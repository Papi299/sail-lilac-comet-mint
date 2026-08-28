import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import { finalizeJobUpload, cleanupExpiredObjects, type FinalizeUploadInput } from "./upload-lifecycle.server.ts";
import type { ObjectStoreWriter, ObjectStorePutInput, ObjectStoreHead } from "./writer.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { randomUUID } from "node:crypto";
import { buildAttachmentContentDisposition } from "../../lib/filenames.ts";

class FakeObjectStoreWriter implements ObjectStoreWriter {
  public objects = new Map<string, ObjectStorePutInput>();
  public putCalls: ObjectStorePutInput[] = [];
  public headCalls: string[] = [];
  public deleteCalls: string[] = [];

  public putShouldThrow = false;
  public headShouldReturnNull = false;
  public headShouldThrow = false;
  public headMetadataMismatch = false;
  public deleteShouldThrow = false;

  async put(input: ObjectStorePutInput): Promise<void> {
    this.putCalls.push(input);
    if (this.putShouldThrow) throw new Error("Fake put failure");
    this.objects.set(input.objectKey, input);
  }

  async head(objectKey: string): Promise<ObjectStoreHead | null> {
    this.headCalls.push(objectKey);
    if (this.headShouldThrow) throw new Error("Fake head failure");
    if (this.headShouldReturnNull) return null;
    
    const obj = this.objects.get(objectKey);
    if (!obj) return null;
    
    return {
      objectKey: obj.objectKey,
      contentLength: this.headMetadataMismatch ? obj.contentLength + 1 : obj.contentLength,
      contentType: obj.contentType,
      contentDisposition: obj.contentDisposition,
    };
  }

  async delete(objectKey: string): Promise<void> {
    this.deleteCalls.push(objectKey);
    if (this.deleteShouldThrow) throw new Error("Fake delete failure");
    this.objects.delete(objectKey);
  }
}

async function* createAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

describe("Content-Disposition metadata", () => {
  it("generates safe attachment headers for hostile filenames", () => {
    const testCases = [
      { input: "../../file.mp4", expected: "file.mp4" },
      { input: 'file"quote".mp4', expected: 'file_quote_.mp4' },
      { input: "file\r\n.mp4", expected: 'file__.mp4' },
      { input: "unicode-é.mp4", expected: 'unicode-_.mp4' }, 
      { input: "dir/file.mp4", expected: 'file.mp4' },
    ];

    for (const { input } of testCases) {
      const header = buildAttachmentContentDisposition(input);
      assert.ok(header.startsWith('attachment; filename="'), `header: ${header}`);
      assert.ok(!header.includes("\r") && !header.includes("\n"), "No CR/LF");
    }
  });
});

