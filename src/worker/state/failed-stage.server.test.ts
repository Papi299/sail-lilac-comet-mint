import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ERROR_MESSAGES } from "../../lib/errors.ts";
import {
  ACQUISITION_STOP_FAILED_STAGE_LABELS,
  FAILED_JOB_STAGE_LABELS,
  WORKER_RESTART_SAFE_MESSAGE,
  WORKER_RESTART_STAGE_LABEL,
  failedJobStageLabelFor,
  isAcquisitionStopCause,
  isFailedJobStageLabel,
} from "../../shared/worker/job-failure.ts";
import {
  DOWNLOAD_STALLED_STAGE_LABEL,
  DOWNLOAD_TIME_LIMIT_STAGE_LABEL,
  RESERVED_FAILED_JOB_STAGE_LABELS,
  classifyJobOutcome,
  publicFailedStageLabel,
} from "../../shared/worker/job-outcome.ts";
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

/**
 * VIDEOFETCH-LD3-WATCHDOG-RUNTIME-ACTIVATION-001: the two acquisition stops.
 *
 * `failJob()` writes `Download stalled` or `Download time limit reached` only
 * for a closed stop the executor names, only for a job leaving `downloading`,
 * and only beside `TIMEOUT`; otherwise the status decides, exactly as before.
 * The transition is the same compare-and-set as every other failure: a
 * terminal row — cancelled, ready, failed — is never touched.
 */
