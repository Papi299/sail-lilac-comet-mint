import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerJobViewSchema, type WorkerJobView } from "../../shared/worker/contracts.ts";
import { WORKER_JOB_ACTIVITY_STATES } from "../../shared/worker/job-activity.ts";
import { PublicJobActivitySchema, PublicJobSchema, toPublicJob } from "./public-job.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the control
 * plane's half of the activity contract — what reaches the browser, field by
 * field, from an older Worker (no field), a newer one (`null` or an activity),
 * and never from a status that is not downloading.
 */

const JOB_ID = "0123456789abcdef0123456789abcdef";
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/aaaabbbbccccddddeeeeffff00001111`;
const NOW = 1_700_000_000_000;
const RECEIVING = { state: "receiving", elapsedSeconds: 42, limitSeconds: 600, idleSeconds: 1 } as const;

function worker(overrides: Record<string, unknown> = {}): WorkerJobView {
  return WorkerJobViewSchema.parse({
    jobId: JOB_ID,
    status: "downloading",
    progress: 12.5,
    stageLabel: "Downloading",
    downloadedBytes: 70_000,
    totalBytes: 560_000,
    speed: 35_000,
    eta: 14,
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
    createdAt: NOW - 60_000,
    updatedAt: NOW - 500,
    expiresAt: NOW + 5_000_000,
    objectKey: null,
    ...overrides,
  });
}

describe("toPublicJob: the activity the browser receives", () => {
  it("an older Worker's status (no field) gives `activity: null`, and everything else unchanged", () => {
    const legacy = worker();
    assert.equal("activity" in legacy, false);
    const dto = toPublicJob(legacy, NOW);
    assert.equal(dto.activity, null);
    assert.equal(dto.progress, 12.5);
    assert.equal(dto.downloadedBytes, 70_000);
    assert.equal(dto.stageLabel, "Downloading");
  });

  it("a Worker's `null` stays null", () => {
    assert.equal(toPublicJob(worker({ activity: null }), NOW).activity, null);
  });

  it("a published activity is copied field by field, for every state", () => {
    const samples = {
      starting: { state: "starting", elapsedSeconds: null, limitSeconds: null, idleSeconds: null },
      "awaiting-first-byte": { state: "awaiting-first-byte", elapsedSeconds: 2, limitSeconds: 600, idleSeconds: 2 },
      receiving: RECEIVING,
      waiting: { state: "waiting", elapsedSeconds: 80, limitSeconds: 600, idleSeconds: 21 },
      "between-resources": { state: "between-resources", elapsedSeconds: 50, limitSeconds: 600, idleSeconds: 0 },
      "between-phases": { state: "between-phases", elapsedSeconds: 300, limitSeconds: 600, idleSeconds: null },
      unobserved: { state: "unobserved", elapsedSeconds: 31, limitSeconds: 600, idleSeconds: null },
    } as const;
    assert.deepEqual(Object.keys(samples).sort(), [...WORKER_JOB_ACTIVITY_STATES].sort());
    for (const activity of Object.values(samples)) {
      const dto = toPublicJob(worker({ activity }), NOW);
      assert.deepEqual(dto.activity, activity);
      assert.deepEqual(Object.keys(dto.activity!).sort(), ["elapsedSeconds", "idleSeconds", "limitSeconds", "state"]);
    }
  });

  it("a status that is not downloading never carries an activity, whatever the Worker could send", () => {
    for (const status of ["queued", "analyzing", "processing", "uploading", "failed", "cancelled"] as const) {
      const dto = toPublicJob(worker({ status, activity: null }), NOW);
      assert.equal(dto.activity, null, status);
    }
    const ready = toPublicJob(worker({ status: "ready", objectKey: OBJECT_KEY, activity: null }), NOW);
    assert.equal(ready.activity, null);
  });

  it("the browser response holds no object key and no internal vocabulary", () => {
    const body = JSON.stringify(toPublicJob(worker({ activity: RECEIVING }), NOW));
    for (const needle of [
      "objectKey",
      "videofetch/jobs",
      "not-advancing",
      "retry-discarded",
      "deadline",
      "anchor",
      "observedBytes",
      "windowMs",
      "phase\"",
    ]) {
      assert.equal(body.includes(needle), false, needle);
    }
  });
});

describe("PublicJobSchema: the browser DTO stays strict", () => {
  const dto = () => ({ ...toPublicJob(worker({ activity: RECEIVING }), NOW) }) as Record<string, unknown>;

  it("requires the field (null when absent) and refuses its removal", () => {
    const value = dto();
    delete value.activity;
    assert.equal(PublicJobSchema.safeParse(value).success, false);
  });

  it("refuses an activity on a DTO that is not downloading", () => {
    const parsed = PublicJobSchema.safeParse({ ...dto(), status: "processing" });
    assert.equal(parsed.success, false);
    assert.ok(!parsed.success && parsed.error.issues.some((i) => /only while the job is downloading/.test(i.message)));
  });

  it("enumerates the activity's four fields and nothing else", () => {
    assert.equal(PublicJobActivitySchema.safeParse({ ...RECEIVING, phase: "video" }).success, false);
    assert.equal(PublicJobActivitySchema.safeParse({ ...RECEIVING, label: "Receiving data" }).success, false);
    assert.equal(PublicJobActivitySchema.safeParse({ ...RECEIVING, state: "stalled" }).success, false);
    assert.equal(PublicJobActivitySchema.safeParse({ ...RECEIVING, idleSeconds: 9 }).success, false, "receiving is recent");
    assert.equal(PublicJobActivitySchema.safeParse(RECEIVING).success, true);
  });
});
