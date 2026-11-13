import { ClientApiError, type PolledJob } from "@/lib/client-api";
import {
  canRequestCancel,
  type CancelFailureClass,
  type DownloaderAction,
  type DownloaderState,
} from "@/lib/downloader-state";
import { ERROR_MESSAGES } from "@/lib/errors";
import type { PollClock } from "@/lib/job-status-poller";
import { formatBytes } from "@/lib/utils";

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: sends the page's
 * cancellation request, once, and reports its answer to the reducer.
 *
 * It decides nothing about the job. A 200 carries the job the Worker committed,
 * which the reducer shows as it is; every failure is classified here, by
 * structure only — whether a response existed, its status and its allowlisted
 * code — never by message text.
 */

/**
 * How long the browser waits for one cancellation answer. Above the control
 * plane's own 30 s Worker budget, so that budget's classified answer normally
 * arrives first; this only bounds a request that never settles at all.
 */
export const CANCEL_REQUEST_TIMEOUT_MS = 45_000;

/** Shown when the control plane refused with no recognised code (e.g. an older deployment without the route). */
export const CANCEL_UNAVAILABLE_MESSAGE = "Cancelling isn't available right now.";

/**
 * - unconfirmed: no response; `WORKER_UNAVAILABLE`; any other 5xx; 408; or a
 *   2xx that is not this job's status. The request may have reached the Worker
 *   and taken effect, or not.
 * - refused: every other 4xx, including 429 — the control plane answered before
 *   or instead of cancelling (access, the rate limit, an invalid, unknown or
 *   expired job).
 * Anything that is not a `ClientApiError` did not come from a classified
 * response, so it is unconfirmed.
 */
export function classifyCancelFailure(error: unknown): CancelFailureClass {
  if (!(error instanceof ClientApiError)) return "unconfirmed";
  if (error.kind === "network") return "unconfirmed";
  if (error.code === "WORKER_UNAVAILABLE") return "unconfirmed";
  const status = error.status;
  if (status === null || status >= 500 || status === 408 || status < 400) return "unconfirmed";
  return "refused";
}

/** The canonical, application-owned reason a refusal shows; never the response's own text. */
export function cancelRefusalMessage(error: unknown): string {
  if (error instanceof ClientApiError && error.code !== null) return ERROR_MESSAGES[error.code];
  return CANCEL_UNAVAILABLE_MESSAGE;
}

/**
 * What confirming will do, including what is lost, for the confirmation
 * dialog. Nothing is resumable: a later download starts from the beginning.
 */
export function cancelConfirmDescription(downloadedBytes: number | null): string {
  const received =
    downloadedBytes != null && downloadedBytes > 0
      ? `the ${formatBytes(downloadedBytes)} received so far`
      : "anything received so far";
  return `VideoFetch will stop this download and discard ${received}. Downloading this video again starts from the beginning.`;
}

export type CancelController = {
  /**
   * Sends a cancellation for `jobId` if the page may (it is the job being
   * processed and no request is outstanding). Returns whether one was sent.
   */
  request(jobId: string): boolean;
  /**
   * The page is going away. Later answers are ignored. The request itself is
   * NOT aborted: the person confirmed it, so it is allowed to arrive.
   */
  dispose(): void;
};

const browserTimers: Pick<PollClock, "setTimeout" | "clearTimeout"> = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createCancelController(options: {
  getState: () => DownloaderState;
  dispatch: (action: DownloaderAction) => void;
  cancel: (jobId: string, signal: AbortSignal) => Promise<PolledJob>;
  clock?: Pick<PollClock, "setTimeout" | "clearTimeout">;
  timeoutMs?: number;
}): CancelController {
  const clock = options.clock ?? browserTimers;
  const timeoutMs = options.timeoutMs ?? CANCEL_REQUEST_TIMEOUT_MS;
  let lastAttempt = 0;
  let inFlight = false;
  let disposed = false;
  let pendingTimer: unknown = null;

  function request(jobId: string): boolean {
    // Single flight: the page state may not have re-rendered between two
    // clicks, so the controller's own flag is checked first.
    if (disposed || inFlight || !canRequestCancel(options.getState(), jobId)) return false;
    inFlight = true;
    const attempt = ++lastAttempt;
    options.dispatch({ type: "cancel_requested", jobId, attempt });

    const controller = new AbortController();
    const timer = clock.setTimeout(() => controller.abort(), timeoutMs);
    pendingTimer = timer;
    const settle = (report: () => void) => {
      clock.clearTimeout(timer);
      if (pendingTimer === timer) pendingTimer = null;
      inFlight = false;
      if (!disposed) report();
    };

    let answer: Promise<PolledJob>;
    try {
      answer = options.cancel(jobId, controller.signal);
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(
      (job) => settle(() => options.dispatch({ type: "cancel_answered", jobId, attempt, job })),
      (error: unknown) =>
        settle(() => {
          const failure = classifyCancelFailure(error);
          options.dispatch({
            type: "cancel_failed",
            jobId,
            attempt,
            failure,
            message: failure === "refused" ? cancelRefusalMessage(error) : "",
          });
        }),
    );
    return true;
  }

  function dispose(): void {
    disposed = true;
    if (pendingTimer !== null) clock.clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  return { request, dispose };
}
