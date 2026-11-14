import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACQUISITION_PROGRESS_MIN_GROWTH_BYTES,
  assessAcquisitionActivity,
  createAcquisitionActivityTracker,
  type AcquisitionActivityEvent,
  type AcquisitionActivityOutcome,
  type AcquisitionActivityPhase,
} from "./acquisition-activity.ts";
import {
  ACQUISITION_INACTIVITY_SUSPENSION_GAP_MS,
  ACQUISITION_INACTIVITY_TICK_MS,
  createAcquisitionInactivityWatchdog,
  resolveAcquisitionInactivityPolicy,
  type AcquisitionInactivityPolicy,
  type AcquisitionInactivityStop,
  type AcquisitionObservationLoss,
  type InactivityWatchdogTimerHandle,
  type InactivityWatchdogTimers,
} from "./acquisition-inactivity-watchdog.ts";

/**
 * VIDEOFETCH-LD3B-INACTIVITY-WATCHDOG-CORE-001 — the watchdog core, in virtual
 * time only.
 *
 * The clock is a number the test moves and the timer hooks are a scheduler the
 * test drives, so no real timer, wait or wall clock exists here and every
 * result is exact. Times below are relative to the phase start unless stated.
 */

const WINDOW = 120_000;
const G = ACQUISITION_PROGRESS_MIN_GROWTH_BYTES;

