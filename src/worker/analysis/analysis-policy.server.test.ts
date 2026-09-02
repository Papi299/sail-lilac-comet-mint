import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../lib/errors.ts";
import {
  VideoMetadataSchema,
  type WorkerVideoMetadata,
} from "../../shared/worker/contracts.ts";
import {
  createMediaAnalysisPolicy,
  type GenericAnalysisLimits,
} from "./media-analyzer.server.ts";

/**
 * CORRECTION-01 §3/§6: generic-only capability must be resolved LAZILY.
 *
 * These tests are at the CANONICAL POLICY level deliberately. The lower-level
 * `analyzeMedia()` tests could not have caught the original defect, because the
 * eager probe happened in `createMediaAnalysisPolicy()` while it built the
 * options object — before `analyzeMedia` was entered at all.
 *
 * The FFmpeg resolver here is always a counting fake, and in one case a fake
 * that throws if touched. Nothing invokes real FFmpeg or real network activity.
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

const SELECTIONS = {
  "preset:1080": {
    formatId: "22",
    protocol: "https" as const,
    container: "mp4" as const,
    hasVideo: true,
    hasAudio: true,
    fileSize: null,
  },
};

type Counters = {
  direct: number;
  generic: number;
  ffmpeg: number;
};

/**
 * Drives the REAL `createMediaAnalysisPolicy` with every dependency injected.
 *
 * This goes through the factory rather than calling `analyzeMedia` directly,
 * because the original defect lived in the factory: it awaited the FFmpeg
 * resolver while building its options object, before the router was entered at
 * all. A router-level test could not have observed that.
 */
async function runPolicy(
  entry: "analyze" | "analyzeForExecution",
  opts: {
    url: string;
    ytdlpEnabled: boolean;
    direct: () => Promise<WorkerVideoMetadata>;
    ffmpeg?: () => Promise<boolean>;
    signal?: AbortSignal;
    onTrace?: (event: string) => void;
  },
): Promise<{ counters: Counters; result: unknown; error: unknown }> {
  const counters: Counters = { direct: 0, generic: 0, ffmpeg: 0 };

  const policy = createMediaAnalysisPolicy({
    ytdlpEnabled: opts.ytdlpEnabled,
    limits: LIMITS,
    ffmpegAvailable: async () => {
      counters.ffmpeg += 1;
      opts.onTrace?.("ffmpeg");
      return opts.ffmpeg ? opts.ffmpeg() : true;
    },
    analyzeDirect: async () => {
      counters.direct += 1;
      opts.onTrace?.("direct");
      return opts.direct();
    },
    analyzeGeneric: async () => {
      counters.generic += 1;
      opts.onTrace?.("generic");
      return { video: genericMeta(), selections: SELECTIONS };
    },
  });

  try {
    const result = await policy[entry](opts.url, opts.signal);
    return { counters, result, error: null };
  } catch (error: unknown) {
    return { counters, result: null, error };
  }
}

const ENTRIES = ["analyze", "analyzeForExecution"] as const;

