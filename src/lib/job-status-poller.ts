import { ClientApiError, type PolledJob } from "@/lib/client-api";
import type { ErrorCode } from "@/lib/errors";

/**
 * BROWSER-JOB-STATUS-POLL-RESILIENCE-001: the job-status polling loop.
 *
 * A Worker job keeps running whether or not the browser can see it. A status
 * read that fails therefore says nothing about the job unless the response
 * itself establishes that polling cannot continue, so a transient failure must
 * never end the download on screen. This module decides, per failure, whether
 * to keep trying, and paces the attempts; it does not render anything.
 *
 * Single flight: the next request is scheduled only after the previous one has
 * settled, so at most one status request per job is ever in flight — a slow
 * response delays the loop instead of stacking requests behind it.
 */

/** Pace of a healthy loop: the cadence the fixed 800 ms interval had. */
export const STATUS_POLL_INTERVAL_MS = 800;

/**
 * Delay before the next attempt after the Nth consecutive transient failure
 * (index N - 1); the last entry is the cap.
 */
export const STATUS_POLL_RETRY_DELAYS_MS: readonly number[] = Object.freeze([800, 1500, 3000, 5000]);

/**
 * How long a continuous outage may last, measured from the start of its first
 * failed request, before the loop stops and hands the decision to the person.
 *
 * Sized against the Production tunnel as measured on 2026-09-29: each episode
 * in which all four cloudflared connections dropped re-registered within 1–2 s
 * of detection, but a status read caught in one can still take up to the
 * control plane's 30 s Worker request budget to fail. 120 s outlasts several
 * such episodes back to back. Multi-minute tunnel outages (seen 2026-09-17)
 * are not ordinary reconnects; they end in the recoverable retry-exhausted
 * state, which keeps the job.
 */
export const STATUS_POLL_RETRY_BUDGET_MS = 120_000;

/**
 * A status read that has not settled after this long is aborted and counted as
 * a transient failure, so one hung request cannot stall the loop or keep the
 * outage clock from ever running out. Healthy Production round trips measured
 * about 0.4 s; this stays below the control plane's own 30 s Worker budget so a
 * request stuck behind a dead tunnel is replaced rather than waited out.
 */
export const STATUS_REQUEST_TIMEOUT_MS = 15_000;

export type StatusPollFailureClass = "transient" | "definitive";

/**
 * Answers that end polling: the job is gone, expired, or this browser may no
 * longer ask about it. Retrying cannot change any of them.
 */
const DEFINITIVE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "NOT_FOUND",
  "EXPIRED",
  "ACCESS_REQUIRED",
  "ACCESS_NOT_CONFIGURED",
  "FORBIDDEN",
]);

/**
 * Classifies a failed status read by structure only — the failure kind, the
 * allowlisted code and the HTTP status — never by message text.
 *
 * - transient: no response at all; `WORKER_UNAVAILABLE`; any 5xx not carrying
 *   a definitive code (a tunnel outage reaches the browser as a 500, because
 *   the edge's HTML error page fails the Worker response contract); 408 and
 *   429, which ask to be retried later; and a 2xx whose body is not a job
 *   status, which is something in between answering rather than the endpoint.
 * - definitive: a definitive code, and every other 4xx.
 *
 * Anything that is not a `ClientApiError` did not come from a classified
 * response, so it is transient; the retry budget bounds it.
 */
export function classifyStatusPollFailure(error: unknown): StatusPollFailureClass {
  if (!(error instanceof ClientApiError)) return "transient";
  if (error.kind === "network") return "transient";
  if (error.code !== null && DEFINITIVE_CODES.has(error.code)) return "definitive";
  if (error.code === "WORKER_UNAVAILABLE") return "transient";
  const status = error.status;
  if (status === null || status >= 500 || status === 408 || status === 429 || status < 400) {
    return "transient";
  }
  return "definitive";
}

/** Delay after `consecutiveFailures` transient failures in a row (>= 1). */
export function statusPollRetryDelayMs(consecutiveFailures: number): number {
  const last = STATUS_POLL_RETRY_DELAYS_MS.length - 1;
  const index = Math.min(Math.max(consecutiveFailures, 1) - 1, last);
  return STATUS_POLL_RETRY_DELAYS_MS[index];
}

