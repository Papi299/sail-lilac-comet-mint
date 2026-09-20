import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@/lib/errors";
import {
  VideoMetadataSchema,
  WORKER_REQUESTED_FORMAT_IDS,
  type WorkerVideoMetadata,
} from "@/shared/worker/contracts";
import {
  DIRECT_KEEP_CONTAINERS,
  deriveDirectExecutionPlan,
  deriveExecutionPlan,
  deriveGenericExecutionPlan,
  executionPlanRequestedFormatId,
  executionPlanRequiresProcessing,
  executionPlanTargetContainer,
  planRequiresProcessing,
  GENERIC_SPLIT_VIDEO_PRESET_IDS,
  GenericExecutionPlanSchema,
  type GenericExecutionPlan,
} from "./format-plan.ts";
import { buildGenericPresets, selectCandidates } from "../analysis/ytdlp-analysis.server.ts";
import {
  buildGenericFormatSelector,
  type GenericPresetSource,
  type GenericSourceSelection,
} from "./generic-source.ts";

/** Wraps one approved source as the SINGLE-source per-preset value (SPLIT-01). */
function single(source: GenericSourceSelection): GenericPresetSource {
  return { kind: "single", source };
}

/**
 * Asserts a derived generic plan names exactly ONE source, and returns it.
 *
 * SPLIT-01 added a `merge-split` variant that carries a `pair` instead of a
 * `source`. Nothing builds one yet, so every plan these cases derive must still
 * be a single-source operation — asserting it keeps each case proving what it
 * always proved, and fails loudly if derivation ever starts producing a merge.
 *
 * HLS-6 added a `clear-hls-remux` variant whose `source` is a private media
 * PLAYLIST rather than a yt-dlp selection. Ordinary derivation must never
 * produce one — that is the HLS-6 dormancy invariant — so it is refused here on
 * exactly the same terms, and every case below keeps proving what it proved.
 */
function planSource(plan: GenericExecutionPlan): GenericSourceSelection {
  assert.notEqual(plan.operation, "merge-split", "this plan must name exactly one source");
  assert.notEqual(
    plan.operation,
    "clear-hls-remux",
    "ordinary generic derivation must never produce a clear-HLS plan",
  );
  if (plan.operation === "merge-split" || plan.operation === "clear-hls-remux") {
    throw new Error("unreachable");
  }
  return plan.source;
}

type FormatSpec = {
  id?: string;
  container: string;
  hasVideo: boolean;
  hasAudio?: boolean;
};

type PresetSpec = {
  id: string;
  container: string;
  hasVideo: boolean;
  hasAudio?: boolean;
  formatId?: string;
};

/**
 * Builds metadata through the SAME strict runtime schema the executor validates
 * analysis output with, so no test can assert against a shape the Worker would
 * never actually see.
 */
function buildMeta(original: FormatSpec, presets: PresetSpec[] = []): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "clip",
    thumbnail: null,
    duration: null,
    source: "example.com",
    extractor: "direct",
    webpageUrl: "https://example.com/clip",
    formats: [
      {
        id: original.id ?? "direct-original",
        resolution: original.hasVideo ? "unknown" : "audio",
        width: null,
        height: null,
        fps: null,
        container: original.container,
        videoCodec: original.hasVideo ? "unknown" : null,
        audioCodec: "unknown",
        bitrate: null,
        fileSize: null,
        hasVideo: original.hasVideo,
        hasAudio: original.hasAudio ?? true,
        formatNote: null,
      },
    ],
    presets: presets.map((p) => ({
      id: p.id,
      label: p.id,
      resolution: p.hasVideo ? "unknown" : "audio",
      container: p.container,
      fileSize: null,
      hasVideo: p.hasVideo,
      hasAudio: p.hasAudio ?? true,
      formatId: p.formatId ?? p.id,
      videoCodec: p.hasVideo ? "unknown" : null,
      audioCodec: "unknown",
      fps: null,
    })),
    capabilities: { mp3: true, merge: true },
  });
}

function assertFormatUnavailable(fn: () => unknown, label: string) {
  assert.throws(
    fn,
    (err: unknown) => {
      assert.ok(err instanceof AppError, `${label}: expected AppError`);
      assert.equal(err.code, "FORMAT_UNAVAILABLE", label);
      return true;
    },
    label,
  );
}

