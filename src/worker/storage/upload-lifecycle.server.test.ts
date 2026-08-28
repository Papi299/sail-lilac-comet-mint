import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import { finalizeJobUpload, cleanupExpiredObjects, type FinalizeUploadInput } from "./upload-lifecycle.server.ts";
import type { ObjectStoreWriter, ObjectStorePutInput, ObjectStoreHead } from "./writer.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { randomUUID } from "node:crypto";
import { WorkerObjectKeySchema } from "../../shared/worker/contracts.ts";
import { buildAttachmentContentDisposition } from "../../lib/filenames.ts";
import type { WorkerJobView } from "../../shared/worker/contracts.ts";

class FakeObjectStoreWriter implements ObjectStoreWriter {
  public objects = new Map<string, ObjectStorePutInput>();
  public putCalls: ObjectStorePutInput[] = [];
  public headCalls: string[] = [];
  public deleteCalls: string[] = [];

  public putShouldThrow: boolean | Error = false;
  public headShouldReturnNull = false;
  public headShouldThrow: boolean | Error = false;
  public deleteShouldThrow: boolean | Error = false;
  public deleteFailures = new Set<string>();
  public headOverride: ((obj: ObjectStorePutInput) => ObjectStoreHead) | null = null;

  async put(input: ObjectStorePutInput): Promise<void> {
    this.putCalls.push(input);
    if (this.putShouldThrow) {
      throw this.putShouldThrow instanceof Error ? this.putShouldThrow : new Error("Fake put failure");
    }
    this.objects.set(input.objectKey, input);
  }

  async head(objectKey: string): Promise<ObjectStoreHead | null> {
    this.headCalls.push(objectKey);
    if (this.headShouldThrow) {
      throw this.headShouldThrow instanceof Error ? this.headShouldThrow : new Error("Fake head failure");
    }
    if (this.headShouldReturnNull) return null;
    
    const obj = this.objects.get(objectKey);
    if (!obj) return null;
    
    if (this.headOverride) return this.headOverride(obj);

    return {
      objectKey: obj.objectKey,
      contentLength: obj.contentLength,
      contentType: obj.contentType,
      contentDisposition: obj.contentDisposition,
    };
  }

  async delete(objectKey: string): Promise<void> {
    this.deleteCalls.push(objectKey);
    // Exact-key assertion required by prompt
    WorkerObjectKeySchema.parse(objectKey);
    if (this.deleteShouldThrow || this.deleteFailures.has(objectKey)) {
      throw this.deleteShouldThrow instanceof Error ? this.deleteShouldThrow : new Error("Fake delete failure for " + objectKey);
    }
    this.objects.delete(objectKey);
  }
}

async function* createAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

