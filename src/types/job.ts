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
