import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  setSafeHttpTestHooks,
  setPinnedRequestFactoryForTests,
  type SafeRequestOnce,
} from "@/lib/security/safe-http.server.ts";
import { setProcessRunnerTestHooks } from "@/services/processing/process-runner.server.ts";
import type { WorkerVideoMetadata } from "@/shared/worker/contracts";
import { analyzeDirectMedia } from "./direct-media.server.ts";
import { DIRECT_KEEP_CONTAINERS, deriveDirectExecutionPlan } from "./format-plan.ts";

const PUBLIC_ADDR = { address: "93.184.216.34", family: 4 as const };
const PRIVATE_ADDR = { address: "127.0.0.1", family: 4 as const };

/**
 * Installs the existing safe-HTTP seams. Nothing in this suite touches the
 * live network, spawns a process, or reaches yt-dlp.
 */
function installHooks(opts: {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  requestOnce: SafeRequestOnce;
}) {
  setSafeHttpTestHooks({
    lookup: opts.lookup ?? (async () => [PUBLIC_ADDR]),
    requestOnce: opts.requestOnce,
  });
}

function mediaHead(contentType: string, contentLength = "1024"): SafeRequestOnce {
  return async (args) => {
    assert.equal(args.method, "HEAD", "analysis must never issue a GET");
    return {
      status: 200,
      headers: { "content-length": contentLength, "content-type": contentType },
      body: null,
    };
  };
}

async function expectAppError(fn: () => Promise<unknown>, code: string, label: string) {
  await assert.rejects(
    fn,
    (err: unknown) => {
      assert.ok(err instanceof AppError, `${label}: expected AppError, got ${String(err)}`);
      assert.equal(err.code, code, label);
      return true;
    },
    label,
  );
}

