import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClientApiError, type PolledJob } from "./client-api.ts";
import {
  CANCEL_REQUEST_TIMEOUT_MS,
  CANCEL_UNAVAILABLE_MESSAGE,
  cancelConfirmDescription,
  cancelRefusalMessage,
  classifyCancelFailure,
  createCancelController,
} from "./download-cancel.ts";
import {
  canRequestCancel,
  downloaderReducer,
  finishedJobForHistory,
  initialDownloaderState,
  statusPollTarget,
  type DownloaderAction,
  type DownloaderState,
} from "./downloader-state.ts";
import { ERROR_MESSAGES, type ErrorCode } from "./errors.ts";
import {
  CANCELLED_HEADING,
  CHOOSE_ANOTHER_QUALITY_LABEL,
  DEFAULT_ERROR_HEADING,
  FRESH_START_HINT,
  TRY_AGAIN_LABEL,
  errorCardHeading,
  jobOutcomeRetry,
} from "./job-failure-ui.ts";
import type { JobStatusPollEvent } from "./job-status-poller.ts";
import { FakeClock, JOB_ID, OTHER_JOB_ID, apiError, networkFailure, polledJob } from "./job-status-poll.fixtures.ts";

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: the browser's side
 * of a cancellation. The reducer shows only an outcome the Worker committed;
 * the controller sends one request at a time and classifies its failures by
 * structure only.
 */

function reduce(state: DownloaderState, ...actions: DownloaderAction[]): DownloaderState {
  return actions.reduce(downloaderReducer, state);
}

function processing(jobId = JOB_ID, status: PolledJob["status"] = "downloading"): DownloaderState {
  return reduce(
    initialDownloaderState,
    { type: "analyze_started" },
    { type: "analyze_succeeded" },
    { type: "download_requested" },
    { type: "download_started", job: polledJob(status, { jobId }) },
  );
}

function poll(state: DownloaderState, event: JobStatusPollEvent, jobId = JOB_ID): DownloaderState {
  return downloaderReducer(state, { type: "status_poll", jobId, generation: state.poll.generation, event });
}

const requested = (s: DownloaderState, attempt = 1, jobId = JOB_ID) =>
  downloaderReducer(s, { type: "cancel_requested", jobId, attempt });
const answered = (s: DownloaderState, job: PolledJob, attempt = 1, jobId = JOB_ID) =>
  downloaderReducer(s, { type: "cancel_answered", jobId, attempt, job });
const failed = (s: DownloaderState, failure: "refused" | "unconfirmed", attempt = 1, message = "m", jobId = JOB_ID) =>
  downloaderReducer(s, { type: "cancel_failed", jobId, attempt, failure, message });

const cancelledJob = (jobId = JOB_ID) => polledJob("cancelled", { jobId, stageLabel: "Cancelled", progress: 42 });

describe("who may send a cancellation", () => {
  it("only the page processing that job, with nothing already out", () => {
    const s = processing();
    assert.equal(canRequestCancel(s, JOB_ID), true);
    assert.equal(canRequestCancel(s, OTHER_JOB_ID), false, "another job");
    assert.equal(canRequestCancel(requested(s), JOB_ID), false, "a request is already out");
    assert.equal(canRequestCancel(initialDownloaderState, JOB_ID), false, "idle");
    assert.equal(canRequestCancel(poll(s, { type: "ready", job: polledJob("ready") }), JOB_ID), false, "complete");
    assert.equal(canRequestCancel(poll(s, { type: "ended", job: cancelledJob() }), JOB_ID), false, "ended");
  });

  it("the reducer refuses the same requests, so state alone cannot double-send", () => {
    const s = requested(processing());
    assert.equal(requested(s, 2), s, "second request while one is out: unchanged state");
    assert.equal(requested(processing(), 1, OTHER_JOB_ID).cancel.kind, "idle");
    assert.equal(requested(initialDownloaderState).cancel.kind, "idle");
  });

  it("is possible in every connectivity state of a running job, and for every active status", () => {
    for (const status of ["queued", "analyzing", "downloading", "processing", "uploading"] as const) {
      assert.equal(canRequestCancel(processing(JOB_ID, status), JOB_ID), true, status);
    }
    const reconnecting = poll(processing(), { type: "reconnecting" });
    assert.equal(canRequestCancel(reconnecting, JOB_ID), true);
    const exhausted = poll(processing(), { type: "exhausted" });
    assert.equal(canRequestCancel(exhausted, JOB_ID), true);
  });
});