/** A virtual scheduler: timers fire in time order, at their own time, or late after a jump. */
function virtualTime(startMs = 5_000_000) {
  let now = startMs;
  let seq = 0;
  let created = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: InactivityWatchdogTimers = {
    setTimeoutFn(fn, ms) {
      seq += 1;
      created += 1;
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
    /** Time passes and every timer due in it fires, in order. */
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
    /** A clock that goes backward (an injected clock can; `performance.now` cannot). */
    rewind(ms: number) {
      now -= ms;
    },
    pendingCount: () => pending.size,
    createdCount: () => created,
  };
}

type Harness = ReturnType<typeof harness>;

function harness(
  policy: Partial<AcquisitionInactivityPolicy> = {},
  opts: { wrapClock?: (base: () => number) => () => number } = {},
) {
  const vt = virtualTime();
  const stops: AcquisitionInactivityStop[] = [];
  const stoppedAt: number[] = [];
  // LD-3c: observation losses are recorded apart from stops: they are never one.
  const losses: AcquisitionObservationLoss[] = [];
  const lostAt: number[] = [];
  const t0 = vt.now();
  const watchdog = createAcquisitionInactivityWatchdog({
    policy: { windowMs: WINDOW, ...policy },
    clock: opts.wrapClock ? opts.wrapClock(vt.clock) : vt.clock,
    timers: vt.timers,
    onStall: (stop) => {
      stops.push(stop);
      stoppedAt.push(vt.now() - t0);
    },
    onObservationLost: (loss) => {
      losses.push(loss);
      lostAt.push(vt.now() - t0);
    },
  });
  const rec = (event: AcquisitionActivityEvent) => watchdog.record(event);
  return {
    vt,
    watchdog,
    stops,
    losses,
    /** The first observation loss's instant, relative to t0, or null. */
    lossAt: () => lostAt[0] ?? null,
    /** The first stop's instant, relative to t0, or null. */
    stopAt: () => stoppedAt[0] ?? null,
    t0,
    arm: (limitMs = 600_000) => rec({ kind: "deadline-armed", limitMs }),
    start: (phase: AcquisitionActivityPhase = "single") => rec({ kind: "phase-started", phase }),
    bytes: (totalBytes: number, evidence: "transport" | "filesystem" = "transport") =>
      rec({ kind: "bytes", totalBytes, evidence }),
    gap: () => rec({ kind: "sample-gap" }),
    boundary: () => rec({ kind: "resource-boundary" }),
    end: () => rec({ kind: "phase-ended" }),
    settle: (outcome: AcquisitionActivityOutcome) => rec({ kind: "settled", outcome }),
    /** Moves to `t` ms after the phase start (absolute within the test). */
    at: (t: number) => vt.advance(t0 + t - vt.now()),
    elapsed: () => vt.now() - t0,
    state: () => watchdog.report().state,
  };
}

/** Runs virtual time up to `limit` (relative to t0) and returns the first stop's instant, or null. */
function stopTime(h: Harness, limit: number): number | null {
  if (h.elapsed() < limit) h.vt.advance(h.t0 + limit - h.vt.now());
  return h.stopAt();
}

describe("the watchdog contract: timing", () => {
  it("a phase that never receives a byte stops exactly when the window ends", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(119_999);
    assert.equal(h.stops.length, 0);
    h.at(120_000);
    assert.equal(h.stops.length, 1);
    assert.deepEqual(h.stops[0], { cause: "inactivity", phase: "single", observedBytes: 0, idleMs: 120_000, windowMs: WINDOW });
    assert.equal(h.state(), "stopped");
    assert.equal(h.vt.pendingCount(), 0, "the timer is released by the stop");
  });

  it("before a phase starts nothing runs: no timer, no window, whatever the events", () => {
    const h = harness();
    h.arm(600_000);
    h.bytes(10 * G); // outside a live phase the tracker accepts nothing
    h.vt.advance(500_000);
    assert.equal(h.vt.pendingCount(), 0);
    assert.equal(h.vt.createdCount(), 0);
    assert.equal(h.state(), "idle");
    assert.equal(h.stops.length, 0);
  });

  it("a meaningful first chunk just before expiry moves the anchor; the next window is measured from it", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(119_999);
    h.bytes(G);
    h.at(120_000);
    assert.equal(h.stops.length, 0, "the anchor moved one millisecond before the window ended");
    // The window now ends at 239,999; the first tick at or after it is 240,000.
    h.at(239_999);
    assert.equal(h.stops.length, 0);
    h.at(240_000);
    assert.equal(h.stops.length, 1);
    assert.equal(h.stops[0]!.idleMs, 120_001);
    assert.equal(h.stops[0]!.observedBytes, G);
  });

  it("a first byte below the floor is not progress", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(119_000);
    h.bytes(1_000);
    h.at(120_000);
    assert.equal(h.stops.length, 1);
    assert.equal(h.stops[0]!.observedBytes, 1_000);
  });

  it("repeated increments below the floor never extend the window", () => {
    const h = harness();
    h.arm();
    h.start();
    let total = 0;
    for (let t = 10_000; t <= 200_000 && h.stops.length === 0; t += 10_000) {
      h.at(t);
      if (h.stops.length > 0) break;
      total += 4_000; // 12 kB per window: always below 64 KiB over the anchor
      h.bytes(total);
    }
    assert.equal(h.stops.length, 1);
    assert.equal(h.elapsed(), 120_000, "insufficient progress moved nothing");
    assert.equal(h.stops[0]!.observedBytes, 44_000);
  });

  it("exactly 65,536 bytes over the anchor is meaningful progress; 65,535 is not", () => {
    const exact = harness();
    exact.arm();
    exact.start();
    exact.at(60_000);
    exact.bytes(G);
    assert.equal(stopTime(exact, 400_000), 180_000);

    const short = harness();
    short.arm();
    short.start();
    short.at(60_000);
    short.bytes(G - 1);
    assert.equal(stopTime(short, 400_000), 120_000);
  });

  it("meaningful progress immediately before expiry keeps the phase alive", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(50_000);
    h.bytes(70_000);
    h.at(169_999);
    h.bytes(70_000 + G);
    h.at(170_000);
    assert.equal(h.stops.length, 0);
    assert.equal(stopTime(h, 600_000), 290_000);
  });

  it("progress arriving after the stop changes nothing, and the stop is reported once", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(120_000);
    assert.equal(h.stops.length, 1);
    const before = h.stops[0];
    h.bytes(100 * G);
    h.vt.advance(1_000_000);
    assert.equal(h.stops.length, 1);
    assert.deepEqual(h.watchdog.report().stop, before);
    assert.equal(h.state(), "stopped");
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("an absolute deadline before the window: the watchdog never stops, and releases its timer", () => {
    const h = harness();
    h.arm(90_000);
    h.start();
    h.vt.advance(1_000_000);
    assert.equal(h.stops.length, 0);
    assert.equal(h.state(), "time-limit");
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("the window before the absolute deadline: inactivity stops first", () => {
    const h = harness();
    h.arm(600_000);
    h.start();
    assert.equal(stopTime(h, 700_000), 120_000);
  });

  it("both at the same observable instant: the absolute time limit wins", () => {
    const h = harness();
    h.arm(120_000);
    h.start();
    h.at(120_000);
    assert.equal(h.stops.length, 0);
    assert.equal(h.state(), "time-limit");
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("a receiving transfer cannot run past the absolute deadline: progress never extends it", () => {
    const h = harness();
    h.arm(300_000);
    h.start();
    let total = 0;
    for (let t = 1_000; t <= 299_000; t += 1_000) {
      h.at(t);
      total += 4 * G;
      h.bytes(total);
    }
    h.at(300_000);
    assert.equal(h.state(), "time-limit", "the deadline passed while bytes were still arriving");
    const s = h.watchdog.snapshot();
    assert.equal(s.deadlineAtMs, h.t0 + 300_000, "progress did not move the deadline");
    assert.equal(
      assessAcquisitionActivity(s, { nowMs: h.vt.now(), windowMs: WINDOW }).status,
      "deadline-exceeded",
    );
  });

  it("a clock discontinuity (the process did not run) grants one fresh window from the resume", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(60_000);
    h.vt.jump(600_000); // a frozen VM whose monotonic clock jumped on resume
    assert.equal(h.stops.length, 0, "the resume is not a stop");
    assert.equal(h.watchdog.report().suspensions, 1);
    const resume = h.elapsed();
    assert.equal(stopTime(h, resume + 400_000), resume + 120_000);
  });

  it("a suspension never moves the absolute deadline", () => {
    const h = harness();
    h.arm(300_000);
    h.start();
    h.at(60_000);
    h.vt.jump(400_000);
    assert.equal(h.stops.length, 0);
    assert.equal(h.state(), "time-limit");
  });

  it("a pause shorter than the suspension gap is inactivity like any other", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(100_000);
    h.vt.jump(20_000); // the next tick is 21 s after the last one: below 30 s
    assert.equal(h.watchdog.report().suspensions, 0);
    assert.equal(h.stops.length, 1);
    assert.equal(h.elapsed(), 120_000);
  });

  it("a clock that goes backward cannot stop a download early", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(60_000);
    h.vt.rewind(50_000); // clock reads t0 + 10,000 now
    for (let i = 0; i < 400 && h.stops.length === 0; i += 1) h.vt.advance(1_000);
    assert.equal(h.stops.length, 1);
    assert.ok(h.stops[0]!.idleMs >= WINDOW, "measured on the clock, never less than the window");
    assert.ok(h.vt.now() - h.t0 >= WINDOW);
  });

  for (const [label, bad] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a string", "123"],
    ["a throwing clock", "throw"],
  ] as const) {
    it(`an invalid time input (${label}) at a tick makes no decision, ever, and releases the timer`, () => {
      let broken = false;
      const h = harness({}, {
        wrapClock: (base) => () => {
          if (!broken) return base();
          if (bad === "throw") throw new Error("clock failure");
          return bad as unknown as number;
        },
      });
      h.arm();
      h.start();
      h.vt.advance(10_000);
      assert.equal(h.state(), "watching");
      broken = true;
      h.vt.advance(2_000);
      assert.equal(h.state(), "clock-fault");
      assert.equal(h.vt.pendingCount(), 0);
      broken = false;
      h.vt.advance(1_000_000);
      assert.equal(h.stops.length, 0);
    });
  }

  it("an invalid time input at an event latches the same fault", () => {
    let broken = false;
    const h = harness({}, { wrapClock: (base) => () => (broken ? Number.NaN : base()) });
    h.arm();
    h.start();
    broken = true;
    h.bytes(G);
    broken = false;
    assert.equal(h.state(), "clock-fault");
    h.vt.advance(1_000_000);
    assert.equal(h.stops.length, 0);
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("an invalid policy is refused before any timer exists, by the clause it breaks", () => {
    const vt = virtualTime();
    const WIN = "invalid inactivity window";
    const TICK = "invalid inactivity tick";
    const GAP = "invalid suspension gap";
    const BLIND = "invalid unobserved allowance";
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ windowMs: 0 }, WIN],
      [{ windowMs: -1 }, WIN],
      [{ windowMs: 1.5 }, WIN],
      [{ windowMs: Number.NaN }, WIN],
      [{ windowMs: Number.POSITIVE_INFINITY }, WIN],
      [{ windowMs: "120000" }, WIN],
      [{}, WIN],
      // Only the window is wrong here: every other clause would accept these.
      [{ windowMs: 1_500.5, maxUnobservedMs: 0 }, WIN],
      [{ windowMs: 2 ** 53, maxUnobservedMs: 0 }, WIN],
      [{ windowMs: WINDOW, tickMs: 0 }, TICK],
      [{ windowMs: WINDOW, tickMs: WINDOW + 1 }, TICK],
      [{ windowMs: WINDOW, tickMs: 1.5 }, TICK],
      [{ windowMs: WINDOW, suspensionGapMs: 1_000 }, GAP],
      [{ windowMs: WINDOW, tickMs: 5_000, suspensionGapMs: 5_000 }, GAP],
      [{ windowMs: WINDOW, suspensionGapMs: 30_000.5 }, GAP],
      [{ windowMs: WINDOW, maxUnobservedMs: -1 }, BLIND],
      [{ windowMs: WINDOW, maxUnobservedMs: 1.5 }, BLIND],
      [{ windowMs: WINDOW, maxUnobservedMs: Number.POSITIVE_INFINITY }, BLIND],
    ];
    for (const [policy, message] of bad) {
      assert.throws(
        () =>
          createAcquisitionInactivityWatchdog({
            policy: policy as unknown as AcquisitionInactivityPolicy,
            clock: vt.clock,
            timers: vt.timers,
            onStall: () => {},
          }),
        { name: "RangeError", message },
        JSON.stringify(policy),
      );
    }
    assert.equal(vt.createdCount(), 0);
  });

  it("the defaults are the design's: a 1 s tick, a 30 s suspension gap, one window of blind allowance", () => {
    assert.equal(ACQUISITION_INACTIVITY_TICK_MS, 1_000);
    assert.equal(ACQUISITION_INACTIVITY_SUSPENSION_GAP_MS, 30_000);
    assert.deepEqual(resolveAcquisitionInactivityPolicy({ windowMs: WINDOW }), {
      windowMs: WINDOW,
      tickMs: 1_000,
      suspensionGapMs: 30_000,
      maxUnobservedMs: WINDOW,
    });
    assert.ok(Object.isFrozen(resolveAcquisitionInactivityPolicy({ windowMs: WINDOW })));
  });

  it("one timer at a time while watching, and none after any ending", () => {
    for (const ending of ["stop", "settle", "time-limit", "dispose"] as const) {
      const h = harness();
      h.arm(ending === "time-limit" ? 50_000 : 600_000);
      assert.equal(h.vt.pendingCount(), 0);
      h.start();
      for (let t = 1_000; t <= 40_000; t += 7_321) {
        h.at(t);
        assert.equal(h.vt.pendingCount(), 1, `${ending}: exactly one pending timer at ${t}`);
      }
      if (ending === "settle") h.settle("completed");
      if (ending === "dispose") h.watchdog.dispose();
      h.vt.advance(200_000);
      assert.equal(h.vt.pendingCount(), 0, `${ending}: released`);
    }
  });

  it("dispose is idempotent and synchronous; a disposed watchdog ignores every later event and tick", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(2 * G);
    h.watchdog.dispose();
    h.watchdog.dispose();
    assert.equal(h.state(), "disposed");
    assert.equal(h.vt.pendingCount(), 0);
    const frozen = h.watchdog.snapshot();
    h.bytes(50 * G);
    h.start("audio");
    h.settle("failed");
    assert.deepEqual(h.watchdog.snapshot(), frozen, "nothing reaches the tracker after dispose");
    h.vt.advance(1_000_000);
    assert.equal(h.stops.length, 0);
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("onStall runs at most once, after the decision is latched, and its exception is contained", () => {
    const vt = virtualTime();
    let calls = 0;
    let stateDuringCall = "";
    const watchdog = createAcquisitionInactivityWatchdog({
      policy: { windowMs: WINDOW },
      clock: vt.clock,
      timers: vt.timers,
      onStall: () => {
        calls += 1;
        stateDuringCall = watchdog.report().state;
        // A re-entrant event and a re-entrant dispose, from inside the owner's handler.
        watchdog.record({ kind: "bytes", totalBytes: 99 * G, evidence: "transport" });
        throw new Error("the owner failed");
      },
    });
    watchdog.record({ kind: "deadline-armed", limitMs: 600_000 });
    watchdog.record({ kind: "phase-started", phase: "single" });
    assert.doesNotThrow(() => vt.advance(500_000));
    assert.equal(calls, 1);
    assert.equal(stateDuringCall, "stopped");
    assert.equal(watchdog.report().state, "stopped");
    assert.equal(vt.pendingCount(), 0);
  });

  it("agrees exactly with the LD-3a assessment on transport evidence (seeded sequences, both directions)", () => {
    let seed = 0x5eed1234;
    const rand = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    let stalled = 0;
    let neverStalled = 0;
    for (let run = 0; run < 40; run += 1) {
      const h = harness();
      const bareClock = { now: h.vt.now() };
      const bare = createAcquisitionActivityTracker({ clock: () => bareClock.now });
      const both = (event: AcquisitionActivityEvent) => {
        bareClock.now = h.vt.now();
        bare.record(event);
        h.watchdog.record(event);
      };
      both({ kind: "deadline-armed", limitMs: 900_000 });
      both({ kind: "phase-started", phase: "single" });
      let total = 0;
      let expected: number | null = null;
      let nextEventAt = 1 + Math.floor(rand() * 45_000);
      // Tick instant by tick instant (the phase started at t0, so ticks are at every
      // whole second): events at random instants in between; at each tick the bare
      // assessment says whether the window is exhausted.
      for (let tick = 1_000; tick <= 950_000 && h.stops.length === 0; tick += 1_000) {
        while (nextEventAt < tick && h.stops.length === 0) {
          h.at(nextEventAt);
          if (h.stops.length > 0) break;
          total += rand() < 0.35 ? 0 : Math.floor(rand() * 2.2 * G);
          both({ kind: "bytes", totalBytes: total, evidence: "transport" });
          nextEventAt += 1 + Math.floor(rand() * 45_000);
        }
        if (h.stops.length > 0) break;
        h.at(tick);
        if (expected === null) {
          bareClock.now = h.vt.now();
          const a = assessAcquisitionActivity(bare.snapshot(), { nowMs: h.vt.now(), windowMs: WINDOW });
          if (a.inactivityWindowExhausted) expected = tick;
        }
      }
      if (expected === null) {
        neverStalled += 1;
        assert.equal(h.stops.length, 0, `run ${run}: the assessment never called the window exhausted`);
      } else {
        stalled += 1;
        assert.equal(h.stops.length, 1, `run ${run}`);
        assert.equal(h.stopAt(), expected, `run ${run}: the stop is the first tick the assessment calls exhausted`);
      }
    }
    assert.ok(stalled >= 10, `both directions exercised: ${stalled} stalled`);
    assert.ok(neverStalled >= 1, `both directions exercised: ${neverStalled} never stalled`);
  });
});

