import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import { setSafeHttpTestHooks } from "@/lib/security/safe-http.server.ts";
import type { AcquisitionActivityEvent, AcquisitionActivitySink } from "@/services/downloads/acquisition-activity";
import {
  createAcquisitionInactivityWatchdog,
  type InactivityWatchdogTimerHandle,
  type InactivityWatchdogTimers,
} from "@/services/downloads/acquisition-inactivity-watchdog";
import { setDirectDownloadDeadlineTimerForTests } from "@/services/extractors/direct.server";
import { runProcess, type RunResult } from "@/services/processing/process-runner.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema, WorkerJobViewSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import type { WorkerRequestedFormatId } from "@/shared/worker/contracts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import { acquireSelectedClearHlsMedia } from "../hls/hls-execution.server.ts";
import {
  acquireClearHlsFmp4,
  acquireClearHlsSeparateAudioFmp4,
  acquireClearHlsSeparateVideoFmp4,
  acquireClearHlsTs,
} from "../hls/hls-fragment-acquisition.server.ts";
import type { ClearHlsFmp4AcquisitionPlan, ClearHlsMpegTsAcquisitionPlan } from "../hls/hls-preflight.server.ts";
import { acquireSelectedSeparateHlsMedia } from "../hls/hls-separate-audio-execution.server.ts";
import {
  DOWNLOAD_TIME_LIMIT_SECONDS,
  FILE_EXPIRATION_MINUTES_RANGE,
  PROCESSING_TIMEOUT_SECONDS,
  UPLOAD_TIMEOUT_SECONDS,
} from "../runtime/time-limits.ts";
import { YTDLP_RUNTIME } from "../runtime/ytdlp-runtime.server.ts";
import type { DurableWorkerJob } from "../state/job-store.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type { ObjectStorePutInput, ObjectStoreWriter } from "../storage/writer.ts";
import {
  GenericExecutionPlanSchema,
  deriveClearHlsExecutionPlan,
  deriveClearHlsSeparateAudioExecutionPlan,
  type ExecutionPlan,
  type GenericSingleSourceExecutionPlan,
} from "./format-plan.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";
import { downloadGenericOriginal, expectedPartPath, selectYtdlpAcquisitionRetryPolicy } from "./ytdlp-download.server.ts";

/**
 * VIDEOFETCH-LD3B-INACTIVITY-WATCHDOG-CORE-001 — enforcement through the REAL
 * executor, against a real SQLite store.
 *
 * Direct and clear HLS run their real transports over the synthetic safe-HTTP
 * hooks; only the watchdog's clock and timers are virtual, so a 120-second
 * window passes when the test says so and no real wait decides anything. The
 * real waits below only let real I/O catch up (bounded at 10 s), never a
 * deadline.
 *
 * Enforcement is supplied here by injection, so each test controls its clock.
 * Since VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001 Production supplies it
 * too, from the composition root: the structural block at the end pins that,
 * and `inactivity-runtime-activation.server.test.ts` proves it on the real
 * runtime.
 */

const WINDOW = 120_000;
const G = 65_536;
const F1 = "https://cdn.example/SECRET-PATH/seg-1.ts?sig=TOP-SECRET-TOKEN";
const F2 = "https://cdn.example/SECRET-PATH/seg-2.ts?sig=TOP-SECRET-TOKEN";
const INIT = "https://cdn.example/SECRET-PATH/init.mp4?sig=TOP-SECRET-TOKEN";
const VIDEO_INIT = "https://cdn.example/SECRET-PATH/video-init.mp4";
const VIDEO_SEG = "https://cdn.example/SECRET-PATH/video-1.m4s";
const AUDIO_INIT = "https://cdn.example/SECRET-PATH/audio-init.mp4";
const AUDIO_SEG = "https://cdn.example/SECRET-PATH/audio-1.m4s";

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
    now: () => now,
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
    /**
     * LD-3 activation: the clock moves and NO timer runs — a process that did
     * not run (a frozen VM). The next `advance` fires what fell due meanwhile,
     * and that late tick reads the jumped clock.
     */
    jump(ms: number) {
      now += ms;
    },
    pendingCount: () => pending.size,
  };
}

const enforcement = (vt: ReturnType<typeof virtualTime>, windowMs = WINDOW) => ({
  policy: { windowMs },
  clock: vt.clock,
  timers: vt.timers,
});

// ── Store, writer, job ───────────────────────────────────────────────────────

let eventLoopHold: ReturnType<typeof setTimeout> | null = null;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  // The transports' timers are unref'd and a manual body holds nothing, so the
  // test keeps the loop alive itself (the Node 22 trap).
  eventLoopHold = setTimeout(() => {}, 60_000);
  setDirectDownloadDeadlineTimerForTests({ set: () => 0, clear: () => {} });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setSafeHttpTestHooks(null);
  setDirectDownloadDeadlineTimerForTests(null);
  if (eventLoopHold !== null) clearTimeout(eventLoopHold);
  eventLoopHold = null;
});

function harness() {
  const tempDir = mkdtempSync(join(tmpdir(), "ld3b-enforcement-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const store = new SQLiteJobStore({ db });
  const puts: ObjectStorePutInput[] = [];
  const failJobCalls: Array<{ code: string }> = [];
  // VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001: forwards EVERY argument —
  // the acquisition stop included — so the real store decides the stage.
  const failJobStops: Array<string | undefined> = [];
  const realFailJob = store.failJob.bind(store);
  store.failJob = (...args: Parameters<SQLiteJobStore["failJob"]>) => {
    failJobCalls.push({ code: args[1] });
    failJobStops.push(args[3]);
    return realFailJob(...args);
  };
  const writer: ObjectStoreWriter = {
    async put(input) {
      puts.push(input);
      for await (const piece of input.body) void piece;
    },
    async head(key) {
      const last = puts.find((p) => p.objectKey === key);
      return last
        ? { objectKey: last.objectKey, contentLength: last.contentLength, contentType: last.contentType, contentDisposition: last.contentDisposition, lastModifiedAtMs: Math.floor(Date.now() / 1000) * 1000 }
        : null;
    },
    async delete() {},
  };
  cleanups.push(() => {
    db.close();
    setTempDirectoryForTests(null);
    rmSync(tempDir, { recursive: true, force: true });
  });
  return {
    tempDir,
    db,
    store,
    puts,
    writer,
    failJobCalls,
    failJobStops,
    claim(formatId: WorkerRequestedFormatId = "direct-original", url = "https://cdn.example.com/clip.mp4"): DurableWorkerJob {
      store.createJob({ url, formatId, principalId: "private-access-user" }, randomUUID());
      const job = store.claimNextQueuedJob();
      assert.ok(job);
      return job;
    },
    jobDirExists: (jobId: string) => existsSync(join(tempDir, "jobs", jobId)),
  };
}

function directMeta(withMp3 = false): WorkerVideoMetadata {
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
        resolution: "unknown",
        width: null,
        height: null,
        fps: null,
        container: "mp4",
        videoCodec: "unknown",
        audioCodec: "unknown",
        bitrate: null,
        fileSize: null,
        hasVideo: true,
        hasAudio: true,
        formatNote: null,
      },
    ],
    presets: withMp3
      ? [
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
        ]
      : [],
    capabilities: { mp3: true, merge: true },
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

const yt = (generic: unknown): ExecutionPlan => ({ strategy: "yt-dlp", generic }) as ExecutionPlan;

const HLS_PLAN = deriveClearHlsExecutionPlan(
  Object.freeze({ "preset:1080": Object.freeze({ playlistUrl: "https://media.example.invalid/hls/media.m3u8", height: 1080 }) }),
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
    video: { ...SOURCE, formatId: "137", hasAudio: false, audioConstraint: "absent" },
    audio: { ...SOURCE, formatId: "140", container: "m4a", hasVideo: false, videoConstraint: "absent" },
  },
  targetContainer: "mp4",
});

// ── Transport fakes ──────────────────────────────────────────────────────────

const chunk = (size: number, fill = 0xab) => Buffer.alloc(size, fill);

function chunkedBody(chunks: readonly Buffer[]): Readable {
  let next = 0;
  return new Readable({
    read() {
      const piece = chunks[next];
      next += 1;
      this.push(piece === undefined ? null : piece);
    },
  });
}

/** A body the test drives by hand; it never ends until told to. */
function manualBody() {
  const stream = new Readable({ read() {} });
  return { stream, push: (data: Buffer) => stream.push(data), end: () => stream.push(null) };
}

function serveDirect(body: Readable) {
  setSafeHttpTestHooks({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    requestOnce: async () => ({ status: 200, headers: { "content-type": "video/mp4" }, body }),
  });
}

function fakeHlsNetwork(routes: Record<string, () => Readable>) {
  setSafeHttpTestHooks({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    requestOnce: async (args) => {
      const route = routes[args.url.href];
      if (route === undefined) throw new AppError("NETWORK_ERROR");
      return { status: 200, headers: {}, body: route() };
    },
  });
}

