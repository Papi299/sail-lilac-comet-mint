import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../../lib/errors.ts";
import type { RunResult } from "../../services/processing/process-runner.server.ts";
import { ProcessOutputLimitError } from "../../services/processing/process-runner.server.ts";
import {
  GENERIC_PRESET_ID_PATTERN,
  YTDLP_ANALYSIS_MAX_PRESETS,
  YTDLP_ANALYSIS_MAX_RAW_FORMATS,
  YTDLP_ANALYSIS_MAX_STDERR_BYTES,
  YTDLP_ANALYSIS_MAX_STDOUT_BYTES,
  YTDLP_ANALYSIS_FFMPEG_LOCATION,
  YTDLP_ANALYSIS_MAX_TITLE_LENGTH,
  YTDLP_ANALYSIS_PATH,
  YTDLP_V1_NATIVE_PROTOCOLS,
  buildYtdlpAnalysisEnvironment,
  analyzeGenericMedia,
  analyzeGenericMediaInternal,
  assertGenericPresetBuild,
  buildGenericPresets,
  buildYtdlpAnalysisArgv,
  classifyAnalysisFailure,
  classifyCodecState,
  parseAnalysisInfo,
  sanitizeUpstreamText,
  selectCandidates,
  ytdlpAnalysisPolicyArgs,
  type GenericAnalysisLimits,
} from "./ytdlp-analysis.server.ts";
import { buildYtdlpEnvironment } from "../runtime/ytdlp-runtime.server.ts";
import {
  buildGenericFormatSelector,
  splitTargetContainer,
  type GenericPresetSource,
  type GenericSourceSelection,
  type GenericSplitSourceSelection,
} from "../execution/generic-source.ts";

/**
 * Unwraps a preset source that must be SINGLE at this call site.
 *
 * SPLIT-01 widened the private per-preset value to a discriminated union, and
 * SPLIT-05 made the split arm reachable. Every use of this helper is therefore a
 * positive claim that THIS preset is fulfilled by exactly one upstream source —
 * an audio preset, or a video preset backed by a muxed rendition — and it fails
 * loudly if that stops being true.
 */
function singleSource(value: GenericPresetSource | undefined): GenericSourceSelection {
  assert.ok(value, "every advertised preset must have a private selection");
  assert.equal(value.kind, "single", "this preset must be fulfilled by one source");
  if (value.kind !== "single") throw new Error("unreachable");
  return value.source;
}

/** Unwraps a preset source that must be a SPLIT pair at this call site. */
function splitPair(value: GenericPresetSource | undefined): GenericSplitSourceSelection {
  assert.ok(value, "every advertised preset must have a private selection");
  assert.equal(value.kind, "split", "this preset must be fulfilled by a pair");
  if (value.kind !== "split") throw new Error("unreachable");
  return value.pair;
}

/**
 * Every upstream source one preset names: one for a muxed/audio selection, two
 * for a pair.
 *
 * Shape-aware on purpose. A privacy or selector assertion that only looked at
 * `kind: "single"` values would silently stop covering the split halves the day
 * they became reachable, which is exactly when the coverage matters most.
 */
function selectionMembers(value: GenericPresetSource): GenericSourceSelection[] {
  return value.kind === "single" ? [value.source] : [value.pair.video, value.pair.audio];
}
import { WorkerAnalyzeSuccessSchema } from "../../shared/worker/contracts.ts";
import {
  YTDLP_PROBE_TIMEOUT_MS,
  YTDLP_RUNTIME,
  type YtdlpProbeOptions,
  type YtdlpRuntimeStatus,
} from "../runtime/ytdlp-runtime.server.ts";

/**
 * The secret-bearing URL used throughout. It never appears in a real request:
 * every test that uses it feeds it to a FAKE runner, and the assertions are
 * about the sentinel NOT escaping into an error, a return value or a log.
 */
const SECRET_URL = "https://example.invalid/video?token=SUPER_SECRET_VALUE";
const SENTINEL = "SUPER_SECRET_VALUE";

const SAFE_URL = "https://example.invalid/watch/abc";

const LIMITS: GenericAnalysisLimits = {
  analysisTimeoutSeconds: 45,
  maxVideoDurationSeconds: 2 * 60 * 60,
  maxFileSizeBytes: 500 * 1024 * 1024,
};

const OK_RUNTIME: YtdlpRuntimeStatus = Object.freeze({
  available: true,
  version: YTDLP_RUNTIME.expectedVersion,
  reason: "ok" as const,
});

function unavailableRuntime(reason: YtdlpRuntimeStatus["reason"]): YtdlpRuntimeStatus {
  return Object.freeze({ available: false, version: null, reason });
}

type RunnerCall = Parameters<
  NonNullable<Parameters<typeof analyzeGenericMedia>[1]["runner"]>
>[0];

/** A runner that records its calls and answers with a canned result. */
function fakeRunner(result: RunResult | (() => Promise<RunResult>)) {
  const calls: RunnerCall[] = [];
  const runner = async (opts: RunnerCall): Promise<RunResult> => {
    calls.push(opts);
    return typeof result === "function" ? result() : result;
  };
  return { runner, calls };
}

/** A runner that fails the test if it is ever invoked. */
function forbiddenRunner() {
  const calls: RunnerCall[] = [];
  const runner = async (opts: RunnerCall): Promise<RunResult> => {
    calls.push(opts);
    throw new Error("a subprocess was spawned when none was permitted");
  };
  return { runner, calls };
}

function singleVideoInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _type: "video",
    title: "A Video",
    duration: 120,
    live_status: "not_live",
    formats: [
      {
        format_id: "http-1080",
        ext: "mp4",
        height: 1080,
        width: 1920,
        fps: 30,
        vcodec: "avc1.640028",
        acodec: "mp4a.40.2",
        filesize: 10_000_000,
        protocol: "https",
      },
    ],
    ...overrides,
  };
}

function ok(stdout: string): RunResult {
  return { code: 0, stdout, stderr: "" };
}

async function analyze(
  url: string,
  opts: {
    runner: (o: RunnerCall) => Promise<RunResult>;
    probeRuntime?: (o: YtdlpProbeOptions) => Promise<YtdlpRuntimeStatus>;
    validateUrl?: (raw: string) => Promise<{ url: string; hostname: string }>;
    ffmpegAvailable?: boolean;
    signal?: AbortSignal;
    limits?: GenericAnalysisLimits;
    clock?: () => number;
  },
) {
  return analyzeGenericMedia(url, {
    limits: opts.limits ?? LIMITS,
    runner: opts.runner,
    clock: opts.clock,
    probeRuntime: opts.probeRuntime ?? (async () => OK_RUNTIME),
    // The default validator is the real SSRF boundary, which performs DNS.
    // Unit tests inject a pure one and exercise the real boundary separately.
    validateUrl:
      opts.validateUrl ??
      (async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname })),
    ffmpegAvailable: opts.ffmpegAvailable ?? false,
    signal: opts.signal,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
  assert.equal(err.code, code);
  return err;
}

// ── Nothing spawns for input the Worker already refused ──────────────────────

describe("generic analysis: unsafe or malformed input spawns nothing", () => {
  it("a malformed request URL spawns no process at all", async () => {
    const { runner, calls } = forbiddenRunner();
    let probed = 0;

    await expectCode(
      analyzeGenericMedia("not-a-url", {
        limits: LIMITS,
        runner,
        probeRuntime: async () => {
          probed += 1;
          return OK_RUNTIME;
        },
      }),
      "INVALID_URL",
    );

    assert.equal(calls.length, 0, "no analysis subprocess may run");
    assert.equal(probed, 0, "the version probe must not run for an invalid URL");
  });

  it("a non-http scheme is refused before any process", async () => {
    const { runner, calls } = forbiddenRunner();
    let probed = 0;
    await expectCode(
      analyzeGenericMedia("file:///etc/passwd", {
        limits: LIMITS,
        runner,
        probeRuntime: async () => {
          probed += 1;
          return OK_RUNTIME;
        },
      }),
      "INVALID_URL",
    );
    assert.equal(calls.length, 0);
    assert.equal(probed, 0);
  });

  it("an SSRF/private-address rejection spawns nothing, probe included", async () => {
    const { runner, calls } = forbiddenRunner();
    let probed = 0;

    await expectCode(
      analyzeGenericMedia("http://169.254.169.254/latest/meta-data", {
        limits: LIMITS,
        runner,
        probeRuntime: async () => {
          probed += 1;
          return OK_RUNTIME;
        },
        // Stands in for the real boundary's private-address refusal.
        validateUrl: async () => {
          throw new AppError("INVALID_URL");
        },
      }),
      "INVALID_URL",
    );

    assert.equal(calls.length, 0, "no yt-dlp subprocess may run");
    assert.equal(probed, 0, "no Node/EJS descendant may exist either");
  });

  it("propagates the URL boundary's NETWORK_ERROR without spawning", async () => {
    const { runner, calls } = forbiddenRunner();
    await expectCode(
      analyzeGenericMedia(SAFE_URL, {
        limits: LIMITS,
        runner,
        probeRuntime: async () => OK_RUNTIME,
        validateUrl: async () => {
          throw new AppError("NETWORK_ERROR");
        },
      }),
      "NETWORK_ERROR",
    );
    assert.equal(calls.length, 0);
  });
});

// ── Exact runtime gate ───────────────────────────────────────────────────────

describe("generic analysis: exact pinned-runtime gate", () => {
  for (const reason of [
    "process_error",
    "version_mismatch",
    "malformed_output",
    "timeout",
  ] as const) {
    it(`fails closed with EXTRACTOR_UNAVAILABLE when the runtime reports '${reason}'`, async () => {
      const { runner, calls } = forbiddenRunner();
      await expectCode(
        analyze(SAFE_URL, {
          runner,
          probeRuntime: async () => unavailableRuntime(reason),
        }),
        "EXTRACTOR_UNAVAILABLE",
      );
      assert.equal(calls.length, 0, "no generic network subprocess may run");
    });
  }

  it("runs the analysis only after the probe answered with the exact version", async () => {
    const order: string[] = [];
    const { runner, calls } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));

    await analyzeGenericMedia(SAFE_URL, {
      limits: LIMITS,
      runner: async (o) => {
        order.push("analysis");
        return runner(o);
      },
      probeRuntime: async () => {
        order.push("probe");
        return OK_RUNTIME;
      },
      validateUrl: async (raw) => {
        order.push("validate");
        return { url: raw, hostname: new URL(raw).hostname };
      },
    });

    assert.deepEqual(order, ["validate", "probe", "analysis"]);
    assert.equal(calls.length, 1);
  });
});

// ── The argv ─────────────────────────────────────────────────────────────────

describe("generic analysis: closed argv", () => {
  const argv = buildYtdlpAnalysisArgv(SAFE_URL);

  it("executes the pinned artifact and puts the URL last, after a bare --", () => {
    assert.equal(argv[0], YTDLP_RUNTIME.artifactPath);
    assert.equal(argv.at(-1), SAFE_URL);
    assert.equal(argv.at(-2), "--", "the URL must be the first positional after --");
    assert.equal(argv.filter((a) => a === "--").length, 1);
  });

  it("carries the Phase-10C1 base policy unchanged", () => {
    for (const flag of [
      "--ignore-config",
      "--no-config-locations",
      "--no-plugin-dirs",
      "--no-js-runtimes",
      "--no-remote-components",
      "--no-update",
      "--no-cookies",
      "--no-cookies-from-browser",
      "--no-playlist",
      "--downloader=native",
    ]) {
      assert.ok(argv.includes(flag), `base policy flag ${flag} is missing`);
    }
    assert.ok(
      argv.some((a) => a.startsWith("--js-runtimes=node:")),
      "Node must be the only enabled JS runtime",
    );
    assert.ok(
      argv.indexOf("--no-js-runtimes") <
        argv.findIndex((a) => a.startsWith("--js-runtimes=")),
      "--no-js-runtimes must precede --js-runtimes, which appends",
    );
  });

  it("carries the analysis policy", () => {
    for (const flag of ["--dump-single-json", "--skip-download", "--no-progress", "--no-warnings", "--no-cache-dir"]) {
      assert.ok(argv.includes(flag), `analysis flag ${flag} is missing`);
    }
    assert.ok(argv.includes("--socket-timeout=10"));
    assert.ok(argv.includes("--retries=2"));
    assert.ok(argv.includes("--extractor-retries=1"));
  });

  it("contains no output template, format selector, or acquisition option", () => {
    const banned = [
      "-o",
      "--output",
      "-P",
      "--paths",
      "-f",
      "--format",
      "--merge-output-format",
      "--remux-video",
      "--recode-video",
      "-x",
      "--extract-audio",
      "--audio-format",
      "--download-sections",
      "--wait-for-video",
      "--write-info-json",
      "--write-thumbnail",
      "--write-description",
      "--write-subs",
      "--write-auto-subs",
      "--write-comments",
      "--download-archive",
      "--cookies",
      "--cookies-from-browser",
      "--netrc",
      "--username",
      "--password",
      "--video-password",
      "--proxy",
      "--add-header",
      "--exec",
      "--postprocessor-args",
      "--load-info-json",
    ];
    for (const flag of banned) {
      assert.ok(!argv.includes(flag), `argv must not contain ${flag}`);
      assert.ok(
        !argv.some((a) => a.startsWith(`${flag}=`)),
        `argv must not contain ${flag}=…`,
      );
    }
  });

  it("enables no JavaScript runtime other than Node", () => {
    const joined = argv.join(" ");
    for (const runtime of ["deno", "bun", "quickjs"]) {
      assert.ok(!joined.toLowerCase().includes(runtime), `${runtime} must not be enabled`);
    }
  });

  it("never lets a hostile URL become an option", () => {
    // Neither of these can be an option: everything after `--` is positional.
    for (const hostile of [
      "https://example.invalid/--exec=curl",
      "https://example.invalid/?x=--output",
    ]) {
      const built = buildYtdlpAnalysisArgv(hostile);
      assert.equal(built.at(-1), hostile);
      assert.equal(built.at(-2), "--");
      // The URL is the ONLY element after the barrier.
      assert.equal(built.length - built.indexOf("--"), 2);
    }
  });

  it("the analysis policy adds nothing that is not verified against the pin", () => {
    // Guards against a future edit adding an unreviewed flag.
    assert.deepEqual(
      [...ytdlpAnalysisPolicyArgs()],
      [
        "--dump-single-json",
        "--skip-download",
        "--no-progress",
        "--no-warnings",
        "--no-cache-dir",
        "--socket-timeout=10",
        "--retries=2",
        "--extractor-retries=1",
        `--ffmpeg-location=${YTDLP_ANALYSIS_FFMPEG_LOCATION}`,
      ],
    );
  });

  it("passes the analysis byte ceilings and the pinned interpreter to the runner", async () => {
    const { runner, calls } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));
    await analyze(SAFE_URL, { runner });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.command, YTDLP_RUNTIME.pythonPath);
    assert.equal(call.maxStdoutBytes, YTDLP_ANALYSIS_MAX_STDOUT_BYTES);
    assert.equal(call.maxStderrBytes, YTDLP_ANALYSIS_MAX_STDERR_BYTES);
    assert.equal(call.timeoutMs, LIMITS.analysisTimeoutSeconds * 1000);
    // The environment is the ANALYSIS closed allowlist, never the ambient one
    // and never the base one that keeps /usr/bin (where ffmpeg lives) on PATH.
    assert.equal(call.env?.PATH, YTDLP_ANALYSIS_PATH);
    assert.equal(call.env?.PYTHONPATH, undefined);
  });

  it("forwards the caller's AbortSignal to the hardened runner", async () => {
    const controller = new AbortController();
    const { runner, calls } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));
    await analyze(SAFE_URL, { runner, signal: controller.signal });
    assert.equal(calls[0]!.signal, controller.signal);
  });
});

// ── Single-item enforcement ──────────────────────────────────────────────────

describe("generic analysis: single-item contract", () => {
  it("accepts an unambiguous single-video info object", () => {
    const parsed = parseAnalysisInfo(JSON.stringify(singleVideoInfo()));
    assert.equal(parsed.ok, true);
  });

  it("rejects a playlist result even though --no-playlist was passed", () => {
    const parsed = parseAnalysisInfo(
      JSON.stringify({
        _type: "playlist",
        title: "A Playlist",
        entries: [singleVideoInfo(), singleVideoInfo()],
      }),
    );
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.rejection, "not_single_video");
  });

  it("rejects a multi_video result", () => {
    const parsed = parseAnalysisInfo(
      JSON.stringify({ _type: "multi_video", entries: [singleVideoInfo()] }),
    );
    assert.equal(parsed.ok === false && parsed.rejection, "not_single_video");
  });

  it("rejects an unresolved url / url_transparent indirection", () => {
    for (const type of ["url", "url_transparent"]) {
      const parsed = parseAnalysisInfo(JSON.stringify({ _type: type, title: "x" }));
      assert.equal(parsed.ok === false && parsed.rejection, "not_single_video");
    }
  });

  it("rejects an unknown _type rather than guessing", () => {
    const parsed = parseAnalysisInfo(JSON.stringify({ _type: "something_new", title: "x" }));
    assert.equal(parsed.ok === false && parsed.rejection, "not_single_video");
  });

  it("rejects a 'video' object that nonetheless carries entries", () => {
    const parsed = parseAnalysisInfo(
      JSON.stringify({ ...singleVideoInfo(), entries: [singleVideoInfo()] }),
    );
    assert.equal(parsed.ok === false && parsed.rejection, "multi_entry");
  });

  it("surfaces a playlist as UNSUPPORTED_SITE, not as a partial success", async () => {
    const { runner } = fakeRunner(
      ok(JSON.stringify({ _type: "playlist", entries: [singleVideoInfo()] })),
    );
    await expectCode(analyze(SAFE_URL, { runner }), "UNSUPPORTED_SITE");
  });
});

// ── Live rejection ───────────────────────────────────────────────────────────

describe("generic analysis: live and wait-for-media sources", () => {
  it("rejects is_live: true", () => {
    const parsed = parseAnalysisInfo(JSON.stringify(singleVideoInfo({ is_live: true })));
    assert.equal(parsed.ok === false && parsed.rejection, "live_source");
  });

  for (const status of ["is_live", "is_upcoming", "post_live"]) {
    it(`rejects live_status '${status}'`, () => {
      const parsed = parseAnalysisInfo(
        JSON.stringify(singleVideoInfo({ live_status: status })),
      );
      assert.equal(parsed.ok === false && parsed.rejection, "live_source");
    });
  }

  for (const status of ["not_live", "was_live"]) {
    it(`accepts finished source with live_status '${status}'`, () => {
      const parsed = parseAnalysisInfo(
        JSON.stringify(singleVideoInfo({ live_status: status })),
      );
      assert.equal(parsed.ok, true);
    });
  }

  it("accepts an unknown live_status (absent)", () => {
    const info = singleVideoInfo();
    delete (info as Record<string, unknown>).live_status;
    assert.equal(parseAnalysisInfo(JSON.stringify(info)).ok, true);
  });

  it("surfaces a live source as VIDEO_UNAVAILABLE", async () => {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ is_live: true }))));
    await expectCode(analyze(SAFE_URL, { runner }), "VIDEO_UNAVAILABLE");
  });
});

// ── Raw JSON validation and bounds ───────────────────────────────────────────

