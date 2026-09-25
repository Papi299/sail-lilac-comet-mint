import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import {
  VideoMetadataSchema,
  type WorkerRequestedFormatId,
  type WorkerVideoMetadata,
} from "@/shared/worker/contracts";
import type { DurableWorkerJob } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import type {
  GenericPresetSource,
  GenericSourceSelection,
  GenericSourceSelections,
  GenericVideoConstraint,
} from "./generic-source.ts";
import {
  downloadGenericOriginal,
  expectedSourcePath,
  type GenericDownloadLimits,
} from "./ytdlp-download.server.ts";
import type {
  GenericExecutionPlan,
  GenericSingleSourceExecutionPlan,
} from "./format-plan.ts";
import { analyzeGenericMediaInternal } from "../analysis/ytdlp-analysis.server.ts";

/**
 * Phase 10C3 §54/§55/§36/§40/§42: generic jobs on the ONE durable state machine.
 *
 * Everything here uses fakes — a fake analyzer, a fake acquisition, a fake
 * object store and a real temp filesystem. No network, no yt-dlp subprocess and
 * no public media site is contacted.
 *
 * The load-bearing assertions are about ORDER: what the durable status says at
 * the exact instant acquisition runs, and at the exact instant Worker FFmpeg
 * would be invoked.
 */

const SENTINEL = "SUPER_SECRET_VALUE";
const GENERIC_URL = "https://example.invalid/watch/abc";

type PresetSpec = {
  id: string;
  container: string;
  hasVideo: boolean;
  hasAudio?: boolean;
};

/** Generic metadata: `formats: []` always, presets application-owned always. */
function genericMeta(presets: PresetSpec[]): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "A Generic Clip",
    thumbnail: null,
    duration: 120,
    source: "example.invalid",
    extractor: "yt-dlp",
    webpageUrl: GENERIC_URL,
    formats: [],
    presets: presets.map((p) => ({
      id: p.id,
      label: p.id,
      resolution: p.hasVideo ? "1080p" : "audio",
      container: p.container,
      fileSize: null,
      hasVideo: p.hasVideo,
      hasAudio: p.hasAudio ?? true,
      formatId: p.id,
      videoCodec: p.hasVideo ? "h264" : null,
      audioCodec: "aac",
      fps: null,
    })),
    capabilities: { mp3: true, merge: false },
  });
}

/**
 * Builds the per-preset private value for ONE approved source.
 *
 * SPLIT-01 made that value a discriminated union, so this returns the
 * `kind: "single"` form. Every case in this file exercises single-source
 * execution, which is the only kind anything can build today.
 */
function selection(over: Partial<GenericSourceSelection> = {}): GenericPresetSource {
  // `videoConstraint` must agree with `hasVideo` or the schema refuses the
  // selection outright (§12), so the default follows whatever the caller asked
  // for and can still be overridden explicitly.
  const hasVideo = over.hasVideo ?? true;
  // Likewise `audioConstraint` must agree with `hasAudio`, which means PROVEN
  // audio (exactly `codec-present`). A caller asking for `hasAudio: false` gets
  // proven absence; the unknown state must be asked for explicitly.
  const hasAudio = over.hasAudio ?? true;
  return {
    kind: "single",
    source: {
      formatId: "22",
      protocol: "https" as const,
      container: "mp4" as const,
      hasVideo: true,
      hasAudio: true,
      videoConstraint: (hasVideo ? "codec-present" : "absent") as GenericVideoConstraint,
      audioConstraint: hasAudio ? ("codec-present" as const) : ("absent" as const),
      fileSize: null,
      ...over,
    },
  };
}

function genericAnalysis(
  presets: PresetSpec[],
  selections: GenericSourceSelections,
): ExecutionAnalysis {
  // Every preset here is progressive-owned, so the HLS half of the fresh
  // analysis is empty. Since HLS-7 the ordinary planner reads it; the
  // executor itself still never does.
  return { strategy: "yt-dlp", video: genericMeta(presets), selections, hlsSelections: {} };
}

type Harness = {
  db: DatabaseSync;
  store: SQLiteJobStore;
  puts: ObjectStorePutInput[];
  writer: ObjectStoreWriter;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "generic-exec-"));
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
  store.createJob({ url: GENERIC_URL, formatId, principalId: "private-access-user" }, randomUUID());
  const job = store.claimNextQueuedJob();
  assert.ok(job, "a job must be claimable");
  return job;
}

/**
 * NODE22-GENERIC-EXECUTION-TEST-LIVENESS-001 — event-loop liveness.
 *
 * A real yt-dlp child process holds the event loop open for exactly as long as
 * it runs. These tests replace that child with a promise, which holds nothing,
 * and `runMonitoredAcquisition` deliberately unrefs its poll timer so a stuck
 * monitor can never keep the Worker alive on its own (§31). With no other
 * ref'd handle, Node 22 can drain the loop before the first sample fires, and
 * node:test then reports "Promise resolution is still pending but the event
 * loop has already resolved" and cancels the remainder of the file.
 *
 * This restores that ONE real property for the duration of each test and
 * nothing else: no barrier, ordering, timeout or assertion is changed. The
 * ceiling sits far above any legitimate test here, so a genuine deadlock still
 * surfaces instead of hanging forever.
 */
const EVENT_LOOP_HOLD_CEILING_MS = 30_000;
let eventLoopHold: ReturnType<typeof setTimeout> | null = null;
const holdEventLoop = () => {
  eventLoopHold = setTimeout(() => {}, EVENT_LOOP_HOLD_CEILING_MS);
};
const releaseEventLoop = () => {
  if (eventLoopHold !== null) {
    clearTimeout(eventLoopHold);
    eventLoopHold = null;
  }
};

let h: Harness;
beforeEach(() => {
  holdEventLoop();
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
  releaseEventLoop();
});

/**
 * A generic acquisition fake that writes the source file and RECORDS the
 * durable status at the moment it ran.
 */
