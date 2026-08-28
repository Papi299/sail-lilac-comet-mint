import { z } from "zod";
import { ERROR_MESSAGES, type ErrorCode } from "../../lib/errors.ts";
import {
  WorkerJobIdSchema,
  WorkerJobStatusSchema,
  type WorkerJobStatus,
  type WorkerJobView,
} from "../../shared/worker/contracts.ts";
import { WorkerErrorCodeSchema } from "../../shared/worker/errors.ts";

/**
 * The browser-facing job DTO.
 *
 * This is the ONLY shape that may be serialized to the browser for a job. It is
 * `.strict()`, so any field added to WorkerJobView in future is a parse failure
 * here rather than a silent leak.
 *
 * Deliberately absent:
 *  - objectKey           — server-to-server only; would be an object-store leak
 *  - safeErrorMessage    — surfaced once, as `error`
 *  - mime                — not part of the browser contract
 *  - url / formatId / principalId / local paths / worker internals
 */
export const PublicJobSchema = z
  .object({
    jobId: WorkerJobIdSchema,
    status: WorkerJobStatusSchema,
    progress: z.number().min(0).max(100).nullable(),
    stageLabel: z.string().min(1),
    downloadedBytes: z.number().int().nonnegative().nullable(),
    totalBytes: z.number().int().nonnegative().nullable(),
    speed: z.number().nonnegative().nullable(),
    eta: z.number().nonnegative().nullable(),
    error: z.string().nullable(),
    errorCode: WorkerErrorCodeSchema.nullable(),
    filename: z.string().nullable(),
    fileSize: z.number().int().nonnegative().nullable(),
    quality: z.string().nullable(),
    container: z.string().nullable(),
    title: z.string().nullable(),
    thumbnail: z.string().url().nullable(),
    source: z.string().nullable(),
    extractor: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    downloadUrl: z.string().nullable(),
  })
  .strict();

export type PublicJob = z.infer<typeof PublicJobSchema>;

/**
 * stageLabel is nullable on the Worker view but the browser progress UI needs a
 * non-null string. These fallbacks are canonical and carry no job detail.
 */
const STAGE_FALLBACK: Record<WorkerJobStatus, string> = {
  queued: "Queued",
  analyzing: "Analyzing",
  downloading: "Downloading",
  processing: "Processing",
  uploading: "Finalizing",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Terminal browser states: polling must stop when one of these is observed. */
const TERMINAL_STATUSES: ReadonlySet<WorkerJobStatus> = new Set<WorkerJobStatus>([
  "ready",
  "failed",
  "cancelled",
]);

export function isTerminalPublicStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as WorkerJobStatus);
}

/** Local, authorization-gated delivery route. Never a signed object-store URL. */
export function publicDownloadPath(jobId: string): string {
  return `/api/download/${WorkerJobIdSchema.parse(jobId)}/file`;
}

/**
 * Maps the server-to-server Worker job view onto the browser DTO.
 *
 * Fields are enumerated explicitly rather than spread, so a new Worker field can
 * never reach the browser by accident.
 */
export function toPublicJob(job: WorkerJobView, now: number): PublicJob {
  const isLiveReady = job.status === "ready" && now < job.expiresAt;

  const error =
    job.safeErrorMessage ??
    (job.errorCode ? ERROR_MESSAGES[job.errorCode as ErrorCode] : null);

  return PublicJobSchema.parse({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    stageLabel: job.stageLabel ?? STAGE_FALLBACK[job.status],
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speed: job.speed,
    eta: job.eta,
    error,
    errorCode: job.errorCode,
    filename: job.filename,
    fileSize: job.fileSize,
    quality: job.quality,
    container: job.container,
    title: job.title,
    thumbnail: job.thumbnail,
    source: job.source,
    extractor: job.extractor,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    downloadUrl: isLiveReady ? publicDownloadPath(job.jobId) : null,
  });
}
