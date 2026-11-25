/**
 * The Worker's time limits and job lifetimes (VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001,
 * extended by VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001 and
 * VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001).
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
 * loader now refuses that variable by presence.
 *
 * ─── Upload stage (LD-2b) ────────────────────────────────────────────────────
 *
 *  - `uploadMs` (`UPLOAD_TIMEOUT`) is ONE absolute deadline for a job's whole
 *    UPLOAD stage, armed once from the durable `processing → uploading`
 *    transition and capped by the job's execution deadline
 *    (`deriveUploadStageDeadlineMs`). It covers the credential mints, the
 *    PutObject, the HeadObject verification and the ready commit: no operation
 *    receives a fresh budget, and progress and retries never extend it.
 *
 * Those three are the only limits the executor receives
 * (`WorkerStageTimeLimits`).
 *
 * ─── Job lifetimes (LD-2a) ───────────────────────────────────────────────────
 *
 * The durable store owns one column, `expires_at_ms`: "the instant after which
 * this job is no longer authorised". LD-2a assigns it three times, each inside
 * the state transition's own transaction, and never again:
 *
 *  - creation (`queued`): `created + L`, the queue-wait bound;
 *  - claim (`queued → analyzing`): `claimed + L`, the execution bound;
 *  - every terminal transition (`failed`, `cancelled`, restart recovery):
 *    `finished + R`, the retention;
 *  - `ready` (VIDEOFETCH-LD5B-R2-RETENTION-LIFECYCLE-HARDENING-001): the same
 *    `finished + R`, capped by the stored object's provider lifecycle —
 *    `min(finished + R, Last-Modified + R2_OBJECT_LIFECYCLE_AGE_MS
 *    − R2_RESULT_LIFECYCLE_SAFETY_MARGIN_MS)` (`deriveReadyExpiresAtMs`).
 *
 * `executionLifetimeMs` (`L`) is DERIVED here and nowhere else:
 *
 *     L = ANALYSIS_TIMEOUT + DOWNLOAD_TIME_LIMIT + PROCESSING_TIMEOUT
 *         + UPLOAD_TIMEOUT + EXECUTION_MARGIN
 *
 * so it can never disagree with the stage limits it must cover. It is not
 * configurable, and there is no `JOB_LIFETIME` variable. `retentionMs` (`R`) is
 * `FILE_EXPIRATION_MINUTES`, at most 55 minutes: the R2 lifecycle rule makes an
 * object eligible for deletion 60 minutes after its `Last-Modified` instant
 * (the upload's completion), and a link must end at least five minutes before
 * that. The 55-minute maximum ALONE does not guarantee it: the ready commit can
 * follow the completion by minutes (every wait between them is an inactivity
 * bound, not a total), so `ready + R` can pass the provider's eligibility. The
 * ready transition's lifecycle cap is what keeps every ready link inside it,
 * at any `R`.
 *
 * `analysisMs` (`ANALYSIS_TIMEOUT`) exists here only because `L` must budget for
 * it. Analysis is still bounded by the analysis policy, which the runtime builds
 * from the same validated value.
 *
 * `uploadMs` (`UPLOAD_TIMEOUT`) was parsed and budgeted by LD-2a and is ENFORCED
 * since LD-2b. Only the derivation below and the executor read it
 * (`worker-time-limits-boundary.test.ts`); the upload lifecycle receives the
 * absolute deadline the executor derives from it, never the duration.
 *
 * ─── Acquisition inactivity (VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001) ─
 *
 *  - `inactivityMs` (`DOWNLOAD_INACTIVITY_TIMEOUT`) is the acquisition
 *    watchdog's window: a live acquisition phase that has not grown by at least
 *    65,536 real media bytes for this long is stopped. It is a SUBORDINATE
 *    window inside the acquisition stage, never a stage of its own: it is not
 *    part of `L`, it never extends `downloadTimeLimitMs`, and it must end
 *    strictly before it (`buildWorkerTimeLimits` refuses anything else). It
 *    arrived with the enforcement that reads it: the composition root hands it
 *    to the executor's watchdog and nothing else reads it.
 *
 * ─── Defaults ────────────────────────────────────────────────────────────────
 *
 * The acquisition default stays 600 s. The long-download value (9,000 s) is a
 * later, separate change (LD-5b), made only after expiry, upload, inactivity,
 * yt-dlp retry and cancellation are bounded. At the defaults L is 5,445 s
 * (1 h 30 min 45 s), R is 2,700 s (45 min) and the inactivity window is 120 s,
 * which leaves `L` unchanged. This module imports nothing, so
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
 * and budgeted into `L` by LD-2a; enforced as the upload stage's one absolute
 * deadline since LD-2b.
 */
