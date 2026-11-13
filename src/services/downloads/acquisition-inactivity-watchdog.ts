/**
 * Acquisition inactivity watchdog (VIDEOFETCH-LD3B-INACTIVITY-WATCHDOG-CORE-001).
 *
 * The narrow consumer of the LD-3a activity model that DECIDES: one watchdog per
 * acquisition, owning that acquisition's one tracker, stops a live phase that
 * has made no meaningful progress for the inactivity window — the accepted
 * design's rule: no growth of at least 65,536 real media bytes within 120 s.
 *
 * It decides nothing else. It never measures progress itself: the high-water
 * mark, the 64 KiB anchor, the three-sample discard, the phase model and the
 * first-wins absolute deadline are the tracker's, and the window's precedence
 * (a settled acquisition, a passed deadline, no phase yet, between phases) is
 * the LD-3a assessment's. It imports nothing else, performs no I/O and owns no
 * platform timer: the monotonic clock and the timer hooks are injected, so it
 * runs in virtual time in tests.
 *
 * ─── Subordinate to the absolute deadline ───────────────────────────────────
 *
 * The acquisition's absolute deadline is the seam's own, armed once and never
 * extended. The watchdog never stops for it and never moves it: once the
 * deadline has passed it makes no further decision and releases its timer,
 * also when the window would end at the same instant. Progress can only move
 * the window's anchor, never the deadline.
 *
 * ─── What can move the window ───────────────────────────────────────────────
 *
 *   - a phase start: the phase is anchored at its start, with no bytes;
 *   - the tracker's anchor moving by meaningful growth.
 *
 * A percentage, a progress callback, a rename, a fragment boundary, a retry, a
 * log line or a metadata request is not an event of this model at all, and a
 * resource boundary or a repeated reading moves nothing. A confirmed discard
 * lowers the anchor's bytes and never its time.
 *
 * ─── Observation loss: bounded, never silent ────────────────────────────────
 *
 * The tracker calls a phase `unobserved` after three consecutive filesystem
 * gaps and, when a sample is readable again, re-anchors it with a fresh window.
 * Taken as is, a repeated pattern of three gaps and one readable sample would
 * re-arm a fresh window forever. This watchdog therefore:
 *
 *   - PAUSES the window while the phase is unobserved, for at most
 *     `maxUnobservedMs` of blind time in total since its honoured anchor;
 *   - honours a recovery's fresh window only when the bytes grew by at least
 *     the floor over that anchor while it could not see them.
 *
 * A stalled phase therefore stops at most `windowMs + maxUnobservedMs` after
 * its last meaningful progress. Transport evidence (direct, clear HLS) never
 * reports a gap, so this applies to filesystem evidence only.
 *
 * ─── Time ───────────────────────────────────────────────────────────────────
 *
 * One timer at a time: a tick every `tickMs`, armed at the first phase start.
 * A stop lands at the first tick at or after the window's end — never before
 * it. Two ticks further apart than `suspensionGapMs` mean the process did not
 * run (a frozen VM, a starved event loop): the window gets one fresh start from
 * the resume, and the deadline is not re-anchored. A clock reading that is not
 * a finite number makes no decision, ever again: the absolute deadline remains
 * the bound.
 *
 * ─── Ending ─────────────────────────────────────────────────────────────────
 *
 * `onStall` runs at most once, after the decision is latched; its exception is
 * dropped. The timer is released on a stop, when the acquisition reports how it
 * ended, once the deadline has passed, on a clock fault and on `dispose()`
 * (idempotent). After `dispose()` every event and every timer callback is a
 * no-op. The watchdog writes nothing durable and exposes only numbers and
 * fixed strings.
 */

import {
  ACQUISITION_PROGRESS_MIN_GROWTH_BYTES,
  assessAcquisitionActivity,
  createAcquisitionActivityTracker,
  type AcquisitionActivityPhase,
  type AcquisitionActivitySink,
  type AcquisitionActivitySnapshot,
} from "@/services/downloads/acquisition-activity";

