import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_RETRY_BUDGET_MS,
  STATUS_POLL_RETRY_DELAYS_MS,
  STATUS_REQUEST_TIMEOUT_MS,
  classifyStatusPollFailure,
  startJobStatusPoller,
  statusPollRetryDelayMs,
  type JobStatusPollEvent,
} from "./job-status-poller.ts";
import {
  FakeClock,
  JOB_ID,
  ScriptedStatus,
  apiError,
  networkFailure,
  polledJob,
  type ScriptStep,
} from "./job-status-poll.fixtures.ts";

/**
 * BROWSER-JOB-STATUS-POLL-RESILIENCE-001: the polling loop under a fake clock.
 */

function run(steps: ScriptStep[], options: { initialDelayMs?: number; fallback?: ScriptStep } = {}) {
  const clock = new FakeClock();
  const endpoint = new ScriptedStatus(clock, steps, options.fallback);
  const events: (JobStatusPollEvent & { at: number })[] = [];
  const poller = startJobStatusPoller({
    jobId: JOB_ID,
    fetchStatus: endpoint.fetchStatus,
    onEvent: (event) => events.push({ ...event, at: clock.now() }),
    initialDelayMs: options.initialDelayMs,
    clock,
  });
  const types = () => events.map((e) => e.type);
  const callTimes = () => endpoint.calls.map((c) => c.at);
  const gaps = () => callTimes().slice(1).map((t, i) => t - callTimes()[i]);
  return { clock, endpoint, events, poller, types, callTimes, gaps };
}

const WORKER_UNAVAILABLE = () => apiError("WORKER_UNAVAILABLE", 503);

describe("classifying a failed status read", () => {
  const transient: [string, unknown][] = [
    ["no response (network)", networkFailure()],
    ["WORKER_UNAVAILABLE 503", apiError("WORKER_UNAVAILABLE", 503)],
    ["PROCESSING_FAILED 500 (unclassified control-plane failure)", apiError("PROCESSING_FAILED", 500)],
    ["a 502 edge page with no envelope", apiError(null, 502)],
    ["a 504 with no envelope", apiError(null, 504)],
    ["a 503 with no envelope", apiError(null, 503)],
    ["408 request timeout", apiError(null, 408)],
    ["429 RATE_LIMITED", apiError("RATE_LIMITED", 429)],
    ["429 with no envelope", apiError(null, 429)],
    ["a 2xx that was not a job status", apiError(null, 200)],
    ["something that is not a ClientApiError", new TypeError("boom")],
  ];
  for (const [label, error] of transient) {
    it(`retries ${label}`, () => {
      assert.equal(classifyStatusPollFailure(error), "transient");
    });
  }

  const definitive: [string, unknown][] = [
    ["NOT_FOUND 404", apiError("NOT_FOUND", 404)],
    ["EXPIRED 410", apiError("EXPIRED", 410)],
    ["ACCESS_REQUIRED 401", apiError("ACCESS_REQUIRED", 401)],
    ["ACCESS_NOT_CONFIGURED 503 (the code wins over the 5xx)", apiError("ACCESS_NOT_CONFIGURED", 503)],
    ["FORBIDDEN 403", apiError("FORBIDDEN", 403)],
    ["a 404 with no envelope", apiError(null, 404)],
    ["a 400 with no envelope", apiError(null, 400)],
  ];
  for (const [label, error] of definitive) {
    it(`stops on ${label}`, () => {
      assert.equal(classifyStatusPollFailure(error), "definitive");
    });
  }
});

describe("backoff and budget constants", () => {
  it("backs off 800 → 1500 → 3000 → 5000 and caps at 5000", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9, 100].map(statusPollRetryDelayMs), [800, 1500, 3000, 5000, 5000, 5000, 5000]);
    assert.deepEqual([...STATUS_POLL_RETRY_DELAYS_MS], [800, 1500, 3000, 5000]);
  });

  it("keeps the healthy cadence at 800 ms and a 120 s outage budget", () => {
    assert.equal(STATUS_POLL_INTERVAL_MS, 800);
    assert.equal(STATUS_POLL_RETRY_BUDGET_MS, 120_000);
    // The budget must outlast a request caught in a tunnel drop (up to the
    // control plane's 30 s Worker budget) several times over.
    assert.ok(STATUS_POLL_RETRY_BUDGET_MS >= 3 * 30_000);
    assert.ok(STATUS_REQUEST_TIMEOUT_MS < 30_000);
  });
});

