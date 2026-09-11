import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../lib/errors.ts";
import { WORKER_ERROR_CODES } from "../../shared/worker/errors.ts";
import type { WorkerVideoMetadata } from "../../shared/worker/contracts.ts";
import { VideoMetadataSchema } from "../../shared/worker/contracts.ts";
import {
  analyzeForExecution,
  analyzeMedia,
  createMediaAnalysisPolicy,
  type GenericAnalysisLimits,
} from "../analysis/media-analyzer.server.ts";
import {
  analyzeGenericMedia,
  analyzeGenericMediaInternal,
} from "../analysis/ytdlp-analysis.server.ts";
import { YTDLP_RUNTIME } from "../runtime/ytdlp-runtime.server.ts";
import { WorkerAnalyzeSuccessSchema } from "../../shared/worker/contracts.ts";

/**
 * Phase 10C3 §44/§45/§53: what the ROUTER does, end to end, at the HTTP and
 * execution entry points.
 *
 * The point of these tests is negative: proving that a disabled deployment
 * starts NO generic process, and that an unverified runtime fails closed rather
 * than reaching for something else. Every generic analyzer here is a fake that
 * records whether it was called at all.
 */

const DIRECT_URL = "https://cdn.example.invalid/clip.mp4";
const GENERIC_URL = "https://example.invalid/watch/abc";

const LIMITS: GenericAnalysisLimits = {
  analysisTimeoutSeconds: 45,
  maxVideoDurationSeconds: 7200,
  maxFileSizeBytes: 500 * 1024 * 1024,
};

function directMeta(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "direct clip",
    thumbnail: null,
    duration: null,
    source: "cdn.example.invalid",
    extractor: "direct",
    webpageUrl: DIRECT_URL,
    formats: [
      {
        id: "direct-original",
        resolution: "unknown",
        width: null,
        height: null,
        fps: null,
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        bitrate: null,
        fileSize: 100,
        hasVideo: true,
        hasAudio: true,
        formatNote: null,
      },
    ],
    presets: [],
    capabilities: { mp3: false, merge: false },
  });
}

function genericMeta(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "generic clip",
    thumbnail: null,
    duration: 120,
    source: "example.invalid",
    extractor: "yt-dlp",
    webpageUrl: GENERIC_URL,
    formats: [],
    presets: [
      {
        id: "preset:1080",
        label: "1080p",
        resolution: "1080p",
        container: "mp4",
        fileSize: null,
        hasVideo: true,
        hasAudio: true,
        formatId: "preset:1080",
        videoCodec: "h264",
        audioCodec: "aac",
        fps: null,
      },
    ],
    capabilities: { mp3: false, merge: false },
  });
}

