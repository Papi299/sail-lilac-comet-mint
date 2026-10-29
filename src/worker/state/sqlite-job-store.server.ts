import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  WorkerJobViewSchema,
  WorkerCreateJobRequestSchema,
  WorkerJobIdSchema,
  WorkerObjectKeySchema,
  type WorkerJobView,
  type WorkerCreateJobRequest
} from "../../shared/worker/contracts.ts";
import { WorkerIdempotencyKeySchema } from "../../shared/worker/auth.ts";
import { WorkerErrorCodeSchema } from "../../shared/worker/errors.ts";
import {
  WORKER_RESTART_SAFE_MESSAGE,
  WORKER_RESTART_STAGE_LABEL,
  failedJobStageLabelFor,
} from "../../shared/worker/job-failure.ts";
import {
  CompleteAnalysisInputSchema,
  UpdateProgressInputSchema,
  type CompleteAnalysisInput,
  type UpdateProgressInput,
  type ExecutionMutationResult,
  type CreateJobResult,
  DurableWorkerJobSchema,
  type DurableWorkerJob,
  type WorkerJobStore,
  type CancelJobResult,
  type CommitReadyInput,
  type CommitReadyResult,
  CommitReadyInputSchema,
  type ExpiredReadyObject,
  ExpiredReadyObjectSchema,
  WorkerExecutionProgressStatusSchema,
  type WorkerExecutionProgressStatus
} from "./job-store.ts";
import { generateIdempotencyFingerprint, WORKER_IDEMPOTENCY_MIN_RETENTION_MS } from "./idempotency.server.ts";
import {
  DEFAULT_WORKER_TIME_LIMITS,
  WorkerTimeLimitsError,
  assertWorkerJobLifetimes,
} from "../runtime/time-limits.ts";

export interface SQLiteJobStoreOptions {
  db: DatabaseSync;
  /**
   * `L` (VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001): assigned to
   * `expires_at_ms` at creation, bounding the queue wait, and again at claim,
   * bounding the execution. Production passes the runtime model's derived
   * value; absent, the strict loader's default model applies. The store never
   * derives it.
   */
  executionLifetimeMs?: number;
  /** `R`: assigned at every terminal transition as `finished + R`. Same defaulting. */
  retentionMs?: number;
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
  private readonly executionLifetimeMs: number;
  private readonly retentionMs: number;
  private readonly clock: () => number;
  private readonly _generateJobId: () => string;

  constructor(options: SQLiteJobStoreOptions) {
    this.db = options.db;
    // LD-2a retired the single creation-based TTL. A caller still passing it is
    // refused rather than ignored, so it cannot believe it sets a lifetime.
    if (Object.hasOwn(options, "jobTtlMs")) {
      throw new WorkerTimeLimitsError("jobTtlMs");
    }
    const lifetimes = assertWorkerJobLifetimes({
      executionLifetimeMs: options.executionLifetimeMs ?? DEFAULT_WORKER_TIME_LIMITS.executionLifetimeMs,
      retentionMs: options.retentionMs ?? DEFAULT_WORKER_TIME_LIMITS.retentionMs,
    });
    this.executionLifetimeMs = lifetimes.executionLifetimeMs;
    this.retentionMs = lifetimes.retentionMs;
    this.clock = options.clock ?? (() => Date.now());
    this._generateJobId = options.generateJobId ?? (() => randomBytes(16).toString("hex"));
  }

  /**
   * LD-2a: every `expires_at_ms` this store writes after creation goes through
   * here. The schema requires `expires_at_ms >= created_at_ms`, and only a wall
   * clock stepped back past a job's creation by more than the window could
   * produce a smaller value, so the floor never binds on a monotonic clock: the
   * assignment is then exactly the value asked for. Without it such a clock
   * would make the transition's UPDATE fail — and `recover()` with it, at every
   * start.
   */
  private boundedExpiry(job: DurableWorkerJob, expiresAt: number): number {
    const bounded = Math.max(job.createdAt, expiresAt);
    if (!Number.isSafeInteger(bounded)) {
      throw new Error("Expiration computation exceeded safe integers");
    }
    return bounded;
  }