describe("a healthy loop", () => {
  it("polls every 800 ms after each answer and stops on ready", async () => {
    const { clock, endpoint, types, callTimes } = run([
      { job: polledJob("downloading") },
      { job: polledJob("processing") },
      { job: polledJob("uploading") },
      { job: polledJob("ready") },
    ]);
    await clock.advance(10_000);
    assert.deepEqual(types(), ["status", "status", "status", "ready"]);
    assert.deepEqual(callTimes(), [800, 1600, 2400, 3200]);
    assert.equal(endpoint.calls.length, 4, "no request after ready");
    assert.equal(clock.pendingTimers(), 0);
  });

  it("waits for a slow answer before scheduling the next request", async () => {
    const { clock, endpoint, callTimes } = run([
      { job: polledJob("downloading"), latencyMs: 5_000 },
      { job: polledJob("downloading"), latencyMs: 3_000 },
      { job: polledJob("ready") },
    ]);
    await clock.advance(20_000);
    assert.deepEqual(callTimes(), [800, 800 + 5_000 + 800, 800 + 5_000 + 800 + 3_000 + 800]);
    assert.equal(endpoint.maxInFlight, 1);
  });

  for (const status of ["failed", "cancelled"] as const) {
    it(`ends on a ${status} job without retrying`, async () => {
      const { clock, endpoint, events } = run([
        { job: polledJob("downloading") },
        { job: polledJob(status, { errorCode: "TIMEOUT", error: "x" }) },
      ]);
      await clock.advance(60_000);
      assert.deepEqual(events.map((e) => e.type), ["status", "ended"]);
      const ended = events[1];
      assert.equal(ended.type === "ended" && ended.job.status, status);
      assert.equal(endpoint.calls.length, 2);
      assert.equal(clock.pendingTimers(), 0);
    });
  }

  it("honors an immediate first request (manual retry)", async () => {
    const { clock, callTimes } = run([{ job: polledJob("ready") }], { initialDelayMs: 0 });
    await clock.advance(1);
    assert.deepEqual(callTimes(), [0]);
  });
});

