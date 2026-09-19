import { formatBytes } from "@/lib/utils";
import type {
  QualityPreset,
  SourceQuality,
  SourceQualityWithheld,
  SourceQualityWithheldReason,
  VideoMetadata,
} from "@/types/media";

/**
 * Browser presentation of the optional P1 `sourceQuality`: the quality one
 * analysis OBSERVED at the source, set against the quality VideoFetch can
 * DOWNLOAD now.
 *
 * Display only. Nothing here adds, removes, reorders or re-identifies a
 * selectable value: options come from `video.presets` and `video.formats`
 * alone, and each option's value is the preset's own id. Observed heights,
 * withheld groups and protection flags are facts to show, never formats to
 * select.
 *
 * Without `sourceQuality` (direct analysis, or a Worker that predates P1) the
 * source-quality helpers here keep the legacy presentation: preset labels are
 * returned unchanged and no quality notice is produced.
 *
 * `isAdvancedAvailable` is deliberately NOT part of that compatibility. It reads
 * `video.formats` alone, so a generic response with `formats: []` reports Advanced
 * as unavailable whether or not `sourceQuality` is present.
 */

export const BEST_PRESET_ID = "preset:best";

type Analyzed = Pick<VideoMetadata, "presets" | "sourceQuality">;

export type QualityOption = { value: string; label: string };

export type SourceQualityFact = { label: string; value: string };

/** Application-owned copy only: no upstream string ever reaches it. */
export type SourceQualityNoticeModel = {
  title: string | null;
  facts: SourceQualityFact[];
  messages: string[];
};

export type SourceQualityPresentation = {
  /** Exact tallest observed height, e.g. "2160p" or "384p". */
  highestObservedLabel: string | null;
  /** The best video preset's rung ("720p"), else its exact height; null when unknown. */
  bestDownloadableLabel: string | null;
  hasHigherObservedQuality: boolean;
  /** A video download exists, but no resolution is known for it. */
  resolutionUnknown: boolean;
  protectedUnenumerated: boolean;
  maybeProtectedObserved: boolean;
  /** Why the observed quality above the downloadable one is withheld. */
  explanations: string[];
  notice: SourceQualityNoticeModel | null;
};

// Explains a withheld group TALLER than the best download.
const HIGHER_QUALITY_COPY: Record<SourceQualityWithheldReason, string> = {
  unsupported_protocol: "Higher-quality streams use a stream type VideoFetch does not support yet.",
  unsupported_container:
    "Higher-quality streams use a media container VideoFetch does not support yet.",
  unsupported_stream_shape:
    "Some higher-quality streams use a stream layout VideoFetch cannot safely select yet.",
  unsafe_selector_identity: "Some higher-quality streams could not be safely selected.",
  // No number: the browser cannot see the Worker's configured limit.
  size_limit_exceeded:
    "Some higher-quality streams exceed VideoFetch's current download size limit.",
  audio_pair_unavailable:
    "Higher-quality video was detected, but no compatible audio stream was available.",
  split_pair_unsupported:
    "Higher-quality video and audio streams were detected, but VideoFetch cannot combine that pairing yet.",
  fallback_suppressed:
    "A higher-quality stream was detected, but its audio compatibility could not be confirmed safely.",
  not_selected:
    "A higher-quality rendition was detected, but it was not selected by the current quality ladder.",
  protected: "Some higher-quality renditions are protected.",
  other_unsupported: "Some higher-quality source renditions are not currently supported.",
};

// Explains a withheld group when NOTHING is downloadable, so "higher" would be
// meaningless.
const UNAVAILABLE_COPY: Record<SourceQualityWithheldReason, string> = {
  unsupported_protocol: "Some detected streams use a stream type VideoFetch does not support yet.",
  unsupported_container:
    "Some detected streams use a media container VideoFetch does not support yet.",
  unsupported_stream_shape:
    "Some detected streams use a stream layout VideoFetch cannot safely select yet.",
  unsafe_selector_identity: "Some detected streams could not be safely selected.",
  size_limit_exceeded: "Some detected streams exceed VideoFetch's current download size limit.",
  audio_pair_unavailable: "Video was detected, but no compatible audio stream was available.",
  split_pair_unsupported:
    "Video and audio streams were detected, but VideoFetch cannot combine that pairing yet.",
  fallback_suppressed: "A detected stream's audio compatibility could not be confirmed safely.",
  not_selected: "Some detected renditions were not selected by the current quality ladder.",
  protected: "Some detected renditions are protected.",
  other_unsupported: "Some detected source renditions are not currently supported.",
};

const RESOLUTION_UNAVAILABLE =
  "VideoFetch can download this source, but the source did not report a reliable video resolution.";
const ADDITIONAL_PROTECTED =
  "Additional protected renditions were detected, but their resolutions were not available during analysis.";
const PROTECTED_UNENUMERATED =
  "Protected renditions were detected, but their resolutions were not available during analysis.";
const MAYBE_PROTECTED = "Some detected source renditions may be protected.";
const NOTHING_DOWNLOADABLE = "No detected rendition is currently downloadable.";

// The Worker's ladder vocabulary ("2160p" … "144p"). Anything else, including
// "unknown" or null, is not a resolution worth showing.
const RUNG_LABEL = /^[1-9]\d{1,4}p$/;

/** Advanced lists raw formats; generic analysis deliberately sends none. */
export function isAdvancedAvailable(video: Pick<VideoMetadata, "formats">): boolean {
  return video.formats.length > 0;
}

/**
 * The label shown for a preset. Only `preset:best` changes, and only when P1
 * metadata exists; its rung comes from the executable preset itself, never from
 * `deliverableMaxHeight` (a 384-pixel source is the 360p preset).
 */
