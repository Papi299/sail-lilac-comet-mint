import type { DatabaseSync } from "node:sqlite";
import type { WorkerReplayStore } from "./replay-store.ts";

import { WorkerRequestIdSchema } from "../../shared/worker/auth.ts";

export class SQLiteWorkerReplayStore implements WorkerReplayStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;

  constructor(
    db: DatabaseSync,
    clock: () => number = () => Math.floor(Date.now() / 1000)
  ) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * Centralized validated epoch-seconds clock.
   * Captures the clock ONCE per call. All replay seconds timestamps
   * within a single operation use this captured value.
   */
  private nowSeconds(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Replay clock generated an invalid or unsafe epoch-seconds value");
    }
    return now;
  }

  async reserve(requestId: string, expiresAtSeconds: number): Promise<"reserved" | "duplicate"> {
    const validRequestId = WorkerRequestIdSchema.parse(requestId);
    
    if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds < 0) {
      throw new Error("expiresAtSeconds must be a nonnegative safe integer");
    }
    
    // Capture clock ONCE for the entire reservation decision
    const now = this.nowSeconds();

    if (expiresAtSeconds <= now) {
      throw new Error("expiresAtSeconds must be in the future");
    }

    // Cleanup expired entries using captured `now`
    const cleanupStmt = this.db.prepare(`
      DELETE FROM worker_replay_requests
      WHERE expires_at_seconds < ?
    `);
    cleanupStmt.run(now);

    // Insert with captured `now` as created_at_seconds
    const stmt = this.db.prepare(`
      INSERT INTO worker_replay_requests (request_id, expires_at_seconds, created_at_seconds)
      VALUES (?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `);

    const result = stmt.run(validRequestId, expiresAtSeconds, now);

    if (result.changes === 1) {
      return "reserved";
    }
    return "duplicate";
  }

  /**
   * Explicit cleanup of expired replay reservations.
   * Uses a separately validated captured current time.
   */
  cleanup(): void {
    const now = this.nowSeconds();
    const stmt = this.db.prepare(`
      DELETE FROM worker_replay_requests
      WHERE expires_at_seconds < ?
    `);
    stmt.run(now);
  }
}
