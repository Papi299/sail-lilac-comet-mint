import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  ClearHlsAcquisitionError,
  SEPARATE_AUDIO_FMP4_FILE_NAME,
  SEPARATE_VIDEO_FMP4_FILE_NAME,
  hlsV1EffectiveAggregateLimitBytes,
  type ClearHlsAcquiredFmp4,
  type ClearHlsAcquisitionProgress,
} from "./hls-fragment-acquisition.server.ts";
import { ClearHlsPreflightError, type ClearHlsAcquisitionPlan } from "./hls-preflight.server.ts";
import {
  acquireSelectedSeparateHlsMedia,
  processAcquiredSeparateHlsMedia,
  type ClearHlsSeparateAudioAcquisitionPrimitives,
  type ClearHlsSeparateAudioAcquired,
  type ClearHlsSeparateAudioProcessingPrimitives,
} from "./hls-separate-audio-execution.server.ts";

/**
 * HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001: the separate-audio
 * orchestration seam, with its primitives injected so every ordering and
 * mapping rule is observable without a network or a subprocess.
 */

const MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), "hls-separate-audio-execution.server.ts");
const VIDEO_URL = "https://cdn.example.com/v/1080.m3u8?vtok=VIDEO_TOKEN";
const AUDIO_URL = "https://cdn.example.com/a/main.m3u8?atok=AUDIO_TOKEN";

const PLAN = Object.freeze({
  operation: "clear-hls-separate-audio-remux" as const,
  source: Object.freeze({ videoPlaylistUrl: VIDEO_URL, audioPlaylistUrl: AUDIO_URL }),
});

function fmp4(fragments: number): ClearHlsAcquisitionPlan {
  return Object.freeze({
    segmentType: "fmp4" as const,
    initializationMap: Object.freeze({ url: "https://cdn.example.com/init.mp4" }),
    fragments: Object.freeze(Array.from({ length: fragments }, (_, i) => Object.freeze({ url: `https://cdn.example.com/${i}.m4s` }))),
    fragmentCount: fragments,
  });
}

function ts(): ClearHlsAcquisitionPlan {
  return Object.freeze({
    segmentType: "mpegts" as const,
    fragments: Object.freeze([Object.freeze({ url: "https://cdn.example.com/0.ts" })]),
    fragmentCount: 1,
  });
}

let workDir = "";
beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "hls-separate-exec-")));
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

function artifact(name: string, size: number): ClearHlsAcquiredFmp4 {
  return Object.freeze({ filePath: join(workDir, name), segmentType: "fmp4" as const, fileSize: size });
}

type Call = { step: string; playlistUrl?: string; timeoutMs?: number; maxAggregateBytes?: number };

function primitives(opts: {
  videoPlan?: ClearHlsAcquisitionPlan;
  audioPlan?: ClearHlsAcquisitionPlan;
  videoSize?: number;
  audioSize?: number;
  failAt?: string;
  failWith?: unknown;
  videoProgress?: number[];
  audioProgress?: number[];
}) {
  const calls: Call[] = [];
  const fail = (step: string) => {
    if (opts.failAt === step) throw opts.failWith;
  };
  const impl: ClearHlsSeparateAudioAcquisitionPrimitives = {
    preflight: async ({ playlistUrl }) => {
      const step = playlistUrl === VIDEO_URL ? "preflight-video" : "preflight-audio";
      calls.push({ step, playlistUrl });
      fail(step);
      return playlistUrl === VIDEO_URL ? (opts.videoPlan ?? fmp4(4)) : (opts.audioPlan ?? fmp4(4));
    },
    acquireVideo: async (request) => {
      calls.push({ step: "acquire-video", timeoutMs: request.timeoutMs, maxAggregateBytes: request.maxAggregateBytes });
      fail("acquire-video");
      // HLS-3's own reports end at the committed size: 9 bytes per percent here.
      for (const p of opts.videoProgress ?? []) request.onProgress?.(progressEvent(p, 9 * p));
      return artifact(SEPARATE_VIDEO_FMP4_FILE_NAME, opts.videoSize ?? 1000);
    },
    acquireAudio: async (request) => {
      calls.push({ step: "acquire-audio", timeoutMs: request.timeoutMs, maxAggregateBytes: request.maxAggregateBytes });
      fail("acquire-audio");
      for (const p of opts.audioProgress ?? []) request.onProgress?.(progressEvent(p, p));
      return artifact(SEPARATE_AUDIO_FMP4_FILE_NAME, opts.audioSize ?? 100);
    },
  };
  return { impl, calls };
}

