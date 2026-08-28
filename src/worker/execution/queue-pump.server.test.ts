import test from "node:test";
import assert from "node:assert/strict";
import { QueuePump, WORKER_MAX_CONCURRENT_JOBS } from "./queue-pump.server.ts";
import type { QueueRunner } from "./queue-runner.server.ts";

type RunResult = { type: "idle" } | { type: "executed"; jobId: string };

/**
 * Minimal FIFO stand-in for the durable claim. `runNext` resolves on a
 * microtask so wake-ups can interleave at the exact await point the real pump
 * suspends on.
 */
class FakeRunner {
  public readonly queue: string[] = [];
  public readonly executed: string[] = [];
  public concurrent = 0;
  public maxObservedConcurrency = 0;
  public onEnter: (() => void) | null = null;
  public failNext: Error | null = null;

  async runNext(): Promise<RunResult> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }

    this.concurrent += 1;
    this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.concurrent);
    try {
      const jobId = this.queue.shift();
      // Yield exactly like a real claim + execute would.
      await Promise.resolve();
      const hook = this.onEnter;
      this.onEnter = null;
      hook?.();
      await Promise.resolve();

      if (!jobId) return { type: "idle" };
      this.executed.push(jobId);
      return { type: "executed", jobId };
    } finally {
      this.concurrent -= 1;
    }
  }
}

function pumpFor(runner: FakeRunner, onError?: (e: unknown) => void) {
  return new QueuePump(runner as unknown as QueueRunner, onError);
}

test("v1 worker concurrency is exactly one", () => {
  assert.equal(WORKER_MAX_CONCURRENT_JOBS, 1);
});

test("nothing runs until wake() is called", async () => {
  const runner = new FakeRunner();
  runner.queue.push("a");
  const pump = pumpFor(runner);

  await Promise.resolve();
  assert.equal(pump.isRunning, false);
  assert.deepEqual(runner.executed, []);

  pump.wake();
  await pump.whenDrained();
  assert.deepEqual(runner.executed, ["a"]);
});

test("wake() returns before the job executes", async () => {
  const runner = new FakeRunner();
  runner.queue.push("a");
  const pump = pumpFor(runner);

  pump.wake();
  // Synchronously after wake(), no execution has happened yet.
  assert.deepEqual(runner.executed, []);
  assert.equal(pump.isRunning, true);

  await pump.whenDrained();
  assert.deepEqual(runner.executed, ["a"]);
});

test("drains FIFO until idle from a single wake", async () => {
  const runner = new FakeRunner();
  runner.queue.push("a", "b", "c");
  const pump = pumpFor(runner);

  pump.wake();
  await pump.whenDrained();

  assert.deepEqual(runner.executed, ["a", "b", "c"]);
  assert.equal(pump.isRunning, false);
});

test("simultaneous wakes never start a second drain loop", async () => {
  const runner = new FakeRunner();
  runner.queue.push("a", "b", "c", "d");
  const pump = pumpFor(runner);

  pump.wake();
  pump.wake();
  pump.wake();
  await pump.whenDrained();

  assert.equal(runner.maxObservedConcurrency, 1, "runNext must never overlap");
  assert.deepEqual(runner.executed, ["a", "b", "c", "d"]);
});

test("no duplicate execution when many creates wake the pump mid-drain", async () => {
  const runner = new FakeRunner();
  const pump = pumpFor(runner);

  runner.queue.push("a");
  pump.wake();
  // Enqueue + wake repeatedly while the pump is already draining.
  for (const id of ["b", "c", "d", "e"]) {
    runner.queue.push(id);
    pump.wake();
    await Promise.resolve();
  }
  await pump.whenDrained();

  assert.deepEqual(runner.executed, ["a", "b", "c", "d", "e"]);
  assert.equal(new Set(runner.executed).size, runner.executed.length, "no job ran twice");
  assert.equal(runner.maxObservedConcurrency, 1);
});

test("lost wake-up: a job arriving as the pump finishes is still executed", async () => {
  const runner = new FakeRunner();
  const pump = pumpFor(runner);

  runner.queue.push("first");
  pump.wake();

  // Fire the wake from INSIDE the final runNext — the moment the pump is about
  // to observe an empty queue and transition to idle.
  runner.onEnter = () => {
    runner.queue.push("late");
    pump.wake();
  };

  await pump.whenDrained();

  assert.deepEqual(runner.executed, ["first", "late"]);
  assert.equal(pump.isRunning, false);
});

test("lost wake-up: enqueue during the idle-detecting runNext still drains", async () => {
  const runner = new FakeRunner();
  const pump = pumpFor(runner);

  runner.queue.push("only");
  pump.wake();
  await pump.whenDrained();
  assert.deepEqual(runner.executed, ["only"]);

  // Second round: the pump sees idle first, then work arrives inside that call.
  runner.onEnter = () => {
    runner.queue.push("arrived-at-idle");
    pump.wake();
  };
  pump.wake();
  await pump.whenDrained();

  assert.deepEqual(runner.executed, ["only", "arrived-at-idle"]);
});

test("a runner failure stops the loop without an unhandled rejection", async () => {
  const runner = new FakeRunner();
  const seen: unknown[] = [];
  const pump = pumpFor(runner, (err) => seen.push(err));

  runner.failNext = new Error("store down");
  runner.queue.push("a");
  pump.wake();
  await pump.whenDrained();

  assert.equal(seen.length, 1);
  assert.equal(pump.isRunning, false);
  assert.deepEqual(runner.executed, []);

  // A later wake recovers and drains the still-queued work.
  pump.wake();
  await pump.whenDrained();
  assert.deepEqual(runner.executed, ["a"]);
});

test("whenDrained resolves even when never woken", async () => {
  const runner = new FakeRunner();
  const pump = pumpFor(runner);
  await pump.whenDrained();
  assert.equal(pump.isRunning, false);
});
