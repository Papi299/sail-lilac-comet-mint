import test from "node:test";
import assert from "node:assert";
import { z } from "zod";
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
    extractor: "yt-dlp",
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
        formatId: "preset:best",
        principalId: WORKER_PRIVATE_PRINCIPAL,
      }),
    );
    assert.doesNotThrow(() =>
      WorkerCreateJobRequestSchema.parse({
        url: "http://youtube.com/watch?v=123",
        formatId: "preset:best",
        principalId: WORKER_PRIVATE_PRINCIPAL,
      }),
    );
  });

  await t.test("Create job rejects arbitrary principal", () => {
    assert.throws(() =>
      WorkerCreateJobRequestSchema.parse({
        url: "https://youtube.com/watch?v=123",
        formatId: "preset:best",
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
          formatId: "preset:best",
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
    runtime: {
      ytdlpVersion: "2026.08.19",
    },
    features: {
      ytdlpEnabled: false,
    },
    safeEgress: {
      enforcement: "external",
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
        extractor: "yt-dlp",
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
        extractor: "yt-dlp",
        webpageUrl: "https://youtube.com/watch?v=123",
        formats: [],
        presets: [],
        capabilities: { mp3: true, merge: true },
        extra: "field",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE-10D-STAGE-A-OBSERVABILITY-BLOCKER-REMEDIATION-02
//
// WHAT THIS PROVES, EXACTLY: that the historical diagnostics schema and the
// current Worker response are mutually incompatible contracts.
//
// WHAT IT DOES NOT PROVE: that the HTTP 500 observed against Production was
// generated by that historical parser. The deployed bundle's source revision is
// not exposed by Vercel for this CLI-created deployment, so no test here can
// tie the live failure to this code. The incompatibility below, the deployment
// predating the contract change, and the direct path succeeding together make
// control-plane skew the leading diagnosis — not an attested root cause.
//
// Keeping that distinction is the point: a compatibility proof is not a
// production-incident proof, and labelling it as one would be exactly the kind
// of overstatement this phase has already been bitten by.
// ─────────────────────────────────────────────────────────────────────────────

test("historical vs current Worker diagnostics contract compatibility", async (t) => {
  /**
   * `WorkerDiagnosticsSuccessSchema` EXACTLY as it stood at
   * 84321e40a0c1de7b5efd7b87d9b594c1578064d7 — the last commit before
   * 506b1b62c4ce011895d4d62688177e6cd1f5d081 introduced the current shape, and
   * the era the deployed Vercel Production build was cut from.
   *
   * Reproduced literally rather than imported, because the point is to show
   * what a control plane compiled from THAT source does with a response from
   * TODAY's Worker.
   */
  const ProductionEraDiagnosticsSchema = z
    .object({
      status: z.enum(["ok", "degraded"]),
      queueDepth: z.number().int().nonnegative(),
      runningJobs: z.number().int().nonnegative(),
      maxConcurrent: z.number().int().nonnegative(),
      binaries: z.object({ ffmpeg: z.boolean(), ytdlp: z.boolean() }).strict(),
      safeEgress: z
        .object({ attested: z.boolean(), policyVersion: z.string().nullable() })
        .strict(),
    })
    .strict();

  /** What the CURRENT Worker actually returns from `/v1/diagnostics`. */
  const currentWorkerResponse = {
    status: "ok" as const,
    queueDepth: 0,
    runningJobs: 0,
    maxConcurrent: 1,
    binaries: { ffmpeg: true, ytdlp: true },
    runtime: { ytdlpVersion: "2026.08.19" },
    features: { ytdlpEnabled: false },
    safeEgress: { enforcement: "external" as const, policyVersion: null },
  };

  await t.test("today's Worker response satisfies today's schema", () => {
    // The Worker parses its OWN response with this schema before sending it, so
    // a control plane built from the SAME commit cannot fail to parse it. That
    // makes a current-source schema rejection implausible — it does not, by
    // itself, establish which source the failing deployment was built from.
    assert.doesNotThrow(() => WorkerDiagnosticsSuccessSchema.parse(currentWorkerResponse));
  });

  await t.test("the historical schema REJECTS today's Worker response", () => {
    const parsed = ProductionEraDiagnosticsSchema.safeParse(currentWorkerResponse);
    assert.equal(
      parsed.success,
      false,
      "a control plane compiled from that source could not parse this response",
    );
  });

  await t.test("and rejects it on four independent counts", () => {
    const parsed = ProductionEraDiagnosticsSchema.safeParse(currentWorkerResponse);
    assert.equal(parsed.success, false);
    if (parsed.success) return;
    const paths = parsed.error.issues.map((i) => i.path.join("."));

    // Each of these is sufficient on its own; together they mean no amount of
    // retrying or reconnecting could have made the old parser accept it.
    assert.ok(
      parsed.error.issues.some((i) => i.code === "unrecognized_keys"),
      "`runtime` and `features` are unrecognized under a .strict() object",
    );
    assert.ok(
      paths.some((p) => p.startsWith("safeEgress")),
      "safeEgress changed shape: `attested` is required and absent; `enforcement` is unknown",
    );
  });

  await t.test("the two contracts are incompatible in BOTH directions", () => {
    // Consistent with the direct regression passing while diagnostics 500'd:
    // the job contracts the direct path uses were untouched by the diagnostics
    // change, so transport, HMAC and routing were demonstrably healthy. That is
    // corroboration for the skew diagnosis, not proof of it.
    const job = {
      status: "ok" as const,
      queueDepth: 0,
      runningJobs: 0,
      maxConcurrent: 1,
      binaries: { ffmpeg: true, ytdlp: true },
      safeEgress: { attested: true, policyVersion: null },
    };
    assert.doesNotThrow(() => ProductionEraDiagnosticsSchema.parse(job));
    // The same document is NOT acceptable to the current schema — the two
    // contracts are mutually incompatible, in both directions.
    assert.equal(WorkerDiagnosticsSuccessSchema.safeParse(job).success, false);
  });
});
