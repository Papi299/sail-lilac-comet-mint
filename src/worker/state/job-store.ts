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

export const CommitReadyInputSchema = z.object({
  objectKey: WorkerObjectKeySchema,
  filename: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
  mime: z.string().min(1).regex(/^[^\r\n]+$/, "no control characters allowed"),
  quality: z.string().nullable(),
  container: z.string().nullable(),
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

  commitReadyFromUploading(jobId: string, input: CommitReadyInput): CommitReadyResult;

  listExpiredReadyObjects(limit: number): ExpiredReadyObject[];

  recover(): void;

  cleanupExpiredIdempotencyRecords(): number;
}
