import { z } from "zod";
import { AppError } from "@/lib/errors";
import {
  WorkerRequestedFormatIdSchema,
  type WorkerRequestedFormatId,
  type WorkerVideoMetadata,
} from "@/shared/worker/contracts";
import {
  GenericPresetSourceSchema,
  GenericSourceContainerSchema,
  GenericSourceSelectionSchema,
  GenericSplitSourceSelectionSchema,
  GenericSplitTargetContainerSchema,
  splitTargetContainer,
  type GenericSourceSelection,
  type GenericSourceSelections,
  type GenericSplitSourceSelection,
} from "./generic-source.ts";

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

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC (yt-dlp) EXECUTION PLANNING — Phase 10C3 §18
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §18: the explicit, runtime-validated GENERIC execution plan.
 *
 * Entirely application-owned apart from the single tightly validated upstream
 * identifier inside `source`. It carries enough to prove, before the job leaves
 * `analyzing`, exactly what will be acquired and what will be done to it:
 *
 *   strategy | requested preset | safe internal source id | expected protocol
 *   | expected source container | expected source stream shape | local
 *   operation | final target container
 *
 * The plan is derived from a FRESH execution analysis, never from the browser's
 * earlier one, and never from durable state (§17/§42).
 */
export const GenericExecutionPlanSchema = z.discriminatedUnion("operation", [
  z
    .object({
      strategy: z.literal("yt-dlp"),
      operation: z.literal("keep-original"),
      requestedFormatId: WorkerRequestedFormatIdSchema,
      source: GenericSourceSelectionSchema,
      // Keeping the original means the delivered container IS the source
      // container. Any other value would be a silent substitution.
      targetContainer: GenericSourceContainerSchema,
    })
    .strict(),
  z
    .object({
      strategy: z.literal("yt-dlp"),
      operation: z.literal("extract-m4a"),
      requestedFormatId: z.literal("preset:audio"),
      source: GenericSourceSelectionSchema,
      targetContainer: z.literal("m4a"),
    })
    .strict(),
  z
    .object({
      strategy: z.literal("yt-dlp"),
      operation: z.literal("extract-mp3"),
      requestedFormatId: z.literal("preset:mp3"),
      source: GenericSourceSelectionSchema,
      targetContainer: z.literal("mp3"),
    })
    .strict(),
  /**
   * SPLIT-01: a video preset fulfilled by an approved video-only + audio-only
   * PAIR, merged LOCALLY by the Worker's own FFmpeg after `beginProcessing()`
   * commits.
   *
   * NOT REACHABLE YET. Nothing constructs a split preset source, so
   * `deriveGenericExecutionPlan` can never produce this variant today. It
   * exists so the representation, its invariants and its refusals can be
   * reviewed before anything can build one — and so that every later task has
   * exactly one shape to target.
   *
   * `pair` carries TWO raw upstream identifiers. They are private to exactly
   * the same extent the single-source `source` is: never browser-facing, never
   * durable, never logged, never in an error message.
   */
  z
    .object({
      strategy: z.literal("yt-dlp"),
      operation: z.literal("merge-split"),
      // A VIDEO preset only. `preset:audio` and `preset:mp3` are single-source
      // operations and are refused by `buildGenericSplitCandidate` before they
      // could reach this schema; the literal union cannot express "any preset
      // except two", so that refusal is the enforcement and this is the shape.
      requestedFormatId: WorkerRequestedFormatIdSchema,
      pair: GenericSplitSourceSelectionSchema,
      targetContainer: GenericSplitTargetContainerSchema,
    })
    .strict()
    .superRefine((plan, ctx) => {
      // The target is DERIVED from the pair, never asserted alongside it. A
      // plan whose declared target disagrees with the closed container table is
      // unrepresentable rather than merely wrong: the target becomes the output
      // extension, the MIME decision and the advertised container at once, so a
      // drifted value would make all three wrong together.
      const derived = splitTargetContainer(plan.pair.video.container, plan.pair.audio.container);
      if (plan.targetContainer !== derived) {
        ctx.addIssue({
          code: "custom",
          path: ["targetContainer"],
          message: "targetContainer must equal the pair's table-derived target",
        });
      }
      // `preset:audio` / `preset:mp3` are audio-only products and are never
      // fulfilled by a merge. Stated here as well as in the builder so the
      // schema alone refuses a hand-constructed plan.
      if (plan.requestedFormatId === "preset:audio" || plan.requestedFormatId === "preset:mp3") {
        ctx.addIssue({
          code: "custom",
          path: ["requestedFormatId"],
          message: "an audio preset is never fulfilled by a split merge",
        });
      }
    }),
]);

export type GenericExecutionPlan = z.infer<typeof GenericExecutionPlanSchema>;

