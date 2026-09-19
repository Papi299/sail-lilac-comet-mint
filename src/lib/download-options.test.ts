import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedFormat, QualityPreset, VideoMetadata } from "@/types/media";
import { hasDownloadOptions, initialSelectionId } from "./download-options.ts";

function preset(id: string): QualityPreset {
  return {
    id,
    label: id,
    resolution: null,
    container: "mp4",
    fileSize: null,
    hasVideo: true,
    hasAudio: true,
    formatId: id,
    videoCodec: null,
    audioCodec: null,
    fps: null,
  };
}

function format(id: string, container = "mp4"): NormalizedFormat {
  return {
    id,
    resolution: "720p",
    width: 1280,
    height: 720,
    fps: null,
    container,
    videoCodec: null,
    audioCodec: null,
    bitrate: null,
    fileSize: null,
    hasVideo: true,
    hasAudio: true,
  };
}

function analyzed(
  presets: QualityPreset[],
  formats: NormalizedFormat[],
  extractor = "yt-dlp",
): VideoMetadata {
  return {
    title: "Example",
    thumbnail: null,
    duration: null,
    source: "example.com",
    extractor,
    webpageUrl: "https://example.com/watch",
    formats,
    presets,
    capabilities: { mp3: false, merge: false },
  };
}

describe("no compatible download = zero presets AND zero formats", () => {
  it("presets > 0, formats > 0 → selectable", () => {
    assert.equal(hasDownloadOptions(analyzed([preset("preset:best")], [format("22")])), true);
  });

  it("presets > 0, formats = 0 → selectable", () => {
    assert.equal(hasDownloadOptions(analyzed([preset("preset:best")], [])), true);
  });

  it("presets = 0, formats > 0 → selectable", () => {
    assert.equal(hasDownloadOptions(analyzed([], [format("22")])), true);
  });

  it("presets = 0, formats = 0 → no compatible download", () => {
    assert.equal(hasDownloadOptions(analyzed([], [])), false);
  });

  it("decides from the public shape, not the extractor", () => {
    for (const extractor of ["yt-dlp", "direct"]) {
      assert.equal(hasDownloadOptions(analyzed([], [], extractor)), false);
      assert.equal(hasDownloadOptions(analyzed([], [format("original")], extractor)), true);
    }
  });
});

describe("initial selection", () => {
  it("prefers the first preset", () => {
    const video = analyzed([preset("preset:best"), preset("preset:720p")], [format("22")]);
    assert.equal(initialSelectionId(video), "preset:best");
  });

  it("keeps a concrete-format-only result selectable, with the first format selected", () => {
    const video = analyzed([], [format("43", "webm"), format("18")]);
    assert.equal(hasDownloadOptions(video), true);
    assert.equal(initialSelectionId(video), "43");
  });

  it("selects nothing when there is no compatible download", () => {
    assert.equal(initialSelectionId(analyzed([], [])), "");
  });

  it("has a selection exactly when the result has download options", () => {
    const shapes = [
      analyzed([preset("preset:best")], [format("22")]),
      analyzed([preset("preset:best")], []),
      analyzed([], [format("22")]),
      analyzed([], []),
    ];
    for (const video of shapes) {
      assert.equal(initialSelectionId(video) !== "", hasDownloadOptions(video));
    }
  });
});

describe("P1 sourceQuality is informational only", () => {
  const observed2160: VideoMetadata["sourceQuality"] = {
    observedMaxHeight: 2160,
    deliverableMaxHeight: 720,
    withheld: [{ reason: "unsupported_protocol", count: 2, maxObservedHeight: 2160 }],
    protectedUnenumerated: false,
    maybeProtectedObserved: false,
  };

  it("never changes option detection or the initial selection", () => {
    const shapes = [
      analyzed([preset("preset:best"), preset("preset:720")], []),
      analyzed([], [format("22")]),
      analyzed([], []),
    ];
    for (const video of shapes) {
      const withQuality: VideoMetadata = { ...video, sourceQuality: observed2160 };
      assert.equal(hasDownloadOptions(withQuality), hasDownloadOptions(video));
      assert.equal(initialSelectionId(withQuality), initialSelectionId(video));
    }
  });

  it("does not make an observed-only quality downloadable", () => {
    const video = { ...analyzed([], []), sourceQuality: observed2160 };
    assert.equal(hasDownloadOptions(video), false);
    assert.equal(initialSelectionId(video), "");
  });
});
