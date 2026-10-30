import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { WorkerJobViewSchema } from "../../shared/worker/contracts.ts";
import { openWorkerDatabase } from "./database.server.ts";
import { generateIdempotencyFingerprint } from "./idempotency.server.ts";
import { DurableWorkerJobSchema } from "./job-store.ts";
import { WORKER_SCHEMA_VERSION, applyMigrations } from "./migrations.server.ts";
import { SQLiteJobStore } from "./sqlite-job-store.server.ts";

/**
 * VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001 — SQLite v1 and mixed-version
 * compatibility.
 *
 * LD-2a adds no column, constraint, index or migration: it re-assigns the
 * existing `expires_at_ms`. So a database is readable in both directions:
 *
 *  - the LD-2a store reads rows the previous store wrote (forward), keeping the
 *    instants they carry and re-assigning only at its own transitions;
 *  - rows the LD-2a store writes satisfy the unchanged v1 integrity check and
 *    the unchanged durable row schema (rollback).
 *
 * The previous store's own code is exercised against LD-2a databases by the
 * qualification harness outside this suite; here the shared, unchanged parts
 * — migrations, the v1 check, `DurableWorkerJobSchema`, the view schema — are
 * pinned against rows produced both ways.
 */

/**
 * The v1 schema, as `applyMigrations` creates it: a SHA-256 over every
 * `sqlite_master` row (type, name, tbl_name, sql) in name order. Measured on
 * `main` 19294883 (pre-LD-2a) and unchanged by LD-2a. A schema change must
 * come with a schema version, never with an edit to this value.
 */
const SCHEMA_V1_DIGEST = "d07f6697293fff00aecfbcec2d12d96c3f91337db1adb2fa5053504e56900f92";

const T0 = 1_800_000_000_000;
const OLD_TTL = 45 * 60_000; // the retired creation-based TTL the previous store wrote
const DAY = 24 * 60 * 60_000;

function schemaDigest(db: DatabaseSync): string {
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
  return createHash("sha256")
    .update(JSON.stringify(rows.map((r) => [r.type, r.name, r.tbl_name, r.sql])))
    .digest("hex");
}

/**
 * Inserts a job and its idempotency record exactly as the PREVIOUS store's
 * `createJob` did — `expires_at_ms = created + 45 min`, record kept
 * `max(created + 24 h, job expiry)` — then moves it to `status` with the
 * columns the previous store's transitions wrote, which never touched
 * `expires_at_ms`.
 */