describe("direct execution plan derivation", () => {
  it("direct-original: keeps the original, no processing", () => {
    const meta = buildMeta({ container: "mp4", hasVideo: true });
    const plan = deriveDirectExecutionPlan(meta, "direct-original");
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "mp4");
    assert.equal(planRequiresProcessing(plan), false);
  });

  it("direct-original: keeps a non-mp4 source container verbatim", () => {
    const meta = buildMeta({ container: "mkv", hasVideo: true });
    const plan = deriveDirectExecutionPlan(meta, "direct-original");
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "mkv");
  });

  it("preset:best advertising the source container: keep, no FFmpeg", () => {
    const meta = buildMeta({ container: "mp4", hasVideo: true }, [
      { id: "preset:best", container: "mp4", hasVideo: true },
    ]);
    const plan = deriveDirectExecutionPlan(meta, "preset:best");
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "mp4");
    assert.equal(planRequiresProcessing(plan), false);
  });

  it("preset:best advertising mp4 over a different source: convert to mp4", () => {
    const meta = buildMeta({ container: "mkv", hasVideo: true }, [
      { id: "preset:best", container: "mp4", hasVideo: true },
    ]);
    const plan = deriveDirectExecutionPlan(meta, "preset:best");
    assert.equal(plan.operation, "convert");
    assert.equal(plan.targetContainer, "mp4");
    assert.equal(planRequiresProcessing(plan), true);
  });

  it("preset:best legitimately advertising webm: convert to webm", () => {
    const meta = buildMeta({ container: "mkv", hasVideo: true }, [
      { id: "preset:best", container: "webm", hasVideo: true },
    ]);
    const plan = deriveDirectExecutionPlan(meta, "preset:best");
    assert.equal(plan.operation, "convert");
    assert.equal(plan.targetContainer, "webm");
  });

  it("preset:best over an audio-only source is unavailable", () => {
    const meta = buildMeta({ container: "mp3", hasVideo: false }, [
      { id: "preset:best", container: "mp4", hasVideo: true },
    ]);
    assertFormatUnavailable(
      () => deriveDirectExecutionPlan(meta, "preset:best"),
      "video preset over audio source",
    );
  });

  it("preset:audio over a video source: extracts m4a", () => {
    const meta = buildMeta({ container: "mp4", hasVideo: true }, [
      { id: "preset:audio", container: "m4a", hasVideo: false },
    ]);
    const plan = deriveDirectExecutionPlan(meta, "preset:audio");
    assert.equal(plan.operation, "extract-m4a");
    assert.equal(plan.targetContainer, "m4a");
    assert.equal(planRequiresProcessing(plan), true);
  });

  it("preset:audio over an already-audio source advertised as the source: keeps original", () => {
    const meta = buildMeta({ container: "mp3", hasVideo: false }, [
      { id: "preset:audio", container: "mp3", hasVideo: false },
    ]);
    const plan = deriveDirectExecutionPlan(meta, "preset:audio");
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "mp3");
    assert.equal(planRequiresProcessing(plan), false);
  });

  it("preset:audio over an already-audio wav source keeps wav, never forces m4a", () => {
    const meta = buildMeta({ container: "wav", hasVideo: false }, [
      { id: "preset:audio", container: "wav", hasVideo: false },
    ]);
    const plan = deriveDirectExecutionPlan(meta, "preset:audio");
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "wav");
  });

  it("preset:audio over an already-audio source advertised as m4a is unavailable", () => {
    // The advertised container does not equal what keeping the original would
    // produce, and the source needs no extraction: there is no honest plan.
    const meta = buildMeta({ container: "mp3", hasVideo: false }, [
      { id: "preset:audio", container: "m4a", hasVideo: false },
    ]);
    assertFormatUnavailable(
      () => deriveDirectExecutionPlan(meta, "preset:audio"),
      "audio source advertised as m4a",
    );
  });

  it("preset:audio advertising hasVideo is unavailable", () => {
    const meta = buildMeta({ container: "mp4", hasVideo: true }, [
      { id: "preset:audio", container: "m4a", hasVideo: true },
    ]);
    assertFormatUnavailable(
      () => deriveDirectExecutionPlan(meta, "preset:audio"),
      "audio preset advertising video",
    );
  });

  it("preset:mp3: extracts mp3", () => {
    const meta = buildMeta({ container: "mp4", hasVideo: true }, [
      { id: "preset:mp3", container: "mp3", hasVideo: false },
    ]);
    const plan = deriveDirectExecutionPlan(meta, "preset:mp3");
    assert.equal(plan.operation, "extract-mp3");
    assert.equal(plan.targetContainer, "mp3");
    assert.equal(planRequiresProcessing(plan), true);
  });

  it("preset:mp3 advertising a non-mp3 container is unavailable", () => {
    const meta = buildMeta({ container: "mp4", hasVideo: true }, [
      { id: "preset:mp3", container: "m4a", hasVideo: false },
    ]);
    assertFormatUnavailable(
      () => deriveDirectExecutionPlan(meta, "preset:mp3"),
      "mp3 preset advertising m4a",
    );
  });

  it("unknown format id is unavailable, with no fallback", () => {
    const meta = buildMeta({ container: "mp4", hasVideo: true }, [
      { id: "preset:best", container: "mp4", hasVideo: true },
    ]);
    for (const id of ["preset:nope", "definitely-not-a-format", "direct-originals", ""]) {
      assertFormatUnavailable(
        () => deriveDirectExecutionPlan(meta, id),
        `unknown format ${JSON.stringify(id)}`,
      );
    }
  });

  it("path-traversal shaped selections are unavailable", () => {
    const meta = buildMeta({ container: "mp4", hasVideo: true }, [
      { id: "preset:best", container: "mp4", hasVideo: true },
    ]);
    for (const id of ["../../evil", "preset:../../evil", "/etc/passwd", "preset:best/../x"]) {
      assertFormatUnavailable(
        () => deriveDirectExecutionPlan(meta, id),
        `traversal ${JSON.stringify(id)}`,
      );
    }
  });

  it("a preset whose formatId does not match its id is not an exact selection", () => {
    const meta = buildMeta({ container: "mkv", hasVideo: true }, [
      { id: "preset:best", container: "mp4", hasVideo: true, formatId: "preset:something-else" },
    ]);
    assertFormatUnavailable(
      () => deriveDirectExecutionPlan(meta, "preset:best"),
      "preset id/formatId mismatch",
    );
  });

  it("unsupported advertised containers are unavailable", () => {
    for (const container of ["exe", "sh", "iso", "unknown", ""]) {
      const meta = buildMeta({ container: "mkv", hasVideo: true }, [
        { id: "preset:best", container, hasVideo: true },
      ]);
      assertFormatUnavailable(
        () => deriveDirectExecutionPlan(meta, "preset:best"),
        `unsupported advertised container ${JSON.stringify(container)}`,
      );
    }
  });

  it("unsupported SOURCE containers are unavailable", () => {
    const meta = buildMeta({ container: "exe", hasVideo: true }, [
      { id: "preset:best", container: "mp4", hasVideo: true },
    ]);
    assertFormatUnavailable(
      () => deriveDirectExecutionPlan(meta, "preset:best"),
      "unsupported source container",
    );
    assertFormatUnavailable(
      () => deriveDirectExecutionPlan(meta, "direct-original"),
      "unsupported source container, original",
    );
  });

  it("metadata missing the direct-original format is unavailable", () => {
    const meta = buildMeta({ id: "something-else", container: "mp4", hasVideo: true });
    assertFormatUnavailable(
      () => deriveDirectExecutionPlan(meta, "something-else"),
      "no direct-original anchor",
    );
  });

  it("arbitrary advertised container strings never become FFmpeg targets or paths", () => {
    const hostile = [
      "../../evil",
      "mp4; rm -rf /",
      "mp4 -i /etc/passwd",
      "/absolute/mp4",
      "mp4\\..\\..\\evil",
      "MP4",
      "mp4 ",
      "-y",
      "$(id)",
      "%00mp4",
    ];
    for (const container of hostile) {
      const meta = buildMeta({ container: "mkv", hasVideo: true }, [
        { id: "preset:best", container, hasVideo: true },
      ]);
      assertFormatUnavailable(
        () => deriveDirectExecutionPlan(meta, "preset:best"),
        `hostile container ${JSON.stringify(container)}`,
      );
    }
  });

  it("every derivable plan target belongs to the closed allowlist", () => {
    const allowed = new Set<string>(DIRECT_KEEP_CONTAINERS);
    const convertible = new Set(["mp4", "webm"]);

    for (const source of DIRECT_KEEP_CONTAINERS) {
      const meta = buildMeta({ container: source, hasVideo: true }, [
        { id: "preset:best", container: source, hasVideo: true },
      ]);
      const plan = deriveDirectExecutionPlan(meta, "preset:best");
      assert.ok(allowed.has(plan.targetContainer), `keep target ${plan.targetContainer}`);

      for (const target of convertible) {
        if (target === source) continue;
        const convertMeta = buildMeta({ container: source, hasVideo: true }, [
          { id: "preset:best", container: target, hasVideo: true },
        ]);
        const convertPlan = deriveDirectExecutionPlan(convertMeta, "preset:best");
        assert.equal(convertPlan.operation, "convert");
        assert.ok(convertible.has(convertPlan.targetContainer));
      }
    }
  });

  it("the plan's expected stream flags match the advertised selection", () => {
    const videoMeta = buildMeta({ container: "mkv", hasVideo: true }, [
      { id: "preset:best", container: "mp4", hasVideo: true, hasAudio: true },
    ]);
    const videoPlan = deriveDirectExecutionPlan(videoMeta, "preset:best");
    assert.equal(videoPlan.expectHasVideo, true);
    assert.equal(videoPlan.expectHasAudio, true);

    const audioMeta = buildMeta({ container: "mp4", hasVideo: true }, [
      { id: "preset:audio", container: "m4a", hasVideo: false, hasAudio: true },
    ]);
    const audioPlan = deriveDirectExecutionPlan(audioMeta, "preset:audio");
    assert.equal(audioPlan.expectHasVideo, false);
    assert.equal(audioPlan.expectHasAudio, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC EXECUTION PLANS — Phase 10C3 §18/§19/§37/§38
// ─────────────────────────────────────────────────────────────────────────────

describe("generic execution plan (§18)", () => {
  const MUXED_MP4 = {
    formatId: "22",
    protocol: "https" as const,
    container: "mp4" as const,
    hasVideo: true,
    hasAudio: true,
    videoConstraint: "codec-present" as const,
    audioConstraint: "codec-present" as const,
    fileSize: 1000,
  };
  const AUDIO_M4A = {
    formatId: "140",
    protocol: "https" as const,
    container: "m4a" as const,
    hasVideo: false,
    hasAudio: true,
    videoConstraint: "absent" as const,
    audioConstraint: "codec-present" as const,
    fileSize: 500,
  };

  function meta(presets: Array<{ id: string; container: string; hasVideo: boolean; hasAudio?: boolean }>) {
    return VideoMetadataSchema.parse({
      title: "generic",
      thumbnail: null,
      duration: 100,
      source: "example.invalid",
      extractor: "yt-dlp",
      webpageUrl: "https://example.invalid/x",
      formats: [],
      presets: presets.map((p) => ({
        id: p.id,
        label: p.id,
        resolution: p.hasVideo ? "1080p" : "audio",
        container: p.container,
        fileSize: null,
        hasVideo: p.hasVideo,
        hasAudio: p.hasAudio ?? true,
        formatId: p.id,
        videoCodec: p.hasVideo ? "h264" : null,
        audioCodec: (p.hasAudio ?? true) ? "aac" : null,
        fps: null,
      })),
      capabilities: { mp3: true, merge: false },
    });
  }

  it("generic VIDEO keeps the single muxed source verbatim (§37)", () => {
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
      { "preset:1080": single(MUXED_MP4) },
      "preset:1080",
    );
    assert.equal(plan.strategy, "yt-dlp");
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "mp4");
    assert.equal(planSource(plan).formatId, "22");
    assert.equal(planSource(plan).protocol, "https");
    assert.equal(planSource(plan).hasVideo, true);
    assert.equal(planSource(plan).hasAudio, true);
  });

  it("keeps a webm source as webm rather than remuxing it", () => {
    const src = { ...MUXED_MP4, container: "webm" as const, formatId: "248" };
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:best", container: "webm", hasVideo: true }]),
      { "preset:best": single(src) },
      "preset:best",
    );
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "webm");
  });

  it("preset:audio KEEPS a real audio-only source (§38)", () => {
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:audio", container: "m4a", hasVideo: false }]),
      { "preset:audio": single(AUDIO_M4A) },
      "preset:audio",
    );
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "m4a");
    assert.equal(planSource(plan).hasVideo, false);
  });

  it("preset:audio EXTRACTS m4a from a muxed source (§38)", () => {
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:audio", container: "m4a", hasVideo: false }]),
      { "preset:audio": single(MUXED_MP4) },
      "preset:audio",
    );
    assert.equal(plan.operation, "extract-m4a");
    assert.equal(plan.targetContainer, "m4a");
    // The SOURCE stays the muxed original: yt-dlp downloads it whole and the
    // Worker's own FFmpeg extracts audio after processing begins.
    assert.equal(planSource(plan).container, "mp4");
    assert.equal(planSource(plan).hasVideo, true);
  });

  it("preset:mp3 is always a Worker transcode (§38)", () => {
    for (const source of [MUXED_MP4, AUDIO_M4A]) {
      const plan = deriveGenericExecutionPlan(
        meta([{ id: "preset:mp3", container: "mp3", hasVideo: false }]),
        { "preset:mp3": single(source) },
        "preset:mp3",
      );
      assert.equal(plan.operation, "extract-mp3");
      assert.equal(plan.targetContainer, "mp3");
      assert.equal(planSource(plan).container, source.container);
    }
  });

  it("FORMAT_UNAVAILABLE when the preset is not advertised", () => {
    assert.throws(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
          { "preset:1080": single(MUXED_MP4) },
          "preset:2160",
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("FORMAT_UNAVAILABLE when a preset carries no private selection", () => {
    // Advertised but unacquirable is worse than absent, so it is refused.
    assert.throws(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
          {},
          "preset:1080",
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("FORMAT_UNAVAILABLE when the selection fails its own validation", () => {
    for (const bad of [
      { ...MUXED_MP4, formatId: "bv+ba" },
      { ...MUXED_MP4, protocol: "m3u8_native" },
      { ...MUXED_MP4, container: "mkv" },
    ]) {
      assert.throws(
        () =>
          deriveGenericExecutionPlan(
            meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
            { "preset:1080": bad as never },
            "preset:1080",
          ),
        (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
      );
    }
  });

  it("FORMAT_UNAVAILABLE when the advertised container would not equal the produced one", () => {
    // The preset promises webm; the source is mp4 and generic v1 never remuxes.
    assert.throws(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "webm", hasVideo: true }]),
          { "preset:1080": single(MUXED_MP4) },
          "preset:1080",
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("refuses a video preset backed by a split (video-only) source", () => {
    assert.throws(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
          {
            "preset:1080": single({
              ...MUXED_MP4,
              hasAudio: false,
              audioConstraint: "absent" as const,
            }),
          },
          "preset:1080",
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("refuses every preset that CLAIMS audio when its source audio is only UNKNOWN", () => {
    // GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001: the private selection
    // describes unknown audio honestly, and no preset that claims audio may be
    // executed from it. GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001
    // leaves this exactly as it was: every preset below claims audio
    // (`hasAudio: true`), so each is still refused. Only a VIDEO preset claiming
    // NO audio may use such a source — pinned in the suite at the end of this
    // file. Each case carries a positive control, so the refusal is attributable
    // to the audio state.
    const unknownAudio = { ...MUXED_MP4, hasAudio: false, audioConstraint: "unknown" as const };
    for (const [id, container, hasVideo] of [
      ["preset:1080", "mp4", true],
      ["preset:audio", "m4a", false],
      ["preset:mp3", "mp3", false],
    ] as const) {
      const presets = meta([{ id, container, hasVideo }]);
      assert.doesNotThrow(
        () => deriveGenericExecutionPlan(presets, { [id]: single(MUXED_MP4) }, id),
        `${id}: the same preset IS executable from proven audio`,
      );
      assert.throws(
        () => deriveGenericExecutionPlan(presets, { [id]: single(unknownAudio) }, id),
        (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
        `${id}: unknown audio must not become executable`,
      );
    }
  });

  it("refuses a concrete (non-preset) id: generic advertises no formats", () => {
    assert.throws(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
          { "preset:1080": single(MUXED_MP4) },
          "direct-original",
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("refuses anything outside the closed request vocabulary", () => {
    for (const id of ["22", "best", "preset:9999", "", "bv+ba"]) {
      assert.throws(
        () =>
          deriveGenericExecutionPlan(
            meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
            { "preset:1080": single(MUXED_MP4) },
            id,
          ),
        (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
      );
    }
  });
});

describe("strategy-aware plan wrapper (§19)", () => {
  it("routes a direct analysis to the untouched direct planner", () => {
    const meta = VideoMetadataSchema.parse({
      title: "direct",
      thumbnail: null,
      duration: null,
      source: "cdn.example",
      extractor: "direct",
      webpageUrl: "https://cdn.example/a.mp4",
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
          fileSize: 10,
          hasVideo: true,
          hasAudio: true,
          formatNote: null,
        },
      ],
      presets: [],
      capabilities: { mp3: false, merge: false },
    });

    const plan = deriveExecutionPlan(
      { strategy: "direct", video: meta, selections: {} },
      "direct-original",
    );
    assert.equal(plan.strategy, "direct");
    assert.equal(executionPlanTargetContainer(plan), "mp4");
    assert.equal(executionPlanRequestedFormatId(plan), "direct-original");
    assert.equal(executionPlanRequiresProcessing(plan), false);
    // No generic concept leaks into the direct plan.
    assert.equal("source" in plan.direct, false);
  });

  it("rejects an out-of-vocabulary id before either planner runs", () => {
    assert.throws(
      () =>
        deriveExecutionPlan(
          { strategy: "direct", video: {} as never, selections: {} },
          "bv+ba",
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT-01: the `merge-split` execution plan
//
// NOT REACHABLE from analysis — nothing builds a split preset source yet, and
// the last case in this block proves that end to end. These cases pin the plan
// shape and its refusals now, so the representation can be reviewed before any
// producer exists.
// ─────────────────────────────────────────────────────────────────────────────

describe("generic SPLIT execution plan (SPLIT-01)", () => {
  const VIDEO_MP4: GenericSourceSelection = {
    formatId: "137",
    protocol: "https",
    container: "mp4",
    hasVideo: true,
    hasAudio: false,
    videoConstraint: "codec-present",
    audioConstraint: "absent",
    fileSize: 9_000_000,
  };
  const AUDIO_M4A_ONLY: GenericSourceSelection = {
    formatId: "140",
    protocol: "https",
    container: "m4a",
    hasVideo: false,
    hasAudio: true,
    videoConstraint: "absent",
    audioConstraint: "codec-present",
    fileSize: 500_000,
  };
  const VIDEO_WEBM: GenericSourceSelection = { ...VIDEO_MP4, formatId: "248", container: "webm" };
  const AUDIO_WEBM: GenericSourceSelection = {
    ...AUDIO_M4A_ONLY,
    formatId: "251",
    container: "webm",
  };

  const splitSource = (
    video: GenericSourceSelection = VIDEO_MP4,
    audio: GenericSourceSelection = AUDIO_M4A_ONLY,
  ): GenericPresetSource => ({ kind: "split", pair: { video, audio } });

  function meta(presets: Array<{ id: string; container: string; hasVideo: boolean; hasAudio?: boolean }>) {
    return VideoMetadataSchema.parse({
      title: "generic",
      thumbnail: null,
      duration: 100,
      source: "example.invalid",
      extractor: "yt-dlp",
      webpageUrl: "https://example.invalid/x",
      formats: [],
      presets: presets.map((p) => ({
        id: p.id,
        label: p.id,
        resolution: p.hasVideo ? "1080p" : "audio",
        container: p.container,
        fileSize: null,
        hasVideo: p.hasVideo,
        hasAudio: p.hasAudio ?? true,
        formatId: p.id,
        videoCodec: p.hasVideo ? "h264" : null,
        audioCodec: "aac",
        fps: null,
      })),
      capabilities: { mp3: true, merge: false },
    });
  }

  it("derives a merge-split plan whose target comes from the closed table", () => {
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
      { "preset:1080": splitSource() },
      "preset:1080",
    );
    assert.equal(plan.strategy, "yt-dlp");
    assert.equal(plan.operation, "merge-split");
    assert.equal(plan.targetContainer, "mp4");
    if (plan.operation !== "merge-split") throw new Error("unreachable");
    assert.equal(plan.pair.video.formatId, "137");
    assert.equal(plan.pair.audio.formatId, "140");
    // The plan carries a PAIR and no single `source`, so nothing downstream can
    // mistake half of it for a complete acquisition.
    assert.equal("source" in plan, false);
  });

  it("derives the webm pair to a webm target", () => {
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:best", container: "webm", hasVideo: true }]),
      { "preset:best": splitSource(VIDEO_WEBM, AUDIO_WEBM) },
      "preset:best",
    );
    assert.equal(plan.operation, "merge-split");
    assert.equal(plan.targetContainer, "webm");
  });

  it("a merge-split plan REQUIRES local processing", () => {
    const plan = deriveExecutionPlan(
      {
        strategy: "yt-dlp",
        video: meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
        selections: { "preset:1080": splitSource() },
      },
      "preset:1080",
    );
    assert.equal(executionPlanRequiresProcessing(plan), true);
    assert.equal(executionPlanTargetContainer(plan), "mp4");
    assert.equal(executionPlanRequestedFormatId(plan), "preset:1080");
  });

  it("FORMAT_UNAVAILABLE when the advertised container would not equal the merged one", () => {
    // The preset promises webm; the mp4 pair would deliver mp4. The advertised
    // preset must equal the produced artifact, so this is a refusal rather than
    // a silent substitution.
    assert.throws(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "webm", hasVideo: true }]),
          { "preset:1080": splitSource() },
          "preset:1080",
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("FORMAT_UNAVAILABLE for an AUDIO preset backed by a pair", () => {
    // `preset:audio` and `preset:mp3` are single-source products. A merge is
    // only ever how a VIDEO preset gets its audio.
    for (const [id, container] of [
      ["preset:audio", "m4a"],
      ["preset:mp3", "mp3"],
    ] as const) {
      assert.throws(
        () =>
          deriveGenericExecutionPlan(
            meta([{ id, container, hasVideo: false }]),
            { [id]: splitSource() },
            id,
          ),
        (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
        id,
      );
    }
  });

  it("FORMAT_UNAVAILABLE when the advertised preset does not claim both streams", () => {
    assert.throws(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "mp4", hasVideo: false }]),
          { "preset:1080": splitSource() },
          "preset:1080",
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("FORMAT_UNAVAILABLE for every malformed pair", () => {
    const cases: Array<[string, unknown]> = [
      ["missing the audio half", { kind: "split", pair: { video: VIDEO_MP4 } }],
      ["missing the video half", { kind: "split", pair: { audio: AUDIO_M4A_ONLY } }],
      [
        "unknown audio masquerading as the audio half",
        splitSourceRaw(VIDEO_MP4, {
          ...AUDIO_M4A_ONLY,
          audioConstraint: "unknown",
          hasAudio: false,
        }),
      ],
      [
        "a muxed source used as the video half",
        splitSourceRaw(
          { ...VIDEO_MP4, audioConstraint: "codec-present", hasAudio: true },
          AUDIO_M4A_ONLY,
        ),
      ],
      ["a cross-family pair", splitSourceRaw(VIDEO_MP4, AUDIO_WEBM)],
      ["both halves naming one id", splitSourceRaw(VIDEO_MP4, { ...AUDIO_M4A_ONLY, formatId: "137" })],
      ["an unsafe raw id", splitSourceRaw({ ...VIDEO_MP4, formatId: "137[ext=mp4]" }, AUDIO_M4A_ONLY)],
    ];

    for (const [label, bad] of cases) {
      assert.throws(
        () =>
          deriveGenericExecutionPlan(
            meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
            { "preset:1080": bad as never },
            "preset:1080",
          ),
        (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
        label,
      );
    }
  });

  function splitSourceRaw(video: unknown, audio: unknown): unknown {
    return { kind: "split", pair: { video, audio } };
  }

  it("the plan SCHEMA refuses a hand-built plan whose target contradicts the table", () => {
    // Built directly, bypassing derivation: the invariant belongs to the plan,
    // not to whoever happened to construct it.
    assert.equal(
      GenericExecutionPlanSchema.safeParse({
        strategy: "yt-dlp",
        operation: "merge-split",
        requestedFormatId: "preset:1080",
        pair: { video: VIDEO_MP4, audio: AUDIO_M4A_ONLY },
        targetContainer: "webm",
      }).success,
      false,
    );
    assert.equal(
      GenericExecutionPlanSchema.safeParse({
        strategy: "yt-dlp",
        operation: "merge-split",
        requestedFormatId: "preset:1080",
        pair: { video: VIDEO_MP4, audio: AUDIO_M4A_ONLY },
        targetContainer: "mp4",
      }).success,
      true,
    );
  });

  // ── CORRECTION-01: the plan schema's OWN requested-format vocabulary ──────
  //
  // The review found that `merge-split` used `WorkerRequestedFormatIdSchema`
  // and subtracted only the two audio presets by refinement, leaving
  // `direct-original` representable. These cases pin the vocabulary
  // POSITIVELY and exhaustively, over the full public request vocabulary, so
  // a future widening cannot reintroduce a non-video member unnoticed.

  const splitPlan = (requestedFormatId: string) => ({
    strategy: "yt-dlp",
    operation: "merge-split",
    requestedFormatId,
    pair: { video: VIDEO_MP4, audio: AUDIO_M4A_ONLY },
    targetContainer: "mp4",
  });

  it("the plan SCHEMA accepts EVERY intended video preset", () => {
    for (const id of GENERIC_SPLIT_VIDEO_PRESET_IDS) {
      assert.equal(
        GenericExecutionPlanSchema.safeParse(splitPlan(id)).success,
        true,
        `${id} must be a valid split-merge target`,
      );
    }
    // The vocabulary is the product's video ladder, in full.
    assert.deepEqual([...GENERIC_SPLIT_VIDEO_PRESET_IDS], [
      "preset:best",
      "preset:2160",
      "preset:1440",
      "preset:1080",
      "preset:720",
      "preset:480",
      "preset:360",
      "preset:240",
      "preset:144",
    ]);
  });

  it("the plan SCHEMA refuses EVERY non-video member of the public request vocabulary", () => {
    // Exhaustive over `WORKER_REQUESTED_FORMAT_IDS`, not a hand-listed few, so
    // a new non-video member added to the public vocabulary is covered the day
    // it appears. `direct-original` is the case the review caught.
    const nonVideo = WORKER_REQUESTED_FORMAT_IDS.filter(
      (id) => !(GENERIC_SPLIT_VIDEO_PRESET_IDS as readonly string[]).includes(id),
    );
    assert.deepEqual(nonVideo, ["direct-original", "preset:audio", "preset:mp3"]);

    for (const id of nonVideo) {
      assert.equal(
        GenericExecutionPlanSchema.safeParse(splitPlan(id)).success,
        false,
        `${id} must never be fulfillable by a split merge`,
      );
    }
  });

  it("the ACCEPTED set equals the closed vocabulary exactly, with nothing else representable", () => {
    // One assertion that fails in BOTH directions: a widening that admits a
    // non-video id, and a narrowing that drops a real rung.
    const accepted = WORKER_REQUESTED_FORMAT_IDS.filter(
      (id) => GenericExecutionPlanSchema.safeParse(splitPlan(id)).success,
    );
    assert.deepEqual(accepted, [...GENERIC_SPLIT_VIDEO_PRESET_IDS]);

    // ...and nothing outside the public vocabulary at all.
    for (const junk of ["preset:9999", "", "bv+ba", "22", "best", "preset:"]) {
      assert.equal(GenericExecutionPlanSchema.safeParse(splitPlan(junk)).success, false, junk);
    }
  });

  /**
   * SPLIT-05 §36: the POSITIVE integration gate that replaces SPLIT-01's
   * "analysis builds NO pair" hard gate.
   *
   * SPLIT-01..04 built the representation, the acquisition and the merge while
   * nothing could construct a pair, so `merge-split` was structurally
   * unreachable and a test asserted exactly that. SPLIT-05 makes the real
   * analyzer build pairs, so the assertion is INVERTED rather than deleted: the
   * pair must now come from `buildGenericPresets`, never from this file, and
   * derivation must turn it into the exact plan the accepted executor consumes.
   */
  describe("SPLIT-05: the real analyzer reaches merge-split", () => {
    const MAX = 500 * 1024 * 1024;

    /** A ladder whose best rendition exists ONLY as a pair. */
    const RAW = [
      // muxed 720p — the best SINGLE-source rendition on offer
      { format_id: "22", ext: "mp4", protocol: "https", vcodec: "avc1.64001F", acodec: "mp4a.40.2", height: 720 },
      // video-only 1080p mp4 + audio-only m4a — the approved pair
      { format_id: "137", ext: "mp4", protocol: "https", vcodec: "avc1.640028", acodec: "none", height: 1080 },
      { format_id: "140", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
      // unknown-audio HTML5 shape: never a pair half, whatever else is present
      { format_id: "0", ext: "mp4", protocol: "https", vcodec: null, video_ext: "mp4", audio_ext: "none" },
    ];

    /**
     * Runs the REAL analysis half and wraps its output in the same strict
     * metadata schema the executor validates against. The pair is whatever the
     * analyzer built; nothing here constructs or repairs one.
     */
    function analyzed(ffmpegAvailable: boolean) {
      const { presets, selections } = buildGenericPresets(
        selectCandidates(RAW, { maxFileSizeBytes: MAX }),
        { ffmpegAvailable, maxFileSizeBytes: MAX },
      );
      const meta = VideoMetadataSchema.parse({
        title: "clip",
        thumbnail: null,
        duration: null,
        source: "example.invalid",
        extractor: "yt-dlp",
        webpageUrl: "https://example.invalid/watch",
        formats: [],
        presets,
        capabilities: {
          mp3: presets.some((p) => p.id === "preset:mp3"),
          merge:
            ffmpegAvailable && Object.values(selections).some((v) => v.kind === "split"),
        },
      });
      return { meta, selections, presets };
    }

    it("derives merge-split for an application-owned preset the ANALYZER paired", () => {
      const { meta, selections } = analyzed(true);

      // The analyzer really did build a pair, and it is bound to an ORDINARY
      // video preset id — not a new split-specific one.
      const source = selections["preset:1080"];
      assert.ok(source, "the 1080p rendition must be advertised");
      assert.equal(source.kind, "split", "and it must be fulfilled by a pair");
      if (source.kind !== "split") throw new Error("unreachable");

      const plan = deriveGenericExecutionPlan(meta, selections, "preset:1080");
      assert.equal(plan.strategy, "yt-dlp");
      assert.equal(plan.operation, "merge-split");
      if (plan.operation !== "merge-split") throw new Error("unreachable");
      // The requested id is the SAME application-owned preset the browser would
      // submit. No raw selector grammar enters it.
      assert.equal(plan.requestedFormatId, "preset:1080");
      // The EXACT validated pair the analyzer built, not a rebuilt one.
      assert.deepEqual(plan.pair, source.pair);
      // The target comes from the closed container table.
      assert.equal(plan.targetContainer, "mp4");
      // ...and it agrees with what the browser was shown.
      assert.equal(meta.presets.find((p) => p.id === "preset:1080")?.container, "mp4");
    });

    it("preset:best takes the higher SPLIT rendition over the lower muxed one", () => {
      const { meta, selections } = analyzed(true);
      assert.equal(meta.presets.find((p) => p.id === "preset:best")?.resolution, "1080p");

      const plan = deriveGenericExecutionPlan(meta, selections, "preset:best");
      assert.equal(plan.operation, "merge-split");

      // ...while the 720p rung is still the ordinary single-source plan.
      const rung = deriveGenericExecutionPlan(meta, selections, "preset:720");
      assert.equal(rung.operation, "keep-original");
      assert.equal(executionPlanRequestedFormatId({ strategy: "yt-dlp", generic: rung }), "preset:720");
    });

    it("without Worker FFmpeg the same document derives no merge at all", () => {
      const { meta, selections } = analyzed(false);
      for (const value of Object.values(selections)) {
        assert.equal(value.kind, "single", "a pair needs the Worker's own FFmpeg");
      }
      assert.equal(meta.capabilities.merge, false);
      // The muxed 720p rendition is still the best on offer, exactly as before.
      assert.equal(meta.presets.find((p) => p.id === "preset:best")?.resolution, "720p");
      assert.equal(
        deriveGenericExecutionPlan(meta, selections, "preset:best").operation,
        "keep-original",
      );
    });

    it("§71: a WebM pair derives to a WEBM target, not an MP4 one", () => {
      // MP4 assumptions must not become universal. Same path, other family.
      const webm = [
        { format_id: "248", ext: "webm", protocol: "https", vcodec: "vp09.00.40.08", acodec: "none", height: 1080 },
        { format_id: "251", ext: "webm", protocol: "https", vcodec: "none", acodec: "opus" },
      ];
      const { presets, selections } = buildGenericPresets(
        selectCandidates(webm, { maxFileSizeBytes: MAX }),
        { ffmpegAvailable: true, maxFileSizeBytes: MAX },
      );
      const meta = VideoMetadataSchema.parse({
        title: "clip", thumbnail: null, duration: null, source: "example.invalid",
        extractor: "yt-dlp", webpageUrl: "https://example.invalid/watch",
        formats: [], presets,
        capabilities: { mp3: presets.some((p) => p.id === "preset:mp3"), merge: true },
      });

      assert.equal(meta.presets.find((p) => p.id === "preset:1080")?.container, "webm");
      const plan = deriveGenericExecutionPlan(meta, selections, "preset:1080");
      assert.equal(plan.operation, "merge-split");
      if (plan.operation !== "merge-split") throw new Error("unreachable");
      assert.equal(plan.targetContainer, "webm");
      assert.equal(plan.pair.video.formatId, "248");
      assert.equal(plan.pair.audio.formatId, "251");
    });

    it("§72: a realistic mixed ladder splits the high rungs and keeps the muxed one", () => {
      // 1440 video-only + 1080 video-only + 720 muxed + one m4a partner: the
      // exact product behaviour SPLIT-05 exists to deliver.
      const ladder = [
        { format_id: "1440v", ext: "mp4", protocol: "https", vcodec: "avc1.640032", acodec: "none", height: 1440 },
        { format_id: "1080v", ext: "mp4", protocol: "https", vcodec: "avc1.640028", acodec: "none", height: 1080 },
        { format_id: "720m", ext: "mp4", protocol: "https", vcodec: "avc1.64001F", acodec: "mp4a.40.2", height: 720 },
        { format_id: "aud", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
      ];
      const { presets, selections } = buildGenericPresets(
        selectCandidates(ladder, { maxFileSizeBytes: MAX }),
        { ffmpegAvailable: true, maxFileSizeBytes: MAX },
      );
      const meta = VideoMetadataSchema.parse({
        title: "clip", thumbnail: null, duration: null, source: "example.invalid",
        extractor: "yt-dlp", webpageUrl: "https://example.invalid/watch",
        formats: [], presets,
        capabilities: { mp3: presets.some((p) => p.id === "preset:mp3"), merge: true },
      });

      assert.equal(meta.presets.find((p) => p.id === "preset:best")?.resolution, "1440p");

      const expected: Array<[string, string, string | null]> = [
        ["preset:best", "merge-split", "1440v"],
        ["preset:1440", "merge-split", "1440v"],
        ["preset:1080", "merge-split", "1080v"],
        ["preset:720", "keep-original", null],
      ];
      for (const [id, operation, videoId] of expected) {
        const plan = deriveGenericExecutionPlan(meta, selections, id);
        assert.equal(plan.operation, operation, id);
        if (plan.operation === "merge-split") {
          assert.equal(plan.pair.video.formatId, videoId, id);
          // ONE fixed family partner across every split rung.
          assert.equal(plan.pair.audio.formatId, "aud", id);
          assert.equal(plan.targetContainer, "mp4", id);
        } else if (plan.operation === "clear-hls-remux") {
          assert.fail(`${id}: ordinary derivation must never produce a clear-HLS plan`);
        } else {
          assert.equal(plan.source.formatId, "720m", id);
        }
      }
    });

    it("§73: a same-rung muxed source is preferred, and derives an ordinary plan", () => {
      const sameRung = [
        { format_id: "1080m", ext: "mp4", protocol: "https", vcodec: "avc1.640028", acodec: "mp4a.40.2", height: 1080 },
        { format_id: "1080v", ext: "mp4", protocol: "https", vcodec: "avc1.640028", acodec: "none", height: 1080 },
        { format_id: "aud", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2" },
      ];
      const { presets, selections } = buildGenericPresets(
        selectCandidates(sameRung, { maxFileSizeBytes: MAX }),
        { ffmpegAvailable: true, maxFileSizeBytes: MAX },
      );
      const meta = VideoMetadataSchema.parse({
        title: "clip", thumbnail: null, duration: null, source: "example.invalid",
        extractor: "yt-dlp", webpageUrl: "https://example.invalid/watch",
        formats: [], presets,
        // The pair is POSSIBLE but never selected, so the capability is false.
        capabilities: {
          mp3: presets.some((p) => p.id === "preset:mp3"),
          merge: Object.values(selections).some((v) => v.kind === "split"),
        },
      });

      assert.equal(meta.capabilities.merge, false);
      for (const id of ["preset:best", "preset:1080"]) {
        const plan = deriveGenericExecutionPlan(meta, selections, id);
        // `assert.equal` from node:assert/strict narrows the union for us.
        assert.equal(plan.operation, "keep-original", id);
        assert.equal(plan.source.formatId, "1080m", id);
      }
      // No duplicate rung was created by the unused pair.
      assert.deepEqual(
        meta.presets.map((p) => p.id),
        ["preset:best", "preset:1080", "preset:audio", "preset:mp3"],
      );
    });

    it("the pair the analyzer built carries two DIFFERENT private ids, and neither is public", () => {
      const { meta, selections } = analyzed(true);
      const source = selections["preset:1080"];
      assert.ok(source && source.kind === "split");
      if (!source || source.kind !== "split") throw new Error("unreachable");
      assert.equal(source.pair.video.formatId, "137");
      assert.equal(source.pair.audio.formatId, "140");
      assert.notEqual(source.pair.video.formatId, source.pair.audio.formatId);

      // Neither raw id may appear anywhere in the browser-facing document.
      const serialized = JSON.stringify(meta);
      assert.equal(serialized.includes('"137"'), false);
      assert.equal(serialized.includes('"140"'), false);
      for (const preset of meta.presets) {
        assert.equal(preset.id, preset.formatId);
        assert.match(preset.id, /^preset:/);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001
//
// A single progressive source whose video is established and whose audio is
// UNKNOWN may back an ordinary VIDEO preset that claims NO audio, as
// `keep-original`. The private `audioConstraint` is the authority; the public
// boolean must agree with it exactly, and `false` alone never distinguishes
// "not proven" from "proven absent".
// ─────────────────────────────────────────────────────────────────────────────

describe("generic plan: unknown-audio single-source video (GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001)", () => {
  const MAX = 500 * 1024 * 1024;

  /** The X-shaped progressive source: video established by shape, audio unknown. */
  const UNKNOWN_MP4: GenericSourceSelection = {
    formatId: "synthetic-prog-high",
    protocol: "https",
    container: "mp4",
    hasVideo: true,
    hasAudio: false,
    videoConstraint: "video-ext",
    audioConstraint: "unknown",
    fileSize: 2_400_000,
  };
  /** The same unknown audio on a source whose video codec IS named. */
  const UNKNOWN_CODEC_VIDEO: GenericSourceSelection = {
    ...UNKNOWN_MP4,
    formatId: "unknown-codec",
    videoConstraint: "codec-present",
  };
  const UNKNOWN_WEBM: GenericSourceSelection = {
    ...UNKNOWN_MP4,
    formatId: "unknown-webm",
    container: "webm",
  };
  const PROVEN_MP4: GenericSourceSelection = {
    ...UNKNOWN_MP4,
    formatId: "proven",
    hasAudio: true,
    videoConstraint: "codec-present",
    audioConstraint: "codec-present",
  };
  /** Proven video-only: a split pair's video half, never an ordinary single. */
  const ABSENT_MP4: GenericSourceSelection = {
    ...PROVEN_MP4,
    formatId: "video-only",
    hasAudio: false,
    audioConstraint: "absent",
  };
  const AUDIO_M4A: GenericSourceSelection = {
    formatId: "audio-only",
    protocol: "https",
    container: "m4a",
    hasVideo: false,
    hasAudio: true,
    videoConstraint: "absent",
    audioConstraint: "codec-present",
    fileSize: 500,
  };

  type Spec = { id: string; container: string; hasVideo: boolean; hasAudio: boolean };

  function meta(presets: Spec[]) {
    return VideoMetadataSchema.parse({
      title: "generic",
      thumbnail: null,
      duration: 100,
      source: "example.invalid",
      extractor: "yt-dlp",
      webpageUrl: "https://example.invalid/x",
      formats: [],
      presets: presets.map((p) => ({
        id: p.id,
        label: p.id,
        resolution: p.hasVideo ? "360p" : "audio",
        container: p.container,
        fileSize: null,
        hasVideo: p.hasVideo,
        hasAudio: p.hasAudio,
        formatId: p.id,
        videoCodec: null,
        audioCodec: p.hasAudio ? "aac" : null,
        fps: null,
      })),
      capabilities: { mp3: false, merge: false },
    });
  }

  const refused = (fn: () => unknown, label: string) =>
    assert.throws(
      fn,
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
      label,
    );

  // ── Accept ─────────────────────────────────────────────────────────────────

  it("ACCEPTS: unknown source + video preset claiming no audio + same container -> keep-original", () => {
    for (const source of [UNKNOWN_MP4, UNKNOWN_CODEC_VIDEO, UNKNOWN_WEBM]) {
      for (const id of GENERIC_SPLIT_VIDEO_PRESET_IDS) {
        const plan = deriveGenericExecutionPlan(
          meta([{ id, container: source.container, hasVideo: true, hasAudio: false }]),
          { [id]: single(source) },
          id,
        );
        assert.equal(plan.strategy, "yt-dlp");
        assert.equal(plan.operation, "keep-original", `${source.formatId} ${id}`);
        assert.equal(plan.requestedFormatId, id);
        assert.equal(plan.targetContainer, source.container, "the original container, verbatim");
        // The EXACT private source, unknown audio and all — never rewritten.
        assert.deepEqual(planSource(plan), source);
        assert.equal(
          executionPlanRequiresProcessing({ strategy: "yt-dlp", generic: plan }),
          false,
          "no processing, remux, transcode or probe",
        );
      }
    }
  });

  it("the proven single-source video plan is unchanged", () => {
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:720", container: "mp4", hasVideo: true, hasAudio: true }]),
      { "preset:720": single(PROVEN_MP4) },
      "preset:720",
    );
    assert.deepEqual(plan, {
      strategy: "yt-dlp",
      operation: "keep-original",
      requestedFormatId: "preset:720",
      source: PROVEN_MP4,
      targetContainer: "mp4",
    });
  });

  // ── Refuse ─────────────────────────────────────────────────────────────────

  it("REFUSES: unknown source behind a video preset that claims audio", () => {
    refused(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:360", container: "mp4", hasVideo: true, hasAudio: true }]),
          { "preset:360": single(UNKNOWN_MP4) },
          "preset:360",
        ),
      "unknown audio may never be delivered as a preset that promises audio",
    );
  });

  it("REFUSES: proven source behind a video preset that claims no audio", () => {
    refused(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:360", container: "mp4", hasVideo: true, hasAudio: false }]),
          { "preset:360": single(PROVEN_MP4) },
          "preset:360",
        ),
      "the public claim must equal the private proof in this direction too",
    );
  });

  it("REFUSES: an explicit ABSENT-audio source as an ordinary single video, whatever the preset says", () => {
    // `hasAudio: false` is shared by UNKNOWN and ABSENT. Only the private
    // constraint tells them apart, and only UNKNOWN is inside this capability.
    assert.equal(ABSENT_MP4.hasAudio, UNKNOWN_MP4.hasAudio);
    for (const hasAudio of [false, true]) {
      refused(
        () =>
          deriveGenericExecutionPlan(
            meta([{ id: "preset:360", container: "mp4", hasVideo: true, hasAudio }]),
            { "preset:360": single(ABSENT_MP4) },
            "preset:360",
          ),
        `absent single, preset hasAudio=${hasAudio}`,
      );
    }
  });

  it("REFUSES: an unknown source for preset:audio and preset:mp3, whatever the preset says", () => {
    for (const [id, container] of [["preset:audio", "m4a"], ["preset:mp3", "mp3"]] as const) {
      // Positive control: the same audio product IS executable from proven audio.
      assert.doesNotThrow(() =>
        deriveGenericExecutionPlan(
          meta([{ id, container, hasVideo: false, hasAudio: true }]),
          { [id]: single(PROVEN_MP4) },
          id,
        ),
      );
      for (const hasAudio of [true, false]) {
        refused(
          () =>
            deriveGenericExecutionPlan(
              meta([{ id, container, hasVideo: false, hasAudio }]),
              { [id]: single(UNKNOWN_MP4) },
              id,
            ),
          `${id} from unknown audio, preset hasAudio=${hasAudio}`,
        );
      }
    }
  });

  it("REFUSES: a split pair behind a video preset that claims no audio", () => {
    const pair: GenericPresetSource = {
      kind: "split",
      pair: { video: ABSENT_MP4, audio: AUDIO_M4A },
    };
    assert.equal(
      deriveGenericExecutionPlan(
        meta([{ id: "preset:1080", container: "mp4", hasVideo: true, hasAudio: true }]),
        { "preset:1080": pair },
        "preset:1080",
      ).operation,
      "merge-split",
      "positive control",
    );
    refused(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "mp4", hasVideo: true, hasAudio: false }]),
          { "preset:1080": pair },
          "preset:1080",
        ),
      "a pair always delivers audio, so a preset denying it is refused",
    );
  });

  it("REFUSES: public/private hasVideo disagreement and a target/source container mismatch", () => {
    refused(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:360", container: "mp4", hasVideo: false, hasAudio: false }]),
          { "preset:360": single(UNKNOWN_MP4) },
          "preset:360",
        ),
      "a video id whose preset claims no video",
    );
    refused(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:360", container: "webm", hasVideo: true, hasAudio: false }]),
          { "preset:360": single(UNKNOWN_MP4) },
          "preset:360",
        ),
      "generic v1 never remuxes, so the containers must agree",
    );
  });

  // ── The plan SCHEMA represents only valid operations ─────────────────────────

  const keepPlan = (requestedFormatId: string, source: GenericSourceSelection, targetContainer: string = source.container) => ({
    strategy: "yt-dlp",
    operation: "keep-original",
    requestedFormatId,
    source,
    targetContainer,
  });

  it("schema: a keep-original VIDEO plan admits proven or unknown audio, never absent", () => {
    for (const id of GENERIC_SPLIT_VIDEO_PRESET_IDS) {
      assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan(id, PROVEN_MP4)).success, true, id);
      assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan(id, UNKNOWN_MP4)).success, true, id);
      assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan(id, UNKNOWN_WEBM)).success, true, id);
      assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan(id, ABSENT_MP4)).success, false, id);
      assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan(id, AUDIO_M4A)).success, false, `${id}: audio-only`);
    }
  });

  it("schema: keep-original must deliver exactly the source container", () => {
    assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan("preset:360", UNKNOWN_MP4, "webm")).success, false);
    assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan("preset:360", PROVEN_MP4, "webm")).success, false);
    assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan("preset:audio", AUDIO_M4A, "mp3")).success, false);
  });

  it("schema: a keep-original preset:audio plan keeps only a PROVEN audio-only source", () => {
    assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan("preset:audio", AUDIO_M4A)).success, true);
    for (const source of [PROVEN_MP4, UNKNOWN_MP4, ABSENT_MP4]) {
      assert.equal(
        GenericExecutionPlanSchema.safeParse(keepPlan("preset:audio", source)).success,
        false,
        source.formatId,
      );
    }
  });

  it("schema: extract-m4a and extract-mp3 require PROVEN audio", () => {
    const extract = (operation: "extract-m4a" | "extract-mp3", source: GenericSourceSelection) => ({
      strategy: "yt-dlp",
      operation,
      requestedFormatId: operation === "extract-m4a" ? "preset:audio" : "preset:mp3",
      source,
      targetContainer: operation === "extract-m4a" ? "m4a" : "mp3",
    });
    for (const operation of ["extract-m4a", "extract-mp3"] as const) {
      assert.equal(GenericExecutionPlanSchema.safeParse(extract(operation, PROVEN_MP4)).success, true, operation);
      assert.equal(GenericExecutionPlanSchema.safeParse(extract(operation, UNKNOWN_MP4)).success, false, operation);
      assert.equal(GenericExecutionPlanSchema.safeParse(extract(operation, ABSENT_MP4)).success, false, operation);
    }
    assert.equal(GenericExecutionPlanSchema.safeParse(extract("extract-mp3", AUDIO_M4A)).success, true);
  });

  it("schema: the keep-original vocabulary is EXACTLY the video ladder plus preset:audio", () => {
    // Exhaustive over the public request vocabulary, in both directions.
    // `direct-original` (refused by derivation) and `preset:mp3` (always an
    // extraction) are unrepresentable rather than merely unbuilt.
    const acceptedWithVideo = WORKER_REQUESTED_FORMAT_IDS.filter(
      (id) => GenericExecutionPlanSchema.safeParse(keepPlan(id, UNKNOWN_MP4)).success,
    );
    assert.deepEqual(acceptedWithVideo, [...GENERIC_SPLIT_VIDEO_PRESET_IDS]);
    const acceptedWithAudio = WORKER_REQUESTED_FORMAT_IDS.filter(
      (id) => GenericExecutionPlanSchema.safeParse(keepPlan(id, AUDIO_M4A)).success,
    );
    assert.deepEqual(acceptedWithAudio, ["preset:audio"]);
    for (const junk of ["direct-original", "preset:mp3", "preset:9999", "", "bv+ba", "22"]) {
      assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan(junk, UNKNOWN_MP4)).success, false, junk);
      assert.equal(GenericExecutionPlanSchema.safeParse(keepPlan(junk, PROVEN_MP4)).success, false, junk);
    }
  });

  // ── The REAL analyzer reaches it, and fresh re-analysis stays authoritative ──

  const FIXTURE = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "analysis", "testdata", "synthetic-x-progressive-unknown-audio.json"),
      "utf8",
    ),
  ) as { formats: Array<Record<string, unknown>> };

  /** Runs the real analysis half and wraps it in the strict metadata schema. */
  function analyzed(formats: Array<Record<string, unknown>>, ffmpegAvailable: boolean) {
    const { presets, selections } = buildGenericPresets(
      selectCandidates(formats, { maxFileSizeBytes: MAX }),
      { ffmpegAvailable, maxFileSizeBytes: MAX },
    );
    const meta = VideoMetadataSchema.parse({
      title: "clip",
      thumbnail: null,
      duration: null,
      source: "example.invalid",
      extractor: "yt-dlp",
      webpageUrl: "https://example.invalid/watch",
      formats: [],
      presets,
      capabilities: {
        mp3: presets.some((p) => p.id === "preset:mp3"),
        merge: ffmpegAvailable && Object.values(selections).some((v) => v.kind === "split"),
      },
    });
    return { meta, selections };
  }

  /** The fixture with its progressive formats' audio state rewritten. */
  function drifted(acodec: string, extra: Array<Record<string, unknown>> = []) {
    return [
      ...FIXTURE.formats.map((f) =>
        f.protocol === "https" ? { ...f, acodec } : f,
      ),
      ...extra,
    ];
  }

  it("the synthetic X-shaped document derives keep-original for every video preset, and no audio product", () => {
    for (const ffmpegAvailable of [false, true]) {
      const { meta, selections } = analyzed(FIXTURE.formats, ffmpegAvailable);
      assert.deepEqual(meta.presets.map((p) => p.id), ["preset:best", "preset:360", "preset:240"]);
      for (const preset of meta.presets) {
        const plan = deriveGenericExecutionPlan(meta, selections, preset.id);
        assert.equal(plan.operation, "keep-original", preset.id);
        assert.equal(planSource(plan).audioConstraint, "unknown", preset.id);
        assert.equal(planSource(plan).protocol, "https", preset.id);
        assert.match(
          buildGenericFormatSelector(planSource(plan)),
          /\[acodec!=\?"none"\]$/,
          `${preset.id}: the unknown selector form`,
        );
      }
      for (const id of ["preset:audio", "preset:mp3"]) {
        refused(() => deriveGenericExecutionPlan(meta, selections, id), `${id} is not advertised`);
      }
    }
  });

  it("re-analysis UNKNOWN -> PRESENT: the same preset now plans from the PROVEN source, with the strict selector", () => {
    const browserEra = analyzed(FIXTURE.formats, true);
    assert.equal(browserEra.meta.presets.find((p) => p.id === "preset:360")?.hasAudio, false);

    // Only the FRESH execution analysis is consulted; nothing browser-era is.
    const fresh = analyzed(drifted("mp4a.40.2"), true);
    const preset = fresh.meta.presets.find((p) => p.id === "preset:360");
    assert.ok(preset, "the requested preset still exists");
    assert.equal(preset.hasAudio, true);

    const plan = deriveGenericExecutionPlan(fresh.meta, fresh.selections, "preset:360");
    assert.equal(plan.operation, "keep-original");
    assert.equal(planSource(plan).audioConstraint, "codec-present");
    assert.equal(
      buildGenericFormatSelector(planSource(plan)),
      'b*[format_id="synthetic-prog-high"][protocol="https"][ext="mp4"][vcodec!=?"none"][video_ext="mp4"][acodec!="none"]',
    );
  });

  it("re-analysis UNKNOWN -> ABSENT with no split partner: the preset is gone, FORMAT_UNAVAILABLE", () => {
    const fresh = analyzed(drifted("none"), true);
    assert.deepEqual(fresh.meta.presets, [], "a proven video-only source alone advertises nothing");
    for (const id of ["preset:best", "preset:360", "preset:240"]) {
      refused(() => deriveGenericExecutionPlan(fresh.meta, fresh.selections, id), id);
    }
  });

  it("re-analysis UNKNOWN -> ABSENT with a valid split partner: the existing merge-split plan is derived", () => {
    const partner = {
      format_id: "synthetic-audio-m4a",
      ext: "m4a",
      protocol: "https",
      vcodec: "none",
      acodec: "mp4a.40.2",
      video_ext: "none",
      audio_ext: "m4a",
    };
    // The progressive formats are now PROVEN video-only, so the ordinary split
    // rules pair them with the m4a partner. Nothing X-specific is involved.
    const fresh = analyzed(drifted("none", [partner]), true);
    assert.equal(fresh.selections["preset:360"]?.kind, "split");
    const plan = deriveGenericExecutionPlan(fresh.meta, fresh.selections, "preset:360");
    assert.equal(plan.operation, "merge-split");
    if (plan.operation !== "merge-split") throw new Error("unreachable");
    assert.equal(plan.pair.video.formatId, "synthetic-prog-high");
    assert.equal(plan.pair.audio.formatId, "synthetic-audio-m4a");
    assert.equal(plan.targetContainer, "mp4");
  });
});
