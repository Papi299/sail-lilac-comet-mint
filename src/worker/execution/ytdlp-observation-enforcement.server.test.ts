import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import type { AcquisitionActivityEvent } from "@/services/downloads/acquisition-activity";
import type { InactivityWatchdogTimerHandle, InactivityWatchdogTimers } from "@/services/downloads/acquisition-inactivity-watchdog";
import type { RunResult } from "@/services/processing/process-runner.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema, type WorkerRequestedFormatId } from "@/shared/worker/contracts";
import { WORKER_ERROR_CODES } from "@/shared/worker/errors";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import { YTDLP_RUNTIME } from "../runtime/ytdlp-runtime.server.ts";
import type { DurableWorkerJob } from "../state/job-store.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type { ObjectStorePutInput, ObjectStoreWriter } from "../storage/writer.ts";
import { GenericExecutionPlanSchema, type ExecutionPlan } from "./format-plan.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";
import {
  downloadGenericOriginal,
  downloadGenericSplitSources,
  expectedPartPath,
  expectedSourcePath,
  expectedSplitSourcePath,
  type GenericDownloadDeps,
} from "./ytdlp-download.server.ts";

/**
 * VIDEOFETCH-LD3C-YTDLP-OBSERVATION-HARDENING-001 — enforcement of the
 * filesystem-observed (yt-dlp) plans through the REAL executor, the REAL
 * yt-dlp seam and its real monitor, against a real SQLite store. Only the
 * child is replaced (it changes real files in the real job directory), and only
 * the watchdog's clock and timers are virtual: a window passes when the test
 * says so, and real waits only let real I/O catch up (bounded at 10 s).
 *
 * Enforcement and its LD-3c opt-in are supplied here by injection only.
 * Production supplies neither: the structural block at the end pins that.
 */

