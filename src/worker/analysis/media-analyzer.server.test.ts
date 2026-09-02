import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError, type ErrorCode } from "../../lib/errors.ts";
import { WORKER_ERROR_CODES } from "../../shared/worker/errors.ts";
import type {
  WorkerExtractorStrategy,
  WorkerVideoMetadata,
} from "../../shared/worker/contracts.ts";
import {
  GENERIC_FALLBACK_TRIGGER_CODE,
  analyzeMedia,
  directFailureAllowsGenericFallback,
  type GenericAnalyzeFn,
} from "./media-analyzer.server.ts";
import type { GenericAnalysisLimits } from "./ytdlp-analysis.server.ts";

const URL_UNDER_TEST = "https://example.invalid/watch/abc";

const LIMITS: GenericAnalysisLimits = {
  analysisTimeoutSeconds: 45,
  maxVideoDurationSeconds: 7200,
  maxFileSizeBytes: 500 * 1024 * 1024,
};

function metadata(extractor: WorkerExtractorStrategy): WorkerVideoMetadata {
  return {
    title: "A Video",
    thumbnail: null,
    duration: 120,
    source: "example.invalid",
    extractor,
    webpageUrl: URL_UNDER_TEST,
    formats: [],
    presets: [],
    capabilities: { mp3: false, merge: false },
  };
}

const DIRECT_RESULT = metadata("direct");
const GENERIC_RESULT = metadata("yt-dlp");

/** Records whether — and how often — the generic analyzer was reached. */
function spyGeneric(result: WorkerVideoMetadata | Error = GENERIC_RESULT) {
  const calls: Parameters<GenericAnalyzeFn>[] = [];
  const fn: GenericAnalyzeFn = async (url, opts) => {
    calls.push([url, opts]);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fn, calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

// ── Direct success ───────────────────────────────────────────────────────────

describe("strategy router: direct success", () => {
  for (const ytdlpEnabled of [true, false]) {
    it(`returns direct metadata and never calls generic (ytdlpEnabled=${ytdlpEnabled})`, async () => {
      const generic = spyGeneric();
      const result = await analyzeMedia(URL_UNDER_TEST, {
        ytdlpEnabled,
        limits: LIMITS,
        analyzeDirect: async () => DIRECT_RESULT,
        analyzeGeneric: generic.fn,
      });

      assert.equal(result, DIRECT_RESULT, "direct metadata must be preserved exactly");
      assert.equal(result.extractor, "direct");
      assert.equal(generic.calls.length, 0, "the generic analyzer must not run");
    });
  }

  it("does not reshape direct metadata to resemble generic metadata", async () => {
    const rich: WorkerVideoMetadata = {
      ...DIRECT_RESULT,
      formats: [
        {
          id: "direct-original",
          resolution: "unknown",
          width: null,
          height: null,
          fps: null,
          container: "mp4",
          videoCodec: null,
          audioCodec: null,
          bitrate: null,
          fileSize: 1234,
          hasVideo: true,
          hasAudio: true,
          formatNote: null,
        },
      ],
      capabilities: { mp3: true, merge: true },
    };
    const result = await analyzeMedia(URL_UNDER_TEST, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => rich,
      analyzeGeneric: spyGeneric().fn,
    });
    assert.deepEqual(result, rich, "direct's own contract stays untouched");
  });
});

// ── Fallback gating ──────────────────────────────────────────────────────────

describe("strategy router: EXTRACTOR_UNAVAILABLE is the only fallback trigger", () => {
  it("does NOT call generic when the feature is disabled, and stays fail-closed", async () => {
    const generic = spyGeneric();
    const err = await rejection(
      analyzeMedia(URL_UNDER_TEST, {
        ytdlpEnabled: false,
        limits: LIMITS,
        analyzeDirect: async () => {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        },
        analyzeGeneric: generic.fn,
      }),
    );

    assert.ok(err instanceof AppError);
    assert.equal(err.code, "EXTRACTOR_UNAVAILABLE");
    assert.equal(generic.calls.length, 0);
  });

  it("defaults to disabled when ytdlpEnabled is omitted", async () => {
    const generic = spyGeneric();
    const err = await rejection(
      analyzeMedia(URL_UNDER_TEST, {
        limits: LIMITS,
        analyzeDirect: async () => {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        },
        analyzeGeneric: generic.fn,
      }),
    );
    assert.ok(err instanceof AppError && err.code === "EXTRACTOR_UNAVAILABLE");
    assert.equal(generic.calls.length, 0, "absent must mean disabled");
  });

  it("calls generic EXACTLY once when enabled and direct is unavailable", async () => {
    const generic = spyGeneric();
    const result = await analyzeMedia(URL_UNDER_TEST, {
      ytdlpEnabled: true,
      limits: LIMITS,
      ffmpegAvailable: true,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: generic.fn,
    });

    assert.equal(result, GENERIC_RESULT);
    assert.equal(result.extractor, "yt-dlp");
    assert.equal(generic.calls.length, 1);
    assert.equal(generic.calls[0]![0], URL_UNDER_TEST);
    assert.deepEqual(generic.calls[0]![1].limits, LIMITS);
    assert.equal(generic.calls[0]![1].ffmpegAvailable, true);
  });

  it("never falls back after any OTHER direct failure", async () => {
    // Every Worker error code except the single trigger must be terminal.
    const others = WORKER_ERROR_CODES.filter((c) => c !== GENERIC_FALLBACK_TRIGGER_CODE);
    assert.ok(others.length >= 10, "the matrix must cover the real code set");

    for (const code of others) {
      const generic = spyGeneric();
      const err = await rejection(
        analyzeMedia(URL_UNDER_TEST, {
          ytdlpEnabled: true,
          limits: LIMITS,
          analyzeDirect: async () => {
            throw new AppError(code as ErrorCode);
          },
          analyzeGeneric: generic.fn,
        }),
      );

      assert.ok(err instanceof AppError, `${code} should propagate as an AppError`);
      assert.equal(err.code, code, `${code} must propagate unchanged`);
      assert.equal(
        generic.calls.length,
        0,
        `a ${code} failure must never start a second network path`,
      );
    }
  });

  it("specifically refuses to retry a security refusal through yt-dlp", async () => {
    // The case that matters most: the Worker's SSRF/URL boundary said no.
    const generic = spyGeneric();
    const err = await rejection(
      analyzeMedia("http://169.254.169.254/latest/meta-data", {
        ytdlpEnabled: true,
        limits: LIMITS,
        analyzeDirect: async () => {
          throw new AppError("INVALID_URL");
        },
        analyzeGeneric: generic.fn,
      }),
    );
    assert.ok(err instanceof AppError && err.code === "INVALID_URL");
    assert.equal(generic.calls.length, 0);
  });

  it("does not fall back after an unexpected non-AppError exception", async () => {
    const generic = spyGeneric();
    const boom = new TypeError("undefined is not a function");
    const err = await rejection(
      analyzeMedia(URL_UNDER_TEST, {
        ytdlpEnabled: true,
        limits: LIMITS,
        analyzeDirect: async () => {
          throw boom;
        },
        analyzeGeneric: generic.fn,
      }),
    );
    assert.equal(err, boom, "an unknown crash propagates verbatim");
    assert.equal(generic.calls.length, 0);
  });

  it("does not fall back when the caller cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const generic = spyGeneric();
    const cancelled = new AppError("EXTRACTOR_UNAVAILABLE");

    const err = await rejection(
      analyzeMedia(URL_UNDER_TEST, {
        ytdlpEnabled: true,
        limits: LIMITS,
        signal: controller.signal,
        analyzeDirect: async () => {
          throw cancelled;
        },
        analyzeGeneric: generic.fn,
      }),
    );

    assert.equal(err, cancelled);
    assert.equal(
      generic.calls.length,
      0,
      "an aborted analysis must not start a second, more capable client",
    );
  });
});

