import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import type { WorkerRequestedFormatId } from "@/shared/worker/contracts";
import type { DurableWorkerJob } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import {
  GenericExecutionPlanSchema,
  deriveClearHlsExecutionPlan,
  deriveClearHlsSeparateAudioExecutionPlan,
  type ExecutionPlan,
} from "./format-plan.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";
import { WorkerTimeLimitsError, type WorkerTimeLimits } from "../runtime/time-limits.ts";

/**
 * VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001 — the executor hands out the ONE model.
 *
 * Every acquisition path (direct, generic single, generic split, clear HLS,
 * separate-audio HLS) must receive the job's ONE acquisition limit, and every
 * processing stage (one-input processing, split merge, clear-HLS remux,
 * separate-audio merge) the ONE processing budget — from the injected model,
 * never from the legacy module configuration and never each other's. The two
 * values are deliberately different and both non-default, so a cross-wired or
 * missed injection cannot pass.
 *
 * Fakes only: no network, no subprocess, no real media.
 */

const LIMITS: WorkerTimeLimits = Object.freeze({ downloadTimeLimitMs: 1_234_000, processingMs: 2_345_000 });
const DEFAULTS = { downloadTimeLimitMs: 600_000, processingMs: 600_000 } as const;
const MAX = 10_000;

type Harness = {
  tempDir: string;
  db: DatabaseSync;
  store: SQLiteJobStore;
  puts: ObjectStorePutInput[];
  writer: ObjectStoreWriter;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-stage-limits-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const store = new SQLiteJobStore({ db });
  const puts: ObjectStorePutInput[] = [];
  const writer: ObjectStoreWriter = {
    async put(input) {
      puts.push(input);
      for await (const chunk of input.body) void chunk;
    },
    async head(key) {
      const last = puts.find((p) => p.objectKey === key);
      return last
        ? {
            objectKey: last.objectKey,
            contentLength: last.contentLength,
            contentType: last.contentType,
            contentDisposition: last.contentDisposition,
          }
        : null;
    },
    async delete() {},
  };
  return {
    tempDir,
    db,
    store,
    puts,
    writer,
    cleanup: () => {
      db.close();
      setTempDirectoryForTests(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function claimJob(store: SQLiteJobStore, formatId: WorkerRequestedFormatId): DurableWorkerJob {
  store.createJob({ url: "https://cdn.example.com/clip", formatId, principalId: "private-access-user" }, randomUUID());
  const job = store.claimNextQueuedJob();
  assert.ok(job, "a job must be claimable");
  return job;
}

function write(dir: string, name: string, bytes = "media-bytes"): { filePath: string; fileSize: number } {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return { filePath, fileSize: Buffer.byteLength(bytes) };
}

function genericMeta(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "Stage Limits",
    thumbnail: null,
    duration: 6,
    source: "example.invalid",
    extractor: "yt-dlp",
    webpageUrl: "https://example.invalid/watch",
    formats: [],
    presets: [],
    capabilities: { mp3: false, merge: false },
  });
}

function directMp3Meta(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "Stage Limits",
    thumbnail: null,
    duration: null,
    source: "cdn.example.com",
    extractor: "direct",
    webpageUrl: "https://cdn.example.com/clip.mp4",
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
    presets: [
      {
        id: "preset:mp3",
        label: "MP3",
        resolution: "audio",
        container: "mp3",
        fileSize: null,
        hasVideo: false,
        hasAudio: true,
        formatId: "preset:mp3",
        videoCodec: null,
        audioCodec: "unknown",
        fps: null,
      },
    ],
    capabilities: { mp3: true, merge: true },
  });
}

const GENERIC_ANALYSIS: ExecutionAnalysis = {
  strategy: "yt-dlp",
  video: genericMeta(),
  selections: {},
  hlsSelections: {},
  separateHlsSelections: {},
};

const SINGLE_PLAN = GenericExecutionPlanSchema.parse({
  strategy: "yt-dlp",
  operation: "keep-original",
  requestedFormatId: "preset:1080",
  source: {
    formatId: "22",
    protocol: "https",
    container: "mp4",
    hasVideo: true,
    hasAudio: true,
    videoConstraint: "codec-present",
    audioConstraint: "codec-present",
    fileSize: null,
  },
  targetContainer: "mp4",
});

