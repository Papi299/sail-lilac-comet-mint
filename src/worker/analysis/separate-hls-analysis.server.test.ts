import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import { AppError } from "../../lib/errors.ts";
import { setSafeHttpTestHooks, type SafeRequestOnce } from "../../lib/security/safe-http.server.ts";
import { deriveExecutionPlan } from "../execution/format-plan.ts";
import { hasClearHlsPublicPresetFacts } from "../hls/hls-source-selection.ts";
import type { SeparateHlsProvenPair, SeparateHlsVideoCandidate } from "../hls/hls-master-pairing.server.ts";
import {
  analyzeGenericFormats,
  analyzeGenericMedia,
  analyzeGenericMediaInternal,
  separateHlsProofCandidates,
  type GenericAnalysisDeps,
} from "./ytdlp-analysis.server.ts";

/**
 * HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001: separate-audio pairing in
 * generic analysis. yt-dlp is scripted (its `-J` document), and the master
 * proof runs FOR REAL through safe-HTTP, scripted only at its lowest hooks — so
 * the static URL policy, the DNS-answer check and `maxRedirects: 0` all run.
 */

const PAGE = "https://example.com/watch/sep";
const TOKEN = "SIGNED_SENTINEL";
const MASTER_URL = `https://cdn.example.com/hls/master.m3u8?sig=${TOKEN}`;
const VIDEO_URL = `https://cdn.example.com/hls/video/1080.m3u8?vtok=${TOKEN}`;
const AUDIO_URL = `https://cdn.example.com/hls/audio/main.m3u8?atok=${TOKEN}`;
const GROUP = "GROUPID_SENTINEL";
const NAME = "RENDITION_NAME_SENTINEL";
const LANG = "LANGUAGE_SENTINEL";

const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${GROUP}",NAME="${NAME}",LANGUAGE="${LANG}",DEFAULT=YES,AUTOSELECT=YES,URI="audio/main.m3u8?atok=${TOKEN}"`,
  `#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="${GROUP}"`,
  `video/1080.m3u8?vtok=${TOKEN}`,
  `#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="${GROUP}"`,
  `video/720.m3u8?vtok=${TOKEN}`,
  "",
].join("\n");

function videoRow(overrides: Record<string, unknown> = {}) {
  return {
    format_id: `hls-${NAME}-900`,
    protocol: "m3u8_native",
    ext: "mp4",
    vcodec: "avc1.640028",
    acodec: "none",
    video_ext: "mp4",
    audio_ext: "none",
    width: 1920,
    height: 1080,
    url: VIDEO_URL,
    manifest_url: MASTER_URL,
    ...overrides,
  };
}

const AUDIO_ROW = {
  format_id: `hls-${GROUP}-${NAME}`,
  protocol: "m3u8_native",
  ext: "mp4",
  vcodec: "none",
  acodec: null,
  video_ext: "none",
  audio_ext: "mp4",
  url: AUDIO_URL,
  manifest_url: MASTER_URL,
  language: LANG,
};

const PROGRESSIVE_1080 = {
  format_id: "prog-1080",
  protocol: "https",
  ext: "mp4",
  vcodec: "avc1.640028",
  acodec: "mp4a.40.2",
  video_ext: "mp4",
  audio_ext: "none",
  width: 1920,
  height: 1080,
  filesize: 4096,
};

const MUXED_HLS_720 = {
  format_id: "hls-muxed-720",
  protocol: "m3u8_native",
  ext: "mp4",
  vcodec: "avc1.64001f",
  acodec: "mp4a.40.2",
  video_ext: "mp4",
  audio_ext: "none",
  width: 1280,
  height: 720,
  url: "https://cdn.example.com/muxed/720.m3u8",
  manifest_url: "https://cdn.example.com/muxed/master.m3u8",
};

function document(formats: unknown[]) {
  return { _type: "video", title: "Separate audio clip", duration: 6, formats };
}

type Served = { status?: number; headers?: IncomingHttpHeaders; body?: Readable | null };

