import type { HistoryItem, PolledJob } from "@/lib/client-api";
import { ERROR_MESSAGES, type ErrorCode } from "@/lib/errors";
import { terminalJobMessage } from "@/lib/job-failure-ui";
import {
  STATUS_POLL_INTERVAL_MS,
  startJobStatusPoller,
  type JobStatusPollEvent,
  type JobStatusPoller,
  type PollClock,
} from "@/lib/job-status-poller";

/**
 * BROWSER-JOB-STATUS-POLL-RESILIENCE-001: the downloader's phase and job state.
 *
 * One reducer owns every transition of `phase`, `job` and `error`, so a status
 * result can be checked against the CURRENT state atomically: a result for a
 * job that was reset or replaced, or from a polling session a manual retry
 * superseded, changes nothing.
 *
 * `connectivity` is browser-only. It describes the status channel, never the
 * job: a job the browser cannot currently see stays in `processing`, with its
 * id and last known progress.
 */

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: `restoring`
 * is a page that found its current job's id in this tab's storage after a
 * reload and is reading that job's status — and nothing else. It never creates
 * a job: the only request it makes is a status read, through the same
 * single-flight, retrying poller as a running job, and the job is shown only
 * once the Worker has answered for it.
 */
export type DownloaderPhase = "idle" | "analyzing" | "ready" | "restoring" | "processing" | "complete" | "error";

export type StatusConnectivity = "connected" | "reconnecting" | "retry_exhausted";

/**
 * One polling session. A new object is created only when polling (re)starts —
 * a new job, or a manual retry — so its identity is the session's identity.
 */
export type StatusPollSession = { generation: number; initialDelayMs: number };

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: the one cancellation
 * request the page may have for its CURRENT job. Browser-only, like
 * `connectivity`: it describes the request, never the job. The job's outcome
 * comes only from a status the Worker committed — a cancel answer or a poll.
 *
 *   idle         no request, or none that still matters
 *   requesting   sent, no answer yet; a second one is never sent meanwhile
 *   unconfirmed  it failed without a definitive answer, so it may or may not
 *                have taken effect; the status channel decides
 *   refused      the control plane answered definitively that it did not
 *                cancel (access, rate limit, an unknown or expired job)
 *
 * `attempt` identifies the request, so an answer to an older one changes
 * nothing.
 */
export type CancelRequestState =
  | { kind: "idle" }
  | { kind: "requesting"; jobId: string; attempt: number }
  | { kind: "unconfirmed"; jobId: string; attempt: number }
  | { kind: "refused"; jobId: string; attempt: number; message: string };

export type CancelFailureClass = "unconfirmed" | "refused";

/**
 * LD-4b: what this tab's stored job id should be, as decided by the last
 * transition that had an opinion. The page writes it to storage; the reducer
 * never touches storage itself.
 *
 *   keep   no decision yet (the state a page starts in): storage is left alone,
 *          so a reload can still read what the previous page stored
 *   job    remember this job: the one the page started or restored
 *   clear  forget it: the person started over, or the job is definitively gone
 */
export type StoredJobDirective = { kind: "keep" } | { kind: "job"; jobId: string } | { kind: "clear" };

export type DownloaderState = {
  phase: DownloaderPhase;
  job: PolledJob | null;
  error: string | null;
  connectivity: StatusConnectivity;
  poll: StatusPollSession;
  cancel: CancelRequestState;
  /** LD-4b: the job a `restoring` page is reading; null in every other phase. */
  restoringJobId: string | null;
  /** LD-4b: see `StoredJobDirective`. */
  stored: StoredJobDirective;
  /** LD-4b: a short note for an idle page, e.g. that the previous job is gone. */
  notice: string | null;
};

export type DownloaderAction =
  | { type: "analyze_started" }
  | { type: "analyze_succeeded" }
  | { type: "analyze_failed"; message: string }
  | { type: "download_requested" }
  | { type: "download_started"; job: PolledJob }
  | { type: "download_failed"; message: string }
  | { type: "reset" }
  | { type: "retry_status" }
  | { type: "status_poll"; jobId: string; generation: number; event: JobStatusPollEvent }
  | { type: "cancel_requested"; jobId: string; attempt: number }
  | { type: "cancel_answered"; jobId: string; attempt: number; job: PolledJob }
  | { type: "cancel_failed"; jobId: string; attempt: number; failure: CancelFailureClass; message: string }
  | { type: "choose_again" }
  | { type: "restore_started"; jobId: string };

