import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import type { WorkerCreateJobRequest } from "../../shared/worker/contracts.ts";
import { WorkerTimeLimitsError } from "../runtime/time-limits.ts";
import { openWorkerDatabase } from "./database.server.ts";
import { WORKER_IDEMPOTENCY_MIN_RETENTION_MS } from "./idempotency.server.ts";
import type { WorkerExecutionProgressStatus } from "./job-store.ts";
import { applyMigrations } from "./migrations.server.ts";
import { SQLiteJobStore } from "./sqlite-job-store.server.ts";

/**
 * VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001 — the durable job lifetime.
 *
 * `expires_at_ms` is assigned at most three times per job, each inside the
 * transaction of its transition, together with the job's idempotency record:
 *
 *   create  → `created + L`     claim → `claimed + L`
 *   ready / failed / cancelled / recover → `finished + R`
 *
 * Every test runs the REAL store against a real SQLite database (in memory,
 * except where two connections are needed) with a virtual clock, and reads the
 * durable rows straight from SQLite rather than trusting the view.
 */

const L = 600_000; // 10 min: deliberately not the default, so every assertion names its source
const R = 240_000; // 4 min
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type JobRow = {
  job_id: string;
  status: string;
  stage_label: string | null;
  error_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  expires_at_ms: number;
  object_key: string | null;
};

type IdempotencyRow = {
  idempotency_key: string;
  payload_hash: string;
  job_id: string;
  created_at_ms: number;
  job_expires_at_ms: number;
  expires_at_ms: number;
};

type Harness = {
  db: DatabaseSync;
  clock: { now: number };
  store: SQLiteJobStore;
  generated: { count: number };
};

function makeHarness(
  options: { executionLifetimeMs?: number; retentionMs?: number; db?: DatabaseSync } = {},
): Harness {
  const db = options.db ?? openWorkerDatabase({ path: ":memory:" });
  if (!options.db) applyMigrations(db);
  const clock = { now: T0 };
  const generated = { count: 0 };
  const store = new SQLiteJobStore({
    db,
    clock: () => clock.now,
    ...("executionLifetimeMs" in options ? { executionLifetimeMs: options.executionLifetimeMs } : { executionLifetimeMs: L }),
    ...("retentionMs" in options ? { retentionMs: options.retentionMs } : { retentionMs: R }),
    generateJobId: () => (++generated.count).toString(16).padStart(32, "0"),
  });
  return { db, clock, store, generated };
}

const request = (url = "https://cdn.example/clip.mp4"): WorkerCreateJobRequest => ({
  url,
  formatId: "direct-original",
  principalId: "private-access-user",
});

function jobRow(db: DatabaseSync, jobId: string): JobRow {
  const row = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  assert.ok(row, `row ${jobId}`);
  return { ...row };
}

function idempotencyRow(db: DatabaseSync, jobId: string): IdempotencyRow {
  const row = db
    .prepare("SELECT * FROM worker_idempotency_records WHERE job_id = ?")
    .get(jobId) as IdempotencyRow | undefined;
  assert.ok(row, `idempotency record for ${jobId}`);
  return { ...row };
}

function create(h: Harness, key: string = randomUUID(), url?: string): string {
  const res = h.store.createJob(request(url), key);
  assert.equal(res.type, "created");
  return res.type === "created" ? res.job.jobId : "";
}

function claim(h: Harness, expectedJobId?: string): string {
  const claimed = h.store.claimNextQueuedJob();
  assert.ok(claimed, "a job is claimed");
  if (expectedJobId) assert.equal(claimed.jobId, expectedJobId);
  return claimed.jobId;
}

const objectKeyFor = (jobId: string) => `videofetch/jobs/${jobId}/${"a".repeat(32)}`;

function commitReady(h: Harness, jobId: string) {
  return h.store.commitReadyFromUploading(jobId, {
    objectKey: objectKeyFor(jobId),
    filename: "clip.mp4",
    fileSize: 8,
    mime: "video/mp4",
    quality: "original",
    container: "mp4",
  });
}

const ACTIVE_STATUSES = ["analyzing", "downloading", "processing", "uploading"] as const;

/**
 * Drives a CLAIMED job forward from its CURRENT active status to `status`, one
 * real transition at a time, advancing the clock a minute per step.
 */
function driveTo(h: Harness, jobId: string, status: (typeof ACTIVE_STATUSES)[number]) {
  const target = ACTIVE_STATUSES.indexOf(status);
  let at = ACTIVE_STATUSES.indexOf(jobRow(h.db, jobId).status as (typeof ACTIVE_STATUSES)[number]);
  assert.ok(at >= 0 && at <= target, `cannot drive ${jobRow(h.db, jobId).status} to ${status}`);
  for (; at < target; at += 1) {
    h.clock.now += 60_000;
    const res =
      at === 0
        ? h.store.completeAnalysis(jobId, {
            title: "Clip",
            thumbnail: null,
            source: "cdn.example",
            extractor: "direct",
          })
        : at === 1
          ? h.store.beginProcessing(jobId)
          : h.store.beginUploading(jobId);
    assert.equal(res.type, "updated");
  }
  assert.equal(jobRow(h.db, jobId).status, status);
}

