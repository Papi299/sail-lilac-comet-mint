/* eslint-disable no-control-regex */
import { z } from "zod";
import type { WorkerJobStore } from "../state/job-store.ts";
import { WorkerJobIdSchema, type WorkerJobView } from "../../shared/worker/contracts.ts";
import { ObjectStorePutInputSchema, ObjectStoreHeadSchema, type ObjectStoreWriter, type ObjectStorePutInput, type ObjectStoreHead } from "./writer.ts";
import { generateWorkerObjectKey } from "./object-key.ts";
import { buildAttachmentContentDisposition } from "../../lib/filenames.ts";

export type FinalizeUploadInput = {
  jobId: string;
  store: WorkerJobStore;
  writer: ObjectStoreWriter;
  body: AsyncIterable<Uint8Array>;
  filename: string;
  fileSize: number;
  mime: string;
  quality: string | null;
  container: string | null;
  randomSource?: () => Uint8Array;
};

export type StorageFailureCode =
  | "invalid_input"
  | "put_failed"
  | "head_failed"
  | "verification_failed"
  | "ready_commit_failed";

export type CleanupOutcome = "deleted" | "failed" | "not_needed";

export type JobStateConflictReason = 
  | "missing"
  | "cancelled"
  | "failed"
  | "ready"
  | "not_uploading";

export type FinalizeUploadResult =
  | { type: "ready"; job: WorkerJobView }
  | { type: "storage_failure"; code: StorageFailureCode; cleanup: CleanupOutcome }
  | { type: "job_state_conflict"; reason: JobStateConflictReason; cleanup: CleanupOutcome }
  /**
   * LD-2a: the upload completed after the job's execution lifetime ended. The
   * ready commit refused it, the uploaded object was deleted by exact key, and
   * the job is still `uploading` — no other writer has claimed it, so the
   * caller must fail it.
   */
  | { type: "lifetime_expired"; cleanup: CleanupOutcome };

async function cleanupUploadedObject(writer: ObjectStoreWriter, objectKey: string): Promise<CleanupOutcome> {
  try {
    await writer.delete(objectKey);
    return "deleted";
  } catch {
    return "failed";
  }
}

function mapJobStatusToConflictReason(status: string): JobStateConflictReason {
  switch (status) {
    case "ready": return "ready";
    case "cancelled": return "cancelled";
    case "failed": return "failed";
    case "queued":
    case "analyzing":
    case "downloading":
    case "processing":
      return "not_uploading";
    default:
      return "not_uploading";
  }
}