const WINDOW = 120_000;
const G = 65_536;
const RUNTIME_OK = Object.freeze({ available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" as const });
const EXIT_OK: RunResult = { code: 0, stdout: "", stderr: "" };

function virtualTime(startMs = 11_000_000) {
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

const enforcement = (vt: ReturnType<typeof virtualTime>, optIn = true) => ({
  policy: { windowMs: WINDOW },
  clock: vt.clock,
  timers: vt.timers,
  ...(optIn ? { watchFilesystemObservedPlans: true } : {}),
});

let eventLoopHold: ReturnType<typeof setTimeout> | null = null;
const cleanups: Array<() => void> = [];
/**
 * Assertions that failed INSIDE a fake child. The seam reports such a child as a
 * failed run, so `execute` re-raises the assertion as itself.
 */
const childAssertions: unknown[] = [];

beforeEach(() => {
  childAssertions.length = 0;
  eventLoopHold = setTimeout(() => {}, 60_000);
});

/** Runs one job; an assertion that failed inside its fake child is re-raised as itself. */
async function execute(executor: JobExecutor, job: DurableWorkerJob): Promise<void> {
  await executor.execute(job);
  if (childAssertions.length > 0) throw childAssertions[0];
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  if (eventLoopHold !== null) clearTimeout(eventLoopHold);
  eventLoopHold = null;
});

function harness() {
  const tempDir = mkdtempSync(join(tmpdir(), "ld3c-enforce-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const store = new SQLiteJobStore({ db });
  const puts: ObjectStorePutInput[] = [];
  const failJobCalls: string[] = [];
  const transitions: string[] = [];
  const realFailJob = store.failJob.bind(store);
  store.failJob = (jobId: string, code: string, message: string) => {
    failJobCalls.push(code);
    return realFailJob(jobId, code, message);
  };
  const realBeginProcessing = store.beginProcessing.bind(store);
  store.beginProcessing = (jobId: string) => {
    transitions.push("processing");
    return realBeginProcessing(jobId);
  };
  const realBeginUploading = store.beginUploading.bind(store);
  store.beginUploading = (jobId: string) => {
    transitions.push("uploading");
    return realBeginUploading(jobId);
  };
  const writer: ObjectStoreWriter = {
    async put(input) {
      puts.push(input);
      for await (const piece of input.body) void piece;
    },
    async head(key) {
      const last = puts.find((p) => p.objectKey === key);
      return last
        ? { objectKey: last.objectKey, contentLength: last.contentLength, contentType: last.contentType, contentDisposition: last.contentDisposition }
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
    store,
    puts,
    writer,
    failJobCalls,
    transitions,
    claim(formatId: WorkerRequestedFormatId = "preset:1080"): DurableWorkerJob {
      store.createJob({ url: "https://example.invalid/watch", formatId, principalId: "private-access-user" }, randomUUID());
      const job = store.claimNextQueuedJob();
      assert.ok(job);
      return job;
    },
  };
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
const SINGLE_PLAN = GenericExecutionPlanSchema.parse({ strategy: "yt-dlp", operation: "keep-original", requestedFormatId: "preset:1080", source: SOURCE, targetContainer: "mp4" });
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
const yt = (generic: unknown): ExecutionPlan => ({ strategy: "yt-dlp", generic }) as ExecutionPlan;

const chunk = (size: number) => Buffer.alloc(size, 0x5a);

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 10_000) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function observer() {
  const events: AcquisitionActivityEvent[] = [];
  return {
    events,
    factory: () => (event: AcquisitionActivityEvent) => {
      events.push(event);
    },
    count: (kind: AcquisitionActivityEvent["kind"]) => events.filter((e) => e.kind === kind).length,
    settled: () => events.flatMap((e) => (e.kind === "settled" ? [e.outcome] : [])),
  };
}

/**
 * A fake child that holds until the operation's own signal aborts, then rejects
 * as the real runner does. BOUNDED: with no abort within 5 s it exits non-zero
 * instead, so a defect that suppresses an abort fails the outcome assertions,
 * never by a test-runner timeout.
 */
const untilAborted = (call: { signal?: AbortSignal }, onAbort?: () => void) =>
  new Promise<RunResult>((resolve, reject) => {
    const fail = () => {
      clearTimeout(timer);
      onAbort?.();
      reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
    };
    const timer = setTimeout(() => {
      call.signal?.removeEventListener("abort", fail);
      resolve({ code: 97, stdout: "", stderr: "" });
    }, 5_000);
    if (call.signal?.aborted) fail();
    else call.signal?.addEventListener("abort", fail, { once: true });
  });

type Runner = (call: { args: readonly string[]; signal?: AbortSignal }) => Promise<RunResult>;

/** The job directory the seam was given, read from the child's own `--output` argument. */
const workDirOf = (call: { args: readonly string[] }) =>
  call.args.find((a) => a.startsWith("--output="))!.slice("--output=".length).replace(/\/[a-z-]+\.%\(ext\)s$/, "");

/**
 * The executor's two yt-dlp seams, bound to the REAL acquisition functions with
 * only the child (and, where a test needs it, the file observation) replaced.
 * They forward the context exactly as the production defaults do, and record
 * what they were handed.
 */
function realYtdlpSeams(runner: Runner, extra: Partial<GenericDownloadDeps> = {}) {
  const handed: Array<Record<string, unknown>> = [];
  const child: Runner = async (call) => {
    try {
      return await runner(call);
    } catch (err: unknown) {
      if (err instanceof assert.AssertionError) childAssertions.push(err);
      throw err;
    }
  };
  const common = (ctx: Record<string, unknown>) => {
    handed.push(ctx);
    return {
      limits: ctx.limits,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      ...(ctx.activity ? { activity: ctx.activity } : {}),
      ...(ctx.stopForInactivity ? { stopForInactivity: ctx.stopForInactivity } : {}),
      ...(ctx.stopForObservationLoss ? { stopForObservationLoss: ctx.stopForObservationLoss } : {}),
      runner: child,
      probeRuntime: async () => RUNTIME_OK,
      validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
      sizePollMs: 1,
      ...extra,
    } as unknown as GenericDownloadDeps;
  };
  const deps: Partial<JobExecutorDeps> = {
    downloadGeneric: (url, workDir, plan, ctx) =>
      downloadGenericOriginal(url, workDir, plan, common(ctx as unknown as Record<string, unknown>)).then((res) => ({ ...res, mime: "video/mp4" })),
    downloadGenericSplit: (url, workDir, plan, ctx) => downloadGenericSplitSources(url, workDir, plan, common(ctx as unknown as Record<string, unknown>)),
  };
  return { deps, handed };
}

function executorFor(h: ReturnType<typeof harness>, plan: unknown, over: Partial<JobExecutorDeps>, getClock: () => number = () => Date.now()) {
  return new JobExecutor(h.store, h.writer, getClock, new Map(), {
    analyzeForExecution: async () => GENERIC_ANALYSIS,
    derivePlanForExecution: () => yt(plan),
    availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
    ...over,
  });
}

const failedAt = (view: ReturnType<SQLiteJobStore["getJob"]>, code: "TIMEOUT" | "PROCESSING_FAILED") => {
  assert.ok(view);
  assert.equal(view.status, "failed");
  assert.equal(view.errorCode, code);
  assert.equal(view.safeErrorMessage, ERROR_MESSAGES[code]);
  assert.equal(view.stageLabel, "Download failed", "always the download stage");
};

// ── Scope ────────────────────────────────────────────────────────────────────

describe("scope: the filesystem-observed plans are watched only on the explicit opt-in", () => {
  it("enforcement without the opt-in keeps LD-3b's scope: no watchdog, and the yt-dlp seam's context gains no stop", async () => {
    const h = harness();
    const vt = virtualTime();
    const { deps, handed } = realYtdlpSeams(async (call) => {
      writeFileSync(expectedSourcePath(workDirOf(call), "mp4"), chunk(100));
      vt.advance(10 * WINDOW); // a long silence on this path changes nothing
      return EXIT_OK;
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt, false) });
    const job = h.claim();
    await execute(executor, job);
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
    assert.deepEqual(Object.keys(handed[0]!).sort(), ["limits", "onProgress", "signal"]);
    assert.equal(vt.pendingCount(), 0, "no watchdog timer was ever armed");
  });

  it("with the opt-in, a yt-dlp seam receives exactly the two stops beside its LD-3b context", async () => {
    const h = harness();
    const vt = virtualTime();
    const { deps, handed } = realYtdlpSeams(async (call) => {
      writeFileSync(expectedSourcePath(workDirOf(call), "mp4"), chunk(100));
      return EXIT_OK;
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt) });
    await execute(executor, h.claim());
    assert.deepEqual(Object.keys(handed[0]!).sort(), ["activity", "limits", "onProgress", "signal", "stopForInactivity", "stopForObservationLoss"]);
    assert.ok(handed[0]!.stopForInactivity instanceof AbortSignal);
    assert.notEqual(handed[0]!.stopForInactivity, handed[0]!.signal, "a stop is never the caller's own signal");
    assert.equal(vt.pendingCount(), 0, "the watchdog was released when the seam settled");
  });
});

// ── Decisions through the executor ──────────────────────────────────────────

describe("decisions: inactivity is TIMEOUT, observation loss is PROCESSING_FAILED, and neither ever processes", () => {
  it("a readable .part that stops growing is stopped for inactivity: TIMEOUT at the download stage, the seam's own cause, no processing, no upload, never ready", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    let runnerSignal: AbortSignal | undefined;
    const { deps, handed } = realYtdlpSeams(async (call) => {
      runnerSignal = call.signal;
      writeFileSync(expectedPartPath(workDirOf(call), "mp4"), chunk(5 * G));
      await waitUntil(() => o.count("bytes") >= 2, "readings of the stalled .part");
      vt.advance(WINDOW); // a full window of visible readings with no growth
      return untilAborted(call);
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt), createAcquisitionActivitySink: o.factory });
    const job = h.claim();
    await execute(executor, job);
    failedAt(h.store.getJob(job.jobId), "TIMEOUT");
    assert.equal(runnerSignal?.aborted, true, "the child's signal was aborted");
    assert.equal((handed[0]!.stopForInactivity as AbortSignal).aborted, true, "the seam was told the cause");
    assert.equal((handed[0]!.stopForObservationLoss as AbortSignal).aborted, false);
    assert.deepEqual(o.settled(), ["failed"], "the seam's own cause: never a cancellation");
    assert.deepEqual(h.transitions, [], "never processing, never uploading");
    assert.equal(h.puts.length, 0);
    assert.deepEqual(h.failJobCalls, ["TIMEOUT"], "one terminal write");
    assert.equal(vt.pendingCount(), 0);
  });

  it("files unreadable for the whole allowance are an observation loss: PROCESSING_FAILED at the download stage, never TIMEOUT, never a stall", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    const refused = Object.assign(new Error("synthetic EACCES /private/x"), { code: "EACCES" });
    const { deps, handed } = realYtdlpSeams(async (call) => {
      await waitUntil(() => o.count("sample-gap") >= 3, "gaps from the start");
      assert.equal(o.count("bytes"), 0);
      vt.advance(WINDOW + 1_000);
      return untilAborted(call);
    }, {
      statSize: async () => {
        throw refused;
      },
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt), createAcquisitionActivitySink: o.factory });
    const job = h.claim();
    await execute(executor, job);
    failedAt(h.store.getJob(job.jobId), "PROCESSING_FAILED");
    assert.equal((handed[0]!.stopForObservationLoss as AbortSignal).aborted, true);
    assert.equal((handed[0]!.stopForInactivity as AbortSignal).aborted, false, "never a stop for inactivity");
    assert.deepEqual(o.settled(), ["failed"]);
    assert.deepEqual(h.transitions, []);
    assert.equal(h.puts.length, 0);
    assert.deepEqual(h.failJobCalls, ["PROCESSING_FAILED"]);
  });

  it("slow but meaningful growth is never stopped: the job processes, uploads and becomes ready", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    const { deps } = realYtdlpSeams(async (call) => {
      const workDir = workDirOf(call);
      const part = expectedPartPath(workDir, "mp4");
      writeFileSync(part, "");
      for (let minute = 1; minute <= 6; minute += 1) {
        appendFileSync(part, chunk(G)); // one floor's worth per virtual minute
        await waitUntil(() => o.events.some((e) => e.kind === "bytes" && e.totalBytes === minute * G), `reading ${minute}`);
        vt.advance(60_000);
      }
      const readingsBefore = o.count("bytes");
      renameSync(part, expectedSourcePath(workDir, "mp4"));
      await waitUntil(() => o.count("bytes") >= readingsBefore + 2, "the renamed file read");
      return EXIT_OK;
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt), createAcquisitionActivitySink: o.factory });
    const job = h.claim();
    await execute(executor, job);
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
    assert.deepEqual(h.transitions, ["processing", "uploading"]);
    assert.equal(h.puts.length, 1);
    assert.equal(Number(h.puts[0]!.contentLength), 6 * G);
  });

  it("split pair: a stall in the audio half is stopped; the validated video half keeps nothing alive; nothing is merged", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    let merged = 0;
    const { deps } = realYtdlpSeams(async (call) => {
      const workDir = workDirOf(call);
      if (call.args.some((a) => a.includes("audio-source"))) {
        writeFileSync(`${expectedSplitSourcePath(workDir, "audio", "m4a")}.part`, chunk(2 * G));
        await waitUntil(() => o.events.some((e) => e.kind === "bytes" && e.totalBytes === 2 * G), "the audio reading");
        vt.advance(WINDOW);
        return untilAborted(call);
      }
      writeFileSync(expectedSplitSourcePath(workDir, "video", "mp4"), chunk(9 * G));
      await waitUntil(() => o.events.some((e) => e.kind === "bytes" && e.totalBytes === 9 * G), "the video reading");
      vt.advance(30_000);
      return EXIT_OK;
    });
    const executor = executorFor(h, SPLIT_PLAN, {
      ...deps,
      acquisitionInactivity: enforcement(vt),
      createAcquisitionActivitySink: o.factory,
      mergeSplit: async () => {
        merged += 1;
        throw new AppError("PROCESSING_FAILED");
      },
    });
    const job = h.claim();
    await execute(executor, job);
    failedAt(h.store.getJob(job.jobId), "TIMEOUT");
    assert.deepEqual(o.events.flatMap((e) => (e.kind === "phase-started" ? [e.phase] : [])), ["video", "audio"]);
    assert.equal(o.events.filter((e) => e.kind === "deadline-armed").length, 1, "one deadline for both halves");
    assert.equal(merged, 0);
    assert.deepEqual(h.transitions, []);
  });
});

