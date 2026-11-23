import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WorkerJobStatusSuccessSchema,
  WorkerJobViewSchema,
  type WorkerJobStatus,
} from "./contracts.ts";
import {
  WORKER_JOB_ACTIVITY_IDLE_STATES,
  WORKER_JOB_ACTIVITY_MAX_SECONDS,
  WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS,
  WORKER_JOB_ACTIVITY_STATES,
  WorkerJobActivitySchema,
  jobActivityConsistencyIssues,
} from "./job-activity.ts";
import { DOWNLOAD_TIME_LIMIT_SECONDS } from "../../worker/runtime/time-limits.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the public
 * activity contract between the Worker and the control plane — a closed state,
 * three bounded counts, strict, and optional on the job view so an older Worker
 * still validates.
 */

const JOB_ID = "0123456789abcdef0123456789abcdef";
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/aaaabbbbccccddddeeeeffff00001111`;

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: JOB_ID,
    status: "downloading",
    progress: null,
    stageLabel: "Downloading",
    downloadedBytes: 70_000,
    totalBytes: null,
    speed: null,
    eta: null,
    errorCode: null,
    safeErrorMessage: null,
    filename: null,
    fileSize: null,
    mime: null,
    quality: null,
    container: null,
    title: "Clip",
    thumbnail: null,
    source: "cdn.example",
    extractor: "direct",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    expiresAt: 1_700_005_445_000,
    objectKey: null,
    ...overrides,
  };
}

/** One valid activity per state: `idleSeconds` exactly where a live part is observable. */
const VALID: Record<(typeof WORKER_JOB_ACTIVITY_STATES)[number], Record<string, unknown>> = {
  starting: { state: "starting", elapsedSeconds: 0, limitSeconds: 600, idleSeconds: null },
  "awaiting-first-byte": { state: "awaiting-first-byte", elapsedSeconds: 3, limitSeconds: 600, idleSeconds: 3 },
  receiving: { state: "receiving", elapsedSeconds: 40, limitSeconds: 600, idleSeconds: 0 },
  waiting: { state: "waiting", elapsedSeconds: 70, limitSeconds: 600, idleSeconds: 25 },
  "between-resources": { state: "between-resources", elapsedSeconds: 41, limitSeconds: 600, idleSeconds: 1 },
  "between-phases": { state: "between-phases", elapsedSeconds: 90, limitSeconds: 600, idleSeconds: null },
  unobserved: { state: "unobserved", elapsedSeconds: 120, limitSeconds: 600, idleSeconds: null },
};

const rejects = (value: unknown, expected?: RegExp) => {
  const parsed = WorkerJobActivitySchema.safeParse(value);
  assert.equal(parsed.success, false, JSON.stringify(value));
  if (expected && !parsed.success) {
    assert.ok(
      parsed.error.issues.some((issue) => expected.test(issue.message) || expected.test(issue.path.join("."))),
      `${JSON.stringify(value)} → ${JSON.stringify(parsed.error.issues.map((i) => i.message))}`,
    );
  }
};

describe("the public activity vocabulary is closed and small", () => {
  it("has exactly seven states, and four of them carry idle time", () => {
    assert.deepEqual([...WORKER_JOB_ACTIVITY_STATES], [
      "starting",
      "awaiting-first-byte",
      "receiving",
      "waiting",
      "between-resources",
      "between-phases",
      "unobserved",
    ]);
    assert.deepEqual([...WORKER_JOB_ACTIVITY_IDLE_STATES].sort(), [
      "awaiting-first-byte",
      "between-resources",
      "receiving",
      "waiting",
    ]);
  });

  it("accepts every state in its valid form", () => {
    for (const [state, activity] of Object.entries(VALID)) {
      assert.deepEqual(WorkerJobActivitySchema.parse(activity), activity, state);
    }
  });

  it("accepts an acquisition whose deadline is not armed yet: both counts null", () => {
    WorkerJobActivitySchema.parse({ state: "starting", elapsedSeconds: null, limitSeconds: null, idleSeconds: null });
    WorkerJobActivitySchema.parse({ state: "awaiting-first-byte", elapsedSeconds: null, limitSeconds: null, idleSeconds: 2 });
  });

  it("refuses every state it does not enumerate — internal names, stall words and free text included", () => {
    for (const state of [
      "not-started",
      "not-advancing",
      "retry-discarded",
      "deadline-exceeded",
      "completed",
      "cancelled",
      "failed",
      "stalled",
      "stall",
      "Receiving",
      "receiving ",
      "",
      "https://cdn.example/SECRET-PATH/video.mp4",
      "<script>alert(1)</script>",
    ]) {
      rejects({ ...VALID.receiving, state });
    }
  });

  it("refuses any field it does not enumerate", () => {
    for (const extra of [
      { phase: "video" },
      { observedBytes: 70_000 },
      { url: "https://cdn.example/SECRET-PATH/video.mp4" },
      { objectKey: OBJECT_KEY },
      { message: "Waiting for the source" },
      { windowMs: 120_000 },
      { deadlineAtMs: 1 },
    ]) {
      rejects({ ...VALID.receiving, ...extra });
    }
  });

  it("refuses a missing field: absence is spelled null", () => {
    for (const key of ["state", "elapsedSeconds", "limitSeconds", "idleSeconds"]) {
      const activity: Record<string, unknown> = { ...VALID.waiting };
      delete activity[key];
      rejects(activity);
    }
  });

  it("refuses negative, fractional, oversized, non-finite and textual numbers", () => {
    for (const key of ["elapsedSeconds", "limitSeconds", "idleSeconds"] as const) {
      for (const bad of [-1, 1.5, WORKER_JOB_ACTIVITY_MAX_SECONDS + 1, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Infinity, "5", true, {}]) {
        rejects({ ...VALID.waiting, [key]: bad }, new RegExp(key));
      }
    }
    rejects({ ...VALID.waiting, limitSeconds: 0 }, /limitSeconds/);
  });

  it("refuses inconsistent combinations, each for its own reason", () => {
    rejects({ ...VALID.receiving, limitSeconds: null }, /armed together/);
    rejects({ ...VALID.receiving, elapsedSeconds: null }, /armed together/);
    rejects({ ...VALID.waiting, elapsedSeconds: 601, limitSeconds: 600 }, /past its limit/);
    rejects({ ...VALID.starting, idleSeconds: 0 }, /live, observable part/);
    rejects({ ...VALID["between-phases"], idleSeconds: 3 }, /live, observable part/);
    rejects({ ...VALID.unobserved, idleSeconds: 30 }, /live, observable part/);
    rejects({ ...VALID.receiving, idleSeconds: null }, /live, observable part/);
    rejects({ ...VALID["awaiting-first-byte"], idleSeconds: null }, /live, observable part/);
    rejects(
      { ...VALID.receiving, idleSeconds: WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS + 1 },
      /recent advance/,
    );
    rejects({ ...VALID.waiting, idleSeconds: WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS }, /no recent advance/);
  });

  it("states the receiving/waiting boundary exactly", () => {
    const max = WORKER_JOB_ACTIVITY_RECEIVING_MAX_IDLE_SECONDS;
    assert.equal(max, 4);
    assert.deepEqual(jobActivityConsistencyIssues({ state: "receiving", elapsedSeconds: 9, limitSeconds: 600, idleSeconds: max }), []);
    assert.deepEqual(jobActivityConsistencyIssues({ state: "waiting", elapsedSeconds: 9, limitSeconds: 600, idleSeconds: max + 1 }), []);
  });

  it("is bounded above every acquisition limit the strict Worker loader accepts", () => {
    assert.ok(WORKER_JOB_ACTIVITY_MAX_SECONDS >= DOWNLOAD_TIME_LIMIT_SECONDS.max);
    WorkerJobActivitySchema.parse({
      state: "receiving",
      elapsedSeconds: DOWNLOAD_TIME_LIMIT_SECONDS.max - 1,
      limitSeconds: DOWNLOAD_TIME_LIMIT_SECONDS.max,
      idleSeconds: 0,
    });
  });
});

describe("the job view carries it optionally — an older Worker still validates", () => {
  it("a view WITHOUT the field (every Worker before LD-4b) parses, and stays without it", () => {
    const parsed = WorkerJobViewSchema.parse(view());
    assert.equal("activity" in parsed, false);
    const body = WorkerJobStatusSuccessSchema.parse({ success: true, job: view({ status: "queued", downloadedBytes: null }) });
    assert.equal("activity" in body.job, false);
  });

  it("a view with `activity: null` parses for every status", () => {
    const statuses: WorkerJobStatus[] = ["queued", "analyzing", "downloading", "processing", "uploading", "failed", "cancelled"];
    for (const status of statuses) {
      assert.equal(WorkerJobViewSchema.parse(view({ status, activity: null })).activity, null, status);
    }
    const ready = WorkerJobViewSchema.parse(view({ status: "ready", objectKey: OBJECT_KEY, activity: null }));
    assert.equal(ready.activity, null);
  });

  it("a downloading view with each valid activity parses unchanged", () => {
    for (const activity of Object.values(VALID)) {
      assert.deepEqual(WorkerJobViewSchema.parse(view({ activity })).activity, activity);
    }
  });

  it("a live activity on any status other than downloading is refused", () => {
    for (const status of ["queued", "analyzing", "processing", "uploading", "failed", "cancelled"] as const) {
      const parsed = WorkerJobViewSchema.safeParse(view({ status, activity: VALID.receiving }));
      assert.equal(parsed.success, false, status);
      assert.ok(!parsed.success && parsed.error.issues.some((i) => /only while the job is downloading/.test(i.message)));
    }
    const ready = WorkerJobViewSchema.safeParse(view({ status: "ready", objectKey: OBJECT_KEY, activity: VALID.receiving }));
    assert.equal(ready.success, false);
  });

  it("a malformed activity makes the whole status invalid: it is never partially trusted", () => {
    for (const activity of [
      { state: "stalled", elapsedSeconds: 1, limitSeconds: 600, idleSeconds: 200 },
      { ...VALID.receiving, url: "https://cdn.example/SECRET-PATH/video.mp4" },
      { ...VALID.receiving, idleSeconds: -1 },
      "receiving",
      7,
      [],
    ]) {
      const parsed = WorkerJobStatusSuccessSchema.safeParse({ success: true, job: view({ activity }) });
      assert.equal(parsed.success, false, JSON.stringify(activity));
    }
  });

  it("an unknown top-level field is still refused: strictness is unchanged", () => {
    assert.equal(WorkerJobViewSchema.safeParse(view({ activityLabel: "Receiving" })).success, false);
    assert.equal(WorkerJobViewSchema.safeParse(view({ activityV2: VALID.receiving })).success, false);
  });
});
