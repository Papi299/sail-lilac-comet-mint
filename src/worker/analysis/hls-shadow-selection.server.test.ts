import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../../lib/errors.ts";
import type { RunResult } from "../../services/processing/process-runner.server.ts";
import {
  VideoMetadataSchema,
  WorkerAnalyzeSuccessSchema,
  type WorkerVideoMetadata,
} from "../../shared/worker/contracts.ts";
import { GENERIC_SOURCE_PROTOCOLS } from "../execution/generic-source.ts";
import { deriveExecutionPlan } from "../execution/format-plan.ts";
import {
  CLEAR_HLS_SHADOW_PRESET_ID_PATTERN,
  hasClearHlsPublicPresetFacts,
} from "../hls/hls-source-selection.ts";
import { YTDLP_RUNTIME, type YtdlpRuntimeStatus } from "../runtime/ytdlp-runtime.server.ts";
import {
  YTDLP_V1_NATIVE_PROTOCOLS,
  analyzeGenericFormats,
  analyzeGenericMedia,
  analyzeGenericMediaInternal,
  type GenericAnalysisLimits,
} from "./ytdlp-analysis.server.ts";
import { analyzeForExecution } from "./media-analyzer.server.ts";

/**
 * HLS-5 + HLS-7: the PRIVATE clear-HLS media-playlist channel, and its
 * activation as an ordinary Product video capability.
 *
 * HLS-5 proved the exact per-rendition playlist URL reaches Worker-private
 * execution-analysis memory on an application-owned rung, and nothing else.
 * HLS-7 composes those placements with the mature progressive/split ladder:
 *
 *   1. HLS may FILL a rung the progressive family leaves empty, never displace
 *      one it fulfils, and owns `preset:best` only when its rung is tallest;
 *   2. every advertised preset is owned by EXACTLY ONE private map;
 *   3. HLS takes part only with Worker FFmpeg, and never as an audio product;
 *   4. the URL stays Worker-private, and both yt-dlp protocol lists stay
 *      exactly http/https — yt-dlp never acquires HLS.
 *
 * Public and private halves are asserted together, on the same documents.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

/**
 * The conspicuous sentinel. It is what a signed playlist URL looks like, and
 * it is searched for by substring everywhere it is forbidden — so a leak
 * through ANY serialisation, not just a known field name, fails the test.
 */
const TOKEN = "VERY_PRIVATE_HLS_TOKEN";
const hlsUrl = (tag: string) =>
  `https://media.example.invalid/hls/${tag}/media.m3u8?sig=${TOKEN}`;

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

// ── Raw-format fixtures ──────────────────────────────────────────────────────

/** A clear-HLS video rendition with proven audio: the admissible shape. */
function hlsFormat(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_id: "hls-1080",
    ext: "mp4",
    height: 1080,
    width: 1920,
    fps: 30,
    vcodec: "avc1.640028",
    acodec: "mp4a.40.2",
    protocol: "m3u8_native",
    url: hlsUrl("1080"),
    ...over,
  };
}

/** An ordinary progressive rendition. Never an HLS shadow candidate. */
function progressiveFormat(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_id: "http-720",
    ext: "mp4",
    height: 720,
    width: 1280,
    fps: 30,
    vcodec: "avc1.4d401f",
    acodec: "mp4a.40.2",
    filesize: 10_000_000,
    protocol: "https",
    url: `https://media.example.invalid/progressive/720.mp4?sig=${TOKEN}`,
    ...over,
  };
}

function infoWith(formats: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    _type: "video",
    title: "A Video",
    duration: 120,
    live_status: "not_live",
    formats,
  };
}

function formatsOf(info: Record<string, unknown>): Record<string, unknown>[] {
  return info.formats as Record<string, unknown>[];
}

/** `analyzeGenericFormats` over one document's formats, with real bounds. */
function analyzeFormats(
  info: Record<string, unknown>,
  opts: { ffmpegAvailable?: boolean; maxFileSizeBytes?: number } = {},
) {
  return analyzeGenericFormats(formatsOf(info) as never, {
    ffmpegAvailable: opts.ffmpegAvailable ?? true,
    maxFileSizeBytes: opts.maxFileSizeBytes ?? LIMITS.maxFileSizeBytes,
  });
}

/** The real internal analyzer over a canned `-J` document. No process runs. */
async function analyzeInternal(
  info: Record<string, unknown>,
  opts: { ffmpegAvailable?: boolean; limits?: GenericAnalysisLimits } = {},
) {
  const stdout = JSON.stringify(info);
  return analyzeGenericMediaInternal(SAFE_URL, {
    limits: opts.limits ?? LIMITS,
    ffmpegAvailable: opts.ffmpegAvailable ?? true,
    runner: async (): Promise<RunResult> => ({ code: 0, stdout, stderr: "" }),
    probeRuntime: async () => OK_RUNTIME,
    validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
  });
}

/** The BROWSER-safe analyzer over the same document. */
async function analyzePublic(
  info: Record<string, unknown>,
  opts: { ffmpegAvailable?: boolean } = {},
): Promise<WorkerVideoMetadata> {
  const stdout = JSON.stringify(info);
  return analyzeGenericMedia(SAFE_URL, {
    limits: LIMITS,
    ffmpegAvailable: opts.ffmpegAvailable ?? true,
    runner: async (): Promise<RunResult> => ({ code: 0, stdout, stderr: "" }),
    probeRuntime: async () => OK_RUNTIME,
    validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
  });
}

