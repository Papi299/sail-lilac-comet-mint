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

  async reserve(requestId: string, expiresAtSeconds: number): Promise<"reserved" | "duplicate"> {
    const validRequestId = WorkerRequestIdSchema.parse(requestId);
    
    if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds < 0) {
      throw new Error("expiresAtSeconds must be a nonnegative safe integer");
    }
    
    if (expiresAtSeconds <= this.clock()) {
      throw new Error("expiresAtSeconds must be in the future");
    }
    // Optional explicit cleanup on reserve
    this.cleanup();

    const stmt = this.db.prepare(`
      INSERT INTO worker_replay_requests (request_id, expires_at_seconds, created_at_seconds)
      VALUES (?, ?, ?)
      ON CONFLICT(request_id) DO NOTHING
    `);

    const result = stmt.run(validRequestId, expiresAtSeconds, this.clock());

    if (result.changes === 1) {
      return "reserved";
    }
    return "duplicate";
  }

  cleanup(): void {
    const stmt = this.db.prepare(`
      DELETE FROM worker_replay_requests
      WHERE expires_at_seconds < ?
    `);
    stmt.run(this.clock());
  }
}