const SPLIT_PLAN = GenericExecutionPlanSchema.parse({
  strategy: "yt-dlp",
  operation: "merge-split",
  requestedFormatId: "preset:1080",
  pair: {
    video: {
      formatId: "137",
      protocol: "https",
      container: "mp4",
      hasVideo: true,
      hasAudio: false,
      videoConstraint: "codec-present",
      audioConstraint: "absent",
      fileSize: null,
    },
    audio: {
      formatId: "140",
      protocol: "https",
      container: "m4a",
      hasVideo: false,
      hasAudio: true,
      videoConstraint: "absent",
      audioConstraint: "codec-present",
      fileSize: null,
    },
  },
  targetContainer: "mp4",
});

const HLS_PLAN = deriveClearHlsExecutionPlan(
  Object.freeze({
    "preset:1080": Object.freeze({ playlistUrl: "https://media.example.invalid/hls/media.m3u8", height: 1080 }),
  }),
  "preset:1080",
);

const SEPARATE_PLAN = deriveClearHlsSeparateAudioExecutionPlan(
  Object.freeze({
    "preset:1080": Object.freeze({
      videoPlaylistUrl: "https://media.example.invalid/hls/video.m3u8",
      audioPlaylistUrl: "https://media.example.invalid/hls/audio.m3u8",
      height: 1080,
    }),
  }),
  "preset:1080",
);

const yt = (generic: unknown): ExecutionPlan => ({ strategy: "yt-dlp", generic }) as ExecutionPlan;

type Seen = { acquisition: number[]; processing: number[] };

type PathCase = {
  readonly name: string;
  readonly formatId: WorkerRequestedFormatId;
  /** Which processing seam the path reaches, if any. */
  readonly processing: string | null;
  readonly deps: (seen: Seen) => JobExecutorDeps;
};

const PATHS: readonly PathCase[] = [
  {
    name: "direct (mp3 extraction)",
    formatId: "preset:mp3",
    processing: "processLocally",
    deps: (seen) => ({
      analyze: async () => directMp3Meta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      downloadOriginal: async (_url, ctx) => {
        seen.acquisition.push(ctx.downloadTimeLimitMs);
        const { filePath, fileSize } = write(ctx.workDir, "source.mp4");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize };
      },
      processLocally: async (opts) => {
        seen.processing.push(opts.timeoutMs);
        return write(opts.workDir, `converted.${opts.target}`).filePath;
      },
    }),
  },
  {
    name: "generic yt-dlp single source (keep original)",
    formatId: "preset:1080",
    processing: null,
    deps: (seen) => ({
      analyzeForExecution: async () => GENERIC_ANALYSIS,
      derivePlanForExecution: () => yt(SINGLE_PLAN),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      downloadGeneric: async (_url, workDir, _plan, ctx) => {
        seen.acquisition.push(ctx.limits.downloadTimeLimitMs);
        assert.equal(ctx.limits.maxFileSizeBytes, MAX, "the byte ceiling travels beside it, unchanged");
        const { filePath, fileSize } = write(workDir, "source.mp4");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize };
      },
      processLocally: async () => assert.fail("keep-original never processes"),
    }),
  },
  {
    name: "generic yt-dlp split pair",
    formatId: "preset:1080",
    processing: "mergeSplit",
    deps: (seen) => ({
      analyzeForExecution: async () => GENERIC_ANALYSIS,
      derivePlanForExecution: () => yt(SPLIT_PLAN),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      downloadGenericSplit: async (_url, workDir, _plan, ctx) => {
        seen.acquisition.push(ctx.limits.downloadTimeLimitMs);
        const video = write(workDir, "video-source.mp4", "VIDEO");
        const audio = write(workDir, "audio-source.m4a", "AUDIO");
        return {
          video: { ...video, container: "mp4" },
          audio: { ...audio, container: "m4a" },
          totalFileSize: video.fileSize + audio.fileSize,
        };
      },
      mergeSplit: async (opts) => {
        seen.processing.push(opts.timeoutMs);
        return write(opts.workDir, "merged.mp4").filePath;
      },
    }),
  },
  {
    name: "clear HLS",
    formatId: "preset:1080",
    processing: "processClearHls",
    deps: (seen) => ({
      analyzeForExecution: async () => GENERIC_ANALYSIS,
      derivePlanForExecution: () => yt(HLS_PLAN),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquireClearHls: async (_plan, workDir, ctx) => {
        seen.acquisition.push(ctx.downloadTimeLimitMs);
        const { filePath, fileSize } = write(workDir, "hls-source.ts");
        return Object.freeze({ filePath, segmentType: "mpegts" as const, fileSize });
      },
      processClearHls: async (opts) => {
        seen.processing.push(opts.timeoutMs);
        const { filePath, fileSize } = write(opts.workDir, "hls-output.mp4");
        return Object.freeze({ filePath, container: "mp4" as const, fileSize });
      },
    }),
  },
  {
    name: "separate-audio HLS",
    formatId: "preset:1080",
    processing: "processSeparateHls",
    deps: (seen) => ({
      analyzeForExecution: async () => GENERIC_ANALYSIS,
      derivePlanForExecution: () => yt(SEPARATE_PLAN),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquireSeparateHls: async (_plan, workDir, ctx) => {
        seen.acquisition.push(ctx.downloadTimeLimitMs);
        const video = write(workDir, "hls-video.fmp4", "VIDEO");
        const audio = write(workDir, "hls-audio.fmp4", "AUDIO");
        return Object.freeze({
          video: Object.freeze({ ...video, segmentType: "fmp4" as const }),
          audio: Object.freeze({ ...audio, segmentType: "fmp4" as const }),
          totalFileSize: video.fileSize + audio.fileSize,
        });
      },
      processSeparateHls: async (opts) => {
        seen.processing.push(opts.timeoutMs);
        const { filePath, fileSize } = write(opts.workDir, "merged.mp4");
        return Object.freeze({ filePath, container: "mp4" as const, fileSize });
      },
    }),
  },
];