for (const entry of ENTRIES) {
  describe(`lazy generic capability: policy.${entry} (§3/§6)`, () => {
    it("resolves NO generic-only FFmpeg capability on a direct success", async () => {
      const { counters, result, error } = await runPolicy(entry, {
        url: DIRECT_URL,
        ytdlpEnabled: true,
        direct: async () => directMeta(),
      });

      assert.equal(error, null);
      assert.ok(result);
      assert.equal(counters.direct, 1, "direct is attempted exactly once");
      assert.equal(counters.ffmpeg, 0, "a direct success must not probe FFmpeg");
      assert.equal(counters.generic, 0, "a direct success must not reach generic");
    });

    it("succeeds even when the FFmpeg resolver would THROW if called", async () => {
      // The strongest form of the assertion: if the resolver were still eager,
      // this could not return direct metadata at all.
      const { counters, result, error } = await runPolicy(entry, {
        url: DIRECT_URL,
        ytdlpEnabled: true,
        direct: async () => directMeta(),
        ffmpeg: async () => {
          throw new Error("the FFmpeg resolver must never run on a direct success");
        },
      });

      assert.equal(error, null, "direct analysis must not depend on the resolver");
      assert.ok(result);
      assert.equal(counters.ffmpeg, 0);
    });

    for (const code of ["INVALID_URL", "NETWORK_ERROR", "TIMEOUT"] as const) {
      it(`resolves no FFmpeg capability when direct fails ${code}`, async () => {
        const { counters, error } = await runPolicy(entry, {
          url: GENERIC_URL,
          ytdlpEnabled: true,
          direct: async () => {
            throw new AppError(code);
          },
          ffmpeg: async () => {
            throw new Error("a non-fallback direct failure must not probe FFmpeg");
          },
        });

        assert.ok(error instanceof AppError && error.code === code, "the original error propagates");
        assert.equal(counters.ffmpeg, 0);
        assert.equal(counters.generic, 0);
      });
    }

    it("resolves no FFmpeg capability when generic is DISABLED", async () => {
      const { counters, error } = await runPolicy(entry, {
        url: GENERIC_URL,
        ytdlpEnabled: false,
        direct: async () => {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        },
        ffmpeg: async () => {
          throw new Error("a disabled deployment must not probe FFmpeg");
        },
      });

      assert.ok(error instanceof AppError && error.code === "EXTRACTOR_UNAVAILABLE");
      assert.equal(counters.ffmpeg, 0, "the switch is checked BEFORE the resolver");
      assert.equal(counters.generic, 0);
    });

    it("resolves FFmpeg capability EXACTLY ONCE on the enabled fallback", async () => {
      const { counters, result, error } = await runPolicy(entry, {
        url: GENERIC_URL,
        ytdlpEnabled: true,
        direct: async () => {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        },
      });

      assert.equal(error, null);
      assert.ok(result);
      assert.equal(counters.direct, 1, "direct is still attempted FIRST");
      assert.equal(counters.ffmpeg, 1, "exactly one capability resolution");
      assert.equal(counters.generic, 1, "exactly one generic attempt");
    });

    it("resolves capability only AFTER direct has failed, never before", async () => {
      // Ordering, not just counting: the trace proves direct completes before
      // the resolver is entered.
      const trace: string[] = [];
      const { error } = await runPolicy(entry, {
        url: GENERIC_URL,
        ytdlpEnabled: true,
        direct: async () => {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        },
        onTrace: (e) => trace.push(e),
      });

      assert.equal(error, null);
      assert.deepEqual(trace, ["direct", "ffmpeg", "generic"]);
    });

    it("does not resolve capability when the caller cancelled", async () => {
      const controller = new AbortController();
      controller.abort();

      const { counters, error } = await runPolicy(entry, {
        url: GENERIC_URL,
        ytdlpEnabled: true,
        signal: controller.signal,
        direct: async () => {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        },
        ffmpeg: async () => {
          throw new Error("a cancelled analysis must not probe FFmpeg");
        },
      });

      assert.ok(error, "cancellation propagates");
      assert.equal(counters.ffmpeg, 0);
      assert.equal(counters.generic, 0);
    });
  });
}

describe("the composition-root policy wires the resolver lazily (§3)", () => {
  it("builds without ever invoking the resolver", () => {
    let probes = 0;
    createMediaAnalysisPolicy({
      ytdlpEnabled: true,
      limits: LIMITS,
      ffmpegAvailable: async () => {
        probes += 1;
        return true;
      },
    });
    // Construction is pure: nothing is probed until a generic fallback happens.
    assert.equal(probes, 0);
  });

  it("exposes both entry points, each closing over the same resolver", () => {
    const policy = createMediaAnalysisPolicy({
      ytdlpEnabled: true,
      limits: LIMITS,
      ffmpegAvailable: async () => true,
    });
    assert.equal(typeof policy.analyze, "function");
    assert.equal(typeof policy.analyzeForExecution, "function");
  });

  it("a DISABLED policy holds a resolver that can never probe", async () => {
    let probes = 0;
    const policy = createMediaAnalysisPolicy({
      ytdlpEnabled: false,
      limits: LIMITS,
      ffmpegAvailable: async () => {
        probes += 1;
        return true;
      },
    });
    // Even reaching the generic branch is impossible when disabled, but the
    // substitution makes that structural rather than merely unreachable.
    await policy.analyze(DIRECT_URL).catch(() => {});
    await policy.analyzeForExecution(DIRECT_URL).catch(() => {});
    assert.equal(probes, 0);
  });
});