describe("generic analysis: bounded, strictly validated JSON", () => {
  it("rejects malformed JSON", () => {
    for (const bad of ["{not json", "", "null", "[1,2,3]", "\u0000"]) {
      const parsed = parseAnalysisInfo(bad);
      assert.equal(parsed.ok, false, `${JSON.stringify(bad)} should be rejected`);
    }
    const truncated = parseAnalysisInfo('{"_type":"video","title":"a');
    assert.equal(truncated.ok, false);
    assert.equal(truncated.ok === false ? truncated.rejection : null, "malformed_json");
  });

  it("rejects wrong field types", () => {
    for (const bad of [
      { _type: "video", duration: "120" },
      { _type: "video", is_live: "yes" },
      { _type: "video", title: 42 },
      { _type: "video", formats: "many" },
      { _type: "video", formats: [{ height: "1080" }] },
    ]) {
      const parsed = parseAnalysisInfo(JSON.stringify(bad));
      assert.equal(parsed.ok, false, `${JSON.stringify(bad)} should be rejected`);
      assert.equal(parsed.ok === false && parsed.rejection, "invalid_shape");
    }
  });

  it(`rejects more than ${YTDLP_ANALYSIS_MAX_RAW_FORMATS} raw formats`, () => {
    const formats = Array.from({ length: YTDLP_ANALYSIS_MAX_RAW_FORMATS + 1 }, () => ({
      ext: "mp4",
      protocol: "https",
      vcodec: "avc1",
      acodec: "mp4a",
      height: 720,
    }));
    const parsed = parseAnalysisInfo(JSON.stringify({ ...singleVideoInfo(), formats }));
    assert.equal(parsed.ok === false && parsed.rejection, "too_many_formats");
  });

  it(`accepts exactly ${YTDLP_ANALYSIS_MAX_RAW_FORMATS} raw formats`, () => {
    const formats = Array.from({ length: YTDLP_ANALYSIS_MAX_RAW_FORMATS }, () => ({
      ext: "mp4",
      protocol: "https",
      vcodec: "avc1",
      acodec: "mp4a",
      height: 720,
    }));
    assert.equal(
      parseAnalysisInfo(JSON.stringify({ ...singleVideoInfo(), formats })).ok,
      true,
    );
  });

  it("strips unknown upstream fields instead of trusting them", () => {
    const parsed = parseAnalysisInfo(
      JSON.stringify({ ...singleVideoInfo(), __evil: "x", extractor: "Evil", webpage_url: "http://evil.invalid" }),
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal("__evil" in parsed.info, false);
      assert.equal("extractor" in parsed.info, false);
      assert.equal("webpage_url" in parsed.info, false);
    }
  });

  it("parses an upstream format_id, and keeps every other identity field out", () => {
    // §10: Phase-10C2 could say "format_id is not parsed at all", because no
    // execution path existed to select a source. Phase 10C3 acquires media, so
    // the Worker must be able to name the exact source it approved. The
    // guarantee therefore moves from "never parsed" to "never ESCAPES the
    // private execution structure" — asserted below and, end-to-end, by
    // "never lets an upstream format_id reach the response".
    const parsed = parseAnalysisInfo(JSON.stringify(singleVideoInfo()));
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      for (const format of parsed.info.formats ?? []) {
        assert.equal(format.format_id, "http-1080");
        // The other upstream identity fields stay structurally absent: nothing
        // needs them, so the schema does not admit them.
        for (const field of ["url", "manifest_url", "fragment_base_url", "http_headers"]) {
          assert.equal(field in format, false, `${field} must stay unparsed`);
        }
      }
    }
  });

  it("rejects oversized stdout without parsing it", async () => {
    const { runner } = fakeRunner(async () => {
      throw new ProcessOutputLimitError("stdout");
    });
    const err = await expectCode(analyze(SAFE_URL, { runner }), "EXTRACTION_FAILED");
    assert.equal(err.message.includes("stdout"), false, "no runner detail may leak");
  });
});

// ── Candidate eligibility and presets ────────────────────────────────────────

let videoFixtureSeq = 0;

function video(overrides: Record<string, unknown> = {}) {
  return {
    // Since Phase 10C3 a candidate must carry an upstream id matching the safe
    // grammar to be eligible at all (§11), so the fixture supplies a distinct
    // safe one. Distinctness matters: several tests build multi-format ladders
    // and each rung must be separately identifiable as a source.
    format_id: `http-${(videoFixtureSeq += 1)}`,
    ext: "mp4",
    height: 1080,
    width: 1920,
    fps: 30,
    vcodec: "avc1.640028",
    acodec: "mp4a.40.2",
    protocol: "https",
    ...overrides,
  };
}

describe("generic analysis: candidate eligibility", () => {
  it("accepts a progressive https muxed format", () => {
    const candidates = selectCandidates([video()], LIMITS);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.hasVideo, true);
    assert.equal(candidates[0]!.hasAudio, true);
  });

  it("rejects every FFmpeg-forcing or unprovable acquisition protocol", () => {
    for (const protocol of [
      "m3u8",
      "m3u8_native",
      "rtmp_ffmpeg",
      "rtmp",
      "http_dash_segments",
      "ism",
      "mhtml",
      "websocket_frag",
      "niconico_live",
    ]) {
      assert.equal(
        selectCandidates([video({ protocol })], LIMITS).length,
        0,
        `${protocol} must not be an eligible v1 candidate`,
      );
    }
  });

  it("rejects a format with no protocol rather than guessing one", () => {
    const withoutProtocol = video();
    delete (withoutProtocol as Record<string, unknown>).protocol;
    assert.equal(selectCandidates([withoutProtocol], LIMITS).length, 0);
  });

  it("only allows the documented native protocol list", () => {
    assert.deepEqual([...YTDLP_V1_NATIVE_PROTOCOLS], ["http", "https"]);
  });

  it("drops storyboards, images and subtitle tracks", () => {
    for (const ext of ["mhtml", "jpg", "png", "webp", "vtt", "srt"]) {
      assert.equal(selectCandidates([video({ ext })], LIMITS).length, 0);
    }
    assert.equal(
      selectCandidates([video({ format_note: "storyboard" })], LIMITS).length,
      0,
    );
  });

  it("drops a candidate whose KNOWN size already exceeds the maximum", () => {
    assert.equal(
      selectCandidates([video({ filesize: LIMITS.maxFileSizeBytes + 1 })], LIMITS).length,
      0,
    );
    assert.equal(
      selectCandidates([video({ filesize_approx: LIMITS.maxFileSizeBytes + 1 })], LIMITS)
        .length,
      0,
    );
  });

  it("keeps a candidate whose size is unknown", () => {
    assert.equal(selectCandidates([video()], LIMITS).length, 1);
  });
});

describe("generic analysis: preset policy", () => {
  async function presetsFor(
    formats: Record<string, unknown>[],
    opts: { ffmpegAvailable?: boolean } = {},
  ) {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats }))));
    const meta = await analyze(SAFE_URL, {
      runner,
      ffmpegAvailable: opts.ffmpegAvailable ?? false,
    });
    return meta;
  }

  it("a muxed single-file source produces video presets", async () => {
    const meta = await presetsFor([video()]);
    const ids = meta.presets.map((p) => p.id);
    assert.ok(ids.includes("preset:best"));
    assert.ok(ids.includes("preset:1080"));
  });

  it("split-stream formats produce NO video preset WITHOUT Worker FFmpeg", async () => {
    // `presetsFor` defaults to `ffmpegAvailable: false`. A pair can only be
    // fulfilled by the Worker's own merge, so without it the pre-SPLIT-05
    // behaviour is exactly preserved: no video preset, and no merge capability.
    // The positive counterpart lives in the SPLIT-05 pairing suite below.
    const meta = await presetsFor([
      video({ acodec: "none", audio_ext: "none" }),
      { format_id: "audio-m4a", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", protocol: "https" },
    ]);
    const videoPresets = meta.presets.filter((p) => p.hasVideo);
    assert.deepEqual(videoPresets, [], "no local merge is available, so there is no pair");
    // The audio-only source is still usable on its own.
    assert.ok(meta.presets.some((p) => p.id === "preset:audio"));
    assert.equal(meta.capabilities.merge, false);
  });

  it("a muxed-only source never advertises merge capability", async () => {
    // `merge` describes THIS source: nothing here needs a merge, with or
    // without Worker FFmpeg, so the capability is false either way (§31).
    for (const ffmpegAvailable of [false, true]) {
      const meta = await presetsFor([video()], { ffmpegAvailable });
      assert.equal(meta.capabilities.merge, false);
    }
  });

  it("offers no preset at all when every format is ineligible", async () => {
    const meta = await presetsFor([video({ protocol: "m3u8_native" })]);
    assert.deepEqual(meta.presets, []);
    assert.equal(meta.capabilities.mp3, false);
  });

  it("buckets by resolution and never sacrifices resolution for a nicer codec", async () => {
    const meta = await presetsFor([
      video({ height: 1080, ext: "webm", vcodec: "vp09.00.40.08", acodec: "opus" }),
      video({ height: 720, ext: "mp4", vcodec: "avc1.640028", acodec: "mp4a.40.2" }),
    ]);
    const best = meta.presets.find((p) => p.id === "preset:best");
    assert.equal(best?.resolution, "1080p", "the 1080p source must win 'best'");
    assert.ok(meta.presets.some((p) => p.id === "preset:1080"));
    assert.ok(meta.presets.some((p) => p.id === "preset:720"));
  });

  it("prefers mp4/h264/aac WITHIN one resolution bucket, deterministically", async () => {
    const meta = await presetsFor([
      video({ height: 1080, ext: "webm", vcodec: "vp09.00.40.08", acodec: "opus" }),
      video({ height: 1080, ext: "mp4", vcodec: "avc1.640028", acodec: "mp4a.40.2" }),
    ]);
    const rung = meta.presets.find((p) => p.id === "preset:1080");
    assert.equal(rung?.container, "mp4");
    assert.equal(rung?.videoCodec, "h264");
    assert.equal(rung?.audioCodec, "aac");
  });

  it("is order-independent: shuffling the upstream list changes nothing", async () => {
    const formats = [
      video({ height: 720, ext: "mp4" }),
      video({ height: 1080, ext: "webm", vcodec: "vp9", acodec: "opus" }),
      video({ height: 1080, ext: "mp4" }),
      video({ height: 360, ext: "mp4" }),
    ];
    const a = await presetsFor(formats);
    const b = await presetsFor([...formats].reverse());
    assert.deepEqual(
      a.presets.map((p) => `${p.id}:${p.container}:${p.videoCodec}`),
      b.presets.map((p) => `${p.id}:${p.container}:${p.videoCodec}`),
    );
  });

  it("offers mp3 only when Worker FFmpeg is available", async () => {
    const without = await presetsFor([video()], { ffmpegAvailable: false });
    assert.equal(without.capabilities.mp3, false);
    assert.equal(without.presets.some((p) => p.id === "preset:mp3"), false);

    const with_ = await presetsFor([video()], { ffmpegAvailable: true });
    assert.equal(with_.capabilities.mp3, true);
    assert.ok(with_.presets.some((p) => p.id === "preset:mp3"));
  });

  it("offers audio from an audio-only source without needing FFmpeg", async () => {
    const meta = await presetsFor(
      [{ format_id: "audio-m4a", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", protocol: "https" }],
      { ffmpegAvailable: false },
    );
    const audio = meta.presets.find((p) => p.id === "preset:audio");
    assert.ok(audio, "an audio-only source needs no local processing");
    assert.equal(audio?.container, "m4a");
  });

  it("requires FFmpeg to derive audio from a muxed-only source", async () => {
    const meta = await presetsFor([video()], { ffmpegAvailable: false });
    assert.equal(
      meta.presets.some((p) => p.id === "preset:audio"),
      false,
      "extracting audio from a muxed source is Worker FFmpeg work",
    );
  });

  it("emits only application-owned preset ids, with id === formatId", async () => {
    const meta = await presetsFor(
      [video({ height: 2160 }), video({ height: 720 }), { format_id: "audio-m4a", ext: "m4a", vcodec: "none", acodec: "mp4a", protocol: "https" }],
      { ffmpegAvailable: true },
    );
    assert.ok(meta.presets.length > 0);
    for (const preset of meta.presets) {
      assert.match(preset.id, GENERIC_PRESET_ID_PATTERN);
      assert.equal(preset.formatId, preset.id);
    }
    assert.ok(meta.presets.length <= YTDLP_ANALYSIS_MAX_PRESETS);
  });

  it("never lets an upstream format_id reach the response", async () => {
    const meta = await presetsFor([
      video({ format_id: "999-EVIL-RAW-ID" }),
      video({ height: 720, format_id: "http-720-raw" }),
    ]);
    const serialized = JSON.stringify(meta);
    assert.equal(serialized.includes("EVIL-RAW-ID"), false);
    assert.equal(serialized.includes("http-720-raw"), false);
  });

  it("returns an EMPTY formats array for generic v1", async () => {
    const meta = await presetsFor([video(), video({ height: 720 })]);
    assert.deepEqual(meta.formats, [], "the advanced selector must have nothing raw to choose");
  });
});

// ── Metadata ownership ───────────────────────────────────────────────────────

describe("generic analysis: application-owned metadata", () => {
  it("reports extractor exactly 'yt-dlp' and keeps the validated URL authoritative", async () => {
    const { runner } = fakeRunner(
      ok(
        JSON.stringify({
          ...singleVideoInfo(),
          extractor: "EvilExtractor",
          extractor_key: "Evil",
          webpage_url: "https://attacker.invalid/elsewhere",
          original_url: "https://attacker.invalid/original",
        }),
      ),
    );
    const meta = await analyze(SAFE_URL, { runner });

    assert.equal(meta.extractor, "yt-dlp");
    assert.equal(meta.webpageUrl, SAFE_URL);
    assert.equal(meta.source, "example.invalid");
    const serialized = JSON.stringify(meta);
    assert.equal(serialized.includes("attacker.invalid"), false);
    assert.equal(serialized.includes("EvilExtractor"), false);
  });

  it("returns a null thumbnail rather than an arbitrary upstream URL", async () => {
    const { runner } = fakeRunner(
      ok(
        JSON.stringify({
          ...singleVideoInfo(),
          thumbnail: "https://attacker.invalid/track.gif?id=1",
          thumbnails: [{ url: "https://attacker.invalid/t2.gif" }],
        }),
      ),
    );
    const meta = await analyze(SAFE_URL, { runner });
    assert.equal(meta.thumbnail, null);
    assert.equal(JSON.stringify(meta).includes("attacker.invalid"), false);
  });

  it("strips control characters from the title", async () => {
    const { runner } = fakeRunner(
      ok(JSON.stringify(singleVideoInfo({ title: "Ti\u0000tle\u001B[31m\u0007 here\n\nx" }))),
    );
    const meta = await analyze(SAFE_URL, { runner });
    // eslint-disable-next-line no-control-regex -- asserting control characters are GONE
    assert.equal(/[\u0000-\u001F\u007F]/.test(meta.title), false);
    assert.equal(meta.title, "Ti tle [31m here x");
  });

  it("bounds the title length", async () => {
    const { runner } = fakeRunner(
      ok(JSON.stringify(singleVideoInfo({ title: "A".repeat(50_000) }))),
    );
    const meta = await analyze(SAFE_URL, { runner });
    assert.equal(meta.title.length, YTDLP_ANALYSIS_MAX_TITLE_LENGTH);
  });

  it("falls back to a safe title when upstream supplies none", async () => {
    for (const title of [null, "", "   "]) {
      const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ title }))));
      const meta = await analyze(SAFE_URL, { runner });
      assert.equal(meta.title, "Video");
    }
  });

  it("sanitizeUpstreamText is total", () => {
    assert.equal(sanitizeUpstreamText(undefined, 10, "fb"), "fb");
    assert.equal(sanitizeUpstreamText(null, 10, "fb"), "fb");
    assert.equal(sanitizeUpstreamText(42 as unknown as string, 10, "fb"), "fb");
    assert.equal(sanitizeUpstreamText("abcdefghijk", 5, "fb"), "abcde");
  });
});

// ── Duration ─────────────────────────────────────────────────────────────────

describe("generic analysis: duration bound", () => {
  it("rejects a video longer than the configured maximum", async () => {
    const { runner } = fakeRunner(
      ok(JSON.stringify(singleVideoInfo({ duration: LIMITS.maxVideoDurationSeconds + 1 }))),
    );
    await expectCode(analyze(SAFE_URL, { runner }), "TOO_LONG");
  });

  it("accepts a video exactly at the maximum", async () => {
    const { runner } = fakeRunner(
      ok(JSON.stringify(singleVideoInfo({ duration: LIMITS.maxVideoDurationSeconds }))),
    );
    const meta = await analyze(SAFE_URL, { runner });
    assert.equal(meta.duration, LIMITS.maxVideoDurationSeconds);
  });

  it("leaves an unknown duration null without rejecting", async () => {
    for (const duration of [null, 0]) {
      const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ duration }))));
      const meta = await analyze(SAFE_URL, { runner });
      assert.equal(meta.duration, null);
    }
  });
});

// ── Failure classification and privacy ───────────────────────────────────────

