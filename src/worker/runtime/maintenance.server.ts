import type { WorkerJobStore } from "../state/job-store.ts";
import type { ObjectStoreWriter } from "../storage/writer.ts";

/**
 * Worker lifecycle maintenance (Phase 8A §18–§21).
 *
 * Nothing runs at module import. A timer exists only after an explicit
 * `start()`, two runs can never overlap, every batch is bounded, and a failure
 * in one category is contained so the HTTP runtime keeps serving.
 *
 * Diagnostics are counted, never narrated: a provider error message could carry
 * credentials, bucket identifiers or request metadata, so raw errors are dropped
 * at the boundary and only a category label is ever reported.
 */

/** Modest interval. Expiration is enforced by `expiresAt`, not by this timer. */
export const WORKER_MAINTENANCE_INTERVAL_MS = 60_000;

/** Bounded per-run scan. The store itself caps this at 1000. */
export const WORKER_MAINTENANCE_BATCH_SIZE = 50;

export type WorkerMaintenanceCategory =
  | "replay_cleanup"
  | "idempotency_cleanup"
  | "expired_object_scan"
  | "expired_object_delete"
  | "expired_metadata_delete";

export type WorkerMaintenanceReport = {
  replayCleanup: "ok" | "failed";
  idempotencyCleanup: "ok" | "failed";
  idempotencyRecordsDeleted: number;
  expiredObjects: {
    scan: "ok" | "failed";
    scanned: number;
    objectsDeleted: number;
    objectDeleteFailures: number;
    metadataDeleted: number;
    metadataDeleteFailures: number;
  };
};

/** The only replay-store capability maintenance needs. */
export interface WorkerReplayCleanup {
  cleanup(): void;
}

/** Injectable timer hooks so tests never wait wall-clock minutes. */
export type WorkerMaintenanceTimerHandle = { unref?: () => unknown };

export type WorkerMaintenanceDeps = {
  store: WorkerJobStore;
  replayStore: WorkerReplayCleanup;
  writer: ObjectStoreWriter;
  intervalMs?: number;
  batchSize?: number;
  /** Receives a category label ONLY. Never an error object or message. */
  onError?: (category: WorkerMaintenanceCategory) => void;
  setIntervalFn?: (handler: () => void, ms: number) => WorkerMaintenanceTimerHandle;
  clearIntervalFn?: (handle: WorkerMaintenanceTimerHandle) => void;
};

function emptyReport(): WorkerMaintenanceReport {
  return {
    replayCleanup: "ok",
    idempotencyCleanup: "ok",
    idempotencyRecordsDeleted: 0,
    expiredObjects: {
      scan: "ok",
      scanned: 0,
      objectsDeleted: 0,
      objectDeleteFailures: 0,
      metadataDeleted: 0,
      metadataDeleteFailures: 0,
    },
  };
}

export class WorkerMaintenance {
  private readonly store: WorkerJobStore;
  private readonly replayStore: WorkerReplayCleanup;
  private readonly writer: ObjectStoreWriter;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly onError: (category: WorkerMaintenanceCategory) => void;
  private readonly setIntervalFn: (handler: () => void, ms: number) => WorkerMaintenanceTimerHandle;
  private readonly clearIntervalFn: (handle: WorkerMaintenanceTimerHandle) => void;

  private timer: WorkerMaintenanceTimerHandle | null = null;
  private inFlight: Promise<WorkerMaintenanceReport> | null = null;
  private stopped = false;

  constructor(deps: WorkerMaintenanceDeps) {
    this.store = deps.store;
    this.replayStore = deps.replayStore;
    this.writer = deps.writer;

    const intervalMs = deps.intervalMs ?? WORKER_MAINTENANCE_INTERVAL_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("maintenance intervalMs must be a positive safe integer");
    }
    this.intervalMs = intervalMs;