describe("worker direct-media analysis", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
    setProcessRunnerTestHooks(null);
  });

  it("analyzes a valid direct video URL", async () => {
    installHooks({ requestOnce: mediaHead("video/mp4", "2048") });
    const meta = await analyzeDirectMedia("https://cdn.example.com/clip.mp4");

    assert.equal(meta.extractor, "direct");
    assert.equal(meta.title, "clip");
    const original = meta.formats.find((f) => f.id === "direct-original");
    assert.ok(original);
    assert.equal(original.container, "mp4");
    assert.equal(original.hasVideo, true);
    assert.equal(original.hasAudio, true);
    assert.equal(original.fileSize, 2048);
  });

  it("analyzes a valid direct audio URL as audio-only", async () => {
    installHooks({ requestOnce: mediaHead("audio/mpeg") });
    const meta = await analyzeDirectMedia("https://cdn.example.com/track.mp3");

    const original = meta.formats.find((f) => f.id === "direct-original");
    assert.ok(original);
    assert.equal(original.container, "mp3");
    assert.equal(original.hasVideo, false);
    assert.equal(original.hasAudio, true);
    assert.equal(original.resolution, "audio");
  });

  it("rejects a URL whose host resolves into private address space", async () => {
    let requested = false;
    installHooks({
      lookup: async () => [PRIVATE_ADDR],
      requestOnce: async () => {
        requested = true;
        throw new Error("must not be reached");
      },
    });

    await expectAppError(
      () => analyzeDirectMedia("https://internal.example.com/clip.mp4"),
      "INVALID_URL",
      "private target",
    );
    assert.equal(requested, false, "no request may be issued to a private target");
  });

  it("rejects a redirect that lands in private address space", async () => {
    const hostsRequested: string[] = [];
    installHooks({
      lookup: async (hostname) =>
        hostname === "internal.example.com" ? [PRIVATE_ADDR] : [PUBLIC_ADDR],
      requestOnce: async (args) => {
        hostsRequested.push(args.url.hostname);
        return {
          status: 302,
          headers: { location: "https://internal.example.com/clip.mp4" },
          body: null,
        };
      },
    });

    await expectAppError(
      () => analyzeDirectMedia("https://cdn.example.com/clip.mp4"),
      "INVALID_URL",
      "private redirect",
    );
    assert.deepEqual(
      hostsRequested,
      ["cdn.example.com"],
      "the private redirect hop must never be requested",
    );
  });

  it("rejects a generic webpage with EXTRACTOR_UNAVAILABLE", async () => {
    let requested = false;
    installHooks({
      requestOnce: async () => {
        requested = true;
        throw new Error("must not be reached");
      },
    });

    for (const url of [
      "https://example.com/watch?v=abcdef",
      "https://example.com/",
      "https://example.com/video",
      "https://example.com/page.html",
    ]) {
      await expectAppError(
        () => analyzeDirectMedia(url),
        "EXTRACTOR_UNAVAILABLE",
        `generic webpage ${url}`,
      );
    }
    assert.equal(requested, false, "generic URLs must be refused before any network call");
  });

  it("maps malformed probe metadata to ANALYSIS_FAILED", async () => {
    installHooks({ requestOnce: mediaHead("video/mp4") });

    const malformedShapes: unknown[] = [
      { title: 123 },
      null,
      { title: "x", formats: "not-an-array" },
      { title: "x", thumbnail: null, duration: null, source: "s", extractor: "direct" },
    ];

    for (const shape of malformedShapes) {
      await expectAppError(
        () => analyzeDirectMedia("https://cdn.example.com/clip.mp4", undefined, async () => shape),
        "ANALYSIS_FAILED",
        `malformed metadata ${JSON.stringify(shape)}`,
      );
    }
  });

  it("propagates an abort raised during the HEAD probe", async () => {
    const controller = new AbortController();
    installHooks({
      requestOnce: async () => {
        controller.abort(new Error("aborted during HEAD"));
        throw new Error("connection torn down");
      },
    });

    await assert.rejects(
      () => analyzeDirectMedia("https://cdn.example.com/clip.mp4", controller.signal),
      (err: unknown) => {
        // The abort reason surfaces verbatim; it is never flattened into
        // ANALYSIS_FAILED.
        assert.ok(!(err instanceof AppError) || err.code !== "ANALYSIS_FAILED");
        assert.equal((err as Error).message, "aborted during HEAD");
        return true;
      },
    );
  });

  it("propagates an abort raised while probing FFmpeg availability", async () => {
    const controller = new AbortController();
    let spawned = false;
    setProcessRunnerTestHooks({
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn after abort");
      },
    });
    installHooks({
      requestOnce: async () => {
        // HEAD succeeds, then the job is cancelled before capability probing.
        controller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
        return {
          status: 200,
          headers: { "content-length": "10", "content-type": "video/mp4" },
          body: null,
        };
      },
    });

    await assert.rejects(
      () => analyzeDirectMedia("https://cdn.example.com/clip.mp4", controller.signal),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.message, "Job cancelled");
        return true;
      },
    );
    assert.equal(spawned, false, "no subprocess may start once the signal is aborted");
  });

  it("never imports or reaches yt-dlp during analysis", async () => {
    // STRENGTHENED in Phase 10C1. This previously asserted
    // `spawned === false || spawned === true`, which is a tautology and proved
    // nothing. It now records every command the analyzer actually spawns and
    // asserts that none of them is the yt-dlp runtime.
    const commands: string[] = [];
    setProcessRunnerTestHooks({
      spawn: (command) => {
        commands.push(command);
        throw new Error("no subprocess expected");
      },
    });
    installHooks({ requestOnce: mediaHead("video/mp4") });

    const meta = await analyzeDirectMedia("https://cdn.example.com/clip.mp4");
    assert.equal(meta.extractor, "direct");
    assert.equal(meta.capabilities.mp3, meta.capabilities.merge);

    // ffmpegAvailable() legitimately probes the FFmpeg binary through
    // runProcess. Nothing yt-dlp-shaped may be spawned at all.
    for (const command of commands) {
      assert.equal(
        /yt-dlp|yt_dlp|python/.test(command),
        false,
        `analysis spawned '${command}', which is yt-dlp-shaped`,
      );
    }
  });

  it("refuses a non-direct URL without spawning anything at all", async () => {
    // The decisive no-execution proof for Phase 10C1: a URL that is NOT direct
    // media is exactly the input a generic yt-dlp path would claim. The Worker
    // must reject it outright, and must do so before any process starts —
    // there is no generic analyzer to fall through to, and no fallback.
    const commands: string[] = [];
    setProcessRunnerTestHooks({
      spawn: (command) => {
        commands.push(command);
        throw new Error("no subprocess expected");
      },
    });
    installHooks({
      requestOnce: async () => {
        throw new Error("analysis must not issue any request for a non-direct URL");
      },
    });

    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://vimeo.com/123456789",
      "https://example.com/page.html",
      "https://example.com/",
    ]) {
      await expectAppError(
        () => analyzeDirectMedia(url),
        "EXTRACTOR_UNAVAILABLE",
        `non-direct URL ${url}`,
      );
    }

    assert.deepEqual(commands, [], "no subprocess may start for a non-direct URL");
  });
});