describe("transport evidence: direct and clear HLS", () => {
  it("direct streaming keeps the phase alive chunk by chunk; silence stops it one window after the last anchor", () => {
    const h = harness();
    h.arm(600_000);
    h.start();
    let total = 0;
    for (let t = 1_000; t <= 500_000; t += 1_000) {
      h.at(t);
      total += G;
      h.bytes(total);
    }
    assert.equal(h.stops.length, 0);
    // The window would end at 620 s; the 600 s deadline comes first.
    assert.equal(stopTime(h, 700_000), null);
    assert.equal(h.state(), "time-limit");

    const s = harness();
    s.arm(900_000);
    s.start();
    let sent = 0;
    for (let t = 1_000; t <= 300_000; t += 1_000) {
      s.at(t);
      sent += G;
      s.bytes(sent);
    }
    assert.equal(stopTime(s, 700_000), 420_000);
  });

  it("a large HLS fragment arriving slowly is progress chunk by chunk; fragment completions alone would stall it", () => {
    // 64 MiB at 1 Mbit/s: 16 KiB transport chunks every 131 ms, one fragment for 537 s.
    const chunked = harness();
    chunked.arm(9_000_000);
    chunked.start();
    let total = 0;
    for (let t = 131; t <= 537_000; t += 131) {
      chunked.at(t);
      total += 16_384;
      chunked.bytes(total);
    }
    chunked.boundary();
    assert.equal(chunked.stops.length, 0, "a healthy large fragment is never a stall");

    // The browser-progress model: only the completed fragment is visible.
    const fragmentLevel = harness();
    fragmentLevel.arm(9_000_000);
    fragmentLevel.start();
    assert.equal(stopTime(fragmentLevel, 537_000), 120_000, "fragment completions are not the evidence");
  });

  it("an HLS resource boundary without byte growth is silence, however many boundaries", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(5_000);
    h.bytes(3 * G);
    for (let t = 10_000; t <= 120_000; t += 5_000) {
      h.at(t);
      h.boundary();
    }
    assert.equal(stopTime(h, 400_000), 125_000);
  });
});

