import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACQUISITION_PROGRESS_MIN_GROWTH_BYTES,
  assessAcquisitionActivity,
  createAcquisitionActivityTracker,
  observeAcquisitionSettlement,
  reportActivity,
  type AcquisitionActivityEvent,
} from "./acquisition-activity.ts";

/**
 * VIDEOFETCH-LD3A-ACQUISITION-ACTIVITY-FOUNDATION-001 — the pure activity model.
 *
 * Virtual time throughout: the clock is a number the test moves. No timer, no
 * I/O and no real wait exists here, so every result is exact and repeatable.
 *
 * The 120-second / 64 KiB rule is LD-3b's to enforce. These tests pin the
 * EVIDENCE that rule will read; nothing here claims a watchdog enforces it.
 */

/** The accepted design target: `LONG-DOWNLOAD-PROGRESS-AND-INACTIVITY-DESIGN.md` §2. */
const TARGET_WINDOW_MS = 120_000;
const TARGET_GROWTH_BYTES = 65_536;

function harness() {
  let nowMs = 1_000;
  const tracker = createAcquisitionActivityTracker({ clock: () => nowMs });
  const startPhase = (phase: "single" | "video" | "audio" = "single") =>
    tracker.record({ kind: "phase-started", phase });
  const bytes = (totalBytes: number, evidence: "transport" | "filesystem" = "filesystem") =>
    tracker.record({ kind: "bytes", totalBytes, evidence });
  return {
    record: tracker.record,
    snapshot: tracker.snapshot,
    startPhase,
    bytes,
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    assess: (windowMs = TARGET_WINDOW_MS) =>
      assessAcquisitionActivity(tracker.snapshot(), { nowMs, windowMs }),
  };
}

describe("the accepted design target", () => {
  it("the meaningful-progress floor is exactly 65,536 bytes", () => {
    assert.equal(ACQUISITION_PROGRESS_MIN_GROWTH_BYTES, 65_536);
    assert.equal(TARGET_GROWTH_BYTES, 65_536);
  });
});

describe("the lifecycle of one acquisition", () => {
  it("nothing has begun: not-started, and no inactivity window runs", () => {
    const t = harness();
    t.record({ kind: "deadline-armed", limitMs: 600_000 });
    t.advance(500_000);
    assert.deepEqual(t.assess(), { status: "not-started", inactivityWindowExhausted: false });
  });

  it("a begun phase with no byte is awaiting-first-byte, and the window runs from the phase's start", () => {
    const t = harness();
    t.startPhase();
    t.advance(119_999);
    assert.deepEqual(t.assess(), { status: "awaiting-first-byte", inactivityWindowExhausted: false });
    t.advance(1);
    assert.deepEqual(t.assess(), { status: "awaiting-first-byte", inactivityWindowExhausted: true });
  });

  it("a zero-byte file is not a first byte; the first real byte is", () => {
    const t = harness();
    t.startPhase();
    t.advance(100);
    t.bytes(0);
    assert.equal(t.snapshot().firstByteAtMs, null);
    assert.equal(t.assess().status, "awaiting-first-byte");
    t.advance(100);
    t.bytes(1);
    assert.equal(t.snapshot().firstByteAtMs, t.now());
    assert.equal(t.snapshot().observedBytes, 1);
    assert.equal(t.assess().status, "receiving");
  });

  it("settled is terminal: the first outcome wins and nothing later changes the record", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1000);
    t.record({ kind: "settled", outcome: "completed" });
    const settled = t.snapshot();
    assert.equal(settled.outcome, "completed");
    t.advance(1000);
    t.bytes(9_999_999); // a late sample after success
    t.record({ kind: "settled", outcome: "failed" });
    t.record({ kind: "phase-started", phase: "audio" });
    t.record({ kind: "deadline-armed", limitMs: 5 });
    assert.deepEqual(t.snapshot(), settled);
    assert.equal(t.assess().status, "completed");
    assert.equal(t.assess().inactivityWindowExhausted, false);
  });

  it("a late sample after cancellation changes nothing", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1000);
    t.record({ kind: "settled", outcome: "cancelled" });
    const settled = t.snapshot();
    t.advance(1000);
    t.bytes(2_000_000);
    assert.deepEqual(t.snapshot(), settled);
    assert.equal(t.assess().status, "cancelled");
  });

  it("no byte is accepted outside a live phase", () => {
    const t = harness();
    t.bytes(500); // before any phase
    assert.equal(t.snapshot().observedBytes, 0);
    t.startPhase("video");
    t.bytes(1000);
    t.record({ kind: "phase-ended" });
    t.bytes(9000); // a late video sample after the phase ended
    assert.equal(t.snapshot().observedBytes, 1000);
  });

  it("a malformed total is never trusted", () => {
    const t = harness();
    t.startPhase();
    t.bytes(Number.NaN);
    t.bytes(-1);
    t.bytes(1.5);
    t.bytes(Number.POSITIVE_INFINITY);
    assert.equal(t.snapshot().observedBytes, 0);
    assert.equal(t.snapshot().firstByteAtMs, null);
  });

  it("the snapshot is frozen and reading it changes nothing", () => {
    const t = harness();
    t.startPhase();
    t.bytes(70_000);
    const a = t.snapshot();
    assert.ok(Object.isFrozen(a));
    assessAcquisitionActivity(a, { nowMs: t.now(), windowMs: TARGET_WINDOW_MS });
    assert.deepEqual(t.snapshot(), a);
  });
});

