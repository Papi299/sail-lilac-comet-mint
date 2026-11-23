import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync, renameSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AppError } from "../errors.ts";
import { setSafeHttpTestHooks } from "./safe-http.server.ts";
import { ACCESS_COOKIE_NAME, mintSessionToken, setPrivateAccessTestEnv } from "./private-access.server.ts";
import { handleDownloadCancel, handleDownloadStatus, resetPrivateAccessApiForTests } from "./private-access-api.server.ts";
import { resetRateLimitForTests } from "./rate-limit.server.ts";
import type { InactivityWatchdogTimerHandle, InactivityWatchdogTimers } from "../../services/downloads/acquisition-inactivity-watchdog.ts";
import type { RunResult } from "../../services/processing/process-runner.server.ts";
import { setDirectDownloadDeadlineTimerForTests } from "../../services/extractors/direct.server.ts";
import { VideoMetadataSchema, type WorkerObjectKey, type WorkerVideoMetadata } from "../../shared/worker/contracts.ts";
import { WorkerJobActivitySchema } from "../../shared/worker/job-activity.ts";
import { resetWorkerRuntimeForTests, setWorkerClientForTests } from "../../web/config/worker-runtime.server.ts";
import { PublicJobSchema, type PublicJob } from "../../web/jobs/public-job.ts";
import { WorkerClient } from "../../web/worker/worker-client.server.ts";
import type { ExecutionAnalysis } from "../../worker/analysis/media-analyzer.server.ts";
import {
  GenericExecutionPlanSchema,
  deriveClearHlsExecutionPlan,
  type ExecutionPlan,
} from "../../worker/execution/format-plan.ts";
import { downloadGenericOriginal, expectedPartPath, expectedSourcePath, type GenericDownloadDeps } from "../../worker/execution/ytdlp-download.server.ts";
import { acquireSelectedClearHlsMedia } from "../../worker/hls/hls-execution.server.ts";
import {
  acquireClearHlsFmp4,
  acquireClearHlsTs,
} from "../../worker/hls/hls-fragment-acquisition.server.ts";
import type { ClearHlsMpegTsAcquisitionPlan } from "../../worker/hls/hls-preflight.server.ts";
import type { WorkerRuntimeConfig } from "../../worker/runtime/config.server.ts";
import { createWorkerRuntime, type WorkerRuntime, type WorkerRuntimeOverrides } from "../../worker/runtime/runtime.server.ts";
import { YTDLP_RUNTIME } from "../../worker/runtime/ytdlp-runtime.server.ts";
import type { ObjectStoreHead, ObjectStorePutInput, ObjectStoreWriter } from "../../worker/storage/writer.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001 — the public
 * activity, END TO END, from the real acquisition observations to the browser
 * response.
 *
 * The Worker is the REAL composition root (`createWorkerRuntime`): strict
 * configuration, on-disk SQLite, queue, executor with its Production
 * inactivity enforcement, and its HTTP server with HMAC authentication and
 * replay reservation. The control plane is the REAL status and cancel handlers
 * with private access, through the REAL HMAC `WorkerClient` on loopback. The
 * acquisitions are the REAL seams: the direct downloader and the clear-HLS
 * fragment acquisition over the synthetic safe-HTTP hooks, and the yt-dlp seam
 * with only its child replaced. Only the object store is in memory, and only
 * the watchdog's clock and timers are virtual (the runtime's test hook), so a
 * window passes when a test says so.
 *
 * What the browser receives is therefore exactly what the watchdog's own
 * tracker observed, projected once — nothing measured twice, nothing guessed.
 */

const KEY_ID = "worker-control-test";
const WORKER_SECRET = "0123456789abcdef0123456789abcdef";
const ACCESS_SECRET = "ld4b-activity-contract-access-secret-0123";
const MEDIA_URL = "https://cdn.example/SECRET-PATH/clip.mp4?sig=TOP-SECRET-TOKEN";
const FRAGMENT_1 = "https://cdn.example/SECRET-PATH/seg-1.ts?sig=TOP-SECRET-TOKEN";
const FRAGMENT_2 = "https://cdn.example/SECRET-PATH/seg-2.ts?sig=TOP-SECRET-TOKEN";
const WINDOW = 120_000;
const G = 65_536;
const LEAKS = ["SECRET-PATH", "TOP-SECRET-TOKEN", "sig=", "cdn.example/", "videofetch/jobs", "objectKey", ".part", "ld4b-activity-"];

