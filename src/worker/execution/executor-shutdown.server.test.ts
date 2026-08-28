import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../../lib/errors.ts";
import type { WorkerVideoMetadata, WorkerObjectKey } from "../../shared/worker/contracts.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type {
  ObjectStoreHead,
  ObjectStorePutInput,
  ObjectStoreWriter,
} from "../storage/writer.ts";
import { JobExecutor } from "./job-executor.server.ts";

/**
 * §22/§23: `abortActiveForShutdown()` regression.
 *
 * An operator restart must abort in-flight media execution — so no FFmpeg
 * descendant outlives the container — WITHOUT ever writing a user cancellation
 * state and without weakening first-terminal-wins.
 */

const MEDIA_URL = "https://cdn.example/clip.mp4";
const FORMAT_ID = "direct-original";

function metadata(): WorkerVideoMetadata {
  return {
    title: "Shutdown Clip",
    thumbnail: null,
    duration: 12,
    source: "cdn.example",
    extractor: "direct",
    webpageUrl: MEDIA_URL,
    formats: [
      {
        id: FORMAT_ID,
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

class MemoryWriter implements ObjectStoreWriter {
  public readonly objects = new Map<string, ObjectStoreHead>();
  async put(input: ObjectStorePutInput): Promise<void> {
    let received = 0;
    for await (const chunk of input.body) received += chunk.length;
    this.objects.set(input.objectKey, {
      objectKey: input.objectKey,
      contentLength: received,
      contentType: input.contentType,
      contentDisposition: input.contentDisposition,
    });
  }
  async head(objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    return this.objects.get(objectKey) ?? null;
  }
  async delete(): Promise<void> {}
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("JobExecutor.abortActiveForShutdown", () => {
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let cancelCalls: string[];

  beforeEach(() => {
    db = openWorkerDatabase({ path: ":memory:" });
    applyMigrations(db);
    store = new SQLiteJobStore({ db });
    cancelCalls = [];
    // Spy that records any user-cancellation attempt without changing behaviour.
    const realCancel = store.cancelJob.bind(store);
    store.cancelJob = (jobId: string) => {
      cancelCalls.push(jobId);
      return realCancel(jobId);
    };
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  function queueJob(): string {
    const created = store.createJob(
      { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
      randomUUID(),
    );
    assert.equal(created.type, "created");
    return created.type === "created" ? created.job.jobId : "";
  }

  it("aborts in-flight work WITHOUT writing a cancelled state", async () => {
    const jobId = queueJob();
    let downloadEntered = false;

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        downloadEntered = true;
        // Blocks until the shutdown abort fires.
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AppError("PROCESSING_FAILED", "aborted");
      },
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    const execution = executor.execute(claimed);

    await waitFor(() => downloadEntered, "download to start");
    assert.equal(executor.activeJobCount, 1);

    const aborted = executor.abortActiveForShutdown();
    assert.equal(aborted, 1, "one execution was signalled");

    await execution;

    const view = store.getJob(jobId);
    assert.ok(view);
    // The durable outcome is `failed`, matching the existing conservative
    // classification for interrupted work.
    assert.equal(view.status, "failed");
    assert.notEqual(view.status, "cancelled", "a shutdown is NOT a user cancellation");
    assert.deepEqual(cancelCalls, [], "store.cancelJob must never be called by shutdown");
  });

  it("returns 0 and does nothing when no execution is active", () => {
    const executor = new JobExecutor(store, new MemoryWriter());
    assert.equal(executor.abortActiveForShutdown(), 0);
    assert.deepEqual(cancelCalls, []);
  });

  it("does NOT disturb a job that already committed a terminal ready state", async () => {
    const jobId = queueJob();
    const writer = new MemoryWriter();

    const executor = new JobExecutor(store, writer, () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        const filePath = join(ctx.workDir, "original.mp4");
        await writeFile(filePath, "SHUTDOWN-MEDIA-BYTES");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 20 };
      },
      processLocally: async () => {
        throw new Error("keep-original must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    await executor.execute(claimed);

    assert.equal(store.getJob(jobId)?.status, "ready");

    // A shutdown arriving after the terminal write changes nothing.
    assert.equal(executor.abortActiveForShutdown(), 0);
    assert.equal(store.getJob(jobId)?.status, "ready", "first-terminal-wins is preserved");
    assert.deepEqual(cancelCalls, []);
  });

  it("aborts every concurrently registered execution", async () => {
    const controllers = new Map<string, AbortController>();
    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), controllers);

    const a = new AbortController();
    const b = new AbortController();
    controllers.set("a".repeat(32), a);
    controllers.set("b".repeat(32), b);

    assert.equal(executor.abortActiveForShutdown(), 2);
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, true);
    assert.deepEqual(cancelCalls, [], "no durable cancellation was written");
  });

  it("leaves a still-queued job queued for the next boot", async () => {
    const jobId = queueJob();
    const executor = new JobExecutor(store, new MemoryWriter());

    // Nothing was claimed, so shutdown has no active execution to abort and the
    // durable row is untouched.
    assert.equal(executor.abortActiveForShutdown(), 0);
    assert.equal(store.getJob(jobId)?.status, "queued");
  });

  it("preserves an explicit user cancellation that won before shutdown", async () => {
    const jobId = queueJob();
    let downloadEntered = false;

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        downloadEntered = true;
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AppError("PROCESSING_FAILED", "aborted");
      },
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    const execution = executor.execute(claimed);
    await waitFor(() => downloadEntered, "download to start");

    // A real user cancellation wins the terminal transition FIRST.
    const cancelled = executor.cancel(jobId);
    assert.equal(cancelled.type, "cancelled");

    // A later shutdown abort must not overwrite that terminal state.
    executor.abortActiveForShutdown();
    await execution;

    assert.equal(store.getJob(jobId)?.status, "cancelled", "the user cancellation still wins");
    assert.deepEqual(cancelCalls, [jobId], "only the explicit cancel called cancelJob");
  });
});