const NO_CANCEL: CancelRequestState = Object.freeze({ kind: "idle" });
const KEEP_STORED: StoredJobDirective = Object.freeze({ kind: "keep" });
const CLEAR_STORED: StoredJobDirective = Object.freeze({ kind: "clear" });

/** LD-4b: shown on an idle page when the job a reload looked for no longer exists. */
export const RESTORE_UNAVAILABLE_NOTICE = "Your previous download is no longer available.";

/** Status answers that say the job itself is gone: its stored id is of no further use. */
const JOB_GONE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["NOT_FOUND", "EXPIRED"]);

export const initialDownloaderState: DownloaderState = {
  phase: "idle",
  job: null,
  error: null,
  connectivity: "connected",
  poll: { generation: 0, initialDelayMs: STATUS_POLL_INTERVAL_MS },
  cancel: NO_CANCEL,
  restoringJobId: null,
  stored: KEEP_STORED,
  notice: null,
};

/**
 * Whether the page may send a cancellation for `jobId` now: only for the job
 * it is processing, and only while no other request for it is outstanding.
 */
export function canRequestCancel(state: DownloaderState, jobId: string): boolean {
  return state.phase === "processing" && state.job?.jobId === jobId && state.cancel.kind !== "requesting";
}

export function downloaderReducer(state: DownloaderState, action: DownloaderAction): DownloaderState {
  const next = reduce(state, action);
  // A cancellation request belongs to one processing job: once the page shows
  // anything else, it no longer matters, and its late answer changes nothing.
  return next.phase !== "processing" && next.cancel.kind !== "idle" ? { ...next, cancel: NO_CANCEL } : next;
}

function reduce(state: DownloaderState, action: DownloaderAction): DownloaderState {
  switch (action.type) {
    case "analyze_started":
      // A page reading its restored job's status has no input to analyze (the
      // URL field is disabled), so a stray request changes nothing. Any other
      // analysis replaces whatever job the page showed: its stored id goes.
      if (state.phase === "restoring") return state;
      return {
        ...state,
        phase: "analyzing",
        error: null,
        job: null,
        connectivity: "connected",
        stored: CLEAR_STORED,
        notice: null,
      };
    case "analyze_succeeded":
      return { ...state, phase: "ready" };
    case "analyze_failed":
      return { ...state, phase: "error", error: action.message };
    case "download_requested":
      return { ...state, error: null };
    case "download_started":
      return {
        ...state,
        phase: "processing",
        job: action.job,
        connectivity: "connected",
        cancel: NO_CANCEL,
        // The create response is itself a fresh status, so the first read
        // waits one ordinary interval.
        poll: { generation: state.poll.generation + 1, initialDelayMs: STATUS_POLL_INTERVAL_MS },
        restoringJobId: null,
        // LD-4b: this tab's job is now this one, replacing any earlier id.
        stored: { kind: "job", jobId: action.job.jobId },
        notice: null,
      };
    case "download_failed":
      // The phase stays `ready`; the failure is announced by a toast.
      return { ...state, error: action.message };
    case "reset":
      return {
        ...state,
        phase: "idle",
        job: null,
        error: null,
        connectivity: "connected",
        restoringJobId: null,
        // LD-4b: starting over forgets the job; it is not cancelled, and a
        // reload will not bring it back.
        stored: CLEAR_STORED,
        notice: null,
      };
    case "retry_status": {
      // Resumes status checks for the SAME job — a running one, or one a
      // reload is still restoring. Valid only once the loop has given up, so a
      // repeated click cannot start a second loop.
      const resumable =
        (state.phase === "processing" && state.job !== null) ||
        (state.phase === "restoring" && state.restoringJobId !== null);
      if (!resumable || state.connectivity !== "retry_exhausted") return state;
      return {
        ...state,
        connectivity: "reconnecting",
        poll: { generation: state.poll.generation + 1, initialDelayMs: 0 },
      };
    }
    case "restore_started":
      // LD-4b: a reload found this tab's job id. Only a fresh, empty page may
      // restore, and restoring the same id again (a repeated mount effect)
      // changes nothing, so at most one session ever reads it. The first read
      // goes out at once: nothing is known about the job yet.
      if (state.phase === "restoring" && state.restoringJobId === action.jobId) return state;
      if (state.phase !== "idle" || state.job !== null || state.restoringJobId !== null) return state;
      return {
        ...state,
        phase: "restoring",
        restoringJobId: action.jobId,
        error: null,
        connectivity: "connected",
        cancel: NO_CANCEL,
        poll: { generation: state.poll.generation + 1, initialDelayMs: 0 },
        stored: { kind: "job", jobId: action.jobId },
        notice: null,
      };
    case "status_poll":
      return applyStatusPollEvent(state, action);
    case "cancel_requested":
      if (!canRequestCancel(state, action.jobId)) return state;
      return { ...state, cancel: { kind: "requesting", jobId: action.jobId, attempt: action.attempt } };
    case "cancel_answered":
      return applyCancelAnswer(state, action);
    case "cancel_failed":
      return applyCancelFailure(state, action);
    case "choose_again":
      // Back to the quality choice for the SAME analysis, after a job ended
      // without a file. Nothing is sent: only pressing Download again starts a
      // new job, which acquires from the beginning. Never valid for a job that
      // is still running, for a finished file, or when no job outcome is shown.
      if (state.phase !== "error" || !state.job || !ENDED_WITHOUT_FILE.has(state.job.status)) return state;
      return {
        ...state,
        phase: "ready",
        job: null,
        error: null,
        connectivity: "connected",
        cancel: NO_CANCEL,
        // LD-4b: the ended job is no longer this page's job.
        stored: CLEAR_STORED,
      };
  }
}