function insertPreviousStoreRow(db: DatabaseSync, jobId: string, status: string, createdAt: number, key = randomUUID()) {
  const url = "https://cdn.example/clip.mp4";
  db.prepare(
    `INSERT INTO worker_jobs (job_id, url, format_id, principal_id, status, created_at_ms, updated_at_ms, expires_at_ms)
     VALUES (?, ?, 'direct-original', 'private-access-user', 'queued', ?, ?, ?)`,
  ).run(jobId, url, createdAt, createdAt, createdAt + OLD_TTL);
  db.prepare(
    `INSERT INTO worker_idempotency_records (idempotency_key, payload_hash, job_id, created_at_ms, job_expires_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    key,
    generateIdempotencyFingerprint({ url, formatId: "direct-original", principalId: "private-access-user" }),
    jobId,
    createdAt,
    createdAt + OLD_TTL,
    Math.max(createdAt + DAY, createdAt + OLD_TTL),
  );
  if (status === "queued") return key;
  const later = createdAt + 60_000;
  if (status === "ready") {
    db.prepare(
      `UPDATE worker_jobs SET status = 'ready', object_key = ?, filename = 'clip.mp4', file_size = 8, mime = 'video/mp4',
         container = 'mp4', progress = 100, stage_label = 'Ready', started_at_ms = ?, updated_at_ms = ?, finished_at_ms = ?
       WHERE job_id = ?`,
    ).run(`videofetch/jobs/${jobId}/${"d".repeat(32)}`, createdAt + 1_000, later, later, jobId);
  } else if (status === "failed" || status === "cancelled") {
    db.prepare(
      `UPDATE worker_jobs SET status = ?, error_code = ?, safe_error_message = ?, stage_label = ?, updated_at_ms = ?, finished_at_ms = ?
       WHERE job_id = ?`,
    ).run(
      status,
      status === "failed" ? "NETWORK_ERROR" : null,
      status === "failed" ? "Network failure" : null,
      status === "failed" ? "Download failed" : null,
      later,
      later,
      jobId,
    );
  } else {
    db.prepare("UPDATE worker_jobs SET status = ?, started_at_ms = ?, updated_at_ms = ? WHERE job_id = ?").run(
      status,
      createdAt + 1_000,
      later,
      jobId,
    );
  }
  return key;
}

const idOf = (n: number) => n.toString(16).padStart(32, "0");

describe("LD-2a keeps SQLite schema v1", () => {
  it("creates exactly the v1 schema: user_version 1 and the pinned DDL", () => {
    const db = openWorkerDatabase({ path: ":memory:" });
    try {
      applyMigrations(db);
      assert.equal(WORKER_SCHEMA_VERSION, 1);
      assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
      assert.equal(schemaDigest(db), SCHEMA_V1_DIGEST);
    } finally {
      db.close();
    }
  });
});

describe("LD-2a × previous-store databases (mixed versions)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld2a-compat-"));
    file = path.join(dir, "worker.sqlite");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("forward: the LD-2a store reads previous-store rows, keeps their instants, and re-assigns only at its own transitions", () => {
    // A database the previous store wrote, at T0.
    const old = openWorkerDatabase({ path: file });
    applyMigrations(old);
    const keyQueued = insertPreviousStoreRow(old, idOf(1), "queued", T0);
    insertPreviousStoreRow(old, idOf(2), "queued", T0 - 50 * 60_000); // past its old 45-minute bound
    for (const [n, status] of [[3, "analyzing"], [4, "downloading"], [5, "processing"], [6, "uploading"]] as const) {
      insertPreviousStoreRow(old, idOf(n), status, T0);
    }
    insertPreviousStoreRow(old, idOf(7), "ready", T0);
    insertPreviousStoreRow(old, idOf(8), "failed", T0);
    insertPreviousStoreRow(old, idOf(9), "cancelled", T0);
    old.close();

    // The LD-2a Worker starts on it: no migration, the v1 check passes.
    const db = openWorkerDatabase({ path: file });
    try {
      applyMigrations(db);
      assert.equal(schemaDigest(db), SCHEMA_V1_DIGEST);
      const startAt = T0 + 5 * 60_000;
      const store = new SQLiteJobStore({ db, clock: () => startAt });
      for (let n = 1; n <= 9; n += 1) assert.ok(store.getJob(idOf(n)), `row ${n} hydrates`);

      const terminalBefore = [7, 8, 9].map((n) => db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(idOf(n)));
      store.recover();
      for (const n of [3, 4, 5, 6]) {
        const row = store.getJob(idOf(n))!;
        assert.equal(row.status, "failed");
        assert.equal(row.stageLabel, "Worker restarted");
        assert.equal(row.expiresAt, startAt + 2_700_000, "recovery + R, by the LD-2a store");
      }
      assert.deepEqual(
        [7, 8, 9].map((n) => db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(idOf(n))),
        terminalBefore,
        "terminal rows keep the instants the previous store wrote",
      );
      assert.equal(store.getJob(idOf(7))!.expiresAt, T0 + OLD_TTL, "a previous-store ready link ends where it always did");

      // The old queued row inside its 45-minute bound is claimed and re-bound;
      // the one past it is not claimable.
      const claimed = store.claimNextQueuedJob();
      assert.equal(claimed?.jobId, idOf(1));
      assert.equal(claimed?.expiresAt, startAt + 5_445_000, "claimed + L");
      assert.equal(store.claimNextQueuedJob(), null);
      assert.equal(store.getJob(idOf(2))!.status, "queued");

      // Its previous-store idempotency record is mirrored from now on.
      const record = db.prepare("SELECT * FROM worker_idempotency_records WHERE idempotency_key = ?").get(keyQueued) as {
        job_expires_at_ms: number;
        expires_at_ms: number;
      };
      assert.equal(record.job_expires_at_ms, startAt + 5_445_000);
      assert.equal(record.expires_at_ms, T0 + DAY);
    } finally {
      db.close();
    }
  });

  it("rollback: every row the LD-2a store writes passes the v1 check and the unchanged durable and view schemas", () => {
    const db = openWorkerDatabase({ path: file });
    applyMigrations(db);
    const clock = { now: T0 };
    let n = 0;
    const store = new SQLiteJobStore({ db, clock: () => clock.now, generateJobId: () => idOf(++n) });
    const create = () => {
      const res = store.createJob(
        { url: "https://cdn.example/clip.mp4", formatId: "direct-original", principalId: "private-access-user" },
        randomUUID(),
      );
      return res.type === "created" ? res.job.jobId : "";
    };
    const advance = (jobId: string, to: "downloading" | "processing" | "uploading") => {
      store.completeAnalysis(jobId, { title: "Clip", thumbnail: null, source: "cdn.example", extractor: "direct" });
      if (to !== "downloading") store.beginProcessing(jobId);
      if (to === "uploading") store.beginUploading(jobId);
    };
    // One row per LD-2a assignment, each claimed before the next is created.
    create(); // stays analyzing: claimed + L
    clock.now += 1_000;
    store.claimNextQueuedJob();
    const uploading = create();
    clock.now += 1_000;
    store.claimNextQueuedJob();
    advance(uploading, "uploading");
    const ready = create();
    clock.now += 1_000;
    store.claimNextQueuedJob();
    advance(ready, "uploading");
    store.commitReadyFromUploading(ready, {
      objectKey: `videofetch/jobs/${ready}/${"e".repeat(32)}`,
      filename: "clip.mp4",
      fileSize: 8,
      mime: "video/mp4",
      quality: null,
      container: "mp4",
    });
    store.failJob(create(), "TIMEOUT", "The video took too long to process.");
    store.cancelJob(create());
    create(); // stays queued: created + L
    db.close();

    // Reopened as any v1 Worker would: the integrity check, then every row
    // through the unchanged schemas.
    const again = openWorkerDatabase({ path: file });
    try {
      assert.doesNotThrow(() => applyMigrations(again));
      assert.equal(schemaDigest(again), SCHEMA_V1_DIGEST);
      const integrity = again.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
      assert.deepEqual(integrity.map((r) => r.integrity_check), ["ok"]);
      const rows = again.prepare("SELECT * FROM worker_jobs ORDER BY job_id").all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, 6);
      for (const row of rows) {
        const durable = DurableWorkerJobSchema.parse({
          jobId: row.job_id,
          url: row.url,
          formatId: row.format_id,
          principalId: row.principal_id,
          status: row.status,
          progress: row.progress,
          stageLabel: row.stage_label,
          downloadedBytes: row.downloaded_bytes,
          totalBytes: row.total_bytes,
          speed: row.speed,
          eta: row.eta,
          errorCode: row.error_code,
          safeErrorMessage: row.safe_error_message,
          filename: row.filename,
          fileSize: row.file_size,
          mime: row.mime,
          quality: row.quality,
          container: row.container,
          title: row.title,
          thumbnail: row.thumbnail,
          source: row.source,
          extractor: row.extractor,
          createdAt: row.created_at_ms,
          updatedAt: row.updated_at_ms,
          expiresAt: row.expires_at_ms,
          objectKey: row.object_key,
          startedAt: row.started_at_ms,
          finishedAt: row.finished_at_ms,
        });
        assert.ok(durable.expiresAt >= durable.createdAt, "the v1 CHECK holds");
        const { startedAt: _s, finishedAt: _f, url: _u, formatId: _fi, principalId: _p, ...view } = durable;
        assert.doesNotThrow(() => WorkerJobViewSchema.parse(view), `view of ${durable.status}`);
      }
      const statuses = rows.map((r) => r.status).sort();
      assert.deepEqual(statuses, ["analyzing", "cancelled", "failed", "queued", "ready", "uploading"]);
      // Every idempotency record keeps the v1 shape and the at-least-24-h rule.
      for (const r of again.prepare("SELECT * FROM worker_idempotency_records").all() as Array<{
        created_at_ms: number;
        job_expires_at_ms: number;
        expires_at_ms: number;
      }>) {
        assert.ok(r.expires_at_ms >= r.created_at_ms + DAY);
        assert.ok(r.expires_at_ms >= r.job_expires_at_ms);
      }
    } finally {
      again.close();
    }
  });
});
