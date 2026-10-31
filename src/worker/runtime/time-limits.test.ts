import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "../../shared/worker/contracts.ts";
import type { ObjectStoreHead, ObjectStorePutInput, ObjectStoreWriter } from "../storage/writer.ts";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";
import type { WorkerRuntimeConfig } from "./config.server.ts";
import { startWorker } from "./main.server.ts";
import { createWorkerRuntime } from "./runtime.server.ts";
import {
  ANALYSIS_TIMEOUT_SECONDS,
  DEFAULT_WORKER_TIME_LIMITS,
  DOWNLOAD_TIME_LIMIT_SECONDS,
  EXECUTION_MARGIN_SECONDS,
  FILE_EXPIRATION_MINUTES_RANGE,
  PROCESSING_TIMEOUT_SECONDS,
  UPLOAD_TIMEOUT_SECONDS,
  WorkerTimeLimitsError,
  assertWorkerJobLifetimes,
  assertWorkerStageTimeLimits,
  buildWorkerTimeLimits,
  deriveUploadStageDeadlineMs,
  type WorkerTimeLimitInputs,
} from "./time-limits.ts";

/**
 * VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001: the stage time-limit model, its one
 * construction point in the runtime, and the startup refusal of the retired
 * `DOWNLOAD_TIMEOUT`.
 *
 * VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001: the same model now also
 * carries the job lifetimes — the derived execution lifetime `L` and the
 * retention `R` — and the parsed-but-not-enforced `UPLOAD_TIMEOUT`.
 *
 * Every value here is a fake. No network, no real media and no real R2.
 */

const BAD_FIELD = (field: string) => (err: unknown) => {
  assert.ok(err instanceof WorkerTimeLimitsError, String(err));
  assert.equal(err.field, field);
  return true;
};

/** The strict loader's defaults, as builder inputs. */
const DEFAULT_INPUTS: WorkerTimeLimitInputs = Object.freeze({
  analysisTimeoutSeconds: 45,
  downloadTimeLimitSeconds: 600,
  processingTimeoutSeconds: 600,
  uploadTimeoutSeconds: 3600,
  fileExpirationMinutes: 45,
});

const inputs = (overrides: Partial<WorkerTimeLimitInputs> = {}): WorkerTimeLimitInputs => ({
  ...DEFAULT_INPUTS,
  ...overrides,
});

/** Each builder input with its range and its unit in milliseconds. */
const INPUT_FIELDS = [
  { field: "analysisTimeoutSeconds", range: ANALYSIS_TIMEOUT_SECONDS, unitMs: 1000, out: "analysisMs" },
  { field: "downloadTimeLimitSeconds", range: DOWNLOAD_TIME_LIMIT_SECONDS, unitMs: 1000, out: "downloadTimeLimitMs" },
  { field: "processingTimeoutSeconds", range: PROCESSING_TIMEOUT_SECONDS, unitMs: 1000, out: "processingMs" },
  { field: "uploadTimeoutSeconds", range: UPLOAD_TIMEOUT_SECONDS, unitMs: 1000, out: "uploadMs" },
  { field: "fileExpirationMinutes", range: FILE_EXPIRATION_MINUTES_RANGE, unitMs: 60_000, out: "retentionMs" },
] as const;

