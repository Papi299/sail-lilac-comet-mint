import type { WorkerJobStatus } from "./contracts.ts";

/**
 * MEDIA-EXECUTION-FAILURE-CLASSIFICATION-001: the closed, VideoFetch-generated
 * context a FAILED job may carry beyond its error code.
 *
 * Deliberately a dependency-free module (the one import is type-only). The
 * Worker writes these values, the control plane forwards only these values,
 * and the browser renders only these values, so all three must agree on one
 * definition without the browser bundle pulling in zod or a server module.
 *
 * Nothing here is ever derived from an exception, a subprocess stream or an
 * upstream response. A stage label says WHICH phase of the Worker's own
 * lifecycle a job failed in; the durable status it was leaving decides that.
 */

/**
 * The one safe message the Worker stores that is NOT its code's canonical
 * `ERROR_MESSAGES` entry. `store.recover()` writes it, with
 * `PROCESSING_FAILED`, for a job a previous Worker process left active
 * (PHASE-10D-WORKER-RESTART-RECOVERY-DETERMINISM-001).
 */
export const WORKER_RESTART_SAFE_MESSAGE = "Worker restarted before the job completed.";

/** The stage label `store.recover()` writes beside that message. */
export const WORKER_RESTART_STAGE_LABEL = "Worker restarted";

/**
 * Every stage label a failed job may carry. The first three are written by
 * `failJob()` from the durable status the job was leaving; the last by
 * `recover()`.
 */
export const FAILED_JOB_STAGE_LABELS = [
  "Download failed",
  "Processing failed",
  "Upload failed",
  WORKER_RESTART_STAGE_LABEL,
] as const;

export type FailedJobStageLabel = (typeof FAILED_JOB_STAGE_LABELS)[number];

/** The durable statuses `failJob()` may leave. */
export type FailableWorkerJobStatus = Extract<
  WorkerJobStatus,
  "queued" | "analyzing" | "downloading" | "processing" | "uploading"
>;

/**
 * The failure stage for the status a job was in when it failed.
 *
 * `queued` and `analyzing` count as the download: a job re-analyzes its own
 * URL at execution time before it acquires anything, and to the person who
 * asked for it that is all part of getting the video. Workspace preflight runs
 * while the job is `downloading`, output validation while it is `processing`,
 * and the object-store write and ready commit while it is `uploading`.
 */
const STAGE_BY_STATUS: Readonly<
  Record<FailableWorkerJobStatus, Exclude<FailedJobStageLabel, typeof WORKER_RESTART_STAGE_LABEL>>
> = Object.freeze({
  queued: "Download failed",
  analyzing: "Download failed",
  downloading: "Download failed",
  processing: "Processing failed",
  uploading: "Upload failed",
});

export function failedJobStageLabelFor(
  status: FailableWorkerJobStatus,
): Exclude<FailedJobStageLabel, typeof WORKER_RESTART_STAGE_LABEL> {
  return STAGE_BY_STATUS[status];
}

const FAILED_JOB_STAGE_LABEL_SET: ReadonlySet<string> = new Set<string>(FAILED_JOB_STAGE_LABELS);

export function isFailedJobStageLabel(value: unknown): value is FailedJobStageLabel {
  return typeof value === "string" && FAILED_JOB_STAGE_LABEL_SET.has(value);
}
