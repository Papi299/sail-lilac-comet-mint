import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { AppError, ERROR_MESSAGES } from "../../lib/errors.ts";
import { setProcessRunnerTestHooks, type SpawnImpl } from "../../services/processing/process-runner.server.ts";
import { setTempDirectoryForTests } from "../../services/temp/files.server.ts";
import {
  VideoMetadataSchema,
  type WorkerObjectKey,
  type WorkerRequestedFormatId,
  type WorkerVideoMetadata,
} from "../../shared/worker/contracts.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import type { DurableWorkerJob } from "../state/job-store.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type { ObjectStoreHead, ObjectStorePutInput, ObjectStoreWriter } from "../storage/writer.ts";
import {
  JobExecutor,
  type ExecutionBackstopTimerHandle,
  type ExecutionBackstopTimers,
  type JobExecutorDeps,
} from "./job-executor.server.ts";

/**
 * VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001 — the executor's
 * execution-lifetime backstop.
 *
 * One timer per execution, armed at the claimed job's durable deadline
 * (`claimed + L`), firing an abort of the execution's existing controller,
 * classified TIMEOUT below cancellation and shutdown, disposed in `finally`.
 *
 * Time is virtual: the backstop's timer hooks are injected, so a test decides
 * the instant it fires and the clock it fires at. The store is the real SQLite
 * store; every stage is a fake seam except where the real processing path and
 * the real process runner are the point, and there spawn and kill are hooked so
 * no host process is ever created or signalled.
 */

const T0 = 1_800_000_000_000;
const L = 600_000;
const R = 240_000;
const MEDIA_URL = "https://cdn.example/clip.mp4";

type ArmedTimer = ExecutionBackstopTimerHandle & {
  handler: () => void;
  ms: number;
  cleared: boolean;
  unrefed: boolean;
};

/** The backstop's timer hooks, in virtual time. */
class VirtualTimers implements ExecutionBackstopTimers {
  readonly armed: ArmedTimer[] = [];
  setTimeoutFn = (handler: () => void, ms: number): ExecutionBackstopTimerHandle => {
    const timer: ArmedTimer = {
      handler,
      ms,
      cleared: false,
      unrefed: false,
      unref: () => {
        timer.unrefed = true;
      },
    };
    this.armed.push(timer);
    return timer;
  };
  clearTimeoutFn = (handle: ExecutionBackstopTimerHandle) => {
    (handle as ArmedTimer).cleared = true;
  };
  /** Fires a timer as the platform would: only if it was not cleared. */
  fire(index = this.armed.length - 1): void {
    const timer = this.armed[index]!;
    if (!timer.cleared) timer.handler();
  }
  /** Runs a handler even after it was cleared: a timer slipping past `clearTimeout`. */
  forceFire(index = this.armed.length - 1): void {
    this.armed[index]!.handler();
  }
}

class RecordingWriter implements ObjectStoreWriter {
  readonly puts: ObjectStorePutInput[] = [];
  readonly deletes: string[] = [];
  /** When set, `put` waits for it after consuming the body: an upload still in flight. */
  gate: Promise<void> | null = null;
  putEntered = false;
  async put(input: ObjectStorePutInput): Promise<void> {
    this.puts.push(input);
    for await (const chunk of input.body) void chunk;
    this.putEntered = true;
    if (this.gate) await this.gate;
  }
  async head(objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    const put = this.puts.find((p) => p.objectKey === objectKey);
    return put
      ? {
          objectKey: put.objectKey,
          contentLength: put.contentLength,
          contentType: put.contentType,
          contentDisposition: put.contentDisposition,
        }
      : null;
  }
  async delete(objectKey: WorkerObjectKey): Promise<void> {
    this.deletes.push(objectKey);
  }
}

function metadata(presets: Array<{ id: string; container: string; hasVideo: boolean }> = []): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "Backstop Clip",
    thumbnail: null,
    duration: null,
    source: "cdn.example",
    extractor: "direct",
    webpageUrl: MEDIA_URL,
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
        fileSize: 8,
        hasVideo: true,
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

const MP3_META = () => metadata([{ id: "preset:mp3", container: "mp3", hasVideo: false }]);