/** Every reason present in the public rendition inventory. */
function withheldReasons(video: WorkerVideoMetadata): string[] {
  return (video.sourceQuality?.withheld ?? []).map((w) => w.reason);
}

// ── Admission: which renditions become shadow candidates (§13, §21) ──────────

describe("HLS-5 admission: the narrow initial HLS shape", () => {
  it("accepts a clear-HLS video rendition with proven audio", () => {
    const { hlsSelections } = analyzeFormats(infoWith([hlsFormat()]));
    assert.equal(hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
    assert.equal(hlsSelections["preset:best"]?.playlistUrl, hlsUrl("1080"));
  });

  it("accepts one with an UNKNOWN size, because HLS-3 enforces actual bytes", () => {
    const { hlsSelections } = analyzeFormats(
      infoWith([hlsFormat({ filesize: null, filesize_approx: null })]),
    );
    assert.equal(hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
  });

  it("accepts one whose known size is within the ceiling", () => {
    const { hlsSelections } = analyzeFormats(
      infoWith([hlsFormat({ filesize: 10_000_000 })]),
      { maxFileSizeBytes: 20_000_000 },
    );
    assert.equal(hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
  });

  it("accepts a coherent unknown-codec video shape, the way analysis already does", () => {
    // `vcodec` unknown, but `video_ext === ext` in a known video container:
    // the same evidence standard the rendition inventory applies.
    const { hlsSelections } = analyzeFormats(
      infoWith([hlsFormat({ vcodec: null, ext: "mp4", video_ext: "mp4" })]),
    );
    assert.equal(hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
  });

  /** Each case must produce NO shadow selection at all. */
  const REFUSED: readonly (readonly [string, Record<string, unknown>])[] = [
    ["the `m3u8` protocol", hlsFormat({ protocol: "m3u8" })],
    ["a progressive http rendition", hlsFormat({ protocol: "http" })],
    ["a progressive https rendition", hlsFormat({ protocol: "https" })],
    ["segmented DASH", hlsFormat({ protocol: "http_dash_segments" })],
    ["a missing protocol", hlsFormat({ protocol: null })],
    ["video-only HLS", hlsFormat({ acodec: "none" })],
    ["unknown-audio HLS", hlsFormat({ acodec: null })],
    ["unknown-audio HLS (empty string)", hlsFormat({ acodec: "" })],
    ["audio-only HLS", hlsFormat({ vcodec: "none", ext: "m4a", video_ext: "none", height: null })],
    ["a stream-less row", hlsFormat({ vcodec: "none", acodec: "none" })],
    ["a storyboard", hlsFormat({ format_note: "storyboard", vcodec: "none" })],
    ["a preview-image row", hlsFormat({ format_note: "Preview image", ext: "jpg" })],
    ["a subtitle row", hlsFormat({ ext: "vtt", vcodec: null, video_ext: "vtt" })],
    ["an unestablished video shape", hlsFormat({ vcodec: null, ext: "mp4", video_ext: "webm" })],
    ["a contradicting video shape", hlsFormat({ vcodec: "avc1.640028", video_ext: "none" })],
    ["a missing playlist URL", hlsFormat({ url: undefined })],
    ["a null playlist URL", hlsFormat({ url: null })],
    ["a non-string playlist URL", hlsFormat({ url: 12345 })],
    ["an empty playlist URL", hlsFormat({ url: "" })],
    ["a relative playlist URL", hlsFormat({ url: "/hls/media.m3u8" })],
    ["a protocol-relative playlist URL", hlsFormat({ url: "//cdn.invalid/m.m3u8" })],
    ["a file: playlist URL", hlsFormat({ url: "file:///tmp/m.m3u8" })],
    ["a data: playlist URL", hlsFormat({ url: "data:text/plain,#EXTM3U" })],
    ["a credential-bearing playlist URL", hlsFormat({ url: "https://u:p@cdn.invalid/m.m3u8" })],
    ["a localhost playlist URL", hlsFormat({ url: "https://localhost/m.m3u8" })],
    ["a private-literal playlist URL", hlsFormat({ url: "https://10.0.0.1/m.m3u8" })],
    ["a malformed playlist URL", hlsFormat({ url: "https://bad host/m.m3u8" })],
    ["an over-ceiling playlist URL", hlsFormat({ url: `https://cdn.invalid/${"a".repeat(5000)}` })],
  ];

  for (const [label, format] of REFUSED) {
    it(`refuses ${label}`, () => {
      const { build, hlsSelections } = analyzeFormats(infoWith([format]));
      assert.deepEqual(hlsSelections, {}, `${label} must not be shadow-selected`);
      // HLS-7: and therefore never an HLS-backed public preset either. (The
      // http/https rows above are ordinary progressive sources, so this is a
      // statement about ownership, not about an empty ladder.)
      assert.equal(build.presets.some(hasClearHlsPublicPresetFacts), false, `${label}: no HLS preset`);
    });
  }

  it("refuses a known size already over the ceiling", () => {
    const { hlsSelections } = analyzeFormats(
      infoWith([hlsFormat({ filesize: 900_000_000 })]),
      { maxFileSizeBytes: 500_000_000 },
    );
    assert.deepEqual(hlsSelections, {});
  });

  it("refuses an over-ceiling ESTIMATED size the same way", () => {
    const { hlsSelections } = analyzeFormats(
      infoWith([hlsFormat({ filesize_approx: 900_000_000 })]),
      { maxFileSizeBytes: 500_000_000 },
    );
    assert.deepEqual(hlsSelections, {});
  });

  it("keeps a bad HLS rendition from affecting ordinary analysis (§28)", () => {
    // One unusable dormant rendition alongside a good progressive one must not
    // cost the user their download. The HLS candidate simply does not exist.
    const { build, hlsSelections } = analyzeFormats(
      infoWith([hlsFormat({ url: "not-a-url" }), progressiveFormat()]),
    );
    assert.deepEqual(hlsSelections, {});
    assert.ok(build.presets.some((p) => p.id === "preset:720"));
  });

  it("does not fail the document when a raw `url` is a hostile non-string", async () => {
    // `url` is declared `unknown`, so junk cannot make the closed schema reject
    // an otherwise valid info document.
    for (const url of [{}, [], 0, true, { toString: null }]) {
      const result = await analyzeInternal(infoWith([progressiveFormat({ url }), hlsFormat({ url })]));
      assert.equal(result.video.title, "A Video");
      assert.deepEqual(result.hlsSelections, {});
    }
  });
});

// ── The shadow ladder, over the analyzer's REAL rungs (§14, §22) ─────────────

describe("HLS-5 shadow ladder: the analyzer's own rung boundaries", () => {
  it("places each HLS rendition on its exact rung, best included", () => {
    const { hlsSelections } = analyzeFormats(
      infoWith([
        hlsFormat({ format_id: "hls-360", height: 360, url: hlsUrl("360") }),
        hlsFormat({ format_id: "hls-1080", height: 1080, url: hlsUrl("1080") }),
        hlsFormat({ format_id: "hls-720", height: 720, url: hlsUrl("720") }),
      ]),
    );
    assert.deepEqual(Object.keys(hlsSelections).sort(), [
      "preset:1080",
      "preset:360",
      "preset:720",
      "preset:best",
    ]);
    assert.equal(hlsSelections["preset:best"]?.playlistUrl, hlsUrl("1080"));
    assert.equal(hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
    assert.equal(hlsSelections["preset:720"]?.playlistUrl, hlsUrl("720"));
    assert.equal(hlsSelections["preset:360"]?.playlistUrl, hlsUrl("360"));
    // A 1080 rendition does not also masquerade as a lower rung.
    assert.equal(hlsSelections["preset:480"], undefined);
    assert.equal(hlsSelections["preset:240"], undefined);
  });

  it("resolves two renditions in one rung by upstream position", () => {
    const { hlsSelections } = analyzeFormats(
      infoWith([
        hlsFormat({ format_id: "hls-a", height: 1080, url: hlsUrl("first") }),
        hlsFormat({ format_id: "hls-b", height: 1152, url: hlsUrl("second") }),
      ]),
    );
    assert.equal(hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("first"));
    assert.equal(hlsSelections["preset:best"]?.playlistUrl, hlsUrl("first"));
  });

  it("lets an unknown-height HLS rendition back preset:best alone", () => {
    const { hlsSelections } = analyzeFormats(
      infoWith([hlsFormat({ height: null, url: hlsUrl("unknown") })]),
    );
    assert.deepEqual(Object.keys(hlsSelections), ["preset:best"]);
    assert.equal(hlsSelections["preset:best"]?.height, null);
  });

  it("freezes the map and every selection in it", () => {
    const { hlsSelections } = analyzeFormats(infoWith([hlsFormat()]));
    assert.equal(Object.isFrozen(hlsSelections), true);
    const selection = hlsSelections["preset:1080"];
    assert.ok(selection);
    assert.equal(Object.isFrozen(selection), true);
    assert.throws(() => {
      (selection as { playlistUrl: string }).playlistUrl = "https://attacker.invalid/x.m3u8";
    }, TypeError);
    assert.equal(hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
  });

  it("emits only video-ladder keys, never an audio product", () => {
    const { hlsSelections } = analyzeFormats(
      infoWith([
        hlsFormat({ format_id: "hls-1080", height: 1080, url: hlsUrl("1080") }),
        // A perfectly good audio-only HLS rendition, which HLS v1 has no
        // product for: it may not create `preset:audio` or `preset:mp3` here.
        hlsFormat({
          format_id: "hls-audio",
          vcodec: "none",
          ext: "m4a",
          video_ext: "none",
          height: null,
          url: hlsUrl("audio"),
        }),
      ]),
    );
    for (const id of Object.keys(hlsSelections)) {
      assert.match(id, CLEAR_HLS_SHADOW_PRESET_ID_PATTERN);
    }
    assert.equal(hlsSelections["preset:audio"], undefined);
    assert.equal(hlsSelections["preset:mp3"], undefined);
    assert.equal(
      JSON.stringify(hlsSelections).includes(hlsUrl("audio")),
      false,
      "the audio-only rendition is not selected at all",
    );
  });

  it("returns a frozen empty map when a document has no HLS at all", () => {
    const { hlsSelections } = analyzeFormats(infoWith([progressiveFormat()]));
    assert.deepEqual(hlsSelections, {});
    assert.equal(Object.isFrozen(hlsSelections), true);
  });
});

// ── Privacy: where the URL may exist, and where it may not (§6, §19) ─────────

describe("HLS-5 privacy: the playlist URL is Worker-private", () => {
  const HLS_ONLY = () => infoWith([hlsFormat()]);

  it("EXISTS in the private execution analysis", async () => {
    const internal = await analyzeInternal(HLS_ONLY());
    assert.equal(internal.hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
    assert.ok(JSON.stringify(internal.hlsSelections).includes(TOKEN));
  });

  /** The strategy-aware execution analysis, with the router's FFmpeg answer. */
  const executionAnalysis = (ffmpegAvailable: boolean) => {
    const stdout = JSON.stringify(HLS_ONLY());
    return analyzeForExecution(SAFE_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
      ffmpegAvailable,
      analyzeDirect: async () => {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      },
      analyzeGeneric: (url, opts) =>
        analyzeGenericMediaInternal(url, {
          limits: opts.limits,
          ffmpegAvailable: opts.ffmpegAvailable,
          runner: async (): Promise<RunResult> => ({ code: 0, stdout, stderr: "" }),
          probeRuntime: async () => OK_RUNTIME,
          validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
        }),
    });
  };

  it("EXISTS in the strategy-aware execution analysis", async () => {
    const execution = await executionAnalysis(true);
    assert.equal(execution.strategy, "yt-dlp");
    assert.equal(execution.hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
  });

  it("does NOT exist when the router reports no Worker FFmpeg (HLS-7)", async () => {
    // Every HLS job ends in a local remux, so without FFmpeg clear HLS takes no
    // part: nothing is advertised and no private location is retained.
    const execution = await executionAnalysis(false);
    assert.deepEqual(execution.hlsSelections, {});
    assert.deepEqual(execution.video.presets, []);
  });

  it("does NOT exist in the public metadata of the same analysis", async () => {
    const internal = await analyzeInternal(HLS_ONLY());
    const serialized = JSON.stringify(internal.video);
    assert.equal(serialized.includes(TOKEN), false, "the token reached WorkerVideoMetadata");
    assert.equal(serialized.includes("m3u8"), false);
    assert.equal(serialized.includes("hlsSelections"), false);
  });

  it("does NOT exist in the browser-safe analyzer's result", async () => {
    const video = await analyzePublic(HLS_ONLY());
    assert.equal(JSON.stringify(video).includes(TOKEN), false);
    assert.equal("hlsSelections" in (video as object), false);
  });

  it("does NOT survive the public response schema", async () => {
    const video = await analyzePublic(HLS_ONLY());
    // Strict public parsing, exactly as the Worker HTTP layer performs it. The
    // private field is DROPPED before this boundary rather than the schema
    // being widened to carry it.
    const response = WorkerAnalyzeSuccessSchema.parse({ success: true, video });
    assert.equal(JSON.stringify(response).includes(TOKEN), false);
    const reparsed = VideoMetadataSchema.parse(JSON.parse(JSON.stringify(video)));
    assert.equal(JSON.stringify(reparsed).includes(TOKEN), false);
  });

  it("reaches ONLY the plan of the preset clear HLS owns (HLS-7)", async () => {
    const internal = await analyzeInternal(infoWith([hlsFormat(), progressiveFormat()]));
    const analysis = { strategy: "yt-dlp" as const, ...internal };

    // A progressive-owned preset: its plan carries no HLS provenance at all.
    const progressive = deriveExecutionPlan(analysis, "preset:720");
    assert.equal(JSON.stringify(progressive).includes(TOKEN), false);
    assert.equal(JSON.stringify(progressive).includes("m3u8"), false);

    // The HLS-owned preset: its Worker-private, in-memory plan is the one place
    // the exact location may go, because HLS-2 is about to request it.
    const hls = deriveExecutionPlan(analysis, "preset:1080");
    assert.equal(hls.strategy === "yt-dlp" ? hls.generic.operation : null, "clear-hls-remux");
    assert.equal(
      hls.strategy === "yt-dlp" && hls.generic.operation === "clear-hls-remux"
        ? hls.generic.source.playlistUrl
        : null,
      hlsUrl("1080"),
    );
  });

  it("does NOT appear in an error when the whole document is unusable", async () => {
    // Every rendition is HLS and Worker FFmpeg is unavailable, so nothing is
    // advertised. Any failure must be a canonical code, and must not describe
    // the private URL it declined.
    const err = await analyzeInternal(infoWith([hlsFormat({ height: null })]), { ffmpegAvailable: false })
      .then(() => null, (e: unknown) => e);
    // A document with no advertisable preset still analyses successfully today;
    // if that ever becomes a failure, it must still be token-free.
    if (err !== null) {
      assert.equal(JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(TOKEN), false);
      assert.equal(String((err as Error).message ?? "").includes(TOKEN), false);
    }
  });

  it("does NOT reach the public Worker analyze response of an HLS-DOMINANT source (HLS-7)", async () => {
    const info = infoWith([
      hlsFormat({ format_id: "hls-2160", height: 2160, url: hlsUrl("2160") }),
      hlsFormat({ format_id: "hls-1080", height: 1080, url: hlsUrl("1080") }),
      progressiveFormat(),
    ]);
    const video = await analyzePublic(info);
    // The browser really is offered HLS-backed ordinary presets...
    assert.deepEqual(
      video.presets.filter(hasClearHlsPublicPresetFacts).map((p) => p.id),
      ["preset:best", "preset:2160", "preset:1080"],
    );
    // ...and the serialized public response names nothing that says so.
    const body = JSON.stringify(WorkerAnalyzeSuccessSchema.parse({ success: true, video }));
    for (const forbidden of [
      TOKEN,
      "playlistUrl",
      "hlsSelections",
      "clear-hls-remux",
      "m3u8_native",
      "m3u8",
      "hls-2160",
      "hls-1080",
      "media.example.invalid",
    ]) {
      assert.equal(body.includes(forbidden), false, `the public body names ${forbidden}`);
    }
    // The private analysis of the same document still holds the exact URL.
    const internal = await analyzeInternal(info);
    assert.equal(internal.hlsSelections["preset:2160"]?.playlistUrl, hlsUrl("2160"));
  });

  it("is not derivable from the progressive private selections", async () => {
    const internal = await analyzeInternal(infoWith([hlsFormat(), progressiveFormat()]));
    const selections = JSON.stringify(internal.selections);
    assert.equal(selections.includes(TOKEN), false, "no URL may enter GenericSourceSelection");
    assert.equal(selections.includes("m3u8"), false);
    assert.equal(selections.includes("playlistUrl"), false);
  });

  it("carries no upstream format id, headers, cookies or referer", async () => {
    const internal = await analyzeInternal(
      infoWith([
        hlsFormat({
          http_headers: { Cookie: `session=${TOKEN}`, Referer: "https://example.invalid/" },
          cookies: `session=${TOKEN}`,
          downloader_options: { http_chunk_size: 10 },
        }),
      ]),
    );
    const selection = internal.hlsSelections["preset:1080"];
    assert.ok(selection);
    assert.deepEqual(Object.keys(selection).sort(), ["height", "playlistUrl"]);
    // The URL's own token is expected; the COOKIE's is not distinguishable by
    // value, so the shape assertion above is what proves no header survived.
    assert.equal("http_headers" in (selection as object), false);
    assert.equal("format_id" in (selection as object), false);
  });
});

// ── HLS-7 activation: one final ladder, one owner per preset (§7–§14) ───────

describe("HLS-7 activation: clear HLS composes with the progressive ladder", () => {
  /** The exact public preset an HLS-owned rung advertises. */
  const hlsPreset = (id: string, label: string, resolution: string | null) => ({
    id,
    label,
    resolution,
    container: "mp4",
    fileSize: null,
    hasVideo: true,
    hasAudio: true,
    formatId: id,
    videoCodec: null,
    audioCodec: null,
    fps: null,
  });
  const ids = (video: WorkerVideoMetadata) => video.presets.map((p) => p.id);
  const operationOf = (analysis: Parameters<typeof deriveExecutionPlan>[0], id: string) => {
    const plan = deriveExecutionPlan(analysis, id);
    return plan.strategy === "yt-dlp" ? plan.generic.operation : plan.direct.operation;
  };
  const asAnalysis = (internal: Awaited<ReturnType<typeof analyzeInternal>>) => ({
    strategy: "yt-dlp" as const,
    ...internal,
  });

  it("leaves both protocol policies exactly http and https", () => {
    assert.deepEqual([...YTDLP_V1_NATIVE_PROTOCOLS], ["http", "https"]);
    assert.deepEqual([...GENERIC_SOURCE_PROTOCOLS], ["http", "https"]);
  });

  it("never makes an HLS rendition a yt-dlp acquisition candidate", () => {
    const { candidates } = analyzeFormats(infoWith([hlsFormat()]));
    assert.deepEqual(candidates, [], "HLS is acquired by VideoFetch, never by yt-dlp");
  });

  // ── A. HLS-only, FFmpeg available ──────────────────────────────────────────
  it("A: an HLS-ONLY source advertises ordinary HLS-owned video presets", async () => {
    const internal = await analyzeInternal(infoWith([hlsFormat()]));

    assert.deepEqual(internal.video.presets, [
      hlsPreset("preset:best", "Best available", "1080p"),
      hlsPreset("preset:1080", "1080p", "1080p"),
    ]);
    assert.deepEqual(internal.video.formats, []);
    assert.deepEqual(internal.video.capabilities, { mp3: false, merge: false });

    // Ownership: HLS alone, and the SAME rendition behind best and its rung.
    assert.deepEqual(internal.selections, {});
    assert.deepEqual(internal.hlsSelections, {
      "preset:best": { playlistUrl: hlsUrl("1080"), height: 1080 },
      "preset:1080": { playlistUrl: hlsUrl("1080"), height: 1080 },
    });

    // The ORDINARY planner — nothing injected — reaches clear HLS.
    for (const id of ["preset:best", "preset:1080"]) {
      assert.equal(operationOf(asAnalysis(internal), id), "clear-hls-remux", id);
    }

    // And the inventory calls the rendition deliverable.
    assert.deepEqual(internal.video.sourceQuality, {
      observedMaxHeight: 1080,
      deliverableMaxHeight: 1080,
      withheld: [],
      protectedUnenumerated: false,
      maybeProtectedObserved: false,
    });
  });

  // ── B. HLS-only, FFmpeg unavailable ────────────────────────────────────────
  it("B: WITHOUT Worker FFmpeg an HLS-only source advertises nothing", async () => {
    const internal = await analyzeInternal(infoWith([hlsFormat()]), { ffmpegAvailable: false });
    assert.deepEqual(internal.video.presets, []);
    assert.deepEqual(internal.selections, {});
    assert.deepEqual(internal.hlsSelections, {});
    assert.deepEqual(withheldReasons(internal.video), ["unsupported_protocol"]);
    assert.equal(internal.video.sourceQuality?.deliverableMaxHeight, null);
    assert.throws(
      () => deriveExecutionPlan(asAnalysis(internal), "preset:1080"),
      (e: unknown) => e instanceof AppError && e.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("B: WITHOUT Worker FFmpeg a mixed source is exactly its progressive result", async () => {
    const withHls = infoWith([
      hlsFormat({ format_id: "hls-2160", height: 2160, url: hlsUrl("2160") }),
      progressiveFormat(),
    ]);
    const a = await analyzeInternal(withHls, { ffmpegAvailable: false });
    const b = await analyzeInternal(infoWith([progressiveFormat()]), { ffmpegAvailable: false });
    assert.deepEqual(a.video.presets, b.video.presets);
    assert.deepEqual(a.video.capabilities, b.video.capabilities);
    assert.deepEqual(a.selections, b.selections);
    assert.deepEqual(a.hlsSelections, {});
    assert.deepEqual(withheldReasons(a.video), ["unsupported_protocol"]);
  });

  // ── C. Higher HLS + lower progressive ──────────────────────────────────────
  it("C: progressive 720 + HLS 2160 — HLS fills 2160 and takes best", async () => {
    const internal = await analyzeInternal(
      infoWith([hlsFormat({ format_id: "hls-2160", height: 2160, url: hlsUrl("2160") }), progressiveFormat()]),
    );
    const progressiveOnly = await analyzeInternal(infoWith([progressiveFormat()]));
    const progressivePreset = (id: string) => progressiveOnly.video.presets.find((p) => p.id === id);

    assert.deepEqual(internal.video.presets, [
      hlsPreset("preset:best", "Best available", "2160p"),
      hlsPreset("preset:2160", "2160p / 4K", "2160p"),
      progressivePreset("preset:720"),
      progressivePreset("preset:audio"),
      progressivePreset("preset:mp3"),
    ]);
    // The progressive half is the progressive-only result minus `preset:best`.
    const { "preset:best": _displaced, ...progressiveRest } = progressiveOnly.selections;
    assert.deepEqual(internal.selections, progressiveRest);
    assert.deepEqual(Object.keys(internal.hlsSelections), ["preset:best", "preset:2160"]);
    assert.equal(internal.hlsSelections["preset:best"]?.playlistUrl, hlsUrl("2160"));

    assert.equal(operationOf(asAnalysis(internal), "preset:720"), "keep-original");
    assert.equal(operationOf(asAnalysis(internal), "preset:best"), "clear-hls-remux");
    assert.equal(operationOf(asAnalysis(internal), "preset:2160"), "clear-hls-remux");

    assert.equal(internal.video.sourceQuality?.deliverableMaxHeight, 2160);
    assert.equal(internal.video.sourceQuality?.observedMaxHeight, 2160);
    assert.deepEqual(withheldReasons(internal.video), []);
    // `merge` is the SPLIT merge; an HLS remux never sets it.
    assert.deepEqual(internal.video.capabilities, { mp3: true, merge: false });
  });

  // ── D. Same-rung tie ───────────────────────────────────────────────────────
  it("D: progressive 1080 + HLS 1080 — progressive keeps the rung and best", async () => {
    const progressive1080 = progressiveFormat({ format_id: "http-1080", height: 1080 });
    const internal = await analyzeInternal(infoWith([hlsFormat(), progressive1080]));
    const progressiveOnly = await analyzeInternal(infoWith([progressive1080]));

    assert.deepEqual(internal.video.presets, progressiveOnly.video.presets);
    assert.deepEqual(internal.selections, progressiveOnly.selections);
    assert.deepEqual(internal.hlsSelections, {}, "HLS does not displace a mature fulfilment");
    assert.equal(operationOf(asAnalysis(internal), "preset:1080"), "keep-original");
    assert.equal(operationOf(asAnalysis(internal), "preset:best"), "keep-original");
    // The HLS rendition was eligible and lost its rung: not_selected.
    assert.deepEqual(internal.video.sourceQuality?.withheld, [
      { reason: "not_selected", count: 1, maxObservedHeight: 1080 },
    ]);
  });

  // ── E. Higher progressive + lower HLS ──────────────────────────────────────
  it("E: progressive 2160 + HLS 1080 — best stays progressive, HLS fills 1080", async () => {
    const progressive2160 = progressiveFormat({ format_id: "http-2160", height: 2160 });
    const internal = await analyzeInternal(infoWith([hlsFormat(), progressive2160]));
    const progressiveOnly = await analyzeInternal(infoWith([progressive2160]));

    assert.deepEqual(ids(internal.video), [
      "preset:best",
      "preset:2160",
      "preset:1080",
      "preset:audio",
      "preset:mp3",
    ]);
    const best = internal.video.presets.find((p) => p.id === "preset:best");
    assert.deepEqual(best, progressiveOnly.video.presets.find((p) => p.id === "preset:best"));
    assert.equal(best?.resolution, "2160p");
    assert.deepEqual(internal.selections, progressiveOnly.selections);
    assert.deepEqual(Object.keys(internal.hlsSelections), ["preset:1080"]);
    assert.deepEqual(
      internal.video.presets.find((p) => p.id === "preset:1080"),
      hlsPreset("preset:1080", "1080p", "1080p"),
    );
    assert.equal(operationOf(asAnalysis(internal), "preset:best"), "keep-original");
    assert.equal(operationOf(asAnalysis(internal), "preset:1080"), "clear-hls-remux");
  });

  // ── F. Unknown height ──────────────────────────────────────────────────────
  it("F: with no named rung, a progressive unknown-height best wins", async () => {
    const internal = await analyzeInternal(
      infoWith([hlsFormat({ height: null }), progressiveFormat({ height: null })]),
    );
    const best = internal.video.presets.find((p) => p.id === "preset:best");
    assert.equal(best?.resolution, null);
    assert.equal(internal.selections["preset:best"]?.kind, "single");
    assert.deepEqual(internal.hlsSelections, {});
    assert.deepEqual(internal.video.sourceQuality?.withheld, [
      { reason: "not_selected", count: 1, maxObservedHeight: null },
    ]);
  });

  it("F: with no named rung and no progressive best, HLS may back best alone", async () => {
    const internal = await analyzeInternal(infoWith([hlsFormat({ height: null })]));
    assert.deepEqual(internal.video.presets, [hlsPreset("preset:best", "Best available", null)]);
    assert.deepEqual(internal.hlsSelections, {
      "preset:best": { playlistUrl: hlsUrl("1080"), height: null },
    });
    assert.equal(operationOf(asAnalysis(internal), "preset:best"), "clear-hls-remux");
  });

  it("F: a named HLS rung outranks an unknown-height progressive best", async () => {
    const internal = await analyzeInternal(
      infoWith([hlsFormat({ height: 720, url: hlsUrl("720") }), progressiveFormat({ height: null })]),
    );
    assert.deepEqual(internal.video.presets.slice(0, 2), [
      hlsPreset("preset:best", "Best available", "720p"),
      hlsPreset("preset:720", "720p", "720p"),
    ]);
    assert.equal(internal.selections["preset:best"], undefined);
    // The displaced progressive rendition is still eligible: not_selected.
    assert.deepEqual(internal.video.sourceQuality?.withheld, [
      { reason: "not_selected", count: 1, maxObservedHeight: null },
    ]);
  });

  // ── K. Audio products ──────────────────────────────────────────────────────
  it("K: clear HLS never creates or owns preset:audio or preset:mp3", async () => {
    const hlsOnly = await analyzeInternal(infoWith([hlsFormat()]));
    assert.equal(hlsOnly.video.presets.some((p) => !p.hasVideo), false);

    const audioOnly = {
      format_id: "http-audio",
      ext: "m4a",
      vcodec: "none",
      acodec: "mp4a.40.2",
      video_ext: "none",
      protocol: "https",
    };
    const mixed = await analyzeInternal(infoWith([hlsFormat(), audioOnly]));
    assert.deepEqual(ids(mixed.video), ["preset:best", "preset:1080", "preset:audio", "preset:mp3"]);
    for (const id of ["preset:audio", "preset:mp3"]) {
      assert.equal(mixed.hlsSelections[id], undefined, `${id} is never HLS-owned`);
      const value = mixed.selections[id];
      assert.equal(value?.kind === "single" ? value.source.formatId : null, "http-audio", id);
    }
  });

  // ── The progressive family's own tier choice is kept ───────────────────────
  it("keeps an unknown-audio progressive ladder, and lets HLS fill above it", async () => {
    // The progressive family chose its unknown-audio fallback tier on its own
    // candidates, before composition. HLS-7's precedence is literal: a rung the
    // progressive family fulfils stays progressive, whatever tier backs it.
    const unknownAudio = progressiveFormat({ format_id: "http-360", height: 360, acodec: null });
    const internal = await analyzeInternal(infoWith([hlsFormat(), unknownAudio]));
    assert.deepEqual(ids(internal.video), ["preset:best", "preset:1080", "preset:360"]);
    assert.equal(internal.video.presets.find((p) => p.id === "preset:best")?.hasAudio, true);
    assert.equal(internal.video.presets.find((p) => p.id === "preset:360")?.hasAudio, false);
    assert.deepEqual(Object.keys(internal.hlsSelections), ["preset:best", "preset:1080"]);
    const value = internal.selections["preset:360"];
    assert.equal(value?.kind === "single" ? value.source.audioConstraint : null, "unknown");
  });

  it("reports the same result for a progressive-only document either way", async () => {
    // The HLS pass is additive: with no HLS rows present, composition returns
    // the construction untouched.
    const info = infoWith([progressiveFormat()]);
    const { hlsSelections } = analyzeFormats(info);
    assert.deepEqual(hlsSelections, {});
    const video = await analyzePublic(info);
    assert.deepEqual(
      video.presets.map((p) => p.id).sort(),
      ["preset:720", "preset:audio", "preset:best", "preset:mp3"],
    );
    assert.deepEqual(withheldReasons(video), []);
  });

  it("makes the two private maps disjoint, and together exhaustive", async () => {
    for (const info of [
      infoWith([hlsFormat()]),
      infoWith([hlsFormat({ format_id: "hls-2160", height: 2160, url: hlsUrl("2160") }), progressiveFormat()]),
      infoWith([hlsFormat(), progressiveFormat({ format_id: "http-2160", height: 2160 })]),
      infoWith([hlsFormat(), progressiveFormat({ format_id: "http-1080", height: 1080 })]),
    ]) {
      const internal = await analyzeInternal(info);
      for (const preset of internal.video.presets) {
        const progressive = preset.id in internal.selections;
        const hls = preset.id in internal.hlsSelections;
        assert.equal(progressive !== hls, true, `${preset.id} has exactly one owner`);
        assert.equal(hasClearHlsPublicPresetFacts(preset), hls, `${preset.id}: facts agree with owner`);
      }
      for (const id of [...Object.keys(internal.selections), ...Object.keys(internal.hlsSelections)]) {
        assert.ok(internal.video.presets.some((p) => p.id === id), `${id} is advertised`);
      }
    }
  });
});

// ── Structure: who may read the channel (§10, §25; HLS-7 §17, §27) ─────────

describe("HLS-5/HLS-7 structure: analysis produces the channel, the planner alone reads it", () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

  /**
   * HLS-7 REPLACED THE DORMANCY PIN BELOW, deliberately.
   *
   * HLS-5 asserted that nothing read the shadow map; HLS-6 narrowed that to
   * "the ORDINARY planner never sees it", pinned by its parameter type. HLS-7 is
   * the reviewed change that connects them, so that pin is now its opposite:
   * the ordinary planner REQUIRES the map, reads which family owns the request,
   * and dispatches — with no try/catch, so neither family is ever a fallback
   * for the other. The progressive derivation it dispatches to stays HLS-blind,
   * and the executor still reads nothing of the map itself.
   */

  /** The body of a top-level function, by brace matching from its signature. */
  const functionBody = (source: string, signature: string): string => {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `${signature} must exist`);
    const open = source.indexOf("{", start + signature.length - 1);
    assert.notEqual(open, -1);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    assert.fail(`${signature} has no balanced body`);
  };

  /** The executable body of a function: brace-matched from `opener`, comments removed. */
  const bodyAfter = (source: string, signature: string, opener: string): string => {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `${signature} must exist`);
    const open = source.indexOf(opener, start) + opener.length - 1;
    assert.equal(source[open], "{", `${signature} must open its body with ${opener}`);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          return source
            .slice(open, i + 1)
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/(^|[^:])\/\/.*$/gm, "$1");
        }
      }
    }
    assert.fail(`${signature} has no balanced body`);
  };

  it("HLS-7: the ordinary planner REQUIRES the map, reads ownership, and never falls back", () => {
    const source = read("src/worker/execution/format-plan.ts");

    // The parameter type now declares the HLS half as REQUIRED, so every caller
    // states it — the direct path and progressive fixtures as `{}`.
    const params = functionBody(source, "export function deriveExecutionPlan(");
    assert.ok(params.includes("readonly hlsSelections: ClearHlsMediaPlaylistSelections;"));
    assert.equal(params.includes("hlsSelections?"), false, "never optional");

    const planner = bodyAfter(source, "export function deriveExecutionPlan(", "): ExecutionPlan {");
    for (const required of [
      "genericPresetOwner(",
      "analysis.hlsSelections",
      "deriveClearHlsExecutionPlan(",
      "deriveGenericExecutionPlan(",
    ]) {
      assert.ok(planner.includes(required), `deriveExecutionPlan must name ${required}`);
    }
    // No try/catch anywhere in it: a refusal from one family is final, and is
    // never retried as the other.
    assert.equal(/\btry\b|\bcatch\b/.test(planner), false, "no hidden substitution");

    // The ownership reader READS; it derives nothing and can only refuse.
    const owner = bodyAfter(source, "function genericPresetOwner(", "): GenericPresetOwner {");
    assert.equal(/derive\w*ExecutionPlan\s*\(/.test(owner), false);
    assert.equal(/\btry\b|\bcatch\b/.test(owner), false);

    // The ordinary GENERIC derivation it dispatches to stays HLS-blind.
    const generic = functionBody(source, "export function deriveGenericExecutionPlan(");
    for (const forbidden of ["hlsSelections", "ClearHls", "clear-hls"]) {
      assert.equal(
        generic.includes(forbidden),
        false,
        `deriveGenericExecutionPlan must not name ${forbidden}`,
      );
    }
  });

  it("is not read by the JobExecutor, whose only HLS edge is the HLS-6 seam", () => {
    const source = read("src/worker/execution/job-executor.server.ts");
    // The direct path STATES an empty map — that is the contract — but nothing
    // reads one.
    assert.equal(source.includes("hlsSelections: {}"), true);
    assert.equal(source.includes("analysis.hlsSelections"), false);
    // The executor cannot even name the HLS-5 vocabulary, so it has no type with
    // which to read a selection, let alone a map to read it from.
    assert.equal(source.includes("hls-source-selection"), false);

    // Exactly ONE HLS import: the HLS-6 orchestration seam. Every HLS-2/3/4
    // primitive stays behind it — the case below proves that separately.
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(
      imports.filter((specifier) => specifier.includes("hls")),
      ["../hls/hls-execution.server.ts"],
    );
  });

  it("calls no HLS-2/3/4 primitive from Product execution", () => {
    for (const rel of [
      "src/worker/execution/format-plan.ts",
      "src/worker/execution/job-executor.server.ts",
      "src/worker/analysis/ytdlp-analysis.server.ts",
      "src/worker/analysis/media-analyzer.server.ts",
    ]) {
      const source = read(rel);
      for (const forbidden of [
        "preflightClearHlsMediaPlaylist",
        "acquireClearHlsTs",
        "processClearHlsTsToMp4",
        "hls-preflight",
        "hls-fragment-acquisition",
        "hls-processing",
        "hls-media-playlist",
      ]) {
        assert.equal(source.includes(forbidden), false, `${rel} must not name ${forbidden}`);
      }
    }
  });

  it("performs no playlist fetch during analysis", () => {
    const source = read("src/worker/analysis/ytdlp-analysis.server.ts");
    for (const forbidden of ["safeGet", "safeHttpRequest", "lookupHost", "fetch("]) {
      assert.equal(source.includes(forbidden), false, `analysis must not call ${forbidden}`);
    }
  });

  it("puts `hlsSelections` in no public contract and no store schema", () => {
    for (const rel of [
      "src/shared/worker/contracts.ts",
      "src/worker/state/job-store.ts",
      "src/worker/state/sqlite-job-store.server.ts",
    ]) {
      const source = read(rel);
      assert.equal(source.includes("hlsSelections"), false, `${rel} must stay free of it`);
      assert.equal(source.includes("playlistUrl"), false);
    }
  });

  it("is imported by no web or shared module", () => {
    for (const rel of [
      "src/shared/worker/contracts.ts",
      "src/web/boundary/control-plane-boundary.test.ts",
    ]) {
      assert.equal(read(rel).includes("hls-source-selection"), false, rel);
    }
  });
});
