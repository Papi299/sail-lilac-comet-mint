import {
  FAILED_JOB_STAGE_LABELS,
  WORKER_RESTART_STAGE_LABEL,
  type FailedJobStageLabel,
} from "./job-failure.ts";

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: the closed contract
 * for how a job's ENDING is presented.
 *
 * Dependency-free, like `job-failure.ts`: the control plane chooses a failed
 * job's message from it, and the browser chooses the heading and the next
 * actions from it, without either pulling in zod or a server module.
 *
 * Two lists, deliberately separate:
 *
 *  - `FAILED_JOB_STAGE_LABELS` (job-failure.ts) is what a Worker WRITES today.
 *    It is pinned by the Worker's own tests and is not changed here.
 *  - `RESERVED_FAILED_JOB_STAGE_LABELS` is what a FUTURE Worker will write once
 *    the acquisition watchdog exists (LD-3b, LD-3c). No Worker in this
 *    repository writes either label, and no module under `src/worker` imports
 *    this file; a structural test pins both facts. The control plane recognises
 *    them now so that the Worker that writes them can be deployed AFTER it, in
 *    the approved Vercel-first order. They carry no new error code: both arrive
 *    as `TIMEOUT`, and a reserved label with any other code is not forwarded.
 *
 * Nothing here is ever derived from an exception, a subprocess stream or an
 * upstream response. Every string a person can see is written below.
 */

/** The acquisition-inactivity watchdog stopped a download (LD-3b / LD-3c). */
export const DOWNLOAD_STALLED_STAGE_LABEL = "Download stalled";

/** The absolute acquisition time limit stopped a download (LD-3b / LD-3c). */
export const DOWNLOAD_TIME_LIMIT_STAGE_LABEL = "Download time limit reached";

export const RESERVED_FAILED_JOB_STAGE_LABELS = [
  DOWNLOAD_STALLED_STAGE_LABEL,
  DOWNLOAD_TIME_LIMIT_STAGE_LABEL,
] as const;

export type ReservedFailedJobStageLabel = (typeof RESERVED_FAILED_JOB_STAGE_LABELS)[number];

/** Every failed-job stage the control plane forwards and the browser recognises. */
export const PUBLIC_FAILED_JOB_STAGE_LABELS = [
  ...FAILED_JOB_STAGE_LABELS,
  ...RESERVED_FAILED_JOB_STAGE_LABELS,
] as const;

export type PublicFailedJobStageLabel = FailedJobStageLabel | ReservedFailedJobStageLabel;

const WRITTEN_STAGE_SET: ReadonlySet<string> = new Set<string>(FAILED_JOB_STAGE_LABELS);
const RESERVED_STAGE_SET: ReadonlySet<string> = new Set<string>(RESERVED_FAILED_JOB_STAGE_LABELS);

export function isReservedFailedJobStageLabel(value: unknown): value is ReservedFailedJobStageLabel {
  return typeof value === "string" && RESERVED_STAGE_SET.has(value);
}

export function isPublicFailedJobStageLabel(value: unknown): value is PublicFailedJobStageLabel {
  return typeof value === "string" && (WRITTEN_STAGE_SET.has(value) || RESERVED_STAGE_SET.has(value));
}

/**
 * The stage a control plane forwards for a FAILED job, or null for none.
 *
 * A label a Worker writes today is forwarded with any code, as before. A
 * reserved label is forwarded only with `TIMEOUT`: the watchdog that will write
 * it reports through that code and no other, so anything else is not this
 * contract and is treated like any unknown label.
 */
export function publicFailedStageLabel(
  stageLabel: unknown,
  errorCode: string | null,
): PublicFailedJobStageLabel | null {
  if (typeof stageLabel !== "string") return null;
  if (WRITTEN_STAGE_SET.has(stageLabel)) return stageLabel as FailedJobStageLabel;
  if (RESERVED_STAGE_SET.has(stageLabel) && errorCode === "TIMEOUT") {
    return stageLabel as ReservedFailedJobStageLabel;
  }
  return null;
}

/**
 * The message for a failed `TIMEOUT` job, by stage.
 *
 * The canonical `TIMEOUT` sentence ("The video took too long to process.")
 * describes processing, but most timeouts happen while downloading, and a slow
 * source that keeps sending until the absolute download limit is not a
 * processing problem at all. The control plane therefore picks the sentence by
 * the stage the Worker recorded.
 *
 * `Download failed` with `TIMEOUT` covers, until LD-3b/LD-3c split them out, the
 * absolute download time limit, yt-dlp's own socket timeout, an analysis
 * timeout and the execution-lifetime backstop. Its sentence is therefore true
 * of every one of them and claims no cause.
 */
