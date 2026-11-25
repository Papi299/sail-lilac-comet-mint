import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { finalizeJobUpload, UPLOAD_CLEANUP_BUDGET_MS, type FinalizeUploadResult, type UploadStageTimerHandle, type UploadStageTimers } from "./upload-lifecycle.server.ts";
import type { ObjectStoreHead, ObjectStoreOperationContext, ObjectStorePutInput, ObjectStoreWriter } from "./writer.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";

/**
 * VIDEOFETCH-LD5B-R2-RETENTION-LIFECYCLE-HARDENING-001 — the upload finalizer
 * and the durable ready commit together, on ONE virtual clock shared by the
 * store and the upload stage:
 *
 *  - the provider double stamps `Last-Modified` when the PUT completes, the way
 *    R2 does (whole seconds, the completion instant — LD-5a Q16);
 *  - the HEAD's answer, and anything between it and the commit, is delayed in
 *    virtual time; the store commits at whatever instant the clock then says;
 *  - every expected value is derived from the commit's ACTUAL instant.
 *
 * Plus the races the upload stage already owns — cancellation, the stage's one
 * deadline, a terminal winner, a failed conditional write — which must keep
 * their precedence with the cap in place, and the LD-5a replay: the provider
 * timestamps and ready instants RECORDED against real R2 (C1, D1b, D1b-x2).
 */

const CAP = 3_300_000;
const R_DEFAULT = 2_700_000;
const R_MAX = 3_300_000;
const L = 5_445_000;
const STAGE_BUDGET = 3_600_000;

type ArmedTimer = UploadStageTimerHandle & { handler: () => void; ms: number; cleared: boolean };

class VirtualTimers implements UploadStageTimers {
  readonly armed: ArmedTimer[] = [];
  setTimeoutFn = (handler: () => void, ms: number): UploadStageTimerHandle => {
    const timer: ArmedTimer = { handler, ms, cleared: false, unref: () => undefined };
    this.armed.push(timer);
    return timer;
  };
  clearTimeoutFn = (handle: UploadStageTimerHandle) => {
    (handle as ArmedTimer).cleared = true;
  };
  fire(index: number): void {
    const timer = this.armed[index]!;
    if (!timer.cleared) timer.handler();
  }
}

type HeadHook = (ctx: { clock: { now: number }; signal: AbortSignal | undefined }) => void;

/**
 * A provider double: PUT stores the object and stamps its whole-second
 * `Last-Modified` from the shared clock; HEAD runs `duringHead` (which may move
 * the clock, cancel, fire the deadline…) and then answers like the real writer:
 * rejecting when its signal has aborted.
 */
class ProviderDouble implements ObjectStoreWriter {
  readonly objects = new Map<string, { input: ObjectStorePutInput; lastModifiedAtMs: number }>();
  readonly deletes: string[] = [];
  readonly heads: string[] = [];
  duringHead: HeadHook = () => {};
  /** Lets a case replace the provider's answer, e.g. with a recorded `Last-Modified`. */
  lastModifiedOverride: number | null = null;
  /** How long the PUT takes on the shared clock, before the provider stamps its completion. */
  putDurationMs = 0;
  /** R2's clock minus the Worker's: the provider stamps Last-Modified on ITS clock. */
  providerOffsetMs = 0;
  putStartedAt: number | null = null;
  private readonly clock: { now: number };
  constructor(clock: { now: number }) {
    this.clock = clock;
  }
  async put(input: ObjectStorePutInput, context?: ObjectStoreOperationContext): Promise<void> {
    if (context?.signal?.aborted) throw new Error("put refused: aborted");
    this.putStartedAt = this.clock.now;
    for await (const chunk of input.body) void chunk;
    this.clock.now += this.putDurationMs;
    this.objects.set(input.objectKey, {
      input,
      lastModifiedAtMs: Math.floor((this.clock.now + this.providerOffsetMs) / 1000) * 1000,
    });
  }
  async head(objectKey: string, context?: ObjectStoreOperationContext): Promise<ObjectStoreHead | null> {
    this.heads.push(objectKey);
    this.duringHead({ clock: this.clock, signal: context?.signal });
    if (context?.signal?.aborted) throw new Error("head torn down");
    const stored = this.objects.get(objectKey);
    if (!stored) return null;
    return {
      objectKey,
      contentLength: stored.input.contentLength,
      contentType: stored.input.contentType,
      contentDisposition: stored.input.contentDisposition,
      lastModifiedAtMs: this.lastModifiedOverride ?? stored.lastModifiedAtMs,
    };
  }
  async delete(objectKey: string): Promise<void> {
    this.deletes.push(objectKey);
    this.objects.delete(objectKey);
  }
}

