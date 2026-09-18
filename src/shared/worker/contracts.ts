import { z } from "zod";
import { WORKER_PRIVATE_PRINCIPAL, WORKER_JOBS_PATH } from "./constants.ts";
import { WorkerErrorCodeSchema } from "./errors.ts";

// --- Identifiers ---

export const WorkerJobIdSchema = z
  .string()
  .length(32)
  .regex(/^[0-9a-f]{32}$/, "Job ID must be exactly 32 lowercase hex characters");
export type WorkerJobId = z.infer<typeof WorkerJobIdSchema>;

export const WorkerObjectKeySchema = z
  .string()
  .regex(
    /^videofetch\/jobs\/[0-9a-f]{32}\/[0-9a-f]{32}$/,
    "Object key must be opaque, server-generated, and match exact pattern",
  );
export type WorkerObjectKey = z.infer<typeof WorkerObjectKeySchema>;

// --- Dynamic Path Builders ---

export function workerJobPath(jobId: string): string {
  const validId = WorkerJobIdSchema.parse(jobId);
  return `${WORKER_JOBS_PATH}/${validId}`;
}

export function workerJobCancelPath(jobId: string): string {
  const validId = WorkerJobIdSchema.parse(jobId);
  return `${WORKER_JOBS_PATH}/${validId}/cancel`;
}

// --- Worker-owned execution strategy identity ---

/**
 * The CLOSED set of execution strategies the Worker may select and persist.
 *
 * This is a Worker-owned identity, never a browser input and never an upstream
 * value. yt-dlp's own `extractor` / `extractor_key` fields are arbitrary
 * strings the SOURCE controls; they are untrusted metadata and must never
 * reach durable strategy state or influence execution.
 *
 * Phase 10C3 narrows every strategy-bearing field to this union so that an
 * arbitrary string can no longer be stored as, or mistaken for, a strategy.
 */
export const WorkerExtractorStrategySchema = z.enum(["direct", "yt-dlp"]);
export type WorkerExtractorStrategy = z.infer<typeof WorkerExtractorStrategySchema>;

// --- Browser-selectable format vocabulary ---

/**
 * The COMPLETE set of format identifiers a browser may request (§6).
 *
 * Before Phase 10C3 this was `z.string().min(1)`, which let the browser send an
 * arbitrary identifier. That surface is now closed: the vocabulary is
 * application-owned, and a raw yt-dlp `format_id` can never appear here because
 * no upstream string matches any member.
 *
 * The values are exactly what the product already advertises:
 *   - `direct-original` — the direct extractor's single concrete format;
 *   - `preset:*`        — the shared application preset ladder, used verbatim
 *                         by BOTH the direct and the generic analyzers.
 *
 * Generic analysis returns `formats: []`, so presets are the only generic
 * selectable options and no per-site identifier is ever exposed.
 */
export const WORKER_REQUESTED_FORMAT_IDS = [
  "direct-original",
  "preset:best",
  "preset:2160",
  "preset:1440",
  "preset:1080",
  "preset:720",
  "preset:480",
  "preset:360",
  "preset:240",
  "preset:144",
  "preset:audio",
  "preset:mp3",
] as const;

export const WorkerRequestedFormatIdSchema = z.enum(WORKER_REQUESTED_FORMAT_IDS);
export type WorkerRequestedFormatId = z.infer<typeof WorkerRequestedFormatIdSchema>;

// --- Status & DTOs ---

export const WorkerJobStatusSchema = z.enum([
  "queued",
  "analyzing",
  "downloading",
  "processing",
  "uploading",
  "ready",
  "failed",
  "cancelled",
]);
export type WorkerJobStatus = z.infer<typeof WorkerJobStatusSchema>;

export const WorkerJobViewSchema = z
  .object({
    jobId: WorkerJobIdSchema,
    status: WorkerJobStatusSchema,
    progress: z.number().min(0).max(100).nullable(),
    stageLabel: z.string().min(1).nullable(),
    downloadedBytes: z.number().int().nonnegative().nullable(),
    totalBytes: z.number().int().nonnegative().nullable(),
    speed: z.number().nonnegative().nullable(),
    eta: z.number().nonnegative().nullable(),
    errorCode: WorkerErrorCodeSchema.nullable(),
    safeErrorMessage: z.string().nullable(),
    filename: z.string().nullable(),
    fileSize: z.number().int().nonnegative().nullable(),
    mime: z.string().nullable(),
    quality: z.string().nullable(),
    container: z.string().nullable(),
    title: z.string().nullable(),
    thumbnail: z.string().url().nullable(),
    source: z.string().nullable(),
    // Worker-owned strategy identity, never an upstream extractor name.
    extractor: WorkerExtractorStrategySchema.nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    objectKey: WorkerObjectKeySchema.nullable(), // SERVER-TO-SERVER ONLY. Vercel strips this for browser.
  })
  .strict()
  .refine(
    (data) => {
      if (data.status === "ready") {
        if (!data.objectKey) return false;
        const embeddedJobId = data.objectKey.split("/")[2];
        if (embeddedJobId !== data.jobId) return false;
      } else {
        if (data.objectKey !== null) return false;
      }
      return true;
    },
    { message: "objectKey must be non-null and match jobId if ready, else null" }
  );
