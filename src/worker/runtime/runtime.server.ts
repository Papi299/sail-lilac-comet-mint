import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { JobExecutor, type JobExecutorDeps } from "../execution/job-executor.server.ts";
import { QueuePump } from "../execution/queue-pump.server.ts";
import { QueueRunner } from "../execution/queue-runner.server.ts";
import type { AnalyzeFn } from "../http/business-service.server.ts";
import { WorkerService } from "../http/business-service.server.ts";
import type { WorkerBinaryProbe } from "../http/binaries.server.ts";
import { createWorkerServer } from "../http/server.server.ts";
import { SQLiteWorkerReplayStore } from "../security/sqlite-replay-store.server.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import { CloudflareR2ObjectStoreWriter } from "../storage/cloudflare-r2-writer.server.ts";
import type { ObjectStoreWriter } from "../storage/writer.ts";
import type { WorkerRuntimeConfig } from "./config.server.ts";
import {
  WorkerMaintenance,
  type WorkerMaintenanceCategory,
  type WorkerMaintenanceDeps,
} from "./maintenance.server.ts";
import { prepareWorkerStateDirectory } from "./state-directory.server.ts";

/**
 * Production Worker composition root (Phase 8A §14).
 *
 * Importing this module does NOTHING. It defines a factory; the executable
 * layer (`main.server.ts`) is the only place allowed to run it, listen, install
 * signal handlers or touch the process. There is no service locator, no global
 * mutable state, and no test-only fallback behaviour — every seam is an
 * explicit dependency-injection parameter on the factory.
 */

/** Bounded shutdown grace before lingering connections are forced closed. */
export const WORKER_SHUTDOWN_GRACE_MS = 10_000;

/**
 * A `QueueRunner` that stops claiming new work once shutdown begins.
 *
 * This is NOT a second queue implementation: it delegates to the single
 * authoritative `QueueRunner` and only adds a one-way gate. Returning `idle`
 * lets the existing single-flight pump loop wind itself down naturally, which
 * is exactly what "do not start additional queued jobs" requires (§22).
 */
class ShutdownAwareQueueRunner extends QueueRunner {
  private claiming = true;

  public stopClaiming(): void {
    this.claiming = false;
  }

  public override async runNext(): Promise<
    { type: "idle" } | { type: "executed"; jobId: string }
  > {
    if (!this.claiming) return { type: "idle" };
    return super.runNext();
  }
}

export type WorkerRuntimeOverrides = {
  /**
   * Replaces the production Cloudflare R2 writer. Tests inject a fake here so
   * no live object-store request can occur.
   */
  objectStoreWriter?: ObjectStoreWriter;
  /** Injected S3 send-client for the real R2 writer (no network at construction). */
  r2Client?: ConstructorParameters<typeof CloudflareR2ObjectStoreWriter>[1];
  clock?: () => number;
  analyze?: AnalyzeFn;
  probeBinaries?: WorkerBinaryProbe;
  executorDeps?: JobExecutorDeps;
  jobTtlMs?: number;
  maintenanceIntervalMs?: number;
  maintenanceBatchSize?: number;
  maintenanceTimers?: Pick<WorkerMaintenanceDeps, "setIntervalFn" | "clearIntervalFn">;
  shutdownGraceMs?: number;
  /** Category label only — never an error object. */
  onMaintenanceError?: (category: WorkerMaintenanceCategory) => void;
  /** Called when the queue pump stops on a store failure. No raw error is passed. */
  onQueueError?: () => void;
};

export type WorkerRuntime = {
  readonly config: WorkerRuntimeConfig;
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly db: DatabaseSync;
  readonly store: SQLiteJobStore;
  readonly replayStore: SQLiteWorkerReplayStore;
  readonly writer: ObjectStoreWriter;
  readonly executor: JobExecutor;
  readonly runner: QueueRunner;
  readonly pump: QueuePump;
  readonly service: WorkerService;
  readonly server: Server;
  readonly maintenance: WorkerMaintenance;
  /** Binds the HTTP listener. Only legal after construction succeeded. */
  listen(): Promise<{ host: string; port: number }>;
  /** Resumes durable queued work that survived a restart. */
  wakeQueue(): void;
  /** Ordered, bounded graceful shutdown. Safe to call more than once. */
  shutdown(): Promise<void>;
};

/**
 * Builds the full Worker runtime.
 *
 * Mandatory initialization order (§11) — every step must succeed before the
 * next begins, and the caller must not `listen()` until this resolves:
 *
 *   validated config → persistent directory → openWorkerDatabase →
 *   applyMigrations → SQLiteJobStore → store.recover() →
 *   SQLiteWorkerReplayStore → writer → executor → runner → pump →
 *   service → server → maintenance
 *
 * An unsupported future schema, a corrupt V1 schema, or a failed recovery all
 * reject here. Nothing recreates or discards an existing incompatible database.
 */