type World = {
  db: DatabaseSync;
  clock: { now: number };
  /** Added to the store's clock only: the commit happening after the stage's last look at the time. */
  storeLag: { ms: number };
  commits: number;
  store: SQLiteJobStore;
  provider: ProviderDouble;
  timers: VirtualTimers;
  execution: AbortController;
  jobId: string;
  key: string;
  uploadingAt: number;
};

const dbs: DatabaseSync[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
});

/** A job driven to `uploading` with its transition committed at `uploadingAt`. */
function world(retentionMs: number, uploadingAt: number, executionLifetimeMs = L): World {
  const db = openWorkerDatabase({ path: ":memory:" });
  applyMigrations(db);
  dbs.push(db);
  const clock = { now: uploadingAt - 4_000 };
  const storeLag = { ms: 0 };
  const store = new SQLiteJobStore({ db, clock: () => clock.now + storeLag.ms, executionLifetimeMs, retentionMs });
  const created = store.createJob(
    { url: "https://cdn.example/clip.mp4", formatId: "direct-original", principalId: "private-access-user" },
    randomUUID(),
  );
  assert.equal(created.type, "created");
  const jobId = created.type === "created" ? created.job.jobId : "";
  clock.now += 1_000;
  store.claimNextQueuedJob();
  clock.now += 1_000;
  store.completeAnalysis(jobId, { title: "Clip", thumbnail: null, source: "cdn.example", extractor: "direct" });
  clock.now += 1_000;
  store.beginProcessing(jobId);
  clock.now += 1_000;
  assert.equal(store.beginUploading(jobId).type, "updated");
  assert.equal(clock.now, uploadingAt);
  const provider = new ProviderDouble(clock);
  const w: World = {
    db,
    clock,
    storeLag,
    commits: 0,
    store,
    provider,
    timers: new VirtualTimers(),
    execution: new AbortController(),
    jobId,
    key: `videofetch/jobs/${jobId}/${"c".repeat(32)}`,
    uploadingAt,
  };
  const realCommit = store.commitReadyFromUploading.bind(store);
  store.commitReadyFromUploading = (id, input) => {
    w.commits += 1;
    return realCommit(id, input);
  };
  return w;
}

function finalize(w: World, stageClock?: () => number): Promise<FinalizeUploadResult> {
  return finalizeJobUpload({
    jobId: w.jobId,
    store: w.store,
    writer: w.provider,
    body: (async function* () {
      yield new Uint8Array(8);
    })(),
    filename: "clip.mp4",
    fileSize: 8,
    mime: "video/mp4",
    quality: null,
    container: "mp4",
    randomSource: () => new Uint8Array(16).fill(0xcc),
    stage: {
      signal: w.execution.signal,
      deadlineMs: w.uploadingAt + STAGE_BUDGET,
      clock: stageClock ?? (() => w.clock.now),
      timers: w.timers,
    },
  });
}

const durable = (w: World) =>
  w.db.prepare("SELECT status, expires_at_ms, finished_at_ms, object_key FROM worker_jobs WHERE job_id = ?").get(w.jobId) as {
    status: string;
    expires_at_ms: number;
    finished_at_ms: number | null;
    object_key: string | null;
  };
