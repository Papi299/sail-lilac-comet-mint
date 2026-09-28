import { ERROR_MESSAGES } from "@/lib/errors";
import {
  WORKER_RESTART_STAGE_LABEL,
  isFailedJobStageLabel,
  type FailedJobStageLabel,
} from "@/shared/worker/job-failure";
import type { JobProgress } from "@/types/job";

/**
 * MEDIA-EXECUTION-FAILURE-CLASSIFICATION-001: what the error card says about a
 * job that ended without a file.
 *
 * The message is the control plane's `error`, which is already the canonical
 * text for an allowlisted code. The heading is chosen from a closed table keyed
 * by the closed failure-stage vocabulary; any other stage label — including one
 * from an older deployment — leaves the generic heading in place.
 */

export const DEFAULT_ERROR_HEADING = "We hit a snag";

const HEADING_BY_STAGE: Readonly<Record<FailedJobStageLabel, string>> = Object.freeze({
  "Download failed": "Download failed",
  "Processing failed": "Processing failed",
  "Upload failed": "Upload failed",
  [WORKER_RESTART_STAGE_LABEL]: "Download interrupted",
});

export function errorCardHeading(
  job: Pick<JobProgress, "status" | "stageLabel"> | null,
): string {
  if (job?.status === "failed" && isFailedJobStageLabel(job.stageLabel)) {
    return HEADING_BY_STAGE[job.stageLabel];
  }
  return DEFAULT_ERROR_HEADING;
}

/** The message for a job that ended `failed` or `cancelled`. */
export function terminalJobMessage(job: Pick<JobProgress, "status" | "error">): string {
  if (job.error) return job.error;
  return job.status === "cancelled"
    ? "This download was cancelled."
    : ERROR_MESSAGES.PROCESSING_FAILED;
}
