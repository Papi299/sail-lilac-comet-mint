import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, WORKER_SCHEMA_VERSION } from "./migrations.server.ts";
import { openWorkerDatabase } from "./database.server.ts";
import { SQLiteJobStore } from "./sqlite-job-store.server.ts";
import type { WorkerCreateJobRequest } from "../../shared/worker/contracts.ts";

describe("Worker SQLite State", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videofetch-worker-state-"));
    dbPath = path.join(tempDir, "state.sqlite");
  });

  after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    db = openWorkerDatabase({ path: dbPath });
    applyMigrations(db);
  });

  afterEach(() => {
    try { if (db) db.close(); } catch (e) { void e; }
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
    if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
  });

  it("new DB migration and reopen migration idempotence", () => {
    const versionObj = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.strictEqual(versionObj.user_version, WORKER_SCHEMA_VERSION);

    assert.doesNotThrow(() => {
      applyMigrations(db);
    });
  });

  it("future user_version rejected", () => {
    db.exec(`PRAGMA user_version = ${WORKER_SCHEMA_VERSION + 1}`);
    assert.throws(() => {
      applyMigrations(db);
    }, /Unsupported future schema version/);
  });

  it("missing tables on v1 rejected", () => {
    db.exec("DROP TABLE worker_jobs");
    assert.throws(() => {
      applyMigrations(db);
    }, /missing table worker_jobs/);
  });

  it("STRICT-table behavior", () => {
    assert.throws(() => {
      db.exec("INSERT INTO worker_jobs (job_id, url) VALUES ('123', 'url')");
    }, /NOT NULL constraint failed/);

    assert.throws(() => {
      db.exec(`
        INSERT INTO worker_jobs (job_id, url, format_id, principal_id, status, created_at_ms, updated_at_ms, expires_at_ms)
        VALUES ('123', 'url', 'fmt', 'prin', 'invalid_status', 1, 1, 1)
      `);
    }, /CHECK constraint failed/);
  });

  it("prepared-value round trip with quotes/unicode", () => {
    const store = new SQLiteJobStore({ db });
    const req: WorkerCreateJobRequest = {
      url: "https://example.com/watch?v=hello",
      formatId: "best'quote\"unicode🔥",
      principalId: "private-access-user"
    };

    const result = store.createJob(req, "123e4567-e89b-42d3-a456-426614174001");
    assert.strictEqual(result.type, "created");
    if (result.type !== "created") return;

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    assert.strictEqual(claimed.jobId, result.job.jobId);
    assert.strictEqual(claimed.url, req.url);
    assert.strictEqual(claimed.formatId, req.formatId);
    assert.strictEqual(claimed.principalId, req.principalId);
  });

  it("job view validation", () => {
    const store = new SQLiteJobStore({ db });
    const result = store.createJob({
      url: "https://example.com/",
      formatId: "fmt",
      principalId: "private-access-user"
    }, "123e4567-e89b-42d3-a456-426614174002");
    
    assert.strictEqual(result.type, "created");
    if (result.type !== "created") return;

    const job = result.job;
    assert.strictEqual(job.status, "queued");
    assert.ok(job.createdAt > 0);
  });

  it("invalid generator rollback", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "invalid-uppercase-ID-123" });
    assert.throws(() => {
      store.createJob({
        url: "https://example.com/",
        formatId: "fmt",
        principalId: "private-access-user"
      }, "123e4567-e89b-42d3-a456-426614174003");
    });
    
    const countJobs = (db.prepare("SELECT count(*) as c FROM worker_jobs").get() as any).c;
    const countIdemp = (db.prepare("SELECT count(*) as c FROM worker_idempotency_records").get() as any).c;
    assert.strictEqual(countJobs, 0);
    assert.strictEqual(countIdemp, 0);
  });

  it("invalid idempotency key rejected", () => {
    const store = new SQLiteJobStore({ db });
    assert.throws(() => {
      store.createJob({
        url: "https://example.com/",
        formatId: "fmt",
        principalId: "private-access-user"
      }, "not-a-uuid");
    });
    
    const countJobs = (db.prepare("SELECT count(*) as c FROM worker_jobs").get() as any).c;
    const countIdemp = (db.prepare("SELECT count(*) as c FROM worker_idempotency_records").get() as any).c;
    assert.strictEqual(countJobs, 0);
    assert.strictEqual(countIdemp, 0);
  });

  it("FIFO queue ordering and atomic queued claim", () => {
    let mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, generateJobId: () => Math.random().toString(16).slice(2).padStart(32, '0') });
    
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174004");
    mockTime = 2000;
    store.createJob({ url: "http://b", formatId: "2", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174005");
    
    const queued = store.listQueuedJobs(10);
    assert.strictEqual(queued.length, 2);
    assert.strictEqual(queued[0].createdAt, 1000);
    assert.strictEqual(queued[1].createdAt, 2000);

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    assert.strictEqual(claimed.createdAt, 1000);
    assert.strictEqual(claimed.status, "analyzing");

    const queuedAfter = store.listQueuedJobs(10);
    assert.strictEqual(queuedAfter.length, 1);
  });

  it("expired queued job not claimed", () => {
    let mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, jobTtlMs: 5000, generateJobId: () => "00000000000000000000000000000001" });
    
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174006");
    
    mockTime = 7000;
    const claimed = store.claimNextQueuedJob();
    assert.strictEqual(claimed, null);
  });

  it("cancel CAS and failure CAS explicit returns", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000002" });
    const res = store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174007");
    if (res.type !== "created") assert.fail("not created");
    
    const cancelled = store.cancelJob(res.job.jobId);
    assert.strictEqual(cancelled.type, "cancelled");

    const failed = store.failJob(res.job.jobId, "PROCESSING_FAILED", "failed");
    assert.strictEqual(failed, false);

    const job = store.getJob(res.job.jobId);
    assert.strictEqual(job?.status, "cancelled");
    
    const cancelledAgain = store.cancelJob(res.job.jobId);
    assert.strictEqual(cancelledAgain.type, "unchanged");
  });

  it("fail-first then cancel CAS", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000003" });
    const res = store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174008");
    if (res.type !== "created") assert.fail("not created");
    
    const failed = store.failJob(res.job.jobId, "NETWORK_ERROR", "failed");
    assert.strictEqual(failed, true);

    const cancelled = store.cancelJob(res.job.jobId);
    assert.strictEqual(cancelled.type, "unchanged");

    const job = store.getJob(res.job.jobId);
    assert.strictEqual(job?.status, "failed");
  });

  it("cancel missing job", () => {
    const store = new SQLiteJobStore({ db });
    const cancelled = store.cancelJob("00000000000000000000000000000009");
    assert.strictEqual(cancelled.type, "not_found");
  });

  it("full restart recovery matrix", () => {
    let idCounter = 1;
    const store = new SQLiteJobStore({ db, generateJobId: () => (idCounter++).toString().padStart(32, '0') });
    
    const create = () => {
      const res = store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, `123e4567-e89b-42d3-a456-42661417401${idCounter}`);
      if (res.type !== "created") throw new Error("not created");
      return res.job.jobId;
    };
    
    const jq = create();
    const ja = create();
    const jd = create();
    const jp = create();
    const ju = create();
    const jr = create();
    const jf = create();
    const jc = create();
    
    db.exec(`UPDATE worker_jobs SET status = 'analyzing' WHERE job_id = '${ja}'`);
    db.exec(`UPDATE worker_jobs SET status = 'downloading' WHERE job_id = '${jd}'`);
    db.exec(`UPDATE worker_jobs SET status = 'processing' WHERE job_id = '${jp}'`);
    db.exec(`UPDATE worker_jobs SET status = 'uploading' WHERE job_id = '${ju}'`);
    db.exec(`UPDATE worker_jobs SET status = 'ready', object_key = 'videofetch/jobs/${jr}/12345678901234567890123456789012' WHERE job_id = '${jr}'`);
    db.exec(`UPDATE worker_jobs SET status = 'failed' WHERE job_id = '${jf}'`);
    db.exec(`UPDATE worker_jobs SET status = 'cancelled' WHERE job_id = '${jc}'`);

    db.close();

    const db2 = openWorkerDatabase({ path: dbPath });
    const store2 = new SQLiteJobStore({ db: db2 });
    
    store2.recover();

    assert.strictEqual(store2.getJob(jq)?.status, "queued");
    
    const verifyInterrupted = (id: string) => {
      const j = store2.getJob(id);
      assert.strictEqual(j?.status, "failed");
      assert.strictEqual(j?.errorCode, "PROCESSING_FAILED");
      assert.strictEqual(j?.safeErrorMessage, "Worker restarted before the job completed.");
    };
    
    verifyInterrupted(ja);
    verifyInterrupted(jd);
    verifyInterrupted(jp);
    verifyInterrupted(ju);

    assert.strictEqual(store2.getJob(jr)?.status, "ready");
    assert.strictEqual(store2.getJob(jf)?.status, "failed");
    assert.strictEqual(store2.getJob(jc)?.status, "cancelled");

    db2.close();
  });

  it("idempotency created/existing/conflict/expired", () => {
    let mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, jobTtlMs: 5000, generateJobId: () => Math.random().toString(16).slice(2).padStart(32, '0') });
    
    const req1: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    
    const res1 = store.createJob(req1, "123e4567-e89b-42d3-a456-426614174020");
    assert.strictEqual(res1.type, "created");
    
    const res2 = store.createJob(req1, "123e4567-e89b-42d3-a456-426614174020");
    assert.strictEqual(res2.type, "existing");
    if (res1.type === "created" && res2.type === "existing") {
      assert.strictEqual(res1.job.jobId, res2.job.jobId);
    }

    const req2: WorkerCreateJobRequest = { url: "http://b", formatId: "1", principalId: "private-access-user" };
    const res3 = store.createJob(req2, "123e4567-e89b-42d3-a456-426614174020");
    assert.strictEqual(res3.type, "conflict");

    mockTime = 10000;
    const res4 = store.createJob(req1, "123e4567-e89b-42d3-a456-426614174020");
    assert.strictEqual(res4.type, "expired");
  });

  it("idempotency restart persistence", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000005" });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    store.createJob(req, "123e4567-e89b-42d3-a456-426614174021");
    
    db.close();

    const db2 = openWorkerDatabase({ path: dbPath });
    const store2 = new SQLiteJobStore({ db: db2 });
    
    const res2 = store2.createJob(req, "123e4567-e89b-42d3-a456-426614174021");
    assert.strictEqual(res2.type, "existing");
    
    db2.close();
  });

  it("missing job / surviving tombstone -> expired", () => {
    const mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, generateJobId: () => "00000000000000000000000000000006" });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    store.createJob(req, "123e4567-e89b-42d3-a456-426614174022");
    
    db.exec("DELETE FROM worker_jobs");

    const res2 = store.createJob(req, "123e4567-e89b-42d3-a456-426614174022");
    assert.strictEqual(res2.type, "expired");
  });

  it("expired idempotency record reuse", () => {
    let mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, jobTtlMs: 5000, generateJobId: () => Math.random().toString(16).slice(2).padStart(32, '0') });
    
    const req1: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    store.createJob(req1, "123e4567-e89b-42d3-a456-426614174023");
    
    mockTime = 1000 + 25 * 60 * 60 * 1000;
    
    const req2: WorkerCreateJobRequest = { url: "http://b", formatId: "1", principalId: "private-access-user" };
    const res2 = store.createJob(req2, "123e4567-e89b-42d3-a456-426614174023");
    assert.strictEqual(res2.type, "created");
  });
});
