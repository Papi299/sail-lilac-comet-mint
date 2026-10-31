import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import diagnosticsChannel from "node:diagnostics_channel";
import { mkdtempSync, rmSync, writeFileSync, type ReadStream } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { S3Client } from "@aws-sdk/client-s3";
import { ERROR_MESSAGES } from "../../lib/errors.ts";
import { setTempDirectoryForTests } from "../../services/temp/files.server.ts";
import { VideoMetadataSchema, type WorkerObjectKey, type WorkerVideoMetadata } from "../../shared/worker/contracts.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import type { DurableWorkerJob } from "../state/job-store.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import { CloudflareR2ObjectStoreWriter, buildR2S3ClientConfig } from "../storage/cloudflare-r2-writer.server.ts";
import type { R2CredentialRequestInput } from "../storage/credential-provider.ts";
import { DelegatedR2ObjectStoreWriter } from "../storage/delegated-r2-writer.server.ts";
import { startStubS3Server, type StubS3Server } from "../storage/r2-stub-server.fixtures.ts";
import { UPLOAD_CLEANUP_BUDGET_MS } from "../storage/upload-lifecycle.server.ts";
import type { ObjectStoreHead, ObjectStoreOperationContext, ObjectStorePutInput, ObjectStoreWriter } from "../storage/writer.ts";
import {
  JobExecutor,
  type ExecutionBackstopTimerHandle,
  type ExecutionBackstopTimers,
  type JobExecutorDeps,
} from "./job-executor.server.ts";
import { QueuePump } from "./queue-pump.server.ts";
import { QueueRunner } from "./queue-runner.server.ts";

/**
 * VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001 — the upload stage inside the
 * executor.
 *
 * Part 1 runs in virtual time: the executor's timer hooks (the lifetime
 * backstop at index 0, the upload stage's deadline at index 1, a cleanup
 * allowance at index 2) are fired by hand against the real SQLite store, so
 * every ordering of deadline, cancellation and shutdown is deterministic.
 *
 * Part 2 runs for real: the production delegated writer, the production R2
 * writer, the real AWS SDK and real sockets, against a synthetic S3 endpoint
 * on the loopback interface, with only `UPLOAD_TIMEOUT` narrowed so the
 * deadline arrives in about a second. Part 3 proves, through the real queue
 * pump and runner, that a stalled upload releases the Worker's single
 * execution slot.
 *
 * Fake credentials only; no host process is spawned and nothing leaves the
 * test process.
 */

const MEDIA_URL = "https://cdn.example/clip.mp4";
const BUCKET = "videofetch-objects";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const MIB = 1024 * 1024;

