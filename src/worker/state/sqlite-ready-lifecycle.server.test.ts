import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ZodError } from "zod";
import { openWorkerDatabase } from "./database.server.ts";
import { applyMigrations } from "./migrations.server.ts";
import { SQLiteJobStore } from "./sqlite-job-store.server.ts";
import type { CommitReadyResult } from "./job-store.ts";

/**
 * VIDEOFETCH-LD5B-R2-RETENTION-LIFECYCLE-HARDENING-001 — the ready transition's
 * provider-lifecycle cap, enforced by the REAL durable store:
 *
 *     expiresAt = min(finished + R, Last-Modified + 3,600,000 − 300,000)
 *
 * computed inside `commitReadyFromUploading`'s own transaction with its own
 * commit instant, and mirrored into the idempotency record in the same
 * transaction. Every case reads the durable rows straight from SQLite.
 *
 * Failed, cancelled and recovered jobs keep `finished + R` exactly.
 */

const R_DEFAULT = 2_700_000;
const R_MAX = 3_300_000;
const L = 5_445_000;
const CAP = 3_300_000; // 3,600,000 − 300,000
/** The job's creation: a whole second, so a provider timestamp can equal it. */
const T0 = 1_795_595_000_000;
/** The provider's `Last-Modified`: the upload completed 25 minutes after creation. */
const LM = T0 + 1_500_000;

type JobRow = {
  status: string;
  expires_at_ms: number;
  finished_at_ms: number | null;
  object_key: string | null;
  created_at_ms: number;
};

type Harness = { db: DatabaseSync; clock: { now: number }; store: SQLiteJobStore };

