/**
 * Acquisition activity observation
 * (VIDEOFETCH-LD3A-ACQUISITION-ACTIVITY-FOUNDATION-001).
 *
 * The evidence a future inactivity watchdog (LD-3b) will decide on, and nothing
 * more. This module has no timer, aborts nothing, imports nothing and reads no
 * configuration: acquisition paths report what they saw, and pure functions
 * answer questions about it. An absent or misbehaving sink changes nothing
 * about a download.
 *
 * ─── Why the user-facing progress callback is not this ──────────────────────
 *
 * `onProgress` is built for the browser, and each of its properties is wrong
 * for a stall decision: clear-HLS reports only COMPLETED fragments (up to
 * 64 MiB, so a healthy large fragment looks stalled); a split pair reports a
 * monotonic floor that hides a restart from zero; a percentage can repeat, or
 * rest on an upstream-declared total; and the executor throttles the stream.
 * None of it is consulted here.
 *
 * ─── The contract ───────────────────────────────────────────────────────────
 *
 * One `AcquisitionActivitySink` per acquisition, emitted to synchronously:
 *
 *   deadline-armed      the acquisition's ONE absolute deadline, by duration.
 *                       The first report wins and nothing can move it, so no
 *                       consumer of this model can extend it.
 *   phase-started       one run whose bytes count from zero: `single`, or the
 *                       `video` / `audio` half of a pair (split or separate
 *                       audio). Never concurrent; both halves share the
 *                       deadline above.
 *   bytes               the phase's cumulative total of REAL media bytes.
 *                       `transport`: chunks accepted in-process (direct, HLS).
 *                       `filesystem`: what the yt-dlp child has on disk.
 *                       Never a percentage, never an upstream-declared size.
 *   resource-boundary   an HLS resource finished and the next has not produced
 *                       a byte. A boundary is NOT progress.
 *   sample-gap          a filesystem sample could not read a file this run had
 *                       already been seen to hold.
 *   phase-ended         the phase's transfer finished; local validation may
 *                       follow, and the next phase, if any, has not begun.
 *   settled             terminal, once: `completed`, `cancelled`,
 *                       `deadline-exceeded` or `failed`. The first wins.
 *
 * The vocabulary is closed: numbers and fixed strings. No event can carry a
 * URL, a host, a path, a title, tool output or an exception.
 *
 * ─── What progress means ────────────────────────────────────────────────────
 *
 * Only a sample ABOVE the phase's high-water mark advances it. The target
 * accepted in the long-download design (`LONG-DOWNLOAD-PROGRESS-AND-INACTIVITY-
 * DESIGN.md` §2) is: a phase is inactive when its observed bytes have not grown
 * by at least 65,536 B for 120 s, measured from the anchor — the byte count and
 * time of the last meaningful progress, or the phase's start.
 *
 * `ACQUISITION_PROGRESS_MIN_GROWTH_BYTES` is that floor, the design's fixed
 * `PROGRESS_MIN_GROWTH_BYTES`. The window is the CALLER's input: its owner is
 * `DOWNLOAD_INACTIVITY_TIMEOUT`, which arrives with the watchdog in LD-3b, and
 * this module holds no default for it.
 *
 * Elapsed time, a retry, a rename, a fragment boundary and a metadata request
 * move nothing. Below the floor, real bytes still count toward the next
 * anchor; no milestone is invented.
 *
 * A sample BELOW the high-water mark is one of two things. A segmented sample
 * can miss a fragment that was just renamed or appended, so a single low
 * reading is noise, and counting its recovery would be counting bytes twice.
 * A restart from zero (a server ignoring `Range`) stays low. So only
 * `DISCARD_CONFIRMATION_SAMPLES` low samples in a row confirm a discard: the
 * high-water mark drops to the sample, the anchor drops with it, and the
 * anchor's TIME does not move. This refines the design's "re-anchor down on
 * any drop", which would credit a fragment append dip as new bytes.
 */

/** The accepted design's floor for meaningful progress. */
export const ACQUISITION_PROGRESS_MIN_GROWTH_BYTES = 65_536;

/** Consecutive samples below the high-water mark that confirm a discard. */
const DISCARD_CONFIRMATION_SAMPLES = 3;

/** Consecutive gaps after which the accepted design calls a phase unobserved. */
const UNOBSERVED_SAMPLE_GAPS = 3;

export type AcquisitionActivityPhase = "single" | "video" | "audio";

export type AcquisitionActivityOutcome = "completed" | "cancelled" | "deadline-exceeded" | "failed";

export type AcquisitionActivityEvent =
  | { readonly kind: "deadline-armed"; readonly limitMs: number }
  | { readonly kind: "phase-started"; readonly phase: AcquisitionActivityPhase }
  | { readonly kind: "bytes"; readonly totalBytes: number; readonly evidence: "transport" | "filesystem" }
  | { readonly kind: "resource-boundary" }
  | { readonly kind: "sample-gap" }
  | { readonly kind: "phase-ended" }
  | { readonly kind: "settled"; readonly outcome: AcquisitionActivityOutcome };