/**
 * What the loop reports. After `ready`, `ended`, `stopped` or `exhausted` the
 * loop has stopped itself and reports nothing further.
 */
export type JobStatusPollEvent =
  /** A non-terminal status; the loop continues at the healthy cadence. */
  | { type: "status"; job: PolledJob }
  /** The job reached `ready`. */
  | { type: "ready"; job: PolledJob }
  /** The job ended without a file: `failed` or `cancelled`. */
  | { type: "ended"; job: PolledJob }
  /** A transient failure inside the budget; the loop will try again. */
  | { type: "reconnecting" }
  /** The outage outlasted the budget; the job may still be running. */
  | { type: "exhausted" }
  /** A definitive answer: polling cannot validly continue. */
  | { type: "stopped"; error: ClientApiError };

/** Injectable time source, so the loop can run under a fake clock. */
export type PollClock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const browserClock: PollClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type JobStatusPoller = {
  /**
   * Ends the loop: clears any pending timer and aborts the request in flight.
   * Nothing is reported after `stop()` returns, even if that request settles.
   */
  stop(): void;
};

export function startJobStatusPoller(options: {
  jobId: string;
  fetchStatus: (jobId: string, signal: AbortSignal) => Promise<PolledJob>;
  onEvent: (event: JobStatusPollEvent) => void;
  /** Delay before the first request. */
  initialDelayMs?: number;
  clock?: PollClock;
}): JobStatusPoller {
  const { jobId, fetchStatus, onEvent } = options;
  const clock = options.clock ?? browserClock;

  let stopped = false;
  let nextTimer: unknown = null;
  let inFlight: AbortController | null = null;
  let requestTimer: unknown = null;
  let consecutiveFailures = 0;
  let outageStartedAt: number | null = null;

  function schedule(ms: number): void {
    if (stopped) return;
    nextTimer = clock.setTimeout(attempt, ms);
  }

  function emit(event: JobStatusPollEvent): void {
    if (!stopped) onEvent(event);
  }

  function finish(event: JobStatusPollEvent): void {
    emit(event);
    stop();
  }

  function attempt(): void {
    nextTimer = null;
    // Single flight: a second request never starts while one is outstanding.
    if (stopped || inFlight !== null) return;
    const controller = new AbortController();
    inFlight = controller;
    const startedAt = clock.now();
    requestTimer = clock.setTimeout(() => controller.abort(), STATUS_REQUEST_TIMEOUT_MS);

    let request: Promise<PolledJob>;
    try {
      request = fetchStatus(jobId, controller.signal);
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (job) => settle(controller, () => succeeded(job)),
      (error: unknown) => settle(controller, () => failed(error, startedAt)),
    );
  }

  function settle(controller: AbortController, handle: () => void): void {
    // A response from a request this loop no longer owns (stopped, or already
    // replaced) is dropped.
    if (inFlight !== controller) return;
    inFlight = null;
    clock.clearTimeout(requestTimer);
    requestTimer = null;
    if (!stopped) handle();
  }

  function succeeded(job: PolledJob): void {
    consecutiveFailures = 0;
    outageStartedAt = null;
    if (job.status === "ready") return finish({ type: "ready", job });
    if (job.status === "failed" || job.status === "cancelled") {
      return finish({ type: "ended", job });
    }
    emit({ type: "status", job });
    schedule(STATUS_POLL_INTERVAL_MS);
  }

  function failed(error: unknown, startedAt: number): void {
    if (classifyStatusPollFailure(error) === "definitive") {
      // Only a ClientApiError can be definitive.
      return finish({ type: "stopped", error: error as ClientApiError });
    }
    consecutiveFailures += 1;
    outageStartedAt ??= startedAt;
    if (clock.now() - outageStartedAt >= STATUS_POLL_RETRY_BUDGET_MS) {
      return finish({ type: "exhausted" });
    }
    emit({ type: "reconnecting" });
    schedule(statusPollRetryDelayMs(consecutiveFailures));
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (nextTimer !== null) clock.clearTimeout(nextTimer);
    nextTimer = null;
    if (requestTimer !== null) clock.clearTimeout(requestTimer);
    requestTimer = null;
    const controller = inFlight;
    inFlight = null;
    controller?.abort();
  }

  schedule(options.initialDelayMs ?? STATUS_POLL_INTERVAL_MS);
  return { stop };
}
