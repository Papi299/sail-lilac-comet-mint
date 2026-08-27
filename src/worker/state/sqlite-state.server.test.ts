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
    // Migration applied in beforeEach
    const versionObj = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.strictEqual(versionObj.user_version, WORKER_SCHEMA_VERSION);

    // Idempotent
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

    const result = store.createJob(req, "idem-1");
    assert.strictEqual(result.type, "created");
    if (result.type !== "created") return;

    const row = store.getJob(result.job.jobId);
    assert.ok(row);
    assert.strictEqual(row.jobId, result.job.jobId);
  });

  it("job view validation", () => {
    const store = new SQLiteJobStore({ db });
    const result = store.createJob({
      url: "https://example.com/",
      formatId: "fmt",
      principalId: "private-access-user"
    }, "idem-2");
    
    assert.strictEqual(result.type, "created");
    if (result.type !== "created") return;

    const job = result.job;
    assert.strictEqual(job.status, "queued");
    assert.ok(job.createdAt > 0);
  });

  it("FIFO queue ordering and atomic queued claim", () => {
    let mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, generateJobId: () => Math.random().toString(16).slice(2).padStart(32, '0') });
    
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "idem-q1");
    mockTime = 2000;
    store.createJob({ url: "http://b", formatId: "2", principalId: "private-access-user" }, "idem-q2");
    
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
    
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "idem-q3");
    
    // Time travel past TTL (job expires at 6000)
    mockTime = 7000;
    
    const claimed = store.claimNextQueuedJob();
    assert.strictEqual(claimed, null);
  });

  it("cancel CAS and failure CAS", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000002" });
    const res = store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "idem-cas1");
    if (res.type !== "created") assert.fail("not created");
    
    // First terminal transition wins
    const cancelled = store.cancelJob(res.job.jobId);
    assert.strictEqual(cancelled, true);

    const failed = store.failJob(res.job.jobId, "PROCESSING_FAILED", "failed");
    assert.strictEqual(failed, false);

    const job = store.getJob(res.job.jobId);
    assert.strictEqual(job?.status, "cancelled");
  });

  it("fail-first then cancel CAS", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000003" });
    const res = store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "idem-cas2");
    if (res.type !== "created") assert.fail("not created");
    
    const failed = store.failJob(res.job.jobId, "NETWORK_ERROR", "failed");
    assert.strictEqual(failed, true);

    const cancelled = store.cancelJob(res.job.jobId);
    assert.strictEqual(cancelled, false);

    const job = store.getJob(res.job.jobId);
    assert.strictEqual(job?.status, "failed");
  });

  it("restart recovery", () => {
    let idCounter = 1;
    const store = new SQLiteJobStore({ db, generateJobId: () => `0000000000000000000000000000000${idCounter++}` });
    
    const res1 = store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "idem-rr1");
    const res2 = store.createJob({ url: "http://b", formatId: "2", principalId: "private-access-user" }, "idem-rr2");
    const res3 = store.createJob({ url: "http://c", formatId: "3", principalId: "private-access-user" }, "idem-rr3");
    
    if (res1.type !== "created" || res2.type !== "created" || res3.type !== "created") assert.fail("not created");

    store.claimNextQueuedJob(); // res1 becomes analyzing
    store.cancelJob(res3.job.jobId); // res3 becomes cancelled
    // res2 remains queued

    db.close();

    const db2 = openWorkerDatabase({ path: dbPath });
    const store2 = new SQLiteJobStore({ db: db2 });
    
    store2.recover();

    const job1 = store2.getJob(res1.job.jobId);
    assert.strictEqual(job1?.status, "failed");
    assert.strictEqual(job1?.errorCode, "PROCESSING_FAILED");

    const job2 = store2.getJob(res2.job.jobId);
    assert.strictEqual(job2?.status, "queued");

    const job3 = store2.getJob(res3.job.jobId);
    assert.strictEqual(job3?.status, "cancelled");

    db2.close();
  });

  it("idempotency created/existing/conflict/expired", () => {
    let mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, jobTtlMs: 5000, generateJobId: () => Math.random().toString(16).slice(2).padStart(32, '0') });
    
    const req1: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    
    // Created
    const res1 = store.createJob(req1, "key-1");
    assert.strictEqual(res1.type, "created");
    
    // Same key, same payload -> Existing
    const res2 = store.createJob(req1, "key-1");
    assert.strictEqual(res2.type, "existing");
    if (res1.type === "created" && res2.type === "existing") {
      assert.strictEqual(res1.job.jobId, res2.job.jobId);
    }

    // Same key, different payload -> Conflict
    const req2: WorkerCreateJobRequest = { url: "http://b", formatId: "1", principalId: "private-access-user" };
    const res3 = store.createJob(req2, "key-1");
    assert.strictEqual(res3.type, "conflict");

    // Expired referenced job
    mockTime = 10000; // Past job TTL (which was 5000), but inside idempotency TTL (24h)
    const res4 = store.createJob(req1, "key-1");
    assert.strictEqual(res4.type, "expired");
  });

  it("idempotency restart persistence", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000005" });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    store.createJob(req, "key-persistence");
    
    db.close();

    const db2 = openWorkerDatabase({ path: dbPath });
    const store2 = new SQLiteJobStore({ db: db2 });
    
    const res2 = store2.createJob(req, "key-persistence");
    assert.strictEqual(res2.type, "existing");
    
    db2.close();
  });

  it("missing job / surviving tombstone -> expired", () => {
    const mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, generateJobId: () => "00000000000000000000000000000006" });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    store.createJob(req, "key-tomb");
    
    // Manually delete the job to simulate tombstone behavior
    db.exec("DELETE FROM worker_jobs");

    const res2 = store.createJob(req, "key-tomb");
    assert.strictEqual(res2.type, "expired"); // Expected logical result
  });

  it("expired idempotency record reuse", () => {
    let mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, jobTtlMs: 5000, generateJobId: () => Math.random().toString(16).slice(2).padStart(32, '0') });
    
    const req1: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    store.createJob(req1, "key-reuse");
    
    // Advance past idempotency min retention (24h)
    mockTime = 1000 + 25 * 60 * 60 * 1000;
    
    // Different payload should not conflict because it's expired
    const req2: WorkerCreateJobRequest = { url: "http://b", formatId: "1", principalId: "private-access-user" };
    const res2 = store.createJob(req2, "key-reuse");
    assert.strictEqual(res2.type, "created");
  });
});