describe("the answer: the committed job, never a local invention", () => {
  it("cancelled → the cancellation outcome", () => {
    const s = answered(requested(processing()), cancelledJob());
    assert.equal(s.phase, "error");
    assert.equal(s.job?.status, "cancelled");
    assert.equal(s.error, "This download was cancelled.");
    assert.equal(s.cancel.kind, "idle");
    assert.equal(errorCardHeading(s.job), CANCELLED_HEADING);
    assert.equal(finishedJobForHistory(s)?.status, "cancelled");
    assert.equal(statusPollTarget(s), null, "polling stops");
  });

  it("ready → the finished download stays a finished download", () => {
    const s = answered(requested(processing()), polledJob("ready"));
    assert.equal(s.phase, "complete");
    assert.equal(s.job?.status, "ready");
    assert.equal(s.job?.downloadUrl, `/api/download/${JOB_ID}/file`);
    assert.equal(finishedJobForHistory(s)?.status, "ready");
  });

  it("failed → the failure stays the failure, with its stage heading", () => {
    const job = polledJob("failed", {
      errorCode: "TIMEOUT",
      stageLabel: "Upload failed",
      error: "Uploading the finished file took too long.",
    });
    const s = answered(requested(processing()), job);
    assert.equal(s.phase, "error");
    assert.equal(s.error, "Uploading the finished file took too long.");
    assert.equal(errorCardHeading(s.job), "Upload failed");
  });

  it("an answer that does not end the job proves nothing: unconfirmed, job untouched, polling continues", () => {
    const before = requested(poll(processing(), { type: "status", job: polledJob("downloading", { progress: 60 }) }));
    const s = answered(before, polledJob("downloading", { progress: 10 }));
    assert.equal(s.phase, "processing");
    assert.equal(s.cancel.kind, "unconfirmed");
    assert.equal(s.job?.progress, 60, "a possibly older view does not overwrite the job");
    assert.ok(statusPollTarget(s));
  });

  it("an answer for another job id is never applied", () => {
    const s = answered(requested(processing()), cancelledJob(OTHER_JOB_ID));
    assert.equal(s.phase, "processing");
    assert.equal(s.job?.jobId, JOB_ID);
    assert.equal(s.cancel.kind, "unconfirmed");
  });

  it("NEGATIVE CONTROL shape: a 200 for a ready job is not shown as cancelled", () => {
    const s = answered(requested(processing()), polledJob("ready"));
    assert.notEqual(errorCardHeading(s.job), CANCELLED_HEADING);
    assert.notEqual(s.job?.status, "cancelled");
  });
});

describe("races with the status channel", () => {
  it("poll says cancelled first, then the cancel answer arrives: shown once, answer dropped", () => {
    const sent = requested(processing());
    const afterPoll = poll(sent, { type: "ended", job: cancelledJob() });
    assert.equal(afterPoll.phase, "error");
    assert.equal(afterPoll.cancel.kind, "idle");
    const late = answered(afterPoll, cancelledJob());
    assert.equal(late, afterPoll, "no second transition");
  });

  it("cancel answer first, then a stale in-flight poll (downloading): the poll is dropped", () => {
    const s = answered(requested(processing()), cancelledJob());
    const stale = poll(s, { type: "status", job: polledJob("downloading", { progress: 99 }) });
    assert.equal(stale, s);
  });

  it("ready beats a late cancel answer: a ready poll first, then the answer (even a forged cancelled one)", () => {
    const sent = requested(processing());
    const ready = poll(sent, { type: "ready", job: polledJob("ready") });
    assert.equal(ready.phase, "complete");
    assert.equal(answered(ready, cancelledJob()), ready, "a forged or late cancelled cannot overwrite ready");
    assert.equal(answered(ready, polledJob("ready")), ready);
  });

  it("a failure poll first, then the cancel answer: the failure stays", () => {
    const sent = requested(processing());
    const failedJob = polledJob("failed", { errorCode: "NETWORK_ERROR", stageLabel: "Download failed", error: ERROR_MESSAGES.NETWORK_ERROR });
    const ended = poll(sent, { type: "ended", job: failedJob });
    assert.equal(answered(ended, cancelledJob()), ended);
    assert.equal(ended.job?.status, "failed");
  });

  it("progress polls while the request is out keep updating the job and keep the request pending", () => {
    let s = requested(processing());
    s = poll(s, { type: "status", job: polledJob("uploading", { progress: 100, stageLabel: "Finalizing" }) });
    assert.equal(s.cancel.kind, "requesting");
    assert.equal(s.job?.status, "uploading");
    s = answered(s, cancelledJob());
    assert.equal(s.job?.status, "cancelled");
  });

  it("a cancellation while the channel is reconnecting is answered normally", () => {
    const s = answered(requested(poll(processing(), { type: "reconnecting" })), cancelledJob());
    assert.equal(s.phase, "error");
    assert.equal(s.connectivity, "connected");
  });

  it("a cancellation after the channel gave up, answered: the outcome is shown and the channel is no longer exhausted", () => {
    const s = answered(requested(poll(processing(), { type: "exhausted" })), cancelledJob());
    assert.equal(s.phase, "error");
    assert.equal(s.connectivity, "connected");
  });
});