describe("generic analysis: error classification", () => {
  it("maps representative upstream failures onto canonical codes", () => {
    assert.equal(classifyAnalysisFailure("ERROR: Unsupported URL: https://x"), "UNSUPPORTED_SITE");
    assert.equal(classifyAnalysisFailure("ERROR: Private video. Sign in"), "VIDEO_UNAVAILABLE");
    assert.equal(classifyAnalysisFailure("ERROR: No video formats found"), "FORMAT_UNAVAILABLE");
    assert.equal(classifyAnalysisFailure("ERROR: The read operation timed out"), "TIMEOUT");
    assert.equal(
      classifyAnalysisFailure("ERROR: Unable to download webpage: connection refused"),
      "NETWORK_ERROR",
    );
  });

  it("collapses anything unrecognized to EXTRACTION_FAILED", () => {
    assert.equal(classifyAnalysisFailure("something entirely novel"), "EXTRACTION_FAILED");
    assert.equal(classifyAnalysisFailure(""), "EXTRACTION_FAILED");
  });

  it("canonicalizes a runner timeout", async () => {
    const { runner } = fakeRunner(async () => {
      throw new AppError("TIMEOUT");
    });
    await expectCode(analyze(SAFE_URL, { runner }), "TIMEOUT");
  });

  it("treats an unexpected spawn failure as EXTRACTOR_UNAVAILABLE", async () => {
    const { runner } = fakeRunner(async () => {
      throw new Error("ENOENT");
    });
    await expectCode(analyze(SAFE_URL, { runner }), "EXTRACTOR_UNAVAILABLE");
  });

  it("propagates a mid-run cancellation verbatim instead of flattening it", async () => {
    // The signal is aborted only once the runner is already executing, so the
    // early gate does not fire and the runner's own reason must survive.
    const controller = new AbortController();
    const cancelled = new AppError("PROCESSING_FAILED", "Download was cancelled.");
    const { runner } = fakeRunner(async () => {
      controller.abort();
      throw cancelled;
    });
    const err = await analyze(SAFE_URL, { runner, signal: controller.signal }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.equal(err, cancelled, "the original cancellation reason must survive");
  });
});

describe("generic analysis: no raw output ever escapes", () => {
  it("a secret in stderr never reaches the thrown error", async () => {
    const { runner } = fakeRunner({
      code: 1,
      stdout: "",
      stderr: `ERROR: Unable to download webpage ${SECRET_URL}\nToken=${SENTINEL}`,
    });
    const err = await expectCode(analyze(SECRET_URL, { runner }), "NETWORK_ERROR");
    assert.equal(err.message.includes(SENTINEL), false);
    assert.equal(JSON.stringify(err.message).includes(SENTINEL), false);
    assert.equal(err.message.includes("example.invalid"), false);
  });

  it("a secret in stdout never reaches the thrown error on a parse failure", async () => {
    const { runner } = fakeRunner(ok(`{"_type":"video","broken" ${SENTINEL}`));
    const err = await expectCode(analyze(SECRET_URL, { runner }), "EXTRACTION_FAILED");
    assert.equal(err.message.includes(SENTINEL), false);
  });

  it("a secret inside accepted JSON does not reach the returned metadata", async () => {
    const { runner } = fakeRunner(
      ok(
        JSON.stringify(
          singleVideoInfo({
            description: `secret ${SENTINEL}`,
            webpage_url: SECRET_URL,
            formats: [{ ...video(), url: SECRET_URL, format_id: SENTINEL }],
          }),
        ),
      ),
    );
    const meta = await analyze(SAFE_URL, { runner });
    assert.equal(JSON.stringify(meta).includes(SENTINEL), false);
  });

  it("writes nothing to the console on any failure path", async () => {
    const calls: unknown[] = [];
    const patched = ["log", "info", "warn", "error", "debug"] as const;
    const originals = patched.map((k) => console[k]);
    for (const key of patched) {
      console[key] = ((...args: unknown[]) => calls.push(args)) as typeof console.log;
    }
    try {
      const failing = fakeRunner({ code: 1, stdout: "", stderr: `boom ${SENTINEL}` });
      await analyze(SECRET_URL, { runner: failing.runner }).catch(() => {});

      const malformed = fakeRunner(ok(`{{${SENTINEL}`));
      await analyze(SECRET_URL, { runner: malformed.runner }).catch(() => {});
    } finally {
      patched.forEach((key, i) => {
        console[key] = originals[i]!;
      });
    }
    assert.deepEqual(calls, [], "the analyzer must never log");
  });

  it("the module contains no logging call at all", () => {
    const source = readFileSync(
      join(process.cwd(), "src/worker/analysis/ytdlp-analysis.server.ts"),
      "utf8",
    );
    for (const token of ["console.log", "console.error", "console.warn", "console.info", "process.stdout.write"]) {
      assert.equal(source.includes(token), false, `the analyzer must not call ${token}`);
    }
  });
});

// ── Static reachability proof ────────────────────────────────────────────────

describe("generic analysis: reachable from Production, but only through the router", () => {
  const ROOT = process.cwd();
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  // DELIBERATELY INVERTED in Phase 10C3. Through Phase 10C2 this block proved
  // the generic analyzer was UNREACHABLE from Production, which was the honest
  // statement while no execution path existed. One exists now, so the same
  // facts are re-stated as the routing and gating rules that keep it safe.

  it("no module reaches around the strategy router to the generic analyzer", () => {
    // The router owns direct-first ordering and the fail-closed enablement
    // check. A caller that skipped it would get generic analysis with neither.
    for (const file of [
      "src/worker/runtime/runtime.server.ts",
      "src/worker/runtime/main.server.ts",
      "src/worker/http/business-service.server.ts",
      "src/worker/http/server.server.ts",
      "src/worker/http/binaries.server.ts",
      "src/worker/execution/job-executor.server.ts",
      "src/worker/execution/queue-pump.server.ts",
      "src/worker/execution/queue-runner.server.ts",
    ]) {
      const source = read(file);
      assert.equal(
        source.includes("analysis/ytdlp-analysis"),
        false,
        `${file} imports the generic analyzer directly instead of the router`,
      );
      assert.equal(
        source.includes("analyzeGenericMedia"),
        false,
        `${file} calls the generic analyzer directly`,
      );
    }
  });

  it("WorkerService analysis is the router, and defaults fail closed", () => {
    const service = read("src/worker/http/business-service.server.ts");
    // The HTTP surface routes through the shared policy...
    assert.match(service, /analyzeMedia/, "WorkerService must use the strategy router");
    // ...and an un-composed service still cannot enable generic by itself.
    assert.match(
      service,
      /ytdlpEnabled\s*(\?\?|=)\s*(deps\.ytdlpEnabled \?\? )?false/,
      "the ytdlp feature state must default to disabled",
    );
  });

  it("the JobExecutor derives strategy itself and persists only a closed identity", () => {
    const executor = read("src/worker/execution/job-executor.server.ts");
    // It re-analyzes rather than trusting the browser or durable state (§17/§42).
    assert.match(executor, /analyzeForExecution/);
    assert.match(executor, /deriveExecutionPlan/);
    // The persisted extractor is the PLAN's strategy, never a literal and never
    // an upstream name.
    assert.match(executor, /extractor:\s*plan\.strategy/);
    assert.equal(
      /extractor:\s*"(direct|yt-dlp)"/.test(executor),
      false,
      "strategy must not be hardcoded at the completeAnalysis call",
    );
    // The legacy stack stays unreachable regardless (§50).
    for (const token of ["downloadWithYtdlp", "ytdlpExtractor", "mapExtractorMessage"]) {
      assert.equal(executor.includes(token), false, `JobExecutor references '${token}'`);
    }
  });

  it("generic capability is now implemented, and /api/sites stays truthful", () => {
    // The constant lives in a dependency-free shared module so the browser
    // diagnostics route can state the same fact without importing the
    // server-only control-plane module.
    const capabilities = read("src/shared/capabilities.ts");
    assert.match(capabilities, /export const GENERIC_YTDLP_EXECUTION_IMPLEMENTED = true;/);

    const sites = read("src/lib/security/private-access-api.server.ts");
    // ...but it is still only ONE of three conjuncts. Runtime presence and
    // operator enablement remain independently required.
    assert.match(
      sites,
      /ytdlp: GENERIC_YTDLP_EXECUTION_IMPLEMENTED && ytdlpInstalled && ytdlpEnabled/,
    );
  });
});

// ── Correction B: one shared subprocess budget, and real cancellation ────────

describe("generic analysis: shared subprocess deadline", () => {
  /** A clock the test advances explicitly. No real sleeps anywhere here. */
  function fakeClock(startMs = 1_000_000) {
    let now = startMs;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const TEN_SECOND_LIMITS: GenericAnalysisLimits = { ...LIMITS, analysisTimeoutSeconds: 10 };

  it("gives the network subprocess only the budget the probe left behind", async () => {
    const clock = fakeClock();
    const { runner, calls } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));

    await analyze(SAFE_URL, {
      runner,
      limits: TEN_SECOND_LIMITS,
      clock: clock.now,
      probeRuntime: async () => {
        clock.advance(3_000); // the probe takes 3s of the 10s budget
        return OK_RUNTIME;
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.timeoutMs,
      7_000,
      "the network run must receive the REMAINING budget, not a fresh one",
    );
  });

  it("caps the probe at the smaller of its own maximum and the remaining budget", async () => {
    const seen: YtdlpProbeOptions[] = [];
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));

    // A 2s analysis budget is far below YTDLP_PROBE_TIMEOUT_MS.
    await analyze(SAFE_URL, {
      runner,
      limits: { ...LIMITS, analysisTimeoutSeconds: 2 },
      clock: fakeClock().now,
      probeRuntime: async (o) => {
        seen.push(o);
        return OK_RUNTIME;
      },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.timeoutMs, 2_000, "budget must shorten the probe");
    assert.ok(seen[0]!.timeoutMs! <= YTDLP_PROBE_TIMEOUT_MS);
  });

  it("never lets the probe exceed its own conservative maximum", async () => {
    const seen: YtdlpProbeOptions[] = [];
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));

    // A very large analysis budget must NOT widen the probe.
    await analyze(SAFE_URL, {
      runner,
      limits: { ...LIMITS, analysisTimeoutSeconds: 3600 },
      clock: fakeClock().now,
      probeRuntime: async (o) => {
        seen.push(o);
        return OK_RUNTIME;
      },
    });

    assert.equal(seen[0]!.timeoutMs, YTDLP_PROBE_TIMEOUT_MS);
  });

  it("starts NO network subprocess when the probe exhausted the budget", async () => {
    const clock = fakeClock();
    const { runner, calls } = forbiddenRunner();

    await expectCode(
      analyze(SAFE_URL, {
        runner,
        limits: TEN_SECOND_LIMITS,
        clock: clock.now,
        probeRuntime: async () => {
          clock.advance(10_000); // consumes the whole budget
          return OK_RUNTIME;
        },
      }),
      "TIMEOUT",
    );

    assert.equal(calls.length, 0, "an exhausted budget must start no network process");
  });

  it("starts no network subprocess when the probe overran the budget", async () => {
    const clock = fakeClock();
    const { runner, calls } = forbiddenRunner();

    await expectCode(
      analyze(SAFE_URL, {
        runner,
        limits: TEN_SECOND_LIMITS,
        clock: clock.now,
        probeRuntime: async () => {
          clock.advance(25_000);
          return OK_RUNTIME;
        },
      }),
      "TIMEOUT",
    );
    assert.equal(calls.length, 0);
  });

  it("uses the whole budget when the probe is instantaneous", async () => {
    const { runner, calls } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));
    await analyze(SAFE_URL, {
      runner,
      limits: TEN_SECOND_LIMITS,
      clock: fakeClock().now,
    });
    assert.equal(calls[0]!.timeoutMs, 10_000);
  });
});

describe("generic analysis: cancellation", () => {
  it("an already-aborted caller starts NEITHER the probe nor the network run", async () => {
    const controller = new AbortController();
    controller.abort();

    const { runner, calls } = forbiddenRunner();
    let probed = 0;

    const err = await analyzeGenericMedia(SAFE_URL, {
      limits: LIMITS,
      runner,
      signal: controller.signal,
      probeRuntime: async () => {
        probed += 1;
        return OK_RUNTIME;
      },
      validateUrl: async (raw) => ({ url: raw, hostname: new URL(raw).hostname }),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof AppError);
    assert.equal(err.code, "PROCESSING_FAILED");
    assert.equal(probed, 0, "no runtime probe may start");
    assert.equal(calls.length, 0, "no network subprocess may start");
  });

  it("forwards the caller's signal to the runtime probe", async () => {
    const controller = new AbortController();
    const seen: YtdlpProbeOptions[] = [];
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));

    await analyze(SAFE_URL, {
      runner,
      signal: controller.signal,
      probeRuntime: async (o) => {
        seen.push(o);
        return OK_RUNTIME;
      },
    });

    assert.equal(
      seen[0]!.signal,
      controller.signal,
      "the probe must be able to terminate its own process group on cancel",
    );
  });

  it("propagates a cancellation raised during the probe, and starts no network run", async () => {
    const controller = new AbortController();
    const { runner, calls } = forbiddenRunner();
    const cancelled = new AppError("PROCESSING_FAILED", "Download was cancelled.");

    const err = await analyzeGenericMedia(SAFE_URL, {
      limits: LIMITS,
      runner,
      signal: controller.signal,
      probeRuntime: async () => {
        // Cancellation arrives while the probe is executing.
        controller.abort();
        throw cancelled;
      },
      validateUrl: async (raw) => ({ url: raw, hostname: new URL(raw).hostname }),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.equal(err, cancelled, "cancellation must propagate verbatim");
    assert.equal(calls.length, 0, "the network subprocess must never start");
  });

  it("does not report a cancelled probe as EXTRACTOR_UNAVAILABLE", async () => {
    const controller = new AbortController();
    const { runner } = forbiddenRunner();
    const cancelled = new AppError("PROCESSING_FAILED", "Download was cancelled.");

    const err = await analyzeGenericMedia(SAFE_URL, {
      limits: LIMITS,
      runner,
      signal: controller.signal,
      probeRuntime: async () => {
        controller.abort();
        throw cancelled;
      },
      validateUrl: async (raw) => ({ url: raw, hostname: new URL(raw).hostname }),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof AppError);
    assert.notEqual(
      err.code,
      "EXTRACTOR_UNAVAILABLE",
      "a cancellation is not a runtime-installation problem",
    );
  });
});

// ── Correction C: the analysis child cannot reach FFmpeg or ffprobe ─────────

describe("generic analysis: FFmpeg/ffprobe descendant isolation", () => {
  it("runs under the analysis environment, whose PATH resolves nothing", async () => {
    const { runner, calls } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));
    await analyze(SAFE_URL, { runner });

    const env = calls[0]!.env!;
    assert.equal(env.PATH, YTDLP_ANALYSIS_PATH);
    assert.equal(env.PATH, buildYtdlpAnalysisEnvironment().PATH);
  });

  it("exposes neither /usr/bin nor /bin on the analysis PATH", async () => {
    const { runner, calls } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));
    await analyze(SAFE_URL, { runner });

    const entries = (calls[0]!.env!.PATH ?? "").split(":").filter(Boolean);
    assert.ok(entries.length > 0, "PATH must be set, not merely empty");
    for (const banned of ["/usr/bin", "/bin", "/usr/local/bin", "/sbin", "/usr/sbin", "."]) {
      assert.equal(
        entries.includes(banned),
        false,
        `the analysis PATH must not expose ${banned}, where ffmpeg/ffprobe live`,
      );
    }
    // An empty PATH is NOT acceptable: some resolvers fall back to the system
    // default (/bin:/usr/bin), which would restore exactly what this removes.
    assert.notEqual(calls[0]!.env!.PATH, "");
  });

  it("no PATH entry can contain an ffmpeg or ffprobe binary", async () => {
    const { runner, calls } = fakeRunner(ok(JSON.stringify(singleVideoInfo())));
    await analyze(SAFE_URL, { runner });

    for (const dir of (calls[0]!.env!.PATH ?? "").split(":").filter(Boolean)) {
      for (const prog of ["ffmpeg", "ffprobe"]) {
        assert.equal(
          existsSync(join(dir, prog)),
          false,
          `${dir}/${prog} is discoverable from the analysis child`,
        );
      }
      assert.equal(existsSync(dir), false, `${dir} exists; PATH must resolve nothing`);
    }
  });

  it("passes exactly one fixed, application-owned --ffmpeg-location", () => {
    const argv = buildYtdlpAnalysisArgv(SAFE_URL);
    const found = argv.filter((a) => a.startsWith("--ffmpeg-location"));
    assert.equal(found.length, 1, "exactly one ffmpeg location must be configured");
    assert.equal(found[0], `--ffmpeg-location=${YTDLP_ANALYSIS_FFMPEG_LOCATION}`);
    assert.ok(
      YTDLP_ANALYSIS_FFMPEG_LOCATION.startsWith("/nonexistent/"),
      "the location must be a path that cannot exist in the image",
    );
    assert.equal(
      existsSync(YTDLP_ANALYSIS_FFMPEG_LOCATION),
      false,
      "the disabling location must not exist",
    );
  });

  it("neither the caller nor the URL can influence the ffmpeg location", () => {
    // The location is a module constant, so it is identical no matter what URL
    // is analyzed — including a URL that tries to look like the option.
    for (const hostile of [
      SAFE_URL,
      "https://example.invalid/x?--ffmpeg-location=/usr/bin",
      "https://example.invalid/--ffmpeg-location=/usr/bin/ffmpeg",
    ]) {
      const found = buildYtdlpAnalysisArgv(hostile).filter((a) =>
        a.startsWith("--ffmpeg-location="),
      );
      assert.deepEqual(found, [`--ffmpeg-location=${YTDLP_ANALYSIS_FFMPEG_LOCATION}`]);
    }
    // And it is not read from configuration or the environment.
    const source = readFileSync(
      join(process.cwd(), "src/worker/analysis/ytdlp-analysis.server.ts"),
      "utf8",
    );
    assert.match(
      source,
      /export const YTDLP_ANALYSIS_FFMPEG_LOCATION\s*=\s*"\/nonexistent\/[^"]+";/,
      "the location must be a plain string literal, not a computed value",
    );
    assert.equal(source.includes("process.env"), false, "no env lookup on this path");
    // And likewise for the analysis PATH.
    assert.match(
      source,
      /export const YTDLP_ANALYSIS_PATH\s*=\s*"\/nonexistent\/[^"]+";/,
    );
  });

  it("keeps the approved Node runtime addressed by ABSOLUTE path", async () => {
    const argv = buildYtdlpAnalysisArgv(SAFE_URL);
    const jsRuntime = argv.find((a) => a.startsWith("--js-runtimes="));
    assert.ok(jsRuntime, "Node must still be enabled");

    const nodePath = jsRuntime.slice("--js-runtimes=node:".length);
    assert.ok(nodePath.startsWith("/"), "Node must be absolute, not PATH-discovered");
    assert.ok(existsSync(nodePath), "the approved Node binary must exist");
    // yt-dlp 2026.08.19 `_determine_runtime_path` returns an absolute path
    // verbatim and only calls `_find_exe` when no path was supplied, so the
    // dead PATH cannot break Node.
    assert.equal(argv.includes("--no-js-runtimes"), true);
    assert.equal(argv.includes("--no-remote-components"), true);
  });

  it("configures FFmpeg neither as a downloader nor as a postprocessor", () => {
    const argv = buildYtdlpAnalysisArgv(SAFE_URL);
    assert.ok(argv.includes("--downloader=native"));
    assert.equal(
      argv.some((a) => /^--downloader=.*ffmpeg/i.test(a)),
      false,
    );
    for (const pp of [
      "--postprocessor-args",
      "--exec",
      "--embed-thumbnail",
      "--embed-metadata",
      "--embed-subs",
      "--embed-chapters",
      "--convert-thumbnails",
      "--split-chapters",
      "--sponsorblock-remove",
      "--extract-audio",
      "--recode-video",
      "--remux-video",
    ]) {
      assert.ok(!argv.includes(pp), `${pp} must not be configured`);
      assert.ok(!argv.some((a) => a.startsWith(`${pp}=`)), `${pp}= must not be configured`);
    }
  });

  it("leaves the shared base environment untouched for its other callers", () => {
    // The diagnostics version probe is non-network and keeps the accepted
    // Phase-10C1 environment; only ANALYSIS narrows PATH.
    assert.equal(buildYtdlpEnvironment().PATH, "/usr/bin:/bin");
    assert.equal(buildYtdlpAnalysisEnvironment().PATH, YTDLP_ANALYSIS_PATH);
    // Everything else is inherited unchanged.
    const base = buildYtdlpEnvironment();
    const analysis = buildYtdlpAnalysisEnvironment();
    for (const key of Object.keys(base)) {
      if (key === "PATH") continue;
      assert.equal(analysis[key], base[key], `${key} must be inherited from the base policy`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE-10D-GENERIC-REAL-OUTPUT-COMPATIBILITY-001
//
// Everything below is anchored to what yt-dlp 2026.08.19 ACTUALLY emits, not to
// an idealized format document. The merged Phase-10D fixture suite found that
// the two disagreed badly enough that no generic video preset could ever be
// built from real output, for any site:
//
//   D1  audio presence was gated on `audio_ext !== "none"`, but
//       `_fill_sorting_fields` sets `audio_ext = "none"` on EVERY format whose
//       `vcodec != "none"`. `audio_ext` is a sorting helper, not a statement
//       that a format carries no audio.
//
//   D2  video presence required a non-null `vcodec`, but the Generic HTML5 path
//       ends with `f.update(formats[0])`, which overwrites the codec parsed out
//       of the `<source type="…; codecs=…">` attribute with `None`.
//
// The governing distinction is that UNKNOWN IS NOT ABSENT: `vcodec = null` says
// the codec identity was not reported; `vcodec = "none"` says there is no video
// stream. Only the second may ever be read as absence.
// ─────────────────────────────────────────────────────────────────────────────

describe("codec state model (§4)", () => {
  it("treats only the exact absence marker as ABSENT", () => {
    assert.equal(classifyCodecState("none"), "absent");
    // Case and surrounding whitespace fold, because an upstream "NONE" is
    // plainly the absence marker rather than a codec named "NONE" — and this
    // fold can only ever WITHDRAW a stream-presence claim, never invent one.
    assert.equal(classifyCodecState("NONE"), "absent");
    assert.equal(classifyCodecState(" none "), "absent");
  });

  it("treats missing codec identity as UNKNOWN, never as absent", () => {
    for (const value of [null, undefined, "", "   ", "null", "NULL"]) {
      assert.equal(
        classifyCodecState(value),
        "unknown",
        `${JSON.stringify(value)} means "we do not know", not "there is none"`,
      );
    }
  });

  it("treats any real codec string as PRESENT", () => {
    for (const value of ["avc1.42E01E", "mp4a.40.2", "vp09.00.40.08", "opus", "h264"]) {
      assert.equal(classifyCodecState(value), "present");
    }
  });
});

describe("real pinned output: the captured /generic document (§20/§21)", () => {
  // The document is a SANITIZED capture of `yt-dlp 2026.08.19` run with the
  // Worker's own analysis argv against the merged fixture page. Its provenance
  // and the reason each decisive field looks the way it does are recorded in
  // `testdata/README.md`. Reading it from disk rather than inlining a literal
  // is deliberate: a future edit cannot quietly "tidy" the awkward fields.
  const CAPTURED = readFileSync(
    join(import.meta.dirname, "testdata", "pinned-generic-html5.json"),
    "utf8",
  );

  function capturedFormat(): Record<string, unknown> {
    return { ...(JSON.parse(CAPTURED).formats[0] as Record<string, unknown>) };
  }

  it("the capture still has the exact shape the defect was about", () => {
    // If this ever fails, the fixture has drifted back toward the false world
    // in which `audio_ext` was simply absent and the bug was invisible.
    const f = capturedFormat();
    assert.equal(f.format_id, "0");
    assert.equal(f.ext, "mp4");
    assert.equal(f.protocol, "http");
    assert.equal(f.vcodec, null, "the HTML5 path reports NO video codec identity");
    assert.equal(f.acodec, "mp4a.40.2");
    assert.equal(f.video_ext, "mp4");
    assert.equal(f.audio_ext, "none", "a muxed format really is emitted with audio_ext=none");
  });

  it("produces exactly one executable muxed video candidate", () => {
    const candidates = selectCandidates([capturedFormat()], LIMITS);
    assert.equal(candidates.length, 1);
    const c = candidates[0]!;
    assert.equal(c.hasVideo, true, "D2: a null vcodec must not mean 'no video'");
    assert.equal(c.hasAudio, true, "D1: audio_ext=none must not mean 'no audio'");
    assert.equal(c.container, "mp4");
    assert.equal(c.protocol, "http");
    assert.equal(c.videoConstraint, "video-ext");
    // §10: the codec was never measured, so it is not invented.
    assert.equal(c.videoCodec, null);
    assert.equal(c.audioCodec, "aac");
    // §10: no height, fps or size is fabricated either.
    assert.equal(c.height, null);
    assert.equal(c.fps, null);
    assert.equal(c.fileSize, null);
  });

  it("reaches a generic video preset with an honest unknown codec", () => {
    const { presets, selections } = buildGenericPresets(
      selectCandidates([capturedFormat()], LIMITS),
      { ffmpegAvailable: false, maxFileSizeBytes: LIMITS.maxFileSizeBytes },
    );
    const best = presets.find((p) => p.id === "preset:best");
    assert.ok(best, "the pinned document must reach preset:best");
    assert.equal(best.hasVideo, true);
    assert.equal(best.hasAudio, true);
    assert.equal(best.container, "mp4");
    assert.equal(best.videoCodec, null, "an unknown codec stays null; it is never synthesized");
    assert.equal(best.audioCodec, "aac");
    // The browser-facing id is application-owned; the raw upstream id "0" is
    // reachable only through the PRIVATE selection.
    assert.equal(best.formatId, "preset:best");
    assert.equal(singleSource(selections["preset:best"]).formatId, "0");
    assert.equal(JSON.stringify(presets).includes('"0"'), false);
  });

  it("survives the whole parse -> candidates -> presets path", () => {
    const parsed = parseAnalysisInfo(CAPTURED);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const { presets } = buildGenericPresets(
      selectCandidates(parsed.info.formats ?? [], LIMITS),
      { ffmpegAvailable: false, maxFileSizeBytes: LIMITS.maxFileSizeBytes },
    );
    assert.ok(presets.some((p) => p.id === "preset:best" && p.hasVideo && p.hasAudio));
  });

  it("D1 MUTATION: gating audio on audio_ext again breaks this document (§22)", () => {
    // The discriminating property. `selectCandidates` must NOT consult
    // `audio_ext`; this asserts the captured format really does carry the
    // combination that would fail under the old rule, so restoring
    // `&& raw.audio_ext !== "none"` turns the assertions above red.
    const f = capturedFormat();
    assert.equal(classifyCodecState(f.acodec as string), "present");
    assert.equal(f.audio_ext, "none");

    const underOldRule = classifyCodecState(f.acodec as string) === "present" && f.audio_ext !== "none";
    assert.equal(underOldRule, false, "the old rule really did refuse this audio");
    assert.equal(selectCandidates([f], LIMITS)[0]?.hasAudio, true, "the new rule accepts it");

    // And removing `audio_ext` entirely must change NOTHING, which is what
    // proves the field has no authority left in either direction.
    const withoutAudioExt = capturedFormat();
    delete withoutAudioExt.audio_ext;
    assert.deepEqual(
      selectCandidates([withoutAudioExt], LIMITS).map((c) => c.hasAudio),
      selectCandidates([f], LIMITS).map((c) => c.hasAudio),
    );
  });

  it("D2 MUTATION: requiring a non-null vcodec again breaks this document (§23)", () => {
    const f = capturedFormat();
    assert.equal(f.vcodec, null);
    assert.equal(f.video_ext, "mp4");

    const underOldRule = classifyCodecState(f.vcodec as null) === "present";
    assert.equal(underOldRule, false, "the old rule really did refuse this video");
    assert.equal(selectCandidates([f], LIMITS)[0]?.hasVideo, true, "the new rule accepts it");

    // The acceptance is driven by the SHAPE evidence, not by leniency: strip
    // `video_ext` and the unknown codec no longer establishes video at all.
    const withoutVideoExt = capturedFormat();
    delete withoutVideoExt.video_ext;
    assert.deepEqual(
      selectCandidates([withoutVideoExt], LIMITS),
      [],
      "an unknown codec with no coherent shape evidence is not executable",
    );
  });
});

describe("unknown-codec video: the evidence required (§6)", () => {
  /** The real pinned shape, parameterized. */
  function html5(overrides: Record<string, unknown> = {}) {
    return {
      format_id: "0",
      ext: "mp4",
      protocol: "https",
      vcodec: null,
      acodec: "mp4a.40.2",
      video_ext: "mp4",
      audio_ext: "none",
      ...overrides,
    };
  }

  it("accepts the coherent case", () => {
    const c = selectCandidates([html5()], LIMITS);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.videoConstraint, "video-ext");
  });

  it("refuses when video_ext does not equal ext", () => {
    // A normalized shape that disagrees with the source container is not
    // evidence about this format; it is a reason to stop.
    assert.deepEqual(selectCandidates([html5({ video_ext: "webm" })], LIMITS), []);
  });

  it("refuses when the container is outside the generic VIDEO allowlist", () => {
    // `_fill_sorting_fields` sets `video_ext = ext` for ANY format whose vcodec
    // is not "none", including audio containers. That is not a video claim.
    for (const ext of ["m4a", "mp3", "ogg", "opus", "aac", "flac", "wav"]) {
      assert.deepEqual(
        selectCandidates([html5({ ext, video_ext: ext })], LIMITS),
        [],
        `${ext} must never become an unknown-codec VIDEO source`,
      );
    }
  });

  it("refuses when video_ext is missing or itself 'none'", () => {
    assert.deepEqual(selectCandidates([html5({ video_ext: null })], LIMITS), []);
    assert.deepEqual(selectCandidates([html5({ video_ext: "none" })], LIMITS), []);
    const bare = html5();
    delete (bare as Record<string, unknown>).video_ext;
    assert.deepEqual(selectCandidates([bare], LIMITS), []);
  });

  it("never invents a codec, a height, an fps or a size for it", async () => {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: [html5()] }))));
    const meta = await analyze(SAFE_URL, { runner });
    const best = meta.presets.find((p) => p.id === "preset:best");
    assert.ok(best);
    assert.equal(best.videoCodec, null);
    assert.equal(best.resolution, null);
    assert.equal(best.fps, null);
    assert.equal(best.fileSize, null);
  });
});

