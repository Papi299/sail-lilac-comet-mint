import test from "node:test";
import assert from "node:assert";
import {
  WorkerJobStatusSchema,
  WorkerJobViewSchema,
  WorkerCreateJobRequestSchema,
  VideoMetadataSchema,
  WorkerDiagnosticsSuccessSchema,
  workerJobPath,
  workerJobCancelPath,
} from "./contracts.ts";
import { WORKER_PRIVATE_PRINCIPAL } from "./constants.ts";

test("Worker Contracts - Status", async (t) => {
  await t.test("accepts all 8 approved states", () => {
    const states = [
      "queued",
      "analyzing",
      "downloading",
      "processing",
      "uploading",
      "ready",
      "failed",
      "cancelled",
    ];
    for (const state of states) {
      assert.doesNotThrow(() => WorkerJobStatusSchema.parse(state));
    }
  });

  await t.test("rejects legacy states", () => {
    assert.throws(() => WorkerJobStatusSchema.parse("merging"));
    assert.throws(() => WorkerJobStatusSchema.parse("converting"));
    assert.throws(() => WorkerJobStatusSchema.parse("unknown"));
  });
});

test("Worker Contracts - WorkerJobView", async (t) => {
  const validJob = {
    jobId: "0123456789abcdef0123456789abcdef",
    status: "ready",
    progress: 100,
    stageLabel: "Done",
    downloadedBytes: 1024,
    totalBytes: 1024,
    speed: 50,
    eta: 0,
    errorCode: null,
    safeErrorMessage: null,
    filename: "video.mp4",
    fileSize: 1024,
    mime: "video/mp4",
    quality: "1080p",
    container: "mp4",
    title: "Test Video",
    thumbnail: "https://example.com/thumb.jpg",
    source: "youtube",
    extractor: "youtube",
    createdAt: 1600000000,
    updatedAt: 1600000000,
    expiresAt: 1600086400,
    objectKey: "videofetch/jobs/0123456789abcdef0123456789abcdef/0123456789abcdef0123456789abcdef",
  };

  await t.test("accepts safe valid DTO", () => {
    assert.doesNotThrow(() => WorkerJobViewSchema.parse(validJob));
  });

  await t.test("rejects workDir and outputPath", () => {
    assert.throws(() => WorkerJobViewSchema.parse({ ...validJob, workDir: "/tmp" }));
    assert.throws(() => WorkerJobViewSchema.parse({ ...validJob, outputPath: "/tmp/out.mp4" }));
  });

  await t.test("rejects malformed job ID", () => {
    assert.throws(() => WorkerJobViewSchema.parse({ ...validJob, jobId: "short" }));
    assert.throws(() => WorkerJobViewSchema.parse({ ...validJob, jobId: "0123456789ABCDEF0123456789ABCDEF" }));
  });

  await t.test("rejects malformed objectKey", () => {
    assert.throws(() => WorkerJobViewSchema.parse({ ...validJob, objectKey: "some/other/path" }));
  });

  await t.test("ready job requires matching objectKey", () => {
    // Valid objectKey for a DIFFERENT job
    const wrongKey = "videofetch/jobs/fedcba9876543210fedcba9876543210/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert.throws(() => WorkerJobViewSchema.parse({ ...validJob, status: "ready", objectKey: wrongKey }));
    
    // Missing objectKey for ready job
    assert.throws(() => WorkerJobViewSchema.parse({ ...validJob, status: "ready", objectKey: null }));
  });

  await t.test("non-ready jobs require null objectKey", () => {
    const nonReadyStates = ["queued", "analyzing", "downloading", "processing", "uploading", "failed", "cancelled"];
    
    // valid job has a non-null objectKey, so setting status to non-ready should fail
    for (const status of nonReadyStates) {
      assert.throws(() => WorkerJobViewSchema.parse({ ...validJob, status }));
      assert.doesNotThrow(() => WorkerJobViewSchema.parse({ ...validJob, status, objectKey: null }));
    }
  });
});

