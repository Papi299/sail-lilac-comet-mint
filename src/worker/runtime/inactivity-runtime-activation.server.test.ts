import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, ERROR_MESSAGES } from "../../lib/errors.ts";
import type { AcquisitionActivitySink } from "../../services/downloads/acquisition-activity.ts";
import type { InactivityWatchdogTimerHandle, InactivityWatchdogTimers } from "../../services/downloads/acquisition-inactivity-watchdog.ts";
import { VideoMetadataSchema, type WorkerObjectKey, type WorkerVideoMetadata } from "../../shared/worker/contracts.ts";
import { WORKER_RESTART_STAGE_LABEL } from "../../shared/worker/job-failure.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import {
  GenericExecutionPlanSchema,
  deriveClearHlsExecutionPlan,
  deriveClearHlsSeparateAudioExecutionPlan,
  type ExecutionPlan,
} from "../execution/format-plan.ts";
import type { JobExecutorDeps } from "../execution/job-executor.server.ts";
import { selectYtdlpAcquisitionRetryPolicy } from "../execution/ytdlp-download.server.ts";
import type { ObjectStoreHead, ObjectStorePutInput, ObjectStoreWriter } from "../storage/writer.ts";
import { loadWorkerRuntimeConfig, type WorkerRuntimeConfig } from "./config.server.ts";
import { createWorkerRuntime, type WorkerRuntime } from "./runtime.server.ts";

/**
 * VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001 — the acquisition-inactivity
 * watchdog is CONNECTED in the real Worker composition root.
 *
 * Every test builds the REAL runtime with `createWorkerRuntime()`: the real
 * strict configuration (or the real loader's output), a real on-disk SQLite
 * database with real migrations and recovery, and the real QueuePump →
 * QueueRunner → JobExecutor wiring. Only the object store is faked (no network),
 * and only the acquisition SEAMS are injected where a test needs a source that
 * stalls; the executor, its watchdog, its classification and the store are the
 * Production code paths. The watchdog's clock and timers are virtual through the
 * runtime's test-only hook, so the configured 120 s window passes when a test
 * says so.
 *
 * A test of the executor's optional seam alone would not prove activation: the
 * first block reads the enforcement back from the runtime built EXACTLY as the
 * executable entry builds it (`createWorkerRuntime(config)`, no overrides).
 */

const FAKE_KEY_ID = "worker-control-test";
const FAKE_SECRET = "0123456789abcdef0123456789abcdef";
const MEDIA_URL = "https://cdn.example/SECRET-PATH/clip.mp4?sig=TOP-SECRET-TOKEN";
const WINDOW = 120_000;
const G = 65_536;

const PRODUCTION_ENFORCEMENT = Object.freeze({
  windowMs: WINDOW,
  tickMs: 1_000,
  suspensionGapMs: 30_000,
  maxUnobservedMs: WINDOW,
  watchFilesystemObservedPlans: true,
});

// ── Virtual watchdog time (through the runtime's test-only hook) ─────────────