export type WorkerJobView = z.infer<typeof WorkerJobViewSchema>;

// --- Requests ---

const UrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(
    (val) => val.startsWith("http://") || val.startsWith("https://"),
    "URL must use http or https protocol"
  );

export const WorkerCreateJobRequestSchema = z
  .object({
    url: UrlSchema,
    // §6: closed, application-owned vocabulary. The browser cannot send a raw
    // yt-dlp format id, and cannot name a strategy, downloader or operation.
    formatId: WorkerRequestedFormatIdSchema,
    principalId: z.literal(WORKER_PRIVATE_PRINCIPAL),
  })
  .strict();
export type WorkerCreateJobRequest = z.infer<typeof WorkerCreateJobRequestSchema>;

export const WorkerAnalyzeRequestSchema = z
  .object({
    url: UrlSchema,
  })
  .strict();
export type WorkerAnalyzeRequest = z.infer<typeof WorkerAnalyzeRequestSchema>;

// --- Media Compatibility ---

export const NormalizedFormatSchema = z
  .object({
    id: z.string(),
    resolution: z.string(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    fps: z.number().nullable(),
    container: z.string(),
    videoCodec: z.string().nullable(),
    audioCodec: z.string().nullable(),
    bitrate: z.number().nullable(),
    fileSize: z.number().nullable(),
    hasVideo: z.boolean(),
    hasAudio: z.boolean(),
    formatNote: z.string().nullable().optional(),
  })
  .strict();
export type WorkerNormalizedFormat = z.infer<typeof NormalizedFormatSchema>;

export const QualityPresetSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    resolution: z.string().nullable(),
    container: z.string(),
    fileSize: z.number().nullable(),
    hasVideo: z.boolean(),
    hasAudio: z.boolean(),
    formatId: z.string(),
    videoCodec: z.string().nullable(),
    audioCodec: z.string().nullable(),
    fps: z.number().nullable(),
  })
  .strict();
export type WorkerQualityPreset = z.infer<typeof QualityPresetSchema>;

// --- Source quality (GENERIC-SOURCE-RENDITION-INVENTORY-001) ---

/**
 * Why an OBSERVED video rendition is not what VideoFetch currently delivers.
 *
 * A closed, application-owned vocabulary. Each value names a boundary of the
 * CURRENT generic capability, never an upstream string, and every observed
 * video rendition that is not delivered carries exactly one of them — the
 * first boundary it met, in the analyzer's existing gate order.
 *
 *   unsupported_protocol      its delivery protocol is absent, or is not one the
 *                             current acquisition path supports (single-file
 *                             http/https). HLS and segmented DASH land here.
 *   unsupported_container     its container is outside the closed set current
 *                             generic delivery keeps verbatim (mp4, webm).
 *   unsupported_stream_shape  a video codec is named, but the reported stream
 *                             shape contradicts it, so no closed selector can
 *                             re-select it.
 *   unsafe_selector_identity  its upstream identifier falls outside the safe
 *                             literal grammar, so it can never be named to
 *                             yt-dlp.
 *   size_limit_exceeded       a known size — declared or estimated, alone or as
 *                             the sum of a split pair — is over the delivered
 *                             size limit.
 *   audio_pair_unavailable    it carries no audio, and the result offers no
 *                             audio-only rendition with proven audio at all.
 *   split_pair_unsupported    it carries no audio, proven audio-only renditions
 *                             exist, but the current split capability cannot
 *                             combine them with it: no partner in its container
 *                             family, or no Worker merge capability.
 *   fallback_suppressed       its audio is unknown, and the unknown-audio tier is
 *                             not used because a proven-audio video rendition
 *                             exists elsewhere in the result.
 *   not_selected              deliverable under current capability, but preset
 *                             construction advertised a different rendition: it
 *                             lost its resolution rung's ranking, or its height
 *                             is unknown while other renditions have heights.
 *   protected                 RESERVED. A positively protected rendition that a
 *                             later reviewed phase enumerates. Never emitted
 *                             today: the pinned runtime removes positively
 *                             protected formats before analysis sees them.
 *   other_unsupported         a pair the closed split table or pair schema
 *                             refuses for any other reason.
 *
 * Declaration order is the public ordering of `withheld[]`.
 */
