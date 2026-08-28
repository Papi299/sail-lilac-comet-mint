import type { WorkerJobStore } from "../state/job-store.ts";
import type { WorkerJobView } from "../../shared/worker/contracts.ts";
import type { ObjectStoreWriter } from "./writer.ts";
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

export type FinalizeUploadResult = 
  | { type: "ready"; job: WorkerJobView }
  | { type: "storage_failure"; error: string }
  | { type: "job_state_conflict"; reason: string };

export async function finalizeJobUpload(input: FinalizeUploadInput): Promise<FinalizeUploadResult> {
  const { jobId, store, writer, body, filename, fileSize, mime, quality, container, randomSource } = input;

  // 1. Verify job is uploading
  const initialJob = store.getJob(jobId);
  if (!initialJob) {
    return { type: "job_state_conflict", reason: "missing" };
  }
  if (initialJob.status !== "uploading") {
    return { type: "job_state_conflict", reason: initialJob.status };
  }

  // 2. Generate opaque objectKey & Content-Disposition
  let objectKey: string;
  let contentDisposition: string;
  try {
    objectKey = generateWorkerObjectKey(jobId, randomSource);
    contentDisposition = buildAttachmentContentDisposition(filename);
  } catch (e) {
    return { type: "storage_failure", error: e instanceof Error ? e.message : String(e) };
  }

  // 3. Put
  try {
    await writer.put({
      objectKey,
      body,
      contentLength: fileSize,
      contentType: mime,
      contentDisposition,
    });
  } catch (e) {
    // Put failure cleanup
    try { await writer.delete(objectKey); } catch (cleanupErr) { void cleanupErr; }
    return { type: "storage_failure", error: e instanceof Error ? e.message : String(e) };
  }

  // 4. Head Verification
  let headResult;
  try {
    headResult = await writer.head(objectKey);
  } catch (e) {
    // Head failure
    try { await writer.delete(objectKey); } catch (cleanupErr) { void cleanupErr; }
    return { type: "storage_failure", error: e instanceof Error ? e.message : String(e) };
  }

  if (
    !headResult ||
    headResult.objectKey !== objectKey ||
    headResult.contentLength !== fileSize ||
    headResult.contentType !== mime ||
    headResult.contentDisposition !== contentDisposition
  ) {
    // Head missing / mismatch
    try { await writer.delete(objectKey); } catch (cleanupErr) { void cleanupErr; }
    return { type: "storage_failure", error: "storage verification failed" };
  }

  // 5. Commit Ready
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
  } catch (e) {
    // e.g. validation failure on row
    try { await writer.delete(objectKey); } catch (cleanupErr) { void cleanupErr; }
    return { type: "storage_failure", error: "commit ready failed" };
  }

  if (commitResult.type === "ready") {
    return { type: "ready", job: commitResult.job };
  }

  // Races -> cleanup (cancel, fail, delete, etc.)
  try { await writer.delete(objectKey); } catch (cleanupErr) { void cleanupErr; }
  return { type: "job_state_conflict", reason: commitResult.type };
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
    } catch (e) {
      result.failed++;
    }
  }

  return result;
}