/** The default tick: how often the window is read. */
export const ACQUISITION_INACTIVITY_TICK_MS = 1_000;

/** The default gap between two ticks that means the process did not run. */
export const ACQUISITION_INACTIVITY_SUSPENSION_GAP_MS = 30_000;

export type AcquisitionInactivityPolicy = Readonly<{
  /** The inactivity window, in milliseconds (`DOWNLOAD_INACTIVITY_TIMEOUT`). */
  windowMs: number;
  /** How often the window is read. Default 1,000 ms; never more than the window. */
  tickMs?: number;
  /** Two ticks further apart than this mean the process did not run. Default 30,000 ms; more than a tick. */
  suspensionGapMs?: number;
  /** Blind time a phase may pause its window for, in total, since its honoured anchor. Default: the window. */
  maxUnobservedMs?: number;
}>;

export type ResolvedAcquisitionInactivityPolicy = Readonly<Required<AcquisitionInactivityPolicy>>;

/** A timer handle: `unref` where the platform has one. */
export type InactivityWatchdogTimerHandle = { unref?: () => unknown };

export type InactivityWatchdogTimers = Readonly<{
  setTimeoutFn: (handler: () => void, ms: number) => InactivityWatchdogTimerHandle;
  clearTimeoutFn: (handle: InactivityWatchdogTimerHandle) => void;
}>;

/** The one decision this watchdog makes, in a closed vocabulary of numbers and fixed strings. */
export type AcquisitionInactivityStop = Readonly<{
  cause: "inactivity";
  phase: AcquisitionActivityPhase;
  /** The phase's high-water mark of real media bytes when it was stopped. */
  observedBytes: number;
  /** How long the phase had gone without meaningful progress, credited blind time excluded. */
  idleMs: number;
  windowMs: number;
}>;

export type AcquisitionInactivityWatchdogState =
  /** No phase has started: no timer, no window. */
  | "idle"
  /** A phase has started: the timer runs and a stop is possible. */
  | "watching"
  /** This watchdog stopped the acquisition. */
  | "stopped"
  /** The acquisition reported how it ended. */
  | "settled"
  /** The absolute deadline passed: the seam's own deadline decides. */
  | "time-limit"
  /** The clock returned something that is not a finite number. */
  | "clock-fault"
  /** Released by its owner. */
  | "disposed";

export type AcquisitionInactivityWatchdogReport = Readonly<{
  state: AcquisitionInactivityWatchdogState;
  stop: AcquisitionInactivityStop | null;
  /** Fresh windows granted after a detected suspension. */
  suspensions: number;
  /** The time the window is measured from (before blind-time credit and suspension), or null before a phase. */
  honouredAnchorAtMs: number | null;
  /** Blind time credited to the honoured anchor so far, capped at `maxUnobservedMs`. */
  unobservedCreditMs: number;
}>;

export type AcquisitionInactivityWatchdog = {
  /** The acquisition's ONE activity sink. */
  readonly record: AcquisitionActivitySink;
  /** The tracker's facts, as of the last event. */
  snapshot(): AcquisitionActivitySnapshot;
  report(): AcquisitionInactivityWatchdogReport;
  /** Releases the timer for good. Idempotent and synchronous. */
  dispose(): void;
};

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The policy with its defaults, or a RangeError: a window that cannot be
 * measured is refused when the policy is built, never discovered mid-download.
 */
export function resolveAcquisitionInactivityPolicy(
  policy: AcquisitionInactivityPolicy,
): ResolvedAcquisitionInactivityPolicy {
  const raw = (policy ?? {}) as Partial<Record<keyof AcquisitionInactivityPolicy, unknown>>;
  const windowMs = raw.windowMs;
  if (!positiveSafeInteger(windowMs)) throw new RangeError("invalid inactivity window");
  const tickMs = raw.tickMs ?? ACQUISITION_INACTIVITY_TICK_MS;
  if (!positiveSafeInteger(tickMs) || tickMs > windowMs) throw new RangeError("invalid inactivity tick");
  const suspensionGapMs = raw.suspensionGapMs ?? ACQUISITION_INACTIVITY_SUSPENSION_GAP_MS;
  if (!positiveSafeInteger(suspensionGapMs) || suspensionGapMs <= tickMs) {
    throw new RangeError("invalid suspension gap");
  }
  const maxUnobservedMs = raw.maxUnobservedMs ?? windowMs;
  if (typeof maxUnobservedMs !== "number" || !Number.isSafeInteger(maxUnobservedMs) || maxUnobservedMs < 0) {
    throw new RangeError("invalid unobserved allowance");
  }
  return Object.freeze({ windowMs, tickMs, suspensionGapMs, maxUnobservedMs });
}