/**
 * The plan variants that name EXACTLY ONE upstream source.
 *
 * The single-source acquisition primitive takes this rather than the whole
 * union, so "this function acquires one source" is a TYPE statement rather than
 * a comment — a `merge-split` plan cannot be handed to it even by mistake, and
 * a future edit cannot quietly teach it to acquire half a pair.
 */
export type GenericSingleSourceExecutionPlan = Exclude<
  GenericExecutionPlan,
  { operation: "merge-split" }
>;

/**
 * §18 + §37 + §38: derives the generic plan for one requested preset.
 *
 * The requested preset must still be present in the FRESH analysis. If the site
 * changed since the browser chose it, the answer is `FORMAT_UNAVAILABLE` — never
 * a substitution (§17).
 */
export function deriveGenericExecutionPlan(
  meta: WorkerVideoMetadata,
  selections: GenericSourceSelections,
  requestedFormatId: string,
): GenericExecutionPlan {
  const requested = WorkerRequestedFormatIdSchema.safeParse(requestedFormatId);
  if (!requested.success) throw new AppError("FORMAT_UNAVAILABLE");
  const id = requested.data;

  // Generic analysis advertises NO concrete formats, so a non-preset request
  // can never be honoured on this strategy.
  if (!id.startsWith("preset:")) throw new AppError("FORMAT_UNAVAILABLE");

  // The preset must be advertised AND selectable. Both halves are checked: the
  // analyzer keeps them in bijection, and this refuses to trust that here.
  const preset = meta.presets.find((p) => p.id === id && p.formatId === id);
  const rawSource = selections[id];
  if (!preset || !rawSource) throw new AppError("FORMAT_UNAVAILABLE");

  // The preset source is RE-PARSED rather than trusted: it crossed a module
  // boundary, and it is what names the upstream source (or pair of sources)
  // acquisition will act on. The discriminated union is the only shape accepted
  // here, so a bare selection left behind by an older build is a refusal rather
  // than something to be interpreted charitably.
  const presetSource = GenericPresetSourceSchema.safeParse(rawSource);
  if (!presetSource.success) throw new AppError("FORMAT_UNAVAILABLE");

  const candidate =
    presetSource.data.kind === "single"
      ? buildGenericCandidate(id, preset, presetSource.data.source)
      : buildGenericSplitCandidate(id, preset, presetSource.data.pair);

  const parsed = GenericExecutionPlanSchema.safeParse(candidate);
  if (!parsed.success) throw new AppError("FORMAT_UNAVAILABLE");

  // §10-equivalent invariant: the container the browser was shown must equal
  // the container this plan actually produces.
  if (parsed.data.targetContainer !== preset.container) {
    throw new AppError("FORMAT_UNAVAILABLE");
  }
  return parsed.data;
}

function buildGenericCandidate(
  id: WorkerRequestedFormatId,
  preset: { hasVideo: boolean; hasAudio: boolean; container: string },
  source: GenericSourceSelection,
): Record<string, unknown> {
  // ── preset:mp3 — always a Worker-side transcode, after processing begins.
  if (id === "preset:mp3") {
    if (!source.hasAudio) throw new AppError("FORMAT_UNAVAILABLE");
    if (preset.hasVideo || !preset.hasAudio) throw new AppError("FORMAT_UNAVAILABLE");
    return {
      strategy: "yt-dlp",
      operation: "extract-mp3",
      requestedFormatId: "preset:mp3",
      source,
      targetContainer: "mp3",
    };
  }

  // ── preset:audio — keep a real audio-only source; extract from a muxed one.
  if (id === "preset:audio") {
    if (!source.hasAudio) throw new AppError("FORMAT_UNAVAILABLE");
    if (preset.hasVideo || !preset.hasAudio) throw new AppError("FORMAT_UNAVAILABLE");

    if (source.hasVideo) {
      // The source carries video, so audio must be extracted LOCALLY, by the
      // Worker's own FFmpeg, strictly after `beginProcessing()` commits. yt-dlp
      // is never asked to do it: `-x` appears nowhere on this path.
      return {
        strategy: "yt-dlp",
        operation: "extract-m4a",
        requestedFormatId: "preset:audio",
        source,
        targetContainer: "m4a",
      };
    }
    // Already audio-only: the only honourable plan is keeping it verbatim.
    return {
      strategy: "yt-dlp",
      operation: "keep-original",
      requestedFormatId: "preset:audio",
      source,
      targetContainer: source.container,
    };
  }

  // ── video presets — one muxed source, kept as-is (§37).
  //
  // Generic v1 performs NO video transcode or remux. A container the product
  // cannot return verbatim is simply not advertised, so reaching here with a
  // mismatch means the analysis and the plan disagree, which is a refusal.
  if (!source.hasVideo || !source.hasAudio) throw new AppError("FORMAT_UNAVAILABLE");
  if (!preset.hasVideo || !preset.hasAudio) throw new AppError("FORMAT_UNAVAILABLE");
  return {
    strategy: "yt-dlp",
    operation: "keep-original",
    requestedFormatId: id,
    source,
    targetContainer: source.container,
  };
}

