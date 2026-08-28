import { z } from "zod";
import { AppError } from "@/lib/errors";
import type { WorkerVideoMetadata } from "@/shared/worker/contracts";

/**
 * §7: Containers the Worker is willing to hand back UNMODIFIED.
 *
 * This is the closed set produced by the direct extractor's own URL-extension
 * allowlist. Keeping it explicit here means an arbitrary `container` string
 * that somehow reached the validated metadata can never become a filename
 * extension, a MIME lookup, or an FFmpeg argument.
 */
export const DIRECT_KEEP_CONTAINERS = [
  "mp4",
  "webm",
  "mkv",
  "mov",
  "m4v",
  "avi",
  "ogv",
  "m4a",
  "mp3",
  "ogg",
  "wav",
  "aac",
  "flac",
  "opus",
] as const;

export const DirectKeepContainerSchema = z.enum(DIRECT_KEEP_CONTAINERS);

/**
 * §7 + §9: the ONLY video containers the Worker will ever ask FFmpeg to
 * produce. `convertMedia` accepts a closed target union; this narrows it
 * further to the two targets direct presets are allowed to advertise.
 */
export const DirectConvertTargetSchema = z.enum(["mp4", "webm"]);

/**
 * §7: explicit, runtime-validated execution plan.
 *
 * The plan is derived once, from the exact selected item inside the
 * runtime-validated analysis metadata, and it is the ONLY thing the executor
 * consults when deciding whether to run FFmpeg and with which target. Nothing
 * user-supplied flows past this boundary.
 */
export const DirectExecutionPlanSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("keep-original"),
      requestedFormatId: z.string().min(1).max(255),
      targetContainer: DirectKeepContainerSchema,
      expectHasVideo: z.boolean(),
      expectHasAudio: z.boolean(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("convert"),
      requestedFormatId: z.string().min(1).max(255),
      targetContainer: DirectConvertTargetSchema,
      expectHasVideo: z.literal(true),
      expectHasAudio: z.boolean(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("extract-m4a"),
      requestedFormatId: z.literal("preset:audio"),
      targetContainer: z.literal("m4a"),
      expectHasVideo: z.literal(false),
      expectHasAudio: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("extract-mp3"),
      requestedFormatId: z.literal("preset:mp3"),
      targetContainer: z.literal("mp3"),
      expectHasVideo: z.literal(false),
      expectHasAudio: z.literal(true),
    })
    .strict(),
]);

export type DirectExecutionPlan = z.infer<typeof DirectExecutionPlanSchema>;

/** True when the plan requires local FFmpeg work after `beginProcessing()`. */
export function planRequiresProcessing(plan: DirectExecutionPlan): boolean {
  return plan.operation !== "keep-original";
}

type SelectedItem = {
  container: string;
  hasVideo: boolean;
  hasAudio: boolean;
};

/**
 * §8: locate the EXACT selected format/preset inside the validated metadata.
 * The selection is never discarded and never re-derived from the raw request.
 */
function findExactSelection(
  meta: WorkerVideoMetadata,
  requestedFormatId: string,
): SelectedItem | null {
  if (requestedFormatId.startsWith("preset:")) {
    const preset = meta.presets.find(
      (p) => p.id === requestedFormatId && p.formatId === requestedFormatId,
    );
    if (!preset) return null;
    return { container: preset.container, hasVideo: preset.hasVideo, hasAudio: preset.hasAudio };
  }
  const format = meta.formats.find((f) => f.id === requestedFormatId);
  if (!format) return null;
  return { container: format.container, hasVideo: format.hasVideo, hasAudio: format.hasAudio };
}

/** The direct extractor always advertises exactly one source format. */
function findOriginal(meta: WorkerVideoMetadata): SelectedItem | null {
  const original = meta.formats.find((f) => f.id === "direct-original");
  if (!original) return null;
  return { container: original.container, hasVideo: original.hasVideo, hasAudio: original.hasAudio };
}

/**
 * §8 + §9: derive the execution plan from the trusted selected item.
 *
 * Any selection that is unknown, or whose advertised target the Worker cannot
 * honour exactly, is FORMAT_UNAVAILABLE. There is deliberately no fallback:
 * silently substituting a different container would break the §10 invariant
 * that the advertised preset equals the produced artifact.
 */
