import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { AppError, ERROR_MESSAGES } from "../errors.ts";
import { resetRateLimitForTests } from "./rate-limit.server.ts";
import { ACCESS_COOKIE_NAME, mintSessionToken, setPrivateAccessTestEnv } from "./private-access.server.ts";
import { handleDownloadCancel, resetPrivateAccessApiForTests } from "./private-access-api.server.ts";
import { setTempDirectoryForTests } from "../../services/temp/files.server.ts";
import type { WorkerObjectKey, WorkerVideoMetadata } from "../../shared/worker/contracts.ts";
import { resetWorkerRuntimeForTests, setWorkerClientForTests } from "../../web/config/worker-runtime.server.ts";
import { WorkerClient } from "../../web/worker/worker-client.server.ts";
import { JobExecutor } from "../../worker/execution/job-executor.server.ts";
import { QueuePump } from "../../worker/execution/queue-pump.server.ts";
import { QueueRunner } from "../../worker/execution/queue-runner.server.ts";
import { WorkerService } from "../../worker/http/business-service.server.ts";
import { createWorkerServer } from "../../worker/http/server.server.ts";
import { SQLiteWorkerReplayStore } from "../../worker/security/sqlite-replay-store.server.ts";
import { openWorkerDatabase } from "../../worker/state/database.server.ts";
import { applyMigrations } from "../../worker/state/migrations.server.ts";
import { SQLiteJobStore } from "../../worker/state/sqlite-job-store.server.ts";
import type { ObjectStoreHead, ObjectStoreWriter } from "../../worker/storage/writer.ts";

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: the browser-facing
 * cancel route against a REAL Worker, end to end on loopback.
 *
 * Real control-plane handler, real HMAC WorkerClient, real Worker HTTP server
 * with request authentication and durable replay reservation, real SQLite store,
 * real queue and executor. Only the media operations are injected, so each job
 * can be held in the phase under test until the cancellation aborts it. No
 * network, no R2, no yt-dlp, no FFmpeg. Nothing in the Worker is changed.
 */

const KEY_ID = "ld4a-cancel-contract";
const WORKER_SECRET = "ld4a-cancel-contract-worker-secret-0123";
const ACCESS_SECRET = "ld4a-cancel-contract-access-secret-0123";
const MEDIA_URL = "https://cdn.example/clip.mp4";

type Phase = "analyzing" | "downloading" | "processing" | "uploading";