const mirrored = (w: World) =>
  (w.db.prepare("SELECT job_expires_at_ms FROM worker_idempotency_records WHERE job_id = ?").get(w.jobId) as { job_expires_at_ms: number })
    .job_expires_at_ms;

// A whole second plus 400 ms: Last-Modified truncation is visible.
const UPLOADING_AT = 1_795_598_000_400;
const COMPLETED_AT = UPLOADING_AT + 600_000; // the PUT completes ten minutes into the stage
const LM = Math.floor(COMPLETED_AT / 1000) * 1000;

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-5b finalizer × store: a delayed HEAD and commit can never carry the expiry past the cap", () => {
  for (const [label, r] of [
    ["default R", R_DEFAULT],
    ["maximum R", R_MAX],
  ] as const) {
    for (const delay of [0, 1_000, 300_000, 381_000, 531_000, 900_000, 936_000, 1_200_000]) {
      it(`${label}: HEAD answered ${delay} ms after completion; the commit's own instant decides`, async () => {
        const w = world(r, UPLOADING_AT);
        w.clock.now = COMPLETED_AT;
        w.provider.duringHead = ({ clock }) => {
          clock.now += delay;
        };
        const result = await finalize(w);
        assert.equal(result.type, "ready");
        const commitAt = COMPLETED_AT + delay;
        const row = durable(w);
        assert.equal(row.finished_at_ms, commitAt);
        assert.equal(row.expires_at_ms, Math.min(commitAt + r, LM + CAP));
        assert.ok(row.expires_at_ms <= LM + CAP);
        assert.ok(row.expires_at_ms <= commitAt + r);
        assert.equal(mirrored(w), row.expires_at_ms);
        assert.deepEqual(w.provider.deletes, []);
      });
    }
  }

  it("the commit instant, not the HEAD's answer, is what counts: time passing after the HEAD still shortens nothing it should not", async () => {
    // The HEAD answers at once; the time is spent before the HEAD starts (a slow
    // credential mint), so the commit happens 700 s after completion.
    const w = world(R_DEFAULT, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.duringHead = ({ clock }) => {
      clock.now += 700_000;
    };
    assert.equal((await finalize(w)).type, "ready");
    assert.equal(durable(w).expires_at_ms, LM + CAP, "600 s < 700 s: the cap binds, not ready + R");
    assert.ok(durable(w).expires_at_ms < COMPLETED_AT + 700_000 + R_DEFAULT);
  });
});

describe("LD-5b finalizer × store: a refused lifecycle never becomes ready, and the exact key is deleted", () => {
  // The PUT completes 100 s into the stage here, so even a HEAD answered 55 min
  // later is still inside the stage's 60-minute deadline: the lifecycle, not
  // the deadline, is what refuses.
  const EARLY_COMPLETION = UPLOADING_AT + 100_000;
  const EARLY_LM = Math.floor(EARLY_COMPLETION / 1000) * 1000;
  for (const [label, lastModifiedAtMs, delay, reason] of [
    ["the provider-safe window already elapsed (HEAD answered 55 min after completion)", null, CAP, "provider_window_elapsed"],
    ["an unreasonably future Last-Modified", EARLY_LM + 3_600_000, 1_000, "last_modified_in_future"],
    ["a Last-Modified an hour before the stage (no window left)", Math.floor((UPLOADING_AT - 3_600_000) / 1000) * 1000, 1_000, "provider_window_elapsed"],
  ] as const) {
    it(`${label} → storage_failure verification_failed, cleanup deleted, still uploading (${reason})`, async () => {
      const w = world(R_DEFAULT, UPLOADING_AT);
      w.clock.now = EARLY_COMPLETION;
      if (lastModifiedAtMs !== null) w.provider.lastModifiedOverride = lastModifiedAtMs;
      w.provider.duringHead = ({ clock }) => {
        clock.now += delay;
      };
      const before = mirrored(w);
      const result = await finalize(w);
      assert.deepEqual(result, { type: "storage_failure", code: "verification_failed", cleanup: "deleted" });
      assert.deepEqual(w.provider.deletes, [w.key], "exactly the attempted key");
      assert.equal(durable(w).status, "uploading", "the executor fails it next, as for any storage failure");
      assert.equal(durable(w).object_key, null);
      assert.equal(mirrored(w), before, "the idempotency record is untouched");
      // The direct check of the same refusal, from the store itself.
      const direct = w.store.commitReadyFromUploading(w.jobId, {
        objectKey: w.key,
        filename: "clip.mp4",
        fileSize: 8,
        mime: "video/mp4",
        quality: null,
        container: "mp4",
        lastModifiedAtMs: lastModifiedAtMs ?? EARLY_LM,
      });
      assert.equal(direct.type === "ready_expiry_refused" ? direct.reason : direct.type, reason);
    });
  }
});