describe("no acquisition result survives a decision", () => {
  it("a seam that ignores an observation-loss stop and returns anyway cannot continue: PROCESSING_FAILED, no processing, no upload", async () => {
    const h = harness();
    const vt = virtualTime();
    let stopSeen: boolean | null = null;
    const executor = executorFor(h, SINGLE_PLAN, {
      acquisitionInactivity: enforcement(vt),
      downloadGeneric: async (_url, workDir, _plan, ctx) => {
        ctx.activity?.({ kind: "deadline-armed", limitMs: 600_000 });
        ctx.activity?.({ kind: "phase-started", phase: "single" });
        for (let i = 0; i < 4; i += 1) ctx.activity?.({ kind: "sample-gap" });
        vt.advance(WINDOW + 1_000);
        stopSeen = ctx.stopForObservationLoss?.aborted ?? null;
        // A misbehaving implementation: it ignores the stop and claims success.
        writeFileSync(join(workDir, "source.mp4"), chunk(100));
        return { filePath: join(workDir, "source.mp4"), container: "mp4", mime: "video/mp4", fileSize: 100 };
      },
    });
    const job = h.claim();
    await execute(executor, job);
    assert.equal(stopSeen, true, "the seam was told");
    failedAt(h.store.getJob(job.jobId), "PROCESSING_FAILED");
    assert.deepEqual(h.transitions, [], "the returned media was never processed");
    assert.equal(h.puts.length, 0);
  });

  it("a seam that ignores an inactivity stop and returns anyway cannot continue either: TIMEOUT", async () => {
    const h = harness();
    const vt = virtualTime();
    const executor = executorFor(h, SINGLE_PLAN, {
      acquisitionInactivity: enforcement(vt),
      downloadGeneric: async (_url, workDir, _plan, ctx) => {
        ctx.activity?.({ kind: "deadline-armed", limitMs: 600_000 });
        ctx.activity?.({ kind: "phase-started", phase: "single" });
        ctx.activity?.({ kind: "bytes", totalBytes: 4 * G, evidence: "filesystem" });
        vt.advance(WINDOW);
        writeFileSync(join(workDir, "source.mp4"), chunk(100));
        return { filePath: join(workDir, "source.mp4"), container: "mp4", mime: "video/mp4", fileSize: 100 };
      },
    });
    const job = h.claim();
    await execute(executor, job);
    failedAt(h.store.getJob(job.jobId), "TIMEOUT");
    assert.deepEqual(h.transitions, []);
  });
});