    const batchSize = deps.batchSize ?? WORKER_MAINTENANCE_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 1000) {
      throw new Error("maintenance batchSize must be a safe integer between 1 and 1000");
    }
    this.batchSize = batchSize;

    this.onError = deps.onError ?? (() => {});
    this.setIntervalFn =
      deps.setIntervalFn ??
      ((handler, ms) => setInterval(handler, ms) as unknown as WorkerMaintenanceTimerHandle);
    this.clearIntervalFn =
      deps.clearIntervalFn ??
      ((handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>));
  }

  /** True while a maintenance pass is in flight. */
  public get isRunning(): boolean {
    return this.inFlight !== null;
  }

  /** True while the periodic timer is installed. */
  public get isStarted(): boolean {
    return this.timer !== null;
  }

  /**
   * Starts the periodic timer. Idempotent, and a no-op after `stop()` so a late
   * tick can never resurrect maintenance during shutdown.
   */
  public start(): void {
    if (this.timer !== null || this.stopped) return;

    const handle = this.setIntervalFn(() => {
      // The tick owns its own rejection. `runOnce()` already contains every
      // category failure, so this is a belt-and-braces guard against an
      // unexpected throw becoming an unhandled rejection.
      void this.runOnce().catch(() => {});
    }, this.intervalMs);

    // Maintenance must never hold the event loop open on its own.
    handle?.unref?.();
    this.timer = handle;
  }

  /**
   * Stops the timer and waits for any in-flight pass to settle. After this the
   * service is permanently stopped; `start()` will not re-arm it.
   */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => {});
    }
  }

  /**
   * Runs one bounded maintenance pass.
   *
   * Overlap is structurally impossible: a call arriving while a pass is in
   * flight joins that pass instead of starting a second one.
   */
  public runOnce(): Promise<WorkerMaintenanceReport> {
    if (this.inFlight) return this.inFlight;

    const run = this.execute().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async execute(): Promise<WorkerMaintenanceReport> {
    const report = emptyReport();

    // 1. Replay reservations. Contained: a failure here must not stop the
    //    idempotency or object cleanup that follows.
    try {
      this.replayStore.cleanup();
    } catch {
      report.replayCleanup = "failed";
      this.onError("replay_cleanup");
    }

    // 2. Retained idempotency records past their retention window.
    try {
      report.idempotencyRecordsDeleted = this.store.cleanupExpiredIdempotencyRecords();
    } catch {
      report.idempotencyCleanup = "failed";
      this.onError("idempotency_cleanup");
    }

    // 3. Expired ready objects.
    await this.cleanupExpiredReadyObjects(report);

    return report;
  }

  /**
   * §19/§20: exact-key expiration cleanup.
   *
   * For each expired ready job: delete EXACTLY the stored object key, and only
   * once that succeeded, conditionally remove the exact durable row. There is
   * no prefix delete, no list, no wildcard and no bucket clear anywhere on this
   * path — the writer interface cannot express them.
   *
   * Ordering matters. Deleting metadata first would strand the object with no
   * record of its key; deleting the object first means a failure simply leaves
   * the row for the next pass. Either way the user's authorization is already
   * gone, because `expiresAt` has passed regardless of cleanup state.
   */
  private async cleanupExpiredReadyObjects(report: WorkerMaintenanceReport): Promise<void> {
    let expired;
    try {
      expired = this.store.listExpiredReadyObjects(this.batchSize);
    } catch {
      report.expiredObjects.scan = "failed";
      this.onError("expired_object_scan");
      return;
    }

    report.expiredObjects.scanned = expired.length;

    for (const item of expired) {
      try {
        await this.writer.delete(item.objectKey);
      } catch {
        // Retain the durable metadata so a later pass retries. A repeated
        // DeleteObject on the same exact key is safe and idempotent.
        report.expiredObjects.objectDeleteFailures += 1;
        this.onError("expired_object_delete");
        continue;
      }

      report.expiredObjects.objectsDeleted += 1;

      try {
        if (this.store.deleteExpiredReadyMetadata(item.jobId, item.objectKey)) {
          report.expiredObjects.metadataDeleted += 1;
        }
      } catch {
        // Metadata survives for retry. Nothing broad is ever attempted as a
        // fallback, and the idempotency tombstone is untouched either way.
        report.expiredObjects.metadataDeleteFailures += 1;
        this.onError("expired_metadata_delete");
      }
    }
  }
}