function metadata(withMp3: boolean): WorkerVideoMetadata {
  return {
    title: "Contract Clip",
    thumbnail: null,
    duration: 12,
    source: "cdn.example",
    extractor: "direct",
    webpageUrl: MEDIA_URL,
    formats: [
      {
        id: "direct-original",
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
    presets: withMp3
      ? [
          {
            id: "preset:mp3",
            label: "MP3",
            resolution: null,
            container: "mp3",
            fileSize: null,
            hasVideo: false,
            hasAudio: true,
            formatId: "preset:mp3",
            videoCodec: null,
            audioCodec: "mp3",
            fps: null,
          },
        ]
      : [],
    capabilities: { mp3: withMp3, merge: false },
  };
}

/** One held operation: resolves `entered` when reached, then waits for its abort. */
class Hold {
  entered!: Promise<AbortSignal>;
  private enter!: (signal: AbortSignal) => void;
  aborted = false;
  constructor() {
    this.entered = new Promise((resolve) => {
      this.enter = resolve;
    });
  }
  async run(signal: AbortSignal | undefined): Promise<never> {
    assert.ok(signal, "the operation must receive the job's signal");
    this.enter(signal);
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    this.aborted = true;
    throw new AppError("PROCESSING_FAILED", "aborted by the test hold");
  }
}

class MemoryWriter implements ObjectStoreWriter {
  objects = new Map<string, ObjectStoreHead>();
  deleted: string[] = [];
  putCalls = 0;
  hold: Hold | null = null;
  async put(input: Parameters<ObjectStoreWriter["put"]>[0], context?: Parameters<ObjectStoreWriter["put"]>[1]) {
    this.putCalls += 1;
    if (this.hold) {
      const hold = this.hold;
      this.hold = null;
      await hold.run(context?.signal);
    }
    for await (const chunk of input.body) void chunk;
    this.objects.set(input.objectKey, {
      objectKey: input.objectKey,
      contentLength: input.contentLength,
      contentType: input.contentType,
      contentDisposition: input.contentDisposition,
    });
  }
  async head(objectKey: WorkerObjectKey) {
    return this.objects.get(objectKey) ?? null;
  }
  async delete(objectKey: WorkerObjectKey) {
    this.deleted.push(objectKey);
    this.objects.delete(objectKey);
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("browser cancel route ↔ real Worker (loopback)", () => {
  let tempDir: string;
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let writer: MemoryWriter;
  let pump: QueuePump;
  let server: Server;
  let client: WorkerClient;

  const holds: Partial<Record<Exclude<Phase, "uploading">, Hold>> = {};
  let failDownloadWith: AppError | null = null;
  let mp3 = false;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videofetch-ld4a-cancel-"));
    setTempDirectoryForTests(tempDir);
    db = openWorkerDatabase({ path: path.join(tempDir, "state.sqlite") });
    applyMigrations(db);
    store = new SQLiteJobStore({ db });
    writer = new MemoryWriter();

    const executor = new JobExecutor(store, writer, () => Date.now(), new Map(), {
      analyze: async (_url: string, signal?: AbortSignal) => {
        const hold = holds.analyzing;
        if (hold) {
          delete holds.analyzing;
          await hold.run(signal);
        }
        return metadata(mp3);
      },
      downloadOriginal: async (_url, ctx) => {
        const hold = holds.downloading;
        if (hold) {
          delete holds.downloading;
          await hold.run(ctx.signal);
        }
        if (failDownloadWith) throw failDownloadWith;
        const filePath = path.join(ctx.workDir, "original.mp4");
        await fsp.writeFile(filePath, "LD4A-CONTRACT-MEDIA");
        ctx.onProgress?.({ progress: 100, downloadedBytes: 19, totalBytes: 19 });
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 19 };
      },
      processLocally: async (opts) => {
        const hold = holds.processing;
        if (hold) {
          delete holds.processing;
          await hold.run(opts.signal);
        }
        const out = path.join(opts.workDir, `converted.${opts.target}`);
        await fsp.writeFile(out, "mp3-bytes");
        return out;
      },
    });
    pump = new QueuePump(new QueueRunner(store, executor));
    const service = new WorkerService({
      store,
      executor,
      pump,
      analyze: async () => metadata(mp3),
      probeBinaries: async () => ({ ffmpeg: true, ytdlp: false, ytdlpVersion: null }),
    });
    server = createWorkerServer(
      { currentKeyId: KEY_ID, currentSecret: WORKER_SECRET, replayStore: new SQLiteWorkerReplayStore(db) },
      service,
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    client = new WorkerClient({ baseUrl: `http://127.0.0.1:${port}`, currentKeyId: KEY_ID, currentSecret: WORKER_SECRET });
  });

  after(async () => {
    await pump.whenDrained();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      db.close();
    } catch (e) {
      void e;
    }
    setTempDirectoryForTests(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: ACCESS_SECRET });
    setWorkerClientForTests(client);
    failDownloadWith = null;
    mp3 = false;
  });

  afterEach(async () => {
    await pump.whenDrained();
    resetPrivateAccessApiForTests();
    resetWorkerRuntimeForTests();
    setPrivateAccessTestEnv(null);
    resetRateLimitForTests();
  });

  async function create(formatId: "direct-original" | "preset:mp3" = "direct-original"): Promise<string> {
    const created = await client.createJob({ url: MEDIA_URL, formatId, principalId: "private-access-user" });
    return created.job.jobId;
  }

  async function browserCancel(jobId: string) {
    const res = await handleDownloadCancel(
      new Request(`https://videofetch.example/api/download/${jobId}/cancel`, {
        method: "POST",
        headers: {
          cookie: `${ACCESS_COOKIE_NAME}=${mintSessionToken(ACCESS_SECRET)}`,
          "sec-fetch-site": "same-origin",
        },
      }),
      jobId,
    );
    const raw = await res.text();
    for (const fragment of ["objectKey", "videofetch/jobs", "safeErrorMessage", WORKER_SECRET, ACCESS_SECRET, tempDir]) {
      assert.equal(raw.includes(fragment), false, `browser response leaked ${fragment}`);
    }
    assert.equal(res.headers.get("cache-control"), "no-store");
    return { res, body: JSON.parse(raw) };
  }

  async function cancelHeld(phase: Exclude<Phase, "uploading">, formatId: "direct-original" | "preset:mp3") {
    const hold = new Hold();
    holds[phase] = hold;
    const jobId = await create(formatId);
    const signal = await hold.entered;
    assert.equal(store.getJob(jobId)?.status, phase, `held in ${phase}`);
    const { res, body } = await browserCancel(jobId);
    assert.equal(res.status, 200);
    assert.equal(body.jobId, jobId);
    assert.equal(body.status, "cancelled", "the Worker's own committed outcome");
    assert.equal(body.downloadUrl, null);
    assert.equal(signal.aborted, true, "the Worker aborted the operation in flight");
    await pump.whenDrained();
    assert.equal(hold.aborted, true);
    assert.equal(store.getJob(jobId)?.status, "cancelled", "the durable outcome stays cancelled");
    return jobId;
  }

  it("cancels during analysis", async () => {
    await cancelHeld("analyzing", "direct-original");
    assert.equal(writer.putCalls, 0);
  });

  it("cancels during acquisition", async () => {
    await cancelHeld("downloading", "direct-original");
    assert.equal(writer.putCalls, 0);
  });

  it("cancels during processing", async () => {
    mp3 = true;
    await cancelHeld("processing", "preset:mp3");
    assert.equal(writer.putCalls, 0);
  });

  it("cancels during the upload: the PUT is aborted and nothing stays stored", async () => {
    const hold = new Hold();
    writer.hold = hold;
    const before = writer.putCalls;
    const jobId = await create();
    const signal = await hold.entered;
    assert.equal(store.getJob(jobId)?.status, "uploading");
    const { res, body } = await browserCancel(jobId);
    assert.equal(res.status, 200);
    assert.equal(body.status, "cancelled");
    assert.equal(signal.aborted, true, "LD-2b: the upload received the abort");
    await pump.whenDrained();
    assert.equal(writer.putCalls, before + 1);
    assert.equal([...writer.objects.keys()].some((k) => k.includes(jobId)), false, "no object kept for the job");
    assert.equal(store.getJob(jobId)?.status, "cancelled");
  });

  it("cancels a job still queued behind another, before any work for it", async () => {
    const hold = new Hold();
    holds.downloading = hold;
    const first = await create();
    await hold.entered;
    const queued = await create();
    assert.equal(store.getJob(queued)?.status, "queued");
    const { body } = await browserCancel(queued);
    assert.equal(body.status, "cancelled");
    // Release the first job by cancelling it through the same route.
    assert.equal((await browserCancel(first)).body.status, "cancelled");
    await pump.whenDrained();
    assert.equal(store.getJob(queued)?.status, "cancelled", "the queued job was never run");
  });

  it("a job that already reached ready is answered unchanged: ready, never cancelled", async () => {
    const jobId = await create();
    await waitFor(() => store.getJob(jobId)?.status === "ready", "ready");
    const deletedBefore = writer.deleted.length;
    const { res, body } = await browserCancel(jobId);
    assert.equal(res.status, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.downloadUrl, `/api/download/${jobId}/file`);
    assert.equal(writer.deleted.length, deletedBefore, "the finished file is not deleted");
    assert.equal(store.getJob(jobId)?.status, "ready");
  });

  it("a job that already failed is answered unchanged with its failure", async () => {
    failDownloadWith = new AppError("NETWORK_ERROR", "raw source text that must not travel");
    const jobId = await create();
    await waitFor(() => store.getJob(jobId)?.status === "failed", "failed");
    const { body } = await browserCancel(jobId);
    assert.equal(body.status, "failed");
    assert.equal(body.errorCode, "NETWORK_ERROR");
    assert.equal(body.error, ERROR_MESSAGES.NETWORK_ERROR);
    assert.equal(body.stageLabel, "Download failed");
  });

  it("a second cancellation is answered unchanged (idempotent), through a fresh signed request", async () => {
    const jobId = await cancelHeld("downloading", "direct-original");
    const again = await browserCancel(jobId);
    assert.equal(again.res.status, 200);
    assert.equal(again.body.status, "cancelled");
  });

  it("an unknown job id is NOT_FOUND", async () => {
    const { res, body } = await browserCancel("ffffffffffffffffffffffffffffffff");
    assert.equal(res.status, 404);
    assert.equal(body.error.code, "NOT_FOUND");
  });

  it("a Worker that has stopped answering is WORKER_UNAVAILABLE, never a job outcome (last: closes the server)", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { res, body } = await browserCancel("ffffffffffffffffffffffffffffffff");
    assert.equal(res.status, 503);
    assert.equal(body.error.code, "WORKER_UNAVAILABLE");
    assert.equal("status" in body, false);
  });
});
