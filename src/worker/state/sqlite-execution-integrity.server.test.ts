import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.server.ts";
import { SQLiteJobStore } from "./sqlite-job-store.server.ts";
import {
  WorkerExecutionProgressStatusSchema,
  type UpdateProgressInput,
  type WorkerExecutionProgressStatus,
} from "./job-store.ts";

type RawRow = {
  status: string;
  progress: number | null;
  stage_label: string | null;
  downloaded_bytes: number | null;
  updated_at_ms: number;
  object_key: string | null;
  title: string | null;
  source: string | null;
  extractor: string | null;
};

const BASE_PROGRESS: UpdateProgressInput = {
  progress: 10,
  downloadedBytes: 100,
  totalBytes: 1000,
  speed: 50,
  eta: 5,
  stageLabel: "downloading",
};

describe("SQLite execution-state integrity", () => {
  let tempDir: string;
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let execCalls: string[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-integrity-"));
    db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
    applyMigrations(db);

    // Records the exact SQL statements the store executes, so "validation
    // happens before BEGIN" is proven directly rather than inferred.
    execCalls = [];
    const spied = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "exec") {
          return (sql: string) => {
            execCalls.push(sql);
            return (value as (s: string) => unknown).call(target, sql);
          };
        }
        if (typeof value === "function") {
          return (value as (...a: unknown[]) => unknown).bind(target);
        }
        return value;
      },
    }) as DatabaseSync;

    store = new SQLiteJobStore({ db: spied });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function rawRow(jobId: string): RawRow {
    return db
      .prepare(
        "SELECT status, progress, stage_label, downloaded_bytes, updated_at_ms, object_key, title, source, extractor FROM worker_jobs WHERE job_id = ?",
      )
      .get(jobId) as unknown as RawRow;
  }

  function downloadingJob(): string {
    store.createJob(
      {
        url: "https://cdn.example.com/a.mp4",
        formatId: "direct-original",
        principalId: "private-access-user",
      },
      randomUUID(),
    );
    const job = store.claimNextQueuedJob()!;
    store.completeAnalysis(job.jobId, {
      title: "T",
      thumbnail: null,
      source: "example.com",
      extractor: "direct",
    });
    return job.jobId;
  }

  // ── §17: trigger-based rollback acceptance ─────────────────────────────────

  it("updateExecutionProgress: a corrupted post-UPDATE row throws and rolls back", () => {
    const jobId = downloadingJob();
    store.updateExecutionProgress(jobId, "downloading", BASE_PROGRESS);
    const before = rawRow(jobId);
    assert.equal(before.progress, 10);

    db.exec(`
      CREATE TRIGGER test_corrupt_progress
      AFTER UPDATE ON worker_jobs
      WHEN new.status = 'downloading'
      BEGIN
        UPDATE worker_jobs SET progress = 500 WHERE job_id = new.job_id;
      END;
    `);

    assert.throws(() =>
      store.updateExecutionProgress(jobId, "downloading", { ...BASE_PROGRESS, progress: 55 }),
    );

    db.exec("DROP TRIGGER test_corrupt_progress;");

    const after = rawRow(jobId);
    assert.deepEqual(after, before, "the original row must survive the rollback untouched");
    assert.equal(store.getJob(jobId)!.progress, 10);
  });

  it("updateExecutionProgress: an empty stage_label written post-UPDATE rolls back", () => {
    const jobId = downloadingJob();
    store.updateExecutionProgress(jobId, "downloading", BASE_PROGRESS);
    const before = rawRow(jobId);

    db.exec(`
      CREATE TRIGGER test_blank_stage
      AFTER UPDATE ON worker_jobs
      WHEN new.status = 'downloading'
      BEGIN
        UPDATE worker_jobs SET stage_label = '' WHERE job_id = new.job_id;
      END;
    `);

    assert.throws(() =>
      store.updateExecutionProgress(jobId, "downloading", { ...BASE_PROGRESS, progress: 77 }),
    );

    db.exec("DROP TRIGGER test_blank_stage;");
    assert.deepEqual(rawRow(jobId), before);
  });

  it("beginProcessing: an illegal object_key written post-UPDATE rolls back", () => {
    const jobId = downloadingJob();
    const before = rawRow(jobId);
    assert.equal(before.status, "downloading");

    // A non-ready job owning an objectKey violates the durable ownership
    // invariant, so the post-UPDATE validation must reject and roll back.
    db.exec(`
      CREATE TRIGGER test_corrupt_processing
      AFTER UPDATE ON worker_jobs
      WHEN new.status = 'processing'
      BEGIN
        UPDATE worker_jobs
        SET object_key = 'videofetch/jobs/' || new.job_id || '/' || substr(hex(randomblob(16)), 1, 32)
        WHERE job_id = new.job_id;
      END;
    `);

    assert.throws(() => store.beginProcessing(jobId));

    db.exec("DROP TRIGGER test_corrupt_processing;");

    const after = rawRow(jobId);
    assert.equal(after.status, "downloading", "the transition must not survive");
    assert.equal(after.object_key, null);
    assert.deepEqual(after, before);
    assert.equal(store.getJob(jobId)!.status, "downloading");
  });

  it("beginUploading: a corrupted post-UPDATE row rolls back and preserves `processing`", () => {
    const jobId = downloadingJob();
    assert.equal(store.beginProcessing(jobId).type, "updated");
    const before = rawRow(jobId);
    assert.equal(before.status, "processing");

    db.exec(`
      CREATE TRIGGER test_corrupt_uploading
      AFTER UPDATE ON worker_jobs
      WHEN new.status = 'uploading'
      BEGIN
        UPDATE worker_jobs SET progress = -1 WHERE job_id = new.job_id;
      END;
    `);

    assert.throws(() => store.beginUploading(jobId));

    db.exec("DROP TRIGGER test_corrupt_uploading;");

    const after = rawRow(jobId);
    assert.equal(after.status, "processing", "the uploading transition must not survive");
    assert.deepEqual(after, before);
    assert.equal(store.getJob(jobId)!.status, "processing");
  });

  it("beginUploading: a post-UPDATE status hijack rolls back", () => {
    const jobId = downloadingJob();
    assert.equal(store.beginProcessing(jobId).type, "updated");
    const before = rawRow(jobId);

    db.exec(`
      CREATE TRIGGER test_hijack_uploading
      AFTER UPDATE ON worker_jobs
      WHEN new.status = 'uploading'
      BEGIN
        UPDATE worker_jobs SET status = 'analyzing' WHERE job_id = new.job_id;
      END;
    `);

    assert.throws(() => store.beginUploading(jobId));

    db.exec("DROP TRIGGER test_hijack_uploading;");
    assert.deepEqual(rawRow(jobId), before);
  });

  it("successful transitions return the exact pre-validated committed view", () => {
    const jobId = downloadingJob();

    const progressRes = store.updateExecutionProgress(jobId, "downloading", BASE_PROGRESS);
    assert.equal(progressRes.type, "updated");
    if (progressRes.type === "updated") {
      assert.deepEqual(progressRes.job, store.getJob(jobId));
    }

    const procRes = store.beginProcessing(jobId);
    assert.equal(procRes.type, "updated");
    if (procRes.type === "updated") {
      assert.equal(procRes.job.status, "processing");
      assert.deepEqual(procRes.job, store.getJob(jobId));
    }

    const upRes = store.beginUploading(jobId);
    assert.equal(upRes.type, "updated");
    if (upRes.type === "updated") {
      assert.equal(upRes.job.status, "uploading");
      assert.deepEqual(upRes.job, store.getJob(jobId));
    }
  });

  // ── §15: narrow progress-mutation status surface ───────────────────────────

  it("the progress-status schema admits only active execution states", () => {
    for (const ok of ["analyzing", "downloading", "processing", "uploading"]) {
      assert.equal(WorkerExecutionProgressStatusSchema.safeParse(ok).success, true, ok);
    }
    for (const rejected of ["queued", "ready", "failed", "cancelled", "", "DOWNLOADING", null]) {
      assert.equal(
        WorkerExecutionProgressStatusSchema.safeParse(rejected).success,
        false,
        `${String(rejected)} must never be a progress-mutation target`,
      );
    }
  });

  it("an invalid expectedStatus is rejected BEFORE any transaction is opened", () => {
    const jobId = downloadingJob();
    const before = rawRow(jobId);

    for (const bad of ["queued", "ready", "failed", "cancelled", "nonsense"]) {
      execCalls.length = 0;
      assert.throws(
        () =>
          store.updateExecutionProgress(
            jobId,
            bad as WorkerExecutionProgressStatus,
            BASE_PROGRESS,
          ),
        `expectedStatus ${bad} must be refused`,
      );
      assert.deepEqual(
        execCalls,
        [],
        `expectedStatus ${bad}: no BEGIN/COMMIT/ROLLBACK may be issued`,
      );
    }

    assert.deepEqual(rawRow(jobId), before, "the row is untouched");
  });

  it("an invalid progress payload is rejected before any transaction is opened", () => {
    const jobId = downloadingJob();
    const before = rawRow(jobId);

    const invalidPayloads: unknown[] = [
      { ...BASE_PROGRESS, progress: 101 },
      { ...BASE_PROGRESS, progress: -1 },
      { ...BASE_PROGRESS, downloadedBytes: -5 },
      { ...BASE_PROGRESS, stageLabel: "" },
      { ...BASE_PROGRESS, extraneous: true },
    ];

    for (const payload of invalidPayloads) {
      execCalls.length = 0;
      assert.throws(() =>
        store.updateExecutionProgress(jobId, "downloading", payload as UpdateProgressInput),
      );
      assert.deepEqual(execCalls, [], `payload ${JSON.stringify(payload)} opened a transaction`);
    }

    assert.deepEqual(rawRow(jobId), before);
  });

  // ── §16: complete ASCII-control rejection ──────────────────────────────────

  it("completeAnalysis rejects U+0000–U+001F and U+007F in every persisted string", () => {
    const controlChars = ["\u0000", "\u0001", "\u0009", "\u001F", "\u007F"];

    for (const ch of controlChars) {
      for (const field of ["title", "source", "extractor"] as const) {
        store.createJob(
          {
            url: "https://cdn.example.com/a.mp4",
            formatId: "direct-original",
            principalId: "private-access-user",
          },
          randomUUID(),
        );
        const job = store.claimNextQueuedJob()!;
        const input = {
          title: "T",
          thumbnail: null,
          source: "example.com",
          extractor: "direct",
          [field]: `bad${ch}value`,
        };

        execCalls.length = 0;
        assert.throws(
          () => store.completeAnalysis(job.jobId, input as never),
          `${field} with U+${ch.charCodeAt(0).toString(16).padStart(4, "0")} must be refused`,
        );
        assert.deepEqual(execCalls, [], "control-character input must not open a transaction");
        assert.equal(rawRow(job.jobId).status, "analyzing", "the job must not advance");
      }
    }
  });

  it("updateExecutionProgress rejects U+0000–U+001F and U+007F in stageLabel", () => {
    const jobId = downloadingJob();
    const before = rawRow(jobId);

    for (const ch of ["\u0000", "\u0001", "\u0009", "\u001F", "\u007F"]) {
      execCalls.length = 0;
      assert.throws(
        () =>
          store.updateExecutionProgress(jobId, "downloading", {
            ...BASE_PROGRESS,
            stageLabel: `stage${ch}label`,
          }),
        `stageLabel with U+${ch.charCodeAt(0).toString(16).padStart(4, "0")} must be refused`,
      );
      assert.deepEqual(execCalls, []);
    }

    assert.deepEqual(rawRow(jobId), before);
  });

  it("ordinary non-ASCII text is still accepted", () => {
    store.createJob(
      {
        url: "https://cdn.example.com/a.mp4",
        formatId: "direct-original",
        principalId: "private-access-user",
      },
      randomUUID(),
    );
    const job = store.claimNextQueuedJob()!;
    const res = store.completeAnalysis(job.jobId, {
      title: "Café — naïve 日本語 🎬",
      thumbnail: null,
      source: "例え.example.com",
      extractor: "direct",
    });
    assert.equal(res.type, "updated");
    assert.equal(store.getJob(job.jobId)!.title, "Café — naïve 日本語 🎬");
  });
});