function virtualTime(startMs = 7_000_000) {
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
  public puts = 0;
  async put(input: ObjectStorePutInput): Promise<void> {
    this.puts += 1;
    let received = 0;
    for await (const chunk of input.body) received += chunk.length;
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

function makeConfig(
  dataDirectory: string,
  port: number,
  media: Partial<WorkerRuntimeConfig["media"]> = {},
): WorkerRuntimeConfig {
  return {
    bindHost: "127.0.0.1",
    port,
    dataDirectory,
    control: { currentKeyId: FAKE_KEY_ID, currentSecret: FAKE_SECRET },
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
      ...media,
    },
  };
}

function directMetadata(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "Runtime Clip",
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

const SOURCE = {
  formatId: "22",
  protocol: "https",
  container: "mp4",
  hasVideo: true,
  hasAudio: true,
  videoConstraint: "codec-present",
  audioConstraint: "codec-present",
  fileSize: null,
} as const;
const SINGLE_PLAN = GenericExecutionPlanSchema.parse({
  strategy: "yt-dlp",
  operation: "keep-original",
  requestedFormatId: "preset:1080",
  source: SOURCE,
  targetContainer: "mp4",
});
const SPLIT_PLAN = GenericExecutionPlanSchema.parse({
  strategy: "yt-dlp",
  operation: "merge-split",
  requestedFormatId: "preset:1080",
  pair: {
    video: { ...SOURCE, formatId: "137", protocol: "http_dash_segments", hasAudio: false, audioConstraint: "absent" },
    audio: { ...SOURCE, formatId: "140", container: "m4a", hasVideo: false, videoConstraint: "absent" },
  },
  targetContainer: "mp4",
});
const yt = (generic: unknown): ExecutionPlan => ({ strategy: "yt-dlp", generic }) as ExecutionPlan;

/** A source that sends `bytes` real media bytes and then nothing, until the acquisition is stopped. */
function stallingSource(seen: { sinks: AcquisitionActivitySink[]; aborted: number }, bytes = 70_000) {
  return (ctx: { signal?: AbortSignal; activity?: AcquisitionActivitySink; downloadTimeLimitMs?: number }) => {
    assert.ok(ctx.activity, "every acquisition receives its watchdog's sink");
    seen.sinks.push(ctx.activity);
    ctx.activity({ kind: "deadline-armed", limitMs: ctx.downloadTimeLimitMs ?? 600_000 });
    ctx.activity({ kind: "phase-started", phase: "single" });
    ctx.activity({ kind: "bytes", totalBytes: bytes, evidence: "transport" });
    return new Promise<never>((_resolve, reject) => {
      const stop = () => {
        seen.aborted += 1;
        reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
      };
      if (ctx.signal?.aborted) stop();
      else ctx.signal?.addEventListener("abort", stop, { once: true });
    });
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

function createdJobId(runtime: WorkerRuntime, formatId: "direct-original" | "preset:1080" = "direct-original"): string {
  const created = runtime.store.createJob({ url: MEDIA_URL, formatId, principalId: "private-access-user" }, randomUUID());
  assert.equal(created.type, "created");
  return created.type === "created" ? created.job.jobId : "";
}

function assertFailedAt(runtime: WorkerRuntime, jobId: string, stage: string) {
  const view = runtime.store.getJob(jobId);
  assert.ok(view);
  assert.equal(view.status, "failed");
  assert.equal(view.errorCode, "TIMEOUT");
  assert.equal(view.safeErrorMessage, ERROR_MESSAGES.TIMEOUT);
  assert.equal(view.stageLabel, stage);
  // Nothing upstream-controlled reaches the durable row: no part of the job's
  // URL, and no error text a seam rejected with.
  const text = JSON.stringify(view);
  for (const needle of ["SECRET-PATH", "TOP-SECRET-TOKEN", "sig=", "Gateway"]) {
    assert.equal(text.includes(needle), false, needle);
  }
}

// The transports' timers are unref'd and a held promise keeps nothing alive, so
// the test keeps the event loop alive itself (the Node 22 trap that cancels the
// older runtime suite there).
let eventLoopHold: ReturnType<typeof setTimeout> | null = null;
let root = "";
const runtimes: WorkerRuntime[] = [];

beforeEach(async () => {
  eventLoopHold = setTimeout(() => {}, 120_000);
  root = await mkdtemp(join(tmpdir(), "ld3-runtime-activation-"));
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    try {
      await runtime.shutdown();
    } catch {
      /* already shut down */
    }
  }
  await rm(root, { recursive: true, force: true });
  if (eventLoopHold !== null) clearTimeout(eventLoopHold);
  eventLoopHold = null;
});

async function boot(config: WorkerRuntimeConfig, overrides: Parameters<typeof createWorkerRuntime>[1] = {}) {
  const runtime = await createWorkerRuntime(config, overrides);
  runtimes.push(runtime);
  return runtime;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the real composition root connects the watchdog", () => {
  it("the exact Production call — createWorkerRuntime(config), no overrides — gives the real executor its enforcement", async () => {
    // Exactly what `main.server.ts` does: the validated configuration, and nothing else.
    const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), await reservePort()));
    runtimes.push(runtime);
    assert.deepEqual({ ...runtime.executor.inactivityEnforcement }, PRODUCTION_ENFORCEMENT);
    assert.equal(runtime.timeLimits.inactivityMs, WINDOW);
    assert.equal(runtime.timeLimits.downloadTimeLimitMs, 600_000, "the absolute limit keeps its 600 s default");
    assert.equal(runtime.timeLimits.executionLifetimeMs, 5_445_000, "and L its 5,445 s");
    assert.deepEqual(
      { ...runtime.executor.timeLimits },
      { downloadTimeLimitMs: 600_000, processingMs: 600_000, uploadMs: 3_600_000 },
    );
  });

  it("the window follows the strict configuration end to end: environment → loader → model → executor", async () => {
    const loaded = loadWorkerRuntimeConfig({
      WORKER_DATA_DIRECTORY: "/var/lib/videofetch-ld3-never-created",
      WORKER_CONTROL_KEY_ID: "worker-control-1",
      WORKER_CONTROL_SECRET: FAKE_SECRET,
      R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      R2_BUCKET: "videofetch-temp",
      R2_BROKER_SOCKET_PATH: "/run/videofetch-r2-broker/broker.sock",
      DOWNLOAD_TIME_LIMIT: "300",
      DOWNLOAD_INACTIVITY_TIMEOUT: "75",
    });
    assert.equal(loaded.media.downloadInactivityTimeoutSeconds, 75);
    // Only where it lives and how it listens change; every media value is the loader's own.
    const runtime = await boot({ ...loaded, dataDirectory: join(root, "state"), bindHost: "127.0.0.1", port: await reservePort() });
    assert.equal(runtime.timeLimits.inactivityMs, 75_000);
    assert.equal(runtime.timeLimits.downloadTimeLimitMs, 300_000);
    assert.deepEqual({ ...runtime.executor.inactivityEnforcement }, {
      ...PRODUCTION_ENFORCEMENT,
      windowMs: 75_000,
      maxUnobservedMs: 75_000,
    });
  });

  it("no test seam can replace, weaken or disconnect it: a JavaScript caller's executor seam is overridden", async () => {
    for (const forged of [
      { acquisitionInactivity: undefined },
      { acquisitionInactivity: { policy: { windowMs: 86_400_000 } } },
      { acquisitionInactivity: { policy: { windowMs: WINDOW }, watchFilesystemObservedPlans: false } },
    ]) {
      const runtime = await boot(makeConfig(join(root, `state-${randomUUID()}`), await reservePort()), {
        objectStoreWriter: new MemoryWriter(),
        executorDeps: forged as never,
      });
      assert.deepEqual({ ...runtime.executor.inactivityEnforcement }, PRODUCTION_ENFORCEMENT, JSON.stringify(forged));
    }
  });

  it("the test-only time hook replaces the clock and timers and nothing else", async () => {
    const vt = virtualTime();
    const runtime = await boot(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: new MemoryWriter(),
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
    });
    assert.deepEqual({ ...runtime.executor.inactivityEnforcement }, PRODUCTION_ENFORCEMENT);
  });

  it("refuses an inconsistent window before touching the state directory, whatever the overrides", async () => {
    const dataDirectory = join(root, "never-created");
    await assert.rejects(
      createWorkerRuntime(makeConfig(dataDirectory, await reservePort(), { downloadTimeLimitSeconds: 120 }), {
        objectStoreWriter: new MemoryWriter(),
        executorDeps: { acquisitionInactivity: { policy: { windowMs: 60_000 } } } as never,
      }),
      (err: unknown) => err instanceof Error && err.name === "WorkerTimeLimitsError" && /downloadInactivityTimeoutSeconds/.test(err.message),
    );
    await assert.rejects(stat(dataDirectory), { code: "ENOENT" });
  });
});