describe("Content-Disposition metadata", () => {
  it("generates safe attachment headers for hostile filenames", () => {
    const testCases = [
      { input: "../../file.mp4" },
      { input: 'file"quote".mp4' },
      { input: "file\r\n.mp4" },
      { input: "unicode-é.mp4" }, 
      { input: "dir/file.mp4" },
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

  function setupUploadingJob(): WorkerJobView {
    const req = {
      url: "https://example.com/video",
      formatId: "137",
      principalId: "private-access-user" as const,
    };
    const { job } = store.createJob(req, randomUUID()) as { job: WorkerJobView };
    store.claimNextQueuedJob(); // queued -> analyzing
    db.prepare("UPDATE worker_jobs SET status = 'uploading' WHERE job_id = ?").run(job.jobId);
    return store.getJob(job.jobId)!;
  }

  function getUploadInput(jobId: string, overrides: Partial<FinalizeUploadInput> = {}): FinalizeUploadInput {
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
      randomSource: () => new Uint8Array(16).fill(0xAA), // Deterministic token
      ...overrides
    };
  }

  it("upload success: job becomes ready and metadata verified", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);
    
    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "ready");
    if (result.type !== "ready") return;

    assert.strictEqual(writer.putCalls.length, 1);
    assert.strictEqual(writer.headCalls.length, 1);
    assert.strictEqual(writer.deleteCalls.length, 0);

    const generatedKey = `videofetch/jobs/${job.jobId}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    assert.strictEqual(writer.putCalls[0].objectKey, generatedKey);
    assert.strictEqual(writer.headCalls[0], generatedKey);
    assert.strictEqual(result.job.objectKey, generatedKey);
    assert.strictEqual(result.job.progress, 100);
  });

  it("invalid pre-put inputs: 0 side effects", async () => {
    const job = setupUploadingJob();
    const badInputs = [
      getUploadInput(job.jobId, { fileSize: -1 }),
      getUploadInput(job.jobId, { fileSize: Number.MAX_SAFE_INTEGER + 1 }),
      getUploadInput(job.jobId, { mime: "video/\r\nmp4" }),
      getUploadInput(job.jobId, { mime: "video/\x00mp4" }),
      getUploadInput(job.jobId, { mime: "a".repeat(256) }),
      getUploadInput(job.jobId, { filename: "" }),
      getUploadInput(job.jobId, { filename: "a".repeat(1025) }),
    ];

    for (const input of badInputs) {
      const result = await finalizeJobUpload(input);
      assert.strictEqual(result.type, "storage_failure");
      if (result.type === "storage_failure") {
        assert.strictEqual(result.code, "invalid_input");
        assert.strictEqual(result.cleanup, "not_needed");
      }
      assert.strictEqual(writer.putCalls.length, 0);
      assert.strictEqual(writer.headCalls.length, 0);
      assert.strictEqual(writer.deleteCalls.length, 0);
      const dbJob = store.getJob(job.jobId);
      assert.strictEqual(dbJob!.status, "uploading");
    }
  });

  it("derived Content-Disposition overflow regression", async () => {
    const job = setupUploadingJob();
    // Filename passes filename bound (<=1024) but causes Content-Disposition to exceed its bound
    // We didn't change the bound to make it strictly overflow yet but if it does, it should be caught.
    // Let's force an overflow by using exactly 1024 for filename so that the added 'attachment; filename=' exceeds 1024.
    const longName = "a".repeat(1024);
    const input = getUploadInput(job.jobId, { filename: longName });
    
    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    if (result.type === "storage_failure") {
      assert.strictEqual(result.code, "invalid_input");
      assert.strictEqual(result.cleanup, "not_needed");
    }
    assert.strictEqual(writer.putCalls.length, 0);
    assert.strictEqual(writer.headCalls.length, 0);
    assert.strictEqual(writer.deleteCalls.length, 0);
    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "uploading");
  });

  it("head missing: attempts delete, job remains uploading", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);
    writer.headShouldReturnNull = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    if (result.type === "storage_failure") {
      assert.strictEqual(result.code, "verification_failed");
      assert.strictEqual(result.cleanup, "deleted");
    }
    assert.strictEqual(writer.deleteCalls.length, 1);
    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "uploading");
  });

  it("metadata mismatch test matrix", async () => {
    const cases = [
      { 
        name: "wrong contentLength", 
        override: (obj: ObjectStorePutInput) => ({ ...obj, contentLength: obj.contentLength + 1 } as ObjectStoreHead) 
      },
      { 
        name: "wrong contentType", 
        override: (obj: ObjectStorePutInput) => ({ ...obj, contentType: "text/plain" } as ObjectStoreHead) 
      },
      { 
        name: "wrong contentDisposition", 
        override: (obj: ObjectStorePutInput) => ({ ...obj, contentDisposition: "inline" } as ObjectStoreHead) 
      },
      { 
        name: "wrong objectKey", 
        override: (obj: ObjectStorePutInput) => ({ ...obj, objectKey: "wrong" } as ObjectStoreHead) 
      },
      { 
        name: "malformed head result (negative length)", 
        override: (obj: ObjectStorePutInput) => ({ ...obj, contentLength: -1 } as unknown as ObjectStoreHead) 
      },
    ];

    for (const { override } of cases) {
      writer.putCalls = [];
      writer.headCalls = [];
      writer.deleteCalls = [];
      const job = setupUploadingJob();
      const input = getUploadInput(job.jobId);
      writer.headOverride = override;

      const result = await finalizeJobUpload(input);
      
      assert.strictEqual(result.type, "storage_failure");
      if (result.type === "storage_failure") {
        assert.ok(["verification_failed"].includes(result.code)); 
        assert.strictEqual(result.cleanup, "deleted");
      }
      assert.strictEqual(writer.deleteCalls.length, 1);
      const dbJob = store.getJob(job.jobId);
      assert.strictEqual(dbJob!.status, "uploading");
    }
    writer.headOverride = null;
  });

  it("put failure: attempts delete, job remains uploading", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);
    writer.putShouldThrow = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    if (result.type === "storage_failure") {
      assert.strictEqual(result.code, "put_failed");
      assert.strictEqual(result.cleanup, "deleted");
    }
    assert.strictEqual(writer.deleteCalls.length, 1);
    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "uploading");
  });

  it("head failure: attempts delete, job remains uploading", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);
    writer.headShouldThrow = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    if (result.type === "storage_failure") {
      assert.strictEqual(result.code, "head_failed");
      assert.strictEqual(result.cleanup, "deleted");
    }
    assert.strictEqual(writer.deleteCalls.length, 1);
    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "uploading");
  });

  it("provider raw-error leakage regression", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);
    writer.putShouldThrow = new Error("SECRET_BUCKET_INTERNAL_ERROR provider-request-id-123");

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    const json = JSON.stringify(result);
    assert.ok(!json.includes("SECRET_BUCKET_INTERNAL_ERROR"));
    assert.ok(!json.includes("provider-request-id-123"));
  });

  it("cancel race: delete succeeds -> cleanup == deleted", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);

    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      const res = await originalHead(key);
      store.cancelJob(job.jobId);
      return res;
    };

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "job_state_conflict");
    if (result.type === "job_state_conflict") {
      assert.strictEqual(result.reason, "cancelled");
      assert.strictEqual(result.cleanup, "deleted");
    }
    assert.strictEqual(writer.deleteCalls.length, 1);
    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "cancelled");
  });

  it("cancel race: delete throws -> cleanup == failed", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);

    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      const res = await originalHead(key);
      store.cancelJob(job.jobId);
      return res;
    };
    writer.deleteShouldThrow = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "job_state_conflict");
    if (result.type === "job_state_conflict") {
      assert.strictEqual(result.reason, "cancelled");
      assert.strictEqual(result.cleanup, "failed");
    }
    assert.strictEqual(writer.deleteCalls.length, 1);
    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "cancelled");
  });

  it("fail race: delete succeeds -> cleanup == deleted", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);

    const originalHead = writer.head.bind(writer);
    let capturedKey = "";
    writer.head = async (key) => {
      capturedKey = key;
      const res = await originalHead(key);
      store.failJob(job.jobId, "PROCESSING_FAILED", "Failed during upload");
      return res;
    };

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "job_state_conflict");
    if (result.type === "job_state_conflict") {
      assert.strictEqual(result.reason, "failed");
      assert.strictEqual(result.cleanup, "deleted");
    }
    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "failed");
    assert.strictEqual(writer.deleteCalls.length, 1);
    assert.strictEqual(writer.deleteCalls[0], capturedKey);
    assert.strictEqual(capturedKey.length, 81);
  });

  it("fail race: delete throws -> cleanup == failed", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);

    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      const res = await originalHead(key);
      store.failJob(job.jobId, "PROCESSING_FAILED", "Failed during upload");
      return res;
    };
    writer.deleteShouldThrow = true;

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "job_state_conflict");
    if (result.type === "job_state_conflict") {
      assert.strictEqual(result.reason, "failed");
      assert.strictEqual(result.cleanup, "failed");
    }
    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "failed");
  });

  it("head-failure + delete-failure regression (leakage test)", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);
    writer.headShouldThrow = new Error("SECRET_BUCKET_INTERNAL_ERROR provider-request-id-123");
    writer.deleteShouldThrow = new Error("SECRET_DELETE_ERROR provider-request-id-456");

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "storage_failure");
    if (result.type === "storage_failure") {
      assert.strictEqual(result.code, "head_failed");
      assert.strictEqual(result.cleanup, "failed");
    }
    const json = JSON.stringify(result);
    assert.ok(!json.includes("SECRET_BUCKET_INTERNAL_ERROR"));
    assert.ok(!json.includes("SECRET_DELETE_ERROR"));
    
    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "uploading");
    assert.strictEqual(writer.deleteCalls.length, 1);
    assert.strictEqual(writer.deleteCalls[0].length, 81);
  });

  it("conflict-state regression matrix before storage starts", async () => {
    const states = [
      { status: "queued", reason: "not_uploading" },
      { status: "analyzing", reason: "not_uploading" },
      { status: "downloading", reason: "not_uploading" },
      { status: "processing", reason: "not_uploading" },
      { status: "ready", reason: "ready" },
      { status: "failed", reason: "failed" },
      { status: "cancelled", reason: "cancelled" },
    ];

    for (const { status, reason } of states) {
      writer.putCalls = [];
      writer.headCalls = [];
      writer.deleteCalls = [];
      
      const job = setupUploadingJob();
      if (status === "ready") {
        db.prepare("UPDATE worker_jobs SET status = ?, object_key = ? WHERE job_id = ?").run(status, `videofetch/jobs/${job.jobId}/` + "a".repeat(32), job.jobId);
      } else {
        db.prepare("UPDATE worker_jobs SET status = ? WHERE job_id = ?").run(status, job.jobId);
      }
      
      const input = getUploadInput(job.jobId);
      const result = await finalizeJobUpload(input);
      
      assert.strictEqual(result.type, "job_state_conflict");
      if (result.type === "job_state_conflict") {
        assert.strictEqual(result.reason, reason);
        assert.strictEqual(result.cleanup, "not_needed");
      }
      assert.strictEqual(writer.putCalls.length, 0);
      assert.strictEqual(writer.headCalls.length, 0);
      assert.strictEqual(writer.deleteCalls.length, 0);
    }
  });

  it("not-found race after upload", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);

    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      const res = await originalHead(key);
      db.prepare("DELETE FROM worker_jobs WHERE job_id = ?").run(job.jobId);
      return res;
    };

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "job_state_conflict");
    if (result.type === "job_state_conflict") {
      assert.strictEqual(result.reason, "missing");
      assert.strictEqual(result.cleanup, "deleted");
    }
    assert.strictEqual(writer.deleteCalls.length, 1);
  });

  it("unexpected nonterminal-state race", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);

    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      const res = await originalHead(key);
      db.prepare("UPDATE worker_jobs SET status = 'analyzing' WHERE job_id = ?").run(job.jobId);
      return res;
    };

    const result = await finalizeJobUpload(input);
    
    assert.strictEqual(result.type, "job_state_conflict");
    if (result.type === "job_state_conflict") {
      assert.strictEqual(result.reason, "not_uploading");
      assert.strictEqual(result.cleanup, "deleted");
    }
    assert.strictEqual(writer.deleteCalls.length, 1);
  });

  it("ready wins: cancel after ready does not delete object", async () => {
    const job = setupUploadingJob();
    const input = getUploadInput(job.jobId);

    const result = await finalizeJobUpload(input);
    assert.strictEqual(result.type, "ready");
    assert.strictEqual(writer.deleteCalls.length, 0);

    store.cancelJob(job.jobId);

    const dbJob = store.getJob(job.jobId);
    assert.strictEqual(dbJob!.status, "ready");
    assert.strictEqual(writer.deleteCalls.length, 0);
  });

  it("ready CAS rollback: invalid post-update state rolls back transaction", () => {
    const jobA = setupUploadingJob();
    const goodKey = `videofetch/jobs/${jobA.jobId}/` + "a".repeat(32); 

    // Install a TEST-ONLY SQLite trigger that corrupts the row after update
    db.exec(`
      CREATE TRIGGER test_corrupt_ready 
      AFTER UPDATE ON worker_jobs 
      WHEN new.status = 'ready' 
      BEGIN 
        UPDATE worker_jobs SET object_key = NULL WHERE job_id = new.job_id; 
      END;
    `);

    assert.throws(() => {
      store.commitReadyFromUploading(jobA.jobId, {
        objectKey: goodKey,
        filename: "test.mp4",
        fileSize: 100,
        mime: "video/mp4",
        quality: "1080p",
        container: "mp4",
      });
    });

    db.exec("DROP TRIGGER test_corrupt_ready;");

    const rawRow = db.prepare("SELECT status, object_key FROM worker_jobs WHERE job_id = ?").get(jobA.jobId) as any;
    assert.strictEqual(rawRow.status, "uploading");
    assert.strictEqual(rawRow.object_key, null);

    const dbJob = store.getJob(jobA.jobId);
    assert.strictEqual(dbJob!.status, "uploading");
  });

  it("expiration cleanup: failure isolation (one fails, one succeeds)", async () => {
    const jobA = setupUploadingJob();
    const jobB = setupUploadingJob();

    await finalizeJobUpload(getUploadInput(jobA.jobId));
    await finalizeJobUpload(getUploadInput(jobB.jobId));

    db.prepare("UPDATE worker_jobs SET expires_at_ms = created_at_ms WHERE job_id IN (?, ?)").run(jobA.jobId, jobB.jobId);

    const jobAData = store.getJob(jobA.jobId)!;
    const jobBData = store.getJob(jobB.jobId)!;
    const keyA = jobAData.objectKey!;
    const keyB = jobBData.objectKey!;

    writer.deleteCalls.length = 0; 
    
    // Cause A to fail, B to succeed
    writer.deleteFailures.add(keyA);

    const result = await cleanupExpiredObjects(store, writer, 10);
    
    assert.strictEqual(result.attempted, 2);
    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(result.failed, 1);
    
    assert.strictEqual(writer.deleteCalls.length, 2);
    assert.ok(writer.deleteCalls.includes(keyA));
    assert.ok(writer.deleteCalls.includes(keyB));
    
    // Verify metadata remains intact for both
    const finalA = store.getJob(jobA.jobId)!;
    const finalB = store.getJob(jobB.jobId)!;
    
    assert.strictEqual(finalA.status, "ready");
    assert.strictEqual(finalA.objectKey, keyA);
    assert.strictEqual(finalA.expiresAt, jobAData.expiresAt);
    
    assert.strictEqual(finalB.status, "ready");
    assert.strictEqual(finalB.objectKey, keyB);
    assert.strictEqual(finalB.expiresAt, jobBData.expiresAt);
  });

  it("exact-key deletion: no prefix deletion allowed", async () => {
    const jobA = setupUploadingJob();
    await finalizeJobUpload(getUploadInput(jobA.jobId));
    db.prepare("UPDATE worker_jobs SET expires_at_ms = created_at_ms WHERE job_id = ?").run(jobA.jobId);
    writer.deleteCalls.length = 0;

    await cleanupExpiredObjects(store, writer, 10);

    const deletedKey = writer.deleteCalls[0];
    assert.ok(!deletedKey.endsWith("/"), "Deleted key must not end with slash (prefix)");
    assert.strictEqual(deletedKey.length, 81); 
  });
});