describe("what counts as progress", () => {
  it("forward byte progress advances the high-water mark and the anchor past the floor", () => {
    const t = harness();
    t.startPhase();
    t.advance(1000);
    t.bytes(70_000);
    const s = t.snapshot();
    assert.equal(s.observedBytes, 70_000);
    assert.equal(s.lastAdvanceAtMs, t.now());
    assert.equal(s.anchorBytes, 70_000);
    assert.equal(s.anchorAtMs, t.now());
    assert.equal(t.assess().status, "receiving");
  });

  it("a repeated identical total does not advance anything", () => {
    const t = harness();
    t.startPhase();
    t.bytes(70_000);
    const anchorAt = t.snapshot().anchorAtMs;
    const advancedAt = t.snapshot().lastAdvanceAtMs;
    for (let i = 0; i < 50; i += 1) {
      t.advance(150);
      t.bytes(70_000);
    }
    const s = t.snapshot();
    assert.equal(s.observedBytes, 70_000);
    assert.equal(s.lastAdvanceAtMs, advancedAt);
    assert.equal(s.anchorAtMs, anchorAt);
    assert.equal(s.lastSampleAdvanced, false);
    assert.equal(t.assess().status, "not-advancing");
  });

  it("time alone is never progress", () => {
    const t = harness();
    t.startPhase();
    t.bytes(70_000);
    const before = t.snapshot();
    t.advance(10_000_000);
    assert.deepEqual(t.snapshot(), before);
  });

  it("progress below the floor accumulates truthfully and invents no milestone", () => {
    const t = harness();
    t.startPhase();
    const startedAt = t.now();
    for (const total of [20_000, 40_000, 65_535]) {
      t.advance(1000);
      t.bytes(total);
      assert.equal(t.snapshot().observedBytes, total, "the exact bytes are recorded");
      assert.equal(t.snapshot().anchorAtMs, startedAt, "below the floor, the anchor does not move");
    }
    t.advance(1000);
    t.bytes(65_536);
    assert.equal(t.snapshot().anchorBytes, 65_536);
    assert.equal(t.snapshot().anchorAtMs, t.now());
  });

  it("samples arriving out of order neither fake progress nor a discard", () => {
    const t = harness();
    t.startPhase();
    t.advance(150);
    t.bytes(300_000);
    t.advance(150);
    t.bytes(200_000); // an older reading delivered late
    assert.equal(t.snapshot().observedBytes, 300_000, "the high-water mark holds");
    assert.equal(t.snapshot().discardedBytes, 0);
    t.advance(150);
    t.bytes(350_000);
    const s = t.snapshot();
    assert.equal(s.observedBytes, 350_000);
    assert.equal(s.discardedBytes, 0);
    assert.equal(s.discardPending, false);
    assert.equal(t.assess().status, "receiving");
  });

  it("a fragment-rollover dip and its recovery are not new bytes", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1_000_000);
    const anchorAt = t.snapshot().anchorAtMs;
    t.advance(150);
    t.bytes(800_000); // the sample missed a fragment that was just renamed
    t.advance(150);
    t.bytes(1_000_000); // and the next reading finds the same bytes again
    const s = t.snapshot();
    assert.equal(s.observedBytes, 1_000_000);
    assert.equal(s.discardedBytes, 0);
    assert.equal(s.anchorAtMs, anchorAt, "a recovery earns no meaningful-progress credit");
  });

  it("a rename reads the same size: no new bytes", () => {
    const t = harness();
    t.startPhase();
    t.bytes(4_000_000);
    const s = t.snapshot();
    t.advance(150);
    t.bytes(4_000_000); // `.part` renamed to its final name, same size
    assert.equal(t.snapshot().observedBytes, 4_000_000);
    assert.equal(t.snapshot().lastAdvanceAtMs, s.lastAdvanceAtMs);
    assert.equal(t.snapshot().anchorAtMs, s.anchorAtMs);
  });

  it("two low samples are noise; a third in a row confirms a discard", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1_000_000);
    const anchorAt = t.snapshot().anchorAtMs;
    t.advance(150);
    t.bytes(0);
    t.advance(150);
    t.bytes(50_000);
    assert.equal(t.snapshot().discardedBytes, 0, "two low samples prove nothing yet");
    t.advance(150);
    t.bytes(60_000);
    const s = t.snapshot();
    assert.equal(s.discardedBytes, 940_000);
    assert.equal(s.observedBytes, 60_000);
    assert.equal(s.anchorBytes, 60_000, "the anchor's byte count drops with the sample");
    assert.equal(s.anchorAtMs, anchorAt, "the anchor's TIME does not move: the drop is not progress");
    assert.equal(s.discardPending, true);
    assert.equal(t.assess().status, "retry-discarded");
  });

  it("after a confirmed discard, genuine growth above the new mark is real progress", () => {
    const t = harness();
    t.startPhase();
    t.bytes(2_000_000);
    for (const total of [0, 1000, 2000]) {
      t.advance(150);
      t.bytes(total);
    }
    assert.equal(t.snapshot().discardPending, true);
    t.advance(150);
    t.bytes(2000 + 65_536);
    const s = t.snapshot();
    assert.equal(s.discardPending, false);
    assert.equal(s.observedBytes, 67_536);
    assert.equal(s.anchorBytes, 67_536);
    assert.equal(s.anchorAtMs, t.now());
    assert.equal(t.assess().status, "receiving");
  });

  it("a resource boundary is not progress", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1_000_000, "transport");
    const before = t.snapshot();
    t.advance(500);
    t.record({ kind: "resource-boundary" });
    const after = t.snapshot();
    assert.equal(after.observedBytes, before.observedBytes);
    assert.equal(after.lastAdvanceAtMs, before.lastAdvanceAtMs);
    assert.equal(after.anchorAtMs, before.anchorAtMs);
    assert.equal(t.assess().status, "between-resources");
    t.advance(500);
    t.bytes(1_000_100, "transport");
    assert.equal(t.assess().status, "receiving");
  });
});

