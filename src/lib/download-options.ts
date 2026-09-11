import type { VideoMetadata } from "@/types/media";

type DownloadChoices = Pick<VideoMetadata, "presets" | "formats">;

/**
 * Whether an analyzed video offers anything to download.
 *
 * A successful analysis can carry no presets AND no formats when none of the
 * source's streams match a supported download. That is not an error, but there
 * is nothing to select. Empty presets alone is NOT that case: a concrete format
 * still downloads.
 */
export function hasDownloadOptions(video: DownloadChoices): boolean {
  return video.presets.length > 0 || video.formats.length > 0;
}

/** The first preset, else the first concrete format, else nothing. */
export function initialSelectionId(video: DownloadChoices): string {
  return video.presets[0]?.id || video.formats[0]?.id || "";
}
