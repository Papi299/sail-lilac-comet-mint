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
  DEFAULT_WORKER_TIME_LIMITS,
  DOWNLOAD_TIME_LIMIT_SECONDS,
  PROCESSING_TIMEOUT_SECONDS,
  WorkerTimeLimitsError,
  assertWorkerTimeLimits,
  buildWorkerTimeLimits,
} from "./time-limits.ts";

/**
 * VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001: the stage time-limit model, its one
 * construction point in the runtime, and the startup refusal of the retired
 * `DOWNLOAD_TIMEOUT`.
 *
 * Every value here is a fake. No network, no real media and no real R2.
 */

const BAD_FIELD = (field: string) => (err: unknown) => {
  assert.ok(err instanceof WorkerTimeLimitsError, String(err));
  assert.equal(err.field, field);
  return true;
};

describe("WorkerTimeLimits: the model", () => {
  it("states the approved ranges and the LD-1 defaults", () => {
    assert.deepEqual({ ...DOWNLOAD_TIME_LIMIT_SECONDS }, { min: 60, max: 21_600, default: 600 });
    assert.deepEqual({ ...PROCESSING_TIMEOUT_SECONDS }, { min: 60, max: 14_400, default: 600 });
    assert.ok(Object.isFrozen(DOWNLOAD_TIME_LIMIT_SECONDS));
    assert.ok(Object.isFrozen(PROCESSING_TIMEOUT_SECONDS));
  });

  it("keeps the 600 s acquisition default: long downloads are NOT enabled by LD-1", () => {
    assert.deepEqual({ ...DEFAULT_WORKER_TIME_LIMITS }, { downloadTimeLimitMs: 600_000, processingMs: 600_000 });
    assert.notEqual(DEFAULT_WORKER_TIME_LIMITS.downloadTimeLimitMs, 9_000_000, "LD-5b, not LD-1");
    assert.ok(Object.isFrozen(DEFAULT_WORKER_TIME_LIMITS));
  });

  it("builds a frozen model of exactly the two LD-1 fields, in milliseconds", () => {
    const limits = buildWorkerTimeLimits({ downloadTimeLimitSeconds: 1234, processingTimeoutSeconds: 2345 });
    assert.deepEqual(Object.keys(limits).sort(), ["downloadTimeLimitMs", "processingMs"]);
    assert.equal(limits.downloadTimeLimitMs, 1_234_000);
    assert.equal(limits.processingMs, 2_345_000);
    assert.ok(Object.isFrozen(limits));
    assert.throws(() => {
      (limits as { downloadTimeLimitMs: number }).downloadTimeLimitMs = 1;
    }, TypeError);
    // No stage-anonymous field, and none of the later phases' fields yet.
    for (const absent of ["timeoutMs", "inactivityMs", "uploadMs", "retentionMs", "executionLifetimeMs"]) {
      assert.equal(Object.hasOwn(limits, absent), false, absent);
    }
  });

  it("keeps acquisition and processing independent of each other", () => {
    const a = buildWorkerTimeLimits({ downloadTimeLimitSeconds: 21_600, processingTimeoutSeconds: 60 });
    assert.deepEqual({ ...a }, { downloadTimeLimitMs: 21_600_000, processingMs: 60_000 });
    const b = buildWorkerTimeLimits({ downloadTimeLimitSeconds: 60, processingTimeoutSeconds: 14_400 });
    assert.deepEqual({ ...b }, { downloadTimeLimitMs: 60_000, processingMs: 14_400_000 });
  });

  it("accepts each range end and refuses one beyond it", () => {
    for (const s of [60, 61, 600, 9000, 21_599, 21_600]) {
      assert.equal(
        buildWorkerTimeLimits({ downloadTimeLimitSeconds: s, processingTimeoutSeconds: 600 }).downloadTimeLimitMs,
        s * 1000,
      );
    }
    for (const s of [60, 14_400]) {
      assert.equal(
        buildWorkerTimeLimits({ downloadTimeLimitSeconds: 600, processingTimeoutSeconds: s }).processingMs,
        s * 1000,
      );
    }
    for (const s of [59, 21_601, 0]) {
      assert.throws(
        () => buildWorkerTimeLimits({ downloadTimeLimitSeconds: s, processingTimeoutSeconds: 600 }),
        BAD_FIELD("downloadTimeLimitSeconds"),
      );
    }
    for (const s of [59, 14_401, 0]) {
      assert.throws(
        () => buildWorkerTimeLimits({ downloadTimeLimitSeconds: 600, processingTimeoutSeconds: s }),
        BAD_FIELD("processingTimeoutSeconds"),
      );
    }
  });

  it("refuses non-integers, non-finite, unsafe and non-number values, naming the field only", () => {
    const bad: unknown[] = [
      -1,
      600.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "600",
      null,
      undefined,
      987_654_321,
    ];
    for (const value of bad) {
      assert.throws(
        () =>
          buildWorkerTimeLimits({
            downloadTimeLimitSeconds: value as number,
            processingTimeoutSeconds: 600,
          }),
        (err: unknown) => {
          BAD_FIELD("downloadTimeLimitSeconds")(err);
          // The exact message: the field, and never the value.
          assert.equal((err as Error).message, "Invalid Worker time limit: downloadTimeLimitSeconds");
          return true;
        },
      );
    }
  });

  it("validates an INJECTED model: narrower is allowed, malformed or wider is refused", () => {
    // Narrower than the environment minimum: tests and harnesses prove a
    // shared deadline with a few milliseconds.
    assert.deepEqual({ ...assertWorkerTimeLimits({ downloadTimeLimitMs: 60, processingMs: 1 }) }, {
      downloadTimeLimitMs: 60,
      processingMs: 1,
    });
    // The environment maximum is the ceiling an injection can never lift.
    assert.ok(assertWorkerTimeLimits({ downloadTimeLimitMs: 21_600_000, processingMs: 14_400_000 }));
    assert.throws(
      () => assertWorkerTimeLimits({ downloadTimeLimitMs: 21_600_001, processingMs: 1 }),
      BAD_FIELD("downloadTimeLimitMs"),
    );
    assert.throws(
      () => assertWorkerTimeLimits({ downloadTimeLimitMs: 1, processingMs: 14_400_001 }),
      BAD_FIELD("processingMs"),
    );
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "600000", null, undefined]) {
      assert.throws(
        () => assertWorkerTimeLimits({ downloadTimeLimitMs: bad, processingMs: 600_000 }),
        BAD_FIELD("downloadTimeLimitMs"),
      );
      assert.throws(
        () => assertWorkerTimeLimits({ downloadTimeLimitMs: 600_000, processingMs: bad }),
        BAD_FIELD("processingMs"),
      );
    }
    for (const notAModel of [null, undefined, "600000", 600_000]) {
      assert.throws(() => assertWorkerTimeLimits(notAModel), BAD_FIELD("timeLimits"));
    }
  });

  it("returns a frozen COPY of exactly the two fields, never the caller's object", () => {
    const injected = { downloadTimeLimitMs: 1_000, processingMs: 2_000, uploadMs: 3_000 };
    const model = assertWorkerTimeLimits(injected);
    assert.notEqual(model, injected);
    assert.deepEqual(Object.keys(model).sort(), ["downloadTimeLimitMs", "processingMs"]);
    assert.ok(Object.isFrozen(model));
    injected.downloadTimeLimitMs = 9;
    assert.equal(model.downloadTimeLimitMs, 1_000, "a later mutation of the input cannot reach the model");
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
      assert.deepEqual({ ...runtime.timeLimits }, { downloadTimeLimitMs: 1_234_000, processingMs: 2_345_000 });
      assert.ok(Object.isFrozen(runtime.timeLimits));
      assert.deepEqual({ ...runtime.executor.timeLimits }, { ...runtime.timeLimits });
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

  it("leaves job expiry exactly as it was: created + FILE_EXPIRATION_MINUTES, whatever the stage limits", async () => {
    // LD-1 changes no lifetime: the creation-based TTL is LD-2a's to redesign.
    const FIXED_NOW = 1_800_000_000_000;
    const runtime = await createWorkerRuntime(
      makeConfig(join(root, "state"), await reservePort(), {
        downloadTimeLimitSeconds: 21_600,
        processingTimeoutSeconds: 14_400,
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
      assert.equal(job.expiresAt - job.createdAt, 45 * 60_000);
    } finally {
      await runtime.shutdown();
    }
  });

  it("refuses a model the loader could not express before touching the state directory", async () => {
    const dataDirectory = join(root, "never-created");
    await assert.rejects(
      createWorkerRuntime(
        makeConfig(dataDirectory, await reservePort(), { downloadTimeLimitSeconds: 59 }),
        { objectStoreWriter: new MemoryWriter() },
      ),
      BAD_FIELD("downloadTimeLimitSeconds"),
    );
    await assert.rejects(stat(dataDirectory), { code: "ENOENT" });
  });

  it("cannot be overridden through an executor test seam: the configuration is the one owner", async () => {
    const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), await reservePort()), {
      objectStoreWriter: new MemoryWriter(),
      // Refused by the type; a JavaScript caller passing it anyway is ignored.
      executorDeps: { timeLimits: { downloadTimeLimitMs: 1, processingMs: 1 } } as never,
    });
    try {
      assert.deepEqual({ ...runtime.executor.timeLimits }, { downloadTimeLimitMs: 600_000, processingMs: 600_000 });
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
});