/** A generic analyzer that must never be called. */
function forbiddenGeneric() {
  const state = { calls: 0 };
  return {
    state,
    analyzeGeneric: async () => {
      state.calls += 1;
      throw new Error("a generic analysis was started when none was permitted");
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §53: direct success
// ─────────────────────────────────────────────────────────────────────────────

describe("routing: direct success (§53)", () => {
  it("returns direct metadata and starts no generic work, even when enabled", async () => {
    const { state, analyzeGeneric } = forbiddenGeneric();
    const meta = await analyzeMedia(DIRECT_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => directMeta(),
      analyzeGeneric,
    });
    assert.equal(meta.extractor, "direct");
    assert.equal(state.calls, 0, "generic must not run after a direct success");
  });

  it("returns the direct result verbatim, without reshaping it", async () => {
    const original = directMeta();
    const meta = await analyzeMedia(DIRECT_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => original,
      analyzeGeneric: async () => {
        throw new Error("unreachable");
      },
    });
    assert.deepEqual(meta, original);
    assert.equal(meta.formats.length, 1, "direct keeps its concrete format");
  });

  it("routes a direct success to the direct strategy on the EXECUTION path", async () => {
    const { state, analyzeGeneric } = forbiddenGeneric();
    const res = await analyzeForExecution(DIRECT_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => directMeta(),
      analyzeGeneric: analyzeGeneric as never,
    });
    assert.equal(res.strategy, "direct");
    assert.deepEqual(res.selections, {}, "direct carries no private source selection");
    assert.equal(state.calls, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §44: disabled means NO generic subprocess
// ─────────────────────────────────────────────────────────────────────────────

describe("routing: YTDLP_ENABLED=false (§44)", () => {
  it("reports EXTRACTOR_UNAVAILABLE and starts nothing", async () => {
    const { state, analyzeGeneric } = forbiddenGeneric();
    await assert.rejects(
      () =>
        analyzeMedia(GENERIC_URL, {
          ytdlpEnabled: false,
          limits: LIMITS,
          analyzeDirect: async () => {
            throw new AppError("EXTRACTOR_UNAVAILABLE");
          },
          analyzeGeneric,
        }),
      (err: unknown) => err instanceof AppError && err.code === "EXTRACTOR_UNAVAILABLE",
    );
    assert.equal(state.calls, 0, "no generic analysis subprocess");
  });

  it("is indistinguishable from a build with no generic path at all", async () => {
    // The disabled response carries the SAME code direct produced, so a
    // disabled deployment does not advertise that a generic path exists.
    let code = "";
    await analyzeMedia(GENERIC_URL, {
      ytdlpEnabled: false,
      limits: LIMITS,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: async () => {
        throw new Error("unreachable");
      },
    }).catch((err: unknown) => {
      code = err instanceof AppError ? err.code : "other";
    });
    assert.equal(code, "EXTRACTOR_UNAVAILABLE");
  });

  it("starts nothing on the EXECUTION path either", async () => {
    const { state, analyzeGeneric } = forbiddenGeneric();
    await assert.rejects(
      () =>
        analyzeForExecution(GENERIC_URL, {
          ytdlpEnabled: false,
          limits: LIMITS,
          analyzeDirect: async () => {
            throw new AppError("EXTRACTOR_UNAVAILABLE");
          },
          analyzeGeneric: analyzeGeneric as never,
        }),
      (err: unknown) => err instanceof AppError && err.code === "EXTRACTOR_UNAVAILABLE",
    );
    assert.equal(state.calls, 0);
  });

  it("does not even probe FFmpeg when generic is disabled", async () => {
    let ffmpegProbes = 0;
    const policy = createMediaAnalysisPolicy({
      ytdlpEnabled: false,
      limits: LIMITS,
      ffmpegAvailable: async () => {
        ffmpegProbes += 1;
        return true;
      },
    });
    await policy.analyze(DIRECT_URL).catch(() => {});
    assert.equal(ffmpegProbes, 0, "a disabled deployment spends no probe");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §53: enabled and reachable
// ─────────────────────────────────────────────────────────────────────────────

describe("routing: YTDLP_ENABLED=true (§53)", () => {
  it("reaches the generic analyzer and returns application-owned presets", async () => {
    let calls = 0;
    const meta = await analyzeMedia(GENERIC_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: async () => {
        calls += 1;
        return genericMeta();
      },
    });

    assert.equal(calls, 1);
    assert.equal(meta.extractor, "yt-dlp");
    assert.deepEqual(meta.formats, [], "generic exposes NO concrete formats");
    for (const p of meta.presets) {
      assert.match(p.id, /^preset:/);
      assert.equal(p.formatId, p.id, "the selectable value is application-owned");
    }
  });

  it("carries the private selections on the execution path only", async () => {
    const res = await analyzeForExecution(GENERIC_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: async () => ({
        video: genericMeta(),
        selections: {
          "preset:1080": {
            kind: "single" as const,
            source: {
              formatId: "22",
              protocol: "https" as const,
              container: "mp4" as const,
              hasVideo: true,
              hasAudio: true,
              videoConstraint: "codec-present" as const,
              audioConstraint: "codec-present" as const,
              fileSize: null,
            },
          },
        },
      }),
    });

    assert.equal(res.strategy, "yt-dlp");
    const routed = res.selections["preset:1080"];
    assert.equal(routed?.kind, "single");
    assert.equal(routed?.kind === "single" ? routed.source.formatId : null, "22");
    // The PUBLIC half stays free of it.
    assert.equal(JSON.stringify(res.video).includes('"22"'), false);
    // The private audio state travels with the selection, never with the
    // browser-safe half (GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001).
    assert.equal(
      routed?.kind === "single" ? routed.source.audioConstraint : null,
      "codec-present",
    );
    assert.equal(JSON.stringify(res.video).includes("audioConstraint"), false);
  });

  it("propagates the analyzer's own failure without a second attempt", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        analyzeMedia(GENERIC_URL, {
          ytdlpEnabled: true,
          limits: LIMITS,
          analyzeDirect: async () => {
            throw new AppError("EXTRACTOR_UNAVAILABLE");
          },
          analyzeGeneric: async () => {
            calls += 1;
            throw new AppError("UNSUPPORTED_SITE");
          },
        }),
      (err: unknown) => err instanceof AppError && err.code === "UNSUPPORTED_SITE",
    );
    assert.equal(calls, 1, "exactly one generic attempt, never a retry");
  });

  it("passes the FFmpeg availability answer through to preset generation", async () => {
    // Generic AUDIO presets from a muxed source require the Worker's own
    // FFmpeg, so a wrong answer here would advertise a preset the Worker could
    // not produce. Both values must reach the analyzer unchanged.
    for (const available of [true, false]) {
      let observed: boolean | null = null;
      await analyzeMedia(GENERIC_URL, {
        ytdlpEnabled: true,
        limits: LIMITS,
        ffmpegAvailable: available,
        analyzeDirect: async () => {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        },
        analyzeGeneric: async (_u, opts) => {
          observed = opts.ffmpegAvailable;
          return genericMeta();
        },
      });
      assert.equal(observed, available);
    }
  });

  it("defaults FFmpeg availability to false rather than assuming it", async () => {
    let observed: boolean | null = null;
    await analyzeMedia(GENERIC_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: async (_u, opts) => {
        observed = opts.ffmpegAvailable;
        return genericMeta();
      },
    });
    // Absent means false, which can only REMOVE presets, never advertise one
    // that cannot be produced.
    assert.equal(observed, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §45: a missing or mismatched runtime fails closed
// ─────────────────────────────────────────────────────────────────────────────

describe("routing: runtime unavailable fails closed (§45)", () => {
  it("does not fall back to direct after generic was selected", async () => {
    let directCalls = 0;
    await assert.rejects(
      () =>
        analyzeMedia(GENERIC_URL, {
          ytdlpEnabled: true,
          limits: LIMITS,
          analyzeDirect: async () => {
            directCalls += 1;
            throw new AppError("EXTRACTOR_UNAVAILABLE");
          },
          // What the real analyzer throws when the pinned runtime probe fails.
          analyzeGeneric: async () => {
            throw new AppError("EXTRACTOR_UNAVAILABLE");
          },
        }),
      (err: unknown) => err instanceof AppError && err.code === "EXTRACTOR_UNAVAILABLE",
    );
    assert.equal(directCalls, 1, "direct is attempted once, never retried as a fallback");
  });

  it("leaves direct media unaffected when the runtime is missing", async () => {
    const meta = await analyzeMedia(DIRECT_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => directMeta(),
      analyzeGeneric: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
    });
    assert.equal(meta.extractor, "direct");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4: no fallback after any other direct failure
// ─────────────────────────────────────────────────────────────────────────────

describe("routing: no fallback after a non-EXTRACTOR_UNAVAILABLE failure (§4)", () => {
  const NEVER_FALLS_BACK = WORKER_ERROR_CODES.filter((c) => c !== "EXTRACTOR_UNAVAILABLE");

  for (const code of NEVER_FALLS_BACK) {
    it(`propagates ${code} without starting generic`, async () => {
      const { state, analyzeGeneric } = forbiddenGeneric();
      await assert.rejects(
        () =>
          analyzeMedia(GENERIC_URL, {
            ytdlpEnabled: true,
            limits: LIMITS,
            analyzeDirect: async () => {
              throw new AppError(code);
            },
            analyzeGeneric,
          }),
        (err: unknown) => err instanceof AppError && err.code === code,
      );
      assert.equal(state.calls, 0, `${code} must never trigger a generic attempt`);
    });
  }

  it("propagates an unexpected non-AppError exception without falling back", async () => {
    const { state, analyzeGeneric } = forbiddenGeneric();
    await assert.rejects(
      () =>
        analyzeMedia(GENERIC_URL, {
          ytdlpEnabled: true,
          limits: LIMITS,
          analyzeDirect: async () => {
            throw new TypeError("something unexpected");
          },
          analyzeGeneric,
        }),
      (err: unknown) => err instanceof TypeError,
    );
    assert.equal(state.calls, 0);
  });

  it("never treats cancellation as a strategy decision", async () => {
    const controller = new AbortController();
    controller.abort();
    const { state, analyzeGeneric } = forbiddenGeneric();
    await assert.rejects(() =>
      analyzeMedia(GENERIC_URL, {
        ytdlpEnabled: true,
        limits: LIMITS,
        signal: controller.signal,
        analyzeDirect: async () => {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        },
        analyzeGeneric,
      }),
    );
    assert.equal(state.calls, 0, "an aborted analysis must not start a second network client");
  });

  it("applies the same no-fallback rule on the execution path", async () => {
    const { state, analyzeGeneric } = forbiddenGeneric();
    await assert.rejects(
      () =>
        analyzeForExecution(GENERIC_URL, {
          ytdlpEnabled: true,
          limits: LIMITS,
          analyzeDirect: async () => {
            throw new AppError("INVALID_URL");
          },
          analyzeGeneric: analyzeGeneric as never,
        }),
      (err: unknown) => err instanceof AppError && err.code === "INVALID_URL",
    );
    assert.equal(state.calls, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT-05 §49: the REAL generic analyzer, driven through the router
//
// Every other case in this file uses a fake generic analyzer, because what they
// prove is a ROUTING property. These two instead wire the real
// `analyzeGenericMedia` / `analyzeGenericMediaInternal` into the same router,
// with a deterministic fake SUBPROCESS runner underneath, so that what crosses
// the service boundary is what the Worker would really produce for a pairable
// source. No HTTP schema is changed to make them pass.
// ─────────────────────────────────────────────────────────────────────────────

describe("routing: a pairable generic source reaches the boundary (SPLIT-05)", () => {
  /** Grammar-valid, obviously synthetic sentinels. Never Production values. */
  const PRIVATE_VIDEO = "PRIVATE_VIDEO_137";
  const PRIVATE_AUDIO = "PRIVATE_AUDIO_140";

  /** A `-J` document whose best rendition exists only as a video+audio pair. */
  const INFO = JSON.stringify({
    _type: "video",
    title: "pairable clip",
    duration: 120,
    live_status: "not_live",
    formats: [
      {
        format_id: PRIVATE_VIDEO,
        ext: "mp4",
        protocol: "https",
        height: 1080,
        fps: 30,
        vcodec: "avc1.640028",
        acodec: "none",
        video_ext: "mp4",
        audio_ext: "none",
        filesize: 9_000_000,
      },
      {
        format_id: PRIVATE_AUDIO,
        ext: "m4a",
        protocol: "https",
        vcodec: "none",
        acodec: "mp4a.40.2",
        video_ext: "none",
        audio_ext: "m4a",
        filesize: 500_000,
      },
    ],
  });

  /** The real analyzer's dependencies, with only the subprocess faked out. */
  const genericDeps = {
    limits: LIMITS,
    ffmpegAvailable: true,
    runner: async () => ({ code: 0, stdout: INFO, stderr: "" }),
    probeRuntime: async () => ({
      available: true as const,
      version: YTDLP_RUNTIME.expectedVersion,
      reason: "ok" as const,
    }),
    validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
  };

  it("the HTTP-visible response advertises the preset and reports merge, with nothing raw", async () => {
    const meta = await analyzeMedia(GENERIC_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: (url) => analyzeGenericMedia(url, genericDeps),
    });

    // The response is validated by the SAME strict success schema the Worker
    // serializes with, so this is what the browser would actually receive.
    const body = JSON.stringify(WorkerAnalyzeSuccessSchema.parse({ success: true, video: meta }));

    // The new video preset is really there...
    const rung = meta.presets.find((p) => p.id === "preset:1080");
    assert.ok(rung, "the split-backed rendition must be advertised");
    assert.equal(rung.container, "mp4");
    assert.equal(rung.hasVideo, true);
    assert.equal(rung.hasAudio, true);
    assert.equal(rung.fileSize, 9_500_000, "the combined known size");

    // ...and the capability says so.
    assert.equal(meta.capabilities.merge, true);

    // No private selections, no raw ids, no formats.
    assert.equal("selections" in meta, false);
    assert.equal(body.includes(PRIVATE_VIDEO), false, "the raw video id must not cross HTTP");
    assert.equal(body.includes(PRIVATE_AUDIO), false, "the raw audio id must not cross HTTP");
    assert.equal(body.includes('"pair"'), false);
    assert.equal(body.includes('"split"'), false);
    assert.deepEqual(meta.formats, [], "formats stays empty");
    for (const p of meta.presets) {
      assert.match(p.id, /^preset:/);
      assert.equal(p.formatId, p.id);
    }
  });

  it("the EXECUTION path carries the pair privately, and only there", async () => {
    const res = await analyzeForExecution(GENERIC_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: (url) => analyzeGenericMediaInternal(url, genericDeps),
    });

    assert.equal(res.strategy, "yt-dlp");
    const routed = res.selections["preset:1080"];
    assert.equal(routed?.kind, "split", "the router passes the pair through untouched");
    if (routed?.kind !== "split") throw new Error("unreachable");
    assert.equal(routed.pair.video.formatId, PRIVATE_VIDEO);
    assert.equal(routed.pair.audio.formatId, PRIVATE_AUDIO);

    // The public half stays free of both.
    const publicBody = JSON.stringify(res.video);
    assert.equal(publicBody.includes(PRIVATE_VIDEO), false);
    assert.equal(publicBody.includes(PRIVATE_AUDIO), false);
    assert.equal(publicBody.includes("audioConstraint"), false);
    assert.equal(res.video.capabilities.merge, true);
  });
});