// ── Virtual watchdog time ────────────────────────────────────────────────────

function virtualTime(startMs = 9_000_000) {
  let now = startMs;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: InactivityWatchdogTimers = {
    setTimeoutFn(fn, ms) {
      seq += 1;
      pending.set(seq, { at: now + ms, fn });
      return { id: seq, unref: () => undefined } as InactivityWatchdogTimerHandle;
    },
    clearTimeoutFn(handle) {
      pending.delete((handle as unknown as { id: number }).id);
    },
  };
  return {
    clock: () => now,
    timers,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let nextId = -1;
        let nextAt = Infinity;
        for (const [id, t] of pending) {
          if (t.at <= end && (t.at < nextAt || (t.at === nextAt && id < nextId))) {
            nextId = id;
            nextAt = t.at;
          }
        }
        if (nextId === -1) break;
        const due = pending.get(nextId)!;
        pending.delete(nextId);
        if (due.at > now) now = due.at;
        due.fn();
      }
      if (end > now) now = end;
    },
    pendingCount: () => pending.size,
  };
}

// ── Fakes: object store, configuration, media ─────────────────────────────────

class MemoryWriter implements ObjectStoreWriter {
  public readonly objects = new Map<string, ObjectStoreHead>();
  async put(input: ObjectStorePutInput): Promise<void> {
    let received = 0;
    for await (const piece of input.body) received += piece.length;
    this.objects.set(input.objectKey, {
      objectKey: input.objectKey,
      contentLength: received,
      contentType: input.contentType,
      contentDisposition: input.contentDisposition,
    });
  }
  async head(objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    return this.objects.get(objectKey) ?? null;
  }
  async delete(objectKey: WorkerObjectKey): Promise<void> {
    this.objects.delete(objectKey);
  }
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function makeConfig(dataDirectory: string, port: number, activityEnabled: boolean | undefined): WorkerRuntimeConfig {
  return {
    bindHost: "127.0.0.1",
    port,
    dataDirectory,
    control: { currentKeyId: KEY_ID, currentSecret: WORKER_SECRET },
    r2: {
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "videofetch-temp",
      jurisdiction: "default",
      brokerSocketPath: "/run/videofetch-r2-broker/broker.sock",
    },
    media: {
      maxFileSizeBytes: 500 * 1024 * 1024,
      maxVideoDurationSeconds: 7200,
      fileExpirationMinutes: 45,
      downloadTimeLimitSeconds: 600,
      downloadInactivityTimeoutSeconds: 120,
      processingTimeoutSeconds: 600,
      uploadTimeoutSeconds: 3600,
      analysisTimeoutSeconds: 45,
      maxRedirects: 5,
      ytdlp: { enabled: false },
      tempDirectory: null,
      ffmpegPath: null,
    },
    ...(activityEnabled === undefined ? {} : { jobStatus: { activityEnabled } }),
  };
}

function directMetadata(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "Activity Clip",
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
        formatNote: null,
      },
    ],
    presets: [],
    capabilities: { mp3: false, merge: false },
  });
}