describe("stale answers change nothing", () => {
  it("an older attempt's answer", () => {
    let s = requested(processing(), 1);
    s = failed(s, "unconfirmed", 1);
    s = requested(s, 2);
    assert.equal(answered(s, cancelledJob(), 1), s, "attempt 1 answered after attempt 2 started");
    assert.equal(failed(s, "refused", 1), s);
    assert.equal(answered(s, cancelledJob(), 2).phase, "error");
  });

  it("an answer after reset", () => {
    const s = reduce(requested(processing()), { type: "reset" });
    assert.equal(s.cancel.kind, "idle");
    assert.equal(answered(s, cancelledJob()), s);
    assert.equal(failed(s, "unconfirmed"), s);
  });

  it("an older job's answer after a new job started", () => {
    let s = requested(processing(JOB_ID), 1, JOB_ID);
    s = reduce(s, { type: "reset" }, { type: "analyze_started" }, { type: "analyze_succeeded" }, {
      type: "download_started",
      job: polledJob("queued", { jobId: OTHER_JOB_ID }),
    });
    const late = answered(s, cancelledJob(JOB_ID), 1, JOB_ID);
    assert.equal(late, s);
    assert.equal(late.job?.jobId, OTHER_JOB_ID);
    assert.equal(late.phase, "processing");
    assert.equal(late.cancel.kind, "idle");
  });

  it("an answer naming the new job but tagged with the old attempt", () => {
    let s = requested(processing(JOB_ID), 1, JOB_ID);
    s = reduce(s, { type: "reset" }, { type: "download_started", job: polledJob("queued", { jobId: OTHER_JOB_ID }) });
    s = requested(s, 2, OTHER_JOB_ID);
    assert.equal(answered(s, cancelledJob(OTHER_JOB_ID), 1, OTHER_JOB_ID), s);
  });
});

describe("a failed request leaves the job running on screen", () => {
  it("unconfirmed: no outcome, the job and its progress kept, nothing recorded", () => {
    const before = requested(processing());
    const s = failed(before, "unconfirmed");
    assert.equal(s.phase, "processing");
    assert.equal(s.job, before.job);
    assert.equal(s.cancel.kind, "unconfirmed");
    assert.equal(finishedJobForHistory(s), null);
    assert.equal(errorCardHeading(s.job), DEFAULT_ERROR_HEADING, "not an ending");
  });

  it("unconfirmed while connected: the existing polling session continues untouched", () => {
    const before = requested(processing());
    const s = failed(before, "unconfirmed");
    assert.equal(s.poll, before.poll);
    assert.equal(s.connectivity, "connected");
  });

  it("unconfirmed after the channel gave up: ONE reconnecting status session starts (a read, not a resend)", () => {
    const before = requested(poll(processing(), { type: "exhausted" }));
    assert.equal(statusPollTarget(before), null);
    const s = failed(before, "unconfirmed");
    assert.equal(s.connectivity, "reconnecting");
    assert.equal(s.poll.generation, before.poll.generation + 1);
    assert.equal(s.poll.initialDelayMs, 0);
    assert.deepEqual(statusPollTarget(s), { jobId: JOB_ID, session: s.poll });
    assert.equal(s.cancel.kind, "unconfirmed");
  });

  it("refused: the reason is shown, polling is untouched, and the person may try again", () => {
    const before = requested(poll(processing(), { type: "exhausted" }));
    const s = failed(before, "refused", 1, ERROR_MESSAGES.RATE_LIMITED);
    assert.deepEqual(s.cancel, { kind: "refused", jobId: JOB_ID, attempt: 1, message: ERROR_MESSAGES.RATE_LIMITED });
    assert.equal(s.connectivity, "retry_exhausted");
    assert.equal(s.poll, before.poll);
    assert.equal(canRequestCancel(s, JOB_ID), true);
  });

  it("logout during a cancellation: refused with the access reason, then the status channel ends the page", () => {
    let s = failed(requested(processing()), "refused", 1, ERROR_MESSAGES.ACCESS_REQUIRED);
    assert.equal(s.phase, "processing");
    s = poll(s, { type: "stopped", error: apiError("ACCESS_REQUIRED", 401) });
    assert.equal(s.phase, "error");
    assert.equal(s.error, ERROR_MESSAGES.ACCESS_REQUIRED);
    assert.equal(s.cancel.kind, "idle");
    assert.equal(finishedJobForHistory(s), null, "an access failure is not a job outcome");
  });
});