const open: DatabaseSync[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function harness(retentionMs: number, executionLifetimeMs = L, t0 = T0): Harness {
  const db = openWorkerDatabase({ path: ":memory:" });
  applyMigrations(db);
  open.push(db);
  const clock = { now: t0 };
  const store = new SQLiteJobStore({ db, clock: () => clock.now, executionLifetimeMs, retentionMs });
  return { db, clock, store };
}

/** Creates, claims and drives one job to `uploading`; the clock ends at `t0 + 4 s`. */
function uploadingJob(h: Harness, key: string = randomUUID()): string {
  const created = h.store.createJob(
    { url: "https://cdn.example/clip.mp4", formatId: "direct-original", principalId: "private-access-user" },
    key,
  );
  assert.equal(created.type, "created");
  const jobId = created.type === "created" ? created.job.jobId : "";
  h.clock.now += 1_000;
  assert.equal(h.store.claimNextQueuedJob()?.jobId, jobId);
  h.clock.now += 1_000;
  assert.equal(h.store.completeAnalysis(jobId, { title: "Clip", thumbnail: null, source: "cdn.example", extractor: "direct" }).type, "updated");
  h.clock.now += 1_000;
  assert.equal(h.store.beginProcessing(jobId).type, "updated");
  h.clock.now += 1_000;
  assert.equal(h.store.beginUploading(jobId).type, "updated");
  return jobId;
}

const objectKeyFor = (jobId: string) => `videofetch/jobs/${jobId}/${"b".repeat(32)}`;

function commit(h: Harness, jobId: string, lastModifiedAtMs: unknown): CommitReadyResult {
  return h.store.commitReadyFromUploading(jobId, {
    objectKey: objectKeyFor(jobId),
    filename: "clip.mp4",
    fileSize: 8,
    mime: "video/mp4",
    quality: "original",
    container: "mp4",
    lastModifiedAtMs: lastModifiedAtMs as number,
  });
}

function row(h: Harness, jobId: string): JobRow {
  const r = h.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  assert.ok(r, `row ${jobId}`);
  return { ...r };
}

function idem(h: Harness, jobId: string): { job_expires_at_ms: number; expires_at_ms: number; created_at_ms: number } {
  const r = h.db.prepare("SELECT * FROM worker_idempotency_records WHERE job_id = ?").get(jobId) as
    | { job_expires_at_ms: number; expires_at_ms: number; created_at_ms: number }
    | undefined;
  assert.ok(r, `idempotency ${jobId}`);
  return { ...r };
}

/** Commits at `LM + delay` and returns the durable outcome. */
function readyAfter(retentionMs: number, delay: number) {
  const h = harness(retentionMs);
  const jobId = uploadingJob(h);
  h.clock.now = LM + delay;
  const res = commit(h, jobId, LM);
  return { h, jobId, res, commitAt: LM + delay };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-5b store: the delayed completion-to-ready matrix (default and maximum R)", () => {
  const delays = (r: number) => {
    const binds = CAP - r; // the delay at which the provider cap first binds
    return [
      ["zero", 0],
      ["one second", 1_000],
      ["one millisecond before the cap binds", binds - 1],
      ["exactly where the cap binds", binds],
      ["one millisecond after the cap binds", binds + 1],
      ["300 s", 300_000],
      ["381 s", 381_000],
      ["531 s", 531_000],
      ["900 s", 900_000],
      ["936 s", 936_000],
      ["1,200 s", 1_200_000],
    ] as const;
  };

  for (const [label, r] of [
    ["default R = 2,700,000", R_DEFAULT],
    ["maximum R = 3,300,000", R_MAX],
  ] as const) {
    for (const [name, delay] of delays(r)) {
      it(`${label}: ${name} (${delay} ms after Last-Modified)`, () => {
        const { h, jobId, res, commitAt } = readyAfter(r, delay);
        assert.equal(res.type, "ready");
        const expected = Math.min(commitAt + r, LM + CAP);
        const durable = row(h, jobId);
        assert.equal(durable.status, "ready");
        assert.equal(durable.finished_at_ms, commitAt, "the commit's own instant is recorded");
        assert.equal(durable.expires_at_ms, expected, "min(ready + R, Last-Modified + 55 min)");
        assert.ok(durable.expires_at_ms <= commitAt + r, "never beyond ready + R");
        assert.ok(durable.expires_at_ms <= LM + CAP, "never beyond Last-Modified + 3,600,000 − 300,000");
        assert.ok(durable.expires_at_ms > commitAt, "a ready result always has a window");
        assert.equal(res.type === "ready" ? res.job.expiresAt : -1, expected, "the view states the committed expiry");
        assert.equal(idem(h, jobId).job_expires_at_ms, expected, "mirrored into the idempotency record");
      });
    }
  }

  it("default R: the provider cap first binds 600 s after completion; before that ready + R is unchanged", () => {
    assert.equal(CAP - R_DEFAULT, 600_000);
    const early = readyAfter(R_DEFAULT, 599_999);
    assert.equal(row(early.h, early.jobId).expires_at_ms, early.commitAt + R_DEFAULT);
    const late = readyAfter(R_DEFAULT, 600_001);
    assert.equal(row(late.h, late.jobId).expires_at_ms, LM + CAP);
  });

  it("maximum R: any commit after completion is capped at Last-Modified + 55 min", () => {
    for (const delay of [1, 932, 1_642]) {
      const { h, jobId } = readyAfter(R_MAX, delay);
      assert.equal(row(h, jobId).expires_at_ms, LM + CAP, `delay ${delay}`);
    }
  });
});

