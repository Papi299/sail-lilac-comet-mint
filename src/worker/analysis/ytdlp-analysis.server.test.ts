import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  YTDLP_ANALYSIS_MAX_TITLE_LENGTH,
  YTDLP_V1_NATIVE_PROTOCOLS,
  analyzeGenericMedia,
  buildYtdlpAnalysisArgv,
  classifyAnalysisFailure,
  parseAnalysisInfo,
  sanitizeUpstreamText,
  selectCandidates,
  ytdlpAnalysisPolicyArgs,
  type GenericAnalysisLimits,
} from "./ytdlp-analysis.server.ts";
import { YTDLP_RUNTIME, type YtdlpRuntimeStatus } from "../runtime/ytdlp-runtime.server.ts";

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
    probeRuntime?: () => Promise<YtdlpRuntimeStatus>;
    validateUrl?: (raw: string) => Promise<{ url: string; hostname: string }>;
    ffmpegAvailable?: boolean;
    signal?: AbortSignal;
    limits?: GenericAnalysisLimits;
  },
) {
  return analyzeGenericMedia(url, {
    limits: opts.limits ?? LIMITS,
    runner: opts.runner,
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
      "--ffmpeg-location",
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
    // The environment is the closed allowlist, never the ambient one.
    assert.equal(call.env?.PATH, "/usr/bin:/bin");
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

  it("never parses an upstream format_id at all", () => {
    const parsed = parseAnalysisInfo(JSON.stringify(singleVideoInfo()));
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      for (const format of parsed.info.formats ?? []) {
        assert.equal("format_id" in format, false, "format_id must be structurally absent");
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

function video(overrides: Record<string, unknown> = {}) {
  return {
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
      { ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", protocol: "https" },
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
      [{ ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", protocol: "https" }],
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
      [video({ height: 2160 }), video({ height: 720 }), { ext: "m4a", vcodec: "none", acodec: "mp4a", protocol: "https" }],
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

  it("propagates cancellation verbatim instead of flattening it", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = new AppError("PROCESSING_FAILED", "Download was cancelled.");
    const { runner } = fakeRunner(async () => {
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

describe("generic analysis: not reachable from Production", () => {
  const ROOT = process.cwd();
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("no Worker composition, business or execution module imports it", () => {
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
        `${file} imports the generic analyzer`,
      );
      assert.equal(
        source.includes("analysis/media-analyzer"),
        false,
        `${file} imports the strategy router`,
      );
      assert.equal(
        source.includes("analyzeGenericMedia"),
        false,
        `${file} calls the generic analyzer`,
      );
      assert.equal(source.includes("analyzeMedia"), false, `${file} calls the router`);
    }
  });

  it("WorkerService still resolves analysis to the direct-media analyzer alone", () => {
    const service = read("src/worker/http/business-service.server.ts");
    assert.match(service, /analyzeDirectMedia/);
    assert.match(service, /deps\.analyze \?\? analyzeDirectMedia/);
  });

  it("the JobExecutor has no generic branch", () => {
    const executor = read("src/worker/execution/job-executor.server.ts");
    for (const token of ["ytdlp", "yt-dlp", "yt_dlp", "analyzeGenericMedia", "analyzeMedia"]) {
      assert.equal(executor.includes(token), false, `JobExecutor references '${token}'`);
    }
  });

  it("generic capability remains unimplemented and /api/sites stays truthful", () => {
    const sites = read("src/lib/security/private-access-api.server.ts");
    assert.match(sites, /export const GENERIC_YTDLP_EXECUTION_IMPLEMENTED = false;/);
    assert.match(sites, /ytdlp: GENERIC_YTDLP_EXECUTION_IMPLEMENTED && ytdlpInstalled && ytdlpEnabled/);
  });
});
