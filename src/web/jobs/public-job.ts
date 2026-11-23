import { z } from "zod";
import { ERROR_MESSAGES } from "../../lib/errors.ts";
import {
  WorkerJobIdSchema,
  WorkerJobStatusSchema,
  type WorkerJobStatus,
  type WorkerJobView,
} from "../../shared/worker/contracts.ts";
import { WorkerErrorCodeSchema, type WorkerErrorCode } from "../../shared/worker/errors.ts";
import { WORKER_RESTART_SAFE_MESSAGE } from "../../shared/worker/job-failure.ts";
import {
  WORKER_JOB_ACTIVITY_STATES,
  WORKER_JOB_ACTIVITY_STATUS,
  WorkerJobActivityLimitSecondsSchema,
  WorkerJobActivitySecondsSchema,
  jobActivityConsistencyIssues,
} from "../../shared/worker/job-activity.ts";
import { publicFailedStageLabel, timeoutMessageForStage } from "../../shared/worker/job-outcome.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the browser's
 * view of a job's live acquisition activity. Its four fields are enumerated
 * HERE, independently of the Worker's schema, and copied one by one in
 * `publicActivity`, so a field the Worker adds later can never reach the
 * browser without a change to this file. One closed state and three bounded
 * whole-second counts (see `job-activity.ts`): no text, no URL, no path, no
 * key.
 */
export const PublicJobActivitySchema = z
  .object({
    state: z.enum(WORKER_JOB_ACTIVITY_STATES),
    elapsedSeconds: WorkerJobActivitySecondsSchema.nullable(),
    limitSeconds: WorkerJobActivityLimitSecondsSchema.nullable(),
    idleSeconds: WorkerJobActivitySecondsSchema.nullable(),
  })
  .strict()
  .superRefine((a, ctx) => {
    for (const message of jobActivityConsistencyIssues(a)) ctx.addIssue({ code: "custom", message });
  });

export type PublicJobActivity = z.infer<typeof PublicJobActivitySchema>;

/**
 * The browser-facing job DTO.
 *
 * This is the ONLY shape that may be serialized to the browser for a job. It is
 * `.strict()`, so any field added to WorkerJobView in future is a parse failure
 * here rather than a silent leak.
 *
 * `activity` (LD-4b) is always present: the live acquisition activity while
 * the job is downloading and the Worker published one, otherwise `null` — a
 * Worker that publishes none (any Worker before LD-4b) gives `null` too.
 *
 * Deliberately absent:
 *  - objectKey           — server-to-server only; would be an object-store leak
 *  - safeErrorMessage    — never forwarded; `error` is derived from the
 *                          allowlisted code (see `publicJobError`)
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
    activity: PublicJobActivitySchema.nullable(),
  })
  .strict()
  .refine((job) => job.activity === null || job.status === WORKER_JOB_ACTIVITY_STATUS, {
    message: "activity is live only while the job is downloading",
  });

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
  const { errorCode, error } = publicJobError(job);

  return PublicJobSchema.parse({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    stageLabel: publicStageLabel(job),
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speed: job.speed,
    eta: job.eta,
    error,
    errorCode,
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
    activity: publicActivity(job),
  });
}

/**
 * LD-4b: the live activity, field by field, only for a downloading job. An
 * absent field (a Worker that publishes none) and `null` (nothing observed)
 * are both `null` to the browser: neither says anything about the source.
 */
function publicActivity(job: Pick<WorkerJobView, "status" | "activity">): PublicJobActivity | null {
  const activity = job.activity;
  if (activity === undefined || activity === null || job.status !== WORKER_JOB_ACTIVITY_STATUS) return null;
  return {
    state: activity.state,
    elapsedSeconds: activity.elapsedSeconds,
    limitSeconds: activity.limitSeconds,
    idleSeconds: activity.idleSeconds,
  };
}

/**
 * MEDIA-EXECUTION-FAILURE-CLASSIFICATION-001: the browser's error code and
 * message, decided HERE from the allowlisted code rather than copied from the
 * Worker.
 *
 * `errorCode` has already passed the shared allowlist in `WorkerJobViewSchema`,
 * so an unknown code never reaches this function: the whole view is refused and
 * the route answers the canonical `PROCESSING_FAILED` instead. The Worker's
 * `safeErrorMessage`, however, is an arbitrary string on the wire, and a
 * "sanitized" label on the far side of a trust boundary is not a guarantee. It
 * is therefore never forwarded. The message is the canonical one for the code,
 * except for the ONE non-canonical pair the Worker is known to write — the
 * restart recovery — which is matched exactly and forwarded only as the shared
 * constant.
 *
 * A failed job that somehow carries no code is still a failure, so it gets the
 * canonical fallback rather than no explanation at all.
 */
function publicJobError(
  job: Pick<WorkerJobView, "status" | "errorCode" | "safeErrorMessage" | "stageLabel">,
): { errorCode: WorkerErrorCode | null; error: string | null } {
  const errorCode: WorkerErrorCode | null =
    job.errorCode ?? (job.status === "failed" ? "PROCESSING_FAILED" : null);
  if (errorCode === null) return { errorCode: null, error: null };
  if (errorCode === "PROCESSING_FAILED" && job.safeErrorMessage === WORKER_RESTART_SAFE_MESSAGE) {
    return { errorCode, error: WORKER_RESTART_SAFE_MESSAGE };
  }
  // LD-4a: a failed TIMEOUT says WHICH stage ran out of time, from the closed
  // stage the Worker recorded (job-outcome.ts), instead of the canonical
  // "took too long to process", which is false for a download that hit its
  // time limit. The code itself is unchanged.
  if (errorCode === "TIMEOUT" && job.status === "failed") {
    return { errorCode, error: timeoutMessageForStage(publicFailedStageLabel(job.stageLabel, errorCode)) };
  }
  return { errorCode, error: ERROR_MESSAGES[errorCode] };
}

/**
 * A failed job's stage label is forwarded only when it is one of the closed
 * failure stages the Worker writes (`FAILED_JOB_STAGE_LABELS`), or — with
 * `TIMEOUT` only — one of the two stages reserved for the acquisition watchdog
 * (`RESERVED_FAILED_JOB_STAGE_LABELS`, written by no Worker yet). Anything else
 * — a row failed by an older Worker still holding its last progress label, for
 * one — becomes the canonical "Failed". Every other status keeps the Worker's
 * progress label as before.
 */
function publicStageLabel(job: Pick<WorkerJobView, "status" | "stageLabel" | "errorCode">): string {
  if (job.status === "failed") {
    return publicFailedStageLabel(job.stageLabel, job.errorCode) ?? STAGE_FALLBACK.failed;
  }
  return job.stageLabel ?? STAGE_FALLBACK[job.status];
}