describe("WorkerTimeLimits: the model", () => {
  it("states the approved ranges, the margin and the defaults", () => {
    assert.deepEqual({ ...ANALYSIS_TIMEOUT_SECONDS }, { min: 1, max: 3_600, default: 45 });
    assert.deepEqual({ ...DOWNLOAD_TIME_LIMIT_SECONDS }, { min: 60, max: 21_600, default: 600 });
    assert.deepEqual({ ...PROCESSING_TIMEOUT_SECONDS }, { min: 60, max: 14_400, default: 600 });
    assert.deepEqual({ ...UPLOAD_TIMEOUT_SECONDS }, { min: 300, max: 14_400, default: 3_600 });
    assert.deepEqual({ ...FILE_EXPIRATION_MINUTES_RANGE }, { min: 1, max: 55, default: 45 });
    assert.equal(EXECUTION_MARGIN_SECONDS, 600);
    for (const range of [
      ANALYSIS_TIMEOUT_SECONDS,
      DOWNLOAD_TIME_LIMIT_SECONDS,
      PROCESSING_TIMEOUT_SECONDS,
      UPLOAD_TIMEOUT_SECONDS,
      FILE_EXPIRATION_MINUTES_RANGE,
    ]) {
      assert.ok(Object.isFrozen(range));
    }
  });

  it("keeps the 600 s acquisition default: long downloads are NOT enabled by LD-2a", () => {
    assert.deepEqual(
      { ...DEFAULT_WORKER_TIME_LIMITS },
      {
        analysisMs: 45_000,
        downloadTimeLimitMs: 600_000,
        processingMs: 600_000,
        uploadMs: 3_600_000,
        retentionMs: 2_700_000,
        executionLifetimeMs: 5_445_000,
      },
    );
    assert.notEqual(DEFAULT_WORKER_TIME_LIMITS.downloadTimeLimitMs, 9_000_000, "LD-5b, not LD-2a");
    assert.ok(Object.isFrozen(DEFAULT_WORKER_TIME_LIMITS));
  });

  it("derives L = 5,445,000 ms (1 h 30 min 45 s) and R = 2,700,000 ms at the staged defaults", () => {
    const model = buildWorkerTimeLimits(DEFAULT_INPUTS);
    assert.equal(model.executionLifetimeMs, (45 + 600 + 600 + 3_600 + 600) * 1000);
    assert.equal(model.executionLifetimeMs, 5_445_000);
    assert.equal(model.executionLifetimeMs, ((1 * 60 + 30) * 60 + 45) * 1000);
    assert.equal(model.retentionMs, 45 * 60_000);
    assert.equal(model.retentionMs, 2_700_000);
  });

  it("builds a frozen model of exactly the LD-2a fields, in milliseconds", () => {
    const limits = buildWorkerTimeLimits(
      inputs({ downloadTimeLimitSeconds: 1234, processingTimeoutSeconds: 2345 }),
    );
    assert.deepEqual(Object.keys(limits).sort(), [
      "analysisMs",
      "downloadTimeLimitMs",
      "executionLifetimeMs",
      "processingMs",
      "retentionMs",
      "uploadMs",
    ]);
    assert.equal(limits.downloadTimeLimitMs, 1_234_000);
    assert.equal(limits.processingMs, 2_345_000);
    assert.ok(Object.isFrozen(limits));
    assert.throws(() => {
      (limits as { downloadTimeLimitMs: number }).downloadTimeLimitMs = 1;
    }, TypeError);
    assert.throws(() => {
      (limits as { executionLifetimeMs: number }).executionLifetimeMs = 1;
    }, TypeError);
    // No stage-anonymous field, and the inactivity watchdog's field only with
    // its watchdog (LD-3b).
    for (const absent of ["timeoutMs", "inactivityMs", "jobTtlMs"]) {
      assert.equal(Object.hasOwn(limits, absent), false, absent);
    }
  });

  it("derives L from every component, exactly, and R from the minutes", () => {
    for (const [a, d, p, u, m] of [
      [45, 600, 600, 3_600, 45],
      [1, 60, 60, 300, 1],
      [30, 120, 90, 300, 7],
      [45, 9_000, 600, 3_600, 45],
      [3_600, 21_600, 14_400, 14_400, 55],
      [17, 6_013, 4_021, 1_009, 54],
    ] as const) {
      const model = buildWorkerTimeLimits({
        analysisTimeoutSeconds: a,
        downloadTimeLimitSeconds: d,
        processingTimeoutSeconds: p,
        uploadTimeoutSeconds: u,
        fileExpirationMinutes: m,
      });
      assert.equal(model.executionLifetimeMs, (a + d + p + u + EXECUTION_MARGIN_SECONDS) * 1000, `${[a, d, p, u]}`);
      assert.equal(model.retentionMs, m * 60_000);
      // Invariant I2: L covers every stage bound plus the margin, never less.
      assert.equal(
        model.executionLifetimeMs -
          (model.analysisMs + model.downloadTimeLimitMs + model.processingMs + model.uploadMs),
        600_000,
      );
      for (const value of Object.values(model)) assert.ok(Number.isSafeInteger(value) && value > 0);
    }
  });

  it("states the widest model any configuration can reach, far inside the safe integers", () => {
    const widest = buildWorkerTimeLimits({
      analysisTimeoutSeconds: 3_600,
      downloadTimeLimitSeconds: 21_600,
      processingTimeoutSeconds: 14_400,
      uploadTimeoutSeconds: 14_400,
      fileExpirationMinutes: 55,
    });
    assert.equal(widest.executionLifetimeMs, 54_600_000, "15 h 10 min");
    assert.equal(widest.retentionMs, 3_300_000, "55 min");
    assert.ok(Number.isSafeInteger(2 * widest.executionLifetimeMs + widest.retentionMs));
    // The R2 lifecycle rule deletes an object 3,600 s after it is written: the
    // longest retention keeps a ready link five minutes inside it.
    assert.ok(widest.retentionMs + 300_000 <= 3_600_000);
  });

  it("keeps acquisition and processing independent of each other", () => {
    const a = buildWorkerTimeLimits(inputs({ downloadTimeLimitSeconds: 21_600, processingTimeoutSeconds: 60 }));
    assert.equal(a.downloadTimeLimitMs, 21_600_000);
    assert.equal(a.processingMs, 60_000);
    const b = buildWorkerTimeLimits(inputs({ downloadTimeLimitSeconds: 60, processingTimeoutSeconds: 14_400 }));
    assert.equal(b.downloadTimeLimitMs, 60_000);
    assert.equal(b.processingMs, 14_400_000);
  });

  for (const { field, range, unitMs, out } of INPUT_FIELDS) {
    it(`${field}: accepts each range end and refuses one beyond it`, () => {
      for (const value of [range.min, range.min + 1, range.default, range.max - 1, range.max]) {
        assert.equal(buildWorkerTimeLimits(inputs({ [field]: value }))[out], value * unitMs, String(value));
      }
      for (const value of [range.min - 1, range.max + 1, 0]) {
        assert.throws(() => buildWorkerTimeLimits(inputs({ [field]: value })), BAD_FIELD(field));
      }
    });

    it(`${field}: refuses non-integers, non-finite, unsafe and non-number values, naming the field only`, () => {
      const bad: unknown[] = [
        -1,
        range.default + 0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        String(range.default),
        null,
        undefined,
        987_654_321,
      ];
      for (const value of bad) {
        assert.throws(
          () => buildWorkerTimeLimits(inputs({ [field]: value as number })),
          (err: unknown) => {
            BAD_FIELD(field)(err);
            // The exact message: the field, and never the value.
            assert.equal((err as Error).message, `Invalid Worker time limit: ${field}`);
            return true;
          },
        );
      }
    });
  }

  it("validates an INJECTED stage model: narrower is allowed, malformed or wider is refused", () => {
    // Narrower than the environment minimum: tests and harnesses prove a
    // shared deadline with a few milliseconds.
    assert.deepEqual(
      { ...assertWorkerStageTimeLimits({ downloadTimeLimitMs: 60, processingMs: 1, uploadMs: 5 }) },
      { downloadTimeLimitMs: 60, processingMs: 1, uploadMs: 5 },
    );
    // The environment maximum is the ceiling an injection can never lift.
    assert.ok(
      assertWorkerStageTimeLimits({ downloadTimeLimitMs: 21_600_000, processingMs: 14_400_000, uploadMs: 14_400_000 }),
    );
    assert.throws(
      () => assertWorkerStageTimeLimits({ downloadTimeLimitMs: 21_600_001, processingMs: 1, uploadMs: 1 }),
      BAD_FIELD("downloadTimeLimitMs"),
    );
    assert.throws(
      () => assertWorkerStageTimeLimits({ downloadTimeLimitMs: 1, processingMs: 14_400_001, uploadMs: 1 }),
      BAD_FIELD("processingMs"),
    );
    // LD-2b: the upload stage's limit is held to the same rule.
    assert.throws(
      () => assertWorkerStageTimeLimits({ downloadTimeLimitMs: 1, processingMs: 1, uploadMs: 14_400_001 }),
      BAD_FIELD("uploadMs"),
    );
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "600000", null, undefined]) {
      assert.throws(
        () => assertWorkerStageTimeLimits({ downloadTimeLimitMs: bad, processingMs: 600_000, uploadMs: 600_000 }),
        BAD_FIELD("downloadTimeLimitMs"),
      );
      assert.throws(
        () => assertWorkerStageTimeLimits({ downloadTimeLimitMs: 600_000, processingMs: bad, uploadMs: 600_000 }),
        BAD_FIELD("processingMs"),
      );
      assert.throws(
        () => assertWorkerStageTimeLimits({ downloadTimeLimitMs: 600_000, processingMs: 600_000, uploadMs: bad }),
        BAD_FIELD("uploadMs"),
      );
    }
    // A pre-LD-2b two-field model is refused, never silently given a default upload limit.
    assert.throws(
      () => assertWorkerStageTimeLimits({ downloadTimeLimitMs: 600_000, processingMs: 600_000 }),
      BAD_FIELD("uploadMs"),
    );
    for (const notAModel of [null, undefined, "600000", 600_000]) {
      assert.throws(() => assertWorkerStageTimeLimits(notAModel), BAD_FIELD("timeLimits"));
    }
  });

  it("returns a frozen COPY of exactly the three stage fields: the lifetimes never pass", () => {
    // LD-1/LD-2a pinned two fields here; LD-2b adds `uploadMs`, which the
    // executor now enforces. `analysisMs` and both lifetimes still never pass.
    const injected = { ...DEFAULT_WORKER_TIME_LIMITS, downloadTimeLimitMs: 1_000, processingMs: 2_000, uploadMs: 3_000 };
    const model = assertWorkerStageTimeLimits(injected);
    assert.notEqual(model, injected);
    assert.deepEqual(Object.keys(model).sort(), ["downloadTimeLimitMs", "processingMs", "uploadMs"]);
    assert.ok(Object.isFrozen(model));
    injected.downloadTimeLimitMs = 9;
    injected.uploadMs = 9;
    assert.equal(model.downloadTimeLimitMs, 1_000, "a later mutation of the input cannot reach the model");
    assert.equal(model.uploadMs, 3_000);
  });

  it("validates the store's lifetimes: narrower is allowed; malformed, or wider than configurable, is refused", () => {
    assert.deepEqual({ ...assertWorkerJobLifetimes({ executionLifetimeMs: 1, retentionMs: 1 }) }, {
      executionLifetimeMs: 1,
      retentionMs: 1,
    });
    assert.ok(assertWorkerJobLifetimes({ executionLifetimeMs: 54_600_000, retentionMs: 3_300_000 }));
    assert.throws(
      () => assertWorkerJobLifetimes({ executionLifetimeMs: 54_600_001, retentionMs: 1 }),
      BAD_FIELD("executionLifetimeMs"),
    );
    // No injection can give a ready link a retention past the R2 backstop margin.
    assert.throws(
      () => assertWorkerJobLifetimes({ executionLifetimeMs: 1, retentionMs: 3_300_001 }),
      BAD_FIELD("retentionMs"),
    );
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2700000", null, undefined]) {
      assert.throws(
        () => assertWorkerJobLifetimes({ executionLifetimeMs: bad, retentionMs: 1 }),
        BAD_FIELD("executionLifetimeMs"),
      );
      assert.throws(
        () => assertWorkerJobLifetimes({ executionLifetimeMs: 1, retentionMs: bad }),
        BAD_FIELD("retentionMs"),
      );
    }
    for (const notAModel of [null, undefined, 1]) {
      assert.throws(() => assertWorkerJobLifetimes(notAModel), BAD_FIELD("jobLifetimes"));
    }
    const lifetimes = assertWorkerJobLifetimes(DEFAULT_WORKER_TIME_LIMITS);
    assert.deepEqual(Object.keys(lifetimes).sort(), ["executionLifetimeMs", "retentionMs"]);
    assert.ok(Object.isFrozen(lifetimes));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ONE construction point: createWorkerRuntime
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_KEY_ID = "worker-control-test";
const FAKE_SECRET = "0123456789abcdef0123456789abcdef";
const MEDIA_URL = "https://cdn.example/clip.mp4";

class MemoryWriter implements ObjectStoreWriter {
  public readonly objects = new Map<string, ObjectStoreHead>();
  async put(input: ObjectStorePutInput): Promise<void> {
    let received = 0;
    for await (const chunk of input.body) received += chunk.length;
    this.objects.set(input.objectKey, {
      objectKey: input.objectKey,
      contentLength: received,
      contentType: input.contentType,
      contentDisposition: input.contentDisposition,
    });
  }
  async head(objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    return this.objects.get(objectKey) ?? null;
  }
  async delete(objectKey: WorkerObjectKey): Promise<void> {
    this.objects.delete(objectKey);
  }
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function makeConfig(
  dataDirectory: string,
  port: number,
  media: Partial<WorkerRuntimeConfig["media"]> = {},
): WorkerRuntimeConfig {
  return {
    bindHost: "127.0.0.1",
    port,
    dataDirectory,
    control: { currentKeyId: FAKE_KEY_ID, currentSecret: FAKE_SECRET },
    r2: {
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "videofetch-temp",
      jurisdiction: "default",
      brokerSocketPath: "/run/videofetch-r2-broker/broker.sock",
    },
    media: {
      maxFileSizeBytes: 500 * 1024 * 1024,
      maxVideoDurationSeconds: 7200,
      fileExpirationMinutes: 45,
      downloadTimeLimitSeconds: 600,
      processingTimeoutSeconds: 600,
      uploadTimeoutSeconds: 3600,
      analysisTimeoutSeconds: 45,
      maxRedirects: 5,
      ytdlp: { enabled: false },
      tempDirectory: null,
      ffmpegPath: null,
      ...media,
    },
  };
}

/** A direct source advertising ONE mp3 preset: acquisition, then one processing stage. */
function mp3Metadata(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "Limits Clip",
    thumbnail: null,
    duration: null,
    source: "cdn.example",
    extractor: "direct",
    webpageUrl: MEDIA_URL,
    formats: [
      {
        id: "direct-original",
        resolution: "unknown",
        width: null,
        height: null,
        fps: null,
        container: "mp4",
        videoCodec: "unknown",
        audioCodec: "unknown",
        bitrate: null,
        fileSize: 8,
        hasVideo: true,
        hasAudio: true,
        formatNote: null,
      },
    ],
    presets: [
      {
        id: "preset:mp3",
        label: "MP3",
        resolution: "audio",
        container: "mp3",
        fileSize: null,
        hasVideo: false,
        hasAudio: true,
        formatId: "preset:mp3",
        videoCodec: null,
        audioCodec: "unknown",
        fps: null,
      },
    ],
    capabilities: { mp3: true, merge: true },
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("WorkerTimeLimits: built once by the runtime and handed to every stage", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worker-time-limits-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds the model from the strict configuration and hands it to the executor", async () => {
    const runtime = await createWorkerRuntime(
      makeConfig(join(root, "state"), await reservePort(), {
        downloadTimeLimitSeconds: 1234,
        processingTimeoutSeconds: 2345,
      }),
      { objectStoreWriter: new MemoryWriter() },
    );
    try {
      assert.deepEqual(
        { ...runtime.timeLimits },
        {
          analysisMs: 45_000,
          downloadTimeLimitMs: 1_234_000,
          processingMs: 2_345_000,
          uploadMs: 3_600_000,
          retentionMs: 2_700_000,
          // L follows the configured stage limits: 45 + 1234 + 2345 + 3600 + 600 s.
          executionLifetimeMs: 7_824_000,
        },
      );
      assert.ok(Object.isFrozen(runtime.timeLimits));
      // The executor keeps exactly the three stage limits — since LD-2b the
      // upload stage's too — and never a lifetime.
      assert.deepEqual(
        { ...runtime.executor.timeLimits },
        { downloadTimeLimitMs: 1_234_000, processingMs: 2_345_000, uploadMs: 3_600_000 },
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("a job's acquisition receives DOWNLOAD_TIME_LIMIT and its processing receives PROCESSING_TIMEOUT", async () => {
    const seen = { downloadTimeLimitMs: [] as number[], processingTimeoutMs: [] as number[] };
    const runtime = await createWorkerRuntime(
      makeConfig(join(root, "state"), await reservePort(), {
        downloadTimeLimitSeconds: 1234,
        processingTimeoutSeconds: 2345,
      }),
      {
        objectStoreWriter: new MemoryWriter(),
        executorDeps: {
          analyze: async () => mp3Metadata(),
          availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
          downloadOriginal: async (_url, ctx) => {
            seen.downloadTimeLimitMs.push(ctx.downloadTimeLimitMs);
            const filePath = join(ctx.workDir, "source.mp4");
            await writeFile(filePath, "ORIGINAL");
            return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
          },
          processLocally: async (opts) => {
            seen.processingTimeoutMs.push(opts.timeoutMs);
            const out = join(opts.workDir, `converted.${opts.target}`);
            await writeFile(out, "MP3-BYTES");
            return out;
          },
        },
      },
    );
    try {
      const created = runtime.store.createJob(
        { url: MEDIA_URL, formatId: "preset:mp3", principalId: "private-access-user" },
        randomUUID(),
      );
      assert.equal(created.type, "created");
      const jobId = created.type === "created" ? created.job.jobId : "";
      runtime.wakeQueue();
      await waitFor(() => runtime.store.getJob(jobId)?.status === "ready", "the mp3 job to complete");
      assert.deepEqual(seen.downloadTimeLimitMs, [1_234_000], "acquisition: DOWNLOAD_TIME_LIMIT, never processing");
      assert.deepEqual(seen.processingTimeoutMs, [2_345_000], "processing: PROCESSING_TIMEOUT, never acquisition");
    } finally {
      await runtime.shutdown();
    }
  });

  it("hands the store the derived L, so a queued job's expiry follows the stage limits, not the retention", async () => {
    // LD-1 left the creation-based TTL alone; LD-2a replaces it with `L`.
    const FIXED_NOW = 1_800_000_000_000;
    const runtime = await createWorkerRuntime(
      makeConfig(join(root, "state"), await reservePort(), {
        downloadTimeLimitSeconds: 21_600,
        processingTimeoutSeconds: 14_400,
        fileExpirationMinutes: 7,
      }),
      { objectStoreWriter: new MemoryWriter(), clock: () => FIXED_NOW },
    );
    try {
      const created = runtime.store.createJob(
        { url: MEDIA_URL, formatId: "preset:mp3", principalId: "private-access-user" },
        randomUUID(),
      );
      const job = created.type === "created" ? created.job : null;
      assert.ok(job);
      assert.equal(job.createdAt, FIXED_NOW);
      assert.equal(job.expiresAt - job.createdAt, (45 + 21_600 + 14_400 + 3_600 + 600) * 1000);
      assert.equal(job.expiresAt - job.createdAt, runtime.timeLimits.executionLifetimeMs);
      assert.notEqual(job.expiresAt - job.createdAt, 7 * 60_000, "the retention is for terminal outcomes only");
    } finally {
      await runtime.shutdown();
    }
  });

  for (const [label, media, field] of [
    ["an acquisition limit below its range", { downloadTimeLimitSeconds: 59 }, "downloadTimeLimitSeconds"],
    ["an upload limit below its range", { uploadTimeoutSeconds: 299 }, "uploadTimeoutSeconds"],
    ["an upload limit above its range", { uploadTimeoutSeconds: 14_401 }, "uploadTimeoutSeconds"],
    ["a retention past the R2 backstop margin", { fileExpirationMinutes: 56 }, "fileExpirationMinutes"],
    ["the pre-LD-2a retention maximum", { fileExpirationMinutes: 1440 }, "fileExpirationMinutes"],
    ["an analysis limit of zero", { analysisTimeoutSeconds: 0 }, "analysisTimeoutSeconds"],
  ] as const) {
    it(`refuses ${label} before touching the state directory`, async () => {
      const dataDirectory = join(root, "never-created");
      await assert.rejects(
        createWorkerRuntime(makeConfig(dataDirectory, await reservePort(), media), {
          objectStoreWriter: new MemoryWriter(),
        }),
        BAD_FIELD(field),
      );
      await assert.rejects(stat(dataDirectory), { code: "ENOENT" });
    });
  }

  it("cannot be overridden through an executor test seam: the configuration is the one owner", async () => {
    const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: new MemoryWriter(),
      // Refused by the type; a JavaScript caller passing it anyway is ignored.
      executorDeps: { timeLimits: { downloadTimeLimitMs: 1, processingMs: 1, uploadMs: 1 } } as never,
    });
    try {
      assert.deepEqual(
        { ...runtime.executor.timeLimits },
        { downloadTimeLimitMs: 600_000, processingMs: 600_000, uploadMs: 3_600_000 },
      );
    } finally {
      await runtime.shutdown();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The retired variable blocks startup, end to end, by name only
// ─────────────────────────────────────────────────────────────────────────────

describe("startup refuses the retired DOWNLOAD_TIMEOUT by presence", () => {
  function validEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      WORKER_DATA_DIRECTORY: "/var/lib/videofetch-ld1-never-created",
      WORKER_CONTROL_KEY_ID: "worker-control-1",
      WORKER_CONTROL_SECRET: FAKE_SECRET,
      R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      R2_BUCKET: "videofetch-temp",
      R2_BROKER_SOCKET_PATH: "/run/videofetch-r2-broker/broker.sock",
      ...extra,
    };
  }

  async function start(env: NodeJS.ProcessEnv) {
    const errors: string[] = [];
    const logs: string[] = [];
    let exitCode: number | null = null;
    let workspaceChecks = 0;
    const runtime = await startWorker({
      env,
      log: (line) => logs.push(line),
      logError: (line) => errors.push(line),
      setExitCode: (code) => {
        exitCode = code;
      },
      onSignal: () => {},
      verifyMediaWorkspace: async () => {
        workspaceChecks += 1;
        // Stops a CONFIG-VALID start here, before any directory is created.
        throw new Error("positive-control stop");
      },
    });
    return { runtime, errors, logs, exitCode, workspaceChecks };
  }

  for (const value of ["600", "", "   ", "\t", "9000", "SENTINEL-DOWNLOAD-TIMEOUT-VALUE"]) {
    it(`DOWNLOAD_TIMEOUT=${JSON.stringify(value)} blocks startup before the workspace check, naming only the variable`, async () => {
      const run = await start(validEnv({ DOWNLOAD_TIMEOUT: value }));
      assert.equal(run.runtime, null);
      assert.equal(run.exitCode, 1);
      assert.equal(run.workspaceChecks, 0, "nothing past configuration ran");
      assert.deepEqual(run.errors, ["[worker] startup blocked: invalid configuration for DOWNLOAD_TIMEOUT"]);
      assert.deepEqual(run.logs, []);
      if (value.trim().length > 0) {
        assert.equal(run.errors.join("\n").includes(value), false, "the value is never rendered");
      }
    });
  }

  it("is refused alongside a valid DOWNLOAD_TIME_LIMIT: no alias, no precedence", async () => {
    const run = await start(validEnv({ DOWNLOAD_TIMEOUT: "600", DOWNLOAD_TIME_LIMIT: "600" }));
    assert.equal(run.runtime, null);
    assert.deepEqual(run.errors, ["[worker] startup blocked: invalid configuration for DOWNLOAD_TIMEOUT"]);
  });

  it("positive control: the same environment without it passes configuration", async () => {
    const run = await start(validEnv({ DOWNLOAD_TIME_LIMIT: "600", PROCESSING_TIMEOUT: "600" }));
    assert.equal(run.runtime, null);
    assert.equal(run.workspaceChecks, 1, "configuration accepted; the stub stopped the start");
    assert.deepEqual(run.errors, ["[worker] startup failed: Error"]);
  });

  // VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001: the two LD-2a ranges block
  // startup end to end, before the workspace check, naming only the variable.
  for (const [name, value] of [
    ["FILE_EXPIRATION_MINUTES", "0"],
    ["FILE_EXPIRATION_MINUTES", "56"],
    ["FILE_EXPIRATION_MINUTES", "60"],
    ["FILE_EXPIRATION_MINUTES", "1440"],
    ["UPLOAD_TIMEOUT", "299"],
    ["UPLOAD_TIMEOUT", "14401"],
    ["UPLOAD_TIMEOUT", "SENTINEL-UPLOAD-TIMEOUT-VALUE"],
  ] as const) {
    it(`${name}=${JSON.stringify(value)} blocks startup before the workspace check, naming only the variable`, async () => {
      const run = await start(validEnv({ [name]: value }));
      assert.equal(run.runtime, null);
      assert.equal(run.exitCode, 1);
      assert.equal(run.workspaceChecks, 0, "nothing past configuration ran");
      assert.deepEqual(run.errors, [`[worker] startup blocked: invalid configuration for ${name}`]);
      assert.equal(run.errors.join("\n").includes(value), false, "the value is never rendered");
    });
  }

  it("positive control: the LD-2a range ends pass configuration", async () => {
    for (const env of [
      { FILE_EXPIRATION_MINUTES: "55", UPLOAD_TIMEOUT: "300" },
      { FILE_EXPIRATION_MINUTES: "1", UPLOAD_TIMEOUT: "14400" },
    ]) {
      const run = await start(validEnv(env));
      assert.equal(run.workspaceChecks, 1, JSON.stringify(env));
      assert.deepEqual(run.errors, ["[worker] startup failed: Error"]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001: the upload stage's ONE
// absolute deadline
// ─────────────────────────────────────────────────────────────────────────────

describe("LD-2b: deriveUploadStageDeadlineMs — one absolute upload deadline", () => {
  const START = 1_800_000_000_000;

  it("is the uploading transition plus UPLOAD_TIMEOUT when the execution deadline is later", () => {
    assert.equal(
      deriveUploadStageDeadlineMs({ stageStartedAtMs: START, uploadMs: 3_600_000, executionDeadlineMs: START + 5_000_000 }),
      START + 3_600_000,
    );
  });

  it("never outlives the job: an earlier execution deadline wins", () => {
    assert.equal(
      deriveUploadStageDeadlineMs({ stageStartedAtMs: START, uploadMs: 3_600_000, executionDeadlineMs: START + 60_000 }),
      START + 60_000,
    );
    // An execution deadline already behind the stage start yields a deadline
    // already passed: the stage refuses to start anything.
    assert.equal(
      deriveUploadStageDeadlineMs({ stageStartedAtMs: START, uploadMs: 3_600_000, executionDeadlineMs: START - 1 }),
      START - 1,
    );
  });

  it("at the defaults, a job reaching upload at minute 21 gets the full hour, inside L = 5,445 s", () => {
    const claimed = START;
    const executionDeadlineMs = claimed + DEFAULT_WORKER_TIME_LIMITS.executionLifetimeMs;
    const uploadingAt = claimed + 21 * 60_000;
    assert.equal(
      deriveUploadStageDeadlineMs({
        stageStartedAtMs: uploadingAt,
        uploadMs: DEFAULT_WORKER_TIME_LIMITS.uploadMs,
        executionDeadlineMs,
      }),
      uploadingAt + 3_600_000,
    );
    assert.equal(DEFAULT_WORKER_TIME_LIMITS.uploadMs, 3_600_000, "UPLOAD_TIMEOUT's default is unchanged");
    assert.equal(DEFAULT_WORKER_TIME_LIMITS.executionLifetimeMs, 5_445_000, "the LD-2a derivation of L is unchanged");
  });

  it("is computed from inputs alone: the same inputs give the same deadline, whenever it is asked", () => {
    const input = { stageStartedAtMs: START, uploadMs: 300_000, executionDeadlineMs: START + 900_000 };
    assert.equal(deriveUploadStageDeadlineMs(input), deriveUploadStageDeadlineMs({ ...input }));
  });

  it("accepts the strict loader's whole range and an injected narrower budget", () => {
    for (const uploadMs of [1, 300_000, 3_600_000, 14_400_000]) {
      assert.equal(
        deriveUploadStageDeadlineMs({ stageStartedAtMs: START, uploadMs, executionDeadlineMs: START + 20_000_000 }),
        START + uploadMs,
      );
    }
  });

  for (const [label, input, field] of [
    ["a zero budget", { stageStartedAtMs: START, uploadMs: 0, executionDeadlineMs: START + 1 }, "uploadMs"],
    ["a negative budget", { stageStartedAtMs: START, uploadMs: -1, executionDeadlineMs: START + 1 }, "uploadMs"],
    ["a fractional budget", { stageStartedAtMs: START, uploadMs: 1.5, executionDeadlineMs: START + 1 }, "uploadMs"],
    ["a budget wider than configurable", { stageStartedAtMs: START, uploadMs: 14_400_001, executionDeadlineMs: START + 1 }, "uploadMs"],
    ["a NaN budget", { stageStartedAtMs: START, uploadMs: Number.NaN, executionDeadlineMs: START + 1 }, "uploadMs"],
    ["a string budget", { stageStartedAtMs: START, uploadMs: "3600000", executionDeadlineMs: START + 1 }, "uploadMs"],
    ["a negative stage start", { stageStartedAtMs: -1, uploadMs: 1, executionDeadlineMs: START }, "stageStartedAtMs"],
    ["an unsafe stage start", { stageStartedAtMs: Number.MAX_SAFE_INTEGER + 2, uploadMs: 1, executionDeadlineMs: START }, "stageStartedAtMs"],
    ["a stage start whose sum overflows", { stageStartedAtMs: Number.MAX_SAFE_INTEGER, uploadMs: 1, executionDeadlineMs: START }, "stageStartedAtMs"],
    ["an infinite execution deadline", { stageStartedAtMs: START, uploadMs: 1, executionDeadlineMs: Number.POSITIVE_INFINITY }, "executionDeadlineMs"],
    ["a missing execution deadline", { stageStartedAtMs: START, uploadMs: 1, executionDeadlineMs: undefined }, "executionDeadlineMs"],
  ] as const) {
    it(`refuses ${label}, naming the field and never the value`, () => {
      assert.throws(
        () => deriveUploadStageDeadlineMs(input as unknown as Parameters<typeof deriveUploadStageDeadlineMs>[0]),
        (err: unknown) => {
          assert.ok(err instanceof WorkerTimeLimitsError);
          assert.equal(err.field, field);
          assert.equal(err.message, `Invalid Worker time limit: ${field}`);
          return true;
        },
      );
    });
  }
});