test("Worker Contracts - Dynamic Paths", async (t) => {
  const validId = "0123456789abcdef0123456789abcdef";

  await t.test("workerJobPath builds path correctly", () => {
    assert.strictEqual(workerJobPath(validId), "/v1/jobs/0123456789abcdef0123456789abcdef");
  });

  await t.test("workerJobCancelPath builds path correctly", () => {
    assert.strictEqual(workerJobCancelPath(validId), "/v1/jobs/0123456789abcdef0123456789abcdef/cancel");
  });

  await t.test("path builders reject malformed job ID", () => {
    assert.throws(() => workerJobPath("not-a-job-id"));
    assert.throws(() => workerJobCancelPath("0123456789ABCDEF0123456789ABCDEF")); // uppercase rejected
  });
});

test("Worker Contracts - Requests and URLs", async (t) => {
  await t.test("Create job accepts valid principal and HTTP/HTTPS URL", () => {
    assert.doesNotThrow(() =>
      WorkerCreateJobRequestSchema.parse({
        url: "https://youtube.com/watch?v=123",
        formatId: "best",
        principalId: WORKER_PRIVATE_PRINCIPAL,
      }),
    );
    assert.doesNotThrow(() =>
      WorkerCreateJobRequestSchema.parse({
        url: "http://youtube.com/watch?v=123",
        formatId: "best",
        principalId: WORKER_PRIVATE_PRINCIPAL,
      }),
    );
  });

  await t.test("Create job rejects arbitrary principal", () => {
    assert.throws(() =>
      WorkerCreateJobRequestSchema.parse({
        url: "https://youtube.com/watch?v=123",
        formatId: "best",
        principalId: "user-123",
      }),
    );
  });

  await t.test("Create job rejects non-HTTP URLs", () => {
    const invalidUrls = [
      "not-a-url",
      "ftp://example.com/video",
      "file:///etc/passwd",
      "data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==",
      "javascript:alert(1)",
      "mailto:test@example.com"
    ];

    for (const url of invalidUrls) {
      assert.throws(() =>
        WorkerCreateJobRequestSchema.parse({
          url,
          formatId: "best",
          principalId: WORKER_PRIVATE_PRINCIPAL,
        }),
      );
    }
  });
});

test("Worker Contracts - Diagnostics", async (t) => {
  const validDiagnostics = {
    status: "ok",
    queueDepth: 0,
    runningJobs: 0,
    maxConcurrent: 1,
    binaries: {
      ffmpeg: true,
      ytdlp: true,
    },
    safeEgress: {
      attested: false,
      policyVersion: "not-enabled",
    },
  };

  await t.test("accepts valid diagnostics DTO", () => {
    assert.doesNotThrow(() => WorkerDiagnosticsSuccessSchema.parse(validDiagnostics));
  });

  await t.test("rejects degraded object shape if status is wrong", () => {
    assert.throws(() => WorkerDiagnosticsSuccessSchema.parse({ ...validDiagnostics, status: "unknown" }));
  });

  await t.test("rejects string binary paths", () => {
    assert.throws(() =>
      WorkerDiagnosticsSuccessSchema.parse({
        ...validDiagnostics,
        binaries: {
          ffmpeg: "/usr/bin/ffmpeg", // Must be boolean
          ytdlp: true,
        },
      }),
    );
  });

  await t.test("rejects unexpected fields", () => {
    assert.throws(() =>
      WorkerDiagnosticsSuccessSchema.parse({
        ...validDiagnostics,
        hostOS: "linux",
      }),
    );
  });
});

test("Worker Contracts - Media", async (t) => {
  await t.test("accepts valid VideoMetadata", () => {
    assert.doesNotThrow(() =>
      VideoMetadataSchema.parse({
        title: "Test",
        thumbnail: "https://example.com/thumb.jpg",
        duration: 120,
        source: "youtube",
        extractor: "youtube",
        webpageUrl: "https://youtube.com/watch?v=123",
        formats: [],
        presets: [],
        capabilities: { mp3: true, merge: true },
      }),
    );
  });
  
  await t.test("rejects extra fields", () => {
    assert.throws(() =>
      VideoMetadataSchema.parse({
        title: "Test",
        thumbnail: "https://example.com/thumb.jpg",
        duration: 120,
        source: "youtube",
        extractor: "youtube",
        webpageUrl: "https://youtube.com/watch?v=123",
        formats: [],
        presets: [],
        capabilities: { mp3: true, merge: true },
        extra: "field",
      }),
    );
  });
});