function hlsTsPlan(urls: readonly string[]): ClearHlsMpegTsAcquisitionPlan {
  return Object.freeze({
    segmentType: "mpegts",
    fragments: Object.freeze(urls.map((url) => Object.freeze({ url }))),
    fragmentCount: urls.length,
  }) as ClearHlsMpegTsAcquisitionPlan;
}

function hlsFmp4Plan(init: string, urls: readonly string[]): ClearHlsFmp4AcquisitionPlan {
  return Object.freeze({
    segmentType: "fmp4",
    initializationMap: Object.freeze({ url: init }),
    fragments: Object.freeze(urls.map((url) => Object.freeze({ url }))),
    fragmentCount: urls.length,
  }) as ClearHlsFmp4AcquisitionPlan;
}

function observer() {
  const events: AcquisitionActivityEvent[] = [];
  return {
    events,
    factory: () => (event: AcquisitionActivityEvent) => {
      events.push(event);
    },
    count: (kind: AcquisitionActivityEvent["kind"]) => events.filter((e) => e.kind === kind).length,
    totals: () => events.flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : [])),
    settled: () => events.flatMap((e) => (e.kind === "settled" ? [e.outcome] : [])),
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 10_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function hlsDeps(over: Partial<JobExecutorDeps> = {}): JobExecutorDeps {
  return {
    analyzeForExecution: async () => GENERIC_ANALYSIS,
    availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
    processClearHls: async (opts) => {
      const filePath = join(opts.workDir, "hls-output.mp4");
      writeFileSync(filePath, "remuxed-media");
      return Object.freeze({ filePath, container: "mp4" as const, fileSize: 13 });
    },
    processSeparateHls: async (opts) => {
      const filePath = join(opts.workDir, "hls-output.mp4");
      writeFileSync(filePath, "merged-media");
      return Object.freeze({ filePath, container: "mp4" as const, fileSize: 12 });
    },
    ...over,
  };
}

/**
 * VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001: a stop is now recorded with
 * its own download-stage label — `Download stalled` for the watchdog's stop,
 * `Download time limit reached` when the seam's absolute deadline came first
 * (LD-3b wrote `Download failed` for both, the LD-4a R3 deferral). Still always
 * the download stage, never processing.
 */
const STALLED = "Download stalled";
const TIME_LIMIT = "Download time limit reached";
const failedAsTimeout = (view: ReturnType<SQLiteJobStore["getJob"]>, stage: typeof STALLED | typeof TIME_LIMIT) => {
  assert.ok(view);
  assert.equal(view.status, "failed");
  assert.equal(view.errorCode, "TIMEOUT");
  assert.equal(view.safeErrorMessage, ERROR_MESSAGES.TIMEOUT);
  assert.equal(view.stageLabel, stage, "the stop's own download-stage label, never processing");
};

// ── Direct ───────────────────────────────────────────────────────────────────

describe("direct: a dead source is stopped one window after its last meaningful progress", () => {
  it("stops the transfer, tears the body down, fails the job TIMEOUT at the download stage, and uploads nothing", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    body.push(chunk(70_000));
    await waitUntil(() => o.totals().includes(70_000), "the first chunk");
    vt.advance(WINDOW - 1_000);
    assert.equal(h.store.getJob(job.jobId)!.status, "downloading", "not yet: the window has not passed");
    vt.advance(1_000);
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
    assert.equal(body.stream.destroyed, true, "the transport stopped reading the source");
    assert.equal(h.puts.length, 0, "no upload after a stalled acquisition");
    assert.equal(h.jobDirExists(job.jobId), false, "the partial file and its directory are gone");
    assert.equal(executor.activeJobCount, 0);
    assert.equal(vt.pendingCount(), 0, "no watchdog timer outlives the acquisition");
    assert.deepEqual(h.failJobCalls, [{ code: "TIMEOUT" }], "one terminal update");
    // The seam saw its caller's abort; the durable outcome is the executor's.
    assert.deepEqual(o.settled(), ["cancelled"]);
    assert.notEqual(h.store.getJob(job.jobId)!.status, "cancelled");
  });

  it("a slow but healthy transfer is never stopped, and completes", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    let total = 0;
    for (let i = 0; i < 8; i += 1) {
      body.push(chunk(G));
      total += G;
      const expected = total;
      await waitUntil(() => o.totals().includes(expected), `chunk ${i}`);
      vt.advance(WINDOW - 1_000); // just inside the window, every time: 8 windows in all
      assert.equal(h.store.getJob(job.jobId)!.status, "downloading");
    }
    body.end();
    await done;
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "ready");
    assert.equal(view.fileSize, 8 * G);
    assert.equal(h.puts.length, 1);
    assert.equal(vt.pendingCount(), 0);
    vt.advance(10 * WINDOW);
    assert.equal(h.store.getJob(job.jobId)!.status, "ready", "a late tick cannot touch a finished job");
    assert.deepEqual(h.failJobCalls, []);
  });

  it("insufficient progress cannot extend the window: small chunks arriving all along still stop it", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    let total = 0;
    for (let i = 0; i < 11; i += 1) {
      body.push(chunk(4_000));
      total += 4_000;
      const expected = total;
      await waitUntil(() => o.totals().includes(expected), `small chunk ${i}`);
      vt.advance(10_000);
    }
    assert.equal(h.store.getJob(job.jobId)!.status, "downloading");
    vt.advance(10_000); // 120 s after the phase start: 44 kB in all, below the floor
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
  });
});

// ── Clear HLS ────────────────────────────────────────────────────────────────

describe("clear HLS: the stop reaches the fragment transport", () => {
  it("MPEG-TS: a stall inside a fragment is stopped; the body is disposed and the partial removed", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    fakeHlsNetwork({ [F1]: () => body.stream, [F2]: () => chunkedBody([chunk(10)]) });
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps({
      derivePlanForExecution: () => yt(HLS_PLAN),
      acquireClearHls: (plan, workDir, ctx) =>
        acquireSelectedClearHlsMedia(
          { plan, workDir, signal: ctx.signal, downloadTimeLimitMs: ctx.downloadTimeLimitMs, ...(ctx.activity ? { activity: ctx.activity } : {}) },
          { preflight: async () => hlsTsPlan([F1, F2]), acquire: acquireClearHlsTs, acquireFmp4: acquireClearHlsFmp4 },
        ),
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    }));
    const job = h.claim("preset:1080", "https://example.invalid/watch");
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    body.push(chunk(100_000)); // meaningful progress inside the first fragment, then nothing
    await waitUntil(() => o.totals().includes(100_000), "the chunk");
    vt.advance(WINDOW);
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
    assert.equal(body.stream.destroyed, true, "the fragment body was disposed");
    assert.equal(h.jobDirExists(job.jobId), false);
    assert.equal(h.puts.length, 0);
    assert.equal(vt.pendingCount(), 0);
  });

  it("fMP4: a resource boundary with no next byte is silence, and is stopped", async () => {
    const h = harness();
    const vt = virtualTime();
    const next = manualBody();
    fakeHlsNetwork({ [INIT]: () => chunkedBody([chunk(70_000)]), [F1]: () => next.stream });
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps({
      derivePlanForExecution: () => yt(HLS_PLAN),
      acquireClearHls: (plan, workDir, ctx) =>
        acquireSelectedClearHlsMedia(
          { plan, workDir, signal: ctx.signal, downloadTimeLimitMs: ctx.downloadTimeLimitMs, ...(ctx.activity ? { activity: ctx.activity } : {}) },
          { preflight: async () => hlsFmp4Plan(INIT, [F1]), acquire: acquireClearHlsTs, acquireFmp4: acquireClearHlsFmp4 },
        ),
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    }));
    const job = h.claim("preset:1080", "https://example.invalid/watch");
    const done = executor.execute(job);
    await waitUntil(() => o.count("resource-boundary") === 1, "the map's boundary");
    vt.advance(WINDOW);
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
    assert.equal(next.stream.destroyed, true);
  });

  it("a large fragment arriving slowly but steadily completes, with no false stop", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    fakeHlsNetwork({ [F1]: () => body.stream });
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps({
      derivePlanForExecution: () => yt(HLS_PLAN),
      acquireClearHls: (plan, workDir, ctx) =>
        acquireSelectedClearHlsMedia(
          { plan, workDir, signal: ctx.signal, downloadTimeLimitMs: ctx.downloadTimeLimitMs, ...(ctx.activity ? { activity: ctx.activity } : {}) },
          { preflight: async () => hlsTsPlan([F1]), acquire: acquireClearHlsTs, acquireFmp4: acquireClearHlsFmp4 },
        ),
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    }));
    const job = h.claim("preset:1080", "https://example.invalid/watch");
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    let total = 0;
    for (let i = 0; i < 6; i += 1) {
      body.push(chunk(G));
      total += G;
      const expected = total;
      await waitUntil(() => o.totals().includes(expected), `chunk ${i}`);
      vt.advance(WINDOW - 1); // six windows inside ONE fragment: no completed fragment at all
    }
    body.end();
    await done;
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
    assert.equal(vt.pendingCount(), 0);
  });

  it("separate-audio: the audio half gets its own window, and a stall in it removes both halves", async () => {
    const h = harness();
    const vt = virtualTime();
    const audioSeg = manualBody();
    fakeHlsNetwork({
      [VIDEO_INIT]: () => chunkedBody([chunk(100)]),
      [VIDEO_SEG]: () => chunkedBody([chunk(70_000)]),
      [AUDIO_INIT]: () => chunkedBody([chunk(50)]),
      [AUDIO_SEG]: () => audioSeg.stream,
    });
    let preflights = 0;
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps({
      derivePlanForExecution: () => yt(SEPARATE_PLAN),
      acquireSeparateHls: (plan, workDir, ctx) =>
        acquireSelectedSeparateHlsMedia(
          { plan, workDir, signal: ctx.signal, downloadTimeLimitMs: ctx.downloadTimeLimitMs, ...(ctx.activity ? { activity: ctx.activity } : {}) },
          {
            preflight: async () => {
              preflights += 1;
              return preflights === 1 ? hlsFmp4Plan(VIDEO_INIT, [VIDEO_SEG]) : hlsFmp4Plan(AUDIO_INIT, [AUDIO_SEG]);
            },
            acquireVideo: acquireClearHlsSeparateVideoFmp4,
            acquireAudio: acquireClearHlsSeparateAudioFmp4,
          } as Parameters<typeof acquireSelectedSeparateHlsMedia>[1],
        ),
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    }));
    const job = h.claim("preset:1080", "https://example.invalid/watch");
    const done = executor.execute(job);
    await waitUntil(() => o.events.some((e) => e.kind === "phase-started" && e.phase === "audio"), "the audio half");
    audioSeg.push(chunk(10));
    await waitUntil(() => o.totals().includes(60), "the audio chunk");
    vt.advance(WINDOW);
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
    assert.equal(audioSeg.stream.destroyed, true);
    assert.equal(h.jobDirExists(job.jobId), false, "both halves are gone with the job directory");
    assert.equal(h.puts.length, 0);
  });
});

