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
    extractor: z.string().nullable(),
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
    formatId: z.string().min(1),
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

export const VideoMetadataSchema = z
  .object({
    title: z.string(),
    thumbnail: z.string().nullable(), // url() not strictly enforced for legacy metadata, but usually url
    duration: z.number().nullable(),
    source: z.string(),
    extractor: z.string(),
    webpageUrl: z.string(),
    formats: z.array(NormalizedFormatSchema),
    presets: z.array(QualityPresetSchema),
    capabilities: z
      .object({
        mp3: z.boolean(),
        merge: z.boolean(),
      })
      .strict(),
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
    binaries: z
      .object({
        ffmpeg: z.boolean(),
        ytdlp: z.boolean(),
      })
      .strict(),
    safeEgress: z
      .object({
        attested: z.boolean(),
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
