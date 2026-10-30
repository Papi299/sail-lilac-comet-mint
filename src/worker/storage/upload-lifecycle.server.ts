/* eslint-disable no-control-regex */
import { z } from "zod";
import type { WorkerJobStore } from "../state/job-store.ts";
import { WorkerJobIdSchema, type WorkerJobView } from "../../shared/worker/contracts.ts";
import { ObjectStorePutInputSchema, ObjectStoreHeadSchema, type ObjectStoreWriter, type ObjectStorePutInput, type ObjectStoreHead } from "./writer.ts";
import { generateWorkerObjectKey } from "./object-key.ts";
import { buildAttachmentContentDisposition } from "../../lib/filenames.ts";
import { AppError } from "../../lib/errors.ts";

/**
 * VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001: the allowance for deleting the
 * attempted object after an upload stage that ended without a ready commit.
 *
 * It is separate from the stage's deadline, because the stage's signal may be
 * exactly what ended the stage, and an aborted signal must not make the
 * exact-key delete impossible. It is a constant and deliberately short: at most
 * one DeleteObject mint (the broker client's own timeout is 5 s) and one
 * DeleteObject request, inside half of the Worker's 10 s shutdown grace, so an
 * operator restart still finishes the attempt before the database closes. It
 * never resumes an upload, never renews the stage and never permits a ready
 * commit. Whatever it cannot finish is left to the R2 lifecycle rule, which
 * deletes every object 3,600 s after it was written.
 */
export const UPLOAD_CLEANUP_BUDGET_MS = 5_000;

/** The largest delay the platform timer accepts; see `openUploadStage`. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** A timer handle: `unref` where the platform has one. */
export type UploadStageTimerHandle = { unref?: () => unknown };

/** The stage's timer hooks, injectable so tests drive the deadline in virtual time. */
export type UploadStageTimers = {
  setTimeoutFn: (handler: () => void, ms: number) => UploadStageTimerHandle;
  clearTimeoutFn: (handle: UploadStageTimerHandle) => void;
};

