import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError, ERROR_MESSAGES, type ErrorCode } from "@/lib/errors";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import type { DurableWorkerJob } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";
import type { WorkerRequestedFormatId } from "../../shared/worker/contracts.ts";
import { Readable } from "node:stream";
import { setSafeHttpTestHooks } from "@/lib/security/safe-http.server";
import { WORKER_RESTART_SAFE_MESSAGE } from "@/shared/worker/job-failure";
import { toPublicJob } from "@/web/jobs/public-job";

/** Markers that must never survive into durable state or any log line. */
const RAW_MARKERS = [
  "SECRET_HTTP_TOKEN",
  "PRIVATE_FS_PATH",
  "FFMPEG_SECRET",
  "R2_SECRET",
] as const;

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
  store: SQLiteJobStore;
  puts: ObjectStorePutInput[];
  deletes: string[];
  writer: ObjectStoreWriter;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-fail-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const store = new SQLiteJobStore({ db });

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
    store,
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

function claimJob(store: SQLiteJobStore, formatId: WorkerRequestedFormatId): DurableWorkerJob {
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

/**
 * Asserts the full terminal contract for one failure mode:
 * exact error code, canonical safe message, zero raw leakage, a preserved
 * terminal winner, and an attempted workDir cleanup.
 */
function assertSafeTerminalFailure(
  h: Harness,
  executor: JobExecutor,
  jobId: string,
  expected: ErrorCode,
  label: string,
) {
  const view = h.store.getJob(jobId)!;
  assert.equal(view.status, "failed", `${label}: terminal status`);
  assert.equal(view.errorCode, expected, `${label}: error code`);
  assert.equal(
    view.safeErrorMessage,
    ERROR_MESSAGES[expected],
    `${label}: canonical safe message`,
  );

  const serialized = JSON.stringify(view);
  for (const marker of RAW_MARKERS) {
    assert.ok(!serialized.includes(marker), `${label}: durable state leaked ${marker}`);
  }
  assert.ok(!serialized.includes(h.tempDir), `${label}: durable state leaked a local path`);

  // The terminal winner is preserved: a later cancel cannot rewrite it.
  const cancelResult = executor.cancel(jobId);
  assert.equal(cancelResult.type, "unchanged", `${label}: terminal winner preserved`);
  const after = h.store.getJob(jobId)!;
  assert.equal(after.status, "failed", `${label}: still failed`);
  assert.equal(after.errorCode, expected, `${label}: error code unchanged`);
  assert.equal(after.safeErrorMessage, ERROR_MESSAGES[expected], `${label}: message unchanged`);

  // Cleanup was attempted: the job directory no longer exists.
  assert.equal(
    fs.existsSync(path.join(h.tempDir, "jobs", jobId)),
    false,
    `${label}: workDir cleanup attempted`,
  );
}

describe("failure matrix", () => {
  let h: Harness;
  const consoleErrors: unknown[][] = [];
  const originalConsoleError = console.error;

  beforeEach(() => {
    h = makeHarness();
    consoleErrors.length = 0;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
    h.cleanup();
  });

  function run(formatId: WorkerRequestedFormatId, deps: JobExecutorDeps) {
    const job = claimJob(h.store, formatId);
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    return { job, executor, done: executor.execute(job) };
  }

  it("analysis failure → ANALYSIS_FAILED with no raw leakage", async () => {
    const { job, executor, done } = run("direct-original", {
      analyze: async () => {
        throw new AppError("ANALYSIS_FAILED", "probe blew up with SECRET_HTTP_TOKEN=abc123");
      },
    });
    await done;
    assertSafeTerminalFailure(h, executor, job.jobId, "ANALYSIS_FAILED", "analysis failure");
    assert.equal(h.puts.length, 0);
  });

  it("network failure during download → NETWORK_ERROR", async () => {
    const { job, executor, done } = run("direct-original", {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async () => {
        throw new AppError("NETWORK_ERROR", "connect failed: SECRET_HTTP_TOKEN in header");
      },
    });
    await done;
    assertSafeTerminalFailure(h, executor, job.jobId, "NETWORK_ERROR", "network failure");
    assert.equal(h.puts.length, 0);
  });

  it("oversized source → TOO_LARGE", async () => {
    const { job, executor, done } = run("direct-original", {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async () => {
        throw new AppError("TOO_LARGE", "exceeded while writing PRIVATE_FS_PATH=/var/secret");
      },
    });
    await done;
    assertSafeTerminalFailure(h, executor, job.jobId, "TOO_LARGE", "too large");
    assert.equal(h.puts.length, 0);
  });

  it("processing timeout → TIMEOUT", async () => {
    const { job, executor, done } = run("preset:mp3", {
      analyze: async () =>
        buildMeta({ container: "mp4", hasVideo: true }, [
          { id: "preset:mp3", container: "mp3", hasVideo: false },
        ]),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
      processLocally: async () => {
        throw new AppError("TIMEOUT", "ffmpeg killed, stderr: FFMPEG_SECRET");
      },
    });
    await done;
    assertSafeTerminalFailure(h, executor, job.jobId, "TIMEOUT", "processing timeout");
    assert.equal(h.puts.length, 0);
  });

  it("generic processing exception → PROCESSING_FAILED", async () => {
    const { job, executor, done } = run("preset:mp3", {
      analyze: async () =>
        buildMeta({ container: "mp4", hasVideo: true }, [
          { id: "preset:mp3", container: "mp3", hasVideo: false },
        ]),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
      processLocally: async () => {
        throw new Error("unhandled: FFMPEG_SECRET spilled from PRIVATE_FS_PATH");
      },
    });
    await done;
    assertSafeTerminalFailure(h, executor, job.jobId, "PROCESSING_FAILED", "generic processing");
    assert.equal(h.puts.length, 0);
  });

  it("containment failure (output escapes workDir) → PROCESSING_FAILED", async () => {
    const escapeTarget = path.join(h.tempDir, "escaped.mp3");
    fs.writeFileSync(escapeTarget, "escaped-bytes");

    const { job, executor, done } = run("preset:mp3", {
      analyze: async () =>
        buildMeta({ container: "mp4", hasVideo: true }, [
          { id: "preset:mp3", container: "mp3", hasVideo: false },
        ]),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
      // A misbehaving processor points at a real file outside the job dir.
      processLocally: async () => escapeTarget,
    });
    await done;
    assertSafeTerminalFailure(h, executor, job.jobId, "PROCESSING_FAILED", "containment failure");
    assert.equal(h.puts.length, 0, "an escaping artifact must never be uploaded");
  });

  it("storage put failure → PROCESSING_FAILED and the object is cleaned up", async () => {
    const job = claimJob(h.store, "direct-original");
    const failingWriter: ObjectStoreWriter = {
      ...h.writer,
      async put() {
        throw new Error("provider rejected upload: R2_SECRET=aki123");
      },
    };
    const executor = new JobExecutor(h.store, failingWriter, () => Date.now(), new Map(), {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
    });
    await executor.execute(job);

    assertSafeTerminalFailure(h, executor, job.jobId, "PROCESSING_FAILED", "put failure");
    assert.equal(h.deletes.length, 1, "a failed put still attempts exactly one cleanup delete");
  });

  it("storage head failure → PROCESSING_FAILED and the object is cleaned up", async () => {
    const job = claimJob(h.store, "direct-original");
    const failingWriter: ObjectStoreWriter = {
      ...h.writer,
      async put(input) {
        h.puts.push(input);
        for await (const chunk of input.body) void chunk;
      },
      async head() {
        throw new Error("provider head failed: R2_SECRET leaked here");
      },
    };
    const executor = new JobExecutor(h.store, failingWriter, () => Date.now(), new Map(), {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
    });
    await executor.execute(job);

    assertSafeTerminalFailure(h, executor, job.jobId, "PROCESSING_FAILED", "head failure");
    assert.deepEqual(h.deletes, [h.puts[0]!.objectKey], "the exact uploaded key is deleted");
  });

  it("temp-directory creation failure → PROCESSING_FAILED before any media work", async () => {
    const job = claimJob(h.store, "direct-original");

    // Point the temp root at a regular file so the jobs root cannot be created.
    const blocker = path.join(h.tempDir, "not-a-directory");
    fs.writeFileSync(blocker, "x");
    setTempDirectoryForTests(blocker);

    let analyzed = 0;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => {
        analyzed += 1;
        throw new Error("unreachable");
      },
    });
    await executor.execute(job);
    setTempDirectoryForTests(h.tempDir);

    assert.equal(analyzed, 0, "no analysis may run when the job directory cannot be created");
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "PROCESSING_FAILED");
    assert.equal(view.safeErrorMessage, ERROR_MESSAGES.PROCESSING_FAILED);
    assert.equal(h.puts.length, 0);
    assert.equal(
      JSON.stringify(view).includes(blocker),
      false,
      "the unusable path must never reach durable state",
    );
  });

  it("no raw execution error is ever written to console", async () => {
    const { done } = run("direct-original", {
      analyze: async () => {
        throw new AppError("ANALYSIS_FAILED", "SECRET_HTTP_TOKEN=abc PRIVATE_FS_PATH=/etc");
      },
    });
    await done;

    const logged = JSON.stringify(consoleErrors);
    for (const marker of RAW_MARKERS) {
      assert.ok(!logged.includes(marker), `console leaked ${marker}`);
    }
    assert.deepEqual(consoleErrors, [], "execution must not log raw diagnostics at all");
  });

  it("expired jobs terminate with EXPIRED and never download", async () => {
    const job = claimJob(h.store, "direct-original");
    let analyzed = 0;
    const executor = new JobExecutor(
      h.store,
      h.writer,
      () => job.expiresAt + 1,
      new Map(),
      {
        analyze: async () => {
          analyzed += 1;
          throw new Error("unreachable");
        },
      },
    );
    await executor.execute(job);

    assert.equal(analyzed, 0);
    assertSafeTerminalFailure(h, executor, job.jobId, "EXPIRED", "expired job");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA-EXECUTION-FAILURE-CLASSIFICATION-001: from a Worker execution failure to
// the browser DTO. Each case runs the real executor against the real durable
// store and then projects the stored view through the control plane's own
// `toPublicJob`, so the code, message and stage asserted here are exactly what
// `/api/download/:jobId/status` would send.
// ─────────────────────────────────────────────────────────────────────────────

describe("failure classification end to end: Worker → public job", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    setSafeHttpTestHooks(null);
    h.cleanup();
  });

  /** Capacity is not under test here, so the preflight never reads the disk. */
  const plenty: Pick<JobExecutorDeps, "availableWorkDirBytes"> = {
    availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
  };

  function assertPublicFailure(
    jobId: string,
    code: ErrorCode,
    stage: string,
    message: string = ERROR_MESSAGES[code],
  ) {
    const dto = toPublicJob(h.store.getJob(jobId)!, Date.now());
    assert.equal(dto.status, "failed");
    assert.equal(dto.errorCode, code);
    assert.equal(dto.error, message);
    assert.equal(dto.stageLabel, stage);
    const json = JSON.stringify(dto);
    for (const marker of [...RAW_MARKERS, "ECONNRESET", h.tempDir]) {
      assert.ok(!json.includes(marker), `the public job leaked ${marker}`);
    }
    return dto;
  }

  it("a connection reset mid-body in the REAL direct downloader → NETWORK_ERROR, not PROCESSING_FAILED", async () => {
    // What Node's HTTP client really emits when the source drops the
    // connection after the headers: a raw, non-AppError "aborted" / ECONNRESET.
    const reset = Object.assign(new Error("aborted SECRET_HTTP_TOKEN"), { code: "ECONNRESET" });
    let sent = false;
    const body = new Readable({
      read() {
        if (sent) {
          this.destroy(reset);
          return;
        }
        sent = true;
        this.push(Buffer.from("partial-media"));
      },
    });
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      requestOnce: async () => ({
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "1000" },
        body,
      }),
    });

    const job = claimJob(h.store, "direct-original");
    // No `downloadOriginal` seam: the production direct downloader runs.
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      ...plenty,
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
    });
    await executor.execute(job);

    const dto = assertPublicFailure(job.jobId, "NETWORK_ERROR", "Download failed");
    assert.notEqual(dto.errorCode, "PROCESSING_FAILED");
    assert.equal(h.puts.length, 0);
  });

  const acquisition: ReadonlyArray<readonly [ErrorCode, string]> = [
    ["NETWORK_ERROR", "connect refused: SECRET_HTTP_TOKEN"],
    ["TIMEOUT", "deadline passed writing PRIVATE_FS_PATH=/var/jobs"],
    ["TOO_LARGE", "exceeded while writing PRIVATE_FS_PATH=/var/secret"],
    ["VIDEO_UNAVAILABLE", "404 from SECRET_HTTP_TOKEN host"],
    ["EXTRACTION_FAILED", "ERROR: [generic] SECRET_HTTP_TOKEN unsupported"],
    ["EXTRACTOR_UNAVAILABLE", "spawn PRIVATE_FS_PATH/yt-dlp ENOENT"],
    ["FORMAT_UNAVAILABLE", "requested format not available: SECRET_HTTP_TOKEN"],
  ];
  for (const [code, raw] of acquisition) {
    it(`acquisition ${code} stays ${code} with its canonical message`, async () => {
      const job = claimJob(h.store, "direct-original");
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
        ...plenty,
        analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
        downloadOriginal: async () => {
          throw new AppError(code, raw);
        },
      });
      await executor.execute(job);
      assertPublicFailure(job.jobId, code, "Download failed");
    });
  }

  const reanalysis: ReadonlyArray<ErrorCode> = [
    "VIDEO_UNAVAILABLE",
    "EXTRACTION_FAILED",
    "EXTRACTOR_UNAVAILABLE",
    "NETWORK_ERROR",
    "TIMEOUT",
    "TOO_LONG",
  ];
  for (const code of reanalysis) {
    it(`execution-time analysis ${code} stays ${code}`, async () => {
      const job = claimJob(h.store, "direct-original");
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
        ...plenty,
        analyze: async () => {
          throw new AppError(code, "stderr: SECRET_HTTP_TOKEN at PRIVATE_FS_PATH");
        },
      });
      await executor.execute(job);
      assertPublicFailure(job.jobId, code, "Download failed");
    });
  }

  it("a format no longer offered at execution time → FORMAT_UNAVAILABLE", async () => {
    const job = claimJob(h.store, "preset:720");
    let downloaded = 0;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      ...plenty,
      // Re-analysis no longer advertises the requested preset.
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async () => {
        downloaded += 1;
        throw new Error("unreachable");
      },
    });
    await executor.execute(job);
    assertPublicFailure(job.jobId, "FORMAT_UNAVAILABLE", "Download failed");
    assert.equal(downloaded, 0);
  });

  it("a local transcode failure → PROCESSING_FAILED, the neutral message and the Processing stage", async () => {
    const job = claimJob(h.store, "preset:mp3");
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      ...plenty,
      analyze: async () =>
        buildMeta({ container: "mp4", hasVideo: true }, [
          { id: "preset:mp3", container: "mp3", hasVideo: false },
        ]),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
      processLocally: async () => {
        throw new Error("ffmpeg exited 1: FFMPEG_SECRET in PRIVATE_FS_PATH");
      },
    });
    await executor.execute(job);
    const dto = assertPublicFailure(job.jobId, "PROCESSING_FAILED", "Processing failed");
    assert.equal(dto.error, "VideoFetch couldn't complete this download.");
    assert.ok(!/another format|another source/i.test(dto.error ?? ""), "no unfounded advice");
  });

  it("an object-store failure → PROCESSING_FAILED with the Upload stage and no storage text", async () => {
    const job = claimJob(h.store, "direct-original");
    const failingWriter: ObjectStoreWriter = {
      ...h.writer,
      async put() {
        throw new Error("provider rejected upload: R2_SECRET=aki123");
      },
    };
    const executor = new JobExecutor(h.store, failingWriter, () => Date.now(), new Map(), {
      ...plenty,
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
    });
    await executor.execute(job);
    assertPublicFailure(job.jobId, "PROCESSING_FAILED", "Upload failed");
  });

  it("an arbitrary non-AppError exception → PROCESSING_FAILED, and none of its text is public", async () => {
    const job = claimJob(h.store, "direct-original");
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      ...plenty,
      analyze: async () => {
        const err = new TypeError("SECRET_HTTP_TOKEN=abc at PRIVATE_FS_PATH/worker.ts:1:1");
        (err as { code?: string }).code = "NOT_A_WORKER_CODE";
        throw err;
      },
    });
    await executor.execute(job);
    const dto = assertPublicFailure(job.jobId, "PROCESSING_FAILED", "Download failed");
    assert.ok(!JSON.stringify(dto).includes("NOT_A_WORKER_CODE"));
    assert.ok(!JSON.stringify(dto).includes("worker.ts"));
  });

  it("a Worker restart keeps its exact restart message and stage", () => {
    const job = claimJob(h.store, "direct-original");
    assert.equal(h.store.getJob(job.jobId)!.status, "analyzing");
    h.store.recover();
    assertPublicFailure(job.jobId, "PROCESSING_FAILED", "Worker restarted", WORKER_RESTART_SAFE_MESSAGE);
  });
});