describe("SQLiteJobStore.failJob: the acquisition stops' own stages", () => {
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "failed-stage-ld3-"));
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
    assert.equal(store.claimNextQueuedJob()?.jobId, jobId);
    return jobId;
  }
  function downloading(): string {
    const jobId = claimed();
    assert.equal(
      store.completeAnalysis(jobId, { title: "T", thumbnail: null, source: "cdn.example", extractor: "direct" }).type,
      "updated",
    );
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

  it("binds the closed table to exactly the two causes and the control plane's two reserved TIMEOUT stages", () => {
    assert.deepEqual(Object.keys(ACQUISITION_STOP_FAILED_STAGE_LABELS), ["inactivity", "time-limit"]);
    assert.deepEqual(Object.values(ACQUISITION_STOP_FAILED_STAGE_LABELS), [...RESERVED_FAILED_JOB_STAGE_LABELS]);
    assert.equal(ACQUISITION_STOP_FAILED_STAGE_LABELS.inactivity, DOWNLOAD_STALLED_STAGE_LABEL);
    assert.equal(ACQUISITION_STOP_FAILED_STAGE_LABELS["time-limit"], DOWNLOAD_TIME_LIMIT_STAGE_LABEL);
    assert.ok(Object.isFrozen(ACQUISITION_STOP_FAILED_STAGE_LABELS));
    // Kept OUT of the status-derived list: the control plane forwards those beside any code.
    for (const label of Object.values(ACQUISITION_STOP_FAILED_STAGE_LABELS)) {
      assert.equal(isFailedJobStageLabel(label), false, label);
    }
    for (const cause of ["inactivity", "time-limit"]) assert.equal(isAcquisitionStopCause(cause), true, cause);
    for (const other of [undefined, null, "", "stall", "Inactivity", "deadline", "observation-lost", "cancelled", "toString", "__proto__", 1]) {
      assert.equal(isAcquisitionStopCause(other), false, JSON.stringify(other));
    }
  });

  for (const [cause, stage] of [
    ["inactivity", "Download stalled"],
    ["time-limit", "Download time limit reached"],
  ] as const) {
    it(`a ${cause} stop while downloading is failed / TIMEOUT / "${stage}", with the canonical message`, () => {
      const jobId = downloading();
      assert.equal(store.failJob(jobId, "TIMEOUT", ERROR_MESSAGES.TIMEOUT, cause), true);
      const view = store.getJob(jobId)!;
      assert.equal(view.status, "failed");
      assert.equal(view.errorCode, "TIMEOUT");
      assert.equal(view.safeErrorMessage, ERROR_MESSAGES.TIMEOUT);
      assert.equal(view.stageLabel, stage);
      assert.equal(view.objectKey, null);
      // The control plane's view of it: the reserved stage, forwarded with TIMEOUT.
      assert.equal(publicFailedStageLabel(view.stageLabel, view.errorCode), stage);
      assert.equal(
        classifyJobOutcome(view),
        cause === "inactivity" ? "download_stalled" : "download_time_limit",
      );
    });
  }

  it("claims nothing where it cannot be true: any other status or code keeps the status's own stage", () => {
    const cases: ReadonlyArray<readonly [() => string, string, string]> = [
      [queued, "TIMEOUT", "Download failed"],
      [claimed, "TIMEOUT", "Download failed"],
      [processing, "TIMEOUT", "Processing failed"],
      [uploading, "TIMEOUT", "Upload failed"],
      [downloading, "PROCESSING_FAILED", "Download failed"],
      [downloading, "NETWORK_ERROR", "Download failed"],
      [downloading, "TOO_LARGE", "Download failed"],
    ];
    for (const cause of ["inactivity", "time-limit"] as const) {
      for (const [reach, code, stage] of cases) {
        const jobId = reach();
        assert.equal(store.failJob(jobId, code, ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES], cause), true);
        const view = store.getJob(jobId)!;
        assert.equal(view.errorCode, code);
        assert.equal(view.stageLabel, stage, `${cause} / ${code}`);
      }
    }
  });

  it("without a stop, a downloading TIMEOUT keeps exactly its earlier stage", () => {
    const jobId = downloading();
    store.failJob(jobId, "TIMEOUT", ERROR_MESSAGES.TIMEOUT);
    assert.equal(store.getJob(jobId)!.stageLabel, "Download failed");
    const other = downloading();
    store.failJob(other, "TIMEOUT", ERROR_MESSAGES.TIMEOUT, undefined);
    assert.equal(store.getJob(other)!.stageLabel, "Download failed");
  });

  it("refuses a cause outside the closed set before writing anything", () => {
    for (const bad of ["stall", "observation-lost", "Download stalled", "", "toString", "__proto__"]) {
      const jobId = downloading();
      const before = store.getJob(jobId);
      assert.throws(() => store.failJob(jobId, "TIMEOUT", ERROR_MESSAGES.TIMEOUT, bad as never), /Unknown acquisition stop/);
      assert.deepEqual(store.getJob(jobId), before, "the row is untouched");
    }
  });

  it("never touches a terminal row: a committed cancellation, a ready result and an earlier failure all win", () => {
    // A terminal row is refused by the transition itself — `false`, never an exception.
    const refused = (jobId: string, cause: "inactivity" | "time-limit") => {
      let result: boolean | undefined;
      assert.doesNotThrow(() => {
        result = store.failJob(jobId, "TIMEOUT", ERROR_MESSAGES.TIMEOUT, cause);
      }, "a terminal row is refused, not an error");
      assert.equal(result, false);
    };
    const cancelled = downloading();
    assert.equal(store.cancelJob(cancelled).type, "cancelled");
    const cancelledView = store.getJob(cancelled);
    refused(cancelled, "inactivity");
    assert.deepEqual(store.getJob(cancelled), cancelledView);

    const ready = uploading();
    const objectKey = `videofetch/jobs/${ready}/${"a".repeat(32)}` as never;
    assert.equal(
      store.commitReadyFromUploading(ready, { objectKey, filename: "x.mp4", fileSize: 1, mime: "video/mp4", quality: null, container: "mp4", lastModifiedAtMs: Math.floor(Date.now() / 1000) * 1000 }).type,
      "ready",
    );
    const readyView = store.getJob(ready);
    for (const cause of ["inactivity", "time-limit"] as const) refused(ready, cause);
    assert.deepEqual(store.getJob(ready), readyView, "a late stop never overwrites ready");

    const failed = downloading();
    assert.equal(store.failJob(failed, "TIMEOUT", ERROR_MESSAGES.TIMEOUT, "time-limit"), true);
    const failedView = store.getJob(failed);
    refused(failed, "inactivity"); // no double terminal transition
    assert.deepEqual(store.getJob(failed), failedView);
  });

  it("restart recovery still writes its own pair, whatever stop a dying process could have meant", () => {
    const jobId = downloading();
    store.recover();
    const view = store.getJob(jobId)!;
    assert.equal(view.errorCode, "PROCESSING_FAILED");
    assert.equal(view.stageLabel, WORKER_RESTART_STAGE_LABEL);
  });

  it("needs no migration: the stage is the existing column, read back through the unchanged row schema", () => {
    const jobId = downloading();
    store.failJob(jobId, "TIMEOUT", ERROR_MESSAGES.TIMEOUT, "inactivity");
    const row = db.prepare("SELECT stage_label, error_code, status FROM worker_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { stage_label: "Download stalled", error_code: "TIMEOUT", status: "failed" });
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1, "schema v1, unchanged");
    // A fresh store over the same database — what an older image's store does — reads it back.
    const again = new SQLiteJobStore({ db });
    assert.equal(again.getJob(jobId)!.stageLabel, "Download stalled");
  });
});
