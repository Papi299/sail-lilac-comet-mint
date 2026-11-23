/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the one
 * thing this tab remembers about its current job, so a reload can find the
 * SAME job again.
 *
 * Only the job's id is kept — 32 lowercase hex characters the Worker generated
 * — under a versioned key, in `sessionStorage`: it lives as long as this tab,
 * and no other tab or window opened later sees it. Nothing else is stored: no
 * source URL, no title, no status, no file name, no link, no cookie and no
 * credential. The id alone grants nothing; every read of the job still goes
 * through private access.
 *
 * Reading never sends anything. What the page does with an id — one status
 * read, never a new job — is the page's and the reducer's.
 *
 * Every access is guarded: storage that is blocked, full, or throws simply
 * means no reattachment, never a failure of the page.
 */

export const ACTIVE_JOB_STORAGE_KEY = "videofetch:active-job:v1";
export const ACTIVE_JOB_STORAGE_VERSION = 1;

/** Longest stored value this version can have written; anything longer is not ours. */
const MAX_STORED_LENGTH = 64;
const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

export type StoredActiveJob =
  /** Nothing stored. */
  | { kind: "none" }
  /** A well-formed entry of this version. */
  | { kind: "job"; jobId: string }
  /** Something is stored, but not a well-formed entry of this version: it should be removed. */
  | { kind: "invalid" }
  /** Storage cannot be read at all (blocked, or no browser). */
  | { kind: "unavailable" };

/** The tab's session storage, or null where it does not exist or refuses access. */
export function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function isStorableJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value);
}

/** Reads and validates the entry. Never throws, never writes. */
export function readActiveJob(storage: Storage | null = sessionStorageOrNull()): StoredActiveJob {
  if (storage === null) return { kind: "unavailable" };
  let raw: string | null;
  try {
    raw = storage.getItem(ACTIVE_JOB_STORAGE_KEY);
  } catch {
    return { kind: "unavailable" };
  }
  if (raw === null) return { kind: "none" };
  if (raw.length > MAX_STORED_LENGTH) return { kind: "invalid" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "invalid" };
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "jobId" || keys[1] !== "v") return { kind: "invalid" };
  const entry = parsed as { v: unknown; jobId: unknown };
  if (entry.v !== ACTIVE_JOB_STORAGE_VERSION || !isStorableJobId(entry.jobId)) return { kind: "invalid" };
  return { kind: "job", jobId: entry.jobId };
}

/** Remembers `jobId` as this tab's current job. Returns whether it was stored. */
export function writeActiveJob(jobId: string, storage: Storage | null = sessionStorageOrNull()): boolean {
  if (storage === null || !isStorableJobId(jobId)) return false;
  try {
    storage.setItem(ACTIVE_JOB_STORAGE_KEY, JSON.stringify({ v: ACTIVE_JOB_STORAGE_VERSION, jobId }));
    return true;
  } catch {
    return false;
  }
}

/** Forgets this tab's current job. Never throws. */
export function clearActiveJob(storage: Storage | null = sessionStorageOrNull()): void {
  if (storage === null) return;
  try {
    storage.removeItem(ACTIVE_JOB_STORAGE_KEY);
  } catch {
    // Blocked storage holds nothing this page could read back either.
  }
}

/**
 * The job id this tab remembers belongs to a session with private access.
 * Whenever the tab is found WITHOUT it — on a load whose session has expired or
 * was ended in another tab — the id is forgotten, so no later sign-in in this
 * tab brings an earlier job back. (Locking from this tab forgets it too, in the
 * access gate.) A development bypass has no session, and keeps it.
 */
export function clearActiveJobWithoutAccess(
  session: { authenticated: boolean; developmentBypass: boolean },
  storage: Storage | null = sessionStorageOrNull(),
): void {
  if (!session.authenticated && !session.developmentBypass) clearActiveJob(storage);
}

/**
 * The page's restore step, run once after it mounts: the action to dispatch
 * for what this tab stored — `restore_started` for a well-formed id, nothing
 * otherwise — and an entry that is not a well-formed id of this version is
 * removed. It sends nothing: the status read that follows is the reducer's and
 * the poller's.
 */
export function restoreActionFromStorage(
  storage: Storage | null = sessionStorageOrNull(),
): { type: "restore_started"; jobId: string } | null {
  const stored = readActiveJob(storage);
  if (stored.kind === "job") return { type: "restore_started", jobId: stored.jobId };
  if (stored.kind === "invalid") clearActiveJob(storage);
  return null;
}

/**
 * Carries out the reducer's decision about the stored id (its
 * `StoredJobDirective`): remember a job, forget it, or — the state a page
 * starts in — leave storage exactly as the previous page left it.
 */
export function applyStoredJobDirective(
  directive: { kind: "keep" } | { kind: "job"; jobId: string } | { kind: "clear" },
  storage: Storage | null = sessionStorageOrNull(),
): void {
  if (directive.kind === "job") writeActiveJob(directive.jobId, storage);
  else if (directive.kind === "clear") clearActiveJob(storage);
}