function progress(h: Harness, jobId: string, status: WorkerExecutionProgressStatus, i: number) {
  return h.store.updateExecutionProgress(jobId, status, {
    progress: i % 101,
    downloadedBytes: i,
    totalBytes: 1_000_000,
    speed: i % 7,
    eta: i % 11,
    stageLabel: `Working ${i % 5}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a durable lifetime: each assignment is exact", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  it("create → queued: created + L; the record mirrors it and is kept at least 24 h from its creation", () => {
    const key = randomUUID();
    const jobId = create(h, key);
    const row = jobRow(h.db, jobId);
    assert.equal(row.status, "queued");
    assert.equal(row.created_at_ms, T0);
    assert.equal(row.expires_at_ms, T0 + L);
    const idem = idempotencyRow(h.db, jobId);
    assert.equal(idem.idempotency_key, key);
    assert.equal(idem.created_at_ms, T0);
    assert.equal(idem.job_expires_at_ms, T0 + L);
    assert.equal(idem.expires_at_ms, T0 + WORKER_IDEMPOTENCY_MIN_RETENTION_MS);
    assert.equal(WORKER_IDEMPOTENCY_MIN_RETENTION_MS, DAY);
  });

  it("claim → analyzing: claimed + L, replacing the queue bound; the mirror follows in the same transaction", () => {
    const jobId = create(h);
    h.clock.now = T0 + 7_000;
    const claimed = h.store.claimNextQueuedJob();
    assert.ok(claimed);
    assert.equal(claimed.status, "analyzing");
    assert.equal(claimed.expiresAt, T0 + 7_000 + L, "the claimed job carries its execution deadline");
    const row = jobRow(h.db, jobId);
    assert.equal(row.started_at_ms, T0 + 7_000);
    assert.equal(row.created_at_ms, T0, "the claim never rewrites the creation instant");
    assert.equal(row.expires_at_ms, T0 + 7_000 + L);
    const idem = idempotencyRow(h.db, jobId);
    assert.equal(idem.job_expires_at_ms, T0 + 7_000 + L);
    assert.equal(idem.expires_at_ms, T0 + DAY, "the floor is still counted from the record's creation");
  });

  it("a queued job is claimable until created + L and never from that instant; a losing claim moves nothing", () => {
    const jobId = create(h);
    const beforeJob = jobRow(h.db, jobId);
    const beforeIdem = idempotencyRow(h.db, jobId);
    h.clock.now = T0 + L;
    assert.equal(h.store.claimNextQueuedJob(), null, "expired at its queue bound");
    assert.deepEqual(jobRow(h.db, jobId), beforeJob);
    assert.deepEqual(idempotencyRow(h.db, jobId), beforeIdem);

    const h2 = makeHarness();
    try {
      const other = create(h2);
      h2.clock.now = T0 + L - 1;
      claim(h2, other);
      assert.equal(jobRow(h2.db, other).expires_at_ms, T0 + L - 1 + L, "claimed a millisecond before the bound");
    } finally {
      h2.db.close();
    }
  });

  it("progress writes and stage transitions never move expires_at or the mirror", () => {
    const jobId = create(h);
    h.clock.now = T0 + 1_000;
    claim(h, jobId);
    const deadline = T0 + 1_000 + L;
    const idem = idempotencyRow(h.db, jobId);
    for (const status of ACTIVE_STATUSES) {
      driveTo(h, jobId, status);
      for (let i = 0; i < 5; i += 1) {
        h.clock.now += 10_000;
        const res = progress(h, jobId, status, i);
        assert.equal(res.type, "updated");
        assert.equal(res.type === "updated" && res.job.expiresAt, deadline, `${status} progress`);
      }
      assert.equal(jobRow(h.db, jobId).expires_at_ms, deadline, `after reaching ${status}`);
      assert.deepEqual(idempotencyRow(h.db, jobId), idem, `the mirror after ${status}`);
    }
  });

  it("ready: ready + R exactly, from the moment the file exists — never MAX'd with the execution lifetime", () => {
    const jobId = create(h);
    h.clock.now = T0 + 1_000;
    claim(h, jobId);
    driveTo(h, jobId, "uploading");
    h.clock.now = T0 + 300_000;
    const res = commitReady(h, jobId);
    assert.equal(res.type, "ready");
    const row = jobRow(h.db, jobId);
    assert.equal(row.finished_at_ms, T0 + 300_000);
    assert.equal(row.expires_at_ms, T0 + 300_000 + R);
    assert.ok(row.expires_at_ms < T0 + 1_000 + L, "shorter than the execution deadline it replaced");
    assert.equal(res.type === "ready" && res.job.expiresAt, T0 + 300_000 + R);
    const idem = idempotencyRow(h.db, jobId);
    assert.equal(idem.job_expires_at_ms, T0 + 300_000 + R);
    assert.equal(idem.expires_at_ms, T0 + DAY);
  });

  for (const from of ["queued", ...ACTIVE_STATUSES] as const) {
    it(`failed from ${from}: finished + R, with the stage of the status it left`, () => {
      const jobId = create(h);
      if (from !== "queued") {
        h.clock.now = T0 + 1_000;
        claim(h, jobId);
        driveTo(h, jobId, from);
      }
      h.clock.now += 33_000;
      const finished = h.clock.now;
      assert.equal(h.store.failJob(jobId, "TIMEOUT", "The video took too long to process."), true);
      const row = jobRow(h.db, jobId);
      assert.equal(row.status, "failed");
      assert.equal(row.finished_at_ms, finished);
      assert.equal(row.expires_at_ms, finished + R);
      const expectedStage = from === "processing" ? "Processing failed" : from === "uploading" ? "Upload failed" : "Download failed";
      assert.equal(row.stage_label, expectedStage);
      assert.equal(idempotencyRow(h.db, jobId).job_expires_at_ms, finished + R);
    });

    it(`cancelled from ${from}: finished + R`, () => {
      const jobId = create(h);
      if (from !== "queued") {
        h.clock.now = T0 + 1_000;
        claim(h, jobId);
        driveTo(h, jobId, from);
      }
      h.clock.now += 41_000;
      const finished = h.clock.now;
      const res = h.store.cancelJob(jobId);
      assert.equal(res.type, "cancelled");
      assert.equal(res.type === "cancelled" && res.job.expiresAt, finished + R);
      const row = jobRow(h.db, jobId);
      assert.equal(row.finished_at_ms, finished);
      assert.equal(row.expires_at_ms, finished + R);
      assert.equal(idempotencyRow(h.db, jobId).job_expires_at_ms, finished + R);
    });
  }

  it("recover: every interrupted job gets recovery + R; queued and terminal rows keep theirs", () => {
    // Created in an order that keeps FIFO claims deterministic: the job left
    // queued is created last.
    const ids: Record<string, string> = {};
    for (const status of ACTIVE_STATUSES) {
      const jobId = create(h);
      h.clock.now += 1_000;
      claim(h, jobId);
      driveTo(h, jobId, status);
      ids[status] = jobId;
    }
    ids.ready = create(h);
    h.clock.now += 1_000;
    claim(h, ids.ready);
    driveTo(h, ids.ready, "uploading");
    assert.equal(commitReady(h, ids.ready).type, "ready");
    ids.failed = create(h);
    h.store.failJob(ids.failed, "NETWORK_ERROR", "x");
    ids.cancelled = create(h);
    h.store.cancelJob(ids.cancelled);
    ids.queued = create(h);

    const untouched = Object.fromEntries(
      ["queued", "ready", "failed", "cancelled"].map((k) => [k, jobRow(h.db, ids[k]!)]),
    );
    const untouchedIdem = Object.fromEntries(
      ["queued", "ready", "failed", "cancelled"].map((k) => [k, idempotencyRow(h.db, ids[k]!)]),
    );

    // The next process: a new store over the same database, later.
    const recoveryNow = h.clock.now + 5 * 60_000;
    const next = new SQLiteJobStore({ db: h.db, clock: () => recoveryNow, executionLifetimeMs: L, retentionMs: R });
    next.recover();

    for (const status of ACTIVE_STATUSES) {
      const row = jobRow(h.db, ids[status]!);
      assert.equal(row.status, "failed", status);
      assert.equal(row.stage_label, "Worker restarted");
      assert.equal(row.finished_at_ms, recoveryNow);
      assert.equal(row.expires_at_ms, recoveryNow + R, `${status}: recovery + R`);
      assert.equal(idempotencyRow(h.db, ids[status]!).job_expires_at_ms, recoveryNow + R);
    }
    for (const k of ["queued", "ready", "failed", "cancelled"]) {
      assert.deepEqual(jobRow(h.db, ids[k]!), untouched[k], `${k} row untouched`);
      assert.deepEqual(idempotencyRow(h.db, ids[k]!), untouchedIdem[k], `${k} record untouched`);
    }
  });

  it("each assignment is single: a terminal row's expiry and mirror are never reassigned", () => {
    const jobId = create(h);
    h.clock.now = T0 + 1_000;
    claim(h, jobId);
    driveTo(h, jobId, "uploading");
    assert.equal(commitReady(h, jobId).type, "ready");
    const row = jobRow(h.db, jobId);
    const idem = idempotencyRow(h.db, jobId);

    h.clock.now += 1_000;
    assert.equal(h.store.cancelJob(jobId).type, "unchanged");
    assert.equal(h.store.failJob(jobId, "TIMEOUT", "x"), false);
    assert.equal(commitReady(h, jobId).type, "terminal");
    assert.equal(h.store.claimNextQueuedJob(), null);
    h.store.recover();
    for (const status of ACTIVE_STATUSES) {
      assert.equal(progress(h, jobId, status, 1).type, "terminal");
    }
    assert.deepEqual(jobRow(h.db, jobId), row);
    assert.deepEqual(idempotencyRow(h.db, jobId), idem);
  });

  it("at the staged defaults the rows carry L = 5,445,000 ms and R = 2,700,000 ms", () => {
    const d = makeHarness({ executionLifetimeMs: undefined, retentionMs: undefined });
    try {
      // Built with neither option: the store falls back to the strict loader's model.
      const store = new SQLiteJobStore({ db: d.db, clock: () => d.clock.now });
      const res = store.createJob(request(), randomUUID());
      assert.equal(res.type, "created");
      const jobId = res.type === "created" ? res.job.jobId : "";
      assert.equal(jobRow(d.db, jobId).expires_at_ms, T0 + 5_445_000);
      d.clock.now = T0 + 1;
      assert.equal(store.claimNextQueuedJob()?.expiresAt, T0 + 1 + 5_445_000);
      // Fifty minutes in — past the retired creation-based 45-minute TTL — the
      // running job is still authorised.
      d.clock.now = T0 + 50 * 60_000;
      assert.ok(jobRow(d.db, jobId).expires_at_ms > d.clock.now);
      store.completeAnalysis(jobId, { title: "Clip", thumbnail: null, source: "cdn.example", extractor: "direct" });
      store.beginProcessing(jobId);
      store.beginUploading(jobId);
      d.clock.now = T0 + 80 * 60_000;
      const ready = store.commitReadyFromUploading(jobId, {
        objectKey: objectKeyFor(jobId),
        filename: "clip.mp4",
        fileSize: 8,
        mime: "video/mp4",
        quality: null,
        container: "mp4",
      });
      assert.equal(ready.type, "ready");
      assert.equal(jobRow(d.db, jobId).expires_at_ms, T0 + 80 * 60_000 + 2_700_000, "ready + 45 min");
    } finally {
      d.db.close();
    }
  });

  it("a wall clock stepped back past creation cannot violate the schema or block recovery: the floor is created_at", () => {
    const failed = create(h);
    const active = create(h);
    h.clock.now = T0 + 1_000;
    claim(h, failed);
    claim(h, active);
    h.clock.now = T0 - 10 * HOUR; // stepped back by far more than L or R
    assert.equal(h.store.failJob(failed, "TIMEOUT", "x"), true);
    assert.equal(jobRow(h.db, failed).expires_at_ms, T0, "floored at created_at, never below it");
    assert.doesNotThrow(() => h.store.recover());
    assert.equal(jobRow(h.db, active).status, "failed");
    assert.equal(jobRow(h.db, active).expires_at_ms, T0);
    assert.equal(idempotencyRow(h.db, active).job_expires_at_ms, T0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a: no progress write ever renews a lifetime", () => {
  it("13,000 progress writes across all four active statuses leave expires_at and the record unchanged", () => {
    const h = makeHarness();
    try {
      const jobId = create(h);
      h.clock.now = T0 + 1_000;
      claim(h, jobId);
      const deadline = T0 + 1_000 + L;
      const idem = idempotencyRow(h.db, jobId);
      const MUTABLE = new Set([
        "progress",
        "downloaded_bytes",
        "total_bytes",
        "speed",
        "eta",
        "stage_label",
        "updated_at_ms",
      ]);
      let writes = 0;
      const plan: Array<[(typeof ACTIVE_STATUSES)[number], number]> = [
        ["analyzing", 1_000],
        ["downloading", 10_000],
        ["processing", 1_000],
        ["uploading", 1_000],
      ];
      for (const [status, count] of plan) {
        if (status !== "analyzing") driveTo(h, jobId, status);
        for (let i = 0; i < count; i += 1) {
          // The clock keeps moving — even past the deadline near the end — and
          // nothing a progress write does may follow it.
          h.clock.now += 47;
          const before = jobRow(h.db, jobId);
          const res = progress(h, jobId, status, i);
          assert.equal(res.type, "updated");
          const after = jobRow(h.db, jobId);
          for (const column of Object.keys(before) as Array<keyof JobRow>) {
            if (!MUTABLE.has(column)) assert.equal(after[column], before[column], `${status} #${i}: ${column}`);
          }
          assert.equal(after.expires_at_ms, deadline);
          writes += 1;
        }
      }
      assert.equal(writes, 13_000);
      assert.deepEqual(idempotencyRow(h.db, jobId), idem);
      assert.ok(h.clock.now > T0 + 600_000, "the virtual clock crossed the whole lifetime");
    } finally {
      // nothing else holds the database
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a: status, expiry and mirror commit or roll back together", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  /** Fails the mirror write — after the job row was already updated inside the transaction. */
  function failMirror(whenJobId?: string) {
    h.db.exec(`
      CREATE TRIGGER ld2a_fail_mirror BEFORE UPDATE ON worker_idempotency_records
      ${whenJobId ? `WHEN OLD.job_id = '${whenJobId}'` : ""}
      BEGIN SELECT RAISE(ABORT, 'injected mirror failure'); END;
    `);
  }
  const healMirror = () => h.db.exec("DROP TRIGGER ld2a_fail_mirror");

  const TRANSITIONS: Array<{
    name: string;
    prepare: (h: Harness) => string;
    run: (h: Harness, jobId: string) => unknown;
  }> = [
    { name: "claim", prepare: (x) => create(x), run: (x) => x.store.claimNextQueuedJob() },
    {
      name: "cancel",
      prepare: (x) => {
        const id = create(x);
        claim(x, id);
        return id;
      },
      run: (x, id) => x.store.cancelJob(id),
    },
    {
      name: "fail",
      prepare: (x) => {
        const id = create(x);
        claim(x, id);
        return id;
      },
      run: (x, id) => x.store.failJob(id, "TIMEOUT", "x"),
    },
    {
      name: "ready",
      prepare: (x) => {
        const id = create(x);
        claim(x, id);
        driveTo(x, id, "uploading");
        return id;
      },
      run: (x, id) => commitReady(x, id),
    },
    {
      name: "recover",
      prepare: (x) => {
        const id = create(x);
        claim(x, id);
        return id;
      },
      run: (x) => x.store.recover(),
    },
  ];

  for (const t of TRANSITIONS) {
    it(`${t.name}: a failed mirror write rolls the status and the expiry back too; healed, it commits`, () => {
      const jobId = t.prepare(h);
      h.clock.now += 5_000;
      const job = jobRow(h.db, jobId);
      const idem = idempotencyRow(h.db, jobId);
      failMirror();
      assert.throws(() => t.run(h, jobId), /injected mirror failure/);
      assert.deepEqual(jobRow(h.db, jobId), job, "the job row is exactly as before");
      assert.deepEqual(idempotencyRow(h.db, jobId), idem, "the record is exactly as before");
      healMirror();
      t.run(h, jobId);
      assert.notEqual(jobRow(h.db, jobId).expires_at_ms, job.expires_at_ms, "positive control: it commits");
      assert.equal(idempotencyRow(h.db, jobId).job_expires_at_ms, jobRow(h.db, jobId).expires_at_ms);
    });

    it(`${t.name}: a failed job write leaves the record untouched`, () => {
      const jobId = t.prepare(h);
      h.clock.now += 5_000;
      const job = jobRow(h.db, jobId);
      const idem = idempotencyRow(h.db, jobId);
      h.db.exec(`
        CREATE TRIGGER ld2a_fail_job BEFORE UPDATE ON worker_jobs
        BEGIN SELECT RAISE(ABORT, 'injected job failure'); END;
      `);
      assert.throws(() => t.run(h, jobId), /injected job failure/);
      h.db.exec("DROP TRIGGER ld2a_fail_job");
      assert.deepEqual(jobRow(h.db, jobId), job);
      assert.deepEqual(idempotencyRow(h.db, jobId), idem);
    });
  }

  it("recover is all-or-nothing: the second job's mirror failing undoes the first job's recovery", () => {
    const first = create(h);
    const second = create(h);
    claim(h, first);
    claim(h, second);
    h.clock.now += 5_000;
    const before = [jobRow(h.db, first), jobRow(h.db, second)];
    const beforeIdem = [idempotencyRow(h.db, first), idempotencyRow(h.db, second)];
    failMirror(second);
    assert.throws(() => h.store.recover(), /injected mirror failure/);
    assert.deepEqual([jobRow(h.db, first), jobRow(h.db, second)], before);
    assert.deepEqual([idempotencyRow(h.db, first), idempotencyRow(h.db, second)], beforeIdem);
  });

  it("a post-update corruption rolls back the expiry with the status (validation before COMMIT)", () => {
    const jobId = create(h);
    claim(h, jobId);
    h.clock.now += 5_000;
    const job = jobRow(h.db, jobId);
    const idem = idempotencyRow(h.db, jobId);
    h.db.exec(`
      CREATE TRIGGER ld2a_corrupt_failed AFTER UPDATE ON worker_jobs WHEN NEW.status = 'failed'
      BEGIN UPDATE worker_jobs SET url = 'not-a-url' WHERE job_id = NEW.job_id; END;
    `);
    assert.throws(() => h.store.failJob(jobId, "TIMEOUT", "x"));
    h.db.exec("DROP TRIGGER ld2a_corrupt_failed");
    assert.deepEqual(jobRow(h.db, jobId), job);
    assert.deepEqual(idempotencyRow(h.db, jobId), idem);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a: idempotency across the whole lifecycle", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  /** Replays `key` and proves the replay changed nothing durable and minted no job. */
  function replay(key: string, url?: string) {
    const jobs = h.db.prepare("SELECT * FROM worker_jobs ORDER BY job_id").all();
    const records = h.db.prepare("SELECT * FROM worker_idempotency_records ORDER BY idempotency_key").all();
    const generatedBefore = h.generated.count;
    const res = h.store.createJob(request(url), key);
    assert.equal(h.generated.count, generatedBefore, "a replay never mints a job id");
    assert.deepEqual(h.db.prepare("SELECT * FROM worker_jobs ORDER BY job_id").all(), jobs);
    // The opportunistic cleanup may only ever remove OTHER, already-expired records.
    const recordsAfter = h.db.prepare("SELECT * FROM worker_idempotency_records ORDER BY idempotency_key").all();
    for (const r of recordsAfter) assert.ok(records.some((b) => JSON.stringify(b) === JSON.stringify(r)));
    return res;
  }

  it("queued: existing until created + L, expired from then on; conflict either way", () => {
    const key = randomUUID();
    const jobId = create(h, key);
    h.clock.now = T0 + L - 1;
    const res = replay(key);
    assert.equal(res.type, "existing");
    assert.equal(res.type === "existing" && res.job.jobId, jobId);
    assert.equal(replay(key, "https://cdn.example/other.mp4").type, "conflict");
    h.clock.now = T0 + L;
    assert.equal(replay(key).type, "expired");
    assert.equal(replay(key, "https://cdn.example/other.mp4").type, "conflict");
  });

  it("active: existing throughout the execution lifetime, long past the retired 45-minute instant", () => {
    const d = makeHarness({ executionLifetimeMs: 5_445_000, retentionMs: 2_700_000 });
    try {
      const key = randomUUID();
      const res = d.store.createJob(request(), key);
      const jobId = res.type === "created" ? res.job.jobId : "";
      d.clock.now = T0 + 60_000;
      d.store.claimNextQueuedJob();
      for (const at of [T0 + 46 * 60_000, T0 + 90 * 60_000]) {
        d.clock.now = at;
        const again = d.store.createJob(request(), key);
        assert.equal(again.type, "existing", `at +${(at - T0) / 60_000} min`);
        assert.equal(again.type === "existing" && again.job.status, "analyzing");
        assert.equal(again.type === "existing" && again.job.jobId, jobId);
      }
    } finally {
      d.db.close();
    }
  });

  for (const terminal of ["ready", "failed", "cancelled"] as const) {
    it(`${terminal}: existing for R after it ends, expired from then on, never a second job`, () => {
      const key = randomUUID();
      const jobId = create(h, key);
      h.clock.now = T0 + 1_000;
      claim(h, jobId);
      driveTo(h, jobId, "uploading");
      h.clock.now += 1_000;
      const finished = h.clock.now;
      if (terminal === "ready") assert.equal(commitReady(h, jobId).type, "ready");
      if (terminal === "failed") h.store.failJob(jobId, "NETWORK_ERROR", "x");
      if (terminal === "cancelled") h.store.cancelJob(jobId);

      h.clock.now = finished + R - 1;
      const res = replay(key);
      assert.equal(res.type, "existing");
      assert.equal(res.type === "existing" && res.job.status, terminal);
      h.clock.now = finished + R;
      assert.equal(replay(key).type, "expired");
      h.clock.now = T0 + DAY - 1;
      assert.equal(replay(key).type, "expired", "the tombstone is retained for 24 h from its creation");
      assert.equal(replay(key, "https://cdn.example/other.mp4").type, "conflict");
    });
  }

  it("metadata-cleaned: an expired ready job's rows go, the tombstone stays, and the key mints nothing", () => {
    const key = randomUUID();
    const jobId = create(h, key);
    claim(h, jobId);
    driveTo(h, jobId, "uploading");
    assert.equal(commitReady(h, jobId).type, "ready");
    const readyAt = h.clock.now;
    h.clock.now = readyAt + R;
    assert.deepEqual(
      h.store.listExpiredReadyObjects(10).map((o) => o.jobId),
      [jobId],
    );
    assert.equal(h.store.deleteExpiredReadyMetadata(jobId, objectKeyFor(jobId)), true);
    assert.equal(h.store.getJob(jobId), null);
    assert.equal(idempotencyRow(h.db, jobId).job_expires_at_ms, readyAt + R, "the tombstone is untouched");
    assert.equal(replay(key).type, "expired");
    assert.equal(h.store.cleanupExpiredIdempotencyRecords(), 0, "still inside its 24 h");
    h.clock.now = T0 + DAY;
    assert.equal(h.store.cleanupExpiredIdempotencyRecords(), 1, "retired only at its own expiry");
  });

  it("the record's 24 h floor is counted from the RECORD's creation, never reset by a transition", () => {
    const d = makeHarness({ executionLifetimeMs: 3 * HOUR, retentionMs: R });
    try {
      const key = randomUUID();
      const res = d.store.createJob(request(), key);
      const jobId = res.type === "created" ? res.job.jobId : "";
      d.clock.now = T0 + 2 * HOUR;
      d.store.claimNextQueuedJob();
      assert.equal(idempotencyRow(d.db, jobId).expires_at_ms, T0 + DAY);
      d.clock.now = T0 + 3 * HOUR;
      d.store.failJob(jobId, "TIMEOUT", "x");
      const idem = idempotencyRow(d.db, jobId);
      assert.equal(idem.job_expires_at_ms, T0 + 3 * HOUR + R);
      assert.equal(idem.expires_at_ms, T0 + DAY, "not T0 + 3 h + 24 h");
    } finally {
      d.db.close();
    }
  });

  it("the record never ends before the job's authorisation, even when that runs past 24 h", () => {
    // The widest configurable lifetime: L = 54,600,000 ms (15 h 10 min).
    const WIDEST = 54_600_000;
    const d = makeHarness({ executionLifetimeMs: WIDEST, retentionMs: 3_300_000 });
    try {
      const key = randomUUID();
      const res = d.store.createJob(request(), key);
      const jobId = res.type === "created" ? res.job.jobId : "";
      d.clock.now = T0 + WIDEST - 1; // claimed a millisecond before its queue bound
      d.store.claimNextQueuedJob();
      const deadline = T0 + 2 * WIDEST - 1;
      assert.ok(deadline > T0 + DAY);
      assert.equal(idempotencyRow(d.db, jobId).expires_at_ms, deadline, "max(created + 24 h, job expiry)");

      d.clock.now = T0 + DAY + HOUR;
      assert.equal(d.store.cleanupExpiredIdempotencyRecords(), 0, "kept while the job is authorised");
      const again = d.store.createJob(request(), key);
      assert.equal(again.type, "existing");
    } finally {
      d.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a: the ready commit requires a running execution lifetime", () => {
  let h: Harness;
  let jobId: string;
  let deadline: number;
  beforeEach(() => {
    h = makeHarness();
    jobId = create(h);
    h.clock.now = T0 + 1_000;
    claim(h, jobId);
    deadline = T0 + 1_000 + L;
    driveTo(h, jobId, "uploading");
  });
  afterEach(() => h.db.close());

  it("a millisecond before the deadline: ready, retained R from that instant", () => {
    h.clock.now = deadline - 1;
    const res = commitReady(h, jobId);
    assert.equal(res.type, "ready");
    assert.equal(jobRow(h.db, jobId).expires_at_ms, deadline - 1 + R);
  });

  for (const offset of [0, 1, HOUR]) {
    it(`${offset === 0 ? "at" : `${offset} ms after`} the deadline: lifetime_expired, and nothing is written`, () => {
      const job = jobRow(h.db, jobId);
      const idem = idempotencyRow(h.db, jobId);
      h.clock.now = deadline + offset;
      const res = commitReady(h, jobId);
      assert.equal(res.type, "lifetime_expired");
      assert.equal(res.type === "lifetime_expired" && res.job.status, "uploading");
      const after = jobRow(h.db, jobId);
      assert.deepEqual(after, job, "no status, key, expiry or timestamp moved");
      assert.equal(after.object_key, null, "no object becomes reachable");
      assert.deepEqual(idempotencyRow(h.db, jobId), idem);
      assert.deepEqual(h.store.listExpiredReadyObjects(10), [], "nothing is ready, so maintenance owns nothing");
    });
  }

  it("lifetime_expired leaves the job to its executor: failJob then records Upload failed, retained R", () => {
    h.clock.now = deadline + 5;
    assert.equal(commitReady(h, jobId).type, "lifetime_expired");
    assert.equal(h.store.failJob(jobId, "TIMEOUT", "The video took too long to process."), true);
    const row = jobRow(h.db, jobId);
    assert.equal(row.status, "failed");
    assert.equal(row.error_code, "TIMEOUT");
    assert.equal(row.stage_label, "Upload failed");
    assert.equal(row.expires_at_ms, deadline + 5 + R);
  });

  it("a cancel that won first still wins, even past the deadline: terminal, never lifetime_expired", () => {
    h.clock.now = deadline - 10;
    assert.equal(h.store.cancelJob(jobId).type, "cancelled");
    h.clock.now = deadline + 10;
    assert.equal(commitReady(h, jobId).type, "terminal");
    assert.equal(jobRow(h.db, jobId).status, "cancelled");
  });

  it("the guard is in the authoritative conditional write, not only in the read before it", () => {
    const file = path.join(process.cwd(), "src/worker/state/sqlite-job-store.server.ts");
    const source = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const readyUpdates: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
        const sql = node.text.replace(/\s+/g, " ");
        if (/UPDATE worker_jobs SET status = 'ready'/.test(sql)) readyUpdates.push(sql);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    assert.equal(readyUpdates.length, 1, "exactly one ready transition");
    assert.match(readyUpdates[0]!, /WHERE job_id = \? AND status = 'uploading' AND expires_at_ms > \?/);
    assert.match(readyUpdates[0]!, /expires_at_ms = \?/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a: claim, cancel and the lifetimes serialise across connections", () => {
  let dir: string;
  let a: Harness;
  let b: Harness;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld2a-cas-"));
    const file = path.join(dir, "state.sqlite");
    const dbA = openWorkerDatabase({ path: file });
    applyMigrations(dbA);
    a = makeHarness({ db: dbA });
    b = makeHarness({ db: openWorkerDatabase({ path: file }) });
    b.generated.count = 1_000; // distinct ids across the two stores
  });
  afterEach(() => {
    a.db.close();
    b.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a claim then a cancel from another connection: the cancel wins and assigns its own retention", () => {
    const jobId = create(a);
    a.clock.now = T0 + 1_000;
    claim(a, jobId);
    b.clock.now = T0 + 2_000;
    assert.equal(b.store.cancelJob(jobId).type, "cancelled");
    assert.equal(a.store.failJob(jobId, "TIMEOUT", "x"), false, "the claimer's later failure loses");
    assert.equal(jobRow(a.db, jobId).expires_at_ms, T0 + 2_000 + R);
    assert.equal(idempotencyRow(a.db, jobId).job_expires_at_ms, T0 + 2_000 + R);
  });

  it("a cancel then a claim from another connection: nothing is claimed and no lifetime moves", () => {
    const jobId = create(a);
    b.clock.now = T0 + 1_000;
    b.store.cancelJob(jobId);
    const cancelled = jobRow(a.db, jobId);
    a.clock.now = T0 + 2_000;
    assert.equal(a.store.claimNextQueuedJob(), null);
    assert.deepEqual(jobRow(a.db, jobId), cancelled);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a: the store's lifetime options", () => {
  it("refuses the retired creation-based TTL by presence rather than ignoring it", () => {
    const db = openWorkerDatabase({ path: ":memory:" });
    try {
      applyMigrations(db);
      for (const value of [1_000, undefined]) {
        assert.throws(
          () => new SQLiteJobStore({ db, ...({ jobTtlMs: value } as object) }),
          (err: unknown) => err instanceof WorkerTimeLimitsError && err.field === "jobTtlMs",
        );
      }
    } finally {
      db.close();
    }
  });

  it("refuses a malformed lifetime, or one wider than the strict ranges can produce", () => {
    const db = openWorkerDatabase({ path: ":memory:" });
    try {
      applyMigrations(db);
      for (const [options, field] of [
        [{ executionLifetimeMs: 0 }, "executionLifetimeMs"],
        [{ executionLifetimeMs: 1.5 }, "executionLifetimeMs"],
        [{ executionLifetimeMs: 54_600_001 }, "executionLifetimeMs"],
        [{ retentionMs: -1 }, "retentionMs"],
        [{ retentionMs: 3_300_001 }, "retentionMs"],
        [{ retentionMs: Number.NaN }, "retentionMs"],
      ] as const) {
        assert.throws(
          () => new SQLiteJobStore({ db, ...options }),
          (err: unknown) => err instanceof WorkerTimeLimitsError && err.field === field,
          JSON.stringify(options),
        );
      }
      assert.doesNotThrow(() => new SQLiteJobStore({ db, executionLifetimeMs: 1, retentionMs: 1 }));
      assert.doesNotThrow(() => new SQLiteJobStore({ db, executionLifetimeMs: 54_600_000, retentionMs: 3_300_000 }));
    } finally {
      db.close();
    }
  });
});
