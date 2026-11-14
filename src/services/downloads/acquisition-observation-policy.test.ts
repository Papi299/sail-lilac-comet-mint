import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACQUISITION_PROGRESS_MIN_GROWTH_BYTES,
  type AcquisitionActivityEvent,
  type AcquisitionActivityOutcome,
  type AcquisitionActivityPhase,
} from "./acquisition-activity.ts";
import {
  createAcquisitionInactivityWatchdog,
  type AcquisitionInactivityPolicy,
  type AcquisitionInactivityStop,
  type AcquisitionObservationLoss,
  type InactivityWatchdogTimerHandle,
  type InactivityWatchdogTimers,
} from "./acquisition-inactivity-watchdog.ts";

/**
 * VIDEOFETCH-LD3C-YTDLP-OBSERVATION-HARDENING-001 — the bounded observation
 * policy of the acquisition watchdog, in virtual time only.
 *
 * The rule under test: an observer that cannot see is no evidence that the
 * source stopped. Blind time (the tracker's `unobserved`: three consecutive
 * gaps) never counts toward a stall; it is bounded by its own allowance, whose
 * end is an OBSERVATION LOSS — a separate decision, never a stop for
 * inactivity. Absence before the first byte is not blindness. Times are
 * relative to the phase start; one sample every 150 ms, as the yt-dlp monitor
 * polls; one tick per second, so a decision lands at the first tick at or after
 * its threshold.
 */

const WINDOW = 120_000;
const G = ACQUISITION_PROGRESS_MIN_GROWTH_BYTES;
const POLL = 150;

function virtualTime(startMs = 7_000_000) {
  let now = startMs;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: InactivityWatchdogTimers = {
    setTimeoutFn(fn, ms) {
      seq += 1;
      pending.set(seq, { at: now + ms, fn });
      return { id: seq, unref: () => undefined } as InactivityWatchdogTimerHandle;
    },
    clearTimeoutFn(handle) {
      pending.delete((handle as unknown as { id: number }).id);
    },
  };
  const runDue = (until: number) => {
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, t] of pending) {
        if (t.at <= until && (t.at < nextAt || (t.at === nextAt && id < nextId))) {
          nextId = id;
          nextAt = t.at;
        }
      }
      if (nextId === -1) return;
      const due = pending.get(nextId)!;
      pending.delete(nextId);
      if (due.at > now) now = due.at;
      due.fn();
    }
  };
  return {
    clock: () => now,
    timers,
    now: () => now,
    advance(ms: number) {
      const end = now + ms;
      runDue(end);
      if (end > now) now = end;
    },
    /** The process did not run: the clock moves, nothing fires during it, and everything due fires late. */
    jump(ms: number) {
      now += ms;
      runDue(now);
    },
    pendingCount: () => pending.size,
  };
}

function harness(policy: Partial<AcquisitionInactivityPolicy> = {}, opts: { withLossCallback?: boolean; throwing?: boolean } = {}) {
  const vt = virtualTime();
  const t0 = vt.now();
  const stops: Array<{ at: number; stop: AcquisitionInactivityStop }> = [];
  const losses: Array<{ at: number; loss: AcquisitionObservationLoss }> = [];
  const watchdog = createAcquisitionInactivityWatchdog({
    policy: { windowMs: WINDOW, ...policy },
    clock: vt.clock,
    timers: vt.timers,
    onStall: (stop) => {
      stops.push({ at: vt.now() - t0, stop });
      if (opts.throwing) throw new Error("owner failure");
    },
    ...(opts.withLossCallback === false
      ? {}
      : {
          onObservationLost: (loss: AcquisitionObservationLoss) => {
            losses.push({ at: vt.now() - t0, loss });
            if (opts.throwing) throw new Error("owner failure");
          },
        }),
  });
  const rec = (event: AcquisitionActivityEvent) => watchdog.record(event);
  const h = {
    vt,
    watchdog,
    stops,
    losses,
    t0,
    arm: (limitMs = 9_000_000) => rec({ kind: "deadline-armed", limitMs }),
    start: (phase: AcquisitionActivityPhase = "single") => rec({ kind: "phase-started", phase }),
    bytes: (totalBytes: number) => rec({ kind: "bytes", totalBytes, evidence: "filesystem" }),
    gap: () => rec({ kind: "sample-gap" }),
    end: () => rec({ kind: "phase-ended" }),
    settle: (outcome: AcquisitionActivityOutcome) => rec({ kind: "settled", outcome }),
    at: (t: number) => vt.advance(t0 + t - vt.now()),
    state: () => watchdog.report().state,
    /** One sample per poll from `from` (inclusive) while `until` is not reached and nothing was decided. */
    sample(from: number, until: number, each: (t: number, i: number) => void) {
      let i = 0;
      for (let t = from; t < until; t += POLL, i += 1) {
        h.at(t);
        if (h.state() !== "watching") return;
        each(t, i);
      }
    },
  };
  return h;
}

