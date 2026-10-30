/**
 * The Worker's time limits and job lifetimes (VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001,
 * extended by VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001).
 *
 * ONE model, built ONCE by the composition root (`runtime.server.ts`) from the
 * strict loader's validated values, and injected into every stage a time limit
 * bounds. Nothing downstream reads the environment or the legacy module
 * configuration (`src/lib/config.ts`) for a Worker time limit, and nothing
 * downstream computes one of its own.
 *
 * ─── Stage limits (LD-1) ─────────────────────────────────────────────────────
 *
 * The two stage limits are deliberately distinct, and neither stands in for the
 * other:
 *
 *  - `downloadTimeLimitMs` (`DOWNLOAD_TIME_LIMIT`) is ONE absolute deadline for a
 *    job's whole ACQUISITION stage. It is armed once, after analysis and the URL
 *    check, and covers the yt-dlp runtime probe, both halves of a split or
 *    separate-audio pair, every fragment and every retry. Progress never extends
 *    it, and cancellation and the size ceilings stay independent of it.
 *  - `processingMs` (`PROCESSING_TIMEOUT`) is ONE absolute deadline per
 *    PROCESSING stage, shared by every FFmpeg and ffprobe subprocess that stage
 *    runs. It is never a fresh budget per subprocess.
 *
 * Both replace the retired `DOWNLOAD_TIMEOUT`, which bounded acquisition AND
 * every processing subprocess with one value read by two loaders. The strict
 * loader now refuses that variable by presence. They are the only two limits
 * the executor receives (`WorkerStageTimeLimits`).
 *
 * ─── Job lifetimes (LD-2a) ───────────────────────────────────────────────────
 *
 * The durable store owns one column, `expires_at_ms`: "the instant after which
 * this job is no longer authorised". LD-2a assigns it three times, each inside
 * the state transition's own transaction, and never again:
 *
 *  - creation (`queued`): `created + L`, the queue-wait bound;
 *  - claim (`queued → analyzing`): `claimed + L`, the execution bound;
 *  - every terminal transition (`ready`, `failed`, `cancelled`, restart
 *    recovery): `finished + R`, the retention.
 *
 * `executionLifetimeMs` (`L`) is DERIVED here and nowhere else:
 *
 *     L = ANALYSIS_TIMEOUT + DOWNLOAD_TIME_LIMIT + PROCESSING_TIMEOUT
 *         + UPLOAD_TIMEOUT + EXECUTION_MARGIN
 *
 * so it can never disagree with the stage limits it must cover. It is not
 * configurable, and there is no `JOB_LIFETIME` variable. `retentionMs` (`R`) is
 * `FILE_EXPIRATION_MINUTES`, capped at 55 minutes because the R2 lifecycle rule
 * deletes an object 60 minutes after it is written: the link must end first.
 *
 * Two fields exist only because `L` must budget for them:
 *
 *  - `analysisMs` (`ANALYSIS_TIMEOUT`). Analysis is still bounded by the analysis
 *    policy, which the runtime builds from the same validated value.
 *  - `uploadMs` (`UPLOAD_TIMEOUT`) is PARSED AND BUDGETED, NOT ENFORCED. Nothing
 *    bounds or cancels the R2 upload yet: an upload already in flight runs to its
 *    own end. LD-2b enforces this value. Until then no Worker module reads it but
 *    the derivation below (`worker-time-limits-boundary.test.ts`), and the
 *    executor never receives it.
 *
 * `inactivityMs` (`DOWNLOAD_INACTIVITY_TIMEOUT`) arrives with its watchdog in
 * LD-3b. A field that nothing enforces would be a value some later code could
 * read before the change that gives it meaning; `uploadMs` is the one deliberate
 * exception, because the lifetime must already reserve the upload's time.
 *
 * ─── Defaults ────────────────────────────────────────────────────────────────
 *
 * The acquisition default stays 600 s. The long-download value (9,000 s) is a
 * later, separate change (LD-5b), made only after expiry, upload, inactivity,
 * yt-dlp retry and cancellation are bounded. At the defaults L is 5,445 s
 * (1 h 30 min 45 s) and R is 2,700 s (45 min). This module imports nothing, so
 * the executor and the store can depend on it without reaching the loader.
 */

/** `ANALYSIS_TIMEOUT`, in seconds: the strict loader's range and default. */
export const ANALYSIS_TIMEOUT_SECONDS = Object.freeze({
  min: 1,
  max: 3_600,
  default: 45,
} as const);

/** `DOWNLOAD_TIME_LIMIT`, in seconds: the strict loader's range and default. */
export const DOWNLOAD_TIME_LIMIT_SECONDS = Object.freeze({
  min: 60,
  max: 21_600,
  default: 600,
} as const);

