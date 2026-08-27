import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  WorkerJobViewSchema,
  WorkerCreateJobRequestSchema,
  WorkerJobIdSchema,
  type WorkerJobView,
  type WorkerCreateJobRequest
} from "../../shared/worker/contracts.ts";
import { WorkerIdempotencyKeySchema } from "../../shared/worker/auth.ts";
import { WorkerErrorCodeSchema } from "../../shared/worker/errors.ts";
import type { WorkerJobStore, CreateJobResult, CancelJobResult, DurableWorkerJob } from "./job-store.ts";
import { DurableWorkerJobSchema } from "./job-store.ts";
import { generateIdempotencyFingerprint, WORKER_IDEMPOTENCY_MIN_RETENTION_MS } from "./idempotency.server.ts";

export interface SQLiteJobStoreOptions {
  db: DatabaseSync;
  jobTtlMs?: number;
  clock?: () => number;
  generateJobId?: () => string;
}

function rowToDurableJob(row: any): DurableWorkerJob {
  const data = {
    jobId: row.job_id,
    url: row.url,
    formatId: row.format_id,
    principalId: row.principal_id,
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
    startedAt: row.started_at_ms,
    finishedAt: row.finished_at_ms,
  };
  return DurableWorkerJobSchema.parse(data);
}

function durableJobToView(job: DurableWorkerJob): WorkerJobView {
  const data = {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    stageLabel: job.stageLabel,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speed: job.speed,
    eta: job.eta,
    errorCode: job.errorCode,
    safeErrorMessage: job.safeErrorMessage,
    filename: job.filename,
    fileSize: job.fileSize,
    mime: job.mime,
    quality: job.quality,
    container: job.container,
    title: job.title,
    thumbnail: job.thumbnail,
    source: job.source,
    extractor: job.extractor,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    objectKey: job.objectKey,
  };
  return WorkerJobViewSchema.parse(data);
}

export class SQLiteJobStore implements WorkerJobStore {
  private readonly db: DatabaseSync;
  private readonly jobTtlMs: number;
  private readonly clock: () => number;
  private readonly _generateJobId: () => string;

  constructor(options: SQLiteJobStoreOptions) {
    this.db = options.db;
    if (options.jobTtlMs !== undefined && (!Number.isSafeInteger(options.jobTtlMs) || options.jobTtlMs <= 0)) {
      throw new Error("jobTtlMs must be a positive safe integer");
    }
    this.jobTtlMs = options.jobTtlMs ?? 45 * 60 * 1000;
    this.clock = options.clock ?? (() => Date.now());
    this._generateJobId = options.generateJobId ?? (() => randomBytes(16).toString("hex"));
  }