export const UPLOAD_TIMEOUT_SECONDS = Object.freeze({
  min: 300,
  max: 14_400,
  default: 3_600,
} as const);

/**
 * `DOWNLOAD_INACTIVITY_TIMEOUT`, in seconds: the strict loader's range and
 * default (VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001), exactly the accepted
 * long-download design's (`LONG-DOWNLOAD-CONFIGURATION-DESIGN.md` §2.1, §2.4):
 *
 *  - at least 60 s: the window must outlast one yt-dlp attempt under the
 *    watched retry policy's 30 s socket timeout (about 31 s, the design's
 *    invariant I5), and it stays above the watchdog's 30 s suspension gap, so a
 *    scheduling gap the watchdog does not treat as a suspension can never
 *    exhaust it on its own;
 *  - at most 900 s: beyond that it stops being a stall detector;
 *  - and strictly below `DOWNLOAD_TIME_LIMIT`: a window that cannot end before
 *    the absolute deadline would never decide anything.
 *
 * The watchdog arms only its 1 s tick, never a timer of the window's length,
 * so no value in the range comes near the platform timer's limit.
 */
export const DOWNLOAD_INACTIVITY_TIMEOUT_SECONDS = Object.freeze({
  min: 60,
  max: 900,
  default: 120,
} as const);

/**
 * `FILE_EXPIRATION_MINUTES`, in minutes: the strict loader's range and default.
 * The maximum is the R2 lifecycle age less the safety margin
 * (`R2_OBJECT_LIFECYCLE_AGE_MS − R2_RESULT_LIFECYCLE_SAFETY_MARGIN_MS`, pinned by
 * `ready-result-lifecycle.test.ts`). It bounds `R`; it does not by itself keep a ready link
 * five minutes inside the rule, because the rule counts from the object's
 * `Last-Modified`, not from the ready commit. The ready transition's cap
 * (`deriveReadyExpiresAtMs`) does.
 */
export const FILE_EXPIRATION_MINUTES_RANGE = Object.freeze({
  min: 1,
  max: 55,
  default: 45,
} as const);

/**
 * VIDEOFETCH-LD5B-R2-RETENTION-LIFECYCLE-HARDENING-001: the R2 bucket's
 * lifecycle rule (`videofetch-expired-job-backstop`, prefix `videofetch/jobs/`,
 * condition Age, 3,600 s; runbook §5h) makes an object eligible for deletion
 * this long after its `Last-Modified` instant. LD-5a measured it against real
 * R2: `Last-Modified` is the upload's COMPLETION, truncated to the whole second,
 * and the provider reports `expiry-date = Last-Modified + 3,600 s` exactly, with
 * the rule id, on PutObject, HeadObject and GetObject.
 *
 * A property of the bucket's configuration, not a Worker setting: no
 * environment variable changes it.
 */
export const R2_OBJECT_LIFECYCLE_AGE_MS = 3_600_000;

/**
 * LD-5b: how long before the provider's lifecycle eligibility every ready link
 * has already ended. Both ends are judged on R2's OWN clock: the provider makes
 * the object eligible at `Last-Modified + R2_OBJECT_LIFECYCLE_AGE_MS`, and it
 * honours a signed GET only until its `X-Amz-Date + X-Amz-Expires`, which the
 * control plane's signer keeps at or before the job's `expiresAt`
 * (`cloudflare-r2-signer.server.ts`). With `expiresAt <= Last-Modified + 55 min`
 * the five minutes therefore hold whatever the Worker's or the control plane's
 * clock reads; they are spent on nothing but a link used at its last moment.
 */
export const R2_RESULT_LIFECYCLE_SAFETY_MARGIN_MS = 300_000;