// ── Terminal precedence ──────────────────────────────────────────────────────

/** A direct seam that reports a live phase and then only waits for its signal. */
function waitingSeam(onAbort: (signal: AbortSignal) => Promise<never> | never, record?: (ctx: { activity?: AcquisitionActivitySink; signal?: AbortSignal }) => void) {
  return (async (_url: string, ctx: { activity?: AcquisitionActivitySink; signal?: AbortSignal }) => {
    record?.(ctx);
    ctx.activity?.({ kind: "deadline-armed", limitMs: 600_000 });
    ctx.activity?.({ kind: "phase-started", phase: "single" });
    await new Promise<void>((resolve) => {
      if (ctx.signal?.aborted) resolve();
      else ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return onAbort(ctx.signal!);
  }) as unknown as JobExecutorDeps["downloadOriginal"];
}

describe("terminal precedence, consistent with the existing executor", () => {
  it("a user cancellation before the window wins: cancelled, no failure written, and no stop afterwards", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    vt.advance(60_000);
    assert.equal(executor.cancel(job.jobId).type, "cancelled");
    await done;
    vt.advance(10 * WINDOW);
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "cancelled");
    assert.equal(view.errorCode, null);
    assert.deepEqual(h.failJobCalls, []);
    assert.equal(vt.pendingCount(), 0);
  });

  it("a cancellation that commits after the stop but before the outcome is written still wins", async () => {
    const h = harness();
    const vt = virtualTime();
    let jobId = "";
    const executor: JobExecutor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      downloadOriginal: waitingSeam(() => {
        // The person's cancel reaches the store between the stop and the catch.
        assert.equal(executor.cancel(jobId).type, "cancelled");
        throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
      }),
    });
    const job = h.claim();
    jobId = job.jobId;
    const done = executor.execute(job);
    await waitUntil(() => vt.pendingCount() === 1, "the watchdog to arm");
    vt.advance(WINDOW);
    await done;
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled", "the durable cancellation is never overwritten");
    assert.deepEqual(h.failJobCalls, []);
  });

  it("an operator shutdown after the stop leaves the row to restart recovery, which classifies it deterministically", async () => {
    const h = harness();
    const vt = virtualTime();
    const executor: JobExecutor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      downloadOriginal: waitingSeam(() => {
        assert.equal(executor.abortActiveForShutdown(), 1);
        throw new AppError("PROCESSING_FAILED", "Worker shutting down");
      }),
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => vt.pendingCount() === 1, "the watchdog to arm");
    vt.advance(WINDOW);
    await done;
    assert.equal(h.store.getJob(job.jobId)!.status, "downloading", "shutdown commits no terminal state");
    assert.deepEqual(h.failJobCalls, []);
    // The next process: recovery owns the restart transition; the watchdog left nothing durable.
    h.store.recover();
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "PROCESSING_FAILED");
    assert.equal(view.stageLabel, "Worker restarted");
  });

  it("the absolute deadline wins when it comes first: the seam's own TIMEOUT, and the watchdog never stopped anything", async () => {
    const h = harness();
    const vt = virtualTime();
    const deadlines: Array<() => void> = [];
    setDirectDownloadDeadlineTimerForTests({ set: (fn) => deadlines.push(fn), clear: () => {} });
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    body.push(chunk(G));
    await waitUntil(() => o.totals().includes(G), "a chunk");
    vt.advance(60_000);
    assert.equal(deadlines.length, 1, "the seam armed its one deadline");
    deadlines[0]!();
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), TIME_LIMIT);
    assert.deepEqual(o.settled(), ["deadline-exceeded"], "the time limit, not a stop, ended the transfer");
    assert.equal(vt.pendingCount(), 0);
  });

  it("both at the same observable instant: the time limit wins, deterministically", async () => {
    const h = harness();
    const vt = virtualTime();
    const deadlines: Array<() => void> = [];
    setDirectDownloadDeadlineTimerForTests({ set: (fn) => deadlines.push(fn), clear: () => {} });
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    // A window equal to the acquisition limit: both end at the same instant.
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt, 600_000),
      createAcquisitionActivitySink: o.factory,
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    vt.advance(600_000);
    assert.equal(h.store.getJob(job.jobId)!.status, "downloading", "the watchdog deferred to the time limit");
    assert.equal(vt.pendingCount(), 0, "and released its timer");
    deadlines[0]!();
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), TIME_LIMIT);
    assert.deepEqual(o.settled(), ["deadline-exceeded"]);
  });

  it("a source failure before the window wins with its own code", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    body.push(chunk(10_000));
    await waitUntil(() => o.totals().includes(10_000), "a chunk");
    vt.advance(30_000);
    body.stream.destroy(new Error("ECONNRESET"));
    await done;
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "NETWORK_ERROR");
    vt.advance(10 * WINDOW);
    assert.equal(h.store.getJob(job.jobId)!.errorCode, "NETWORK_ERROR");
    assert.deepEqual(h.failJobCalls, [{ code: "NETWORK_ERROR" }]);
  });

  it("another writer's terminal state wins the CAS: the stop's failure is refused, and nothing throws", async () => {
    const h = harness();
    const vt = virtualTime();
    let jobId = "";
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      downloadOriginal: waitingSeam(() => {
        assert.equal(h.store.failJob(jobId, "NETWORK_ERROR", ERROR_MESSAGES.NETWORK_ERROR), true);
        throw new AppError("NETWORK_ERROR");
      }),
    });
    const job = h.claim();
    jobId = job.jobId;
    const done = executor.execute(job);
    await waitUntil(() => vt.pendingCount() === 1, "the watchdog to arm");
    vt.advance(WINDOW);
    await done;
    assert.equal(h.store.getJob(job.jobId)!.errorCode, "NETWORK_ERROR", "the first terminal writer is kept");
    assert.deepEqual(h.failJobCalls, [{ code: "NETWORK_ERROR" }, { code: "TIMEOUT" }]);
  });

  it("a seam that ignores the stop and returns anyway cannot continue: no processing, no upload", async () => {
    const h = harness();
    const vt = virtualTime();
    let processed = 0;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(true),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      processLocally: async (opts) => {
        processed += 1;
        const out = join(opts.workDir, `converted.${opts.target}`);
        writeFileSync(out, "converted");
        return out;
      },
      downloadOriginal: (async (_url: string, ctx: Parameters<NonNullable<JobExecutorDeps["downloadOriginal"]>>[1]) => {
        ctx.activity?.({ kind: "phase-started", phase: "single" });
        await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
        const filePath = join(ctx.workDir, "source.mp4");
        writeFileSync(filePath, "late-success");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 12 };
      }) as JobExecutorDeps["downloadOriginal"],
    });
    const job = h.claim("preset:mp3");
    const done = executor.execute(job);
    await waitUntil(() => vt.pendingCount() === 1, "the watchdog to arm");
    vt.advance(WINDOW);
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
    assert.equal(processed, 0, "no FFmpeg after a stopped acquisition");
    assert.equal(h.puts.length, 0, "no upload after a stopped acquisition");
  });

  it("the stop is the execution's own controller aborting with TIMEOUT; no cancellation is recorded", async () => {
    const h = harness();
    const vt = virtualTime();
    let seen: AbortSignal | undefined;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      downloadOriginal: waitingSeam(
        (signal) => {
          throw signal.reason;
        },
        (ctx) => {
          seen = ctx.signal;
        },
      ),
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => vt.pendingCount() === 1, "the watchdog to arm");
    vt.advance(WINDOW);
    await done;
    assert.ok(seen?.aborted);
    assert.ok(seen.reason instanceof AppError);
    assert.equal((seen.reason as AppError).code, "TIMEOUT");
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "TIMEOUT");
  });

  it("completion just before the window wins, and a late timer cannot touch the finished job", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    body.push(chunk(500));
    await waitUntil(() => o.totals().includes(500), "a small chunk");
    vt.advance(WINDOW - 1_000);
    body.end(); // fewer than 64 KiB in all, finishing inside the window
    await done;
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
    assert.equal(vt.pendingCount(), 0);
    vt.advance(10 * WINDOW);
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
    assert.deepEqual(h.failJobCalls, []);
  });

  it("a late activity callback after the job finished is inert", async () => {
    const h = harness();
    const vt = virtualTime();
    let captured: AcquisitionActivitySink | undefined;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      downloadOriginal: (async (_url: string, ctx: Parameters<NonNullable<JobExecutorDeps["downloadOriginal"]>>[1]) => {
        captured = ctx.activity;
        ctx.activity?.({ kind: "phase-started", phase: "single" });
        const filePath = join(ctx.workDir, "source.mp4");
        writeFileSync(filePath, "mockdata");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
      }) as JobExecutorDeps["downloadOriginal"],
    });
    const job = h.claim();
    await executor.execute(job);
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
    assert.equal(vt.pendingCount(), 0, "released the moment the seam settled, though the seam never reported it");
    assert.ok(captured);
    captured({ kind: "phase-started", phase: "audio" });
    captured({ kind: "bytes", totalBytes: 10, evidence: "transport" });
    vt.advance(10 * WINDOW);
    assert.equal(vt.pendingCount(), 0, "a disposed watchdog arms nothing");
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
  });

  it("a timer due during the executor's cleanup does not act twice", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    vt.advance(WINDOW);
    vt.advance(10 * WINDOW); // while the transport tears down and the directory is removed
    await done;
    vt.advance(10 * WINDOW);
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
    assert.deepEqual(h.failJobCalls, [{ code: "TIMEOUT" }]);
  });

  it("processing is never watched: a conversion longer than many windows finishes ready", async () => {
    const h = harness();
    const vt = virtualTime();
    const body = manualBody();
    serveDirect(body.stream);
    const o = observer();
    let pendingAtProcessing = -1;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(true),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
      processLocally: async (opts) => {
        pendingAtProcessing = vt.pendingCount();
        vt.advance(10 * WINDOW);
        const out = join(opts.workDir, `converted.${opts.target}`);
        writeFileSync(out, "converted-media");
        return out;
      },
    });
    const job = h.claim("preset:mp3");
    const done = executor.execute(job);
    await waitUntil(() => o.count("phase-started") === 1, "the phase to start");
    body.push(chunk(G));
    body.end();
    await done;
    assert.equal(pendingAtProcessing, 0, "the watchdog was released before processing began");
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
  });
});

