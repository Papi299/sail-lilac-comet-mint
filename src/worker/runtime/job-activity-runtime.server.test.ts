import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";
import { WorkerService } from "../http/business-service.server.ts";
import type { ObjectStoreHead, ObjectStorePutInput, ObjectStoreWriter } from "../storage/writer.ts";
import { WorkerRuntimeConfigError, loadWorkerRuntimeConfig, type WorkerRuntimeConfig } from "./config.server.ts";
import { createWorkerRuntime, type WorkerRuntime } from "./runtime.server.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the Worker
 * publishes the job-status `activity` field ONLY when the operator's validated
 * `JOB_STATUS_ACTIVITY_ENABLED` says so. A control plane that predates the
 * field refuses any status carrying it, so the default — and every value that
 * is not exactly "true" — keeps the status body exactly as before.
 */

const BASE_ENV = Object.freeze({
  WORKER_DATA_DIRECTORY: "/var/lib/videofetch-ld4b-never-created",
  WORKER_CONTROL_KEY_ID: "worker-control-1",
  WORKER_CONTROL_SECRET: "0123456789abcdef0123456789abcdef",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET: "videofetch-temp",
  R2_BROKER_SOCKET_PATH: "/run/videofetch-r2-broker/broker.sock",
});

const load = (extra: Record<string, string | undefined>) => loadWorkerRuntimeConfig({ ...BASE_ENV, ...extra });

class MemoryWriter implements ObjectStoreWriter {
  async put(input: ObjectStorePutInput): Promise<void> {
    for await (const _piece of input.body) {
      // drained
    }
  }
  async head(_objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    return null;
  }
  async delete(_objectKey: WorkerObjectKey): Promise<void> {}
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

let root = "";
const runtimes: WorkerRuntime[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ld4b-runtime-"));
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    try {
      await runtime.shutdown();
    } catch {
      /* already shut down */
    }
  }
  await rm(root, { recursive: true, force: true });
});

/** The exact Production call — `createWorkerRuntime(config)` — on a loaded configuration, relocated to a test directory. */
async function production(config: WorkerRuntimeConfig, overrides: Parameters<typeof createWorkerRuntime>[1] = {}) {
  const runtime = await createWorkerRuntime(
    { ...config, dataDirectory: join(root, `state-${randomUUID()}`), bindHost: "127.0.0.1", port: await reservePort() },
    { objectStoreWriter: new MemoryWriter(), ...overrides },
  );
  runtimes.push(runtime);
  return runtime;
}

function queued(runtime: WorkerRuntime): string {
  const created = runtime.store.createJob(
    { url: "https://cdn.example/clip.mp4", formatId: "direct-original", principalId: "private-access-user" },
    randomUUID(),
  );
  assert.equal(created.type, "created");
  return created.type === "created" ? created.job.jobId : "";
}

describe("JOB_STATUS_ACTIVITY_ENABLED: the strict loader owns it", () => {
  it("absent, empty or whitespace-only is off: the default publishes nothing", () => {
    assert.deepEqual(load({}).jobStatus, { activityEnabled: false });
    assert.deepEqual(load({ JOB_STATUS_ACTIVITY_ENABLED: "" }).jobStatus, { activityEnabled: false });
    assert.deepEqual(load({ JOB_STATUS_ACTIVITY_ENABLED: "   " }).jobStatus, { activityEnabled: false });
  });

  it('exactly "true" or "false" (surrounding whitespace tolerated)', () => {
    assert.equal(load({ JOB_STATUS_ACTIVITY_ENABLED: "true" }).jobStatus?.activityEnabled, true);
    assert.equal(load({ JOB_STATUS_ACTIVITY_ENABLED: " true\n" }).jobStatus?.activityEnabled, true);
    assert.equal(load({ JOB_STATUS_ACTIVITY_ENABLED: "false" }).jobStatus?.activityEnabled, false);
  });

  it("every other spelling is a startup failure that names the variable and never its value", () => {
    for (const value of ["TRUE", "True", "1", "0", "yes", "on", "enabled", "true false", "tru"]) {
      assert.throws(
        () => load({ JOB_STATUS_ACTIVITY_ENABLED: value }),
        (err: unknown) => {
          assert.ok(err instanceof WorkerRuntimeConfigError, value);
          assert.deepEqual([...err.variables], ["JOB_STATUS_ACTIVITY_ENABLED"], value);
          assert.equal(err.message.includes(value) && value.length > 2, false, "the value is not echoed");
          return true;
        },
      );
    }
  });

  it("leaves every other setting exactly as before", () => {
    const off = load({});
    const on = load({ JOB_STATUS_ACTIVITY_ENABLED: "true" });
    assert.deepEqual({ ...on, jobStatus: undefined }, { ...off, jobStatus: undefined });
    assert.equal(on.media.downloadTimeLimitSeconds, 600, "the absolute limit keeps its 600 s default");
    assert.equal(on.media.downloadInactivityTimeoutSeconds, 120, "and the window its 120 s");
  });
});