/**
 * LD-5b: how far after the ready commit, on the Worker's clock, a provider
 * `Last-Modified` may lie before it is refused as bad data.
 *
 * An object cannot complete after the HEAD that reported it, so a later
 * `Last-Modified` means either a Worker clock behind R2's — harmless to the cap,
 * which is on R2's clock — or a wrong timestamp, which would silently disable
 * the cap (`min()` would then always pick `finished + R`). The bound separates
 * the two at the system's existing clock-skew budget: the Worker already refuses
 * a control-plane request whose timestamp is more than
 * `WORKER_TIMESTAMP_TOLERANCE_SECONDS` (300 s) off its clock, and the Worker
 * VM's guest clock has been recorded stepping by minutes after a host sleep
 * (+236 s, 2026-09-17), so a tighter bound would fail every completed upload
 * during such a lag. Beyond the budget the timestamp is refused, never clamped.
 * Pinned equal to that constant by `ready-result-lifecycle.test.ts` (this
 * module imports nothing).
 */
export const R2_LAST_MODIFIED_FUTURE_TOLERANCE_MS = 300_000;

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
  /**
   * `DOWNLOAD_INACTIVITY_TIMEOUT`: the acquisition watchdog's window, always
   * shorter than `downloadTimeLimitMs` and never part of `L`.
   */
  inactivityMs: number;
  /** ONE absolute deadline per processing stage, shared by its subprocesses. */
  processingMs: number;
  /** `UPLOAD_TIMEOUT`. ONE absolute deadline for a job's upload stage, budgeted into `L`. */
  uploadMs: number;
  /** `R`: how long a terminal outcome stays authorised after it is reached. */
  retentionMs: number;
  /** `L`: the queue-wait bound from creation, and the execution bound from claim. */
  executionLifetimeMs: number;
}>;

/**
 * The three stage limits the executor enforces. An executor receives ONLY these:
 * never a lifetime, which the store assigns and the executor reads back from the
 * job it claimed.
 */
export type WorkerStageTimeLimits = Pick<
  WorkerTimeLimits,
  "downloadTimeLimitMs" | "processingMs" | "uploadMs"
>;

/** The two lifetimes the durable store assigns to `expires_at_ms`. */
export type WorkerJobLifetimes = Pick<WorkerTimeLimits, "executionLifetimeMs" | "retentionMs">;

/** The strict loader's validated values, each in its own unit. */
export type WorkerTimeLimitInputs = Readonly<{
  analysisTimeoutSeconds: number;
  downloadTimeLimitSeconds: number;
  downloadInactivityTimeoutSeconds: number;
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
  const inactivityMs = toMilliseconds(
    "downloadInactivityTimeoutSeconds",
    inputs.downloadInactivityTimeoutSeconds,
    DOWNLOAD_INACTIVITY_TIMEOUT_SECONDS,
    1000,
  );
  // The design's cross-field rule (§2.4), re-checked like the ranges: a window
  // that does not end strictly before the absolute deadline could never decide.
  if (inactivityMs >= downloadTimeLimitMs) {
    throw new WorkerTimeLimitsError("downloadInactivityTimeoutSeconds");
  }
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
    inactivityMs,
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
  downloadInactivityTimeoutSeconds: DOWNLOAD_INACTIVITY_TIMEOUT_SECONDS.default,
  processingTimeoutSeconds: PROCESSING_TIMEOUT_SECONDS.default,
  uploadTimeoutSeconds: UPLOAD_TIMEOUT_SECONDS.default,
  fileExpirationMinutes: FILE_EXPIRATION_MINUTES_RANGE.default,
});

/** The model at every range maximum: the widest values any configuration can reach. */
const MAXIMUM_WORKER_TIME_LIMITS: WorkerTimeLimits = buildWorkerTimeLimits({
  analysisTimeoutSeconds: ANALYSIS_TIMEOUT_SECONDS.max,
  downloadTimeLimitSeconds: DOWNLOAD_TIME_LIMIT_SECONDS.max,
  downloadInactivityTimeoutSeconds: DOWNLOAD_INACTIVITY_TIMEOUT_SECONDS.max,
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
 * Validates an INJECTED stage model and returns a frozen copy of exactly its
 * three fields — whatever else the caller's object carries, a lifetime included,
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
    uploadMs: readInjected(value, "uploadMs", MAXIMUM_WORKER_TIME_LIMITS.uploadMs),
  });
}