describe("Upload Lifecycle Coordinator", () => {
  let store: SQLiteJobStore;
  let writer: FakeObjectStoreWriter;
  let db: ReturnType<typeof openWorkerDatabase>;

  beforeEach(() => {
    db = openWorkerDatabase({ path: ":memory:" });
    applyMigrations(db);
    store = new SQLiteJobStore({ db });
    writer = new FakeObjectStoreWriter();
  });

  afterEach(() => {
    db.close();
  });

  function setupUploadingJob(): string {
    const req = {
      url: "https://example.com/video",
      formatId: "137",
      principalId: "private-access-user" as const,
    };
    const { job } = store.createJob(req, randomUUID()) as { job: any };
    store.claimNextQueuedJob(); // queued -> analyzing
    db.prepare("UPDATE worker_jobs SET status = 'uploading' WHERE job_id = ?").run(job.jobId);
    return job.jobId;
  }

  function getUploadInput(jobId: string): FinalizeUploadInput {
    return {
      jobId,
      store,
      writer,
      body: createAsyncIterable(new Uint8Array([1, 2, 3])),
      filename: "test.mp4",
      fileSize: 3,
      mime: "video/mp4",
      quality: "1080p",
      container: "mp4",
      randomSource: () => new Uint8Array(16).fill(0xAA) // Deterministic token
    };
  }

  it("upload success: job becomes ready and metadata verified", async () => {
    const jobId = setupUploadingJob();
    const input = getUploadInput(jobId);
    
    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "ready");
    if (result.type !== "ready") return;

    assert.strictEqual(writer.putCalls.length, 1);
    assert.strictEqual(writer.headCalls.length, 1);
    assert.strictEqual(writer.deleteCalls.length, 0);

    const generatedKey = `videofetch/jobs/${jobId}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    assert.strictEqual(writer.putCalls[0].objectKey, generatedKey);
    assert.strictEqual(writer.headCalls[0], generatedKey);
    assert.strictEqual(result.job.objectKey, generatedKey);
    assert.strictEqual(result.job.progress, 100);
  });

  it("head missing: attempts delete, job remains uploading", async () => {
    const jobId = setupUploadingJob();
    const input = getUploadInput(jobId);
    writer.headShouldReturnNull = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    assert.strictEqual(writer.deleteCalls.length, 1);
    const job = store.getJob(jobId);
    assert.strictEqual(job!.status, "uploading");
  });

  it("metadata mismatch: attempts delete, job remains uploading", async () => {
    const jobId = setupUploadingJob();
    const input = getUploadInput(jobId);
    writer.headMetadataMismatch = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    assert.strictEqual(writer.deleteCalls.length, 1);
    const job = store.getJob(jobId);
    assert.strictEqual(job!.status, "uploading");
  });

  it("put failure: attempts delete, job remains uploading", async () => {
    const jobId = setupUploadingJob();
    const input = getUploadInput(jobId);
    writer.putShouldThrow = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    assert.strictEqual(writer.deleteCalls.length, 1);
    const job = store.getJob(jobId);
    assert.strictEqual(job!.status, "uploading");
  });

  it("head failure: attempts delete, job remains uploading", async () => {
    const jobId = setupUploadingJob();
    const input = getUploadInput(jobId);
    writer.headShouldThrow = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    assert.strictEqual(writer.deleteCalls.length, 1);
    const job = store.getJob(jobId);
    assert.strictEqual(job!.status, "uploading");
  });

  it("cancel race: job cancelled before ready CAS loses CAS and deletes object", async () => {
    const jobId = setupUploadingJob();
    const input = getUploadInput(jobId);

    // Override head to trigger the race condition just before CAS
    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      const res = await originalHead(key);
      // Cancel the job during the head call
      store.cancelJob(jobId);
      return res;
    };

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "job_state_conflict");
    assert.strictEqual(result.reason, "terminal");
    assert.strictEqual(writer.deleteCalls.length, 1);
    
    const job = store.getJob(jobId);
    assert.strictEqual(job!.status, "cancelled");
  });

  it("fail race: job failed before ready CAS loses CAS and deletes object", async () => {
    const jobId = setupUploadingJob();
    const input = getUploadInput(jobId);

    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      const res = await originalHead(key);
      store.failJob(jobId, "PROCESSING_FAILED", "Failed during upload");
      return res;
    };

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "job_state_conflict");
    assert.strictEqual(result.reason, "terminal");
    assert.strictEqual(writer.deleteCalls.length, 1);
    
    const job = store.getJob(jobId);
    assert.strictEqual(job!.status, "failed");
  });

  it("ready wins: cancel after ready does not delete object", async () => {
    const jobId = setupUploadingJob();
    const input = getUploadInput(jobId);

    const result = await finalizeJobUpload(input);
    assert.strictEqual(result.type, "ready");
    assert.strictEqual(writer.deleteCalls.length, 0);

    store.cancelJob(jobId);

    const job = store.getJob(jobId);
    assert.strictEqual(job!.status, "ready"); // ready -> cancel is a no-op per Phase 3
    assert.strictEqual(writer.deleteCalls.length, 0);
  });

  it("cleanup failure: delete throws, returns failure but job stays in state", async () => {
    const jobId = setupUploadingJob();
    const input = getUploadInput(jobId);

    // Cancel race + delete fails
    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      const res = await originalHead(key);
      store.cancelJob(jobId);
      return res;
    };
    writer.deleteShouldThrow = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "job_state_conflict");
    assert.strictEqual(writer.deleteCalls.length, 1);
    
    const job = store.getJob(jobId);
    assert.strictEqual(job!.status, "cancelled");
  });

  it("ready CAS rollback: invalid validation rolls back transaction", () => {
    // This tests that our `commitReadyFromUploading` validates the output.
    // If we pass an object key belonging to another job, it should throw/rollback.
    const jobIdA = setupUploadingJob();
    const jobIdB = randomUUID(); // different job ID

    const badKey = `videofetch/jobs/${jobIdB}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    assert.throws(() => {
      store.commitReadyFromUploading(jobIdA, {
        objectKey: badKey,
        filename: "test.mp4",
        fileSize: 100,
        mime: "video/mp4",
        quality: "1080p",
        container: "mp4",
      });
    });

    const job = store.getJob(jobIdA);
    assert.strictEqual(job!.status, "uploading"); // Rolled back
  });

  it("expiration cleanup: exactly deletes expired ready object keys", async () => {
    // Set up 3 ready jobs. A and B expired, C non-expired.
    const jobA = setupUploadingJob();
    const jobB = setupUploadingJob();
    const jobC = setupUploadingJob();

    await finalizeJobUpload(getUploadInput(jobA));
    await finalizeJobUpload(getUploadInput(jobB));
    await finalizeJobUpload(getUploadInput(jobC));

    // Force expire A and B
    db.prepare("UPDATE worker_jobs SET expires_at_ms = created_at_ms WHERE job_id IN (?, ?)").run(jobA, jobB);

    writer.deleteCalls.length = 0; // Clear put/head stuff

    const result = await cleanupExpiredObjects(store, writer, 10);
    
    assert.strictEqual(result.attempted, 2);
    assert.strictEqual(result.deleted, 2);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(writer.deleteCalls.length, 2);
    
    // Verify no job metadata was deleted
    assert.ok(store.getJob(jobA));
    assert.ok(store.getJob(jobB));
    assert.ok(store.getJob(jobC));

    // Verify objectKey remains in metadata
    assert.ok(store.getJob(jobA)!.objectKey !== null);
  });

  it("exact-key deletion: no prefix deletion allowed", async () => {
    const jobA = setupUploadingJob();
    await finalizeJobUpload(getUploadInput(jobA));
    db.prepare("UPDATE worker_jobs SET expires_at_ms = created_at_ms WHERE job_id = ?").run(jobA);
    writer.deleteCalls.length = 0;

    await cleanupExpiredObjects(store, writer, 10);

    const deletedKey = writer.deleteCalls[0];
    assert.ok(!deletedKey.endsWith("/"), "Deleted key must not end with slash (prefix)");
    assert.strictEqual(deletedKey.length, 81); // "videofetch/jobs/"(16) + uuid(32) + "/"(1) + hex(32)
  });
});