/** A stage that never ends on its own: it settles only when its signal aborts. */
function untilAborted(signal: AbortSignal | undefined, entered: { value: boolean }, settleLater = false) {
  entered.value = true;
  return new Promise<never>((_resolve, reject) => {
    const fail = () => {
      const err = new AppError("PROCESSING_FAILED", "aborted");
      if (settleLater) setImmediate(() => reject(err));
      else reject(err);
    };
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * Awaits an execution, but never forever. If the backstop under test were
 * broken, the stage it should abort would never settle, and Node 26's test
 * runner waits on a pending test indefinitely (Node 22's cancels it). This
 * turns that into a bounded, named failure instead of a hang.
 */
async function settled(execution: Promise<void>, label: string, timeoutMs = 5000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the execution never settled: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Harness = {
  tempDir: string;
  db: DatabaseSync;
  clock: { now: number };
  store: SQLiteJobStore;
  writer: RecordingWriter;
  timers: VirtualTimers;
  failCalls: Array<{ jobId: string; code: string }>;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = mkdtempSync(join(tmpdir(), "ld2a-backstop-"));
  setTempDirectoryForTests(tempDir);
  const db = openWorkerDatabase({ path: ":memory:" });
  applyMigrations(db);
  const clock = { now: T0 };
  const store = new SQLiteJobStore({ db, clock: () => clock.now, executionLifetimeMs: L, retentionMs: R });
  const failCalls: Array<{ jobId: string; code: string }> = [];
  const realFail = store.failJob.bind(store);
  store.failJob = (jobId: string, code: string, message: string) => {
    failCalls.push({ jobId, code });
    return realFail(jobId, code, message);
  };
  return {
    tempDir,
    db,
    clock,
    store,
    writer: new RecordingWriter(),
    timers: new VirtualTimers(),
    failCalls,
    cleanup: () => {
      db.close();
      setTempDirectoryForTests(null);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function claimJob(h: Harness, formatId: WorkerRequestedFormatId = "direct-original"): DurableWorkerJob {
  h.store.createJob({ url: MEDIA_URL, formatId, principalId: "private-access-user" }, randomUUID());
  h.clock.now += 1_000;
  const job = h.store.claimNextQueuedJob();
  assert.ok(job);
  return job;
}

function makeExecutor(h: Harness, deps: JobExecutorDeps, controllers = new Map<string, AbortController>()) {
  return new JobExecutor(h.store, h.writer, () => h.clock.now, controllers, {
    availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
    backstopTimers: h.timers,
    ...deps,
  });
}

const writeOriginal = (workDir: string) => {
  const filePath = join(workDir, "source.mp4");
  writeFileSync(filePath, "ORIGINAL");
  return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
};

function row(h: Harness, jobId: string) {
  return h.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId) as {
    status: string;
    error_code: string | null;
    safe_error_message: string | null;
    stage_label: string | null;
    finished_at_ms: number | null;
    expires_at_ms: number;
    object_key: string | null;
  };
}

function assertLifetimeTimeout(h: Harness, jobId: string, stage: string, finishedAt: number) {
  const r = row(h, jobId);
  assert.equal(r.status, "failed");
  assert.equal(r.error_code, "TIMEOUT");
  assert.equal(r.safe_error_message, ERROR_MESSAGES.TIMEOUT);
  assert.notEqual(r.safe_error_message, ERROR_MESSAGES.EXPIRED, "a running job's timeout is not an expired link");
  assert.equal(r.stage_label, stage);
  assert.equal(r.object_key, null);
  assert.equal(r.finished_at_ms, finishedAt);
  assert.equal(r.expires_at_ms, finishedAt + R, "the failed outcome is retained R");
}

// ─────────────────────────────────────────────────────────────────────────────

describe("execution-lifetime backstop: arming and disposal", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  it("arms exactly ONE unref'd timer per execution, for the claimed deadline's remainder, and disposes it", async () => {
    const job = claimJob(h);
    assert.equal(job.expiresAt, T0 + 1_000 + L, "the claim wrote claimed + L");
    h.clock.now += 250; // the execution starts a moment after the claim
    await makeExecutor(h, {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => writeOriginal(ctx.workDir),
    }).execute(job);

    assert.equal(row(h, job.jobId).status, "ready");
    assert.equal(h.timers.armed.length, 1, "armed once");
    const [timer] = h.timers.armed;
    assert.equal(timer!.ms, L - 250, "the remaining lifetime to the durable deadline — never a fresh L");
    assert.equal(timer!.unrefed, true, "it never holds the event loop on its own");
    assert.equal(timer!.cleared, true, "disposed in finally");
    assert.deepEqual(h.failCalls, []);
  });

  it("a deadline already passed arms at zero, and the stage check fails the job as TIMEOUT", async () => {
    const job = claimJob(h);
    h.clock.now = job.expiresAt + 5;
    let analyzed = 0;
    await makeExecutor(h, {
      analyze: async () => {
        analyzed += 1;
        return metadata();
      },
    }).execute(job);
    assert.equal(h.timers.armed[0]!.ms, 0);
    assert.equal(analyzed, 0, "nothing runs past the lifetime");
    assertLifetimeTimeout(h, job.jobId, "Download failed", job.expiresAt + 5);
  });

  it("clamps a deadline beyond the platform timer range, so it can only fire early, never overflow", async () => {
    const job = claimJob(h);
    const executor = new JobExecutor(h.store, h.writer, () => 0, new Map(), {
      backstopTimers: h.timers,
      analyze: async () => {
        throw new AppError("NETWORK_ERROR");
      },
    });
    await executor.execute(job);
    assert.equal(h.timers.armed[0]!.ms, 2 ** 31 - 1);
  });

  it("never fires for an execution that ends first, and a late handler then does nothing", async () => {
    const job = claimJob(h);
    await makeExecutor(h, {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => writeOriginal(ctx.workDir),
    }).execute(job);
    const ready = row(h, job.jobId);
    assert.equal(ready.status, "ready");

    h.clock.now = job.expiresAt + 1;
    h.timers.fire(); // cleared: the platform would not run it
    h.timers.forceFire(); // even if it slipped through
    assert.deepEqual(row(h, job.jobId), ready, "a disposed backstop writes nothing");
    assert.deepEqual(h.failCalls, []);
    assert.deepEqual(h.writer.deletes, []);
  });

  it("never acts on a LATER execution: each is bound to its own controller", async () => {
    const first = claimJob(h);
    const secondEntered = { value: false };
    let release: () => void = () => {};
    const executor = makeExecutor(h, {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        if (ctx.workDir.endsWith(first.jobId)) return writeOriginal(ctx.workDir);
        // The second job's acquisition waits for its own abort, or a release.
        secondEntered.value = true;
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          ctx.signal?.addEventListener("abort", () => reject(new AppError("PROCESSING_FAILED", "aborted")), {
            once: true,
          });
        });
        return writeOriginal(ctx.workDir);
      },
    });
    await executor.execute(first);
    const second = claimJob(h);
    const running = executor.execute(second);
    await waitFor(() => secondEntered.value, "the second acquisition");

    h.timers.forceFire(0); // the FIRST execution's handler, long disposed
    assert.equal(executor.activeJobCount, 1);
    assert.equal(row(h, second.jobId).status, "downloading", "the later job is untouched");
    release();
    await settled(running, "the later execution");
    assert.equal(row(h, second.jobId).status, "ready");
    assert.equal(h.timers.armed.length, 2, "one timer per execution");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("execution-lifetime backstop: fires exactly at its bound, as TIMEOUT with the stage of the status", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    setProcessRunnerTestHooks(null);
    h.cleanup();
  });

  it("analysis that never answers: TIMEOUT, Download failed, no work directory left", async () => {
    const job = claimJob(h);
    const entered = { value: false };
    let workRoot = "";
    const executor = makeExecutor(h, {
      analyze: async (_url, signal) => {
        workRoot = join(h.tempDir, "jobs", job.jobId);
        return untilAborted(signal, entered);
      },
    });
    const execution = executor.execute(job);
    await waitFor(() => entered.value, "analysis");
    assert.ok(existsSync(workRoot), "the job directory exists while it runs");
    assert.equal(executor.activeJobCount, 1);
    h.clock.now = job.expiresAt;
    h.timers.fire();
    await settled(execution, "analysis");
    assertLifetimeTimeout(h, job.jobId, "Download failed", job.expiresAt);
    assert.equal(existsSync(workRoot), false, "the work directory is removed");
    assert.equal(executor.activeJobCount, 0, "the controller is unregistered");
  });

  it("an acquisition that never ends: TIMEOUT, Download failed, its partial file removed", async () => {
    const job = claimJob(h);
    const entered = { value: false };
    let partial = "";
    const execution = makeExecutor(h, {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        partial = join(ctx.workDir, "partial.mp4");
        writeFileSync(partial, "PARTIAL");
        return untilAborted(ctx.signal, entered);
      },
    }).execute(job);
    await waitFor(() => entered.value, "acquisition");
    h.clock.now = job.expiresAt;
    h.timers.fire();
    await settled(execution, "acquisition");
    assertLifetimeTimeout(h, job.jobId, "Download failed", job.expiresAt);
    assert.equal(existsSync(partial), false);
    assert.deepEqual(h.writer.puts, [], "nothing is uploaded");
  });

  it("processing through the REAL convertMedia and process runner: the backstop SIGKILLs the stage's process group", async () => {
    // Spawn and kill are hooked: the runner is real, the child is not, and no
    // host process is ever created or signalled.
    const FAKE_PID = 73_100;
    const spawned: string[] = [];
    const killRequests: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
      killCalls: Array<NodeJS.Signals | undefined>;
    };
    child.pid = FAKE_PID;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killCalls = [];
    child.kill = (signal) => {
      child.killCalls.push(signal);
      return true;
    };
    let closed = false;
    const closeChild = () => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => child.emit("close", null));
    };
    const spawn: SpawnImpl = (command) => {
      spawned.push(command);
      return child as unknown as ChildProcess; // stays alive until its group is killed
    };
    setProcessRunnerTestHooks({
      platform: "linux",
      spawn,
      processKill: (pid, signal) => {
        killRequests.push({ pid, signal });
        if (pid === -FAKE_PID) closeChild();
        return true;
      },
    });
    const job = claimJob(h, "preset:mp3");
    const execution = makeExecutor(h, {
      analyze: async () => MP3_META(),
      downloadOriginal: async (_url, ctx) => writeOriginal(ctx.workDir),
      // processLocally is NOT injected: production's convertMedia runs. Its own
      // processing budget is narrowed to 30 s, far beyond the 2 s this test
      // allows the backstop's kill, so the stage's timeout can never pass it.
      timeLimits: { downloadTimeLimitMs: 600_000, processingMs: 30_000 },
    }).execute(job);
    try {
      await waitFor(() => spawned.length === 1, "FFmpeg to be spawned");
      assert.equal(row(h, job.jobId).status, "processing");
      h.clock.now = job.expiresAt;
      h.timers.fire();
      await waitFor(() => killRequests.length === 1, "the backstop's group kill", 2_000);
      await settled(execution, "processing");
    } finally {
      // Whatever failed above, the fake child closes and the execution settles
      // BEFORE afterEach removes the hooks: a runner timer left pending would
      // otherwise send a real SIGKILL to the fabricated group on the host.
      closeChild();
      await settled(execution, "processing cleanup").catch(() => {});
    }

    assert.deepEqual(killRequests, [{ pid: -FAKE_PID, signal: "SIGKILL" }], "exactly the group, with SIGKILL");
    assert.deepEqual(child.killCalls, [], "no direct-child fallback was needed");
    assertLifetimeTimeout(h, job.jobId, "Processing failed", job.expiresAt);
  });

  it("an upload LD-2a cannot cancel runs to its end; the ready commit refuses it and the exact key is deleted", async () => {
    const job = claimJob(h);
    let releaseUpload: () => void = () => {};
    h.writer.gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const execution = makeExecutor(h, {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => writeOriginal(ctx.workDir),
    }).execute(job);
    await waitFor(() => h.writer.putEntered, "the upload to be in flight");
    assert.equal(row(h, job.jobId).status, "uploading");

    h.clock.now = job.expiresAt;
    h.timers.fire(); // the abort reaches the controller; the PUT does not observe it before LD-2b
    assert.equal(h.writer.deletes.length, 0, "nothing deleted while the upload is still in flight");
    h.clock.now = job.expiresAt + 2_000;
    releaseUpload(); // the PUT completes after the lifetime
    await settled(execution, "the late upload");

    assert.equal(h.writer.puts.length, 1);
    assert.deepEqual(h.writer.deletes, [h.writer.puts[0]!.objectKey], "exactly the uploaded key, nothing else");
    assertLifetimeTimeout(h, job.jobId, "Upload failed", job.expiresAt + 2_000);
    assert.deepEqual(
      h.failCalls.map((c) => c.code),
      ["TIMEOUT"],
      "one terminal outcome",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("execution-lifetime backstop: the ready commit at, before and after the deadline", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  /** Runs one job whose upload completes with the clock at `commitAt`, without the timer firing. */
  async function uploadCompletingAt(commitAt: (job: DurableWorkerJob) => number) {
    const job = claimJob(h);
    let releaseUpload: () => void = () => {};
    h.writer.gate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const execution = makeExecutor(h, {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => writeOriginal(ctx.workDir),
    }).execute(job);
    await waitFor(() => h.writer.putEntered, "the upload");
    h.clock.now = commitAt(job);
    releaseUpload();
    await settled(execution, "the upload completing");
    return job;
  }

  it("a millisecond before the deadline: ready, retained R from that instant", async () => {
    const job = await uploadCompletingAt((j) => j.expiresAt - 1);
    const r = row(h, job.jobId);
    assert.equal(r.status, "ready");
    assert.equal(r.expires_at_ms, job.expiresAt - 1 + R);
    assert.deepEqual(h.writer.deletes, []);
    assert.equal(h.timers.armed[0]!.cleared, true);
  });

  for (const [label, offset] of [
    ["exactly at the deadline", 0],
    ["a millisecond after it", 1],
  ] as const) {
    it(`${label}, even before the timer fired: TIMEOUT, Upload failed, the exact key deleted`, async () => {
      const job = await uploadCompletingAt((j) => j.expiresAt + offset);
      assertLifetimeTimeout(h, job.jobId, "Upload failed", job.expiresAt + offset);
      assert.deepEqual(h.writer.deletes, [h.writer.puts[0]!.objectKey]);
    });
  }

  it("a failed cleanup after the losing commit still fails the job and never makes it ready", async () => {
    h.writer.delete = async () => {
      throw new Error("provider unavailable");
    };
    const job = await uploadCompletingAt((j) => j.expiresAt + 10);
    assertLifetimeTimeout(h, job.jobId, "Upload failed", job.expiresAt + 10);
    assert.equal(row(h, job.jobId).object_key, null, "no unauthorised object is ever referenced");
    assert.deepEqual(h.store.listExpiredReadyObjects(10), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("execution-lifetime backstop: precedence — cancellation, then shutdown, then the deadline", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  function blockingAcquisition(entered: { value: boolean }, settleLater = false) {
    return {
      analyze: async () => metadata(),
      downloadOriginal: async (_url: string, ctx: { signal?: AbortSignal }) => untilAborted(ctx.signal, entered, settleLater),
    } satisfies JobExecutorDeps;
  }

  it("a cancel whose durable CAS lands first wins; the backstop then finds nothing to do", async () => {
    const job = claimJob(h);
    const entered = { value: false };
    const executor = makeExecutor(h, blockingAcquisition(entered));
    const execution = executor.execute(job);
    await waitFor(() => entered.value, "acquisition");
    h.clock.now += 5_000;
    const cancelledAt = h.clock.now;
    assert.equal(executor.cancel(job.jobId).type, "cancelled");
    await settled(execution, "cancel first");
    h.clock.now = job.expiresAt;
    h.timers.forceFire();
    const r = row(h, job.jobId);
    assert.equal(r.status, "cancelled");
    assert.equal(r.expires_at_ms, cancelledAt + R);
    assert.deepEqual(h.failCalls, [], "no failure is written over a won cancellation");
  });

  it("the deadline fires, but a cancel's CAS lands before the execution records it: cancellation wins", async () => {
    const job = claimJob(h);
    const entered = { value: false };
    const executor = makeExecutor(h, blockingAcquisition(entered, true));
    const execution = executor.execute(job);
    await waitFor(() => entered.value, "acquisition");
    h.clock.now = job.expiresAt;
    h.timers.fire();
    // The acquisition settles a macrotask later; the cancel lands in between.
    assert.equal(executor.cancel(job.jobId).type, "cancelled");
    await settled(execution, "deadline, then cancel");
    assert.equal(row(h, job.jobId).status, "cancelled");
    assert.deepEqual(h.failCalls, []);
  });

  it("the deadline's failure lands first: a later cancel is unchanged", async () => {
    const job = claimJob(h);
    const entered = { value: false };
    const executor = makeExecutor(h, blockingAcquisition(entered));
    const execution = executor.execute(job);
    await waitFor(() => entered.value, "acquisition");
    h.clock.now = job.expiresAt;
    h.timers.fire();
    await settled(execution, "deadline first");
    assert.equal(executor.cancel(job.jobId).type, "unchanged");
    assertLifetimeTimeout(h, job.jobId, "Download failed", job.expiresAt);
  });

  it("shutdown first: the row stays ACTIVE for recover(), and the disposed backstop never fires", async () => {
    const job = claimJob(h);
    const entered = { value: false };
    const executor = makeExecutor(h, blockingAcquisition(entered));
    const execution = executor.execute(job);
    await waitFor(() => entered.value, "acquisition");
    executor.abortActiveForShutdown();
    await settled(execution, "shutdown first");
    assert.equal(row(h, job.jobId).status, "downloading");
    h.clock.now = job.expiresAt;
    h.timers.forceFire();
    assert.equal(row(h, job.jobId).status, "downloading");
    assert.deepEqual(h.failCalls, []);

    const recoveredAt = job.expiresAt + 1_000;
    new SQLiteJobStore({ db: h.db, clock: () => recoveredAt, executionLifetimeMs: L, retentionMs: R }).recover();
    const r = row(h, job.jobId);
    assert.equal(r.status, "failed");
    assert.equal(r.stage_label, "Worker restarted");
    assert.equal(r.expires_at_ms, recoveredAt + R);
  });

  it("the deadline fires, then shutdown before the execution records it: shutdown keeps its precedence", async () => {
    const job = claimJob(h);
    const entered = { value: false };
    const executor = makeExecutor(h, blockingAcquisition(entered, true));
    const execution = executor.execute(job);
    await waitFor(() => entered.value, "acquisition");
    h.clock.now = job.expiresAt;
    h.timers.fire();
    executor.abortActiveForShutdown();
    await settled(execution, "deadline, then shutdown");
    assert.equal(row(h, job.jobId).status, "downloading", "an operator restart is never turned into a TIMEOUT");
    assert.deepEqual(h.failCalls, []);
  });

  it("an ORDINARY failure before the deadline keeps its own code: the backstop marks nothing it did not abort", async () => {
    const job = claimJob(h);
    await makeExecutor(h, {
      analyze: async () => metadata(),
      downloadOriginal: async () => {
        throw new AppError("NETWORK_ERROR");
      },
    }).execute(job);
    assert.equal(row(h, job.jobId).error_code, "NETWORK_ERROR");
    assert.equal(h.timers.armed[0]!.cleared, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("execution-lifetime backstop: nothing renews it", () => {
  it("a stream of progress reports moves neither the timer nor the durable deadline", async () => {
    const h = makeHarness();
    try {
      const job = claimJob(h);
      const entered = { value: false };
      const execution = makeExecutor(h, {
        analyze: async () => metadata(),
        downloadOriginal: async (_url, ctx) => {
          for (let i = 1; i <= 50; i += 1) {
            h.clock.now += 5_000; // progress keeps arriving for minutes of virtual time
            ctx.onProgress?.({ progress: i, downloadedBytes: i * 1_000, totalBytes: 50_000 });
          }
          return untilAborted(ctx.signal, entered);
        },
      }).execute(job);
      await waitFor(() => entered.value, "acquisition");
      assert.equal(h.timers.armed.length, 1, "never re-armed");
      assert.equal(h.timers.armed[0]!.ms, L, "armed once, for the claimed deadline");
      assert.equal(row(h, job.jobId).expires_at_ms, job.expiresAt, "progress never touched the durable deadline");
      assert.equal(row(h, job.jobId).status, "downloading");
      h.clock.now = job.expiresAt;
      h.timers.fire();
      await settled(execution, "progress then the deadline");
      assertLifetimeTimeout(h, job.jobId, "Download failed", job.expiresAt);
    } finally {
      h.cleanup();
    }
  });
});
