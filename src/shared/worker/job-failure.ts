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
 * lifecycle a job failed in; the durable status it was leaving decides that —
 * or, since VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001, one of two closed
 * acquisition stops, named by the executor from its own typed provenance and
 * honoured only where it can be true.
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
 * The status-derived stage labels and the restart stage. The first three are
 * written by `failJob()` from the durable status the job was leaving; the last
 * by `recover()`. Since VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001
 * `failJob()` may also write one of the two acquisition-stop stages below, kept
 * out of this list on purpose (see `ACQUISITION_STOP_FAILED_STAGE_LABELS`).
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

/**
 * VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001: the two acquisition stops
 * whose failure carries a stage of its own, by cause.
 *
 *   inactivity   the acquisition watchdog stopped a live phase that had made no
 *                meaningful progress for its window (`DOWNLOAD_INACTIVITY_TIMEOUT`);
 *   time-limit   the acquisition's own absolute deadline (`DOWNLOAD_TIME_LIMIT`)
 *                ended it, as the first cause its seam recorded.
 *
 * The values are exactly the control plane's reserved, `TIMEOUT`-only stages
 * (`RESERVED_FAILED_JOB_STAGE_LABELS`, LD-4a), and a test binds the two tables.
 * They are deliberately NOT members of `FAILED_JOB_STAGE_LABELS`: the control
 * plane forwards those beside any code, while these may reach a browser only
 * beside `TIMEOUT`. An observation loss has no entry: an observer that could
 * not see is no evidence about the source, so it keeps the download stage.
 */
export const ACQUISITION_STOP_FAILED_STAGE_LABELS = Object.freeze({
  inactivity: "Download stalled",
  "time-limit": "Download time limit reached",
} as const);

export type AcquisitionStopCause = keyof typeof ACQUISITION_STOP_FAILED_STAGE_LABELS;

export type AcquisitionStopFailedStageLabel =
  (typeof ACQUISITION_STOP_FAILED_STAGE_LABELS)[AcquisitionStopCause];

export function isAcquisitionStopCause(value: unknown): value is AcquisitionStopCause {
  return typeof value === "string" && Object.hasOwn(ACQUISITION_STOP_FAILED_STAGE_LABELS, value);
}

/**
 * The stage a failure records. An acquisition stop's own stage only where it
 * can be true — the job is leaving `downloading`, the one status an acquisition
 * runs in, with `TIMEOUT`, the one code either stop produces — and otherwise the
 * stage of the status it is leaving (`failedJobStageLabelFor`). A stop named in
 * any other combination claims nothing.
 */
export function failedJobStageLabelForFailure(
  status: FailableWorkerJobStatus,
  errorCode: string,
  acquisitionStop: AcquisitionStopCause | undefined,
): Exclude<FailedJobStageLabel, typeof WORKER_RESTART_STAGE_LABEL> | AcquisitionStopFailedStageLabel {
  if (isAcquisitionStopCause(acquisitionStop) && status === "downloading" && errorCode === "TIMEOUT") {
    return ACQUISITION_STOP_FAILED_STAGE_LABELS[acquisitionStop];
  }
  return failedJobStageLabelFor(status);
}
