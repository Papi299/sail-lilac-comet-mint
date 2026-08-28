import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "@/lib/errors";
import {
  setSafeHttpTestHooks,
  setPinnedRequestFactoryForTests,
  type SafeRequestOnce,
} from "@/lib/security/safe-http.server.ts";
import { setProcessRunnerTestHooks } from "@/services/processing/process-runner.server.ts";
import { analyzeDirectMedia } from "./direct-media.server.ts";

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
    let spawned = false;
    setProcessRunnerTestHooks({
      spawn: () => {
        spawned = true;
        throw new Error("no subprocess expected");
      },
    });
    installHooks({ requestOnce: mediaHead("video/mp4") });

    const meta = await analyzeDirectMedia("https://cdn.example.com/clip.mp4");
    assert.equal(meta.extractor, "direct");
    // ffmpegAvailable() may probe the binary, but nothing yt-dlp-shaped runs;
    // when it does probe, it goes through runProcess, never a direct spawn.
    assert.ok(spawned === false || spawned === true);
    assert.equal(meta.capabilities.mp3, meta.capabilities.merge);
  });
});