// ── Precedence ───────────────────────────────────────────────────────────────

describe("precedence: the first cause decides, and the stop never relabels another", () => {
  it("a user cancellation before the window wins: cancelled, no failure written, and no stop afterwards", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    let jobId = "";
    const { deps, handed } = realYtdlpSeams(async (call) => {
      writeFileSync(expectedPartPath(workDirOf(call), "mp4"), chunk(3 * G));
      await waitUntil(() => o.count("bytes") >= 1, "a reading");
      assert.equal(executor.cancel(jobId).type, "cancelled");
      vt.advance(10 * WINDOW); // whatever the watchdog would decide, it is too late
      return untilAborted(call);
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt), createAcquisitionActivitySink: o.factory });
    const job = h.claim();
    jobId = job.jobId;
    await execute(executor, job);
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
    assert.deepEqual(h.failJobCalls, []);
    assert.equal((handed[0]!.stopForInactivity as AbortSignal).aborted, false);
    assert.deepEqual(o.settled(), ["cancelled"]);
  });

  it("an operator shutdown landing after the stop still wins: the row is left active for restart recovery, no failure written", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    const { deps } = realYtdlpSeams(async (call) => {
      writeFileSync(expectedPartPath(workDirOf(call), "mp4"), chunk(3 * G));
      await waitUntil(() => o.count("bytes") >= 1, "a reading");
      vt.advance(WINDOW);
      return untilAborted(call, () => executor.abortActiveForShutdown());
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt), createAcquisitionActivitySink: o.factory });
    const job = h.claim();
    await execute(executor, job);
    assert.equal(h.store.getJob(job.jobId)!.status, "downloading", "left for the next process's recovery");
    assert.deepEqual(h.failJobCalls, []);
  });

  it("the absolute deadline first: the seam's own TIMEOUT, and the watchdog decided nothing", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    const { deps, handed } = realYtdlpSeams(async (call) => {
      writeFileSync(expectedPartPath(workDirOf(call), "mp4"), chunk(3 * G));
      await waitUntil(() => o.count("bytes") >= 1, "a reading");
      vt.advance(WINDOW / 2);
      throw new AppError("TIMEOUT"); // the runner's own deadline kill
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt), createAcquisitionActivitySink: o.factory });
    const job = h.claim();
    await execute(executor, job);
    failedAt(h.store.getJob(job.jobId), "TIMEOUT");
    assert.deepEqual(o.settled(), ["deadline-exceeded"]);
    assert.equal((handed[0]!.stopForInactivity as AbortSignal).aborted, false);
    assert.equal((handed[0]!.stopForObservationLoss as AbortSignal).aborted, false);
  });

  it("a size overflow before the window: TOO_LARGE, and the watchdog decided nothing", async () => {
    const h = harness();
    const vt = virtualTime();
    const { deps, handed } = realYtdlpSeams(async (call) => {
      writeFileSync(expectedPartPath(workDirOf(call), "mp4"), chunk(5_000));
      return untilAborted(call);
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, genericLimits: { maxFileSizeBytes: 1_000 }, acquisitionInactivity: enforcement(vt) });
    const job = h.claim();
    await execute(executor, job);
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.errorCode, "TOO_LARGE");
    assert.equal((handed[0]!.stopForInactivity as AbortSignal).aborted, false);
    assert.deepEqual(h.transitions, []);
  });

  it("a late filesystem sample after the stop cannot revive the acquisition or touch the failed job", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    let heldCalls = 0;
    let part = "";
    const { deps } = realYtdlpSeams(async (call) => {
      part = expectedPartPath(workDirOf(call), "mp4");
      writeFileSync(part, chunk(3 * G));
      await waitUntil(() => o.count("bytes") >= 1, "a reading");
      hold = true;
      await waitUntil(() => heldCalls > 0, "a held sample");
      vt.advance(WINDOW);
      return untilAborted(call);
    }, {
      statSize: async (path: string) => {
        if (hold) {
          heldCalls += 1;
          await held;
          return 50 * G; // "growth", arriving only after the stop
        }
        try {
          return statSync(path).size;
        } catch {
          return null;
        }
      },
    });
    let clockOffset = 0;
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt), createAcquisitionActivitySink: o.factory },
      () => Date.now() + clockOffset);
    let progressWrites = 0;
    const realProgress = h.store.updateExecutionProgress.bind(h.store);
    h.store.updateExecutionProgress = ((...args: Parameters<typeof realProgress>) => {
      progressWrites += 1;
      return realProgress(...args);
    }) as typeof h.store.updateExecutionProgress;
    const job = h.claim();
    await execute(executor, job);
    const before = h.store.getJob(job.jobId)!;
    failedAt(before, "TIMEOUT");
    const events = o.events.length;
    const writes = progressWrites;
    clockOffset += 60_000; // past the progress throttle, so a late sample's write could not be masked by it
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(o.events.length, events, "the late sample reported nothing");
    assert.equal(progressWrites, writes, "the late sample never even attempted a progress write");
    assert.deepEqual(h.store.getJob(job.jobId), before, "the durable row is untouched");
    assert.deepEqual(h.transitions, []);
  });

  it("an observation loss never relabels an earlier cause: a cancellation first stays cancelled", async () => {
    const h = harness();
    const vt = virtualTime();
    const o = observer();
    let jobId = "";
    const { deps, handed } = realYtdlpSeams(async (call) => {
      await waitUntil(() => o.count("sample-gap") >= 3, "blindness");
      assert.equal(executor.cancel(jobId).type, "cancelled");
      vt.advance(10 * WINDOW);
      return untilAborted(call);
    }, {
      statSize: async () => {
        throw Object.assign(new Error("x"), { code: "EIO" });
      },
    });
    const executor = executorFor(h, SINGLE_PLAN, { ...deps, acquisitionInactivity: enforcement(vt), createAcquisitionActivitySink: o.factory });
    const job = h.claim();
    jobId = job.jobId;
    await execute(executor, job);
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
    assert.deepEqual(h.failJobCalls, []);
    assert.equal((handed[0]!.stopForObservationLoss as AbortSignal).aborted, false);
  });
});

