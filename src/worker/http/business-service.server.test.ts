import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../../lib/errors.ts";
import type { WorkerVideoMetadata } from "../../shared/worker/contracts.ts";
import { JobExecutor } from "../execution/job-executor.server.ts";
import { QueuePump } from "../execution/queue-pump.server.ts";
import { QueueRunner } from "../execution/queue-runner.server.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type { ObjectStoreWriter } from "../storage/writer.ts";
import { WorkerService } from "./business-service.server.ts";
import { WorkerBusinessError } from "./errors.server.ts";

const KEY_A = "11111111-1111-4111-a111-111111111111";
const KEY_B = "22222222-2222-4222-a222-222222222222";

const META: WorkerVideoMetadata = {
  title: "Clip",
  thumbnail: null,
  duration: 10,
  source: "cdn.example",
  extractor: "direct",
  webpageUrl: "https://cdn.example/a.mp4",
  formats: [],
  presets: [],
  capabilities: { mp3: false, merge: false },
};

class NoopWriter implements ObjectStoreWriter {
  async put() {}
  async head() {
    return null;
  }
  async delete() {}
}

function request(url = "https://cdn.example/a.mp4", formatId = "direct-original") {
  return { url, formatId, principalId: "private-access-user" as const };
}

describe("Worker business service", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let executor: JobExecutor;
  let pump: QueuePump;
  let now: number;

  function makeService(overrides: Partial<{ analyze: typeof failingAnalyze }> = {}) {
    return new WorkerService({
      store,
      executor,
      pump,
      analyze: overrides.analyze ?? (async () => META),
      probeBinaries: async () => ({ ffmpeg: true, ytdlp: false }),
      clock: () => now,
    });
  }

  const failingAnalyze = async (): Promise<WorkerVideoMetadata> => {
    throw new AppError("EXTRACTOR_UNAVAILABLE");
  };

  beforeEach(() => {
    now = 1_700_000_000_000;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videofetch-worker-service-"));
    dbPath = path.join(tempDir, "state.sqlite");
    db = openWorkerDatabase({ path: dbPath });
    applyMigrations(db);
    store = new SQLiteJobStore({ db, clock: () => now });
    executor = new JobExecutor(store, new NoopWriter(), () => now);
    pump = new QueuePump(new QueueRunner(store, executor));
  });

  afterEach(() => {
    try {
      db.close();
    } catch (e) {
      void e;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── analyze ───────────────────────────────────────────────────────────────

  it("returns the exact shared analyze success schema", async () => {
    const res = await makeService().analyze({ url: "https://cdn.example/a.mp4" });
    assert.equal(res.success, true);
    assert.equal(res.video.title, "Clip");
    assert.deepEqual(Object.keys(res).sort(), ["success", "video"]);
  });

  it("propagates a fail-closed generic-URL rejection", async () => {
    await assert.rejects(
      () => makeService({ analyze: failingAnalyze }).analyze({ url: "https://example.com/watch" }),
      (err: unknown) => err instanceof AppError && err.code === "EXTRACTOR_UNAVAILABLE",
    );
  });

  // ── create ────────────────────────────────────────────────────────────────

  it("creates a queued job with 201 and wakes the pump", async () => {
    const service = makeService();
    const res = await service.createJob(request(), KEY_A);
    assert.equal(res.status, 201);
    assert.equal(res.body.job.status, "queued");
    assert.equal(res.body.job.objectKey, null);
    // The pump was signalled but the HTTP path did not await execution.
    assert.equal(pump.isRunning, true);
    await pump.whenDrained();
  });

  it("returns the same job at 200 for the same key and payload", async () => {
    const service = makeService();
    const first = await service.createJob(request(), KEY_A);
    const second = await service.createJob(request(), KEY_A);
    assert.equal(second.status, 200);
    assert.equal(second.body.job.jobId, first.body.job.jobId);
    await pump.whenDrained();
  });

  it("rejects the same key with a different payload as 409 and creates nothing", async () => {
    const service = makeService();
    await service.createJob(request(), KEY_A);
    await pump.whenDrained();
    const before = store.listQueuedJobs(100).length;

    await assert.rejects(
      () => service.createJob(request("https://cdn.example/other.mp4"), KEY_A),
      (err: unknown) =>
        err instanceof WorkerBusinessError &&
        err.code === "PROCESSING_FAILED" &&
        err.httpStatus === 409,
    );
    assert.equal(store.listQueuedJobs(100).length, before);
  });

  it("returns EXPIRED when the retained key references an expired job", async () => {
    const service = makeService();
    await service.createJob(request(), KEY_A);
    await pump.whenDrained();

    now += 46 * 60 * 1000;
    await assert.rejects(
      () => service.createJob(request(), KEY_A),
      (err: unknown) => err instanceof WorkerBusinessError && err.code === "EXPIRED",
    );
  });

  // ── get ───────────────────────────────────────────────────────────────────

  it("404s an unknown job", async () => {
    await assert.rejects(
      () => makeService().getJob("0123456789abcdef0123456789abcdef"),
      (err: unknown) =>
        err instanceof WorkerBusinessError && err.code === "NOT_FOUND" && err.httpStatus === 404,
    );
  });

  it("410s an expired job rather than returning stale metadata", async () => {
    const service = makeService();
    const created = await service.createJob(request(), KEY_B);
    await pump.whenDrained();

    now += 46 * 60 * 1000;
    await assert.rejects(
      () => service.getJob(created.body.job.jobId),
      (err: unknown) =>
        err instanceof WorkerBusinessError && err.code === "EXPIRED" && err.httpStatus === 410,
    );
  });

  it("returns the server-to-server job view for a live job", async () => {
    const service = makeService();
    const created = await service.createJob(request(), KEY_A);
    const got = await service.getJob(created.body.job.jobId);
    assert.equal(got.success, true);
    assert.equal(got.job.jobId, created.body.job.jobId);
    assert.ok("objectKey" in got.job, "the authenticated boundary carries objectKey");
    await pump.whenDrained();
  });

  // ── cancel ────────────────────────────────────────────────────────────────

  it("404s cancelling a missing job", async () => {
    await assert.rejects(
      () => makeService().cancelJob("0123456789abcdef0123456789abcdef"),
      (err: unknown) => err instanceof WorkerBusinessError && err.code === "NOT_FOUND",
    );
  });

  it("cancels a queued job and is idempotent afterwards", async () => {
    const service = makeService();
    const created = await service.createJob(request(), KEY_A);
    const jobId = created.body.job.jobId;

    const first = await service.cancelJob(jobId);
    assert.equal(first.job.status, "cancelled");

    const second = await service.cancelJob(jobId);
    assert.equal(second.job.status, "cancelled");
    await pump.whenDrained();
  });

  it("leaves an already-terminal job unchanged", async () => {
    const service = makeService();
    const created = await service.createJob(request(), KEY_A);
    const jobId = created.body.job.jobId;
    store.failJob(jobId, "TIMEOUT", "The video took too long to process.");

    const res = await service.cancelJob(jobId);
    assert.equal(res.job.status, "failed");
    assert.equal(res.job.errorCode, "TIMEOUT");
    await pump.whenDrained();
  });

  it("routes cancellation through the executor so active work is aborted", async () => {
    let aborted = false;
    const controllers = new Map<string, AbortController>();
    const abortingExecutor = new JobExecutor(store, new NoopWriter(), () => now, controllers);
    const service = new WorkerService({
      store,
      executor: abortingExecutor,
      pump,
      analyze: async () => META,
      probeBinaries: async () => ({ ffmpeg: true, ytdlp: false }),
      clock: () => now,
    });

    const created = await service.createJob(request(), KEY_A);
    const jobId = created.body.job.jobId;
    store.claimNextQueuedJob();

    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      aborted = true;
    });
    controllers.set(jobId, controller);

    const res = await service.cancelJob(jobId);
    assert.equal(res.job.status, "cancelled");
    assert.equal(aborted, true, "the in-flight execution must receive the AbortSignal");
    await pump.whenDrained();
  });

  // ── diagnostics ───────────────────────────────────────────────────────────

  it("reports the exact diagnostics contract with maxConcurrent 1", async () => {
    const service = makeService();
    await service.createJob(request(), KEY_A);
    await pump.whenDrained();

    const diag = await service.diagnostics();
    assert.deepEqual(Object.keys(diag).sort(), [
      "binaries",
      "maxConcurrent",
      "queueDepth",
      "runningJobs",
      "safeEgress",
      "status",
    ]);
    assert.equal(diag.maxConcurrent, 1);
    assert.equal(typeof diag.queueDepth, "number");
    assert.equal(diag.runningJobs, 0);
    assert.equal(diag.binaries.ffmpeg, true);
    assert.equal(diag.binaries.ytdlp, false);
  });

  it("keeps safe-egress attestation fail-closed by default", async () => {
    const previous = process.env.YTDLP_NETWORK_ISOLATED;
    try {
      delete process.env.YTDLP_NETWORK_ISOLATED;
      const diag = await makeService().diagnostics();
      assert.equal(diag.safeEgress.attested, false);
      assert.equal(diag.safeEgress.policyVersion, null);
    } finally {
      if (previous === undefined) delete process.env.YTDLP_NETWORK_ISOLATED;
      else process.env.YTDLP_NETWORK_ISOLATED = previous;
    }
  });

  it("degrades status when FFmpeg is unavailable", async () => {
    const service = new WorkerService({
      store,
      executor,
      pump,
      analyze: async () => META,
      probeBinaries: async () => ({ ffmpeg: false, ytdlp: false }),
      clock: () => now,
    });
    const diag = await service.diagnostics();
    assert.equal(diag.status, "degraded");
  });
});