describe("unknown audio never becomes a muxed claim (§8/§27)", () => {
  // GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001 INVERTS the video half
  // of these cases rather than deleting them. Unknown audio still never becomes
  // a MUXED claim — no preset states `hasAudio: true` for it, and no audio or MP3
  // preset is built on it — but with no proven video fulfilment in the document
  // it now backs ordinary video presets that claim no audio.
  it("a proven-video format with an unknown acodec backs video presets that claim NO audio", async () => {
    for (const acodec of [null, undefined, "", "null"]) {
      const format: Record<string, unknown> = {
        format_id: "v-only",
        ext: "mp4",
        protocol: "https",
        height: 1080,
        vcodec: "avc1.640028",
        video_ext: "mp4",
        audio_ext: "none",
        acodec,
      };
      const candidates = selectCandidates([format], LIMITS);
      assert.equal(candidates.length, 1, "the format is still describable");
      assert.equal(candidates[0]!.hasAudio, false, "unknown audio is not proven audio");
      assert.equal(candidates[0]!.audioCodec, null);

      const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: [format] }))));
      const meta = await analyze(SAFE_URL, { runner, ffmpegAvailable: true });
      assert.deepEqual(
        meta.presets.map((p) => p.id),
        ["preset:best", "preset:1080"],
        "video presets only: no audio, no mp3",
      );
      for (const preset of meta.presets) {
        assert.equal(preset.hasVideo, true);
        assert.equal(preset.hasAudio, false, "an mp4 container is not evidence of an audio stream");
        assert.equal(preset.audioCodec, null);
      }
      assert.equal(meta.capabilities.mp3, false);
    }
  });

  it("an unknown-codec video with unknown audio produces ONE video preset and nothing else", async () => {
    const format = {
      format_id: "0",
      ext: "mp4",
      protocol: "https",
      vcodec: null,
      acodec: null,
      video_ext: "mp4",
      audio_ext: "none",
    };
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: [format] }))));
    const meta = await analyze(SAFE_URL, { runner, ffmpegAvailable: true });
    assert.deepEqual(meta.presets, [
      {
        id: "preset:best",
        label: "Best available",
        resolution: null,
        container: "mp4",
        fileSize: null,
        hasVideo: true,
        hasAudio: false,
        formatId: "preset:best",
        videoCodec: null,
        audioCodec: null,
        fps: null,
      },
    ]);
  });
});

describe("contradictory upstream metadata fails closed (§7/§26)", () => {
  it("refuses vcodec='none' alongside a real video_ext", () => {
    const format = {
      format_id: "contra-1",
      ext: "mp4",
      protocol: "https",
      vcodec: "none",
      acodec: "mp4a.40.2",
      video_ext: "mp4",
      audio_ext: "none",
    };
    assert.deepEqual(
      selectCandidates([format], LIMITS),
      [],
      "one field says there is no video, the other names a video container",
    );
  });

  it("refuses a present vcodec alongside video_ext='none'", () => {
    const format = {
      format_id: "contra-2",
      ext: "mp4",
      protocol: "https",
      height: 1080,
      vcodec: "avc1.640028",
      acodec: "mp4a.40.2",
      video_ext: "none",
      audio_ext: "none",
    };
    assert.deepEqual(selectCandidates([format], LIMITS), []);
  });

  it("does not silently pick whichever field makes the format usable", async () => {
    // Both contradictions above would be "fixable" by preferring one field.
    // Neither may produce a preset of ANY kind — not a video one, and not an
    // audio one salvaged from the same document.
    for (const vcodec of ["none", "avc1.640028"]) {
      const format = {
        format_id: "contra-3",
        ext: "mp4",
        protocol: "https",
        vcodec,
        acodec: "mp4a.40.2",
        video_ext: vcodec === "none" ? "mp4" : "none",
        audio_ext: "none",
      };
      const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: [format] }))));
      const meta = await analyze(SAFE_URL, { runner });
      assert.deepEqual(meta.presets, [], `contradiction with vcodec=${vcodec} must be refused`);
    }
  });
});

describe("real-shaped audio-only and split-stream regressions (§24/§25)", () => {
  /** The pinned shape of a genuine audio-only rendition. */
  const AUDIO_ONLY = {
    format_id: "140",
    ext: "m4a",
    protocol: "https",
    vcodec: "none",
    acodec: "mp4a.40.2",
    video_ext: "none",
    audio_ext: "m4a",
  };

  it("classifies a real audio-only format correctly", () => {
    const c = selectCandidates([AUDIO_ONLY], LIMITS);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.hasVideo, false, "vcodec='none' really is proven absence");
    assert.equal(c[0]!.hasAudio, true);
    assert.equal(c[0]!.videoConstraint, "absent");
    assert.equal(c[0]!.container, "m4a");
  });

  it("audio-only never becomes video through the new video_ext logic", async () => {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: [AUDIO_ONLY] }))));
    const meta = await analyze(SAFE_URL, { runner });
    assert.deepEqual(meta.presets.filter((p) => p.hasVideo), []);
    assert.ok(meta.presets.some((p) => p.id === "preset:audio"));
  });

  it("split streams produce NO merged video preset without Worker FFmpeg", async () => {
    // Both halves carry the real `*_ext` fields this time, so the refusal is
    // proven against the pinned shape rather than against an omission. `analyze`
    // defaults to `ffmpegAvailable: false`; with the Worker's own FFmpeg this
    // same pair IS advertised, which the SPLIT-05 pairing suite pins.
    const videoOnly = {
      format_id: "137",
      ext: "mp4",
      protocol: "https",
      height: 1080,
      vcodec: "avc1.640028",
      acodec: "none",
      video_ext: "mp4",
      audio_ext: "none",
    };
    const { runner } = fakeRunner(
      ok(JSON.stringify(singleVideoInfo({ formats: [videoOnly, AUDIO_ONLY] }))),
    );
    const meta = await analyze(SAFE_URL, { runner });
    assert.deepEqual(
      meta.presets.filter((p) => p.hasVideo),
      [],
      "no local merge is available, so the pair is not advertised",
    );
    assert.equal(meta.capabilities.merge, false);
    assert.ok(meta.presets.some((p) => p.id === "preset:audio"));
  });

  it("an unknown-CODEC video half is still a valid pair half, gated only by FFmpeg", async () => {
    // `vcodec: null` with a coherent `video_ext` is the `video-ext` constraint:
    // the codec identity is unknown, but video PRESENCE is established, and the
    // audio here is PROVEN absent (`acodec: "none"`). SPLIT-01's pair schema
    // accepts `video-ext` explicitly (invariant I1) — it is the same evidence
    // standard muxed video presets already rely on, and the container, not the
    // codec, is what makes the stream copy legal.
    //
    // So the only thing that decides this case is the Worker's own FFmpeg.
    const unknownVideo = {
      format_id: "0",
      ext: "mp4",
      protocol: "https",
      vcodec: null,
      acodec: "none",
      video_ext: "mp4",
      audio_ext: "none",
    };
    const formats = [unknownVideo, AUDIO_ONLY];

    const without = await analyze(SAFE_URL, {
      runner: fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats })))).runner,
      ffmpegAvailable: false,
    });
    assert.deepEqual(without.presets.filter((p) => p.hasVideo), []);
    assert.equal(without.capabilities.merge, false);

    const with_ = await analyze(SAFE_URL, {
      runner: fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats })))).runner,
      ffmpegAvailable: true,
    });
    const best = with_.presets.find((p) => p.id === "preset:best");
    assert.ok(best, "the pair is advertisable once the Worker can merge it");
    assert.equal(best.container, "mp4");
    // No codec is ever invented for an unknown one.
    assert.equal(best.videoCodec, null);
    assert.equal(best.audioCodec, "aac");
    assert.equal(with_.capabilities.merge, true);
  });
});