// ── Scope: which paths are watched ───────────────────────────────────────────

describe("scope: only transport-observed plans are watched", () => {
  for (const [label, plan] of [
    ["single source", SINGLE_PLAN],
    ["split pair", SPLIT_PLAN],
  ] as const) {
    it(`a generic subprocess ${label} never gets a watchdog, whatever enforcement is supplied`, async () => {
      const h = harness();
      const vt = virtualTime();
      const o = observer();
      const handed: unknown[] = [];
      const write = (dir: string, name: string) => {
        writeFileSync(join(dir, name), "media-bytes");
        return { filePath: join(dir, name), fileSize: 11 };
      };
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
        analyzeForExecution: async () => GENERIC_ANALYSIS,
        derivePlanForExecution: () => yt(plan),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        acquisitionInactivity: enforcement(vt),
        createAcquisitionActivitySink: o.factory,
        downloadGeneric: async (_url, workDir, _plan, ctx) => {
          handed.push(ctx.activity);
          ctx.activity?.({ kind: "phase-started", phase: "single" });
          vt.advance(10 * WINDOW); // a long silence on this path changes nothing
          return { ...write(workDir, "source.mp4"), container: "mp4", mime: "video/mp4" };
        },
        downloadGenericSplit: async (_url, workDir, _plan, ctx) => {
          handed.push(ctx.activity);
          vt.advance(10 * WINDOW);
          const video = write(workDir, "video-source.mp4");
          const audio = write(workDir, "audio-source.m4a");
          return { video: { ...video, container: "mp4" }, audio: { ...audio, container: "m4a" }, totalFileSize: 22 };
        },
        mergeSplit: async (opts) => write(opts.workDir, "merged.mp4").filePath,
      });
      const job = h.claim("preset:1080", "https://example.invalid/watch");
      await executor.execute(job);
      assert.equal(h.store.getJob(job.jobId)!.status, "ready");
      assert.equal(handed.length, 1);
      assert.equal(typeof handed[0], "function");
      assert.equal(vt.pendingCount(), 0, "no watchdog timer was ever armed");
      assert.equal(o.events.length, label === "single source" ? 1 : 0, "the seam reached the observer directly");
    });
  }

  it("with no observer and a generic plan, the seam's context has no activity key at all", async () => {
    const h = harness();
    const vt = virtualTime();
    let keys: string[] = [];
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyzeForExecution: async () => GENERIC_ANALYSIS,
      derivePlanForExecution: () => yt(SINGLE_PLAN),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      downloadGeneric: async (_url, workDir, _plan, ctx) => {
        keys = Object.keys(ctx).sort();
        writeFileSync(join(workDir, "source.mp4"), "media-bytes");
        return { filePath: join(workDir, "source.mp4"), container: "mp4", mime: "video/mp4", fileSize: 11 };
      },
    });
    await executor.execute(h.claim("preset:1080", "https://example.invalid/watch"));
    assert.deepEqual(keys, ["limits", "onProgress", "signal"]);
  });

  it("enforcement changes nothing a seam receives except the one sink, and never the deadline", async () => {
    const seen = async (withEnforcement: boolean) => {
      const h = harness();
      const vt = virtualTime();
      let ctxSeen: Record<string, unknown> = {};
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
        analyze: async () => directMeta(),
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        ...(withEnforcement ? { acquisitionInactivity: enforcement(vt) } : {}),
        downloadOriginal: async (_url, ctx) => {
          ctxSeen = { ...ctx };
          const filePath = join(ctx.workDir, "source.mp4");
          writeFileSync(filePath, "mockdata");
          return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
        },
      });
      await executor.execute(h.claim());
      return ctxSeen;
    };
    const off = await seen(false);
    const on = await seen(true);
    assert.deepEqual(Object.keys(off).sort(), ["downloadTimeLimitMs", "onProgress", "signal", "workDir"]);
    assert.deepEqual(Object.keys(on).sort(), ["activity", "downloadTimeLimitMs", "onProgress", "signal", "workDir"]);
    assert.equal(off.downloadTimeLimitMs, 600_000);
    assert.equal(on.downloadTimeLimitMs, 600_000, "the absolute deadline is never extended by enforcement");
  });

  it("an observer that throws can never keep an event from the watchdog", async () => {
    const h = harness();
    const vt = virtualTime();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: () => () => {
        throw new Error("a broken observer");
      },
      downloadOriginal: waitingSeam((signal) => {
        throw signal.reason;
      }),
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => vt.pendingCount() === 1, "the watchdog to arm through the composite");
    vt.advance(WINDOW);
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
  });

  it("a failing observer factory never removes the watchdog", async () => {
    const h = harness();
    const vt = virtualTime();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: () => {
        throw new Error("factory failure");
      },
      downloadOriginal: waitingSeam((signal) => {
        throw signal.reason;
      }),
    });
    const job = h.claim();
    const done = executor.execute(job);
    await waitUntil(() => vt.pendingCount() === 1, "the watchdog to arm without its observer");
    vt.advance(WINDOW);
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
  });

  it("a progress percentage or a browser-progress update is never evidence", async () => {
    const h = harness();
    const vt = virtualTime();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      downloadOriginal: (async (_url: string, ctx: Parameters<NonNullable<JobExecutorDeps["downloadOriginal"]>>[1]) => {
        ctx.activity?.({ kind: "deadline-armed", limitMs: 600_000 });
        ctx.activity?.({ kind: "phase-started", phase: "single" });
        // The browser channel keeps moving — a percentage, growing byte counts — while
        // the transport reports nothing at all.
        for (let i = 1; i <= 20 && !ctx.signal?.aborted; i += 1) {
          ctx.onProgress?.({ progress: i * 4, downloadedBytes: i * 10_000_000, totalBytes: 250_000_000, stage: "downloading" });
          vt.advance(10_000);
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (ctx.signal?.aborted) throw ctx.signal.reason;
        const filePath = join(ctx.workDir, "source.mp4");
        writeFileSync(filePath, "mockdata");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
      }) as JobExecutorDeps["downloadOriginal"],
    });
    const job = h.claim();
    await executor.execute(job);
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
  });

  it("a stop never relabels an abort that already happened for another cause", async () => {
    const h = harness();
    const vt = virtualTime();
    let jobId = "";
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: enforcement(vt),
      downloadOriginal: (async (_url: string, ctx: Parameters<NonNullable<JobExecutorDeps["downloadOriginal"]>>[1]) => {
        ctx.activity?.({ kind: "phase-started", phase: "single" });
        // Another writer ends the job; the next progress write is refused and the
        // executor's own progress gate aborts this execution (PROCESSING_FAILED).
        assert.equal(h.store.failJob(jobId, "NETWORK_ERROR", ERROR_MESSAGES.NETWORK_ERROR), true);
        ctx.onProgress?.({ progress: 1, downloadedBytes: 1, totalBytes: null, stage: "downloading" });
        assert.equal(ctx.signal?.aborted, true, "the progress gate aborted first");
        vt.advance(WINDOW); // the window passes while the seam is still unwinding
        throw new AppError("PROCESSING_FAILED");
      }) as JobExecutorDeps["downloadOriginal"],
    });
    const job = h.claim();
    jobId = job.jobId;
    await executor.execute(job);
    // The executor's own classification of the first cause is attempted (and refused
    // by the terminal row); never a TIMEOUT that no stop caused first.
    assert.deepEqual(h.failJobCalls, [{ code: "NETWORK_ERROR" }, { code: "PROCESSING_FAILED" }]);
    assert.equal(h.store.getJob(job.jobId)!.errorCode, "NETWORK_ERROR");
  });

  it("an invalid enforcement policy is refused when the executor is built", () => {
    const h = harness();
    const vt = virtualTime();
    for (const windowMs of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), { acquisitionInactivity: enforcement(vt, windowMs) }),
        RangeError,
      );
    }
  });
});