describe("phases: a split or separate-audio pair", () => {
  it("each half counts from zero; the absolute deadline does not reset between them", () => {
    const t = harness();
    t.record({ kind: "deadline-armed", limitMs: 600_000 });
    const deadlineAt = t.snapshot().deadlineAtMs;
    t.startPhase("video");
    t.bytes(5_000_000);
    t.advance(100_000);
    t.record({ kind: "phase-ended" });

    assert.deepEqual(t.assess(), { status: "between-phases", inactivityWindowExhausted: false });

    t.advance(1000);
    t.startPhase("audio");
    let s = t.snapshot();
    assert.equal(s.phase, "audio");
    assert.equal(s.observedBytes, 0, "audio counts from zero");
    assert.equal(s.deadlineAtMs, deadlineAt, "the deadline did not move");

    t.advance(100);
    t.bytes(1000);
    s = t.snapshot();
    assert.equal(s.observedBytes, 1000, "the video half's total is not a floor here");
    assert.equal(t.assess().status, "receiving");
  });

  it("between phases the inactivity window does not run; a later phase starts its own", () => {
    const t = harness();
    t.startPhase("video");
    t.bytes(70_000);
    t.record({ kind: "phase-ended" });
    t.advance(500_000);
    assert.equal(t.assess().inactivityWindowExhausted, false);
    t.startPhase("audio");
    t.advance(119_999);
    assert.equal(t.assess().inactivityWindowExhausted, false);
    t.advance(1);
    assert.equal(t.assess().inactivityWindowExhausted, true);
  });
});