// ── The decision function itself ─────────────────────────────────────────────

describe("strategy router: fallback predicate", () => {
  it("is true for exactly one code and nothing else", () => {
    assert.equal(
      directFailureAllowsGenericFallback(new AppError("EXTRACTOR_UNAVAILABLE")),
      true,
    );
    for (const code of WORKER_ERROR_CODES.filter((c) => c !== GENERIC_FALLBACK_TRIGGER_CODE)) {
      assert.equal(
        directFailureAllowsGenericFallback(new AppError(code as ErrorCode)),
        false,
        `${code} must not permit fallback`,
      );
    }
  });

  it("is false for non-AppError values", () => {
    for (const value of [
      new Error("EXTRACTOR_UNAVAILABLE"),
      { code: "EXTRACTOR_UNAVAILABLE" },
      "EXTRACTOR_UNAVAILABLE",
      null,
      undefined,
    ]) {
      assert.equal(directFailureAllowsGenericFallback(value), false);
    }
  });
});

// ── Generic-path outcomes ────────────────────────────────────────────────────

describe("strategy router: generic outcomes", () => {
  it("propagates a generic failure without a third attempt", async () => {
    const failure = new AppError("UNSUPPORTED_SITE");
    const generic = spyGeneric(failure);
    const err = await rejection(
      analyzeMedia(URL_UNDER_TEST, {
        ytdlpEnabled: true,
        limits: LIMITS,
        analyzeDirect: async () => {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        },
        analyzeGeneric: generic.fn,
      }),
    );
    assert.equal(err, failure);
    assert.equal(generic.calls.length, 1);
  });

  it("forwards the AbortSignal to the generic analyzer", async () => {
    const controller = new AbortController();
    const generic = spyGeneric();
    await analyzeMedia(URL_UNDER_TEST, {
      ytdlpEnabled: true,
      limits: LIMITS,
      signal: controller.signal,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: generic.fn,
    });
    assert.equal(generic.calls[0]![1].signal, controller.signal);
  });

  it("passes the URL through untouched", async () => {
    const generic = spyGeneric();
    const weird = "https://example.invalid/a%20b?x=1&y=--exec";
    await analyzeMedia(weird, {
      ytdlpEnabled: true,
      limits: LIMITS,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: generic.fn,
    });
    assert.equal(generic.calls[0]![0], weird, "the router does not rewrite the URL");
  });
});