function network(routes: Record<string, Served | (() => Served)>) {
  const requests: string[] = [];
  setSafeHttpTestHooks({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    requestOnce: (async (args) => {
      requests.push(args.url.href);
      const route = routes[args.url.href];
      if (route === undefined) return { status: 404, headers: {}, body: null };
      const served = typeof route === "function" ? route() : route;
      return { status: served.status ?? 200, headers: served.headers ?? {}, body: served.body ?? null };
    }) as SafeRequestOnce,
  });
  return requests;
}

const serve = (text: string): (() => Served) => () => ({ status: 200, body: Readable.from([Buffer.from(text)]) });

afterEach(() => setSafeHttpTestHooks(null));

function deps(formats: unknown[], overrides: Partial<GenericAnalysisDeps> = {}): GenericAnalysisDeps {
  return {
    limits: { analysisTimeoutSeconds: 45, maxVideoDurationSeconds: 7200, maxFileSizeBytes: 4 * 1024 ** 3 },
    ffmpegAvailable: true,
    runner: async () => ({ code: 0, stdout: JSON.stringify(document(formats)), stderr: "" }),
    probeRuntime: async () => ({ available: true, version: "2026.08.19", reason: "ok" as const }),
    validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
    ...overrides,
  };
}

describe("separate-audio analysis: a master-proven pair becomes an ordinary preset", () => {
  it("proves the pair with ONE zero-redirect master request and advertises ordinary MP4 presets", async () => {
    const requests = network({ [MASTER_URL]: serve(MASTER) });
    const result = await analyzeGenericMediaInternal(PAGE, deps([AUDIO_ROW, videoRow()]));

    assert.deepEqual(requests, [MASTER_URL], "exactly the master: no media playlist, map or segment");
    assert.deepEqual(result.video.presets.map((p) => p.id), ["preset:best", "preset:1080"]);
    for (const preset of result.video.presets) assert.ok(hasClearHlsPublicPresetFacts(preset), preset.id);
    assert.deepEqual(result.selections, {});
    assert.deepEqual(result.hlsSelections, {});
    assert.deepEqual(JSON.parse(JSON.stringify(result.separateHlsSelections)), {
      "preset:best": { videoPlaylistUrl: VIDEO_URL, audioPlaylistUrl: AUDIO_URL, height: 1080 },
      "preset:1080": { videoPlaylistUrl: VIDEO_URL, audioPlaylistUrl: AUDIO_URL, height: 1080 },
    });
    assert.equal(result.video.capabilities.merge, false, "no public value reveals the HLS family");
    assert.deepEqual(result.video.sourceQuality, {
      observedMaxHeight: 1080,
      deliverableMaxHeight: 1080,
      withheld: [],
      protectedUnenumerated: false,
      maybeProtectedObserved: false,
    });

    const plan = deriveExecutionPlan({ strategy: "yt-dlp", ...result }, "preset:1080");
    assert.equal(plan.strategy === "yt-dlp" ? plan.generic.operation : null, "clear-hls-separate-audio-remux");
  });

  it("keeps every private and upstream value off the public result — and the browser path returns only it", async () => {
    network({ [MASTER_URL]: serve(MASTER) });
    const internal = await analyzeGenericMediaInternal(PAGE, deps([AUDIO_ROW, videoRow()]));
    network({ [MASTER_URL]: serve(MASTER) });
    const browser = await analyzeGenericMedia(PAGE, deps([AUDIO_ROW, videoRow()]));
    assert.deepEqual(browser, internal.video);
    const publicJson = JSON.stringify(browser);
    for (const needle of [
      TOKEN,
      "cdn.example.com",
      "master.m3u8",
      "1080.m3u8",
      "main.m3u8",
      GROUP,
      NAME,
      LANG,
      "EXT-X",
      "manifest",
      "playlistUrl",
      "separate",
      "clear-hls-separate-audio-remux",
    ]) {
      assert.equal(publicJson.includes(needle), false, needle);
    }
  });

  it("fills only a rung neither mature family fulfils, and lets preset:best follow the tallest rung", async () => {
    const requests = network({ [MASTER_URL]: serve(MASTER) });
    const progressive720 = { ...PROGRESSIVE_1080, format_id: "prog-720", width: 1280, height: 720 };
    const result = await analyzeGenericMediaInternal(PAGE, deps([progressive720, AUDIO_ROW, videoRow()]));
    assert.deepEqual(requests, [MASTER_URL]);
    assert.deepEqual(result.video.presets.filter((p) => p.hasVideo).map((p) => p.id), ["preset:best", "preset:1080", "preset:720"]);
    assert.deepEqual(Object.keys(result.separateHlsSelections).sort(), ["preset:1080", "preset:best"]);
    assert.ok(Object.hasOwn(result.selections, "preset:720"), "the progressive rung stays progressive");
  });

  it("never displaces muxed clear HLS: the muxed rung stays muxed and the pair fills the gap", async () => {
    const requests = network({ [MASTER_URL]: serve(MASTER) });
    const pair720 = videoRow({ url: `https://cdn.example.com/hls/video/720.m3u8?vtok=${TOKEN}`, width: 1280, height: 720 });
    const result = await analyzeGenericMediaInternal(PAGE, deps([MUXED_HLS_720, pair720, AUDIO_ROW, videoRow()]));
    assert.deepEqual(requests, [MASTER_URL], "only the 1080 candidate needed a proof; the muxed rung did not");
    assert.deepEqual(Object.keys(result.hlsSelections), ["preset:720"]);
    assert.deepEqual(Object.keys(result.separateHlsSelections).sort(), ["preset:1080", "preset:best"]);
  });
});

