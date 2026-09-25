import { z } from "zod";
import { AppError } from "@/lib/errors";
import {
  SOURCE_QUALITY_MAX_HEIGHT,
  WorkerRequestedFormatIdSchema,
  type WorkerRequestedFormatId,
  type WorkerVideoMetadata,
} from "@/shared/worker/contracts";
import {
  CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES,
  acceptClearHlsPlaylistUrl,
  hasClearHlsPublicPresetFacts,
  type ClearHlsMediaPlaylistSelections,
} from "../hls/hls-source-selection.ts";
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
/**
 * SPLIT-01 CORRECTION-01: the CLOSED set of requested ids a split merge may
 * ever fulfil — the VIDEO presets, and nothing else.
 *
 * This exists because `WorkerRequestedFormatIdSchema` is the wrong vocabulary
 * here. It is the browser REQUEST vocabulary, so it necessarily also contains
 * `direct-original` and the two audio presets, none of which a merge can
 * produce. Using it and subtracting the audio presets by refinement left
 * `direct-original` representable: a hand-built `merge-split` plan naming it,
 * with a valid pair and a correct target, passed the schema.
 *
 * Ordinary derivation refused that case anyway — `deriveGenericExecutionPlan`
 * rejects a non-`preset:` id before the builder is reached — so nothing was
 * reachable in Production. But SPLIT-01's whole premise is that the PLAN
 * SCHEMA itself represents only valid operations, because every later task is
 * going to trust it. Subtracting invalid members by refinement is exactly the
 * shape of mistake that premise exists to prevent, so the vocabulary is stated
 * positively instead.
 *
 * Deliberately a SEPARATE, private, application-owned enum:
 *   - it is not exported to, derived from, or coupled with any public schema;
 *   - `src/shared/worker/contracts.ts` is untouched and
 *     `WorkerRequestedFormatIdSchema` keeps its full membership for the rest of
 *     the product;
 *   - a new video rung added to the product ladder must be added here too,
 *     which is a deliberate, reviewed edit rather than an accident of subset.
 */
export const GENERIC_SPLIT_VIDEO_PRESET_IDS = [
  "preset:best",
  "preset:2160",
  "preset:1440",
  "preset:1080",
  "preset:720",
  "preset:480",
  "preset:360",
  "preset:240",
  "preset:144",
] as const satisfies readonly WorkerRequestedFormatId[];

export const GenericSplitVideoPresetIdSchema = z.enum(GENERIC_SPLIT_VIDEO_PRESET_IDS);
export type GenericSplitVideoPresetId = z.infer<typeof GenericSplitVideoPresetIdSchema>;

/**
 * GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001: the CLOSED set of
 * requested ids a single-source `keep-original` plan may fulfil — the VIDEO
 * ladder (the same closed vocabulary a merge may fulfil) plus `preset:audio`.
 *
 * Stated positively for the same reason as the split vocabulary above.
 * `direct-original` was representable here through `WorkerRequestedFormatIdSchema`
 * although derivation refuses it, and `preset:mp3` was representable although it
 * is always an extraction. Neither is a member now, so neither needs refuting.
 */
const GenericKeepOriginalRequestedIdSchema = z.enum([
  ...GENERIC_SPLIT_VIDEO_PRESET_IDS,
  "preset:audio",
]);

/**
 * An extraction reads an audio stream out of the acquired file with the
 * Worker's own FFmpeg, so its source must carry PROVEN audio. An `unknown`
 * source may be silent, and extracting from a silent file is a
 * `PROCESSING_FAILED` rather than a download.
 */
