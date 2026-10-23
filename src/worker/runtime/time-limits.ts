/**
 * The Worker's stage time limits (VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001).
 *
 * ONE model, built ONCE by the composition root (`runtime.server.ts`) from the
 * strict loader's validated values, and injected into every stage a time limit
 * bounds. Nothing downstream reads the environment or the legacy module
 * configuration (`src/lib/config.ts`) for a Worker time limit, and nothing
 * downstream computes one of its own.
 *
 * The two limits are deliberately distinct, and neither stands in for the other:
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
 * ─── Staging ─────────────────────────────────────────────────────────────────
 *
 * The approved design's full model (`LONG-DOWNLOAD-CONFIGURATION-DESIGN.md` §3)
 * also names `analysisMs`, `inactivityMs`, `uploadMs`, `retentionMs` and
 * `executionLifetimeMs`. LD-1 activates only the two limits above, so only they
 * exist here. A field that nothing enforces yet would be a value some later code
 * could read before the change that gives it meaning; each later phase adds its
 * field together with its enforcement (`retentionMs`, `uploadMs` parsing and
 * `executionLifetimeMs` in LD-2a, `uploadMs` enforcement in LD-2b,
 * `inactivityMs` in LD-3b). Adding a readonly field is a compatible extension:
 * every consumer reads the fields it names and nothing else.
 *
 * ─── Defaults ────────────────────────────────────────────────────────────────
 *
 * The acquisition default stays 600 s. The long-download value (9,000 s) is a
 * later, separate change (LD-5b), made only after expiry, upload, inactivity,
 * yt-dlp retry and cancellation are bounded. This module imports nothing, so
 * the executor can depend on it without reaching the loader.
 */

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

export type WorkerTimeLimits = Readonly<{
  /** ONE absolute deadline for a job's whole acquisition stage. */
  downloadTimeLimitMs: number;
  /** ONE absolute deadline per processing stage, shared by its subprocesses. */
  processingMs: number;
}>;

/** The strict loader's validated values, in its own unit. */
export type WorkerTimeLimitSeconds = Readonly<{
  downloadTimeLimitSeconds: number;
  processingTimeoutSeconds: number;
}>;

type TimeLimitField = keyof WorkerTimeLimits;

const MAXIMUM_MS: Readonly<Record<TimeLimitField, number>> = Object.freeze({
  downloadTimeLimitMs: DOWNLOAD_TIME_LIMIT_SECONDS.max * 1000,
  processingMs: PROCESSING_TIMEOUT_SECONDS.max * 1000,
});

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
  seconds: number,
  range: { readonly min: number; readonly max: number },
): number {
  if (!Number.isSafeInteger(seconds) || seconds < range.min || seconds > range.max) {
    throw new WorkerTimeLimitsError(field);
  }
  const ms = seconds * 1000;
  // Unreachable inside the ranges above; kept so the invariant is stated where
  // the arithmetic happens rather than assumed from them.
  if (!Number.isSafeInteger(ms)) throw new WorkerTimeLimitsError(field);
  return ms;
}

/**
 * Builds the model from the strict loader's values. The ONE production
 * construction point is `createWorkerRuntime`.
 *
 * The ranges are re-checked rather than trusted, so a caller that bypassed the
 * loader still cannot build a limit the environment could not express.
 */
export function buildWorkerTimeLimits(seconds: WorkerTimeLimitSeconds): WorkerTimeLimits {
  return Object.freeze({
    downloadTimeLimitMs: toMilliseconds(
      "downloadTimeLimitSeconds",
      seconds.downloadTimeLimitSeconds,
      DOWNLOAD_TIME_LIMIT_SECONDS,
    ),
    processingMs: toMilliseconds(
      "processingTimeoutSeconds",
      seconds.processingTimeoutSeconds,
      PROCESSING_TIMEOUT_SECONDS,
    ),
  });
}

/**
 * The strict loader's defaults, as a model: what a Worker with neither
 * `DOWNLOAD_TIME_LIMIT` nor `PROCESSING_TIMEOUT` set runs with. It is also the
 * executor's fallback when no model is injected — the same reviewed values, and
 * never the legacy module configuration.
 */
export const DEFAULT_WORKER_TIME_LIMITS: WorkerTimeLimits = buildWorkerTimeLimits({
  downloadTimeLimitSeconds: DOWNLOAD_TIME_LIMIT_SECONDS.default,
  processingTimeoutSeconds: PROCESSING_TIMEOUT_SECONDS.default,
});

/**
 * Validates an INJECTED model and returns a frozen copy of exactly its two
 * fields.
 *
 * Each field must be a positive safe integer of milliseconds no larger than
 * the environment maximum. A model may be NARROWER than the environment
 * minimum — tests and acceptance harnesses narrow a deadline to prove it is
 * shared — but never malformed and never wider than the strict loader could
 * configure, so no injection can lift a stage's upper bound.
 */
export function assertWorkerTimeLimits(value: unknown): WorkerTimeLimits {
  if (typeof value !== "object" || value === null) {
    throw new WorkerTimeLimitsError("timeLimits");
  }
  const read = (field: TimeLimitField): number => {
    const ms = (value as Record<string, unknown>)[field];
    if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0 || ms > MAXIMUM_MS[field]) {
      throw new WorkerTimeLimitsError(field);
    }
    return ms;
  };
  return Object.freeze({
    downloadTimeLimitMs: read("downloadTimeLimitMs"),
    processingMs: read("processingMs"),
  });
}