export const DOWNLOAD_TIMEOUT_MESSAGE = "The download didn't finish in time.";

const TIMEOUT_MESSAGE_BY_STAGE: Readonly<Record<PublicFailedJobStageLabel, string>> = Object.freeze({
  "Download failed": DOWNLOAD_TIMEOUT_MESSAGE,
  "Processing failed": "Processing took too long.",
  "Upload failed": "Uploading the finished file took too long.",
  // `recover()` writes PROCESSING_FAILED with this stage, never TIMEOUT; a
  // TIMEOUT here would be a contradiction, so it claims nothing more.
  [WORKER_RESTART_STAGE_LABEL]: DOWNLOAD_TIMEOUT_MESSAGE,
  [DOWNLOAD_STALLED_STAGE_LABEL]: "The source stopped sending data, so VideoFetch stopped waiting.",
  [DOWNLOAD_TIME_LIMIT_STAGE_LABEL]:
    "The download was still running when it reached VideoFetch's maximum download time.",
});

export function timeoutMessageForStage(stage: PublicFailedJobStageLabel | null): string {
  return stage === null ? DOWNLOAD_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE_BY_STAGE[stage];
}

/**
 * How a job ended, as a closed set. `null` means the job has not ended, or
 * ended with a file (`ready`).
 *
 * A lost status connection, an unreachable Worker and an unconfirmed
 * cancellation are NOT here: they describe the browser's view of a job, never
 * the job, and a job is never presented as ended because of them.
 *
 *   cancelled            the job was cancelled before it finished
 *   download_time_limit  the absolute download time limit stopped it (reserved: LD-3b/3c)
 *   download_stalled     the source stopped sending data (reserved: LD-3b/3c)
 *   download_timeout     a timeout while getting the video, cause not separated
 *   processing_timeout   a processing step took too long
 *   upload_timeout       uploading the finished file took too long
 *   worker_restarted     the Worker stopped or restarted before the job completed
 *   source_failure       the source could not be reached, read or used
 *   limit_exceeded       the video is over a size or duration limit
 *   unclassified         any other failure
 */
export const JOB_OUTCOME_KINDS = [
  "cancelled",
  "download_time_limit",
  "download_stalled",
  "download_timeout",
  "processing_timeout",
  "upload_timeout",
  "worker_restarted",
  "source_failure",
  "limit_exceeded",
  "unclassified",
] as const;

export type JobOutcomeKind = (typeof JOB_OUTCOME_KINDS)[number];

const SOURCE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "NETWORK_ERROR",
  "VIDEO_UNAVAILABLE",
  "EXTRACTION_FAILED",
  "UNSUPPORTED_SITE",
  "ANALYSIS_FAILED",
  "FORMAT_UNAVAILABLE",
]);

const LIMIT_CODES: ReadonlySet<string> = new Set(["TOO_LARGE", "TOO_LONG"]);

const TIMEOUT_OUTCOME_BY_STAGE: Readonly<Record<PublicFailedJobStageLabel, JobOutcomeKind>> = Object.freeze({
  "Download failed": "download_timeout",
  "Processing failed": "processing_timeout",
  "Upload failed": "upload_timeout",
  [WORKER_RESTART_STAGE_LABEL]: "worker_restarted",
  [DOWNLOAD_STALLED_STAGE_LABEL]: "download_stalled",
  [DOWNLOAD_TIME_LIMIT_STAGE_LABEL]: "download_time_limit",
});

/**
 * Classifies a job's ending from its status, its allowlisted code and its
 * stage label only — the fields the browser receives — never from message
 * text. An unrecognised stage claims no stage.
 */
export function classifyJobOutcome(job: {
  status: string;
  errorCode: string | null;
  stageLabel: string | null;
}): JobOutcomeKind | null {
  if (job.status === "cancelled") return "cancelled";
  if (job.status !== "failed") return null;
  const stage = publicFailedStageLabel(job.stageLabel, job.errorCode);
  if (stage === WORKER_RESTART_STAGE_LABEL) return "worker_restarted";
  if (job.errorCode === "TIMEOUT") {
    return stage === null ? "unclassified" : TIMEOUT_OUTCOME_BY_STAGE[stage];
  }
  if (job.errorCode !== null && SOURCE_FAILURE_CODES.has(job.errorCode)) return "source_failure";
  if (job.errorCode !== null && LIMIT_CODES.has(job.errorCode)) return "limit_exceeded";
  return "unclassified";
}
