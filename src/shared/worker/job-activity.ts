import { z } from "zod";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the PUBLIC
 * acquisition-activity contract of a job status.
 *
 * What the Worker may say about a job's LIVE acquisition, in a closed
 * vocabulary of one state and three bounded whole-second counts. It is a
 * projection of the acquisition watchdog's own observation (LD-3a/LD-3), never
 * a second measurement: the Worker reads the watchdog's tracker and maps its
 * assessment, and nothing here can reach the watchdog, its window or the
 * absolute acquisition deadline.
 *
 * It carries no URL, host, path, object key, token, file name, title,
 * extractor or tool output, no free text, and no internal event: a value the
 * schema does not enumerate is a contract violation, refused as a whole.
 *
 * ─── States ─────────────────────────────────────────────────────────────────
 *
 *   starting             the acquisition is being prepared: no transfer part
 *                        has started yet.
 *   awaiting-first-byte  a transfer part has started; no media byte yet.
 *   receiving            media bytes advanced within the last
 *                        `WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS`.
 *   waiting              a transfer part has received bytes, but none has
 *                        advanced it for longer than that. NOT a stall: a stall
 *                        is decided only by the watchdog, over its own window,
 *                        and is reported as the job's failure, never here.
 *   between-resources    one stream resource finished and the next has not
 *                        produced a byte yet (segmented streams).
 *   between-phases       one part of a pair finished; the next has not started.
 *   unobserved           the Worker cannot currently measure the transfer. It
 *                        says nothing about the source, and is never a stall.
 *
 * ─── Numbers (whole seconds, floored, bounded) ──────────────────────────────
 *
 *   elapsedSeconds  time since the acquisition's absolute deadline was armed,
 *                   on the Worker's monotonic clock; null until it is armed.
 *   limitSeconds    that deadline's duration, as armed; null until it is
 *                   armed. Not a countdown, and never extended by anything.
 *   idleSeconds     time since the current part's last observed byte advance
 *                   — or since the part started, before its first byte. Null
 *                   exactly when there is no live, observable part (starting,
 *                   between-phases, unobserved).
 *
 * ─── Absence ────────────────────────────────────────────────────────────────
 *
 * A job view without the field comes from a Worker that does not publish it
 * (every Worker before this contract, and this one with publishing off). A
 * `null` value means the Worker publishes it but holds no live observation for
 * the job: it is not downloading, its acquisition has not reached the watchdog
 * yet, or it has just settled. Neither means anything about the source.
 */

export const WORKER_JOB_ACTIVITY_STATES = [
  "starting",
  "awaiting-first-byte",
  "receiving",
  "waiting",
  "between-resources",
  "between-phases",
  "unobserved",
] as const;

export const WorkerJobActivityStateSchema = z.enum(WORKER_JOB_ACTIVITY_STATES);
export type WorkerJobActivityState = z.infer<typeof WorkerJobActivityStateSchema>;

/**
 * Upper bound on every number in the contract: one day. Above the strict
 * Worker loader's largest acquisition limit (`DOWNLOAD_TIME_LIMIT`, 21,600 s),
 * which a test keeps true.
 */
export const WORKER_JOB_ACTIVITY_MAX_SECONDS = 86_400;

/**
 * `receiving` means the last observed advance is at most this many whole
 * seconds old; `waiting` means it is older. Presentation only: it decides
 * which word a status shows, never whether an acquisition continues.
 */
export const WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS = 4;

/** The states with a live, observable transfer part: exactly these carry `idleSeconds`. */
export const WORKER_JOB_ACTIVITY_IDLE_STATES: ReadonlySet<WorkerJobActivityState> = new Set<WorkerJobActivityState>([
  "awaiting-first-byte",
  "receiving",
  "waiting",
  "between-resources",
]);

/** Whole seconds, bounded: the type of `elapsedSeconds` and `idleSeconds`. */
export const WorkerJobActivitySecondsSchema = z.number().int().min(0).max(WORKER_JOB_ACTIVITY_MAX_SECONDS);

/** A positive bounded whole-second duration: the type of `limitSeconds`. */
export const WorkerJobActivityLimitSecondsSchema = z.number().int().min(1).max(WORKER_JOB_ACTIVITY_MAX_SECONDS);

type JobActivityFields = {
  state: WorkerJobActivityState;
  elapsedSeconds: number | null;
  limitSeconds: number | null;
  idleSeconds: number | null;
};

/**
 * The cross-field rules of the contract, shared by the Worker's schema and the
 * browser DTO's, so the two can never disagree about what is consistent. Each
 * holds exactly for what the Worker's projection produces.
 */
export function jobActivityConsistencyIssues(a: JobActivityFields): string[] {
  const issues: string[] = [];
  if ((a.elapsedSeconds === null) !== (a.limitSeconds === null)) {
    issues.push("elapsedSeconds and limitSeconds are armed together");
  }
  if (a.elapsedSeconds !== null && a.limitSeconds !== null && a.elapsedSeconds > a.limitSeconds) {
    issues.push("an acquisition past its limit has no live activity");
  }
  const live = WORKER_JOB_ACTIVITY_IDLE_STATES.has(a.state);
  if (live !== (a.idleSeconds !== null)) {
    issues.push("idleSeconds is present exactly for a live, observable part");
  }
  if (a.idleSeconds !== null) {
    if (a.state === "receiving" && a.idleSeconds > WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS) {
      issues.push("receiving means a recent advance");
    }
    if (a.state === "waiting" && a.idleSeconds <= WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS) {
      issues.push("waiting means no recent advance");
    }
  }
  return issues;
}

export const WorkerJobActivitySchema = z
  .object({
    state: WorkerJobActivityStateSchema,
    elapsedSeconds: WorkerJobActivitySecondsSchema.nullable(),
    limitSeconds: WorkerJobActivityLimitSecondsSchema.nullable(),
    idleSeconds: WorkerJobActivitySecondsSchema.nullable(),
  })
  .strict()
  .superRefine((a, ctx) => {
    for (const message of jobActivityConsistencyIssues(a)) ctx.addIssue({ code: "custom", message });
  });
export type WorkerJobActivity = z.infer<typeof WorkerJobActivitySchema>;

/** The only job status whose view may carry a non-null activity. */
export const WORKER_JOB_ACTIVITY_STATUS = "downloading" as const;
