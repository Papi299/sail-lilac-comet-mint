import {
  assessAcquisitionActivity,
  type AcquisitionActivitySnapshot,
  type AcquisitionActivityStatus,
} from "@/services/downloads/acquisition-activity";
import {
  WORKER_JOB_ACTIVITY_MAX_SECONDS,
  WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS,
  WorkerJobActivitySchema,
  type WorkerJobActivity,
  type WorkerJobActivityState,
} from "@/shared/worker/job-activity";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the ONE
 * projection from the acquisition watchdog's observation to the public
 * activity contract (`job-activity.ts`).
 *
 * Pure. It reads one snapshot of the watchdog's own tracker and the LD-3a
 * assessment of it, at one reading of the watchdog's own monotonic clock; it
 * measures nothing itself, holds no state, arms no timer and calls nothing
 * that records. The watchdog's decisions cannot depend on it, and it never
 * suggests one: a stall and an observation loss are the job's outcome, decided
 * by the watchdog and recorded by the store, never an activity state.
 *
 * ─── Internal assessment → public state ─────────────────────────────────────
 *
 *   not-started          → starting
 *   awaiting-first-byte  → awaiting-first-byte
 *   receiving            ┐ receiving while the last observed advance is at most
 *   not-advancing        ├ WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS old,
 *   retry-discarded      ┘ waiting once it is older (a discard is not progress)
 *   between-resources    → between-resources
 *   between-phases       → between-phases
 *   unobserved           → unobserved
 *   deadline-exceeded    ┐
 *   completed            │ null: the acquisition is over or its limit has
 *   cancelled            │ passed, and the job's durable status — not this —
 *   failed               ┘ says what happened
 *
 * Transport evidence (direct, clear HLS) reports nothing during silence, so the
 * assessment can still say `receiving` for a silent transfer until its window
 * passes; the idle time is what tells the two apart here, which is why the
 * three transfer statuses share one rule.
 *
 * Anything the contract cannot state exactly — a clock that is not a finite
 * number, a time before the deadline was armed, a value past the contract's
 * bounds — is no activity (null), never a clamped or invented one. The result
 * is checked against the contract before it is returned.
 */

const LIVE_TRANSFER: ReadonlySet<AcquisitionActivityStatus> = new Set<AcquisitionActivityStatus>([
  "receiving",
  "not-advancing",
  "retry-discarded",
]);

function wholeSeconds(ms: number): number | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  return seconds <= WORKER_JOB_ACTIVITY_MAX_SECONDS ? seconds : null;
}

function publicState(
  status: AcquisitionActivityStatus,
  idleSeconds: number | null,
): WorkerJobActivityState | null {
  switch (status) {
    case "not-started":
      return "starting";
    case "awaiting-first-byte":
      return "awaiting-first-byte";
    case "between-resources":
      return "between-resources";
    case "between-phases":
      return "between-phases";
    case "unobserved":
      return "unobserved";
    case "receiving":
    case "not-advancing":
    case "retry-discarded":
      if (idleSeconds === null) return null;
      return idleSeconds <= WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS ? "receiving" : "waiting";
    case "deadline-exceeded":
    case "completed":
    case "cancelled":
    case "failed":
      return null;
  }
}

/**
 * The public activity of one acquisition at `nowMs`, or null. `windowMs` is the
 * watchdog's own window, passed through to the assessment unchanged.
 */
export function projectAcquisitionActivity(
  snapshot: AcquisitionActivitySnapshot,
  policy: { readonly nowMs: number; readonly windowMs: number },
): WorkerJobActivity | null {
  const { nowMs, windowMs } = policy;
  if (!Number.isFinite(nowMs)) return null;
  let status: AcquisitionActivityStatus;
  try {
    status = assessAcquisitionActivity(snapshot, { nowMs, windowMs }).status;
  } catch {
    return null;
  }

  // The deadline as armed: its duration and the time it was armed.
  let elapsedSeconds: number | null = null;
  let limitSeconds: number | null = null;
  if (snapshot.deadlineAtMs !== null || snapshot.deadlineLimitMs !== null) {
    if (snapshot.deadlineAtMs === null || snapshot.deadlineLimitMs === null) return null;
    elapsedSeconds = wholeSeconds(nowMs - (snapshot.deadlineAtMs - snapshot.deadlineLimitMs));
    const limit = Math.ceil(snapshot.deadlineLimitMs / 1000);
    limitSeconds = limit >= 1 && limit <= WORKER_JOB_ACTIVITY_MAX_SECONDS ? limit : null;
    if (elapsedSeconds === null || limitSeconds === null) return null;
  }

  // Idle time of the live part: since its last observed advance, or since it
  // started when no byte has arrived yet. Only meaningful where a part is live.
  let idleSeconds: number | null = null;
  if (status === "awaiting-first-byte" || status === "between-resources" || LIVE_TRANSFER.has(status)) {
    const since = snapshot.lastAdvanceAtMs ?? snapshot.anchorAtMs;
    if (since === null) return null;
    idleSeconds = wholeSeconds(nowMs - since);
    if (idleSeconds === null) return null;
  }

  const state = publicState(status, idleSeconds);
  if (state === null) return null;
  const parsed = WorkerJobActivitySchema.safeParse({ state, elapsedSeconds, limitSeconds, idleSeconds });
  return parsed.success ? parsed.data : null;
}