function refineProvenAudioExtraction(
  plan: { readonly source: GenericSourceSelection },
  ctx: z.RefinementCtx,
): void {
  if (plan.source.audioConstraint !== "codec-present" || plan.source.hasAudio !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["source", "audioConstraint"],
      message: "an audio extraction requires a source with proven audio",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEAR-HLS EXECUTION PLANNING — HLS-6 §5/§6/§7
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HLS-6: the CLOSED set of requested ids a clear-HLS plan may fulfil.
 *
 * Deliberately the SAME closed list a split merge may fulfil, reused rather than
 * restated. Both mean exactly one thing — "the application's VIDEO ladder" — and
 * a third copy of the nine rungs would be a third place to forget when the
 * ladder changes. What the reuse must NOT be read as is any coupling to split
 * merging: the two operations share a vocabulary, not a capability.
 *
 * `preset:audio` and `preset:mp3` are not members, so an HLS audio product is
 * unrepresentable rather than merely refused — HLS v1 has no audio pairing and
 * no independent HLS audio capability. `direct-original` is not a member either:
 * HLS analysis advertises no concrete formats.
 */
export const ClearHlsVideoPresetIdSchema = z.enum(GENERIC_SPLIT_VIDEO_PRESET_IDS);
export type ClearHlsVideoPresetId = z.infer<typeof ClearHlsVideoPresetIdSchema>;

/**
 * The ONE container a clear-HLS plan can ever deliver.
 *
 * Not a caller choice and not derived from the source: HLS-4 remuxes MPEG-TS
 * into MP4 with a fixed argv that names the `mp4` muxer explicitly, so any other
 * value here would be a claim the processing primitive cannot honour.
 */
export const CLEAR_HLS_TARGET_CONTAINER = "mp4" as const;

/**
 * HLS-6 §7: the EXECUTION-AUTHORITY view of one HLS-5 private selection.
 *
 * Structurally identical to `ClearHlsMediaPlaylistSelection`, and deliberately a
 * distinct type: holding one of these means holding values this module already
 * captured and validated, not a reference to an object analysis handed over.
 */
export type ClearHlsExecutionSource = {
  readonly playlistUrl: string;
  readonly height: number | null;
};

/** The two fields an HLS-5 selection carries, and the only two. */
const CLEAR_HLS_SELECTION_FIELDS = ["playlistUrl", "height"] as const;

/**
 * HLS-6 §7: PARSE one HLS-5 private selection into a validated snapshot, or
 * refuse it.
 *
 * ─── Why this exists at all ─────────────────────────────────────────────────
 *
 * An HLS execution plan is the authority for real network acquisition: the
 * string inside it becomes the ONE URL HLS-2 requests. A structurally typed
 * JavaScript object is not evidence of anything, so it is not trusted merely
 * because TypeScript says it has the right shape.
 *
 * ─── Why it PARSES rather than answering yes/no ─────────────────────────────
 *
 * Exactly HLS-4's reasoning for `parseAcquiredTsArtifact()`. A boolean guard
 * validates the values it read and hands the caller back the original object,
 * which the caller must read AGAIN to use. `Object.freeze` makes accessor
 * properties non-configurable but does NOT convert them into data properties, so
 * a frozen object may still expose a getter that answers differently every time.
 * Validating one URL and then requesting another is precisely the TOCTOU shape
 * §7 forbids, and no care at the call site closes it.
 *
 * So this returns the CAPTURED PRIMITIVES. Past the call the caller holds a
 * string and a number of its own, and the supplied object is never consulted
 * again — there is nothing left for a getter to answer.
 *
 * ─── The representation it requires ─────────────────────────────────────────
 *
 * Exactly what `buildClearHlsMediaPlaylistSelections()` actually constructs,
 * which is a frozen object literal:
 *
 *   - a non-null object, frozen;
 *   - the ordinary `Object.prototype`, so a null-prototype object, a class
 *     instance and a Proxy-backed exotic shape are all refused rather than
 *     probed;
 *   - an own property set of EXACTLY the two fields, counted with
 *     `Reflect.ownKeys()` rather than `Object.keys()`: the latter sees only
 *     enumerable STRING keys, so a symbol-keyed or non-enumerable extra would
 *     sail past a length check while the object still carried payload this
 *     module has not reasoned about;
 *   - each field an own DATA property. An accessor is refused outright, and
 *     refusing it never invokes it — `getOwnPropertyDescriptor()` reports a
 *     getter without calling it.
 *
 * ─── What the captured values must then satisfy ─────────────────────────────
 *
 *   playlistUrl  a string that HLS-5's own static acceptance returns UNCHANGED.
 *                The re-acceptance is what proves the retained value still
 *                satisfies the accepted canonical/static URL policy — absolute
 *                http(s), no credentials, a public host, within the byte
 *                ceiling. The `===` comparison is load-bearing: a value that
 *                would be accepted only AFTER canonicalisation is refused
 *                rather than silently rewritten, so this function can never
 *                validate one URL and hand back another.
 *
 *   height       `null`, or a whole number on HLS-5's observed-height contract
 *                (1 … SOURCE_QUALITY_MAX_HEIGHT) — the exact bound
 *                `observedDimension()` applies before a candidate can exist.
 *
 * Every refusal is `null`, with no interpolation anywhere: the sensitive URL is
 * never echoed into a message, a log or a thrown error from here.
 */
export function snapshotClearHlsSelection(value: unknown): ClearHlsExecutionSource | null {
  if (typeof value !== "object" || value === null) return null;
  if (!Object.isFrozen(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;

  // The COMPLETE own-property set: strings and symbols, enumerable or not.
  if (Reflect.ownKeys(value).length !== CLEAR_HLS_SELECTION_FIELDS.length) return null;

  const captured: Record<string, unknown> = {};
  for (const field of CLEAR_HLS_SELECTION_FIELDS) {
    // An OWN descriptor, so an inherited value can never stand in for one.
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined) return null;
    // A data descriptor carries `value`; an accessor carries `get`/`set`
    // instead. This is the single read of the stored value, and there is no
    // second one.
    if (!("value" in descriptor)) return null;
    captured[field] = descriptor.value;
  }

  const { playlistUrl, height } = captured;
  if (typeof playlistUrl !== "string" || playlistUrl.length === 0) return null;
  // Re-run HLS-5's own acceptance and require it to return this EXACT string.
  if (acceptClearHlsPlaylistUrl(playlistUrl) !== playlistUrl) return null;

  if (height !== null) {
    if (typeof height !== "number") return null;
    if (!Number.isSafeInteger(height)) return null;
    if (height < 1 || height > SOURCE_QUALITY_MAX_HEIGHT) return null;
  }

  return Object.freeze({ playlistUrl, height });
}

/**
 * The plan-shaped view of a validated selection.
 *
 * The bounds restate what `snapshotClearHlsSelection()` already proved, because
 * the schema is what makes a hand-built plan unrepresentable rather than merely
 * unbuilt. The string ceiling is in UTF-16 code units and HLS-5's is in UTF-8
 * bytes, so this is a coarser outer bound on top of the exact one, never a
 * replacement for it.
 */
const ClearHlsExecutionSourceSchema = z
  .object({
    playlistUrl: z.string().min(1).max(CLEAR_HLS_V1_MAX_PLAYLIST_URL_BYTES),
    height: z.number().int().min(1).max(SOURCE_QUALITY_MAX_HEIGHT).nullable(),
  })
  .strict();

export const GenericExecutionPlanSchema = z.discriminatedUnion("operation", [
  z
    .object({
      strategy: z.literal("yt-dlp"),
      operation: z.literal("keep-original"),
      requestedFormatId: GenericKeepOriginalRequestedIdSchema,
      source: GenericSourceSelectionSchema,
      // Keeping the original means the delivered container IS the source
      // container. Any other value would be a silent substitution.
      targetContainer: GenericSourceContainerSchema,
    })
    .strict()
    .superRefine((plan, ctx) => {
      const issue = (path: string[], message: string) =>
        ctx.addIssue({ code: "custom", path, message });

      // Stated as an invariant of the plan rather than left to derivation.
      if (plan.targetContainer !== plan.source.container) {
        issue(["targetContainer"], "keep-original must deliver the source container");
      }

      if (plan.requestedFormatId === "preset:audio") {
        // Kept verbatim ONLY when the source is already audio-only, with PROVEN
        // audio. A video-bearing source is an `extract-m4a`, never a keep.
        if (plan.source.hasVideo || plan.source.videoConstraint !== "absent") {
          issue(["source", "videoConstraint"], "preset:audio keeps only an audio-only source");
        }
        if (plan.source.audioConstraint !== "codec-present") {
          issue(["source", "audioConstraint"], "preset:audio requires proven audio");
        }
        return;
      }

      // An ordinary VIDEO preset from ONE source: video established, and audio
      // either PROVEN (a muxed source) or UNKNOWN (the unknown-audio fallback
      // tier). `absent` is a split pair's video half; as a single ordinary video
      // fulfilment it is outside the capability, so it is unrepresentable here.
      if (!plan.source.hasVideo || plan.source.videoConstraint === "absent") {
        issue(["source", "videoConstraint"], "a video preset requires a video-bearing source");
      }
      if (
        plan.source.audioConstraint !== "codec-present" &&
        plan.source.audioConstraint !== "unknown"
      ) {
        issue(
          ["source", "audioConstraint"],
          "a single-source video preset requires proven or unknown audio, never absent",
        );
      }
    }),
  z
    .object({
      strategy: z.literal("yt-dlp"),
      operation: z.literal("extract-m4a"),
      requestedFormatId: z.literal("preset:audio"),
      source: GenericSourceSelectionSchema,
      targetContainer: z.literal("m4a"),
    })
    .strict()
    .superRefine(refineProvenAudioExtraction),
  z
    .object({
      strategy: z.literal("yt-dlp"),
      operation: z.literal("extract-mp3"),
      requestedFormatId: z.literal("preset:mp3"),
      source: GenericSourceSelectionSchema,
      targetContainer: z.literal("mp3"),
    })
    .strict()
    .superRefine(refineProvenAudioExtraction),
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
      // The CLOSED video-preset vocabulary, stated POSITIVELY. `direct-original`
      // and the two audio presets are not members, so no refinement is needed
      // to exclude them and none can be forgotten (CORRECTION-01).
      requestedFormatId: GenericSplitVideoPresetIdSchema,
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
      // The audio-preset refinement that used to live here is GONE, because the
      // vocabulary above makes `preset:audio`, `preset:mp3` and
      // `direct-original` unrepresentable rather than merely refuted. A
      // refinement that can never fire is not defence in depth, it is dead code
      // that implies a guard the enum already provides.
      //
      // Defence in depth is retained where it can still act: the derivation
      // guard in `deriveGenericExecutionPlan` (non-`preset:` ids) and the
      // explicit audio-preset refusal in `buildGenericSplitCandidate`, both
      // unchanged.
    }),
  /**
   * HLS-6 §5: a video preset fulfilled by ONE clear-HLS media playlist that
   * VideoFetch acquires itself and remuxes, by stream copy, into MP4.
   *
   * `strategy: "yt-dlp"` is deliberate and is not a description of the
   * transport. yt-dlp remains the fresh ANALYSIS/extractor strategy that
   * produced the rendition, and the durable extractor vocabulary is exactly
   * `direct | yt-dlp`; gaining an `"hls"` member would change a persisted,
   * public-facing value for an internal acquisition detail. What is
   * VideoFetch-owned is the acquisition itself, and that is what `operation`
   * says: no yt-dlp subprocess runs on this path.
   *
   * REACHABLE FROM ORDINARY PRODUCT DERIVATION since HLS-7, and only one way:
   * `deriveExecutionPlan()` produces it for a requested preset that the FRESH
   * analysis's `hlsSelections` — and nothing else — owns. It is never a
   * fallback from a progressive refusal, nor the reverse.
   *
   * `source.playlistUrl` is SENSITIVE Worker-private data — routinely a signed,
   * expiring location. It lives in this in-memory plan and in the HLS-2 request
   * it becomes, and nowhere else: never durable, never logged, never in an
   * error, never in a filename, object key or subprocess argv.
   */
  z
    .object({
      strategy: z.literal("yt-dlp"),
      operation: z.literal("clear-hls-remux"),
      // The CLOSED video ladder, stated positively. Audio presets and
      // `direct-original` are not members, so neither needs refuting.
      requestedFormatId: ClearHlsVideoPresetIdSchema,
      source: ClearHlsExecutionSourceSchema,
      // Fixed, never derived and never a caller choice.
      targetContainer: z.literal(CLEAR_HLS_TARGET_CONTAINER),
    })
    .strict(),
]);

export type GenericExecutionPlan = z.infer<typeof GenericExecutionPlanSchema>;

/**
 * The plan variants the ORDINARY yt-dlp single-source downloader can accept.
 *
 * The single-source acquisition primitive takes this rather than the whole
 * union, so "this function acquires one source with yt-dlp" is a TYPE statement
 * rather than a comment — a `merge-split` plan cannot be handed to it even by
 * mistake, and a future edit cannot quietly teach it to acquire half a pair.
 *
 * HLS-6 subtracts `clear-hls-remux` here EXPLICITLY rather than leaving it to
 * fall in by default. A clear-HLS plan names a media playlist, not a media
 * file; its acquisition is VideoFetch's own fragment transport and runs no
 * yt-dlp subprocess at all. Had it stayed a member, passing one to
 * `downloadGenericOriginal()` would have type-checked, and the whole point of
 * this partition is that such a call is a compile error.
 */
export type GenericSingleSourceExecutionPlan = Exclude<
  GenericExecutionPlan,
  { operation: "merge-split" } | { operation: "clear-hls-remux" }
>;

/**
 * SPLIT-03: the ONE plan variant that names an approved video-only + audio-only
 * PAIR — the exact complement of `GenericSingleSourceExecutionPlan`.
 *
 * The dual-source acquisition primitive takes this rather than the whole union,
 * so "this function acquires a pair" is a TYPE statement as well: a
 * single-source plan cannot be handed to it even by mistake, and the two
 * acquisition APIs cannot be asked to do each other's job.
 */
export type GenericSplitExecutionPlan = Extract<
  GenericExecutionPlan,
  { operation: "merge-split" }
>;

/**
 * HLS-6 §11: the ONE plan variant fulfilled by VideoFetch's own clear-HLS
 * acquisition and remux — disjoint from both yt-dlp partitions above.
 *
 * The three types together exactly cover `GenericExecutionPlan`, and no plan is
 * a member of two. That is what makes "an HLS plan cannot reach a progressive
 * yt-dlp acquisition seam, and a progressive plan cannot reach the HLS one" a
 * statement the compiler enforces rather than a convention tests hope for.
 */
export type ClearHlsExecutionPlan = Extract<
  GenericExecutionPlan,
  { operation: "clear-hls-remux" }
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
  //
  // Audio products are PROVEN-audio only, read from the private constraint
  // rather than from the boolean alone: an `unknown` source may be silent.
  if (id === "preset:mp3") {
    if (source.audioConstraint !== "codec-present" || !source.hasAudio) {
      throw new AppError("FORMAT_UNAVAILABLE");
    }
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
    if (source.audioConstraint !== "codec-present" || !source.hasAudio) {
      throw new AppError("FORMAT_UNAVAILABLE");
    }
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

  // ── video presets — one source, kept as-is (§37).
  //
  // Generic v1 performs NO video transcode or remux. A container the product
  // cannot return verbatim is simply not advertised, so reaching here with a
  // mismatch means the analysis and the plan disagree, which is a refusal.
  if (!source.hasVideo || source.videoConstraint === "absent") {
    throw new AppError("FORMAT_UNAVAILABLE");
  }
  if (!preset.hasVideo) throw new AppError("FORMAT_UNAVAILABLE");

  // The PRIVATE audio constraint is the authority, and the public boolean must
  // agree with it exactly (GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001).
  // `hasAudio: false` alone cannot distinguish "not proven" from "proven absent",
  // so it is never read as that distinction here.
  switch (source.audioConstraint) {
    case "codec-present":
      // A muxed source: audio PROVEN, and the preset must say so.
      if (!source.hasAudio || preset.hasAudio !== true) throw new AppError("FORMAT_UNAVAILABLE");
      break;
    case "unknown":
      // The unknown-audio fallback tier: audio NOT proven, and the preset must
      // not claim it. Delivered exactly as acquired — no probe, no processing.
      if (source.hasAudio || preset.hasAudio !== false) throw new AppError("FORMAT_UNAVAILABLE");
      break;
    default:
      // `absent` is a split pair's video half. As an ordinary single video
      // fulfilment it is outside this capability.
      throw new AppError("FORMAT_UNAVAILABLE");
  }
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

/**
 * HLS-6 §8: derives the clear-HLS execution plan for ONE requested video preset.
 *
 * Deliberately a SEPARATE entry point from `deriveGenericExecutionPlan()`. Since
 * HLS-7, `deriveExecutionPlan()` calls it for exactly one case — the requested
 * preset is owned by `hlsSelections` alone, and its public facts agree — after
 * checking that the preset is advertised. It is never tried because the
 * progressive derivation refused, and never the other way round.
 *
 * The steps, in order:
 *
 *   1. the requested id must be a member of the closed VIDEO vocabulary;
 *   2. exactly that key must be an OWN data property of the FRESH HLS-5 map —
 *      an inherited value, an accessor and a missing key are all refusals;
 *   3. the selection is parsed into a module-owned frozen snapshot (§7);
 *   4. the fixed MP4 plan is built from the snapshot and re-parsed by the plan
 *      schema, which is the representation every later phase trusts.
 *
 * There is NO substitution, in any direction. A requested `preset:1080` whose
 * HLS key is absent is `FORMAT_UNAVAILABLE`, even when `preset:720`,
 * `preset:best` or a progressive source could have been delivered instead:
 * silently handing back a rendition nobody asked for is exactly what the
 * existing derivation rules forbid, and HLS is not an exception to them.
 *
 * The returned plan and its source are frozen. The snapshot is already detached
 * from the caller's map — mutating either afterwards cannot change what this
 * plan will acquire.
 *
 * Nothing here interpolates the playlist URL into an error: every refusal is a
 * bare `FORMAT_UNAVAILABLE` carrying the canonical safe message.
 */
export function deriveClearHlsExecutionPlan(
  hlsSelections: ClearHlsMediaPlaylistSelections,
  requestedFormatId: string,
): ClearHlsExecutionPlan {
  const requested = ClearHlsVideoPresetIdSchema.safeParse(requestedFormatId);
  if (!requested.success) throw new AppError("FORMAT_UNAVAILABLE");
  const id = requested.data;

  if (typeof hlsSelections !== "object" || hlsSelections === null) {
    throw new AppError("FORMAT_UNAVAILABLE");
  }

  // EXACTLY this key, as an OWN DATA property. `getOwnPropertyDescriptor()`
  // reports an accessor without invoking it, so a hostile getter on the map
  // gets no execution either.
  const entry = Object.getOwnPropertyDescriptor(hlsSelections, id);
  if (entry === undefined || !("value" in entry)) throw new AppError("FORMAT_UNAVAILABLE");

  const source = snapshotClearHlsSelection(entry.value);
  if (source === null) throw new AppError("FORMAT_UNAVAILABLE");

  const parsed = GenericExecutionPlanSchema.safeParse({
    strategy: "yt-dlp",
    operation: "clear-hls-remux",
    requestedFormatId: id,
    source,
    targetContainer: CLEAR_HLS_TARGET_CONTAINER,
  });
  // The discriminant is re-read rather than assumed: this function's return
  // type is the HLS partition, and the only honest way to produce one from a
  // whole-union parse is to check which member came back.
  if (!parsed.success || parsed.data.operation !== "clear-hls-remux") {
    throw new AppError("FORMAT_UNAVAILABLE");
  }

  // `safeParse` already returned a fresh object rather than the input, so this
  // freeze is about what the CALLER can do next, not about detaching from the
  // analysis map.
  return Object.freeze({ ...parsed.data, source: Object.freeze(parsed.data.source) });
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

/** The two private families a generic preset can be owned by. */
type GenericPresetOwner = "progressive" | "clear-hls";

/** Does this private map say ANYTHING about `id`? Never invokes an accessor. */
function claims(map: unknown, id: string): boolean {
  return typeof map === "object" && map !== null && id in map;
}

/**
 * HLS-7: which family owns ONE requested generic preset, read — never decided —
 * off the FRESH analysis.
 *
 * Analysis made the family decision once, for this source, and encoded it as
 * WHICH private map holds the key. This reads that encoding and checks it:
 *
 *   1. exactly one map claims the id. Neither and both are both
 *      `FORMAT_UNAVAILABLE` — "both" is a malformed analysis, and resolving it
 *      here by precedence would be the third family decision analysis exists to
 *      prevent;
 *   2. the preset is ADVERTISED, with `id === formatId`;
 *   3. its public facts agree with the family that claims it. A clear-HLS preset
 *      states exactly `CLEAR_HLS_PUBLIC_PRESET_FACTS`, and a progressive one
 *      never does (the analyzer asserts both). A disagreement means the private
 *      map and the preset the browser was shown describe different things, so
 *      it is refused rather than fulfilled by whichever map happened to hold
 *      the key.
 *
 * Each step can only REFUSE. Nothing here substitutes one family for another,
 * and nothing is retried with the other family after a refusal.
 */
function genericPresetOwner(
  analysis: {
    readonly video: WorkerVideoMetadata;
    readonly selections: GenericSourceSelections;
    readonly hlsSelections: ClearHlsMediaPlaylistSelections;
  },
  requestedFormatId: string,
): GenericPresetOwner {
  const progressive = claims(analysis.selections, requestedFormatId);
  const hls = claims(analysis.hlsSelections, requestedFormatId);
  if (progressive === hls) throw new AppError("FORMAT_UNAVAILABLE");

  const preset = analysis.video.presets.find(
    (p) => p.id === requestedFormatId && p.formatId === requestedFormatId,
  );
  if (!preset) throw new AppError("FORMAT_UNAVAILABLE");
  if (hasClearHlsPublicPresetFacts(preset) !== hls) throw new AppError("FORMAT_UNAVAILABLE");

  return hls ? "clear-hls" : "progressive";
}

/**
 * §35: derives the execution plan for whichever strategy the Worker selected.
 *
 * The strategy comes from the FRESH execution analysis — never from the browser
 * and never from the durable `extractor` column, which records what a previous
 * attempt chose rather than what this one should (§42).
 *
 * ─── HLS-7: THE PRODUCT ACTIVATION POINT ────────────────────────────────────
 *
 * This is the ONE place the ordinary Product planner reaches clear HLS. For
 * `yt-dlp` it reads which private map owns the requested preset
 * (`genericPresetOwner`) and dispatches to that family's already-reviewed
 * derivation, and to nothing else:
 *
 *   progressive/split owner   `deriveGenericExecutionPlan()`, unchanged;
 *   clear-HLS owner           `deriveClearHlsExecutionPlan()`, unchanged;
 *   neither, or both          `FORMAT_UNAVAILABLE`.
 *
 * There is no try-one-then-the-other. A progressive refusal is final, an HLS
 * refusal is final, and a preset whose owner the fresh analysis cannot name is
 * unavailable — the site may have changed since the browser chose it, and the
 * answer to that has always been `FORMAT_UNAVAILABLE`, never a substitution.
 *
 * `hlsSelections` is a REQUIRED input, so every caller states the HLS half of
 * the fresh analysis, if only as `{}`. The direct strategy never reads it.
 */
export function deriveExecutionPlan(
  analysis: {
    readonly strategy: "direct" | "yt-dlp";
    readonly video: WorkerVideoMetadata;
    readonly selections: GenericSourceSelections;
    readonly hlsSelections: ClearHlsMediaPlaylistSelections;
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

  if (genericPresetOwner(analysis, requestedFormatId) === "clear-hls") {
    const hls = deriveClearHlsExecutionPlan(analysis.hlsSelections, requestedFormatId);
    // §10-equivalent: the container the browser was shown is the container
    // this plan delivers. The facts check above already pinned it to mp4; this
    // restates the invariant against the plan itself.
    const shown = analysis.video.presets.find((p) => p.id === requestedFormatId);
    if (!shown || hls.targetContainer !== shown.container) {
      throw new AppError("FORMAT_UNAVAILABLE");
    }
    return { strategy: "yt-dlp", generic: hls };
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