const GENERIC_ANALYSIS: ExecutionAnalysis = {
  strategy: "yt-dlp",
  video: VideoMetadataSchema.parse({
    title: "clip",
    thumbnail: null,
    duration: 6,
    source: "example.invalid",
    extractor: "yt-dlp",
    webpageUrl: "https://example.invalid/watch",
    formats: [],
    presets: [],
    capabilities: { mp3: false, merge: false },
  }),
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
const HLS_PLAN = deriveClearHlsExecutionPlan(
  Object.freeze({ "preset:1080": Object.freeze({ playlistUrl: "https://cdn.example/SECRET-PATH/media.m3u8", height: 1080 }) }),
  "preset:1080",
);
const yt = (generic: unknown): ExecutionPlan => ({ strategy: "yt-dlp", generic }) as ExecutionPlan;

const chunk = (size: number) => Buffer.alloc(size, 0x5a);

/** A body the test drives by hand; it never ends until told to. */
function manualBody() {
  const stream = new Readable({
    read() {
      // Chunks arrive only when the test pushes them.
    },
  });
  return { stream, push: (data: Buffer) => stream.push(data), end: () => stream.push(null) };
}

/** Synthetic HTTP for the real safe-HTTP transport: a route per URL, counting requests. */
function serveHttp(routes: Record<string, () => Readable>) {
  const requested: string[] = [];
  setSafeHttpTestHooks({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    requestOnce: async (args) => {
      requested.push(args.url.href);
      const route = routes[args.url.href];
      if (route === undefined) throw new AppError("NETWORK_ERROR");
      return { status: 200, headers: { "content-type": "video/mp4" }, body: route() };
    },
  });
  return requested;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

// ── Harness ───────────────────────────────────────────────────────────────────

let eventLoopHold: ReturnType<typeof setTimeout> | null = null;
let root = "";
const runtimes: WorkerRuntime[] = [];
const bodies: Array<ReturnType<typeof manualBody>> = [];

beforeEach(async () => {
  eventLoopHold = setTimeout(() => {}, 120_000);
  root = await mkdtemp(join(tmpdir(), "ld4b-activity-"));
  setPrivateAccessTestEnv({ nodeEnv: "production", secret: ACCESS_SECRET });
});

afterEach(async () => {
  for (const body of bodies.splice(0)) body.stream.destroy();
  for (const runtime of runtimes.splice(0)) {
    try {
      await runtime.shutdown();
    } catch {
      /* already shut down */
    }
  }
  setSafeHttpTestHooks(null);
  setDirectDownloadDeadlineTimerForTests(null);
  resetPrivateAccessApiForTests();
  resetWorkerRuntimeForTests();
  setPrivateAccessTestEnv(null);
  resetRateLimitForTests();
  await rm(root, { recursive: true, force: true });
  if (eventLoopHold !== null) clearTimeout(eventLoopHold);
  eventLoopHold = null;
});

type Stack = {
  runtime: WorkerRuntime;
  client: WorkerClient;
  vt: ReturnType<typeof virtualTime>;
  /** Every raw status body the Worker sent, as bytes on the wire. */
  wire: string[];
};

async function stack(
  activityEnabled: boolean | undefined,
  overrides: Omit<WorkerRuntimeOverrides, "objectStoreWriter" | "acquisitionInactivityTime"> = {},
  dataDirectory = join(root, "state"),
): Promise<Stack> {
  const vt = virtualTime();
  const runtime = await createWorkerRuntime(makeConfig(dataDirectory, await reservePort(), activityEnabled), {
    objectStoreWriter: new MemoryWriter(),
    acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
    ...overrides,
  });
  runtimes.push(runtime);
  const { port } = await runtime.listen();
  const wire: string[] = [];
  const client = new WorkerClient({
    baseUrl: `http://127.0.0.1:${port}`,
    currentKeyId: KEY_ID,
    currentSecret: WORKER_SECRET,
    fetchImplementation: async (input, init) => {
      const res = await fetch(input, init);
      if ((init?.method ?? "GET") === "GET") wire.push(await res.clone().text());
      return res;
    },
  });
  setWorkerClientForTests(client);
  return { runtime, client, vt, wire };
}

function browserRequest(path: string, method = "GET"): Request {
  return new Request(`https://videofetch.example${path}`, {
    method,
    headers: {
      cookie: `${ACCESS_COOKIE_NAME}=${mintSessionToken(ACCESS_SECRET)}`,
      "sec-fetch-site": "same-origin",
    },
  });
}

/** The browser's view, through the real status handler. */
async function browserStatus(jobId: string): Promise<{ res: Response; job: PublicJob; text: string }> {
  const res = await handleDownloadStatus(browserRequest(`/api/download/${jobId}/status`), jobId);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.equal(res.headers.get("cache-control"), "no-store", "a private job status is never cacheable");
  return { res, job: PublicJobSchema.parse(JSON.parse(text)), text };
}

async function createJob(s: Stack, formatId: "direct-original" | "preset:1080" = "direct-original"): Promise<string> {
  const created = await s.client.createJob({ url: MEDIA_URL, formatId, principalId: "private-access-user" });
  s.runtime.wakeQueue();
  return created.job.jobId;
}

/** A queued job written to the store directly: the queue is not woken. */
function queuedJob(s: Stack): string {
  const created = s.runtime.store.createJob({ url: MEDIA_URL, formatId: "direct-original", principalId: "private-access-user" }, randomUUID());
  assert.equal(created.type, "created");
  return created.type === "created" ? created.job.jobId : "";
}

const liveWatchdogs = (runtime: WorkerRuntime) =>
  (runtime.executor as unknown as { liveAcquisitionWatchdogs: Map<string, unknown> }).liveAcquisitionWatchdogs;

const workerActivity = (s: Stack, jobId: string) => {
  const view = s.runtime.store.getJob(jobId);
  return view?.status === "downloading" ? s.runtime.executor.acquisitionActivity(jobId) : null;
};

function assertPrivate(text: string) {
  for (const needle of LEAKS) assert.equal(text.includes(needle), false, `must not expose ${needle}`);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the Worker publishes activity only when its configuration says so", () => {
  it("the Production default (no JOB_STATUS_ACTIVITY_ENABLED) sends no `activity` key at all, even mid-download", async () => {
    const body = manualBody();
    bodies.push(body);
    serveHttp({ [MEDIA_URL]: () => body.stream });
    const s = await stack(undefined, {
      executorDeps: { analyze: async () => directMetadata(), availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER },
    });
    const jobId = await createJob(s);
    body.push(chunk(70_000));
    await waitFor(() => s.runtime.executor.acquisitionActivity(jobId)?.state === "receiving", "a live observation");
    const { job } = await browserStatus(jobId);
    assert.equal(job.status, "downloading");
    assert.equal(job.activity, null, "an unpublished activity is null to the browser");
    await s.client.getJob(jobId);
    assert.equal(s.wire.length, 2, "both status reads were captured on the wire");
    for (const raw of s.wire) {
      assert.equal(JSON.parse(raw).job && "activity" in JSON.parse(raw).job, false, "the wire carries no activity key");
      assert.equal(raw.includes("activity"), false);
    }
  });

  // These two never wake the queue: the job is written to the store directly,
  // so it stays queued and nothing is analyzed or fetched.
  it("explicitly off behaves exactly like the default", async () => {
    const s = await stack(false);
    const jobId = queuedJob(s);
    await s.client.getJob(jobId);
    assert.equal(s.wire.at(-1)!.includes("activity"), false);
  });

  it("on, every status states it: null while queued, null when not downloading", async () => {
    const s = await stack(true);
    const jobId = queuedJob(s);
    const read = await s.client.getJob(jobId);
    assert.equal(read.job.status, "queued");
    assert.equal(read.job.activity, null);
    assert.equal(JSON.parse(s.wire.at(-1)!).job.activity, null, "stated as null on the wire");
    assert.equal((await browserStatus(jobId)).job.activity, null);
  });
});

describe("direct: the real downloader's transport bytes, through the real watchdog, to the browser", () => {
  it("awaiting-first-byte → receiving → waiting (idle counting) → receiving → processing (null) → ready (null)", async () => {
    const body = manualBody();
    bodies.push(body);
    const requested = serveHttp({ [MEDIA_URL]: () => body.stream });
    const s = await stack(true, {
      executorDeps: { analyze: async () => directMetadata(), availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER },
    });
    const jobId = await createJob(s);
    await waitFor(
      () => requested.length === 1 && workerActivity(s, jobId)?.state === "awaiting-first-byte",
      "the transfer to start",
    );

    let seen = await browserStatus(jobId);
    assert.equal(seen.job.status, "downloading");
    assert.deepEqual(seen.job.activity, { state: "awaiting-first-byte", elapsedSeconds: 0, limitSeconds: 600, idleSeconds: 0 });

    s.vt.advance(3_000);
    seen = await browserStatus(jobId);
    assert.deepEqual(seen.job.activity, { state: "awaiting-first-byte", elapsedSeconds: 3, limitSeconds: 600, idleSeconds: 3 });

    body.push(chunk(70_000));
    await waitFor(() => workerActivity(s, jobId)?.state === "receiving", "the first chunk");
    seen = await browserStatus(jobId);
    assert.deepEqual(seen.job.activity, { state: "receiving", elapsedSeconds: 3, limitSeconds: 600, idleSeconds: 0 });

    s.vt.advance(5_000);
    seen = await browserStatus(jobId);
    assert.deepEqual(seen.job.activity, { state: "waiting", elapsedSeconds: 8, limitSeconds: 600, idleSeconds: 5 });

    s.vt.advance(15_000);
    seen = await browserStatus(jobId);
    assert.deepEqual(seen.job.activity, { state: "waiting", elapsedSeconds: 23, limitSeconds: 600, idleSeconds: 20 });
    assertPrivate(seen.text);
    WorkerJobActivitySchema.parse(JSON.parse(s.wire.at(-1)!).job.activity);

    body.push(chunk(10_000));
    await waitFor(() => workerActivity(s, jobId)?.idleSeconds === 0, "the next chunk");
    assert.deepEqual((await browserStatus(jobId)).job.activity, { state: "receiving", elapsedSeconds: 23, limitSeconds: 600, idleSeconds: 0 });

    body.end();
    await waitFor(() => s.runtime.store.getJob(jobId)!.status === "ready", "the job to complete");
    const ready = await browserStatus(jobId);
    assert.equal(ready.job.status, "ready");
    assert.equal(ready.job.activity, null);
    assert.equal(liveWatchdogs(s.runtime).size, 0, "nothing is kept after the acquisition");
    assert.equal(s.vt.pendingCount(), 0, "and the watchdog released its timer");
  });

  it("status reads at any rate change nothing: the stall lands at the same instant, the limit never moves", async () => {
    const stallAt = async (readsPerSecond: number): Promise<{ failedAtSeconds: number; idles: number[] }> => {
      const body = manualBody();
      bodies.push(body);
      serveHttp({ [MEDIA_URL]: () => body.stream });
      const s = await stack(true, {
        executorDeps: { analyze: async () => directMetadata(), availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER },
      }, join(root, `state-${randomUUID()}`));
      const jobId = await createJob(s);
      await waitFor(() => workerActivity(s, jobId) !== null, "the transfer to start");
      body.push(chunk(70_000));
      await waitFor(() => workerActivity(s, jobId)?.state === "receiving", "the first chunk");
      // The watchdog's own report, read the same way in both runs: its decision
      // is synchronous inside the virtual tick, so the second it lands in is
      // exact (the durable failure that follows is asynchronous).
      const watchdog = liveWatchdogs(s.runtime).get(jobId) as { report(): { state: string; stop: unknown } } | undefined;
      assert.ok(watchdog, "the acquisition is watched");
      const idles: number[] = [];
      for (let second = 1; second <= 130; second += 1) {
        s.vt.advance(1_000);
        // Read at once, before any await lets the execution unwind: the stop
        // decision is kept in the report after the watchdog is disposed too.
        const decided = watchdog.report().stop !== null;
        for (let r = 0; r < readsPerSecond; r += 1) {
          const activity = workerActivity(s, jobId);
          if (activity !== null) {
            assert.equal(activity.limitSeconds, 600, "the limit is never moved");
            if (r === 0) idles.push(activity.idleSeconds!);
          }
          if (r === 0 && second % 10 === 0) await browserStatus(jobId);
        }
        if (decided) {
          await waitFor(() => s.runtime.store.getJob(jobId)!.status === "failed", "the stall to be recorded");
          await s.runtime.pump.whenDrained();
          const failed = s.runtime.store.getJob(jobId)!;
          assert.equal(failed.errorCode, "TIMEOUT");
          assert.equal(failed.stageLabel, "Download stalled");
          return { failedAtSeconds: second, idles };
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.fail("the stall was never decided");
    };
    const quiet = await stallAt(0);
    const busy = await stallAt(25);
    assert.equal(quiet.failedAtSeconds, WINDOW / 1000, "stopped at the 120 s window — not at the 20 s notice");
    assert.equal(busy.failedAtSeconds, quiet.failedAtSeconds, "the same instant with 25 reads per second");
    assert.deepEqual(busy.idles, Array.from({ length: busy.idles.length }, (_, i) => i + 1), "idle advanced one per second");
  });

  it("a cancelled job stops publishing at once, and nothing is left behind", async () => {
    const body = manualBody();
    bodies.push(body);
    serveHttp({ [MEDIA_URL]: () => body.stream });
    const s = await stack(true, {
      executorDeps: { analyze: async () => directMetadata(), availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER },
    });
    const jobId = await createJob(s);
    body.push(chunk(70_000));
    await waitFor(() => workerActivity(s, jobId)?.state === "receiving", "receiving");
    const res = await handleDownloadCancel(browserRequest(`/api/download/${jobId}/cancel`, "POST"), jobId);
    assert.equal(res.status, 200);
    const cancelled = PublicJobSchema.parse(await res.json());
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.activity, null);
    await s.runtime.pump.whenDrained();
    assert.equal((await browserStatus(jobId)).job.activity, null);
    assert.equal(liveWatchdogs(s.runtime).size, 0);
  });
});

describe("one job's activity is that job's alone", () => {
  it("a queued job beside a downloading one states null, and the next acquisition starts from nothing", async () => {
    const first = manualBody();
    const second = manualBody();
    bodies.push(first, second);
    let n = 0;
    serveHttp({ [MEDIA_URL]: () => (n++ === 0 ? first.stream : second.stream) });
    const s = await stack(true, {
      executorDeps: { analyze: async () => directMetadata(), availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER },
    });
    const a = await createJob(s);
    first.push(chunk(70_000));
    await waitFor(() => workerActivity(s, a)?.state === "receiving", "job A receiving");
    s.vt.advance(30_000);
    const b = await createJob(s);
    assert.equal((await browserStatus(b)).job.status, "queued");
    assert.equal((await browserStatus(b)).job.activity, null, "B shows none of A's observation");
    assert.equal(s.runtime.executor.acquisitionActivity(b), null);
    assert.equal((await browserStatus(a)).job.activity?.idleSeconds, 30);

    first.end();
    await waitFor(() => s.runtime.store.getJob(a)!.status === "ready", "job A ready");
    await waitFor(() => workerActivity(s, b)?.state === "awaiting-first-byte", "job B's own acquisition");
    assert.deepEqual((await browserStatus(b)).job.activity, {
      state: "awaiting-first-byte",
      elapsedSeconds: 0,
      limitSeconds: 600,
      idleSeconds: 0,
    }, "B starts from zero, inheriting nothing from A");
    assert.equal((await browserStatus(a)).job.activity, null);
  });

  it("a Worker restart exposes no stale activity: the interrupted job is failed, and nothing is published", async () => {
    const body = manualBody();
    bodies.push(body);
    serveHttp({ [MEDIA_URL]: () => body.stream });
    const dataDirectory = join(root, "restart-state");
    const s1 = await stack(true, {
      executorDeps: { analyze: async () => directMetadata(), availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER },
    }, dataDirectory);
    const jobId = await createJob(s1);
    body.push(chunk(70_000));
    await waitFor(() => workerActivity(s1, jobId)?.state === "receiving", "receiving");
    await s1.runtime.shutdown();
    assert.equal(liveWatchdogs(s1.runtime).size, 0, "the shut-down executor keeps nothing");

    const s2 = await stack(true, {}, dataDirectory);
    const after = await browserStatus(jobId);
    assert.equal(after.job.status, "failed", "recovery classified the interrupted job");
    assert.equal(after.job.activity, null);
    assert.equal(liveWatchdogs(s2.runtime).size, 0);
  });
});

describe("clear HLS: the real fragment acquisition's boundaries", () => {
  it("between-resources is published between fragments, with its idle time, and receiving resumes", async () => {
    const f1 = manualBody();
    const f2 = manualBody();
    bodies.push(f1, f2);
    serveHttp({ [FRAGMENT_1]: () => f1.stream, [FRAGMENT_2]: () => f2.stream });
    const tsPlan = Object.freeze({
      segmentType: "mpegts",
      fragments: Object.freeze([Object.freeze({ url: FRAGMENT_1 }), Object.freeze({ url: FRAGMENT_2 })]),
      fragmentCount: 2,
    }) as ClearHlsMpegTsAcquisitionPlan;
    const s = await stack(true, {
      executorDeps: {
        analyzeForExecution: async () => GENERIC_ANALYSIS,
        derivePlanForExecution: () => yt(HLS_PLAN),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        // The REAL acquisition with only the playlist preflight given: every
        // fragment byte goes through the real transport, the real sink and the
        // real watchdog.
        acquireClearHls: (plan, workDir, ctx) =>
          acquireSelectedClearHlsMedia(
            { plan, workDir, ...ctx },
            { preflight: async () => tsPlan, acquire: acquireClearHlsTs, acquireFmp4: acquireClearHlsFmp4 },
          ),
      },
    });
    const jobId = await createJob(s, "preset:1080");
    await waitFor(() => workerActivity(s, jobId) !== null, "the transfer to start");
    f1.push(chunk(2_000));
    await waitFor(() => workerActivity(s, jobId)?.state === "receiving", "fragment 1 bytes");
    f1.end();
    await waitFor(() => workerActivity(s, jobId)?.state === "between-resources", "the boundary");
    s.vt.advance(21_000);
    const between = await browserStatus(jobId);
    assert.deepEqual(between.job.activity, { state: "between-resources", elapsedSeconds: 21, limitSeconds: 600, idleSeconds: 21 });
    assertPrivate(between.text);
    f2.push(chunk(3_000));
    await waitFor(() => workerActivity(s, jobId)?.state === "receiving", "fragment 2 bytes");
    assert.deepEqual((await browserStatus(jobId)).job.activity, { state: "receiving", elapsedSeconds: 21, limitSeconds: 600, idleSeconds: 0 });
    const res = await handleDownloadCancel(browserRequest(`/api/download/${jobId}/cancel`, "POST"), jobId);
    assert.equal(res.status, 200);
    await s.runtime.pump.whenDrained();
    assert.equal((await browserStatus(jobId)).job.activity, null);
    assert.equal(liveWatchdogs(s.runtime).size, 0);
  });
});

describe("yt-dlp: the real seam's filesystem observation, child replaced", () => {
  it("filesystem samples are published as receiving, then waiting; the job completes and publishes nothing more", async () => {
    let jobId = "";
    let s: Stack | null = null;
    const runtimeOk = Object.freeze({ available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" as const });
    const child = async (call: { args: readonly string[] }): Promise<RunResult> => {
      const workDir = call.args.find((a) => a.startsWith("--output="))!.slice("--output=".length).replace(/\/[a-z-]+\.%\(ext\)s$/, "");
      const part = expectedPartPath(workDir, "mp4");
      writeFileSync(part, "");
      appendFileSync(part, chunk(2 * G));
      await waitFor(() => workerActivity(s!, jobId)?.state === "receiving", "the sampled bytes");
      s!.vt.advance(6_000);
      await waitFor(() => workerActivity(s!, jobId)?.state === "waiting", "a quiet sample");
      const waiting = await browserStatus(jobId);
      assert.equal(waiting.job.activity?.state, "waiting");
      assert.equal(waiting.job.activity?.idleSeconds, 6);
      assert.equal(waiting.job.activity?.limitSeconds, 600);
      assertPrivate(waiting.text);
      appendFileSync(part, chunk(G));
      await waitFor(() => workerActivity(s!, jobId)?.state === "receiving", "growth again");
      renameSync(part, expectedSourcePath(workDir, "mp4"));
      return { code: 0, stdout: "", stderr: "" };
    };
    s = await stack(true, {
      executorDeps: {
        analyzeForExecution: async () => GENERIC_ANALYSIS,
        derivePlanForExecution: () => yt(SINGLE_PLAN),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        downloadGeneric: (url, workDir, plan, ctx) =>
          downloadGenericOriginal(url, workDir, plan, {
            ...(ctx as unknown as Record<string, unknown>),
            runner: child,
            probeRuntime: async () => runtimeOk,
            validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
            sizePollMs: 1,
          } as unknown as GenericDownloadDeps).then((res) => ({ ...res, mime: "video/mp4" })),
      },
    });
    jobId = await createJob(s, "preset:1080");
    await waitFor(() => s!.runtime.store.getJob(jobId)!.status === "ready", "the job to complete", 15_000);
    assert.equal((await browserStatus(jobId)).job.activity, null);
    assert.equal(liveWatchdogs(s.runtime).size, 0);
  });
});
