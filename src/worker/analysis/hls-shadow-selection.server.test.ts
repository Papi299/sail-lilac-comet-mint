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
import { CLEAR_HLS_SHADOW_PRESET_ID_PATTERN } from "../hls/hls-source-selection.ts";
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
 * HLS-5: the PRIVATE clear-HLS media-playlist selection channel.
 *
 * Two things are proved here, and they are deliberately in tension:
 *
 *   1. the exact per-rendition playlist URL now reaches Worker-private
 *      execution-analysis memory, on an application-owned preset rung;
 *   2. absolutely nothing else changes. HLS is still not advertised, still not
 *      downloadable, still withheld publicly as `unsupported_protocol`, and the
 *      progressive path's public and private outputs are untouched.
 *
 * The private half is future execution provenance for HLS-6. The public half
 * remains current Product truth. Both are asserted, together, on the same
 * documents.
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
      const { hlsSelections } = analyzeFormats(infoWith([format]));
      assert.deepEqual(hlsSelections, {}, `${label} must not be shadow-selected`);
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

  it("EXISTS in the strategy-aware execution analysis", async () => {
    const stdout = JSON.stringify(HLS_ONLY());
    const execution = await analyzeForExecution(SAFE_URL, {
      ytdlpEnabled: true,
      limits: LIMITS,
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
    assert.equal(execution.strategy, "yt-dlp");
    assert.equal(execution.hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
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

  it("does NOT reach the execution PLAN, which cannot express HLS", async () => {
    const internal = await analyzeInternal(infoWith([hlsFormat(), progressiveFormat()]));
    // The planner takes `{strategy, video, selections}` and has no HLS arm at
    // all: there is nothing for the private map to flow into.
    const plan = deriveExecutionPlan(
      { strategy: "yt-dlp", video: internal.video, selections: internal.selections },
      "preset:720",
    );
    assert.equal(JSON.stringify(plan).includes(TOKEN), false);
    assert.equal(JSON.stringify(plan).includes("m3u8"), false);
  });

  it("does NOT appear in an error when the whole document is unusable", async () => {
    // Every rendition is HLS, so nothing is advertised. The failure must be a
    // canonical code, and must not describe the private URL it declined.
    const err = await analyzeInternal(infoWith([hlsFormat({ height: null })]))
      .then(() => null, (e: unknown) => e);
    // A document with no advertisable preset still analyses successfully today;
    // if that ever becomes a failure, it must still be token-free.
    if (err !== null) {
      assert.equal(JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(TOKEN), false);
      assert.equal(String((err as Error).message ?? "").includes(TOKEN), false);
    }
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

// ── Public equivalence: nothing about Product behaviour moved (§15, §16) ─────

describe("HLS-5 public equivalence: HLS is still not a capability", () => {
  /** The same document, with and without every HLS rendition removed. */
  function pair(): { withHls: Record<string, unknown>; withoutHls: Record<string, unknown> } {
    return {
      withHls: infoWith([
        hlsFormat({ format_id: "hls-2160", height: 2160, url: hlsUrl("2160") }),
        hlsFormat({ format_id: "hls-1080", height: 1080, url: hlsUrl("1080") }),
        progressiveFormat(),
      ]),
      withoutHls: infoWith([progressiveFormat()]),
    };
  }

  it("leaves both protocol policies exactly http and https", () => {
    assert.deepEqual([...YTDLP_V1_NATIVE_PROTOCOLS], ["http", "https"]);
    assert.deepEqual([...GENERIC_SOURCE_PROTOCOLS], ["http", "https"]);
  });

  it("still refuses every HLS rendition as protocol-unsupported", () => {
    const { candidates } = analyzeFormats(infoWith([hlsFormat()]));
    assert.deepEqual(candidates, [], "HLS is not an acquisition candidate");
  });

  it("still reports HLS publicly as unsupported_protocol", async () => {
    const video = await analyzePublic(infoWith([hlsFormat()]));
    assert.deepEqual(withheldReasons(video), ["unsupported_protocol"]);
    assert.equal(video.sourceQuality?.observedMaxHeight, 1080);
    assert.equal(video.sourceQuality?.deliverableMaxHeight, null);
    assert.deepEqual(video.presets, [], "no HLS-derived public preset exists");
    assert.deepEqual(video.formats, []);
    assert.deepEqual(video.capabilities, { mp3: false, merge: false });
  });

  it("creates no public preset for an HLS-ONLY source, while selecting privately", async () => {
    const internal = await analyzeInternal(infoWith([hlsFormat()]));
    // Private: a full shadow ladder entry exists.
    assert.equal(internal.hlsSelections["preset:1080"]?.playlistUrl, hlsUrl("1080"));
    // Public: nothing at all. This is the deliberate contradiction of HLS-5.
    assert.deepEqual(internal.video.presets, []);
    assert.deepEqual(internal.selections, {});
    assert.deepEqual(withheldReasons(internal.video), ["unsupported_protocol"]);
  });

  it("keeps public metadata IDENTICAL whether or not HLS renditions are present", async () => {
    const { withHls, withoutHls } = pair();
    const a = await analyzePublic(withHls);
    const b = await analyzePublic(withoutHls);

    // Everything the browser can act on is untouched by the HLS rows.
    assert.deepEqual(a.presets, b.presets);
    assert.deepEqual(a.formats, b.formats);
    assert.deepEqual(a.capabilities, b.capabilities);
    assert.equal(a.sourceQuality?.deliverableMaxHeight, b.sourceQuality?.deliverableMaxHeight);

    // sourceQuality's OBSERVED half legitimately differs — it always described
    // the HLS rows, before HLS-5 and after. What must not change is that they
    // are still WITHHELD, and for the same reason.
    assert.equal(a.sourceQuality?.observedMaxHeight, 2160);
    assert.equal(b.sourceQuality?.observedMaxHeight, 720);
    assert.deepEqual(withheldReasons(a), ["unsupported_protocol"]);
    assert.deepEqual(withheldReasons(b), []);
  });

  it("does not let a TALLER HLS rendition displace the progressive preset:best", async () => {
    const internal = await analyzeInternal(pair().withHls);
    const best = internal.video.presets.find((p) => p.id === "preset:best");
    assert.ok(best, "the progressive source still backs preset:best");
    assert.equal(best.resolution, "720p", "a 2160 HLS rendition does not take it");

    // The private progressive selection is the progressive source, unchanged.
    const selection = internal.selections["preset:best"];
    assert.equal(selection?.kind, "single");
    assert.equal(
      selection?.kind === "single" ? selection.source.formatId : null,
      "http-720",
    );
    assert.equal(
      selection?.kind === "single" ? selection.source.protocol : null,
      "https",
    );

    // …while the SHADOW `preset:best` is the 2160 HLS rendition. Two maps, two
    // meanings: advertised-and-acquirable versus if-HLS-were-downloadable.
    assert.equal(internal.hlsSelections["preset:best"]?.playlistUrl, hlsUrl("2160"));
  });

  it("leaves the private progressive selections byte-identical", async () => {
    const { withHls, withoutHls } = pair();
    const a = await analyzeInternal(withHls);
    const b = await analyzeInternal(withoutHls);
    assert.deepEqual(a.selections, b.selections);
    assert.equal(JSON.stringify(a.selections).includes("m3u8"), false);
  });

  it("reports the same public result for a progressive-only document either way", async () => {
    // The HLS pass is additive: with no HLS rows present, removing it would
    // change nothing. Proved by the shadow map being empty and the whole
    // public document parsing unchanged.
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
});

// ── Structural dormancy (§10, §25) ───────────────────────────────────────────

describe("HLS-5 dormancy: the channel exists and nothing consumes it", () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

  it("is not read by the execution planner", () => {
    const source = read("src/worker/execution/format-plan.ts");
    assert.equal(source.includes("hlsSelections"), false);
    assert.equal(source.includes("hls"), false, "no HLS operation exists in the planner");
  });

  it("is not read by the JobExecutor, which names no HLS module", () => {
    const source = read("src/worker/execution/job-executor.server.ts");
    // The direct path STATES an empty map — that is the contract — but nothing
    // reads one, and no HLS module is imported.
    assert.equal(source.includes("hlsSelections: {}"), true);
    assert.equal(source.includes("analysis.hlsSelections"), false);
    assert.equal(source.includes("hls-source-selection"), false);
    assert.equal(source.includes("ClearHls"), false);
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
