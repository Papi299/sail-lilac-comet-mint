import type { StatusConnectivity } from "@/lib/downloader-state";
import type { JobActivity, JobActivityState, JobProgress } from "@/types/job";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: what the
 * progress card says about a running job, decided here so it can be tested
 * without rendering.
 *
 * Everything shown comes from the job's own status: the Worker's stage, its
 * progress fields, and — while downloading — its activity (one closed state
 * and three whole-second counts the Worker measured). Nothing is derived from
 * the percentage, the speed or the ETA, and nothing here can change what the
 * Worker does: the waiting notice is presentation only, and its threshold has
 * no effect on the Worker's own inactivity limit.
 *
 * What is never shown: a remaining time (the limit is a bound, not a promise
 * of completion), a stall (only the job's own outcome can say that), or an
 * acquisition start the Worker did not measure.
 */

/** The waiting notice appears once the source has sent nothing new for this long. */
export const WAITING_NOTICE_AFTER_SECONDS = 20;

/** Largest count the contract allows (`WORKER_JOB_ACTIVITY_MAX_SECONDS`). */
const MAX_ACTIVITY_SECONDS = 86_400;

export const ACTIVITY_LABELS: Readonly<Record<JobActivityState, string>> = Object.freeze({
  starting: "Getting the download ready",
  "awaiting-first-byte": "Waiting for the source to start sending data",
  receiving: "Receiving data from the source",
  waiting: "Waiting for the source to send more data",
  "between-resources": "Moving on to the next part of the stream",
  "between-phases": "One part received. Starting the next part",
  unobserved: "Still downloading. Progress can't be measured right now",
});

/** What each later stage means, so a finished download is never shown as still downloading. */
export const STAGE_DESCRIPTIONS: Readonly<Partial<Record<JobProgress["status"], string>>> = Object.freeze({
  queued: "Waiting for a free slot to start",
  analyzing: "Checking the video before downloading",
  downloading: "Downloading from the source",
  processing: "Download complete. Preparing the file",
  uploading: "Download complete. Finishing up",
});

export const WAITING_NOTICE_TITLE = "Waiting for the source to send more data.";
export const WAITING_NOTICE_MESSAGE =
  "The download is still running. VideoFetch will stop it if the source stays inactive for too long.";

export const ELAPSED_LABEL = "Elapsed since request";
export const DOWNLOAD_LIMIT_LABEL = "Download time limit";
export const DOWNLOADING_FOR_LABEL = "Downloading for";

const NOTICE_STATES: ReadonlySet<JobActivityState> = new Set<JobActivityState>([
  "awaiting-first-byte",
  "waiting",
  "between-resources",
]);

function isCount(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= MAX_ACTIVITY_SECONDS;
}

/**
 * The job's activity, if this page can trust and understand it: a downloading
 * job, a state this build knows, and counts within the contract's bounds.
 * Anything else — a field from a newer or older control plane, an unknown
 * state, a malformed count — is treated as no activity, never guessed at.
 */
export function knownActivity(job: Pick<JobProgress, "status" | "activity">): JobActivity | null {
  const activity = job.activity;
  if (job.status !== "downloading" || activity === null || activity === undefined || typeof activity !== "object") {
    return null;
  }
  if (!Object.hasOwn(ACTIVITY_LABELS, activity.state)) return null;
  const { elapsedSeconds, limitSeconds, idleSeconds } = activity;
  if (elapsedSeconds !== null && !isCount(elapsedSeconds)) return null;
  if (limitSeconds !== null && !isCount(limitSeconds, 1)) return null;
  if (idleSeconds !== null && !isCount(idleSeconds)) return null;
  return activity;
}

export type ProgressCardView = Readonly<{
  /** The stage in words (changes rarely: suitable for a polite live region). */
  stageDescription: string | null;
  /** The activity in words, or null when there is none to show right now. */
  activityLabel: string | null;
  showWaitingNotice: boolean;
  /** Whole seconds since the request was made, or null when the clocks disagree. */
  elapsedSinceRequestSeconds: number | null;
  /** The armed acquisition limit, while downloading and known. */
  downloadLimitSeconds: number | null;
  /** How long the acquisition has run, as the Worker measured it. */
  downloadingForSeconds: number | null;
}>;

/**
 * Whole seconds since the job was created, by this browser's clock against the
 * Worker's `createdAt`. The two clocks are independent, so a reading that
 * cannot be right — well before the job existed, or past the job's own expiry
 * — is shown as unknown rather than as a wrong number. A small negative
 * difference (a browser clock slightly behind) reads as zero.
 */
export function elapsedSinceRequestSeconds(
  job: Pick<JobProgress, "createdAt" | "expiresAt">,
  nowMs: number,
): number | null {
  if (!Number.isFinite(nowMs) || !Number.isFinite(job.createdAt) || !Number.isFinite(job.expiresAt)) return null;
  const elapsedMs = nowMs - job.createdAt;
  if (elapsedMs < -5_000) return null;
  if (nowMs > job.expiresAt + 60_000) return null;
  return Math.max(0, Math.floor(elapsedMs / 1000));
}

/**
 * The progress card's facts. The activity is shown only while the status
 * channel is connected: a reading taken before an outage is not presented as
 * the source's current state.
 */
export function progressCardView(
  job: Pick<JobProgress, "status" | "activity" | "createdAt" | "expiresAt">,
  options: { connectivity: StatusConnectivity; nowMs: number },
): ProgressCardView {
  const live = options.connectivity === "connected";
  const activity = live ? knownActivity(job) : null;
  const downloading = job.status === "downloading";
  const showWaitingNotice =
    activity !== null &&
    NOTICE_STATES.has(activity.state) &&
    activity.idleSeconds !== null &&
    activity.idleSeconds >= WAITING_NOTICE_AFTER_SECONDS;
  const known = downloading ? knownActivity(job) : null;
  return Object.freeze({
    stageDescription: STAGE_DESCRIPTIONS[job.status] ?? null,
    activityLabel: activity === null ? null : ACTIVITY_LABELS[activity.state],
    showWaitingNotice,
    elapsedSinceRequestSeconds: elapsedSinceRequestSeconds(job, options.nowMs),
    // The limit is a fixed fact of the armed acquisition: still true during an outage.
    downloadLimitSeconds: known?.limitSeconds ?? null,
    downloadingForSeconds: activity?.elapsedSeconds ?? null,
  });
}

/** `m:ss`, or `h:mm:ss` from one hour. */
export function formatClock(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** A limit in plain words: "10 min", "1 h 30 min", "45 s". */
export function formatLimit(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return "—";
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} h`);
  if (m > 0) parts.push(`${m} min`);
  if (sec > 0) parts.push(`${sec} s`);
  return parts.join(" ");
}