function progressEvent(progress: number, downloadedBytes: number): ClearHlsAcquisitionProgress {
  return { progress, downloadedBytes, totalBytes: null, speed: null, eta: null, stage: "downloading" };
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    return err.code;
  }
  assert.fail("succeeded");
}

describe("separate-audio acquisition: order and the fMP4 subset", () => {
  it("preflights BOTH playlists before acquiring the video half, then the audio half", async () => {
    const { impl, calls } = primitives({});
    const result = await acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, impl);
    assert.deepEqual(calls.map((c) => c.step), ["preflight-video", "preflight-audio", "acquire-video", "acquire-audio"]);
    assert.deepEqual(calls.slice(0, 2).map((c) => c.playlistUrl), [VIDEO_URL, AUDIO_URL]);
    assert.equal(result.totalFileSize, 1100);
    assert.equal(result.video.filePath, join(workDir, SEPARATE_VIDEO_FMP4_FILE_NAME));
    assert.equal(result.audio.filePath, join(workDir, SEPARATE_AUDIO_FMP4_FILE_NAME));
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(Object.keys(result), ["video", "audio", "totalFileSize"]);
  });

  it("refuses MPEG-TS on either side — and mixed families — before any media request", async () => {
    for (const [videoPlan, audioPlan] of [
      [ts(), fmp4(2)],
      [fmp4(2), ts()],
      [ts(), ts()],
    ] as const) {
      const { impl, calls } = primitives({ videoPlan, audioPlan });
      assert.equal(
        await codeOf(acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, impl)),
        "FORMAT_UNAVAILABLE",
      );
      assert.deepEqual(calls.map((c) => c.step), ["preflight-video", "preflight-audio"]);
    }
  });

  it("maps each half's preflight refusal through the muxed table, and stops there", async () => {
    for (const [failAt, reason, code] of [
      ["preflight-video", "playlist_rejected", "FORMAT_UNAVAILABLE"],
      ["preflight-audio", "playlist_rejected", "FORMAT_UNAVAILABLE"],
      ["preflight-audio", "playlist_http_status", "NETWORK_ERROR"],
      ["preflight-video", "timeout", "TIMEOUT"],
      ["preflight-audio", "cancelled", "PROCESSING_FAILED"],
    ] as const) {
      const { impl, calls } = primitives({ failAt, failWith: new ClearHlsPreflightError(reason) });
      assert.equal(await codeOf(acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, impl)), code);
      assert.equal(calls.some((c) => c.step.startsWith("acquire")), false, `${failAt}: no acquisition`);
    }
  });

  it("maps each half's acquisition refusal, and never acquires audio after a failed video half", async () => {
    for (const [failAt, reason, code] of [
      ["acquire-video", "network_error", "NETWORK_ERROR"],
      ["acquire-video", "aggregate_too_large", "TOO_LARGE"],
      ["acquire-audio", "fragment_http_status", "NETWORK_ERROR"],
      ["acquire-audio", "aggregate_too_large", "TOO_LARGE"],
      ["acquire-audio", "timeout", "TIMEOUT"],
    ] as const) {
      const { impl, calls } = primitives({ failAt, failWith: new ClearHlsAcquisitionError(reason) });
      assert.equal(await codeOf(acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, impl)), code);
      if (failAt === "acquire-video") assert.equal(calls.some((c) => c.step === "acquire-audio"), false);
    }
  });

  it("collapses an unexpected primitive error to PROCESSING_FAILED, dropping its text", async () => {
    const { impl } = primitives({ failAt: "acquire-audio", failWith: new Error(`boom ${AUDIO_URL}`) });
    try {
      await acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, impl);
      assert.fail("succeeded");
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "PROCESSING_FAILED");
      assert.equal(String(err.message).includes("AUDIO_TOKEN"), false);
    }
  });
});