describe("the absolute deadline cannot be extended by this model", () => {
  it("a passed deadline outranks a transfer still receiving data", () => {
    const t = harness();
    t.record({ kind: "deadline-armed", limitMs: 600_000 });
    t.startPhase();
    for (let i = 1; i <= 600; i += 1) {
      t.advance(1000);
      t.bytes(i * 100_000);
    }
    assert.equal(t.assess().status, "deadline-exceeded");
    assert.equal(t.assess().inactivityWindowExhausted, false);
  });

  it("the first arm wins: a later report can never move the deadline", () => {
    const t = harness();
    t.record({ kind: "deadline-armed", limitMs: 1000 });
    const deadlineAt = t.snapshot().deadlineAtMs;
    t.advance(500);
    t.record({ kind: "deadline-armed", limitMs: 999_999_999 });
    assert.equal(t.snapshot().deadlineAtMs, deadlineAt);
  });

  it("a malformed deadline report is ignored", () => {
    const t = harness();
    t.record({ kind: "deadline-armed", limitMs: Number.NaN });
    t.record({ kind: "deadline-armed", limitMs: 0 });
    t.record({ kind: "deadline-armed", limitMs: -5 });
    assert.equal(t.snapshot().deadlineAtMs, null);
  });

  it("settled as deadline-exceeded reads as that, whatever the bytes", () => {
    const t = harness();
    t.startPhase();
    t.bytes(70_000);
    t.record({ kind: "settled", outcome: "deadline-exceeded" });
    assert.equal(t.assess().status, "deadline-exceeded");
  });
});

describe("the 120-second / 64 KiB evidence (LD-3b's future decision)", () => {
  it("sustained progress never exhausts the window", () => {
    const t = harness();
    t.startPhase();
    let total = 0;
    for (let second = 1; second <= 900; second += 1) {
      t.advance(1000);
      total += 70_000;
      t.bytes(total);
      assert.equal(t.assess().inactivityWindowExhausted, false, `second ${second}`);
      assert.equal(t.assess().status, "receiving");
    }
  });

  it("steady progress just over the floor per window never exhausts it", () => {
    const t = harness();
    t.startPhase();
    let total = 0;
    for (let window = 0; window < 30; window += 1) {
      t.advance(119_000);
      total += 65_536;
      t.bytes(total);
      assert.equal(t.assess().inactivityWindowExhausted, false, `window ${window}`);
    }
  });

  it("no growth for exactly 120 s exhausts the window, at 119,999 ms it has not", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1_000_000);
    t.advance(119_999);
    assert.equal(t.assess().inactivityWindowExhausted, false);
    t.advance(1);
    assert.equal(t.assess().inactivityWindowExhausted, true);
    assert.equal(t.assess().status, "not-advancing");
  });

  it("65,535 bytes in the window is not meaningful progress, and it is real bytes all the same", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1_000_000);
    t.advance(60_000);
    t.bytes(1_000_000 + 65_535);
    t.advance(60_000);
    const assessment = t.assess();
    assert.equal(assessment.inactivityWindowExhausted, true);
    assert.equal(t.snapshot().observedBytes, 1_065_535);
  });

  it("repeated identical samples do not defer the window", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1_000_000);
    for (let i = 0; i < 800; i += 1) {
      t.advance(150);
      t.bytes(1_000_000);
    }
    assert.equal(t.assess().inactivityWindowExhausted, true);
  });

  it("a confirmed discard re-anchors the bytes but not the clock", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1_000_000);
    t.advance(119_000);
    for (const total of [0, 0, 0]) {
      t.bytes(total);
      t.advance(300);
    }
    assert.equal(t.snapshot().discardPending, true);
    assert.equal(t.assess().inactivityWindowExhausted, false);
    t.advance(100);
    assert.equal(t.assess().inactivityWindowExhausted, true, "a discard never earns more time");
  });

  it("a stalled next fragment exhausts the window while waiting at a boundary", () => {
    const t = harness();
    t.startPhase();
    t.bytes(1_000_000, "transport");
    t.record({ kind: "resource-boundary" });
    t.advance(120_000);
    assert.deepEqual(t.assess(), { status: "between-resources", inactivityWindowExhausted: true });
  });

  it("an invalid window is refused rather than read as never exhausted", () => {
    const t = harness();
    t.startPhase();
    assert.throws(() => t.assess(0), RangeError);
    assert.throws(() => t.assess(Number.NaN), RangeError);
    assert.throws(() => t.assess(Number.POSITIVE_INFINITY), RangeError);
  });
});