// ── DIRECT-PRESET-FILESIZE-PROVENANCE-001 ────────────────────────────────────
//
// `direct-original.fileSize` is the source's HEAD `Content-Length`. A preset
// may repeat it only when its execution plan returns those original bytes; a
// converted or extracted output has no known size before processing.

const ORIGINAL_FFMPEG_PATH = config.ffmpegPath;

/**
 * Makes `ffmpegAvailable()` answer true without a real binary: it needs the
 * configured path to exist and `-version` to print an FFmpeg banner. The path
 * is this Node executable, which never runs because the one spawn is answered
 * by a fake child. The child has no pid, so the runner can never address a
 * host process group.
 */
function installFfmpeg(): void {
  config.ffmpegPath = process.execPath;
  setProcessRunnerTestHooks({
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdout.on("end", () => setImmediate(() => child.emit("close", 0)));
      setImmediate(() => {
        child.stdout.end("ffmpeg version 7.0-test\n");
        child.stderr.end();
      });
      return child as unknown as ChildProcess;
    },
  });
}

/** FFmpeg absent on any host: the configured path does not exist. */
function removeFfmpeg(): void {
  config.ffmpegPath = "/nonexistent/videofetch-test/ffmpeg";
  setProcessRunnerTestHooks({
    spawn: () => {
      throw new Error("no subprocess expected");
    },
  });
}

/** Analyzes `url` behind one HEAD; `contentLength` undefined omits the header. */
async function analyzeBehindHead(url: string, contentType: string, contentLength?: string) {
  installHooks({
    requestOnce: async (args) => {
      assert.equal(args.method, "HEAD", "analysis must never issue a GET");
      return {
        status: 200,
        headers:
          contentLength === undefined
            ? { "content-type": contentType }
            : { "content-length": contentLength, "content-type": contentType },
        body: null,
      };
    },
  });
  return analyzeDirectMedia(url);
}

function originalOf(meta: WorkerVideoMetadata) {
  const original = meta.formats.find((f) => f.id === "direct-original");
  assert.ok(original, "direct analysis advertises its source format");
  return original;
}

function presetOf(meta: WorkerVideoMetadata, id: string) {
  const preset = meta.presets.find((p) => p.id === id);
  assert.ok(preset, `${id} is advertised`);
  return preset;
}