describe("separate-audio analysis: no master request unless a pair could fill a gap", () => {
  it("makes no request for a muxed-only HLS source", async () => {
    const requests = network({});
    const result = await analyzeGenericMediaInternal(PAGE, deps([MUXED_HLS_720]));
    assert.deepEqual(requests, []);
    assert.deepEqual(Object.keys(result.hlsSelections).sort(), ["preset:720", "preset:best"]);
    assert.deepEqual(result.separateHlsSelections, {});
  });

  it("makes no request when progressive already fulfils the candidate's rung", async () => {
    const requests = network({ [MASTER_URL]: serve(MASTER) });
    const result = await analyzeGenericMediaInternal(PAGE, deps([PROGRESSIVE_1080, AUDIO_ROW, videoRow()]));
    assert.deepEqual(requests, []);
    assert.deepEqual(result.separateHlsSelections, {});
    // The candidate is still accounted for exactly as before.
    assert.deepEqual(result.video.sourceQuality?.withheld, [{ reason: "unsupported_protocol", count: 1, maxObservedHeight: 1080 }]);
  });

  it("makes no request, and advertises nothing separate, without Worker FFmpeg", async () => {
    const requests = network({ [MASTER_URL]: serve(MASTER) });
    const result = await analyzeGenericMediaInternal(PAGE, deps([AUDIO_ROW, videoRow()], { ffmpegAvailable: false }));
    assert.deepEqual(requests, []);
    assert.deepEqual(result.separateHlsSelections, {});
    assert.deepEqual(result.video.presets, []);
  });

  it("admits only proven-video-only m3u8_native rows with a canonical unique URL and an accepted master", () => {
    const opts = { ffmpegAvailable: true, maxFileSizeBytes: 4 * 1024 ** 3 };
    const offered = (rows: unknown[]) => separateHlsProofCandidates(rows as never, opts).map((c) => c.index);
    assert.deepEqual(offered([videoRow()]), [0]);
    for (const [label, rows] of [
      ["audio unknown", [videoRow({ acodec: null })]],
      ["audio present", [videoRow({ acodec: "mp4a.40.2" })]],
      ["no video codec", [videoRow({ vcodec: null })]],
      ["video_ext none", [videoRow({ video_ext: "none" })]],
      ["protocol m3u8", [videoRow({ protocol: "m3u8" })]],
      ["protocol https", [videoRow({ protocol: "https" })]],
      ["non-canonical URL", [videoRow({ url: "https://CDN.example.com/hls/video/1080.m3u8" })]],
      ["relative URL", [videoRow({ url: "video/1080.m3u8" })]],
      ["duplicated URL", [videoRow(), videoRow({ format_id: "dup" })]],
      ["URL shared with any row", [videoRow(), { ...PROGRESSIVE_1080, url: VIDEO_URL }]],
      ["no manifest_url", [videoRow({ manifest_url: undefined })]],
      ["non-join-stable manifest_url", [videoRow({ manifest_url: "https://cdn.example.com/hls/../master.m3u8" })]],
      ["private manifest_url", [videoRow({ manifest_url: "https://10.0.0.1/master.m3u8" })]],
      ["height without width", [videoRow({ width: null })]],
      ["fractional height", [videoRow({ height: 1080.5 })]],
      ["known size over the limit", [videoRow({ filesize: 5 * 1024 ** 3 })]],
    ] as const) {
      assert.deepEqual(offered(rows as unknown as unknown[]), [], label);
    }
  });

  it("offers an unknown-height candidate only when the ladder would otherwise be empty", () => {
    const opts = { ffmpegAvailable: true, maxFileSizeBytes: 4 * 1024 ** 3 };
    const unknown = videoRow({ width: null, height: null });
    assert.deepEqual(separateHlsProofCandidates([unknown] as never, opts).map((c) => c.index), [0]);
    assert.deepEqual(separateHlsProofCandidates([PROGRESSIVE_1080, unknown] as never, opts), []);
  });
});

