import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "@/lib/config";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import {
  VideoMetadataSchema,
  type WorkerRequestedFormatId,
  type WorkerVideoMetadata,
} from "@/shared/worker/contracts";
import type { DurableWorkerJob, WorkerJobStore } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import {
  JobExecutor,
  availableBytesOnWorkDirFilesystem,
  type DownloadGenericOriginalFn,
  type DownloadGenericSplitFn,
  type JobExecutorDeps,
  type MergeSplitMediaFn,
} from "./job-executor.server.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import { GenericPresetSourceSchema, type GenericPresetSource } from "./generic-source.ts";
import {
  GenericExecutionPlanSchema,
  deriveExecutionPlan,
  type GenericSingleSourceExecutionPlan,
  type GenericSplitExecutionPlan,
} from "./format-plan.ts";
import type { GenericDownloadLimits, GenericSplitSourcesDownload } from "./ytdlp-download.server.ts";

/**
 * SPLIT-04: split-stream execution on the ONE durable state machine.
 *
 *   analysis -> completeAnalysis (downloading) -> capacity preflight
 *   -> split acquisition -> beginProcessing (processing) -> merge
 *   -> final local validation -> beginUploading (uploading) -> upload -> ready
 *
 * The real analyzer still builds NO split selection, so every case here injects
 * a valid split `ExecutionAnalysis` built through the REAL schemas. Executor
 * logic is driven through injected seams here; split-execution-primitives
 * .server.test.ts runs SPLIT-03's `downloadGenericSplitSources` and SPLIT-02's
 * `mergeSplitMedia` inside the executor with only their subprocesses faked.
 * No network, no yt-dlp, no FFmpeg.
 *
 * The load-bearing assertions are about ORDER: what the durable status says at
 * the exact instant acquisition, the merge, and the upload are invoked.
 */

const SENTINEL = "SUPER_SECRET_VALUE";
const SPLIT_URL = "https://example.invalid/watch/split";

/** A deliberately tiny ceiling, so every byte bound is exercised exactly. */
const MAX = 1000;
const LIMITS: GenericDownloadLimits = { maxFileSizeBytes: MAX, downloadTimeoutSeconds: 600 };
/** Exactly the split preflight's requirement: 2 × MAX. */
const ENOUGH = 2 * MAX;

type SplitTarget = "mp4" | "webm";

/** The two rows of SPLIT-01's closed pair table, each with a video preset. */
const PAIR_SHAPE = {
  mp4: { video: "mp4", audio: "m4a", preset: "preset:1080", quality: "1080" },
  webm: { video: "webm", audio: "webm", preset: "preset:720", quality: "720" },
} as const;

type PairIds = { video: string; audio: string };

/** A valid split preset source, parsed by the REAL schema rather than cast. */
function splitSource(target: SplitTarget, ids: PairIds = { video: "137", audio: "140" }): GenericPresetSource {
  const shape = PAIR_SHAPE[target];
  return GenericPresetSourceSchema.parse({
    kind: "split",
    pair: {
      video: {
        formatId: ids.video,
        protocol: "https",
        container: shape.video,
        hasVideo: true,
        hasAudio: false,
        videoConstraint: "codec-present",
        audioConstraint: "absent",
        fileSize: null,
      },
      audio: {
        formatId: ids.audio,
        protocol: "https",
        container: shape.audio,
        hasVideo: false,
        hasAudio: true,
        videoConstraint: "absent",
        audioConstraint: "codec-present",
        fileSize: null,
      },
    },
  });
}

/** Public generic metadata for one advertised video preset. */
function presetMeta(preset: { id: string; container: string; hasVideo: boolean }): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "A Split Clip",
    thumbnail: null,
    duration: 120,
    source: "example.invalid",
    extractor: "yt-dlp",
    webpageUrl: SPLIT_URL,
    formats: [],
    presets: [
      {
        id: preset.id,
        label: preset.id,
        resolution: preset.hasVideo ? "1080p" : "audio",
        container: preset.container,
        fileSize: null,
        hasVideo: preset.hasVideo,
        hasAudio: true,
        formatId: preset.id,
        videoCodec: preset.hasVideo ? "h264" : null,
        audioCodec: "aac",
        fps: null,
      },
    ],
    // Left exactly as generic analysis reports it today: SPLIT-04 does not
    // change `capabilities.merge` (§32).
    capabilities: { mp3: true, merge: false },
  });
}

function splitAnalysis(target: SplitTarget, ids?: PairIds): ExecutionAnalysis {
  const shape = PAIR_SHAPE[target];
  return {
    strategy: "yt-dlp",
    video: presetMeta({ id: shape.preset, container: target, hasVideo: true }),
    selections: { [shape.preset]: splitSource(target, ids) },
  };
}

type SinglePreset = "preset:1080" | "preset:audio" | "preset:mp3";

/** A muxed single source: keep-original / extract-m4a / extract-mp3. */
function singleAnalysis(presetId: SinglePreset): ExecutionAnalysis {
  const container = presetId === "preset:1080" ? "mp4" : presetId === "preset:audio" ? "m4a" : "mp3";
  return {
    strategy: "yt-dlp",
    video: presetMeta({ id: presetId, container, hasVideo: presetId === "preset:1080" }),
    selections: {
      [presetId]: GenericPresetSourceSchema.parse({
        kind: "single",
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
      }),
    },
  };
}

function directAnalysis(): ExecutionAnalysis {
  return {
    strategy: "direct",
    video: VideoMetadataSchema.parse({
      title: "direct clip",
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
          videoCodec: "h264",
          audioCodec: "aac",
          bitrate: null,
          fileSize: 8,
          hasVideo: true,
          hasAudio: true,
          formatNote: null,
        },
      ],
      presets: [],
      capabilities: { mp3: false, merge: false },
    }),
    selections: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** Store calls that mark lifecycle order, recorded into `trace`. */
const TRACED_STORE_CALLS = new Set([
  "completeAnalysis",
  "beginProcessing",
  "beginUploading",
  "commitReadyFromUploading",
  "failJob",
]);

type StoreHooks = {
  /** Runs BEFORE the named store call reaches the real store. */
  before?: (name: string) => void;
  /** Replaces the named store call's result entirely (or throws). */
  override?: (name: string) => { value: unknown } | undefined;
  /** Runs AFTER the real store call returned, with its result. */
  after?: (name: string, result: unknown) => void;
};

