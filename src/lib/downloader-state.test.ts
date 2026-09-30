import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_MESSAGES } from "./errors.ts";
import { DEFAULT_ERROR_HEADING, errorCardHeading } from "./job-failure-ui.ts";
import type { JobStatusPollEvent } from "./job-status-poller.ts";
import {
  downloaderReducer,
  finishedJobForHistory,
  historyEntryForJob,
  initialDownloaderState,
  statusPollTarget,
  type DownloaderAction,
  type DownloaderState,
} from "./downloader-state.ts";
import { JOB_ID, OTHER_JOB_ID, apiError, polledJob } from "./job-status-poll.fixtures.ts";

/**
 * BROWSER-JOB-STATUS-POLL-RESILIENCE-001: the downloader's transitions. A lost
 * status connection is never a job outcome, and a result that no longer
 * belongs to the page changes nothing.
 */

function reduce(state: DownloaderState, ...actions: DownloaderAction[]): DownloaderState {
  return actions.reduce(downloaderReducer, state);
}

function processing(jobId = JOB_ID): DownloaderState {
  return reduce(
    initialDownloaderState,
    { type: "analyze_started" },
    { type: "analyze_succeeded" },
    { type: "download_requested" },
    { type: "download_started", job: polledJob("queued", { jobId, progress: null, stageLabel: "Queued" }) },
  );
}

function poll(state: DownloaderState, event: JobStatusPollEvent, jobId = JOB_ID): DownloaderState {
  return downloaderReducer(state, {
    type: "status_poll",
    jobId,
    generation: state.poll.generation,
    event,
  });
}

describe("ordinary flow is unchanged", () => {
  it("analyze → ready → processing → complete", () => {
    let s = reduce(initialDownloaderState, { type: "analyze_started" });
    assert.equal(s.phase, "analyzing");
    s = reduce(s, { type: "analyze_succeeded" });
    assert.equal(s.phase, "ready");
    s = reduce(s, { type: "download_started", job: polledJob("queued") });
    assert.equal(s.phase, "processing");
    assert.equal(s.connectivity, "connected");
    s = poll(s, { type: "status", job: polledJob("downloading", { progress: 42 }) });
    assert.equal(s.job?.progress, 42);
    s = poll(s, { type: "ready", job: polledJob("ready") });
    assert.equal(s.phase, "complete");
    assert.equal(s.job?.downloadUrl, `/api/download/${JOB_ID}/file`);
  });

  it("an analysis failure is an error with its message; a create failure keeps `ready`", () => {
    const failed = reduce(initialDownloaderState, { type: "analyze_started" }, { type: "analyze_failed", message: "m" });
    assert.equal(failed.phase, "error");
    assert.equal(failed.error, "m");
    const create = reduce(
      initialDownloaderState,
      { type: "analyze_started" },
      { type: "analyze_succeeded" },
      { type: "download_failed", message: "c" },
    );
    assert.equal(create.phase, "ready");
    assert.equal(create.error, "c");
  });

  it("reset returns to idle and drops the job", () => {
    const s = reduce(processing(), { type: "reset" });
    assert.equal(s.phase, "idle");
    assert.equal(s.job, null);
    assert.equal(s.error, null);
    assert.equal(statusPollTarget(s), null);
  });
});

describe("a transient status failure is not a job outcome", () => {
  it("reconnecting keeps processing, the job id and the last known job", () => {
    const before = poll(processing(), { type: "status", job: polledJob("downloading", { progress: 61 }) });
    const s = poll(before, { type: "reconnecting" });
    assert.equal(s.phase, "processing");
    assert.equal(s.connectivity, "reconnecting");
    assert.equal(s.error, null);
    assert.equal(s.job, before.job, "the last known job — progress, title, thumbnail, preset — is kept as is");
    assert.equal(s.job?.jobId, JOB_ID);
    assert.equal(s.job?.progress, 61);
    assert.equal(finishedJobForHistory(s), null);
  });

  it("does not restart polling while reconnecting or on progress", () => {
    const s0 = processing();
    const target0 = statusPollTarget(s0)!;
    const s1 = poll(s0, { type: "reconnecting" });
    const s2 = poll(s1, { type: "status", job: polledJob("processing") });
    assert.equal(statusPollTarget(s1)?.session, target0.session);
    assert.equal(statusPollTarget(s2)?.session, target0.session);
  });

  it("recovers: reconnecting → status clears the indicator → ready completes", () => {
    let s = poll(processing(), { type: "reconnecting" });
    s = poll(s, { type: "status", job: polledJob("processing") });
    assert.equal(s.connectivity, "connected");
    s = poll(s, { type: "reconnecting" });
    s = poll(s, { type: "ready", job: polledJob("ready") });
    assert.equal(s.phase, "complete");
    assert.equal(s.connectivity, "connected");
    assert.equal(s.error, null);
    assert.equal(finishedJobForHistory(s)?.status, "ready");
  });
});