/**
 * One watchdog for ONE acquisition. Feed every event of that acquisition to
 * `record`; call `dispose()` when the acquisition settles.
 */
export function createAcquisitionInactivityWatchdog(opts: {
  readonly policy: AcquisitionInactivityPolicy;
  /** Monotonic: `performance.now` in production, a virtual clock in tests. */
  readonly clock: () => number;
  readonly timers: InactivityWatchdogTimers;
  /** Called at most once, when the window has passed with no meaningful progress. */
  readonly onStall: (stop: AcquisitionInactivityStop) => void;
}): AcquisitionInactivityWatchdog {
  const policy = resolveAcquisitionInactivityPolicy(opts.policy);
  const { windowMs, tickMs, suspensionGapMs, maxUnobservedMs } = policy;
  const { clock, timers, onStall } = opts;

  // The tracker reads the time of the event being recorded, so the tracker and
  // this watchdog's own accounting see one reading per event.
  let eventNow = 0;
  const tracker = createAcquisitionActivityTracker({ clock: () => eventNow });

  let state: AcquisitionInactivityWatchdogState = "idle";
  let timer: InactivityWatchdogTimerHandle | null = null;
  let stop: AcquisitionInactivityStop | null = null;
  let lastReading = 0;
  let lastTickAtMs: number | null = null;
  let suspensions = 0;
  let suspensionGrantAtMs: number | null = null;

  // The anchor the window is measured from: the tracker's, except a recovery
  // re-anchor that no visible growth backs.
  let honouredAnchorAtMs: number | null = null;
  let honouredAnchorBytes = 0;
  let trackerAnchorAtMs: number | null = null;
  // Blind time since the honoured anchor: closed runs, and the open one.
  let unobservedMs = 0;
  let blindSinceMs: number | null = null;

  const deciding = () => state === "idle" || state === "watching";

  const readClock = (): number | null => {
    let value: unknown;
    try {
      value = clock();
    } catch {
      value = Number.NaN;
    }
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const release = () => {
    if (timer === null) return;
    const handle = timer;
    timer = null;
    timers.clearTimeoutFn(handle);
  };

  /** A terminal state for decisions: no timer survives it. */
  const end = (next: Exclude<AcquisitionInactivityWatchdogState, "idle" | "watching">) => {
    state = next;
    release();
  };

  const isUnobserved = (snapshot: AcquisitionActivitySnapshot, nowMs: number) =>
    assessAcquisitionActivity(snapshot, { nowMs, windowMs }).status === "unobserved";

  const honour = (atMs: number, bytes: number) => {
    honouredAnchorAtMs = atMs;
    honouredAnchorBytes = bytes;
    unobservedMs = 0;
    blindSinceMs = null;
  };

  const blindCreditMs = (nowMs: number) =>
    Math.min(unobservedMs + (blindSinceMs === null ? 0 : Math.max(0, nowMs - blindSinceMs)), maxUnobservedMs);

  const schedule = () => {
    if (state !== "watching" || timer !== null) return;
    const handle = timers.setTimeoutFn(tick, tickMs);
    handle.unref?.();
    timer = handle;
  };

  function tick() {
    timer = null;
    if (state !== "watching") return;
    const now = readClock();
    if (now === null) {
      end("clock-fault");
      return;
    }
    lastReading = now;
    if (lastTickAtMs !== null && now - lastTickAtMs > suspensionGapMs) {
      // The process did not run: one fresh window from the resume.
      suspensionGrantAtMs = now;
      suspensions += 1;
    }
    lastTickAtMs = now;

    const snapshot = tracker.snapshot();
    const { status } = assessAcquisitionActivity(snapshot, { nowMs: now, windowMs });
    if (snapshot.outcome !== null) {
      end("settled");
      return;
    }
    // Precedence is the assessment's: a passed deadline outranks the window,
    // also at the same instant, and nothing runs before or between phases.
    if (status === "deadline-exceeded") {
      end("time-limit");
      return;
    }
    if (status === "not-started" || status === "between-phases" || honouredAnchorAtMs === null) {
      schedule();
      return;
    }

    let anchorMs = honouredAnchorAtMs + blindCreditMs(now);
    if (suspensionGrantAtMs !== null && suspensionGrantAtMs > anchorMs) anchorMs = suspensionGrantAtMs;
    const idleMs = now - anchorMs;
    if (idleMs < windowMs || snapshot.phase === null) {
      schedule();
      return;
    }

    stop = Object.freeze({
      cause: "inactivity",
      phase: snapshot.phase,
      observedBytes: snapshot.observedBytes,
      idleMs: Math.floor(idleMs),
      windowMs,
    });
    end("stopped");
    try {
      onStall(stop);
    } catch {
      // The owner's failure goes no further; the decision stands.
    }
  }

  const record: AcquisitionActivitySink = (event) => {
    if (state === "disposed") return;
    const reading = readClock();
    if (reading === null) {
      if (deciding()) end("clock-fault");
    } else {
      lastReading = reading;
    }
    const now = lastReading;
    eventNow = now;
    const wasBlind = blindSinceMs !== null;
    tracker.record(event);
    if (!deciding()) return;

    const snapshot = tracker.snapshot();
    if (snapshot.outcome !== null) {
      end("settled");
      return;
    }
    switch (event.kind) {
      case "phase-started":
        if (snapshot.phase !== null && snapshot.anchorAtMs !== null) {
          honour(snapshot.anchorAtMs, snapshot.anchorBytes);
          suspensionGrantAtMs = null;
          if (state === "idle") {
            state = "watching";
            lastTickAtMs = now;
            schedule();
          }
        }
        break;
      case "bytes":
        if (wasBlind && !isUnobserved(snapshot, now)) {
          unobservedMs += Math.max(0, now - (blindSinceMs as number));
          blindSinceMs = null;
        }
        if (snapshot.anchorAtMs !== trackerAnchorAtMs && snapshot.anchorAtMs !== null) {
          // Meaningful growth moves the tracker's anchor; so does a recovery
          // from `unobserved`, which is honoured only when the bytes grew by the
          // floor while they could not be seen.
          if (!wasBlind || snapshot.anchorBytes - honouredAnchorBytes >= ACQUISITION_PROGRESS_MIN_GROWTH_BYTES) {
            honour(snapshot.anchorAtMs, snapshot.anchorBytes);
          }
        } else if (snapshot.anchorBytes < honouredAnchorBytes) {
          // A confirmed discard lowers the anchor's bytes, never its time.
          honouredAnchorBytes = snapshot.anchorBytes;
        }
        break;
      case "sample-gap":
        if (blindSinceMs === null && isUnobserved(snapshot, now)) blindSinceMs = now;
        break;
      case "phase-ended":
        if (blindSinceMs !== null) {
          unobservedMs += Math.max(0, now - blindSinceMs);
          blindSinceMs = null;
        }
        break;
      default:
        break;
    }
    trackerAnchorAtMs = snapshot.anchorAtMs;
  };

  return {
    record,
    snapshot: () => tracker.snapshot(),
    report: () =>
      Object.freeze({
        state,
        stop,
        suspensions,
        honouredAnchorAtMs,
        unobservedCreditMs: blindCreditMs(lastReading),
      }),
    dispose: () => {
      if (state === "disposed") return;
      state = "disposed";
      release();
    },
  };
}
