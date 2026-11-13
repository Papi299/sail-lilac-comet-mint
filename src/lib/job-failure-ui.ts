import { ERROR_MESSAGES } from "@/lib/errors";
import { WORKER_RESTART_STAGE_LABEL } from "@/shared/worker/job-failure";
import {
  DOWNLOAD_STALLED_STAGE_LABEL,
  DOWNLOAD_TIME_LIMIT_STAGE_LABEL,
  classifyJobOutcome,
  publicFailedStageLabel,
  type JobOutcomeKind,
  type PublicFailedJobStageLabel,
} from "@/shared/worker/job-outcome";
import type { JobProgress } from "@/types/job";

/**
 * MEDIA-EXECUTION-FAILURE-CLASSIFICATION-001: what the error card says about a
 * job that ended without a file.
 *
 * The message is the control plane's `error`, which is already the canonical
 * text for an allowlisted code (for `TIMEOUT`, the text for its stage). The
 * heading is chosen from a closed table keyed by the closed failure-stage
 * vocabulary; any other stage label — including one from an older deployment —
 * leaves the generic heading in place.
 *
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001 adds the two stages
 * reserved for the acquisition watchdog (shown only once a Worker writes them,
 * with `TIMEOUT`) and a heading of its own for a cancelled job, which used to
 * borrow the generic one.
 */

export const DEFAULT_ERROR_HEADING = "We hit a snag";

export const CANCELLED_HEADING = "Download cancelled";

const HEADING_BY_STAGE: Readonly<Record<PublicFailedJobStageLabel, string>> = Object.freeze({
  "Download failed": "Download failed",
  "Processing failed": "Processing failed",
  "Upload failed": "Upload failed",
  [WORKER_RESTART_STAGE_LABEL]: "Download interrupted",
  [DOWNLOAD_STALLED_STAGE_LABEL]: "Download stalled",
  [DOWNLOAD_TIME_LIMIT_STAGE_LABEL]: "Time limit reached",
});

export function errorCardHeading(
  job: Pick<JobProgress, "status" | "stageLabel" | "errorCode"> | null,
): string {
  if (job?.status === "cancelled") return CANCELLED_HEADING;
  if (job?.status === "failed") {
    const stage = publicFailedStageLabel(job.stageLabel, job.errorCode);
    if (stage !== null) return HEADING_BY_STAGE[stage];
  }
  return DEFAULT_ERROR_HEADING;
}

/**
 * The second action an ended job offers beside "Start over": return to the
 * quality choice for the same video. It never sends anything by itself; the
 * person presses Download again, which starts a NEW job from the beginning.
 * Nothing is resumed. For a time limit or a size limit the same choice is
 * worded as picking another quality, since the same one would likely end the
 * same way.
 *
 * Null when the page shows no job outcome: an analysis error, or a status
 * answer that ended polling (unknown, expired, access) — those keep "Start over"
 * only, because the job itself is not known to have ended.
 */
export type JobOutcomeRetry = { label: string; hint: string };

export const TRY_AGAIN_LABEL = "Try again";
export const CHOOSE_ANOTHER_QUALITY_LABEL = "Choose another quality";
export const FRESH_START_HINT = "A new download starts from the beginning.";

const CHOOSE_ANOTHER_QUALITY: ReadonlySet<JobOutcomeKind> = new Set<JobOutcomeKind>([
  "download_time_limit",
  "limit_exceeded",
]);

export function jobOutcomeRetry(
  job: Pick<JobProgress, "status" | "stageLabel" | "errorCode"> | null,
): JobOutcomeRetry | null {
  if (!job) return null;
  const outcome = classifyJobOutcome(job);
  if (outcome === null) return null;
  return {
    label: CHOOSE_ANOTHER_QUALITY.has(outcome) ? CHOOSE_ANOTHER_QUALITY_LABEL : TRY_AGAIN_LABEL,
    hint: FRESH_START_HINT,
  };
}

/** The message for a job that ended `failed` or `cancelled`. */
export function terminalJobMessage(job: Pick<JobProgress, "status" | "error">): string {
  if (job.error) return job.error;
  return job.status === "cancelled"
    ? "This download was cancelled."
    : ERROR_MESSAGES.PROCESSING_FAILED;
}