/**
 * SPLIT-01: builds the candidate plan for a preset fulfilled by a PAIR.
 *
 * NOT REACHABLE YET — no analysis path produces a split preset source, so
 * nothing calls this today. It is written now so the refusals are reviewable
 * before anything can construct a pair, and so the later analysis task has one
 * fixed contract to satisfy rather than one to invent.
 *
 * Every refusal below is a `FORMAT_UNAVAILABLE`, deliberately: a preset whose
 * pair cannot be honoured EXACTLY must fail, never be substituted with a
 * different rendition, a single source, or a different container (§17).
 */
function buildGenericSplitCandidate(
  id: WorkerRequestedFormatId,
  preset: { hasVideo: boolean; hasAudio: boolean; container: string },
  pair: GenericSplitSourceSelection,
): Record<string, unknown> {
  // Audio products are single-source operations. A merge is only ever how a
  // VIDEO preset gets its audio, so these two can never arrive here.
  if (id === "preset:audio" || id === "preset:mp3") {
    throw new AppError("FORMAT_UNAVAILABLE");
  }

  // The advertised preset must itself claim both streams. A pair fulfilling a
  // preset that claims no audio would deliver more than was advertised, which
  // is a substitution in the other direction and equally refused.
  if (!preset.hasVideo || !preset.hasAudio) throw new AppError("FORMAT_UNAVAILABLE");

  // The target comes from the closed container table and from nowhere else. A
  // combination outside it is not a pair, whatever the members claim.
  const target = splitTargetContainer(pair.video.container, pair.audio.container);
  if (target === null) throw new AppError("FORMAT_UNAVAILABLE");

  return {
    strategy: "yt-dlp",
    operation: "merge-split",
    requestedFormatId: id,
    pair,
    targetContainer: target,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY-AWARE WRAPPER — §19
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §19: the executor's single view of "what to do", across both strategies.
 *
 * A discriminated union rather than one merged plan shape. The direct planner is
 * already reviewed and stays untouched — no yt-dlp concept enters it, and no
 * direct concept enters the generic one.
 */
export type ExecutionPlan =
  | { readonly strategy: "direct"; readonly direct: DirectExecutionPlan }
  | { readonly strategy: "yt-dlp"; readonly generic: GenericExecutionPlan };

/** The container the plan will deliver. Always a closed-vocabulary value. */
export function executionPlanTargetContainer(plan: ExecutionPlan): string {
  return plan.strategy === "direct"
    ? plan.direct.targetContainer
    : plan.generic.targetContainer;
}

/** The application-owned preset/format the user actually asked for. */
export function executionPlanRequestedFormatId(plan: ExecutionPlan): string {
  return plan.strategy === "direct"
    ? plan.direct.requestedFormatId
    : plan.generic.requestedFormatId;
}

/** True when the plan requires local Worker FFmpeg after `beginProcessing()`. */
export function executionPlanRequiresProcessing(plan: ExecutionPlan): boolean {
  return plan.strategy === "direct"
    ? planRequiresProcessing(plan.direct)
    : plan.generic.operation !== "keep-original";
}

/**
 * §35: derives the execution plan for whichever strategy the Worker selected.
 *
 * The strategy comes from the FRESH execution analysis — never from the browser
 * and never from the durable `extractor` column, which records what a previous
 * attempt chose rather than what this one should (§42).
 */
export function deriveExecutionPlan(
  analysis: {
    readonly strategy: "direct" | "yt-dlp";
    readonly video: WorkerVideoMetadata;
    readonly selections: GenericSourceSelections;
  },
  requestedFormatId: string,
): ExecutionPlan {
  // The Worker validates the requested id INDEPENDENTLY of the control plane
  // (§6): a durable row written by an older build, or a request that somehow
  // bypassed the HTTP schema, still cannot name anything outside the closed
  // vocabulary.
  if (!WorkerRequestedFormatIdSchema.safeParse(requestedFormatId).success) {
    throw new AppError("FORMAT_UNAVAILABLE");
  }

  if (analysis.strategy === "direct") {
    return {
      strategy: "direct",
      direct: deriveDirectExecutionPlan(analysis.video, requestedFormatId),
    };
  }
  return {
    strategy: "yt-dlp",
    generic: deriveGenericExecutionPlan(
      analysis.video,
      analysis.selections,
      requestedFormatId,
    ),
  };
}