describe("stage time limits reach every acquisition and processing seam (VIDEOFETCH-LD1)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  for (const p of PATHS) {
    it(`${p.name}: acquisition gets downloadTimeLimitMs, processing gets processingMs`, async () => {
      const seen: Seen = { acquisition: [], processing: [] };
      const job = claimJob(h.store, p.formatId);
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
        ...p.deps(seen),
        genericLimits: { maxFileSizeBytes: MAX },
        timeLimits: LIMITS,
      });
      await executor.execute(job);
      const view = h.store.getJob(job.jobId)!;
      assert.equal(view.status, "ready", `${view.status} ${view.errorCode ?? ""}`);
      assert.deepEqual(seen.acquisition, [LIMITS.downloadTimeLimitMs], "never processingMs, never a default");
      assert.deepEqual(
        seen.processing,
        p.processing === null ? [] : [LIMITS.processingMs],
        "never downloadTimeLimitMs, never a default",
      );
    });

    it(`${p.name}: with no model injected, the STRICT defaults apply — never the legacy module value`, async () => {
      const saved = config.downloadTimeoutMs;
      // A legacy value no Worker path may read: before LD-1 every path but the
      // generic one, and every processing call, would have used it.
      Object.assign(config, { downloadTimeoutMs: 7 });
      try {
        const seen: Seen = { acquisition: [], processing: [] };
        const job = claimJob(h.store, p.formatId);
        const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
          ...p.deps(seen),
          genericLimits: { maxFileSizeBytes: MAX },
        });
        await executor.execute(job);
        assert.equal(h.store.getJob(job.jobId)!.status, "ready");
        assert.deepEqual(seen.acquisition, [DEFAULTS.downloadTimeLimitMs]);
        assert.deepEqual(seen.processing, p.processing === null ? [] : [DEFAULTS.processingMs]);
      } finally {
        Object.assign(config, { downloadTimeoutMs: saved });
      }
    });
  }
});

describe("stage time limits: construction refuses a second or malformed source", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  const construct = (deps: JobExecutorDeps) => () => new JobExecutor(h.store, h.writer, () => 0, new Map(), deps);
  const refusedFor = (field: string) => (err: unknown) => {
    assert.ok(err instanceof WorkerTimeLimitsError, String(err));
    assert.equal(err.field, field);
    return true;
  };

  it("refuses a malformed model", () => {
    for (const bad of [
      { downloadTimeLimitMs: 0, processingMs: 1 },
      { downloadTimeLimitMs: 1.5, processingMs: 1 },
      { downloadTimeLimitMs: "600000", processingMs: 1 },
      { downloadTimeLimitMs: 1, processingMs: Number.NaN },
      { downloadTimeLimitMs: 21_600_001, processingMs: 1 },
      { downloadTimeLimitMs: 1, processingMs: 14_400_001 },
    ]) {
      const field = (bad.downloadTimeLimitMs as unknown) === 1 ? "processingMs" : "downloadTimeLimitMs";
      assert.throws(construct({ timeLimits: bad as unknown as WorkerTimeLimits }), refusedFor(field));
    }
  });

  it("refuses a time limit arriving through the byte-ceiling channel (pre-LD-1 or seam shape)", () => {
    for (const stale of [
      { maxFileSizeBytes: MAX, downloadTimeoutSeconds: 600 },
      { maxFileSizeBytes: MAX, downloadTimeLimitMs: 600_000 },
    ]) {
      assert.throws(construct({ genericLimits: stale as never }), refusedFor("genericLimits"));
    }
  });

  it("exposes exactly the model it was given, frozen", () => {
    const executor = construct({ timeLimits: LIMITS })();
    assert.deepEqual({ ...executor.timeLimits }, { ...LIMITS });
    assert.ok(Object.isFrozen(executor.timeLimits));
    assert.deepEqual({ ...construct({})().timeLimits }, DEFAULTS);
  });
});