/** `PROCESSING_TIMEOUT`, in seconds: the strict loader's range and default. */
export const PROCESSING_TIMEOUT_SECONDS = Object.freeze({
  min: 60,
  max: 14_400,
  default: 600,
} as const);

/**
 * `UPLOAD_TIMEOUT`, in seconds: the strict loader's range and default. Parsed
 * and budgeted into `L` by LD-2a; enforced only from LD-2b.
 */
export const UPLOAD_TIMEOUT_SECONDS = Object.freeze({
  min: 300,
  max: 14_400,
  default: 3_600,
} as const);

/**
 * `FILE_EXPIRATION_MINUTES`, in minutes: the strict loader's range and default.
 * The maximum keeps a ready link at least five minutes inside the R2 lifecycle
 * rule, which deletes an object 3,600 s after it is written.
 */
export const FILE_EXPIRATION_MINUTES_RANGE = Object.freeze({
  min: 1,
  max: 55,
  default: 45,
} as const);

/**
 * The reviewed slack inside `L`, in seconds: two HLS preflights, the yt-dlp
 * probe, file moves and the ready commit. A constant, not a variable.
 */
export const EXECUTION_MARGIN_SECONDS = 600;

export type WorkerTimeLimits = Readonly<{
  /** `ANALYSIS_TIMEOUT`. Budgeted into `L`; enforced by the analysis policy. */
  analysisMs: number;
  /** ONE absolute deadline for a job's whole acquisition stage. */
  downloadTimeLimitMs: number;
  /** ONE absolute deadline per processing stage, shared by its subprocesses. */
  processingMs: number;
  /** `UPLOAD_TIMEOUT`. Budgeted into `L`; NOT enforced before LD-2b. */
  uploadMs: number;
  /** `R`: how long a terminal outcome stays authorised after it is reached. */
  retentionMs: number;
  /** `L`: the queue-wait bound from creation, and the execution bound from claim. */
  executionLifetimeMs: number;
}>;

/**
 * The two limits the executor hands to its stage seams. An executor receives
 * ONLY these: never `uploadMs`, which nothing enforces yet, and never a
 * lifetime, which the store assigns and the executor reads back from the job it
 * claimed.
 */
export type WorkerStageTimeLimits = Pick<WorkerTimeLimits, "downloadTimeLimitMs" | "processingMs">;

/** The two lifetimes the durable store assigns to `expires_at_ms`. */
export type WorkerJobLifetimes = Pick<WorkerTimeLimits, "executionLifetimeMs" | "retentionMs">;

/** The strict loader's validated values, each in its own unit. */
export type WorkerTimeLimitInputs = Readonly<{
  analysisTimeoutSeconds: number;
  downloadTimeLimitSeconds: number;
  processingTimeoutSeconds: number;
  uploadTimeoutSeconds: number;
  fileExpirationMinutes: number;
}>;

/**
 * A malformed time-limit input. Names the FIELD only, never the value, like
 * every other configuration failure in the Worker.
 */
