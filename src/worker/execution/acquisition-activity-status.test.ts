import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessAcquisitionActivity,
  createAcquisitionActivityTracker,
  type AcquisitionActivityEvent,
} from "../../services/downloads/acquisition-activity.ts";
import { WorkerJobActivitySchema } from "../../shared/worker/job-activity.ts";
import { projectAcquisitionActivity } from "./acquisition-activity-status.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the ONE
 * projection from the watchdog's observation to the public activity, on the
 * REAL LD-3a tracker and assessment, in virtual time. Every internal status is
 * mapped deliberately; anything the contract cannot state exactly is null.
 */

const WINDOW = 120_000;
const LIMIT = 600_000;
const G = 65_536;

function acquisition(startMs = 5_000_000) {
  let nowMs = startMs;
  const tracker = createAcquisitionActivityTracker({ clock: () => nowMs });
  const record = (event: AcquisitionActivityEvent) => tracker.record(event);
  return {
    record,
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    internal: () => assessAcquisitionActivity(tracker.snapshot(), { nowMs, windowMs: WINDOW }).status,
    project: () => projectAcquisitionActivity(tracker.snapshot(), { nowMs, windowMs: WINDOW }),
    snapshot: () => tracker.snapshot(),
    /** Armed and started, as every seam begins. */
    begin(phase: "single" | "video" = "single") {
      record({ kind: "deadline-armed", limitMs: LIMIT });
      record({ kind: "phase-started", phase });
    },
  };
}

describe("internal assessment → public state, one by one", () => {
  it("not-started → starting: no part yet; the armed deadline is stated, idle is not", () => {
    const a = acquisition();
    // Neither armed nor started: the acquisition is starting, and no count is known.
    assert.deepEqual(a.project(), { state: "starting", elapsedSeconds: null, limitSeconds: null, idleSeconds: null });
    a.record({ kind: "deadline-armed", limitMs: LIMIT });
    a.advance(2_500);
    assert.equal(a.internal(), "not-started");
    assert.deepEqual(a.project(), { state: "starting", elapsedSeconds: 2, limitSeconds: 600, idleSeconds: null });
  });

  it("awaiting-first-byte → awaiting-first-byte, idle counted from the part's start", () => {
    const a = acquisition();
    a.record({ kind: "deadline-armed", limitMs: LIMIT });
    a.advance(1_000);
    a.record({ kind: "phase-started", phase: "single" });
    a.advance(21_999);
    assert.equal(a.internal(), "awaiting-first-byte");
    assert.deepEqual(a.project(), { state: "awaiting-first-byte", elapsedSeconds: 22, limitSeconds: 600, idleSeconds: 21 });
  });

  it("receiving → receiving while the last advance is at most 4 s old, then waiting", () => {
    const a = acquisition();
    a.begin();
    a.record({ kind: "bytes", totalBytes: G + 10, evidence: "transport" });
    assert.equal(a.internal(), "receiving");
    assert.deepEqual(a.project(), { state: "receiving", elapsedSeconds: 0, limitSeconds: 600, idleSeconds: 0 });
    a.advance(4_999);
    assert.equal(a.internal(), "receiving", "transport silence is still `receiving` internally");
    assert.equal(a.project()?.state, "receiving");
    assert.equal(a.project()?.idleSeconds, 4);
    a.advance(1);
    assert.equal(a.internal(), "receiving", "…until the window passes");
    assert.deepEqual(a.project(), { state: "waiting", elapsedSeconds: 5, limitSeconds: 600, idleSeconds: 5 });
  });

  it("not-advancing → receiving or waiting by the same idle rule (filesystem samples)", () => {
    const a = acquisition();
    a.begin();
    a.record({ kind: "bytes", totalBytes: 100_000, evidence: "filesystem" });
    a.advance(1_000);
    a.record({ kind: "bytes", totalBytes: 100_000, evidence: "filesystem" });
    assert.equal(a.internal(), "not-advancing");
    assert.deepEqual(a.project(), { state: "receiving", elapsedSeconds: 1, limitSeconds: 600, idleSeconds: 1 });
    a.advance(19_000);
    a.record({ kind: "bytes", totalBytes: 100_000, evidence: "filesystem" });
    assert.deepEqual(a.project(), { state: "waiting", elapsedSeconds: 20, limitSeconds: 600, idleSeconds: 20 });
  });

  it("retry-discarded → waiting: a restart from zero is not progress", () => {
    const a = acquisition();
    a.begin();
    a.record({ kind: "bytes", totalBytes: 300_000, evidence: "filesystem" });
    for (let i = 0; i < 3; i += 1) {
      a.advance(2_000);
      a.record({ kind: "bytes", totalBytes: 1_000, evidence: "filesystem" });
    }
    assert.equal(a.internal(), "retry-discarded");
    assert.deepEqual(a.project(), { state: "waiting", elapsedSeconds: 6, limitSeconds: 600, idleSeconds: 6 });
  });

  it("between-resources → between-resources, with the idle time since the last byte", () => {
    const a = acquisition();
    a.begin();
    a.record({ kind: "bytes", totalBytes: 2_000, evidence: "transport" });
    a.record({ kind: "resource-boundary" });
    a.advance(3_000);
    assert.equal(a.internal(), "between-resources");
    assert.deepEqual(a.project(), { state: "between-resources", elapsedSeconds: 3, limitSeconds: 600, idleSeconds: 3 });
    a.advance(18_000);
    assert.equal(a.project()?.idleSeconds, 21, "a long gap between resources keeps counting");
  });

  it("between-phases → between-phases, without idle time", () => {
    const a = acquisition();
    a.begin("video");
    a.record({ kind: "bytes", totalBytes: 500_000, evidence: "filesystem" });
    a.record({ kind: "phase-ended" });
    a.advance(7_000);
    assert.equal(a.internal(), "between-phases");
    assert.deepEqual(a.project(), { state: "between-phases", elapsedSeconds: 7, limitSeconds: 600, idleSeconds: null });
  });

  it("unobserved → unobserved, without idle time: blindness is never presented as silence", () => {
    const a = acquisition();
    a.begin();
    a.record({ kind: "bytes", totalBytes: 100_000, evidence: "filesystem" });
    for (let i = 0; i < 3; i += 1) {
      a.advance(1_000);
      a.record({ kind: "sample-gap" });
    }
    assert.equal(a.internal(), "unobserved");
    assert.deepEqual(a.project(), { state: "unobserved", elapsedSeconds: 3, limitSeconds: 600, idleSeconds: null });
  });

  it("deadline-exceeded and every settled outcome → null: the durable status decides", () => {
    const passed = acquisition();
    passed.begin();
    passed.advance(LIMIT);
    assert.equal(passed.internal(), "deadline-exceeded");
    assert.equal(passed.project(), null);
    for (const outcome of ["completed", "cancelled", "failed", "deadline-exceeded"] as const) {
      const a = acquisition();
      a.begin();
      a.record({ kind: "bytes", totalBytes: 1_000, evidence: "transport" });
      a.record({ kind: "settled", outcome });
      assert.equal(a.internal(), outcome);
      assert.equal(a.project(), null, outcome);
    }
  });
});

