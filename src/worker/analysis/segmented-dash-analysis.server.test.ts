import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../lib/errors.ts";
import type { SourceQuality } from "../../shared/worker/contracts.ts";
import {
  GenericExecutionPlanSchema,
  deriveExecutionPlan,
  type GenericExecutionPlan,
} from "../execution/format-plan.ts";
import { buildGenericFormatSelector, type GenericSourceSelection } from "../execution/generic-source.ts";
import {
  analyzeGenericFormats,
  analyzeGenericMediaInternal,
  assertGenericPresetBuild,
  selectCandidates,
} from "./ytdlp-analysis.server.ts";

/**
 * GENERIC-SEGMENTED-DASH-EXECUTION-001 — analysis admission of segmented DASH.
 *
 * Every document here is shaped the way the pinned 2026.08.19 MPD parser shapes
 * a segmented Representation (`_parse_mpd_periods` + `_fill_sorting_fields`):
 * `protocol: "http_dash_segments"`, `container: "<ext>_dash"`, the other codec
 * set to exactly `"none"` by `parse_codecs`, `video_ext`/`audio_ext` filled from
 * `ext`, a manifest `url`, a `fragment_base_url` and a `fragments` list — none
 * of which the Worker's raw schema reads. `format_id` is `<mpd_id>-<@id>` when
 * the extractor names an mpd id.
 *
 * The analyzer is run through its REAL entry point with only the yt-dlp
 * subprocess faked.
 */

const SAFE_URL = "https://example.invalid/watch/dash";
const MAX = 4 * 1024 ** 3;
/** A needle that must never reach public metadata. */
const PRIVATE_MANIFEST = "https://media.example.invalid/dash/manifest.mpd?sig=DASH_PRIVATE_TOKEN";

type Row = Record<string, unknown>;

function dashVideo(id: string, height: number, over: Row = {}): Row {
  return {
    format_id: id,
    format_note: "DASH video",
    ext: "mp4",
    container: "mp4_dash",
    protocol: "http_dash_segments",
    height,
    width: Math.round((height * 16) / 9),
    fps: 30,
    vcodec: "avc1.640028",
    acodec: "none",
    video_ext: "mp4",
    audio_ext: "none",
    url: PRIVATE_MANIFEST,
    manifest_url: PRIVATE_MANIFEST,
    fragment_base_url: "https://media.example.invalid/dash/video/",
    fragments: [{ path: "init.mp4" }, { path: "seg-1.m4s", duration: 2 }, { path: "seg-2.m4s", duration: 2 }],
    is_dash_periods: true,
    ...over,
  };
}

function dashAudio(id: string, over: Row = {}): Row {
  return {
    format_id: id,
    format_note: "DASH audio",
    ext: "m4a",
    container: "m4a_dash",
    protocol: "http_dash_segments",
    vcodec: "none",
    acodec: "mp4a.40.2",
    video_ext: "none",
    audio_ext: "m4a",
    url: PRIVATE_MANIFEST,
    manifest_url: PRIVATE_MANIFEST,
    fragment_base_url: "https://media.example.invalid/dash/audio/",
    fragments: [{ path: "init.m4a" }, { path: "seg-1.m4s", duration: 2 }],
    is_dash_periods: true,
    ...over,
  };
}

function httpsVideoOnly(id: string, height: number, over: Row = {}): Row {
  return {
    format_id: id, ext: "mp4", protocol: "https", height, fps: 30, vcodec: "avc1.640028",
    acodec: "none", video_ext: "mp4", audio_ext: "none", filesize: 5_000_000, ...over,
  };
}

function httpsAudioOnly(id: string, over: Row = {}): Row {
  return {
    format_id: id, ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2",
    video_ext: "none", audio_ext: "m4a", filesize: 500_000, ...over,
  };
}

function httpsMuxed(id: string, height: number, over: Row = {}): Row {
  return {
    format_id: id, ext: "mp4", protocol: "https", height, fps: 30, vcodec: "avc1.640028",
    acodec: "mp4a.40.2", video_ext: "mp4", audio_ext: "none", filesize: 2_000_000, ...over,
  };
}