/**
 * LD-2b: the ONE absolute deadline of a job's upload stage, in epoch
 * milliseconds.
 *
 *     deadline = min(stageStartedAtMs + uploadMs, executionDeadlineMs)
 *
 * `stageStartedAtMs` is the instant the durable `processing → uploading`
 * transition committed, read back from that transition's own row, and
 * `executionDeadlineMs` is the claimed job's `expiresAt` (`claimed + L`): the
 * upload stage never outlives the job it belongs to. The value is computed once
 * per execution and nothing renews it.
 *
 * Every input must be a safe integer, `uploadMs` positive and no wider than the
 * strict loader can configure; anything else is refused by field name, never
 * clamped into a plausible deadline.
 */
export function deriveUploadStageDeadlineMs(input: {
  stageStartedAtMs: number;
  uploadMs: number;
  executionDeadlineMs: number;
}): number {
  const { stageStartedAtMs, uploadMs, executionDeadlineMs } = input;
  if (!Number.isSafeInteger(stageStartedAtMs) || stageStartedAtMs < 0) {
    throw new WorkerTimeLimitsError("stageStartedAtMs");
  }
  if (
    !Number.isSafeInteger(uploadMs) ||
    uploadMs <= 0 ||
    uploadMs > MAXIMUM_WORKER_TIME_LIMITS.uploadMs
  ) {
    throw new WorkerTimeLimitsError("uploadMs");
  }
  if (!Number.isSafeInteger(executionDeadlineMs) || executionDeadlineMs < 0) {
    throw new WorkerTimeLimitsError("executionDeadlineMs");
  }
  const stageDeadlineMs = stageStartedAtMs + uploadMs;
  if (!Number.isSafeInteger(stageDeadlineMs)) throw new WorkerTimeLimitsError("stageStartedAtMs");
  return Math.min(stageDeadlineMs, executionDeadlineMs);
}

/**
 * LD-5b: a provider `Last-Modified` instant as the Worker carries it internally
 * (`ObjectStoreHead.lastModifiedAtMs`, `CommitReadyInput.lastModifiedAtMs`):
 * epoch MILLISECONDS, a nonnegative safe integer, and a whole number of seconds,
 * the HTTP-date resolution the provider sends. NaN (an invalid `Date`),
 * Infinity, a negative (pre-1970) instant, a fractional second and a local
 * millisecond clock reading are all refused, never rounded.
 */
export function isProviderLastModifiedAtMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value % 1000 === 0;
}

/** Why a ready commit is refused: no expiry satisfies every bound, or the timestamp is unusable. */
export type ReadyExpiryRefusal =
  /** Not a provider `Last-Modified` instant at all, or one whose cap overflows the safe integers. */
  | "invalid_last_modified"
  /** Later than the commit by more than `R2_LAST_MODIFIED_FUTURE_TOLERANCE_MS`: bad data. */
  | "last_modified_in_future"
  /** The provider-safe instant is not after the commit: no availability window is left. */
  | "provider_window_elapsed"
  /**
   * The expiry would fall before the job's own creation, which the row's
   * `CHECK(expires_at_ms >= created_at_ms)` forbids: the Worker's clock stepped
   * back past the creation by more than R, or `Last-Modified` predates the job
   * by more than 55 minutes. Refused, never floored into a longer expiry.
   */
  | "expiry_before_job";

export type ReadyExpiry =
  | { readonly ok: true; readonly expiresAtMs: number; readonly providerSafeExpiresAtMs: number }
  | { readonly ok: false; readonly reason: ReadyExpiryRefusal };

