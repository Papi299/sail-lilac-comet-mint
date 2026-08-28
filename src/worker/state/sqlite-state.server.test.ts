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

  // ── Schema integrity regression matrix (§10) ──────────────────────────────

  it("valid fresh v0 migrates and validates", () => {
    const versionObj = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.strictEqual(versionObj.user_version, WORKER_SCHEMA_VERSION);
    // Idempotent reopen
    assert.doesNotThrow(() => { applyMigrations(db); });
  });

  it("valid v1 reopen validates", () => {
    db.close();
    const db2 = openWorkerDatabase({ path: dbPath });
    assert.doesNotThrow(() => { applyMigrations(db2); });
    db2.close();
    // Reopen for afterEach cleanup
    db = openWorkerDatabase({ path: dbPath });
  });

  it("future user_version rejected", () => {
    db.exec(`PRAGMA user_version = ${WORKER_SCHEMA_VERSION + 1}`);
    assert.throws(() => { applyMigrations(db); }, /Unsupported future schema version/);
  });

  it("v1 missing worker_jobs rejected", () => {
    db.exec("DROP TABLE worker_jobs");
    assert.throws(() => { applyMigrations(db); }, /missing table worker_jobs/);
  });

  it("v1 missing worker_idempotency_records rejected", () => {
    db.exec("DROP TABLE worker_idempotency_records");
    assert.throws(() => { applyMigrations(db); }, /missing table worker_idempotency_records/);
  });

  it("v1 missing worker_replay_requests rejected", () => {
    db.exec("DROP TABLE worker_replay_requests");
    assert.throws(() => { applyMigrations(db); }, /missing table worker_replay_requests/);
  });

  it("v1 missing critical worker_jobs column rejected", () => {
    // Recreate worker_jobs without the 'object_key' column
    db.exec("DROP TABLE worker_jobs");
    db.exec(`
      CREATE TABLE worker_jobs (
        job_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        format_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL,
        stage_label TEXT,
        downloaded_bytes INTEGER,
        total_bytes INTEGER,
        speed REAL,
        eta REAL,
        error_code TEXT,
        safe_error_message TEXT,
        filename TEXT,
        file_size INTEGER,
        mime TEXT,
        quality TEXT,
        container TEXT,
        title TEXT,
        thumbnail TEXT,
        source TEXT,
        extractor TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        started_at_ms INTEGER,
        finished_at_ms INTEGER
      ) STRICT;
    `);
    assert.throws(() => { applyMigrations(db); }, /missing column object_key in worker_jobs/);
  });

  it("v1 missing critical idempotency column rejected", () => {
    db.exec("DROP TABLE worker_idempotency_records");
    db.exec(`
      CREATE TABLE worker_idempotency_records (
        idempotency_key TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        job_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    assert.throws(() => { applyMigrations(db); }, /missing column job_expires_at_ms in worker_idempotency_records/);
  });

  it("v1 missing critical replay column rejected", () => {
    db.exec("DROP INDEX idx_worker_replay_requests_expires_at_seconds");
    db.exec("DROP TABLE worker_replay_requests");
    db.exec(`
      CREATE TABLE worker_replay_requests (
        request_id TEXT PRIMARY KEY,
        expires_at_seconds INTEGER NOT NULL
      ) STRICT;
    `);
    assert.throws(() => { applyMigrations(db); }, /missing column created_at_seconds in worker_replay_requests/);
  });

  it("v1 missing replay expiration index rejected", () => {
    db.exec("DROP INDEX idx_worker_replay_requests_expires_at_seconds");
    assert.throws(() => { applyMigrations(db); }, /missing index idx_worker_replay_requests_expires_at_seconds/);
  });

  it("v1 missing idempotency expiration index rejected", () => {
    db.exec("DROP INDEX idx_worker_idempotency_records_expires_at_ms");
    assert.throws(() => { applyMigrations(db); }, /missing index idx_worker_idempotency_records_expires_at_ms/);
  });

  // ── STRICT-table behavior ──────────────────────────────────────────────────

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

  // ── Job creation and round-trip ────────────────────────────────────────────

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

  // ── Queue and claim ────────────────────────────────────────────────────────

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

  // ── Cancel / fail CAS ─────────────────────────────────────────────────────

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

  // ── Transition pre- and post-commit validation regressions ─────────────────

  it("claimNextQueuedJob corrupted queue rollback", () => {
    const mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, generateJobId: () => "00000000000000000000000000000010" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174060");
    
    // Corrupt the row using prepared SQL
    const stmt = db.prepare("UPDATE worker_jobs SET object_key = ? WHERE job_id = ?");
    stmt.run("videofetch/jobs/00000000000000000000000000000010/12345678901234567890123456789012", "00000000000000000000000000000010");

    assert.throws(() => { store.claimNextQueuedJob(); });
    
    const row = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get("00000000000000000000000000000010") as any;
    assert.strictEqual(row.status, "queued");
  });

  it("claimNextQueuedJob second claim corruption regression", () => {
    const mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, generateJobId: () => "00000000000000000000000000000011" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174061");
    
    // SQLite allows any string without constraints for url unless we add CHECK. But we rely on Zod schema.
    const stmt = db.prepare("UPDATE worker_jobs SET url = ? WHERE job_id = ?");
    stmt.run("not-a-valid-http-url", "00000000000000000000000000000011");

    assert.throws(() => { store.claimNextQueuedJob(); });
    
    const row = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get("00000000000000000000000000000011") as any;
    assert.strictEqual(row.status, "queued");
  });

  it("claimNextQueuedJob post-transition validation rollback", () => {
    const mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, generateJobId: () => "00000000000000000000000000000012" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174062");
    
    // Test-only trigger to corrupt the resulting row during transition
    db.exec(`
      CREATE TRIGGER test_corrupt_analyzing AFTER UPDATE ON worker_jobs
      WHEN NEW.status = 'analyzing'
      BEGIN
        UPDATE worker_jobs SET object_key = 'videofetch/jobs/00000000000000000000000000000012/12345678901234567890123456789012' WHERE job_id = NEW.job_id;
      END;
    `);

    assert.throws(() => { store.claimNextQueuedJob(); });
    
    db.exec("DROP TRIGGER test_corrupt_analyzing");

    const row = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get("00000000000000000000000000000012") as any;
    assert.strictEqual(row.status, "queued");
    assert.strictEqual(row.object_key, null);
  });

  it("cancelJob corruption rollback", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000013" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174063");
    
    db.exec(`
      CREATE TRIGGER test_corrupt_cancel AFTER UPDATE ON worker_jobs
      WHEN NEW.status = 'cancelled'
      BEGIN
        UPDATE worker_jobs SET url = 'invalid-url' WHERE job_id = NEW.job_id;
      END;
    `);

    assert.throws(() => { store.cancelJob("00000000000000000000000000000013"); });
    
    db.exec("DROP TRIGGER test_corrupt_cancel");

    const row = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get("00000000000000000000000000000013") as any;
    assert.strictEqual(row.status, "queued"); // original active state
  });

  it("failJob corruption behavior", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000014" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174064");
    
    // Corrupt the row before failing
    const stmt = db.prepare("UPDATE worker_jobs SET url = ? WHERE job_id = ?");
    stmt.run("not-a-url", "00000000000000000000000000000014");

    assert.throws(() => { store.failJob("00000000000000000000000000000014", "NETWORK_ERROR", "test"); });
    
    const row = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get("00000000000000000000000000000014") as any;
    assert.strictEqual(row.status, "queued");
  });

  it("recover atomic-corruption regression", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000015" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174065");
    const store2 = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000016" });
    store2.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174066");
    
    // Advance both to active state
    db.prepare("UPDATE worker_jobs SET status = 'analyzing' WHERE job_id = '00000000000000000000000000000015'").run();
    db.prepare("UPDATE worker_jobs SET status = 'processing' WHERE job_id = '00000000000000000000000000000016'").run();

    // Corrupt B only
    db.prepare("UPDATE worker_jobs SET url = 'invalid' WHERE job_id = '00000000000000000000000000000016'").run();

    assert.throws(() => { store.recover(); });

    // Verify all-or-nothing rollback
    const a = db.prepare("SELECT * FROM worker_jobs WHERE job_id = '00000000000000000000000000000015'").get() as any;
    const b = db.prepare("SELECT * FROM worker_jobs WHERE job_id = '00000000000000000000000000000016'").get() as any;
    
    assert.strictEqual(a.status, "analyzing");
    assert.strictEqual(b.status, "processing");
  });

  it("recover post-update validation regression", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "00000000000000000000000000000017" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174067");
    
    db.prepare("UPDATE worker_jobs SET status = 'analyzing' WHERE job_id = '00000000000000000000000000000017'").run();

    // Test-only trigger to corrupt one recovery result
    db.exec(`
      CREATE TRIGGER test_corrupt_recover AFTER UPDATE ON worker_jobs
      WHEN NEW.status = 'failed'
      BEGIN
        UPDATE worker_jobs SET url = 'invalid-url' WHERE job_id = NEW.job_id;
      END;
    `);

    assert.throws(() => { store.recover(); });
    
    db.exec("DROP TRIGGER test_corrupt_recover");

    const row = db.prepare("SELECT * FROM worker_jobs WHERE job_id = '00000000000000000000000000000017'").get() as any;
    assert.strictEqual(row.status, "analyzing");
  });

  // ── Restart recovery (§15: prepared statements for test fixtures) ─────────

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

    // §15: Use prepared statements with bound parameters for dynamic fixture IDs
    const setStatus = db.prepare("UPDATE worker_jobs SET status = ? WHERE job_id = ?");
    setStatus.run("analyzing", ja);
    setStatus.run("downloading", jd);
    setStatus.run("processing", jp);
    setStatus.run("uploading", ju);

    const setReady = db.prepare("UPDATE worker_jobs SET status = 'ready', object_key = ? WHERE job_id = ?");
    setReady.run(`videofetch/jobs/${jr}/12345678901234567890123456789012`, jr);

    setStatus.run("failed", jf);
    setStatus.run("cancelled", jc);

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

  // ── No-generator retry regressions (§4) ────────────────────────────────────

  it("existing retry does NOT invoke generator", () => {
    const storeA = new SQLiteJobStore({ db });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    storeA.createJob(req, "123e4567-e89b-42d3-a456-426614174030");

    const storeB = new SQLiteJobStore({ db, generateJobId: () => { throw new Error("generator must not run"); } });
    const res = storeB.createJob(req, "123e4567-e89b-42d3-a456-426614174030");
    assert.strictEqual(res.type, "existing");
  });

  it("conflict does NOT invoke generator", () => {
    const storeA = new SQLiteJobStore({ db });
    const req1: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    storeA.createJob(req1, "123e4567-e89b-42d3-a456-426614174031");

    const storeB = new SQLiteJobStore({ db, generateJobId: () => { throw new Error("generator must not run"); } });
    const req2: WorkerCreateJobRequest = { url: "http://b", formatId: "1", principalId: "private-access-user" };
    const res = storeB.createJob(req2, "123e4567-e89b-42d3-a456-426614174031");
    assert.strictEqual(res.type, "conflict");
  });

  it("expired-via-job-ttl does NOT invoke generator", () => {
    let mockTime = 1000;
    const storeA = new SQLiteJobStore({ db, clock: () => mockTime, jobTtlMs: 5000 });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    storeA.createJob(req, "123e4567-e89b-42d3-a456-426614174032");

    // Advance past job TTL but within idempotency retention (24h)
    mockTime = 10000;
    const storeB = new SQLiteJobStore({ db, clock: () => mockTime, jobTtlMs: 5000, generateJobId: () => { throw new Error("generator must not run"); } });
    const res = storeB.createJob(req, "123e4567-e89b-42d3-a456-426614174032");
    assert.strictEqual(res.type, "expired");
  });

  it("tombstone (missing job row) does NOT invoke generator", () => {
    const mockTime = 1000;
    const storeA = new SQLiteJobStore({ db, clock: () => mockTime });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    storeA.createJob(req, "123e4567-e89b-42d3-a456-426614174033");

    db.exec("DELETE FROM worker_jobs");

    const storeB = new SQLiteJobStore({ db, clock: () => mockTime, generateJobId: () => { throw new Error("generator must not run"); } });
    const res = storeB.createJob(req, "123e4567-e89b-42d3-a456-426614174033");
    assert.strictEqual(res.type, "expired");
  });

  it("expired idempotency record reuse DOES invoke generator", () => {
    let mockTime = 1000;
    let generatorCalled = false;
    const storeA = new SQLiteJobStore({ db, clock: () => mockTime, jobTtlMs: 5000 });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    storeA.createJob(req, "123e4567-e89b-42d3-a456-426614174034");

    // Advance past idempotency retention (24h)
    mockTime = 1000 + 25 * 60 * 60 * 1000;
    const storeB = new SQLiteJobStore({
      db, clock: () => mockTime, jobTtlMs: 5000,
      generateJobId: () => { generatorCalled = true; return Math.random().toString(16).slice(2).padStart(32, '0'); }
    });
    const req2: WorkerCreateJobRequest = { url: "http://b", formatId: "1", principalId: "private-access-user" };
    const res = storeB.createJob(req2, "123e4567-e89b-42d3-a456-426614174034");
    assert.strictEqual(res.type, "created");
    assert.strictEqual(generatorCalled, true);
  });

  // ── Durable object-key corruption tests (§7) ──────────────────────────────

  it("queued + non-null objectKey fails closed", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174040");

    // Corrupt: set objectKey on a queued job
    const stmt = db.prepare("UPDATE worker_jobs SET object_key = ? WHERE job_id = ?");
    stmt.run("videofetch/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1/12345678901234567890123456789012", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1");

    assert.throws(() => { store.getJob("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1"); }, /non-ready job must have null objectKey/);
  });

  it("analyzing + objectKey rejected", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174041");

    const setStatus = db.prepare("UPDATE worker_jobs SET status = ?, object_key = ? WHERE job_id = ?");
    setStatus.run("analyzing", "videofetch/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2/12345678901234567890123456789012", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2");

    assert.throws(() => { store.getJob("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2"); }, /non-ready job must have null objectKey/);
  });

  it("ready + null objectKey rejected", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174042");

    const stmt = db.prepare("UPDATE worker_jobs SET status = 'ready' WHERE job_id = ?");
    stmt.run("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3");

    assert.throws(() => { store.getJob("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3"); }, /ready job must have a non-null objectKey/);
  });

  it("ready + objectKey belonging to DIFFERENT job ID rejected", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174043");

    // objectKey embeds a DIFFERENT job ID
    const stmt = db.prepare("UPDATE worker_jobs SET status = 'ready', object_key = ? WHERE job_id = ?");
    stmt.run("videofetch/jobs/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/12345678901234567890123456789012", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4");

    assert.throws(() => { store.getJob("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4"); }, /objectKey embedded job ID must equal jobId/);
  });

  it("ready + correctly matching objectKey accepted", () => {
    const store = new SQLiteJobStore({ db, generateJobId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5" });
    store.createJob({ url: "http://a", formatId: "1", principalId: "private-access-user" }, "123e4567-e89b-42d3-a456-426614174044");

    const stmt = db.prepare("UPDATE worker_jobs SET status = 'ready', object_key = ? WHERE job_id = ?");
    stmt.run("videofetch/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5/12345678901234567890123456789012", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5");

    const job = store.getJob("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5");
    assert.ok(job);
    assert.strictEqual(job.status, "ready");
    assert.strictEqual(job.objectKey, "videofetch/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5/12345678901234567890123456789012");
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

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

  // ── Explicit maintenance cleanup (§11) ─────────────────────────────────────

  it("cleanupExpiredIdempotencyRecords deletes expired records", () => {
    let mockTime = 1000;
    const store = new SQLiteJobStore({ db, clock: () => mockTime, jobTtlMs: 5000 });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    store.createJob(req, "123e4567-e89b-42d3-a456-426614174050");

    // Count before
    const countBefore = (db.prepare("SELECT count(*) as c FROM worker_idempotency_records").get() as any).c;
    assert.strictEqual(countBefore, 1);

    // Advance past idempotency expiry (24h)
    mockTime = 1000 + 25 * 60 * 60 * 1000;
    const deleted = store.cleanupExpiredIdempotencyRecords();
    assert.strictEqual(deleted, 1);

    const countAfter = (db.prepare("SELECT count(*) as c FROM worker_idempotency_records").get() as any).c;
    assert.strictEqual(countAfter, 0);
  });

  it("cleanupExpiredIdempotencyRecords does not delete unexpired records", () => {
    const store = new SQLiteJobStore({ db, clock: () => 1000 });
    const req: WorkerCreateJobRequest = { url: "http://a", formatId: "1", principalId: "private-access-user" };
    store.createJob(req, "123e4567-e89b-42d3-a456-426614174051");

    const deleted = store.cleanupExpiredIdempotencyRecords();
    assert.strictEqual(deleted, 0);

    const count = (db.prepare("SELECT count(*) as c FROM worker_idempotency_records").get() as any).c;
    assert.strictEqual(count, 1);
  });
});