const doc = (formats: Row[]) => ({
  _type: "video",
  title: "Segmented DASH scenario",
  duration: 120,
  live_status: "not_live",
  formats,
});

async function analyze(formats: Row[], opts: { ffmpegAvailable?: boolean; maxFileSizeBytes?: number } = {}) {
  return analyzeGenericMediaInternal(SAFE_URL, {
    limits: {
      analysisTimeoutSeconds: 45,
      maxVideoDurationSeconds: 7200,
      maxFileSizeBytes: opts.maxFileSizeBytes ?? MAX,
    },
    ffmpegAvailable: opts.ffmpegAvailable ?? true,
    runner: async () => ({ code: 0, stdout: JSON.stringify(doc(formats)), stderr: "" }),
    probeRuntime: async () => ({ available: true, version: "2026.08.19", reason: "ok" as const }),
    validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
  });
}

function quality(video: { sourceQuality?: SourceQuality }): SourceQuality {
  assert.ok(video.sourceQuality);
  return video.sourceQuality;
}

function dispositions(formats: Row[], ffmpegAvailable = true, maxFileSizeBytes = MAX) {
  const { inventory } = analyzeGenericFormats(formats as never, { ffmpegAvailable, maxFileSizeBytes });
  return inventory.renditions.map((r) => [r.observed.height, r.observed.protocol, r.disposition]);
}

type Split = Extract<GenericExecutionPlan, { operation: "merge-split" }>;

// ─────────────────────────────────────────────────────────────────────────────

