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
import {
  VideoMetadataSchema,
  type WorkerRequestedFormatId,
  type WorkerVideoMetadata,
} from "@/shared/worker/contracts";
import type { DurableWorkerJob, WorkerJobStore } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import { analyzeGenericMediaInternal } from "../analysis/ytdlp-analysis.server.ts";
import type { ClearHlsAcquiredTs } from "../hls/hls-execution.server.ts";
import { AGGREGATE_FILE_NAME } from "../hls/hls-fragment-acquisition.server.ts";
import { HLS_OUTPUT_FILE_NAME } from "../hls/hls-processing.server.ts";
import type { ClearHlsMediaPlaylistSelections } from "../hls/hls-source-selection.ts";
import { deriveClearHlsExecutionPlan } from "./format-plan.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";

/**
 * HLS-6 + HLS-7: the clear-HLS job lifecycle, end to end.
 *
 * Everything is a fake — a fake analyzer, fake HLS primitives, a fake object
 * store, a real SQLite store and a real temp filesystem. No network, no DNS, no
 * subprocess, no public media site.
 *
 * The load-bearing assertions are about ORDER: what the durable status says at
 * the exact instant HLS-2 runs, at the exact instant HLS-3 runs, and at the
 * exact instant HLS-4 would be invoked.
 *
 * ─── Two ways to reach the branch ───────────────────────────────────────────
 *
 * Section I is the HLS-7 activation proof: the REAL generic analyzer over a
 * canned document, and the ORDINARY `deriveExecutionPlan()` — nothing injected
 * — reach the HLS branch and a `ready` job.
 *
 * Sections A–G keep the HLS-6 matrix, which drives the branch in isolation
 * through the internal `derivePlanForExecution` seam, calling
 * `deriveClearHlsExecutionPlan()` explicitly on a hand-built analysis. That is
 * still the cleanest way to aim a failure, a cancellation or a shutdown at one
 * precise stage. The seam is not user-controlled, not read from the environment
 * or configuration, and the Production runtime never supplies one — pinned in
 * `hls-execution-plan.test.ts`.
 */

const VERY_PRIVATE_HLS_TOKEN = "VERY_PRIVATE_HLS_TOKEN";
const PLAYLIST_URL = `https://media.example.invalid/hls/1080/media.m3u8?sig=${VERY_PRIVATE_HLS_TOKEN}`;
const PAGE_URL = "https://example.invalid/watch/abc";
const MP4_BYTES = "REMUXED-MP4-BYTES";

/**
 * A hand-built HLS-ONLY analysis for the injected-derivation matrix: no
 * progressive preset, and the private map carries the rung. It advertises
 * NOTHING publicly, so the ordinary planner refuses it (section H) — which is
 * exactly why sections A–G derive their plan explicitly. Nothing can pass here
 * by accidentally selecting a progressive source.
 */
function hlsOnlyAnalysis(
  hlsSelections: ClearHlsMediaPlaylistSelections = Object.freeze({
    "preset:1080": Object.freeze({ playlistUrl: PLAYLIST_URL, height: 1080 }),
  }),
): ExecutionAnalysis {
  return {
    strategy: "yt-dlp",
    video: meta(),
    selections: {},
    hlsSelections,
  };
}

function meta(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "An HLS Clip",
    thumbnail: null,
    duration: 120,
    source: "example.invalid",
    extractor: "yt-dlp",
    webpageUrl: PAGE_URL,
    formats: [],
    presets: [],
    capabilities: { mp3: false, merge: false },
  });
}

/**
 * The HLS-6 test seam: derive the clear-HLS plan explicitly from the fresh
 * analysis's private map — the same derivation the ordinary planner has
 * dispatched to since HLS-7, minus its ownership and advertising checks.
 */
const deriveHlsPlan: NonNullable<JobExecutorDeps["derivePlanForExecution"]> = (
  analysis,
  requestedFormatId,
) => ({
  strategy: "yt-dlp",
  generic: deriveClearHlsExecutionPlan(
    (analysis as ExecutionAnalysis).hlsSelections,
    requestedFormatId,
  ),
});