/**
 * LD-5b: the ONE derivation of a ready result's expiry (PO-20):
 *
 *     expiresAt = min(finished + R,
 *                     lastModifiedAt + R2_OBJECT_LIFECYCLE_AGE_MS
 *                                    − R2_RESULT_LIFECYCLE_SAFETY_MARGIN_MS)
 *
 * where `finished` is the instant the transition records as `finished_at_ms`:
 * the row's existing value (`finishedAtMs`, which the UPDATE's `COALESCE`
 * keeps, as at every terminal transition), or else the commit instant
 * `readyCommitAtMs`. An `uploading` row never carries one, so for every row
 * this code produces `finished` is the commit instant: PO-20's `readyCommitAt`.
 * The ONE caller is the durable ready transition, inside its own transaction,
 * with that transaction's own commit instant. Nothing earlier — not the upload
 * finalizer, not the HEAD — decides the expiry, so neither a delayed HEAD nor a
 * delayed commit can carry it past either bound.
 *
 * `lastModifiedAtMs` is the provider's own timestamp, never a local substitute.
 * The second term is on R2's clock, as the provider's deletion is, so it holds
 * whatever the Worker's clock reads. A refusal means the result must not become
 * ready (the caller deletes the exact key it uploaded):
 *
 *  - not a provider instant (`isProviderLastModifiedAtMs`), or a cap past the
 *    safe integers → `invalid_last_modified`;
 *  - after `readyCommitAtMs + R2_LAST_MODIFIED_FUTURE_TOLERANCE_MS` →
 *    `last_modified_in_future` (bad data: it would disable the cap);
 *  - an expiry not after `readyCommitAtMs` → `provider_window_elapsed` (for
 *    every row this code produces only the provider term can do this, since
 *    `finished + R` is then after the commit; a recorded finish more than `R`
 *    before the commit would too);
 *  - an expiry before `jobCreatedAtMs` → `expiry_before_job`.
 *
 * Nothing is clamped or floored: a refused timestamp is never turned into a
 * plausible one, and no expiry is ever lengthened to satisfy the row. The
 * Worker's own instants and `retentionMs` are validated values; anything else
 * there is a caller fault, refused by field name.
 */
export function deriveReadyExpiresAtMs(input: {
  lastModifiedAtMs: number;
  readyCommitAtMs: number;
  finishedAtMs: number | null;
  retentionMs: number;
  jobCreatedAtMs: number;
}): ReadyExpiry {
  const { lastModifiedAtMs, readyCommitAtMs, finishedAtMs, retentionMs, jobCreatedAtMs } = input;
  if (!Number.isSafeInteger(readyCommitAtMs) || readyCommitAtMs < 0) {
    throw new WorkerTimeLimitsError("readyCommitAtMs");
  }
  if (finishedAtMs !== null && (!Number.isSafeInteger(finishedAtMs) || finishedAtMs < 0)) {
    throw new WorkerTimeLimitsError("finishedAtMs");
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
    throw new WorkerTimeLimitsError("retentionMs");
  }
  if (!Number.isSafeInteger(jobCreatedAtMs) || jobCreatedAtMs < 0) {
    throw new WorkerTimeLimitsError("jobCreatedAtMs");
  }
  const retentionBoundMs = (finishedAtMs ?? readyCommitAtMs) + retentionMs;
  if (!Number.isSafeInteger(retentionBoundMs)) {
    throw new WorkerTimeLimitsError(finishedAtMs === null ? "readyCommitAtMs" : "finishedAtMs");
  }
  if (!isProviderLastModifiedAtMs(lastModifiedAtMs)) {
    return { ok: false, reason: "invalid_last_modified" };
  }
  if (lastModifiedAtMs - readyCommitAtMs > R2_LAST_MODIFIED_FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: "last_modified_in_future" };
  }
  const providerSafeExpiresAtMs =
    lastModifiedAtMs + R2_OBJECT_LIFECYCLE_AGE_MS - R2_RESULT_LIFECYCLE_SAFETY_MARGIN_MS;
  if (!Number.isSafeInteger(providerSafeExpiresAtMs)) {
    return { ok: false, reason: "invalid_last_modified" };
  }
  const expiresAtMs = Math.min(retentionBoundMs, providerSafeExpiresAtMs);
  if (expiresAtMs <= readyCommitAtMs) {
    return { ok: false, reason: "provider_window_elapsed" };
  }
  if (expiresAtMs < jobCreatedAtMs) {
    return { ok: false, reason: "expiry_before_job" };
  }
  return { ok: true, expiresAtMs, providerSafeExpiresAtMs };
}

/**
 * Validates the two lifetimes handed to the durable store and returns a frozen
 * copy of exactly them.
 *
 * The same rule as an injected stage model: narrower than the environment
 * minimum is allowed — tests prove an expiry with a few milliseconds — while a
 * malformed value or one wider than the strict ranges can produce is refused.
 * In particular no injection can give `R` more than the 55-minute maximum. A
 * ready link is additionally capped at the stored object's `Last-Modified`
 * plus 55 minutes by the ready transition (`deriveReadyExpiresAtMs`):
 * that cap, not `R`'s range, keeps it inside the R2 lifecycle backstop.
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