describe("LD-5b store: a missing, malformed or implausible Last-Modified never becomes ready", () => {
  function expectNothingWritten(h: Harness, jobId: string, before: JobRow, beforeIdem: ReturnType<typeof idem>) {
    assert.deepEqual(row(h, jobId), before, "the job row is untouched");
    assert.deepEqual(idem(h, jobId), beforeIdem, "the idempotency record is untouched");
    assert.equal(row(h, jobId).status, "uploading");
    assert.equal(row(h, jobId).object_key, null);
  }

  it("refuses a commit with no Last-Modified at the schema, before any transaction: no fallback to ready + R", () => {
    const h = harness(R_DEFAULT);
    const jobId = uploadingJob(h);
    h.clock.now = LM + 1_000;
    const before = row(h, jobId);
    const beforeIdem = idem(h, jobId);
    const input = {
      objectKey: objectKeyFor(jobId),
      filename: "clip.mp4",
      fileSize: 8,
      mime: "video/mp4",
      quality: "original",
      container: "mp4",
    };
    assert.throws(() => h.store.commitReadyFromUploading(jobId, input as never), ZodError);
    expectNothingWritten(h, jobId, before, beforeIdem);
  });

  for (const [label, value] of [
    ["an invalid Date's NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative (pre-1970) instant", -1_000],
    ["a fractional second", LM + 500],
    ["a local millisecond clock reading", LM + 437],
    ["seconds instead of milliseconds", LM / 1000],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["a numeric string", String(LM)],
    ["a Date object", new Date(LM)],
    ["null", null],
  ] as const) {
    it(`refuses ${label} at the schema: nothing written`, () => {
      const h = harness(R_DEFAULT);
      const jobId = uploadingJob(h);
      h.clock.now = LM + 1_000;
      const before = row(h, jobId);
      const beforeIdem = idem(h, jobId);
      assert.throws(() => commit(h, jobId, value), ZodError);
      expectNothingWritten(h, jobId, before, beforeIdem);
    });
  }

  for (const [label, lm, commitAt, reason, retentionMs] of [
    ["an unreasonably future Last-Modified (301 s after the commit: beyond the clock-skew budget)", LM + 301_000, LM, "last_modified_in_future", R_DEFAULT],
    ["milliseconds read as seconds and scaled again (far future)", LM * 1000, LM, "last_modified_in_future", R_DEFAULT],
    ["year 9999", 253_402_300_799_000, LM, "last_modified_in_future", R_DEFAULT],
    ["whole seconds since 1970 read as milliseconds", 1_795_599_000, LM, "provider_window_elapsed", R_DEFAULT],
    ["an already-expired provider-safe window", LM, LM + CAP + 1_000, "provider_window_elapsed", R_DEFAULT],
    ["a provider-safe boundary equal to the commit instant", LM, LM + CAP, "provider_window_elapsed", R_DEFAULT],
    ["an expiry before the job's creation (clock stepped back 10 s past it, 1 s retention)", T0 - 5_000, T0 - 10_000, "expiry_before_job", 1_000],
    ["an expiry before the job's creation (Last-Modified 56 min before it, clock stepped back 200 s)", T0 - 3_360_000, T0 - 200_000, "expiry_before_job", R_DEFAULT],
  ] as const) {
    it(`refuses ${label}: ready_expiry_refused (${reason}), nothing written`, () => {
      const h = harness(retentionMs, 2 * 3_600_000 + 1_500_000);
      const jobId = uploadingJob(h);
      h.clock.now = commitAt;
      const before = row(h, jobId);
      const beforeIdem = idem(h, jobId);
      const res = commit(h, jobId, lm);
      assert.equal(res.type, "ready_expiry_refused");
      assert.equal(res.type === "ready_expiry_refused" ? res.reason : null, reason);
      assert.equal(res.type === "ready_expiry_refused" ? res.job.status : null, "uploading");
      expectNothingWritten(h, jobId, before, beforeIdem);
    });
  }

  it("accepts a Last-Modified inside the 300 s clock-skew budget, and one long before the job: the cap only shortens", () => {
    const h = harness(R_DEFAULT, 2 * 3_600_000 + 1_500_000);
    const ahead = uploadingJob(h);
    h.clock.now = LM - 300_000; // the Worker's clock 300 s behind R2's
    assert.equal(commit(h, ahead, LM).type, "ready");
    assert.equal(row(h, ahead).expires_at_ms, LM - 300_000 + R_DEFAULT, "the configured bound binds");
    const behind = uploadingJob(h);
    h.clock.now = T0 + 60_000;
    const early = T0 - 600_000; // R2's Last-Modified reads 10 min before the job's creation
    assert.equal(commit(h, behind, early).type, "ready");
    assert.equal(row(h, behind).expires_at_ms, early + CAP, "capped at Last-Modified + 55 min, never floored");
  });

  it("accepts a window of exactly one millisecond, and caps the expiry at it", () => {
    const h = harness(R_DEFAULT, 2 * 3_600_000 + 1_500_000);
    const jobId = uploadingJob(h);
    h.clock.now = LM + CAP - 1;
    const res = commit(h, jobId, LM);
    assert.equal(res.type, "ready");
    assert.equal(row(h, jobId).expires_at_ms, LM + CAP);
    assert.equal(idem(h, jobId).job_expires_at_ms, LM + CAP);
  });

  it("refuses a cap past the safe integers (arithmetic overflow) without writing", () => {
    // Unreachable through createJob, whose 24-hour idempotency floor needs
    // `created + 24 h` to be a safe integer; the uploading row is inserted
    // directly so the store's own guard is exercised.
    const created = Number.MAX_SAFE_INTEGER - 3_200_000;
    const h = harness(R_DEFAULT, 600_000, created);
    const jobId = "f".repeat(32);
    h.db
      .prepare(
        `INSERT INTO worker_jobs (job_id, url, format_id, principal_id, status, created_at_ms, updated_at_ms, expires_at_ms, started_at_ms)
         VALUES (?, 'https://cdn.example/clip.mp4', 'direct-original', 'private-access-user', 'uploading', ?, ?, ?, ?)`,
      )
      .run(jobId, created, created, Number.MAX_SAFE_INTEGER, created);
    h.clock.now = created + 100_000;
    const lm = Math.floor(h.clock.now / 1000) * 1000;
    assert.ok(lm + CAP > Number.MAX_SAFE_INTEGER, "the cap itself would overflow");
    const before = row(h, jobId);
    const res = commit(h, jobId, lm);
    assert.equal(res.type, "ready_expiry_refused");
    assert.equal(res.type === "ready_expiry_refused" ? res.reason : null, "invalid_last_modified");
    assert.deepEqual(row(h, jobId), before, "the job row is untouched");
  });
});