type Harness = {
  tempDir: string;
  raw: SQLiteJobStore;
  store: WorkerJobStore;
  calls: string[];
  puts: ObjectStorePutInput[];
  deletes: string[];
  writer: ObjectStoreWriter;
  putFails: boolean;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hls-exec-"));
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
  const h: Harness = {
    tempDir,
    raw,
    store,
    calls,
    puts,
    deletes,
    putFails: false,
    writer: {
      async put(input) {
        if (h.putFails) throw new Error("object store unavailable");
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
      async delete(key) {
        deletes.push(key);
      },
    },
    cleanup: () => {
      db.close();
      setTempDirectoryForTests(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
  return h;
}

function claimJob(store: WorkerJobStore, formatId: WorkerRequestedFormatId): DurableWorkerJob {
  store.createJob({ url: PAGE_URL, formatId, principalId: "private-access-user" }, randomUUID());
  const job = store.claimNextQueuedJob();
  assert.ok(job, "a job must be claimable");
  return job;
}

/** What the real HLS-3 commits: a frozen artifact at the fixed aggregate name. */
function writeAggregate(workDir: string): ClearHlsAcquiredTs {
  const filePath = path.join(workDir, AGGREGATE_FILE_NAME);
  fs.writeFileSync(filePath, "MPEG-TS-AGGREGATE-BYTES");
  return Object.freeze({
    filePath,
    segmentType: "mpegts" as const,
    fileSize: fs.statSync(filePath).size,
  });
}

/** What the real HLS-4 commits: the remuxed MP4 at the fixed output name. */
function writeOutput(workDir: string) {
  const filePath = path.join(workDir, HLS_OUTPUT_FILE_NAME);
  fs.writeFileSync(filePath, MP4_BYTES);
  return Object.freeze({
    filePath,
    container: "mp4" as const,
    fileSize: fs.statSync(filePath).size,
  });
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

/** The whole happy-path dependency set, with per-case overrides. */
function hlsDeps(over: Partial<JobExecutorDeps> = {}): JobExecutorDeps {
  return {
    analyzeForExecution: async () => hlsOnlyAnalysis(),
    derivePlanForExecution: deriveHlsPlan,
    acquireClearHls: async (_plan, workDir) => writeAggregate(workDir),
    processClearHls: async ({ workDir }) => writeOutput(workDir),
    // Every seam HLS must NOT touch, wired to fail loudly.
    downloadOriginal: async () => {
      throw new Error("the DIRECT downloader must never run for an HLS job");
    },
    downloadGeneric: async () => {
      throw new Error("the progressive yt-dlp downloader must never run for an HLS job");
    },
    downloadGenericSplit: async () => {
      throw new Error("the split downloader must never run for an HLS job");
    },
    processLocally: async () => {
      throw new Error("convertMedia must never run for an HLS job");
    },
    mergeSplit: async () => {
      throw new Error("mergeSplitMedia must never run for an HLS job");
    },
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. THE SUCCESS PATH (§40)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 lifecycle: a dormant clear-HLS job reaches ready", () => {
  it("runs queued -> ready through the normal upload lifecycle", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps());
    await executor.execute(job);

    const final = h.raw.getJob(job.jobId);
    assert.equal(final?.status, "ready");
    // The strategy persisted is the Worker's own closed vocabulary value. The
    // durable extractor column gains no `"hls"` member.
    assert.equal(final?.extractor, "yt-dlp");

    assert.equal(h.puts.length, 1, "exactly one object uploaded");
    const put = h.puts[0]!;
    assert.equal(put.contentType, "video/mp4");
    assert.equal(put.contentLength, MP4_BYTES.length, "the MP4's size, not the TS aggregate's");
    assert.match(put.contentDisposition ?? "", /\.mp4/);

    // The upload lifecycle is the existing one, unchanged.
    assert.ok(h.calls.includes("beginUploading"));
    assert.ok(h.calls.includes("completeAnalysis"));
    assert.ok(h.calls.includes("beginProcessing"));
  });

  it("uploads the MP4, never the MPEG-TS aggregate", async () => {
    const job = claimJob(h.store, "preset:1080");
    let aggregateSize = 0;
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (_plan, workDir) => {
          const acquired = writeAggregate(workDir);
          aggregateSize = acquired.fileSize;
          return acquired;
        },
      }),
    );
    await executor.execute(job);

    assert.notEqual(aggregateSize, MP4_BYTES.length, "the fixture sizes must differ");
    assert.equal(h.puts[0]!.contentLength, MP4_BYTES.length);
    assert.equal(h.puts[0]!.contentType, "video/mp4");
    assert.equal(h.puts[0]!.contentDisposition?.includes(".ts"), false);
  });

  it("uses NO yt-dlp, direct or FFmpeg seam anywhere on the path", async () => {
    // Every forbidden seam in `hlsDeps()` throws, so reaching `ready` is itself
    // the proof. Asserted explicitly so the intent survives a refactor of the
    // fixture.
    const job = claimJob(h.store, "preset:1080");
    let hlsAcquisitions = 0;
    let hlsProcessings = 0;
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (_plan, workDir) => {
          hlsAcquisitions += 1;
          return writeAggregate(workDir);
        },
        processClearHls: async ({ workDir }) => {
          hlsProcessings += 1;
          return writeOutput(workDir);
        },
      }),
    );
    await executor.execute(job);

    assert.equal(h.raw.getJob(job.jobId)?.status, "ready");
    assert.equal(hlsAcquisitions, 1, "exactly one HLS acquisition");
    assert.equal(hlsProcessings, 1, "exactly one HLS remux");
  });

  it("gives HLS acquisition the plan and this job's workDir — and no page URL", async () => {
    const job = claimJob(h.store, "preset:1080");
    let seenPlan: unknown;
    let seenWorkDir = "";
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (plan, workDir, ctx) => {
          seenPlan = plan;
          seenWorkDir = workDir;
          assert.ok(ctx.signal instanceof AbortSignal);
          return writeAggregate(workDir);
        },
      }),
    );
    await executor.execute(job);

    assert.deepEqual(seenPlan, {
      strategy: "yt-dlp",
      operation: "clear-hls-remux",
      requestedFormatId: "preset:1080",
      source: { playlistUrl: PLAYLIST_URL, height: 1080 },
      targetContainer: "mp4",
    });
    // The canonical per-job directory this execution created. Compared through
    // `realpath` because the platform temp root may itself be a symlink.
    assert.ok(path.isAbsolute(seenWorkDir));
    assert.ok(
      fs.realpathSync(path.dirname(seenWorkDir)).startsWith(fs.realpathSync(h.tempDir)),
      "the server-owned per-job directory",
    );
    assert.equal(seenWorkDir.includes(job.jobId), true);
  });

  it("hands HLS-4 the EXACT artifact HLS-3 returned", async () => {
    const job = claimJob(h.store, "preset:1080");
    let acquired: ClearHlsAcquiredTs | null = null;
    let processedSource: unknown;
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (_plan, workDir) => {
          acquired = writeAggregate(workDir);
          return acquired;
        },
        processClearHls: async ({ source, workDir, maxOutputBytes, timeoutMs }) => {
          processedSource = source;
          assert.ok(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0);
          assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
          return writeOutput(workDir);
        },
      }),
    );
    await executor.execute(job);

    assert.ok(acquired);
    assert.equal(processedSource, acquired, "the same object, never a path reconstruction");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. THE PROCESSING BOUNDARY — HARD GATE (§23)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 boundary: HLS-2/HLS-3 while downloading, HLS-4 only after processing", () => {
  it("observes the durable status at each primitive, in order", async () => {
    const job = claimJob(h.store, "preset:1080");
    const observed: string[] = [];
    const at = (label: string) =>
      observed.push(`${label}:${h.raw.getJob(job.jobId)?.status ?? "missing"}`);

    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        // The seam is composed HERE so each primitive can be observed
        // separately, exactly as the production seam composes them.
        acquireClearHls: async (_plan, workDir) => {
          at("hls-2-preflight");
          at("hls-3-acquisition");
          return writeAggregate(workDir);
        },
        processClearHls: async ({ workDir }) => {
          at("hls-4-processing");
          return writeOutput(workDir);
        },
      }),
    );

    const originalPut = h.writer.put.bind(h.writer);
    h.writer.put = async (input) => {
      at("upload");
      return originalPut(input);
    };

    await executor.execute(job);

    assert.deepEqual(observed, [
      "hls-2-preflight:downloading",
      "hls-3-acquisition:downloading",
      "hls-4-processing:processing",
      "upload:uploading",
    ]);
    assert.equal(h.raw.getJob(job.jobId)?.status, "ready");
  });

  it("never invokes HLS-4 while the status is still downloading", async () => {
    const job = claimJob(h.store, "preset:1080");
    let processingRanDuringDownloading = false;
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        processClearHls: async ({ workDir }) => {
          if (h.raw.getJob(job.jobId)?.status === "downloading") {
            processingRanDuringDownloading = true;
          }
          return writeOutput(workDir);
        },
      }),
    );
    await executor.execute(job);
    assert.equal(processingRanDuringDownloading, false);
  });

  it("commits beginProcessing strictly between acquisition and processing", async () => {
    const job = claimJob(h.store, "preset:1080");
    const order: string[] = [];
    const store = new Proxy(h.raw, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            if (prop === "beginProcessing" || prop === "beginUploading") order.push(String(prop));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    }) as unknown as WorkerJobStore;

    const executor = new JobExecutor(
      store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (_plan, workDir) => {
          order.push("acquire");
          return writeAggregate(workDir);
        },
        processClearHls: async ({ workDir }) => {
          order.push("process");
          return writeOutput(workDir);
        },
      }),
    );
    await executor.execute(job);
    assert.deepEqual(order, ["acquire", "beginProcessing", "process", "beginUploading"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. WORKSPACE CAPACITY (§30)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 workspace: no playlist is fetched for a job the Worker cannot hold", () => {
  it("refuses with PROCESSING_FAILED before acquisition when capacity is short", async () => {
    const job = claimJob(h.store, "preset:1080");
    let acquisitions = 0;
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        genericLimits: { maxFileSizeBytes: 1_000, downloadTimeoutSeconds: 60 },
        // One byte short of 2 x the ceiling.
        availableWorkDirBytes: async () => 1_999,
        acquireClearHls: async (_plan, workDir) => {
          acquisitions += 1;
          return writeAggregate(workDir);
        },
      }),
    );
    await executor.execute(job);

    assert.equal(acquisitions, 0, "no playlist request may be spent on an impossible job");
    const final = h.raw.getJob(job.jobId);
    assert.equal(final?.status, "failed");
    // Local disk is Worker capacity, not a property of the media.
    assert.equal(final?.errorCode, "PROCESSING_FAILED");
    assert.equal(h.puts.length, 0);
  });

  it("proceeds at exactly 2 x the ceiling", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        genericLimits: { maxFileSizeBytes: 1_000, downloadTimeoutSeconds: 60 },
        availableWorkDirBytes: async () => 2_000,
      }),
    );
    await executor.execute(job);
    assert.equal(h.raw.getJob(job.jobId)?.status, "ready");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. THE FAILURE MATRIX (§29)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 failure matrix: each stage stops the ones after it", () => {
  it("HLS-2/HLS-3 failure: no processing, no upload, the mapped code is durable", async () => {
    for (const code of ["FORMAT_UNAVAILABLE", "NETWORK_ERROR", "TIMEOUT", "TOO_LARGE"] as const) {
      const local = makeHarness();
      try {
        const job = claimJob(local.store, "preset:1080");
        let processings = 0;
        const executor = new JobExecutor(
          local.store,
          local.writer,
          () => Date.now(),
          new Map(),
          hlsDeps({
            acquireClearHls: async () => {
              throw new AppError(code);
            },
            processClearHls: async ({ workDir }) => {
              processings += 1;
              return writeOutput(workDir);
            },
          }),
        );
        await executor.execute(job);

        assert.equal(processings, 0, `${code}: HLS-4 must not run`);
        assert.equal(local.puts.length, 0, `${code}: nothing uploaded`);
        assert.ok(!local.calls.includes("beginProcessing"), `${code}: processing never began`);
        const final = local.raw.getJob(job.jobId);
        assert.equal(final?.status, "failed");
        assert.equal(final?.errorCode, code);
      } finally {
        local.cleanup();
      }
    }
  });

  it("a beginProcessing conflict stops before HLS-4 and uploads nothing", async () => {
    const job = claimJob(h.store, "preset:1080");
    let processings = 0;
    const active: { executor?: JobExecutor } = {};
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (_plan, workDir) => {
          const acquired = writeAggregate(workDir);
          // A terminal state committed by another writer between acquisition
          // and the processing transition.
          active.executor!.cancel(job.jobId);
          return acquired;
        },
        processClearHls: async ({ workDir }) => {
          processings += 1;
          return writeOutput(workDir);
        },
      }),
    );
    active.executor = executor;
    await executor.execute(job);

    assert.equal(processings, 0, "a lost beginProcessing CAS must not reach HLS-4");
    assert.equal(h.puts.length, 0);
    assert.equal(h.raw.getJob(job.jobId)?.status, "cancelled");
  });

  it("HLS-4 failure: processing had begun, nothing is uploaded, the code is preserved", async () => {
    for (const code of ["PROCESSING_FAILED", "TOO_LARGE", "TIMEOUT"] as const) {
      const local = makeHarness();
      try {
        const job = claimJob(local.store, "preset:1080");
        let statusAtFailure = "";
        const executor = new JobExecutor(
          local.store,
          local.writer,
          () => Date.now(),
          new Map(),
          hlsDeps({
            processClearHls: async () => {
              statusAtFailure = local.raw.getJob(job.jobId)?.status ?? "missing";
              throw new AppError(code);
            },
          }),
        );
        await executor.execute(job);

        assert.equal(statusAtFailure, "processing", `${code}: HLS-4 ran after beginProcessing`);
        assert.equal(local.puts.length, 0, `${code}: nothing uploaded`);
        const final = local.raw.getJob(job.jobId);
        assert.equal(final?.status, "failed");
        assert.equal(final?.errorCode, code, "HLS-4's canonical error is not reinterpreted");
      } finally {
        local.cleanup();
      }
    }
  });

  it("refuses a processing result that hands back the MPEG-TS source", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        processClearHls: async ({ source }) =>
          // The exact substitution the boundary exists to catch: the aggregate
          // returned as though it had been remuxed.
          Object.freeze({ filePath: source.filePath, container: "mp4" as const, fileSize: 1 }),
      }),
    );
    await executor.execute(job);

    assert.equal(h.puts.length, 0, "the TS aggregate must never be uploaded");
    const final = h.raw.getJob(job.jobId);
    assert.equal(final?.status, "failed");
    assert.equal(final?.errorCode, "PROCESSING_FAILED");
  });

  it("refuses an acquisition result that is not an MPEG-TS aggregate", async () => {
    const job = claimJob(h.store, "preset:1080");
    let processings = 0;
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (_plan, workDir) => {
          const filePath = path.join(workDir, "not-an-aggregate.mp4");
          fs.writeFileSync(filePath, "x");
          return { filePath, segmentType: "mp4", fileSize: 1 } as unknown as ClearHlsAcquiredTs;
        },
        processClearHls: async ({ workDir }) => {
          processings += 1;
          return writeOutput(workDir);
        },
      }),
    );
    await executor.execute(job);

    assert.equal(processings, 0);
    assert.equal(h.raw.getJob(job.jobId)?.errorCode, "PROCESSING_FAILED");
    assert.equal(h.puts.length, 0);
  });

  it("local-output validation failure: no upload, a safe PROCESSING_FAILED", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        // A path outside the job workDir, with the right extension: the output
        // gate is what must catch it.
        processClearHls: async () =>
          Object.freeze({
            filePath: path.join(h.tempDir, "escaped", HLS_OUTPUT_FILE_NAME),
            container: "mp4" as const,
            fileSize: 10,
          }),
      }),
    );
    await executor.execute(job);

    assert.equal(h.puts.length, 0);
    const final = h.raw.getJob(job.jobId);
    assert.equal(final?.status, "failed");
    assert.equal(final?.errorCode, "PROCESSING_FAILED");
    assert.equal(
      final?.safeErrorMessage?.includes(h.tempDir),
      false,
      "no path in the durable message",
    );
  });

  it("storage failure uses the existing upload lifecycle behaviour", async () => {
    const job = claimJob(h.store, "preset:1080");
    h.putFails = true;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps());
    await executor.execute(job);

    // Exactly what a direct or generic job does on a storage failure: the
    // lifecycle reports it and the executor commits PROCESSING_FAILED. No
    // HLS-specific behaviour is invented.
    const final = h.raw.getJob(job.jobId);
    assert.equal(final?.status, "failed");
    assert.equal(final?.errorCode, "PROCESSING_FAILED");
    assert.equal(h.puts.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. CANCELLATION AND SHUTDOWN (§28)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 cancellation: the user's terminal state always wins", () => {
  for (const stage of ["preflight", "acquisition", "processing"] as const) {
    it(`cancel during ${stage}: the job ends cancelled and nothing is uploaded`, async () => {
      const job = claimJob(h.store, "preset:1080");
      const active: { executor?: JobExecutor } = {};
      let sawAbortedSignal = false;

      const cancelNow = (signal: AbortSignal) => {
        active.executor!.cancel(job.jobId);
        sawAbortedSignal = signal.aborted;
        // A LATER HLS error, of a kind that would otherwise be durable. It must
        // not overwrite the cancellation the user already committed.
        throw new AppError("NETWORK_ERROR");
      };

      const executor = new JobExecutor(
        h.store,
        h.writer,
        () => Date.now(),
        new Map(),
        hlsDeps({
          acquireClearHls: async (_plan, workDir, ctx) => {
            if (stage === "preflight" || stage === "acquisition") cancelNow(ctx.signal);
            return writeAggregate(workDir);
          },
          processClearHls: async ({ signal, workDir }) => {
            if (stage === "processing") cancelNow(signal);
            return writeOutput(workDir);
          },
        }),
      );
      active.executor = executor;
      await executor.execute(job);

      assert.equal(sawAbortedSignal, true, "the in-flight HLS signal must abort");
      const final = h.raw.getJob(job.jobId);
      assert.equal(final?.status, "cancelled");
      assert.equal(final?.errorCode ?? null, null, "a later HLS error must not overwrite it");
      assert.equal(h.puts.length, 0);
    });
  }

  it("operator shutdown leaves the row ACTIVE for next-start recovery", async () => {
    const job = claimJob(h.store, "preset:1080");
    const active: { executor?: JobExecutor } = {};
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (_plan, _workDir, ctx) => {
          active.executor!.abortActiveForShutdown();
          assert.equal(ctx.signal.aborted, true);
          throw new AppError("NETWORK_ERROR");
        },
      }),
    );
    active.executor = executor;
    await executor.execute(job);

    const final = h.raw.getJob(job.jobId);
    // The dying process commits no ordinary failure: exactly the existing
    // direct/generic behaviour, unchanged.
    assert.equal(final?.status, "downloading");
    assert.equal(final?.errorCode ?? null, null);
    assert.ok(!h.calls.includes("failJob"));
    assert.equal(h.puts.length, 0);
  });

  it("removes the whole workDir on every unwind, so no HLS artifact survives", async () => {
    for (const outcome of ["success", "failure"] as const) {
      const local = makeHarness();
      try {
        const job = claimJob(local.store, "preset:1080");
        let workDir = "";
        const executor = new JobExecutor(
          local.store,
          local.writer,
          () => Date.now(),
          new Map(),
          hlsDeps({
            acquireClearHls: async (_plan, dir) => {
              workDir = dir;
              return writeAggregate(dir);
            },
            processClearHls: async ({ workDir: dir }) => {
              const produced = writeOutput(dir);
              if (outcome === "failure") throw new AppError("PROCESSING_FAILED");
              return produced;
            },
          }),
        );
        await executor.execute(job);

        assert.notEqual(workDir, "");
        assert.equal(fs.existsSync(workDir), false, `${outcome}: the workDir is removed`);
        assert.equal(
          fs.existsSync(path.join(workDir, AGGREGATE_FILE_NAME)),
          false,
          `${outcome}: no MPEG-TS aggregate survives`,
        );
        assert.equal(
          fs.existsSync(path.join(workDir, HLS_OUTPUT_FILE_NAME)),
          false,
          `${outcome}: no MP4 survives`,
        );
      } finally {
        local.cleanup();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. PROGRESS (§22)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 progress: truthful, and inert once acquisition has settled", () => {
  it("writes HLS-3's progress durably, inventing no total, speed or ETA", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (_plan, workDir, ctx) => {
          ctx.onProgress?.({
            progress: 40,
            downloadedBytes: 4_096,
            totalBytes: null,
            speed: null,
            eta: null,
            stage: "downloading",
          });
          const view = h.raw.getJob(job.jobId);
          assert.equal(view?.progress, 40);
          assert.equal(view?.downloadedBytes, 4_096);
          assert.equal(view?.totalBytes ?? null, null, "no invented total");
          assert.equal(view?.speed ?? null, null, "no invented speed");
          assert.equal(view?.eta ?? null, null, "no invented ETA");
          return writeAggregate(workDir);
        },
      }),
    );
    await executor.execute(job);
    assert.equal(h.raw.getJob(job.jobId)?.status, "ready");
  });

  it("ignores a LATE callback that arrives after acquisition returned", async () => {
    const job = claimJob(h.store, "preset:1080");
    let late: ((p: never) => void) | null = null;
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async (_plan, workDir, ctx) => {
          late = ctx.onProgress as unknown as (p: never) => void;
          return writeAggregate(workDir);
        },
        processClearHls: async ({ workDir }) => {
          // The dangerous moment: the durable job is no longer `downloading`,
          // so a live reporter would lose the CAS and abort a job that had
          // already succeeded.
          late?.({
            progress: 99,
            downloadedBytes: 1,
            totalBytes: null,
            speed: null,
            eta: null,
            stage: "downloading",
          } as never);
          return writeOutput(workDir);
        },
      }),
    );
    await executor.execute(job);
    assert.equal(h.raw.getJob(job.jobId)?.status, "ready", "a late callback must be inert");
    assert.equal(h.puts.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. PRIVACY AND FRESHNESS (§26, §27)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-6 privacy: the playlist URL reaches no durable or outward surface", () => {
  it("is absent from every durable row, job view, object key and header", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps());
    await executor.execute(job);

    const view = h.raw.getJob(job.jobId);
    assert.equal(view?.status, "ready");

    const surfaces = [
      JSON.stringify(view),
      JSON.stringify(h.puts),
      h.puts[0]!.objectKey,
      h.puts[0]!.contentDisposition ?? "",
      h.puts[0]!.contentType,
      JSON.stringify(h.raw.listExpiredReadyObjects(10)),
    ];
    for (const surface of surfaces) {
      assert.equal(surface.includes(VERY_PRIVATE_HLS_TOKEN), false, "no token");
      assert.equal(surface.includes("media.example.invalid"), false, "no HLS host");
      assert.equal(surface.includes("m3u8"), false, "no playlist reference");
    }
  });

  it("is absent from the raw SQLite database file itself", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps());
    await executor.execute(job);

    // The whole durable store, byte for byte: the strongest available statement
    // that nothing persisted the URL through some column this test did not name.
    const bytes = fs.readFileSync(path.join(h.tempDir, "test.sqlite")).toString("binary");
    assert.equal(bytes.includes(VERY_PRIVATE_HLS_TOKEN), false);
    assert.equal(bytes.includes("m3u8"), false);
  });

  it("is absent from a FAILED job's durable error text", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        acquireClearHls: async () => {
          throw new AppError("NETWORK_ERROR");
        },
      }),
    );
    await executor.execute(job);

    const view = h.raw.getJob(job.jobId);
    assert.equal(view?.status, "failed");
    assert.equal(JSON.stringify(view).includes(VERY_PRIVATE_HLS_TOKEN), false);
    assert.equal(JSON.stringify(view).includes("media.example.invalid"), false);
  });

  it("re-derives the plan from a FRESH analysis on every attempt", async () => {
    // Freshness is the existing durable-execution model: the URL belongs to
    // THIS attempt, and a retry obtains a new one rather than reusing a signed
    // location that may have expired.
    const job = claimJob(h.store, "preset:1080");
    let analyses = 0;
    const seenUrls: string[] = [];
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      hlsDeps({
        analyzeForExecution: async () => {
          analyses += 1;
          return hlsOnlyAnalysis(
            Object.freeze({
              "preset:1080": Object.freeze({
                playlistUrl: `${PLAYLIST_URL}&attempt=${analyses}`,
                height: 1080,
              }),
            }),
          );
        },
        acquireClearHls: async (plan, workDir) => {
          seenUrls.push(plan.source.playlistUrl);
          return writeAggregate(workDir);
        },
      }),
    );
    await executor.execute(job);

    assert.equal(analyses, 1, "one fresh analysis per execution");
    assert.deepEqual(seenUrls, [`${PLAYLIST_URL}&attempt=1`]);
    // Nothing about the plan was persisted, so a later attempt has nothing to
    // reuse: the durable row carries the strategy and no source at all.
    const view = h.raw.getJob(job.jobId);
    assert.equal(view?.extractor, "yt-dlp");
    assert.equal(JSON.stringify(view).includes("attempt=1"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. THE PRODUCTION DEFAULT: an UNADVERTISED HLS selection is no capability
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-7 production default: the ordinary planner never runs an unadvertised HLS selection", () => {
  it("refuses a private HLS selection that the fresh analysis does not advertise", async () => {
    // Before HLS-7 this proved the default planner could not reach HLS at all.
    // Since HLS-7 it can — for an ADVERTISED preset (section I). This same
    // fixture advertises nothing, so a private selection alone must still
    // produce no plan, no request and no job output.
    const job = claimJob(h.store, "preset:1080");
    let acquisitions = 0;
    const deps = hlsDeps({
      acquireClearHls: async (_plan, workDir) => {
        acquisitions += 1;
        return writeAggregate(workDir);
      },
    });
    // The ONLY difference from the injected success case in section A.
    delete deps.derivePlanForExecution;

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.equal(acquisitions, 0, "no playlist request for an unadvertised rung");
    const final = h.raw.getJob(job.jobId);
    assert.equal(final?.status, "failed");
    assert.equal(final?.errorCode, "FORMAT_UNAVAILABLE");
    assert.equal(h.puts.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. HLS-7 ACTIVATION: the REAL analyzer + the ORDINARY planner (§19, §28, §31)
// ─────────────────────────────────────────────────────────────────────────────

/** A real `-J` document: one admitted clear-HLS rendition, nothing progressive. */
const HLS_ONLY_DOCUMENT = JSON.stringify({
  _type: "video",
  title: "An HLS Clip",
  duration: 120,
  live_status: "not_live",
  formats: [
    {
      format_id: "synthetic-hls-1080",
      ext: "mp4",
      video_ext: "mp4",
      audio_ext: "none",
      height: 1080,
      width: 1920,
      fps: 30,
      protocol: "m3u8_native",
      vcodec: "avc1.640028",
      acodec: "mp4a.40.2",
      url: PLAYLIST_URL,
    },
  ],
});

/** The executor's analysis seam: the REAL generic analyzer, only yt-dlp canned. */
function realHlsAnalysis(ffmpegAvailable = true): NonNullable<JobExecutorDeps["analyzeForExecution"]> {
  return async (url, signal) => {
    const { video, selections, hlsSelections } = await analyzeGenericMediaInternal(url, {
      limits: { analysisTimeoutSeconds: 45, maxVideoDurationSeconds: 7200, maxFileSizeBytes: 4 * 1024 ** 3 },
      ffmpegAvailable,
      runner: async () => ({ code: 0, stdout: HLS_ONLY_DOCUMENT, stderr: "" }),
      probeRuntime: async () => ({ available: true, version: "2026.08.19", reason: "ok" as const }),
      validateUrl: async (raw: string) => ({ url: raw, hostname: new URL(raw).hostname }),
      ...(signal ? { signal } : {}),
    });
    return { strategy: "yt-dlp", video, selections, hlsSelections };
  };
}

/** `hlsDeps()` with the REAL analyzer and NO injected plan derivation. */
function ordinaryDeps(over: Partial<JobExecutorDeps> = {}): JobExecutorDeps {
  const deps = hlsDeps({ analyzeForExecution: realHlsAnalysis(), ...over });
  delete deps.derivePlanForExecution;
  assert.equal("derivePlanForExecution" in deps, false, "the Production default planner");
  return deps;
}

describe("HLS-7 activation: an ordinary HLS job reaches ready through the ORDINARY planner", () => {
  it("analyzes, acquires while downloading, remuxes while processing, uploads, and is ready", async () => {
    const job = claimJob(h.store, "preset:1080");
    const observed: string[] = [];
    const at = (label: string) =>
      observed.push(`${label}:${h.raw.getJob(job.jobId)?.status ?? "missing"}`);
    let seenPlan: unknown;

    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      ordinaryDeps({
        acquireClearHls: async (plan, workDir) => {
          seenPlan = plan;
          at("hls-acquisition");
          return writeAggregate(workDir);
        },
        processClearHls: async ({ workDir }) => {
          at("hls-processing");
          return writeOutput(workDir);
        },
      }),
    );
    const originalPut = h.writer.put.bind(h.writer);
    h.writer.put = async (input) => {
      at("upload");
      return originalPut(input);
    };
    await executor.execute(job);

    assert.deepEqual(observed, [
      "hls-acquisition:downloading",
      "hls-processing:processing",
      "upload:uploading",
    ]);
    // The plan the ORDINARY planner derived from the fresh real analysis.
    assert.deepEqual(seenPlan, {
      strategy: "yt-dlp",
      operation: "clear-hls-remux",
      requestedFormatId: "preset:1080",
      source: { playlistUrl: PLAYLIST_URL, height: 1080 },
      targetContainer: "mp4",
    });
    const final = h.raw.getJob(job.jobId);
    assert.equal(final?.status, "ready");
    assert.equal(final?.extractor, "yt-dlp", "the durable strategy vocabulary gains no HLS member");
    assert.equal(h.puts.length, 1);
    assert.equal(h.puts[0]!.contentType, "video/mp4");
    assert.equal(h.puts[0]!.contentLength, MP4_BYTES.length);
    assert.ok(h.calls.indexOf("beginProcessing") < h.calls.indexOf("beginUploading"));
  });

  it("serves preset:best from the same rendition", async () => {
    const job = claimJob(h.store, "preset:best");
    let seenUrl = "";
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      ordinaryDeps({
        acquireClearHls: async (plan, workDir) => {
          seenUrl = plan.source.playlistUrl;
          return writeAggregate(workDir);
        },
      }),
    );
    await executor.execute(job);
    assert.equal(h.raw.getJob(job.jobId)?.status, "ready");
    assert.equal(seenUrl, PLAYLIST_URL);
  });

  it("refuses preset:audio and preset:mp3 — clear HLS has no audio product", async () => {
    for (const formatId of ["preset:audio", "preset:mp3"] as const) {
      const local = makeHarness();
      try {
        const job = claimJob(local.store, formatId);
        let acquisitions = 0;
        const executor = new JobExecutor(
          local.store,
          local.writer,
          () => Date.now(),
          new Map(),
          ordinaryDeps({
            acquireClearHls: async (_plan, workDir) => {
              acquisitions += 1;
              return writeAggregate(workDir);
            },
          }),
        );
        await executor.execute(job);
        assert.equal(acquisitions, 0, formatId);
        assert.equal(local.raw.getJob(job.jobId)?.errorCode, "FORMAT_UNAVAILABLE", formatId);
      } finally {
        local.cleanup();
      }
    }
  });

  it("refuses the job when the FRESH analysis has no Worker FFmpeg — no substitution", async () => {
    // The browser may have been offered the preset earlier. The job's own
    // analysis is authoritative, and without FFmpeg it advertises nothing.
    const job = claimJob(h.store, "preset:1080");
    let acquisitions = 0;
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      ordinaryDeps({
        analyzeForExecution: realHlsAnalysis(false),
        acquireClearHls: async (_plan, workDir) => {
          acquisitions += 1;
          return writeAggregate(workDir);
        },
      }),
    );
    await executor.execute(job);
    assert.equal(acquisitions, 0);
    assert.equal(h.raw.getJob(job.jobId)?.errorCode, "FORMAT_UNAVAILABLE");
    assert.equal(h.puts.length, 0);
  });

  it("persists NO playlist URL, token, plan operation or raw format id — anywhere durable", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), ordinaryDeps());
    await executor.execute(job);

    const view = h.raw.getJob(job.jobId);
    assert.equal(view?.status, "ready");
    // The raw durable store, byte for byte, plus every outward surface.
    const database = fs.readFileSync(path.join(h.tempDir, "test.sqlite")).toString("binary");
    const surfaces = [
      database,
      JSON.stringify(view),
      JSON.stringify(h.puts),
      h.puts[0]!.objectKey,
      h.puts[0]!.contentDisposition ?? "",
    ];
    for (const surface of surfaces) {
      for (const forbidden of [
        VERY_PRIVATE_HLS_TOKEN,
        PLAYLIST_URL,
        "media.example.invalid",
        "m3u8",
        "clear-hls-remux",
        "synthetic-hls-1080",
        "playlistUrl",
      ]) {
        assert.equal(surface.includes(forbidden), false, `a durable surface names ${forbidden}`);
      }
    }
    // Positive control: the scan really reads the durable row it guards.
    assert.ok(database.includes(job.jobId));
  });

  it("persists NO private provenance on a FAILED ordinary HLS job either", async () => {
    const job = claimJob(h.store, "preset:1080");
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => Date.now(),
      new Map(),
      ordinaryDeps({
        acquireClearHls: async () => {
          throw new AppError("NETWORK_ERROR");
        },
      }),
    );
    await executor.execute(job);

    const view = h.raw.getJob(job.jobId);
    assert.equal(view?.status, "failed");
    assert.equal(view?.errorCode, "NETWORK_ERROR");
    const serialized = `${JSON.stringify(view)}\n${fs.readFileSync(path.join(h.tempDir, "test.sqlite")).toString("binary")}`;
    for (const forbidden of [VERY_PRIVATE_HLS_TOKEN, "media.example.invalid", "m3u8", "synthetic-hls-1080"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});
