/* eslint-disable no-control-regex */
import { z } from "zod";
import {
  type WorkerJobView,
  type WorkerCreateJobRequest,
  WorkerJobIdSchema,
  WorkerJobStatusSchema,
  WorkerObjectKeySchema
} from "../../shared/worker/contracts.ts";
import { WorkerErrorCodeSchema } from "../../shared/worker/errors.ts";

/**
 * Internal durable worker job schema.
 * Validates raw SQLite rows into trusted execution state.
 * Enforces objectKey/status ownership invariant at the storage boundary.
 */
export const DurableWorkerJobSchema = z.object({
  jobId: WorkerJobIdSchema,
  url: z.string().url().max(2048).refine(val => val.startsWith("http://") || val.startsWith("https://")),
  formatId: z.string().min(1),
  principalId: z.literal("private-access-user"),

  status: WorkerJobStatusSchema,

  progress: z.number().min(0).max(100).nullable(),
  stageLabel: z.string().min(1).nullable(),
  downloadedBytes: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  speed: z.number().nonnegative().nullable(),
  eta: z.number().nonnegative().nullable(),

  errorCode: WorkerErrorCodeSchema.nullable(),
  safeErrorMessage: z.string().nullable(),

  filename: z.string().nullable(),
  fileSize: z.number().int().nonnegative().nullable(),
  mime: z.string().nullable(),
  quality: z.string().nullable(),
  container: z.string().nullable(),

  title: z.string().nullable(),
  thumbnail: z.string().url().nullable(),
  source: z.string().nullable(),
  extractor: z.string().nullable(),

  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),

  objectKey: WorkerObjectKeySchema.nullable(),

  startedAt: z.number().int().nonnegative().nullable(),
  finishedAt: z.number().int().nonnegative().nullable(),
}).strict().superRefine((data, ctx) => {
  if (data.status === "ready") {
    if (data.objectKey === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ready job must have a non-null objectKey",
        path: ["objectKey"],
      });
    } else {
      // objectKey format: videofetch/jobs/<jobId>/<hash32>
      const expectedPrefix = `videofetch/jobs/${data.jobId}/`;
      if (!data.objectKey.startsWith(expectedPrefix)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "objectKey embedded job ID must equal jobId",
          path: ["objectKey"],
        });
      }
    }
  } else {
    if (data.objectKey !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "non-ready job must have null objectKey",
        path: ["objectKey"],
      });
    }
  }
});

export type DurableWorkerJob = z.infer<typeof DurableWorkerJobSchema>;

export type CreateJobResult =
  | { type: "created"; job: WorkerJobView }
  | { type: "existing"; job: WorkerJobView }
  | { type: "conflict" }
  | { type: "expired" };

export type CancelJobResult =
  | { type: "cancelled"; job: WorkerJobView }
  | { type: "unchanged"; job: WorkerJobView }
  | { type: "not_found" };


export const CompleteAnalysisInputSchema = z.object({
  title: z.string().min(1).max(1024).regex(/^[^\u0000-\u001F\u007F]*$/, "no control characters allowed"),
  thumbnail: z.string().url().nullable(),
  source: z.string().min(1).max(2048).regex(/^[^\u0000-\u001F\u007F]*$/, "no control characters allowed"),
  extractor: z.string().min(1).max(255).regex(/^[^\u0000-\u001F\u007F]*$/, "no control characters allowed")
}).strict();

export type CompleteAnalysisInput = z.infer<typeof CompleteAnalysisInputSchema>;

/**
 * §15: Progress mutations are only ever legal against an ACTIVE execution
 * state. Terminal states (ready/failed/cancelled) and `queued` must never be
 * addressable as a same-state progress-mutation target, so they are excluded
 * from the type system rather than merely rejected at runtime.
 */
export const WorkerExecutionProgressStatusSchema = z.enum([
  "analyzing",
  "downloading",
  "processing",
  "uploading",
]);

export type WorkerExecutionProgressStatus = z.infer<typeof WorkerExecutionProgressStatusSchema>;