function metadata(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "Upload Clip",
    thumbnail: null,
    duration: null,
    source: "cdn.example",
    extractor: "direct",
    webpageUrl: MEDIA_URL,
    formats: [
      {
        id: "direct-original",
        resolution: "unknown",
        width: null,
        height: null,
        fps: null,
        container: "mp4",
        videoCodec: "unknown",
        audioCodec: "unknown",
        bitrate: null,
        fileSize: 8,
        hasVideo: true,
        hasAudio: true,
        formatNote: null,
      },
    ],
    presets: [],
    capabilities: { mp3: true, merge: true },
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Bounds an await, so a promise that never settles fails the test instead of hanging it. */
async function settled<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`never settled: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Row = {
  status: string;
  error_code: string | null;
  safe_error_message: string | null;
  stage_label: string | null;
  finished_at_ms: number | null;
  expires_at_ms: number;
  object_key: string | null;
};
const rowOf = (db: DatabaseSync, jobId: string) =>
  db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId) as Row;

// ═════════════════════════════════════════════════════════════════════════════
// Part 1 — virtual time
// ═════════════════════════════════════════════════════════════════════════════

type ArmedTimer = ExecutionBackstopTimerHandle & { handler: () => void; ms: number; cleared: boolean; unrefed: boolean };

class VirtualTimers implements ExecutionBackstopTimers {
  readonly armed: ArmedTimer[] = [];
  setTimeoutFn = (handler: () => void, ms: number): ExecutionBackstopTimerHandle => {
    const timer: ArmedTimer = { handler, ms, cleared: false, unrefed: false, unref: () => (timer.unrefed = true) };
    this.armed.push(timer);
    return timer;
  };
  clearTimeoutFn = (handle: ExecutionBackstopTimerHandle) => {
    (handle as ArmedTimer).cleared = true;
  };
  fire(index: number): void {
    const timer = this.armed[index]!;
    if (!timer.cleared) timer.handler();
  }
}

const BACKSTOP = 0;
const UPLOAD_STAGE = 1;
const CLEANUP = 2;

/**
 * A writer that records what each operation was handed. A put reads one chunk
 * of its body, then — when `hold` is set — waits until its own signal aborts,
 * as a request on a stalled connection would.
 */
class StageWriter implements ObjectStoreWriter {
  readonly puts: ObjectStorePutInput[] = [];
  readonly signals: Array<{ op: string; signal: AbortSignal | undefined }> = [];
  readonly deletes: string[] = [];
  readonly objects = new Map<string, ObjectStorePutInput>();
  hold = false;
  putFails = false;
  putEntered = false;
  putSawAbort = false;
  deleteGate: Promise<void> | null = null;

  async put(input: ObjectStorePutInput, context: ObjectStoreOperationContext = {}): Promise<void> {
    this.puts.push(input);
    this.signals.push({ op: "put", signal: context.signal });
    const iterator = input.body[Symbol.asyncIterator]();
    await iterator.next(); // one chunk is in flight
    this.putEntered = true;
    if (this.putFails) throw new Error("provider refused: internal detail");
    if (this.hold) {
      await new Promise<void>((_, reject) => {
        const onAbort = () => {
          this.putSawAbort = true;
          reject(new Error("request torn down"));
        };
        if (context.signal?.aborted) onAbort();
        else context.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) void next.value;
    this.objects.set(input.objectKey, input);
  }

  async head(objectKey: WorkerObjectKey, context: ObjectStoreOperationContext = {}): Promise<ObjectStoreHead | null> {
    this.signals.push({ op: "head", signal: context.signal });
    const put = this.objects.get(objectKey);
    return put
      ? { objectKey, contentLength: put.contentLength, contentType: put.contentType, contentDisposition: put.contentDisposition }
      : null;
  }

  async delete(objectKey: WorkerObjectKey, context: ObjectStoreOperationContext = {}): Promise<void> {
    this.signals.push({ op: "delete", signal: context.signal });
    this.deletes.push(objectKey);
    if (this.deleteGate) await this.deleteGate;
    this.objects.delete(objectKey);
  }
}

type VirtualHarness = {
  tempDir: string;
  db: DatabaseSync;
  clock: { now: number };
  store: SQLiteJobStore;
  writer: StageWriter;
  timers: VirtualTimers;
  failCalls: string[];
  cleanup: () => void;
};

const T0 = 1_800_000_000_000;
const R = 240_000;

function virtualHarness(L: number): VirtualHarness {
  const tempDir = mkdtempSync(join(tmpdir(), "ld2b-upload-"));
  setTempDirectoryForTests(tempDir);
  const db = openWorkerDatabase({ path: ":memory:" });
  applyMigrations(db);
  const clock = { now: T0 };
  const store = new SQLiteJobStore({ db, clock: () => clock.now, executionLifetimeMs: L, retentionMs: R });
  const failCalls: string[] = [];
  const realFail = store.failJob.bind(store);
  store.failJob = (jobId: string, code: string, message: string) => {
    failCalls.push(code);
    return realFail(jobId, code, message);
  };
  return {
    tempDir,
    db,
    clock,
    store,
    writer: new StageWriter(),
    timers: new VirtualTimers(),
    failCalls,
    cleanup: () => {
      db.close();
      setTempDirectoryForTests(null);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function claim(store: SQLiteJobStore, clock?: { now: number }): DurableWorkerJob {
  store.createJob({ url: MEDIA_URL, formatId: "direct-original", principalId: "private-access-user" }, randomUUID());
  if (clock) clock.now += 1_000;
  const job = store.claimNextQueuedJob();
  assert.ok(job);
  return job;
}

function virtualExecutor(h: VirtualHarness, uploadMs: number, controllers = new Map<string, AbortController>()) {
  return new JobExecutor(h.store, h.writer, () => h.clock.now, controllers, {
    availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
    backstopTimers: h.timers,
    timeLimits: { downloadTimeLimitMs: 600_000, processingMs: 600_000, uploadMs },
    analyze: async () => metadata(),
    downloadOriginal: async (_url, ctx) => {
      const filePath = join(ctx.workDir, "source.mp4");
      writeFileSync(filePath, Buffer.alloc(256 * 1024, 7));
      return { filePath, container: "mp4", mime: "video/mp4", fileSize: 256 * 1024 };
    },
  } satisfies JobExecutorDeps);
}

function assertUploadTimeout(h: VirtualHarness, jobId: string, finishedAt: number) {
  const r = rowOf(h.db, jobId);
  assert.equal(r.status, "failed");
  assert.equal(r.error_code, "TIMEOUT");
  assert.equal(r.safe_error_message, ERROR_MESSAGES.TIMEOUT);
  assert.equal(r.stage_label, "Upload failed");
  assert.equal(r.object_key, null, "a failed job never references the attempted object");
  assert.equal(r.finished_at_ms, finishedAt);
  assert.equal(r.expires_at_ms, finishedAt + R, "retained R from the terminal instant");
}

describe("LD-2b executor: UPLOAD_TIMEOUT is ONE absolute deadline, enforced", () => {
  let h: VirtualHarness;
  afterEach(() => h.cleanup());

  it("an upload past its deadline is torn down: TIMEOUT, 'Upload failed', the exact key deleted, the file closed", async () => {
    h = virtualHarness(10_000_000);
    const job = claim(h.store, h.clock);
    h.writer.hold = true;
    const executor = virtualExecutor(h, 60_000);
    const execution = executor.execute(job);
    await waitFor(() => h.writer.putEntered, "the upload to be in flight");
    assert.equal(rowOf(h.db, job.jobId).status, "uploading");

    assert.equal(h.timers.armed.length, 2, "the backstop, then the upload stage's one deadline");
    assert.equal(h.timers.armed[UPLOAD_STAGE]!.ms, 60_000, "UPLOAD_TIMEOUT from the durable uploading transition");
    assert.equal(h.timers.armed[UPLOAD_STAGE]!.unrefed, true);

    h.clock.now += 60_000;
    h.timers.fire(UPLOAD_STAGE);
    await settled(execution, "the timed-out upload");

    assert.equal(h.writer.putSawAbort, true, "the in-flight request observed the deadline");
    assertUploadTimeout(h, job.jobId, h.clock.now);
    assert.deepEqual(h.writer.deletes, [h.writer.puts[0]!.objectKey], "exactly the attempted key");
    const cleanupSignal = h.writer.signals.find((s) => s.op === "delete")!.signal!;
    assert.equal(cleanupSignal.aborted, false, "cleanup ran under its own, live allowance");
    assert.equal(h.timers.armed[CLEANUP]!.ms, UPLOAD_CLEANUP_BUDGET_MS);
    const body = h.writer.puts[0]!.body as unknown as ReadStream;
    assert.equal(body.destroyed, true, "the executor closed the file it opened");
    assert.equal(body.closed, true);
    assert.ok(h.timers.armed.every((t) => t.cleared), "no timer outlives the execution");
    assert.deepEqual(h.failCalls, ["TIMEOUT"], "one terminal outcome");
    assert.equal(executor.activeJobCount, 0, "the execution slot is released");
  });

  it("never outlives the job: an execution deadline earlier than the upload budget caps it", async () => {
    const L = 30_000;
    h = virtualHarness(L);
    const job = claim(h.store, h.clock);
    h.clock.now += 5_000; // analysis, acquisition and processing took 5 s
    h.writer.hold = true;
    const execution = virtualExecutor(h, 3_600_000).execute(job);
    await waitFor(() => h.writer.putEntered, "the upload");
    assert.equal(h.timers.armed[UPLOAD_STAGE]!.ms, job.expiresAt - h.clock.now, "capped at claimed + L");
    h.clock.now = job.expiresAt;
    h.timers.fire(UPLOAD_STAGE);
    await settled(execution, "the capped deadline");
    assertUploadTimeout(h, job.jobId, job.expiresAt);
  });

  it("the deadline and the lifetime backstop at the same instant produce ONE TIMEOUT", async () => {
    h = virtualHarness(60_000);
    const job = claim(h.store, h.clock);
    h.writer.hold = true;
    const execution = virtualExecutor(h, 60_000).execute(job);
    await waitFor(() => h.writer.putEntered, "the upload");
    h.clock.now = job.expiresAt;
    h.timers.fire(BACKSTOP);
    h.timers.fire(UPLOAD_STAGE);
    await settled(execution, "both deadlines");
    assertUploadTimeout(h, job.jobId, job.expiresAt);
    assert.deepEqual(h.failCalls, ["TIMEOUT"]);
  });

  it("a successful upload closes its file and leaves no timer armed", async () => {
    h = virtualHarness(10_000_000);
    const job = claim(h.store, h.clock);
    await virtualExecutor(h, 60_000).execute(job);
    assert.equal(rowOf(h.db, job.jobId).status, "ready");
    const body = h.writer.puts[0]!.body as unknown as ReadStream;
    assert.equal(body.closed, true);
    assert.equal(h.timers.armed.length, 2, "backstop + upload stage; no cleanup");
    assert.ok(h.timers.armed.every((t) => t.cleared));
  });

  it("an ORDINARY upload failure keeps PROCESSING_FAILED, 'Upload failed', and closes the file", async () => {
    h = virtualHarness(10_000_000);
    const job = claim(h.store, h.clock);
    h.writer.putFails = true;
    await virtualExecutor(h, 60_000).execute(job);
    const r = rowOf(h.db, job.jobId);
    assert.equal(r.status, "failed");
    assert.equal(r.error_code, "PROCESSING_FAILED");
    assert.equal(r.stage_label, "Upload failed");
    assert.equal((h.writer.puts[0]!.body as unknown as ReadStream).closed, true);
    assert.deepEqual(h.writer.deletes, [h.writer.puts[0]!.objectKey]);
  });
});

describe("LD-2b executor: cancellation and shutdown reach the upload, and keep their precedence", () => {
  let h: VirtualHarness;
  afterEach(() => h.cleanup());

  it("a cancellation during the upload aborts the request; cancelled is preserved; the key is deleted", async () => {
    h = virtualHarness(10_000_000);
    const job = claim(h.store, h.clock);
    h.writer.hold = true;
    const executor = virtualExecutor(h, 60_000);
    const execution = executor.execute(job);
    await waitFor(() => h.writer.putEntered, "the upload");
    h.clock.now += 1_000;
    assert.equal(executor.cancel(job.jobId).type, "cancelled");
    await settled(execution, "the cancelled upload");
    assert.equal(h.writer.putSawAbort, true);
    const r = rowOf(h.db, job.jobId);
    assert.equal(r.status, "cancelled");
    assert.equal(r.object_key, null);
    assert.deepEqual(h.writer.deletes, [h.writer.puts[0]!.objectKey]);
    assert.deepEqual(h.failCalls, [], "no failure is written over a won cancellation");
    assert.equal((h.writer.puts[0]!.body as unknown as ReadStream).closed, true);
  });

  it("an operator shutdown during the upload aborts it and leaves the row ACTIVE for the next process", async () => {
    h = virtualHarness(10_000_000);
    const job = claim(h.store, h.clock);
    h.writer.hold = true;
    const executor = virtualExecutor(h, 60_000);
    const execution = executor.execute(job);
    await waitFor(() => h.writer.putEntered, "the upload");
    assert.equal(executor.abortActiveForShutdown(), 1);
    await settled(execution, "the shutdown");
    assert.equal(h.writer.putSawAbort, true);
    assert.equal(rowOf(h.db, job.jobId).status, "uploading", "the dying Worker writes no ordinary failure");
    assert.deepEqual(h.failCalls, []);
    assert.deepEqual(h.writer.deletes, [h.writer.puts[0]!.objectKey], "the bounded cleanup still ran");
    assert.equal((h.writer.puts[0]!.body as unknown as ReadStream).closed, true);

    const recoveredAt = h.clock.now + 1_000;
    new SQLiteJobStore({ db: h.db, clock: () => recoveredAt, executionLifetimeMs: 10_000_000, retentionMs: R }).recover();
    const r = rowOf(h.db, job.jobId);
    assert.equal(r.status, "failed");
    assert.equal(r.stage_label, "Worker restarted");
  });

  it("the deadline fires, then a cancellation's CAS lands during the cleanup: cancellation wins", async () => {
    h = virtualHarness(10_000_000);
    const job = claim(h.store, h.clock);
    h.writer.hold = true;
    let releaseDelete: () => void = () => {};
    h.writer.deleteGate = new Promise<void>((resolve) => (releaseDelete = resolve));
    const executor = virtualExecutor(h, 60_000);
    const execution = executor.execute(job);
    await waitFor(() => h.writer.putEntered, "the upload");
    h.clock.now += 60_000;
    h.timers.fire(UPLOAD_STAGE);
    await waitFor(() => h.writer.deletes.length === 1, "the cleanup");
    assert.equal(executor.cancel(job.jobId).type, "cancelled", "the job is still uploading: the cancel's CAS wins");
    releaseDelete();
    await settled(execution, "timeout, then cancel");
    assert.equal(rowOf(h.db, job.jobId).status, "cancelled");
    assert.deepEqual(h.failCalls, []);
  });

  it("the deadline fires, then a shutdown during the cleanup: the row stays ACTIVE", async () => {
    h = virtualHarness(10_000_000);
    const job = claim(h.store, h.clock);
    h.writer.hold = true;
    let releaseDelete: () => void = () => {};
    h.writer.deleteGate = new Promise<void>((resolve) => (releaseDelete = resolve));
    const executor = virtualExecutor(h, 60_000);
    const execution = executor.execute(job);
    await waitFor(() => h.writer.putEntered, "the upload");
    h.clock.now += 60_000;
    h.timers.fire(UPLOAD_STAGE);
    await waitFor(() => h.writer.deletes.length === 1, "the cleanup");
    executor.abortActiveForShutdown();
    releaseDelete();
    await settled(execution, "timeout, then shutdown");
    assert.equal(rowOf(h.db, job.jobId).status, "uploading", "an operator restart is never turned into a TIMEOUT");
    assert.deepEqual(h.failCalls, []);
  });

  it("a ready commit that won first is never undone: a later cancel and a disposed deadline change nothing", async () => {
    h = virtualHarness(10_000_000);
    const job = claim(h.store, h.clock);
    const executor = virtualExecutor(h, 60_000);
    await executor.execute(job);
    const ready = rowOf(h.db, job.jobId);
    assert.equal(ready.status, "ready");
    assert.equal(executor.cancel(job.jobId).type, "unchanged");
    h.clock.now += 120_000;
    for (let i = 0; i < h.timers.armed.length; i += 1) h.timers.armed[i]!.handler(); // even timers slipping past disposal
    assert.deepEqual(rowOf(h.db, job.jobId), ready);
    assert.deepEqual(h.writer.deletes, [], "a ready object is never deleted by a loser");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Part 2 — real sockets
// ═════════════════════════════════════════════════════════════════════════════

const clientSockets: Socket[] = [];
const onClientSocket = (message: unknown) => clientSockets.push((message as { socket: Socket }).socket);
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
before(() => {
  diagnosticsChannel.subscribe("net.client.socket", onClientSocket);
  process.on("unhandledRejection", onUnhandled);
});
after(() => {
  diagnosticsChannel.unsubscribe("net.client.socket", onClientSocket);
  process.off("unhandledRejection", onUnhandled);
});

type RealHarness = {
  tempDir: string;
  db: DatabaseSync;
  store: SQLiteJobStore;
  stub: StubS3Server;
  writer: ObjectStoreWriter;
  bodies: AsyncIterable<Uint8Array>[];
  mints: Array<R2CredentialRequestInput & { withSignal: boolean }>;
  cleanup: () => Promise<void>;
};

/**
 * The production write path end to end — delegated writer, R2 writer, SDK —
 * with a fake credential minter and the S3 client pointed at the stub.
 */
async function realHarness(stalledKeys: (key: string) => boolean): Promise<RealHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), "ld2b-real-"));
  setTempDirectoryForTests(tempDir);
  const db = openWorkerDatabase({ path: ":memory:" });
  applyMigrations(db);
  const store = new SQLiteJobStore({ db });
  const stub = await startStubS3Server({
    bucket: BUCKET,
    mode: (exchange) =>
      exchange.method === "PUT" && stalledKeys(exchange.key) ? { kind: "stall-body", afterBytes: 1 * MIB } : { kind: "normal" },
  });
  const mints: RealHarness["mints"] = [];
  const delegated = new DelegatedR2ObjectStoreWriter({
    location: { accountId: ACCOUNT_ID, bucket: BUCKET, jurisdiction: "default" },
    credentials: {
      async mint(request, options) {
        mints.push({ ...request, withSignal: options?.signal !== undefined });
        return {
          accessKeyId: "fake-delegated-key-id",
          secretAccessKey: "fake-delegated-secret",
          sessionToken: `fake-session-token-${request.action}`,
          expiresAt: Date.now() + request.ttlSeconds * 1000,
        };
      },
    },
    jobDeadlineAt: (jobId) => store.getJob(jobId)?.expiresAt ?? null,
    createWriter: (config) =>
      new CloudflareR2ObjectStoreWriter(
        config,
        new S3Client({
          ...buildR2S3ClientConfig({
            endpoint: stub.endpoint,
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
            },
          }),
          forcePathStyle: true,
        }),
      ),
  });
  const bodies: AsyncIterable<Uint8Array>[] = [];
  const writer: ObjectStoreWriter = {
    put: (input, context) => {
      bodies.push(input.body);
      return delegated.put(input, context);
    },
    head: (key, context) => delegated.head(key, context),
    delete: (key, context) => delegated.delete(key, context),
  };
  return {
    tempDir,
    db,
    store,
    stub,
    writer,
    bodies,
    mints,
    cleanup: async () => {
      await stub.close();
      db.close();
      setTempDirectoryForTests(null);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function realExecutor(h: RealHarness, uploadMs: number) {
  // Real platform timers: no virtual hooks.
  return new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
    availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
    timeLimits: { downloadTimeLimitMs: 600_000, processingMs: 600_000, uploadMs },
    analyze: async () => metadata(),
    downloadOriginal: async (_url, ctx) => {
      const filePath = join(ctx.workDir, "source.mp4");
      writeFileSync(filePath, Buffer.alloc(8 * MIB, 7));
      return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 * MIB };
    },
  });
}

async function clientSocketsClosed(label: string) {
  assert.ok(clientSockets.length > 0, `${label}: a client socket was captured`);
  await waitFor(() => clientSockets.every((socket) => socket.destroyed && socket.closed), `${label}: every client socket closed`);
}

describe("LD-2b executor over real sockets: the request itself ends", () => {
  let h: RealHarness;
  beforeEach(() => {
    clientSockets.length = 0;
  });
  afterEach(async () => {
    await h.cleanup();
    const seen = unhandled;
    unhandled = [];
    assert.deepEqual(seen, [], "no unhandled rejection");
  });

  it("UPLOAD_TIMEOUT: a stalled PUT is torn down at the deadline, its key deleted, the job TIMEOUT", async () => {
    h = await realHarness(() => true);
    const job = claim(h.store);
    const executor = realExecutor(h, 1_500);
    const start = performance.now();
    await settled(executor.execute(job), "a stalled upload");
    const elapsed = performance.now() - start;

    assert.ok(elapsed >= 1_400 && elapsed < 6_000, `ended at the upload deadline, not a transport bound (${Math.round(elapsed)} ms)`);
    const r = rowOf(h.db, job.jobId);
    assert.equal(r.status, "failed");
    assert.equal(r.error_code, "TIMEOUT");
    assert.equal(r.stage_label, "Upload failed");
    assert.equal(r.object_key, null);

    const methods = h.stub.exchanges.map((e) => e.method);
    assert.deepEqual(methods, ["PUT", "DELETE"], "no HEAD, and no second PUT");
    assert.equal(h.stub.exchanges[1]!.key, h.stub.exchanges[0]!.key, "the delete named exactly the attempted key");
    assert.ok(h.stub.exchanges[0]!.bytesReceived < 8 * MIB, "the stall really held the body back");
    assert.deepEqual(
      h.mints.map((m) => [m.action, m.withSignal]),
      [
        ["PutObject", true],
        ["DeleteObject", true],
      ],
    );
    await clientSocketsClosed("the timed-out upload");
    const body = h.bodies[0] as unknown as ReadStream;
    assert.equal(body.closed, true, "the file stream is closed");
    assert.equal(executor.activeJobCount, 0);
  });

  it("a cancellation ends the in-flight PUT at once, not at any timeout", async () => {
    h = await realHarness(() => true);
    const job = claim(h.store);
    const executor = realExecutor(h, 3_600_000);
    const execution = executor.execute(job);
    await waitFor(() => (h.stub.exchanges[0]?.bytesReceived ?? 0) >= 512 * 1024, "the body to be flowing");
    const start = performance.now();
    assert.equal(executor.cancel(job.jobId).type, "cancelled");
    await settled(execution, "the cancelled upload");
    assert.ok(performance.now() - start < 3_000, "ended by the cancellation");
    assert.equal(rowOf(h.db, job.jobId).status, "cancelled");
    assert.deepEqual(h.stub.exchanges.map((e) => e.method), ["PUT", "DELETE"]);
    assert.equal(h.stub.exchanges[1]!.key, h.stub.exchanges[0]!.key);
    await clientSocketsClosed("the cancelled upload");
    assert.equal((h.bodies[0] as unknown as ReadStream).closed, true);
  });

  it("an operator shutdown ends the in-flight PUT, cleans up within its bound, and leaves the row ACTIVE", async () => {
    h = await realHarness(() => true);
    const job = claim(h.store);
    const executor = realExecutor(h, 3_600_000);
    const execution = executor.execute(job);
    await waitFor(() => (h.stub.exchanges[0]?.bytesReceived ?? 0) >= 512 * 1024, "the body to be flowing");
    const start = performance.now();
    assert.equal(executor.abortActiveForShutdown(), 1);
    await settled(execution, "the shutdown");
    assert.ok(performance.now() - start < UPLOAD_CLEANUP_BUDGET_MS, "inside the cleanup allowance, and so the 10 s grace");
    assert.equal(rowOf(h.db, job.jobId).status, "uploading");
    assert.deepEqual(h.stub.exchanges.map((e) => e.method), ["PUT", "DELETE"]);
    await clientSocketsClosed("the shutdown");
    assert.equal((h.bodies[0] as unknown as ReadStream).closed, true);
    assert.equal(executor.activeJobCount, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Part 3 — the Worker's single execution slot
// ═════════════════════════════════════════════════════════════════════════════

describe("LD-2b: a stalled upload releases the single execution slot to the next queued job", () => {
  let h: RealHarness;
  afterEach(async () => {
    await h.cleanup();
  });

  it("job A's upload stalls and times out; job B, queued behind it, then runs to ready", async () => {
    let stalledJob = "";
    h = await realHarness((key) => key.includes(stalledJob));
    h.store.createJob({ url: MEDIA_URL, formatId: "direct-original", principalId: "private-access-user" }, randomUUID());
    h.store.createJob({ url: MEDIA_URL, formatId: "direct-original", principalId: "private-access-user" }, randomUUID());
    const [a, b] = h.store.listQueuedJobs(10);
    assert.ok(a && b);
    stalledJob = a.jobId;

    const executor = realExecutor(h, 1_000);
    const pump = new QueuePump(new QueueRunner(h.store, executor));
    pump.wake();
    await waitFor(() => h.store.getJob(b.jobId)?.status === "ready", "job B to complete", 20_000);
    await settled(pump.whenDrained(), "the pump to drain");

    const rowA = rowOf(h.db, a.jobId);
    assert.equal(rowA.status, "failed");
    assert.equal(rowA.error_code, "TIMEOUT");
    assert.equal(rowA.stage_label, "Upload failed");
    const rowB = rowOf(h.db, b.jobId);
    assert.equal(rowB.status, "ready");
    assert.ok(rowB.object_key && h.stub.objects.get(rowB.object_key)?.size === 8 * MIB, "B's object is complete");
    const startedB = (h.db.prepare("SELECT started_at_ms FROM worker_jobs WHERE job_id = ?").get(b.jobId) as {
      started_at_ms: number;
    }).started_at_ms;
    assert.ok(rowA.finished_at_ms! <= startedB, "B was claimed only after A released the slot");

    const aExchanges = h.stub.exchanges.filter((e) => e.key.includes(a.jobId)).map((e) => e.method);
    assert.deepEqual(aExchanges, ["PUT", "DELETE"], "A: one put, then exactly its own key deleted");
    const settledCount = h.stub.exchanges.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(h.stub.exchanges.length, settledCount, "no stale request afterwards");
    assert.deepEqual(rowOf(h.db, a.jobId), rowA, "and no stale write to A");
    assert.equal(executor.activeJobCount, 0);
  });
});