// ── The accepted cancellation mechanisms ─────────────────────────────────────

const RUNTIME_OK = Object.freeze({ available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" as const });

function progressivePlan(): GenericSingleSourceExecutionPlan {
  return { strategy: "yt-dlp", operation: "keep-original", requestedFormatId: "preset:1080", source: { ...SOURCE }, targetContainer: "mp4" } as GenericSingleSourceExecutionPlan;
}

describe("a stop uses the accepted cancellation mechanisms", () => {
  it(
    "terminates a real child process group, grandchild included",
    { timeout: 15_000, skip: process.platform === "win32" ? "POSIX process groups only" : false },
    async () => {
      const vt = virtualTime();
      const controller = new AbortController();
      const watchdog = createAcquisitionInactivityWatchdog({
        policy: { windowMs: WINDOW },
        clock: vt.clock,
        timers: vt.timers,
        onStall: () => controller.abort(new AppError("TIMEOUT")),
      });
      watchdog.record({ kind: "phase-started", phase: "single" });
      const childSource = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: false });
if (!grandchild.pid) process.exit(2);
process.stdout.write("child=" + process.pid + "\\n");
process.stdout.write("grandchild=" + grandchild.pid + "\\n");
setInterval(() => {}, 1000);
`;
      let seen = "";
      let childPid: number | undefined;
      let grandchildPid: number | undefined;
      try {
        const pending = runProcess({
          command: process.execPath,
          args: ["-e", childSource],
          timeoutMs: 12_000,
          signal: controller.signal,
          onStdout: (text) => {
            seen += text;
            childPid ??= Number(/child=(\d+)/.exec(seen)?.[1]) || undefined;
            grandchildPid ??= Number(/grandchild=(\d+)/.exec(seen)?.[1]) || undefined;
          },
        });
        pending.catch(() => {});
        await waitUntil(() => grandchildPid !== undefined, "the grandchild's pid");
        vt.advance(WINDOW); // no byte at all: the watchdog stops it
        assert.equal(watchdog.report().state, "stopped");
        await assert.rejects(pending, (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED");
        await waitUntil(() => !isAlive(childPid!) && !isAlive(grandchildPid!), "the whole group to be gone");
      } finally {
        for (const pid of [grandchildPid, childPid]) {
          if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
        }
      }
    },
  );

  it("reaches the generic subprocess seam as its caller's abort (why that seam needs LD-3c)", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "ld3b-ytdlp-"));
    cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
    const vt = virtualTime();
    const controller = new AbortController();
    const watchdog = createAcquisitionInactivityWatchdog({
      policy: { windowMs: WINDOW },
      clock: vt.clock,
      timers: vt.timers,
      onStall: () => controller.abort(new AppError("TIMEOUT")),
    });
    let runnerSignal: AbortSignal | undefined;
    const outcome = downloadGenericOriginal("https://example.invalid/watch", workDir, progressivePlan(), {
      limits: { maxFileSizeBytes: 1_000_000_000, downloadTimeLimitMs: 600_000 },
      probeRuntime: async () => RUNTIME_OK,
      validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
      sizePollMs: 1,
      signal: controller.signal,
      activity: watchdog.record,
      runner: async (call: { signal?: AbortSignal }): Promise<RunResult> => {
        runnerSignal = call.signal;
        writeFileSync(expectedPartPath(workDir, "mp4"), chunk(70_000));
        await new Promise<void>((resolve) => call.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
      },
    } as unknown as Parameters<typeof downloadGenericOriginal>[3]);
    outcome.catch(() => {});
    await waitUntil(() => watchdog.snapshot().observedBytes === 70_000, "the monitor's first sample");
    vt.advance(WINDOW);
    await assert.rejects(outcome);
    assert.equal(runnerSignal?.aborted, true, "the child's signal was aborted");
    assert.equal(watchdog.report().state, "stopped");
    // The seam records its CALLER's abort: it has no inactivity cause of its own yet.
    assert.equal(watchdog.snapshot().outcome, "cancelled");
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Structural pins ──────────────────────────────────────────────────────────

const ROOT = new URL("../../../", import.meta.url);
const source = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");
/** Code only: block and line comments removed (a `//` inside a URL string is kept). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001: LD-3b pinned enforcement as
// deliberately DISCONNECTED here. This change connects it, so the first two
// pins are inverted; the rest of the block is unchanged.
describe("enforcement is connected in Production, and nothing else moved", () => {
  it("the composition root supplies the enforcement — and still builds no watchdog and names no observer sink", () => {
    const runtime = code(source("src/worker/runtime/runtime.server.ts"));
    assert.match(runtime, /policy: Object\.freeze\(\{ windowMs: timeLimits\.inactivityMs \}\)/);
    assert.match(runtime, /watchFilesystemObservedPlans: true/);
    assert.match(runtime, /\n\s*acquisitionInactivity,\n\s*timeLimits,\n/);
    // It hands the executor a policy; the executor alone builds one watchdog per acquisition.
    assert.equal(runtime.includes("acquisition-inactivity-watchdog"), false);
    assert.equal(runtime.includes("createAcquisitionInactivityWatchdog"), false);
    assert.equal(runtime.includes("createAcquisitionActivitySink"), false);
  });

  it("the strict configuration owns the window — the loader, the model and the composition root — and the lax loader never reads it", () => {
    assert.equal(code(source("src/worker/runtime/config.server.ts")).includes("DOWNLOAD_INACTIVITY_TIMEOUT"), true);
    assert.match(code(source("src/worker/runtime/time-limits.ts")), /\binactivityMs\b/);
    assert.match(code(source("src/worker/runtime/runtime.server.ts")), /timeLimits\.inactivityMs/);
    assert.equal(code(source("src/lib/config.ts")).includes("DOWNLOAD_INACTIVITY_TIMEOUT"), false);
    assert.equal(/\binactivityMs\b/.test(code(source("src/lib/config.ts"))), false);
    // Positive controls for the comment stripper.
    assert.equal(code("// DOWNLOAD_INACTIVITY_TIMEOUT\nconst x = 1;").includes("DOWNLOAD_INACTIVITY_TIMEOUT"), false);
    assert.equal(code('const u = "https://a.invalid/x";').includes("https://a.invalid/x"), true);
  });

  it("the existing stage defaults are unchanged: 600 s acquisition and processing, 3,600 s upload, 45 min retention", () => {
    assert.equal(DOWNLOAD_TIME_LIMIT_SECONDS.default, 600);
    assert.equal(PROCESSING_TIMEOUT_SECONDS.default, 600);
    assert.equal(UPLOAD_TIMEOUT_SECONDS.default, 3_600);
    assert.equal(FILE_EXPIRATION_MINUTES_RANGE.default, 45);
  });

  it("the watched plans are exactly the three transport-observed ones", () => {
    const executor = source("src/worker/execution/job-executor.server.ts");
    const body = /function isInactivityWatchedPlan\(plan: ExecutionPlan\): boolean \{([\s\S]*?)\n\}/.exec(executor)?.[1];
    assert.ok(body, "the allowlist function exists");
    const operations = [...body.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(operations, ["clear-hls-remux", "clear-hls-separate-audio-remux", "direct"]);
  });

  it("the core imports nothing but the LD-3a model", () => {
    const core = source("src/services/downloads/acquisition-inactivity-watchdog.ts");
    const specifiers = [...core.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    assert.deepEqual(specifiers, ["@/services/downloads/acquisition-activity"]);
  });

  it("the public job view still has no activity field: a view carrying one is refused", () => {
    const h = harness();
    const job = h.claim();
    const view = h.store.getJob(job.jobId)!;
    assert.deepEqual(Object.keys(view).sort(), [
      "container", "createdAt", "downloadedBytes", "errorCode", "eta", "expiresAt", "extractor", "fileSize", "filename",
      "jobId", "mime", "objectKey", "progress", "quality", "safeErrorMessage", "source", "speed", "stageLabel", "status",
      "thumbnail", "title", "totalBytes", "updatedAt",
    ]);
    assert.equal(WorkerJobViewSchema.safeParse({ ...view, activity: { state: "receiving" } }).success, false);
    assert.equal(WorkerJobViewSchema.safeParse(view).success, true, "positive control: the same view without it parses");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001
//
// The executor under the enforcement EXACTLY as Production now composes it
// (`runtime.server.ts`: the configured window, the reviewed defaults, the
// filesystem-observed plans opted in, no observer sink), on virtual time. The
// real runtime itself is exercised in `inactivity-runtime-activation.server.test.ts`.
// ═════════════════════════════════════════════════════════════════════════════

const productionEnforcement = (vt: ReturnType<typeof virtualTime>) => ({
  policy: { windowMs: WINDOW },
  watchFilesystemObservedPlans: true,
  clock: vt.clock,
  timers: vt.timers,
});

const M4A_PLAN = GenericExecutionPlanSchema.parse({
  strategy: "yt-dlp",
  operation: "extract-m4a",
  requestedFormatId: "preset:audio",
  source: SOURCE,
  targetContainer: "m4a",
});
const MP3_PLAN = GenericExecutionPlanSchema.parse({
  strategy: "yt-dlp",
  operation: "extract-mp3",
  requestedFormatId: "preset:mp3",
  source: SOURCE,
  targetContainer: "mp3",
});
const DASH_SPLIT_PLAN = GenericExecutionPlanSchema.parse({
  strategy: "yt-dlp",
  operation: "merge-split",
  requestedFormatId: "preset:1080",
  pair: {
    video: { ...SOURCE, formatId: "137", protocol: "http_dash_segments", hasAudio: false, audioConstraint: "absent" },
    audio: { ...SOURCE, formatId: "140", protocol: "http_dash_segments", container: "m4a", hasVideo: false, videoConstraint: "absent" },
  },
  targetContainer: "mp4",
});

/**
 * Every acquisition seam as a quick, successful fake that records what it was handed. Each reports a real
 * phase to the sink it receives — deadline, phase start, bytes, phase end — so the watchdog arms its timer and a
 * missing release is visible the moment the acquisition settles.
 */
function recordingSeams(handed: Array<Record<string, unknown>>): Partial<JobExecutorDeps> {
  const keep = (ctx: object) => {
    handed.push({ ...ctx });
    const sink = (ctx as { activity?: AcquisitionActivitySink }).activity;
    sink?.({ kind: "deadline-armed", limitMs: 600_000 });
    sink?.({ kind: "phase-started", phase: "single" });
    sink?.({ kind: "bytes", totalBytes: 2 * G, evidence: "transport" });
    sink?.({ kind: "phase-ended" });
  };
  return {
    downloadOriginal: async (_url, ctx) => {
      keep(ctx);
      const filePath = join(ctx.workDir, "source.mp4");
      writeFileSync(filePath, "direct-media");
      return { filePath, container: "mp4", mime: "video/mp4", fileSize: 12 };
    },
    downloadGeneric: async (_url, workDir, _plan, ctx) => {
      keep(ctx);
      const filePath = join(workDir, "source.mp4");
      writeFileSync(filePath, "generic-media");
      return { filePath, container: "mp4", mime: "video/mp4", fileSize: 13 };
    },
    downloadGenericSplit: async (_url, workDir, plan, ctx) => {
      keep(ctx);
      const video = join(workDir, `video-source.${plan.pair.video.container}`);
      const audio = join(workDir, `audio-source.${plan.pair.audio.container}`);
      writeFileSync(video, "video");
      writeFileSync(audio, "audio");
      return {
        video: { filePath: video, container: plan.pair.video.container, fileSize: 5 },
        audio: { filePath: audio, container: plan.pair.audio.container, fileSize: 5 },
        totalFileSize: 10,
      };
    },
    acquireClearHls: async (_plan, workDir, ctx) => {
      keep(ctx);
      const filePath = join(workDir, "hls.ts");
      writeFileSync(filePath, "transport-stream");
      return Object.freeze({ filePath, segmentType: "mpegts", fileSize: 16 }) as never;
    },
    acquireSeparateHls: async (_plan, workDir, ctx) => {
      keep(ctx);
      const v = join(workDir, "hls-video.fmp4");
      const a = join(workDir, "hls-audio.fmp4");
      writeFileSync(v, "video");
      writeFileSync(a, "audio");
      return Object.freeze({
        video: Object.freeze({ filePath: v, segmentType: "fmp4", fileSize: 5 }),
        audio: Object.freeze({ filePath: a, segmentType: "fmp4", fileSize: 5 }),
        totalFileSize: 10,
      }) as never;
    },
    processLocally: async (opts) => {
      const out = join(opts.workDir, `converted.${opts.target}`);
      writeFileSync(out, "converted");
      return out;
    },
    mergeSplit: async (opts) => {
      const out = join(opts.workDir, `merged.${opts.target}`);
      writeFileSync(out, "merged");
      return out;
    },
  };
}

describe("LD-3 activation: under Production's enforcement every acquisition family gets exactly one watchdog", () => {
  const FAMILIES: ReadonlyArray<{
    label: string;
    formatId: WorkerRequestedFormatId;
    deps: Partial<JobExecutorDeps>;
    ytdlp: boolean;
  }> = [
    { label: "direct keep-original", formatId: "direct-original", deps: { analyze: async () => directMeta() }, ytdlp: false },
    { label: "direct convert (MP3)", formatId: "preset:mp3", deps: { analyze: async () => directMeta(true) }, ytdlp: false },
    { label: "clear HLS", formatId: "preset:1080", deps: hlsDeps({ derivePlanForExecution: () => yt(HLS_PLAN) }), ytdlp: false },
    { label: "separate-audio HLS", formatId: "preset:1080", deps: hlsDeps({ derivePlanForExecution: () => yt(SEPARATE_PLAN) }), ytdlp: false },
    { label: "yt-dlp progressive keep-original", formatId: "preset:1080", deps: { analyzeForExecution: async () => GENERIC_ANALYSIS, derivePlanForExecution: () => yt(SINGLE_PLAN) }, ytdlp: true },
    { label: "yt-dlp extract-m4a", formatId: "preset:audio", deps: { analyzeForExecution: async () => GENERIC_ANALYSIS, derivePlanForExecution: () => yt(M4A_PLAN) }, ytdlp: true },
    { label: "yt-dlp extract-mp3", formatId: "preset:mp3", deps: { analyzeForExecution: async () => GENERIC_ANALYSIS, derivePlanForExecution: () => yt(MP3_PLAN) }, ytdlp: true },
    { label: "yt-dlp split pair (progressive halves)", formatId: "preset:1080", deps: { analyzeForExecution: async () => GENERIC_ANALYSIS, derivePlanForExecution: () => yt(SPLIT_PLAN) }, ytdlp: true },
    { label: "yt-dlp split pair (segmented DASH halves)", formatId: "preset:1080", deps: { analyzeForExecution: async () => GENERIC_ANALYSIS, derivePlanForExecution: () => yt(DASH_SPLIT_PLAN) }, ytdlp: true },
  ];

  for (const family of FAMILIES) {
    it(`${family.label}: one watchdog sink${family.ytdlp ? ", both stops (the watched retry policy)" : ", no yt-dlp stop"}, released on completion`, async () => {
      const h = harness();
      const vt = virtualTime();
      const handed: Array<Record<string, unknown>> = [];
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
        availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
        ...recordingSeams(handed),
        ...family.deps,
        acquisitionInactivity: productionEnforcement(vt),
      });
      const job = h.claim(family.formatId, "https://example.invalid/watch");
      await executor.execute(job);
      // Read before any virtual time passes: the watchdog armed a timer, and only its release removes it.
      assert.equal(vt.pendingCount(), 0, "the watchdog was released the moment the acquisition settled");
      assert.equal(h.store.getJob(job.jobId)!.status, "ready", family.label);
      assert.equal(handed.length, 1, "one acquisition");
      const ctx = handed[0]!;
      assert.equal(typeof ctx.activity, "function", "the watchdog's own sink");
      if (family.ytdlp) {
        assert.ok(ctx.stopForInactivity instanceof AbortSignal);
        assert.ok(ctx.stopForObservationLoss instanceof AbortSignal);
        assert.equal(selectYtdlpAcquisitionRetryPolicy(ctx as never), "watched");
        assert.deepEqual({ ...(ctx.limits as object) }, { maxFileSizeBytes: Number((ctx.limits as { maxFileSizeBytes: number }).maxFileSizeBytes), downloadTimeLimitMs: 600_000 });
      } else {
        assert.equal("stopForInactivity" in ctx || "stopForObservationLoss" in ctx, false, "transport paths never get a yt-dlp stop");
        assert.equal("limits" in ctx, false, "nor yt-dlp limits");
        assert.equal(ctx.downloadTimeLimitMs, 600_000, "the one absolute limit");
      }
      assert.equal(vt.pendingCount(), 0, "no watchdog timer outlives the acquisition");
      assert.deepEqual(h.failJobCalls, []);
    });
  }

  it("a bare executor — the only way to have none — watches nothing and selects the bounded policy", async () => {
    const h = harness();
    const handed: Array<Record<string, unknown>> = [];
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      ...recordingSeams(handed),
      analyzeForExecution: async () => GENERIC_ANALYSIS,
      derivePlanForExecution: () => yt(SINGLE_PLAN),
    });
    assert.equal(executor.inactivityEnforcement, null);
    await executor.execute(h.claim("preset:1080", "https://example.invalid/watch"));
    assert.deepEqual(Object.keys(handed[0]!).sort(), ["limits", "onProgress", "signal"]);
    assert.equal(selectYtdlpAcquisitionRetryPolicy(handed[0] as never), "bounded");
  });
});

describe("LD-3 activation: the real HLS transports' own deadline is 'Download time limit reached'", () => {
  /** A narrower injected acquisition limit, so the transports' REAL timers fire within the test. */
  const narrow = { downloadTimeLimitMs: 40, processingMs: 600_000, uploadMs: 3_600_000 };

  for (const [label, preflight] of [
    ["MPEG-TS", () => hlsTsPlan([F1])],
    ["fMP4", () => hlsFmp4Plan(INIT, [F1])],
  ] as const) {
    it(`clear HLS ${label}: a body still open at the deadline ends as the time limit, never a stall`, async () => {
      const h = harness();
      const vt = virtualTime();
      const body = manualBody();
      fakeHlsNetwork({ [INIT]: () => chunkedBody([chunk(100)]), [F1]: () => body.stream });
      const o = observer();
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps({
        derivePlanForExecution: () => yt(HLS_PLAN),
        acquireClearHls: (plan, workDir, ctx) =>
          acquireSelectedClearHlsMedia(
            { plan, workDir, signal: ctx.signal, downloadTimeLimitMs: ctx.downloadTimeLimitMs, ...(ctx.activity ? { activity: ctx.activity } : {}) },
            { preflight: async () => preflight(), acquire: acquireClearHlsTs, acquireFmp4: acquireClearHlsFmp4 },
          ),
        timeLimits: narrow,
        acquisitionInactivity: productionEnforcement(vt),
        createAcquisitionActivitySink: o.factory,
      }));
      const job = h.claim("preset:1080", "https://example.invalid/watch");
      await executor.execute(job);
      failedAsTimeout(h.store.getJob(job.jobId), TIME_LIMIT);
      assert.deepEqual(o.settled(), ["deadline-exceeded"], "the transport's own latch: its deadline, first");
      assert.equal(body.stream.destroyed, true);
      assert.equal(h.puts.length, 0);
      assert.equal(vt.pendingCount(), 0);
    });
  }

  it("separate-audio HLS: the ONE shared deadline ending the video half is the time limit too", async () => {
    const h = harness();
    const vt = virtualTime();
    const videoSeg = manualBody();
    fakeHlsNetwork({
      [VIDEO_INIT]: () => chunkedBody([chunk(100)]),
      [VIDEO_SEG]: () => videoSeg.stream,
      [AUDIO_INIT]: () => chunkedBody([chunk(50)]),
      [AUDIO_SEG]: () => chunkedBody([chunk(50)]),
    });
    let preflights = 0;
    const o = observer();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps({
      derivePlanForExecution: () => yt(SEPARATE_PLAN),
      acquireSeparateHls: (plan, workDir, ctx) =>
        acquireSelectedSeparateHlsMedia(
          { plan, workDir, signal: ctx.signal, downloadTimeLimitMs: ctx.downloadTimeLimitMs, ...(ctx.activity ? { activity: ctx.activity } : {}) },
          {
            preflight: async () => {
              preflights += 1;
              return preflights === 1 ? hlsFmp4Plan(VIDEO_INIT, [VIDEO_SEG]) : hlsFmp4Plan(AUDIO_INIT, [AUDIO_SEG]);
            },
            acquireVideo: acquireClearHlsSeparateVideoFmp4,
            acquireAudio: acquireClearHlsSeparateAudioFmp4,
          } as Parameters<typeof acquireSelectedSeparateHlsMedia>[1],
        ),
      timeLimits: narrow,
      acquisitionInactivity: productionEnforcement(vt),
      createAcquisitionActivitySink: o.factory,
    }));
    const job = h.claim("preset:1080", "https://example.invalid/watch");
    await executor.execute(job);
    failedAsTimeout(h.store.getJob(job.jobId), TIME_LIMIT);
    assert.deepEqual(o.settled(), ["deadline-exceeded"]);
    assert.equal(h.jobDirExists(job.jobId), false);
  });
});

/** A direct seam under full test control: it reports what the test says and settles when told. */
function scriptedDirectSeam() {
  let sink: AcquisitionActivitySink | undefined;
  let signal: AbortSignal | undefined;
  let settle!: (outcome: "deadline-exceeded" | "cancelled" | "failed", err: unknown) => void;
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => {
    started = resolve;
  });
  const seam = ((_url: string, ctx: { activity?: AcquisitionActivitySink; signal?: AbortSignal; downloadTimeLimitMs: number }) =>
    new Promise((_resolve, reject) => {
      sink = ctx.activity;
      signal = ctx.signal;
      settle = (outcome, err) => {
        sink?.({ kind: "settled", outcome });
        reject(err);
      };
      started();
    })) as unknown as JobExecutorDeps["downloadOriginal"];
  return {
    seam,
    started: startedP,
    report: (event: AcquisitionActivityEvent) => sink?.(event),
    settle: (outcome: "deadline-exceeded" | "cancelled" | "failed", err: unknown) => settle(outcome, err),
    aborted: () => signal?.aborted === true,
  };
}

describe("LD-3 activation: precedence between the stall and the absolute deadline", () => {
  function directExecutor(h: ReturnType<typeof harness>, vt: ReturnType<typeof virtualTime>, seam: JobExecutorDeps["downloadOriginal"], extra: Partial<JobExecutorDeps> = {}) {
    return new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      downloadOriginal: seam,
      acquisitionInactivity: productionEnforcement(vt),
      ...extra,
    });
  }

  it("the seam latched its deadline FIRST and the stop landed before it settled: the time limit is the outcome, never relabelled", async () => {
    const h = harness();
    const vt = virtualTime();
    const s = scriptedDirectSeam();
    const job = h.claim();
    const done = directExecutor(h, vt, s.seam).execute(job);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: 600_000 });
    s.report({ kind: "phase-started", phase: "single" });
    s.report({ kind: "bytes", totalBytes: 2 * G, evidence: "transport" });
    // The deadline fires inside the seam (its one-way latch records it) ...
    vt.advance(WINDOW); // ... and a watchdog tick lands before the seam's settlement: a nearby timer.
    assert.equal(s.aborted(), true, "the watchdog did stop the execution");
    s.settle("deadline-exceeded", new AppError("TIMEOUT"));
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), TIME_LIMIT);
    assert.deepEqual(h.failJobStops, ["time-limit"]);
  });

  it("the stop landed FIRST and the seam then saw its caller's abort: the stall is the outcome", async () => {
    const h = harness();
    const vt = virtualTime();
    const s = scriptedDirectSeam();
    const job = h.claim();
    const done = directExecutor(h, vt, s.seam).execute(job);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: 600_000 });
    s.report({ kind: "phase-started", phase: "single" });
    vt.advance(WINDOW);
    s.settle("cancelled", new AppError("PROCESSING_FAILED", "aborted"));
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
    assert.deepEqual(h.failJobStops, ["inactivity"]);
  });

  it("a tick one millisecond before the deadline, with the window spent: the stall came first", async () => {
    const h = harness();
    const vt = virtualTime();
    const s = scriptedDirectSeam();
    const job = h.claim();
    const done = directExecutor(h, vt, s.seam).execute(job);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: WINDOW + 1 });
    s.report({ kind: "phase-started", phase: "single" });
    vt.advance(WINDOW);
    assert.equal(s.aborted(), true, "stopped at the window, 1 ms before the deadline");
    s.settle("cancelled", new AppError("PROCESSING_FAILED", "aborted"));
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
  });

  it("the deadline and the window at the SAME instant: the watchdog defers, and the time limit is the outcome", async () => {
    const h = harness();
    const vt = virtualTime();
    const s = scriptedDirectSeam();
    const job = h.claim();
    const done = directExecutor(h, vt, s.seam).execute(job);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: WINDOW });
    s.report({ kind: "phase-started", phase: "single" });
    vt.advance(WINDOW);
    assert.equal(s.aborted(), false, "the watchdog deferred to the time limit");
    assert.equal(vt.pendingCount(), 0, "and released its timer");
    s.settle("deadline-exceeded", new AppError("TIMEOUT"));
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), TIME_LIMIT);
  });

  it("a second deadline report can never move the absolute deadline: the watchdog still defers at the first one", async () => {
    const h = harness();
    const vt = virtualTime();
    const s = scriptedDirectSeam();
    const job = h.claim();
    const done = directExecutor(h, vt, s.seam).execute(job);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: WINDOW });
    s.report({ kind: "phase-started", phase: "single" });
    vt.advance(WINDOW / 2);
    // A later report — as each half of a separate-audio pair makes — of a longer limit.
    s.report({ kind: "deadline-armed", limitMs: 600_000 });
    vt.advance(WINDOW / 2);
    assert.equal(s.aborted(), false, "at the FIRST deadline the watchdog defers: it was never moved");
    assert.equal(vt.pendingCount(), 0, "and released its timer there");
    s.settle("deadline-exceeded", new AppError("TIMEOUT"));
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), TIME_LIMIT);
  });

  it("a TIMEOUT after a successful watched acquisition (processing) keeps its own stage: never an acquisition stop", async () => {
    const h = harness();
    const vt = virtualTime();
    const executor = directExecutor(h, vt, recordingSeams([]).downloadOriginal, {
      processLocally: async () => {
        throw new AppError("TIMEOUT");
      },
      analyze: async () => directMeta(true),
    });
    const job = h.claim("preset:mp3");
    await executor.execute(job);
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.errorCode, "TIMEOUT");
    assert.equal(view.stageLabel, "Processing failed", "a processing timeout is never an acquisition stop");
    assert.deepEqual(h.failJobStops, [undefined]);
  });

  it("the execution-lifetime backstop during a watched acquisition is TIMEOUT at the download stage, never a reserved stage", async () => {
    const h = harness();
    const vt = virtualTime();
    const backstop = virtualTime();
    const s = scriptedDirectSeam();
    const job = h.claim();
    const done = directExecutor(h, vt, s.seam, { backstopTimers: backstop.timers }).execute(job);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: 600_000 });
    s.report({ kind: "phase-started", phase: "single" });
    backstop.advance(job.expiresAt - Date.now() + 1_000); // the job's own lifetime ends
    assert.equal(s.aborted(), true);
    s.settle("cancelled", new AppError("PROCESSING_FAILED", "aborted"));
    await done;
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.errorCode, "TIMEOUT");
    assert.equal(view.stageLabel, "Download failed");
    assert.deepEqual(h.failJobStops, [undefined]);
    vt.advance(10 * WINDOW);
    assert.equal(vt.pendingCount(), 0, "the watchdog was released with the acquisition");
  });
});

