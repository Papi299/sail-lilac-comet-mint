import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "@/lib/errors";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import {
  DIRECT_KEEP_CONTAINERS,
  deriveDirectExecutionPlan,
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