describe("numbers: exact, bounded, never invented", () => {
  it("the limit is the deadline AS ARMED, rounded up to whole seconds; elapsed is floored", () => {
    const a = acquisition();
    a.record({ kind: "deadline-armed", limitMs: 1_500 });
    a.record({ kind: "phase-started", phase: "single" });
    a.advance(1_499);
    assert.deepEqual(a.project(), { state: "awaiting-first-byte", elapsedSeconds: 1, limitSeconds: 2, idleSeconds: 1 });
  });

  it("a later deadline-armed report changes nothing: the first wins", () => {
    const a = acquisition();
    a.begin();
    a.record({ kind: "deadline-armed", limitMs: 9_000_000 });
    assert.equal(a.project()?.limitSeconds, 600);
    assert.equal(a.snapshot().deadlineLimitMs, LIMIT);
  });

  it("a limit beyond the contract's bound is not clamped: no activity at all", () => {
    const a = acquisition();
    a.record({ kind: "deadline-armed", limitMs: 86_401_000 });
    a.record({ kind: "phase-started", phase: "single" });
    assert.equal(a.project(), null);
  });

  it("a clock that is not a finite number, or that reads before the arming, gives null", () => {
    const a = acquisition();
    a.begin();
    a.record({ kind: "bytes", totalBytes: 1_000, evidence: "transport" });
    for (const nowMs of [Number.NaN, Infinity, -Infinity]) {
      assert.equal(projectAcquisitionActivity(a.snapshot(), { nowMs, windowMs: WINDOW }), null);
    }
    assert.equal(projectAcquisitionActivity(a.snapshot(), { nowMs: a.now() - 5_000, windowMs: WINDOW }), null);
  });

  it("an invalid window gives null rather than throwing into a status read", () => {
    const a = acquisition();
    a.begin();
    assert.equal(projectAcquisitionActivity(a.snapshot(), { nowMs: a.now(), windowMs: 0 }), null);
  });

  it("every projection it returns satisfies the strict contract", () => {
    const a = acquisition();
    a.begin();
    const seen = new Set<string>();
    const totals = [10_000, 10_000, 80_000, 80_000, 70_000, 70_000, 70_000, 200_000];
    for (const total of totals) {
      a.advance(3_000);
      a.record({ kind: "bytes", totalBytes: total, evidence: "filesystem" });
      for (let step = 0; step < 4; step += 1) {
        a.advance(2_000);
        const activity = a.project();
        assert.ok(activity, "a live part always has an activity");
        assert.equal(WorkerJobActivitySchema.safeParse(activity).success, true, JSON.stringify(activity));
        seen.add(activity.state);
      }
    }
    assert.deepEqual([...seen].sort(), ["receiving", "waiting"]);
  });
});

describe("a read changes nothing", () => {
  it("projecting reads the snapshot only: the tracker's facts are identical before and after", () => {
    const a = acquisition();
    a.begin();
    a.record({ kind: "bytes", totalBytes: G * 2, evidence: "transport" });
    a.advance(30_000);
    const before = a.snapshot();
    for (let i = 0; i < 1_000; i += 1) a.project();
    assert.deepEqual(a.snapshot(), before);
    assert.ok(Object.isFrozen(before));
  });

  it("the projection takes no percentage, speed or ETA: its inputs are the snapshot and two numbers", () => {
    assert.equal(projectAcquisitionActivity.length, 2);
    const a = acquisition();
    a.begin();
    const keys = Object.keys(a.snapshot());
    for (const forbidden of ["progress", "percent", "speed", "eta", "totalBytes"]) {
      assert.equal(keys.includes(forbidden), false, forbidden);
    }
  });
});