function fakeGenericDownload(
  store: SQLiteJobStore,
  jobId: string,
  observed: { statuses: string[]; calls: number },
  container = "mp4",
) {
  return (async (
    _url: string,
    workDir: string,
    _plan: unknown,
    _ctx: unknown,
  ) => {
    observed.calls += 1;
    observed.statuses.push(store.getJob(jobId)?.status ?? "missing");
    const filePath = path.join(workDir, `source.${container}`);
    fs.writeFileSync(filePath, "GENERIC-MEDIA-BYTES");
    return { filePath, container, mime: `video/${container}`, fileSize: 19 };
  }) as NonNullable<JobExecutorDeps["downloadGeneric"]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §54: the generic happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("generic job: happy path (§54)", () => {
  it("runs queued -> ready and persists extractor = yt-dlp", async () => {
    const job = claimJob(h.store, "preset:1080");
    const observed = { statuses: [] as string[], calls: 0 };
    let ffmpegCalls = 0;
    let directCalls = 0;

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        ),
      downloadOriginal: async () => {
        directCalls += 1;
        throw new Error("the DIRECT downloader must never run for a generic job");
      },
      downloadGeneric: fakeGenericDownload(h.store, job.jobId, observed),
      processLocally: async () => {
        ffmpegCalls += 1;
        throw new Error("keep-original must never invoke Worker FFmpeg");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    const final = h.store.getJob(job.jobId);
    assert.equal(final?.status, "ready");
    assert.equal(final?.extractor, "yt-dlp", "the Worker's own strategy decision is persisted");
    assert.equal(observed.calls, 1, "exactly one acquisition");
    assert.equal(directCalls, 0);
    assert.equal(ffmpegCalls, 0, "a keep-original generic video needs zero FFmpeg calls");
    assert.equal(h.puts.length, 1, "exactly one object uploaded");
    assert.equal(h.puts[0]!.contentLength, 19);
    assert.equal(h.puts[0]!.contentType, "video/mp4");
  });

  it("observes downloading at acquisition and processing at FFmpeg", async () => {
    const job = claimJob(h.store, "preset:mp3");
    const acquisition = { statuses: [] as string[], calls: 0 };
    const ffmpegStatuses: string[] = [];

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:mp3", container: "mp3", hasVideo: false }],
          { "preset:mp3": selection() },
        ),
      downloadGeneric: fakeGenericDownload(h.store, job.jobId, acquisition),
      processLocally: async ({ workDir, target }) => {
        ffmpegStatuses.push(h.store.getJob(job.jobId)?.status ?? "missing");
        const out = path.join(workDir, `out.${target}`);
        fs.writeFileSync(out, "MP3");
        return out;
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.deepEqual(acquisition.statuses, ["downloading"], "acquisition runs while downloading");
    assert.deepEqual(ffmpegStatuses, ["processing"], "FFmpeg runs only once processing committed");
    assert.equal(h.store.getJob(job.jobId)?.status, "ready");
  });

  it("never invokes Worker FFmpeg while the status is downloading (§36 hard gate)", async () => {
    const job = claimJob(h.store, "preset:audio");
    let ffmpegRanDuringDownloading = false;

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:audio", container: "m4a", hasVideo: false }],
          { "preset:audio": selection() },
        ),
      downloadGeneric: (async (_u: string, workDir: string) => {
        // If anything invoked FFmpeg from inside acquisition, the flag below
        // would already be set by the time this returns.
        fs.writeFileSync(path.join(workDir, "source.mp4"), "MUXED");
        return { filePath: path.join(workDir, "source.mp4"), container: "mp4", mime: "video/mp4", fileSize: 5 };
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
      processLocally: async ({ workDir, target }) => {
        if (h.store.getJob(job.jobId)?.status === "downloading") {
          ffmpegRanDuringDownloading = true;
        }
        const out = path.join(workDir, `out.${target}`);
        fs.writeFileSync(out, "M4A");
        return out;
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);
    assert.equal(ffmpegRanDuringDownloading, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §55: generic audio policy
// ─────────────────────────────────────────────────────────────────────────────

describe("generic job: audio policy (§38/§55)", () => {
  it("keeps an AUDIO-ONLY source verbatim, with no FFmpeg at all", async () => {
    const job = claimJob(h.store, "preset:audio");
    let ffmpegCalls = 0;

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:audio", container: "m4a", hasVideo: false }],
          {
            "preset:audio": selection({
              formatId: "140",
              container: "m4a",
              hasVideo: false,
              hasAudio: true,
            }),
          },
        ),
      downloadGeneric: (async (_u: string, workDir: string) => {
        const p = path.join(workDir, "source.m4a");
        fs.writeFileSync(p, "AUDIO");
        return { filePath: p, container: "m4a", mime: "audio/mp4", fileSize: 5 };
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
      processLocally: async () => {
        ffmpegCalls += 1;
        throw new Error("an audio-only source must be kept, not processed");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.equal(h.store.getJob(job.jobId)?.status, "ready");
    assert.equal(ffmpegCalls, 0);
    assert.equal(h.puts[0]!.contentType, "audio/mp4");
  });

  it("extracts m4a from a MUXED source, strictly after processing begins", async () => {
    const job = claimJob(h.store, "preset:audio");
    const seen: Array<{ status: string; target: string }> = [];

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:audio", container: "m4a", hasVideo: false }],
          { "preset:audio": selection() }, // muxed mp4 source
        ),
      downloadGeneric: (async (_u: string, workDir: string) => {
        const p = path.join(workDir, "source.mp4");
        fs.writeFileSync(p, "MUXED");
        return { filePath: p, container: "mp4", mime: "video/mp4", fileSize: 5 };
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
      processLocally: async ({ workDir, target }) => {
        seen.push({ status: h.store.getJob(job.jobId)?.status ?? "missing", target });
        const out = path.join(workDir, `out.${target}`);
        fs.writeFileSync(out, "M4A");
        return out;
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.deepEqual(seen, [{ status: "processing", target: "m4a" }]);
    assert.equal(h.store.getJob(job.jobId)?.status, "ready");
  });

  it("transcodes preset:mp3 with the Worker's own FFmpeg, never yt-dlp -x", async () => {
    const job = claimJob(h.store, "preset:mp3");
    const seen: Array<{ status: string; target: string }> = [];

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:mp3", container: "mp3", hasVideo: false }],
          { "preset:mp3": selection() },
        ),
      downloadGeneric: (async (_u: string, workDir: string, plan: unknown) => {
        // The acquisition plan must still name the SOURCE, not the mp3 target.
        const p = plan as { targetContainer: string; source: { container: string } };
        assert.equal(p.targetContainer, "mp3");
        assert.equal(p.source.container, "mp4", "the acquired source stays the muxed original");
        const f = path.join(workDir, "source.mp4");
        fs.writeFileSync(f, "MUXED");
        return { filePath: f, container: "mp4", mime: "video/mp4", fileSize: 5 };
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
      processLocally: async ({ workDir, target }) => {
        seen.push({ status: h.store.getJob(job.jobId)?.status ?? "missing", target });
        const out = path.join(workDir, `out.${target}`);
        fs.writeFileSync(out, "MP3");
        return out;
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.deepEqual(seen, [{ status: "processing", target: "mp3" }]);
    assert.equal(h.puts[0]!.contentType, "audio/mpeg");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §17/§42: the Worker decides strategy itself
// ─────────────────────────────────────────────────────────────────────────────

describe("generic job: strategy authority (§17/§42)", () => {
  it("re-analyzes the stored URL rather than trusting the browser", async () => {
    const job = claimJob(h.store, "preset:1080");
    const analyzedUrls: string[] = [];

    const deps: JobExecutorDeps = {
      analyzeForExecution: async (url) => {
        analyzedUrls.push(url);
        return genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        );
      },
      downloadGeneric: fakeGenericDownload(h.store, job.jobId, { statuses: [], calls: 0 }),
    };

    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);
    assert.deepEqual(analyzedUrls, [GENERIC_URL], "exactly the job's own stored URL");
  });

  it("ignores a durable extractor value written by a previous attempt", async () => {
    const job = claimJob(h.store, "preset:1080");
    // Simulate a stale row claiming a strategy this execution must not inherit.
    h.db.prepare("UPDATE worker_jobs SET extractor = ? WHERE job_id = ?").run("direct", job.jobId);

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        ),
      downloadOriginal: async () => {
        throw new Error("a stale durable extractor must not select the direct downloader");
      },
      downloadGeneric: fakeGenericDownload(h.store, job.jobId, { statuses: [], calls: 0 }),
    };

    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);
    assert.equal(h.store.getJob(job.jobId)?.extractor, "yt-dlp", "this execution's own decision wins");
  });

  it("FORMAT_UNAVAILABLE when the site no longer offers the chosen preset", async () => {
    const job = claimJob(h.store, "preset:2160");
    let acquired = 0;

    const deps: JobExecutorDeps = {
      // The browser chose 2160 earlier; the fresh analysis only has 1080.
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        ),
      downloadGeneric: (async () => {
        acquired += 1;
        throw new Error("nothing may be acquired for an unavailable preset");
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
    };

    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    const final = h.store.getJob(job.jobId);
    assert.equal(final?.status, "failed");
    assert.equal(final?.errorCode, "FORMAT_UNAVAILABLE");
    assert.equal(acquired, 0, "no substitution, and no acquisition");
  });

  it("routes a DIRECT analysis to the direct downloader, unchanged (§61)", async () => {
    const job = claimJob(h.store, "direct-original");
    let directCalls = 0;
    let genericCalls = 0;

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () => ({
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
        hlsSelections: {},
      }),
      downloadOriginal: async (_url, ctx) => {
        directCalls += 1;
        const p = path.join(ctx.workDir, "source.mp4");
        fs.writeFileSync(p, "DIRECT");
        return { filePath: p, container: "mp4", mime: "video/mp4", fileSize: 6 };
      },
      downloadGeneric: (async () => {
        genericCalls += 1;
        throw new Error("generic acquisition must never run for a direct job");
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
    };

    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    assert.equal(directCalls, 1);
    assert.equal(genericCalls, 0);
    assert.equal(h.store.getJob(job.jobId)?.extractor, "direct");
    assert.equal(h.store.getJob(job.jobId)?.status, "ready");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §40/§59: cancellation and shutdown
// ─────────────────────────────────────────────────────────────────────────────

describe("generic job: cancellation and shutdown (§40/§41/§59)", () => {
  it("cancelling during acquisition prevents processing, upload and a late ready", async () => {
    const job = claimJob(h.store, "preset:1080");
    let sawAbort = false;
    let processed = 0;

    const controllers = new Map<string, AbortController>();
    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        ),
      downloadGeneric: (async (_u: string, _w: string, _p: unknown, ctx: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
          });
          // Cancel once acquisition is genuinely in flight.
          setTimeout(() => executor.cancel(job.jobId), 5);
        })) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
      processLocally: async () => {
        processed += 1;
        throw new Error("processing must not start after cancellation");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), controllers, deps);
    await executor.execute(job);

    assert.equal(sawAbort, true, "the abort must reach the acquisition");
    assert.equal(processed, 0);
    assert.equal(h.puts.length, 0, "nothing may be uploaded");
    assert.equal(h.store.getJob(job.jobId)?.status, "cancelled");
    assert.equal(controllers.size, 0, "the controller is released");
  });

  it("shutdown aborts generic acquisition without writing a cancelled OR failed state", async () => {
    const job = claimJob(h.store, "preset:1080");
    let sawAbort = false;
    let abortedCount = -1;

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        ),
      downloadGeneric: (async (_u: string, _w: string, _p: unknown, ctx: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new AppError("PROCESSING_FAILED", "Worker shutting down"));
          });
          setTimeout(() => {
            // Captured rather than asserted here: a throw inside a timer
            // callback crashes the runner instead of failing this test.
            abortedCount = executor.abortActiveForShutdown();
          }, 5);
        })) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.equal(sawAbort, true);
    assert.equal(abortedCount, 1, "shutdown must signal exactly the one active execution");
    const final = h.store.getJob(job.jobId);
    // A restart is neither a user cancellation nor an execution failure: the
    // interrupted row stays ACTIVE for the next process's `store.recover()`.
    assert.equal(final?.status, "downloading");
    assert.notEqual(final?.status, "cancelled");
    assert.notEqual(final?.status, "failed");
    assert.equal(h.puts.length, 0);

    h.store.recover();
    const recovered = h.store.getJob(job.jobId);
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.errorCode, "PROCESSING_FAILED");
    assert.equal(recovered?.safeErrorMessage, "Worker restarted before the job completed.");
    assert.equal(recovered?.stageLabel, "Worker restarted");
  });

  it("removes the job workDir after a generic failure", async () => {
    const job = claimJob(h.store, "preset:1080");
    let capturedWorkDir = "";

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        ),
      downloadGeneric: (async (_u: string, workDir: string) => {
        capturedWorkDir = workDir;
        fs.writeFileSync(path.join(workDir, "source.mp4.part"), "PARTIAL");
        throw new AppError("NETWORK_ERROR");
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
    };

    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    assert.ok(capturedWorkDir);
    assert.equal(fs.existsSync(capturedWorkDir), false, "the workDir must be cleaned up");
    assert.equal(h.store.getJob(job.jobId)?.errorCode, "NETWORK_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §60: privacy of the private selection
// ─────────────────────────────────────────────────────────────────────────────

describe("generic job: the private selection never becomes durable (§9/§60)", () => {
  it("persists no raw upstream format id anywhere in durable state", async () => {
    const job = claimJob(h.store, "preset:1080");

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          // A raw id that is BOTH grammar-legal and carries the sentinel, so a
          // leak would be unmistakable.
          { "preset:1080": selection({ formatId: `raw-${SENTINEL}` }) },
        ),
      downloadGeneric: fakeGenericDownload(h.store, job.jobId, { statuses: [], calls: 0 }),
    };

    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    // The whole durable row, serialized.
    const row = h.db
      .prepare("SELECT * FROM worker_jobs WHERE job_id = ?")
      .get(job.jobId) as Record<string, unknown>;
    const serializedRow = JSON.stringify(row);
    assert.equal(serializedRow.includes(SENTINEL), false, "raw id reached SQLite");

    // The browser-facing view.
    const view = h.store.getJob(job.jobId);
    assert.equal(JSON.stringify(view).includes(SENTINEL), false, "raw id reached the job view");
    assert.equal(view?.extractor, "yt-dlp", "only the closed strategy identity is stored");

    // The uploaded object's own metadata and filename.
    const put = h.puts[0]!;
    assert.equal(JSON.stringify(put.contentDisposition).includes(SENTINEL), false);
    assert.equal(put.objectKey.includes(SENTINEL), false);
    assert.equal(String(view?.filename).includes(SENTINEL), false);
  });

  it("never puts a raw upstream id in the durable formatId or quality", async () => {
    const job = claimJob(h.store, "preset:720");
    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:720", container: "mp4", hasVideo: true }],
          { "preset:720": selection({ formatId: "137" }) },
        ),
      downloadGeneric: fakeGenericDownload(h.store, job.jobId, { statuses: [], calls: 0 }),
    };
    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    const view = h.store.getJob(job.jobId);
    // `quality` is derived from the APPLICATION preset, never the source id.
    assert.equal(view?.quality, "720");
    const row = h.db
      .prepare("SELECT format_id FROM worker_jobs WHERE job_id = ?")
      .get(job.jobId) as { format_id: string };
    assert.equal(row.format_id, "preset:720");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION-01 §10: the durable-state race between the byte monitor and
// beginProcessing(), exercised through the REAL acquisition primitive.
// ─────────────────────────────────────────────────────────────────────────────

/** A barrier the test controls explicitly. No sleeps, no timing luck. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("generic job: a late byte-monitor sample cannot break a succeeding job (§10)", () => {
  it("reaches ready even when a suspended stat resolves after acquisition returned", async () => {
    // This binds BOTH layers: the real `downloadGenericOriginal` runs inside the
    // executor, with only its subprocess and filesystem probes faked.
    //
    // The defect this guards: a sample suspended on a stat resumes after
    // `beginProcessing()` has committed, emits `downloading` progress, and the
    // executor's progress reporter sees `updateExecutionProgress(..., "downloading")`
    // fail with a state conflict — which HALTS the reporter and ABORTS the
    // execution. A job that had actually succeeded would end up cancelled.
    const job = claimJob(h.store, "preset:1080");

    const sampleStarted = deferred();
    const releaseStat = deferred();
    let statCalls = 0;
    let progressAfterSettlement = 0;
    let settled = false;

    const statSize = async (): Promise<number | null> => {
      statCalls += 1;
      if (statCalls === 1) {
        sampleStarted.resolve();
        await releaseStat.promise;
        // Under-limit, so this sample would emit progress if it were still live.
        return 12;
      }
      return null;
    };

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        ),
      downloadGeneric: (async (
        url: string,
        workDir: string,
        plan: GenericSingleSourceExecutionPlan,
        ctx: { limits: GenericDownloadLimits; signal?: AbortSignal; onProgress?: (p: unknown) => void },
      ) => {
        const res = await downloadGenericOriginal(url, workDir, plan, {
          limits: ctx.limits,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onProgress: (p) => {
            if (settled) progressAfterSettlement += 1;
            ctx.onProgress?.(p);
          },
          statSize,
          sizePollMs: 1,
          probeRuntime: async () => ({
            available: true,
            version: "2026.08.19",
            reason: "ok" as const,
          }),
          validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
          runner: async () => {
            await sampleStarted.promise;
            fs.writeFileSync(path.join(workDir, "source.mp4"), "GENERIC-BYTES");
            return { code: 0, stdout: "", stderr: "" };
          },
        });
        settled = true;
        // Release the suspended stat at the exact moment acquisition has
        // returned and the executor is about to commit `beginProcessing()`.
        releaseStat.resolve();
        return {
          filePath: res.filePath,
          container: res.container,
          mime: "video/mp4",
          fileSize: res.fileSize,
        };
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);
    await flush();

    const final = h.store.getJob(job.jobId);
    assert.equal(final?.status, "ready", "the job must NOT be aborted by a stale progress write");
    assert.equal(final?.errorCode, null);
    assert.equal(final?.extractor, "yt-dlp");
    assert.equal(h.puts.length, 1, "the object is still uploaded");
    assert.equal(
      progressAfterSettlement,
      0,
      "no progress may be emitted after acquisition settled",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE-10D-WORKER-RESTART-RECOVERY-DETERMINISM-001: the generic regression
// closest to the live Stage-B `shutdown` failure.
//
// The Production case restarted the container while a GENERIC (yt-dlp)
// acquisition was in flight. The old process classified the shutdown abort as
// an ordinary failure and committed
// `PROCESSING_FAILED` / "We couldn't process this video. Try another format or
// source.", so the interrupted row was already terminal by the time the new
// process ran `store.recover()` and the restart message never appeared.
// ─────────────────────────────────────────────────────────────────────────────

describe("generic job: operator shutdown during acquisition", () => {
  it("leaves the row downloading, then recover() writes the restart result", async () => {
    const job = claimJob(h.store, "preset:1080");
    let acquisitionEntered = false;
    let statusAtAcquisition = "";
    let genericCalls = 0;

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        ),
      downloadOriginal: async () => {
        throw new Error("the DIRECT downloader must never run for a generic job");
      },
      downloadGeneric: (async (
        _url: string,
        _workDir: string,
        _plan: GenericExecutionPlan,
        ctx: { signal?: AbortSignal },
      ) => {
        genericCalls += 1;
        statusAtAcquisition = h.store.getJob(job.jobId)?.status ?? "missing";
        acquisitionEntered = true;
        // Blocks until the operator shutdown abort fires, then rejects exactly
        // as a killed yt-dlp process group does.
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AppError("PROCESSING_FAILED", "yt-dlp process group terminated");
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
      processLocally: async () => {
        throw new Error("shutdown must never reach Worker FFmpeg");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    const execution = executor.execute(job);

    // Analysis committed and acquisition is genuinely in flight.
    const deadline = Date.now() + 5000;
    while (!acquisitionEntered && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(acquisitionEntered, true, "generic acquisition must be in flight");
    assert.equal(statusAtAcquisition, "downloading", "acquisition runs while downloading");
    assert.equal(executor.activeJobCount, 1);

    assert.equal(executor.abortActiveForShutdown(), 1, "the generic execution was signalled");

    // The executor drains cleanly inside the grace period.
    await execution;
    assert.equal(executor.activeJobCount, 0);

    // ── BEFORE recover() ────────────────────────────────────────────────────
    const interrupted = h.store.getJob(job.jobId);
    assert.ok(interrupted);
    assert.equal(interrupted.status, "downloading", "the interrupted row stays active");
    assert.notEqual(interrupted.status, "failed", "no ordinary failure was committed");
    assert.notEqual(interrupted.status, "cancelled", "a shutdown is not a user cancellation");
    assert.notEqual(interrupted.status, "ready");
    assert.equal(
      interrupted.extractor,
      "yt-dlp",
      "the Worker's own generic strategy decision survives the interruption",
    );
    assert.equal(interrupted.errorCode, null);
    assert.equal(h.puts.length, 0, "nothing was uploaded");
    assert.equal(genericCalls, 1, "exactly one acquisition attempt");

    // ── The next process owns the transition ────────────────────────────────
    h.store.recover();

    const recovered = h.store.getJob(job.jobId);
    assert.ok(recovered);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.errorCode, "PROCESSING_FAILED");
    assert.equal(recovered.safeErrorMessage, "Worker restarted before the job completed.");
    assert.equal(recovered.stageLabel, "Worker restarted");
    assert.equal(recovered.extractor, "yt-dlp", "recovery preserves the recorded strategy");
  });

  it("still ordinary-fails a generic acquisition that broke WITHOUT a shutdown", async () => {
    const job = claimJob(h.store, "preset:1080");

    const deps: JobExecutorDeps = {
      analyzeForExecution: async () =>
        genericAnalysis(
          [{ id: "preset:1080", container: "mp4", hasVideo: true }],
          { "preset:1080": selection() },
        ),
      downloadGeneric: (async () => {
        throw new AppError("EXTRACTION_FAILED", SENTINEL);
      }) as NonNullable<JobExecutorDeps["downloadGeneric"]>,
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    const final = h.store.getJob(job.jobId);
    assert.equal(final?.status, "failed", "an ordinary generic failure is still terminal at once");
    assert.equal(final?.errorCode, "EXTRACTION_FAILED");
    assert.equal(
      final?.safeErrorMessage,
      "We couldn't extract the video streams from this page.",
    );
    assert.notEqual(
      final?.safeErrorMessage,
      "Worker restarted before the job completed.",
      "an ordinary failure must never masquerade as a restart",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YTDLP-MAX-FILESIZE-REFUSAL-CLASSIFICATION-001: the pinned --max-filesize
// refusal, through the REAL acquisition primitive inside the executor
// ─────────────────────────────────────────────────────────────────────────────

describe("generic job: a pinned --max-filesize refusal (YTDLP-MAX-FILESIZE-REFUSAL-CLASSIFICATION-001)", () => {
  const LIMITS: GenericDownloadLimits = { maxFileSizeBytes: 1000, downloadTimeoutSeconds: 60 };

  /** The stdout the pinned runtime produces when `--max-filesize` refuses `ceiling`. */
  const refusalStdout = (ceiling: number) =>
    "[info] abc: Downloading 1 format(s): 22\n" +
    `\r[download] File is larger than max-filesize (4000 bytes > ${ceiling} bytes). Aborting.\n`;

  type RefusalRecord = {
    argvs: string[][];
    workDir: string;
    /** Set when the run was refused on a LATER chunk and left its `.part`. */
    partPath?: string;
    /** Whether that `.part` still existed when the primitive threw. */
    partExistedWhenAcquisitionThrew?: boolean;
  };

  /**
   * The REAL `downloadGenericOriginal` inside the executor, with only its
   * yt-dlp boundary faked: the run exits 0 having written nothing, exactly as
   * the pinned runtime does when `--max-filesize` refuses. `beforeResult` runs
   * inside that fake subprocess, before it reports.
   *
   * With `partialBytes`, the refusal is of a LATER chunk: the fake subprocess
   * first writes the chunks the pinned `HttpFD` admitted into the `.part` the
   * REAL argv's `--output` names.
   */
  function refusedAcquisition(record: RefusalRecord, beforeResult?: () => void, partialBytes = 0) {
    return (async (
      url: string,
      workDir: string,
      plan: GenericSingleSourceExecutionPlan,
      ctx: { limits: GenericDownloadLimits; signal?: AbortSignal },
    ) => {
      record.workDir = workDir;
      try {
        const res = await downloadGenericOriginal(url, workDir, plan, {
          limits: ctx.limits,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          probeRuntime: async () => ({ available: true, version: "2026.08.19", reason: "ok" as const }),
          validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
          runner: async (call) => {
            record.argvs.push([...call.args]);
            if (partialBytes > 0) {
              const template = call.args
                .find((a) => a.startsWith("--output="))!
                .slice("--output=".length);
              record.partPath = `${template.replace("%(ext)s", "mp4")}.part`;
              fs.writeFileSync(record.partPath, "x".repeat(partialBytes));
            }
            beforeResult?.();
            return { code: 0, stdout: refusalStdout(ctx.limits.maxFileSizeBytes), stderr: "" };
          },
        });
        return { filePath: res.filePath, container: res.container, mime: "video/mp4", fileSize: res.fileSize };
      } catch (err) {
        if (record.partPath) record.partExistedWhenAcquisitionThrew = fs.existsSync(record.partPath);
        throw err;
      }
    }) as NonNullable<JobExecutorDeps["downloadGeneric"]>;
  }

  /** Records the lifecycle transitions and failures the executor attempts. */
  function traceStore() {
    const transitions: string[] = [];
    const failCodes: string[] = [];
    const store = h.store;
    const beginProcessing = store.beginProcessing.bind(store);
    const beginUploading = store.beginUploading.bind(store);
    const failJob = store.failJob.bind(store);
    store.beginProcessing = (...a: Parameters<SQLiteJobStore["beginProcessing"]>) => {
      transitions.push("beginProcessing");
      return beginProcessing(...a);
    };
    store.beginUploading = (...a: Parameters<SQLiteJobStore["beginUploading"]>) => {
      transitions.push("beginUploading");
      return beginUploading(...a);
    };
    store.failJob = (...a: Parameters<SQLiteJobStore["failJob"]>) => {
      failCodes.push(String(a[1]));
      return failJob(...a);
    };
    return { transitions, failCodes };
  }

  const analysis = async () =>
    genericAnalysis(
      [{ id: "preset:1080", container: "mp4", hasVideo: true }],
      { "preset:1080": selection() },
    );

  it("downloading -> failed / TOO_LARGE: no processing, no FFmpeg, no upload, no object key, workDir removed", async () => {
    const job = claimJob(h.store, "preset:1080");
    const trace = traceStore();
    const record = { argvs: [] as string[][], workDir: "" };
    let processed = 0;
    let statusAtAcquisition = "";
    const deps: JobExecutorDeps = {
      analyzeForExecution: analysis,
      genericLimits: LIMITS,
      downloadGeneric: refusedAcquisition(record, () => {
        statusAtAcquisition = h.store.getJob(job.jobId)?.status ?? "missing";
      }),
      processLocally: async () => {
        processed += 1;
        throw new Error("a refused acquisition must never reach Worker FFmpeg");
      },
    };

    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    const final = h.store.getJob(job.jobId);
    assert.equal(statusAtAcquisition, "downloading");
    assert.equal(final?.status, "failed");
    assert.equal(final?.errorCode, "TOO_LARGE");
    assert.equal(final?.safeErrorMessage, ERROR_MESSAGES.TOO_LARGE);
    assert.deepEqual(trace.failCodes, ["TOO_LARGE"]);
    assert.deepEqual(trace.transitions, [], "neither processing nor uploading was attempted");
    assert.equal(processed, 0, "no Worker FFmpeg");
    assert.equal(h.puts.length, 0, "nothing uploaded");
    const row = h.db
      .prepare("SELECT object_key FROM worker_jobs WHERE job_id = ?")
      .get(job.jobId) as { object_key: string | null };
    assert.equal(row.object_key, null, "no object key");
    assert.equal(record.argvs.length, 1, "one acquisition subprocess");
    assert.ok(
      record.argvs[0]!.includes("--max-filesize=1000"),
      "the executor's own limit is the run's allowance",
    );
    assert.ok(record.workDir);
    assert.equal(fs.existsSync(record.workDir), false, "the executor's finally removed the workDir");
  });

  it("an operator shutdown established first stays a restart, never a TOO_LARGE failure", async () => {
    const job = claimJob(h.store, "preset:1080");
    const trace = traceStore();
    const record = { argvs: [] as string[][], workDir: "" };
    const active: { executor?: JobExecutor } = {};
    active.executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyzeForExecution: analysis,
      genericLimits: LIMITS,
      downloadGeneric: refusedAcquisition(record, () => {
        assert.equal(active.executor!.abortActiveForShutdown(), 1);
      }),
    });
    await active.executor.execute(job);

    assert.equal(h.store.getJob(job.jobId)?.status, "downloading", "the row is left ACTIVE for recover()");
    assert.deepEqual(trace.failCodes, [], "the dying process commits no failure at all");
    assert.equal(fs.existsSync(record.workDir), false);
    h.store.recover();
    const recovered = h.store.getJob(job.jobId);
    assert.equal(recovered?.errorCode, "PROCESSING_FAILED");
    assert.equal(recovered?.safeErrorMessage, "Worker restarted before the job completed.");
  });

  it("a user cancellation established first stays cancelled, never a TOO_LARGE failure", async () => {
    const job = claimJob(h.store, "preset:1080");
    const trace = traceStore();
    const record = { argvs: [] as string[][], workDir: "" };
    const active: { executor?: JobExecutor } = {};
    active.executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyzeForExecution: analysis,
      genericLimits: LIMITS,
      downloadGeneric: refusedAcquisition(record, () => {
        assert.equal(active.executor!.cancel(job.jobId).type, "cancelled");
      }),
    });
    await active.executor.execute(job);

    assert.equal(h.store.getJob(job.jobId)?.status, "cancelled");
    assert.deepEqual(trace.failCodes, []);
    assert.equal(fs.existsSync(record.workDir), false);
  });

  // ── the same refusal of a LATER chunk: the run's partial `.part` ─────────

  it("LATER chunk: downloading -> failed / TOO_LARGE, no processing or upload, and the partial .part dies with the workDir", async () => {
    const job = claimJob(h.store, "preset:1080");
    const trace = traceStore();
    const record: RefusalRecord = { argvs: [], workDir: "" };
    let processed = 0;
    let statusAtAcquisition = "";
    const deps: JobExecutorDeps = {
      analyzeForExecution: analysis,
      genericLimits: LIMITS,
      downloadGeneric: refusedAcquisition(
        record,
        () => {
          statusAtAcquisition = h.store.getJob(job.jobId)?.status ?? "missing";
        },
        600,
      ),
      processLocally: async () => {
        processed += 1;
        throw new Error("a refused acquisition must never reach Worker FFmpeg");
      },
    };

    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    const final = h.store.getJob(job.jobId);
    assert.equal(statusAtAcquisition, "downloading");
    assert.equal(final?.status, "failed");
    assert.equal(final?.errorCode, "TOO_LARGE");
    assert.equal(final?.safeErrorMessage, ERROR_MESSAGES.TOO_LARGE);
    assert.deepEqual(trace.failCodes, ["TOO_LARGE"]);
    assert.deepEqual(trace.transitions, [], "neither processing nor uploading was attempted");
    assert.equal(processed, 0, "no Worker FFmpeg");
    assert.equal(h.puts.length, 0, "nothing uploaded");
    const row = h.db
      .prepare("SELECT object_key FROM worker_jobs WHERE job_id = ?")
      .get(job.jobId) as { object_key: string | null };
    assert.equal(row.object_key, null, "no object key");
    assert.ok(record.argvs[0]!.includes("--max-filesize=1000"));
    assert.ok(record.partPath?.startsWith(record.workDir), "the .part was the run's own, inside the workDir");
    assert.equal(record.partExistedWhenAcquisitionThrew, true, "acquisition left the .part to its owner");
    assert.equal(fs.existsSync(record.partPath!), false, "the executor's finally removed the .part");
    assert.equal(fs.existsSync(record.workDir), false, "…with the workDir");
  });

  it("LATER chunk: an operator shutdown established first stays a restart, never a TOO_LARGE failure", async () => {
    const job = claimJob(h.store, "preset:1080");
    const trace = traceStore();
    const record: RefusalRecord = { argvs: [], workDir: "" };
    const active: { executor?: JobExecutor } = {};
    active.executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyzeForExecution: analysis,
      genericLimits: LIMITS,
      downloadGeneric: refusedAcquisition(
        record,
        () => {
          assert.equal(active.executor!.abortActiveForShutdown(), 1);
        },
        600,
      ),
    });
    await active.executor.execute(job);

    assert.equal(h.store.getJob(job.jobId)?.status, "downloading", "the row is left ACTIVE for recover()");
    assert.deepEqual(trace.failCodes, [], "the dying process commits no failure at all");
    assert.equal(fs.existsSync(record.workDir), false, "the partial .part went with the workDir");
    h.store.recover();
    const recovered = h.store.getJob(job.jobId);
    assert.equal(recovered?.errorCode, "PROCESSING_FAILED");
    assert.equal(recovered?.safeErrorMessage, "Worker restarted before the job completed.");
  });

  it("LATER chunk: a user cancellation established first stays cancelled, never a TOO_LARGE failure", async () => {
    const job = claimJob(h.store, "preset:1080");
    const trace = traceStore();
    const record: RefusalRecord = { argvs: [], workDir: "" };
    const active: { executor?: JobExecutor } = {};
    active.executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyzeForExecution: analysis,
      genericLimits: LIMITS,
      downloadGeneric: refusedAcquisition(
        record,
        () => {
          assert.equal(active.executor!.cancel(job.jobId).type, "cancelled");
        },
        600,
      ),
    });
    await active.executor.execute(job);

    assert.equal(h.store.getJob(job.jobId)?.status, "cancelled");
    assert.deepEqual(trace.failCodes, []);
    assert.equal(fs.existsSync(record.workDir), false, "the partial .part went with the workDir");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001: an unknown-audio video
// preset through the REAL analyzer, the REAL planner and the REAL single-source
// downloader. Only the two yt-dlp subprocesses are faked, and no network, no
// public media site and no real yt-dlp is involved.
// ─────────────────────────────────────────────────────────────────────────────

describe("generic job: unknown-audio progressive video (GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001)", () => {
  const MAX = 10 * 1024 * 1024;
  const DOWNLOAD_LIMITS: GenericDownloadLimits = { maxFileSizeBytes: MAX, downloadTimeoutSeconds: 60 };
  const PINNED = { available: true, version: "2026.08.19", reason: "ok" as const };

  const FIXTURE = JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dirname, "..", "analysis", "testdata", "synthetic-x-progressive-unknown-audio.json"),
      "utf8",
    ),
  ) as { formats: Array<Record<string, unknown>> } & Record<string, unknown>;

  /** The fixture, with the progressive formats' `acodec` rewritten (or left absent). */
  function doc(acodec?: string, extra: Array<Record<string, unknown>> = []): string {
    return JSON.stringify({
      ...FIXTURE,
      formats: [
        ...FIXTURE.formats.map((f) => (f.protocol === "https" && acodec !== undefined ? { ...f, acodec } : f)),
        ...extra,
      ],
    });
  }

  /**
   * A deterministic SYNTHETIC video-only MP4 payload: an ISO-BMFF `ftyp` box and
   * a `free` box, with no audio track anywhere. Nothing on the keep-original
   * path parses it, which is the point: actual absence of audio is not itself a
   * reason to fail.
   */
  const SILENT_MP4 = Buffer.concat([
    Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isommp41"),
    Buffer.from([0, 0, 0, 16]), Buffer.from("free"), Buffer.from("no-audio"),
  ]);

  /** The executor's analysis seam: the REAL internal analyzer over a canned yt-dlp document. */
  function realAnalysis(stdout: string, ffmpegAvailable = true): JobExecutorDeps["analyzeForExecution"] {
    return async (url, signal) => {
      const { video, selections, hlsSelections } = await analyzeGenericMediaInternal(url, {
        limits: { analysisTimeoutSeconds: 45, maxVideoDurationSeconds: 7200, maxFileSizeBytes: MAX },
        ffmpegAvailable,
        runner: async () => ({ code: 0, stdout, stderr: "" }),
        probeRuntime: async () => PINNED,
        validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
        ...(signal ? { signal } : {}),
      });
      return { strategy: "yt-dlp", video, selections, hlsSelections };
    };
  }

  type AcquisitionRecord = { argvs: string[][]; plans: GenericExecutionPlan[] };

  /** The executor's acquisition seam: the REAL downloader, with only yt-dlp faked. */
  function realAcquisition(
    record: AcquisitionRecord,
    result: "write-silent-mp4" | "no-format-match",
  ): NonNullable<JobExecutorDeps["downloadGeneric"]> {
    return (async (url: string, workDir: string, plan: GenericSingleSourceExecutionPlan, ctx: { limits: GenericDownloadLimits; signal?: AbortSignal }) => {
      record.plans.push(plan);
      const res = await downloadGenericOriginal(url, workDir, plan, {
        limits: ctx.limits,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        probeRuntime: async () => PINNED,
        validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
        runner: async (call) => {
          record.argvs.push([...call.args]);
          if (result === "no-format-match") {
            // What the pinned runtime reports when the bound selector matches no
            // format of the re-extracted list (proven offline by verify-selector.py).
            return { code: 1, stdout: "", stderr: "ERROR: [generic] synthetic: Requested format is not available. Use --list-formats for a list of available formats\n" };
          }
          fs.writeFileSync(expectedSourcePath(workDir, "mp4"), SILENT_MP4);
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      return { filePath: res.filePath, container: res.container, mime: "video/mp4", fileSize: res.fileSize };
    }) as NonNullable<JobExecutorDeps["downloadGeneric"]>;
  }

  /** Every media-processing and alternative-acquisition seam, counted and forbidden. */
  function forbiddenSeams(counters: { ffmpeg: number; merge: number; split: number; direct: number }): Partial<JobExecutorDeps> {
    return {
      processLocally: async () => {
        counters.ffmpeg += 1;
        throw new Error("keep-original must never invoke Worker FFmpeg");
      },
      mergeSplit: async () => {
        counters.merge += 1;
        throw new Error("no merge (and no merge-time ffprobe) for a single source");
      },
      downloadGenericSplit: async () => {
        counters.split += 1;
        throw new Error("a single source must never reach split acquisition");
      },
      downloadOriginal: async () => {
        counters.direct += 1;
        throw new Error("the direct downloader must never run for a generic job");
      },
    };
  }

  /** A writer that keeps the uploaded bytes, so delivery can be checked byte for byte. */
  function recordingWriter(): { writer: ObjectStoreWriter; bodies: Buffer[] } {
    const bodies: Buffer[] = [];
    const writer: ObjectStoreWriter = {
      ...h.writer,
      async put(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) chunks.push(Buffer.from(chunk as Uint8Array));
        bodies.push(Buffer.concat(chunks));
        h.puts.push(input);
      },
    };
    return { writer, bodies };
  }

  const UNKNOWN_SELECTOR =
    '--format=b*[format_id="synthetic-prog-high"][protocol="https"][ext="mp4"][vcodec!=?"none"][video_ext="mp4"][acodec!=?"none"]';

  it("traverses real analysis -> planning -> acquisition to ready: keep-original, one acquisition, zero FFmpeg", async () => {
    const job = claimJob(h.store, "preset:360");
    const record: AcquisitionRecord = { argvs: [], plans: [] };
    const counters = { ffmpeg: 0, merge: 0, split: 0, direct: 0 };
    const { writer, bodies } = recordingWriter();

    const deps: JobExecutorDeps = {
      analyzeForExecution: realAnalysis(doc()),
      genericLimits: DOWNLOAD_LIMITS,
      downloadGeneric: realAcquisition(record, "write-silent-mp4"),
      ...forbiddenSeams(counters),
    };
    await new JobExecutor(h.store, writer, () => Date.now(), new Map(), deps).execute(job);

    const final = h.store.getJob(job.jobId);
    assert.equal(final?.status, "ready", `job must reach ready, got ${final?.status}/${final?.errorCode}`);
    assert.equal(final?.extractor, "yt-dlp");

    // Exactly one progressive acquisition, of exactly the approved source.
    assert.equal(record.argvs.length, 1, "exactly one acquisition subprocess");
    assert.ok(record.argvs[0]!.includes(UNKNOWN_SELECTOR), "the selector binds the unknown-audio constraint");
    assert.equal(record.argvs[0]!.some((a) => a.includes("+") && a.startsWith("--format=")), false, "no merge");

    // The plan the executor derived for it.
    assert.equal(record.plans.length, 1);
    const plan = record.plans[0]!;
    assert.equal(plan.operation, "keep-original");
    if (plan.operation !== "keep-original") throw new Error("unreachable");
    assert.equal(plan.requestedFormatId, "preset:360");
    assert.equal(plan.targetContainer, "mp4");
    assert.equal(plan.source.audioConstraint, "unknown");
    assert.equal(plan.source.hasAudio, false);

    // No media processing of any kind; the original container, byte for byte.
    assert.deepEqual(counters, { ffmpeg: 0, merge: 0, split: 0, direct: 0 });
    assert.equal(h.puts.length, 1);
    assert.equal(h.puts[0]!.contentType, "video/mp4");
    assert.equal(h.puts[0]!.contentLength, SILENT_MP4.length);
    assert.deepEqual(bodies[0], SILENT_MP4, "the silent original is delivered verbatim");

    // The private upstream id never became durable.
    const row = JSON.stringify(h.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(job.jobId));
    assert.equal(row.includes("synthetic-prog"), false);
  });

  /**
   * HLS-5 + HLS-7: the same real traversal, with a clear-HLS rendition present.
   *
   * Since HLS-7 that rendition backs its OWN presets (`preset:1080` and, being
   * tallest, `preset:best`). This job asks for the progressive `preset:360`,
   * so this is the end-to-end proof that the HLS selection goes NOWHERE on a
   * progressive job — not into the durable row, not into an object key, not
   * into the delivered metadata, not into the acquisition argv — and that the
   * progressive rung it never touched still reaches `ready`.
   */
  it("HLS-5: a private HLS playlist URL reaches no durable row, object key or argv", async () => {
    const TOKEN = "VERY_PRIVATE_HLS_TOKEN";
    const hlsRendition = {
      format_id: "synthetic-hls-1080",
      ext: "mp4",
      video_ext: "mp4",
      height: 1080,
      width: 1920,
      protocol: "m3u8_native",
      vcodec: "avc1.640028",
      acodec: "mp4a.40.2",
      url: `https://media.example.invalid/hls/1080/media.m3u8?sig=${TOKEN}`,
    };

    const job = claimJob(h.store, "preset:360");
    const record: AcquisitionRecord = { argvs: [], plans: [] };
    const counters = { ffmpeg: 0, merge: 0, split: 0, direct: 0 };
    const { writer, bodies } = recordingWriter();

    const analyze = realAnalysis(doc(undefined, [hlsRendition]))!;
    // HLS-7: the rendition really is live in the same analysis — it owns its
    // own rung and, being tallest, `preset:best` — while `preset:360` stays
    // progressive.
    const analysis = await analyze("https://example.invalid/watch/abc");
    assert.deepEqual(Object.keys(analysis.hlsSelections), ["preset:best", "preset:1080"]);
    assert.equal(analysis.selections["preset:360"]?.kind, "single");
    assert.equal("preset:360" in analysis.hlsSelections, false);

    const deps: JobExecutorDeps = {
      analyzeForExecution: analyze,
      genericLimits: DOWNLOAD_LIMITS,
      downloadGeneric: realAcquisition(record, "write-silent-mp4"),
      ...forbiddenSeams(counters),
    };
    await new JobExecutor(h.store, writer, () => Date.now(), new Map(), deps).execute(job);

    // The progressive job is entirely unaffected by the HLS rendition.
    const final = h.store.getJob(job.jobId);
    assert.equal(final?.status, "ready", `got ${final?.status}/${final?.errorCode}`);
    assert.equal(record.argvs.length, 1, "still exactly one progressive acquisition");
    assert.ok(record.argvs[0]!.includes(UNKNOWN_SELECTOR), "the same approved source");
    assert.deepEqual(counters, { ffmpeg: 0, merge: 0, split: 0, direct: 0 });
    assert.deepEqual(bodies[0], SILENT_MP4);

    // The sentinel reached none of the durable or outward surfaces.
    const row = JSON.stringify(h.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(job.jobId));
    assert.equal(row.includes(TOKEN), false, "the playlist URL became durable state");
    assert.equal(row.includes("m3u8"), false);
    assert.equal(row.includes("synthetic-hls"), false);

    assert.equal(h.puts.length, 1);
    const put = h.puts[0]!;
    assert.equal(put.objectKey.includes(TOKEN), false, "the playlist URL became an object key");
    assert.equal(put.objectKey.includes("m3u8"), false);
    assert.equal(put.contentDisposition.includes(TOKEN), false);
    assert.equal(JSON.stringify(final).includes(TOKEN), false, "it reached the job view");

    // Nor the acquisition command line, which is built from the progressive
    // selection alone and never from an upstream URL.
    assert.equal(JSON.stringify(record.argvs).includes(TOKEN), false);
    assert.equal(JSON.stringify(record.plans).includes(TOKEN), false);
  });

  it("re-analysis UNKNOWN -> PRESENT at job time: the proven source is acquired with the STRICT selector", async () => {
    const job = claimJob(h.store, "preset:360");
    const record: AcquisitionRecord = { argvs: [], plans: [] };
    const counters = { ffmpeg: 0, merge: 0, split: 0, direct: 0 };
    const deps: JobExecutorDeps = {
      analyzeForExecution: realAnalysis(doc("mp4a.40.2")),
      genericLimits: DOWNLOAD_LIMITS,
      downloadGeneric: realAcquisition(record, "write-silent-mp4"),
      ...forbiddenSeams(counters),
    };
    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    assert.equal(h.store.getJob(job.jobId)?.status, "ready");
    const plan = record.plans[0]!;
    assert.equal(plan.operation, "keep-original");
    if (plan.operation !== "keep-original") throw new Error("unreachable");
    assert.equal(plan.source.audioConstraint, "codec-present", "the FRESH analysis is authoritative");
    assert.ok(
      record.argvs[0]!.includes(
        '--format=b*[format_id="synthetic-prog-high"][protocol="https"][ext="mp4"][vcodec!=?"none"][video_ext="mp4"][acodec!="none"]',
      ),
    );
    assert.deepEqual(counters, { ffmpeg: 0, merge: 0, split: 0, direct: 0 });
  });

  it("re-analysis UNKNOWN -> ABSENT with no split partner: FORMAT_UNAVAILABLE before any acquisition", async () => {
    const job = claimJob(h.store, "preset:360");
    const record: AcquisitionRecord = { argvs: [], plans: [] };
    const counters = { ffmpeg: 0, merge: 0, split: 0, direct: 0 };
    const deps: JobExecutorDeps = {
      analyzeForExecution: realAnalysis(doc("none")),
      genericLimits: DOWNLOAD_LIMITS,
      downloadGeneric: realAcquisition(record, "write-silent-mp4"),
      ...forbiddenSeams(counters),
    };
    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    const final = h.store.getJob(job.jobId);
    assert.equal(final?.status, "failed");
    assert.equal(final?.errorCode, "FORMAT_UNAVAILABLE");
    assert.equal(record.plans.length, 0, "no plan reached acquisition");
    assert.equal(record.argvs.length, 0, "no acquisition subprocess");
    assert.deepEqual(counters, { ffmpeg: 0, merge: 0, split: 0, direct: 0 });
    assert.equal(h.puts.length, 0);
  });

  it("re-analysis UNKNOWN -> ABSENT with a valid split partner: routed to the existing merge-split path", async () => {
    const job = claimJob(h.store, "preset:360");
    const record: AcquisitionRecord = { argvs: [], plans: [] };
    const splitPlans: GenericExecutionPlan[] = [];
    const partner = {
      format_id: "synthetic-audio-m4a", ext: "m4a", protocol: "https",
      vcodec: "none", acodec: "mp4a.40.2", video_ext: "none", audio_ext: "m4a",
    };
    const deps: JobExecutorDeps = {
      analyzeForExecution: realAnalysis(doc("none", [partner]), true),
      genericLimits: DOWNLOAD_LIMITS,
      downloadGeneric: realAcquisition(record, "write-silent-mp4"),
      downloadGenericSplit: async (_url, _workDir, plan) => {
        splitPlans.push(plan);
        // Routing is what is under test here; SPLIT-04's own suites cover the rest.
        throw new AppError("NETWORK_ERROR");
      },
    };
    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    assert.equal(record.plans.length, 0, "the single-source seam was not used");
    assert.equal(splitPlans.length, 1);
    const plan = splitPlans[0]!;
    assert.equal(plan.operation, "merge-split");
    if (plan.operation !== "merge-split") throw new Error("unreachable");
    assert.equal(plan.pair.video.formatId, "synthetic-prog-high");
    assert.equal(plan.pair.audio.formatId, "synthetic-audio-m4a");
  });

  it("drift AFTER job analysis, before acquisition: the unknown selector matches nothing -> FORMAT_UNAVAILABLE, no substitution", async () => {
    const job = claimJob(h.store, "preset:360");
    const record: AcquisitionRecord = { argvs: [], plans: [] };
    const counters = { ffmpeg: 0, merge: 0, split: 0, direct: 0 };
    const deps: JobExecutorDeps = {
      analyzeForExecution: realAnalysis(doc()),
      genericLimits: DOWNLOAD_LIMITS,
      downloadGeneric: realAcquisition(record, "no-format-match"),
      ...forbiddenSeams(counters),
    };
    await new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps).execute(job);

    const final = h.store.getJob(job.jobId);
    assert.equal(final?.status, "failed");
    assert.equal(final?.errorCode, "FORMAT_UNAVAILABLE");
    assert.equal(record.argvs.length, 1, "one attempt at the approved source, and no other");
    assert.ok(record.argvs[0]!.includes(UNKNOWN_SELECTOR));
    assert.equal(record.argvs[0]!.some((a) => a.startsWith("--format=") && a.includes("/")), false, "no fallback");
    assert.deepEqual(counters, { ffmpeg: 0, merge: 0, split: 0, direct: 0 });
    assert.equal(h.puts.length, 0);
  });
});