export type AcquisitionActivitySink = (event: AcquisitionActivityEvent) => void;

/** Sinks whose acquisition has settled: nothing further reaches them. */
const settledSinks = new WeakSet<AcquisitionActivitySink>();

/**
 * The one way an acquisition path emits. Observer-only: a sink that throws is
 * dropped whole, exactly as HLS's `reportSafely` drops a throwing reporter, so
 * an observer can never decide the outcome of a transfer or touch its output.
 *
 * The first `settled` closes the sink, so a sink sees exactly one terminal
 * event and nothing after it — the more specific outcome a transport reported
 * is never followed by a seam's generic one, and a late callback reports nothing.
 */
export function reportActivity(
  sink: AcquisitionActivitySink | undefined,
  event: AcquisitionActivityEvent,
): void {
  if (sink === undefined || settledSinks.has(sink)) return;
  if (event.kind === "settled") settledSinks.add(sink);
  try {
    sink(event);
  } catch {
    // Observer output only; the exception and its text go no further.
  }
}

/**
 * Runs an acquisition and reports how it ended. `completed` only when `run`
 * resolved, after the seam's own artifact checks. A rejection reports
 * `cancelled` or `failed`, unless a more specific outcome was already reported
 * (the first `settled` closes the sink). With no sink, `run` is returned
 * untouched.
 */
export function observeAcquisitionSettlement<T>(
  sink: AcquisitionActivitySink | undefined,
  isCancelled: () => boolean,
  run: () => Promise<T>,
): Promise<T> {
  if (sink === undefined) return run();
  return run().then(
    (result) => {
      reportActivity(sink, { kind: "settled", outcome: "completed" });
      return result;
    },
    (err: unknown) => {
      reportActivity(sink, { kind: "settled", outcome: isCancelled() ? "cancelled" : "failed" });
      throw err;
    },
  );
}

/** The facts one acquisition has reported, as of the last event. */
export type AcquisitionActivitySnapshot = Readonly<{
  phase: AcquisitionActivityPhase | null;
  phaseEnded: boolean;
  /** The current phase's high-water mark of real media bytes. */
  observedBytes: number;
  firstByteAtMs: number | null;
  lastAdvanceAtMs: number | null;
  lastSampleAdvanced: boolean;
  atResourceBoundary: boolean;
  /** The bytes and time of the last meaningful progress, or the phase's start. */
  anchorBytes: number;
  anchorAtMs: number | null;
  /** Across the acquisition: bytes a confirmed discard removed. */
  discardedBytes: number;
  /** A confirmed discard the phase has not yet advanced past. */
  discardPending: boolean;
  sampleGaps: number;
  deadlineAtMs: number | null;
  outcome: AcquisitionActivityOutcome | null;
}>;

export type AcquisitionActivityTracker = {
  readonly record: AcquisitionActivitySink;
  snapshot(): AcquisitionActivitySnapshot;
};

/**
 * The state of ONE acquisition, fed by its emitters. `clock` must be monotonic;
 * `performance.now` in production, a virtual clock in tests.
 *
 * Nothing is accepted after `settled`, and no byte is accepted outside a live
 * phase, so a late callback from a finished run or phase changes nothing.
 */