describe("filesystem evidence: yt-dlp progressive, segmented DASH, split halves", () => {
  /** One sample every 150 ms, as the yt-dlp monitor polls. */
  const POLL = 150;

  it("progressive growth sampled from disk keeps the phase alive", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    let total = 0;
    for (let t = POLL; t <= 300_000; t += POLL) {
      h.at(t);
      total += 50_000;
      h.bytes(total, "filesystem");
    }
    assert.equal(h.stops.length, 0);
  });

  it("an output rename reads the same bytes: no credit, so a finished-looking silence still stops", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(1_000);
    h.bytes(5 * G, "filesystem"); // the `.part`
    for (let t = 1_150; t <= 130_000; t += POLL) {
      h.at(t);
      h.bytes(5 * G, "filesystem"); // the renamed final file: the same size
    }
    assert.equal(h.stops.length, 1);
    assert.equal(h.stops[0]!.observedBytes, 5 * G);
    assert.equal(h.watchdog.snapshot().anchorAtMs, h.t0 + 1_000, "repeated readings never moved the anchor");
  });

  it("a segmented DASH rollover dip and its recovery are neither progress nor a stall", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    let total = 0;
    let dips = 0;
    let lastAnchorBytesBeforeDip = 0;
    for (let t = POLL; t <= 240_000; t += POLL) {
      h.at(t);
      if (t % 3_000 === 0) {
        // The aggregate read before a fragment's append, the fragment already gone: one low sample.
        lastAnchorBytesBeforeDip = h.watchdog.snapshot().anchorBytes;
        h.bytes(Math.max(0, total - 40_000), "filesystem");
        dips += 1;
        continue;
      }
      total += 30_000;
      h.bytes(total, "filesystem");
    }
    assert.ok(dips > 50);
    assert.equal(h.stops.length, 0, "continuous real growth with dips is not a stall");
    const s = h.watchdog.snapshot();
    assert.equal(s.discardedBytes, 0, "a one-sample dip is never a discard");
    assert.ok(s.anchorBytes >= lastAnchorBytesBeforeDip);
    // A recovery to the old high-water mark is not new bytes.
    const before = h.watchdog.snapshot();
    h.at(240_000 + POLL);
    h.bytes(total - 40_000, "filesystem");
    h.at(240_000 + 2 * POLL);
    h.bytes(total, "filesystem");
    assert.equal(h.watchdog.snapshot().anchorAtMs, before.anchorAtMs);
    assert.equal(stopTime(h, 600_000) !== null, true, "and growth that stops is a stall");
  });

  it("three low samples confirm a discard, and the window keeps its time", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(10_000);
    h.bytes(1_000_000, "filesystem");
    h.at(20_000);
    h.bytes(10, "filesystem");
    h.at(20_150);
    h.bytes(10, "filesystem");
    assert.equal(h.watchdog.snapshot().discardedBytes, 0, "two low samples are not yet a discard");
    h.at(20_300);
    h.bytes(10, "filesystem");
    const s = h.watchdog.snapshot();
    assert.equal(s.discardedBytes, 1_000_000 - 10);
    assert.equal(s.anchorAtMs, h.t0 + 10_000, "the discard did not restart the window");
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0 + 10_000);
    assert.equal(stopTime(h, 400_000), 130_000, "a retry that restarts nothing gets no extension");
  });

  it("a real retry that restarts from zero re-earns its window only by real growth", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(10_000);
    h.bytes(1_000_000, "filesystem");
    for (const t of [20_000, 20_150, 20_300]) {
      h.at(t);
      h.bytes(10, "filesystem");
    }
    h.at(100_000);
    h.bytes(70_000, "filesystem"); // the source re-sent real bytes from zero: >= 64 KiB over the lowered anchor
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0 + 100_000);
    assert.equal(stopTime(h, 500_000), 220_000);
  });

  it("no false progress from a resumed file already observed: back to the old size is not new bytes", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(10_000);
    h.bytes(800_000, "filesystem");
    h.at(20_000);
    h.bytes(700_000, "filesystem"); // a dip: one low sample
    h.at(20_150);
    h.bytes(800_000, "filesystem"); // the resume shows the bytes already counted
    h.at(20_300);
    h.bytes(800_000 + G - 1, "filesystem"); // still below the floor over the anchor
    assert.equal(h.watchdog.snapshot().anchorAtMs, h.t0 + 10_000);
    assert.equal(stopTime(h, 400_000), 130_000);
  });

  it("a temporary observation gap changes nothing", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(10_000);
    h.bytes(3 * G, "filesystem");
    h.at(10_150);
    h.gap();
    h.at(10_300);
    h.gap();
    h.at(10_450);
    h.bytes(3 * G, "filesystem");
    assert.equal(h.watchdog.report().unobservedCreditMs, 0, "two gaps are not a blind period");
    assert.equal(stopTime(h, 400_000), 130_000);
  });

  // LD-3c changed this test's outcome. LD-3b asserted a STALL at 250 s (window +
  // allowance after the last progress): once the blind allowance was spent the
  // window ran again on blind time. Blind time now never counts toward a stall;
  // spending the allowance is an observation loss of its own.
  it("repeated stat failures pause the window; spending the blind allowance is an observation loss, never a stall (LD-3c)", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(10_000);
    h.bytes(3 * G, "filesystem");
    for (let t = 20_000; t <= 600_000 && h.state() === "watching"; t += POLL) {
      h.at(t);
      if (h.state() !== "watching") break;
      h.gap();
    }
    // Blind from the third gap (20,300); the allowance (one window) is spent at
    // 140,300, decided at the first tick after it.
    assert.equal(h.stops.length, 0, "no stall: nothing was seen to stop");
    assert.equal(h.losses.length, 1);
    assert.equal(h.lossAt(), 141_000);
    assert.equal(h.state(), "observation-lost");
    assert.deepEqual(h.losses[0], { cause: "observation-lost", phase: "single", observedBytes: 3 * G, unobservedMs: 120_700, maxUnobservedMs: WINDOW });
    assert.equal(h.watchdog.report().stop, null);
    assert.deepEqual(h.watchdog.report().observationLoss, h.losses[0]);
    assert.equal(h.watchdog.report().unobservedCreditMs, WINDOW);
    assert.equal(h.vt.pendingCount(), 0, "the decision released the timer");
  });

  it("three gaps and one readable sample, repeated, cannot re-arm the window forever", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(10_000);
    h.bytes(3 * G, "filesystem");
    let trackerReanchors = 0;
    let previousTrackerAnchor = h.watchdog.snapshot().anchorAtMs;
    let t = 20_000;
    while (t <= 2_000_000 && h.stops.length === 0) {
      for (const kind of ["gap", "gap", "gap", "read"] as const) {
        h.at(t);
        if (h.stops.length > 0) break;
        if (kind === "gap") h.gap();
        else h.bytes(3 * G, "filesystem"); // readable again, with no growth
        t += POLL;
      }
      const anchor = h.watchdog.snapshot().anchorAtMs;
      if (anchor !== previousTrackerAnchor) trackerReanchors += 1;
      previousTrackerAnchor = anchor;
    }
    assert.ok(trackerReanchors > 100, "the LD-3a tracker alone re-anchored at every recovery");
    assert.equal(h.stops.length, 1, "the watchdog still stopped");
    assert.ok(h.stopAt()! <= 10_000 + WINDOW + WINDOW, `bounded: stopped at ${h.stopAt()}`);
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0 + 10_000, "no unbacked recovery was honoured");
  });

  // LD-3c: the recovery rule this test pins is unchanged; it now states the
  // allowance it relies on, because 200 s of blindness spends the DEFAULT
  // allowance (one window) and is an observation loss (see the test above).
  it("a recovery backed by real growth earns its fresh window (the design's size-invisible case, inside an explicit allowance)", () => {
    const h = harness({ maxUnobservedMs: 300_000 });
    h.arm(9_000_000);
    h.start();
    h.at(10_000);
    h.bytes(3 * G, "filesystem");
    for (let t = 20_000; t < 220_000; t += POLL) {
      h.at(t);
      h.gap();
    }
    assert.equal(h.stops.length, 0, "200 s of blindness inside the allowance is not a stall");
    h.at(220_000);
    h.bytes(3 * G + 5_000_000, "filesystem"); // the file grew while it could not be seen
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0 + 220_000);
    let total = 3 * G + 5_000_000;
    for (let t = 220_000 + POLL; t <= 500_000; t += POLL) {
      h.at(t);
      total += 30_000;
      h.bytes(total, "filesystem");
    }
    assert.equal(h.stops.length, 0);
  });

  it("the blind allowance renews after meaningful progress, and is spent only by blindness since then", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(10_000);
    h.bytes(3 * G, "filesystem");
    for (let t = 20_000; t < 120_000; t += POLL) {
      h.at(t);
      h.gap();
    }
    h.at(120_000);
    h.bytes(3 * G + 5_000_000, "filesystem"); // visible again, with real growth: honoured
    assert.equal(h.watchdog.report().honouredAnchorAtMs, h.t0 + 120_000);
    assert.equal(h.watchdog.report().unobservedCreditMs, 0, "the old blind time is not carried over");
    for (let t = 130_000; t < 200_000; t += POLL) {
      h.at(t);
      h.gap();
    }
    h.at(200_000);
    h.bytes(3 * G + 5_000_000, "filesystem"); // visible again, nothing new: not honoured
    // Blind from the third gap (130,300) to 200,000: 69,700 ms credited. The window
    // ends at 120,000 + 69,700 + 120,000.
    assert.equal(stopTime(h, 600_000), 310_000);
  });

  // LD-3c resolved the dependency this test pinned. LD-3b asserted a STALL at
  // 250 s here ("a sampler that cannot see is indistinguishable from a stalled
  // source"); the typed observations and the observation-loss decision now tell
  // them apart, so the same blindness is never reported as inactivity.
  it("blindness beyond the allowance is an observation loss, never a stall, even for a run that was growing unseen (LD-3c)", () => {
    const h = harness();
    h.arm(9_000_000);
    h.start();
    h.at(10_000);
    h.bytes(3 * G, "filesystem");
    for (let t = 20_000; t < 300_000 && h.state() === "watching"; t += POLL) {
      h.at(t);
      if (h.state() !== "watching") break;
      h.gap();
    }
    assert.equal(h.stops.length, 0, "an observer that cannot see is no evidence about the source");
    assert.equal(h.losses.length, 1);
    assert.equal(h.lossAt(), 141_000);
    // Visible again, with real growth: too late, the decision stands.
    h.at(300_000);
    h.bytes(3 * G + 5_000_000, "filesystem");
    assert.equal(h.state(), "observation-lost");
    assert.equal(h.stops.length, 0);
    assert.equal(h.losses.length, 1);
  });

  it("video to audio: no window between the phases, a fresh one for the audio half, one deadline for both", () => {
    const h = harness();
    h.arm(600_000);
    h.start("video");
    h.at(50_000);
    h.bytes(10 * G, "filesystem");
    h.at(100_000);
    h.end();
    h.at(300_000); // 200 s of local validation and re-extraction before the audio run starts
    assert.equal(h.stops.length, 0, "no window runs between the phases");
    h.arm(9_999_999); // a later arm can never move the deadline
    h.start("audio");
    const s = h.watchdog.snapshot();
    assert.equal(s.phase, "audio");
    assert.equal(s.observedBytes, 0, "no fabricated progress carried into the audio half");
    assert.equal(s.anchorBytes, 0);
    assert.equal(s.deadlineAtMs, h.t0 + 600_000);
    assert.equal(stopTime(h, 700_000), 420_000);
    assert.equal(h.stops[0]!.phase, "audio");
  });

  it("the shared deadline ends a slow second half: the time limit, not a stall", () => {
    const h = harness();
    h.arm(350_000);
    h.start("video");
    h.at(100_000);
    h.bytes(10 * G);
    h.end();
    h.at(300_000);
    h.start("audio");
    h.vt.advance(200_000);
    assert.equal(h.stops.length, 0);
    assert.equal(h.state(), "time-limit");
  });

  it("a source that ends with fewer than 65,536 bytes completes without a stop", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(1_000);
    h.bytes(1_000);
    h.at(2_000);
    h.end();
    h.at(2_500);
    h.settle("completed");
    h.vt.advance(1_000_000);
    assert.equal(h.stops.length, 0);
    assert.equal(h.state(), "settled");
    assert.equal(h.vt.pendingCount(), 0);
  });
});