describe("unobservable samples (the accepted design's `unobserved`)", () => {
  it("two gaps are not enough; a third suspends the window, indefinitely", () => {
    const t = harness();
    t.startPhase();
    t.bytes(70_000);
    t.record({ kind: "sample-gap" });
    t.record({ kind: "sample-gap" });
    assert.notEqual(t.assess().status, "unobserved");
    t.record({ kind: "sample-gap" });
    assert.equal(t.assess().status, "unobserved");
    t.advance(TARGET_WINDOW_MS * 10);
    assert.deepEqual(t.assess(), { status: "unobserved", inactivityWindowExhausted: false });
  });

  it("a readable sample ends a run of gaps, and returning from unobserved earns a fresh window, not progress", () => {
    const t = harness();
    t.startPhase();
    t.bytes(70_000);
    t.record({ kind: "sample-gap" });
    t.bytes(70_000);
    t.record({ kind: "sample-gap" });
    t.record({ kind: "sample-gap" });
    assert.notEqual(t.assess().status, "unobserved", "the readable sample reset the run");

    t.record({ kind: "sample-gap" });
    assert.equal(t.assess().status, "unobserved");
    t.advance(TARGET_WINDOW_MS * 10);
    t.bytes(70_000); // readable again, unchanged
    const s = t.snapshot();
    assert.equal(s.anchorAtMs, t.now(), "a fresh window from this moment");
    assert.equal(s.anchorBytes, 70_000);
    assert.equal(s.observedBytes, 70_000, "no credit for the unobserved time");
    t.advance(TARGET_WINDOW_MS);
    assert.equal(t.assess().inactivityWindowExhausted, true);
  });

  it("the absolute deadline still reads through an unobserved phase", () => {
    const t = harness();
    t.record({ kind: "deadline-armed", limitMs: 1000 });
    t.startPhase();
    t.record({ kind: "sample-gap" });
    t.record({ kind: "sample-gap" });
    t.record({ kind: "sample-gap" });
    t.advance(1000);
    assert.equal(t.assess().status, "deadline-exceeded");
  });
});

describe("reportActivity and the observation wrapper", () => {
  const sample: AcquisitionActivityEvent = { kind: "bytes", totalBytes: 1, evidence: "transport" };

  it("a sink that throws is dropped whole, and an absent sink is nothing", () => {
    reportActivity(undefined, sample);
    let calls = 0;
    reportActivity(() => {
      calls += 1;
      throw new Error("observer failure with a /private/path and a https://host/ url");
    }, sample);
    assert.equal(calls, 1);
  });

  it("the first settled closes the sink: one terminal event, and nothing after it", () => {
    const events: AcquisitionActivityEvent[] = [];
    const sink = (e: AcquisitionActivityEvent) => {
      events.push(e);
    };
    reportActivity(sink, { kind: "settled", outcome: "deadline-exceeded" });
    reportActivity(sink, { kind: "settled", outcome: "failed" });
    reportActivity(sink, sample);
    assert.deepEqual(events, [{ kind: "settled", outcome: "deadline-exceeded" }]);
  });

  it("with no sink the run's own promise is returned untouched", async () => {
    const original = Promise.resolve(7);
    const returned = observeAcquisitionSettlement(undefined, () => false, () => original);
    assert.equal(returned, original, "the same promise, not a wrapper");
    assert.equal(await returned, 7);
  });

  it("reports completed only on resolve, after the run", async () => {
    const events: AcquisitionActivityEvent[] = [];
    let ran = false;
    const value = await observeAcquisitionSettlement(
      (e) => events.push(e),
      () => false,
      async () => {
        assert.equal(events.length, 0, "nothing is reported before the run settles");
        ran = true;
        return 5;
      },
    );
    assert.equal(ran, true);
    assert.equal(value, 5);
    assert.deepEqual(events, [{ kind: "settled", outcome: "completed" }]);
  });

  it("a rejection reports cancelled or failed and passes the original error through", async () => {
    const original = new Error("boom");
    for (const [cancelled, outcome] of [
      [true, "cancelled"],
      [false, "failed"],
    ] as const) {
      const events: AcquisitionActivityEvent[] = [];
      await assert.rejects(
        observeAcquisitionSettlement(
          (e) => events.push(e),
          () => cancelled,
          async () => {
            throw original;
          },
        ),
        (err) => err === original,
      );
      assert.deepEqual(events, [{ kind: "settled", outcome }]);
    }
  });

  it("a throwing sink changes neither the result nor the rejection", async () => {
    const fail: (e: AcquisitionActivityEvent) => void = () => {
      throw new Error("sink failure");
    };
    assert.equal(await observeAcquisitionSettlement(fail, () => false, async () => 9), 9);
    const boom = new Error("original");
    await assert.rejects(
      observeAcquisitionSettlement(fail, () => false, async () => {
        throw boom;
      }),
      (err) => err === boom,
    );
  });

  it("the first settled outcome wins: a specific failure is not overwritten by the wrapper", async () => {
    const t = createAcquisitionActivityTracker({ clock: () => 0 });
    await assert.rejects(
      observeAcquisitionSettlement(
        t.record,
        () => false,
        async () => {
          t.record({ kind: "settled", outcome: "deadline-exceeded" });
          throw new Error("x");
        },
      ),
    );
    assert.equal(t.snapshot().outcome, "deadline-exceeded");
  });
});