describe("the private execution descriptor stays private (§11/§34)", () => {
  /** The real pinned shape, whose approval depends on the new private field. */
  const HTML5 = {
    format_id: "0",
    ext: "mp4",
    protocol: "https",
    vcodec: null,
    acodec: "mp4a.40.2",
    video_ext: "mp4",
    audio_ext: "none",
  };

  it("neither the raw id nor videoConstraint reaches the browser surface", async () => {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: [HTML5] }))));
    const meta = await analyze(SAFE_URL, { runner });

    const serialized = JSON.stringify(meta);
    // The raw upstream id "0" must not appear as a value anywhere in the
    // browser-facing document, and neither may the private constraint enum.
    assert.equal(serialized.includes('"0"'), false, "the raw upstream id must stay private");
    assert.equal(serialized.includes("videoConstraint"), false);
    assert.equal(serialized.includes("video-ext"), false);
    assert.equal(serialized.includes("codec-present"), false);
    assert.equal(serialized.includes("audioConstraint"), false);
    // Generic analysis still advertises no concrete formats at all.
    assert.deepEqual(meta.formats, []);
    for (const preset of meta.presets) {
      assert.equal(preset.id, preset.formatId, "the preset id is application-owned");
      assert.match(preset.id, GENERIC_PRESET_ID_PATTERN);
    }
  });

  it("the private selection carries it, and carries no codec string", () => {
    const { selections } = buildGenericPresets(selectCandidates([HTML5], LIMITS), {
      ffmpegAvailable: false,
      maxFileSizeBytes: LIMITS.maxFileSizeBytes,
    });
    const selection = singleSource(selections["preset:best"]);
    assert.equal(selection.videoConstraint, "video-ext");
    assert.equal(selection.audioConstraint, "codec-present");
    assert.equal(selection.formatId, "0");
    // The enum is application-owned: it must never paraphrase or embed the
    // upstream codec field it was derived from.
    assert.equal(JSON.stringify(selection).includes("mp4a.40.2"), false);
    assert.deepEqual(Object.keys(selection).sort(), [
      "audioConstraint",
      "container",
      "fileSize",
      "formatId",
      "hasAudio",
      "hasVideo",
      "protocol",
      "videoConstraint",
    ]);
  });

  it("no media URL is parsed into the Worker's generic format schema (§35)", () => {
    // Solving codec classification must not have widened the application
    // boundary: yt-dlp remains responsible for resolving the selected media URL
    // inside the constrained acquisition subprocess.
    const withUrls = {
      ...HTML5,
      url: `https://attacker.invalid/media.mp4?t=${SENTINEL}`,
      manifest_url: "https://attacker.invalid/manifest.m3u8",
      fragment_base_url: "https://attacker.invalid/frag/",
      http_headers: { Cookie: SENTINEL, Referer: "https://attacker.invalid/" },
    };
    const candidates = selectCandidates([withUrls], LIMITS);
    assert.equal(candidates.length, 1);
    const serialized = JSON.stringify(candidates);
    assert.equal(serialized.includes(SENTINEL), false);
    assert.equal(serialized.includes("attacker.invalid"), false);
    assert.equal(serialized.includes("url"), false);
    assert.equal(serialized.includes("http_headers"), false);

    const { selections } = buildGenericPresets(candidates, {
      ffmpegAvailable: false,
      maxFileSizeBytes: LIMITS.maxFileSizeBytes,
    });
    assert.equal(JSON.stringify(selections).includes("attacker.invalid"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001
//
// Audio is no longer reduced to a boolean before it reaches the private source
// descriptor. `Candidate.audioConstraint` mirrors `classifyCodecState(acodec)`
// one-for-one, and `hasAudio` is the narrower statement "audio is PROVEN".
//
// The advertising policy is deliberately UNCHANGED: every generic preset still
// requires proven audio. These tests pin both halves — the honest private
// representation, and the fact that it enables nothing new.
// ─────────────────────────────────────────────────────────────────────────────

describe("GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001", () => {
  /** Real-shaped raw formats, one per classification analysis makes. */
  const MUXED_720 = {
    format_id: "22", ext: "mp4", protocol: "https", height: 720,
    vcodec: "avc1.64001F", acodec: "mp4a.40.2", video_ext: "mp4", audio_ext: "none",
  };
  const MUXED_360 = {
    format_id: "18", ext: "mp4", protocol: "https", height: 360,
    vcodec: "avc1.42001E", acodec: "mp4a.40.2", video_ext: "mp4", audio_ext: "none",
  };
  /** HTML5 with `codecs=` declared: video codec clobbered to null, audio survives. */
  const HTML5_DECLARED = {
    format_id: "h1", ext: "mp4", protocol: "https",
    vcodec: null, acodec: "mp4a.40.2", video_ext: "mp4", audio_ext: "none",
  };
  /** HTML5 with NO `codecs=`: the pinned runtime sets no `acodec` key at all. */
  const HTML5_UNDECLARED = {
    format_id: "h2", ext: "mp4", protocol: "https",
    vcodec: null, video_ext: "mp4", audio_ext: "none",
  };
  const VIDEO_ONLY = {
    format_id: "137", ext: "mp4", protocol: "https", height: 1080,
    vcodec: "avc1.640028", acodec: "none", video_ext: "mp4", audio_ext: "none",
  };
  const AUDIO_ONLY = {
    format_id: "140", ext: "m4a", protocol: "https",
    vcodec: "none", acodec: "mp4a.40.2", video_ext: "none", audio_ext: "m4a",
  };

  const DOCUMENTS: Array<[string, Array<Record<string, unknown>>]> = [
    ["muxed ladder", [MUXED_720, MUXED_360]],
    ["html5 with declared codecs", [HTML5_DECLARED]],
    ["html5 without declared codecs", [HTML5_UNDECLARED]],
    ["split streams", [VIDEO_ONLY, AUDIO_ONLY]],
    ["unknown-audio video beside an audio-only source", [HTML5_UNDECLARED, AUDIO_ONLY]],
    [
      "everything at once",
      [MUXED_720, MUXED_360, HTML5_DECLARED, HTML5_UNDECLARED, VIDEO_ONLY, AUDIO_ONLY],
    ],
  ];

  /** The private-half analyzer, wired exactly like `analyze` above. */
  function analyzeInternal(
    url: string,
    opts: { runner: (o: RunnerCall) => Promise<RunResult>; ffmpegAvailable?: boolean },
  ) {
    return analyzeGenericMediaInternal(url, {
      limits: LIMITS,
      runner: opts.runner,
      probeRuntime: async () => OK_RUNTIME,
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ffmpegAvailable: opts.ffmpegAvailable ?? false,
    });
  }

  describe("the private audio constraint mirrors acodec exactly", () => {
    /** A proven-video mp4 whose only variable is its `acodec` field. */
    function provenVideo(acodec?: unknown): Record<string, unknown> {
      const f: Record<string, unknown> = {
        format_id: "v", ext: "mp4", protocol: "https", height: 720,
        vcodec: "avc1.64001F", video_ext: "mp4", audio_ext: "none",
      };
      if (acodec !== undefined) f.acodec = acodec;
      return f;
    }

    function only(format: Record<string, unknown>) {
      const candidates = selectCandidates([format], LIMITS);
      assert.equal(candidates.length, 1, "the format is still describable");
      return candidates[0]!;
    }

    it("a MISSING acodec key is UNKNOWN", () => {
      const c = only(provenVideo());
      assert.equal(c.audioConstraint, "unknown");
      assert.equal(c.hasAudio, false, "unknown is not proven audio");
      assert.equal(c.audioCodec, null);
    });

    it("an explicit null acodec is UNKNOWN", () => {
      assert.equal(only(provenVideo(null)).audioConstraint, "unknown");
    });

    it("empty and 'null' forms follow the classifier contract: UNKNOWN", () => {
      for (const acodec of ["", "   ", "null", "NULL"]) {
        assert.equal(classifyCodecState(acodec), "unknown");
        assert.equal(only(provenVideo(acodec)).audioConstraint, "unknown", JSON.stringify(acodec));
      }
    });

    it("the exact absence marker is ABSENT", () => {
      for (const acodec of ["none", "NONE", " none "]) {
        const c = only(provenVideo(acodec));
        assert.equal(c.audioConstraint, "absent", JSON.stringify(acodec));
        assert.equal(c.hasAudio, false);
      }
    });

    it("a real codec string is CODEC_PRESENT", () => {
      for (const acodec of ["mp4a.40.2", "opus", "vorbis", "mp3"]) {
        const c = only(provenVideo(acodec));
        assert.equal(c.audioConstraint, "codec-present", acodec);
        assert.equal(c.hasAudio, true);
      }
    });

    it("hasAudio is true exactly for CODEC_PRESENT, across every state", () => {
      const formats = [
        provenVideo(),
        provenVideo(null),
        provenVideo(""),
        provenVideo("none"),
        provenVideo("mp4a.40.2"),
        AUDIO_ONLY,
        HTML5_DECLARED,
        HTML5_UNDECLARED,
      ].map((f, i) => ({ ...f, format_id: `f${i}` }));
      const candidates = selectCandidates(formats, LIMITS);
      assert.equal(candidates.length, formats.length);
      const seen = new Set<string>();
      for (const c of candidates) {
        assert.equal(c.hasAudio, c.audioConstraint === "codec-present", c.formatId);
        seen.add(c.audioConstraint);
      }
      assert.deepEqual([...seen].sort(), ["absent", "codec-present", "unknown"]);
    });

    it("audio_ext and correlational metadata never substitute for acodec", () => {
      // Every field that merely correlates with audio, set as favourably as it
      // can be. None of them is evidence of an audio stream.
      const c = only({
        ...provenVideo(),
        audio_ext: "mp4",
        abr: 128,
        asr: 44100,
        audio_channels: 2,
        tbr: 2500,
        format_note: "with audio",
      });
      assert.equal(c.audioConstraint, "unknown");
      assert.equal(c.hasAudio, false);
    });
  });

  describe("unknown audio: video fallback only, never an audio product", () => {
    // Was "unknown audio stays unadvertised (fail-closed policy unchanged)".
    // GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001 inverts ONLY the
    // video half: with no proven video fulfilment, an unknown-audio progressive
    // source backs ordinary video presets that claim no audio. The audio half is
    // unchanged — no `preset:audio`, no `preset:mp3` — and so is the private state.
    /** The one video preset a lone HTML5_UNDECLARED-shaped source yields. */
    const UNKNOWN_BEST = {
      id: "preset:best",
      label: "Best available",
      resolution: null,
      container: "mp4",
      fileSize: null,
      hasVideo: true,
      hasAudio: false,
      formatId: "preset:best",
      videoCodec: null,
      audioCodec: null,
      fps: null,
    };

    for (const ffmpegAvailable of [false, true]) {
      it(`an UNKNOWN-audio progressive video backs ONLY a video preset claiming no audio (ffmpeg=${ffmpegAvailable})`, () => {
        const candidates = selectCandidates([HTML5_UNDECLARED], LIMITS);
        assert.equal(candidates.length, 1, "it remains an honest private candidate");
        assert.equal(candidates[0]!.videoConstraint, "video-ext");
        assert.equal(candidates[0]!.audioConstraint, "unknown");

        const { presets, selections } = buildGenericPresets(candidates, {
          ffmpegAvailable,
          maxFileSizeBytes: LIMITS.maxFileSizeBytes,
        });
        assert.deepEqual(presets, [UNKNOWN_BEST], "a video preset, and no audio or mp3 preset");
        assert.deepEqual(Object.keys(selections), ["preset:best"]);
        const source = singleSource(selections["preset:best"]);
        assert.equal(source.formatId, "h2");
        assert.equal(source.audioConstraint, "unknown", "unknown stays unknown privately");
        assert.equal(source.hasAudio, false);
      });

      it(`an ABSENT-audio video-bearing source creates no preset (ffmpeg=${ffmpegAvailable})`, () => {
        const candidates = selectCandidates([VIDEO_ONLY], LIMITS);
        assert.equal(candidates[0]?.audioConstraint, "absent");
        const { presets, selections } = buildGenericPresets(candidates, {
          ffmpegAvailable,
          maxFileSizeBytes: LIMITS.maxFileSizeBytes,
        });
        assert.deepEqual(presets, []);
        assert.deepEqual(selections, {});
      });
    }

    it("the full analyzer returns exactly the one audio-free video preset for the affected shape", async () => {
      const { runner } = fakeRunner(
        ok(JSON.stringify(singleVideoInfo({ formats: [HTML5_UNDECLARED] }))),
      );
      const meta = await analyze(SAFE_URL, { runner, ffmpegAvailable: true });
      assert.deepEqual(meta.presets, [UNKNOWN_BEST]);
      assert.deepEqual(meta.formats, []);
      assert.equal(meta.capabilities.mp3, false);
      assert.equal(meta.capabilities.merge, false);
    });

    it("the captured pinned no-codecs document now yields one video preset and no audio product", async () => {
      const doc = readFileSync(
        join(import.meta.dirname, "testdata", "pinned-generic-html5-no-audio-codec.json"),
        "utf8",
      );
      const f = (JSON.parse(doc).formats as Array<Record<string, unknown>>)[0]!;
      // The decisive real-runtime fact: the key is ABSENT, not null.
      assert.equal("acodec" in f, false, "the pinned runtime omits acodec entirely");
      assert.equal(f.vcodec, null);
      assert.equal(f.video_ext, "mp4");
      assert.equal(f.audio_ext, "none");

      const candidates = selectCandidates([f], LIMITS);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]!.videoConstraint, "video-ext");
      assert.equal(candidates[0]!.audioConstraint, "unknown");

      const { runner } = fakeRunner(ok(doc));
      const meta = await analyze(SAFE_URL, { runner, ffmpegAvailable: true });
      assert.deepEqual(meta.presets, [UNKNOWN_BEST], "video only, claiming no audio");
      assert.equal(meta.capabilities.mp3, false);
    });
  });

  describe("every emitted selection carries the audio state its preset states", () => {
    /**
     * The audio rule, in the form that applies to each SHAPE (SPLIT-05 §29, and
     * GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001).
     *
     *   audio / mp3    one source, audio PROVEN PRESENT, exactly as before.
     *   video, single  the public `hasAudio` equals the private proof: PROVEN
     *                  PRESENT behind `true`, UNKNOWN behind `false` (with no
     *                  audio codec). Never ABSENT — that is a split half's shape.
     *   video, split   audio PROVEN ABSENT on the video half — that is what makes
     *                  it a video half at all — and PROVEN PRESENT on the audio
     *                  half; the preset claims audio.
     *
     * `unknown` may appear ONLY behind a single-source video preset that claims
     * no audio. Returns whether this preset was unknown-backed, so callers can
     * prove the new shape was actually exercised.
     */
    function assertAudioRule(
      id: string,
      value: GenericPresetSource,
      preset: { hasVideo: boolean; hasAudio: boolean; audioCodec: string | null },
      label: string,
    ): boolean {
      const audioProduct = id === "preset:audio" || id === "preset:mp3";
      if (value.kind === "single") {
        const source = value.source;
        if (audioProduct) {
          assert.equal(source.audioConstraint, "codec-present", `${label} ${id}`);
          assert.equal(source.hasAudio, true, `${label} ${id}`);
          assert.equal(preset.hasAudio, true, `${label} ${id}`);
          return false;
        }
        assert.equal(preset.hasAudio, source.hasAudio, `${label} ${id}: public claim == private proof`);
        assert.notEqual(source.audioConstraint, "absent", `${label} ${id}: absent single`);
        if (source.audioConstraint === "unknown") {
          assert.equal(preset.hasAudio, false, `${label} ${id}`);
          assert.equal(preset.audioCodec, null, `${label} ${id}`);
          return true;
        }
        assert.equal(source.audioConstraint, "codec-present", `${label} ${id}`);
        assert.equal(preset.hasAudio, true, `${label} ${id}`);
        return false;
      }
      assert.equal(audioProduct, false, `${label} ${id}: an audio product is never a pair`);
      assert.equal(preset.hasAudio, true, `${label} ${id}: a pair claims audio`);
      const { video, audio } = value.pair;
      assert.equal(video.audioConstraint, "absent", `${label} ${id}: video half`);
      assert.equal(video.hasAudio, false, `${label} ${id}: video half`);
      assert.equal(audio.audioConstraint, "codec-present", `${label} ${id}: audio half`);
      assert.equal(audio.hasAudio, true, `${label} ${id}: audio half`);
      // ...and video absence on the audio half is proven too, never unknown.
      assert.equal(audio.videoConstraint, "absent", `${label} ${id}: audio half`);
      for (const member of [video, audio]) {
        assert.notEqual(member.audioConstraint, "unknown", `${label} ${id}: unknown audio`);
        assert.notEqual(member.videoConstraint, "unknown", `${label} ${id}: unknown video`);
      }
      return false;
    }

    for (const ffmpegAvailable of [false, true]) {
      it(`buildGenericPresets emits only shape-correct audio selections (ffmpeg=${ffmpegAvailable})`, () => {
        let emitted = 0;
        let unknownBacked = 0;
        for (const [label, formats] of DOCUMENTS) {
          const { presets, selections } = buildGenericPresets(selectCandidates(formats, LIMITS), {
            ffmpegAvailable,
            maxFileSizeBytes: LIMITS.maxFileSizeBytes,
          });
          for (const [id, presetSource] of Object.entries(selections)) {
            const preset = presets.find((p) => p.id === id);
            assert.ok(preset, `${label}: ${id} is advertised`);
            if (assertAudioRule(id, presetSource, preset, label)) unknownBacked += 1;
            emitted += 1;
          }
        }
        assert.ok(emitted > 0, "the invariant must actually be exercised");
        assert.ok(unknownBacked > 0, "the unknown-audio video shape must actually be exercised");
      });

      it(`the internal analyzer emits only shape-correct audio selections (ffmpeg=${ffmpegAvailable})`, async () => {
        for (const [label, formats] of DOCUMENTS) {
          const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats }))));
          const { video, selections } = await analyzeInternal(SAFE_URL, { runner, ffmpegAvailable });
          assert.deepEqual(
            Object.keys(selections).sort(),
            video.presets.map((p) => p.id).sort(),
            `${label}: selections and presets stay in bijection`,
          );
          for (const [id, presetSource] of Object.entries(selections)) {
            assertAudioRule(id, presetSource, video.presets.find((p) => p.id === id)!, label);
          }
        }
      });
    }

    it("proven video suppresses the unknown-audio tier in every mixed document", () => {
      // "everything at once" carries muxed renditions, so the unknown-audio HTML5
      // source must affect no preset there, with or without FFmpeg.
      for (const ffmpegAvailable of [false, true]) {
        const [, formats] = DOCUMENTS.find(([label]) => label === "everything at once")!;
        const { selections } = buildGenericPresets(selectCandidates(formats, LIMITS), {
          ffmpegAvailable,
          maxFileSizeBytes: LIMITS.maxFileSizeBytes,
        });
        for (const value of Object.values(selections)) {
          for (const member of selectionMembers(value)) {
            assert.notEqual(member.audioConstraint, "unknown", `ffmpeg=${ffmpegAvailable}`);
          }
        }
      }
    });

    it("an UNKNOWN-audio video source is never promoted into a pair half", () => {
      // The single most important pairing regression (§29/M1). An unknown-audio
      // video source sitting next to a perfectly good audio-only partner is
      // exactly the shape a "just treat unknown as absent" edit would pair up.
      const { presets, selections } = buildGenericPresets(
        selectCandidates([HTML5_UNDECLARED, AUDIO_ONLY], LIMITS),
        { ffmpegAvailable: true, maxFileSizeBytes: LIMITS.maxFileSizeBytes },
      );
      for (const value of Object.values(selections)) {
        assert.equal(value.kind, "single", "unknown audio is not absence, so there is no pair");
      }
      // The video rendition is the unknown source ALONE, claiming no audio — not
      // the unknown source merged with the audio-only one.
      const videoPresets = presets.filter((p) => p.hasVideo);
      assert.deepEqual(videoPresets.map((p) => p.id), ["preset:best"]);
      assert.equal(videoPresets[0]!.hasAudio, false);
      assert.equal(singleSource(selections["preset:best"]).formatId, "h2");
      assert.equal(singleSource(selections["preset:best"]).audioConstraint, "unknown");
      // The audio-only source is still independently usable.
      assert.ok(presets.some((p) => p.id === "preset:audio"));
      assert.equal(singleSource(selections["preset:audio"]).formatId, "140");
      assert.equal(presets.find((p) => p.id === "preset:best")?.container, "mp4");
      assert.equal(presets.find((p) => p.id === "preset:best")?.audioCodec, null);
    });

    it("every reachable selector is byte-identical to the pre-correction one", () => {
      // The strings below are exactly what the boolean construction produced
      // for these sources, which all carry proven audio. The correction must
      // not move a single character of any selector acquisition actually runs.
      //
      // SPLIT-05 note: the 1080p rungs are now fulfilled by the 137 + 140 pair,
      // so the map is keyed per MEMBER — each half is acquired by its own
      // independent single-source invocation, never by a joined expression, so
      // each half has its own complete selector and there is no `+` anywhere.
      const { selections } = buildGenericPresets(
        selectCandidates([MUXED_720, MUXED_360, HTML5_DECLARED, VIDEO_ONLY, AUDIO_ONLY], LIMITS),
        { ffmpegAvailable: true, maxFileSizeBytes: LIMITS.maxFileSizeBytes },
      );
      const built = Object.fromEntries(
        Object.entries(selections).map(([id, s]) => [
          id,
          selectionMembers(s).map(buildGenericFormatSelector),
        ]),
      );
      const muxed22 = 'b*[format_id="22"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!="none"]';
      const audio140 = 'b*[format_id="140"][protocol="https"][ext="m4a"][vcodec="none"][acodec!="none"]';
      // The video half binds PROVEN audio absence — `[acodec="none"]` — which is
      // what makes acquiring it twice-over impossible if the site changes shape.
      const video137 = 'b*[format_id="137"][protocol="https"][ext="mp4"][vcodec!="none"][acodec="none"]';
      assert.deepEqual(built, {
        "preset:best": [video137, audio140],
        "preset:1080": [video137, audio140],
        "preset:720": [muxed22],
        "preset:360": ['b*[format_id="18"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!="none"]'],
        "preset:audio": [audio140],
        "preset:mp3": [audio140],
      });
      // §52: no selector on any path is a merge expression.
      for (const selectors of Object.values(built)) {
        for (const selector of selectors) assert.equal(selector.includes("+"), false, selector);
      }

      const captured = readFileSync(
        join(import.meta.dirname, "testdata", "pinned-generic-html5.json"),
        "utf8",
      );
      const html5 = buildGenericPresets(
        selectCandidates(JSON.parse(captured).formats, LIMITS),
        { ffmpegAvailable: false, maxFileSizeBytes: LIMITS.maxFileSizeBytes },
      ).selections["preset:best"];
      assert.equal(
        buildGenericFormatSelector(singleSource(html5)),
        'b*[format_id="0"][protocol="http"][ext="mp4"][vcodec!=?"none"][video_ext="mp4"][acodec!="none"]',
      );
    });
  });

  describe("the public surface is unchanged and carries no private audio state", () => {
    it("WorkerVideoMetadata and its presets keep exactly their public keys", async () => {
      const { runner } = fakeRunner(
        ok(JSON.stringify(singleVideoInfo({ formats: [MUXED_720, AUDIO_ONLY] }))),
      );
      const meta = await analyze(SAFE_URL, { runner, ffmpegAvailable: true });
      assert.deepEqual(Object.keys(meta).sort(), [
        "capabilities", "duration", "extractor", "formats", "presets",
        // The one deliberate addition (GENERIC-SOURCE-RENDITION-INVENTORY-001):
        // bounded numbers and closed reasons, carrying no private audio state.
        "source", "sourceQuality", "thumbnail", "title", "webpageUrl",
      ]);
      assert.ok(meta.presets.length > 0);
      for (const preset of meta.presets) {
        assert.deepEqual(Object.keys(preset).sort(), [
          "audioCodec", "container", "fileSize", "formatId", "fps", "hasAudio",
          "hasVideo", "id", "label", "resolution", "videoCodec",
        ]);
        assert.equal(preset.hasAudio, true, "every generic preset still states proven audio");
      }
    });

    it("neither the metadata nor the HTTP body carries audioConstraint, raw ids or selectors", async () => {
      for (const [label, formats] of DOCUMENTS) {
        const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats }))));
        const { video, selections } = await analyzeInternal(SAFE_URL, {
          runner,
          ffmpegAvailable: true,
        });
        const body = JSON.stringify(WorkerAnalyzeSuccessSchema.parse({ success: true, video }));
        for (const forbidden of ["audioConstraint", "videoConstraint", "selections", "acodec", "b*["]) {
          assert.equal(body.includes(forbidden), false, `${label}: ${forbidden}`);
        }
        // Shape-aware: for a pair this covers BOTH raw ids and BOTH selectors.
        for (const presetSource of Object.values(selections)) {
          for (const selection of selectionMembers(presetSource)) {
            assert.equal(body.includes(`"${selection.formatId}"`), false, `${label}: raw id`);
            assert.equal(
              body.includes(buildGenericFormatSelector(selection)),
              false,
              `${label}: selector`,
            );
          }
        }
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT-05 §86: the BEHAVIOURAL DELTA, stated as a pinned before/after
//
// This suite replaces SPLIT-01's "the public preset surface is unchanged". That
// premise was true while nothing could build a pair and is deliberately false
// now, so the cases are inverted rather than deleted: the SAME candidate set is
// pinned field-for-field in BOTH directions.
//
//   FFmpeg unavailable  the pre-SPLIT array, byte for byte. Nothing regressed.
//   FFmpeg available    the 1080p pair becomes an ORDINARY video preset.
//
// The private envelope, the id === formatId contract and the raw-id boundary are
// unchanged in both.
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-05: split renditions become advertisable", () => {
  /** Muxed, video-only and audio-only renditions in one document. */
  const MIXED = [
    { format_id: "22", ext: "mp4", protocol: "https", vcodec: "avc1.64001F", acodec: "mp4a.40.2", height: 720, fps: 30, filesize: 3_000_000 },
    { format_id: "137", ext: "mp4", protocol: "https", vcodec: "avc1.640028", acodec: "none", height: 1080, fps: 30, filesize: 9_000_000 },
    { format_id: "248", ext: "webm", protocol: "https", vcodec: "vp09.00.40.08", acodec: "none", height: 1080, fps: 30, filesize: 8_000_000 },
    { format_id: "140", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2", filesize: 500_000 },
    { format_id: "251", ext: "webm", protocol: "https", vcodec: "none", acodec: "opus", filesize: 450_000 },
  ];

  const build = (ffmpegAvailable: boolean) =>
    buildGenericPresets(selectCandidates(MIXED, LIMITS), {
      ffmpegAvailable,
      maxFileSizeBytes: LIMITS.maxFileSizeBytes,
    });

  it("BEFORE (no Worker FFmpeg): EXACTLY the pre-SPLIT preset array, field for field", () => {
    // The pre-SPLIT golden array, unchanged from SPLIT-01 except that `mp3` is
    // absent because MP3 always required FFmpeg. Two 1080p video-only
    // renditions and two audio-only renditions are present and individually
    // eligible, and the product still offers only the 720p MUXED source.
    assert.deepEqual(build(false).presets, [
      {
        id: "preset:best",
        label: "Best available",
        resolution: "720p",
        container: "mp4",
        fileSize: 3_000_000,
        hasVideo: true,
        hasAudio: true,
        formatId: "preset:best",
        videoCodec: "h264",
        audioCodec: "aac",
        fps: 30,
      },
      {
        id: "preset:720",
        label: "720p",
        resolution: "720p",
        container: "mp4",
        fileSize: 3_000_000,
        hasVideo: true,
        hasAudio: true,
        formatId: "preset:720",
        videoCodec: "h264",
        audioCodec: "aac",
        fps: 30,
      },
      {
        id: "preset:audio",
        label: "Audio only",
        resolution: "audio",
        container: "m4a",
        fileSize: 500_000,
        hasVideo: false,
        hasAudio: true,
        formatId: "preset:audio",
        videoCodec: null,
        audioCodec: "aac",
        fps: null,
      },
    ]);
  });

  it("AFTER (Worker FFmpeg available): the 1080p pair is an ORDINARY video preset", () => {
    // The delta, pinned field for field. `preset:1080` looks exactly like any
    // other video preset: an application-owned id, one container, one codec
    // pair, one size. Nothing states that two sources are involved.
    assert.deepEqual(build(true).presets, [
      {
        id: "preset:best",
        label: "Best available",
        resolution: "1080p",
        // Derived from the closed pair table: mp4 video + m4a audio -> mp4.
        container: "mp4",
        // The exact COMBINED known size, not either half alone (§15).
        fileSize: 9_500_000,
        hasVideo: true,
        hasAudio: true,
        formatId: "preset:best",
        // Video metadata from the VIDEO half, audio metadata from the AUDIO half.
        videoCodec: "h264",
        audioCodec: "aac",
        fps: 30,
      },
      {
        id: "preset:1080",
        label: "1080p",
        resolution: "1080p",
        container: "mp4",
        fileSize: 9_500_000,
        hasVideo: true,
        hasAudio: true,
        formatId: "preset:1080",
        videoCodec: "h264",
        audioCodec: "aac",
        fps: 30,
      },
      {
        // The muxed rung is untouched: a pair never displaces a single source
        // at its own resolution, and never invents extra rungs.
        id: "preset:720",
        label: "720p",
        resolution: "720p",
        container: "mp4",
        fileSize: 3_000_000,
        hasVideo: true,
        hasAudio: true,
        formatId: "preset:720",
        videoCodec: "h264",
        audioCodec: "aac",
        fps: 30,
      },
      {
        id: "preset:audio",
        label: "Audio only",
        resolution: "audio",
        container: "m4a",
        fileSize: 500_000,
        hasVideo: false,
        hasAudio: true,
        formatId: "preset:audio",
        videoCodec: null,
        audioCodec: "aac",
        fps: null,
      },
      {
        id: "preset:mp3",
        label: "Audio only (MP3)",
        resolution: "audio",
        container: "mp3",
        fileSize: null,
        hasVideo: false,
        hasAudio: true,
        formatId: "preset:mp3",
        videoCodec: null,
        audioCodec: "mp3",
        fps: null,
      },
    ]);
  });

  it("preset ordering, count and the id === formatId contract are unchanged", () => {
    for (const ffmpegAvailable of [false, true]) {
      const { presets } = build(ffmpegAvailable);
      assert.deepEqual(
        presets.map((p) => p.id),
        ffmpegAvailable
          ? ["preset:best", "preset:1080", "preset:720", "preset:audio", "preset:mp3"]
          : ["preset:best", "preset:720", "preset:audio"],
      );
      // Split fulfilment changes HOW a rung is served, never how many ids exist.
      assert.ok(presets.length <= YTDLP_ANALYSIS_MAX_PRESETS);
      for (const p of presets) {
        assert.equal(p.formatId, p.id);
        assert.match(p.id, GENERIC_PRESET_ID_PATTERN);
      }
    }
  });

  it("the private selections name exactly the sources each preset was built on", () => {
    const { selections } = build(true);
    // The video rungs are pairs of the mp4 halves; the mp4 family partner is
    // 140, chosen ONCE (251 is the webm family's partner and is not used here
    // because the mp4 video half won the 1080p bucket).
    for (const id of ["preset:best", "preset:1080"]) {
      const pair = splitPair(selections[id]);
      assert.equal(pair.video.formatId, "137");
      assert.equal(pair.audio.formatId, "140");
      assert.equal(splitTargetContainer(pair.video.container, pair.audio.container), "mp4");
    }
    // The muxed rung and both audio presets stay single-source (§28).
    assert.equal(singleSource(selections["preset:720"]).formatId, "22");
    assert.equal(singleSource(selections["preset:audio"]).formatId, "140");
    assert.equal(singleSource(selections["preset:mp3"]).formatId, "140");

    // With no FFmpeg, nothing is a pair and the split halves back nothing.
    for (const [id, value] of Object.entries(build(false).selections)) {
      const source = singleSource(value);
      assert.ok(["22", "140"].includes(source.formatId), `${id}: unexpected source`);
    }
  });

  it("§19: no private union marker and no raw id reaches the public response", async () => {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: MIXED }))));
    const { video, selections } = await analyzeGenericMediaInternal(SAFE_URL, {
      limits: LIMITS,
      runner,
      probeRuntime: async () => OK_RUNTIME,
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ffmpegAvailable: true,
    });
    const body = JSON.stringify(WorkerAnalyzeSuccessSchema.parse({ success: true, video }));

    // The private envelope's own vocabulary. `"video"`/`"audio"` are NOT listed:
    // they are legitimate public words (the response's own `video` key, and the
    // `resolution: "audio"` label), so asserting their absence would be a test
    // that cannot pass rather than a boundary that holds.
    for (const marker of ['"kind"', '"single"', '"split"', '"pair"', '"source":{']) {
      assert.equal(body.includes(marker), false, marker);
    }
    // Every raw upstream id in the document, advertised or not — including the
    // two halves that now really do back an advertised preset.
    for (const rawId of ["22", "137", "248", "140", "251"]) {
      assert.equal(body.includes(`"${rawId}"`), false, `raw id ${rawId}`);
    }
    // ...and the private constraint vocabulary.
    for (const marker of ["videoConstraint", "audioConstraint", "formatId\":\"2", "selections"]) {
      assert.equal(body.includes(marker), false, marker);
    }
    // The capability is public, and it is now TRUE for this source — which is
    // the one public value SPLIT-05 deliberately changes.
    assert.equal(video.capabilities.merge, true);

    // Positive control: the private half really did carry those ids.
    assert.equal(splitPair(selections["preset:best"]).video.formatId, "137");
    assert.equal(splitPair(selections["preset:best"]).audio.formatId, "140");
    assert.equal(singleSource(selections["preset:audio"]).formatId, "140");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT-05: PAIRING, RANKING AND ADVERTISING