describe("an observation failure is never a stall", () => {
  it("a phase unreadable from its very first sample is blind, not awaiting a byte: an observation loss, never a stall", () => {
    const h = harness();
    h.arm();
    h.start();
    h.sample(POLL, 400_000, () => h.gap());
    // Blind from the third gap (450); the allowance (one window) is spent at 120,450.
    assert.equal(h.stops.length, 0);
    assert.equal(h.losses.length, 1);
    assert.equal(h.losses[0]!.at, 121_000);
    assert.deepEqual(h.losses[0]!.loss, { cause: "observation-lost", phase: "single", observedBytes: 0, unobservedMs: 120_550, maxUnobservedMs: WINDOW });
    assert.equal(h.watchdog.snapshot().firstByteAtMs, null, "no byte was ever invented");
  });

  it("absence before the first byte is not blindness: no first byte at all is a stall at the window", () => {
    const h = harness();
    h.arm();
    h.start();
    // The yt-dlp monitor reports nothing while no file exists yet (D3), so the
    // phase is simply awaiting its first byte.
    h.at(400_000);
    assert.equal(h.losses.length, 0);
    assert.equal(h.stops.length, 1);
    assert.equal(h.stops[0]!.at, WINDOW);
    assert.deepEqual(h.stops[0]!.stop, { cause: "inactivity", phase: "single", observedBytes: 0, idleMs: WINDOW, windowMs: WINDOW });
  });

  it("a genuine stall with a readable file stops at the window: repeated identical readings are visible evidence", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(5_000);
    h.bytes(4 * G);
    h.sample(5_000 + POLL, 400_000, () => h.bytes(4 * G));
    assert.equal(h.losses.length, 0);
    assert.equal(h.stops.length, 1);
    assert.equal(h.stops[0]!.at, 125_000);
  });

  it("blind time pauses the window without a cap: a stall needs a full window of VISIBLE time", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(4 * G); // honoured anchor at 10 s
    h.sample(10_000 + POLL, 70_000, () => h.bytes(4 * G)); // 60 s visible, no growth
    h.sample(70_000, 170_000, () => h.gap()); // blind from 70,300 to the next reading: 99,700 ms
    h.sample(170_000, 400_000, () => h.bytes(4 * G)); // visible again, still no growth
    assert.equal(h.losses.length, 0, "99.7 s of blindness is inside the allowance");
    assert.equal(h.stops.length, 1);
    // 10,000 + 99,700 blind + 120,000 visible = 229,700: the first tick at or after it.
    assert.equal(h.stops[0]!.at, 230_000);
    assert.equal(h.stops[0]!.stop.idleMs, 120_300);
  });

  it("a custom allowance is its own limit, measured from the honoured anchor", () => {
    const h = harness({ maxUnobservedMs: 30_000 });
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(4 * G);
    h.sample(20_000, 400_000, () => h.gap());
    assert.equal(h.stops.length, 0);
    assert.equal(h.losses.length, 1);
    assert.equal(h.losses[0]!.at, 51_000, "blind from 20,300; 30 s later is 50,300");
    assert.equal(h.losses[0]!.loss.maxUnobservedMs, 30_000);
  });

  it("a zero allowance: the first tick that finds the phase blind is an observation loss", () => {
    const h = harness({ maxUnobservedMs: 0 });
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(4 * G);
    h.sample(10_150, 60_000, () => h.gap());
    assert.equal(h.losses.length, 1);
    assert.equal(h.losses[0]!.at, 11_000, "blind from 10,450; the next tick decides");
    assert.equal(h.stops.length, 0);
  });
});