describe("classifying a failed cancellation", () => {
  const response = (code: ErrorCode | null, status: number) => apiError(code, status);

  it("unconfirmed: anything that does not say whether it happened", () => {
    for (const error of [
      networkFailure(),
      response("WORKER_UNAVAILABLE", 503),
      response("PROCESSING_FAILED", 500),
      response(null, 502),
      response(null, 504),
      response(null, 408),
      response(null, 200), // a 2xx that was not this job's status
      new TypeError("Failed to fetch"),
      new Error("anything"),
      "a thrown string",
    ]) {
      assert.equal(classifyCancelFailure(error), "unconfirmed", String((error as { status?: unknown }).status ?? error));
    }
  });

  it("refused: a definitive answer that it did not cancel", () => {
    for (const [code, status] of [
      ["NOT_FOUND", 404],
      ["EXPIRED", 410],
      ["ACCESS_REQUIRED", 401],
      ["FORBIDDEN", 403],
      ["RATE_LIMITED", 429],
      [null, 404], // an older control plane without the route
      [null, 405],
    ] as const) {
      assert.equal(classifyCancelFailure(response(code, status)), "refused", `${code} ${status}`);
    }
  });

  it("the refusal's message is canonical, never the response's own text", () => {
    const hostile = new ClientApiError({ kind: "response", code: "RATE_LIMITED", status: 429, message: "<b>raw</b> /var/lib" });
    assert.equal(cancelRefusalMessage(hostile), ERROR_MESSAGES.RATE_LIMITED);
    assert.equal(cancelRefusalMessage(response(null, 404)), CANCEL_UNAVAILABLE_MESSAGE);
    assert.equal(cancelRefusalMessage(new Error("x")), CANCEL_UNAVAILABLE_MESSAGE);
  });

  it("NEGATIVE CONTROL: Worker unavailability is never a job failure", () => {
    const s = failed(requested(processing()), classifyCancelFailure(response("WORKER_UNAVAILABLE", 503)));
    assert.equal(s.phase, "processing");
    assert.notEqual(s.job?.status, "failed");
    assert.equal(finishedJobForHistory(s), null);
  });
});

// ── The controller ──────────────────────────────────────────────────────────

type Pending = { jobId: string; signal: AbortSignal; resolve: (job: PolledJob) => void; reject: (e: unknown) => void };

function harness(initial: DownloaderState = processing()) {
  const clock = new FakeClock();
  let state = initial;
  const dispatched: DownloaderAction[] = [];
  const calls: Pending[] = [];
  const controller = createCancelController({
    getState: () => state,
    dispatch: (action) => {
      dispatched.push(action);
      state = downloaderReducer(state, action);
    },
    cancel: (jobId, signal) =>
      new Promise<PolledJob>((resolve, reject) => {
        calls.push({ jobId, signal, resolve, reject });
      }),
    clock,
  });
  return {
    clock,
    controller,
    calls,
    dispatched,
    get state() {
      return state;
    },
    set state(next: DownloaderState) {
      state = next;
    },
  };
}