export async function finalizeJobUpload(input: FinalizeUploadInput): Promise<FinalizeUploadResult> {
  const { jobId, store, writer, body, filename, fileSize, mime, quality, container, randomSource } = input;

  // 1. Validate auxiliary inputs
  try {
    WorkerJobIdSchema.parse(jobId);
    z.string().min(1).max(1024).regex(/^[^\x00-\x1F\x7F]+$/).parse(filename);
    z.string().max(255).regex(/^[^\x00-\x1F\x7F]+$/).nullable().parse(quality);
    z.string().max(255).regex(/^[^\x00-\x1F\x7F]+$/).nullable().parse(container);
    if (!body || typeof (body as any)[Symbol.asyncIterator] !== "function") {
      throw new Error("invalid body");
    }
  } catch {
    return { type: "storage_failure", code: "invalid_input", cleanup: "not_needed" };
  }

  // 1b. Verify job is uploading
  const initialJob = store.getJob(jobId);
  if (!initialJob) {
    return { type: "job_state_conflict", reason: "missing", cleanup: "not_needed" };
  }
  if (initialJob.status !== "uploading") {
    return { type: "job_state_conflict", reason: mapJobStatusToConflictReason(initialJob.status), cleanup: "not_needed" };
  }

  // 2. Generate opaque objectKey & Content-Disposition
  let objectKey: string;
  let contentDisposition: string;
  try {
    const validJobId = WorkerJobIdSchema.parse(jobId);
    objectKey = generateWorkerObjectKey(validJobId, randomSource);
    contentDisposition = buildAttachmentContentDisposition(filename);
  } catch {
    return { type: "storage_failure", code: "invalid_input", cleanup: "not_needed" };
  }

  // 3. Construct and validate complete put candidate
  let validatedPutInput: ObjectStorePutInput;
  try {
    validatedPutInput = ObjectStorePutInputSchema.parse({
      objectKey,
      body,
      contentLength: fileSize,
      contentType: mime,
      contentDisposition,
    });
  } catch {
    return { type: "storage_failure", code: "invalid_input", cleanup: "not_needed" };
  }

  // 4. Try put
  try {
    await writer.put(validatedPutInput);
  } catch {
    const cleanup = await cleanupUploadedObject(writer, objectKey);
    return { type: "storage_failure", code: "put_failed", cleanup };
  }

  // 5. Head Retrieval
  let rawHead: ObjectStoreHead | null;
  try {
    rawHead = await writer.head(objectKey);
  } catch {
    const cleanup = await cleanupUploadedObject(writer, objectKey);
    return { type: "storage_failure", code: "head_failed", cleanup };
  }

  if (rawHead === null) {
    const cleanup = await cleanupUploadedObject(writer, objectKey);
    return { type: "storage_failure", code: "verification_failed", cleanup };
  }

  // 6. Head Validation
  let validatedHead: ObjectStoreHead;
  try {
    validatedHead = ObjectStoreHeadSchema.parse(rawHead);
  } catch {
    const cleanup = await cleanupUploadedObject(writer, objectKey);
    return { type: "storage_failure", code: "verification_failed", cleanup };
  }

  // 7. Metadata Comparison
  if (
    validatedHead.objectKey !== objectKey ||
    validatedHead.contentLength !== fileSize ||
    validatedHead.contentType !== mime ||
    validatedHead.contentDisposition !== contentDisposition
  ) {
    const cleanup = await cleanupUploadedObject(writer, objectKey);
    return { type: "storage_failure", code: "verification_failed", cleanup };
  }

  // 8. Commit Ready
  let commitResult;
  try {
    commitResult = store.commitReadyFromUploading(jobId, {
      objectKey,
      filename,
      fileSize,
      mime,
      quality,
      container,
    });
  } catch {
    const cleanup = await cleanupUploadedObject(writer, objectKey);
    return { type: "storage_failure", code: "ready_commit_failed", cleanup };
  }

  if (commitResult.type === "ready") {
    return { type: "ready", job: commitResult.job };
  }

  // 9. Races -> cleanup
  const cleanup = await cleanupUploadedObject(writer, objectKey);
  if (commitResult.type === "lifetime_expired") {
    return { type: "lifetime_expired", cleanup };
  }
  let reason: JobStateConflictReason = "not_uploading";
  if (commitResult.type === "not_found") {
    reason = "missing";
  } else if (commitResult.type === "terminal") {
    reason = mapJobStatusToConflictReason(commitResult.job.status);
  } else if (commitResult.type === "not_uploading") {
    reason = mapJobStatusToConflictReason(commitResult.job.status);
  }
  return { type: "job_state_conflict", reason, cleanup };
}

export type CleanupResult = {
  attempted: number;
  deleted: number;
  failed: number;
};

export async function cleanupExpiredObjects(store: WorkerJobStore, writer: ObjectStoreWriter, limit: number): Promise<CleanupResult> {
  const expiredObjects = store.listExpiredReadyObjects(limit);
  
  const result: CleanupResult = { attempted: 0, deleted: 0, failed: 0 };
  
  for (const obj of expiredObjects) {
    result.attempted++;
    try {
      await writer.delete(obj.objectKey);
      result.deleted++;
    } catch {
      result.failed++;
    }
  }

  return result;
}