export function presetDisplayLabel(
  preset: QualityPreset,
  video: Pick<VideoMetadata, "sourceQuality">,
): string {
  if (!video.sourceQuality || preset.id !== BEST_PRESET_ID) return preset.label;
  const rung = rungLabel(preset);
  return rung ? `Best downloadable — ${rung}` : "Best downloadable";
}

/** Simple-mode options: exactly one per preset, in order, valued by its id. */
export function qualityOptions(video: Analyzed): QualityOption[] {
  return video.presets.map((preset) => ({
    value: preset.id,
    label:
      presetDisplayLabel(preset, video) +
      (preset.fileSize ? ` · ${formatBytes(preset.fileSize)}` : ""),
  }));
}

/**
 * A gap exists only when something TALLER than the best download was observed.
 * Equal heights are no gap: withheld renditions at the delivered height (the
 * X/Twitter HLS copies of the same 384-pixel encode) are not a better quality.
 */
export function hasHigherObservedQuality(quality: SourceQuality): boolean {
  if (quality.observedMaxHeight === null) return false;
  return (
    quality.deliverableMaxHeight === null ||
    quality.observedMaxHeight > quality.deliverableMaxHeight
  );
}

/** The selector's source-quality view; null without P1 metadata (legacy). */
export function presentSourceQuality(video: Analyzed): SourceQualityPresentation | null {
  const quality = video.sourceQuality;
  if (!quality) return null;

  const bestVideo =
    video.presets.find((p) => p.id === BEST_PRESET_ID && p.hasVideo) ??
    video.presets.find((p) => p.hasVideo) ??
    null;
  const bestDownloadableLabel = bestVideo
    ? (rungLabel(bestVideo) ?? heightLabel(quality.deliverableMaxHeight))
    : null;
  const highestObservedLabel = heightLabel(quality.observedMaxHeight);
  const gap = hasHigherObservedQuality(quality);
  const resolutionUnknown = bestVideo !== null && bestDownloadableLabel === null;

  const explanations = gap
    ? unique(
        quality.withheld
          .filter((entry) => isAbove(entry, quality.deliverableMaxHeight))
          .map((entry) => copy(HIGHER_QUALITY_COPY, entry.reason)),
      )
    : [];

  const protection = [
    ...(quality.protectedUnenumerated ? [ADDITIONAL_PROTECTED] : []),
    ...(quality.maybeProtectedObserved ? [MAYBE_PROTECTED] : []),
  ];

  let notice: SourceQualityNoticeModel | null = null;
  if (gap && highestObservedLabel !== null) {
    const downloadable =
      bestDownloadableLabel ??
      (bestVideo ? "Resolution unavailable" : video.presets.length > 0 ? "Audio only" : null);
    notice = {
      title: "Higher source quality detected",
      facts: [
        { label: "Highest observed", value: highestObservedLabel },
        ...(downloadable ? [{ label: "Best downloadable", value: downloadable }] : []),
      ],
      messages: [...explanations, ...protection],
    };
  } else if (resolutionUnknown) {
    notice = {
      title: "Resolution unavailable",
      facts: [],
      messages: [RESOLUTION_UNAVAILABLE, ...protection],
    };
  } else if (quality.protectedUnenumerated) {
    notice = { title: "Protected renditions detected", facts: [], messages: protection };
  } else if (quality.maybeProtectedObserved) {
    notice = { title: null, facts: [], messages: protection };
  }

  return {
    highestObservedLabel,
    bestDownloadableLabel,
    hasHigherObservedQuality: gap,
    resolutionUnknown,
    protectedUnenumerated: quality.protectedUnenumerated,
    maybeProtectedObserved: quality.maybeProtectedObserved,
    explanations,
    notice,
  };
}

/**
 * Context for "No compatible download": nothing is downloadable, so every
 * withheld group explains why. Null without P1 metadata, or when it adds
 * nothing to the legacy message.
 */
export function presentNoCompatibleDownload(
  video: Pick<VideoMetadata, "sourceQuality">,
): SourceQualityNoticeModel | null {
  const quality = video.sourceQuality;
  if (!quality) return null;

  const observed = heightLabel(quality.observedMaxHeight);
  const messages = unique([
    ...(observed ? [NOTHING_DOWNLOADABLE] : []),
    ...quality.withheld.map((entry) => copy(UNAVAILABLE_COPY, entry.reason)),
    ...(quality.protectedUnenumerated ? [PROTECTED_UNENUMERATED] : []),
    ...(quality.maybeProtectedObserved ? [MAYBE_PROTECTED] : []),
  ]);
  const facts = observed ? [{ label: "Highest observed", value: observed }] : [];
  if (facts.length === 0 && messages.length === 0) return null;
  return { title: null, facts, messages };
}

function rungLabel(preset: QualityPreset): string | null {
  return preset.resolution !== null && RUNG_LABEL.test(preset.resolution)
    ? preset.resolution
    : null;
}

/** An exact observed height, kept exact: 2160 → "2160p", 384 → "384p". */
function heightLabel(height: number | null): string | null {
  return height === null ? null : `${height}p`;
}

function isAbove(entry: SourceQualityWithheld, deliverable: number | null): boolean {
  if (entry.maxObservedHeight === null) return false;
  return deliverable === null || entry.maxObservedHeight > deliverable;
}

// The schema closes the vocabulary; a reason outside it still never renders
// as-is. It gets the generic copy instead.
function copy(table: Record<SourceQualityWithheldReason, string>, reason: string): string {
  return Object.hasOwn(table, reason)
    ? table[reason as SourceQualityWithheldReason]
    : table.other_unsupported;
}

function unique(messages: string[]): string[] {
  return [...new Set(messages)];
}