  /**
   * Centralized validated millisecond clock.
   * All SQLite ms timestamps flow through this method.
   */
  private nowMs(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Clock generated an invalid or unsafe timestamp");
    }
    return now;
  }

  createJob(request: WorkerCreateJobRequest, idempotencyKey: string): CreateJobResult {
    // §3 step 1: validate request
    const validRequest = WorkerCreateJobRequestSchema.parse(request);
    // §3 step 2: validate idempotency key
    const validIdempotencyKey = WorkerIdempotencyKeySchema.parse(idempotencyKey);
    // Compute payload hash (pure, no side effects)
    const payloadHash = generateIdempotencyFingerprint(validRequest);
    // §3 step 3: validate current time
    const now = this.nowMs();

    // §3 step 4: BEGIN IMMEDIATE
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Opportunistic cleanup of other expired idempotency records
      const cleanupStmt = this.db.prepare("DELETE FROM worker_idempotency_records WHERE expires_at_ms <= ? AND idempotency_key != ?");
      cleanupStmt.run(now, validIdempotencyKey);

      // §3 step 5: inspect the exact Idempotency-Key
      const idempStmt = this.db.prepare("SELECT * FROM worker_idempotency_records WHERE idempotency_key = ?");
      const existingIdemp = idempStmt.get(validIdempotencyKey) as any;

      if (existingIdemp) {
        // §3 step 6: retained record exists
        if (existingIdemp.expires_at_ms > now) {
          // Record is retained (not expired)
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
            return { type: "expired" };
          }

          return { type: "existing", job: durableJobToView(rowToDurableJob(jobRow)) };
        } else {
          // §3 step 7: record itself expired — delete inside same transaction
          const delStmt = this.db.prepare("DELETE FROM worker_idempotency_records WHERE idempotency_key = ?");
          delStmt.run(validIdempotencyKey);
        }
      }

      // §3 step 8: ONLY NOW — generate and validate new job ID, calculate expiry, insert
      const jobId = WorkerJobIdSchema.parse(this._generateJobId());
      const jobExpiresAt = now + this.jobTtlMs;
      const idempotencyExpiresAt = Math.max(now + WORKER_IDEMPOTENCY_MIN_RETENTION_MS, jobExpiresAt);

      if (!Number.isSafeInteger(jobExpiresAt) || !Number.isSafeInteger(idempotencyExpiresAt)) {
        throw new Error("Expiration computation exceeded safe integers");
      }

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
        validIdempotencyKey, payloadHash, jobId,
        now, jobExpiresAt, idempotencyExpiresAt
      );

      // §5: validate BEFORE COMMIT
      const jobStmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
      const newJobRow = jobStmt.get(jobId);
      const durableJob = rowToDurableJob(newJobRow);
      const jobView = durableJobToView(durableJob);

      // Both validations passed — safe to commit
      this.db.exec("COMMIT");

      return { type: "created", job: jobView };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch (_rollbackErr) { void _rollbackErr; }
      throw e;
    }
  }

  getJob(jobId: string): WorkerJobView | null {
    const stmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
    const row = stmt.get(jobId);
    if (!row) return null;
    return durableJobToView(rowToDurableJob(row));
  }

  listQueuedJobs(limit: number): DurableWorkerJob[] {
    const now = this.nowMs();
    const stmt = this.db.prepare("SELECT * FROM worker_jobs WHERE status = 'queued' AND expires_at_ms > ? ORDER BY created_at_ms ASC, job_id ASC LIMIT ?");
    const rows = stmt.all(now, limit);
    return rows.map(rowToDurableJob);
  }

  claimNextQueuedJob(): DurableWorkerJob | null {
    const now = this.nowMs();

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
      return rowToDurableJob(newRow);
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch (_rollbackErr) { void _rollbackErr; }
      throw e;
    }
  }

  cancelJob(jobId: string): CancelJobResult {
    const now = this.nowMs();
    
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
      const row = stmt.get(jobId);
      
      if (!row) {
        this.db.exec("COMMIT");
        return { type: "not_found" };
      }
      
      const durableJob = rowToDurableJob(row);
      const isTerminal = ['ready', 'failed', 'cancelled'].includes(durableJob.status);
      
      if (isTerminal) {
        this.db.exec("COMMIT");
        return { type: "unchanged", job: durableJobToView(durableJob) };
      }

      const updateStmt = this.db.prepare(`
        UPDATE worker_jobs 
        SET status = 'cancelled', updated_at_ms = ?, finished_at_ms = COALESCE(finished_at_ms, ?)
        WHERE job_id = ? AND status IN ('queued', 'analyzing', 'downloading', 'processing', 'uploading')
      `);
      updateStmt.run(now, now, jobId);
      
      this.db.exec("COMMIT");
      
      const newRow = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId);
      return { type: "cancelled", job: durableJobToView(rowToDurableJob(newRow)) };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch (_rollbackErr) { void _rollbackErr; }
      throw e;
    }
  }

  failJob(jobId: string, errorCode: string, errorMessage: string): boolean {
    const validErrorCode = WorkerErrorCodeSchema.parse(errorCode);
    const now = this.nowMs();
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
    const now = this.nowMs();
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

  /**
   * §11: Explicit idempotency cleanup maintenance primitive.
   * Deletes expired idempotency records. Returns count of deleted rows.
   */
  cleanupExpiredIdempotencyRecords(): number {
    const now = this.nowMs();
    const stmt = this.db.prepare("DELETE FROM worker_idempotency_records WHERE expires_at_ms <= ?");
    const result = stmt.run(now);
    return Number(result.changes);
  }
}