describe("separate-audio analysis: an unprovable pair is simply absent", () => {
  it("withholds a multi-rendition group as unsupported_protocol and keeps the analysis valid", async () => {
    const ambiguous = MASTER.replace(
      "#EXT-X-STREAM-INF",
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${GROUP}",NAME="alt",LANGUAGE="he",URI="audio/alt.m3u8"\n#EXT-X-STREAM-INF`,
    );
    const requests = network({ [MASTER_URL]: serve(ambiguous) });
    const result = await analyzeGenericMediaInternal(PAGE, deps([AUDIO_ROW, videoRow()]));
    assert.deepEqual(requests, [MASTER_URL]);
    assert.deepEqual(result.video.presets, []);
    assert.deepEqual(result.separateHlsSelections, {});
    assert.deepEqual(result.video.sourceQuality?.withheld, [{ reason: "unsupported_protocol", count: 1, maxObservedHeight: 1080 }]);
    assert.equal(result.video.sourceQuality?.deliverableMaxHeight, null);
  });

  it("refuses a redirected master and never requests the redirect target", async () => {
    const target = "https://cdn.example.com/elsewhere/master.m3u8";
    const requests = network({
      [MASTER_URL]: { status: 302, headers: { location: target } },
      [target]: serve(MASTER),
    });
    const result = await analyzeGenericMediaInternal(PAGE, deps([AUDIO_ROW, videoRow()]));
    assert.deepEqual(requests, [MASTER_URL]);
    assert.deepEqual(result.separateHlsSelections, {});
  });

  it("treats a master failure as absence, never as an analysis failure", async () => {
    for (const served of [{ status: 404 }, { status: 200, body: Readable.from([Buffer.from([0xff, 0xfe])]) }]) {
      network({ [MASTER_URL]: served });
      const result = await analyzeGenericMediaInternal(PAGE, deps([AUDIO_ROW, videoRow()]));
      assert.deepEqual(result.separateHlsSelections, {});
    }
  });

  it("fetches NOTHING when the gap candidates name more distinct masters than the cap", async () => {
    const rows = [1080, 720, 480, 360, 240].map((height, i) =>
      videoRow({
        width: Math.round((height * 16) / 9),
        height,
        url: `https://cdn.example.com/m${i}/v.m3u8`,
        manifest_url: `https://cdn.example.com/m${i}/master.m3u8`,
      }),
    );
    const requests = network({});
    const result = await analyzeGenericMediaInternal(PAGE, deps(rows));
    assert.deepEqual(requests, []);
    assert.deepEqual(result.separateHlsSelections, {});
  });

  it("fetches one master once for every candidate that names it", async () => {
    const requests = network({ [MASTER_URL]: serve(MASTER) });
    const pair720 = videoRow({ url: `https://cdn.example.com/hls/video/720.m3u8?vtok=${TOKEN}`, width: 1280, height: 720 });
    const result = await analyzeGenericMediaInternal(PAGE, deps([AUDIO_ROW, videoRow(), pair720]));
    assert.deepEqual(requests, [MASTER_URL]);
    assert.deepEqual(Object.keys(result.separateHlsSelections).sort(), ["preset:1080", "preset:720", "preset:best"]);
  });
});

