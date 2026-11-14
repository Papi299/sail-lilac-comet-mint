import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "@/lib/errors";
import type { AcquisitionActivityEvent } from "@/services/downloads/acquisition-activity";
import {
  createAcquisitionInactivityWatchdog,
  type InactivityWatchdogTimerHandle,
  type InactivityWatchdogTimers,
} from "@/services/downloads/acquisition-inactivity-watchdog";
import { runProcess } from "@/services/processing/process-runner.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema } from "@/shared/worker/contracts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import { YTDLP_RUNTIME } from "../runtime/ytdlp-runtime.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type { ObjectStorePutInput, ObjectStoreWriter } from "../storage/writer.ts";
import { GenericExecutionPlanSchema, type ExecutionPlan, type GenericSingleSourceExecutionPlan } from "./format-plan.ts";
import { JobExecutor } from "./job-executor.server.ts";
import {
  downloadGenericOriginal,
  expectedPartPath,
  expectedSourcePath,
  type GenericDownloadDeps,
} from "./ytdlp-download.server.ts";

/**
 * VIDEOFETCH-LD3C-YTDLP-OBSERVATION-HARDENING-001, section M — deterministic
 * PROCESS CONTAINMENT, with real processes, through the real yt-dlp seam and
 * the real hardened process runner (closing the LD-3b J09 limitation, whose
 * negative control was detected only by cancelled tests).
 *
 * The child is a synthetic fixture in place of the pinned interpreter; every
 * other field of the runner call — the signal, the time limit, the environment
 * and the output ceilings — is the seam's own, unchanged. The fixture spawns
 * ONE descendant in its own process group (the runner's detached spawn makes
 * the fixture the group leader), records both pids in a readiness file, writes
 * real bytes where the monitor looks, and then holds — or, in `complete` mode,
 * finishes the way yt-dlp does and exits 0.
 *
 * Every claim is an explicit, named assertion over observable process state
 * (`kill(pid, 0)`, `kill(-pgid, 0)`, `ps`), polled within a fixed bound, so a
 * defect that leaves a process alive fails an assertion, never a test-runner
 * timeout. The acquisition itself is awaited only through a bounded race for
 * the same reason. Every test kills whatever it recorded in `finally`, and
 * proves afterwards that nothing it started survives.
 */