const ENDED_WITHOUT_FILE: ReadonlySet<string> = new Set(["failed", "cancelled"]);

function isCurrentCancel(
  state: DownloaderState,
  action: { jobId: string; attempt: number },
): boolean {
  return (
    state.phase === "processing" &&
    state.job?.jobId === action.jobId &&
    state.cancel.kind === "requesting" &&
    state.cancel.jobId === action.jobId &&
    state.cancel.attempt === action.attempt
  );
}

/**
 * The Worker's committed job, as the cancel route returned it. It is shown for
 * what it is: `cancelled` only when the Worker says so. A job that had already
 * reached `ready` stays a finished download, and one that had failed keeps its
 * failure. An answer that does not end the job proves nothing, so the status
 * channel decides.
 */
function applyCancelAnswer(
  state: DownloaderState,
  action: Extract<DownloaderAction, { type: "cancel_answered" }>,
): DownloaderState {
  if (!isCurrentCancel(state, action)) return state;
  const job = action.job;
  if (job.jobId !== action.jobId) {
    return { ...state, cancel: { kind: "unconfirmed", jobId: action.jobId, attempt: action.attempt } };
  }
  if (job.status === "ready") {
    return { ...state, phase: "complete", job, error: null, connectivity: "connected" };
  }
  if (job.status === "cancelled" || job.status === "failed") {
    return { ...state, phase: "error", job, error: terminalJobMessage(job), connectivity: "connected" };
  }
  return { ...state, cancel: { kind: "unconfirmed", jobId: action.jobId, attempt: action.attempt } };
}

/**
 * A cancellation that failed. Nothing about the job changes: the page keeps
 * showing it as running, with its last known progress. A request that may have
 * reached the Worker is never sent again automatically; instead, when the
 * status channel had already given up, ONE reconnecting session starts, so the
 * page reads what actually happened as soon as the Worker can be reached.
 */
function applyCancelFailure(
  state: DownloaderState,
  action: Extract<DownloaderAction, { type: "cancel_failed" }>,
): DownloaderState {
  if (!isCurrentCancel(state, action)) return state;
  if (action.failure === "refused") {
    return {
      ...state,
      cancel: { kind: "refused", jobId: action.jobId, attempt: action.attempt, message: action.message },
    };
  }
  const cancel: CancelRequestState = { kind: "unconfirmed", jobId: action.jobId, attempt: action.attempt };
  if (state.connectivity !== "retry_exhausted") return { ...state, cancel };
  return {
    ...state,
    cancel,
    connectivity: "reconnecting",
    poll: { generation: state.poll.generation + 1, initialDelayMs: 0 },
  };
}

