import type { QueueRunner } from "./queue-runner.server.ts";

/**
 * v1 worker concurrency. The pump is strictly single-flight, so exactly one
 * job may execute at a time. Diagnostics reports this value verbatim.
 */
export const WORKER_MAX_CONCURRENT_JOBS = 1;

/**
 * Single-flight queue wake-up.
 *
 * `wake()` is a cheap, synchronous, fire-and-forget signal: it never awaits the
 * work it schedules, so an HTTP create request returns as soon as the durable
 * row is committed.
 *
 * Concurrency contract:
 *  - at most ONE drain loop exists at a time (`running` is the mutex);
 *  - the loop only ever stops in a synchronous window where `pendingWake` is
 *    false and `running` is set false in the SAME synchronous statement pair,
 *    so a `wake()` arriving while the pump is becoming idle can never be lost;
 *  - the loop is an async function whose every await is guarded, so it never
 *    rejects and can never produce an unhandled rejection;
 *  - nothing is claimed, polled, or timed at module import.
 */
export class QueuePump {
  private readonly runner: QueueRunner;
  private readonly onError: (err: unknown) => void;
  private running = false;
  private pendingWake = false;
  private loopPromise: Promise<void> = Promise.resolve();

  constructor(runner: QueueRunner, onError: (err: unknown) => void = () => {}) {
    this.runner = runner;
    this.onError = onError;
  }

  /** True while a drain loop is in flight. */
  public get isRunning(): boolean {
    return this.running;
  }

  /**
   * Signals that queued work may exist. Safe to call from any number of
   * concurrent HTTP requests; only the first starts a loop.
   */
  public wake(): void {
    this.pendingWake = true;
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  /** Test/shutdown helper: resolves once no drain loop is in flight. */
  public async whenDrained(): Promise<void> {
    while (this.running) {
      await this.loopPromise;
    }
  }

  private async loop(): Promise<void> {
    for (;;) {
      // The check and the `running = false` release are adjacent synchronous
      // statements. `wake()` can only interleave at an await point, so it
      // either observes `running === true` (and the loop below re-reads
      // `pendingWake`) or observes `running === false` and starts a new loop.
      if (!this.pendingWake) {
        this.running = false;
        return;
      }
      this.pendingWake = false;

      let result: Awaited<ReturnType<QueueRunner["runNext"]>>;
      try {
        result = await this.runner.runNext();
      } catch (err: unknown) {
        // Stop rather than hot-spin on a store failure. The next create wakes
        // the pump again, which re-attempts the claim.
        this.running = false;
        this.onError(err);
        return;
      }

      if (result.type !== "idle") {
        // Executed one job; keep draining FIFO until the queue reports idle.
        this.pendingWake = true;
      }
    }
  }
}
