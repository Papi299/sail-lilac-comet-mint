import type { NormalizedFormat, QualityPreset, SourceQuality, VideoMetadata } from "@/types/media";

/**
 * Analysis shapes for the source-quality presentation tests. Each generic
 * fixture mirrors what the Worker's preset builder emits (`preset:best` labelled
 * "Best available", ladder rungs, `formats: []`), and every `sourceQuality` here
 * must satisfy the real `SourceQualitySchema`; the tests assert both.
 */

export function preset(
  id: string,
  label: string,
  resolution: string | null,
  extra: Partial<QualityPreset> = {},
): QualityPreset {
  return {
    id,
    label,
    resolution,
    container: "mp4",
    fileSize: null,
    hasVideo: true,
    hasAudio: true,
    formatId: id,
    videoCodec: "avc1.64001f",
    audioCodec: "mp4a.40.2",
    fps: 30,
    ...extra,
  };
}

export function generic(presets: QualityPreset[], sourceQuality?: SourceQuality): VideoMetadata {
  return {
    title: "Example",
    thumbnail: null,
    duration: 60,
    source: "example.com",
    extractor: "yt-dlp",
    webpageUrl: "https://example.com/watch",
    formats: [],
    presets,
    capabilities: { mp3: false, merge: false },
    ...(sourceQuality ? { sourceQuality } : {}),
  };
}

export function quality(overrides: Partial<SourceQuality> = {}): SourceQuality {
  return {
    observedMaxHeight: null,
    deliverableMaxHeight: null,
    withheld: [],
    protectedUnenumerated: false,
    maybeProtectedObserved: false,
    ...overrides,
  };
}

// The accepted Production X/Twitter case (P1 promotion, 2026-09-18): a
// 384-pixel progressive MP4 behind the 360p rung, plus two HLS copies of the
// SAME height withheld as an unsupported protocol.
export const X_CASE_QUALITY: SourceQuality = quality({
  observedMaxHeight: 384,
  deliverableMaxHeight: 384,
  withheld: [{ reason: "unsupported_protocol", count: 2, maxObservedHeight: 384 }],
});

export function xCasePresets(): QualityPreset[] {
  const unknownAudio = { hasAudio: false, audioCodec: null, fps: 30 };
  return [
    preset("preset:best", "Best available", "360p", { ...unknownAudio, fileSize: 774_763 }),
    preset("preset:360", "360p", "360p", { ...unknownAudio, fileSize: 774_763 }),
    preset("preset:240", "240p", "240p", unknownAudio),
  ];
}

export function xCase(): VideoMetadata {
  return { ...generic(xCasePresets(), X_CASE_QUALITY), source: "x.com" };
}

export const GAP_2160_QUALITY: SourceQuality = quality({
  observedMaxHeight: 2160,
  deliverableMaxHeight: 720,
  withheld: [{ reason: "unsupported_protocol", count: 2, maxObservedHeight: 2160 }],
});

export function gap2160(): VideoMetadata {
  return generic(
    [
      preset("preset:best", "Best available", "720p"),
      preset("preset:720", "720p", "720p"),
      preset("preset:480", "480p", "480p"),
      preset("preset:360", "360p", "360p"),
    ],
    GAP_2160_QUALITY,
  );
}

// The original confusing screenshot: one executable Best with no height at all.
export function unknownResolution(): VideoMetadata {
  return generic([preset("preset:best", "Best available", null)], quality());
}

export function protectedUnenumerated(): VideoMetadata {
  return generic(
    [preset("preset:best", "Best available", "1080p"), preset("preset:1080", "1080p", "1080p")],
    quality({ observedMaxHeight: 1080, deliverableMaxHeight: 1080, protectedUnenumerated: true }),
  );
}

export function noCompatible(sourceQuality?: SourceQuality): VideoMetadata {
  return generic([], sourceQuality);
}

/** Direct analysis (`src/services/extractors/direct.server.ts`): one raw format, no P1 metadata. */
export function direct(): VideoMetadata {
  const original: NormalizedFormat = {
    id: "direct-original",
    resolution: "unknown",
    width: null,
    height: null,
    fps: null,
    container: "mp4",
    videoCodec: null,
    audioCodec: null,
    bitrate: null,
    fileSize: 2_848_208,
    hasVideo: true,
    hasAudio: true,
    formatNote: "video/mp4",
  };
  const best = preset("preset:best", "Best available", "unknown", {
    fileSize: 2_848_208,
    videoCodec: null,
    audioCodec: null,
    fps: null,
  });
  return {
    ...generic([best]),
    extractor: "direct",
    source: "download.samplelib.com",
    formats: [original],
  };
}
