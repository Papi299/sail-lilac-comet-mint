import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_MESSAGES } from "../../lib/errors.ts";
import {
  WorkerJobViewSchema,
  type WorkerJobStatus,
  type WorkerJobView,
} from "../../shared/worker/contracts.ts";
import { PublicJobSchema, isTerminalPublicStatus, toPublicJob } from "./public-job.ts";

const JOB_ID = "0123456789abcdef0123456789abcdef";
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/aaaabbbbccccddddeeeeffff00001111`;
const NOW = 1_700_000_000_000;

function workerJob(overrides: Partial<WorkerJobView> = {}): WorkerJobView {
  return WorkerJobViewSchema.parse({
    jobId: JOB_ID,
    status: "queued",
    progress: null,
    stageLabel: null,
    downloadedBytes: null,
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
    title: null,
    thumbnail: null,
    source: null,
    extractor: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 500,
    expiresAt: NOW + 60_000,
    objectKey: null,
    ...overrides,
  });
}

function readyJob(overrides: Partial<WorkerJobView> = {}): WorkerJobView {
  return workerJob({
    status: "ready",
    objectKey: OBJECT_KEY,
    filename: "clip.mp4",
    fileSize: 2048,
    mime: "video/mp4",
    quality: "original",
    container: "mp4",
    title: "Clip",
    ...overrides,
  });
}

describe("public browser job DTO", () => {
  it("NEVER serializes the object key anywhere in the browser response", () => {
    const job = readyJob();
    const dto = toPublicJob(job, NOW);
    const serialized = JSON.stringify(dto);

    assert.equal("objectKey" in dto, false);
    assert.equal(serialized.includes(OBJECT_KEY), false, "exact object key leaked");
    assert.equal(serialized.includes("aaaabbbbccccddddeeeeffff00001111"), false);
    assert.equal(serialized.includes("videofetch/jobs"), false);
    assert.equal(serialized.includes("objectKey"), false);
  });

  it("also strips the object key from a full API-style envelope", () => {
    const body = JSON.stringify({ success: true, job: toPublicJob(readyJob(), NOW) });
    assert.equal(body.includes(OBJECT_KEY), false);
    assert.equal(body.includes("videofetch/jobs"), false);
  });

  it("exposes exactly the browser contract and no worker internals", () => {
    const dto = toPublicJob(readyJob(), NOW);
    assert.deepEqual(Object.keys(dto).sort(), [
      "container",
      "createdAt",
      "downloadUrl",
      "downloadedBytes",
      "error",
      "errorCode",
      "eta",
      "expiresAt",
      "extractor",
      "fileSize",
      "filename",
      "jobId",
      "progress",
      "quality",
      "source",
      "speed",
      "stageLabel",
      "status",
      "thumbnail",
      "title",
      "totalBytes",
      "updatedAt",
    ]);
    assert.equal("mime" in dto, false, "mime is not part of the browser contract");
    assert.equal("safeErrorMessage" in dto, false, "the raw field must not be duplicated");
    assert.equal("url" in dto, false);
    assert.equal("principalId" in dto, false);
  });

  it("maps safeErrorMessage onto the browser error field only", () => {
    const dto = toPublicJob(
      workerJob({
        status: "failed",
        errorCode: "TIMEOUT",
        safeErrorMessage: ERROR_MESSAGES.TIMEOUT,
      }),
      NOW,
    );
    assert.equal(dto.error, ERROR_MESSAGES.TIMEOUT);
    assert.equal(dto.errorCode, "TIMEOUT");
    assert.equal("safeErrorMessage" in dto, false);
  });

  it("falls back to the canonical message when only a code is present", () => {
    const dto = toPublicJob(workerJob({ status: "failed", errorCode: "TOO_LARGE" }), NOW);
    assert.equal(dto.error, ERROR_MESSAGES.TOO_LARGE);
  });

  it("gives a live ready job the local file route and nothing else", () => {
    const dto = toPublicJob(readyJob(), NOW);
    assert.equal(dto.downloadUrl, `/api/download/${JOB_ID}/file`);
    assert.equal(dto.downloadUrl!.startsWith("/api/"), true);
    assert.equal(dto.downloadUrl!.includes("http"), false, "never a signed object-store URL");
    assert.equal(dto.downloadUrl!.includes("X-Amz"), false);
  });

  it("gives an expired ready job no download URL", () => {
    const dto = toPublicJob(readyJob({ expiresAt: NOW - 1 }), NOW);
    assert.equal(dto.downloadUrl, null);
  });

  it("gives every non-ready status a null download URL", () => {
    const statuses: WorkerJobStatus[] = [
      "queued",
      "analyzing",
      "downloading",
      "processing",
      "uploading",
      "failed",
      "cancelled",
    ];
    for (const status of statuses) {
      const dto = toPublicJob(workerJob({ status }), NOW);
      assert.equal(dto.downloadUrl, null, `${status} must not receive a download URL`);
    }
  });

  it("supports uploading as a first-class non-terminal status", () => {
    const dto = toPublicJob(workerJob({ status: "uploading" }), NOW);
    assert.equal(dto.status, "uploading");
    assert.equal(dto.stageLabel, "Finalizing");
    assert.equal(isTerminalPublicStatus("uploading"), false);
  });

  it("treats cancelled as terminal so polling stops", () => {
    assert.equal(isTerminalPublicStatus("cancelled"), true);
    assert.equal(isTerminalPublicStatus("ready"), true);
    assert.equal(isTerminalPublicStatus("failed"), true);
    assert.equal(isTerminalPublicStatus("queued"), false);
    assert.equal(isTerminalPublicStatus("downloading"), false);
  });

  it("never produces a legacy merging or converting status", () => {
    const statuses: WorkerJobStatus[] = [
      "queued",
      "analyzing",
      "downloading",
      "processing",
      "uploading",
      "ready",
      "failed",
      "cancelled",
    ];
    for (const status of statuses) {
      const source = status === "ready" ? readyJob() : workerJob({ status });
      const dto = toPublicJob(source, NOW);
      assert.notEqual(dto.status, "merging");
      assert.notEqual(dto.status, "converting");
    }
  });

  it("supplies a non-null stage label for every status", () => {
    const statuses: WorkerJobStatus[] = [
      "queued",
      "analyzing",
      "downloading",
      "processing",
      "uploading",
      "ready",
      "failed",
      "cancelled",
    ];
    for (const status of statuses) {
      const source = status === "ready" ? readyJob() : workerJob({ status });
      const dto = toPublicJob(source, NOW);
      assert.equal(typeof dto.stageLabel, "string");
      assert.ok(dto.stageLabel.length > 0, `${status} produced an empty stage label`);
    }
  });

  it("preserves a worker-supplied stage label verbatim", () => {
    const dto = toPublicJob(
      workerJob({ status: "downloading", stageLabel: "Downloading 42%" }),
      NOW,
    );
    assert.equal(dto.stageLabel, "Downloading 42%");
  });

  it("carries the progress and metadata fields through unchanged", () => {
    const dto = toPublicJob(
      workerJob({
        status: "downloading",
        progress: 42,
        downloadedBytes: 100,
        totalBytes: 200,
        speed: 12.5,
        eta: 8,
        title: "Clip",
        thumbnail: "https://cdn.example/t.jpg",
        source: "cdn.example",
        extractor: "direct",
      }),
      NOW,
    );
    assert.equal(dto.progress, 42);
    assert.equal(dto.downloadedBytes, 100);
    assert.equal(dto.totalBytes, 200);
    assert.equal(dto.speed, 12.5);
    assert.equal(dto.eta, 8);
    assert.equal(dto.title, "Clip");
    assert.equal(dto.thumbnail, "https://cdn.example/t.jpg");
    assert.equal(dto.source, "cdn.example");
    assert.equal(dto.extractor, "direct");
    assert.equal(dto.createdAt, NOW - 1000);
    assert.equal(dto.updatedAt, NOW - 500);
    assert.equal(dto.expiresAt, NOW + 60_000);
  });

  it("is strict: an object key can never be smuggled back in", () => {
    assert.throws(() =>
      PublicJobSchema.parse({ ...toPublicJob(readyJob(), NOW), objectKey: OBJECT_KEY }),
    );
  });
});