describe("recovery and repeated transitions", () => {
  it("visible again with the same bytes earns nothing; blind time already spent still counts toward the allowance", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(4 * G); // honoured anchor
    h.sample(20_000, 100_000, () => h.gap()); // blind 20,300 → 100,000: 79,700 ms
    h.at(100_000);
    h.bytes(4 * G); // readable again, the same bytes
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0 + 10_000, "an unbacked recovery is not honoured");
    h.sample(100_000 + POLL, 110_000, () => h.bytes(4 * G));
    h.sample(110_000, 400_000, () => h.gap()); // blind again from 110,300: 40,300 ms more spends the allowance
    assert.equal(h.stops.length, 0);
    assert.equal(h.losses.length, 1);
    assert.equal(h.losses[0]!.at, 151_000, "79,700 + 40,300 = 120,000 at 150,600");
  });

  it("visible again with verified growth earns a fresh window and a fresh allowance", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(4 * G);
    h.sample(20_000, 100_000, () => h.gap());
    h.at(100_000);
    h.bytes(4 * G + G); // exactly the floor more than the honoured anchor's bytes
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0 + 100_000);
    assert.equal(h.watchdog.report().unobservedCreditMs, 0, "the spent allowance is renewed by real growth");
    h.sample(110_000, 400_000, () => h.gap());
    assert.equal(h.losses.length, 1);
    assert.equal(h.losses[0]!.at, 231_000, "a full allowance from the new anchor: blind from 110,300");
  });

  // LD-3c fixed a latent LD-3b defect here. The watchdog noticed the tracker's
  // anchor moving only when its TIME changed, so growth landing at the very
  // instant of the phase start left the honoured anchor's bytes at 0. A later
  // recovery with exactly the same bytes then looked like a full 4 x 64 KiB of
  // growth and was honoured: a fresh window with no new byte (old result:
  // honouredAnchorAtMs = the recovery's time).
  it("growth at the instant of the phase start is honoured; a blind recovery with the same bytes then earns nothing", () => {
    const h = harness();
    h.arm();
    h.start();
    h.bytes(4 * G); // the same clock reading as the phase start
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0);
    h.sample(10_000, 30_000, () => h.gap());
    h.at(30_000);
    h.bytes(4 * G); // readable again: nothing new
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0, "an unbacked recovery is never honoured");
    h.sample(30_000 + POLL, 400_000, () => h.bytes(4 * G));
    // Blind from 10,300 to 30,000 (19,700 ms): the window ends at 0 + 19,700 + 120,000.
    assert.equal(h.stops[0]!.at, 140_000);
  });

  it("two gaps and a reading, repeated, are never blind: the readings are evidence, and the stall comes at the window", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(4 * G);
    h.sample(10_150, 400_000, (_t, i) => (i % 3 === 2 ? h.bytes(4 * G) : h.gap()));
    assert.equal(h.losses.length, 0);
    assert.equal(h.watchdog.report().unobservedCreditMs, 0);
    assert.equal(h.stops.length, 1);
    assert.equal(h.stops[0]!.at, 130_000);
  });

  it("mostly blind (nine gaps, one reading, repeated) ends as an observation loss before any stall", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(4 * G);
    h.sample(10_150, 2_000_000, (_t, i) => (i % 10 === 9 ? h.bytes(4 * G) : h.gap()));
    // Each 1,500 ms cycle is blind from its third gap to its reading: 1,050 ms.
    assert.equal(h.stops.length, 0, "the visible evidence never reached a window");
    assert.equal(h.losses.length, 1);
    assert.ok(h.losses[0]!.at < 10_000 + WINDOW * 2, `bounded: decided at ${h.losses[0]!.at}`);
    assert.ok(h.losses[0]!.loss.unobservedMs >= WINDOW);
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0 + 10_000, "no unbacked recovery was honoured");
  });

  it("slow but meaningful progress is never stopped, even with repeated blindness", () => {
    const h = harness();
    h.arm();
    h.start();
    let total = 0;
    for (let cycle = 0; cycle < 40; cycle += 1) {
      const base = 1_000 + cycle * 60_000;
      h.sample(base, base + 30_000, () => h.gap()); // 30 s unreadable
      h.at(base + 30_000);
      total += G; // one floor's worth per minute, seen after the blindness
      h.bytes(total);
      h.sample(base + 30_000 + POLL, base + 60_000, () => h.bytes(total));
    }
    assert.equal(h.stops.length, 0);
    assert.equal(h.losses.length, 0);
    assert.equal(h.state(), "watching");
  });

  it("less than the floor of growth in a window is a stall; exactly the floor is progress (filesystem evidence)", () => {
    const below = harness();
    below.arm();
    below.start();
    below.at(1_000);
    below.bytes(G - 1);
    below.at(400_000);
    assert.equal(below.stops[0]!.at, WINDOW);

    const exact = harness();
    exact.arm();
    exact.start();
    exact.at(1_000);
    exact.bytes(G);
    exact.at(400_000);
    assert.equal(exact.stops[0]!.at, 121_000, "the anchor moved to the reading at 1 s");
  });
});