  /**
   * LD-2a: the terminal assignment, `finished + R`, for ready, failed,
   * cancelled and recovered jobs alike. `finished` is the instant the
   * transition records: the row's existing `finished_at_ms`, which the UPDATE's
   * `COALESCE` keeps, or else `now`. Assigned exactly, never `MAX`ed with the
   * execution lifetime it replaces: a later value could outlive a ready object.
   */
  private terminalExpiresAt(job: DurableWorkerJob, now: number): number {
    return this.boundedExpiry(job, (job.finishedAt ?? now) + this.retentionMs);
  }

  /**
   * LD-2a: mirrors a job's newly assigned `expires_at_ms` into its idempotency
   * record INSIDE the caller's open transaction, so the status, the expiry and
   * the mirror commit or roll back together.
   *
   * `job_expires_at_ms` follows the job exactly, so a replayed create answers
   * `existing` while the job is authorised and `expired` after it. The record's
   * own retention keeps its 24-hour floor counted from the RECORD's creation —
   * never from this transition — and never ends before the job's authorisation.
   * A replay never reaches this method, so no request can move a job's
   * lifetime. Every record naming the job is updated, each against its own
   * creation time; none (a job inserted without one) is not an error.
   */
  private mirrorExpiryToIdempotencyRecord(jobId: string, jobExpiresAt: number): void {
    this.db.prepare(`
      UPDATE worker_idempotency_records
      SET job_expires_at_ms = ?,
          expires_at_ms = MAX(created_at_ms + ?, ?)
      WHERE job_id = ?
    `).run(jobExpiresAt, WORKER_IDEMPOTENCY_MIN_RETENTION_MS, jobExpiresAt, jobId);
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

      // §3 step 8: ONLY NOW — generate and validate new job ID, calculate expiry, insert.
      // LD-2a: a queued job is authorised for `created + L`, the queue-wait
      // bound. Claiming it re-assigns the bound for the execution.
      const jobId = WorkerJobIdSchema.parse(this._generateJobId());
      const jobExpiresAt = now + this.executionLifetimeMs;
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
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new Error("limit must be a safe integer between 1 and 1000");
    }
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

      // §3.1 validate BEFORE mutation
      const queuedJob = rowToDurableJob(row);

      // §3.2 conditional UPDATE. LD-2a: the claim assigns the execution bound,
      // `claimed + L`, in the SAME conditional write that wins the claim. A
      // claim that loses the CAS rolls back and moves nothing, and an expired
      // queued row stays unclaimable — both predicates are in the WHERE clause.
      const claimExpiresAt = this.boundedExpiry(queuedJob, now + this.executionLifetimeMs);
      const updateStmt = this.db.prepare(`
        UPDATE worker_jobs
        SET status = 'analyzing',
            started_at_ms = COALESCE(started_at_ms, ?),
            updated_at_ms = ?,
            expires_at_ms = ?
        WHERE job_id = ? AND status = 'queued' AND expires_at_ms > ?
      `);
      const result = updateStmt.run(now, now, claimExpiresAt, row.job_id, now);

      // §3.3 require changes === 1
      if (result.changes !== 1) {
        throw new Error("Failed to claim job; changes != 1");
      }
      
      // §3.4 SELECT updated row
      const newStmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
      const newRow = newStmt.get(row.job_id);
      
      // §3.5 validate BEFORE COMMIT
      const claimedJob = rowToDurableJob(newRow);
      if (claimedJob.status !== "analyzing") {
        throw new Error("Claimed job must be in analyzing status");
      }
      if (claimedJob.expiresAt !== claimExpiresAt) {
        throw new Error("Claimed job must carry its execution lifetime");
      }
      this.mirrorExpiryToIdempotencyRecord(claimedJob.jobId, claimExpiresAt);

      // §3.6 COMMIT
      this.db.exec("COMMIT");
      return claimedJob;
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

      // LD-2a: a cancelled outcome stays viewable for `R` after it is reached.
      const cancelExpiresAt = this.terminalExpiresAt(durableJob, now);
      const updateStmt = this.db.prepare(`
        UPDATE worker_jobs
        SET status = 'cancelled', updated_at_ms = ?, finished_at_ms = COALESCE(finished_at_ms, ?),
            expires_at_ms = ?
        WHERE job_id = ? AND status IN ('queued', 'analyzing', 'downloading', 'processing', 'uploading')
      `);
      const result = updateStmt.run(now, now, cancelExpiresAt, jobId);