describe("terminal outcomes", () => {
  for (const outcome of ["completed", "cancelled", "failed", "deadline-exceeded"] as const) {
    it(`a settlement (${outcome}) before the window ends the watch for good`, () => {
      const h = harness();
      h.arm();
      h.start();
      h.at(60_000);
      h.settle(outcome);
      assert.equal(h.state(), "settled");
      assert.equal(h.vt.pendingCount(), 0);
      h.vt.advance(1_000_000);
      assert.equal(h.stops.length, 0);
    });
  }

  it("late callbacks after settlement change nothing and arm nothing", () => {
    const h = harness();
    h.arm();
    h.start();
    h.at(10_000);
    h.bytes(2 * G);
    h.settle("completed");
    const settled = h.watchdog.snapshot();
    h.bytes(50 * G);
    h.start("audio");
    h.gap();
    assert.deepEqual(h.watchdog.snapshot(), settled);
    assert.equal(h.vt.pendingCount(), 0);
  });

  it("a timer callback that fires during the owner's cleanup is inert", () => {
    // A scheduler that does NOT honour clearTimeout, so a callback already on its way runs after dispose anyway.
    const handlers: Array<() => void> = [];
    let now = 1_000;
    let calls = 0;
    const watchdog = createAcquisitionInactivityWatchdog({
      policy: { windowMs: WINDOW },
      clock: () => now,
      timers: {
        setTimeoutFn: (fn) => {
          handlers.push(fn);
          return {};
        },
        clearTimeoutFn: () => {},
      },
      onStall: () => {
        calls += 1;
      },
    });
    watchdog.record({ kind: "phase-started", phase: "single" });
    // Ordinary ticks one second apart, up to one tick before the window ends.
    for (let i = 1; i < WINDOW / 1_000; i += 1) {
      now += 1_000;
      handlers.at(-1)!();
    }
    assert.equal(calls, 0);
    assert.equal(watchdog.report().state, "watching");
    const late = handlers.at(-1)!;
    const scheduled = handlers.length;
    watchdog.dispose();
    now += 1_000; // one ordinary tick later (no suspension), exactly where the window ends
    late();
    assert.equal(calls, 0, "a disposed watchdog's late tick decides nothing");
    assert.equal(handlers.length, scheduled, "and schedules nothing");
    assert.equal(watchdog.report().state, "disposed");
  });

  it("a stop whose owner disposes it during cleanup is not repeated", () => {
    const vt = virtualTime();
    let calls = 0;
    const watchdog = createAcquisitionInactivityWatchdog({
      policy: { windowMs: WINDOW },
      clock: vt.clock,
      timers: vt.timers,
      onStall: () => {
        calls += 1;
        watchdog.dispose();
      },
    });
    watchdog.record({ kind: "phase-started", phase: "single" });
    vt.advance(10 * WINDOW);
    assert.equal(calls, 1);
    assert.equal(watchdog.report().state, "disposed");
    assert.equal(watchdog.report().stop?.cause, "inactivity", "the decision is kept for the record");
    assert.equal(vt.pendingCount(), 0);
  });

  it("every value the watchdog reports is a number, a fixed string or null", () => {
    const h = harness();
    h.arm();
    h.start("video");
    h.at(120_000);
    const report = h.watchdog.report();
    const flat = JSON.stringify(report);
    for (const [key, value] of Object.entries({ ...report, ...report.stop })) {
      if (value === null || typeof value === "number") continue;
      if (typeof value === "object") continue;
      assert.ok(
        ["inactivity", "video", "stopped", "idle", "watching", "settled", "time-limit", "clock-fault", "disposed"].includes(value as string),
        `${key}: ${String(value)}`,
      );
    }
    assert.equal(/https?:|\/|\\/.test(flat), false);
  });
});