export async function createWorkerRuntime(
  config: WorkerRuntimeConfig,
  overrides: WorkerRuntimeOverrides = {},
): Promise<WorkerRuntime> {
  const prepared = await prepareWorkerStateDirectory(config.dataDirectory);

  const db = openWorkerDatabase({ path: prepared.databasePath });

  // From here on any failure must close the database before propagating,
  // otherwise a failed startup would leak the file handle and its WAL.
  try {
    applyMigrations(db);

    const store = new SQLiteJobStore({
      db,
      ...(overrides.jobTtlMs !== undefined ? { jobTtlMs: overrides.jobTtlMs } : {}),
      ...(overrides.clock ? { clock: overrides.clock } : {}),
    });

    // Conservative startup recovery, BEFORE anything can listen or execute:
    // queued stays queued, interrupted active work fails deterministically,
    // ready and terminal rows are left exactly as they are.
    store.recover();

    const replayStore = new SQLiteWorkerReplayStore(
      db,
      overrides.clock
        ? () => Math.floor(overrides.clock!() / 1000)
        : undefined,
    );

    // Worker-side WRITE credentials only. The Vercel signer identity is never
    // read by this process, and constructing the client performs no request:
    // the first R2 call happens during media execution or maintenance.
    const writer: ObjectStoreWriter =
      overrides.objectStoreWriter ??
      new CloudflareR2ObjectStoreWriter(
        {
          accountId: config.r2.accountId,
          bucket: config.r2.bucket,
          jurisdiction: config.r2.jurisdiction,
          accessKeyId: config.r2.accessKeyId,
          secretAccessKey: config.r2.secretAccessKey,
          ...(config.r2.sessionToken !== undefined
            ? { sessionToken: config.r2.sessionToken }
            : {}),
        },
        overrides.r2Client,
      );

    const executor = new JobExecutor(
      store,
      writer,
      overrides.clock,
      new Map(),
      overrides.executorDeps ?? {},
    );

    const runner = new ShutdownAwareQueueRunner(store, executor);
    const pump = new QueuePump(runner, () => overrides.onQueueError?.());

    const service = new WorkerService({
      store,
      executor,
      pump,
      ...(overrides.analyze ? { analyze: overrides.analyze } : {}),
      ...(overrides.probeBinaries ? { probeBinaries: overrides.probeBinaries } : {}),
      ...(overrides.clock ? { clock: overrides.clock } : {}),
    });

    const server = createWorkerServer(
      {
        currentKeyId: config.control.currentKeyId,
        currentSecret: config.control.currentSecret,
        ...(config.control.previousKeyId !== undefined &&
        config.control.previousSecret !== undefined
          ? {
              previousKeyId: config.control.previousKeyId,
              previousSecret: config.control.previousSecret,
            }
          : {}),
        replayStore,
        ...(overrides.clock
          ? { clock: () => Math.floor(overrides.clock!() / 1000) }
          : {}),
      },
      service,
    );

    const maintenance = new WorkerMaintenance({
      store,
      replayStore,
      writer,
      ...(overrides.maintenanceIntervalMs !== undefined
        ? { intervalMs: overrides.maintenanceIntervalMs }
        : {}),
      ...(overrides.maintenanceBatchSize !== undefined
        ? { batchSize: overrides.maintenanceBatchSize }
        : {}),
      ...(overrides.onMaintenanceError ? { onError: overrides.onMaintenanceError } : {}),
      ...(overrides.maintenanceTimers ?? {}),
    });

    const graceMs = overrides.shutdownGraceMs ?? WORKER_SHUTDOWN_GRACE_MS;
    let shutdownPromise: Promise<void> | null = null;

    const runtime: WorkerRuntime = {
      config,
      stateDirectory: prepared.directory,
      databasePath: prepared.databasePath,
      db,
      store,
      replayStore,
      writer,
      executor,
      runner,
      pump,
      service,
      server,
      maintenance,

      listen(): Promise<{ host: string; port: number }> {
        return new Promise((resolve, reject) => {
          const onError = (err: unknown) => {
            server.removeListener("listening", onListening);
            reject(err);
          };
          const onListening = () => {
            server.removeListener("error", onError);
            const address = server.address();
            resolve(
              address && typeof address === "object"
                ? { host: address.address, port: address.port }
                : { host: config.bindHost, port: config.port },
            );
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(config.port, config.bindHost);
        });
      },

      wakeQueue(): void {
        pump.wake();
      },

      shutdown(): Promise<void> {
        shutdownPromise ??= performShutdown();
        return shutdownPromise;
      },
    };

    async function performShutdown(): Promise<void> {
      // 1. Stop periodic maintenance and let any in-flight pass settle.
      await maintenance.stop();

      // 2. Refuse to claim further queued work. Already-durable queued rows
      //    stay queued for the next boot — they are NOT cancelled.
      runner.stopClaiming();

      // 3. Stop accepting new HTTP connections.
      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      server.closeIdleConnections?.();

      // 4. Abort in-flight media so no FFmpeg descendant outlives the process.
      //    This never writes a `cancelled` state — a restart is not a user
      //    cancellation.
      executor.abortActiveForShutdown();

      // 5. Bounded grace. Whatever has not finished by now is forced closed.
      const graceTimer = setTimeout(() => {
        server.closeAllConnections?.();
      }, graceMs);
      graceTimer.unref?.();

      try {
        await withTimeout(closed, graceMs, () => server.closeAllConnections?.());
        await withTimeout(pump.whenDrained(), graceMs, () => {});
      } finally {
        clearTimeout(graceTimer);
      }

      // 6. SQLite closes LAST, strictly after new HTTP work has stopped.
      try {
        db.close();
      } catch {
        /* an already-closed database must not turn shutdown into a failure */
      }
    }

    return runtime;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* the original startup failure is the one that matters */
    }
    throw err;
  }
}

/** Resolves when `promise` settles or the bound elapses, whichever is first. */
async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([promise.then(() => {}).catch(() => {}), bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