describe("LD-5b store: the existing precedence and the other terminal retentions are unchanged", () => {
  it("an execution lifetime that ended still wins: lifetime_expired, even with an elapsed provider window", () => {
    const h = harness(R_DEFAULT, 1_000_000);
    const jobId = uploadingJob(h);
    h.clock.now = T0 + 1_000 + 1_000_000; // exactly claimed + L
    assert.equal(commit(h, jobId, T0).type, "lifetime_expired");
    assert.equal(row(h, jobId).status, "uploading");
  });

  it("a terminal winner still wins: terminal, whatever the Last-Modified says", () => {
    const h = harness(R_DEFAULT);
    const jobId = uploadingJob(h);
    assert.equal(h.store.cancelJob(jobId).type, "cancelled");
    const cancelled = row(h, jobId);
    h.clock.now = LM + 1_000;
    for (const lm of [LM, LM * 1000, T0 - 3_600_000]) {
      assert.equal(commit(h, jobId, lm).type, "terminal");
    }
    assert.deepEqual(row(h, jobId), cancelled);
  });

  for (const [label, r] of [
    ["default R", R_DEFAULT],
    ["maximum R", R_MAX],
  ] as const) {
    it(`${label}: failed, cancelled and recovered jobs keep finished + R exactly`, () => {
      const h = harness(r);
      const failed = uploadingJob(h);
      const cancelled = uploadingJob(h);
      const recovered = uploadingJob(h);
      h.clock.now = LM + 900_000;
      assert.equal(h.store.failJob(failed, "PROCESSING_FAILED", "Upload failed"), true);
      assert.equal(row(h, failed).expires_at_ms, LM + 900_000 + r);
      assert.equal(idem(h, failed).job_expires_at_ms, LM + 900_000 + r);
      h.clock.now += 1_000;
      assert.equal(h.store.cancelJob(cancelled).type, "cancelled");
      assert.equal(row(h, cancelled).expires_at_ms, LM + 901_000 + r);
      assert.equal(idem(h, cancelled).job_expires_at_ms, LM + 901_000 + r);
      h.clock.now += 1_000;
      h.store.recover();
      assert.equal(row(h, recovered).status, "failed");
      assert.equal(row(h, recovered).expires_at_ms, LM + 902_000 + r);
      assert.equal(idem(h, recovered).job_expires_at_ms, LM + 902_000 + r);
    });
  }
});

