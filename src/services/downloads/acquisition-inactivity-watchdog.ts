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
 * ─── Observation loss: bounded, never silent, and never a stall ─────────────
 *
 * The tracker calls a phase `unobserved` after three consecutive filesystem
 * gaps and, when a sample is readable again, re-anchors it with a fresh window.
 * Taken as is, a repeated pattern of three gaps and one readable sample would
 * re-arm a fresh window forever. This watchdog therefore:
 *
 *   - PAUSES the window while the phase is unobserved: blind time never counts
 *     toward inactivity, because an observer that cannot see is no evidence
 *     that the source stopped (VIDEOFETCH-LD3C-YTDLP-OBSERVATION-HARDENING-001);
 *   - honours a recovery's fresh window only when the bytes grew by at least
 *     the floor over that anchor while it could not see them;
 *   - ends the watch as an OBSERVATION LOSS — a decision of its own, reported
 *     through `onObservationLost`, never through `onStall` — once the blind
 *     time since its honoured anchor reaches `maxUnobservedMs`.
 *
 * A stall therefore always rests on a full window of VISIBLE time without
 * meaningful growth, and a phase that cannot be seen ends at most
 * `maxUnobservedMs` of blindness after its last honoured anchor. Transport
 * evidence (direct, clear HLS) never reports a gap, so this applies to
 * filesystem evidence only. (LD-3b let the window run again once the
 * allowance was spent, so blindness could end as a stall; LD-3c replaced that.)
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
 * A detected suspension also restarts the observation allowance from the
 * resume: time in which the process did not run is neither visible nor blind.
 *
 * ─── Ending ─────────────────────────────────────────────────────────────────
 *
 * At most ONE decision is made: `onStall` or `onObservationLost`, at most once,
 * after the decision is latched; an exception from either is dropped. Without
 * `onObservationLost` an observation loss still ends the watch (no callback),
 * and the acquisition stays bounded by its absolute deadline alone. The timer is
 * released on a decision, when the acquisition reports how it ended, once the
 * deadline has passed, on a clock fault and on `dispose()` (idempotent). After
 * `dispose()` every event and every timer callback is a no-op. The watchdog
 * writes nothing durable and exposes only numbers and fixed strings.
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
  /**
   * The observation-loss allowance: blind time a phase may spend, in total, since
   * its honoured anchor, before the watch ends as an observation loss. Default:
   * the window.
   */
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

/**
 * LD-3c: the other decision — the phase could not be observed for the whole
 * allowance. It says nothing about the source: it is never an inactivity stop.
 */
export type AcquisitionObservationLoss = Readonly<{
  cause: "observation-lost";
  phase: AcquisitionActivityPhase;
  /** The phase's high-water mark of real media bytes when the allowance ran out. */
  observedBytes: number;
  /** Blind time since the honoured anchor, when it was decided. */
  unobservedMs: number;
  maxUnobservedMs: number;
}>;

export type AcquisitionInactivityWatchdogState =
  /** No phase has started: no timer, no window. */
  | "idle"
  /** A phase has started: the timer runs and a stop is possible. */
  | "watching"
  /** This watchdog stopped the acquisition. */
  | "stopped"
  /** LD-3c: the phase could not be observed for the whole allowance. */
  | "observation-lost"
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
  /** LD-3c: the observation-loss decision, or null. At most one of `stop` and this is set. */
  observationLoss: AcquisitionObservationLoss | null;
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
  /**
   * LD-3c: called at most once — and never together with `onStall` — when the
   * phase has been unobservable for the whole allowance.
   */
  readonly onObservationLost?: (loss: AcquisitionObservationLoss) => void;
}): AcquisitionInactivityWatchdog {
  const policy = resolveAcquisitionInactivityPolicy(opts.policy);
  const { windowMs, tickMs, suspensionGapMs, maxUnobservedMs } = policy;
  const { clock, timers, onStall, onObservationLost } = opts;

  // The tracker reads the time of the event being recorded, so the tracker and
  // this watchdog's own accounting see one reading per event.
  let eventNow = 0;
  const tracker = createAcquisitionActivityTracker({ clock: () => eventNow });

  let state: AcquisitionInactivityWatchdogState = "idle";
  let timer: InactivityWatchdogTimerHandle | null = null;
  let stop: AcquisitionInactivityStop | null = null;
  let observationLoss: AcquisitionObservationLoss | null = null;
  let lastReading = 0;
  let lastTickAtMs: number | null = null;
  let suspensions = 0;
  let suspensionGrantAtMs: number | null = null;

  // The anchor the window is measured from: the tracker's, except a recovery
  // re-anchor that no visible growth backs.
  let honouredAnchorAtMs: number | null = null;
  let honouredAnchorBytes = 0;
  // The tracker's anchor as last seen: a move is a new time OR more bytes at the
  // same time (LD-3c: growth landing at the instant of the phase start, or of the
  // previous anchor, used to be missed, leaving the honoured bytes stale so a
  // later unbacked recovery looked like growth).
  let trackerAnchorAtMs: number | null = null;
  let trackerAnchorBytes = 0;
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

  /** Blind time since the honoured anchor: the closed runs and the open one. */
  const blindMs = (nowMs: number) => unobservedMs + (blindSinceMs === null ? 0 : Math.max(0, nowMs - blindSinceMs));
  /** The same, as the report states it: never more than the allowance. */
  const blindCreditMs = (nowMs: number) => Math.min(blindMs(nowMs), maxUnobservedMs);

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
      // The process did not run: one fresh window from the resume — and, since
      // a frozen observer is not a blind one, a fresh observation allowance too.
      suspensionGrantAtMs = now;
      suspensions += 1;
      unobservedMs = 0;
      if (blindSinceMs !== null) blindSinceMs = now;
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

    // LD-3c: the window runs from the later of the honoured anchor and a
    // suspension's fresh start, and every blind millisecond since that point is
    // excluded from it, uncapped (a suspension restarts the blind count, and an
    // honoured anchor resets it), so a stall always rests on a full window of
    // VISIBLE time without meaningful growth. Blindness is bounded separately,
    // below, by its own decision.
    const blind = blindMs(now);
    const windowStartMs =
      suspensionGrantAtMs !== null && suspensionGrantAtMs > honouredAnchorAtMs ? suspensionGrantAtMs : honouredAnchorAtMs;
    const idleMs = now - (windowStartMs + blind);
    if (snapshot.phase === null) {
      schedule();
      return;
    }

    if (idleMs >= windowMs) {
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
      return;
    }

    if (blind > 0 && blind >= maxUnobservedMs) {
      observationLoss = Object.freeze({
        cause: "observation-lost",
        phase: snapshot.phase,
        observedBytes: snapshot.observedBytes,
        unobservedMs: Math.floor(blind),
        maxUnobservedMs,
      });
      end("observation-lost");
      try {
        onObservationLost?.(observationLoss);
      } catch {
        // The owner's failure goes no further; the decision stands.
      }
      return;
    }

    schedule();
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
        if (
          snapshot.anchorAtMs !== null &&
          (snapshot.anchorAtMs !== trackerAnchorAtMs || snapshot.anchorBytes > trackerAnchorBytes)
        ) {
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
    trackerAnchorBytes = snapshot.anchorBytes;
  };

  return {
    record,
    snapshot: () => tracker.snapshot(),
    report: () =>
      Object.freeze({
        state,
        stop,
        observationLoss,
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