//
// The first source task that makes an approved video-only + audio-only pair
// reachable as an ordinary application-owned preset. These cases pin the four
// decisions that make that safe:
//
//   WHICH candidates may be halves       (§6: proven, never unknown)
//   WHICH halves may be combined         (§5: the closed container table)
//   WHICH partner each family uses       (§9/§10: one, fixed, no fallback)
//   WHICH fulfilment wins a rung         (§23/§24: resolution, then muxed)
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-05: pairing eligibility", () => {
  const MAX = 500 * 1024 * 1024;
  const LIM = { maxFileSizeBytes: MAX };

  const build = (formats: Array<Record<string, unknown>>, ffmpegAvailable = true) =>
    buildGenericPresets(selectCandidates(formats, LIM), {
      ffmpegAvailable,
      maxFileSizeBytes: MAX,
    });

  /** A video-only rendition: video present, audio PROVEN absent. */
  const videoOnly = (o: Record<string, unknown> = {}) => ({
    format_id: "v-mp4",
    ext: "mp4",
    protocol: "https",
    height: 1080,
    fps: 30,
    vcodec: "avc1.640028",
    acodec: "none",
    video_ext: "mp4",
    audio_ext: "none",
    ...o,
  });

  /** An audio-only rendition: audio PROVEN present, video PROVEN absent. */
  const audioOnly = (o: Record<string, unknown> = {}) => ({
    format_id: "a-m4a",
    ext: "m4a",
    protocol: "https",
    vcodec: "none",
    acodec: "mp4a.40.2",
    video_ext: "none",
    audio_ext: "m4a",
    ...o,
  });

  // ── §38: the approved families ─────────────────────────────────────────────

  it("MP4 family: mp4 video-only + m4a audio-only -> an mp4 video preset", () => {
    const { presets, selections } = build([videoOnly(), audioOnly()]);
    const best = presets.find((p) => p.id === "preset:best");
    assert.ok(best, "the pair must be advertised");
    assert.equal(best.resolution, "1080p");
    assert.equal(best.container, "mp4");
    assert.equal(best.hasVideo, true);
    assert.equal(best.hasAudio, true);

    const pair = splitPair(selections["preset:best"]);
    assert.equal(pair.video.formatId, "v-mp4");
    assert.equal(pair.audio.formatId, "a-m4a");
    assert.equal(splitTargetContainer(pair.video.container, pair.audio.container), "mp4");
  });

  it("WebM family: webm video-only + webm audio-only -> a webm video preset", () => {
    const { presets, selections } = build([
      videoOnly({ format_id: "v-webm", ext: "webm", vcodec: "vp09.00.40.08", video_ext: "webm" }),
      audioOnly({ format_id: "a-webm", ext: "webm", acodec: "opus", audio_ext: "webm" }),
    ]);
    const best = presets.find((p) => p.id === "preset:best");
    assert.ok(best, "MP4 assumptions must not be universal");
    assert.equal(best.container, "webm", "the target comes from the closed table");
    assert.equal(best.videoCodec, "vp9");
    assert.equal(best.audioCodec, "opus");

    const pair = splitPair(selections["preset:best"]);
    assert.equal(splitTargetContainer(pair.video.container, pair.audio.container), "webm");
  });

  // ── §39: everything that is NOT a pair ─────────────────────────────────────

  /**
   * Every shape that must NOT become a pair.
   *
   * The third element says whether a VIDEO preset may still legitimately appear
   * from a SINGLE source in that row, and of which kind: `"muxed"` for the row
   * whose "video half" is actually an ordinary muxed rendition, and
   * `"unknown-audio"` for the row whose "video half" has unknown audio — which is
   * not a pair half, but since GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001
   * is an unknown-audio fallback video source claiming no audio. Everywhere else
   * the absence of a video preset is itself part of the assertion, so a row
   * cannot pass merely by producing nothing.
   */
  const NOT_PAIRS: Array<
    [string, Array<Record<string, unknown>>, ("muxed" | "unknown-audio")?]
  > = [
    [
      "cross-family: mp4 video + webm audio",
      [videoOnly(), audioOnly({ format_id: "a-webm", ext: "webm", acodec: "opus", audio_ext: "webm" })],
    ],
    [
      "cross-family: webm video + m4a audio",
      [videoOnly({ format_id: "v-webm", ext: "webm", vcodec: "vp09.00.40.08", video_ext: "webm" }), audioOnly()],
    ],
    [
      "mp4 video + mp3 audio (an allowed audio-only container, but not a pair)",
      [videoOnly(), audioOnly({ format_id: "a-mp3", ext: "mp3", acodec: "mp3", audio_ext: "mp3" })],
    ],
    [
      "the same raw id on both halves",
      [videoOnly({ format_id: "same" }), audioOnly({ format_id: "same" })],
    ],
    [
      "video half with UNKNOWN audio",
      [videoOnly({ acodec: undefined, vcodec: null }), audioOnly()],
      "unknown-audio",
    ],
    [
      "video half with PROVEN audio (it is muxed, not a half)",
      [videoOnly({ acodec: "mp4a.40.2" }), audioOnly({ format_id: "a2" })],
      "muxed",
    ],
    [
      "audio half with UNKNOWN video",
      [videoOnly(), audioOnly({ vcodec: undefined, video_ext: undefined })],
    ],
    [
      "audio half without PROVEN audio",
      [videoOnly(), audioOnly({ acodec: "none" })],
    ],
    [
      "a video half whose raw id is outside the safe grammar",
      [videoOnly({ format_id: "bv+ba" }), audioOnly()],
    ],
    [
      "an audio half whose raw id is outside the safe grammar",
      [videoOnly(), audioOnly({ format_id: 'a"[x]' })],
    ],
    [
      "a non-http(s) video half",
      [videoOnly({ protocol: "m3u8_native" }), audioOnly()],
    ],
    [
      "a non-http(s) audio half",
      [videoOnly(), audioOnly({ protocol: "m3u8_native" })],
    ],
    [
      "an unsupported source container on the video half",
      [videoOnly({ ext: "mkv", video_ext: "mkv" }), audioOnly()],
    ],
  ];

  for (const [label, formats, singleVideoExpected] of NOT_PAIRS) {
    it(`NOT a pair: ${label}`, () => {
      const { presets, selections } = build(formats);
      // Nothing may be fulfilled by a pair...
      for (const [id, value] of Object.entries(selections)) {
        assert.equal(value.kind, "single", `${label}: ${id} must not be a pair`);
      }
      // ...and, except for the two single-source rows, no video preset may
      // exist at all. Without this half the row could pass by accident.
      const videoPresets = presets.filter((p) => p.hasVideo);
      assert.equal(videoPresets.length > 0, singleVideoExpected !== undefined, `${label}: video-preset presence`);
      // Where one exists, its audio claim is the single source's own proof.
      for (const preset of videoPresets) {
        assert.equal(preset.hasAudio, singleVideoExpected === "muxed", `${label}: ${preset.id} hasAudio`);
      }
    });
  }

  it("the muxed case above really does still produce an ordinary single preset", () => {
    // A pointed control for the "video half with PROVEN audio" row: refusing it
    // as a PAIR must not also refuse it as the muxed source it actually is.
    const { presets, selections } = build([videoOnly({ acodec: "mp4a.40.2" })]);
    assert.ok(presets.some((p) => p.id === "preset:1080"));
    assert.equal(singleSource(selections["preset:1080"]).formatId, "v-mp4");
  });

  it("an unpairable video half leaves the AUDIO side completely untouched", () => {
    // Reduced capability, never a thrown error (§78).
    const { presets } = build([
      videoOnly({ format_id: "v-webm", ext: "webm", vcodec: "vp09.00.40.08", video_ext: "webm" }),
      audioOnly(),
    ]);
    assert.deepEqual(presets.filter((p) => p.hasVideo), []);
    assert.ok(presets.some((p) => p.id === "preset:audio"));
    assert.ok(presets.some((p) => p.id === "preset:mp3"));
  });

  it("a MUXED webm source is never mistaken for the webm-family audio partner", () => {
    // The webm family is the one where this can actually happen: a muxed webm
    // rendition shares its CONTAINER with a legitimate webm audio-only partner,
    // so container alone does not distinguish them. Only proven video absence
    // does. Using the muxed source as the "audio half" would acquire its video
    // twice and then discard one copy via the stream map.
    const muxedWebm = {
      format_id: "muxed-webm", ext: "webm", protocol: "https", height: 480,
      vcodec: "vp09.00.40.08", acodec: "opus", video_ext: "webm", audio_ext: "none",
    };
    const videoHalf = {
      format_id: "webm-video", ext: "webm", protocol: "https", height: 1080,
      vcodec: "vp09.00.40.08", acodec: "none", video_ext: "webm", audio_ext: "none",
    };
    const audioHalf = {
      format_id: "webm-audio", ext: "webm", protocol: "https",
      vcodec: "none", acodec: "opus", video_ext: "none", audio_ext: "webm",
    };

    // With a real partner present, the pair must name the AUDIO-ONLY source.
    const withPartner = build([muxedWebm, videoHalf, audioHalf]);
    const pair = splitPair(withPartner.selections["preset:1080"]);
    assert.equal(pair.video.formatId, "webm-video");
    assert.equal(pair.audio.formatId, "webm-audio");
    // ...and the muxed rendition still fills its own rung as a single source.
    assert.equal(singleSource(withPartner.selections["preset:480"]).formatId, "muxed-webm");

    // With NO audio-only partner, the muxed source must NOT be pressed into
    // service as one: the 1080p rendition simply has no split fulfilment.
    const withoutPartner = build([muxedWebm, videoHalf]);
    for (const [id, value] of Object.entries(withoutPartner.selections)) {
      assert.equal(value.kind, "single", `${id}: a muxed source is not an audio half`);
    }
    assert.equal(
      withoutPartner.presets.some((p) => p.resolution === "1080p"),
      false,
      "no partner means no pair, not a substituted one",
    );
    assert.equal(withoutPartner.presets.find((p) => p.id === "preset:best")?.resolution, "480p");
  });

  it("a video-only source with NO audio partner at all is simply not advertised", () => {
    const { presets, selections } = build([videoOnly()]);
    assert.deepEqual(presets, []);
    assert.deepEqual(selections, {});
  });
});