describe("separate-audio acquisition: ONE byte budget, ONE deadline", () => {
  it("hands the audio half exactly what the video half's actual bytes left of the limit", async () => {
    const { impl, calls } = primitives({ videoSize: 1234 });
    await acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, impl);
    const video = calls.find((c) => c.step === "acquire-video")!;
    const audio = calls.find((c) => c.step === "acquire-audio")!;
    assert.equal(video.maxAggregateBytes, undefined, "the video half may use the whole limit");
    assert.equal(audio.maxAggregateBytes, hlsV1EffectiveAggregateLimitBytes() - 1234);
  });

  it("refuses with TOO_LARGE, before any audio request, when the video half used the whole budget", async () => {
    const { impl, calls } = primitives({ videoSize: hlsV1EffectiveAggregateLimitBytes() });
    assert.equal(await codeOf(acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, impl)), "TOO_LARGE");
    assert.equal(calls.some((c) => c.step === "acquire-audio"), false);
  });

  it("re-asserts the combined total, so an implementation that ignores the allowance still fails", async () => {
    const limit = hlsV1EffectiveAggregateLimitBytes();
    const { impl } = primitives({ videoSize: limit - 10, audioSize: 11 });
    assert.equal(await codeOf(acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, impl)), "TOO_LARGE");
  });

  it("shares one deadline: the audio half receives only what the video half left", async () => {
    const saved = config.downloadTimeoutMs;
    Object.assign(config, { downloadTimeoutMs: 1_000 });
    try {
      const { impl, calls } = primitives({});
      const slowVideo = impl.acquireVideo;
      const timed: ClearHlsSeparateAudioAcquisitionPrimitives = {
        ...impl,
        acquireVideo: async (request) => {
          await new Promise((r) => setTimeout(r, 120));
          return slowVideo(request);
        },
      };
      await acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, timed);
      const video = calls.find((c) => c.step === "acquire-video")!.timeoutMs!;
      const audio = calls.find((c) => c.step === "acquire-audio")!.timeoutMs!;
      assert.ok(video <= 1_000 && video > 900, `video ${video}`);
      assert.ok(audio <= video - 100, `audio ${audio} must be what is left of ${video}`);
    } finally {
      Object.assign(config, { downloadTimeoutMs: saved });
    }
  });

  it("refuses with TIMEOUT when nothing is left for the audio half", async () => {
    const saved = config.downloadTimeoutMs;
    Object.assign(config, { downloadTimeoutMs: 50 });
    try {
      const { impl, calls } = primitives({});
      const slowVideo = impl.acquireVideo;
      const timed: ClearHlsSeparateAudioAcquisitionPrimitives = {
        ...impl,
        acquireVideo: async (request) => {
          await new Promise((r) => setTimeout(r, 80));
          return slowVideo(request);
        },
      };
      assert.equal(await codeOf(acquireSelectedSeparateHlsMedia({ plan: PLAN, workDir, signal: new AbortController().signal }, timed)), "TIMEOUT");
      assert.equal(calls.some((c) => c.step === "acquire-audio"), false);
    } finally {
      Object.assign(config, { downloadTimeoutMs: saved });
    }
  });
});

describe("separate-audio acquisition: one monotonic progress stream", () => {
  it("weights each half by its fragment count, holds 100 for the end, and counts actual bytes", async () => {
    const { impl } = primitives({
      videoPlan: fmp4(3),
      audioPlan: fmp4(1),
      videoSize: 900,
      audioSize: 100,
      videoProgress: [0, 33, 67, 100],
      audioProgress: [0, 100],
    });
    const seen: ClearHlsAcquisitionProgress[] = [];
    await acquireSelectedSeparateHlsMedia(
      { plan: PLAN, workDir, signal: new AbortController().signal, onProgress: (p) => seen.push(p) },
      impl,
    );
    assert.deepEqual(seen.map((p) => p.progress), [0, 24, 50, 75, 75, 99, 100]);
    // Video bytes, then the committed 900 video bytes plus the audio half's.
    assert.deepEqual(seen.map((p) => p.downloadedBytes), [0, 297, 603, 900, 900, 1000, 1000]);
    const bytes = seen.map((p) => p.downloadedBytes);
    assert.ok(bytes.every((b, i) => i === 0 || b >= bytes[i - 1]!), "actual bytes never move backwards");
    const progresses = seen.map((p) => p.progress);
    assert.ok(progresses.every((p, i) => i === 0 || p >= progresses[i - 1]!), "monotonic");
    assert.equal(progresses.filter((p) => p === 100).length, 1, "exactly one terminal 100, last");
    assert.ok(seen.every((p) => p.totalBytes === null && p.speed === null && p.eta === null && p.stage === "downloading"));
  });

  it("drops a throwing reporter whole, without failing the acquisition", async () => {
    const { impl } = primitives({ videoProgress: [50], audioProgress: [50] });
    const result = await acquireSelectedSeparateHlsMedia(
      {
        plan: PLAN,
        workDir,
        signal: new AbortController().signal,
        onProgress: () => {
          throw new Error("reporter defect");
        },
      },
      impl,
    );
    assert.equal(result.totalFileSize, 1100);
  });
});

