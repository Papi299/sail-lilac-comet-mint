import type { WorkerJobActivityState } from "@/shared/worker/job-activity";

/**
 * Browser-facing job status.
 *
 * `uploading` and `cancelled` are Worker states and must be handled as
 * first-class values, not as unknown. `merging` / `converting` remain only
 * because the legacy in-process stack still declares them; the Worker adapter
 * never produces either.
 */
export type JobStatusName =
  | "queued"
  | "analyzing"
  | "downloading"
  | "processing"
  | "uploading"
  | "merging"
  | "converting"
  | "ready"
  | "failed"
  | "cancelled";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: a job's live
 * acquisition activity, as the control plane's DTO states it
 * (`PublicJobActivitySchema`): one closed state and three bounded whole-second
 * counts, only while the job is downloading.
 */
export type JobActivityState = WorkerJobActivityState;

export type JobActivity = {
  state: JobActivityState;
  elapsedSeconds: number | null;
  limitSeconds: number | null;
  idleSeconds: number | null;
};

export type JobProgress = {
  status: JobStatusName;
  progress: number | null;
  stageLabel: string;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speed: number | null;
  eta: number | null;
  error: string | null;
  errorCode: string | null;
  filename: string | null;
  fileSize: number | null;
  quality: string | null;
  container: string | null;
  title: string | null;
  thumbnail: string | null;
  source: string | null;
  extractor: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  downloadUrl: string | null;
  /**
   * LD-4b. Optional: a page loaded from a control plane that predates the
   * field may still receive a status without it, and the legacy in-process
   * stack never sets it. Absent and `null` mean the same: nothing observed.
   */
  activity?: JobActivity | null;
};

export type JobRecord = JobProgress & {
  id: string;
  url: string;
  formatId: string;
  principalId: string;
  outputPath: string | null;
  outputMime: string | null;
  workDir: string;
  startedAt: number | null;
  finishedAt: number | null;
};