describe("separate-audio analysis: the proof's budget, cancellation and integrity", () => {
  it("hands the proof only what is left of the ONE analysis deadline", async () => {
    let now = 1_000;
    let budget: number | null = null;
    await analyzeGenericMediaInternal(
      PAGE,
      deps([AUDIO_ROW, videoRow()], {
        clock: () => now,
        runner: async () => {
          now += 30_000;
          return { code: 0, stdout: JSON.stringify(document([AUDIO_ROW, videoRow()])), stderr: "" };
        },
        proveSeparateHlsPairs: async ({ timeoutMs }) => {
          budget = timeoutMs;
          return [];
        },
      }),
    );
    assert.equal(budget, 15_000);
  });

  it("starts no proof once the analysis budget is spent", async () => {
    let now = 0;
    let proofs = 0;
    await analyzeGenericMediaInternal(
      PAGE,
      deps([AUDIO_ROW, videoRow()], {
        clock: () => now,
        runner: async () => {
          now += 45_000;
          return { code: 0, stdout: JSON.stringify(document([AUDIO_ROW, videoRow()])), stderr: "" };
        },
        proveSeparateHlsPairs: async () => {
          proofs += 1;
          return [];
        },
      }),
    );
    assert.equal(proofs, 0);
  });

  it("stays a cancellation when the caller cancels during the proof", async () => {
    const controller = new AbortController();
    await assert.rejects(
      analyzeGenericMediaInternal(
        PAGE,
        deps([AUDIO_ROW, videoRow()], {
          signal: controller.signal,
          proveSeparateHlsPairs: async () => {
            controller.abort();
            return [];
          },
        }),
      ),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );
  });

  it("admits a proven pair ONLY for a candidate the plan offered, by index and URL", () => {
    const opts = { ffmpegAvailable: true, maxFileSizeBytes: 4 * 1024 ** 3 };
    const rows = [AUDIO_ROW, videoRow()];
    const [offered] = separateHlsProofCandidates(rows as never, opts) as SeparateHlsVideoCandidate[];
    const pair = (overrides: Partial<SeparateHlsProvenPair>): SeparateHlsProvenPair => ({
      videoPlaylistUrl: offered!.videoPlaylistUrl,
      audioPlaylistUrl: AUDIO_URL,
      height: offered!.height,
      index: offered!.index,
      ...overrides,
    });
    assert.deepEqual(Object.keys(analyzeGenericFormats(rows as never, opts, [pair({})]).separateHlsSelections).sort(), ["preset:1080", "preset:best"]);
    for (const forged of [pair({ index: 0 }), pair({ videoPlaylistUrl: "https://cdn.example.com/other.m3u8" }), pair({ height: 720 })]) {
      assert.deepEqual(analyzeGenericFormats(rows as never, opts, [forged]).separateHlsSelections, {});
    }
  });

  it("is network-free and unchanged when read synchronously without proven pairs", () => {
    const opts = { ffmpegAvailable: true, maxFileSizeBytes: 4 * 1024 ** 3 };
    const result = analyzeGenericFormats([AUDIO_ROW, videoRow(), PROGRESSIVE_1080] as never, opts);
    assert.deepEqual(result.separateHlsSelections, {});
    assert.deepEqual(result.build.presets.filter((p) => p.hasVideo).map((p) => p.id), ["preset:best", "preset:1080"]);
  });
});