describe("SPLIT-05: one fixed audio partner per family (§9/§10)", () => {
  const MAX = 500 * 1024 * 1024;
  const build = (formats: Array<Record<string, unknown>>) =>
    buildGenericPresets(selectCandidates(formats, { maxFileSizeBytes: MAX }), {
      ffmpegAvailable: true,
      maxFileSizeBytes: MAX,
    });

  /** Two mp4 video rungs, three m4a partners, two webm rungs, two webm partners. */
  const LADDER = [
    { format_id: "v1080", ext: "mp4", protocol: "https", height: 1080, vcodec: "avc1.640028", acodec: "none", filesize: 9_000_000 },
    { format_id: "v720", ext: "mp4", protocol: "https", height: 720, vcodec: "avc1.64001F", acodec: "none", filesize: 4_000_000 },
    { format_id: "a-aac-lo", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2", filesize: 300_000 },
    { format_id: "a-aac-hi", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2", filesize: 900_000 },
    { format_id: "a-aac-mid", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2", filesize: 600_000 },
    { format_id: "w1080", ext: "webm", protocol: "https", height: 1080, vcodec: "vp09.00.40.08", acodec: "none", filesize: 8_000_000 },
    { format_id: "w720", ext: "webm", protocol: "https", height: 720, vcodec: "vp09.00.40.08", acodec: "none", filesize: 3_500_000 },
    { format_id: "a-opus-lo", ext: "webm", protocol: "https", vcodec: "none", acodec: "opus", filesize: 250_000 },
    { format_id: "a-opus-hi", ext: "webm", protocol: "https", vcodec: "none", acodec: "opus", filesize: 700_000 },
  ];

  it("every MP4-family split uses the SAME single partner", () => {
    const { selections } = build(LADDER);
    // mp4 beats webm within a bucket, so both rungs are mp4-family splits.
    const partners = new Set<string>();
    for (const id of ["preset:best", "preset:1080", "preset:720"]) {
      const pair = splitPair(selections[id]);
      assert.equal(pair.audio.container, "m4a");
      partners.add(pair.audio.formatId);
    }
    assert.equal(partners.size, 1, "one partner for the whole analysis, not one per rung");
    // The existing deterministic ranking picks the larger known size among
    // equal-codec audio-only candidates.
    assert.deepEqual([...partners], ["a-aac-hi"]);
  });

  it("the WebM family has its OWN single partner, chosen the same way", () => {
    // Drop the mp4 halves so the webm family is the one that wins the buckets.
    const { selections } = build(LADDER.filter((f) => !String(f.format_id).startsWith("v") && !String(f.format_id).startsWith("a-aac")));
    const partners = new Set<string>();
    for (const id of ["preset:best", "preset:1080", "preset:720"]) {
      const pair = splitPair(selections[id]);
      assert.equal(pair.audio.container, "webm");
      partners.add(pair.audio.formatId);
    }
    assert.deepEqual([...partners], ["a-opus-hi"]);
  });

  it("upstream ORDER introduces no second pairing policy", () => {
    const forward = build(LADDER);
    const reversed = build([...LADDER].reverse());
    const shape = (b: ReturnType<typeof build>) =>
      Object.fromEntries(
        Object.entries(b.selections).map(([id, v]) => [
          id,
          v.kind === "single" ? v.source.formatId : `${v.pair.video.formatId}+${v.pair.audio.formatId}`,
        ]),
      );
    assert.deepEqual(shape(forward), shape(reversed));
    assert.deepEqual(forward.presets, reversed.presets);
  });

  it("NO alternate partner is tried when the fixed one does not fit (§10)", () => {
    // The family partner is 900_000. The ceiling admits the 720p rung with it
    // (4_000_000 + 900_000) but not the 1080p rung (9_000_000 + 900_000). A
    // smaller partner exists and WOULD have made 1080p fit — and must not be
    // reached for, because that would make the advertised audio depend on which
    // video rung the user picked.
    const { presets, selections } = buildGenericPresets(
      selectCandidates(LADDER.filter((f) => !String(f.format_id).startsWith("w") && !String(f.format_id).startsWith("a-opus")), {
        maxFileSizeBytes: 9_500_000,
      }),
      { ffmpegAvailable: true, maxFileSizeBytes: 9_500_000 },
    );
    assert.equal(
      presets.some((p) => p.resolution === "1080p"),
      false,
      "the 1080p rung has no split fulfilment rather than a substituted partner",
    );
    const rung = splitPair(selections["preset:720"]);
    assert.equal(rung.audio.formatId, "a-aac-hi", "still the family partner, not a smaller one");
  });

  it("preset:audio follows its OWN ranking and stays single-source (§28)", () => {
    const { presets, selections } = build(LADDER);
    const audio = singleSource(selections["preset:audio"]);
    // It happens to be the same candidate the mp4 family paired with — the same
    // ranking run twice, not a coupling. What matters is the SHAPE.
    assert.equal(selections["preset:audio"]?.kind, "single");
    assert.equal(selections["preset:mp3"]?.kind, "single");
    assert.equal(audio.hasVideo, false);
    assert.equal(audio.audioConstraint, "codec-present");
    assert.equal(presets.find((p) => p.id === "preset:audio")?.container, "m4a");
  });
});

describe("SPLIT-05: the combined known-size gate (§13/§14/§15/§41)", () => {
  const pairFor = (videoSize: number | null, audioSize: number | null, max: number) => {
    const v: Record<string, unknown> = {
      format_id: "v", ext: "mp4", protocol: "https", height: 1080,
      vcodec: "avc1.640028", acodec: "none",
    };
    const a: Record<string, unknown> = {
      format_id: "a", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2",
    };
    if (videoSize !== null) v.filesize = videoSize;
    if (audioSize !== null) a.filesize = audioSize;
    return buildGenericPresets(selectCandidates([v, a], { maxFileSizeBytes: max }), {
      ffmpegAvailable: true,
      maxFileSizeBytes: max,
    });
  };

  it("both sizes known and within the ceiling -> advertised with the EXACT sum", () => {
    const { presets, selections } = pairFor(700, 200, 1000);
    const best = presets.find((p) => p.id === "preset:best");
    assert.ok(best);
    assert.equal(best.fileSize, 900, "not the video size, not the audio size, not the ceiling");
    assert.equal(selections["preset:best"]?.kind, "split");
  });

  it("both sizes known and OVER the ceiling -> NOT advertised", () => {
    // Each half fits on its own; together they do not.
    const { presets, selections } = pairFor(700, 400, 1000);
    assert.equal(
      presets.some((p) => p.hasVideo),
      false,
      "a pair analysis already knows cannot fit must not be advertised",
    );
    for (const value of Object.values(selections)) assert.equal(value.kind, "single");
  });

  it("an UNKNOWN video size still pairs, advertising fileSize: null", () => {
    const { presets, selections } = pairFor(null, 200, 1000);
    const best = presets.find((p) => p.id === "preset:best");
    assert.ok(best, "unknown size is not a reason to refuse a valid pair");
    assert.equal(best.fileSize, null, "no combined size is invented");
    assert.equal(selections["preset:best"]?.kind, "split");
  });

  it("an UNKNOWN audio size still pairs, advertising fileSize: null", () => {
    const { presets } = pairFor(700, null, 1000);
    const best = presets.find((p) => p.id === "preset:best");
    assert.ok(best);
    assert.equal(best.fileSize, null);
  });

  it("an UNSAFE integer sum is refused rather than compared inexactly", () => {
    // Both halves are individually within a ceiling this large, so the ONLY
    // thing that can refuse the pair is the safe-integer rule.
    const max = Number.MAX_SAFE_INTEGER;
    const { presets, selections } = pairFor(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, max);
    assert.equal(
      presets.some((p) => p.hasVideo),
      false,
      "a budget decision made on an inexact number is not a decision",
    );
    for (const value of Object.values(selections)) assert.equal(value.kind, "single");
  });

  it("the individual-candidate gate is unchanged: an oversized half never becomes a candidate", () => {
    const { presets } = pairFor(2000, 200, 1000);
    assert.equal(presets.some((p) => p.hasVideo), false);
  });
});

describe("SPLIT-05: ranking (§23/§24/§25/§42-§46)", () => {
  const MAX = 500 * 1024 * 1024;
  const build = (formats: Array<Record<string, unknown>>, ffmpegAvailable = true) =>
    buildGenericPresets(selectCandidates(formats, { maxFileSizeBytes: MAX }), {
      ffmpegAvailable,
      maxFileSizeBytes: MAX,
    });

  const muxed = (height: number | null, o: Record<string, unknown> = {}) => ({
    format_id: `m${height ?? "x"}`,
    ext: "mp4", protocol: "https", vcodec: "avc1.640028", acodec: "mp4a.40.2",
    ...(height === null ? {} : { height }),
    ...o,
  });
  const splitVideo = (height: number | null, o: Record<string, unknown> = {}) => ({
    format_id: `s${height ?? "x"}`,
    ext: "mp4", protocol: "https", vcodec: "avc1.640028", acodec: "none",
    ...(height === null ? {} : { height }),
    ...o,
  });
  const partner = { format_id: "aud", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" };

  it("§42: at the SAME resolution, MUXED beats split — whatever else the split wins on", () => {
    // The split rendition is deliberately given every non-resolution advantage
    // the ranking knows about: nicer codec order is equal, but it has a larger
    // known size and a higher fps, and it would win the container comparison if
    // kind did not come first.
    const { presets, selections } = build([
      muxed(1080, { fps: 24, filesize: 1_000_000 }),
      splitVideo(1080, { fps: 60, filesize: 50_000_000 }),
      partner,
    ]);
    for (const id of ["preset:best", "preset:1080"]) {
      assert.equal(selections[id]?.kind, "single", `${id} must use the muxed source`);
      assert.equal(singleSource(selections[id]).formatId, "m1080");
    }
    assert.equal(presets.find((p) => p.id === "preset:1080")?.fps, 24);
    // ...and the unused-but-valid pair creates no extra preset and no capability.
    assert.deepEqual(
      presets.map((p) => p.id),
      ["preset:best", "preset:1080", "preset:audio", "preset:mp3"],
    );
  });

  it("§43: a HIGHER split beats a LOWER muxed for preset:best", () => {
    const { presets, selections } = build([muxed(720), splitVideo(1080), partner]);
    assert.equal(presets.find((p) => p.id === "preset:best")?.resolution, "1080p");
    assert.equal(selections["preset:best"]?.kind, "split");
    assert.equal(selections["preset:1080"]?.kind, "split");
    assert.equal(selections["preset:720"]?.kind, "single");
    assert.equal(singleSource(selections["preset:720"]).formatId, "m720");
  });

  it("§44: a HIGHER muxed stays ordinary, and the lower split still fills its rung", () => {
    const { presets, selections } = build([muxed(1080), splitVideo(720), partner]);
    assert.equal(presets.find((p) => p.id === "preset:best")?.resolution, "1080p");
    assert.equal(selections["preset:best"]?.kind, "single");
    assert.equal(selections["preset:1080"]?.kind, "single");
    assert.equal(selections["preset:720"]?.kind, "split");
  });

  it("§45: a split-only ladder fills every rung, with no duplicate or extra ids", () => {
    const { presets, selections } = build([
      splitVideo(2160), splitVideo(1080), splitVideo(720), partner,
    ]);
    assert.deepEqual(
      presets.map((p) => p.id),
      ["preset:best", "preset:2160", "preset:1080", "preset:720", "preset:audio", "preset:mp3"],
    );
    for (const id of ["preset:best", "preset:2160", "preset:1080", "preset:720"]) {
      assert.equal(selections[id]?.kind, "split", id);
    }
    assert.equal(splitPair(selections["preset:best"]).video.formatId, "s2160");
    assert.equal(splitPair(selections["preset:2160"]).video.formatId, "s2160");
    assert.equal(splitPair(selections["preset:1080"]).video.formatId, "s1080");
    assert.equal(splitPair(selections["preset:720"]).video.formatId, "s720");
    // No split-specific vocabulary leaked into the ids.
    assert.equal(new Set(presets.map((p) => p.id)).size, presets.length);
    for (const p of presets) assert.match(p.id, GENERIC_PRESET_ID_PATTERN);
  });

  it("§46: unknown heights — muxed only", () => {
    const { presets, selections } = build([muxed(null)]);
    assert.equal(presets.find((p) => p.id === "preset:best")?.resolution, null);
    assert.equal(selections["preset:best"]?.kind, "single");
    assert.equal(presets.some((p) => p.id === "preset:1080"), false, "no named rung");
  });

  it("§46: unknown heights — split only", () => {
    const { presets, selections } = build([splitVideo(null), partner]);
    const best = presets.find((p) => p.id === "preset:best");
    assert.ok(best, "video must not be dropped merely because height is unknown");
    assert.equal(best.resolution, null);
    assert.equal(selections["preset:best"]?.kind, "split");
    assert.equal(
      presets.some((p) => p.resolution !== null && p.resolution !== "audio"),
      false,
      "named rungs stay absent",
    );
  });

  it("§46: unknown heights — MUXED wins over split at equivalent unknown height", () => {
    const { presets, selections } = build([muxed(null), splitVideo(null), partner]);
    assert.equal(presets.find((p) => p.id === "preset:best")?.resolution, null);
    assert.equal(selections["preset:best"]?.kind, "single");
    assert.equal(singleSource(selections["preset:best"]).formatId, "mx");
  });

  it("§26: a 1080p pair never also masquerades as the 720p rung", () => {
    const { presets } = build([splitVideo(1080), partner]);
    assert.equal(presets.some((p) => p.id === "preset:720"), false);
    assert.ok(presets.some((p) => p.id === "preset:1080"));
  });

  it("split-vs-split in one bucket uses the EXISTING candidate ranking on the video half", () => {
    // mp4 outranks webm, so the mp4 half wins even though the webm one appears
    // first and is larger. The audio partner is fixed per family and takes no
    // part in this decision.
    const { selections } = build([
      { format_id: "wv", ext: "webm", protocol: "https", height: 1080, vcodec: "vp09.00.40.08", acodec: "none", filesize: 90_000_000 },
      { format_id: "wa", ext: "webm", protocol: "https", vcodec: "none", acodec: "opus" },
      { format_id: "mv", ext: "mp4", protocol: "https", height: 1080, vcodec: "avc1.640028", acodec: "none", filesize: 1_000_000 },
      partner,
    ]);
    const pair = splitPair(selections["preset:1080"]);
    assert.equal(pair.video.formatId, "mv");
    assert.equal(pair.audio.formatId, "aud");
  });
});

describe("SPLIT-05: Worker FFmpeg availability gates every pair (§8/§47)", () => {
  const MAX = 500 * 1024 * 1024;
  const FORMATS = [
    { format_id: "v", ext: "mp4", protocol: "https", height: 1080, vcodec: "avc1.640028", acodec: "none" },
    { format_id: "a", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
    { format_id: "m", ext: "mp4", protocol: "https", height: 480, vcodec: "avc1.42001E", acodec: "mp4a.40.2" },
  ];
  const build = (ffmpegAvailable: boolean) =>
    buildGenericPresets(selectCandidates(FORMATS, { maxFileSizeBytes: MAX }), {
      ffmpegAvailable,
      maxFileSizeBytes: MAX,
    });

  it("ffmpegAvailable=false: no split preset, and muxed behaviour is untouched", () => {
    const { presets, selections } = build(false);
    for (const [id, value] of Object.entries(selections)) {
      assert.equal(value.kind, "single", `${id}: a pair needs the Worker's own merge`);
    }
    assert.deepEqual(
      presets.map((p) => p.id),
      ["preset:best", "preset:480", "preset:audio"],
      "the muxed rung and the audio-only source are unaffected",
    );
    assert.equal(presets.find((p) => p.id === "preset:best")?.resolution, "480p");
    // MP3 still requires FFmpeg, unchanged.
    assert.equal(presets.some((p) => p.id === "preset:mp3"), false);
  });

  it("ffmpegAvailable=true: the same candidate set advertises the pair", () => {
    const { presets, selections } = build(true);
    assert.equal(presets.find((p) => p.id === "preset:best")?.resolution, "1080p");
    assert.equal(selections["preset:best"]?.kind, "split");
    assert.equal(selections["preset:480"]?.kind, "single");
    assert.ok(presets.some((p) => p.id === "preset:mp3"));
  });

  it("the analyzer refuses to emit a split selection when FFmpeg is unavailable", async () => {
    // The structural half of the same rule: even if preset construction were
    // edited to build a pair without FFmpeg, the analyzer's own assertion fails
    // closed rather than advertising a merge nothing can perform.
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: FORMATS }))));
    const meta = await analyze(SAFE_URL, { runner, ffmpegAvailable: false });
    assert.equal(meta.capabilities.merge, false);
    assert.equal(meta.presets.some((p) => p.resolution === "1080p"), false);
  });
});

describe("SPLIT-05: capabilities.merge semantics (§31/§74)", () => {
  const MAX = 500 * 1024 * 1024;

  async function analyzed(formats: Array<Record<string, unknown>>, ffmpegAvailable: boolean) {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats }))));
    return analyzeGenericMediaInternal(SAFE_URL, {
      limits: { ...LIMITS, maxFileSizeBytes: MAX },
      runner,
      probeRuntime: async () => OK_RUNTIME,
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ffmpegAvailable,
    });
  }

  const PAIRABLE = [
    { format_id: "v", ext: "mp4", protocol: "https", height: 1080, vcodec: "avc1.640028", acodec: "none" },
    { format_id: "a", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
  ];
  const MUXED_ONLY = [
    { format_id: "m", ext: "mp4", protocol: "https", height: 720, vcodec: "avc1.640028", acodec: "mp4a.40.2" },
  ];
  /** A valid pair that is never SELECTED, because a muxed rung outranks it. */
  const PAIR_NOT_CHOSEN = [
    { format_id: "m", ext: "mp4", protocol: "https", height: 1080, vcodec: "avc1.640028", acodec: "mp4a.40.2" },
    { format_id: "v", ext: "mp4", protocol: "https", height: 1080, vcodec: "avc1.640028", acodec: "none" },
    { format_id: "a", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
  ];

  const TRUTH_TABLE: Array<[string, Array<Record<string, unknown>>, boolean, boolean]> = [
    ["FFmpeg false + pairable streams", PAIRABLE, false, false],
    ["FFmpeg true + no valid pair", MUXED_ONLY, true, false],
    ["FFmpeg true + an advertised split-backed preset", PAIRABLE, true, true],
    ["FFmpeg true + a POSSIBLE but unselected pair (§73)", PAIR_NOT_CHOSEN, true, false],
  ];

  for (const [label, formats, ffmpegAvailable, expected] of TRUTH_TABLE) {
    it(`${label} -> merge ${expected}`, async () => {
      const { video } = await analyzed(formats, ffmpegAvailable);
      assert.equal(video.capabilities.merge, expected);
    });
  }

  it("merge is true IFF at least one advertised preset is split-backed (both directions)", async () => {
    for (const formats of [PAIRABLE, MUXED_ONLY, PAIR_NOT_CHOSEN]) {
      for (const ffmpegAvailable of [false, true]) {
        const { video, selections } = await analyzed(formats, ffmpegAvailable);
        const anySplit = Object.values(selections).some((v) => v.kind === "split");
        assert.equal(
          video.capabilities.merge,
          anySplit,
          "the public capability must stay synchronized with what the user can choose",
        );
      }
    }
  });

  it("§73: an unselected pair creates no duplicate preset and no capability", async () => {
    const { video, selections } = await analyzed(PAIR_NOT_CHOSEN, true);
    assert.equal(selections["preset:best"]?.kind, "single");
    assert.equal(selections["preset:1080"]?.kind, "single");
    assert.equal(video.capabilities.merge, false);
    assert.deepEqual(
      video.presets.map((p) => p.id),
      ["preset:best", "preset:1080", "preset:audio", "preset:mp3"],
    );
  });

  it("capabilities.mp3 stays decoupled from split support (§32)", async () => {
    const { video } = await analyzed(PAIRABLE, true);
    assert.equal(video.capabilities.merge, true);
    assert.equal(video.capabilities.mp3, video.presets.some((p) => p.id === "preset:mp3"));
  });
});

describe("SPLIT-05: raw pair ids stay private (§12/§48/§77)", () => {
  const MAX = 500 * 1024 * 1024;
  // Grammar-valid sentinels. Clearly synthetic, and clearly NOT Production values.
  const PRIVATE_VIDEO = "PRIVATE_VIDEO_137";
  const PRIVATE_AUDIO = "PRIVATE_AUDIO_140";
  const FORMATS = [
    { format_id: PRIVATE_VIDEO, ext: "mp4", protocol: "https", height: 1080, vcodec: "avc1.640028", acodec: "none", filesize: 9_000_000 },
    { format_id: PRIVATE_AUDIO, ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2", filesize: 500_000 },
  ];

  it("neither sentinel appears anywhere in the browser-safe metadata", async () => {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: FORMATS }))));
    const { video, selections } = await analyzeGenericMediaInternal(SAFE_URL, {
      limits: { ...LIMITS, maxFileSizeBytes: MAX },
      runner,
      probeRuntime: async () => OK_RUNTIME,
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ffmpegAvailable: true,
    });

    const serialized = JSON.stringify(video);
    assert.equal(serialized.includes(PRIVATE_VIDEO), false, "the video half's id must stay private");
    assert.equal(serialized.includes(PRIVATE_AUDIO), false, "the audio half's id must stay private");
    assert.deepEqual(video.formats, [], "generic analysis exposes no raw formats");
    for (const preset of video.presets) {
      assert.equal(preset.id, preset.formatId);
      assert.match(preset.id, GENERIC_PRESET_ID_PATTERN);
    }

    // ...and the INTERNAL half really does carry them, in the pair and nowhere
    // else: exactly one place each id may exist.
    const pair = splitPair(selections["preset:1080"]);
    assert.equal(pair.video.formatId, PRIVATE_VIDEO);
    assert.equal(pair.audio.formatId, PRIVATE_AUDIO);
  });

  it("no raw selector grammar can become a browser-selectable id", async () => {
    // Safe-but-selector-LOOKING distinctions across candidate ids. The public
    // vocabulary must stay closed regardless of what upstream called things.
    const formats = [
      { format_id: "best.2160-v", ext: "mp4", protocol: "https", height: 2160, vcodec: "avc1.640033", acodec: "none" },
      { format_id: "bestaudio.m4a", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
    ];
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats }))));
    const meta = await analyze(SAFE_URL, { runner, ffmpegAvailable: true });

    const serialized = JSON.stringify(meta);
    for (const raw of ["best.2160-v", "bestaudio.m4a"]) {
      assert.equal(serialized.includes(raw), false, raw);
    }
    for (const preset of meta.presets) {
      assert.equal(preset.id, preset.formatId);
      assert.match(preset.id, GENERIC_PRESET_ID_PATTERN);
      for (const forbidden of ["+", "/", "[", "]", ",", "(", ")"]) {
        assert.equal(preset.id.includes(forbidden), false, `${preset.id} contains ${forbidden}`);
      }
    }
  });

  it("the preset ceiling is unchanged at a maximal ladder (§76)", async () => {
    // Every rung as a SPLIT, plus both audio presets: split changes HOW a rung
    // is fulfilled, never how many preset ids exist.
    const heights = [2160, 1440, 1080, 720, 480, 360, 240, 144];
    const formats = [
      ...heights.map((h) => ({
        format_id: `v${h}`, ext: "mp4", protocol: "https", height: h,
        vcodec: "avc1.640028", acodec: "none",
      })),
      { format_id: "a", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
    ];
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats }))));
    const meta = await analyze(SAFE_URL, { runner, ffmpegAvailable: true });

    assert.deepEqual(meta.presets.map((p) => p.id), [
      "preset:best", "preset:2160", "preset:1440", "preset:1080", "preset:720",
      "preset:480", "preset:360", "preset:240", "preset:144",
      "preset:audio", "preset:mp3",
    ]);
    assert.equal(meta.presets.length, YTDLP_ANALYSIS_MAX_PRESETS);
    assert.equal(YTDLP_ANALYSIS_MAX_PRESETS, 11);
    assert.equal(meta.capabilities.merge, true);
  });
});