describe("the cancel controller", () => {
  it("sends exactly one request for a double click", async () => {
    const h = harness();
    assert.equal(h.controller.request(JOB_ID), true);
    assert.equal(h.controller.request(JOB_ID), false, "the second click in the same tick");
    assert.equal(h.calls.length, 1);
    assert.equal(h.state.cancel.kind, "requesting");
    h.calls[0].resolve(cancelledJob());
    await h.clock.advance(0);
    assert.equal(h.state.phase, "error");
    assert.equal(h.controller.request(JOB_ID), false, "nothing more to cancel");
    assert.equal(h.calls.length, 1);
  });

  it("sends one request even when the page has not re-rendered between two clicks", () => {
    // React applies a dispatch on the next render, so the state the controller
    // reads can still say "nothing requested" at the second click.
    const stale = processing();
    const calls: string[] = [];
    const controller = createCancelController({
      getState: () => stale,
      dispatch: () => {},
      cancel: (jobId) => {
        calls.push(jobId);
        return new Promise<PolledJob>(() => {});
      },
      clock: new FakeClock(),
    });
    assert.equal(controller.request(JOB_ID), true);
    assert.equal(controller.request(JOB_ID), false);
    assert.equal(controller.request(JOB_ID), false);
    assert.deepEqual(calls, [JOB_ID]);
  });

  it("sends nothing for a job the page is not processing", () => {
    const h = harness(initialDownloaderState);
    assert.equal(h.controller.request(JOB_ID), false);
    const other = harness();
    assert.equal(other.controller.request(OTHER_JOB_ID), false);
    assert.equal(h.calls.length + other.calls.length, 0);
    assert.equal(h.dispatched.length + other.dispatched.length, 0);
  });

  it("does not resend after a lost answer; the person may send again", async () => {
    const h = harness();
    h.controller.request(JOB_ID);
    h.calls[0].reject(networkFailure());
    await h.clock.advance(60 * 60 * 1000);
    assert.equal(h.calls.length, 1, "never resent automatically");
    assert.equal(h.state.cancel.kind, "unconfirmed");
    assert.equal(h.controller.request(JOB_ID), true, "an explicit second click");
    assert.equal(h.calls.length, 2);
    assert.notEqual(
      (h.dispatched[h.dispatched.length - 1] as { attempt: number }).attempt,
      (h.dispatched[0] as { attempt: number }).attempt,
      "a new attempt id",
    );
  });

  it("a request that never answers is abandoned at the browser timeout as unconfirmed", async () => {
    const h = harness();
    h.controller.request(JOB_ID);
    const { signal } = h.calls[0];
    // The real client turns its own abort into a network failure.
    signal.addEventListener("abort", () => h.calls[0].reject(networkFailure()));
    await h.clock.advance(CANCEL_REQUEST_TIMEOUT_MS - 1);
    assert.equal(signal.aborted, false);
    assert.equal(h.state.cancel.kind, "requesting");
    await h.clock.advance(1);
    assert.equal(signal.aborted, true);
    assert.equal(h.state.cancel.kind, "unconfirmed");
    assert.ok(CANCEL_REQUEST_TIMEOUT_MS > 30_000, "longer than the control plane's own Worker budget");
  });

  it("a refusal is reported with its canonical reason", async () => {
    const h = harness();
    h.controller.request(JOB_ID);
    h.calls[0].reject(apiError("RATE_LIMITED", 429));
    await h.clock.advance(0);
    assert.deepEqual(h.state.cancel, { kind: "refused", jobId: JOB_ID, attempt: 1, message: ERROR_MESSAGES.RATE_LIMITED });
  });

  it("unmount: a pending answer is ignored and the request itself is NOT aborted", async () => {
    const h = harness();
    h.controller.request(JOB_ID);
    const before = h.dispatched.length;
    h.controller.dispose();
    h.calls[0].resolve(cancelledJob());
    await h.clock.advance(CANCEL_REQUEST_TIMEOUT_MS * 2);
    assert.equal(h.calls[0].signal.aborted, false, "a confirmed cancellation is allowed to arrive");
    assert.equal(h.dispatched.length, before, "nothing dispatched after unmount");
    assert.equal(h.controller.request(JOB_ID), false, "a disposed controller sends nothing");
    assert.equal(h.clock.pendingTimers(), 0, "no timer left behind");
  });

  it("an answer that arrives after the page moved on to another job changes nothing", async () => {
    const h = harness();
    h.controller.request(JOB_ID);
    h.state = reduce(h.state, { type: "reset" }, { type: "download_started", job: polledJob("queued", { jobId: OTHER_JOB_ID }) });
    const snapshot = h.state;
    h.calls[0].resolve(cancelledJob(JOB_ID));
    await h.clock.advance(0);
    assert.equal(h.state, snapshot);
    assert.equal(h.controller.request(OTHER_JOB_ID), true, "the new job can be cancelled");
  });

  it("a synchronous throw from the transport is a failure, not a crash", async () => {
    const clock = new FakeClock();
    let state = processing();
    const controller = createCancelController({
      getState: () => state,
      dispatch: (a) => {
        state = downloaderReducer(state, a);
      },
      cancel: () => {
        throw new TypeError("boom");
      },
      clock,
    });
    assert.equal(controller.request(JOB_ID), true);
    await clock.advance(0);
    assert.equal(state.cancel.kind, "unconfirmed");
  });
});