const PLATFORM_TIMERS: UploadStageTimers = {
  setTimeoutFn: (handler, ms) => setTimeout(handler, ms),
  clearTimeoutFn: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * LD-2b: the bounds of ONE upload stage, from the executor.
 *
 * `deadlineMs` is the stage's one absolute deadline
 * (`deriveUploadStageDeadlineMs`): `min(uploading + UPLOAD_TIMEOUT, claimed +
 * L)`. This module never sees a duration, so it cannot grant a fresh budget to
 * anything: every operation of the stage — each credential mint, the put, the
 * head and the ready commit — gets only what is left of the same deadline.
 */
export type UploadStageBounds = {
  /**
   * The execution's own signal. Cancellation, operator shutdown and the
   * execution-lifetime backstop abort it; the stage follows it but never
   * aborts it.
   */
  readonly signal: AbortSignal;
  /** The stage's ONE absolute deadline, epoch milliseconds. */
  readonly deadlineMs: number;
  /** The clock `deadlineMs` is measured on. Default: `Date.now`. */
  readonly clock?: () => number;
  /** The stage deadline's and the cleanup allowance's timers. Default: the platform's. */
  readonly timers?: UploadStageTimers;
};

export type FinalizeUploadInput = {
  jobId: string;
  store: WorkerJobStore;
  writer: ObjectStoreWriter;
  body: AsyncIterable<Uint8Array>;
  filename: string;
  fileSize: number;
  mime: string;
  quality: string | null;
  container: string | null;
  randomSource?: () => Uint8Array;
  /** LD-2b: required — an upload without a deadline is not one this module will start. */
  stage: UploadStageBounds;
};

export type StorageFailureCode =
  | "invalid_input"
  | "put_failed"
  | "head_failed"
  | "verification_failed"
  | "ready_commit_failed";

export type CleanupOutcome = "deleted" | "failed" | "not_needed";

export type JobStateConflictReason = 
  | "missing"
  | "cancelled"
  | "failed"
  | "ready"
  | "not_uploading";

export type FinalizeUploadResult =
  | { type: "ready"; job: WorkerJobView }
  | { type: "storage_failure"; code: StorageFailureCode; cleanup: CleanupOutcome }
  | { type: "job_state_conflict"; reason: JobStateConflictReason; cleanup: CleanupOutcome }
  /**
   * LD-2a: the upload completed after the job's execution lifetime ended. The
   * ready commit refused it, the uploaded object was deleted by exact key, and
   * the job is still `uploading` — no other writer has claimed it, so the
   * caller must fail it.
   */
  | { type: "lifetime_expired"; cleanup: CleanupOutcome }
  /**
   * LD-2b: the execution's signal ended the stage first — cancellation,
   * operator shutdown or the lifetime backstop. The in-flight operation was
   * torn down, no ready commit was attempted, and the attempted key was deleted
   * when a put had started. The caller classifies it from the signal's own
   * provenance; nothing here decides between those causes.
   */
  | { type: "aborted"; cleanup: CleanupOutcome }
  /**
   * LD-2b: the stage's deadline passed first. The in-flight operation was torn
   * down, no ready commit was attempted, and the attempted key was deleted
   * when a put had started. The job is still `uploading`; the caller fails it.
   */
  | { type: "upload_timeout"; cleanup: CleanupOutcome };

/**
 * Deletes the attempted object by its exact key, under the cleanup allowance's
 * OWN signal (`UPLOAD_CLEANUP_BUDGET_MS`) — never the stage's, which may be the
 * very signal that ended the upload. The delegated writer mints a
 * DeleteObject-only credential for it, so cleanup carries no Put or Head
 * authority. `deleted` means the exact-key DeleteObject succeeded; it is not a
 * claim about a request this process had already torn down, should the
 * provider still complete it (see the LD-2b cleanup notes in the runbook).
 */
async function cleanupUploadedObject(
  writer: ObjectStoreWriter,
  objectKey: string,
  timers: UploadStageTimers,
): Promise<CleanupOutcome> {
  const allowance = new AbortController();
  const handle = timers.setTimeoutFn(
    () => allowance.abort(new AppError("TIMEOUT", "Upload cleanup allowance elapsed")),
    UPLOAD_CLEANUP_BUDGET_MS,
  );
  handle.unref?.();
  try {
    await writer.delete(objectKey, { signal: allowance.signal });
    return "deleted";
  } catch {
    return "failed";
  } finally {
    timers.clearTimeoutFn(handle);
  }
}

/** Why an upload stage ended before its ready commit: the first cause wins. */
type StageInterruption = "signal" | "deadline";

/**
 * LD-2b: opens ONE upload stage — one internal controller, composed from the
 * execution's signal and the stage's one deadline timer.
 *
 * The internal controller is the only signal the stage's operations see. It
 * aborts on whichever comes first, and that first cause is latched:
 *
 *  - the execution's signal aborting (its reason is carried over), or
 *  - the deadline timer firing.
 *
 * It never aborts the execution's own controller, so cancellation and
 * shutdown provenance stay the executor's alone. The timer is armed once, at
 * `deadlineMs - now`, and nothing re-arms it; `interruption()` also reads the
 * clock, so a timer that fires late cannot let an operation start or a commit
 * happen past the deadline. `dispose()` (idempotent) clears the timer and the
 * listener, so nothing of the stage outlives it.
 */
function openUploadStage(stage: UploadStageBounds) {
  const clock = stage.clock ?? Date.now;
  const timers = stage.timers ?? PLATFORM_TIMERS;
  const controller = new AbortController();
  let cause: StageInterruption | null = null;
  let disposed = false;

  const end = (by: StageInterruption, reason: unknown) => {
    if (cause !== null) return;
    cause = by;
    controller.abort(reason);
  };
  const onExecutionAbort = () => end("signal", stage.signal.reason);
  const deadlineReached = () => end("deadline", new AppError("TIMEOUT", "Upload stage deadline"));

  if (stage.signal.aborted) onExecutionAbort();
  else stage.signal.addEventListener("abort", onExecutionAbort, { once: true });

  const delayMs = Math.min(Math.max(stage.deadlineMs - clock(), 0), MAX_TIMER_DELAY_MS);
  const handle = timers.setTimeoutFn(() => {
    if (!disposed) deadlineReached();
  }, delayMs);
  handle.unref?.();

  return {
    signal: controller.signal,
    timers,
    /** The cause that ended the stage, or null while it may continue. */
    interruption(): StageInterruption | null {
      if (cause === null && clock() >= stage.deadlineMs) deadlineReached();
      return cause;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      timers.clearTimeoutFn(handle);
      stage.signal.removeEventListener("abort", onExecutionAbort);
    },
  };
}

type UploadStage = ReturnType<typeof openUploadStage>;

/** The stage's own boundary validation: refused, never clamped. */
function assertUploadStageBounds(stage: unknown): asserts stage is UploadStageBounds {
  const candidate = stage as Partial<UploadStageBounds> | null;
  if (typeof candidate !== "object" || candidate === null) throw new Error("invalid stage");
  if (!(candidate.signal instanceof AbortSignal)) throw new Error("invalid stage signal");
  if (!Number.isSafeInteger(candidate.deadlineMs) || (candidate.deadlineMs as number) < 0) {
    throw new Error("invalid stage deadline");
  }
}

/**
 * What the stage's operations ended with, before any cleanup: `attempted`
 * says whether a put was started, and so whether an object may exist.
 */
type StageOutcome =
  | { type: "ready"; job: WorkerJobView }
  | { type: "storage_failure"; code: Exclude<StorageFailureCode, "invalid_input"> }
  | { type: "job_state_conflict"; reason: JobStateConflictReason }
  | { type: "lifetime_expired" }
  | { type: "interrupted"; cause: StageInterruption; attempted: boolean };

function mapJobStatusToConflictReason(status: string): JobStateConflictReason {
  switch (status) {
    case "ready": return "ready";
    case "cancelled": return "cancelled";
    case "failed": return "failed";
    case "queued":
    case "analyzing":
    case "downloading":
    case "processing":
      return "not_uploading";
    default:
      return "not_uploading";
  }
}

export async function finalizeJobUpload(input: FinalizeUploadInput): Promise<FinalizeUploadResult> {
  const { jobId, store, writer, body, filename, fileSize, mime, quality, container, randomSource, stage } = input;

  // 1. Validate auxiliary inputs
  try {
    WorkerJobIdSchema.parse(jobId);
    z.string().min(1).max(1024).regex(/^[^\x00-\x1F\x7F]+$/).parse(filename);
    z.string().max(255).regex(/^[^\x00-\x1F\x7F]+$/).nullable().parse(quality);
    z.string().max(255).regex(/^[^\x00-\x1F\x7F]+$/).nullable().parse(container);
    if (!body || typeof (body as any)[Symbol.asyncIterator] !== "function") {
      throw new Error("invalid body");
    }
    assertUploadStageBounds(stage);
  } catch {
    return { type: "storage_failure", code: "invalid_input", cleanup: "not_needed" };
  }

  // 1b. Verify job is uploading
  const initialJob = store.getJob(jobId);
  if (!initialJob) {
    return { type: "job_state_conflict", reason: "missing", cleanup: "not_needed" };
  }
  if (initialJob.status !== "uploading") {
    return { type: "job_state_conflict", reason: mapJobStatusToConflictReason(initialJob.status), cleanup: "not_needed" };
  }

  // 2. Generate opaque objectKey & Content-Disposition
  let objectKey: string;
  let contentDisposition: string;
  try {
    const validJobId = WorkerJobIdSchema.parse(jobId);
    objectKey = generateWorkerObjectKey(validJobId, randomSource);
    contentDisposition = buildAttachmentContentDisposition(filename);
  } catch {
    return { type: "storage_failure", code: "invalid_input", cleanup: "not_needed" };
  }

  // 3. Construct and validate complete put candidate
  let validatedPutInput: ObjectStorePutInput;
  try {
    validatedPutInput = ObjectStorePutInputSchema.parse({
      objectKey,
      body,
      contentLength: fileSize,
      contentType: mime,
      contentDisposition,
    });
  } catch {
    return { type: "storage_failure", code: "invalid_input", cleanup: "not_needed" };
  }

  // 4–8. LD-2b: every storage operation and the ready commit run inside ONE
  //      upload stage, bounded by its one deadline and the execution's signal.
  //      The stage is closed — its timer cleared, its listener removed —
  //      before any cleanup starts, so the cleanup below can never be what
  //      the stage's deadline or signal acts on.
  const upload = openUploadStage(stage);
  let outcome: StageOutcome;
  try {
    outcome = await runUploadStage(upload, {
      jobId,
      store,
      writer,
      objectKey,
      putInput: validatedPutInput,
      fileSize,
      mime,
      contentDisposition,
      commit: { objectKey, filename, fileSize, mime, quality, container },
    });
  } finally {
    upload.dispose();
  }

  if (outcome.type === "ready") return outcome;

  // 9. Everything else after a started put deletes exactly the attempted key,
  //    under the cleanup allowance's own signal. Nothing here can commit.
  const attempted = outcome.type !== "interrupted" || outcome.attempted;
  const cleanup: CleanupOutcome = attempted
    ? await cleanupUploadedObject(writer, objectKey, upload.timers)
    : "not_needed";

  switch (outcome.type) {
    case "storage_failure":
      return { type: "storage_failure", code: outcome.code, cleanup };
    case "job_state_conflict":
      return { type: "job_state_conflict", reason: outcome.reason, cleanup };
    case "lifetime_expired":
      return { type: "lifetime_expired", cleanup };
    case "interrupted":
      return outcome.cause === "deadline"
        ? { type: "upload_timeout", cleanup }
        : { type: "aborted", cleanup };
  }
}

/**
 * The upload stage's operations: put, head, metadata verification, ready
 * commit — the order is unchanged from before LD-2b.
 *
 * LD-2b adds one rule, applied at every step: once the stage has ended (its
 * deadline passed or the execution's signal aborted), nothing further starts.
 * A stage already over at its start mints nothing, sends nothing and reads
 * none of the body. A put or head that settled after the stage ended — even
 * successfully, and even with a late answer from the provider — is not trusted
 * for anything: the stage reports the interruption and the attempted key is
 * cleaned up. The last check sits immediately before the ready commit, which is
 * synchronous, so nothing can interleave between them.
 */
async function runUploadStage(
  upload: UploadStage,
  op: {
    jobId: string;
    store: WorkerJobStore;
    writer: ObjectStoreWriter;
    objectKey: string;
    putInput: ObjectStorePutInput;
    fileSize: number;
    mime: string;
    contentDisposition: string;
    commit: Parameters<WorkerJobStore["commitReadyFromUploading"]>[1];
  },
): Promise<StageOutcome> {
  const { jobId, store, writer, objectKey, fileSize, mime, contentDisposition } = op;
  const context = { signal: upload.signal };
  const interrupted = (attempted: boolean): StageOutcome | null => {
    const cause = upload.interruption();
    return cause === null ? null : { type: "interrupted", cause, attempted };
  };

  // 4. Try put — only inside a stage that is still running.
  const before = interrupted(false);
  if (before) return before;
  try {
    await writer.put(op.putInput, context);
  } catch {
    return interrupted(true) ?? { type: "storage_failure", code: "put_failed" };
  }

  // 5. Head Retrieval
  const afterPut = interrupted(true);
  if (afterPut) return afterPut;
  let rawHead: ObjectStoreHead | null;
  try {
    rawHead = await writer.head(objectKey, context);
  } catch {
    return interrupted(true) ?? { type: "storage_failure", code: "head_failed" };
  }
  const afterHead = interrupted(true);
  if (afterHead) return afterHead;

  if (rawHead === null) {
    return { type: "storage_failure", code: "verification_failed" };
  }

  // 6. Head Validation
  let validatedHead: ObjectStoreHead;
  try {
    validatedHead = ObjectStoreHeadSchema.parse(rawHead);
  } catch {
    return { type: "storage_failure", code: "verification_failed" };
  }

  // 7. Metadata Comparison
  if (
    validatedHead.objectKey !== objectKey ||
    validatedHead.contentLength !== fileSize ||
    validatedHead.contentType !== mime ||
    validatedHead.contentDisposition !== contentDisposition
  ) {
    return { type: "storage_failure", code: "verification_failed" };
  }

  // 8. Commit Ready — the last point the stage can refuse, synchronous from
  //    here: no timer, signal or provider answer can land in between.
  const beforeCommit = interrupted(true);
  if (beforeCommit) return beforeCommit;
  let commitResult;
  try {
    commitResult = store.commitReadyFromUploading(jobId, op.commit);
  } catch {
    return { type: "storage_failure", code: "ready_commit_failed" };
  }

  if (commitResult.type === "ready") {
    return { type: "ready", job: commitResult.job };
  }

  // 9. Races: the caller cleans up.
  if (commitResult.type === "lifetime_expired") {
    return { type: "lifetime_expired" };
  }
  let reason: JobStateConflictReason = "not_uploading";
  if (commitResult.type === "not_found") {
    reason = "missing";
  } else if (commitResult.type === "terminal") {
    reason = mapJobStatusToConflictReason(commitResult.job.status);
  } else if (commitResult.type === "not_uploading") {
    reason = mapJobStatusToConflictReason(commitResult.job.status);
  }
  return { type: "job_state_conflict", reason };
}

export type CleanupResult = {
  attempted: number;
  deleted: number;
  failed: number;
};

export async function cleanupExpiredObjects(store: WorkerJobStore, writer: ObjectStoreWriter, limit: number): Promise<CleanupResult> {
  const expiredObjects = store.listExpiredReadyObjects(limit);
  
  const result: CleanupResult = { attempted: 0, deleted: 0, failed: 0 };
  
  for (const obj of expiredObjects) {
    result.attempted++;
    try {
      await writer.delete(obj.objectKey);
      result.deleted++;
    } catch {
      result.failed++;
    }
  }

  return result;
}
