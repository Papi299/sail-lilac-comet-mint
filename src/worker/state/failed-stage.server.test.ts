import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ERROR_MESSAGES } from "../../lib/errors.ts";
import {
  FAILED_JOB_STAGE_LABELS,
  WORKER_RESTART_SAFE_MESSAGE,
  WORKER_RESTART_STAGE_LABEL,
  failedJobStageLabelFor,
  isFailedJobStageLabel,
} from "../../shared/worker/job-failure.ts";
import { applyMigrations } from "./migrations.server.ts";
import { SQLiteJobStore } from "./sqlite-job-store.server.ts";

/**
 * MEDIA-EXECUTION-FAILURE-CLASSIFICATION-001: `failJob()` records WHICH phase a
 * job failed in, as a closed stage label decided by the durable status it
 * leaves — never by its caller and never by the failure's own text.
 */

describe("the closed failed-job stage vocabulary", () => {
  it("is exactly the three phase stages plus the restart stage", () => {
    assert.deepEqual(
      [...FAILED_JOB_STAGE_LABELS],
      ["Download failed", "Processing failed", "Upload failed", "Worker restarted"],
    );
  });

  it("maps every failable status to its phase", () => {
    assert.equal(failedJobStageLabelFor("queued"), "Download failed");
    assert.equal(failedJobStageLabelFor("analyzing"), "Download failed");
    assert.equal(failedJobStageLabelFor("downloading"), "Download failed");
    assert.equal(failedJobStageLabelFor("processing"), "Processing failed");
    assert.equal(failedJobStageLabelFor("uploading"), "Upload failed");
  });

  it("recognises only its own members", () => {
    for (const label of FAILED_JOB_STAGE_LABELS) assert.equal(isFailedJobStageLabel(label), true);
    for (const other of [
      null,
      undefined,
      "",
      "Failed",
      "Downloading",
      "downloading",
      "download failed",
      "Download failed ",
      "Upload failed: R2_SECRET",
      42,
    ]) {
      assert.equal(isFailedJobStageLabel(other), false, JSON.stringify(other));
    }
  });

  it("pins the restart pair the Stage-B acceptance harness observes", () => {
    assert.equal(WORKER_RESTART_SAFE_MESSAGE, "Worker restarted before the job completed.");
    assert.equal(WORKER_RESTART_STAGE_LABEL, "Worker restarted");
  });
});

describe("SQLiteJobStore.failJob records the failure stage", () => {
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "failed-stage-test-"));
    db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
    applyMigrations(db);
    store = new SQLiteJobStore({ db });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function queued(): string {
    const res = store.createJob(
      { url: "https://cdn.example/a.mp4", formatId: "direct-original", principalId: "private-access-user" },
      randomUUID(),
    );
    assert.ok(res.type === "created");
    return res.job.jobId;
  }

  function claimed(): string {
    const jobId = queued();
    const job = store.claimNextQueuedJob();
    assert.equal(job?.jobId, jobId);
    return jobId;
  }

  function downloading(): string {
    const jobId = claimed();
    const res = store.completeAnalysis(jobId, {
      title: "T",
      thumbnail: null,
      source: "cdn.example",
      extractor: "direct",
    });
    assert.equal(res.type, "updated");
    // The last progress label is exactly what a failure must NOT leave behind.
    const progress = store.updateExecutionProgress(jobId, "downloading", {
      progress: 40,
      downloadedBytes: 400,
      totalBytes: 1000,
      speed: null,
      eta: null,
      stageLabel: "downloading",
    });
    assert.equal(progress.type, "updated");
    return jobId;
  }

  function processing(): string {
    const jobId = downloading();
    assert.equal(store.beginProcessing(jobId).type, "updated");
    return jobId;
  }

  function uploading(): string {
    const jobId = processing();
    assert.equal(store.beginUploading(jobId).type, "updated");
    return jobId;
  }

  const cases: ReadonlyArray<readonly [string, () => string, string]> = [
    ["queued", queued, "Download failed"],
    ["analyzing", claimed, "Download failed"],
    ["downloading", downloading, "Download failed"],
    ["processing", processing, "Processing failed"],
    ["uploading", uploading, "Upload failed"],
  ];

  for (const [status, reach, stage] of cases) {
    it(`a job failed while ${status} carries "${stage}"`, () => {
      const jobId = reach();
      assert.equal(store.getJob(jobId)!.status, status);
      assert.equal(store.failJob(jobId, "NETWORK_ERROR", ERROR_MESSAGES.NETWORK_ERROR), true);
      const view = store.getJob(jobId)!;
      assert.equal(view.status, "failed");
      assert.equal(view.errorCode, "NETWORK_ERROR");
      assert.equal(view.safeErrorMessage, ERROR_MESSAGES.NETWORK_ERROR);
      assert.equal(view.stageLabel, stage);
    });
  }

  it("the stage does not depend on the code", () => {
    const a = processing();
    const b = processing();
    store.failJob(a, "TIMEOUT", ERROR_MESSAGES.TIMEOUT);
    store.failJob(b, "PROCESSING_FAILED", ERROR_MESSAGES.PROCESSING_FAILED);
    assert.equal(store.getJob(a)!.stageLabel, "Processing failed");
    assert.equal(store.getJob(b)!.stageLabel, "Processing failed");
  });

  it("a terminal job's stage is left exactly as it was", () => {
    const jobId = uploading();
    store.failJob(jobId, "PROCESSING_FAILED", ERROR_MESSAGES.PROCESSING_FAILED);
    assert.equal(store.failJob(jobId, "TIMEOUT", ERROR_MESSAGES.TIMEOUT), false);
    const view = store.getJob(jobId)!;
    assert.equal(view.errorCode, "PROCESSING_FAILED");
    assert.equal(view.stageLabel, "Upload failed");

    const cancelledId = downloading();
    assert.equal(store.cancelJob(cancelledId).type, "cancelled");
    assert.equal(store.failJob(cancelledId, "TIMEOUT", ERROR_MESSAGES.TIMEOUT), false);
    assert.equal(store.getJob(cancelledId)!.stageLabel, "downloading");
  });

  it("recover() still writes the restart pair, from the shared constants", () => {
    const jobId = processing();
    store.recover();
    const view = store.getJob(jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "PROCESSING_FAILED");
    assert.equal(view.safeErrorMessage, WORKER_RESTART_SAFE_MESSAGE);
    assert.equal(view.stageLabel, WORKER_RESTART_STAGE_LABEL);
  });
});