export const SOURCE_QUALITY_WITHHELD_REASONS = [
  "unsupported_protocol",
  "unsupported_container",
  "unsupported_stream_shape",
  "unsafe_selector_identity",
  "size_limit_exceeded",
  "audio_pair_unavailable",
  "split_pair_unsupported",
  "fallback_suppressed",
  "not_selected",
  "protected",
  "other_unsupported",
] as const;

export const SourceQualityWithheldReasonSchema = z.enum(SOURCE_QUALITY_WITHHELD_REASONS);
export type SourceQualityWithheldReason = z.infer<typeof SourceQualityWithheldReasonSchema>;

/** Largest height the public summary will state. Anything taller is not a fact. */
export const SOURCE_QUALITY_MAX_HEIGHT = 16_384;

/** Upper bound on any count, and on all counts together. */
export const SOURCE_QUALITY_MAX_COUNT = 512;

const SourceQualityHeightSchema = z.number().int().min(1).max(SOURCE_QUALITY_MAX_HEIGHT);

export const SourceQualityWithheldSchema = z
  .object({
    reason: SourceQualityWithheldReasonSchema,
    count: z.number().int().min(1).max(SOURCE_QUALITY_MAX_COUNT),
    maxObservedHeight: SourceQualityHeightSchema.nullable(),
  })
  .strict();
export type SourceQualityWithheld = z.infer<typeof SourceQualityWithheldSchema>;

/**
 * What ONE generic analysis observed about source quality, versus what
 * VideoFetch can currently deliver.
 *
 *   observedMaxHeight       the tallest video rendition observed in THIS run's
 *                           sanitized inventory, deliverable or not. Not a claim
 *                           about renditions the run could not see.
 *   deliverableMaxHeight    the tallest SOURCE height behind an advertised video
 *                           preset — the real rendition, not its rung label.
 *   withheld                observed video renditions that are not delivered,
 *                           aggregated by reason, in vocabulary order.
 *   protectedUnenumerated   the extractor reported that protected renditions
 *                           existed and were removed before their qualities were
 *                           listed. No height is inferred from it.
 *   maybeProtectedObserved  a surviving rendition carried the upstream "maybe
 *                           protected" marker. Delivery is unaffected.
 *
 * The refinements make the summary self-consistent: every observed height above
 * the deliverable one is explained by a withheld reason, and nothing states a
 * height the observed maximum does not cover.
 */
export const SourceQualitySchema = z
  .object({
    observedMaxHeight: SourceQualityHeightSchema.nullable(),
    deliverableMaxHeight: SourceQualityHeightSchema.nullable(),
    withheld: z.array(SourceQualityWithheldSchema).max(SOURCE_QUALITY_WITHHELD_REASONS.length),
    protectedUnenumerated: z.boolean(),
    maybeProtectedObserved: z.boolean(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });

    let previous = -1;
    let total = 0;
    let withheldMax: number | null = null;
    for (const entry of q.withheld) {
      const position = SOURCE_QUALITY_WITHHELD_REASONS.indexOf(entry.reason);
      if (position <= previous) issue("withheld reasons must be unique and in vocabulary order");
      previous = position;
      total += entry.count;
      if (entry.maxObservedHeight !== null) {
        withheldMax = Math.max(withheldMax ?? 0, entry.maxObservedHeight);
      }
    }
    if (total > SOURCE_QUALITY_MAX_COUNT) issue("withheld counts exceed the bound");

    const heights = [q.deliverableMaxHeight, withheldMax].filter((h): h is number => h !== null);
    const explained = heights.length === 0 ? null : Math.max(...heights);
    if (q.observedMaxHeight !== explained) {
      issue("observedMaxHeight must equal the tallest deliverable or withheld height");
    }
  });
export type SourceQuality = z.infer<typeof SourceQualitySchema>;

export const VideoMetadataSchema = z
  .object({
    title: z.string(),
    thumbnail: z.string().nullable(), // url() not strictly enforced for legacy metadata, but usually url
    duration: z.number().nullable(),
    source: z.string(),
    // Worker-owned strategy identity: exactly `direct` or `yt-dlp`.
    extractor: WorkerExtractorStrategySchema,
    webpageUrl: z.string(),
    formats: z.array(NormalizedFormatSchema),
    presets: z.array(QualityPresetSchema),
    capabilities: z
      .object({
        mp3: z.boolean(),
        merge: z.boolean(),
      })
      .strict(),
    // OPTIONAL, so a Worker that predates it still validates. Generic analysis
    // sends it; direct analysis does not know source quality and omits it.
    // Because this schema is strict, a control plane that predates the field
    // REJECTS a Worker that sends it: the control plane must deploy first.
    sourceQuality: SourceQualitySchema.optional(),
  })
  .strict();