describe("precedence: deadline, settlement, phases, suspension", () => {
  it("the absolute deadline before the allowance: the time limit, and neither decision", () => {
    const h = harness();
    h.arm(60_000);
    h.start();
    h.sample(POLL, 300_000, () => h.gap());
    assert.equal(h.state(), "time-limit");
    assert.equal(h.stops.length + h.losses.length, 0);
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("the deadline and the allowance at the same instant: the time limit wins", () => {
    const h = harness();
    h.arm(121_000);
    h.start();
    h.sample(POLL, 300_000, () => h.gap()); // the allowance is spent at 120,450; the tick at 121,000 is also the deadline
    assert.equal(h.state(), "time-limit");
    assert.equal(h.losses.length, 0);
  });

  it("a cancellation before the allowance is spent: settled, no decision, and no timer", () => {
    const h = harness();
    h.arm();
    h.start();
    h.sample(POLL, 60_000, () => h.gap());
    h.settle("cancelled");
    h.at(500_000);
    assert.equal(h.state(), "settled");
    assert.equal(h.stops.length + h.losses.length, 0);
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("completion just before a pending tick: no decision afterwards", () => {
    const h = harness();
    h.arm();
    h.start();
    h.sample(POLL, 120_500, () => h.gap()); // the allowance is spent; the deciding tick is due at 121,000
    h.end();
    h.settle("completed");
    h.at(121_000);
    assert.equal(h.state(), "settled");
    assert.equal(h.losses.length, 0);
  });

  it("blindness in the video half never carries into the audio half; between the phases nothing is counted", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start("video");
    h.sample(POLL, 100_000, () => h.gap()); // 99.55 s blind
    h.end();
    h.at(200_000); // 100 s of validation and re-extraction between the halves
    assert.equal(h.state(), "watching");
    h.start("audio");
    assert.equal(h.watchdog.report().unobservedCreditMs, 0, "a fresh allowance for the audio half");
    h.sample(200_000 + POLL, 500_000, () => h.gap());
    assert.equal(h.losses.length, 1);
    assert.equal(h.losses[0]!.loss.phase, "audio");
    assert.equal(h.losses[0]!.at, 321_000, "blind from 200,450 in the audio half alone");
    assert.equal(h.watchdog.snapshot().deadlineAtMs, h.t0 + 9_000_000, "one deadline for both halves");
  });

  it("a suspension (the process did not run) restarts the allowance from the resume", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(4 * G);
    h.sample(20_000, 100_000, () => h.gap()); // blind from 20,300: 79,700 ms spent
    h.vt.jump(600_000); // frozen from 99,950: no tick ran; the due one fires late, at the resume (699,950)
    assert.equal(h.watchdog.report().suspensions, 1);
    assert.equal(h.losses.length, 0, "the frozen time was neither visible nor blind");
    h.sample(700_000 + POLL, 1_200_000, () => h.gap());
    assert.equal(h.stops.length, 0, "blind after the resume pauses the resumed window too: never a stall");
    assert.equal(h.losses.length, 1);
    assert.equal(h.losses[0]!.at, 819_950, "a full allowance from the resume at 699,950");
  });

  it("at most one decision: an observation loss is final, and a stall can never follow it", () => {
    const h = harness();
    h.arm();
    h.start();
    h.sample(POLL, 200_000, () => h.gap());
    h.at(200_000);
    h.bytes(4 * G);
    h.at(1_000_000);
    assert.equal(h.losses.length, 1);
    assert.equal(h.stops.length, 0);
    assert.equal(h.watchdog.report().stop, null);
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("at most one decision: after a stall, blindness decides nothing more", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(1_000);
    h.bytes(4 * G);
    h.at(200_000);
    assert.equal(h.stops.length, 1);
    h.sample(200_000, 600_000, () => h.gap());
    for (let i = 0; i < 2000; i += 1) h.gap();
    h.at(900_000);
    assert.equal(h.losses.length, 0);
    assert.equal(h.watchdog.report().observationLoss, null);
  });

  it("the owner's exception is contained; the decision stands and is not repeated", () => {
    const h = harness({}, { throwing: true });
    h.arm();
    h.start();
    h.sample(POLL, 400_000, () => h.gap());
    h.at(800_000);
    assert.equal(h.losses.length, 1);
    assert.equal(h.state(), "observation-lost");
  });

  it("without an observation-loss callback the watch still ends, silently: nothing stalls; only the deadline remains", () => {
    const h = harness({}, { withLossCallback: false });
    h.arm();
    h.start();
    h.sample(POLL, 400_000, () => h.gap());
    h.at(2_000_000);
    assert.equal(h.state(), "observation-lost");
    assert.equal(h.stops.length, 0);
    assert.notEqual(h.watchdog.report().observationLoss, null);
  });

  it("dispose during blindness releases everything; nothing is decided afterwards", () => {
    const h = harness();
    h.arm();
    h.start();
    h.sample(POLL, 60_000, () => h.gap());
    h.watchdog.dispose();
    h.at(500_000);
    assert.equal(h.state(), "disposed");
    assert.equal(h.stops.length + h.losses.length, 0);
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("every value the watchdog reports after an observation loss is a number, a fixed string or null", () => {
    const h = harness();
    h.arm();
    h.start();
    h.sample(POLL, 300_000, () => h.gap());
    const report = h.watchdog.report();
    const flat = { ...report, observationLoss: undefined, ...(report.observationLoss ?? {}) };
    for (const [key, value] of Object.entries(flat)) {
      if (value === undefined || value === null) continue;
      assert.ok(typeof value === "number" || ["observation-lost", "single"].includes(value as string), `${key}: ${String(value)}`);
    }
    assert.deepEqual(Object.keys(report.observationLoss!).sort(), ["cause", "maxUnobservedMs", "observedBytes", "phase", "unobservedMs"]);
  });
});