describe("the real composition root carries it to the job status, and nothing else can", () => {
  it("the Production default: a status has NO `activity` key", async () => {
    const runtime = await production(load({}));
    const body = await runtime.service.getJob(queued(runtime));
    assert.equal("activity" in body.job, false);
    assert.equal(JSON.stringify(body).includes("activity"), false);
  });

  it('with "true": every status states it (null while nothing is observed)', async () => {
    const runtime = await production(load({ JOB_STATUS_ACTIVITY_ENABLED: "true" }));
    const body = await runtime.service.getJob(queued(runtime));
    assert.equal(body.job.activity, null);
  });

  it("no runtime override can switch it on", async () => {
    const runtime = await production(load({}), {
      publishJobActivity: true,
      jobStatus: { activityEnabled: true },
      executorDeps: { publishJobActivity: true },
    } as never);
    const body = await runtime.service.getJob(queued(runtime));
    assert.equal("activity" in body.job, false);
  });

  it("a configuration written out by hand without the key is off", async () => {
    const config = load({ JOB_STATUS_ACTIVITY_ENABLED: "true" });
    const { jobStatus: _ignored, ...withoutKey } = config;
    const runtime = await production(withoutKey as WorkerRuntimeConfig);
    const body = await runtime.service.getJob(queued(runtime));
    assert.equal("activity" in body.job, false);
  });

  it("the service itself treats anything but exactly `true` as off", async () => {
    const runtime = await production(load({}));
    const jobId = queued(runtime);
    for (const forged of ["true", 1, {}, "yes"]) {
      const service = new WorkerService({
        store: runtime.store,
        executor: runtime.executor,
        pump: runtime.pump,
        publishJobActivity: forged as never,
      });
      const body = await service.getJob(jobId);
      assert.equal("activity" in body.job, false, JSON.stringify(forged));
    }
  });

  it("a downloading job's durable progress is never turned into activity: no watched acquisition, no activity", async () => {
    const runtime = await production(load({ JOB_STATUS_ACTIVITY_ENABLED: "true" }));
    const jobId = queued(runtime);
    assert.equal(runtime.store.claimNextQueuedJob()?.jobId, jobId);
    assert.equal(
      runtime.store.completeAnalysis(jobId, { title: "Clip", thumbnail: null, source: "cdn.example", extractor: "direct" }).type,
      "updated",
    );
    assert.equal(
      runtime.store.updateExecutionProgress(jobId, "downloading", {
        progress: 64,
        downloadedBytes: 1_000_000,
        totalBytes: 2_000_000,
        speed: 0,
        eta: 9_999,
        stageLabel: "Downloading",
      }).type,
      "updated",
    );
    const body = await runtime.service.getJob(jobId);
    assert.equal(body.job.status, "downloading");
    assert.equal(body.job.progress, 64);
    assert.equal(body.job.activity, null, "a percentage, a zero speed and a long ETA say nothing about the source");
  });

  it("the composition passes the validated value and nothing else (one line, from configuration)", () => {
    const source = readFileSync(new URL("./runtime.server.ts", import.meta.url), "utf8");
    const lines = source.split("\n").filter((line) => line.includes("publishJobActivity"));
    assert.deepEqual(lines.map((line) => line.trim()), ["publishJobActivity: config.jobStatus?.activityEnabled === true,"]);
  });
});