export const UpdateProgressInputSchema = z.object({
  progress: z.number().min(0).max(100).nullable(),
  downloadedBytes: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  speed: z.number().nonnegative().nullable(),
  eta: z.number().nonnegative().nullable(),
  stageLabel: z.string().min(1).max(255).regex(/^[^\u0000-\u001F\u007F]*$/, "no control characters allowed"),
}).strict();

export type UpdateProgressInput = z.infer<typeof UpdateProgressInputSchema>;

export type ExecutionMutationResult =
  | { type: "updated"; job: WorkerJobView }
  | { type: "terminal"; job: WorkerJobView }
  | { type: "state_conflict"; job: WorkerJobView }
  | { type: "not_found" };

export const CommitReadyInputSchema = z.object({
  objectKey: WorkerObjectKeySchema,
  filename: z.string().min(1).max(1024).regex(/^[^\u0000-\u001F\u007F]+$/, "no control characters allowed"),
  fileSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mime: z.string().min(1).max(255).regex(/^[^\u0000-\u001F\u007F]+$/, "no control characters allowed"),
  quality: z.string().max(255).regex(/^[^\u0000-\u001F\u007F]+$/, "no control characters allowed").nullable(),
  container: z.string().max(255).regex(/^[^\u0000-\u001F\u007F]+$/, "no control characters allowed").nullable(),
}).strict();

export type CommitReadyInput = z.infer<typeof CommitReadyInputSchema>;

export type CommitReadyResult = 
  | { type: "ready"; job: WorkerJobView }
  | { type: "terminal"; job: WorkerJobView }
  | { type: "not_uploading"; job: WorkerJobView }
  | { type: "not_found" };

export const ExpiredReadyObjectSchema = z.object({
  jobId: WorkerJobIdSchema,
  objectKey: WorkerObjectKeySchema,
  expiresAt: z.number().int().nonnegative(),
}).strict().superRefine((data, ctx) => {
  const expectedPrefix = `videofetch/jobs/${data.jobId}/`;
  if (!data.objectKey.startsWith(expectedPrefix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "objectKey embedded job ID must equal jobId",
      path: ["objectKey"],
    });
  }
});

export type ExpiredReadyObject = z.infer<typeof ExpiredReadyObjectSchema>;

export interface WorkerJobStore {
  createJob(
    request: WorkerCreateJobRequest,
    idempotencyKey: string
  ): CreateJobResult;

  listQueuedJobs(limit: number): DurableWorkerJob[];

  claimNextQueuedJob(): DurableWorkerJob | null;

  cancelJob(jobId: string): CancelJobResult;
  
  failJob(jobId: string, errorCode: string, errorMessage: string): boolean;

  getJob(jobId: string): WorkerJobView | null;


  completeAnalysis(jobId: string, input: CompleteAnalysisInput): ExecutionMutationResult;
  updateExecutionProgress(jobId: string, expectedStatus: WorkerExecutionProgressStatus, input: UpdateProgressInput): ExecutionMutationResult;
  beginProcessing(jobId: string): ExecutionMutationResult;
  beginUploading(jobId: string): ExecutionMutationResult;
  commitReadyFromUploading(jobId: string, input: CommitReadyInput): CommitReadyResult;

  listExpiredReadyObjects(limit: number): ExpiredReadyObject[];

  /**
   * Removes the durable job metadata for ONE already-expired ready job whose
   * stored object has just been deleted from the object store.
   *
   * This exists solely so successful expiration cleanup stops re-issuing
   * DeleteObject for the same key forever. It is deliberately the narrowest
   * possible operation:
   *  - the row must currently be `ready`;
   *  - `objectKey` must match EXACTLY (no prefix, no pattern);
   *  - `expiresAt` must already have passed;
   *  - exactly the one `worker_jobs` row is removed, never anything else.
   *
   * The retained idempotency record/tombstone is NEVER removed here: a client
   * replaying the original Idempotency-Key must not be able to mint a second
   * job merely because the expired job's metadata was cleaned up.
   *
   * @returns true when the single row was removed, false when no row matched.
   */
  deleteExpiredReadyMetadata(jobId: string, expectedObjectKey: string): boolean;

  recover(): void;

  cleanupExpiredIdempotencyRecords(): number;
}
