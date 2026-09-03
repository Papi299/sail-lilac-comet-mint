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

  it("split-stream video-only formats produce NO video preset", async () => {
    const meta = await presetsFor([
      video({ acodec: "none", audio_ext: "none" }),
      { format_id: "audio-m4a", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", protocol: "https" },
    ]);
    const videoPresets = meta.presets.filter((p) => p.hasVideo);
    assert.deepEqual(videoPresets, [], "merging separate streams is out of scope for v1");
    // The audio-only source is still usable on its own.
    assert.ok(meta.presets.some((p) => p.id === "preset:audio"));
    assert.equal(meta.capabilities.merge, false);
  });

  it("never advertises merge capability", async () => {
    const meta = await presetsFor([video()]);
    assert.equal(meta.capabilities.merge, false);
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
      { ffmpegAvailable: false },
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
    assert.equal(selections["preset:best"]?.formatId, "0");
    assert.equal(JSON.stringify(presets).includes('"0"'), false);
  });

  it("survives the whole parse -> candidates -> presets path", () => {
    const parsed = parseAnalysisInfo(CAPTURED);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const { presets } = buildGenericPresets(
      selectCandidates(parsed.info.formats ?? [], LIMITS),
      { ffmpegAvailable: false },
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
  it("a proven-video format with an unknown acodec produces no video preset", async () => {
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
      const meta = await analyze(SAFE_URL, { runner });
      assert.deepEqual(
        meta.presets.filter((p) => p.hasVideo),
        [],
        "an mp4 container is not evidence of an audio stream",
      );
    }
  });

  it("an unknown-codec video with unknown audio produces nothing at all", async () => {
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
    const meta = await analyze(SAFE_URL, { runner });
    assert.deepEqual(meta.presets, []);
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

  it("split streams still produce NO merged video preset", async () => {
    // Both halves carry the real `*_ext` fields this time, so the refusal is
    // proven against the pinned shape rather than against an omission.
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
      "unknown-video support must not become a way to recombine split streams",
    );
    assert.equal(meta.capabilities.merge, false);
    assert.ok(meta.presets.some((p) => p.id === "preset:audio"));
  });

  it("an unknown-codec video source and a separate audio source do not merge", async () => {
    const unknownVideo = {
      format_id: "0",
      ext: "mp4",
      protocol: "https",
      vcodec: null,
      acodec: "none",
      video_ext: "mp4",
      audio_ext: "none",
    };
    const { runner } = fakeRunner(
      ok(JSON.stringify(singleVideoInfo({ formats: [unknownVideo, AUDIO_ONLY] }))),
    );
    const meta = await analyze(SAFE_URL, { runner });
    assert.deepEqual(meta.presets.filter((p) => p.hasVideo), []);
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
    });
    const selection = selections["preset:best"];
    assert.ok(selection);
    assert.equal(selection.videoConstraint, "video-ext");
    assert.equal(selection.formatId, "0");
    // The enum is application-owned: it must never paraphrase or embed the
    // upstream codec field it was derived from.
    assert.equal(JSON.stringify(selection).includes("mp4a.40.2"), false);
    assert.deepEqual(Object.keys(selection).sort(), [
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

    const { selections } = buildGenericPresets(candidates, { ffmpegAvailable: false });
    assert.equal(JSON.stringify(selections).includes("attacker.invalid"), false);
  });
});