describe("transient failures keep the loop alive", () => {
  it("recovers from one network failure: reconnecting, then status, then ready", async () => {
    const { clock, types, gaps } = run([
      { job: polledJob("downloading") },
      { error: networkFailure() },
      { job: polledJob("processing") },
      { job: polledJob("ready") },
    ]);
    await clock.advance(10_000);
    assert.deepEqual(types(), ["status", "reconnecting", "status", "ready"]);
    assert.deepEqual(gaps(), [800, 800, 800]);
  });

  it("recovers from several WORKER_UNAVAILABLE answers, backing off to the cap", async () => {
    const { clock, types, gaps, endpoint } = run([
      { job: polledJob("downloading") },
      { error: WORKER_UNAVAILABLE() },
      { error: WORKER_UNAVAILABLE() },
      { error: WORKER_UNAVAILABLE() },
      { error: WORKER_UNAVAILABLE() },
      { error: WORKER_UNAVAILABLE() },
      { job: polledJob("processing") },
      { job: polledJob("ready") },
    ]);
    await clock.advance(60_000);
    assert.deepEqual(types(), [
      "status",
      "reconnecting",
      "reconnecting",
      "reconnecting",
      "reconnecting",
      "reconnecting",
      "status",
      "ready",
    ]);
    // After the first status: 800, then the backoff after failures 1..5, then
    // the healthy cadence again.
    assert.deepEqual(gaps(), [800, 800, 1500, 3000, 5000, 5000, 800]);
    assert.equal(endpoint.maxInFlight, 1);
  });

  for (const [label, error] of [
    ["500 PROCESSING_FAILED", apiError("PROCESSING_FAILED", 500)],
    ["502 edge page", apiError(null, 502)],
    ["504 gateway timeout", apiError(null, 504)],
    ["408", apiError(null, 408)],
    ["429", apiError("RATE_LIMITED", 429)],
    ["a 2xx interstitial", apiError(null, 200)],
  ] as const) {
    it(`retries ${label}`, async () => {
      const { clock, types } = run([{ error }, { error }, { job: polledJob("ready") }]);
      await clock.advance(10_000);
      assert.deepEqual(types(), ["reconnecting", "reconnecting", "ready"]);
    });
  }

  it("a success resets the backoff", async () => {
    const { clock, gaps } = run([
      { error: WORKER_UNAVAILABLE() },
      { error: WORKER_UNAVAILABLE() },
      { error: WORKER_UNAVAILABLE() },
      { job: polledJob("downloading") },
      { error: WORKER_UNAVAILABLE() },
      { job: polledJob("ready") },
    ]);
    await clock.advance(30_000);
    // 800, 1500, 3000 after failures 1..3; 800 after the success; and 800
    // again — not 5000 — after the next first failure.
    assert.deepEqual(gaps(), [800, 1500, 3000, 800, 800]);
  });

  it("a success resets the outage clock", async () => {
    // ~100 s of failures, one success, then ~105 s more: 205 s of failure in
    // total, but never 120 s in a row.
    const clock = new FakeClock();
    const endpoint = new ScriptedStatus(clock, []);
    const events: JobStatusPollEvent[] = [];
    let recovered = false;
    const fetchStatus = (jobId: string, signal: AbortSignal) => {
      const now = clock.now();
      if (!recovered && now >= 100_000) {
        recovered = true;
        endpoint.push({ job: polledJob("downloading") });
      } else if (recovered && now >= 205_000) {
        endpoint.push({ job: polledJob("ready") });
      } else {
        endpoint.push({ error: WORKER_UNAVAILABLE() });
      }
      return endpoint.fetchStatus(jobId, signal);
    };
    startJobStatusPoller({ jobId: JOB_ID, fetchStatus, onEvent: (e) => events.push(e), clock });
    await clock.advance(300_000);
    const types = events.map((e) => e.type);
    assert.equal(types.includes("exhausted"), false, "the outage clock must restart after a success");
    assert.equal(types.filter((t) => t === "status").length, 1);
    assert.equal(types.at(-1), "ready");
  });
});

describe("the outage budget", () => {
  it("gives up after 120 s of continuous failure, measured in time", async () => {
    const { clock, events, endpoint } = run([], { fallback: { error: WORKER_UNAVAILABLE() } });
    await clock.advance(600_000);
    const exhausted = events.findIndex((e) => e.type === "exhausted");
    assert.ok(exhausted > 0);
    assert.equal(exhausted, events.length - 1, "nothing is reported after exhausted");
    const firstFailure = endpoint.calls[0].at;
    const givenUpAt = events[exhausted].at;
    assert.ok(givenUpAt - firstFailure >= STATUS_POLL_RETRY_BUDGET_MS);
    assert.ok(givenUpAt - firstFailure < STATUS_POLL_RETRY_BUDGET_MS + 5_000 + 1);
    assert.equal(clock.pendingTimers(), 0, "the loop stopped itself");
    const calls = endpoint.calls.length;
    await clock.advance(600_000);
    assert.equal(endpoint.calls.length, calls, "no request after exhausted");
  });

  it("counts elapsed time, not attempts: slow failures give up at the same time with fewer attempts", async () => {
    const fast = run([], { fallback: { error: WORKER_UNAVAILABLE() } });
    const slow = run([], { fallback: { error: WORKER_UNAVAILABLE(), latencyMs: 14_000 } });
    await fast.clock.advance(600_000);
    await slow.clock.advance(600_000);
    const at = (r: typeof fast) => r.events.find((e) => e.type === "exhausted")!.at - r.endpoint.calls[0].at;
    assert.ok(at(fast) >= STATUS_POLL_RETRY_BUDGET_MS && at(slow) >= STATUS_POLL_RETRY_BUDGET_MS);
    assert.ok(at(slow) < STATUS_POLL_RETRY_BUDGET_MS + 5_000 + 14_000 + 1);
    assert.ok(slow.endpoint.calls.length < fast.endpoint.calls.length);
  });

  it("aborts a request that hangs past the request timeout and counts it as transient", async () => {
    const { clock, endpoint, types, callTimes } = run([
      { hang: true },
      { job: polledJob("ready") },
    ]);
    await clock.advance(STATUS_REQUEST_TIMEOUT_MS + 5_000);
    assert.equal(endpoint.aborted, 1);
    assert.deepEqual(types(), ["reconnecting", "ready"]);
    assert.deepEqual(callTimes(), [800, 800 + STATUS_REQUEST_TIMEOUT_MS + 800]);
    assert.equal(endpoint.maxInFlight, 1);
  });

  it("gives up even when every request hangs", async () => {
    const { clock, types, endpoint } = run([], { fallback: { hang: true } });
    await clock.advance(600_000);
    assert.equal(types().at(-1), "exhausted");
    assert.equal(endpoint.maxInFlight, 1);
    assert.equal(endpoint.aborted, endpoint.calls.length);
  });
});