// ── Processing ───────────────────────────────────────────────────────────────

function acquiredOnDisk(videoBytes = 64, audioBytes = 32): ClearHlsSeparateAudioAcquired {
  writeFileSync(join(workDir, SEPARATE_VIDEO_FMP4_FILE_NAME), Buffer.alloc(videoBytes, 0x56));
  writeFileSync(join(workDir, SEPARATE_AUDIO_FMP4_FILE_NAME), Buffer.alloc(audioBytes, 0x41));
  return Object.freeze({
    video: artifact(SEPARATE_VIDEO_FMP4_FILE_NAME, videoBytes),
    audio: artifact(SEPARATE_AUDIO_FMP4_FILE_NAME, audioBytes),
    totalFileSize: videoBytes + audioBytes,
  });
}

type MergeCall = Parameters<ClearHlsSeparateAudioProcessingPrimitives["merge"]>[0];

function merger(produce: (opts: MergeCall) => Promise<string> | string) {
  const calls: MergeCall[] = [];
  const impl: ClearHlsSeparateAudioProcessingPrimitives = {
    merge: async (opts) => {
      calls.push(opts);
      return produce(opts);
    },
  };
  return { impl, calls };
}

const writeMerged = (bytes = 80) => (opts: MergeCall) => {
  const out = join(opts.workDir, "merged.mp4");
  writeFileSync(out, Buffer.alloc(bytes, 0x4d));
  return out;
};

