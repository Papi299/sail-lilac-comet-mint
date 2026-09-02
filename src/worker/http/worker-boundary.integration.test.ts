import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../../lib/errors.ts";
import type {
  WorkerObjectKey,
  WorkerVideoMetadata,
} from "../../shared/worker/contracts.ts";
import { JobExecutor } from "../execution/job-executor.server.ts";
import { QueuePump } from "../execution/queue-pump.server.ts";
import { QueueRunner } from "../execution/queue-runner.server.ts";
import { SQLiteWorkerReplayStore } from "../security/sqlite-replay-store.server.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type {
  ObjectStoreHead,
  ObjectStorePutInput,
  ObjectStoreWriter,
} from "../storage/writer.ts";
import { WorkerClient } from "../../web/worker/worker-client.server.ts";
import { WorkerService } from "./business-service.server.ts";
import { createWorkerServer } from "./server.server.ts";

/**
 * Real local loopback boundary test.
 *
 * Real Worker HTTP server, real HMAC WorkerClient, real request authentication
 * and durable replay reservation, real SQLite in a temporary database, real
 * Phase-6 QueueRunner/JobExecutor wiring, and the real upload lifecycle.
 *
 * No internet, no R2, no yt-dlp: the object store is an in-memory writer and
 * the direct network/media operations are dependency-injected fakes.
 */

const KEY_ID = "phase7-control";
const SECRET = "0123456789abcdef0123456789abcdef0123";
const MEDIA_URL = "https://cdn.example/clip.mp4";

function metadata(): WorkerVideoMetadata {
  return {
    title: "Loopback Clip",
    thumbnail: null,
    duration: 12,
    source: "cdn.example",
    extractor: "direct",
    webpageUrl: MEDIA_URL,
    formats: [
      {
        id: "direct-original",
        resolution: "1280x720",
        width: 1280,
        height: 720,
        fps: null,
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        bitrate: null,
        fileSize: null,
        hasVideo: true,
        hasAudio: true,
      },
    ],
    presets: [],
    capabilities: { mp3: false, merge: false },
  };
}

/** In-memory object store. Records exactly what was written, never uploads. */
class MemoryWriter implements ObjectStoreWriter {
  public readonly objects = new Map<string, ObjectStoreHead>();
  public readonly deleted: string[] = [];

  async put(input: ObjectStorePutInput): Promise<void> {
    let received = 0;
    for await (const chunk of input.body) received += chunk.length;
    assert.equal(received, input.contentLength, "uploaded byte count must match");
    this.objects.set(input.objectKey, {
      objectKey: input.objectKey,
      contentLength: input.contentLength,
      contentType: input.contentType,
      contentDisposition: input.contentDisposition,
    });
  }

  async head(objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    return this.objects.get(objectKey) ?? null;
  }

