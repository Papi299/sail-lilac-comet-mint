import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "@/lib/errors";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import type { DurableWorkerJob, WorkerJobStore } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";
import type { WorkerRequestedFormatId } from "../../shared/worker/contracts.ts";

function buildMeta(
  original: { container: string; hasVideo: boolean },
  presets: Array<{ id: string; container: string; hasVideo: boolean }> = [],
): WorkerVideoMetadata {
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
        resolution: original.hasVideo ? "unknown" : "audio",
        width: null,
        height: null,
        fps: null,
        container: original.container,
        videoCodec: original.hasVideo ? "unknown" : null,
        audioCodec: "unknown",
        bitrate: null,
        fileSize: 8,
        hasVideo: original.hasVideo,
        hasAudio: true,
        formatNote: null,
      },
    ],
    presets: presets.map((p) => ({
      id: p.id,
      label: p.id,
      resolution: p.hasVideo ? "unknown" : "audio",
      container: p.container,
      fileSize: null,
      hasVideo: p.hasVideo,
      hasAudio: true,
      formatId: p.id,
      videoCodec: p.hasVideo ? "unknown" : null,
      audioCodec: "unknown",
      fps: null,
    })),
    capabilities: { mp3: true, merge: true },
  });
}

type Harness = {
  tempDir: string;
  raw: SQLiteJobStore;
  store: WorkerJobStore;
  calls: string[];
  puts: ObjectStorePutInput[];
  deletes: string[];
  writer: ObjectStoreWriter;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-cancel-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const raw = new SQLiteJobStore({ db });

  // Records every store method the executor invokes, so "beginProcessing was
  // never reached" is asserted directly rather than inferred.
  const calls: string[] = [];
  const store = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as unknown as WorkerJobStore;

  const puts: ObjectStorePutInput[] = [];
  const deletes: string[] = [];
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
    async delete(key) {
      deletes.push(key);
    },
  };

  return {
    tempDir,
    raw,
    store,
    calls,
    puts,
    deletes,
    writer,
    cleanup: () => {
      db.close();
      setTempDirectoryForTests(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function claimJob(store: WorkerJobStore, formatId: WorkerRequestedFormatId): DurableWorkerJob {
  store.createJob(
    { url: "https://cdn.example.com/clip.mp4", formatId, principalId: "private-access-user" },
    randomUUID(),
  );
  const job = store.claimNextQueuedJob();
  assert.ok(job);
  return job;
}

function writeOriginal(workDir: string, container: string) {
  const filePath = path.join(workDir, `source.${container}`);
  fs.writeFileSync(filePath, "mockdata");
  return filePath;
}

describe("cancellation matrix", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("cancel during analyzing: job is cancelled and nothing is downloaded", async () => {
    const job = claimJob(h.store, "direct-original");
    let downloads = 0;
    const active: { executor?: JobExecutor } = {};

    const deps: JobExecutorDeps = {
      analyze: async (_url, signal) => {
        active.executor!.cancel(job.jobId);
        assert.equal(signal!.aborted, true, "the in-flight analysis signal must abort");
        throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
      },
      downloadOriginal: async () => {
        downloads += 1;
        throw new Error("unreachable");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    active.executor = executor;
    await executor.execute(job);

    assert.equal(downloads, 0);
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
    assert.equal(h.puts.length, 0);
    assert.ok(!h.calls.includes("completeAnalysis"), "analysis must not be committed");
  });

  it("cancel during analyzing (analysis returns normally): completeAnalysis loses the CAS", async () => {
    const job = claimJob(h.store, "direct-original");
    let downloads = 0;
    const active: { executor?: JobExecutor } = {};

    const deps: JobExecutorDeps = {
      analyze: async () => {
        active.executor!.cancel(job.jobId);
        return buildMeta({ container: "mp4", hasVideo: true });
      },
      downloadOriginal: async () => {
        downloads += 1;
        throw new Error("unreachable");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    active.executor = executor;
    await executor.execute(job);

    assert.equal(downloads, 0, "a lost completeAnalysis must not proceed to download");
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
    assert.equal(h.puts.length, 0);
  });

  it("cancel during downloading: signal aborts, beginProcessing never runs, nothing is uploaded", async () => {
    const job = claimJob(h.store, "direct-original");
    const active: { executor?: JobExecutor } = {};
    let sawAbortedSignal = false;

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async (_url, ctx) => {
        assert.equal(h.raw.getJob(job.jobId)!.status, "downloading");
        active.executor!.cancel(job.jobId);
        sawAbortedSignal = ctx.signal!.aborted;
        throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    active.executor = executor;
    await executor.execute(job);

    assert.equal(sawAbortedSignal, true);
    assert.ok(!h.calls.includes("beginProcessing"), "beginProcessing must never be reached");
    assert.equal(h.puts.length, 0);
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
  });

  it("cancel during processing: the local process sees the aborted signal, beginUploading never runs", async () => {
    const job = claimJob(h.store, "preset:mp3");
    const active: { executor?: JobExecutor } = {};
    let sawAbortedSignal = false;

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }, [
        { id: "preset:mp3", container: "mp3", hasVideo: false },
      ]),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
      processLocally: async (opts) => {
        assert.equal(h.raw.getJob(job.jobId)!.status, "processing");
        active.executor!.cancel(job.jobId);
        sawAbortedSignal = opts.signal!.aborted;
        throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    active.executor = executor;
    await executor.execute(job);

    assert.equal(sawAbortedSignal, true, "the local process must receive the aborted signal");
    assert.ok(!h.calls.includes("beginUploading"), "beginUploading must never be reached");
    assert.equal(h.puts.length, 0);
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
  });

  it("cancel after processing but before upload: beginUploading loses and nothing is uploaded", async () => {
    const job = claimJob(h.store, "preset:mp3");
    const active: { executor?: JobExecutor } = {};

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }, [
        { id: "preset:mp3", container: "mp3", hasVideo: false },
      ]),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
      processLocally: async (opts) => {
        const out = path.join(opts.workDir, `converted.${opts.target}`);
        fs.writeFileSync(out, "mp3-bytes");
        // Processing finished successfully; the cancel lands in the gap before
        // the uploading transition is attempted.
        active.executor!.cancel(job.jobId);
        return out;
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    active.executor = executor;
    await executor.execute(job);

    assert.ok(h.calls.includes("beginUploading"), "the uploading transition must be attempted");
    assert.equal(h.puts.length, 0, "no object may be written once beginUploading loses");
    assert.equal(h.deletes.length, 0, "nothing was uploaded, so nothing may be deleted");
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
  });

  it("cancel during the object upload: the real ready CAS loses and the exact key is deleted", async () => {
    const job = claimJob(h.store, "direct-original");
    const active: { executor?: JobExecutor } = {};

    const cancellingWriter: ObjectStoreWriter = {
      ...h.writer,
      async put(input) {
        h.puts.push(input);
        for await (const chunk of input.body) void chunk;
        // The upload itself completed; the cancel lands before the ready CAS.
        assert.equal(h.raw.getJob(job.jobId)!.status, "uploading");
        active.executor!.cancel(job.jobId);
      },
    };

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
    };

    const executor = new JobExecutor(h.store, cancellingWriter, () => Date.now(), new Map(), deps);
    active.executor = executor;
    await executor.execute(job);

    assert.equal(h.puts.length, 1, "uploading was already committed, so the put happened");
    const uploadedKey = h.puts[0]!.objectKey;
    assert.deepEqual(h.deletes, [uploadedKey], "exactly the uploaded key must be deleted");

    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "cancelled", "the terminal cancellation winner is preserved");
    assert.equal(view.objectKey, null, "a cancelled job never owns an object key");
  });

  it("ready commits first: a later cancel changes nothing and deletes nothing", async () => {
    const job = claimJob(h.store, "direct-original");

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    const readyView = h.store.getJob(job.jobId)!;
    assert.equal(readyView.status, "ready");
    assert.ok(readyView.objectKey);
    assert.equal(h.deletes.length, 0);

    const result = executor.cancel(job.jobId);
    assert.equal(result.type, "unchanged", "a terminal ready job cannot be cancelled");

    const afterView = h.store.getJob(job.jobId)!;
    assert.equal(afterView.status, "ready");
    assert.equal(afterView.objectKey, readyView.objectKey, "the object key survives");
    assert.equal(h.deletes.length, 0, "a losing cancel must never delete a ready object");
  });

  it("§18: a cancel landing at controller registration is observed before any filesystem or media work", async () => {
    const job = claimJob(h.store, "direct-original");
    let analyzed = 0;

    // The controller map fires the cancellation the instant the executor
    // registers its AbortController. If registration happened after
    // createJobDir(), this cancel would arrive too late to be observed here.
    const controllers = new (class extends Map<string, AbortController> {
      set(key: string, value: AbortController) {
        const result = super.set(key, value);
        h.raw.cancelJob(key);
        value.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
        return result;
      }
    })();

    const deps: JobExecutorDeps = {
      analyze: async () => {
        analyzed += 1;
        throw new Error("unreachable");
      },
      downloadOriginal: async () => {
        throw new Error("unreachable");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), controllers, deps);
    await executor.execute(job);

    assert.equal(analyzed, 0, "no media work may start after an already-observed cancel");
    assert.equal(h.puts.length, 0);
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
    assert.equal(
      fs.existsSync(path.join(h.tempDir, "jobs", job.jobId)),
      false,
      "no job directory may be created once the cancel is observable",
    );
  });

  it("a job already cancelled before execution starts does no work at all", async () => {
    const job = claimJob(h.store, "direct-original");
    h.raw.cancelJob(job.jobId);

    let analyzed = 0;
    const deps: JobExecutorDeps = {
      analyze: async () => {
        analyzed += 1;
        throw new Error("unreachable");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.equal(analyzed, 0);
    assert.equal(h.puts.length, 0);
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
  });
});
