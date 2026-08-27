import type {
  WorkerJobView,
  WorkerCreateJobRequest
} from "../../shared/worker/contracts.ts";

export type CreateJobResult =
  | { type: "created"; job: WorkerJobView }
  | { type: "existing"; job: WorkerJobView }
  | { type: "conflict" }
  | { type: "expired" };

export interface WorkerJobStore {
  createJob(
    request: WorkerCreateJobRequest,
    idempotencyKey: string
  ): CreateJobResult;

  listQueuedJobs(limit: number): WorkerJobView[];

  claimNextQueuedJob(): WorkerJobView | null;

  cancelJob(jobId: string): boolean;
  
  failJob(jobId: string, errorCode: string, errorMessage: string): boolean;

  getJob(jobId: string): WorkerJobView | null;

  recover(): void;

  cleanupIdempotency(): void;
}
