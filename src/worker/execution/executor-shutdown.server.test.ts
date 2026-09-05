import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../../lib/errors.ts";
import { setTempDirectoryForTests } from "../../services/temp/files.server.ts";
import type { WorkerVideoMetadata, WorkerObjectKey } from "../../shared/worker/contracts.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type {
  ObjectStoreHead,
  ObjectStorePutInput,
  ObjectStoreWriter,
} from "../storage/writer.ts";
import { JobExecutor } from "./job-executor.server.ts";

/**
 * §22/§23 + PHASE-10D-WORKER-RESTART-RECOVERY-DETERMINISM-001:
 * `abortActiveForShutdown()` regression.
 *
 * An operator restart must abort in-flight media execution — so no FFmpeg
 * descendant outlives the container, and so the per-job work directory is
 * removed — WITHOUT writing a user cancellation state and WITHOUT committing
 * an ordinary terminal failure.
 *
 * The durable row of an execution interrupted by shutdown stays in its ACTIVE
 * state through the old process's drain. The NEXT process owns the transition:
 * `store.recover()` classifies it deterministically. Letting the dying
 * process's error classifier commit `PROCESSING_FAILED` /
 * "We couldn't process this video. Try another format or source." is exactly
 * the nondeterminism the live Stage-B `shutdown` case caught.
 */

const MEDIA_URL = "https://cdn.example/clip.mp4";
const FORMAT_ID = "direct-original";

/** The one deterministic outcome an operator restart may ever produce. */
const RESTART_RECOVERY = {
  status: "failed",
  errorCode: "PROCESSING_FAILED",
  safeErrorMessage: "Worker restarted before the job completed.",
  stageLabel: "Worker restarted",
} as const;