describe("LD-3 activation: timing under Production's 120 s window", () => {
  function started(vt: ReturnType<typeof virtualTime>) {
    const h = harness();
    const s = scriptedDirectSeam();
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyze: async () => directMeta(),
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      downloadOriginal: s.seam,
      acquisitionInactivity: productionEnforcement(vt),
    });
    const job = h.claim();
    const done = executor.execute(job);
    return { h, s, job, done };
  }

  it("never early: the stop lands at the first tick at or after 120 s of silence", async () => {
    const vt = virtualTime();
    const { h, s, job, done } = started(vt);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: 600_000 });
    s.report({ kind: "phase-started", phase: "single" });
    vt.advance(WINDOW - 1);
    assert.equal(s.aborted(), false, "119.999 s: not yet");
    vt.advance(1);
    assert.equal(s.aborted(), true, "120 s: stopped");
    s.settle("cancelled", new AppError("PROCESSING_FAILED", "aborted"));
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
  });

  it("no first byte at all is a stall too, one window after the phase began", async () => {
    const vt = virtualTime();
    const { h, s, job, done } = started(vt);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: 600_000 });
    s.report({ kind: "phase-started", phase: "single" });
    vt.advance(WINDOW);
    s.settle("cancelled", new AppError("PROCESSING_FAILED", "aborted"));
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
  });

  it("a suspended process is not a stalled source: one fresh window from the resume, then a stall on visible silence", async () => {
    const vt = virtualTime();
    const { h, s, job, done } = started(vt);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: 3_600_000 });
    s.report({ kind: "phase-started", phase: "single" });
    s.report({ kind: "bytes", totalBytes: 2 * G, evidence: "transport" });
    vt.advance(60_000); // a minute of visible silence
    vt.jump(10 * 60_000); // the VM froze for ten minutes: no tick ran
    vt.advance(0); // the late tick sees the gap: a suspension
    assert.equal(s.aborted(), false, "the frozen time is never inactivity");
    vt.advance(WINDOW - 1_000);
    assert.equal(s.aborted(), false, "a fresh window from the resume");
    vt.advance(1_000);
    assert.equal(s.aborted(), true, "and visible silence for that window stops it");
    s.settle("cancelled", new AppError("PROCESSING_FAILED", "aborted"));
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), STALLED);
  });

  it("meaningful progress can never extend the absolute deadline: past it the watchdog stops deciding and releases its timer", async () => {
    const vt = virtualTime();
    const { h, s, job, done } = started(vt);
    await s.started;
    s.report({ kind: "deadline-armed", limitMs: 600_000 });
    s.report({ kind: "phase-started", phase: "single" });
    let bytes = 0;
    for (let minute = 1; minute <= 9; minute += 1) {
      bytes += 2 * G;
      s.report({ kind: "bytes", totalBytes: bytes, evidence: "transport" });
      vt.advance(60_000);
    }
    assert.equal(s.aborted(), false, "steady meaningful progress is never stopped");
    vt.advance(60_000); // the 600 s deadline passes; the seam has not reported yet
    assert.equal(vt.pendingCount(), 0, "no window is ever re-armed past the absolute deadline");
    vt.advance(10 * WINDOW);
    assert.equal(s.aborted(), false, "and nothing the watchdog does replaces the seam's own deadline");
    s.settle("deadline-exceeded", new AppError("TIMEOUT"));
    await done;
    failedAsTimeout(h.store.getJob(job.jobId), TIME_LIMIT);
  });
});