export type WorkerVideoMetadata = z.infer<typeof VideoMetadataSchema>;

// --- Responses ---

export const WorkerAnalyzeSuccessSchema = z
  .object({
    success: z.literal(true),
    video: VideoMetadataSchema,
  })
  .strict();
export type WorkerAnalyzeSuccess = z.infer<typeof WorkerAnalyzeSuccessSchema>;

export const WorkerCreateJobSuccessSchema = z
  .object({
    success: z.literal(true),
    job: WorkerJobViewSchema,
  })
  .strict();
export type WorkerCreateJobSuccess = z.infer<typeof WorkerCreateJobSuccessSchema>;

export const WorkerJobStatusSuccessSchema = z
  .object({
    success: z.literal(true),
    job: WorkerJobViewSchema,
  })
  .strict();
export type WorkerJobStatusSuccess = z.infer<typeof WorkerJobStatusSuccessSchema>;

export const WorkerCancelJobSuccessSchema = z
  .object({
    success: z.literal(true),
    job: WorkerJobViewSchema,
  })
  .strict();
export type WorkerCancelJobSuccess = z.infer<typeof WorkerCancelJobSuccessSchema>;

export const WorkerDiagnosticsSuccessSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    queueDepth: z.number().int().nonnegative(),
    runningJobs: z.number().int().nonnegative(),
    maxConcurrent: z.number().int().nonnegative(),
    /**
     * Whether each media binary is present AND executes correctly.
     *
     * `ytdlp` means specifically: the EXACT pinned yt-dlp runtime this image
     * ships answered its version probe. It does not mean "some command named
     * yt-dlp exists", and — importantly — it says nothing about whether
     * generic extraction is allowed to run. That is `features.ytdlpEnabled`.
     */
    binaries: z
      .object({
        ffmpeg: z.boolean(),
        ytdlp: z.boolean(),
      })
      .strict(),
    /** Reported runtime identity. Non-secret; null when unavailable. */
    runtime: z
      .object({
        ytdlpVersion: z.string().nullable(),
      })
      .strict(),
    /**
     * APPLICATION feature state, distinct from runtime availability.
     *
     * `ytdlpEnabled` is the operator's explicit `YTDLP_ENABLED` intent. It is
     * fail-closed, and installing the runtime never sets it.
     *
     * Since Phase 10C3 it gates a path that genuinely exists: it is one of the
     * three independent conjuncts — implementation, runtime, operator intent —
     * that `/api/sites.ytdlp` requires together. The Phase-10C1 note that it
     * gated nothing was reconciled by
     * PHASE-10C4-YTDLP-PRODUCTION-ACCEPTANCE-HARNESS-001; it described the
     * Phase-10C1 source and would now read as a false statement about the
     * current one.
     */
    features: z
      .object({
        ytdlpEnabled: z.boolean(),
      })
      .strict(),
    /**
     * Safe egress is enforced OUTSIDE this container, by the media network
     * namespace, its externally owned nftables policy, the policy verifier and
     * the watchdog. The Worker holds no NET_ADMIN, cannot read the ruleset and
     * cannot alter it.
     *
     * The field therefore states WHO enforces, and deliberately offers no
     * boolean claiming the boundary is intact: the Worker cannot prove that,
     * and the retired `attested` flag — an operator-set environment variable —
     * only ever looked like proof. `policyVersion` stays null until something
     * that genuinely owns the policy publishes one.
     */
    safeEgress: z
      .object({
        enforcement: z.literal("external"),
        policyVersion: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type WorkerDiagnosticsSuccess = z.infer<typeof WorkerDiagnosticsSuccessSchema>;

export const WorkerHealthSuccessSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();
export type WorkerHealthSuccess = z.infer<typeof WorkerHealthSuccessSchema>;

// --- Type Compatibility Checks ---
// Ensure structural compatibility with existing VideoFetch media types
import type { NormalizedFormat, QualityPreset, VideoMetadata } from "../../types/media.ts";

// These will fail to compile if schemas diverge from expected Types
const _formatCheck: NormalizedFormat = {} as WorkerNormalizedFormat;
const _presetCheck: QualityPreset = {} as WorkerQualityPreset;
const _metaCheck: VideoMetadata = {} as WorkerVideoMetadata;