      if (result.changes !== 1) {
        throw new Error("Failed to cancel job; changes != 1");
      }

      const newRow = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId);
      const resultingJob = rowToDurableJob(newRow);
      if (resultingJob.expiresAt !== cancelExpiresAt) {
        throw new Error("Cancelled job must carry its retention");
      }
      const view = durableJobToView(resultingJob);
      this.mirrorExpiryToIdempotencyRecord(jobId, cancelExpiresAt);

      this.db.exec("COMMIT");
      return { type: "cancelled", job: view };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch (_rollbackErr) { void _rollbackErr; }
      throw e;
    }
  }

  failJob(jobId: string, errorCode: string, errorMessage: string): boolean {
    const validErrorCode = WorkerErrorCodeSchema.parse(errorCode);
    const now = this.nowMs();
    
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
      const row = stmt.get(jobId);

      if (!row) {
        this.db.exec("COMMIT");
        return false;
      }

      const durableJob = rowToDurableJob(row);
      const leaving = durableJob.status;
      if (leaving === 'ready' || leaving === 'failed' || leaving === 'cancelled') {
        this.db.exec("COMMIT");
        return false;
      }

      // MEDIA-EXECUTION-FAILURE-CLASSIFICATION-001: the stage label records
      // WHICH phase failed, from the closed vocabulary, decided by the durable
      // status this very transaction is leaving — never by the caller, and never
      // by anything the failure itself said. Without it the row keeps whatever
      // the last progress write left, which says nothing about where it failed.
      //
      // LD-2a: the failed outcome stays viewable for `R` after it is reached —
      // a failure near the end of a long execution would otherwise already
      // answer 410 instead of saying why.
      const failExpiresAt = this.terminalExpiresAt(durableJob, now);
      const updateStmt = this.db.prepare(`
        UPDATE worker_jobs
        SET status = 'failed',
            error_code = ?,
            safe_error_message = ?,
            stage_label = ?,
            updated_at_ms = ?,
            finished_at_ms = COALESCE(finished_at_ms, ?),
            expires_at_ms = ?
        WHERE job_id = ? AND status = ?
      `);
      const result = updateStmt.run(
        validErrorCode,
        errorMessage,
        failedJobStageLabelFor(leaving),
        now,
        now,
        failExpiresAt,
        jobId,
        leaving,
      );

      if (result.changes !== 1) {
        throw new Error("Failed to update job status to failed");
      }

      const newRow = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId);
      const resultingJob = rowToDurableJob(newRow);
      if (resultingJob.status !== 'failed') {
        throw new Error("Job must be failed after failJob");
      }
      if (resultingJob.expiresAt !== failExpiresAt) {
        throw new Error("Failed job must carry its retention");
      }
      this.mirrorExpiryToIdempotencyRecord(jobId, failExpiresAt);

      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch (_rollbackErr) { void _rollbackErr; }
      throw e;
    }
  }


  completeAnalysis(jobId: string, input: CompleteAnalysisInput): ExecutionMutationResult {
    const validJobId = WorkerJobIdSchema.parse(jobId);
    const validated = CompleteAnalysisInputSchema.parse(input);
    const now = this.nowMs();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
      const row = stmt.get(validJobId);
      if (!row) {
        this.db.exec("COMMIT");
        return { type: "not_found" };
      }
      const durableJob = rowToDurableJob(row);
      if (['ready', 'failed', 'cancelled'].includes(durableJob.status)) {
        this.db.exec("COMMIT");
        return { type: "terminal", job: durableJobToView(durableJob) };
      }
      if (durableJob.status !== 'analyzing') {
        this.db.exec("COMMIT");
        return { type: "state_conflict", job: durableJobToView(durableJob) };
      }
      
      const updateStmt = this.db.prepare(`
        UPDATE worker_jobs 
        SET status = 'downloading',
            title = ?,
            thumbnail = ?,
            source = ?,
            extractor = ?,
            updated_at_ms = ?
        WHERE job_id = ? AND status = 'analyzing'
      `);
      const result = updateStmt.run(validated.title, validated.thumbnail, validated.source, validated.extractor, now, validJobId);
      if (result.changes !== 1) {
        throw new Error("Failed to transition job to downloading");
      }
      const newRow = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(validJobId);
      const resultingJob = rowToDurableJob(newRow);
      if (resultingJob.status !== 'downloading') {
        throw new Error("Job must be downloading after completeAnalysis");
      }
      const view = durableJobToView(resultingJob);
      this.db.exec("COMMIT");
      return { type: "updated", job: view };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  updateExecutionProgress(jobId: string, expectedStatus: WorkerExecutionProgressStatus, input: UpdateProgressInput): ExecutionMutationResult {
    // §15: every argument is validated BEFORE any transaction is opened.
    // `queued` and the terminal states are not members of this enum, so they
    // can never be used as a same-state progress-mutation target.
    const validJobId = WorkerJobIdSchema.parse(jobId);
    const validExpectedStatus = WorkerExecutionProgressStatusSchema.parse(expectedStatus);
    const validated = UpdateProgressInputSchema.parse(input);
    const now = this.nowMs();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
      const row = stmt.get(validJobId);
      if (!row) {
        this.db.exec("COMMIT");
        return { type: "not_found" };
      }
      const durableJob = rowToDurableJob(row);
      if (['ready', 'failed', 'cancelled'].includes(durableJob.status)) {
        this.db.exec("COMMIT");
        return { type: "terminal", job: durableJobToView(durableJob) };
      }
      if (durableJob.status !== validExpectedStatus) {
        this.db.exec("COMMIT");
        return { type: "state_conflict", job: durableJobToView(durableJob) };
      }
      
      const updateStmt = this.db.prepare(`
        UPDATE worker_jobs 
        SET progress = ?,
            downloaded_bytes = ?,
            total_bytes = ?,
            speed = ?,
            eta = ?,
            stage_label = ?,
            updated_at_ms = ?
        WHERE job_id = ? AND status = ?
      `);
      const result = updateStmt.run(validated.progress, validated.downloadedBytes, validated.totalBytes, validated.speed, validated.eta, validated.stageLabel, now, validJobId, validExpectedStatus);
      if (result.changes !== 1) {
        throw new Error("Failed to update progress");
      }
      const newRow = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(validJobId);
      // §13: durable validation, then exact expected-status validation, then
      // PUBLIC WorkerJobView validation — all strictly BEFORE COMMIT. Any
      // failure here propagates to the catch block and ROLLBACKs.
      const resultingJob = rowToDurableJob(newRow);
      if (resultingJob.status !== validExpectedStatus) {
        throw new Error("Job status changed unexpectedly during updateExecutionProgress");
      }
      const view = durableJobToView(resultingJob);
      this.db.exec("COMMIT");
      return { type: "updated", job: view };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  beginProcessing(jobId: string): ExecutionMutationResult {
    return this._transitionExecutionState(jobId, 'downloading', 'processing');
  }

  beginUploading(jobId: string): ExecutionMutationResult {
    return this._transitionExecutionState(jobId, 'processing', 'uploading');
  }

  private _transitionExecutionState(jobId: string, fromState: import("../../shared/worker/contracts.ts").WorkerJobStatus, toState: import("../../shared/worker/contracts.ts").WorkerJobStatus): ExecutionMutationResult {
    const validJobId = WorkerJobIdSchema.parse(jobId);
    const now = this.nowMs();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?");
      const row = stmt.get(validJobId);
      if (!row) {
        this.db.exec("COMMIT");
        return { type: "not_found" };
      }
      const durableJob = rowToDurableJob(row);
      if (['ready', 'failed', 'cancelled'].includes(durableJob.status)) {
        this.db.exec("COMMIT");
        return { type: "terminal", job: durableJobToView(durableJob) };
      }
      if (durableJob.status !== fromState) {
        this.db.exec("COMMIT");
        return { type: "state_conflict", job: durableJobToView(durableJob) };
      }
      
      const updateStmt = this.db.prepare(`
        UPDATE worker_jobs 
        SET status = ?,
            updated_at_ms = ?
        WHERE job_id = ? AND status = ?
      `);
      const result = updateStmt.run(toState, now, validJobId, fromState);
      if (result.changes !== 1) {
        throw new Error(`Failed to transition job to ${toState}`);
      }
      const newRow = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(validJobId);
      // §14: durable validation, exact expected-status validation, and PUBLIC
      // WorkerJobView validation all happen BEFORE COMMIT. The already-validated
      // view is returned; it is never constructed for the first time post-commit.
      const resultingJob = rowToDurableJob(newRow);
      if (resultingJob.status !== toState) {
        throw new Error(`Job must be ${toState} after transition`);
      }
      const view = durableJobToView(resultingJob);
      this.db.exec("COMMIT");
      return { type: "updated", job: view };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  commitReadyFromUploading(jobId: string, input: CommitReadyInput): CommitReadyResult {
    const validJobId = WorkerJobIdSchema.parse(jobId);
    const validatedInput = CommitReadyInputSchema.parse(input);
    const embeddedJobId = validatedInput.objectKey.split("/")[2];
    if (embeddedJobId !== validJobId) {
      throw new Error("Embedded job ID in objectKey does not match the target job ID");
    }

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

      if (['ready', 'failed', 'cancelled'].includes(durableJob.status)) {
        this.db.exec("COMMIT");
        return { type: "terminal", job: durableJobToView(durableJob) };
      }

      if (durableJob.status !== 'uploading') {
        this.db.exec("COMMIT");
        return { type: "not_uploading", job: durableJobToView(durableJob) };
      }

      // LD-2a: only a job whose execution lifetime is still running may become
      // ready. An upload that finished after `claimed + L` — one LD-2a cannot yet
      // cancel — must not resurrect the job: it loses here, nothing is written,
      // and the caller deletes the exact key it uploaded. The same predicate is
      // in the UPDATE's WHERE clause below, so the conditional write itself is
      // the authority, not this read.
      if (durableJob.expiresAt <= now) {
        this.db.exec("COMMIT");
        return { type: "lifetime_expired", job: durableJobToView(durableJob) };
      }

      // LD-2a: the person gets the full retention from the moment the file
      // exists: `ready + R`.
      const readyExpiresAt = this.terminalExpiresAt(durableJob, now);
      const updateStmt = this.db.prepare(`
        UPDATE worker_jobs
        SET status = 'ready',
            object_key = ?,
            filename = ?,
            file_size = ?,
            mime = ?,
            quality = ?,
            container = ?,
            progress = 100,
            stage_label = 'Ready',
            updated_at_ms = ?,
            finished_at_ms = COALESCE(finished_at_ms, ?),
            expires_at_ms = ?
        WHERE job_id = ? AND status = 'uploading' AND expires_at_ms > ?
      `);

      const result = updateStmt.run(
        validatedInput.objectKey,
        validatedInput.filename,
        validatedInput.fileSize,
        validatedInput.mime,
        validatedInput.quality,
        validatedInput.container,
        now,
        now,
        readyExpiresAt,
        jobId,
        now
      );

      if (result.changes !== 1) {
        throw new Error("Failed to transition job to ready");
      }

      const newRow = this.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId);
      const resultingJob = rowToDurableJob(newRow);

      if (resultingJob.status !== 'ready') {
        throw new Error("Job must be ready after commitReadyFromUploading");
      }
      if (resultingJob.objectKey !== validatedInput.objectKey) {
        throw new Error("objectKey mismatch after commitReadyFromUploading");
      }
      if (resultingJob.expiresAt !== readyExpiresAt) {
        throw new Error("Ready job must carry its retention");
      }

      const view = durableJobToView(resultingJob);
      this.mirrorExpiryToIdempotencyRecord(jobId, readyExpiresAt);

      this.db.exec("COMMIT");
      return { type: "ready", job: view };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch (_rollbackErr) { void _rollbackErr; }
      throw e;
    }
  }

  listExpiredReadyObjects(limit: number): ExpiredReadyObject[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new Error("limit must be a safe integer between 1 and 1000");
    }
    const now = this.nowMs();
    const stmt = this.db.prepare(`
      SELECT job_id, object_key, expires_at_ms
      FROM worker_jobs
      WHERE status = 'ready' AND expires_at_ms <= ? AND object_key IS NOT NULL
      ORDER BY expires_at_ms ASC, job_id ASC
      LIMIT ?
    `);
    const rows = stmt.all(now, limit) as any[];
    return rows.map(row => ExpiredReadyObjectSchema.parse({
      jobId: row.job_id,
      objectKey: row.object_key,
      expiresAt: row.expires_at_ms
    }));
  }

  /**
   * §20: conditional exact-row metadata cleanup for an expired ready job whose
   * object has ALREADY been deleted from the object store.
   *
   * Every predicate is part of the WHERE clause, so the delete is atomic with
   * its own precondition check — a concurrent transition out of `ready` simply
   * matches nothing. `changes` can only ever be 0 or 1 because `job_id` is the
   * primary key; anything else is treated as corruption and rolls back.
   *
   * `worker_idempotency_records` is untouched: no foreign key, no cascade, no
   * companion DELETE. The tombstone outlives the job metadata by design.
   */
  deleteExpiredReadyMetadata(jobId: string, expectedObjectKey: string): boolean {
    const validJobId = WorkerJobIdSchema.parse(jobId);
    const validObjectKey = WorkerObjectKeySchema.parse(expectedObjectKey);

    // The object key embeds the job id; a mismatched pair can never identify a
    // legitimate row and is rejected before any statement runs.
    if (!validObjectKey.startsWith(`videofetch/jobs/${validJobId}/`)) {
      throw new Error("objectKey embedded job ID must equal jobId");
    }

    const now = this.nowMs();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare(`
        DELETE FROM worker_jobs
        WHERE job_id = ?
          AND status = 'ready'
          AND object_key = ?
          AND expires_at_ms <= ?
      `);
      const result = stmt.run(validJobId, validObjectKey, now);
      const changes = Number(result.changes);

      if (changes !== 0 && changes !== 1) {
        throw new Error("deleteExpiredReadyMetadata matched more than one row");
      }

      this.db.exec("COMMIT");
      return changes === 1;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch (_rollbackErr) { void _rollbackErr; }
      throw e;
    }
  }

  recover(): void {
    const now = this.nowMs();
    
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const selectStmt = this.db.prepare(`
        SELECT * FROM worker_jobs 
        WHERE status IN ('analyzing', 'downloading', 'processing', 'uploading')
      `);
      const rows = selectStmt.all() as any[];

      // Validate all selected rows before update
      const interrupted = rows.map(rowToDurableJob);

      if (interrupted.length > 0) {
        // The restart message and stage are the shared constants the control
        // plane allowlists, so the two cannot drift apart.
        //
        // LD-2a: each recovered job is retained for `R` from this recovery,
        // like any other failure, so the person can still see why it ended. One
        // conditional UPDATE per row, because each row's retention is its own;
        // all of them share this one transaction, so recovery stays
        // all-or-nothing.
        const updateStmt = this.db.prepare(`
          UPDATE worker_jobs
          SET status = 'failed',
              error_code = 'PROCESSING_FAILED',
              safe_error_message = ?,
              stage_label = ?,
              updated_at_ms = ?,
              finished_at_ms = COALESCE(finished_at_ms, ?),
              expires_at_ms = ?
          WHERE job_id = ? AND status = ?
        `);
        const expectedExpiry = new Map<string, number>();
        for (const job of interrupted) {
          const recoveredExpiresAt = this.terminalExpiresAt(job, now);
          const result = updateStmt.run(
            WORKER_RESTART_SAFE_MESSAGE,
            WORKER_RESTART_STAGE_LABEL,
            now,
            now,
            recoveredExpiresAt,
            job.jobId,
            job.status,
          );
          if (result.changes !== 1) {
            throw new Error("Failed to recover an interrupted job");
          }
          this.mirrorExpiryToIdempotencyRecord(job.jobId, recoveredExpiresAt);
          expectedExpiry.set(job.jobId, recoveredExpiresAt);
        }

        const ids = interrupted.map((job) => job.jobId);
        const placeholders = ids.map(() => '?').join(',');
        const newRowsStmt = this.db.prepare(`SELECT * FROM worker_jobs WHERE job_id IN (${placeholders})`);
        const newRows = newRowsStmt.all(...ids) as any[];

        // Validate all rows after update
        for (const row of newRows) {
          const recovered = rowToDurableJob(row);
          if (recovered.expiresAt !== expectedExpiry.get(recovered.jobId)) {
            throw new Error("Recovered job must carry its retention");
          }
        }
      }

      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch (_rollbackErr) { void _rollbackErr; }
      throw e;
    }
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
