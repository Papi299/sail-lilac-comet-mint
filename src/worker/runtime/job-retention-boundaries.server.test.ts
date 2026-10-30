import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../../lib/errors.ts";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";
import { toPublicJob } from "../../web/jobs/public-job.ts";
import { CloudflareR2Signer } from "../../web/storage/cloudflare-r2-signer.server.ts";
import { WorkerService } from "../http/business-service.server.ts";
import { WorkerBusinessError } from "../http/errors.server.ts";
import { JobExecutor } from "../execution/job-executor.server.ts";
import { QueuePump } from "../execution/queue-pump.server.ts";
import { QueueRunner } from "../execution/queue-runner.server.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type { R2CredentialRequestInput } from "../storage/credential-provider.ts";
import { DelegatedR2Error, DelegatedR2ObjectStoreWriter } from "../storage/delegated-r2-writer.server.ts";
import type { ObjectStoreHead, ObjectStorePutInput, ObjectStoreWriter } from "../storage/writer.ts";
import { WorkerMaintenance } from "./maintenance.server.ts";

/**
 * VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001 — the retention after `ready`
 * meets the existing boundaries that read `expiresAt`, none of which changed:
 *
 *  - maintenance collects ONLY expired ready objects, by exact key, metadata
 *    after the object, idempotency tombstone kept;
 *  - delegated R2 credentials stay `min(ceiling, remaining lifetime)`, so a
 *    longer job lifetime never lengthens one;
 *  - the control plane signs a ready link only while `now < expiresAt`, never
 *    past it, and its DTO offers the link only then.
 *
 * Real store, real maintenance, real delegated writer and the control plane's
 * real signer and projection; the object store and the broker are fakes.
 */

const T0 = 1_800_000_000_000;
const L = 5_445_000; // the staged default
const R = 2_700_000; // 45 minutes
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

class RecordingObjectStore implements ObjectStoreWriter {
  readonly deletes: string[] = [];
  readonly operations: string[] = [];
  failDeletes = false;
  async put(input: ObjectStorePutInput): Promise<void> {
    this.operations.push("put");
    for await (const chunk of input.body) void chunk;
  }
  async head(): Promise<ObjectStoreHead | null> {
    this.operations.push("head");
    return null;
  }
  async delete(objectKey: WorkerObjectKey): Promise<void> {
    this.operations.push("delete");
    if (this.failDeletes) throw new Error("provider unavailable (raw detail that must not travel)");
    this.deletes.push(objectKey);
  }
}

type Harness = {
  db: DatabaseSync;
  clock: { now: number };
  store: SQLiteJobStore;
  objects: RecordingObjectStore;
  maintenance: WorkerMaintenance;
  service: WorkerService;
};

function makeHarness(retentionMs = R): Harness {
  const db = openWorkerDatabase({ path: ":memory:" });
  applyMigrations(db);
  const clock = { now: T0 };
  const store = new SQLiteJobStore({ db, clock: () => clock.now, executionLifetimeMs: L, retentionMs });
  const objects = new RecordingObjectStore();
  const maintenance = new WorkerMaintenance({ store, replayStore: { cleanup() {} }, writer: objects });
  const executor = new JobExecutor(store, objects, () => clock.now);
  const service = new WorkerService({
    store,
    executor,
    pump: new QueuePump(new QueueRunner(store, executor)),
    analyze: async () => {
      throw new AppError("EXTRACTOR_UNAVAILABLE");
    },
    probeBinaries: async () => ({ ffmpeg: true, ytdlp: false, ytdlpVersion: null }),
    clock: () => clock.now,
  });
  return { db, clock, store, objects, maintenance, service };
}

const objectKeyFor = (jobId: string) => `videofetch/jobs/${jobId}/${"c".repeat(32)}`;

function create(h: Harness, key = randomUUID()): string {
  const res = h.store.createJob(
    { url: "https://cdn.example/clip.mp4", formatId: "direct-original", principalId: "private-access-user" },
    key,
  );
  assert.equal(res.type, "created");
  return res.type === "created" ? res.job.jobId : "";
}

/** Claims and drives one job to `uploading`; returns its execution deadline. */
function toUploading(h: Harness, jobId: string): number {
  h.clock.now += 1_000;
  const claimed = h.store.claimNextQueuedJob();
  assert.equal(claimed?.jobId, jobId);
  h.store.completeAnalysis(jobId, { title: "Clip", thumbnail: null, source: "cdn.example", extractor: "direct" });
  h.store.beginProcessing(jobId);
  h.store.beginUploading(jobId);
  return claimed!.expiresAt;
}

function makeReady(h: Harness, jobId: string, readyAt: number) {
  h.clock.now = readyAt;
  const res = h.store.commitReadyFromUploading(jobId, {
    objectKey: objectKeyFor(jobId),
    filename: "clip.mp4",
    fileSize: 8,
    mime: "video/mp4",
    quality: null,
    container: "mp4",
  });
  assert.equal(res.type, "ready");
}