type Harness = {
  tempDir: string;
  jobsRoot: string;
  db: DatabaseSync;
  raw: SQLiteJobStore;
  store: WorkerJobStore;
  calls: string[];
  trace: string[];
  hooks: StoreHooks;
  puts: ObjectStorePutInput[];
  uploaded: string[];
  deletes: string[];
  failPut: boolean;
  writer: ObjectStoreWriter;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "split-exec-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const raw = new SQLiteJobStore({ db });

  const calls: string[] = [];
  const trace: string[] = [];
  const hooks: StoreHooks = {};
  const store = new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const name = String(prop);
        calls.push(name);
        if (TRACED_STORE_CALLS.has(name)) trace.push(name);
        hooks.before?.(name);
        const overridden = hooks.override?.(name);
        const result = overridden
          ? overridden.value
          : (value as (...a: unknown[]) => unknown).apply(target, args);
        hooks.after?.(name, result);
        return result;
      };
    },
  }) as unknown as WorkerJobStore;

  const h = {
    tempDir,
    jobsRoot: path.join(fs.realpathSync(tempDir), "jobs"),
    db,
    raw,
    store,
    calls,
    trace,
    hooks,
    puts: [] as ObjectStorePutInput[],
    uploaded: [] as string[],
    deletes: [] as string[],
    failPut: false,
    writer: undefined as unknown as ObjectStoreWriter,
    cleanup: () => {
      db.close();
      setTempDirectoryForTests(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  } satisfies Harness;

  h.writer = {
    async put(input) {
      // The object key embeds the job id, so the fake store writer can read the
      // durable status at the exact moment the upload begins.
      const jobId = input.objectKey.split("/")[2] ?? "";
      h.trace.push(`put=${raw.getJob(jobId)?.status ?? "missing"}`);
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      if (h.failPut) throw new Error(`object store refused ${SENTINEL}`);
      h.uploaded.push(Buffer.concat(chunks).toString("utf8"));
      h.puts.push(input);
    },
    async head(key) {
      const last = h.puts.find((p) => p.objectKey === key);
      return last
        ? {
            objectKey: last.objectKey,
            contentLength: last.contentLength,
            contentType: last.contentType,
            contentDisposition: last.contentDisposition,
          }
        : null;
    },
    async delete(key) {
      h.deletes.push(key);
    },
  };
  return h;
}

function claimJob(store: WorkerJobStore, formatId: WorkerRequestedFormatId): DurableWorkerJob {
  store.createJob({ url: SPLIT_URL, formatId, principalId: "private-access-user" }, randomUUID());
  const job = store.claimNextQueuedJob();
  assert.ok(job, "a job must be claimable");
  return job;
}

function executorFor(
  h: Harness,
  deps: JobExecutorDeps,
  controllers: Map<string, AbortController> = new Map(),
): JobExecutor {
  return new JobExecutor(h.store, h.writer, () => Date.now(), controllers, {
    genericLimits: LIMITS,
    ...deps,
  });
}

const VIDEO_BYTES = "VIDEO-HALF-BYTES";
const AUDIO_BYTES = "AUDIO-HALF";
const mergedBytes = (target: string) => `MERGED-${target.toUpperCase()}-ARTIFACT`;

/** Both halves, exactly where and how SPLIT-03 leaves them. */
function writeHalves(workDir: string, target: SplitTarget): GenericSplitSourcesDownload {
  const shape = PAIR_SHAPE[target];
  const video = path.join(workDir, `video-source.${shape.video}`);
  const audio = path.join(workDir, `audio-source.${shape.audio}`);
  fs.writeFileSync(video, VIDEO_BYTES);
  fs.writeFileSync(audio, AUDIO_BYTES);
  return {
    video: { filePath: video, container: shape.video, fileSize: VIDEO_BYTES.length },
    audio: { filePath: audio, container: shape.audio, fileSize: AUDIO_BYTES.length },
    totalFileSize: VIDEO_BYTES.length + AUDIO_BYTES.length,
  };
}

type SplitCall = {
  url: string;
  workDir: string;
  plan: GenericSplitExecutionPlan;
  ctx: Parameters<DownloadGenericSplitFn>[3];
  status: string;
};

type SplitRecord = {
  capacity: Array<{ workDir: string; status: string }>;
  downloads: SplitCall[];
  merges: Array<{ opts: Parameters<MergeSplitMediaFn>[0]; status: string }>;
  single: number;
  direct: number;
  processed: number;
};

/**
 * Recording fakes for every seam a split job may touch, plus tripwires for the
 * three it must never touch. `over` replaces any of them for one test.
 */
function splitDeps(
  h: Harness,
  jobId: string,
  target: SplitTarget,
  over: Partial<JobExecutorDeps> = {},
): { deps: JobExecutorDeps; rec: SplitRecord } {
  const rec: SplitRecord = { capacity: [], downloads: [], merges: [], single: 0, direct: 0, processed: 0 };
  const status = () => h.raw.getJob(jobId)?.status ?? "missing";
  const deps: JobExecutorDeps = {
    analyzeForExecution: async () => splitAnalysis(target),
    availableWorkDirBytes: async (workDir) => {
      rec.capacity.push({ workDir, status: status() });
      h.trace.push("capacity");
      return ENOUGH;
    },
    downloadOriginal: async () => {
      rec.direct += 1;
      throw new Error("the DIRECT downloader must never run for a split job");
    },
    downloadGeneric: async () => {
      rec.single += 1;
      throw new Error("the SINGLE-source downloader must never run for a split job");
    },
    downloadGenericSplit: async (url, workDir, plan, ctx) => {
      rec.downloads.push({ url, workDir, plan, ctx, status: status() });
      h.trace.push(`download=${status()}`);
      return writeHalves(workDir, target);
    },
    processLocally: async () => {
      rec.processed += 1;
      throw new Error("a split job must never reach the ONE-input processor");
    },
    mergeSplit: async (opts) => {
      rec.merges.push({ opts, status: status() });
      h.trace.push(`merge=${status()}`);
      const out = path.join(opts.workDir, `merged.${opts.target}`);
      fs.writeFileSync(out, mergedBytes(opts.target));
      return out;
    },
    ...over,
  };
  return { deps, rec };
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// The fixture really is a split plan
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04 fixture: the injected analysis derives a real merge-split plan", () => {
  for (const target of ["mp4", "webm"] as const) {
    it(`${target}: the REAL planner turns it into merge-split -> ${target}`, () => {
      const shape = PAIR_SHAPE[target];
      const plan = deriveExecutionPlan(splitAnalysis(target), shape.preset);
      assert.equal(plan.strategy, "yt-dlp");
      assert.ok(plan.strategy === "yt-dlp");
      assert.equal(plan.generic.operation, "merge-split");
      assert.equal(plan.generic.targetContainer, target);
      assert.equal(GenericExecutionPlanSchema.safeParse(plan.generic).success, true);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §48/§49: the happy path, and the order it happens in
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: split happy path (§48/§49)", () => {
  for (const target of ["mp4", "webm"] as const) {
    it(`${target}: downloading -> capacity -> acquisition -> processing -> merge -> uploading -> ready`, async () => {
      const shape = PAIR_SHAPE[target];
      const job = claimJob(h.store, shape.preset);
      const { deps, rec } = splitDeps(h, job.jobId, target);

      await executorFor(h, deps).execute(job);

      assert.deepEqual(h.trace, [
        "completeAnalysis",
        "capacity",
        "download=downloading",
        "beginProcessing",
        "merge=processing",
        "beginUploading",
        "put=uploading",
        "commitReadyFromUploading",
      ]);

      const view = h.raw.getJob(job.jobId)!;
      assert.equal(view.status, "ready");
      assert.equal(view.extractor, "yt-dlp");
      assert.equal(view.container, target);
      assert.equal(view.mime, target === "mp4" ? "video/mp4" : "video/webm");
      assert.ok(view.filename!.endsWith(`.${target}`), view.filename!);
      assert.ok(view.filename!.includes(shape.quality), "the quality comes from the requested preset");
      assert.equal(view.quality, shape.quality);

      assert.equal(h.puts.length, 1, "exactly one object uploaded");
      assert.equal(h.puts[0]!.contentType, view.mime);
      assert.equal(h.uploaded[0], mergedBytes(target), "the uploaded bytes are the MERGE's output");
      assert.equal(h.puts[0]!.contentLength, mergedBytes(target).length);

      assert.equal(rec.downloads.length, 1, "exactly one split acquisition");
      assert.equal(rec.merges.length, 1, "exactly one merge");
      assert.equal(rec.single, 0, "the single-source downloader never ran");
      assert.equal(rec.direct, 0, "the direct downloader never ran");
      assert.equal(rec.processed, 0, "the one-input processor never ran");
    });
  }

  it("HARD GATE: download=downloading, merge=processing, upload=uploading (§3/§20)", async () => {
    const job = claimJob(h.store, "preset:1080");
    const statusesAtInvocation: string[] = [];

    const { deps } = splitDeps(h, job.jobId, "mp4", {
      downloadGenericSplit: async (_url, workDir) => {
        statusesAtInvocation.push(`download=${h.raw.getJob(job.jobId)!.status}`);
        return writeHalves(workDir, "mp4");
      },
      mergeSplit: async (opts) => {
        // The fake merge inspects the durable state at the exact moment the
        // split input ffprobe / FFmpeg merge would begin.
        statusesAtInvocation.push(`merge=${h.raw.getJob(job.jobId)!.status}`);
        const out = path.join(opts.workDir, "merged.mp4");
        fs.writeFileSync(out, mergedBytes("mp4"));
        return out;
      },
    });

    await executorFor(h, deps).execute(job);

    assert.deepEqual(statusesAtInvocation, ["download=downloading", "merge=processing"]);
    assert.ok(h.trace.includes("put=uploading"), "the writer ran only once uploading committed");
    assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8/§18/§29/§54-§56: what exactly each seam is handed
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: seam arguments are bound exactly (§8/§18)", () => {
  for (const target of ["mp4", "webm"] as const) {
    it(`${target}: the split downloader receives the job URL, workDir, the fresh plan, limits, signal and progress`, async () => {
      const job = claimJob(h.store, PAIR_SHAPE[target].preset);
      const { deps, rec } = splitDeps(h, job.jobId, target);
      await executorFor(h, deps).execute(job);

      const call = rec.downloads[0]!;
      assert.equal(call.url, SPLIT_URL, "exactly the job's own stored URL");
      assert.equal(call.workDir, path.join(h.jobsRoot, job.jobId), "the canonical per-job workDir");
      assert.equal(call.plan.operation, "merge-split");
      const approved = splitSource(target);
      assert.ok(approved.kind === "split");
      assert.deepEqual(call.plan.pair, approved.pair, "exactly the pair fresh analysis approved");
      assert.equal(call.plan.targetContainer, target);
      assert.deepEqual(call.ctx.limits, LIMITS);
      assert.ok(call.ctx.signal instanceof AbortSignal);
      assert.equal(typeof call.ctx.onProgress, "function");
      assert.deepEqual(Object.keys(call.ctx).sort(), ["limits", "onProgress", "signal"]);
    });

    it(`${target}: the merge receives video->videoPath, audio->audioPath, the plan target, one ceiling`, async () => {
      // M5 (swapped halves), M6 (wrong target) and M7 (doubled ceiling) guard.
      const job = claimJob(h.store, PAIR_SHAPE[target].preset);
      const shape = PAIR_SHAPE[target];
      const controllers = new Map<string, AbortController>();
      let registeredSignal: AbortSignal | undefined;
      const { deps, rec } = splitDeps(h, job.jobId, target, {
        mergeSplit: async (opts) => {
          registeredSignal = controllers.get(job.jobId)?.signal;
          rec.merges.push({ opts, status: h.raw.getJob(job.jobId)!.status });
          const out = path.join(opts.workDir, `merged.${opts.target}`);
          fs.writeFileSync(out, mergedBytes(opts.target));
          return out;
        },
      });
      await executorFor(h, deps, controllers).execute(job);

      const workDir = path.join(h.jobsRoot, job.jobId);
      const { opts } = rec.merges[0]!;
      assert.equal(opts.videoPath, path.join(workDir, `video-source.${shape.video}`), "the VIDEO half");
      assert.equal(opts.audioPath, path.join(workDir, `audio-source.${shape.audio}`), "the AUDIO half");
      assert.equal(opts.workDir, workDir);
      assert.equal(opts.target, target, "the plan's table-derived target, never substituted");
      assert.equal(opts.maxOutputBytes, LIMITS.maxFileSizeBytes, "ONE normal ceiling, not 2x");
      assert.equal(opts.timeoutMs, config.downloadTimeoutMs, "the one-input processing timeout policy");
      assert.ok(opts.signal instanceof AbortSignal);
      assert.equal(opts.signal, registeredSignal, "the job's own registered AbortSignal");
      assert.equal(opts.signal, rec.downloads[0]!.ctx.signal, "the same signal acquisition had");
      assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
    });
  }

  it("a merge that hands back one of the halves is refused, never uploaded (M10)", async () => {
    for (const half of ["video", "audio"] as const) {
      const local = makeHarness();
      try {
        const job = claimJob(local.store, "preset:1080");
        const { deps } = splitDeps(local, job.jobId, "mp4", {
          mergeSplit: async (opts) => (half === "video" ? opts.videoPath : opts.audioPath),
        });
        await executorFor(local, deps).execute(job);
        const view = local.raw.getJob(job.jobId)!;
        assert.equal(view.status, "failed", `${half}: a half is not a merged artifact`);
        assert.equal(view.errorCode, "PROCESSING_FAILED");
        assert.equal(local.puts.length, 0);
      } finally {
        local.cleanup();
      }
    }
    // `makeHarness` re-pointed the temp root; restore the suite harness's.
    setTempDirectoryForTests(h.tempDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7/§10/§42/§43: each plan reaches exactly ONE acquisition seam
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: acquisition routing (§10/§42/§43)", () => {
  it("TYPE: a merge-split plan cannot reach the single-source seam, nor a single plan the split seam", () => {
    // Compile-time assertions, enforced by `npm run typecheck` (tsconfig
    // includes test files): an `@ts-expect-error` that stops being an error
    // fails the typecheck. `typeOnly` is never invoked.
    const typeOnly = (
      single: DownloadGenericOriginalFn,
      split: DownloadGenericSplitFn,
      splitPlan: GenericSplitExecutionPlan,
      singlePlan: GenericSingleSourceExecutionPlan,
    ) => {
      // @ts-expect-error a merge-split plan is not a single-source plan (M3)
      void single(SPLIT_URL, "/w", splitPlan, { limits: LIMITS });
      // @ts-expect-error a single-source plan is not a merge-split plan (M4)
      void split(SPLIT_URL, "/w", singlePlan, { limits: LIMITS });
    };
    assert.equal(typeof typeOnly, "function");
  });

  it("merge-split reaches ONLY the split downloader (M3)", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4");
    await executorFor(h, deps).execute(job);
    assert.equal(rec.downloads.length, 1);
    assert.equal(rec.single, 0);
    assert.equal(rec.direct, 0);
    assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
  });

  for (const presetId of ["preset:1080", "preset:audio", "preset:mp3"] as const) {
    it(`generic single-source ${presetId} still uses ONLY downloadGeneric and the one-input path (M4)`, async () => {
      const job = claimJob(h.store, presetId);
      let singleCalls = 0;
      let splitCalls = 0;
      let merges = 0;
      let capacityCalls = 0;
      const processed: string[] = [];
      const deps: JobExecutorDeps = {
        analyzeForExecution: async () => singleAnalysis(presetId),
        downloadGeneric: async (_url, workDir, plan) => {
          singleCalls += 1;
          assert.notEqual(plan.operation, "merge-split");
          const filePath = path.join(workDir, "source.mp4");
          fs.writeFileSync(filePath, "MUXED-SOURCE");
          return { filePath, container: "mp4", mime: "video/mp4", fileSize: 12 };
        },
        downloadGenericSplit: async () => {
          splitCalls += 1;
          throw new Error("a single-source plan must never reach the split downloader");
        },
        mergeSplit: async () => {
          merges += 1;
          throw new Error("a single-source plan must never be merged");
        },
        availableWorkDirBytes: async () => {
          capacityCalls += 1;
          return 1;
        },
        processLocally: async ({ workDir, target }) => {
          processed.push(`${target}@${h.raw.getJob(job.jobId)!.status}`);
          const out = path.join(workDir, `converted.${target}`);
          fs.writeFileSync(out, "CONVERTED");
          return out;
        },
      };
      await executorFor(h, deps).execute(job);

      assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
      assert.equal(singleCalls, 1);
      assert.equal(splitCalls, 0);
      assert.equal(merges, 0);
      assert.equal(capacityCalls, 0, "the split preflight is split-only: 1 free byte changes nothing");
      const expected =
        presetId === "preset:1080" ? [] : [`${presetId === "preset:audio" ? "m4a" : "mp3"}@processing`];
      assert.deepEqual(processed, expected);
    });
  }

  it("a DIRECT job with 1 free byte is untouched by the split preflight (§42/§50)", async () => {
    const job = claimJob(h.store, "direct-original");
    let capacityCalls = 0;
    let splitCalls = 0;
    let merges = 0;
    const deps: JobExecutorDeps = {
      analyzeForExecution: async () => directAnalysis(),
      downloadOriginal: async (_url, ctx) => {
        const filePath = path.join(ctx.workDir, "source.mp4");
        fs.writeFileSync(filePath, "DIRECT");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 6 };
      },
      downloadGenericSplit: async () => {
        splitCalls += 1;
        throw new Error("unreachable");
      },
      mergeSplit: async () => {
        merges += 1;
        throw new Error("unreachable");
      },
      availableWorkDirBytes: async () => {
        capacityCalls += 1;
        return 1;
      },
    };
    await executorFor(h, deps).execute(job);
    assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
    assert.equal(h.raw.getJob(job.jobId)!.extractor, "direct");
    assert.equal(capacityCalls, 0);
    assert.equal(splitCalls, 0);
    assert.equal(merges, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §13-§15/§50: the split temp-capacity preflight
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: split temp-capacity preflight (§13-§15/§50)", () => {
  function assertRefusedBeforeAcquisition(jobId: string, rec: SplitRecord) {
    const view = h.raw.getJob(jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "PROCESSING_FAILED", "local capacity is never TOO_LARGE");
    assert.equal(view.safeErrorMessage, ERROR_MESSAGES.PROCESSING_FAILED);
    assert.equal(rec.downloads.length, 0, "no split acquisition may start");
    assert.equal(rec.merges.length, 0);
    assert.equal(h.puts.length, 0);
  }

  it("runs after completeAnalysis, while downloading, on the canonical workDir, before acquisition", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4");
    await executorFor(h, deps).execute(job);
    assert.deepEqual(rec.capacity, [{ workDir: path.join(h.jobsRoot, job.jobId), status: "downloading" }]);
    assert.ok(h.trace.indexOf("completeAnalysis") < h.trace.indexOf("capacity"));
    assert.ok(h.trace.indexOf("capacity") < h.trace.indexOf("download=downloading"));
  });

  it("exactly 2 x maxFileSizeBytes free: acquisition may start", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4", { availableWorkDirBytes: async () => 2000 });
    await executorFor(h, deps).execute(job);
    assert.equal(rec.downloads.length, 1);
    assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
  });

  it("one byte short of 2 x maxFileSizeBytes: PROCESSING_FAILED before any acquisition (M8)", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4", { availableWorkDirBytes: async () => 1999 });
    await executorFor(h, deps).execute(job);
    assertRefusedBeforeAcquisition(job.jobId, rec);
    // Text columns only: numeric timestamps can contain any digit run.
    const text = JSON.stringify(
      h.db.prepare("SELECT safe_error_message, stage_label FROM worker_jobs WHERE job_id = ?").get(job.jobId),
    );
    assert.equal(text.includes("1999"), false, "the measured capacity is never persisted");
  });

  it("an unreadable filesystem fails closed as PROCESSING_FAILED before acquisition", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4", {
      availableWorkDirBytes: async () => {
        throw new Error(`statfs EACCES ${SENTINEL}`);
      },
    });
    await executorFor(h, deps).execute(job);
    assertRefusedBeforeAcquisition(job.jobId, rec);
    assert.equal(h.raw.getJob(job.jobId)!.safeErrorMessage!.includes(SENTINEL), false);
  });

  it("a nonsensical capacity reading fails closed before acquisition", async () => {
    for (const reading of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      const job = claimJob(h.store, "preset:1080");
      const { deps, rec } = splitDeps(h, job.jobId, "mp4", { availableWorkDirBytes: async () => reading });
      await executorFor(h, deps).execute(job);
      assertRefusedBeforeAcquisition(job.jobId, rec);
    }
  });

  it("a ceiling whose double is not a positive safe integer fails closed without reading capacity", async () => {
    for (const maxFileSizeBytes of [Number.MAX_SAFE_INTEGER, 0, -1, 1.5]) {
      const job = claimJob(h.store, "preset:1080");
      const { deps, rec } = splitDeps(h, job.jobId, "mp4", {
        genericLimits: { maxFileSizeBytes, downloadTimeoutSeconds: 600 },
      });
      await executorFor(h, deps).execute(job);
      assert.equal(rec.capacity.length, 0, `${maxFileSizeBytes}: nothing to compare against`);
      assertRefusedBeforeAcquisition(job.jobId, rec);
    }
  });

  it("the production reader measures the real filesystem holding the workDir", async () => {
    const bytes = await availableBytesOnWorkDirFilesystem(h.tempDir);
    assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, String(bytes));
    await assert.rejects(() => availableBytesOnWorkDirFilesystem(path.join(h.tempDir, "absent")));
  });

  it("with NO injected reader the executor preflights the real filesystem (production default)", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4");
    delete deps.availableWorkDirBytes;
    await executorFor(h, deps).execute(job);
    assert.equal(rec.downloads.length, 1, "this host has far more than 2 x 1000 bytes free");
    assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
  });

  it("the production default refuses a requirement no real disk can meet", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4", {
      // 2 x 2^51 bytes = 4 PiB: a safe integer, and more than any test host has.
      genericLimits: { maxFileSizeBytes: 2 ** 51, downloadTimeoutSeconds: 600 },
    });
    delete deps.availableWorkDirBytes;
    await executorFor(h, deps).execute(job);
    assertRefusedBeforeAcquisition(job.jobId, rec);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §17/§22/§51: beginProcessing() returning `updated` is the ONLY door to a merge
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: no merge unless beginProcessing() returned updated (§17/§22/§51)", () => {
  function assertNothingProcessed(jobId: string, rec: SplitRecord) {
    assert.equal(rec.downloads.length, 1, "acquisition itself succeeded");
    assert.equal(rec.merges.length, 0, "no merge without a committed processing transition");
    assert.equal(h.puts.length, 0, "no upload");
    assert.ok(!h.calls.includes("beginUploading"), "beginUploading is never reached");
    assert.equal(fs.existsSync(path.join(h.jobsRoot, jobId)), false, "the acquired halves are cleaned up");
  }

  it("terminal — cancelled durably, signal NOT aborted: no merge, cancellation preserved (M2)", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4");
    // Only the durable row changes; the AbortSignal stays live, so nothing but
    // the transition's own result can stop the merge.
    h.hooks.before = (name) => {
      if (name === "beginProcessing") h.raw.cancelJob(job.jobId);
    };
    await executorFor(h, deps).execute(job);
    assert.equal(h.raw.getJob(job.jobId)!.status, "cancelled");
    assertNothingProcessed(job.jobId, rec);
  });

  it("terminal — failed by another writer: no merge, failure preserved", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4");
    h.hooks.before = (name) => {
      if (name === "beginProcessing") h.raw.failJob(job.jobId, "NETWORK_ERROR", ERROR_MESSAGES.NETWORK_ERROR);
    };
    await executorFor(h, deps).execute(job);
    assert.equal(h.raw.getJob(job.jobId)!.status, "failed");
    assert.equal(h.raw.getJob(job.jobId)!.errorCode, "NETWORK_ERROR", "the first terminal writer wins");
    assertNothingProcessed(job.jobId, rec);
  });

  it("state_conflict — the row is no longer downloading: no merge", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4");
    h.hooks.before = (name) => {
      if (name !== "beginProcessing") return;
      h.db.prepare("UPDATE worker_jobs SET status = 'processing' WHERE job_id = ?").run(job.jobId);
    };
    let result: unknown;
    h.hooks.after = (name, res) => {
      if (name === "beginProcessing") result = res;
    };
    await executorFor(h, deps).execute(job);
    assert.equal((result as { type: string }).type, "state_conflict");
    assertNothingProcessed(job.jobId, rec);
  });

  it("not_found: no merge", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4");
    h.hooks.override = (name) => (name === "beginProcessing" ? { value: { type: "not_found" } } : undefined);
    await executorFor(h, deps).execute(job);
    assertNothingProcessed(job.jobId, rec);
    assert.equal(h.raw.getJob(job.jobId)!.status, "downloading", "the executor wrote nothing further");
  });

  it("throws: no merge, and the job fails with the safe PROCESSING_FAILED", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps, rec } = splitDeps(h, job.jobId, "mp4");
    h.hooks.override = (name) => {
      if (name === "beginProcessing") throw new Error(`sqlite exploded ${SENTINEL}`);
      return undefined;
    };
    await executorFor(h, deps).execute(job);
    const view = h.raw.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "PROCESSING_FAILED");
    assert.equal(view.safeErrorMessage, ERROR_MESSAGES.PROCESSING_FAILED);
    assertNothingProcessed(job.jobId, rec);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §16/§44/§45: acquisition results are re-proven at the executor boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: malformed or mismatched acquisition results fail closed (§16/§44/§45)", () => {
  const video = (w: string, over: object = {}) => ({
    filePath: path.join(w, "video-source.mp4"),
    container: "mp4",
    fileSize: 16,
    ...over,
  });
  const audio = (w: string, over: object = {}) => ({
    filePath: path.join(w, "audio-source.m4a"),
    container: "m4a",
    fileSize: 10,
    ...over,
  });

  // [label, what the split seam hands back, the canonical refusal]
  const cases: ReadonlyArray<readonly [string, (w: string) => unknown, string]> = [
    [
      "a SINGLE-source result from the split seam",
      (w) => ({ filePath: path.join(w, "source.mp4"), container: "mp4", mime: "video/mp4", fileSize: 26 }),
      "PROCESSING_FAILED",
    ],
    ["the audio half missing", (w) => ({ video: video(w), totalFileSize: 16 }), "PROCESSING_FAILED"],
    ["the video half missing", (w) => ({ audio: audio(w), totalFileSize: 10 }), "PROCESSING_FAILED"],
    ["a total that is not the sum", (w) => ({ video: video(w), audio: audio(w), totalFileSize: 25 }), "PROCESSING_FAILED"],
    ["a zero total", (w) => ({ video: video(w), audio: audio(w), totalFileSize: 0 }), "PROCESSING_FAILED"],
    [
      "a fractional size",
      (w) => ({ video: video(w, { fileSize: 15.5 }), audio: audio(w), totalFileSize: 25.5 }),
      "PROCESSING_FAILED",
    ],
    [
      "an unsafe size",
      (w) => ({
        video: video(w, { fileSize: Number.MAX_SAFE_INTEGER + 2 }),
        audio: audio(w),
        totalFileSize: Number.MAX_SAFE_INTEGER,
      }),
      "PROCESSING_FAILED",
    ],
    ["an empty path", (w) => ({ video: video(w, { filePath: "" }), audio: audio(w), totalFileSize: 26 }), "PROCESSING_FAILED"],
    [
      "one file named as both halves",
      (w) => ({ video: video(w), audio: audio(w, { filePath: path.join(w, "video-source.mp4") }), totalFileSize: 26 }),
      "PROCESSING_FAILED",
    ],
    [
      "an extra field carrying a raw id",
      (w) => ({ video: video(w), audio: audio(w), totalFileSize: 26, formatId: "137" }),
      "PROCESSING_FAILED",
    ],
    [
      "a total over the one combined budget",
      (w) => ({
        video: video(w, { fileSize: 600 }),
        audio: audio(w, { fileSize: 401 }),
        totalFileSize: 1001,
      }),
      "TOO_LARGE",
    ],
    [
      "the video half in a container the pair did not approve",
      (w) => ({ video: video(w, { container: "webm" }), audio: audio(w), totalFileSize: 26 }),
      "FORMAT_UNAVAILABLE",
    ],
    [
      "the audio half in a container the pair did not approve",
      (w) => ({ video: video(w), audio: audio(w, { container: "mp4" }), totalFileSize: 26 }),
      "FORMAT_UNAVAILABLE",
    ],
  ];

  for (const [label, build, code] of cases) {
    it(`${label} -> ${code}, and nothing is merged`, async () => {
      const job = claimJob(h.store, "preset:1080");
      const { deps, rec } = splitDeps(h, job.jobId, "mp4", {
        // Deliberately typed past: this simulates a BROKEN split implementation.
        downloadGenericSplit: async (_u, workDir) => {
          writeHalves(workDir, "mp4");
          return build(workDir) as GenericSplitSourcesDownload;
        },
      });
      await executorFor(h, deps).execute(job);
      const view = h.raw.getJob(job.jobId)!;
      assert.equal(view.status, "failed");
      assert.equal(view.errorCode, code);
      assert.equal(view.safeErrorMessage, ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES]);
      assert.ok(!h.calls.includes("beginProcessing"), "processing is never entered");
      assert.equal(rec.merges.length, 0);
      assert.equal(h.puts.length, 0);
    });
  }

  it("a SPLIT-shaped result from a single-source seam fails closed, generic and direct alike", async () => {
    const splitShaped = (w: string) =>
      ({ video: video(w), audio: audio(w), totalFileSize: 26 }) as unknown as {
        filePath: string;
        container: string;
        mime: string;
        fileSize: number;
      };
    for (const kind of ["generic", "direct"] as const) {
      const job = claimJob(h.store, kind === "generic" ? "preset:audio" : "direct-original");
      let processed = 0;
      const deps: JobExecutorDeps = {
        analyzeForExecution: async () => (kind === "generic" ? singleAnalysis("preset:audio") : directAnalysis()),
        downloadGeneric: async (_u, workDir) => splitShaped(workDir),
        downloadOriginal: async (_u, ctx) => splitShaped(ctx.workDir),
        processLocally: async () => {
          processed += 1;
          throw new Error("unreachable");
        },
      };
      await executorFor(h, deps).execute(job);
      const view = h.raw.getJob(job.jobId)!;
      assert.equal(view.status, "failed", kind);
      assert.equal(view.errorCode, "PROCESSING_FAILED", kind);
      assert.equal(processed, 0, `${kind}: a pair is never processed as one input`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §60: canonical errors only — never raw subprocess text, paths or ids
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: split-path errors are persisted canonically (§60)", () => {
  const RAW = `yt-dlp/ffmpeg said ${SENTINEL} at /private/jobs/video-source.mp4 for format 137 {"streams":[]}`;

  function assertCanonicalFailure(jobId: string, code: keyof typeof ERROR_MESSAGES) {
    const view = h.raw.getJob(jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, code);
    assert.equal(view.safeErrorMessage, ERROR_MESSAGES[code]);
    // Only the TEXT columns: numeric timestamps can contain any digit run.
    const text = JSON.stringify(
      h.db
        .prepare("SELECT error_code, safe_error_message, stage_label, filename FROM worker_jobs WHERE job_id = ?")
        .get(jobId),
    );
    for (const leak of [SENTINEL, "video-source", "format 137", "streams"]) {
      assert.equal(text.includes(leak), false, `${leak} reached the durable row`);
    }
    const row = JSON.stringify(h.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId));
    assert.equal(row.includes(SENTINEL), false, "the raw text reached the durable row");
  }

  for (const code of ["FORMAT_UNAVAILABLE", "NETWORK_ERROR", "TIMEOUT", "TOO_LARGE", "PROCESSING_FAILED"] as const) {
    it(`split acquisition ${code}`, async () => {
      const job = claimJob(h.store, "preset:1080");
      const { deps, rec } = splitDeps(h, job.jobId, "mp4", {
        downloadGenericSplit: async () => {
          throw new AppError(code, RAW);
        },
      });
      await executorFor(h, deps).execute(job);
      assertCanonicalFailure(job.jobId, code);
      assert.equal(rec.merges.length, 0);
    });
  }

  for (const code of ["PROCESSING_FAILED", "TIMEOUT", "TOO_LARGE"] as const) {
    it(`split merge ${code}`, async () => {
      const job = claimJob(h.store, "preset:1080");
      const { deps } = splitDeps(h, job.jobId, "mp4", {
        mergeSplit: async () => {
          throw new AppError(code, RAW);
        },
      });
      await executorFor(h, deps).execute(job);
      assertCanonicalFailure(job.jobId, code);
      assert.ok(!h.calls.includes("beginUploading"));
      assert.equal(h.puts.length, 0);
    });
  }

  const badArtifacts: ReadonlyArray<readonly [string, (workDir: string) => string]> = [
    [
      "a symlink",
      (w) => {
        const out = path.join(w, "merged.mp4");
        fs.symlinkSync(path.join(w, "video-source.mp4"), out);
        return out;
      },
    ],
    [
      "an empty file",
      (w) => {
        const out = path.join(w, "merged.mp4");
        fs.writeFileSync(out, "");
        return out;
      },
    ],
    [
      "a file outside the job directory",
      () => {
        const out = path.join(h.tempDir, "merged.mp4");
        fs.writeFileSync(out, mergedBytes("mp4"));
        return out;
      },
    ],
  ];
  for (const [label, produce] of badArtifacts) {
    it(`final local validation refuses ${label} as PROCESSING_FAILED`, async () => {
      const job = claimJob(h.store, "preset:1080");
      const { deps } = splitDeps(h, job.jobId, "mp4", {
        mergeSplit: async (opts) => produce(opts.workDir),
      });
      await executorFor(h, deps).execute(job);
      assertCanonicalFailure(job.jobId, "PROCESSING_FAILED");
      assert.ok(!h.calls.includes("beginUploading"), "validation precedes the uploading transition");
    });
  }

  it("an object-store failure is PROCESSING_FAILED, with no storage text", async () => {
    const job = claimJob(h.store, "preset:1080");
    h.failPut = true;
    const { deps } = splitDeps(h, job.jobId, "mp4");
    await executorFor(h, deps).execute(job);
    assertCanonicalFailure(job.jobId, "PROCESSING_FAILED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §27/§63: the executor's finally removes the job directory on EVERY outcome
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: the per-job workDir is removed after every split outcome (§27/§63)", () => {
  type Scenario = (ctx: { jobId: string; active: { executor?: JobExecutor } }) => Partial<JobExecutorDeps>;
  const scenarios: ReadonlyArray<readonly [string, Scenario]> = [
    ["success", () => ({})],
    ["capacity failure", () => ({ availableWorkDirBytes: async () => 0 })],
    [
      "acquisition failure after a partial half",
      () => ({
        downloadGenericSplit: async (_u, workDir) => {
          fs.writeFileSync(path.join(workDir, "video-source.mp4"), VIDEO_BYTES);
          fs.writeFileSync(path.join(workDir, "audio-source.m4a.part"), "PARTIAL");
          throw new AppError("NETWORK_ERROR");
        },
      }),
    ],
    [
      "beginProcessing conflict",
      ({ jobId }) => {
        h.hooks.before = (name) => {
          if (name === "beginProcessing") h.raw.cancelJob(jobId);
        };
        return {};
      },
    ],
    ["merge failure", () => ({ mergeSplit: async () => Promise.reject(new AppError("PROCESSING_FAILED")) })],
    ["merge timeout", () => ({ mergeSplit: async () => Promise.reject(new AppError("TIMEOUT")) })],
    ["merged artifact TOO_LARGE", () => ({ mergeSplit: async () => Promise.reject(new AppError("TOO_LARGE")) })],
    [
      "final validation failure",
      () => ({
        mergeSplit: async (opts) => {
          const out = path.join(opts.workDir, "merged.mp4");
          fs.writeFileSync(out, "");
          return out;
        },
      }),
    ],
    [
      "upload failure",
      () => {
        h.failPut = true;
        return {};
      },
    ],
    [
      "cancellation during the merge",
      ({ jobId, active }) => ({
        mergeSplit: async () => {
          active.executor!.cancel(jobId);
          throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
        },
      }),
    ],
  ];

  for (const [label, scenario] of scenarios) {
    it(label, async () => {
      const job = claimJob(h.store, "preset:1080");
      const active: { executor?: JobExecutor } = {};
      const { deps, rec } = splitDeps(h, job.jobId, "mp4", scenario({ jobId: job.jobId, active }));
      const executor = executorFor(h, deps);
      active.executor = executor;
      await executor.execute(job);

      const workDir = path.join(h.jobsRoot, job.jobId);
      assert.equal(rec.capacity[0]?.workDir ?? workDir, workDir);
      assert.equal(fs.existsSync(workDir), false, `${label}: the job workDir must be gone`);
      assert.equal(executor.activeJobCount, 0, `${label}: the controller is released`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §23/§24/§57: cancellation across the split lifecycle (injected seams; the
// real-primitive cases live in split-execution-primitives.server.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: cancellation matrix (§23/§24/§57)", () => {
  function assertCancelledWithoutMerge(jobId: string, rec: SplitRecord) {
    assert.equal(h.raw.getJob(jobId)!.status, "cancelled", "the durable cancellation is authoritative");
    assert.equal(rec.merges.length, 0, "a cancelled job is never merged");
    assert.equal(h.puts.length, 0, "nothing is uploaded");
    assert.ok(!h.calls.includes("failJob"), "a user cancellation is never an ordinary failure");
  }

  function setup(over: (active: { executor?: JobExecutor }, jobId: string) => Partial<JobExecutorDeps>) {
    const job = claimJob(h.store, "preset:1080");
    const active: { executor?: JobExecutor } = {};
    const { deps, rec } = splitDeps(h, job.jobId, "mp4", over(active, job.jobId));
    const executor = executorFor(h, deps);
    active.executor = executor;
    return { job, active, rec, executor };
  }

  it("before acquisition: a cancel during the capacity preflight starts no acquisition", async () => {
    const { job, rec, executor } = setup((active, jobId) => ({
      availableWorkDirBytes: async () => {
        active.executor!.cancel(jobId);
        return ENOUGH;
      },
    }));
    await executor.execute(job);
    assert.equal(rec.downloads.length, 0, "no split acquisition after an observed cancel");
    assertCancelledWithoutMerge(job.jobId, rec);
  });

  it("during acquisition: the abort reaches the split downloader and processing never begins", async () => {
    let sawAbort = false;
    const { job, rec, executor } = setup((active, jobId) => ({
      downloadGenericSplit: (_u, _w, _p, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
            },
            { once: true },
          );
          setTimeout(() => active.executor!.cancel(jobId), 5);
        }),
    }));
    await executor.execute(job);
    assert.equal(sawAbort, true);
    assert.ok(!h.calls.includes("beginProcessing"));
    assertCancelledWithoutMerge(job.jobId, rec);
  });

  it("after acquisition succeeded: a pair already on disk never forces a merge", async () => {
    const { job, rec, executor } = setup((active, jobId) => ({
      downloadGenericSplit: async (_u, workDir) => {
        const res = writeHalves(workDir, "mp4");
        active.executor!.cancel(jobId);
        return res;
      },
    }));
    await executor.execute(job);
    assert.ok(h.calls.includes("beginProcessing"), "the transition is attempted — and loses");
    assertCancelledWithoutMerge(job.jobId, rec);
  });

  it("at the transition: a cancel landing just before beginProcessing prevents the merge", async () => {
    const { job, active, rec, executor } = setup(() => ({}));
    h.hooks.before = (name) => {
      if (name === "beginProcessing") active.executor!.cancel(job.jobId);
    };
    await executor.execute(job);
    assertCancelledWithoutMerge(job.jobId, rec);
  });

  it("after beginProcessing committed: the cancel is observed before the merge starts", async () => {
    const { job, active, rec, executor } = setup(() => ({}));
    let transition = "";
    h.hooks.after = (name, res) => {
      if (name !== "beginProcessing") return;
      transition = (res as { type: string }).type;
      active.executor!.cancel(job.jobId);
    };
    await executor.execute(job);
    assert.equal(transition, "updated", "processing really had committed");
    assertCancelledWithoutMerge(job.jobId, rec);
  });

  it("an abort of the signal alone after beginProcessing still prevents the merge", async () => {
    const job = claimJob(h.store, "preset:1080");
    const controllers = new Map<string, AbortController>();
    const { deps, rec } = splitDeps(h, job.jobId, "mp4");
    h.hooks.after = (name) => {
      if (name === "beginProcessing") controllers.get(job.jobId)?.abort(new AppError("PROCESSING_FAILED"));
    };
    await executorFor(h, deps, controllers).execute(job);
    assert.equal(rec.merges.length, 0, "checkCancelled stops the merge");
    assert.equal(h.raw.getJob(job.jobId)!.status, "failed", "an unmarked abort is an ordinary failure");
    assert.equal(h.puts.length, 0);
  });

  it("during the merge: the job's signal reaches the merger and uploading never begins", async () => {
    let sawAbort = false;
    const { job, rec, executor } = setup((active, jobId) => ({
      mergeSplit: (opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
            },
            { once: true },
          );
          setTimeout(() => active.executor!.cancel(jobId), 5);
        }),
    }));
    await executor.execute(job);
    assert.equal(sawAbort, true, "the caller's signal reached SPLIT-02");
    assert.ok(!h.calls.includes("beginUploading"));
    assertCancelledWithoutMerge(job.jobId, rec);
  });

  it("after the merge, before upload: beginUploading loses and nothing is uploaded", async () => {
    const { job, rec, executor } = setup((active, jobId) => ({
      mergeSplit: async (opts) => {
        const out = path.join(opts.workDir, "merged.mp4");
        fs.writeFileSync(out, mergedBytes("mp4"));
        active.executor!.cancel(jobId);
        return out;
      },
    }));
    await executor.execute(job);
    assert.ok(h.calls.includes("beginUploading"), "the uploading transition is attempted — and loses");
    assertCancelledWithoutMerge(job.jobId, rec);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §25/§26/§62: operator shutdown leaves the row active for recover()
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: operator shutdown and restart recovery (§25/§26/§62)", () => {
  async function waitFor(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function assertRestartRecovered(jobId: string) {
    h.raw.recover();
    const view = h.raw.getJob(jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "PROCESSING_FAILED");
    assert.equal(view.safeErrorMessage, "Worker restarted before the job completed.");
    assert.equal(view.stageLabel, "Worker restarted");
    assert.equal(view.extractor, "yt-dlp");
  }

  const blockUntilAbort = (signal?: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new AppError("PROCESSING_FAILED", "process group terminated")),
        { once: true },
      );
    });

  for (const phase of ["downloading", "processing"] as const) {
    it(`shutdown while ${phase}: row stays ${phase}, workDir removed, no failJob, recover() classifies`, async () => {
      const job = claimJob(h.store, "preset:1080");
      let entered = false;
      const over: Partial<JobExecutorDeps> =
        phase === "downloading"
          ? {
              downloadGenericSplit: async (_u, workDir, _p, ctx) => {
                fs.writeFileSync(path.join(workDir, "video-source.mp4"), VIDEO_BYTES);
                entered = true;
                return blockUntilAbort(ctx.signal);
              },
            }
          : {
              mergeSplit: async (opts) => {
                fs.writeFileSync(path.join(opts.workDir, "merged.mp4.partial"), "PARTIAL");
                entered = true;
                return blockUntilAbort(opts.signal);
              },
            };
      const { deps, rec } = splitDeps(h, job.jobId, "mp4", over);
      const executor = executorFor(h, deps);
      const execution = executor.execute(job);

      await waitFor(() => entered, `${phase} to be in flight`);
      assert.equal(h.raw.getJob(job.jobId)!.status, phase);
      assert.equal(executor.abortActiveForShutdown(), 1, "exactly the one active execution");
      await execution;

      const interrupted = h.raw.getJob(job.jobId)!;
      assert.equal(interrupted.status, phase, "the interrupted row stays ACTIVE");
      assert.equal(interrupted.errorCode, null);
      assert.ok(!h.calls.includes("failJob"), "the dying process commits no ordinary failure");
      assert.ok(!h.calls.includes("cancelJob"), "a shutdown is not a user cancellation");
      assert.equal(fs.existsSync(path.join(h.jobsRoot, job.jobId)), false, "the old process cleaned up");
      assert.equal(h.puts.length, 0);
      if (phase === "downloading") assert.equal(rec.merges.length, 0);
      assertRestartRecovered(job.jobId);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §58: acquisition progress ends when acquisition does
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: late acquisition progress cannot touch a processing job (§58)", () => {
  it("a callback fired after beginProcessing writes nothing, aborts nothing, and the job completes", async () => {
    const job = claimJob(h.store, "preset:1080");
    type Report = NonNullable<Parameters<DownloadGenericSplitFn>[3]["onProgress"]>;
    let late: Report | undefined;
    let writesByLateCallback = -1;
    let abortedByLateCallback: boolean | undefined;
    let progressDuringMerge: number | null = null;

    const { deps } = splitDeps(h, job.jobId, "mp4", {
      downloadGenericSplit: async (_u, workDir, _p, ctx) => {
        // Live progress is persisted as ordinary downloading progress.
        ctx.onProgress?.({ progress: 40, downloadedBytes: 10, stage: "Downloading" });
        late = ctx.onProgress;
        return writeHalves(workDir, "mp4");
      },
      mergeSplit: async (opts) => {
        const writes = () => h.calls.filter((c) => c === "updateExecutionProgress").length;
        const before = writes();
        // A misbehaving acquisition reports AFTER it returned, while processing.
        late?.({ progress: 100, downloadedBytes: 26, stage: "Downloading" });
        writesByLateCallback = writes() - before;
        abortedByLateCallback = opts.signal?.aborted;
        progressDuringMerge = h.raw.getJob(job.jobId)!.progress;
        const out = path.join(opts.workDir, "merged.mp4");
        fs.writeFileSync(out, mergedBytes("mp4"));
        return out;
      },
    });
    await executorFor(h, deps).execute(job);

    assert.equal(writesByLateCallback, 0, "no durable progress write is even attempted");
    assert.equal(abortedByLateCallback, false, "the execution is not aborted");
    assert.equal(progressDuringMerge, 40, "the live report was persisted; the late one was not");
    assert.equal(h.raw.getJob(job.jobId)!.status, "ready");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §61: both raw source ids stay in process memory
// ─────────────────────────────────────────────────────────────────────────────

describe("SPLIT-04: neither raw source id leaves process memory (§61)", () => {
  const ids = { video: `v-${SENTINEL}`, audio: `a-${SENTINEL}` };

  it("no raw id in the durable row, job view, filename, quality, MIME, object metadata or logs", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps } = splitDeps(h, job.jobId, "mp4", { analyzeForExecution: async () => splitAnalysis("mp4", ids) });

    const logged: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const saved = methods.map((m) => console[m]);
    for (const m of methods) {
      console[m] = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
    }
    try {
      await executorFor(h, deps).execute(job);
    } finally {
      methods.forEach((m, i) => {
        console[m] = saved[i]!;
      });
    }

    const view = h.raw.getJob(job.jobId)!;
    assert.equal(view.status, "ready");
    const row = JSON.stringify(h.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(job.jobId));
    const put = h.puts[0]!;
    for (const [where, text] of [
      ["durable row", row],
      ["job view (the Worker's public job response)", JSON.stringify(view)],
      ["filename", String(view.filename)],
      ["quality", String(view.quality)],
      ["MIME", String(view.mime)],
      ["object key", put.objectKey],
      ["content-disposition", put.contentDisposition],
      ["content-type", put.contentType],
      ["logs", logged.join("\n")],
    ] as const) {
      assert.equal(text.includes(SENTINEL), false, `a raw source id reached the ${where}`);
    }
    assert.equal(view.quality, "1080", "quality comes from the requested preset only");
  });

  it("a FAILED split job's durable error carries no raw id either", async () => {
    const job = claimJob(h.store, "preset:1080");
    const { deps } = splitDeps(h, job.jobId, "mp4", {
      analyzeForExecution: async () => splitAnalysis("mp4", ids),
      mergeSplit: async () => {
        throw new AppError("PROCESSING_FAILED", `could not merge ${ids.video}+${ids.audio}`);
      },
    });
    await executorFor(h, deps).execute(job);
    const row = JSON.stringify(h.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(job.jobId));
    assert.equal(h.raw.getJob(job.jobId)!.status, "failed");
    assert.equal(row.includes(SENTINEL), false);
  });
});
