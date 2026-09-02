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
import type { DurableWorkerJob } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import type { GenericSourceSelections } from "./generic-source.ts";
import { downloadGenericOriginal, type GenericDownloadLimits } from "./ytdlp-download.server.ts";
import type { GenericExecutionPlan } from "./format-plan.ts";

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

function selection(over: Partial<GenericSourceSelections[string]> = {}) {
  return {
    formatId: "22",
    protocol: "https" as const,
    container: "mp4" as const,
    hasVideo: true,
    hasAudio: true,
    fileSize: null,
    ...over,
  };
}

function genericAnalysis(
  presets: PresetSpec[],
  selections: GenericSourceSelections,
): ExecutionAnalysis {
  return { strategy: "yt-dlp", video: genericMeta(presets), selections };
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

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
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

  it("shutdown aborts generic acquisition without writing a cancelled state", async () => {
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
    // A restart is not a user cancellation: the job fails deterministically.
    assert.equal(final?.status, "failed");
    assert.equal(h.puts.length, 0);
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
        plan: GenericExecutionPlan,
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