describe("LD-5b finalizer × store: cancellation, the stage deadline and terminal winners keep their precedence", () => {
  it("cancellation during the HEAD: aborted, no ready, the attempted key deleted", async () => {
    const w = world(R_MAX, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.duringHead = ({ clock }) => {
      clock.now += 381_000;
      w.execution.abort(new Error("cancelled by the person"));
    };
    assert.deepEqual(await finalize(w), { type: "aborted", cleanup: "deleted" });
    assert.equal(durable(w).status, "uploading");
    assert.deepEqual(w.provider.deletes, [w.key]);
  });

  it("the stage deadline during the HEAD: upload_timeout, no ready, the attempted key deleted", async () => {
    const w = world(R_MAX, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.duringHead = ({ clock }) => {
      clock.now = UPLOADING_AT + STAGE_BUDGET;
      w.timers.fire(0);
    };
    assert.deepEqual(await finalize(w), { type: "upload_timeout", cleanup: "deleted" });
    assert.equal(durable(w).status, "uploading");
    assert.deepEqual(w.provider.deletes, [w.key]);
  });

  it("the deadline reached exactly when the HEAD answers (no timer fired): the last check before the commit refuses", async () => {
    const w = world(R_MAX, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.duringHead = ({ clock }) => {
      clock.now = UPLOADING_AT + STAGE_BUDGET;
    };
    assert.deepEqual(await finalize(w), { type: "upload_timeout", cleanup: "deleted" });
    assert.equal(durable(w).status, "uploading");
  });

  it("one millisecond before the stage deadline the commit still happens — capped by the provider lifecycle", async () => {
    const w = world(R_DEFAULT, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.duringHead = ({ clock }) => {
      clock.now = UPLOADING_AT + STAGE_BUDGET - 1;
    };
    assert.equal((await finalize(w)).type, "ready");
    assert.equal(durable(w).finished_at_ms, UPLOADING_AT + STAGE_BUDGET - 1);
    assert.equal(durable(w).expires_at_ms, LM + CAP);
  });

  it("a cancellation that lands before the commit (after the HEAD answered) still wins: aborted, nothing committed", async () => {
    const w = world(R_DEFAULT, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.duringHead = () => {
      // Queued before the HEAD's own answer resolves: it lands first.
      queueMicrotask(() => w.execution.abort(new Error("cancelled")));
    };
    assert.deepEqual(await finalize(w), { type: "aborted", cleanup: "deleted" });
    assert.equal(durable(w).status, "uploading");
  });

  it("a terminal winner before the commit (the person cancelled) keeps the job cancelled, and the key is deleted", async () => {
    const w = world(R_DEFAULT, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.duringHead = ({ clock }) => {
      clock.now += 1_000;
      assert.equal(w.store.cancelJob(w.jobId).type, "cancelled");
    };
    assert.deepEqual(await finalize(w), { type: "job_state_conflict", reason: "cancelled", cleanup: "deleted" });
    assert.equal(durable(w).status, "cancelled");
    assert.equal(durable(w).expires_at_ms, COMPLETED_AT + 1_000 + R_DEFAULT, "the cancelled retention is finished + R, unchanged");
  });

  it("a failed conditional durable write: ready_commit_failed, rolled back, the key deleted", async () => {
    const w = world(R_DEFAULT, UPLOADING_AT);
    // The conditional UPDATE matches nothing (as when another writer moved the row).
    w.db.exec(
      "CREATE TRIGGER ld5b_ignore_ready BEFORE UPDATE OF status ON worker_jobs WHEN NEW.status = 'ready' BEGIN SELECT RAISE(IGNORE); END;",
    );
    w.clock.now = COMPLETED_AT;
    const before = mirrored(w);
    assert.deepEqual(await finalize(w), { type: "storage_failure", code: "ready_commit_failed", cleanup: "deleted" });
    assert.equal(durable(w).status, "uploading");
    assert.equal(mirrored(w), before, "the idempotency mirror rolled back with the transition");
    assert.deepEqual(w.provider.deletes, [w.key]);
  });

  it("the cleanup after a lifecycle refusal runs under its own allowance, not the stage's", async () => {
    const w = world(R_DEFAULT, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.lastModifiedOverride = LM + 3_600_000;
    await finalize(w);
    assert.equal(w.timers.armed.length, 2, "the stage's timer, then the cleanup allowance's");
    assert.equal(w.timers.armed[1]!.ms, UPLOAD_CLEANUP_BUDGET_MS);
    assert.ok(w.timers.armed.every((t) => t.cleared));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The LD-5a provider replay. Real observations, RECORDED against real R2 by
// VIDEOFETCH-LD5A-R2-LONG-UPLOAD-AND-CREDENTIAL-QUALIFICATION-001 (archive
// SHA-256 f1c3adbf…20e3b, evidence/F-live/runs/<case>/judgement.json,
// `lifecycleSemantics`): the HEAD's Last-Modified, the provider's own
// expiry-date from x-amz-expiration, and the ready commit's instant. The PUT
// itself is not replayed; its completion is the recorded Last-Modified.
// ─────────────────────────────────────────────────────────────────────────────

const LD5A_RECORDED = [
  { run: "C1", headLastModified: 1_795_599_531_000, providerExpiryDate: 1_795_603_131_000, readyCommitAt: 1_795_599_531_932, appExpiresAtR2700: 1_795_602_231_932 },
  { run: "D1b", headLastModified: 1_795_604_522_000, providerExpiryDate: 1_795_608_122_000, readyCommitAt: 1_795_604_522_858, appExpiresAtR2700: 1_795_607_222_858 },
  { run: "D1b-x2", headLastModified: 1_795_616_118_000, providerExpiryDate: 1_795_619_718_000, readyCommitAt: 1_795_616_119_642, appExpiresAtR2700: 1_795_618_819_642 },
] as const;

describe("LD-5b: the LD-5a observations replayed through the finalizer and the store", () => {
  for (const rec of LD5A_RECORDED) {
    it(`${rec.run}: the recorded provider expiry is Last-Modified + 3,600 s, as the cap assumes`, () => {
      assert.equal(rec.providerExpiryDate - rec.headLastModified, 3_600_000);
    });

    it(`${rec.run}: default R reproduces the recorded expiry exactly (the cap does not bind)`, async () => {
      const w = world(R_DEFAULT, rec.headLastModified - 1_800_400);
      w.clock.now = rec.headLastModified;
      w.provider.lastModifiedOverride = rec.headLastModified;
      w.provider.duringHead = ({ clock }) => {
        clock.now = rec.readyCommitAt;
      };
      assert.equal((await finalize(w)).type, "ready");
      assert.equal(durable(w).expires_at_ms, rec.appExpiresAtR2700, "identical to what Production's code committed");
      const margin = rec.providerExpiryDate - durable(w).expires_at_ms;
      assert.ok(margin >= 898_000 && margin <= 900_000, `margin ${margin}`);
    });

    it(`${rec.run}: maximum R is capped at exactly 300 s before the provider's own expiry-date`, async () => {
      const w = world(R_MAX, rec.headLastModified - 1_800_400);
      w.clock.now = rec.headLastModified;
      w.provider.lastModifiedOverride = rec.headLastModified;
      w.provider.duringHead = ({ clock }) => {
        clock.now = rec.readyCommitAt;
      };
      assert.equal((await finalize(w)).type, "ready");
      assert.equal(durable(w).expires_at_ms, rec.headLastModified + CAP);
      assert.equal(rec.providerExpiryDate - durable(w).expires_at_ms, 300_000, "exactly the safety margin");
      assert.ok(durable(w).expires_at_ms < rec.readyCommitAt + R_MAX, "shorter than ready + R by the recorded completion-to-ready time");
    });
  }

  it("synthetic, from LD-5a's documented pathological delays: 381 s / 531 s / 936 s after D1b's completion stay inside the provider expiry", async () => {
    const rec = LD5A_RECORDED[1];
    for (const [r, delay] of [
      [R_MAX, 381_000],
      [R_MAX, 531_000],
      [R_DEFAULT, 936_000],
    ] as const) {
      const w = world(r, rec.headLastModified - 1_800_400);
      w.clock.now = rec.headLastModified;
      w.provider.lastModifiedOverride = rec.headLastModified;
      w.provider.duringHead = ({ clock }) => {
        clock.now = rec.headLastModified + delay;
      };
      assert.equal((await finalize(w)).type, "ready");
      assert.equal(durable(w).expires_at_ms, rec.headLastModified + CAP, `R ${r} delay ${delay}`);
      assert.equal(rec.providerExpiryDate - durable(w).expires_at_ms, 300_000);
    }
  });
});

describe("LD-5b finalizer × store: the commit's own instant decides, even when time passes after the stage's last check", () => {
  it("configured binding: a commit 120 s after the HEAD answered gets exactly commit + R", async () => {
    const w = world(R_DEFAULT, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.duringHead = ({ clock }) => {
      clock.now += 1_000;
      w.storeLag.ms = 120_000;
    };
    assert.equal((await finalize(w)).type, "ready");
    const commitAt = COMPLETED_AT + 1_000 + 120_000;
    assert.equal(durable(w).finished_at_ms, commitAt);
    assert.equal(durable(w).expires_at_ms, commitAt + R_DEFAULT, "from the commit, not from the HEAD's answer");
    assert.equal(mirrored(w), commitAt + R_DEFAULT);
  });

  it("window crossing: a window still open at the HEAD's answer but gone at the commit is refused", async () => {
    const early = UPLOADING_AT + 100_000;
    const lm = Math.floor(early / 1000) * 1000;
    const w = world(R_DEFAULT, UPLOADING_AT);
    w.clock.now = early;
    w.provider.duringHead = ({ clock }) => {
      clock.now = lm + 3_299_000; // one second of window left on the stage's clock
      w.storeLag.ms = 2_000; // gone by the commit
    };
    assert.deepEqual(await finalize(w), { type: "storage_failure", code: "verification_failed", cleanup: "deleted" });
    assert.equal(durable(w).status, "uploading");
    assert.equal(w.commits, 1);
  });

  it("lifetime crossing during the lag: the execution lifetime still wins (lifetime_expired)", async () => {
    // A 10-minute execution lifetime, so it ends inside the 60-minute stage.
    const w = world(R_DEFAULT, UPLOADING_AT, 600_000);
    const claimedPlusL = UPLOADING_AT - 3_000 + 600_000; // the claim happened 3 s before uploading
    w.clock.now = claimedPlusL - 10_000;
    w.provider.duringHead = () => {
      w.storeLag.ms = 20_000;
    };
    assert.deepEqual(await finalize(w), { type: "lifetime_expired", cleanup: "deleted" });
  });
});

describe("LD-5b finalizer × store: the last interruption check sits immediately before the commit", () => {
  /** A stage clock that acts on its N-th read after the HEAD answered (the 2nd is the pre-commit check). */
  function afterHead(w: World, onRead: (n: number) => number | void) {
    let answered = false;
    let reads = 0;
    w.provider.duringHead = () => {
      answered = true;
    };
    return () => {
      if (!answered) return w.clock.now;
      reads += 1;
      return onRead(reads) ?? w.clock.now;
    };
  }

  it("the stage deadline reached at the pre-commit check (no timer fired): upload_timeout, no commit", async () => {
    const w = world(R_MAX, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    const deadline = UPLOADING_AT + STAGE_BUDGET;
    const clock = afterHead(w, (n) => (n >= 2 ? deadline : undefined));
    assert.deepEqual(await finalize(w, clock), { type: "upload_timeout", cleanup: "deleted" });
    assert.equal(w.commits, 0, "the commit was never attempted");
    assert.equal(durable(w).status, "uploading");
    assert.equal(durable(w).object_key, null);
  });

  it("a cancellation landing at the pre-commit check: aborted, no commit", async () => {
    const w = world(R_MAX, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    const clock = afterHead(w, (n) => {
      if (n === 2) w.execution.abort(new Error("cancelled at the last moment"));
    });
    assert.deepEqual(await finalize(w, clock), { type: "aborted", cleanup: "deleted" });
    assert.equal(w.commits, 0);
    assert.equal(durable(w).status, "uploading");
  });

  it("precedence: the deadline reached together with an elapsed provider window is an upload_timeout", async () => {
    const early = UPLOADING_AT + 100_000;
    const w = world(R_DEFAULT, UPLOADING_AT);
    w.clock.now = early;
    w.provider.duringHead = ({ clock }) => {
      clock.now = UPLOADING_AT + STAGE_BUDGET; // past the stage deadline and past LM + 55 min at once
    };
    assert.deepEqual(await finalize(w), { type: "upload_timeout", cleanup: "deleted" });
    assert.equal(w.commits, 0);
  });

  it("precedence: a cancellation with an unusable Last-Modified is aborted, not a lifecycle refusal", async () => {
    const w = world(R_DEFAULT, UPLOADING_AT);
    w.clock.now = COMPLETED_AT;
    w.provider.lastModifiedOverride = LM + 3_600_000;
    w.provider.duringHead = () => {
      w.execution.abort(new Error("cancelled"));
    };
    assert.deepEqual(await finalize(w), { type: "aborted", cleanup: "deleted" });
    assert.equal(w.commits, 0);
  });
});

describe("LD-5b finalizer × store: only the provider's completion stamp counts — not the PUT's start, not the Worker's clock", () => {
  for (const putDurationMs of [900_000, 3_359_463]) {
    for (const providerOffsetMs of [-7_000, 0, 17_000]) {
      for (const phase of [437, 999]) {
        for (const r of [R_DEFAULT, R_MAX]) {
          it(`PUT ${putDurationMs} ms, R2 clock ${providerOffsetMs >= 0 ? "+" : ""}${providerOffsetMs} ms, completion phase ${phase} ms, R ${r}`, async () => {
            const start = UPLOADING_AT - 400 + 1_000 + phase - (putDurationMs % 1000); // the PUT completes `phase` ms past a Worker second
            const w = world(r, UPLOADING_AT);
            w.clock.now = start;
            w.provider.putDurationMs = putDurationMs;
            w.provider.providerOffsetMs = providerOffsetMs;
            w.provider.duringHead = ({ clock }) => {
              clock.now += 1_642; // LD-5a D1b-x2's completion-to-ready time
            };
            assert.equal((await finalize(w)).type, "ready");
            const completedWorker = start + putDurationMs;
            const lm = Math.floor((completedWorker + providerOffsetMs) / 1000) * 1000;
            const commitAt = completedWorker + 1_642;
            assert.equal(durable(w).expires_at_ms, Math.min(commitAt + r, lm + CAP), "exactly min(commit + R, provider Last-Modified + 55 min)");
            assert.notEqual(lm, Math.floor(w.provider.putStartedAt! / 1000) * 1000, "the PUT's start differs from the provider stamp");
          });
        }
      }
    }
  }
});