describe("what a running job sees, through the real runtime", () => {
  it("a direct source that stops sending is stopped at the configured window: failed / TIMEOUT / Download stalled, nothing uploaded", async () => {
    const vt = virtualTime();
    const writer = new MemoryWriter();
    const seen = { sinks: [] as AcquisitionActivitySink[], aborted: 0 };
    const source = stallingSource(seen);
    const runtime = await boot(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: writer,
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
      executorDeps: {
        analyze: async () => directMetadata(),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        downloadOriginal: (_url, ctx) => source(ctx),
      },
    });
    const jobId = createdJobId(runtime);
    runtime.wakeQueue();
    await waitFor(() => seen.sinks.length === 1, "the acquisition to start");
    vt.advance(WINDOW - 1_000);
    assert.equal(runtime.store.getJob(jobId)!.status, "downloading", "not before the window");
    assert.equal(seen.aborted, 0);
    vt.advance(1_000);
    await waitFor(() => runtime.store.getJob(jobId)!.status === "failed", "the stall to be recorded");
    assertFailedAt(runtime, jobId, "Download stalled");
    assert.equal(seen.aborted, 1, "the acquisition was stopped through its own signal");
    assert.equal(writer.puts, 0, "no upload after a stalled acquisition");
    await waitFor(() => runtime.executor.activeJobCount === 0, "the execution to unwind");
    assert.equal(vt.pendingCount(), 0, "no watchdog timer outlives the acquisition");
  });

  it("the absolute deadline ending a direct acquisition first is failed / TIMEOUT / Download time limit reached", async () => {
    const vt = virtualTime();
    const writer = new MemoryWriter();
    let limitSeen = 0;
    const runtime = await boot(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: writer,
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
      executorDeps: {
        analyze: async () => directMetadata(),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        downloadOriginal: async (_url, ctx) => {
          limitSeen = ctx.downloadTimeLimitMs;
          ctx.activity?.({ kind: "deadline-armed", limitMs: ctx.downloadTimeLimitMs });
          ctx.activity?.({ kind: "phase-started", phase: "single" });
          ctx.activity?.({ kind: "bytes", totalBytes: 9 * G, evidence: "transport" });
          // The seam's own one-way latch: its absolute deadline, first.
          ctx.activity?.({ kind: "settled", outcome: "deadline-exceeded" });
          throw new AppError("TIMEOUT");
        },
      },
    });
    const jobId = createdJobId(runtime);
    runtime.wakeQueue();
    await waitFor(() => runtime.store.getJob(jobId)!.status === "failed", "the deadline to be recorded");
    assertFailedAt(runtime, jobId, "Download time limit reached");
    assert.equal(limitSeen, 600_000, "the one absolute limit, never extended");
    assert.equal(writer.puts, 0);
    assert.equal(vt.pendingCount(), 0);
  });

  it("a TIMEOUT the seam did NOT attribute to its deadline keeps the generic download stage: no cause is claimed", async () => {
    const vt = virtualTime();
    const runtime = await boot(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: new MemoryWriter(),
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
      executorDeps: {
        analyze: async () => directMetadata(),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        downloadOriginal: async (_url, ctx) => {
          ctx.activity?.({ kind: "deadline-armed", limitMs: ctx.downloadTimeLimitMs });
          ctx.activity?.({ kind: "phase-started", phase: "single" });
          // e.g. a per-request socket timeout: a failure, not the deadline.
          ctx.activity?.({ kind: "settled", outcome: "failed" });
          throw new AppError("TIMEOUT", "Gateway Timeout from https://cdn.example/SECRET-PATH");
        },
      },
    });
    const jobId = createdJobId(runtime);
    runtime.wakeQueue();
    await waitFor(() => runtime.store.getJob(jobId)!.status === "failed", "the failure to be recorded");
    assertFailedAt(runtime, jobId, "Download failed");
  });

  it("a yt-dlp single source and both halves of a split pair get their watchdog's two stops — so the watched retry policy — and the same deadline", async () => {
    const vt = virtualTime();
    const handed: Array<{ plan: string; ctx: Record<string, unknown> }> = [];
    let plan: unknown = SINGLE_PLAN;
    const deps: Omit<JobExecutorDeps, "timeLimits" | "acquisitionInactivity"> = {
      analyzeForExecution: async () => GENERIC_ANALYSIS,
      derivePlanForExecution: () => yt(plan),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      downloadGeneric: async (_url, workDir, _p, ctx) => {
        handed.push({ plan: "single", ctx: { ...ctx } });
        const filePath = join(workDir, "source.mp4");
        await writeFile(filePath, "SINGLE");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 6 };
      },
      downloadGenericSplit: async (_url, workDir, _p, ctx) => {
        handed.push({ plan: "split", ctx: { ...ctx } });
        await writeFile(join(workDir, "video-source.mp4"), "VIDEO");
        await writeFile(join(workDir, "audio-source.m4a"), "AUDIO");
        return {
          video: { filePath: join(workDir, "video-source.mp4"), container: "mp4", fileSize: 5 },
          audio: { filePath: join(workDir, "audio-source.m4a"), container: "m4a", fileSize: 5 },
          totalFileSize: 10,
        };
      },
      mergeSplit: async (opts) => {
        const out = join(opts.workDir, "merged.mp4");
        await writeFile(out, "MERGED");
        return out;
      },
    };
    const runtime = await boot(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: new MemoryWriter(),
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
      executorDeps: deps,
    });
    for (const next of [SINGLE_PLAN, SPLIT_PLAN]) {
      plan = next;
      const jobId = createdJobId(runtime, "preset:1080");
      runtime.wakeQueue();
      await waitFor(() => runtime.store.getJob(jobId)!.status === "ready", `the ${next.operation} job to finish`);
    }
    assert.deepEqual(handed.map((h) => h.plan), ["single", "split"]);
    for (const { plan: kind, ctx } of handed) {
      assert.deepEqual(Object.keys(ctx).sort(), ["activity", "limits", "onProgress", "signal", "stopForInactivity", "stopForObservationLoss"], kind);
      assert.ok(ctx.stopForInactivity instanceof AbortSignal && ctx.stopForObservationLoss instanceof AbortSignal, kind);
      assert.notEqual(ctx.stopForInactivity, ctx.signal, `${kind}: a stop is never the caller's own signal`);
      assert.equal(selectYtdlpAcquisitionRetryPolicy(ctx as never), "watched", kind);
      assert.deepEqual({ ...(ctx.limits as object) }, { maxFileSizeBytes: 500 * 1024 * 1024, downloadTimeLimitMs: 600_000 }, kind);
    }
    assert.notEqual(handed[0]!.ctx.activity, handed[1]!.ctx.activity, "one watchdog per acquisition, never shared");
    assert.equal(vt.pendingCount(), 0);
  });

  it("a stalled yt-dlp acquisition is told its cause and recorded as Download stalled", async () => {
    const vt = virtualTime();
    let stops: { inactivity?: AbortSignal; observation?: AbortSignal } = {};
    const runtime = await boot(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: new MemoryWriter(),
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
      executorDeps: {
        analyzeForExecution: async () => GENERIC_ANALYSIS,
        derivePlanForExecution: () => yt(SINGLE_PLAN),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        downloadGeneric: (_url, _workDir, _plan, ctx) => {
          stops = { inactivity: ctx.stopForInactivity, observation: ctx.stopForObservationLoss };
          ctx.activity?.({ kind: "deadline-armed", limitMs: 600_000 });
          ctx.activity?.({ kind: "phase-started", phase: "single" });
          ctx.activity?.({ kind: "bytes", totalBytes: 3 * G, evidence: "filesystem" });
          return new Promise((_resolve, reject) => {
            ctx.stopForInactivity?.addEventListener("abort", () => reject(new AppError("TIMEOUT")), { once: true });
          });
        },
      },
    });
    const jobId = createdJobId(runtime, "preset:1080");
    runtime.wakeQueue();
    await waitFor(() => stops.inactivity !== undefined, "the acquisition to start");
    vt.advance(WINDOW);
    await waitFor(() => runtime.store.getJob(jobId)!.status === "failed", "the stall to be recorded");
    assertFailedAt(runtime, jobId, "Download stalled");
    assert.equal(stops.inactivity?.aborted, true, "the seam was told: inactivity");
    assert.equal(stops.observation?.aborted, false, "and never: observation loss");
  });

  it("clear HLS and separate-audio HLS each get one watchdog sink and no yt-dlp stop, and a stall in either is Download stalled", async () => {
    const vt = virtualTime();
    const seen = { sinks: [] as AcquisitionActivitySink[], aborted: 0 };
    const keys: string[][] = [];
    const source = stallingSource(seen);
    let plan: unknown = null;
    const HLS_PLAN = deriveClearHlsExecutionPlan(
      Object.freeze({ "preset:1080": Object.freeze({ playlistUrl: "https://media.example.invalid/hls/media.m3u8", height: 1080 }) }),
      "preset:1080",
    );
    const SEP_PLAN = deriveClearHlsSeparateAudioExecutionPlan(
      Object.freeze({
        "preset:1080": Object.freeze({
          videoPlaylistUrl: "https://media.example.invalid/hls/video.m3u8",
          audioPlaylistUrl: "https://media.example.invalid/hls/audio.m3u8",
          height: 1080,
        }),
      }),
      "preset:1080",
    );
    const runtime = await boot(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: new MemoryWriter(),
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
      executorDeps: {
        analyzeForExecution: async () => GENERIC_ANALYSIS,
        derivePlanForExecution: () => yt(plan),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        acquireClearHls: (_plan, _workDir, ctx) => {
          keys.push(Object.keys(ctx).sort());
          return source(ctx);
        },
        acquireSeparateHls: (_plan, _workDir, ctx) => {
          keys.push(Object.keys(ctx).sort());
          return source(ctx);
        },
      },
    });
    for (const next of [HLS_PLAN, SEP_PLAN]) {
      plan = next;
      const jobId = createdJobId(runtime, "preset:1080");
      const before = seen.sinks.length;
      runtime.wakeQueue();
      await waitFor(() => seen.sinks.length === before + 1, `the ${next.operation} acquisition to start`);
      vt.advance(WINDOW);
      await waitFor(() => runtime.store.getJob(jobId)!.status === "failed", `the ${next.operation} stall to be recorded`);
      assertFailedAt(runtime, jobId, "Download stalled");
    }
    for (const k of keys) assert.deepEqual(k, ["activity", "downloadTimeLimitMs", "onProgress", "signal"]);
    assert.equal(new Set(seen.sinks).size, 2, "one watchdog per acquisition");
    assert.equal(vt.pendingCount(), 0);
  });
});

