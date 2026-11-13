import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_MESSAGES } from "../../lib/errors.ts";
import { WorkerJobViewSchema, type WorkerJobView } from "../../shared/worker/contracts.ts";
import { WORKER_ERROR_CODES } from "../../shared/worker/errors.ts";
import {
  FAILED_JOB_STAGE_LABELS,
  WORKER_RESTART_SAFE_MESSAGE,
} from "../../shared/worker/job-failure.ts";
import {
  DOWNLOAD_TIMEOUT_MESSAGE,
  RESERVED_FAILED_JOB_STAGE_LABELS,
  timeoutMessageForStage,
} from "../../shared/worker/job-outcome.ts";
import { toPublicJob } from "./public-job.ts";

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: what the control
 * plane says about a failed job. A failed TIMEOUT now names the stage that ran
 * out of time; every other code, and every other field, is as before.
 */

const JOB_ID = "0123456789abcdef0123456789abcdef";
const NOW = 1_700_000_000_000;
const HOSTILE =
  "yt-dlp: ERROR: Download stalled https://media.example/v.mp4?X-Amz-Signature=deadbeef at /var/lib/videofetch/jobs/x token=sk-live-SECRET";

function failedJob(overrides: Partial<WorkerJobView>): WorkerJobView {
  return WorkerJobViewSchema.parse({
    jobId: JOB_ID,
    status: "failed",
    progress: 42,
    stageLabel: null,
    downloadedBytes: 1_000,
    totalBytes: null,
    speed: null,
    eta: null,
    errorCode: "TIMEOUT",
    safeErrorMessage: ERROR_MESSAGES.TIMEOUT,
    filename: null,
    fileSize: null,
    mime: null,
    quality: null,
    container: null,
    title: "Clip",
    thumbnail: null,
    source: "cdn.example",
    extractor: "direct",
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    objectKey: null,
    ...overrides,
  });
}

function assertNoRaw(json: string) {
  for (const fragment of ["X-Amz-Signature", "/var/lib", "sk-live", "yt-dlp: ERROR", "media.example"]) {
    assert.equal(json.includes(fragment), false, `leaked ${fragment}`);
  }
}

describe("a failed TIMEOUT names its stage", () => {
  it("as the current Worker writes it (status-derived stages)", () => {
    const expected: Record<string, string> = {
      "Download failed": "The download didn't finish in time.",
      "Processing failed": "Processing took too long.",
      "Upload failed": "Uploading the finished file took too long.",
    };
    for (const [stageLabel, message] of Object.entries(expected)) {
      const dto = toPublicJob(failedJob({ stageLabel, safeErrorMessage: HOSTILE }), NOW);
      assert.equal(dto.errorCode, "TIMEOUT");
      assert.equal(dto.stageLabel, stageLabel);
      assert.equal(dto.error, message, stageLabel);
      assertNoRaw(JSON.stringify(dto));
    }
  });

  it("never shows the processing sentence for a download that ran out of time", () => {
    const dto = toPublicJob(failedJob({ stageLabel: "Download failed" }), NOW);
    assert.notEqual(dto.error, ERROR_MESSAGES.TIMEOUT);
    assert.equal(/process/i.test(dto.error ?? ""), false);
  });

  it("forwards a reserved watchdog stage, with its approved sentence, when a future Worker writes it", () => {
    const stalled = toPublicJob(failedJob({ stageLabel: "Download stalled" }), NOW);
    assert.equal(stalled.stageLabel, "Download stalled");
    assert.equal(stalled.error, "The source stopped sending data, so VideoFetch stopped waiting.");
    const limit = toPublicJob(failedJob({ stageLabel: "Download time limit reached" }), NOW);
    assert.equal(limit.stageLabel, "Download time limit reached");
    assert.equal(limit.error, "The download was still running when it reached VideoFetch's maximum download time.");
    assert.notEqual(stalled.error, limit.error, "a stall is not the absolute deadline");
  });

  it("does not forward a reserved stage that arrives with any other code", () => {
    for (const stageLabel of RESERVED_FAILED_JOB_STAGE_LABELS) {
      for (const errorCode of WORKER_ERROR_CODES.filter((c) => c !== "TIMEOUT")) {
        const dto = toPublicJob(failedJob({ stageLabel, errorCode, safeErrorMessage: HOSTILE }), NOW);
        assert.equal(dto.stageLabel, "Failed", `${stageLabel} / ${errorCode}`);
        assert.equal(dto.error, ERROR_MESSAGES[errorCode], `${stageLabel} / ${errorCode}`);
      }
    }
  });

  it("claims no stage when the stage is unknown or hostile", () => {
    for (const stageLabel of [null, "downloading", "Downloading 42%", HOSTILE]) {
      const dto = toPublicJob(failedJob({ stageLabel, safeErrorMessage: HOSTILE }), NOW);
      assert.equal(dto.stageLabel, "Failed", JSON.stringify(stageLabel));
      assert.equal(dto.error, DOWNLOAD_TIMEOUT_MESSAGE);
      assertNoRaw(JSON.stringify(dto));
    }
  });

  it("no failed job's message is ever the canonical processing sentence for TIMEOUT", () => {
    for (const stageLabel of [...FAILED_JOB_STAGE_LABELS, ...RESERVED_FAILED_JOB_STAGE_LABELS, null, "Failed"]) {
      const dto = toPublicJob(failedJob({ stageLabel }), NOW);
      assert.notEqual(dto.error, ERROR_MESSAGES.TIMEOUT, String(stageLabel));
      assert.equal(dto.error, timeoutMessageForStage(dto.stageLabel === "Failed" ? null : (dto.stageLabel as never)));
    }
  });
});

describe("everything else is unchanged", () => {
  it("every other code keeps its canonical message, whatever the stage", () => {
    for (const errorCode of WORKER_ERROR_CODES.filter((c) => c !== "TIMEOUT")) {
      for (const stageLabel of [...FAILED_JOB_STAGE_LABELS, null]) {
        const dto = toPublicJob(failedJob({ errorCode, stageLabel, safeErrorMessage: HOSTILE }), NOW);
        assert.equal(dto.error, ERROR_MESSAGES[errorCode], `${errorCode}/${stageLabel}`);
        assertNoRaw(JSON.stringify(dto));
      }
    }
  });

  it("the restart pair is forwarded exactly as before", () => {
    const dto = toPublicJob(
      failedJob({ errorCode: "PROCESSING_FAILED", safeErrorMessage: WORKER_RESTART_SAFE_MESSAGE, stageLabel: "Worker restarted" }),
      NOW,
    );
    assert.equal(dto.error, WORKER_RESTART_SAFE_MESSAGE);
    assert.equal(dto.stageLabel, "Worker restarted");
  });

  it("a cancelled job still carries no error and keeps its own label", () => {
    const dto = toPublicJob(
      failedJob({ status: "cancelled", errorCode: null, safeErrorMessage: null, stageLabel: "Cancelled" }),
      NOW,
    );
    assert.equal(dto.status, "cancelled");
    assert.equal(dto.errorCode, null);
    assert.equal(dto.error, null);
    assert.equal(dto.stageLabel, "Cancelled");
  });

  it("an active job's progress label is never filtered (only failed jobs use the closed stages)", () => {
    const dto = toPublicJob(
      failedJob({ status: "downloading", errorCode: null, safeErrorMessage: null, stageLabel: "Downloading video" }),
      NOW,
    );
    assert.equal(dto.stageLabel, "Downloading video");
    assert.equal(dto.error, null);
  });
});