// ── Structural pins ──────────────────────────────────────────────────────────

const ROOT = new URL("../../../", import.meta.url);
const source = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("still disconnected, and nothing public moved", () => {
  it("the composition root supplies no enforcement, no opt-in and no stop", () => {
    const runtime = source("src/worker/runtime/runtime.server.ts");
    for (const token of ["acquisitionInactivity", "watchFilesystemObservedPlans", "stopForInactivity", "stopForObservationLoss", "acquisition-inactivity-watchdog"]) {
      assert.equal(runtime.includes(token), false, token);
    }
    // Positive control: the same reader finds the opt-in where it is defined.
    assert.equal(source("src/worker/execution/job-executor.server.ts").includes("watchFilesystemObservedPlans"), true);
  });

  it("the filesystem-observed plans are exactly the four yt-dlp operations, and the transport list is unchanged", () => {
    const executor = source("src/worker/execution/job-executor.server.ts");
    const body = (name: string) => /\{([\s\S]*?)\n\}/.exec(executor.slice(executor.indexOf(`function ${name}(plan: ExecutionPlan): boolean`)))?.[1] ?? "";
    assert.deepEqual([...body("isFilesystemObservedPlan").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]).sort(), ["extract-m4a", "extract-mp3", "keep-original", "merge-split", "yt-dlp"]);
    assert.deepEqual([...body("isInactivityWatchedPlan").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort(), ["clear-hls-remux", "clear-hls-separate-audio-remux", "direct"]);
    assert.match(code(executor), /enforcement\.watchFilesystemObservedPlans === true/, "honoured only when exactly true");
  });

  it("the production yt-dlp seams forward both stops, only when present", () => {
    const executor = code(source("src/worker/execution/job-executor.server.ts"));
    assert.equal(executor.split("...(ctx.stopForInactivity ? { stopForInactivity: ctx.stopForInactivity } : {}),").length - 1, 2);
    assert.equal(executor.split("...(ctx.stopForObservationLoss ? { stopForObservationLoss: ctx.stopForObservationLoss } : {}),").length - 1, 2);
  });

  it("no error code was added: the Worker allowlist is exactly the sixteen it was", () => {
    assert.deepEqual([...WORKER_ERROR_CODES], [
      "INVALID_URL", "UNSUPPORTED_SITE", "VIDEO_UNAVAILABLE", "ANALYSIS_FAILED", "FORMAT_UNAVAILABLE", "SERVER_OVERLOAD", "PROCESSING_FAILED", "TIMEOUT",
      "NETWORK_ERROR", "EXTRACTION_FAILED", "EXTRACTOR_UNAVAILABLE", "TOO_LARGE", "TOO_LONG", "RATE_LIMITED", "NOT_FOUND", "EXPIRED",
    ]);
  });

  it("no configuration owns the window yet, and the stage defaults are unchanged", () => {
    for (const file of ["src/worker/runtime/config.server.ts", "src/worker/runtime/time-limits.ts", "src/worker/runtime/runtime.server.ts", "src/lib/config.ts"]) {
      assert.equal(code(source(file)).includes("DOWNLOAD_INACTIVITY_TIMEOUT"), false, file);
      assert.equal(/\b(inactivityMs|watchFilesystemObservedPlans)\b/.test(code(source(file))), false, file);
    }
  });
});