describe("precedence through the real runtime", () => {
  it("a cancellation before the window wins: cancelled, and the watchdog decides nothing afterwards", async () => {
    const vt = virtualTime();
    const seen = { sinks: [] as AcquisitionActivitySink[], aborted: 0 };
    const source = stallingSource(seen);
    const runtime = await boot(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: new MemoryWriter(),
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
      executorDeps: {
        analyze: async () => directMetadata(),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        downloadOriginal: (_url, ctx) => source(ctx),
      },
    });
    const jobId = createdJobId(runtime);
    runtime.wakeQueue();
    await waitFor(() => seen.sinks.length === 1, "the acquisition to start");
    vt.advance(WINDOW / 2);
    assert.equal(runtime.executor.cancel(jobId).type, "cancelled");
    await waitFor(() => runtime.executor.activeJobCount === 0, "the execution to unwind");
    vt.advance(10 * WINDOW);
    const view = runtime.store.getJob(jobId)!;
    assert.equal(view.status, "cancelled");
    assert.equal(view.errorCode, null);
    assert.equal(vt.pendingCount(), 0);
  });

  it("an operator shutdown during a watched acquisition leaves the row to restart recovery: Worker restarted, never a stall", async () => {
    const vt = virtualTime();
    const seen = { sinks: [] as AcquisitionActivitySink[], aborted: 0 };
    const source = stallingSource(seen);
    const config = makeConfig(join(root, "state"), await reservePort());
    const first = await createWorkerRuntime(config, {
      objectStoreWriter: new MemoryWriter(),
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
      executorDeps: {
        analyze: async () => directMetadata(),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        downloadOriginal: (_url, ctx) => source(ctx),
      },
    });
    const jobId = createdJobId(first);
    first.wakeQueue();
    await waitFor(() => seen.sinks.length === 1, "the acquisition to start");
    await first.shutdown();
    assert.equal(seen.aborted, 1, "the shutdown stopped the acquisition");
    vt.advance(10 * WINDOW); // a watchdog that outlived the shutdown would act now
    assert.equal(vt.pendingCount(), 0);

    // The next process owns the restart transition.
    const second = await boot(config, { objectStoreWriter: new MemoryWriter() });
    const view = second.store.getJob(jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "PROCESSING_FAILED");
    assert.equal(view.stageLabel, WORKER_RESTART_STAGE_LABEL);
  });

  it("a job that completed before the window is ready, and a late watchdog timer cannot touch it", async () => {
    const vt = virtualTime();
    const writer = new MemoryWriter();
    const runtime = await boot(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: writer,
      acquisitionInactivityTime: { clock: vt.clock, timers: vt.timers },
      executorDeps: {
        analyze: async () => directMetadata(),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        downloadOriginal: async (_url, ctx) => {
          ctx.activity?.({ kind: "deadline-armed", limitMs: ctx.downloadTimeLimitMs });
          ctx.activity?.({ kind: "phase-started", phase: "single" });
          vt.advance(WINDOW - 1);
          ctx.activity?.({ kind: "bytes", totalBytes: 2 * G, evidence: "transport" });
          ctx.activity?.({ kind: "phase-ended" });
          const filePath = join(ctx.workDir, "source.mp4");
          await writeFile(filePath, "ORIGINAL");
          return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
        },
      },
    });
    const jobId = createdJobId(runtime);
    runtime.wakeQueue();
    await waitFor(() => runtime.store.getJob(jobId)!.status === "ready", "the job to finish");
    const ready = runtime.store.getJob(jobId);
    // Read BEFORE any time passes: an undisposed watchdog would end itself at the
    // absolute deadline and hide a missing release (the LD-3b lesson).
    assert.equal(vt.pendingCount(), 0, "the watchdog was released the moment the acquisition settled");
    vt.advance(10 * WINDOW);
    assert.deepEqual(runtime.store.getJob(jobId), ready);
    assert.equal(writer.puts, 1);
    assert.equal(vt.pendingCount(), 0);
  });
});
