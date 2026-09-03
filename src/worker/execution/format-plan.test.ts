import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "@/lib/errors";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import {
  DIRECT_KEEP_CONTAINERS,
  deriveDirectExecutionPlan,
  deriveExecutionPlan,
  deriveGenericExecutionPlan,
  executionPlanRequestedFormatId,
  executionPlanRequiresProcessing,
  executionPlanTargetContainer,
  planRequiresProcessing,
} from "./format-plan.ts";

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
    fileSize: 1000,
  };
  const AUDIO_M4A = {
    formatId: "140",
    protocol: "https" as const,
    container: "m4a" as const,
    hasVideo: false,
    hasAudio: true,
    videoConstraint: "absent" as const,
    fileSize: 500,
  };

  function meta(presets: Array<{ id: string; container: string; hasVideo: boolean }>) {
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
        hasAudio: true,
        formatId: p.id,
        videoCodec: p.hasVideo ? "h264" : null,
        audioCodec: "aac",
        fps: null,
      })),
      capabilities: { mp3: true, merge: false },
    });
  }

  it("generic VIDEO keeps the single muxed source verbatim (§37)", () => {
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
      { "preset:1080": MUXED_MP4 },
      "preset:1080",
    );
    assert.equal(plan.strategy, "yt-dlp");
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "mp4");
    assert.equal(plan.source.formatId, "22");
    assert.equal(plan.source.protocol, "https");
    assert.equal(plan.source.hasVideo, true);
    assert.equal(plan.source.hasAudio, true);
  });

  it("keeps a webm source as webm rather than remuxing it", () => {
    const src = { ...MUXED_MP4, container: "webm" as const, formatId: "248" };
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:best", container: "webm", hasVideo: true }]),
      { "preset:best": src },
      "preset:best",
    );
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "webm");
  });

  it("preset:audio KEEPS a real audio-only source (§38)", () => {
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:audio", container: "m4a", hasVideo: false }]),
      { "preset:audio": AUDIO_M4A },
      "preset:audio",
    );
    assert.equal(plan.operation, "keep-original");
    assert.equal(plan.targetContainer, "m4a");
    assert.equal(plan.source.hasVideo, false);
  });

  it("preset:audio EXTRACTS m4a from a muxed source (§38)", () => {
    const plan = deriveGenericExecutionPlan(
      meta([{ id: "preset:audio", container: "m4a", hasVideo: false }]),
      { "preset:audio": MUXED_MP4 },
      "preset:audio",
    );
    assert.equal(plan.operation, "extract-m4a");
    assert.equal(plan.targetContainer, "m4a");
    // The SOURCE stays the muxed original: yt-dlp downloads it whole and the
    // Worker's own FFmpeg extracts audio after processing begins.
    assert.equal(plan.source.container, "mp4");
    assert.equal(plan.source.hasVideo, true);
  });

  it("preset:mp3 is always a Worker transcode (§38)", () => {
    for (const source of [MUXED_MP4, AUDIO_M4A]) {
      const plan = deriveGenericExecutionPlan(
        meta([{ id: "preset:mp3", container: "mp3", hasVideo: false }]),
        { "preset:mp3": source },
        "preset:mp3",
      );
      assert.equal(plan.operation, "extract-mp3");
      assert.equal(plan.targetContainer, "mp3");
      assert.equal(plan.source.container, source.container);
    }
  });

  it("FORMAT_UNAVAILABLE when the preset is not advertised", () => {
    assert.throws(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
          { "preset:1080": MUXED_MP4 },
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
          { "preset:1080": MUXED_MP4 },
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
          { "preset:1080": { ...MUXED_MP4, hasAudio: false } },
          "preset:1080",
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORMAT_UNAVAILABLE",
    );
  });

  it("refuses a concrete (non-preset) id: generic advertises no formats", () => {
    assert.throws(
      () =>
        deriveGenericExecutionPlan(
          meta([{ id: "preset:1080", container: "mp4", hasVideo: true }]),
          { "preset:1080": MUXED_MP4 },
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
            { "preset:1080": MUXED_MP4 },
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
