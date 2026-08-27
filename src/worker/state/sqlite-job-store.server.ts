import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  WorkerJobViewSchema,
  WorkerCreateJobRequestSchema,
  type WorkerJobView,
  type WorkerCreateJobRequest
} from "../../shared/worker/contracts.ts";
import { WorkerErrorCodeSchema } from "../../shared/worker/errors.ts";
import type { WorkerJobStore, CreateJobResult } from "./job-store.ts";
import { generateIdempotencyFingerprint, WORKER_IDEMPOTENCY_MIN_RETENTION_MS } from "./idempotency.server.ts";

export interface SQLiteJobStoreOptions {
  db: DatabaseSync;
  jobTtlMs?: number;
  clock?: () => number;
  generateJobId?: () => string;
}

function rowToJobView(row: any): WorkerJobView {
  const data = {
    jobId: row.job_id,
    status: row.status,
    progress: row.progress,
    stageLabel: row.stage_label,
    downloadedBytes: row.downloaded_bytes,
    totalBytes: row.total_bytes,
    speed: row.speed,
    eta: row.eta,
    errorCode: row.error_code,
    safeErrorMessage: row.safe_error_message,
    filename: row.filename,
    fileSize: row.file_size,
    mime: row.mime,
    quality: row.quality,
    container: row.container,
    title: row.title,
    thumbnail: row.thumbnail,
    source: row.source,
    extractor: row.extractor,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    expiresAt: row.expires_at_ms,
    objectKey: row.object_key,
  };
  return WorkerJobViewSchema.parse(data);
}

export class SQLiteJobStore implements WorkerJobStore {
  private db: DatabaseSync;
  private jobTtlMs: number;
  private clock: () => number;
  private generateJobId: () => string;

  constructor(options: SQLiteJobStoreOptions) {
    this.db = options.db;
    if (options.jobTtlMs !== undefined && (!Number.isSafeInteger(options.jobTtlMs) || options.jobTtlMs <= 0)) {
      throw new Error("jobTtlMs must be a positive safe integer");
    }
    this.jobTtlMs = options.jobTtlMs ?? 45 * 60 * 1000;
    this.clock = options.clock ?? (() => Date.now());
    this.generateJobId = options.generateJobId ?? (() => randomBytes(16).toString("hex"));
  }

