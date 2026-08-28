import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type { WorkerJobStore } from "../state/job-store.ts";
import type {
  ObjectStoreHead,
  ObjectStorePutInput,
  ObjectStoreWriter,
} from "../storage/writer.ts";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";
import {
  WorkerMaintenance,
  type WorkerMaintenanceCategory,
} from "./maintenance.server.ts";

/**
 * Runtime maintenance (§18–§21).
 *
 * Real SQLite, real store, fake writer. No network of any kind, and no test
 * waits on a wall-clock interval — the timer is injected.
 */

const JOB_ID = "0123456789abcdef0123456789abcdef";
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/aaaabbbbccccddddeeeeffff00001111`;

/** Records every delete. Cannot express a prefix, list or wildcard operation. */
class RecordingWriter implements ObjectStoreWriter {
  public readonly deleted: string[] = [];
  public readonly puts: string[] = [];
  public readonly heads: string[] = [];
  public failDelete: ((key: string) => boolean) | null = null;

  async put(input: ObjectStorePutInput): Promise<void> {
    this.puts.push(input.objectKey);
  }
  async head(objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    this.heads.push(objectKey);
    return null;
  }
  async delete(objectKey: WorkerObjectKey): Promise<void> {
    if (this.failDelete?.(objectKey)) {
      throw new Error("provider failure carrying credentials: AKIA-SECRET-DO-NOT-LOG");
    }
    this.deleted.push(objectKey);
  }
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

describe("Worker runtime maintenance", () => {
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let writer: RecordingWriter;
  let now: number;
  let categories: WorkerMaintenanceCategory[];

  function insertReadyJob(jobId = JOB_ID, objectKey = OBJECT_KEY, expiresAt = now - 1) {
    db.prepare(
      `INSERT INTO worker_jobs
        (job_id, url, format_id, principal_id, status, object_key,
         created_at_ms, updated_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
    ).run(
      jobId,
      "https://cdn.example/clip.mp4",
      "direct-original",
      "private-access-user",
      objectKey,
      now - 100_000,
      now - 100_000,
      expiresAt,
    );
  }

  function insertNonReadyJob(jobId: string, status: string) {
    db.prepare(
      `INSERT INTO worker_jobs
        (job_id, url, format_id, principal_id, status, object_key,
         created_at_ms, updated_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      jobId,
      "https://cdn.example/clip.mp4",
      "direct-original",
      "private-access-user",
      status,
      now - 100_000,
      now - 100_000,
      now - 1,
    );
  }

  function makeMaintenance(overrides: Partial<{
    store: WorkerJobStore;
    replayStore: { cleanup(): void };
    writer: ObjectStoreWriter;
    batchSize: number;
  }> = {}) {
    return new WorkerMaintenance({
      store: overrides.store ?? store,
      replayStore: overrides.replayStore ?? { cleanup: () => {} },
      writer: overrides.writer ?? writer,
      ...(overrides.batchSize !== undefined ? { batchSize: overrides.batchSize } : {}),
      onError: (category) => categories.push(category),
    });
  }

  beforeEach(() => {
    db = openWorkerDatabase({ path: ":memory:" });
    applyMigrations(db);
    now = 1_800_000_000_000;
    store = new SQLiteJobStore({ db, clock: () => now });
    writer = new RecordingWriter();
    categories = [];
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  describe("expired ready-object cleanup", () => {
    it("deletes the EXACT object key then removes the exact metadata row", async () => {
      insertReadyJob();

      const report = await makeMaintenance().runOnce();

      assert.deepEqual(writer.deleted, [OBJECT_KEY], "exactly one exact-key delete");
      assert.equal(report.expiredObjects.scanned, 1);
      assert.equal(report.expiredObjects.objectsDeleted, 1);
      assert.equal(report.expiredObjects.metadataDeleted, 1);
      assert.equal(countRows(db, "worker_jobs"), 0);
    });

    it("never lists, heads or puts during cleanup", async () => {
      insertReadyJob();

      await makeMaintenance().runOnce();

      assert.deepEqual(writer.heads, [], "no HeadObject during maintenance");
      assert.deepEqual(writer.puts, [], "no PutObject during maintenance");
    });

    it("RETAINS metadata when the object delete fails", async () => {
      insertReadyJob();
      writer.failDelete = () => true;

      const report = await makeMaintenance().runOnce();

      assert.deepEqual(writer.deleted, [], "the failing delete recorded nothing");
      assert.equal(report.expiredObjects.objectDeleteFailures, 1);
      assert.equal(report.expiredObjects.metadataDeleted, 0);
      assert.equal(countRows(db, "worker_jobs"), 1, "metadata is retained for retry");
      assert.deepEqual(categories, ["expired_object_delete"]);
    });

    it("retries successfully on a later pass after a delete failure", async () => {
      insertReadyJob();
      writer.failDelete = () => true;
      const maintenance = makeMaintenance();

      await maintenance.runOnce();
      assert.equal(countRows(db, "worker_jobs"), 1);

      writer.failDelete = null;
      const second = await maintenance.runOnce();

      assert.deepEqual(writer.deleted, [OBJECT_KEY]);
      assert.equal(second.expiredObjects.metadataDeleted, 1);
      assert.equal(countRows(db, "worker_jobs"), 0);
    });

    it("leaves a retry-safe state when metadata cleanup fails after a successful delete", async () => {
      insertReadyJob();

      const failingStore: WorkerJobStore = Object.create(store);
      failingStore.deleteExpiredReadyMetadata = () => {
        throw new Error("sqlite failure");
      };

      const report = await makeMaintenance({ store: failingStore }).runOnce();

      assert.deepEqual(writer.deleted, [OBJECT_KEY], "the object was still deleted exactly once");
      assert.equal(report.expiredObjects.metadataDeleteFailures, 1);
      assert.equal(report.expiredObjects.metadataDeleted, 0);
      // No broad delete fallback: the row is simply left for the next pass.
      assert.equal(countRows(db, "worker_jobs"), 1);
      assert.deepEqual(categories, ["expired_metadata_delete"]);
    });

    it("does NOT call the writer for a non-expired ready object", async () => {
      insertReadyJob(JOB_ID, OBJECT_KEY, now + 600_000);

      const report = await makeMaintenance().runOnce();

      assert.deepEqual(writer.deleted, []);
      assert.equal(report.expiredObjects.scanned, 0);
      assert.equal(countRows(db, "worker_jobs"), 1);
    });

    it("does NOT call the writer for non-ready jobs", async () => {
      const statuses = ["queued", "analyzing", "downloading", "processing", "uploading", "failed", "cancelled"];
      statuses.forEach((status, index) => {
        insertNonReadyJob(index.toString(16).padStart(32, "0"), status);
      });

      const report = await makeMaintenance().runOnce();

      assert.deepEqual(writer.deleted, [], "non-ready jobs own no object to delete");
      assert.equal(report.expiredObjects.scanned, 0);
      assert.equal(countRows(db, "worker_jobs"), statuses.length);
    });

    it("preserves the idempotency tombstone across object metadata cleanup", async () => {
      insertReadyJob();
      const key = randomUUID();
      db.prepare(
        `INSERT INTO worker_idempotency_records
          (idempotency_key, payload_hash, job_id, created_at_ms, job_expires_at_ms, expires_at_ms)
         VALUES (?, 'hash', ?, ?, ?, ?)`,
      ).run(key, JOB_ID, now - 100_000, now - 1, now + 3_600_000);

      await makeMaintenance().runOnce();

      assert.equal(countRows(db, "worker_jobs"), 0);
      assert.equal(
        countRows(db, "worker_idempotency_records"),
        1,
        "a still-retained tombstone must survive job metadata cleanup",
      );
    });

    it("bounds the batch size", async () => {
      for (let i = 0; i < 5; i += 1) {
        const jobId = i.toString(16).padStart(32, "0");
        insertReadyJob(jobId, `videofetch/jobs/${jobId}/${"a".repeat(32)}`);
      }

      const report = await makeMaintenance({ batchSize: 2 }).runOnce();

      assert.equal(report.expiredObjects.scanned, 2);
      assert.equal(writer.deleted.length, 2);
      assert.equal(countRows(db, "worker_jobs"), 3, "the rest wait for the next pass");
    });

    it("isolates a single object failure from the rest of the batch", async () => {
      const failingId = "1".repeat(32);
      const failingKey = `videofetch/jobs/${failingId}/${"b".repeat(32)}`;
      const okId = "2".repeat(32);
      const okKey = `videofetch/jobs/${okId}/${"c".repeat(32)}`;
      insertReadyJob(failingId, failingKey, now - 2);
      insertReadyJob(okId, okKey, now - 1);
      writer.failDelete = (key) => key === failingKey;

      const report = await makeMaintenance().runOnce();

      assert.deepEqual(writer.deleted, [okKey]);
      assert.equal(report.expiredObjects.objectDeleteFailures, 1);
      assert.equal(report.expiredObjects.metadataDeleted, 1);
      assert.equal(countRows(db, "worker_jobs"), 1, "only the failing job's metadata remains");
    });
  });

  describe("failure isolation", () => {
    it("continues past a replay-cleanup failure", async () => {
      insertReadyJob();

      const report = await makeMaintenance({
        replayStore: { cleanup: () => { throw new Error("replay failure"); } },
      }).runOnce();

      assert.equal(report.replayCleanup, "failed");
      assert.equal(report.idempotencyCleanup, "ok", "idempotency cleanup still ran");
      assert.deepEqual(writer.deleted, [OBJECT_KEY], "object cleanup still ran");
      assert.ok(categories.includes("replay_cleanup"));
    });

    it("continues past an idempotency-cleanup failure", async () => {
      insertReadyJob();
      const failingStore: WorkerJobStore = Object.create(store);
      failingStore.cleanupExpiredIdempotencyRecords = () => {
        throw new Error("sqlite failure");
      };

      const report = await makeMaintenance({ store: failingStore }).runOnce();

      assert.equal(report.idempotencyCleanup, "failed");
      assert.deepEqual(writer.deleted, [OBJECT_KEY], "object cleanup still ran");
      assert.ok(categories.includes("idempotency_cleanup"));
    });

    it("contains a scan failure without rejecting", async () => {
      const failingStore: WorkerJobStore = Object.create(store);
      failingStore.listExpiredReadyObjects = () => {
        throw new Error("sqlite failure");
      };

      const report = await makeMaintenance({ store: failingStore }).runOnce();

      assert.equal(report.expiredObjects.scan, "failed");
      assert.deepEqual(writer.deleted, []);
      assert.ok(categories.includes("expired_object_scan"));
    });

    it("never surfaces a provider or store raw message", async () => {
      insertReadyJob();
      writer.failDelete = () => true;

      const report = await makeMaintenance().runOnce();

      // The error callback receives a CATEGORY only. The provider message that
      // carried a credential-shaped string never reaches any consumer.
      const rendered = JSON.stringify({ report, categories });
      assert.ok(!rendered.includes("AKIA-SECRET-DO-NOT-LOG"));
      assert.deepEqual(categories, ["expired_object_delete"]);
    });

    it("runOnce resolves rather than rejecting when everything fails", async () => {
      const failingStore: WorkerJobStore = Object.create(store);
      failingStore.cleanupExpiredIdempotencyRecords = () => { throw new Error("x"); };
      failingStore.listExpiredReadyObjects = () => { throw new Error("x"); };

      const report = await makeMaintenance({
        store: failingStore,
        replayStore: { cleanup: () => { throw new Error("x"); } },
      }).runOnce();

      assert.equal(report.replayCleanup, "failed");
      assert.equal(report.idempotencyCleanup, "failed");
      assert.equal(report.expiredObjects.scan, "failed");
    });
  });

  describe("overlap and lifecycle", () => {
    it("makes two concurrent runs IMPOSSIBLE", async () => {
      insertReadyJob();

      let concurrent = 0;
      let maxConcurrent = 0;
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => { release = resolve; });

      const slowStore: WorkerJobStore = Object.create(store);
      slowStore.cleanupExpiredIdempotencyRecords = () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        concurrent -= 1;
        return 0;
      };
      const slowWriter = new RecordingWriter();
      slowWriter.delete = async (key: WorkerObjectKey) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate;
        slowWriter.deleted.push(key);
        concurrent -= 1;
      };

      const maintenance = makeMaintenance({ store: slowStore, writer: slowWriter });

      const first = maintenance.runOnce();
      const second = maintenance.runOnce();
      const third = maintenance.runOnce();

      assert.ok(maintenance.isRunning, "a pass is in flight");
      release!();
      const [a, b, c] = await Promise.all([first, second, third]);

      assert.equal(maxConcurrent, 1, "maintenance never overlapped");
      assert.equal(slowWriter.deleted.length, 1, "the object was deleted exactly once");
      // Concurrent callers join the in-flight pass rather than starting another.
      assert.equal(a, b);
      assert.equal(b, c);
      assert.equal(maintenance.isRunning, false);
    });

    it("creates no timer until start() is called", () => {
      const created: number[] = [];
      const maintenance = new WorkerMaintenance({
        store,
        replayStore: { cleanup: () => {} },
        writer,
        intervalMs: 60_000,
        setIntervalFn: (_handler, ms) => { created.push(ms); return { unref: () => {} }; },
        clearIntervalFn: () => {},
      });

      assert.deepEqual(created, [], "constructing must not schedule anything");
      assert.equal(maintenance.isStarted, false);

      maintenance.start();
      assert.deepEqual(created, [60_000]);
      assert.equal(maintenance.isStarted, true);
    });

    it("start() is idempotent and stop() clears the timer", async () => {
      let cleared = 0;
      const handle = { unref: () => {} };
      const maintenance = new WorkerMaintenance({
        store,
        replayStore: { cleanup: () => {} },
        writer,
        setIntervalFn: () => handle,
        clearIntervalFn: (h) => { assert.equal(h, handle); cleared += 1; },
      });

      maintenance.start();
      maintenance.start();
      maintenance.start();
      assert.equal(maintenance.isStarted, true);

      await maintenance.stop();

      assert.equal(cleared, 1, "exactly one timer existed and was cleared");
      assert.equal(maintenance.isStarted, false);
    });

    it("unrefs its timer so maintenance never holds the process open", () => {
      let unrefCalls = 0;
      const maintenance = new WorkerMaintenance({
        store,
        replayStore: { cleanup: () => {} },
        writer,
        setIntervalFn: () => ({ unref: () => { unrefCalls += 1; return null; } }),
        clearIntervalFn: () => {},
      });

      maintenance.start();
      assert.equal(unrefCalls, 1);
    });

    it("does not re-arm after stop()", async () => {
      let created = 0;
      const maintenance = new WorkerMaintenance({
        store,
        replayStore: { cleanup: () => {} },
        writer,
        setIntervalFn: () => { created += 1; return { unref: () => {} }; },
        clearIntervalFn: () => {},
      });

      maintenance.start();
      await maintenance.stop();
      maintenance.start();

      assert.equal(created, 1, "a stopped service must stay stopped");
      assert.equal(maintenance.isStarted, false);
    });

    it("runs a bounded pass on each timer tick without overlapping", async () => {
      insertReadyJob();
      const installed: { handler: (() => void) | null } = { handler: null };
      const maintenance = new WorkerMaintenance({
        store,
        replayStore: { cleanup: () => {} },
        writer,
        setIntervalFn: (handler) => {
          installed.handler = handler;
          return { unref: () => {} };
        },
        clearIntervalFn: () => {},
      });

      maintenance.start();
      const tick = installed.handler;
      assert.ok(tick, "the timer handler was installed");

      // Three ticks fire back to back; the object may only be deleted once.
      tick();
      tick();
      tick();
      await maintenance.stop();

      assert.deepEqual(writer.deleted, [OBJECT_KEY]);
      assert.equal(countRows(db, "worker_jobs"), 0);
    });

    it("stop() waits for an in-flight pass to settle", async () => {
      insertReadyJob();
      let settled = false;
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => { release = resolve; });

      const slowWriter = new RecordingWriter();
      slowWriter.delete = async (key: WorkerObjectKey) => {
        await gate;
        slowWriter.deleted.push(key);
        settled = true;
      };

      const maintenance = makeMaintenance({ writer: slowWriter });
      const run = maintenance.runOnce();

      const stopping = maintenance.stop();
      release!();
      await stopping;

      assert.equal(settled, true, "stop() must not abandon an in-flight pass");
      await run;
    });
  });

  describe("routine cleanup categories", () => {
    it("runs replay and idempotency cleanup on every pass", async () => {
      let replayCleanups = 0;
      db.prepare(
        `INSERT INTO worker_idempotency_records
          (idempotency_key, payload_hash, job_id, created_at_ms, job_expires_at_ms, expires_at_ms)
         VALUES (?, 'hash', ?, ?, ?, ?)`,
      ).run(randomUUID(), JOB_ID, now - 100_000, now - 100_000, now - 1);

      const report = await makeMaintenance({
        replayStore: { cleanup: () => { replayCleanups += 1; } },
      }).runOnce();

      assert.equal(replayCleanups, 1);
      assert.equal(report.replayCleanup, "ok");
      assert.equal(report.idempotencyCleanup, "ok");
      assert.equal(report.idempotencyRecordsDeleted, 1);
      assert.equal(countRows(db, "worker_idempotency_records"), 0);
    });

    it("rejects an invalid interval or batch size at construction", () => {
      const deps = { store, replayStore: { cleanup: () => {} }, writer };
      assert.throws(() => new WorkerMaintenance({ ...deps, intervalMs: 0 }));
      assert.throws(() => new WorkerMaintenance({ ...deps, intervalMs: -1 }));
      assert.throws(() => new WorkerMaintenance({ ...deps, batchSize: 0 }));
      assert.throws(() => new WorkerMaintenance({ ...deps, batchSize: 1001 }));
    });
  });
});