const POSIX = process.platform !== "win32";
const WINDOW = 120_000;
const G = 65_536;
const BOUND_MS = 10_000;
const MARKER = "ld3c-containment-fixture";
const RUNTIME_OK = Object.freeze({ available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" as const });

/**
 * The fixture. argv: readiness file, mode, `.part` path, final path, byte count, marker.
 * Its descendant carries the marker too, so a leftover would be visible to `ps`.
 */
const FIXTURE = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [readyFile, mode, partPath, finalPath, bytes, marker] = process.argv.slice(1);
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore", detached: false });
if (!child.pid) process.exit(3);
fs.writeFileSync(readyFile + ".tmp", JSON.stringify({ parent: process.pid, child: child.pid }));
fs.renameSync(readyFile + ".tmp", readyFile);
fs.writeFileSync(partPath, Buffer.alloc(Number(bytes), 7));
if (mode === "complete") {
  fs.renameSync(partPath, finalPath);
  child.on("exit", () => process.exit(0));
  child.kill("SIGTERM");
} else {
  setInterval(() => {}, 1000);
}
`;

type Pids = { readonly parent: number; readonly child: number };

let workRoot = "";
let eventLoopHold: ReturnType<typeof setTimeout> | null = null;
const started: Pids[] = [];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  eventLoopHold = setTimeout(() => {}, 120_000);
  workRoot = mkdtempSync(join(tmpdir(), "ld3c-contain-"));
});

afterEach(() => {
  // Never leave a process behind, whatever the test did.
  for (const pids of started.splice(0)) {
    for (const pid of [pids.child, pids.parent]) if (exists(pid)) kill(pid);
    if (groupExists(pids.parent)) kill(-pids.parent);
  }
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(workRoot, { recursive: true, force: true });
  if (eventLoopHold !== null) clearTimeout(eventLoopHold);
  eventLoopHold = null;
});

// ── Observable process state ─────────────────────────────────────────────────

function probe(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err: unknown) {
    // EPERM: it exists, but is not ours to signal.
    return (err as { code?: unknown }).code === "EPERM";
  }
}
const exists = (pid: number) => probe(pid);
const groupExists = (pgid: number) => probe(-pgid);
function kill(target: number) {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Already gone.
  }
}
/** `ps`'s view of one process: its group, its parent and its state, or null once it is gone. */
function psView(pid: number): { pgid: number; ppid: number; state: string } | null {
  try {
    const out = execFileSync("/bin/ps", ["-o", "pgid=,ppid=,stat=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", PATH: "/bin:/usr/bin" } }).trim();
    const [pgid, ppid, state] = out.split(/\s+/);
    return out === "" ? null : { pgid: Number(pgid), ppid: Number(ppid), state: state ?? "" };
  } catch {
    return null;
  }
}
/** Running means: the process exists and is not a zombie awaiting its reaper. */
function running(pid: number): boolean {
  if (!exists(pid)) return false;
  const view = psView(pid);
  return view !== null && !view.state.startsWith("Z");
}

/** Polls `predicate` until it holds or the bound passes; the RESULT is asserted by the caller, by name. */
async function within(predicate: () => boolean, boundMs = BOUND_MS): Promise<boolean> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > boundMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/** Awaits an operation for at most the bound: "pending" if it did not settle. */
async function settleWithin<T>(operation: Promise<T>): Promise<{ ok: T } | { err: unknown } | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), BOUND_MS);
  });
  try {
    return await Promise.race([operation.then((ok) => ({ ok }), (err: unknown) => ({ err })), bound]);
  } finally {
    clearTimeout(timer);
  }
}

// ── The fixture, behind the REAL runner ──────────────────────────────────────

function fixture(mode: "hold" | "complete", bytes: number) {
  const readyFile = join(workRoot, `ready-${randomUUID()}.json`);
  let pids: Pids | null = null;
  let runnerSignal: AbortSignal | undefined;
  const runner = ((call: Parameters<typeof runProcess>[0]) => {
    runnerSignal = call.signal;
    const output = call.args.find((a) => a.startsWith("--output="))!.slice("--output=".length);
    const workDir = output.replace(/\/[a-z-]+\.%\(ext\)s$/, "");
    // Only the program is replaced: the signal, the time limit, the environment
    // and the output ceilings are the seam's own.
    return runProcess({
      ...call,
      command: process.execPath,
      args: ["-e", FIXTURE, readyFile, mode, expectedPartPath(workDir, "mp4"), expectedSourcePath(workDir, "mp4"), String(bytes), MARKER],
    });
  }) as typeof runProcess;
  return {
    runner,
    /** Waits for the fixture's readiness file; records both pids for the afterEach sweep. */
    async ready(): Promise<Pids> {
      const ok = await within(() => existsSync(readyFile));
      assert.equal(ok, true, "the fixture reported readiness");
      pids = JSON.parse(readFileSync(readyFile, "utf8")) as Pids;
      started.push(pids);
      return pids;
    },
    pids: () => pids,
    /** The signal the seam handed the REAL runner: aborting it is how termination is initiated. */
    runnerSignal: () => runnerSignal,
  };
}

function progressivePlan(): GenericSingleSourceExecutionPlan {
  return {
    strategy: "yt-dlp",
    operation: "keep-original",
    requestedFormatId: "preset:1080",
    source: { formatId: "22", protocol: "https", container: "mp4", hasVideo: true, hasAudio: true, videoConstraint: "codec-present", audioConstraint: "codec-present", fileSize: null },
    targetContainer: "mp4",
  } as GenericSingleSourceExecutionPlan;
}

function seamDeps(runner: typeof runProcess, over: Partial<GenericDownloadDeps> = {}): GenericDownloadDeps {
  return {
    // The production default acquisition limit: longer than the window, so a
    // stall can be decided before the absolute deadline.
    limits: { maxFileSizeBytes: 1_000_000_000, downloadTimeLimitMs: 600_000 },
    probeRuntime: async () => RUNTIME_OK,
    validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
    sizePollMs: 5,
    runner,
    ...over,
  } as GenericDownloadDeps;
}

function virtualTime(startMs = 13_000_000) {
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
  };
}

/** The group relationship the containment rests on, asserted from `ps`. */
function assertOneGroup(pids: Pids) {
  const parent = psView(pids.parent);
  const child = psView(pids.child);
  assert.ok(parent && child, "both processes are running before the stop");
  assert.equal(child.ppid, pids.parent, "the descendant is the fixture's own child");
  assert.equal(parent.pgid, pids.parent, "the runner made the fixture its own process-group leader");
  assert.equal(child.pgid, pids.parent, "the descendant belongs to that same process group");
  assert.notEqual(pids.parent, process.pid);
}

/** The containment post-condition, every clause by name. */
async function assertContained(pids: Pids, cause: string) {
  assert.equal(await within(() => !running(pids.parent)), true, `${cause}: the parent process exited`);
  assert.equal(await within(() => !running(pids.child)), true, `${cause}: no descendant survived`);
  assert.equal(await within(() => !groupExists(pids.parent)), true, `${cause}: the process group no longer exists`);
}

const quietObserver = () => {
  const events: AcquisitionActivityEvent[] = [];
  return { events, sink: (e: AcquisitionActivityEvent) => events.push(e), readings: () => events.filter((e) => e.kind === "bytes").length };
};

// ── The seam ─────────────────────────────────────────────────────────────────

describe("M: a stop reaches the running child's whole process group", { skip: POSIX ? false : "POSIX process groups only" }, () => {
  it("M1-M5: a genuine inactivity decision terminates the parent and its descendant, removes the group, and settles as TIMEOUT", { timeout: 60_000 }, async () => {
    const workDir = mkdtempSync(join(workRoot, "job-"));
    const f = fixture("hold", 4 * G);
    const vt = virtualTime();
    const stop = new AbortController();
    const o = quietObserver();
    const watchdog = createAcquisitionInactivityWatchdog({
      policy: { windowMs: WINDOW },
      clock: vt.clock,
      timers: vt.timers,
      onStall: () => stop.abort(),
    });
    const outcome = downloadGenericOriginal("https://example.invalid/watch", workDir, progressivePlan(), seamDeps(f.runner, {
      activity: (event) => {
        o.sink(event);
        watchdog.record(event);
      },
      stopForInactivity: stop.signal,
    }));
    outcome.catch(() => {});
    const pids = await f.ready();
    assertOneGroup(pids);
    assert.equal(await within(() => o.readings() >= 2), true, "the monitor read the child's file");
    assert.equal(stop.signal.aborted, false, "nothing stopped before the window");
    assert.equal(f.runnerSignal()?.aborted, false, "the runner's signal is live before the decision");
    vt.advance(WINDOW); // a full window of readings without growth: a genuine stall
    assert.equal(watchdog.report().state, "stopped", "the watchdog decided inactivity");
    assert.equal(stop.signal.aborted, true, "the decision reached the seam's stop");
    const initiated = f.runnerSignal()?.aborted === true;
    // The process state is asserted FIRST: a suppressed abort must fail by the process staying alive (task M).
    await assertContained(pids, "inactivity");
    assert.equal(initiated, true, "termination was initiated: the runner's own signal aborted");
    const settled = await settleWithin(outcome);
    assert.notEqual(settled, "pending", "the acquisition settled after the stop");
    assert.ok(settled !== "pending" && "err" in settled && settled.err instanceof AppError && settled.err.code === "TIMEOUT", "the outcome is the stop's own: TIMEOUT");
    assert.deepEqual(o.events.flatMap((e) => (e.kind === "settled" ? [e.outcome] : [])), ["failed"], "never recorded as a cancellation");
  });

  it("M: an observation-loss decision terminates the group the same way, and settles as PROCESSING_FAILED", { timeout: 60_000 }, async () => {
    const workDir = mkdtempSync(join(workRoot, "job-"));
    const f = fixture("hold", G);
    const stop = new AbortController();
    const outcome = downloadGenericOriginal("https://example.invalid/watch", workDir, progressivePlan(), seamDeps(f.runner, { stopForObservationLoss: stop.signal }));
    outcome.catch(() => {});
    const pids = await f.ready();
    assertOneGroup(pids);
    stop.abort();
    await assertContained(pids, "observation loss");
    const settled = await settleWithin(outcome);
    assert.ok(settled !== "pending" && "err" in settled && settled.err instanceof AppError && settled.err.code === "PROCESSING_FAILED" && settled.err.message !== "Download was cancelled.", "PROCESSING_FAILED, not a cancellation");
  });

  it("M9: an explicit user cancellation terminates the group and stays a cancellation; a later stop changes nothing", { timeout: 60_000 }, async () => {
    const workDir = mkdtempSync(join(workRoot, "job-"));
    const f = fixture("hold", G);
    const caller = new AbortController();
    const stop = new AbortController();
    const outcome = downloadGenericOriginal("https://example.invalid/watch", workDir, progressivePlan(), seamDeps(f.runner, { signal: caller.signal, stopForInactivity: stop.signal }));
    outcome.catch(() => {});
    const pids = await f.ready();
    assertOneGroup(pids);
    caller.abort(new AppError("PROCESSING_FAILED", "Download was cancelled."));
    stop.abort();
    await assertContained(pids, "cancellation");
    const settled = await settleWithin(outcome);
    assert.ok(settled !== "pending" && "err" in settled && settled.err instanceof AppError && settled.err.message === "Download was cancelled.", "still the user's cancellation");
  });

  it("M10: a competing size overflow keeps its precedence over a later stop; the group is terminated", { timeout: 60_000 }, async () => {
    const workDir = mkdtempSync(join(workRoot, "job-"));
    const f = fixture("hold", 5_000);
    const stop = new AbortController();
    const outcome = downloadGenericOriginal("https://example.invalid/watch", workDir, progressivePlan(), seamDeps(f.runner, {
      limits: { maxFileSizeBytes: 1_000, downloadTimeLimitMs: 600_000 },
      stopForInactivity: stop.signal,
    }));
    outcome.catch(() => {});
    const pids = await f.ready();
    await assertContained(pids, "overflow");
    stop.abort();
    const settled = await settleWithin(outcome);
    assert.ok(settled !== "pending" && "err" in settled && settled.err instanceof AppError && settled.err.code === "TOO_LARGE", "TOO_LARGE keeps its precedence");
  });

  it("M12: the absolute deadline cannot leave an orphan: the runner's TIMEOUT terminates the whole group", { timeout: 60_000 }, async () => {
    const workDir = mkdtempSync(join(workRoot, "job-"));
    const f = fixture("hold", G);
    const outcome = downloadGenericOriginal("https://example.invalid/watch", workDir, progressivePlan(), seamDeps(f.runner, {
      limits: { maxFileSizeBytes: 1_000_000_000, downloadTimeLimitMs: 1_500 },
    }));
    outcome.catch(() => {});
    const pids = await f.ready();
    assertOneGroup(pids);
    await assertContained(pids, "deadline");
    const settled = await settleWithin(outcome);
    assert.ok(settled !== "pending" && "err" in settled && settled.err instanceof AppError && settled.err.code === "TIMEOUT", "the deadline's TIMEOUT");
  });

  it("M11: a normal successful subprocess is not killed: it exits 0 by itself and its artifact is validated", { timeout: 60_000 }, async () => {
    const workDir = mkdtempSync(join(workRoot, "job-"));
    const f = fixture("complete", 3 * G);
    const stop = new AbortController();
    const outcome = downloadGenericOriginal("https://example.invalid/watch", workDir, progressivePlan(), seamDeps(f.runner, { stopForInactivity: stop.signal }));
    outcome.catch(() => {});
    const pids = await f.ready();
    const settled = await settleWithin(outcome);
    assert.ok(settled !== "pending" && "ok" in settled, "the acquisition succeeded");
    assert.equal(settled.ok.fileSize, 3 * G);
    assert.equal(statSync(settled.ok.filePath).size, 3 * G);
    assert.equal(stop.signal.aborted, false, "no stop was ever involved");
    assert.equal(await within(() => !running(pids.parent) && !running(pids.child)), true, "both exited on their own");
  });
});

// ── The executor ─────────────────────────────────────────────────────────────

describe("M6-M8: through the real executor, a stopped acquisition never proceeds", { skip: POSIX ? false : "POSIX process groups only" }, () => {
  it("the job fails TIMEOUT at the download stage, the group is terminated, it never processes or uploads, never becomes ready, and nothing revives it", { timeout: 60_000 }, async () => {
    const tempDir = mkdtempSync(join(workRoot, "executor-"));
    setTempDirectoryForTests(tempDir);
    const db = new DatabaseSync(join(tempDir, "test.sqlite"));
    applyMigrations(db);
    cleanups.push(() => {
      db.close();
      setTempDirectoryForTests(null);
    });
    const store = new SQLiteJobStore({ db });
    const transitions: string[] = [];
    const realBeginProcessing = store.beginProcessing.bind(store);
    store.beginProcessing = (jobId: string) => {
      transitions.push("processing");
      return realBeginProcessing(jobId);
    };
    const puts: ObjectStorePutInput[] = [];
    const writer: ObjectStoreWriter = {
      async put(input) {
        puts.push(input);
        for await (const piece of input.body) void piece;
      },
      async head() {
        return null;
      },
      async delete() {},
    };
    const vt = virtualTime();
    const f = fixture("hold", 4 * G);
    const o = quietObserver();
    const plan = GenericExecutionPlanSchema.parse(progressivePlan());
    const analysis: ExecutionAnalysis = {
      strategy: "yt-dlp",
      video: VideoMetadataSchema.parse({ title: "clip", thumbnail: null, duration: 6, source: "example.invalid", extractor: "yt-dlp", webpageUrl: "https://example.invalid/watch", formats: [], presets: [], capabilities: { mp3: false, merge: false } }),
      selections: {},
      hlsSelections: {},
      separateHlsSelections: {},
    };
    const executor = new JobExecutor(store, writer, () => Date.now(), new Map(), {
      analyzeForExecution: async () => analysis,
      derivePlanForExecution: () => ({ strategy: "yt-dlp", generic: plan }) as ExecutionPlan,
      availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
      acquisitionInactivity: { policy: { windowMs: WINDOW }, clock: vt.clock, timers: vt.timers, watchFilesystemObservedPlans: true },
      createAcquisitionActivitySink: () => o.sink,
      downloadGeneric: (url, workDir, generic, ctx) =>
        downloadGenericOriginal(url, workDir, generic, seamDeps(f.runner, {
          limits: ctx.limits,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
          ...(ctx.activity ? { activity: ctx.activity } : {}),
          ...(ctx.stopForInactivity ? { stopForInactivity: ctx.stopForInactivity } : {}),
          ...(ctx.stopForObservationLoss ? { stopForObservationLoss: ctx.stopForObservationLoss } : {}),
        })).then((res) => ({ ...res, mime: "video/mp4" })),
    });
    store.createJob({ url: "https://example.invalid/watch", formatId: "preset:1080", principalId: "private-access-user" }, randomUUID());
    const job = store.claimNextQueuedJob();
    assert.ok(job);
    const execution = executor.execute(job);
    execution.catch(() => {});
    const pids = await f.ready();
    assertOneGroup(pids);
    assert.equal(await within(() => o.readings() >= 2), true, "the monitor read the child's file");
    vt.advance(WINDOW);
    await assertContained(pids, "executor stop");
    const settled = await settleWithin(execution);
    assert.notEqual(settled, "pending", "the execution finished");
    const view = store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "TIMEOUT");
    assert.equal(view.stageLabel, "Download failed");
    assert.deepEqual(transitions, [], "the acquisition did not proceed into processing");
    assert.equal(puts.length, 0, "nothing was uploaded");
    assert.equal(executor.activeJobCount, 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(store.getJob(job.jobId), view, "nothing late revived or rewrote the job");
    assert.equal(existsSync(join(tempDir, "jobs", job.jobId)), false, "the job directory was removed");
  });
});

// ── The suite's own hygiene ──────────────────────────────────────────────────

describe("M13: the containment tests leave nothing running", { skip: POSIX ? false : "POSIX process groups only" }, () => {
  it("no process carrying the fixture's marker survives this file's earlier tests", { timeout: 30_000 }, async () => {
    const leftovers = () =>
      execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", env: { LC_ALL: "C", PATH: "/bin:/usr/bin" } })
        .split("\n")
        .filter((line) => line.includes(MARKER) && !line.includes("/bin/ps"))
        .map((line) => Number(line.trim().split(/\s+/)[0]))
        .filter((pid) => pid !== process.pid && running(pid));
    assert.equal(await within(() => leftovers().length === 0), true, `no fixture process left: ${leftovers().join(",")}`);
  });
});