describe("separate-audio processing: the shared merge, and only it", () => {
  it("hands the shared merge the two halves by their fixed identities, the mp4 target and one budget", async () => {
    const source = acquiredOnDisk();
    const { impl, calls } = merger(writeMerged());
    const out = await processAcquiredSeparateHlsMedia(
      { source, workDir, timeoutMs: 5_000, maxOutputBytes: 1_000, signal: new AbortController().signal },
      impl,
    );
    assert.deepEqual(out, { filePath: join(workDir, "merged.mp4"), container: "mp4", fileSize: 80 });
    assert.ok(Object.isFrozen(out));
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.videoPath, join(workDir, SEPARATE_VIDEO_FMP4_FILE_NAME));
    assert.equal(call.audioPath, join(workDir, SEPARATE_AUDIO_FMP4_FILE_NAME));
    assert.equal(call.target, "mp4", "the MP4 synchronization policy, never WebM's");
    assert.equal(call.maxOutputBytes, 1_000);
    assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 5_000);
    assert.ok(call.signal instanceof AbortSignal);
  });

  it("refuses a forged, mutated or mismatched acquisition result before the merge", async () => {
    const good = acquiredOnDisk();
    const forged: unknown[] = [
      { ...good },
      Object.freeze({ ...good, extra: 1 }),
      Object.freeze({ video: good.audio, audio: good.video, totalFileSize: good.totalFileSize }),
      Object.freeze({ ...good, totalFileSize: good.totalFileSize + 1 }),
      Object.freeze({ ...good, video: artifact(SEPARATE_VIDEO_FMP4_FILE_NAME, 63) }),
      Object.freeze({ ...good, audio: Object.freeze({ ...good.audio, segmentType: "mpegts" }) }),
      Object.freeze({ ...good, audio: artifact("hls-source.fmp4", 32) }),
      Object.freeze(Object.defineProperty({ audio: good.audio, totalFileSize: good.totalFileSize }, "video", { get: () => good.video, enumerable: true })),
    ];
    for (const source of forged) {
      const { impl, calls } = merger(writeMerged());
      assert.equal(
        await codeOf(
          processAcquiredSeparateHlsMedia(
            { source: source as ClearHlsSeparateAudioAcquired, workDir, timeoutMs: 5_000, maxOutputBytes: 1_000, signal: new AbortController().signal },
            impl,
          ),
        ),
        "PROCESSING_FAILED",
      );
      assert.equal(calls.length, 0);
    }
  });

  it("refuses an output that is not the merge's own contained MP4", async () => {
    const source = acquiredOnDisk();
    for (const produce of [
      () => join(workDir, SEPARATE_VIDEO_FMP4_FILE_NAME),
      () => join(workDir, "merged.webm"),
      () => "/etc/hosts.mp4",
      () => 42 as unknown as string,
    ]) {
      const { impl } = merger(produce);
      assert.equal(
        await codeOf(processAcquiredSeparateHlsMedia({ source, workDir, timeoutMs: 5_000, maxOutputBytes: 1_000, signal: new AbortController().signal }, impl)),
        "PROCESSING_FAILED",
      );
    }
  });

  it("refuses an output over the ceiling as TOO_LARGE", async () => {
    const source = acquiredOnDisk();
    const { impl } = merger(writeMerged(1_001));
    assert.equal(
      await codeOf(processAcquiredSeparateHlsMedia({ source, workDir, timeoutMs: 5_000, maxOutputBytes: 1_000, signal: new AbortController().signal }, impl)),
      "TOO_LARGE",
    );
  });

  it("passes the merge's canonical errors through, and hides anything else", async () => {
    const source = acquiredOnDisk();
    for (const [thrown, code] of [
      [new AppError("PROCESSING_FAILED"), "PROCESSING_FAILED"],
      [new AppError("TOO_LARGE"), "TOO_LARGE"],
      [new Error("ffmpeg said something about /tmp/x"), "PROCESSING_FAILED"],
    ] as const) {
      const { impl } = merger(() => {
        throw thrown;
      });
      assert.equal(
        await codeOf(processAcquiredSeparateHlsMedia({ source, workDir, timeoutMs: 5_000, maxOutputBytes: 1_000, signal: new AbortController().signal }, impl)),
        code,
      );
    }
  });

  it("reports a cancellation as a cancellation and its one deadline as TIMEOUT", async () => {
    const source = acquiredOnDisk();
    const hang = merger(
      (opts) =>
        new Promise<string>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new AppError("PROCESSING_FAILED", "Download was cancelled.")), { once: true });
        }),
    );
    assert.equal(
      await codeOf(processAcquiredSeparateHlsMedia({ source, workDir, timeoutMs: 40, maxOutputBytes: 1_000, signal: new AbortController().signal }, hang.impl)),
      "TIMEOUT",
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const cancelled = processAcquiredSeparateHlsMedia({ source, workDir, timeoutMs: 5_000, maxOutputBytes: 1_000, signal: controller.signal }, hang.impl);
    try {
      await cancelled;
      assert.fail("succeeded");
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "PROCESSING_FAILED");
      assert.equal(err.message, "Download was cancelled.");
    }
    const gone = new AbortController();
    gone.abort();
    const never = merger(writeMerged());
    assert.equal(
      await codeOf(processAcquiredSeparateHlsMedia({ source, workDir, timeoutMs: 5_000, maxOutputBytes: 1_000, signal: gone.signal }, never.impl)),
      "PROCESSING_FAILED",
    );
    assert.equal(never.calls.length, 0);
  });
});

describe("separate-audio orchestration: structure", () => {
  const code = readFileSync(MODULE_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("depends on the SHARED merge seam and restates no synchronization option", () => {
    assert.ok(code.includes('import { mergeSplitMedia } from "@/services/processing/ffmpeg.server";'));
    for (const forbidden of ["-isync", "-itsoffset", "-copyts", "make_zero", "start_at_zero", "decideMergeSync", "matroska", "CodecDelay", "webm"]) {
      assert.equal(code.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
    assert.ok(code.includes('target: "mp4"'));
  });

  it("names no master proof and no yt-dlp facility", () => {
    for (const forbidden of ["hls-master-", "manifest", "yt-dlp", "ytdlp", "runProcess"]) {
      assert.equal(code.includes(forbidden), false, forbidden);
    }
  });
});