describe("LD-5b store: a shortened ready result through replay, view, maintenance and restart", () => {
  it("an idempotent replay answers the shortened job while it is authorised and expired after — never a longer one", () => {
    const h = harness(R_MAX);
    const key = randomUUID();
    const jobId = uploadingJob(h, key);
    h.clock.now = LM + 381_000;
    assert.equal(commit(h, jobId, LM).type, "ready");
    const capped = LM + CAP;
    assert.equal(row(h, jobId).expires_at_ms, capped);
    const replay = () =>
      h.store.createJob({ url: "https://cdn.example/clip.mp4", formatId: "direct-original", principalId: "private-access-user" }, key);
    h.clock.now = capped - 1;
    const live = replay();
    assert.equal(live.type, "existing");
    assert.equal(live.type === "existing" ? live.job.expiresAt : -1, capped, "the replay never re-derives or extends it");
    assert.equal(row(h, jobId).expires_at_ms, capped);
    h.clock.now = capped;
    assert.equal(replay().type, "expired");
    assert.equal(idem(h, jobId).job_expires_at_ms, capped);
  });

  it("maintenance collects the shortened object at its capped expiry, not at ready + R; the tombstone stays", () => {
    const h = harness(R_MAX);
    const key = randomUUID();
    const jobId = uploadingJob(h, key);
    h.clock.now = LM + 381_000;
    assert.equal(commit(h, jobId, LM).type, "ready");
    const capped = LM + CAP;
    h.clock.now = capped - 1;
    assert.deepEqual(h.store.listExpiredReadyObjects(10), []);
    assert.equal(h.store.deleteExpiredReadyMetadata(jobId, objectKeyFor(jobId)), false);
    h.clock.now = capped;
    assert.deepEqual(h.store.listExpiredReadyObjects(10), [{ jobId, objectKey: objectKeyFor(jobId), expiresAt: capped }]);
    assert.equal(h.store.deleteExpiredReadyMetadata(jobId, objectKeyFor(jobId)), true);
    assert.equal(h.store.getJob(jobId), null);
    assert.equal(idem(h, jobId).job_expires_at_ms, capped, "the idempotency tombstone outlives the metadata");
    const replay = h.store.createJob(
      { url: "https://cdn.example/clip.mp4", formatId: "direct-original", principalId: "private-access-user" },
      key,
    );
    assert.equal(replay.type, "expired", "no second job from the same key");
  });

  it("restart recovery leaves a shortened ready result exactly as committed", () => {
    const h = harness(R_MAX);
    const jobId = uploadingJob(h);
    h.clock.now = LM + 936_000;
    assert.equal(commit(h, jobId, LM).type, "ready");
    const committed = row(h, jobId);
    const committedIdem = idem(h, jobId);
    h.clock.now += 60_000;
    h.store.recover();
    assert.deepEqual(row(h, jobId), committed);
    assert.deepEqual(idem(h, jobId), committedIdem);
  });

  it("a late commit or a cancellation after the capped expiry cannot resurrect or move the result", () => {
    const h = harness(R_MAX);
    const jobId = uploadingJob(h);
    h.clock.now = LM + 1_000;
    assert.equal(commit(h, jobId, LM).type, "ready");
    const committed = row(h, jobId);
    h.clock.now = LM + CAP + 60_000;
    assert.equal(commit(h, jobId, LM + 60_000).type, "terminal");
    assert.equal(h.store.cancelJob(jobId).type, "unchanged");
    assert.equal(h.store.failJob(jobId, "PROCESSING_FAILED", "Upload failed"), false);
    assert.deepEqual(row(h, jobId), committed);
  });
});