describe("segmented DASH: the representative 1080p split becomes deliverable", () => {
  const formats = [
    httpsMuxed("p360", 360),
    dashVideo("dash-v720", 720),
    dashVideo("dash-v1080", 1080),
    dashAudio("dash-a128"),
  ];

  it("observed 1080p DASH video + executable audio partner → preset:1080, deliverable 1080", async () => {
    const { video, selections, hlsSelections } = await analyze(formats);
    assert.deepEqual(hlsSelections, {});
    assert.deepEqual(
      video.presets.map((p) => [p.id, p.resolution, p.container, p.hasVideo, p.hasAudio]),
      [
        ["preset:best", "1080p", "mp4", true, true],
        ["preset:1080", "1080p", "mp4", true, true],
        ["preset:720", "720p", "mp4", true, true],
        ["preset:360", "360p", "mp4", true, true],
        // Audio products are progressive-only: the muxed 360 is extracted from.
        ["preset:audio", "audio", "m4a", false, true],
        ["preset:mp3", "audio", "mp3", false, true],
      ],
    );
    assert.equal(video.capabilities.merge, true);

    const q = quality(video);
    assert.equal(q.observedMaxHeight, 1080);
    assert.equal(q.deliverableMaxHeight, 1080);
    // The browser has nothing to say "higher source quality detected" about.
    assert.deepEqual(q.withheld, []);

    for (const id of ["preset:best", "preset:1080"]) {
      const value = selections[id];
      assert.equal(value?.kind, "split", id);
      if (value?.kind !== "split") continue;
      assert.equal(value.pair.video.formatId, "dash-v1080");
      assert.equal(value.pair.video.protocol, "http_dash_segments");
      assert.equal(value.pair.audio.formatId, "dash-a128");
      assert.equal(value.pair.audio.protocol, "http_dash_segments");
    }
    assert.equal(selections["preset:audio"]?.kind, "single");
    assert.equal(
      selections["preset:audio"]?.kind === "single" && selections["preset:audio"].source.protocol,
      "https",
    );
  });

  it("fresh execution derives a merge-split plan whose selectors bind the exact DASH protocol", async () => {
    const analysis = { strategy: "yt-dlp" as const, ...(await analyze(formats)) };
    const plan = deriveExecutionPlan(analysis, "preset:1080");
    assert.equal(plan.strategy, "yt-dlp");
    const generic = plan.strategy === "yt-dlp" ? plan.generic : null;
    assert.equal(generic?.operation, "merge-split");
    const split = generic as Split;
    assert.equal(split.targetContainer, "mp4");
    assert.equal(
      buildGenericFormatSelector(split.pair.video),
      'b*[format_id="dash-v1080"][protocol="http_dash_segments"][ext="mp4"][vcodec!="none"][acodec="none"]',
    );
    assert.equal(
      buildGenericFormatSelector(split.pair.audio),
      'b*[format_id="dash-a128"][protocol="http_dash_segments"][ext="m4a"][vcodec="none"][acodec!="none"]',
    );
  });

  it("a fresh analysis that no longer offers the preset is FORMAT_UNAVAILABLE, never a substitute", async () => {
    // The source changed between the browser's analysis and execution: the
    // 1080 DASH rendition is gone.
    const changed = { strategy: "yt-dlp" as const, ...(await analyze(formats.filter((f) => f.height !== 1080))) };
    assert.throws(
      () => deriveExecutionPlan(changed, "preset:1080"),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("keeps DASH provenance out of public metadata", async () => {
    const { video } = await analyze(formats);
    const text = JSON.stringify(video);
    for (const forbidden of ["dash-v1080", "dash-a128", "http_dash_segments", "DASH_PRIVATE_TOKEN", "media.example.invalid", "mp4_dash", "fragment"]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(video.formats, []);
  });
});

describe("segmented DASH: pairing across protocols", () => {
  it("DASH video + HTTPS audio pairs, and the HTTPS audio also backs preset:audio", async () => {
    const { video, selections } = await analyze([dashVideo("dash-v1080", 1080), httpsAudioOnly("a140")]);
    const pair = selections["preset:1080"];
    assert.equal(pair?.kind, "split");
    if (pair?.kind !== "split") return;
    assert.deepEqual([pair.pair.video.protocol, pair.pair.audio.protocol], ["http_dash_segments", "https"]);
    assert.deepEqual(video.presets.map((p) => p.id), ["preset:best", "preset:1080", "preset:audio", "preset:mp3"]);
    const audio = selections["preset:audio"];
    assert.equal(audio?.kind === "single" && audio.source.formatId, "a140");
  });

  it("HTTPS video + DASH audio pairs, but the DASH audio backs NO audio product", async () => {
    const { video, selections } = await analyze([httpsVideoOnly("v137", 1080), dashAudio("dash-a128")]);
    const pair = selections["preset:1080"];
    assert.equal(pair?.kind, "split");
    if (pair?.kind !== "split") return;
    assert.deepEqual([pair.pair.video.protocol, pair.pair.audio.protocol], ["https", "http_dash_segments"]);
    assert.deepEqual(video.presets.map((p) => p.id), ["preset:best", "preset:1080"]);
    assert.equal(video.capabilities.mp3, false);
  });

  it("a DASH-only document offers its video ladder and no audio product", async () => {
    const { video } = await analyze([dashVideo("dash-v1080", 1080), dashAudio("dash-a128")]);
    assert.deepEqual(video.presets.map((p) => p.id), ["preset:best", "preset:1080"]);
    assert.deepEqual(video.capabilities, { mp3: false, merge: true });
  });
});

describe("segmented DASH: every ordinary gate still applies, and reports its own reason", () => {
  const progressive = httpsMuxed("p720", 720);

  it("unsafe format id → unsafe_selector_identity", async () => {
    const formats = [progressive, dashVideo("dash-video=5000000", 1080), dashAudio("dash-a128")];
    assert.deepEqual(dispositions(formats), [
      [720, "progressive", "deliverable"],
      [1080, "dash-segmented", "unsafe-format-id"],
    ]);
    const { video } = await analyze(formats);
    assert.deepEqual(quality(video).withheld, [
      { reason: "unsafe_selector_identity", count: 1, maxObservedHeight: 1080 },
    ]);
  });

  it("container outside the allowlist → unsupported_container", () => {
    assert.deepEqual(dispositions([progressive, dashVideo("dash-ts", 1080, { ext: "ts", video_ext: "ts" })]), [
      [720, "progressive", "deliverable"],
      [1080, "dash-segmented", "container-not-allowed"],
    ]);
  });

  it("known size over the limit → size_limit_exceeded (per format and per pair)", () => {
    const over = dispositions(
      [progressive, dashVideo("dash-v1080", 1080, { filesize: 2000 }), dashAudio("dash-a128", { filesize: 10 })],
      true,
      1000,
    );
    assert.deepEqual(over[1], [1080, "dash-segmented", "size-over-limit"]);
    const pairOver = dispositions(
      [progressive, dashVideo("dash-v1080", 1080, { filesize: 900 }), dashAudio("dash-a128", { filesize: 200 })],
      true,
      1000,
    );
    assert.deepEqual(pairOver[1], [1080, "dash-segmented", "pair-size"]);
  });

  it("video with no audio partner at all → audio_pair_unavailable", async () => {
    const formats = [dashVideo("dash-v1080", 1080)];
    assert.deepEqual(dispositions(formats), [[1080, "dash-segmented", "no-audio"]]);
    const { video } = await analyze(formats);
    assert.deepEqual(video.presets, []);
    assert.deepEqual(quality(video).withheld, [
      { reason: "audio_pair_unavailable", count: 1, maxObservedHeight: 1080 },
    ]);
  });

  it("incompatible container pair (webm video, only m4a audio) → no pair", () => {
    const formats = [
      progressive,
      dashVideo("dash-vp9", 1080, { ext: "webm", video_ext: "webm", container: "webm_dash", vcodec: "vp9" }),
      dashAudio("dash-a128"),
    ];
    assert.deepEqual(dispositions(formats)[1], [1080, "dash-segmented", "no-partner"]);
  });

  it("Worker FFmpeg unavailable → no DASH pair (split_pair_unsupported), and DASH never becomes a single", async () => {
    const formats = [progressive, dashVideo("dash-v1080", 1080), dashAudio("dash-a128")];
    const { video, selections } = await analyze(formats, { ffmpegAvailable: false });
    assert.deepEqual(video.presets.map((p) => p.id), ["preset:best", "preset:720"]);
    assert.equal(JSON.stringify(selections).includes("dash-"), false);
    assert.deepEqual(quality(video).withheld, [
      { reason: "split_pair_unsupported", count: 1, maxObservedHeight: 1080 },
    ]);
  });

  it("a MUXED segmented rendition stays unsupported_protocol (not a split half)", async () => {
    const formats = [progressive, dashVideo("dash-muxed", 1080, { acodec: "mp4a.40.2" }), dashAudio("dash-a128")];
    assert.deepEqual(dispositions(formats)[1], [1080, "dash-segmented", "segmented-not-split-half"]);
    const { video, selections } = await analyze(formats);
    assert.equal(JSON.stringify(selections).includes("dash-muxed"), false);
    assert.deepEqual(quality(video).withheld, [
      { reason: "unsupported_protocol", count: 1, maxObservedHeight: 1080 },
    ]);
  });

  it("a segmented video whose audio is UNKNOWN stays unsupported_protocol, even with no proven tier", async () => {
    const formats = [dashVideo("dash-unknown", 1080, { acodec: null })];
    assert.deepEqual(dispositions(formats), [[1080, "dash-segmented", "segmented-not-split-half"]]);
    const { video } = await analyze(formats);
    assert.deepEqual(video.presets, [], "the unknown-audio fallback tier is progressive-only");
  });

  it("unadmitted DASH spellings stay unsupported_protocol", () => {
    for (const protocol of ["http_dash_segments_generator", "dash", "http_dash_segments+https"]) {
      assert.deepEqual(
        dispositions([progressive, dashVideo("dash-x", 1080, { protocol })])[1],
        [1080, protocol === "http_dash_segments_generator" ? "dash-segmented" : "other", "protocol-unsupported"],
        protocol,
      );
    }
  });

  it("a live DASH document is refused whole, before any format is judged", async () => {
    await assert.rejects(
      analyzeGenericMediaInternal(SAFE_URL, {
        limits: { analysisTimeoutSeconds: 45, maxVideoDurationSeconds: 7200, maxFileSizeBytes: MAX },
        ffmpegAvailable: true,
        runner: async () => ({
          code: 0,
          stdout: JSON.stringify({ ...doc([dashVideo("dash-v1080", 1080), dashAudio("dash-a128")]), live_status: "is_live" }),
          stderr: "",
        }),
        probeRuntime: async () => ({ available: true, version: "2026.08.19", reason: "ok" as const }),
        validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      }),
      (err: unknown) => err instanceof AppError,
    );
  });
});

describe("segmented DASH: ranking adds no protocol preference", () => {
  it("equal media facts: the EXISTING upstream-order tie-break decides, in both orders", () => {
    const dash = dashVideo("dash-v1080", 1080, { filesize: 5_000_000 });
    const https = httpsVideoOnly("v1080", 1080, { filesize: 5_000_000 });
    const audio = httpsAudioOnly("a140");
    const winner = (formats: Row[]) => {
      const { build } = analyzeGenericFormats(formats as never, { ffmpegAvailable: true, maxFileSizeBytes: MAX });
      const value = build.selections["preset:1080"];
      return value?.kind === "split" ? value.pair.video.formatId : null;
    };
    assert.equal(winner([dash, https, audio]), "dash-v1080");
    assert.equal(winner([https, dash, audio]), "v1080");
  });

  it("a real media fact still decides before protocol could: a larger known size wins either way", () => {
    const dash = dashVideo("dash-v1080", 1080, { filesize: 9_000_000 });
    const https = httpsVideoOnly("v1080", 1080, { filesize: 5_000_000 });
    const { build } = analyzeGenericFormats([https, dash, httpsAudioOnly("a140")] as never, {
      ffmpegAvailable: true,
      maxFileSizeBytes: MAX,
    });
    const value = build.selections["preset:1080"];
    assert.equal(value?.kind === "split" && value.pair.video.formatId, "dash-v1080");
  });
});

describe("segmented DASH: single-source fulfilment is unrepresentable", () => {
  const dashAudioSelection: GenericSourceSelection = {
    formatId: "dash-a128",
    protocol: "http_dash_segments",
    container: "m4a",
    hasVideo: false,
    hasAudio: true,
    videoConstraint: "absent",
    audioConstraint: "codec-present",
    fileSize: null,
  };

  // `extract-m4a` needs a MUXED source, and a muxed DASH selection is already
  // unrepresentable one layer down (`generic-source.test.ts`).
  it("the plan schema refuses keep-original and extract-mp3 on a DASH audio half", () => {
    const plans = [
      { operation: "keep-original", requestedFormatId: "preset:audio", targetContainer: "m4a" },
      { operation: "extract-mp3", requestedFormatId: "preset:mp3", targetContainer: "mp3" },
    ];
    for (const plan of plans) {
      const parsed = GenericExecutionPlanSchema.safeParse({
        strategy: "yt-dlp",
        ...plan,
        source: dashAudioSelection,
      });
      assert.equal(parsed.success, false, plan.operation);
      assert.ok(parsed.error!.issues.some((i) => i.path.join(".") === "source.protocol"), plan.operation);
      // Control: the same plan on an HTTPS source is valid.
      assert.equal(
        GenericExecutionPlanSchema.safeParse({
          strategy: "yt-dlp",
          ...plan,
          source: { ...dashAudioSelection, protocol: "https" },
        }).success,
        true,
        `${plan.operation} control`,
      );
    }
  });

  it("the analyzer's own structural assertion refuses a single DASH selection", () => {
    const candidates = selectCandidates([dashAudio("dash-a128")] as never, { maxFileSizeBytes: MAX });
    assert.equal(candidates.length, 1, "the audio half itself is an admitted candidate");
    assert.throws(
      () =>
        assertGenericPresetBuild(
          {
            presets: [
              {
                id: "preset:audio", label: "Audio only", resolution: "audio", container: "m4a", fileSize: null,
                hasVideo: false, hasAudio: true, formatId: "preset:audio", videoCodec: null, audioCodec: "aac", fps: null,
              },
            ],
            selections: { "preset:audio": { kind: "single", source: dashAudioSelection } },
          },
          { candidates, ffmpegAvailable: true, maxFileSizeBytes: MAX },
        ),
      (err: unknown) => err instanceof AppError && err.code === "EXTRACTION_FAILED",
    );
  });
});