function applyStatusPollEvent(
  state: DownloaderState,
  action: Extract<DownloaderAction, { type: "status_poll" }>,
): DownloaderState {
  const owner =
    state.phase === "processing" ? state.job?.jobId : state.phase === "restoring" ? state.restoringJobId : undefined;
  if (owner !== action.jobId || state.poll.generation !== action.generation) {
    return state;
  }
  const event = action.event;
  // LD-4b: the first answer that shows a job ends restoring; from then on the
  // page shows the job exactly as a running page would.
  const shown = { restoringJobId: null } as const;
  switch (event.type) {
    case "status":
      return { ...state, ...shown, phase: "processing", job: event.job, connectivity: "connected" };
    case "reconnecting":
      return state.connectivity === "reconnecting" ? state : { ...state, connectivity: "reconnecting" };
    case "exhausted":
      return { ...state, connectivity: "retry_exhausted" };
    case "ready":
      return { ...state, ...shown, phase: "complete", job: event.job, error: null, connectivity: "connected" };
    case "ended":
      return {
        ...state,
        ...shown,
        phase: "error",
        job: event.job,
        error: terminalJobMessage(event.job),
        connectivity: "connected",
      };
    case "stopped": {
      const gone = event.error.code !== null && JOB_GONE_CODES.has(event.error.code);
      if (state.phase === "restoring") {
        // Nothing was shown yet. A job that no longer exists leaves an empty
        // page with a short note, and its id is forgotten; any other definitive
        // answer (access, for one) is shown as an error, and the id is kept
        // for the access lifecycle to decide.
        if (gone) {
          return {
            ...state,
            ...shown,
            phase: "idle",
            job: null,
            error: null,
            connectivity: "connected",
            stored: CLEAR_STORED,
            notice: RESTORE_UNAVAILABLE_NOTICE,
          };
        }
        return {
          ...state,
          ...shown,
          phase: "error",
          job: null,
          error: event.error.code ? ERROR_MESSAGES[event.error.code] : event.error.message,
          connectivity: "connected",
        };
      }
      // The job is not known to have failed: the last known job is kept, so the
      // card keeps the generic heading, and the message is the canonical one
      // for the code. LD-4b: a job that is gone is forgotten.
      return {
        ...state,
        phase: "error",
        error: event.error.code ? ERROR_MESSAGES[event.error.code] : event.error.message,
        connectivity: "connected",
        ...(gone ? { stored: CLEAR_STORED } : {}),
      };
    }
  }
}

/**
 * The polling session the page should be running, or null for none. Polling
 * runs only while a job is processing and the loop has not given up; the
 * session object changes only when polling (re)starts.
 */
export type StatusPollTarget = { jobId: string; session: StatusPollSession };

export function statusPollTarget(state: DownloaderState): StatusPollTarget | null {
  if (state.connectivity === "retry_exhausted") return null;
  if (state.phase === "processing" && state.job) return { jobId: state.job.jobId, session: state.poll };
  // LD-4b: a restoring page reads its stored job the same way.
  if (state.phase === "restoring" && state.restoringJobId) {
    return { jobId: state.restoringJobId, session: state.poll };
  }
  return null;
}

/**
 * Runs one polling session for `target`, tagging every result with the job and
 * the session it belongs to so the reducer can drop it once either is stale.
 * The caller owns the returned loop and must stop it when the target changes.
 */
export function startStatusPollSession(
  target: StatusPollTarget,
  dispatch: (action: DownloaderAction) => void,
  fetchStatus: (jobId: string, signal: AbortSignal) => Promise<PolledJob>,
  clock?: PollClock,
): JobStatusPoller {
  const { jobId, session } = target;
  return startJobStatusPoller({
    jobId,
    fetchStatus,
    initialDelayMs: session.initialDelayMs,
    clock,
    onEvent: (event) =>
      dispatch({ type: "status_poll", jobId, generation: session.generation, event }),
  });
}

const HISTORY_STATUSES: ReadonlySet<string> = new Set(["ready", "failed", "cancelled"]);

/**
 * The job whose outcome belongs in history, or null. It is derived from the
 * state the reducer ACCEPTED, so a status result the reducer dropped can never
 * be recorded, and only a job's own terminal status counts: a connection that
 * failed, gave up, or was refused says nothing about how the job ended.
 */
export function finishedJobForHistory(state: DownloaderState): PolledJob | null {
  if (state.phase !== "complete" && state.phase !== "error") return null;
  if (!state.job || !HISTORY_STATUSES.has(state.job.status)) return null;
  return state.job;
}

export function historyEntryForJob(
  job: PolledJob,
  video: { title?: string | null; thumbnail?: string | null } | null,
  now: number,
): HistoryItem {
  return {
    jobId: job.jobId,
    title: job.title || video?.title || "Video",
    thumbnail: job.thumbnail || video?.thumbnail || null,
    status: job.status,
    format: job.container,
    quality: job.quality,
    completedAt: now,
  };
}