function metadata(): WorkerVideoMetadata {
  return {
    title: "Shutdown Clip",
    thumbnail: null,
    duration: 12,
    source: "cdn.example",
    extractor: "direct",
    webpageUrl: MEDIA_URL,
    formats: [
      {
        id: FORMAT_ID,
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
    presets: [],
    capabilities: { mp3: false, merge: false },
  };
}

class MemoryWriter implements ObjectStoreWriter {
  public readonly objects = new Map<string, ObjectStoreHead>();
  async put(input: ObjectStorePutInput): Promise<void> {
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
  async delete(): Promise<void> {}
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("JobExecutor.abortActiveForShutdown", () => {
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let cancelCalls: string[];
  let failCalls: Array<{ jobId: string; code: string; message: string }>;
  let tempRootDir: string;
  let canonicalJobsRoot: string;

  beforeEach(async () => {
    tempRootDir = await mkdtemp(join(tmpdir(), "executor-shutdown-"));
    setTempDirectoryForTests(tempRootDir);
    canonicalJobsRoot = join(await realpath(tempRootDir), "jobs");

    db = openWorkerDatabase({ path: ":memory:" });
    applyMigrations(db);
    store = new SQLiteJobStore({ db });
    cancelCalls = [];
    failCalls = [];
    // Spies that record any cancellation or ordinary-failure attempt without
    // changing behaviour.
    const realCancel = store.cancelJob.bind(store);
    store.cancelJob = (jobId: string) => {
      cancelCalls.push(jobId);
      return realCancel(jobId);
    };
    const realFail = store.failJob.bind(store);
    store.failJob = (jobId: string, code: string, message: string) => {
      failCalls.push({ jobId, code, message });
      return realFail(jobId, code as never, message);
    };
  });

  afterEach(async () => {
    try { db.close(); } catch { /* already closed */ }
    setTempDirectoryForTests(null);
    await rm(tempRootDir, { recursive: true, force: true });
  });

  function queueJob(): string {
    const created = store.createJob(
      { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
      randomUUID(),
    );
    assert.equal(created.type, "created");
    return created.type === "created" ? created.job.jobId : "";
  }

  /** The exact durable result `store.recover()` must produce, and nothing else. */
  function assertRestartRecovered(jobId: string) {
    const view = store.getJob(jobId);
    assert.ok(view, "the recovered job must still exist");
    assert.equal(view.status, RESTART_RECOVERY.status);
    assert.equal(view.errorCode, RESTART_RECOVERY.errorCode);
    assert.equal(view.safeErrorMessage, RESTART_RECOVERY.safeErrorMessage);
    assert.equal(view.stageLabel, RESTART_RECOVERY.stageLabel);
  }

  /** A `downloadOriginal` that parks until the shutdown abort fires. */
  function blockingDirectDownload(entered: { value: boolean }) {
    return async (_url: string, ctx: { workDir: string; signal?: AbortSignal }) => {
      entered.value = true;
      await new Promise<void>((resolve) => {
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // Whatever the acquisition layer rejects with is irrelevant to the
      // shutdown decision — provenance comes from the marked signal, never
      // from this error object.
      throw new AppError("PROCESSING_FAILED", "aborted");
    };
  }

  it("leaves the interrupted row ACTIVE, then recover() writes the restart result", async () => {
    const jobId = queueJob();
    const entered = { value: false };

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: blockingDirectDownload(entered),
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    const execution = executor.execute(claimed);

    await waitFor(() => entered.value, "download to start");
    assert.equal(executor.activeJobCount, 1);
    assert.equal(store.getJob(jobId)?.status, "downloading");

    const aborted = executor.abortActiveForShutdown();
    assert.equal(aborted, 1, "one execution was signalled");

    // The execution drains cleanly INSIDE the grace period — correctness must
    // not depend on killing the process before this catch runs.
    await execution;
    assert.equal(executor.activeJobCount, 0, "the active controller was unregistered");

    // ── BEFORE recover(): the interrupted row is still ACTIVE ───────────────
    const interrupted = store.getJob(jobId);
    assert.ok(interrupted);
    assert.equal(
      interrupted.status,
      "downloading",
      "the row stays in the active state the execution had reached",
    );
    assert.notEqual(interrupted.status, "failed", "shutdown must not commit an ordinary failure");
    assert.notEqual(interrupted.status, "cancelled", "a shutdown is NOT a user cancellation");
    assert.notEqual(interrupted.status, "ready");
    assert.deepEqual(failCalls, [], "store.failJob must never be called by shutdown");
    assert.deepEqual(cancelCalls, [], "store.cancelJob must never be called by shutdown");

    // ── The next process owns the transition ────────────────────────────────
    store.recover();
    assertRestartRecovered(jobId);
  });

  it("removes the interrupted job's work directory even though the row stays active", async () => {
    const jobId = queueJob();
    const entered = { value: false };
    let observedWorkDir = "";

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        observedWorkDir = ctx.workDir;
        await writeFile(join(ctx.workDir, "partial.mp4"), "PARTIAL-BYTES");
        entered.value = true;
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AppError("PROCESSING_FAILED", "aborted");
      },
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    const execution = executor.execute(claimed);
    await waitFor(() => entered.value, "download to start");

    assert.equal(observedWorkDir, join(canonicalJobsRoot, jobId));
    assert.equal(existsSync(observedWorkDir), true, "the work directory exists while running");

    executor.abortActiveForShutdown();
    await execution;

    assert.equal(
      existsSync(observedWorkDir),
      false,
      "the per-job work directory is removed by the OLD process",
    );
    assert.equal(store.getJob(jobId)?.status, "downloading", "cleanup did not touch durable state");

    store.recover();
    assertRestartRecovered(jobId);
  });

  it("returns 0 and does nothing when no execution is active", () => {
    const executor = new JobExecutor(store, new MemoryWriter());
    assert.equal(executor.abortActiveForShutdown(), 0);
    assert.deepEqual(cancelCalls, []);
    assert.deepEqual(failCalls, []);
  });

  it("does NOT disturb a job that already committed a terminal ready state", async () => {
    const jobId = queueJob();
    const writer = new MemoryWriter();

    const executor = new JobExecutor(store, writer, () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        const filePath = join(ctx.workDir, "original.mp4");
        await writeFile(filePath, "SHUTDOWN-MEDIA-BYTES");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 20 };
      },
      processLocally: async () => {
        throw new Error("keep-original must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    await executor.execute(claimed);

    assert.equal(store.getJob(jobId)?.status, "ready");

    // A shutdown arriving after the terminal write changes nothing, and the
    // next boot's recovery must not reopen a terminal row either.
    assert.equal(executor.abortActiveForShutdown(), 0);
    assert.equal(store.getJob(jobId)?.status, "ready", "first-terminal-wins is preserved");
    store.recover();
    assert.equal(store.getJob(jobId)?.status, "ready", "recover() never overwrites a ready row");
    assert.deepEqual(cancelCalls, []);
  });

  it("aborts every concurrently registered execution", async () => {
    const controllers = new Map<string, AbortController>();
    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), controllers);

    const a = new AbortController();
    const b = new AbortController();
    controllers.set("a".repeat(32), a);
    controllers.set("b".repeat(32), b);

    assert.equal(executor.abortActiveForShutdown(), 2);
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, true);
    assert.deepEqual(cancelCalls, [], "no durable cancellation was written");
  });

  it("recovers EVERY genuinely interrupted execution deterministically", async () => {
    const firstId = queueJob();
    const secondId = queueJob();
    const entered = new Set<string>();

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        entered.add(ctx.workDir);
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AppError("PROCESSING_FAILED", "aborted");
      },
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const first = store.claimNextQueuedJob();
    const second = store.claimNextQueuedJob();
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.jobId, second.jobId);

    const executions = [executor.execute(first), executor.execute(second)];
    await waitFor(() => entered.size === 2, "both downloads to start");
    assert.equal(executor.activeJobCount, 2);

    assert.equal(executor.abortActiveForShutdown(), 2, "every active execution was signalled");
    await Promise.all(executions);

    assert.equal(store.getJob(firstId)?.status, "downloading");
    assert.equal(store.getJob(secondId)?.status, "downloading");
    assert.deepEqual(failCalls, [], "neither job was ordinary-failed by the dying process");

    store.recover();
    assertRestartRecovered(firstId);
    assertRestartRecovered(secondId);
  });

  it("leaves a still-queued job queued for the next boot", async () => {
    const jobId = queueJob();
    const executor = new JobExecutor(store, new MemoryWriter());

    // Nothing was claimed, so shutdown has no active execution to abort and the
    // durable row is untouched.
    assert.equal(executor.abortActiveForShutdown(), 0);
    assert.equal(store.getJob(jobId)?.status, "queued");

    // Recovery must not sweep queued work: it stays eligible for the next boot.
    store.recover();
    assert.equal(store.getJob(jobId)?.status, "queued", "queued stays queued through recovery");
  });

  it("preserves an explicit user cancellation that won before shutdown", async () => {
    const jobId = queueJob();
    const entered = { value: false };

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: blockingDirectDownload(entered),
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    const execution = executor.execute(claimed);
    await waitFor(() => entered.value, "download to start");

    // A real user cancellation wins the terminal transition FIRST.
    const cancelled = executor.cancel(jobId);
    assert.equal(cancelled.type, "cancelled");

    // A later shutdown abort must not overwrite that terminal state.
    executor.abortActiveForShutdown();
    await execution;

    assert.equal(store.getJob(jobId)?.status, "cancelled", "the user cancellation still wins");
    assert.deepEqual(cancelCalls, [jobId], "only the explicit cancel called cancelJob");

    // Nor may the next boot's recovery reopen it.
    store.recover();
    assert.equal(store.getJob(jobId)?.status, "cancelled");
  });

  it("keeps `cancelled` authoritative when cancel wins the CAS AFTER the shutdown abort", async () => {
    const jobId = queueJob();
    const entered = { value: false };
    const released = { value: false };

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        entered.value = true;
        // Parks past the abort so the durable cancellation lands in the window
        // BETWEEN the shutdown abort and the executor's catch. The wait is
        // deadline-bounded so a failed assertion below can never wedge the
        // test runner on a promise that is only released on the happy path.
        await new Promise<void>((resolve) => {
          const deadline = Date.now() + 5000;
          const finish = () => {
            if (released.value || Date.now() >= deadline) resolve();
            else setTimeout(finish, 5);
          };
          ctx.signal?.addEventListener("abort", finish, { once: true });
        });
        throw new AppError("PROCESSING_FAILED", "aborted");
      },
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    const execution = executor.execute(claimed);
    await waitFor(() => entered.value, "download to start");

    // Shutdown aborts FIRST …
    const abortedCount = executor.abortActiveForShutdown();
    // … and only then does the user's cancellation win the durable CAS.
    const cancelled = store.cancelJob(jobId);
    // Released unconditionally: the acquisition must unblock whatever the
    // assertions below conclude.
    released.value = true;
    await execution;

    assert.equal(abortedCount, 1);
    assert.equal(
      cancelled.type,
      "cancelled",
      "shutdown must leave the row cancellable — it writes no terminal state of its own",
    );

    assert.equal(
      store.getJob(jobId)?.status,
      "cancelled",
      "cancellation checked first stays authoritative over a shutdown abort",
    );

    // `cancelled` is terminal, so startup recovery leaves it alone.
    store.recover();
    assert.equal(store.getJob(jobId)?.status, "cancelled");
  });

  it("still writes an ORDINARY failure when an execution fails without a shutdown", async () => {
    const jobId = queueJob();

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async () => {
        throw new AppError("PROCESSING_FAILED", "upstream blew up");
      },
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    await executor.execute(claimed);

    const view = store.getJob(jobId);
    assert.equal(view?.status, "failed");
    assert.equal(view?.errorCode, "PROCESSING_FAILED");
    assert.equal(
      view?.safeErrorMessage,
      "We couldn't process this video. Try another format or source.",
      "an ordinary failure keeps the generic safe message",
    );
    assert.equal(failCalls.length, 1, "the ordinary classifier still runs");
  });

  it("still writes TIMEOUT for an ordinary timeout", async () => {
    const jobId = queueJob();

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async () => {
        throw new AppError("TIMEOUT");
      },
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    await executor.execute(claimed);

    const view = store.getJob(jobId);
    assert.equal(view?.status, "failed");
    assert.equal(view?.errorCode, "TIMEOUT");
    assert.equal(view?.safeErrorMessage, "The video took too long to process.");
  });

  it("still writes NETWORK_ERROR for an ordinary network failure", async () => {
    const jobId = queueJob();

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), new Map(), {
      analyze: async () => metadata(),
      downloadOriginal: async () => {
        throw new AppError("NETWORK_ERROR");
      },
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    await executor.execute(claimed);

    const view = store.getJob(jobId);
    assert.equal(view?.status, "failed");
    assert.equal(view?.errorCode, "NETWORK_ERROR");
    assert.equal(view?.safeErrorMessage, "We couldn't connect to the source website.");
  });

  it("does NOT suppress a failure merely because an unmarked abort happened", async () => {
    const jobId = queueJob();
    const controllers = new Map<string, AbortController>();

    const executor = new JobExecutor(store, new MemoryWriter(), () => Date.now(), controllers, {
      analyze: async () => metadata(),
      downloadOriginal: async (_url, ctx) => {
        // An abort that did NOT come from operator shutdown — exactly what the
        // halted progress reporter does when a terminal state was observed.
        controllers.get(jobId)?.abort(new AppError("PROCESSING_FAILED"));
        assert.equal(ctx.signal?.aborted, true);
        throw new AppError("PROCESSING_FAILED", "aborted for an unrelated reason");
      },
      processLocally: async () => {
        throw new Error("must not process");
      },
    });

    const claimed = store.claimNextQueuedJob();
    assert.ok(claimed);
    await executor.execute(claimed);

    const view = store.getJob(jobId);
    assert.equal(
      view?.status,
      "failed",
      "an aborted signal alone is not shutdown provenance",
    );
    assert.equal(view?.errorCode, "PROCESSING_FAILED");
    assert.equal(
      view?.safeErrorMessage,
      "We couldn't process this video. Try another format or source.",
    );
  });
});