export class WorkerTimeLimitsError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Invalid Worker time limit: ${field}`);
    this.name = "WorkerTimeLimitsError";
    this.field = field;
  }
}

function toMilliseconds(
  field: string,
  value: number,
  range: { readonly min: number; readonly max: number },
  unitMs: number,
): number {
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    throw new WorkerTimeLimitsError(field);
  }
  const ms = value * unitMs;
  // Unreachable inside the ranges above; kept so the invariant is stated where
  // the arithmetic happens rather than assumed from them.
  if (!Number.isSafeInteger(ms)) throw new WorkerTimeLimitsError(field);
  return ms;
}

/**
 * Builds the model from the strict loader's values. The ONE production
 * construction point is `createWorkerRuntime`, and this is the ONE place `L` is
 * computed.
 *
 * The ranges are re-checked rather than trusted, so a caller that bypassed the
 * loader still cannot build a limit the environment could not express.
 */
export function buildWorkerTimeLimits(inputs: WorkerTimeLimitInputs): WorkerTimeLimits {
  const analysisMs = toMilliseconds(
    "analysisTimeoutSeconds",
    inputs.analysisTimeoutSeconds,
    ANALYSIS_TIMEOUT_SECONDS,
    1000,
  );
  const downloadTimeLimitMs = toMilliseconds(
    "downloadTimeLimitSeconds",
    inputs.downloadTimeLimitSeconds,
    DOWNLOAD_TIME_LIMIT_SECONDS,
    1000,
  );
  const processingMs = toMilliseconds(
    "processingTimeoutSeconds",
    inputs.processingTimeoutSeconds,
    PROCESSING_TIMEOUT_SECONDS,
    1000,
  );
  const uploadMs = toMilliseconds(
    "uploadTimeoutSeconds",
    inputs.uploadTimeoutSeconds,
    UPLOAD_TIMEOUT_SECONDS,
    1000,
  );
  const retentionMs = toMilliseconds(
    "fileExpirationMinutes",
    inputs.fileExpirationMinutes,
    FILE_EXPIRATION_MINUTES_RANGE,
    60_000,
  );
  const executionLifetimeMs =
    analysisMs + downloadTimeLimitMs + processingMs + uploadMs + EXECUTION_MARGIN_SECONDS * 1000;
  // Every term is bounded above, so the sum is at most 54,600,000 ms; checked
  // here for the same reason as `toMilliseconds`.
  if (!Number.isSafeInteger(executionLifetimeMs)) {
    throw new WorkerTimeLimitsError("executionLifetimeMs");
  }
  return Object.freeze({
    analysisMs,
    downloadTimeLimitMs,
    processingMs,
    uploadMs,
    retentionMs,
    executionLifetimeMs,
  });
}

/**
 * The strict loader's defaults, as a model: what a Worker with none of the
 * variables above set runs with. It is also the executor's and the store's
 * fallback when nothing is injected — the same reviewed values, and never the
 * legacy module configuration.
 */
export const DEFAULT_WORKER_TIME_LIMITS: WorkerTimeLimits = buildWorkerTimeLimits({
  analysisTimeoutSeconds: ANALYSIS_TIMEOUT_SECONDS.default,
  downloadTimeLimitSeconds: DOWNLOAD_TIME_LIMIT_SECONDS.default,
  processingTimeoutSeconds: PROCESSING_TIMEOUT_SECONDS.default,
  uploadTimeoutSeconds: UPLOAD_TIMEOUT_SECONDS.default,
  fileExpirationMinutes: FILE_EXPIRATION_MINUTES_RANGE.default,
});

/** The model at every range maximum: the widest values any configuration can reach. */
const MAXIMUM_WORKER_TIME_LIMITS: WorkerTimeLimits = buildWorkerTimeLimits({
  analysisTimeoutSeconds: ANALYSIS_TIMEOUT_SECONDS.max,
  downloadTimeLimitSeconds: DOWNLOAD_TIME_LIMIT_SECONDS.max,
  processingTimeoutSeconds: PROCESSING_TIMEOUT_SECONDS.max,
  uploadTimeoutSeconds: UPLOAD_TIMEOUT_SECONDS.max,
  fileExpirationMinutes: FILE_EXPIRATION_MINUTES_RANGE.max,
});

/** An injected value: a positive safe integer of milliseconds, at most `maximum`. */
function readInjected(value: object, field: string, maximum: number): number {
  const ms = (value as Record<string, unknown>)[field];
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0 || ms > maximum) {
    throw new WorkerTimeLimitsError(field);
  }
  return ms;
}

/**
 * Validates an INJECTED stage model and returns a frozen copy of exactly its two
 * fields — whatever else the caller's object carries, `uploadMs` included,
 * never reaches the executor.
 *
 * Each field must be a positive safe integer of milliseconds no larger than
 * the environment maximum. A model may be NARROWER than the environment
 * minimum — tests and acceptance harnesses narrow a deadline to prove it is
 * shared — but never malformed and never wider than the strict loader could
 * configure, so no injection can lift a stage's upper bound.
 */
export function assertWorkerStageTimeLimits(value: unknown): WorkerStageTimeLimits {
  if (typeof value !== "object" || value === null) {
    throw new WorkerTimeLimitsError("timeLimits");
  }
  return Object.freeze({
    downloadTimeLimitMs: readInjected(
      value,
      "downloadTimeLimitMs",
      MAXIMUM_WORKER_TIME_LIMITS.downloadTimeLimitMs,
    ),
    processingMs: readInjected(value, "processingMs", MAXIMUM_WORKER_TIME_LIMITS.processingMs),
  });
}

/**
 * Validates the two lifetimes handed to the durable store and returns a frozen
 * copy of exactly them.
 *
 * The same rule as an injected stage model: narrower than the environment
 * minimum is allowed — tests prove an expiry with a few milliseconds — while a
 * malformed value or one wider than the strict ranges can produce is refused.
 * In particular no injection can give a ready link a retention that outlives
 * the R2 lifecycle backstop.
 */
export function assertWorkerJobLifetimes(value: unknown): WorkerJobLifetimes {
  if (typeof value !== "object" || value === null) {
    throw new WorkerTimeLimitsError("jobLifetimes");
  }
  return Object.freeze({
    executionLifetimeMs: readInjected(
      value,
      "executionLifetimeMs",
      MAXIMUM_WORKER_TIME_LIMITS.executionLifetimeMs,
    ),
    retentionMs: readInjected(value, "retentionMs", MAXIMUM_WORKER_TIME_LIMITS.retentionMs),
  });
}