  async delete(objectKey: WorkerObjectKey): Promise<void> {
    this.deleted.push(objectKey);
    this.objects.delete(objectKey);
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("Worker boundary integration (loopback)", () => {
  let tempDir: string;
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let executor: JobExecutor;
  let pump: QueuePump;
  let writer: MemoryWriter;
  let server: Server;
  let client: WorkerClient;
  let baseUrl: string;

  let analyzeCalls: string[];
  let downloadCalls: string[];
  let processCalls: number;
  let holdDownload: (() => void) | null;
  let downloadEntered: (() => void) | null;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videofetch-phase7-loopback-"));
    db = openWorkerDatabase({ path: path.join(tempDir, "state.sqlite") });
    applyMigrations(db);

    store = new SQLiteJobStore({ db });
    writer = new MemoryWriter();

    executor = new JobExecutor(store, writer, () => Date.now(), new Map(), {
      analyze: async (url: string) => {
        analyzeCalls.push(url);
        return metadata();
      },
      downloadOriginal: async (url, ctx) => {
        downloadCalls.push(url);
        downloadEntered?.();
        if (holdDownload) {
          await new Promise<void>((resolve) => {
            const release = holdDownload!;
            holdDownload = () => {
              release();
              resolve();
            };
            // Abort must win over the hold so cancellation is observable.
            ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          if (ctx.signal?.aborted) throw new AppError("PROCESSING_FAILED", "aborted");
        }
        const filePath = path.join(ctx.workDir, "original.mp4");
        await fsp.writeFile(filePath, "LOOPBACK-MEDIA-BYTES");
        ctx.onProgress?.({ progress: 100, downloadedBytes: 20, totalBytes: 20 });
        return {
          filePath,
          container: "mp4",
          mime: "video/mp4",
          fileSize: 20,
        };
      },
      processLocally: async () => {
        processCalls += 1;
        throw new Error("keep-original must never invoke local processing");
      },
    });

    pump = new QueuePump(new QueueRunner(store, executor));

    const service = new WorkerService({
      store,
      executor,
      pump,
      analyze: async (url: string) => {
        analyzeCalls.push(url);
        return metadata();
      },
      probeBinaries: async () => ({ ffmpeg: true, ytdlp: false, ytdlpVersion: null }),
    });

    server = createWorkerServer(
      {
        currentKeyId: KEY_ID,
        currentSecret: SECRET,
        replayStore: new SQLiteWorkerReplayStore(db),
      },
      service,
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    client = new WorkerClient({
      baseUrl,
      currentKeyId: KEY_ID,
      currentSecret: SECRET,
    });
  });

  after(async () => {
    await pump.whenDrained();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      db.close();
    } catch (e) {
      void e;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    analyzeCalls = [];
    downloadCalls = [];
    processCalls = 0;
    holdDownload = null;
    downloadEntered = null;
  });

  // A ── analyze over the authenticated boundary ────────────────────────────
  it("A: WorkerClient.analyze reaches the authenticated worker and succeeds", async () => {
    const res = await client.analyze({ url: MEDIA_URL });
    assert.equal(res.success, true);
    assert.equal(res.video.title, "Loopback Clip");
    assert.equal(res.video.extractor, "direct");
    assert.deepEqual(analyzeCalls, [MEDIA_URL]);
  });

  // B + C ── create returns immediately with a queued job ───────────────────
  it("B+C: POST /v1/jobs returns a queued job without waiting for execution", async () => {
    const created = await client.createJob({
      url: MEDIA_URL,
      formatId: "direct-original",
      principalId: "private-access-user",
    });

    assert.equal(created.success, true);
    // The HTTP response was produced before the media job could finish.
    assert.ok(
      ["queued", "analyzing", "downloading"].includes(created.job.status),
      `create must not block on execution, saw ${created.job.status}`,
    );
    assert.equal(created.job.objectKey, null);
    assert.equal(created.job.filename, null);

    // D + E ── the pump claims and executes; the durable state converges.
    await waitFor(() => {
      const view = store.getJob(created.job.jobId);
      return view?.status === "ready";
    }, "job to reach ready");

    const observed = await client.getJob(created.job.jobId);
    assert.equal(observed.job.status, "ready");
    assert.equal(observed.job.filename, "Loopback-Clip-original.mp4");
    assert.equal(observed.job.fileSize, 20);
    assert.equal(processCalls, 0, "keep-original must not call FFmpeg");

    // J ── the Phase-6 upload lifecycle is reused verbatim.
    assert.ok(observed.job.objectKey, "ready job must carry an object key");
    const head = writer.objects.get(observed.job.objectKey!);
    assert.ok(head, "finalizeJobUpload must have written the object");
    assert.equal(head!.contentLength, 20);
    assert.equal(head!.contentType, "video/mp4");
    assert.match(head!.contentDisposition, /^attachment; filename=/);
    assert.deepEqual(writer.deleted, [], "a clean success deletes nothing");
    assert.equal(
      observed.job.objectKey!.startsWith(`videofetch/jobs/${created.job.jobId}/`),
      true,
    );
  });

  // F ── idempotency at the worker service level ────────────────────────────
  it("F: the same idempotency key and payload returns the same job", async () => {
    const fixedKey = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const fixedClient = new WorkerClient({
      baseUrl,
      currentKeyId: KEY_ID,
      currentSecret: SECRET,
      idempotencyKeyFactory: () => fixedKey,
    });

    const payload = {
      url: "https://cdn.example/idem.mp4",
      formatId: "direct-original",
      principalId: "private-access-user" as const,
    };

    const first = await fixedClient.createJob(payload);
    const second = await fixedClient.createJob(payload);
    assert.equal(second.job.jobId, first.job.jobId, "same key + payload is the same job");

    await waitFor(() => store.getJob(first.job.jobId)?.status === "ready", "idem job ready");
  });

  it("F: the same idempotency key with a different payload is refused", async () => {
    const fixedKey = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";
    const fixedClient = new WorkerClient({
      baseUrl,
      currentKeyId: KEY_ID,
      currentSecret: SECRET,
      idempotencyKeyFactory: () => fixedKey,
    });

    const first = await fixedClient.createJob({
      url: "https://cdn.example/one.mp4",
      formatId: "direct-original",
      principalId: "private-access-user",
    });

    await assert.rejects(
      () =>
        fixedClient.createJob({
          url: "https://cdn.example/two.mp4",
          formatId: "direct-original",
          principalId: "private-access-user",
        }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );

    await waitFor(() => store.getJob(first.job.jobId)?.status === "ready", "conflict job ready");
  });

  // G ── HTTP cancel aborts active execution ────────────────────────────────
  it("G: HTTP cancel reaches JobExecutor.cancel and aborts the active download", async () => {
    let entered = false;
    downloadEntered = () => {
      entered = true;
    };
    holdDownload = () => {};

    const created = await client.createJob({
      url: "https://cdn.example/cancel-me.mp4",
      formatId: "direct-original",
      principalId: "private-access-user",
    });

    await waitFor(() => entered, "download to start");
    assert.equal(executor.activeJobCount, 1, "an execution must be registered");

    const cancelled = await client.cancelJob(created.job.jobId);
    assert.equal(cancelled.job.status, "cancelled");

    await waitFor(() => executor.activeJobCount === 0, "execution to unwind");
    const final = store.getJob(created.job.jobId);
    assert.equal(final?.status, "cancelled", "first committed terminal state wins");
    assert.equal(final?.objectKey, null, "a cancelled job never carries an object key");
  });

  // Status contract ─────────────────────────────────────────────────────────
  it("returns 404 NOT_FOUND for an unknown job", async () => {
    await assert.rejects(
      () => client.getJob("0123456789abcdef0123456789abcdef"),
      (err: unknown) => err instanceof AppError && err.code === "NOT_FOUND",
    );
  });

  it("cancelling an unknown job is NOT_FOUND", async () => {
    await assert.rejects(
      () => client.cancelJob("fedcba9876543210fedcba9876543210"),
      (err: unknown) => err instanceof AppError && err.code === "NOT_FOUND",
    );
  });

  it("exposes live diagnostics with maxConcurrent 1", async () => {
    const diag = await client.diagnostics();
    assert.equal(diag.maxConcurrent, 1);
    assert.equal(diag.binaries.ffmpeg, true);
    assert.equal(diag.binaries.ytdlp, false);
    assert.equal(diag.safeEgress.enforcement, "external");
    assert.equal(diag.features.ytdlpEnabled, false);
    assert.equal(diag.runtime.ytdlpVersion, null);
  });

  it("health stays unauthenticated and minimal", async () => {
    const health = await client.health();
    assert.deepEqual(health, { status: "ok" });
  });

  // H ── invalid HMAC never reaches business logic ──────────────────────────
  it("H: an invalid HMAC is rejected before any business dispatch", async () => {
    const badClient = new WorkerClient({
      baseUrl,
      currentKeyId: KEY_ID,
      currentSecret: "ffffffffffffffffffffffffffffffffffff",
    });
    const before = analyzeCalls.length;

    await assert.rejects(
      () => badClient.analyze({ url: MEDIA_URL }),
      (err: unknown) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE",
    );
    assert.equal(analyzeCalls.length, before, "analyze must not have been invoked");
  });

  // I ── replayed request never reaches business logic ──────────────────────
  it("I: a replayed request never reaches the business service", async () => {
    const replayedId = "cccccccc-cccc-4ccc-accc-cccccccccccc";
    const replayClient = new WorkerClient({
      baseUrl,
      currentKeyId: KEY_ID,
      currentSecret: SECRET,
      requestIdFactory: () => replayedId,
    });

    const first = await replayClient.analyze({ url: MEDIA_URL });
    assert.equal(first.success, true);
    const afterFirst = analyzeCalls.length;

    await assert.rejects(
      () => replayClient.analyze({ url: MEDIA_URL }),
      (err: unknown) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE",
    );
    assert.equal(analyzeCalls.length, afterFirst, "the replay must not re-invoke analyze");
  });
});
