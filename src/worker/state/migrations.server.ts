import type { DatabaseSync } from "node:sqlite";

export const WORKER_SCHEMA_VERSION = 1;

export function applyMigrations(db: DatabaseSync): void {
  const versionQuery = db.prepare("PRAGMA user_version");
  const currentVersionObj = versionQuery.get() as { user_version: number };
  const currentVersion = currentVersionObj.user_version;

  if (currentVersion > WORKER_SCHEMA_VERSION) {
    throw new Error(`Unsupported future schema version: ${currentVersion}. Max supported is ${WORKER_SCHEMA_VERSION}.`);
  }

  if (currentVersion === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE worker_replay_requests (
          request_id TEXT PRIMARY KEY,
          expires_at_seconds INTEGER NOT NULL,
          created_at_seconds INTEGER
        ) STRICT;
        CREATE INDEX idx_worker_replay_requests_expires_at_seconds ON worker_replay_requests(expires_at_seconds);
      `);

      db.exec(`
        CREATE TABLE worker_jobs (
          job_id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          format_id TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued', 'analyzing', 'downloading', 'processing', 'uploading', 'ready', 'failed', 'cancelled')),
          progress INTEGER,
          stage_label TEXT,
          downloaded_bytes INTEGER,
          total_bytes INTEGER,
          speed INTEGER,
          eta INTEGER,
          error_code TEXT,
          safe_error_message TEXT,
          filename TEXT,
          file_size INTEGER,
          mime TEXT,
          quality TEXT,
          container TEXT,
          title TEXT,
          thumbnail TEXT,
          source TEXT,
          extractor TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          object_key TEXT,
          started_at_ms INTEGER,
          finished_at_ms INTEGER,
          CHECK(expires_at_ms >= created_at_ms),
          CHECK(progress IS NULL OR (progress >= 0 AND progress <= 100)),
          CHECK(downloaded_bytes IS NULL OR downloaded_bytes >= 0),
          CHECK(total_bytes IS NULL OR total_bytes >= 0),
          CHECK(speed IS NULL OR speed >= 0),
          CHECK(eta IS NULL OR eta >= 0),
          CHECK(file_size IS NULL OR file_size >= 0)
        ) STRICT;
      `);

      db.exec(`
        CREATE TABLE worker_idempotency_records (
          idempotency_key TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          job_id TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          job_expires_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_worker_idempotency_records_expires_at_ms ON worker_idempotency_records(expires_at_ms);
      `);

      db.exec(`PRAGMA user_version = ${WORKER_SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