describe("retry exhaustion keeps the job and offers Retry status", () => {
  it("keeps processing and the job, stops polling, records nothing", () => {
    const before = poll(processing(), { type: "status", job: polledJob("downloading", { progress: 30 }) });
    const s = poll(poll(before, { type: "reconnecting" }), { type: "exhausted" });
    assert.equal(s.phase, "processing");
    assert.equal(s.connectivity, "retry_exhausted");
    assert.equal(s.job?.jobId, JOB_ID);
    assert.equal(s.job?.progress, 30);
    assert.equal(s.error, null);
    assert.equal(statusPollTarget(s), null, "the loop has given up");
    assert.equal(finishedJobForHistory(s), null, "no failed entry in history");
  });

  it("Retry status resumes the SAME job in a new session, immediately", () => {
    const exhausted = poll(processing(), { type: "exhausted" });
    const s = reduce(exhausted, { type: "retry_status" });
    assert.equal(s.phase, "processing");
    assert.equal(s.connectivity, "reconnecting");
    const target = statusPollTarget(s)!;
    assert.equal(target.jobId, JOB_ID);
    assert.equal(target.session.generation, exhausted.poll.generation + 1);
    assert.equal(target.session.initialDelayMs, 0);
  });

  it("a second Retry status is ignored, so there is never a second loop", () => {
    const once = reduce(poll(processing(), { type: "exhausted" }), { type: "retry_status" });
    const twice = reduce(once, { type: "retry_status" });
    assert.equal(twice, once);
  });

  it("Retry status does nothing unless polling has given up", () => {
    for (const s of [initialDownloaderState, processing(), poll(processing(), { type: "reconnecting" })]) {
      assert.equal(reduce(s, { type: "retry_status" }), s);
    }
  });
});

describe("terminal job outcomes (PR #101) are unchanged", () => {
  it("failed: error phase, canonical message, closed stage heading, history", () => {
    const failedJob = polledJob("failed", {
      errorCode: "PROCESSING_FAILED",
      error: ERROR_MESSAGES.PROCESSING_FAILED,
      stageLabel: "Processing failed",
    });
    const s = poll(poll(processing(), { type: "reconnecting" }), { type: "ended", job: failedJob });
    assert.equal(s.phase, "error");
    assert.equal(s.error, ERROR_MESSAGES.PROCESSING_FAILED);
    assert.equal(s.connectivity, "connected");
    assert.equal(errorCardHeading(s.job), "Processing failed");
    assert.equal(finishedJobForHistory(s)?.status, "failed");
  });

  it("cancelled: error phase with the cancellation message, history", () => {
    const s = poll(processing(), { type: "ended", job: polledJob("cancelled") });
    assert.equal(s.phase, "error");
    assert.equal(s.error, "This download was cancelled.");
    assert.equal(finishedJobForHistory(s)?.status, "cancelled");
  });
});

describe("definitive status answers stop with canonical copy and no history", () => {
  for (const [code, status] of [
    ["NOT_FOUND", 404],
    ["EXPIRED", 410],
    ["ACCESS_REQUIRED", 401],
    ["ACCESS_NOT_CONFIGURED", 503],
    ["FORBIDDEN", 403],
  ] as const) {
    it(code, () => {
      const before = poll(processing(), { type: "status", job: polledJob("downloading") });
      const s = poll(before, { type: "stopped", error: apiError(code, status) });
      assert.equal(s.phase, "error");
      assert.equal(s.error, ERROR_MESSAGES[code]);
      assert.equal(errorCardHeading(s.job), DEFAULT_ERROR_HEADING, "not a job failure heading");
      assert.equal(finishedJobForHistory(s), null, "a lost job is not recorded as failed");
    });
  }
});

describe("stale results change nothing", () => {
  it("after reset", () => {
    const s = reduce(processing(), { type: "reset" });
    for (const event of [
      { type: "ready", job: polledJob("ready") },
      { type: "status", job: polledJob("downloading") },
      { type: "reconnecting" },
      { type: "exhausted" },
      { type: "stopped", error: apiError("NOT_FOUND", 404) },
    ] as JobStatusPollEvent[]) {
      assert.equal(poll(s, event), s);
    }
  });

  it("after a new job replaced the old one", () => {
    const old = processing(JOB_ID);
    const oldGeneration = old.poll.generation;
    const next = reduce(old, { type: "reset" }, { type: "analyze_started" }, { type: "analyze_succeeded" }, {
      type: "download_started",
      job: polledJob("queued", { jobId: OTHER_JOB_ID }),
    });
    const late = downloaderReducer(next, {
      type: "status_poll",
      jobId: JOB_ID,
      generation: oldGeneration,
      event: { type: "ready", job: polledJob("ready") },
    });
    assert.equal(late, next);
    assert.equal(late.job?.jobId, OTHER_JOB_ID);
  });

  it("from a session a manual retry superseded", () => {
    const exhausted = poll(processing(), { type: "exhausted" });
    const retried = reduce(exhausted, { type: "retry_status" });
    const late = downloaderReducer(retried, {
      type: "status_poll",
      jobId: JOB_ID,
      generation: exhausted.poll.generation,
      event: { type: "stopped", error: apiError("NOT_FOUND", 404) },
    });
    assert.equal(late, retried);
  });

  it("once the job reached a terminal phase", () => {
    const done = poll(processing(), { type: "ready", job: polledJob("ready") });
    assert.equal(poll(done, { type: "reconnecting" }), done);
    assert.equal(poll(done, { type: "exhausted" }), done);
  });
});

describe("history entries", () => {
  it("carry the job's own metadata with the analyzed video as the fallback", () => {
    const job = polledJob("ready", { title: null, thumbnail: null });
    assert.deepEqual(historyEntryForJob(job, { title: "Analyzed", thumbnail: "t.jpg" }, 7), {
      jobId: JOB_ID,
      title: "Analyzed",
      thumbnail: "t.jpg",
      status: "ready",
      format: "mp4",
      quality: "1080",
      completedAt: 7,
    });
  });
});