export function createAcquisitionActivityTracker(opts: {
  readonly clock: () => number;
}): AcquisitionActivityTracker {
  const { clock } = opts;
  let phase: AcquisitionActivityPhase | null = null;
  let phaseEnded = false;
  let observedBytes = 0;
  let firstByteAtMs: number | null = null;
  let lastAdvanceAtMs: number | null = null;
  let lastSampleAdvanced = false;
  let atResourceBoundary = false;
  let anchorBytes = 0;
  let anchorAtMs: number | null = null;
  let discardedBytes = 0;
  let discardPending = false;
  let lowSamples = 0;
  let sampleGaps = 0;
  let deadlineAtMs: number | null = null;
  let outcome: AcquisitionActivityOutcome | null = null;

  const phaseLive = () => phase !== null && !phaseEnded;

  const recordBytes = (total: number, now: number) => {
    if (!Number.isSafeInteger(total) || total < 0) return;
    // A readable file ends any run of gaps; back from `unobserved`, the phase
    // gets a fresh window from this moment, and no credit for the bytes.
    if (sampleGaps >= UNOBSERVED_SAMPLE_GAPS) {
      anchorBytes = total;
      anchorAtMs = now;
    }
    sampleGaps = 0;

    if (total > observedBytes) {
      lowSamples = 0;
      observedBytes = total;
      firstByteAtMs ??= now;
      lastAdvanceAtMs = now;
      lastSampleAdvanced = true;
      atResourceBoundary = false;
      discardPending = false;
      if (observedBytes - anchorBytes >= ACQUISITION_PROGRESS_MIN_GROWTH_BYTES) {
        anchorBytes = observedBytes;
        anchorAtMs = now;
      }
      return;
    }

    lastSampleAdvanced = false;
    if (total === observedBytes) {
      lowSamples = 0;
      return;
    }

    lowSamples += 1;
    if (lowSamples < DISCARD_CONFIRMATION_SAMPLES) return;
    lowSamples = 0;
    discardedBytes += observedBytes - total;
    observedBytes = total;
    discardPending = true;
    anchorBytes = Math.min(anchorBytes, total);
  };

  const record: AcquisitionActivitySink = (event) => {
    if (outcome !== null) return;
    const now = clock();
    switch (event.kind) {
      case "deadline-armed":
        if (deadlineAtMs === null && Number.isSafeInteger(event.limitMs) && event.limitMs > 0) {
          deadlineAtMs = now + event.limitMs;
        }
        return;
      case "phase-started":
        phase = event.phase;
        phaseEnded = false;
        observedBytes = 0;
        firstByteAtMs = null;
        lastAdvanceAtMs = null;
        lastSampleAdvanced = false;
        atResourceBoundary = false;
        anchorBytes = 0;
        anchorAtMs = now;
        discardPending = false;
        lowSamples = 0;
        sampleGaps = 0;
        return;
      case "phase-ended":
        if (phaseLive()) phaseEnded = true;
        return;
      case "resource-boundary":
        if (phaseLive()) atResourceBoundary = true;
        return;
      case "sample-gap":
        if (phaseLive()) sampleGaps += 1;
        return;
      case "bytes":
        if (phaseLive()) recordBytes(event.totalBytes, now);
        return;
      case "settled":
        outcome = event.outcome;
        return;
    }
  };

  return {
    record,
    snapshot: () =>
      Object.freeze({
        phase,
        phaseEnded,
        observedBytes,
        firstByteAtMs,
        lastAdvanceAtMs,
        lastSampleAdvanced,
        atResourceBoundary,
        anchorBytes,
        anchorAtMs,
        discardedBytes,
        discardPending,
        sampleGaps,
        deadlineAtMs,
        outcome,
      }),
  };
}

export type AcquisitionActivityStatus =
  | "not-started"
  | "awaiting-first-byte"
  | "receiving"
  | "not-advancing"
  | "retry-discarded"
  | "between-resources"
  | "between-phases"
  | "unobserved"
  | "deadline-exceeded"
  | AcquisitionActivityOutcome;

export type AcquisitionActivityAssessment = Readonly<{
  status: AcquisitionActivityStatus;
  /**
   * True when a live phase has gone `windowMs` without meaningful progress.
   * EVIDENCE for LD-3b's decision: nothing here acts on it.
   */
  inactivityWindowExhausted: boolean;
}>;

/**
 * Reads one snapshot against an inactivity window. Pure.
 *
 * A passed absolute deadline outranks any progress, so the assessment can never
 * suggest that a transfer still receiving data may continue past it. Between
 * phases, and while a phase is unobserved, the window does not run; only the
 * absolute deadline does.
 *
 * `not-advancing` means the last sample did not advance the phase's high-water
 * mark, or the window has passed without one. Transport evidence produces no
 * event during silence, so on those paths only the window can show it; the
 * filesystem sampler's repeated readings show it straight away.
 */
export function assessAcquisitionActivity(
  snapshot: AcquisitionActivitySnapshot,
  policy: { readonly nowMs: number; readonly windowMs: number },
): AcquisitionActivityAssessment {
  const { nowMs, windowMs } = policy;
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError("invalid inactivity window");
  const verdict = (status: AcquisitionActivityStatus, inactivityWindowExhausted = false) =>
    Object.freeze({ status, inactivityWindowExhausted });

  if (snapshot.outcome !== null) return verdict(snapshot.outcome);
  if (snapshot.deadlineAtMs !== null && nowMs >= snapshot.deadlineAtMs) return verdict("deadline-exceeded");
  if (snapshot.phase === null || snapshot.anchorAtMs === null) return verdict("not-started");
  if (snapshot.phaseEnded) return verdict("between-phases");
  if (snapshot.sampleGaps >= UNOBSERVED_SAMPLE_GAPS) return verdict("unobserved");

  const exhausted = nowMs - snapshot.anchorAtMs >= windowMs;
  if (snapshot.firstByteAtMs === null || snapshot.lastAdvanceAtMs === null) {
    return verdict("awaiting-first-byte", exhausted);
  }
  if (snapshot.atResourceBoundary) return verdict("between-resources", exhausted);
  if (snapshot.discardPending) return verdict("retry-discarded", exhausted);
  if (!snapshot.lastSampleAdvanced || nowMs - snapshot.lastAdvanceAtMs >= windowMs) {
    return verdict("not-advancing", exhausted);
  }
  return verdict("receiving", exhausted);
}
