import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import type { DurableWorkerJob, WorkerJobStore } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import { JobExecutor, PROGRESS_THROTTLE_MS, type JobExecutorDeps } from "./job-executor.server.ts";

function buildMeta(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "clip",
    thumbnail: null,
    duration: null,
    source: "cdn.example.com",
    extractor: "direct",
    webpageUrl: "https://cdn.example.com/clip",
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

type Harness = {
  tempDir: string;
  raw: SQLiteJobStore;
  store: WorkerJobStore;
  progressWrites: number;
  puts: ObjectStorePutInput[];
  writer: ObjectStoreWriter;
  resetCounters: () => void;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-progress-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const raw = new SQLiteJobStore({ db });

  let progressWrites = 0;
  const store = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          if (prop === "updateExecutionProgress") progressWrites += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as unknown as WorkerJobStore;

  const puts: ObjectStorePutInput[] = [];
  const writer: ObjectStoreWriter = {
    async put(input) {
      puts.push(input);
      for await (const chunk of input.body) void chunk;
    },
    async head(key) {
      const last = puts.find((p) => p.objectKey === key);
      if (!last) return null;
      return {
        objectKey: last.objectKey,
        contentLength: last.contentLength,
        contentType: last.contentType,
        contentDisposition: last.contentDisposition,
      };
    },
    async delete() {},
  };

  const harness: Harness = {
    tempDir,
    raw,
    store,
    get progressWrites() {
      return progressWrites;
    },
    puts,
    writer,
    resetCounters: () => {
      progressWrites = 0;
    },
    cleanup: () => {
      db.close();
      setTempDirectoryForTests(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  } as Harness;

  return harness;
}

function claimJob(store: WorkerJobStore): DurableWorkerJob {
  store.createJob(
    {
      url: "https://cdn.example.com/clip.mp4",
      formatId: "direct-original",
      principalId: "private-access-user",
    },
    randomUUID(),
  );
  const job = store.claimNextQueuedJob();
  assert.ok(job);
  return job;
}

describe("durable progress throttling", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("coalesces a burst of events inside the throttle window into one durable write", async () => {
    const job = claimJob(h.store);
    let now = Date.now();

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta(),
      downloadOriginal: async (_url, ctx) => {
        h.resetCounters();

        // 200 events, all inside a single throttle window.
        for (let i = 0; i < 200; i += 1) {
          now += 1;
          ctx.onProgress?.({
            progress: null,
            downloadedBytes: i,
            totalBytes: null,
            speed: null,
            eta: null,
            stage: "downloading",
          });
        }
        assert.equal(
          h.progressWrites,
          1,
          "a burst inside one throttle window must produce exactly one durable write",
        );
        assert.ok(now - Date.now() < PROGRESS_THROTTLE_MS, "the burst stayed inside the window");

        const during = h.raw.getJob(job.jobId)!;
        assert.equal(during.downloadedBytes, 0, "only the first event of the burst was persisted");

        // Advance past the throttle window: the next event must persist.
        now += PROGRESS_THROTTLE_MS + 1;
        ctx.onProgress?.({
          progress: 42,
          downloadedBytes: 4096,
          totalBytes: 8192,
          speed: 1024,
          eta: 4,
          stage: "downloading",
        });
        assert.equal(h.progressWrites, 2, "a later event outside the window is persisted");

        const after = h.raw.getJob(job.jobId)!;
        assert.equal(after.progress, 42);
        assert.equal(after.downloadedBytes, 4096);
        assert.equal(after.totalBytes, 8192);
        assert.equal(after.stageLabel, "downloading");

        const filePath = path.join(ctx.workDir, "source.mp4");
        fs.writeFileSync(filePath, "mockdata");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => now, new Map(), deps);
    await executor.execute(job);

    assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
  });

  it("a 100% completion event always flushes, even inside the throttle window", async () => {
    const job = claimJob(h.store);
    const now = Date.now();

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta(),
      downloadOriginal: async (_url, ctx) => {
        h.resetCounters();
        ctx.onProgress?.({ progress: 10, downloadedBytes: 1, stage: "downloading" });
        ctx.onProgress?.({ progress: 100, downloadedBytes: 8, stage: "downloading" });
        assert.equal(h.progressWrites, 2, "the terminal 100% event bypasses the throttle");
        assert.equal(h.raw.getJob(job.jobId)!.progress, 100);

        const filePath = path.join(ctx.workDir, "source.mp4");
        fs.writeFileSync(filePath, "mockdata");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => now, new Map(), deps);
    await executor.execute(job);
    assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
  });

  it("a terminal store result aborts the active signal and stops all later progress", async () => {
    const job = claimJob(h.store);
    let now = Date.now();
    let writesAfterTerminal = 0;
    let abortedDuringDownload = false;

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta(),
      downloadOriginal: async (_url, ctx) => {
        // First event lands normally while the job is still downloading.
        ctx.onProgress?.({ progress: 5, downloadedBytes: 1, stage: "downloading" });
        assert.equal(h.raw.getJob(job.jobId)!.progress, 5);

        // The job becomes terminal underneath the running execution.
        h.raw.cancelJob(job.jobId);

        now += PROGRESS_THROTTLE_MS + 1;
        ctx.onProgress?.({ progress: 50, downloadedBytes: 2, stage: "downloading" });
        abortedDuringDownload = ctx.signal!.aborted;

        h.resetCounters();
        for (let i = 0; i < 25; i += 1) {
          now += PROGRESS_THROTTLE_MS + 1;
          ctx.onProgress?.({ progress: 60 + i, downloadedBytes: 3 + i, stage: "downloading" });
        }
        writesAfterTerminal = h.progressWrites;

        throw Object.assign(new Error("aborted"), { code: "PROCESSING_FAILED" });
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => now, new Map(), deps);
    await executor.execute(job);

    assert.equal(abortedDuringDownload, true, "a terminal store result aborts the active signal");
    assert.equal(writesAfterTerminal, 0, "no progress write is attempted after the terminal result");

    const view = h.raw.getJob(job.jobId)!;
    assert.equal(view.status, "cancelled", "the terminal state is preserved");
    assert.notEqual(view.progress, 50, "a late progress event never overwrote terminal state");
    assert.equal(h.puts.length, 0);
  });

  it("progress mutations are refused for a state the job is not in", () => {
    const job = claimJob(h.store);
    // The job is `analyzing`; a downloading-progress mutation must not apply.
    const res = h.raw.updateExecutionProgress(job.jobId, "downloading", {
      progress: 10,
      downloadedBytes: null,
      totalBytes: null,
      speed: null,
      eta: null,
      stageLabel: "downloading",
    });
    assert.equal(res.type, "state_conflict");
    assert.equal(h.raw.getJob(job.jobId)!.progress, null);
  });
});