describe("LD-3 activation: separate-audio — a deadline that passes BETWEEN the halves is still the time limit", () => {
  it("a video half ending in the shared deadline's last instant leaves the audio half nothing: Download time limit reached", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    let audioStarted = 0;
    let preflights = 0;
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), hlsDeps({
      derivePlanForExecution: () => yt(SEPARATE_PLAN),
      acquireSeparateHls: (plan, workDir, ctx) =>
        acquireSelectedSeparateHlsMedia(
          { plan, workDir, signal: ctx.signal, downloadTimeLimitMs: ctx.downloadTimeLimitMs, ...(ctx.activity ? { activity: ctx.activity } : {}) },
          {
            preflight: async () => {
              preflights += 1;
              return preflights === 1 ? hlsFmp4Plan(VIDEO_INIT, [VIDEO_SEG]) : hlsFmp4Plan(AUDIO_INIT, [AUDIO_SEG]);
            },
            // A video half that completes only after the ONE deadline has run out.
            acquireVideo: async (order: { workDir: string; activity?: AcquisitionActivitySink }) => {
              order.activity?.({ kind: "phase-started", phase: "video" });
              await new Promise((resolve) => setTimeout(resolve, 60));
              const filePath = join(order.workDir, "hls-video.fmp4");
              writeFileSync(filePath, chunk(100));
              order.activity?.({ kind: "bytes", totalBytes: 100, evidence: "transport" });
              order.activity?.({ kind: "phase-ended" });
              return Object.freeze({ filePath, segmentType: "fmp4", fileSize: 100 });
            },
            acquireAudio: async () => {
              audioStarted += 1;
              throw new Error("the audio half must not start");
            },
          } as unknown as Parameters<typeof acquireSelectedSeparateHlsMedia>[1],
        ),
      // A 20 ms shared deadline, so the real clock passes it inside the video half.
      timeLimits: { downloadTimeLimitMs: 20, processingMs: 600_000, uploadMs: 3_600_000 },
      acquisitionInactivity: productionEnforcement(vt),
      createAcquisitionActivitySink: o.factory,
    }));
    const job = h.claim("preset:1080", "https://example.invalid/watch");
    await executor.execute(job);
    failedAsTimeout(h.store.getJob(job.jobId), TIME_LIMIT);
    assert.deepEqual(o.settled(), ["deadline-exceeded"], "the seam recorded its deadline at the boundary");
    assert.equal(audioStarted, 0);
    assert.equal(h.jobDirExists(job.jobId), false);
  });
});
