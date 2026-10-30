import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import {
  finalizeJobUpload,
  cleanupExpiredObjects,
  UPLOAD_CLEANUP_BUDGET_MS,
  type FinalizeUploadInput,
  type UploadStageTimerHandle,
  type UploadStageTimers,
} from "./upload-lifecycle.server.ts";
import type { ObjectStoreWriter, ObjectStorePutInput, ObjectStoreHead, ObjectStoreOperationContext } from "./writer.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { randomUUID } from "node:crypto";
import { WorkerObjectKeySchema } from "../../shared/worker/contracts.ts";
import { buildAttachmentContentDisposition } from "../../lib/filenames.ts";
import type {
  WorkerCreateJobRequest,
  WorkerJobView,
} from "../../shared/worker/contracts.ts";

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
    const req: WorkerCreateJobRequest = {
      url: "https://example.com/video",
      formatId: "preset:1080",
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
      // LD-2b: a stage whose deadline is an hour away and whose signal never
      // aborts, so every pre-LD-2b case below runs exactly as before.
      stage: { signal: new AbortController().signal, deadlineMs: Date.now() + 3_600_000 },
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

  // ── VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001: the lifetime race ──────
  //
  // The ready commit requires the job's execution lifetime to still be
  // running. A clock-controlled store over the same database plays an upload
  // that finishes after `claimed + L`.
  function lifetimeStore() {
    const clock = { now: 1_800_000_000_000 };
    const timed = new SQLiteJobStore({ db, clock: () => clock.now, executionLifetimeMs: 60_000, retentionMs: 30_000 });
    const { job } = timed.createJob(
      { url: "https://example.com/video", formatId: "preset:1080", principalId: "private-access-user" },
      randomUUID(),
    ) as { job: WorkerJobView };
    clock.now += 1_000;
    const claimed = timed.claimNextQueuedJob()!;
    db.prepare("UPDATE worker_jobs SET status = 'uploading' WHERE job_id = ?").run(job.jobId);
    return { clock, timed, jobId: job.jobId, deadline: claimed.expiresAt };
  }

  it("LD-2a: an upload finishing after the lifetime is refused, and exactly its key is deleted", async () => {
    const { clock, timed, jobId, deadline } = lifetimeStore();
    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      clock.now = deadline + 1; // the PUT and HEAD took the job past its deadline
      return originalHead(key);
    };

    const result = await finalizeJobUpload({ ...getUploadInput(jobId), store: timed });

    assert.deepStrictEqual(result, { type: "lifetime_expired", cleanup: "deleted" });
    assert.strictEqual(writer.putCalls.length, 1);
    assert.deepStrictEqual(writer.deleteCalls, [writer.putCalls[0]!.objectKey], "exactly the uploaded key");
    assert.strictEqual(writer.objects.size, 0, "no unauthorised object survives");
    const view = timed.getJob(jobId)!;
    assert.strictEqual(view.status, "uploading", "left to its executor, which fails it");
    assert.strictEqual(view.objectKey, null);
    assert.strictEqual(view.expiresAt, deadline);
  });

  it("LD-2a: a failed cleanup after the refused commit is reported as failed, never as ready", async () => {
    const { clock, timed, jobId, deadline } = lifetimeStore();
    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      clock.now = deadline;
      return originalHead(key);
    };
    writer.deleteShouldThrow = true;

    const result = await finalizeJobUpload({ ...getUploadInput(jobId), store: timed });

    assert.deepStrictEqual(result, { type: "lifetime_expired", cleanup: "failed" });
    assert.strictEqual(writer.deleteCalls.length, 1);
    assert.strictEqual(timed.getJob(jobId)!.status, "uploading");
    assert.deepStrictEqual(timed.listExpiredReadyObjects(10), [], "never reachable through ready metadata");
  });

  it("LD-2a: a commit a millisecond before the deadline is ready, retained R from it", async () => {
    const { clock, timed, jobId, deadline } = lifetimeStore();
    const originalHead = writer.head.bind(writer);
    writer.head = async (key) => {
      clock.now = deadline - 1;
      return originalHead(key);
    };

    const result = await finalizeJobUpload({ ...getUploadInput(jobId), store: timed });

    assert.strictEqual(result.type, "ready");
    assert.strictEqual(result.type === "ready" && result.job.expiresAt, deadline - 1 + 30_000);
    assert.strictEqual(writer.deleteCalls.length, 0);
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

// ─────────────────────────────────────────────────────────────────────────────
// VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001: one absolute upload-stage
// deadline, the execution's signal, and an independent, bounded cleanup.
//
// Virtual time: the stage's timers are injected and fired by hand, and its
// clock is a plain number. The writer is gated: each operation records the
// signal it was handed and waits for a release, or for that signal to abort.
// ─────────────────────────────────────────────────────────────────────────────

type ArmedTimer = UploadStageTimerHandle & { handler: () => void; ms: number; cleared: boolean; unrefed: boolean };

class VirtualTimers implements UploadStageTimers {
  readonly armed: ArmedTimer[] = [];
  setTimeoutFn = (handler: () => void, ms: number): UploadStageTimerHandle => {
    const timer: ArmedTimer = { handler, ms, cleared: false, unrefed: false, unref: () => (timer.unrefed = true) };
    this.armed.push(timer);
    return timer;
  };
  clearTimeoutFn = (handle: UploadStageTimerHandle) => {
    (handle as ArmedTimer).cleared = true;
  };
  /** Fires a timer as the platform would: only if it was not cleared. */
  fire(index: number): void {
    const timer = this.armed[index]!;
    if (!timer.cleared) timer.handler();
  }
}

type Gate = { release: () => void; promise: Promise<void> };
const gate = (): Gate => {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { release, promise };
};

type OpRecord = { op: "put" | "head" | "delete"; key: string; signal: AbortSignal | undefined; abortedSeen: boolean };

/**
 * A writer whose operations behave like the real one by default — they end,
 * rejecting, the moment their own signal aborts — and which can be told to
 * hold an operation until released, to ignore its signal (a provider that
 * keeps going), or to fail.
 */
class GatedWriter implements ObjectStoreWriter {
  readonly records: OpRecord[] = [];
  readonly objects = new Map<string, ObjectStorePutInput>();
  readonly gates: Partial<Record<OpRecord["op"], Gate>> = {};
  ignoreSignal: Partial<Record<OpRecord["op"], boolean>> = {};
  fail: Partial<Record<OpRecord["op"], boolean>> = {};
  bodyBytesRead = 0;
  readonly entered: Partial<Record<OpRecord["op"], boolean>> = {};

  private async run(op: OpRecord["op"], key: string, context: ObjectStoreOperationContext | undefined) {
    const record: OpRecord = { op, key, signal: context?.signal, abortedSeen: false };
    this.records.push(record);
    this.entered[op] = true;
    const signal = context?.signal;
    if (signal?.aborted && !this.ignoreSignal[op]) {
      record.abortedSeen = true;
      throw new Error(`${op} refused: already aborted`);
    }
    const held = this.gates[op];
    if (held) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          record.abortedSeen = true;
          reject(new Error(`${op} torn down`));
        };
        if (signal && !this.ignoreSignal[op]) signal.addEventListener("abort", onAbort, { once: true });
        void held.promise.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
    if (this.fail[op]) throw new Error(`${op} failed: provider-internal detail`);
  }

  async put(input: ObjectStorePutInput, context?: ObjectStoreOperationContext): Promise<void> {
    await this.run("put", input.objectKey, context);
    for await (const chunk of input.body) this.bodyBytesRead += chunk.byteLength;
    this.objects.set(input.objectKey, input);
  }

  async head(objectKey: string, context?: ObjectStoreOperationContext): Promise<ObjectStoreHead | null> {
    await this.run("head", objectKey, context);
    const object = this.objects.get(objectKey);
    return object
      ? { objectKey, contentLength: object.contentLength, contentType: object.contentType, contentDisposition: object.contentDisposition }
      : null;
  }

  async delete(objectKey: string, context?: ObjectStoreOperationContext): Promise<void> {
    await this.run("delete", objectKey, context);
    this.objects.delete(objectKey);
  }

  ops(): string[] {
    return this.records.map((r) => r.op);
  }
}

describe("LD-2b upload stage: one absolute deadline, the execution's signal, a bounded cleanup", () => {
  const T0 = 1_800_000_000_000;
  const BUDGET = 3_600_000;
  let db: ReturnType<typeof openWorkerDatabase>;
  let store: SQLiteJobStore;
  let writer: GatedWriter;
  let timers: VirtualTimers;
  let clock: { now: number };
  let execution: AbortController;

  beforeEach(() => {
    db = openWorkerDatabase({ path: ":memory:" });
    applyMigrations(db);
    store = new SQLiteJobStore({ db });
    writer = new GatedWriter();
    timers = new VirtualTimers();
    clock = { now: T0 };
    execution = new AbortController();
  });

  afterEach(() => {
    db.close();
  });

  function uploadingJobId(): string {
    const { job } = store.createJob(
      { url: "https://example.com/video", formatId: "preset:1080", principalId: "private-access-user" },
      randomUUID(),
    ) as { job: WorkerJobView };
    store.claimNextQueuedJob();
    db.prepare("UPDATE worker_jobs SET status = 'uploading' WHERE job_id = ?").run(job.jobId);
    return job.jobId;
  }

  function bodyOf(bytes: number) {
    const state = { read: 0 };
    const body = (async function* () {
      state.read += bytes;
      yield new Uint8Array(bytes);
    })();
    return { state, body };
  }

  function input(jobId: string, deadlineMs = T0 + BUDGET): FinalizeUploadInput {
    return {
      jobId,
      store,
      writer,
      body: bodyOf(3).body,
      filename: "test.mp4",
      fileSize: 3,
      mime: "video/mp4",
      quality: "1080p",
      container: "mp4",
      randomSource: () => new Uint8Array(16).fill(0xaa),
      stage: { signal: execution.signal, deadlineMs, clock: () => clock.now, timers },
    };
  }

  const KEY_OF = (jobId: string) => `videofetch/jobs/${jobId}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

  async function untilEntered(op: OpRecord["op"]) {
    for (let i = 0; i < 1000 && !writer.entered[op]; i += 1) await new Promise((r) => setImmediate(r));
    assert.ok(writer.entered[op], `${op} was reached`);
  }

  // ── H2: the absolute deadline ──────────────────────────────────────────────

  it("arms ONE unref'd timer for the remaining budget, hands every operation the same signal, and disposes it", async () => {
    const jobId = uploadingJobId();
    clock.now = T0 + 1_250; // the stage opened a moment ago: only the remainder is left
    const result = await finalizeJobUpload(input(jobId));
    assert.strictEqual(result.type, "ready");
    assert.strictEqual(timers.armed.length, 1, "one stage timer, no cleanup timer");
    assert.strictEqual(timers.armed[0]!.ms, BUDGET - 1_250, "the remainder of the ONE deadline, never a fresh budget");
    assert.strictEqual(timers.armed[0]!.unrefed, true);
    assert.strictEqual(timers.armed[0]!.cleared, true, "disposed when the stage ended");
    const [put, head] = writer.records;
    assert.ok(put!.signal && put!.signal === head!.signal, "the put and the head share the stage's one signal");
    assert.notStrictEqual(put!.signal, execution.signal, "the stage composes its own; it never aborts the execution's");
  });

  it("a slow put leaves the head only what remains: the SAME deadline fires during the head", async () => {
    const jobId = uploadingJobId();
    writer.gates.head = gate();
    const pending = finalizeJobUpload(input(jobId));
    await untilEntered("head");
    // The put took most of the budget; no new timer was armed for the head.
    clock.now = T0 + BUDGET;
    assert.strictEqual(timers.armed.length, 1, "the head got no budget of its own");
    timers.fire(0);
    const result = await pending;
    assert.deepStrictEqual(result, { type: "upload_timeout", cleanup: "deleted" });
    assert.strictEqual(writer.records[1]!.abortedSeen, true, "the in-flight head saw the deadline");
    assert.deepStrictEqual(writer.ops(), ["put", "head", "delete"]);
    assert.strictEqual(store.getJob(jobId)!.status, "uploading", "left for the executor to fail");
  });

  it("the deadline is exact: a commit one millisecond before it is ready; at it, nothing is committed", async () => {
    for (const [offset, expected] of [
      [-1, "ready"],
      [0, "upload_timeout"],
    ] as const) {
      writer = new GatedWriter();
      timers = new VirtualTimers();
      const jobId = uploadingJobId();
      const deadline = T0 + BUDGET;
      const realHead = writer.head.bind(writer);
      writer.head = async (key, context) => {
        const answer = await realHead(key, context);
        clock.now = deadline + offset; // the provider answers at this instant; no timer has fired
        return answer;
      };
      const result = await finalizeJobUpload(input(jobId, deadline));
      assert.strictEqual(result.type, expected, `offset ${offset}`);
      assert.strictEqual(store.getJob(jobId)!.status, expected === "ready" ? "ready" : "uploading");
      clock.now = T0;
    }
  });

  it("a deadline already passed refuses all work: nothing minted, sent or read, and nothing to clean", async () => {
    for (const deadlineMs of [T0, T0 - 1, 0]) {
      writer = new GatedWriter();
      const jobId = uploadingJobId();
      const { state, body } = bodyOf(3);
      const result = await finalizeJobUpload({ ...input(jobId, deadlineMs), body });
      assert.deepStrictEqual(result, { type: "upload_timeout", cleanup: "not_needed" });
      assert.deepStrictEqual(writer.ops(), [], "no operation started");
      assert.strictEqual(state.read, 0, "the body was never read");
      assert.strictEqual(store.getJob(jobId)!.status, "uploading");
    }
  });

  it("nothing renews the deadline: many operations, one timer, armed once", async () => {
    const jobId = uploadingJobId();
    const realPut = writer.put.bind(writer);
    writer.put = async (i, context) => {
      for (let step = 0; step < 20; step += 1) clock.now += 10_000; // a long, active transfer
      return realPut(i, context);
    };
    const result = await finalizeJobUpload(input(jobId));
    assert.strictEqual(result.type, "ready");
    assert.strictEqual(timers.armed.length, 1);
    assert.strictEqual(timers.armed[0]!.ms, BUDGET);
  });

  // ── H5/H6: interruptions, races and the first cause ────────────────────────

  for (const [label, interrupt, expected] of [
    ["the execution's signal (cancellation, shutdown, the lifetime backstop)", "signal", "aborted"],
    ["the stage's deadline", "deadline", "upload_timeout"],
  ] as const) {
    it(`${label} during the put tears the put down and deletes exactly the attempted key`, async () => {
      const jobId = uploadingJobId();
      writer.gates.put = gate();
      const pending = finalizeJobUpload(input(jobId));
      await untilEntered("put");
      if (interrupt === "signal") execution.abort(new Error("cancelled"));
      else {
        clock.now = T0 + BUDGET;
        timers.fire(0);
      }
      const result = await pending;
      assert.deepStrictEqual(result, { type: expected, cleanup: "deleted" });
      assert.strictEqual(writer.records[0]!.abortedSeen, true, "the in-flight put observed it");
      assert.deepStrictEqual(writer.ops(), ["put", "delete"], "no head, and no commit");
      const del = writer.records[1]!;
      assert.strictEqual(del.key, KEY_OF(jobId), "exactly the attempted key");
      assert.ok(del.signal && !del.signal.aborted, "the cleanup ran under its own, live signal");
      assert.notStrictEqual(del.signal, writer.records[0]!.signal);
      assert.strictEqual(store.getJob(jobId)!.status, "uploading");
      assert.strictEqual(store.getJob(jobId)!.objectKey, null);
    });
  }

  it("cancelled after the put, before the head: no head, the key is deleted", async () => {
    const jobId = uploadingJobId();
    const realPut = writer.put.bind(writer);
    writer.put = async (i, context) => {
      await realPut(i, context);
      execution.abort(new Error("cancelled")); // lands as the put returns
    };
    const result = await finalizeJobUpload(input(jobId));
    assert.deepStrictEqual(result, { type: "aborted", cleanup: "deleted" });
    assert.deepStrictEqual(writer.ops(), ["put", "delete"]);
  });

  it("a provider that ignores the abort and 'succeeds' late is never trusted: no head, no commit, key deleted", async () => {
    const jobId = uploadingJobId();
    writer.gates.put = gate();
    writer.ignoreSignal.put = true;
    const pending = finalizeJobUpload(input(jobId));
    await untilEntered("put");
    execution.abort(new Error("cancelled"));
    writer.gates.put.release(); // the put completes anyway, after the abort
    const result = await pending;
    assert.deepStrictEqual(result, { type: "aborted", cleanup: "deleted" });
    assert.deepStrictEqual(writer.ops(), ["put", "delete"]);
    assert.strictEqual(writer.objects.size, 0, "the late object was deleted");
  });

  it("a late SUCCESSFUL head after the deadline never leads to a commit", async () => {
    const jobId = uploadingJobId();
    writer.gates.head = gate();
    writer.ignoreSignal.head = true;
    const pending = finalizeJobUpload(input(jobId));
    await untilEntered("head");
    clock.now = T0 + BUDGET + 5;
    timers.fire(0);
    writer.gates.head.release(); // the head answers, correctly, after the deadline
    const result = await pending;
    assert.deepStrictEqual(result, { type: "upload_timeout", cleanup: "deleted" });
    assert.strictEqual(store.getJob(jobId)!.status, "uploading", "never ready");
    assert.strictEqual(store.getJob(jobId)!.objectKey, null);
  });

  it("an abort landing immediately before the ready CAS prevents it", async () => {
    const jobId = uploadingJobId();
    const realHead = writer.head.bind(writer);
    writer.head = async (key, context) => {
      const answer = await realHead(key, context);
      execution.abort(new Error("cancelled")); // after verification succeeded, before the commit
      return answer;
    };
    const result = await finalizeJobUpload(input(jobId));
    assert.deepStrictEqual(result, { type: "aborted", cleanup: "deleted" });
    assert.strictEqual(store.getJob(jobId)!.status, "uploading");
  });

  it("the first cause wins: a deadline then a cancellation is a timeout; a cancellation then a deadline is an abort", async () => {
    for (const order of [["deadline", "signal"], ["signal", "deadline"]] as const) {
      writer = new GatedWriter();
      timers = new VirtualTimers();
      execution = new AbortController();
      const jobId = uploadingJobId();
      writer.gates.put = gate();
      const pending = finalizeJobUpload(input(jobId));
      await untilEntered("put");
      for (const cause of order) {
        if (cause === "signal") execution.abort(new Error("cancelled"));
        else {
          clock.now = T0 + BUDGET;
          timers.fire(0);
        }
      }
      const result = await pending;
      assert.strictEqual(result.type, order[0] === "deadline" ? "upload_timeout" : "aborted", order.join(" then "));
      clock.now = T0;
    }
  });

  it("an ORDINARY put failure keeps its own code even if the deadline passes during the cleanup", async () => {
    const jobId = uploadingJobId();
    writer.fail.put = true;
    writer.gates.delete = gate();
    const pending = finalizeJobUpload(input(jobId));
    await untilEntered("delete");
    clock.now = T0 + BUDGET + 1;
    timers.armed[0]!.handler(); // even a stage timer that slipped past its disposal
    writer.gates.delete.release();
    const result = await pending;
    assert.deepStrictEqual(result, { type: "storage_failure", code: "put_failed", cleanup: "deleted" });
  });

  it("the stage's abort reason is not a transient error an SDK retry layer would re-attempt", async () => {
    const jobId = uploadingJobId();
    writer.gates.put = gate();
    const pending = finalizeJobUpload(input(jobId));
    await untilEntered("put");
    clock.now = T0 + BUDGET;
    timers.fire(0);
    await pending;
    const reason = writer.records[0]!.signal!.reason as { name?: unknown; code?: unknown; $retryable?: unknown };
    assert.notStrictEqual(reason.name, "TimeoutError", "not AbortSignal.timeout()'s transient-looking reason");
    assert.ok(!["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(String(reason.code)));
    assert.strictEqual(reason.$retryable, undefined);
  });

  // ── E6: cleanup ────────────────────────────────────────────────────────────

  it("a failed cleanup is reported as failed and never as ready; the job stays for its executor", async () => {
    const jobId = uploadingJobId();
    writer.gates.put = gate();
    writer.fail.delete = true;
    const pending = finalizeJobUpload(input(jobId));
    await untilEntered("put");
    execution.abort(new Error("cancelled"));
    const result = await pending;
    assert.deepStrictEqual(result, { type: "aborted", cleanup: "failed" });
    assert.ok(!JSON.stringify(result).includes("provider-internal"), "no provider detail leaks");
    assert.strictEqual(store.getJob(jobId)!.status, "uploading");
    assert.deepStrictEqual(store.listExpiredReadyObjects(10), []);
  });

  it("a cleanup that hangs ends at its own allowance, and the allowance is torn down after", async () => {
    const jobId = uploadingJobId();
    writer.gates.put = gate();
    writer.gates.delete = gate(); // never released: a DeleteObject that never answers
    const pending = finalizeJobUpload(input(jobId));
    await untilEntered("put");
    execution.abort(new Error("cancelled"));
    await untilEntered("delete");
    assert.strictEqual(timers.armed.length, 2, "the stage's timer, then the cleanup allowance's");
    assert.strictEqual(timers.armed[1]!.ms, UPLOAD_CLEANUP_BUDGET_MS);
    assert.strictEqual(timers.armed[1]!.unrefed, true);
    timers.fire(1);
    const result = await pending;
    assert.deepStrictEqual(result, { type: "aborted", cleanup: "failed" });
    assert.strictEqual(writer.records[1]!.abortedSeen, true, "the hanging delete was torn down");
    assert.ok(timers.armed.every((t) => t.cleared), "no timer outlives the call");
  });

  it("pins the cleanup allowance: 5 s, inside the Worker's 10 s shutdown grace", () => {
    assert.strictEqual(UPLOAD_CLEANUP_BUDGET_MS, 5_000);
  });

  it("leaves no listener on the execution's signal once the stage is over", async () => {
    const live = new Set<unknown>();
    const signal = execution.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
      live.add(listener);
      add(type, listener as EventListener, options as AddEventListenerOptions);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
      live.delete(listener);
      remove(type, listener as EventListener, options as EventListenerOptions);
    }) as typeof signal.removeEventListener;
    for (const failPut of [false, true]) {
      writer = new GatedWriter();
      writer.fail.put = failPut;
      const jobId = uploadingJobId();
      await finalizeJobUpload(input(jobId));
      assert.strictEqual(live.size, 0, `no listener left (put ${failPut ? "failed" : "succeeded"})`);
    }
  });

  it("refuses malformed stage bounds before any work", async () => {
    for (const stage of [
      undefined,
      null,
      { signal: execution.signal },
      { signal: execution.signal, deadlineMs: -1 },
      { signal: execution.signal, deadlineMs: 1.5 },
      { signal: execution.signal, deadlineMs: Number.MAX_SAFE_INTEGER + 2 },
      { signal: {}, deadlineMs: T0 + 1 },
      { deadlineMs: T0 + 1 },
    ]) {
      writer = new GatedWriter();
      const jobId = uploadingJobId();
      const result = await finalizeJobUpload({ ...input(jobId), stage: stage as never });
      assert.deepStrictEqual(result, { type: "storage_failure", code: "invalid_input", cleanup: "not_needed" }, JSON.stringify(stage));
      assert.deepStrictEqual(writer.ops(), []);
    }
  });
});