describe("stage time limits never bypass cancellation, shutdown, the byte ceiling or classification", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  /** The direct path, with an acquisition that waits until its signal aborts. */
  function blockingDirect(onStart: (jobId: string) => void, jobIdRef: { id: string }): JobExecutorDeps {
    return {
      analyze: async () => directMp3Meta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      downloadOriginal: (_url, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(new AppError("PROCESSING_FAILED", "aborted")), {
            once: true,
          });
          onStart(jobIdRef.id);
        }),
      processLocally: async () => assert.fail("never reached"),
    };
  }

  it("a user cancellation during acquisition still wins (cancelled, not a timeout)", async () => {
    const job = claimJob(h.store, "preset:mp3");
    const ref = { id: job.jobId };
    const executor: JobExecutor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      ...blockingDirect((id) => queueMicrotask(() => executor.cancel(id)), ref),
      timeLimits: LIMITS,
    });
    await executor.execute(job);
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
    assert.equal(h.puts.length, 0);
    assert.equal(fs.existsSync(path.join(h.tempDir, "jobs", job.jobId)), false, "workDir removed");
  });

  it("an operator shutdown during acquisition still leaves the row active for recovery", async () => {
    const job = claimJob(h.store, "preset:mp3");
    const ref = { id: job.jobId };
    const executor: JobExecutor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      ...blockingDirect(() => queueMicrotask(() => executor.abortActiveForShutdown()), ref),
      timeLimits: LIMITS,
    });
    await executor.execute(job);
    assert.equal(h.store.getJob(job.jobId)!.status, "downloading", "recover() owns the restart outcome");
  });

  it("the byte ceiling is still authoritative with a long limit (TOO_LARGE)", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      ...PATHS[2]!.deps({ acquisition: [], processing: [] }),
      downloadGenericSplit: async (_url, workDir) => {
        const video = write(workDir, "video-source.mp4", "V".repeat(MAX));
        const audio = write(workDir, "audio-source.m4a", "A");
        return {
          video: { ...video, container: "mp4" },
          audio: { ...audio, container: "m4a" },
          totalFileSize: video.fileSize + audio.fileSize,
        };
      },
      genericLimits: { maxFileSizeBytes: MAX },
      timeLimits: { downloadTimeLimitMs: 21_600_000, processingMs: 14_400_000 },
    });
    await executor.execute(job);
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "TOO_LARGE");
  });

  it("a processing-stage timeout is TIMEOUT in 'Processing failed', with no upload and the workDir removed", async () => {
    const job = claimJob(h.store, "preset:mp3");
    let budget = 0;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      ...PATHS[0]!.deps({ acquisition: [], processing: [] }),
      processLocally: async (opts) => {
        budget = opts.timeoutMs;
        write(opts.workDir, "converted.mp3", "PARTIAL");
        throw new AppError("TIMEOUT");
      },
      timeLimits: LIMITS,
    });
    await executor.execute(job);
    const view = h.store.getJob(job.jobId)!;
    assert.equal(budget, LIMITS.processingMs);
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "TIMEOUT");
    assert.equal(view.stageLabel, "Processing failed");
    assert.equal(h.puts.length, 0, "an incomplete output is never uploaded");
    assert.equal(fs.existsSync(path.join(h.tempDir, "jobs", job.jobId)), false, "incomplete output removed");
  });

  it("an acquisition timeout is TIMEOUT in 'Download failed', and processing never starts", async () => {
    const job = claimJob(h.store, "preset:mp3");
    let processed = 0;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      ...PATHS[0]!.deps({ acquisition: [], processing: [] }),
      downloadOriginal: async () => {
        throw new AppError("TIMEOUT");
      },
      processLocally: async () => {
        processed += 1;
        return "";
      },
      timeLimits: LIMITS,
    });
    await executor.execute(job);
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "TIMEOUT");
    assert.equal(view.stageLabel, "Download failed");
    assert.equal(processed, 0);
  });
});