describe("definitive answers stop at once", () => {
  for (const [code, status] of [
    ["NOT_FOUND", 404],
    ["EXPIRED", 410],
    ["ACCESS_REQUIRED", 401],
    ["ACCESS_NOT_CONFIGURED", 503],
    ["FORBIDDEN", 403],
  ] as const) {
    it(`${code}: one request, one stopped event, nothing after`, async () => {
      const { clock, endpoint, events } = run([
        { job: polledJob("downloading") },
        { error: apiError(code, status) },
      ], { fallback: { job: polledJob("ready") } });
      await clock.advance(600_000);
      assert.deepEqual(events.map((e) => e.type), ["status", "stopped"]);
      const stopped = events[1];
      assert.equal(stopped.type === "stopped" && stopped.error.code, code);
      assert.equal(endpoint.calls.length, 2);
      assert.equal(clock.pendingTimers(), 0);
    });
  }
});

describe("single flight", () => {
  it("never has two requests in flight — slow success, slow 5xx, reconnecting", async () => {
    const { clock, endpoint, types } = run([
      { job: polledJob("downloading"), latencyMs: 4_000 },
      { error: apiError(null, 502), latencyMs: 6_000 },
      { error: networkFailure(), latencyMs: 2_500 },
      { error: WORKER_UNAVAILABLE(), latencyMs: 9_000 },
      { job: polledJob("processing"), latencyMs: 7_000 },
      { job: polledJob("ready"), latencyMs: 1_000 },
    ]);
    await clock.advance(120_000);
    assert.deepEqual(types(), ["status", "reconnecting", "reconnecting", "reconnecting", "status", "ready"]);
    assert.equal(endpoint.maxInFlight, 1);
    assert.equal(endpoint.calls.length, 6);
  });
});

describe("stop()", () => {
  it("aborts the request in flight and reports nothing when it settles", async () => {
    const { clock, endpoint, events, poller } = run([{ job: polledJob("ready"), latencyMs: 2_000 }]);
    await clock.advance(1_000);
    assert.equal(endpoint.inFlight, 1);
    poller.stop();
    assert.equal(endpoint.calls[0].signal.aborted, true);
    await clock.advance(60_000);
    assert.deepEqual(events, []);
    assert.equal(endpoint.calls.length, 1);
  });

  it("cancels a scheduled attempt", async () => {
    const { clock, endpoint, poller } = run([{ job: polledJob("downloading") }]);
    await clock.advance(1_000);
    assert.equal(endpoint.calls.length, 1);
    poller.stop();
    assert.equal(clock.pendingTimers(), 0);
    await clock.advance(60_000);
    assert.equal(endpoint.calls.length, 1);
  });

  it("stops a reconnecting loop", async () => {
    const { clock, endpoint, events, poller } = run([], { fallback: { error: WORKER_UNAVAILABLE() } });
    await clock.advance(5_000);
    const calls = endpoint.calls.length;
    const reported = events.length;
    poller.stop();
    await clock.advance(600_000);
    assert.equal(endpoint.calls.length, calls);
    assert.equal(events.length, reported);
  });
});
