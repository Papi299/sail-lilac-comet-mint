import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RESTORE_UNAVAILABLE_NOTICE,
  canRequestCancel,
  downloaderReducer,
  initialDownloaderState,
  statusPollTarget,
  type DownloaderAction,
  type DownloaderState,
} from "./downloader-state.ts";
import { ERROR_MESSAGES } from "./errors.ts";
import { JOB_ID, OTHER_JOB_ID, apiError, networkFailure, polledJob } from "./job-status-poll.fixtures.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the
 * reducer's `restoring` phase and its storage directive, transition by
 * transition.
 */

const run = (...actions: DownloaderAction[]): DownloaderState =>
  actions.reduce((state, action) => downloaderReducer(state, action), initialDownloaderState);

const restore = (jobId = JOB_ID): DownloaderAction => ({ type: "restore_started", jobId });

function pollEvent(state: DownloaderState, event: Extract<DownloaderAction, { type: "status_poll" }>["event"], jobId = JOB_ID) {
  return downloaderReducer(state, { type: "status_poll", jobId, generation: state.poll.generation, event });
}

describe("restore_started", () => {
  it("from a fresh page: restoring that id, one immediate read, the id kept", () => {
    const state = run(restore());
    assert.equal(state.phase, "restoring");
    assert.equal(state.restoringJobId, JOB_ID);
    assert.equal(state.job, null, "nothing is shown before the Worker answers");
    assert.deepEqual(state.poll, { generation: 1, initialDelayMs: 0 });
    assert.deepEqual(state.stored, { kind: "job", jobId: JOB_ID });
    assert.deepEqual(statusPollTarget(state), { jobId: JOB_ID, session: state.poll });
  });

  it("again for the same id changes nothing — the same state object, the same session", () => {
    const once = run(restore());
    assert.equal(downloaderReducer(once, restore()), once);
  });

  it("is refused on any page that is not fresh and empty", () => {
    const busy: DownloaderState[] = [
      run({ type: "analyze_started" }),
      run({ type: "analyze_started" }, { type: "analyze_succeeded" }),
      run({ type: "download_started", job: polledJob("queued") }),
      run(restore(), { type: "restore_started", jobId: OTHER_JOB_ID }),
    ];
    for (const state of busy) assert.equal(downloaderReducer(state, restore(OTHER_JOB_ID)), state, state.phase);
  });

  it("a restoring page cannot cancel (no job is known yet) and ignores an analysis", () => {
    const state = run(restore());
    assert.equal(canRequestCancel(state, JOB_ID), false);
    assert.equal(downloaderReducer(state, { type: "analyze_started" }), state);
  });
});

describe("the restored job's first answers", () => {
  it("an active status shows the job as processing; polling continues on the same session", () => {
    const restoring = run(restore());
    const state = pollEvent(restoring, { type: "status", job: polledJob("downloading") });
    assert.equal(state.phase, "processing");
    assert.equal(state.restoringJobId, null);
    assert.equal(state.job?.jobId, JOB_ID);
    assert.equal(state.poll, restoring.poll);
    assert.equal(canRequestCancel(state, JOB_ID), true, "and its Cancel works");
  });

  it("ready, failed and cancelled show the outcome", () => {
    assert.equal(pollEvent(run(restore()), { type: "ready", job: polledJob("ready") }).phase, "complete");
    const failed = pollEvent(run(restore()), { type: "ended", job: polledJob("failed", { error: "Boom." }) });
    assert.equal(failed.phase, "error");
    assert.equal(failed.error, "Boom.");
    const cancelled = pollEvent(run(restore()), { type: "ended", job: polledJob("cancelled") });
    assert.equal(cancelled.phase, "error");
    assert.equal(cancelled.job?.status, "cancelled");
  });

  it("reconnecting and exhausted keep restoring; Retry status resumes the same id", () => {
    let state = pollEvent(run(restore()), { type: "reconnecting" });
    assert.equal(state.phase, "restoring");
    assert.equal(state.connectivity, "reconnecting");
    state = pollEvent(state, { type: "exhausted" });
    assert.equal(state.connectivity, "retry_exhausted");
    assert.equal(statusPollTarget(state), null);
    const resumed = downloaderReducer(state, { type: "retry_status" });
    assert.equal(resumed.connectivity, "reconnecting");
    assert.deepEqual(statusPollTarget(resumed), { jobId: JOB_ID, session: { generation: 2, initialDelayMs: 0 } });
    assert.deepEqual(resumed.stored, { kind: "job", jobId: JOB_ID }, "an unreachable Worker never discards the id");
  });

  it("NOT_FOUND and EXPIRED: back to an empty page with a note, and the id forgotten", () => {
    for (const code of ["NOT_FOUND", "EXPIRED"] as const) {
      const state = pollEvent(run(restore()), { type: "stopped", error: apiError(code, code === "NOT_FOUND" ? 404 : 410) });
      assert.equal(state.phase, "idle", code);
      assert.equal(state.notice, RESTORE_UNAVAILABLE_NOTICE);
      assert.deepEqual(state.stored, { kind: "clear" });
      assert.equal(state.error, null);
    }
  });

  it("an access refusal is shown as an error, and the id is left to the access lifecycle", () => {
    const state = pollEvent(run(restore()), { type: "stopped", error: apiError("ACCESS_REQUIRED", 401) });
    assert.equal(state.phase, "error");
    assert.equal(state.error, ERROR_MESSAGES.ACCESS_REQUIRED);
    assert.deepEqual(state.stored, { kind: "job", jobId: JOB_ID });
  });

  it("answers for another id, or from an older session, change nothing", () => {
    const state = run(restore());
    assert.equal(pollEvent(state, { type: "status", job: polledJob("downloading") }, OTHER_JOB_ID), state);
    const stale = downloaderReducer(state, {
      type: "status_poll",
      jobId: JOB_ID,
      generation: state.poll.generation - 1,
      event: { type: "status", job: polledJob("downloading") },
    });
    assert.equal(stale, state);
  });
});

describe("the storage directive, transition by transition", () => {
  it("starts as keep, so a reload can read what the previous page stored", () => {
    assert.deepEqual(initialDownloaderState.stored, { kind: "keep" });
  });

  it("a new job is remembered; Start over, a new analysis and Try again forget it", () => {
    const started = run({ type: "download_started", job: polledJob("queued") });
    assert.deepEqual(started.stored, { kind: "job", jobId: JOB_ID });
    assert.deepEqual(downloaderReducer(started, { type: "reset" }).stored, { kind: "clear" });
    assert.deepEqual(downloaderReducer(started, { type: "analyze_started" }).stored, { kind: "clear" });
    const ended = pollEvent(started, { type: "ended", job: polledJob("failed") });
    assert.deepEqual(ended.stored, { kind: "job", jobId: JOB_ID }, "an ended job is still this page's job");
    assert.deepEqual(downloaderReducer(ended, { type: "choose_again" }).stored, { kind: "clear" });
  });

  it("a running job that turns out to be gone is forgotten; a transient failure keeps it", () => {
    const running = run({ type: "download_started", job: polledJob("downloading") });
    assert.deepEqual(pollEvent(running, { type: "stopped", error: apiError("EXPIRED", 410) }).stored, { kind: "clear" });
    assert.deepEqual(pollEvent(running, { type: "reconnecting" }).stored, { kind: "job", jobId: JOB_ID });
    assert.equal(networkFailure().kind, "network");
  });
});