  createJob(request: WorkerCreateJobRequest, idempotencyKey: string): CreateJobResult {
    const validRequest = WorkerCreateJobRequestSchema.parse(request);
    const payloadHash = generateIdempotencyFingerprint(validRequest);
    const now = this.clock();

    // Expire old idempotency records before processing
    this.cleanupIdempotency(now);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Check for existing idempotency record
      const idempStmt = this.db.prepare("SELECT * FROM worker_idempotency_records WHERE idempotency_key = ?");
      const existingIdemp = idempStmt.get(idempotencyKey) as any;

      if (existingIdemp) {
        // Expiration is checked implicitly or explicitly (we already ran cleanup, but just in case)
        if (existingIdemp.expires_at_ms > now) {
          if (existingIdemp.payload_hash !== payloadHash) {
            this.db.exec("COMMIT");
            return { type: "conflict" };
          }

          if (existingIdemp.job_expires_at_ms <= now) {
            this.db.exec("COMMIT");
            return { type: "expired" };
          }

          const jobStmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
          const jobRow = jobStmt.get(existingIdemp.job_id);

          this.db.exec("COMMIT");

          if (!jobRow) {
            // Missing job, surviving tombstone
            return { type: "expired" }; // Safe logical result
          }

          return { type: "existing", job: rowToJobView(jobRow) };
        } else {
            // Delete expired idempotency key explicitly and allow reuse below
            const delStmt = this.db.prepare("DELETE FROM worker_idempotency_records WHERE idempotency_key = ?");
            delStmt.run(idempotencyKey);
        }
      }

      // New key or reused expired key
      const jobId = this.generateJobId();
      const jobExpiresAt = now + this.jobTtlMs;
      const idempotencyExpiresAt = Math.max(now + WORKER_IDEMPOTENCY_MIN_RETENTION_MS, jobExpiresAt);

      const insertJobStmt = this.db.prepare(`
        INSERT INTO worker_jobs (
          job_id, url, format_id, principal_id, status,
          created_at_ms, updated_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
      `);
      insertJobStmt.run(
        jobId, validRequest.url, validRequest.formatId, validRequest.principalId,
        now, now, jobExpiresAt
      );

      const insertIdempStmt = this.db.prepare(`
        INSERT INTO worker_idempotency_records (
          idempotency_key, payload_hash, job_id,
          created_at_ms, job_expires_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertIdempStmt.run(
        idempotencyKey, payloadHash, jobId,
        now, jobExpiresAt, idempotencyExpiresAt
      );

      this.db.exec("COMMIT");

      const jobStmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
      const newJobRow = jobStmt.get(jobId);
      
      return { type: "created", job: rowToJobView(newJobRow) };

    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getJob(jobId: string): WorkerJobView | null {
    const stmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
    const row = stmt.get(jobId);
    if (!row) return null;
    return rowToJobView(row);
  }

  listQueuedJobs(limit: number): WorkerJobView[] {
    const now = this.clock();
    const stmt = this.db.prepare("SELECT * FROM worker_jobs WHERE status = 'queued' AND expires_at_ms > ? ORDER BY created_at_ms ASC, job_id ASC LIMIT ?");
    const rows = stmt.all(now, limit);
    return rows.map(rowToJobView);
  }

  claimNextQueuedJob(): WorkerJobView | null {
    const now = this.clock();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const selectStmt = this.db.prepare(`
        SELECT * FROM worker_jobs 
        WHERE status = 'queued' AND expires_at_ms > ? 
        ORDER BY created_at_ms ASC, job_id ASC 
        LIMIT 1
      `);
      const row = selectStmt.get(now) as any;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      const updateStmt = this.db.prepare(`
        UPDATE worker_jobs 
        SET status = 'analyzing', 
            started_at_ms = COALESCE(started_at_ms, ?), 
            updated_at_ms = ? 
        WHERE job_id = ? AND status = 'queued'
      `);
      updateStmt.run(now, now, row.job_id);

      this.db.exec("COMMIT");
      
      const newStmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
      const newRow = newStmt.get(row.job_id);
      return rowToJobView(newRow);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  cancelJob(jobId: string): boolean {
    const now = this.clock();
    const stmt = this.db.prepare(`
      UPDATE worker_jobs 
      SET status = 'cancelled', updated_at_ms = ? 
      WHERE job_id = ? AND status IN ('queued', 'analyzing', 'downloading', 'processing', 'uploading')
    `);
    const result = stmt.run(now, jobId);
    return result.changes === 1;
  }

  failJob(jobId: string, errorCode: string, errorMessage: string): boolean {
    const validErrorCode = WorkerErrorCodeSchema.parse(errorCode);
    const now = this.clock();
    const stmt = this.db.prepare(`
      UPDATE worker_jobs 
      SET status = 'failed', 
          error_code = ?, 
          safe_error_message = ?, 
          updated_at_ms = ?,
          finished_at_ms = COALESCE(finished_at_ms, ?)
      WHERE job_id = ? AND status IN ('queued', 'analyzing', 'downloading', 'processing', 'uploading')
    `);
    const result = stmt.run(validErrorCode, errorMessage, now, now, jobId);
    return result.changes === 1;
  }

  recover(): void {
    const now = this.clock();
    const stmt = this.db.prepare(`
      UPDATE worker_jobs 
      SET status = 'failed',
          error_code = 'PROCESSING_FAILED',
          safe_error_message = 'Worker restarted before the job completed.',
          stage_label = 'Worker restarted',
          updated_at_ms = ?,
          finished_at_ms = COALESCE(finished_at_ms, ?)
      WHERE status IN ('analyzing', 'downloading', 'processing', 'uploading')
    `);
    stmt.run(now, now);
  }

  cleanupIdempotency(nowOverride?: number): void {
    const now = nowOverride ?? this.clock();
    const stmt = this.db.prepare("DELETE FROM worker_idempotency_records WHERE expires_at_ms <= ?");
    stmt.run(now);
  }
}
