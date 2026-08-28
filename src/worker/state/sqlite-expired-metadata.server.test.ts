import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openWorkerDatabase } from "./database.server.ts";
import { applyMigrations } from "./migrations.server.ts";
import { SQLiteJobStore } from "./sqlite-job-store.server.ts";

/**
 * §20: `deleteExpiredReadyMetadata` — the narrowest durable cleanup that stops
 * a successfully deleted object from being re-deleted forever.
 *
 * Every precondition is proven, and the retained idempotency tombstone is
 * proven to SURVIVE job-metadata removal.
 */

const JOB_ID = "0123456789abcdef0123456789abcdef";
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/aaaabbbbccccddddeeeeffff00001111`;

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

describe("SQLiteJobStore.deleteExpiredReadyMetadata", () => {
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let now: number;

  /** Inserts a durable row directly so each precondition can be isolated. */
  function insertJob(overrides: Partial<Record<string, unknown>> = {}) {
    const values = {
      job_id: JOB_ID,
      url: "https://cdn.example/clip.mp4",
      format_id: "direct-original",
      principal_id: "private-access-user",
      status: "ready",
      object_key: OBJECT_KEY,
      created_at_ms: now - 100_000,
      updated_at_ms: now - 100_000,
      expires_at_ms: now - 1,
      ...overrides,
    } as Record<string, unknown>;

    db.prepare(
      `INSERT INTO worker_jobs
        (job_id, url, format_id, principal_id, status, object_key,
         created_at_ms, updated_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      values.job_id as string,
      values.url as string,
      values.format_id as string,
      values.principal_id as string,
      values.status as string,
      (values.object_key ?? null) as string | null,
      values.created_at_ms as number,
      values.updated_at_ms as number,
      values.expires_at_ms as number,
    );
  }

  /** A retained idempotency record pointing at the same job. */
  function insertTombstone(key = randomUUID()) {
    db.prepare(
      `INSERT INTO worker_idempotency_records
        (idempotency_key, payload_hash, job_id, created_at_ms, job_expires_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(key, "hash", JOB_ID, now - 100_000, now - 1, now + 3_600_000);
    return key;
  }

  beforeEach(() => {
    db = openWorkerDatabase({ path: ":memory:" });
    applyMigrations(db);
    now = 1_800_000_000_000;
    store = new SQLiteJobStore({ db, clock: () => now });
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("deletes exactly the expired ready row on an exact key match", () => {
    insertJob();
    assert.equal(countRows(db, "worker_jobs"), 1);

    const deleted = store.deleteExpiredReadyMetadata(JOB_ID, OBJECT_KEY);

    assert.equal(deleted, true);
    assert.equal(countRows(db, "worker_jobs"), 0);
  });

  it("is idempotent — a second call reports no row removed", () => {
    insertJob();

    assert.equal(store.deleteExpiredReadyMetadata(JOB_ID, OBJECT_KEY), true);
    assert.equal(store.deleteExpiredReadyMetadata(JOB_ID, OBJECT_KEY), false);
  });

  it("PRESERVES the retained idempotency tombstone", () => {
    insertJob();
    const key = insertTombstone();
    assert.equal(countRows(db, "worker_idempotency_records"), 1);

    assert.equal(store.deleteExpiredReadyMetadata(JOB_ID, OBJECT_KEY), true);

    assert.equal(countRows(db, "worker_jobs"), 0, "job metadata is removed");
    assert.equal(
      countRows(db, "worker_idempotency_records"),
      1,
      "the tombstone must outlive the job metadata",
    );
    const retained = db
      .prepare("SELECT job_id FROM worker_idempotency_records WHERE idempotency_key = ?")
      .get(key) as { job_id: string };
    assert.equal(retained.job_id, JOB_ID);
  });

  it("refuses an object-key MISMATCH and leaves metadata intact", () => {
    insertJob();
    const otherKey = `videofetch/jobs/${JOB_ID}/99998888777766665555444433332222`;

    const deleted = store.deleteExpiredReadyMetadata(JOB_ID, otherKey);

    assert.equal(deleted, false);
    assert.equal(countRows(db, "worker_jobs"), 1, "a mismatched key must not delete anything");
  });

  it("refuses a key whose embedded job id does not match", () => {
    insertJob();
    const foreignKey =
      "videofetch/jobs/ffffffffffffffffffffffffffffffff/aaaabbbbccccddddeeeeffff00001111";

    assert.throws(
      () => store.deleteExpiredReadyMetadata(JOB_ID, foreignKey),
      /objectKey embedded job ID must equal jobId/,
    );
    assert.equal(countRows(db, "worker_jobs"), 1);
  });

  it("refuses a NON-EXPIRED ready job", () => {
    insertJob({ expires_at_ms: now + 60_000 });

    assert.equal(store.deleteExpiredReadyMetadata(JOB_ID, OBJECT_KEY), false);
    assert.equal(countRows(db, "worker_jobs"), 1);
  });

  it("treats expiresAt exactly equal to now as expired", () => {
    insertJob({ expires_at_ms: now });

    assert.equal(store.deleteExpiredReadyMetadata(JOB_ID, OBJECT_KEY), true);
  });

  it("refuses every non-ready status", () => {
    for (const status of ["queued", "analyzing", "downloading", "processing", "uploading", "failed", "cancelled"]) {
      db.exec("DELETE FROM worker_jobs");
      // Only `ready` rows may carry an objectKey, so non-ready rows are stored
      // with a null key exactly as the durable invariant requires.
      insertJob({ status, object_key: null });

      assert.equal(
        store.deleteExpiredReadyMetadata(JOB_ID, OBJECT_KEY),
        false,
        `${status} must never be removed by expiration cleanup`,
      );
      assert.equal(countRows(db, "worker_jobs"), 1, `${status} row must survive`);
    }
  });

  it("rejects a malformed job id or object key before touching the database", () => {
    insertJob();

    assert.throws(() => store.deleteExpiredReadyMetadata("not-a-job-id", OBJECT_KEY));
    assert.throws(() => store.deleteExpiredReadyMetadata(JOB_ID, "videofetch/jobs/*"));
    assert.throws(() => store.deleteExpiredReadyMetadata(JOB_ID, ""));
    assert.throws(() =>
      store.deleteExpiredReadyMetadata(JOB_ID, `videofetch/jobs/${JOB_ID}/`),
    );

    assert.equal(countRows(db, "worker_jobs"), 1, "no broad delete may occur");
  });

  it("never removes OTHER jobs' rows", () => {
    insertJob();
    const otherId = "ffffffffffffffffffffffffffffffff";
    const otherKey = `videofetch/jobs/${otherId}/11112222333344445555666677778888`;
    db.prepare(
      `INSERT INTO worker_jobs
        (job_id, url, format_id, principal_id, status, object_key,
         created_at_ms, updated_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      otherId,
      "https://cdn.example/other.mp4",
      "direct-original",
      "private-access-user",
      "ready",
      otherKey,
      now - 100_000,
      now - 100_000,
      now - 1,
    );

    assert.equal(store.deleteExpiredReadyMetadata(JOB_ID, OBJECT_KEY), true);

    assert.equal(countRows(db, "worker_jobs"), 1, "the other expired job must remain");
    const survivor = db.prepare("SELECT job_id FROM worker_jobs").get() as { job_id: string };
    assert.equal(survivor.job_id, otherId);
  });

  it("pairs with listExpiredReadyObjects to converge the cleanup loop", () => {
    insertJob();

    const first = store.listExpiredReadyObjects(10);
    assert.equal(first.length, 1);
    assert.equal(first[0].objectKey, OBJECT_KEY);

    assert.equal(store.deleteExpiredReadyMetadata(first[0].jobId, first[0].objectKey), true);

    // Convergence: the same expired object is not offered again, so the runtime
    // cannot re-issue DeleteObject for it forever.
    assert.deepEqual(store.listExpiredReadyObjects(10), []);
  });

  it("requires no schema migration", () => {
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, 1, "cleanup must work on the merged V1 schema");
  });
});