describe("worker direct-media analysis: preset fileSize provenance", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setProcessRunnerTestHooks(null);
    config.ffmpegPath = ORIGINAL_FFMPEG_PATH;
  });

  it("publishes no size for audio extracted from a video source", async () => {
    installFfmpeg();
    const meta = await analyzeBehindHead("https://cdn.example.com/clip.mp4", "video/mp4", "2048");

    assert.equal(originalOf(meta).fileSize, 2048, "the source format keeps its HEAD Content-Length");
    assert.deepEqual(
      meta.presets.map((p) => p.id),
      ["preset:best", "preset:audio", "preset:mp3"],
    );

    const best = presetOf(meta, "preset:best");
    assert.equal(best.container, "mp4");
    assert.equal(deriveDirectExecutionPlan(meta, "preset:best").operation, "keep-original");
    assert.equal(best.fileSize, 2048, "the original bytes are delivered, so the source size is theirs");

    const audio = presetOf(meta, "preset:audio");
    assert.equal(audio.container, "m4a");
    assert.equal(deriveDirectExecutionPlan(meta, "preset:audio").operation, "extract-m4a");
    assert.equal(audio.fileSize, null, "a new M4A is extracted; the video's 2048 bytes are not its size");

    const mp3 = presetOf(meta, "preset:mp3");
    assert.equal(deriveDirectExecutionPlan(meta, "preset:mp3").operation, "extract-mp3");
    assert.equal(mp3.fileSize, null);
  });

  it("publishes no size for a video preset converted to another container", async () => {
    installFfmpeg();
    const meta = await analyzeBehindHead("https://cdn.example.com/clip.mkv", "video/x-matroska", "4096");

    const original = originalOf(meta);
    assert.equal(original.container, "mkv");
    assert.equal(original.fileSize, 4096, "the source format keeps its HEAD Content-Length");

    const best = presetOf(meta, "preset:best");
    assert.equal(best.container, "mp4");
    const plan = deriveDirectExecutionPlan(meta, "preset:best");
    assert.equal(plan.operation, "convert");
    assert.equal(plan.targetContainer, "mp4");
    assert.equal(best.fileSize, null, "a converted MP4 is not the 4096-byte MKV");
  });

  it("keeps the source size for an audio-only source returned unchanged", async () => {
    installFfmpeg();
    const meta = await analyzeBehindHead("https://cdn.example.com/track.mp3", "audio/mpeg", "3072");

    const original = originalOf(meta);
    assert.equal(original.hasVideo, false);
    assert.equal(original.fileSize, 3072);
    assert.deepEqual(meta.presets.map((p) => p.id), ["preset:audio", "preset:mp3"]);

    const audio = presetOf(meta, "preset:audio");
    assert.equal(audio.container, "mp3");
    assert.equal(deriveDirectExecutionPlan(meta, "preset:audio").operation, "keep-original");
    assert.equal(audio.fileSize, 3072, "valid source-size provenance is not suppressed for audio");

    const mp3 = presetOf(meta, "preset:mp3");
    assert.equal(deriveDirectExecutionPlan(meta, "preset:mp3").operation, "extract-mp3");
    assert.equal(mp3.fileSize, null, "preset:mp3 is still an extraction, even from an MP3");
  });

  it("publishes no size anywhere without a valid Content-Length, and estimates none", async () => {
    installFfmpeg();
    for (const contentLength of [undefined, "not-a-number", "-1"]) {
      const meta = await analyzeBehindHead("https://cdn.example.com/clip.mp4", "video/mp4", contentLength);

      assert.equal(originalOf(meta).fileSize, null, `Content-Length ${String(contentLength)}`);
      assert.deepEqual(
        meta.presets.map((p) => [p.id, p.fileSize]),
        [
          ["preset:best", null],
          ["preset:audio", null],
          ["preset:mp3", null],
        ],
        `Content-Length ${String(contentLength)}`,
      );
    }
  });

  it("gives every advertised preset the size its execution plan implies", async () => {
    // Every extension the direct extractor accepts (typed by extension alone),
    // plus Content-Type, no-FFmpeg and missing-length variants.
    const scenarios: Array<{ url: string; type: string; length?: string; ffmpeg: boolean }> = [
      ...DIRECT_KEEP_CONTAINERS.map((ext) => ({
        url: `https://cdn.example.com/media.${ext}`,
        type: "application/octet-stream",
        length: "5000",
        ffmpeg: true,
      })),
      { url: "https://cdn.example.com/clip.mp4", type: "audio/mp4", length: "5000", ffmpeg: true },
      { url: "https://cdn.example.com/clip.mkv", type: "video/x-matroska", length: "5000", ffmpeg: false },
      { url: "https://cdn.example.com/clip.mp4", type: "video/mp4", length: "5000", ffmpeg: false },
      { url: "https://cdn.example.com/clip.mkv", type: "video/x-matroska", ffmpeg: true },
    ];

    const seen = new Set<string>();
    for (const scenario of scenarios) {
      if (scenario.ffmpeg) installFfmpeg();
      else removeFfmpeg();
      const meta = await analyzeBehindHead(scenario.url, scenario.type, scenario.length);
      const original = originalOf(meta);
      assert.ok(meta.presets.length > 0 || !scenario.ffmpeg, `${scenario.url} advertises presets`);

      for (const preset of meta.presets) {
        const label = `${scenario.url} (${scenario.type}, ffmpeg ${scenario.ffmpeg}) ${preset.id}`;
        const plan = deriveDirectExecutionPlan(meta, preset.id);
        seen.add(plan.operation);
        switch (plan.operation) {
          case "keep-original":
            assert.equal(preset.fileSize, original.fileSize, `${label}: keep-original carries the source size`);
            break;
          case "convert":
          case "extract-m4a":
          case "extract-mp3":
            assert.equal(preset.fileSize, null, `${label}: ${plan.operation} has no known output size`);
            break;
          default: {
            const unhandled: never = plan;
            assert.fail(`${label}: unclassified operation ${JSON.stringify(unhandled)}`);
          }
        }
      }
    }
    assert.deepEqual(
      [...seen].sort(),
      ["convert", "extract-m4a", "extract-mp3", "keep-original"],
      "every direct operation was exercised",
    );
  });
});