describe("after an ending: try again is a new job, chosen by the person", () => {
  it("cancelled or failed → back to the quality choice; nothing else changes", () => {
    for (const job of [
      cancelledJob(),
      polledJob("failed", { errorCode: "NETWORK_ERROR", stageLabel: "Download failed", error: "x" }),
    ]) {
      const ended = poll(processing(), { type: "ended", job });
      const s = reduce(ended, { type: "choose_again" });
      assert.equal(s.phase, "ready", job.status);
      assert.equal(s.job, null);
      assert.equal(s.error, null);
      assert.equal(statusPollTarget(s), null, "no status read for the old job");
    }
  });

  it("is refused for a running job, a finished file, an analysis error and a lost job", () => {
    const running = processing();
    assert.equal(reduce(running, { type: "choose_again" }), running);
    const complete = poll(processing(), { type: "ready", job: polledJob("ready") });
    assert.equal(reduce(complete, { type: "choose_again" }), complete);
    const analysis = reduce(initialDownloaderState, { type: "analyze_started" }, { type: "analyze_failed", message: "m" });
    assert.equal(reduce(analysis, { type: "choose_again" }), analysis);
    const lost = poll(processing(), { type: "stopped", error: apiError("NOT_FOUND", 404) });
    assert.equal(reduce(lost, { type: "choose_again" }), lost);
  });

  it("the offered action is worded by the outcome, and says a new download starts from the beginning", () => {
    const retry = (job: Parameters<typeof jobOutcomeRetry>[0]) => jobOutcomeRetry(job);
    assert.deepEqual(retry(cancelledJob()), { label: TRY_AGAIN_LABEL, hint: FRESH_START_HINT });
    assert.deepEqual(
      retry(polledJob("failed", { errorCode: "TIMEOUT", stageLabel: "Download time limit reached" })),
      { label: CHOOSE_ANOTHER_QUALITY_LABEL, hint: FRESH_START_HINT },
    );
    assert.equal(retry(polledJob("failed", { errorCode: "TOO_LARGE", stageLabel: "Download failed" }))?.label, CHOOSE_ANOTHER_QUALITY_LABEL);
    for (const stageLabel of ["Download stalled", "Download failed", "Upload failed", "Worker restarted"]) {
      assert.equal(retry(polledJob("failed", { errorCode: "TIMEOUT", stageLabel }))?.label, TRY_AGAIN_LABEL, stageLabel);
    }
    assert.equal(retry(polledJob("downloading")), null, "a running job has no outcome");
    assert.equal(retry(polledJob("ready")), null);
    assert.equal(retry(null), null);
    assert.equal(/resum|continue|pick up/i.test(FRESH_START_HINT), false, "no resume is claimed");
    assert.match(FRESH_START_HINT, /from the beginning/);
  });

  it("retry status remains a status-only action, distinct from cancel and from try again", () => {
    const exhausted = poll(processing(), { type: "exhausted" });
    const retried = reduce(exhausted, { type: "retry_status" });
    assert.equal(retried.phase, "processing");
    assert.equal(retried.job?.jobId, JOB_ID, "the same job");
    assert.equal(retried.cancel.kind, "idle", "no cancellation");
    assert.equal(reduce(exhausted, { type: "choose_again" }), exhausted, "try again is not available while running");
  });
});

describe("the confirmation copy", () => {
  it("says what is lost and that nothing resumes", () => {
    assert.equal(
      cancelConfirmDescription(1_331_691_520),
      "VideoFetch will stop this download and discard the 1.2 GB received so far. Downloading this video again starts from the beginning.",
    );
    for (const unknown of [null, 0]) {
      assert.equal(
        cancelConfirmDescription(unknown),
        "VideoFetch will stop this download and discard anything received so far. Downloading this video again starts from the beginning.",
      );
    }
  });
});