describe("SPLIT-05: the public/private boundary is unchanged (§35)", () => {
  const MAX = 500 * 1024 * 1024;
  const PAIRABLE = [
    { format_id: "vv", ext: "mp4", protocol: "https", height: 1080, vcodec: "avc1.640028", acodec: "none" },
    { format_id: "aa", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
  ];

  it("analyzeGenericMedia returns ONLY the public metadata, pair or no pair", async () => {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: PAIRABLE }))));
    const meta = await analyze(SAFE_URL, { runner, ffmpegAvailable: true });
    // A positive split case really is being exercised.
    assert.equal(meta.capabilities.merge, true);
    assert.deepEqual(Object.keys(meta).sort(), [
      "capabilities", "duration", "extractor", "formats", "presets",
      // The one deliberate addition (GENERIC-SOURCE-RENDITION-INVENTORY-001).
      "source", "sourceQuality", "thumbnail", "title", "webpageUrl",
    ]);
    assert.equal("selections" in meta, false, "no private half may be reachable here");
    for (const preset of meta.presets) {
      assert.deepEqual(Object.keys(preset).sort(), [
        "audioCodec", "container", "fileSize", "formatId", "fps", "hasAudio",
        "hasVideo", "id", "label", "resolution", "videoCodec",
      ]);
    }
  });

  it("the preset/selection bijection holds with pairs present (§34)", async () => {
    const { runner } = fakeRunner(ok(JSON.stringify(singleVideoInfo({ formats: PAIRABLE }))));
    const { video, selections } = await analyzeGenericMediaInternal(SAFE_URL, {
      limits: { ...LIMITS, maxFileSizeBytes: MAX },
      runner,
      probeRuntime: async () => OK_RUNTIME,
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ffmpegAvailable: true,
    });
    assert.deepEqual(
      Object.keys(selections).sort(),
      video.presets.map((p) => p.id).sort(),
      "no orphan preset and no orphan selection",
    );
    assert.ok(Object.values(selections).some((v) => v.kind === "split"));
  });

  it("§75: public metadata agrees with the SHAPE that produced it", async () => {
    const { runner } = fakeRunner(
      ok(JSON.stringify(singleVideoInfo({
        formats: [
          ...PAIRABLE,
          { format_id: "mx", ext: "mp4", protocol: "https", height: 480, vcodec: "avc1.42001E", acodec: "mp4a.40.2", fps: 25, filesize: 1234 },
        ],
      }))),
    );
    const { video, selections } = await analyzeGenericMediaInternal(SAFE_URL, {
      limits: { ...LIMITS, maxFileSizeBytes: MAX },
      runner,
      probeRuntime: async () => OK_RUNTIME,
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ffmpegAvailable: true,
    });

    for (const preset of video.presets.filter((p) => p.hasVideo)) {
      const value = selections[preset.id];
      assert.ok(value);
      if (value.kind === "single") {
        assert.equal(preset.container, value.source.container, preset.id);
        assert.equal(preset.fileSize, value.source.fileSize, preset.id);
        continue;
      }
      // Target from the closed table; codecs from the correct halves.
      assert.equal(
        preset.container,
        splitTargetContainer(value.pair.video.container, value.pair.audio.container),
        preset.id,
      );
      const known =
        value.pair.video.fileSize !== null && value.pair.audio.fileSize !== null
          ? value.pair.video.fileSize + value.pair.audio.fileSize
          : null;
      assert.equal(preset.fileSize, known, preset.id);
      assert.equal(value.pair.video.hasVideo, true, preset.id);
      assert.equal(value.pair.audio.hasAudio, true, preset.id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001
//
// A progressive source with established video and UNKNOWN audio may back
// ordinary VIDEO presets — `hasAudio: false`, `audioCodec: null` — as a
// whole-result FALLBACK tier used only when no proven video fulfilment (muxed,
// or a split pair with Worker FFmpeg) exists. It never becomes audio, MP3, a
// split half, or a reason to admit an otherwise-ineligible format.
// ─────────────────────────────────────────────────────────────────────────────

describe("GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001", () => {
  const MAX = LIMITS.maxFileSizeBytes;
  const build = (formats: Array<Record<string, unknown>>, ffmpegAvailable: boolean) =>
    buildGenericPresets(selectCandidates(formats, LIMITS), { ffmpegAvailable, maxFileSizeBytes: MAX });

  /** An X-shaped progressive format: video by shape, no vcodec, no acodec. */
  const unknownProgressive = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    format_id: "unk",
    ext: "mp4",
    protocol: "https",
    height: 1080,
    video_ext: "mp4",
    audio_ext: "none",
    ...o,
  });
  const muxed = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    format_id: "mux",
    ext: "mp4",
    protocol: "https",
    height: 720,
    vcodec: "avc1.64001F",
    acodec: "mp4a.40.2",
    video_ext: "mp4",
    audio_ext: "none",
    filesize: 5_000_000,
    ...o,
  });
  const videoOnly = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    format_id: "vid",
    ext: "mp4",
    protocol: "https",
    height: 720,
    vcodec: "avc1.64001F",
    acodec: "none",
    video_ext: "mp4",
    audio_ext: "none",
    ...o,
  });
  const audioOnly = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    format_id: "aud",
    ext: "m4a",
    protocol: "https",
    vcodec: "none",
    acodec: "mp4a.40.2",
    video_ext: "none",
    audio_ext: "m4a",
    ...o,
  });

  /** Every video preset is unknown-backed, claims no audio, and names no audio codec. */
  function assertUnknownVideoOnly(
    presets: Array<{ id: string; hasVideo: boolean; hasAudio: boolean; audioCodec: string | null }>,
    selections: Record<string, GenericPresetSource>,
    label: string,
  ) {
    const video = presets.filter((p) => p.hasVideo);
    assert.ok(video.length > 0, `${label}: video presets are produced`);
    for (const preset of video) {
      assert.equal(preset.hasAudio, false, `${label} ${preset.id}`);
      assert.equal(preset.audioCodec, null, `${label} ${preset.id}`);
      const source = singleSource(selections[preset.id]);
      assert.equal(source.audioConstraint, "unknown", `${label} ${preset.id}`);
      assert.equal(source.hasAudio, false, `${label} ${preset.id}`);
      assert.equal(source.hasVideo, true, `${label} ${preset.id}`);
    }
  }

  // ── The SYNTHETIC X-shaped regression ──────────────────────────────────────

  describe("the SYNTHETIC X-shaped document", () => {
    const DOC = readFileSync(
      join(import.meta.dirname, "testdata", "synthetic-x-progressive-unknown-audio.json"),
      "utf8",
    );
    const FORMATS = JSON.parse(DOC).formats as Array<Record<string, unknown>>;

    it("has exactly the decisive shape, and is sanitized", () => {
      assert.equal(FORMATS.length, 6);
      const progressive = FORMATS.filter((f) => f.protocol === "https");
      const hlsVideo = FORMATS.filter((f) => f.protocol === "m3u8_native" && f.vcodec !== "none");
      const hlsAudio = FORMATS.filter((f) => f.protocol === "m3u8_native" && f.vcodec === "none");
      assert.equal(progressive.length, 2);
      assert.equal(hlsVideo.length, 2);
      assert.equal(hlsAudio.length, 2);
      for (const f of progressive) {
        assert.equal(f.ext, "mp4");
        assert.equal(f.video_ext, "mp4");
        assert.equal("vcodec" in f, false, "video codec identity unknown");
        assert.equal("acodec" in f, false, "audio UNKNOWN: the key is absent");
      }
      assert.notEqual(progressive[0]!.height, progressive[1]!.height, "a lower and a higher rendition");
      for (const f of hlsVideo) assert.equal(f.acodec, "none");
      for (const f of hlsAudio) {
        assert.equal(f.ext, "mp4");
        assert.equal("acodec" in f, false, "audio-rendition-like, audio metadata unknown");
      }
      // Sanitization, with a positive control so an empty scan cannot pass.
      assert.ok(DOC.includes("SYNTHETIC"));
      for (const forbidden of ["http://", "https://", "//", "?", "token", "cookie", "x.com", "twitter", "twimg", "status", "url"]) {
        assert.equal(DOC.toLowerCase().includes(forbidden), false, forbidden);
      }
      for (const f of FORMATS) assert.match(String(f.format_id), /^synthetic-[a-z-]+$/);
    });

    it("HLS stays excluded: only the two progressive formats are candidates", () => {
      assert.deepEqual([...YTDLP_V1_NATIVE_PROTOCOLS], ["http", "https"]);
      const candidates = selectCandidates(FORMATS, LIMITS);
      assert.deepEqual(
        candidates.map((c) => [c.formatId, c.protocol, c.videoConstraint, c.audioConstraint]),
        [
          ["synthetic-prog-low", "https", "video-ext", "unknown"],
          ["synthetic-prog-high", "https", "video-ext", "unknown"],
        ],
      );
    });

    for (const ffmpegAvailable of [false, true]) {
      it(`produces video presets claiming no audio, and no audio/mp3 (ffmpeg=${ffmpegAvailable})`, async () => {
        const { runner } = fakeRunner(ok(DOC));
        const { video, selections } = await analyzeGenericMediaInternal(SAFE_URL, {
          limits: LIMITS,
          runner,
          probeRuntime: async () => OK_RUNTIME,
          validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
          ffmpegAvailable,
        });
        const common = { container: "mp4", hasVideo: true, hasAudio: false, videoCodec: null, audioCodec: null, fps: null };
        assert.deepEqual(video.presets, [
          { id: "preset:best", label: "Best available", resolution: "360p", fileSize: 2_400_000, formatId: "preset:best", ...common },
          { id: "preset:360", label: "360p", resolution: "360p", fileSize: 2_400_000, formatId: "preset:360", ...common },
          { id: "preset:240", label: "240p", resolution: "240p", fileSize: 1_200_000, formatId: "preset:240", ...common },
        ]);
        assert.deepEqual(video.capabilities, { mp3: false, merge: false });
        assert.equal(singleSource(selections["preset:best"]).formatId, "synthetic-prog-high");
        assert.equal(singleSource(selections["preset:360"]).formatId, "synthetic-prog-high");
        assert.equal(singleSource(selections["preset:240"]).formatId, "synthetic-prog-low");
        assertUnknownVideoOnly(video.presets, selections, "synthetic X");
        for (const value of Object.values(selections)) {
          const selector = buildGenericFormatSelector(singleSource(value));
          assert.match(selector, /\[protocol="https"\]/);
          assert.match(selector, /\[acodec!=\?"none"\]$/);
          assert.doesNotMatch(selector, /[/+]/);
        }
        // Nothing private reaches the HTTP body.
        const body = JSON.stringify(WorkerAnalyzeSuccessSchema.parse({ success: true, video }));
        for (const forbidden of ["synthetic-prog", "synthetic-hls", "audioConstraint", "videoConstraint", "b*["]) {
          assert.equal(body.includes(forbidden), false, forbidden);
        }
      });
    }
  });

  // ── The analysis matrix ──────────────────────────────────────────────────

  it("matrix: http/https × codec-present/video-ext × missing/null/empty/'null' acodec × mp4/webm", () => {
    let cases = 0;
    for (const protocol of ["http", "https"]) {
      for (const video of ["codec-present", "video-ext"] as const) {
        for (const acodec of [undefined, null, "", "null"]) {
          for (const ext of ["mp4", "webm"]) {
            const format: Record<string, unknown> = unknownProgressive({ protocol, ext, video_ext: ext });
            if (video === "codec-present") format.vcodec = ext === "mp4" ? "avc1.640028" : "vp09.00.40.08";
            if (acodec !== undefined) format.acodec = acodec;
            const label = `${protocol}/${video}/${JSON.stringify(acodec)}/${ext}`;

            const candidates = selectCandidates([format], LIMITS);
            assert.equal(candidates.length, 1, label);
            assert.equal(candidates[0]!.videoConstraint, video, label);
            assert.equal(candidates[0]!.audioConstraint, "unknown", label);

            const { presets, selections } = buildGenericPresets(candidates, { ffmpegAvailable: true, maxFileSizeBytes: MAX });
            assert.deepEqual(presets.map((p) => p.id), ["preset:best", "preset:1080"], label);
            for (const preset of presets) {
              assert.equal(preset.container, ext, label);
              assert.equal(preset.videoCodec, video === "codec-present" ? (ext === "mp4" ? "h264" : "vp9") : null, label);
            }
            assertUnknownVideoOnly(presets, selections, label);
            cases += 1;
          }
        }
      }
    }
    assert.equal(cases, 32);
  });

  it("eligibility is not weakened: every refusal still holds, each with a positive control", () => {
    const rows: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["HLS", unknownProgressive({ protocol: "m3u8_native" }), unknownProgressive()],
      ["no protocol", unknownProgressive({ protocol: undefined }), unknownProgressive()],
      ["unsupported container", unknownProgressive({ ext: "mkv", video_ext: "mkv" }), unknownProgressive()],
      ["unsafe id", unknownProgressive({ format_id: "bv+ba" }), unknownProgressive({ format_id: "bv-ba" })],
      ["over-limit known size", unknownProgressive({ filesize: MAX + 1 }), unknownProgressive({ filesize: MAX })],
      ["video_ext differs from ext", unknownProgressive({ video_ext: "webm" }), unknownProgressive()],
      ["video_ext missing", unknownProgressive({ video_ext: undefined }), unknownProgressive()],
      ["vcodec none beside a video_ext", unknownProgressive({ vcodec: "none" }), unknownProgressive()],
      ["named vcodec beside video_ext none", unknownProgressive({ vcodec: "avc1", video_ext: "none" }), unknownProgressive({ vcodec: "avc1" })],
      ["storyboard", unknownProgressive({ format_note: "storyboard" }), unknownProgressive({ format_note: "sd" })],
    ];
    for (const [label, refusedFormat, control] of rows) {
      for (const ffmpegAvailable of [false, true]) {
        assert.deepEqual(build([refusedFormat], ffmpegAvailable).presets, [], `${label}: refused`);
        const positive = build([control], ffmpegAvailable);
        assert.ok(positive.presets.length > 0, `${label}: control advertises`);
        assertUnknownVideoOnly(positive.presets, positive.selections, `${label} control`);
      }
    }
  });

  it("an explicit ABSENT-audio single progressive is NOT an ordinary silent-video fallback", () => {
    for (const ffmpegAvailable of [false, true]) {
      assert.deepEqual(build([unknownProgressive({ acodec: "none" })], ffmpegAvailable).presets, []);
      assert.deepEqual(build([videoOnly()], ffmpegAvailable).presets, []);
    }
  });

  // ── Proven fulfilments keep priority, byte for byte ─────────────────────────

  it("proven 720p + unknown 1080p is DEEP-EQUAL to proven 720p alone (presets AND selections)", () => {
    for (const ffmpegAvailable of [false, true]) {
      const alone = build([muxed()], ffmpegAvailable);
      for (const formats of [
        [muxed(), unknownProgressive()],
        [unknownProgressive(), muxed()],
        [unknownProgressive({ format_id: "unk-a", height: 2160 }), muxed(), unknownProgressive({ format_id: "unk-b", height: 480 })],
      ]) {
        assert.deepEqual(build(formats, ffmpegAvailable), alone, `ffmpeg=${ffmpegAvailable}`);
      }
      assert.equal(alone.presets.find((p) => p.id === "preset:best")?.resolution, "720p");
      assert.equal(alone.presets.every((p) => p.hasAudio), true);
    }
  });

  it("the tier is whole-result: a proven source with NO height still suppresses every unknown rung", () => {
    for (const ffmpegAvailable of [false, true]) {
      const alone = build([muxed({ height: undefined })], ffmpegAvailable);
      assert.deepEqual(build([muxed({ height: undefined }), unknownProgressive()], ffmpegAvailable), alone);
    }
  });

  it("approved split pair + unknown higher rung is DEEP-EQUAL to pair-only analysis (FFmpeg available)", () => {
    const pairOnly = build([videoOnly(), audioOnly()], true);
    assert.equal(pairOnly.selections["preset:best"]?.kind, "split");
    assert.deepEqual(build([videoOnly(), audioOnly(), unknownProgressive({ height: 2160 })], true), pairOnly);
    assert.deepEqual(build([unknownProgressive({ height: 2160 }), audioOnly(), videoOnly()], true), pairOnly);
  });

  it("FFmpeg unavailable: a pair-only proven tier is EMPTY, so the unknown fallback MAY engage", () => {
    // Intentional and documented: without Worker FFmpeg the pair cannot be
    // offered, and the unknown progressive source is deliverable as-is.
    const pairOnly = build([videoOnly(), audioOnly()], false);
    assert.equal(pairOnly.presets.some((p) => p.hasVideo), false, "the pair is not offered");

    const withUnknown = build([videoOnly(), audioOnly(), unknownProgressive({ height: 2160 })], false);
    assertUnknownVideoOnly(withUnknown.presets, withUnknown.selections, "ffmpeg unavailable");
    assert.deepEqual(withUnknown.presets.filter((p) => p.hasVideo).map((p) => p.id), ["preset:best", "preset:2160"]);
    // The audio-only source still backs preset:audio independently; MP3 still needs FFmpeg.
    assert.equal(singleSource(withUnknown.selections["preset:audio"]).formatId, "aud");
    assert.equal(withUnknown.presets.some((p) => p.id === "preset:mp3"), false);

    // ...and with FFmpeg back, the pair wins the whole result again.
    const withFfmpeg = build([videoOnly(), audioOnly(), unknownProgressive({ height: 2160 })], true);
    assert.deepEqual(withFfmpeg, build([videoOnly(), audioOnly()], true));
  });

  // ── Audio and MP3 stay proven-only ────────────────────────────────────────

  it("unknown video fallback + an independent PROVEN audio-only source: independent identities", () => {
    const { presets, selections } = build([unknownProgressive(), audioOnly()], true);
    assert.deepEqual(presets.map((p) => p.id), ["preset:best", "preset:1080", "preset:audio", "preset:mp3"]);
    assertUnknownVideoOnly(presets, selections, "with audio-only");
    for (const id of ["preset:audio", "preset:mp3"]) {
      const source = singleSource(selections[id]);
      assert.equal(source.formatId, "aud", id);
      assert.equal(source.audioConstraint, "codec-present", id);
      assert.equal(source.hasVideo, false, id);
    }
    assert.equal(singleSource(selections["preset:best"]).formatId, "unk");
    assert.equal(presets.find((p) => p.id === "preset:audio")?.hasAudio, true);
    // Exactly the audio half an audio-only-alone document would produce.
    const audioAlone = build([audioOnly()], true);
    for (const id of ["preset:audio", "preset:mp3"]) {
      assert.deepEqual(presets.find((p) => p.id === id), audioAlone.presets.find((p) => p.id === id), id);
      assert.deepEqual(selections[id], audioAlone.selections[id], id);
    }
  });

  it("an unknown-only document never yields preset:audio or preset:mp3, with or without FFmpeg", () => {
    for (const ffmpegAvailable of [false, true]) {
      const { presets, selections } = build(
        [unknownProgressive({ format_id: "a", height: 720 }), unknownProgressive({ format_id: "b", height: 360, ext: "webm", video_ext: "webm" })],
        ffmpegAvailable,
      );
      assert.equal(presets.some((p) => !p.hasVideo), false);
      assert.equal("preset:audio" in selections, false);
      assert.equal("preset:mp3" in selections, false);
    }
  });

  it("fallback ranking reuses the existing single-source ranking, and is order-independent", () => {
    const formats = [
      unknownProgressive({ format_id: "webm-big", ext: "webm", video_ext: "webm", filesize: 9_000_000 }),
      unknownProgressive({ format_id: "mp4-small", filesize: 1_000_000 }),
      unknownProgressive({ format_id: "mp4-big", filesize: 2_000_000 }),
    ];
    const forward = build(formats, true);
    // Container first (mp4 over webm), then the larger known size.
    assert.equal(singleSource(forward.selections["preset:best"]).formatId, "mp4-big");
    assert.deepEqual(build([...formats].reverse(), true).presets, forward.presets);
  });

  // ── The analyzer's own assertion fails closed ─────────────────────────────

  describe("assertGenericPresetBuild fails closed", () => {
    const ctx = (formats: Array<Record<string, unknown>>, ffmpegAvailable = true) => ({
      candidates: selectCandidates(formats, LIMITS),
      ffmpegAvailable,
      maxFileSizeBytes: MAX,
    });
    const expectFail = (fn: () => void, label: string) =>
      assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === "EXTRACTION_FAILED", label);

    /** A deep, mutable copy of a real build to tamper with. */
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

    it("accepts every legitimate shape (positive controls)", () => {
      for (const formats of [
        [unknownProgressive()],
        [unknownProgressive(), audioOnly()],
        [muxed(), unknownProgressive()],
        [videoOnly(), audioOnly(), unknownProgressive()],
      ]) {
        for (const ffmpegAvailable of [false, true]) {
          assert.doesNotThrow(() => assertGenericPresetBuild(build(formats, ffmpegAvailable), ctx(formats, ffmpegAvailable)));
        }
      }
    });

    it("public/private audio mismatch, in both directions", () => {
      const unknown = clone(build([unknownProgressive()], true));
      unknown.presets[0]!.hasAudio = true;
      expectFail(() => assertGenericPresetBuild(unknown, ctx([unknownProgressive()])), "unknown behind true");

      const proven = clone(build([muxed()], true));
      proven.presets[0]!.hasAudio = false;
      expectFail(() => assertGenericPresetBuild(proven, ctx([muxed()])), "proven behind false");

      const codec = clone(build([unknownProgressive()], true));
      codec.presets[0]!.audioCodec = "aac";
      expectFail(() => assertGenericPresetBuild(codec, ctx([unknownProgressive()])), "unknown with an audio codec");
    });

    it("an unknown source behind preset:audio or preset:mp3", () => {
      const formats = [unknownProgressive(), audioOnly()];
      for (const id of ["preset:audio", "preset:mp3"]) {
        const tampered = clone(build(formats, true));
        (tampered.selections as Record<string, GenericPresetSource>)[id] = clone(tampered.selections["preset:best"]!);
        expectFail(() => assertGenericPresetBuild(tampered, ctx(formats)), id);
      }
    });

    it("an unknown source admitted while a proven video fulfilment should have suppressed it", () => {
      // Mixed on the ladder...
      const mixedFormats = [muxed(), unknownProgressive()];
      const mixed = clone(build(mixedFormats, true));
      const unknownOnly = build([unknownProgressive()], true);
      (mixed.selections as Record<string, GenericPresetSource>)["preset:1080"] = unknownOnly.selections["preset:1080"]!;
      mixed.presets.push(unknownOnly.presets.find((p) => p.id === "preset:1080")!);
      expectFail(() => assertGenericPresetBuild(mixed, ctx(mixedFormats)), "mixed tiers");

      // ...and the whole ladder replaced while the candidates still offer proof.
      expectFail(() => assertGenericPresetBuild(unknownOnly, ctx(mixedFormats)), "muxed candidate unused");
      const pairFormats = [videoOnly(), audioOnly(), unknownProgressive()];
      expectFail(() => assertGenericPresetBuild(unknownOnly, ctx(pairFormats, true)), "pair candidate unused");
      // Control: without FFmpeg the pair is not a proven fulfilment, so it may engage.
      assert.doesNotThrow(() => assertGenericPresetBuild(unknownOnly, ctx(pairFormats, false)));
    });

    it("an explicit ABSENT-audio single source behind a video preset", () => {
      const tampered = clone(build([unknownProgressive()], true));
      for (const id of Object.keys(tampered.selections)) {
        const value = (tampered.selections as Record<string, GenericPresetSource>)[id]!;
        if (value.kind === "single") value.source.audioConstraint = "absent";
      }
      expectFail(() => assertGenericPresetBuild(tampered, ctx([videoOnly()])), "absent single");
    });

    it("a malformed split source, and a split preset denying audio", () => {
      const formats = [videoOnly(), audioOnly()];
      const unknownHalf = clone(build(formats, true));
      const pair = unknownHalf.selections["preset:best"];
      assert.ok(pair && pair.kind === "split");
      if (pair.kind === "split") {
        pair.pair.video.audioConstraint = "unknown";
      }
      expectFail(() => assertGenericPresetBuild(unknownHalf, ctx(formats)), "unknown video half");

      const denied = clone(build(formats, true));
      denied.presets.find((p) => p.id === "preset:best")!.hasAudio = false;
      expectFail(() => assertGenericPresetBuild(denied, ctx(formats)), "pair denying audio");

      expectFail(() => assertGenericPresetBuild(build(formats, true), ctx(formats, false)), "pair without FFmpeg");
    });

    it("a video preset whose single source carries no video, and an orphan selection", () => {
      const noVideo = clone(build([unknownProgressive(), audioOnly()], true));
      (noVideo.selections as Record<string, GenericPresetSource>)["preset:best"] = clone(noVideo.selections["preset:audio"]!);
      expectFail(() => assertGenericPresetBuild(noVideo, ctx([unknownProgressive(), audioOnly()])), "audio-only behind video");

      const orphan = clone(build([unknownProgressive()], true));
      (orphan.selections as Record<string, GenericPresetSource>)["preset:720"] = clone(orphan.selections["preset:best"]!);
      expectFail(() => assertGenericPresetBuild(orphan, ctx([unknownProgressive()])), "orphan selection");
    });
  });
});