export function deriveDirectExecutionPlan(
  meta: WorkerVideoMetadata,
  requestedFormatId: string,
): DirectExecutionPlan {
  if (typeof requestedFormatId !== "string" || requestedFormatId.length === 0) {
    throw new AppError("FORMAT_UNAVAILABLE");
  }

  const selected = findExactSelection(meta, requestedFormatId);
  const original = findOriginal(meta);
  if (!selected || !original) {
    throw new AppError("FORMAT_UNAVAILABLE");
  }

  const originalContainer = DirectKeepContainerSchema.safeParse(original.container);
  if (!originalContainer.success) {
    // The source container is outside the closed allowlist; refuse rather than
    // letting it become an extension or an FFmpeg argument.
    throw new AppError("FORMAT_UNAVAILABLE");
  }

  const candidate = buildCandidate(requestedFormatId, selected, {
    container: originalContainer.data,
    hasVideo: original.hasVideo,
    hasAudio: original.hasAudio,
  });

  // §10: the advertised container MUST equal the container this plan produces.
  if (candidate.targetContainer !== selected.container) {
    throw new AppError("FORMAT_UNAVAILABLE");
  }

  const parsed = DirectExecutionPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AppError("FORMAT_UNAVAILABLE");
  }
  return parsed.data;
}

function buildCandidate(
  requestedFormatId: string,
  selected: SelectedItem,
  original: { container: (typeof DIRECT_KEEP_CONTAINERS)[number]; hasVideo: boolean; hasAudio: boolean },
): Record<string, unknown> {
  // preset:mp3 — always an MP3 extraction, performed locally after processing begins.
  if (requestedFormatId === "preset:mp3") {
    if (selected.hasVideo || !selected.hasAudio || !original.hasAudio) {
      throw new AppError("FORMAT_UNAVAILABLE");
    }
    return {
      operation: "extract-mp3",
      requestedFormatId: "preset:mp3",
      targetContainer: "mp3",
      expectHasVideo: false,
      expectHasAudio: true,
    };
  }

  // preset:audio — extract M4A from video sources; keep an audio source as-is
  // when, and only when, the advertised container equals the source container.
  if (requestedFormatId === "preset:audio") {
    if (selected.hasVideo || !selected.hasAudio || !original.hasAudio) {
      throw new AppError("FORMAT_UNAVAILABLE");
    }
    if (original.hasVideo) {
      return {
        operation: "extract-m4a",
        requestedFormatId: "preset:audio",
        targetContainer: "m4a",
        expectHasVideo: false,
        expectHasAudio: true,
      };
    }
    // Source is already audio-only: the only honourable plan is keeping it.
    return {
      operation: "keep-original",
      requestedFormatId: "preset:audio",
      targetContainer: original.container,
      expectHasVideo: false,
      expectHasAudio: true,
    };
  }

  // Video presets (preset:best and the resolution-capped presets) preserve the
  // source streams; they either keep the original container or remux/transcode
  // into one of the two allowlisted video targets.
  if (requestedFormatId.startsWith("preset:")) {
    if (!selected.hasVideo || !original.hasVideo) {
      throw new AppError("FORMAT_UNAVAILABLE");
    }
    if (selected.container === original.container) {
      return {
        operation: "keep-original",
        requestedFormatId,
        targetContainer: original.container,
        expectHasVideo: true,
        expectHasAudio: selected.hasAudio,
      };
    }
    const target = DirectConvertTargetSchema.safeParse(selected.container);
    if (!target.success) {
      throw new AppError("FORMAT_UNAVAILABLE");
    }
    return {
      operation: "convert",
      requestedFormatId,
      targetContainer: target.data,
      expectHasVideo: true,
      expectHasAudio: selected.hasAudio,
    };
  }

  // A concrete (non-preset) format: the direct extractor only ever advertises
  // the untouched original, so the only legal plan is keeping it verbatim.
  if (requestedFormatId !== "direct-original") {
    throw new AppError("FORMAT_UNAVAILABLE");
  }
  if (selected.container !== original.container || selected.hasVideo !== original.hasVideo) {
    throw new AppError("FORMAT_UNAVAILABLE");
  }
  return {
    operation: "keep-original",
    requestedFormatId: "direct-original",
    targetContainer: original.container,
    expectHasVideo: original.hasVideo,
    expectHasAudio: original.hasAudio,
  };
}