const isExpired = (err: unknown) =>
  err instanceof WorkerBusinessError && err.code === "EXPIRED" && err.httpStatus === 410;

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a retention × maintenance", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  it("keeps a ready object for the full R after ready — however long the pipeline took — then deletes exactly it", async () => {
    const key = randomUUID();
    const jobId = create(h, key);
    toUploading(h, jobId);
    const readyAt = T0 + 80 * 60_000; // 80 minutes after creation: past the retired 45-minute TTL
    makeReady(h, jobId, readyAt);

    h.clock.now = readyAt + R - 1;
    let report = await h.maintenance.runOnce();
    assert.equal(report.expiredObjects.scanned, 0);
    assert.deepEqual(h.objects.deletes, []);
    assert.equal((await h.service.getJob(jobId)).job.status, "ready");

    h.clock.now = readyAt + R;
    report = await h.maintenance.runOnce();
    assert.equal(report.expiredObjects.objectsDeleted, 1);
    assert.equal(report.expiredObjects.metadataDeleted, 1);
    assert.deepEqual(h.objects.deletes, [objectKeyFor(jobId)], "the exact key, nothing else");
    assert.deepEqual(h.objects.operations, ["delete"], "no list, head or put");
    assert.equal(h.store.getJob(jobId), null, "metadata removed after the object");
    const tombstone = h.db.prepare("SELECT * FROM worker_idempotency_records WHERE job_id = ?").get(jobId);
    assert.ok(tombstone, "the idempotency tombstone stays");
    assert.equal(h.store.createJob(
      { url: "https://cdn.example/clip.mp4", formatId: "direct-original", principalId: "private-access-user" },
      key,
    ).type, "expired", "and the key mints no second job");
  });

  it("never touches an ACTIVE job, however long it has run", async () => {
    const jobId = create(h);
    toUploading(h, jobId);
    for (const at of [T0 + 46 * 60_000, T0 + 4 * 60 * 60_000]) {
      h.clock.now = at;
      assert.deepEqual(h.store.listExpiredReadyObjects(50), []);
      await h.maintenance.runOnce();
    }
    assert.deepEqual(h.objects.deletes, []);
    assert.equal(h.store.getJob(jobId)?.status, "uploading");
  });

  it("keeps failed and cancelled rows (the existing policy); their view still ends at finished + R", async () => {
    const failed = create(h);
    const cancelled = create(h);
    h.clock.now = T0 + 10_000;
    h.store.failJob(failed, "NETWORK_ERROR", "x");
    h.store.cancelJob(cancelled);
    h.clock.now = T0 + 10_000 + R + 60 * 60_000;
    await h.maintenance.runOnce();
    assert.deepEqual(h.objects.deletes, []);
    assert.equal(h.store.getJob(failed)?.status, "failed");
    assert.equal(h.store.getJob(cancelled)?.status, "cancelled");
    await assert.rejects(() => h.service.getJob(failed), isExpired);
    await assert.rejects(() => h.service.getJob(cancelled), isExpired);
  });

  it("a failed object delete keeps the metadata for retry and never extends authorisation", async () => {
    const jobId = create(h);
    toUploading(h, jobId);
    makeReady(h, jobId, T0 + 10 * 60_000);
    h.objects.failDeletes = true;
    h.clock.now = T0 + 10 * 60_000 + R;
    const report = await h.maintenance.runOnce();
    assert.equal(report.expiredObjects.objectDeleteFailures, 1);
    assert.equal(report.expiredObjects.metadataDeleted, 0);
    const view = h.store.getJob(jobId)!;
    assert.equal(view.status, "ready", "kept for the next pass");
    await assert.rejects(() => h.service.getJob(jobId), isExpired);
    assert.equal(toPublicJob(view, h.clock.now).downloadUrl, null, "the control plane offers no link");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a retention × delegated R2 credentials", () => {
  let h: Harness;
  let minted: R2CredentialRequestInput[];
  let writer: DelegatedR2ObjectStoreWriter;

  beforeEach(() => {
    h = makeHarness();
    minted = [];
    writer = new DelegatedR2ObjectStoreWriter({
      location: { accountId: ACCOUNT_ID, bucket: "videofetch-temp", jurisdiction: "default" },
      credentials: {
        async mint(request) {
          minted.push(request);
          return {
            accessKeyId: "fake-delegated-key-id",
            secretAccessKey: "fake-delegated-secret",
            sessionToken: "fake-session-token",
            expiresAt: h.clock.now + request.ttlSeconds * 1000,
          };
        },
      },
      // The production deadline source (`runtime.server.ts`).
      jobDeadlineAt: (jobId) => h.store.getJob(jobId)?.expiresAt ?? null,
      clock: () => h.clock.now,
      createWriter: () => new RecordingObjectStore(),
    });
  });
  afterEach(() => h.db.close());

  const put = (jobId: string) =>
    writer.put({
      objectKey: objectKeyFor(jobId),
      body: (async function* () {
        yield new Uint8Array([1]);
      })(),
      contentLength: 1,
      contentType: "video/mp4",
      contentDisposition: 'attachment; filename="clip.mp4"',
    });

  it("PutObject: the 900 s ceiling early in a 90-minute lifetime — the longer lifetime never lengthens a credential", async () => {
    const jobId = create(h);
    toUploading(h, jobId);
    await put(jobId);
    assert.deepEqual(minted.map((m) => [m.action, m.ttlSeconds]), [["PutObject", 900]]);
  });

  it("PutObject and HeadObject: bounded by the remaining lifetime near the deadline, refused past it", async () => {
    const jobId = create(h);
    const deadline = toUploading(h, jobId);
    h.clock.now = deadline - 120_000;
    await put(jobId);
    await writer.head(objectKeyFor(jobId));
    h.clock.now = deadline - 45_000;
    await writer.head(objectKeyFor(jobId));
    assert.deepEqual(
      minted.map((m) => [m.action, m.ttlSeconds]),
      [
        ["PutObject", 120],
        ["HeadObject", 120],
        ["HeadObject", 45],
      ],
    );
    h.clock.now = deadline;
    const before = minted.length;
    await assert.rejects(put(jobId), (err: unknown) => err instanceof DelegatedR2Error && err.failure === "job_expired");
    await assert.rejects(
      writer.head(objectKeyFor(jobId)),
      (err: unknown) => err instanceof DelegatedR2Error && err.failure === "job_expired",
    );
    assert.equal(minted.length, before, "the broker is never asked past the lifetime");
  });

  it("DeleteObject keeps its floor after retention, so cleanup still works, and stays short", async () => {
    const jobId = create(h);
    toUploading(h, jobId);
    makeReady(h, jobId, T0 + 20 * 60_000);
    h.clock.now = T0 + 20 * 60_000 + R + 10 * 60_000;
    await writer.delete(objectKeyFor(jobId));
    assert.deepEqual(minted.map((m) => [m.action, m.ttlSeconds]), [["DeleteObject", 60]]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2a retention × control-plane signing", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  /** A signer whose presigner records the TTL it was asked for and stops there. */
  function signerAt(now: () => number, asked: number[]) {
    return new CloudflareR2Signer(
      {
        accountId: "00000000000000000000000000000000",
        bucket: "test-bucket",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        clock: now,
      },
      async (_client, _command, options) => {
        asked.push(options?.expiresIn ?? -1);
        throw new Error("recorded; no URL is needed");
      },
    );
  }

  it("signs a ready link only before ready + R, for no longer than what remains, and offers it only then", async () => {
    const jobId = create(h);
    toUploading(h, jobId);
    const readyAt = T0 + 70 * 60_000;
    makeReady(h, jobId, readyAt);
    const view = h.store.getJob(jobId)!;
    assert.equal(view.expiresAt, readyAt + R);
    const asked: number[] = [];
    const signer = signerAt(() => h.clock.now, asked);
    const sign = () => signer.signGet({ objectKey: view.objectKey as WorkerObjectKey, expiresAt: view.expiresAt });

    h.clock.now = readyAt + 10_000;
    await assert.rejects(sign(), (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED");
    h.clock.now = readyAt + R - 100_000;
    await assert.rejects(sign());
    assert.deepEqual(asked, [300, 100], "min(300 s, remaining) — never past the retention");
    assert.notEqual(toPublicJob(view, h.clock.now).downloadUrl, null);

    for (const at of [readyAt + R - 500, readyAt + R, readyAt + R + 60_000]) {
      h.clock.now = at;
      await assert.rejects(sign(), (err: unknown) => err instanceof AppError && err.code === "EXPIRED");
    }
    assert.deepEqual(asked, [300, 100], "nothing is presigned at or past the retention");
    h.clock.now = readyAt + R;
    assert.equal(toPublicJob(view, h.clock.now).downloadUrl, null);
  });

  it("at the 55-minute maximum a ready link ends five minutes inside the 3,600 s R2 backstop", () => {
    const wide = makeHarness(3_300_000);
    try {
      const jobId = create(wide);
      toUploading(wide, jobId);
      makeReady(wide, jobId, T0 + 30 * 60_000);
      const row = wide.db
        .prepare("SELECT finished_at_ms, expires_at_ms FROM worker_jobs WHERE job_id = ?")
        .get(jobId) as { finished_at_ms: number; expires_at_ms: number };
      assert.equal(Number(row.expires_at_ms) - Number(row.finished_at_ms), 3_300_000);
      // The object was written no later than the ready commit, so it lives at
      // least until ready + 3,600 s: five minutes after the link ends.
      assert.ok(3_300_000 + 300_000 <= 3_600_000);
      assert.throws(() => new SQLiteJobStore({ db: wide.db, retentionMs: 3_300_001 }));
    } finally {
      wide.db.close();
    }
  });
});
