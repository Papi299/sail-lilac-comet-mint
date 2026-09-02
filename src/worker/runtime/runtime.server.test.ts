import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../lib/errors.ts";
import type { WorkerVideoMetadata, WorkerObjectKey } from "../../shared/worker/contracts.ts";
import { WorkerClient } from "../../web/worker/worker-client.server.ts";
import { openWorkerDatabase } from "../state/database.server.ts";
import type {
  ObjectStoreHead,
  ObjectStorePutInput,
  ObjectStoreWriter,
} from "../storage/writer.ts";
import {
  CloudflareR2ObjectStoreWriter,
  type CloudflareR2Config,
  type S3SendClient,
} from "../storage/cloudflare-r2-writer.server.ts";
import type { R2CredentialProvider } from "../storage/credential-provider.ts";
import type { WorkerRuntimeConfig } from "./config.server.ts";
import { createWorkerRuntime, type WorkerRuntime } from "./runtime.server.ts";
import { WORKER_DATABASE_FILENAME } from "./state-directory.server.ts";

/**
 * Real local Worker runtime composition (§35/§36/§37).
 *
 * Real strict config, a real temporary persistent directory, a real on-disk
 * SQLite database (never `:memory:`), real migrations, real recovery, a real
 * replay store, the real authenticated HTTP server, and the real
 * QueuePump/QueueRunner/JobExecutor wiring.
 *
 * The object store is the ONLY faked seam, because it is the only place a
 * network request would otherwise occur. No internet is used anywhere here.
 */

const FAKE_KEY_ID = "worker-control-test";
const FAKE_SECRET = "0123456789abcdef0123456789abcdef";
const MEDIA_URL = "https://cdn.example/clip.mp4";
const FORMAT_ID = "direct-original";

function metadata(): WorkerVideoMetadata {
  return {
    title: "Runtime Clip",
    thumbnail: null,
    duration: 12,
    source: "cdn.example",
    extractor: "direct",
    webpageUrl: MEDIA_URL,
    formats: [
      {
        id: FORMAT_ID,
        resolution: "1280x720",
        width: 1280,
        height: 720,
        fps: null,
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        bitrate: null,
        fileSize: null,
        hasVideo: true,
        hasAudio: true,
      },
    ],
    presets: [],
    capabilities: { mp3: false, merge: false },
  };
}

/** In-memory object store. Never uploads, never reaches a network. */
class MemoryWriter implements ObjectStoreWriter {
  public readonly objects = new Map<string, ObjectStoreHead>();
  public readonly deleted: string[] = [];

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
    this.deleted.push(objectKey);
    this.objects.delete(objectKey);
  }
}

/** Reserves a concrete free port: the strict config forbids port 0. */
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

/**
 * A deterministic stand-in for the trusted broker.
 *
 * It opens no socket and holds no parent secret — it only proves that the
 * runtime asks for a credential per operation and uses what it is handed.
 */
function fakeCredentials(
  record?: Array<{ action: string; objectKey: string; ttlSeconds: number }>,
): R2CredentialProvider {
  return {
    async mint(request) {
      record?.push({
        action: request.action,
        objectKey: request.objectKey,
        ttlSeconds: request.ttlSeconds,
      });
      return {
        accessKeyId: "fake-delegated-access-key-id",
        secretAccessKey: "fake-delegated-secret-access-key",
        sessionToken: "fake-delegated-session-token",
        expiresAt: Date.now() + 120_000,
      };
    },
  };
}

/**
 * Builds the REAL `CloudflareR2ObjectStoreWriter` for each delegated
 * operation, with only its S3 send-client replaced. Every command therefore
 * travels the real writer's code path and is counted rather than dispatched.
 */
function delegatedWriterFactory(
  client: S3SendClient,
): (config: CloudflareR2Config) => ObjectStoreWriter {
  return (config) => new CloudflareR2ObjectStoreWriter(config, client);
}

function makeConfig(
  dataDirectory: string,
  port: number,
  mediaOverrides: Partial<WorkerRuntimeConfig["media"]> = {},
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
      // A socket path, never a credential. The Worker cannot be configured
      // with an R2 parent secret at all.
      brokerSocketPath: "/run/videofetch-r2-broker/broker.sock",
    },
    media: {
      maxFileSizeBytes: 500 * 1024 * 1024,
      maxVideoDurationSeconds: 7200,
      fileExpirationMinutes: 45,
      downloadTimeoutSeconds: 600,
      analysisTimeoutSeconds: 45,
      maxRedirects: 5,
      ytdlp: { enabled: false },
      tempDirectory: null,
      ffmpegPath: null,
      ...mediaOverrides,
    },
  };
}

/** Media fakes that complete the keep-original path without any network. */
function mediaDeps(record?: { analyzed: string[]; downloaded: string[] }) {
  return {
    analyze: async (url: string) => {
      record?.analyzed.push(url);
      return metadata();
    },
    downloadOriginal: async (
      url: string,
      ctx: { workDir: string; signal?: AbortSignal; onProgress?: (u: any) => void },
    ) => {
      record?.downloaded.push(url);
      const filePath = join(ctx.workDir, "original.mp4");
      await writeFile(filePath, "RUNTIME-MEDIA-BYTES");
      ctx.onProgress?.({ progress: 100, downloadedBytes: 19, totalBytes: 19 });
      return { filePath, container: "mp4", mime: "video/mp4", fileSize: 19 };
    },
    processLocally: async () => {
      throw new Error("keep-original must never invoke local processing");
    },
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("Worker runtime composition", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worker-runtime-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ── §35 startup integration ───────────────────────────────────────────────
  describe("startup integration", () => {
    let runtime: WorkerRuntime;
    let writer: MemoryWriter;
    let baseUrl: string;

    beforeEach(async () => {
      const port = await reservePort();
      writer = new MemoryWriter();
      runtime = await createWorkerRuntime(makeConfig(join(root, "state"), port), {
        objectStoreWriter: writer,
        probeBinaries: async () => ({ ffmpeg: true, ytdlp: false, ytdlpVersion: null }),
        analyze: async () => metadata(),
        executorDeps: mediaDeps(),
      });
      const address = await runtime.listen();
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      await runtime.shutdown();
    });

    it("starts and creates the SQLite database on the persistent directory", async () => {
      assert.equal(runtime.databasePath, join(runtime.stateDirectory, WORKER_DATABASE_FILENAME));
      assert.ok((await stat(runtime.databasePath)).isFile(), "database file exists on disk");
      assert.ok(
        !runtime.databasePath.startsWith("/tmp/videofetch"),
        "durable state never lives in the media temp directory",
      );
    });

    it("answers GET /v1/healthz with 200 and no authentication", async () => {
      const res = await fetch(`${baseUrl}/v1/healthz`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: "ok" });
    });

    it("has the migrated V1 schema in place", () => {
      const version = runtime.db.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(version.user_version, 1);

      for (const table of ["worker_jobs", "worker_idempotency_records", "worker_replay_requests"]) {
        const row = runtime.db
          .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) as { count: number };
        assert.equal(Number(row.count), 1, `${table} must exist`);
      }
    });

    it("serves the HMAC-authenticated endpoints end to end", async () => {
      const client = new WorkerClient({
        baseUrl,
        currentKeyId: FAKE_KEY_ID,
        currentSecret: FAKE_SECRET,
      });

      const analyzed = await client.analyze({ url: MEDIA_URL });
      assert.equal(analyzed.success, true);
      assert.equal(analyzed.video.title, "Runtime Clip");

      const created = await client.createJob({
        url: MEDIA_URL,
        formatId: FORMAT_ID,
        principalId: "private-access-user",
      });
      assert.equal(created.success, true);

      const fetched = await client.getJob(created.job.jobId);
      assert.equal(fetched.job.jobId, created.job.jobId);
    });

    it("rejects an unsigned request to an authenticated endpoint", async () => {
      const res = await fetch(`${baseUrl}/v1/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: MEDIA_URL }),
      });
      assert.equal(res.status, 401);
    });

    it("rejects a request signed with the wrong secret", async () => {
      const wrong = new WorkerClient({
        baseUrl,
        currentKeyId: FAKE_KEY_ID,
        currentSecret: "ffffffffffffffffffffffffffffffff",
      });
      await assert.rejects(() => wrong.analyze({ url: MEDIA_URL }));
    });

    it("shuts down cleanly: listener closed and SQLite closed", async () => {
      await runtime.shutdown();

      await assert.rejects(
        () => fetch(`${baseUrl}/v1/healthz`),
        "the listener must stop accepting connections",
      );
      assert.throws(
        () => runtime.db.prepare("SELECT 1").get(),
        "the database must be closed",
      );

      // Idempotent: a second shutdown must not throw.
      await runtime.shutdown();
    });
  });

  // ── §35 HMAC rotation ─────────────────────────────────────────────────────
  it("accepts the previous key during an HMAC rotation", async () => {
    const port = await reservePort();
    const base = makeConfig(join(root, "state"), port);
    const runtime = await createWorkerRuntime(
      {
        ...base,
        control: {
          currentKeyId: FAKE_KEY_ID,
          currentSecret: FAKE_SECRET,
          previousKeyId: "worker-control-old",
          previousSecret: "fedcba9876543210fedcba9876543210",
        },
      },
      {
        objectStoreWriter: new MemoryWriter(),
        analyze: async () => metadata(),
        executorDeps: mediaDeps(),
      },
    );

    try {
      const address = await runtime.listen();
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const previous = new WorkerClient({
        baseUrl,
        currentKeyId: "worker-control-old",
        currentSecret: "fedcba9876543210fedcba9876543210",
      });
      const res = await previous.analyze({ url: MEDIA_URL });
      assert.equal(res.success, true, "the previous key must still authenticate");
    } finally {
      await runtime.shutdown();
    }
  });

  // ── §36 persistence and restart ───────────────────────────────────────────
  describe("persistence across a restart", () => {
    it("resumes a durable queued job created before the process started", async () => {
      const dataDirectory = join(root, "state");
      let databasePath = "";
      let jobId = "";

      // ── instance A: create a queued job, then close the runtime ───────────
      {
        const runtimeA = await createWorkerRuntime(
          makeConfig(dataDirectory, await reservePort()),
          { objectStoreWriter: new MemoryWriter(), executorDeps: mediaDeps() },
        );
        databasePath = runtimeA.databasePath;

        const created = runtimeA.store.createJob(
          { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
          randomUUID(),
        );
        assert.equal(created.type, "created");
        jobId = created.type === "created" ? created.job.jobId : "";
        assert.equal(created.type === "created" ? created.job.status : "", "queued");

        // The pump is never woken, so the job is still queued on disk.
        await runtimeA.shutdown();
      }

      assert.ok((await stat(databasePath)).isFile(), "a real on-disk database persisted");

      // ── instance B: same data directory ───────────────────────────────────
      const record = { analyzed: [] as string[], downloaded: [] as string[] };
      const writer = new MemoryWriter();
      const runtimeB = await createWorkerRuntime(
        makeConfig(dataDirectory, await reservePort()),
        { objectStoreWriter: writer, executorDeps: mediaDeps(record) },
      );

      try {
        // Migrations accepted the EXISTING schema rather than recreating it.
        assert.equal(runtimeB.databasePath, databasePath);
        const version = runtimeB.db.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        assert.equal(version.user_version, 1);

        // The queued job survived recovery untouched.
        const survived = runtimeB.store.getJob(jobId);
        assert.ok(survived, "the queued job must survive the restart");
        assert.equal(survived.status, "queued", "queued stays queued through recovery");

        await runtimeB.listen();

        // The startup wake is what resumes pre-existing durable work.
        runtimeB.wakeQueue();

        await waitFor(
          () => runtimeB.store.getJob(jobId)?.status === "ready",
          "the pre-existing queued job to be claimed and completed after startup wake",
        );

        assert.deepEqual(record.analyzed, [MEDIA_URL]);
        assert.deepEqual(record.downloaded, [MEDIA_URL]);
        assert.equal(writer.objects.size, 1, "exactly one object was uploaded");
      } finally {
        await runtimeB.shutdown();
      }
    });

    it("applies the conservative recovery result to an interrupted active job", async () => {
      const dataDirectory = join(root, "state");
      let jobId = "";

      {
        const runtimeA = await createWorkerRuntime(
          makeConfig(dataDirectory, await reservePort()),
          { objectStoreWriter: new MemoryWriter(), executorDeps: mediaDeps() },
        );
        const created = runtimeA.store.createJob(
          { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
          randomUUID(),
        );
        jobId = created.type === "created" ? created.job.jobId : "";

        // Simulate an execution interrupted mid-flight by a hard restart.
        runtimeA.db
          .prepare("UPDATE worker_jobs SET status = 'downloading' WHERE job_id = ?")
          .run(jobId);

        await runtimeA.shutdown();
      }

      const runtimeB = await createWorkerRuntime(
        makeConfig(dataDirectory, await reservePort()),
        { objectStoreWriter: new MemoryWriter(), executorDeps: mediaDeps() },
      );

      try {
        const recovered = runtimeB.store.getJob(jobId);
        assert.ok(recovered);
        // The existing conservative policy is authoritative: interrupted active
        // work fails deterministically. It is NOT resumed and NOT cancelled.
        assert.equal(recovered.status, "failed");
        assert.notEqual(recovered.status, "cancelled", "a restart is not a user cancellation");
        assert.equal(recovered.errorCode, "PROCESSING_FAILED");
        assert.equal(
          recovered.safeErrorMessage,
          "Worker restarted before the job completed.",
          "the deterministic worker-restart classification is authoritative",
        );
      } finally {
        await runtimeB.shutdown();
      }
    });

    it("preserves ready and terminal jobs across a restart", async () => {
      const dataDirectory = join(root, "state");
      const readyId = "0".repeat(32);
      const objectKey = `videofetch/jobs/${readyId}/${"a".repeat(32)}`;
      const cancelledId = "1".repeat(32);

      {
        const runtimeA = await createWorkerRuntime(
          makeConfig(dataDirectory, await reservePort()),
          { objectStoreWriter: new MemoryWriter(), executorDeps: mediaDeps() },
        );
        const now = Date.now();
        runtimeA.db
          .prepare(
            `INSERT INTO worker_jobs
              (job_id, url, format_id, principal_id, status, object_key,
               created_at_ms, updated_at_ms, expires_at_ms)
             VALUES (?, ?, ?, 'private-access-user', 'ready', ?, ?, ?, ?)`,
          )
          .run(readyId, MEDIA_URL, FORMAT_ID, objectKey, now, now, now + 3_600_000);
        runtimeA.db
          .prepare(
            `INSERT INTO worker_jobs
              (job_id, url, format_id, principal_id, status, object_key,
               created_at_ms, updated_at_ms, expires_at_ms)
             VALUES (?, ?, ?, 'private-access-user', 'cancelled', NULL, ?, ?, ?)`,
          )
          .run(cancelledId, MEDIA_URL, FORMAT_ID, now, now, now + 3_600_000);
        await runtimeA.shutdown();
      }

      const runtimeB = await createWorkerRuntime(
        makeConfig(dataDirectory, await reservePort()),
        { objectStoreWriter: new MemoryWriter(), executorDeps: mediaDeps() },
      );

      try {
        assert.equal(runtimeB.store.getJob(readyId)?.status, "ready");
        assert.equal(runtimeB.store.getJob(cancelledId)?.status, "cancelled");
      } finally {
        await runtimeB.shutdown();
      }
    });

    it("refuses to start on an unsupported FUTURE schema version", async () => {
      const dataDirectory = join(root, "state");
      {
        const runtimeA = await createWorkerRuntime(
          makeConfig(dataDirectory, await reservePort()),
          { objectStoreWriter: new MemoryWriter(), executorDeps: mediaDeps() },
        );
        runtimeA.db.exec("PRAGMA user_version = 99");
        await runtimeA.shutdown();
      }

      await assert.rejects(
        () =>
          createWorkerRuntime(makeConfig(dataDirectory, 8080), {
            objectStoreWriter: new MemoryWriter(),
          }),
        /Unsupported future schema version/,
      );
    });

    it("refuses to start on a corrupt V1 schema instead of recreating it", async () => {
      const dataDirectory = join(root, "state");
      {
        const runtimeA = await createWorkerRuntime(
          makeConfig(dataDirectory, await reservePort()),
          { objectStoreWriter: new MemoryWriter(), executorDeps: mediaDeps() },
        );
        runtimeA.db.exec("DROP TABLE worker_idempotency_records");
        await runtimeA.shutdown();
      }

      await assert.rejects(
        () =>
          createWorkerRuntime(makeConfig(dataDirectory, 8080), {
            objectStoreWriter: new MemoryWriter(),
          }),
        /schema integrity check failed/,
      );

      // The existing database was NOT silently discarded or recreated.
      const remaining = await stat(join(root, "state", WORKER_DATABASE_FILENAME));
      assert.ok(remaining.isFile());
    });
  });

  // ── Correction-01: FILE_EXPIRATION_MINUTES reaches durable state ──────────
  describe("configured job TTL", () => {
    it("derives the DURABLE expiresAt from fileExpirationMinutes", async () => {
      const FIXED_NOW = 1_800_000_000_000;
      const runtime = await createWorkerRuntime(
        makeConfig(join(root, "state"), await reservePort(), { fileExpirationMinutes: 7 }),
        {
          objectStoreWriter: new MemoryWriter(),
          executorDeps: mediaDeps(),
          clock: () => FIXED_NOW,
        },
      );

      try {
        const created = runtime.store.createJob(
          { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
          randomUUID(),
        );
        assert.equal(created.type, "created");
        const job = created.type === "created" ? created.job : null;
        assert.ok(job);

        // The durable row itself — not the parsed config — must carry the TTL.
        assert.equal(job.createdAt, FIXED_NOW);
        assert.equal(job.expiresAt - job.createdAt, 420_000, "7 minutes in milliseconds");
        assert.equal(job.expiresAt, FIXED_NOW + 420_000);

        // Confirmed straight from SQLite, bypassing the view entirely.
        const row = runtime.db
          .prepare("SELECT created_at_ms, expires_at_ms FROM worker_jobs WHERE job_id = ?")
          .get(job.jobId) as { created_at_ms: number; expires_at_ms: number };
        assert.equal(Number(row.expires_at_ms) - Number(row.created_at_ms), 420_000);
      } finally {
        await runtime.shutdown();
      }
    });

    it("uses a different configured retention for a different value", async () => {
      const FIXED_NOW = 1_800_000_000_000;
      const runtime = await createWorkerRuntime(
        makeConfig(join(root, "state"), await reservePort(), { fileExpirationMinutes: 90 }),
        {
          objectStoreWriter: new MemoryWriter(),
          executorDeps: mediaDeps(),
          clock: () => FIXED_NOW,
        },
      );

      try {
        const created = runtime.store.createJob(
          { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
          randomUUID(),
        );
        const job = created.type === "created" ? created.job : null;
        assert.ok(job);
        assert.equal(job.expiresAt - job.createdAt, 5_400_000, "90 minutes in milliseconds");
      } finally {
        await runtime.shutdown();
      }
    });

    it("lets an explicit test override win over the configured retention", async () => {
      const FIXED_NOW = 1_800_000_000_000;
      const runtime = await createWorkerRuntime(
        makeConfig(join(root, "state"), await reservePort(), { fileExpirationMinutes: 45 }),
        {
          objectStoreWriter: new MemoryWriter(),
          executorDeps: mediaDeps(),
          clock: () => FIXED_NOW,
          jobTtlMs: 1_000,
        },
      );

      try {
        const created = runtime.store.createJob(
          { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
          randomUUID(),
        );
        const job = created.type === "created" ? created.job : null;
        assert.ok(job);
        assert.equal(job.expiresAt - job.createdAt, 1_000);
      } finally {
        await runtime.shutdown();
      }
    });
  });

  // ── §22 shutdown behaviour ────────────────────────────────────────────────
  describe("shutdown", () => {
    it("is NOT delayed by an in-flight maintenance operation", async () => {
      const GRACE_MS = 300;
      const port = await reservePort();
      const record = { analyzed: [] as string[], downloaded: [] as string[] };

      // A writer whose delete never settles until the test releases it. This is
      // the hang that previously blocked the entire shutdown sequence.
      const gate: { release: (() => void) | null } = { release: null };
      const maintenanceGate = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      const releaseMaintenance = () => gate.release?.();
      let maintenanceEntered = false;

      const hangingWriter = new MemoryWriter();
      hangingWriter.delete = async () => {
        maintenanceEntered = true;
        await maintenanceGate;
      };

      const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), port), {
        objectStoreWriter: hangingWriter,
        executorDeps: mediaDeps(record),
        shutdownGraceMs: GRACE_MS,
      });

      let shutdownSettled = false;
      try {
        const address = await runtime.listen();
        const baseUrl = `http://127.0.0.1:${address.port}`;

        // An expired ready object gives maintenance something to hang on.
        const jobId = "0".repeat(32);
        const objectKey = `videofetch/jobs/${jobId}/${"a".repeat(32)}`;
        const now = Date.now();
        runtime.db
          .prepare(
            `INSERT INTO worker_jobs
              (job_id, url, format_id, principal_id, status, object_key,
               created_at_ms, updated_at_ms, expires_at_ms)
             VALUES (?, ?, ?, 'private-access-user', 'ready', ?, ?, ?, ?)`,
          )
          .run(jobId, MEDIA_URL, FORMAT_ID, objectKey, now - 10_000, now - 10_000, now - 1);

        // Start a maintenance pass and let it reach the hanging delete.
        const maintenancePass = runtime.maintenance.runOnce();
        await waitFor(() => maintenanceEntered, "maintenance to reach the hanging delete");
        assert.equal(runtime.maintenance.isRunning, true);

        // A durable queued job exists; nothing may claim it once shutdown began.
        runtime.store.createJob(
          { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
          randomUUID(),
        );

        const started = Date.now();
        const shutdown = runtime.shutdown().then(() => {
          shutdownSettled = true;
        });

        // The non-blocking phase must already have taken effect, well before
        // the hanging maintenance operation settles.
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(maintenanceEntered, true, "maintenance is still hanging");
        assert.equal(shutdownSettled, false, "shutdown has not returned yet");

        // 1. No further queued work may be claimed.
        runtime.wakeQueue();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(record.analyzed, [], "no queued job may be claimed during shutdown");

        // 2. The maintenance timer is disarmed and no new pass can begin.
        assert.equal(runtime.maintenance.isStarted, false, "maintenance timer disarmed");

        // 3. The listener is closing: new connections are refused.
        await assert.rejects(
          () => fetch(`${baseUrl}/v1/healthz`),
          "the listener must stop accepting new connections immediately",
        );

        // Shutdown must return on the bounded grace, NOT on the hung operation.
        await shutdown;
        const elapsed = Date.now() - started;
        assert.equal(shutdownSettled, true);
        assert.ok(
          elapsed < GRACE_MS * 6,
          `shutdown must be bounded by the grace period, took ${elapsed}ms`,
        );
        assert.equal(maintenanceEntered, true);

        // The maintenance operation is still hanging at this point: shutdown
        // did not wait for it.
        releaseMaintenance();
        await maintenancePass;

        // 4. SQLite closed last, so the durable evidence is read from a FRESH
        //    handle on the same file: an operator shutdown wrote no `cancelled`
        //    state, and the queued job survived for the next boot.
        const reopened = openWorkerDatabase({ path: runtime.databasePath });
        try {
          const cancelled = reopened
            .prepare("SELECT count(*) AS count FROM worker_jobs WHERE status = 'cancelled'")
            .get() as { count: number };
          assert.equal(
            Number(cancelled.count),
            0,
            "an operator shutdown must never write `cancelled`",
          );

          const stillQueued = reopened
            .prepare("SELECT count(*) AS count FROM worker_jobs WHERE status = 'queued'")
            .get() as { count: number };
          assert.equal(Number(stillQueued.count), 1, "the queued job survives for the next boot");
        } finally {
          reopened.close();
        }
      } finally {
        releaseMaintenance();
      }
    });

    it("closes SQLite last, after the bounded wait", async () => {
      const port = await reservePort();
      const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), port), {
        objectStoreWriter: new MemoryWriter(),
        executorDeps: mediaDeps(),
        shutdownGraceMs: 250,
      });
      await runtime.listen();

      // Live before shutdown.
      assert.ok(runtime.db.prepare("SELECT 1 AS ok").get());

      await runtime.shutdown();

      assert.throws(
        () => runtime.db.prepare("SELECT 1").get(),
        "SQLite must be closed once shutdown completes",
      );
    });

    it("stops maintenance and refuses to claim further queued work", async () => {
      const port = await reservePort();
      const record = { analyzed: [] as string[], downloaded: [] as string[] };
      const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), port), {
        objectStoreWriter: new MemoryWriter(),
        executorDeps: mediaDeps(record),
      });
      await runtime.listen();
      runtime.maintenance.start();
      assert.equal(runtime.maintenance.isStarted, true);

      // A durable queued job exists but the pump is never woken before shutdown.
      runtime.store.createJob(
        { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
        randomUUID(),
      );

      await runtime.shutdown();

      assert.equal(runtime.maintenance.isStarted, false, "the maintenance timer stopped");

      // Waking after shutdown must not start additional queued jobs.
      runtime.wakeQueue();
      await runtime.pump.whenDrained();
      assert.deepEqual(record.analyzed, [], "no queued job may be claimed after shutdown");
    });

    it("does not mark queued work cancelled merely because the Worker restarts", async () => {
      const dataDirectory = join(root, "state");
      let jobId = "";
      {
        const runtimeA = await createWorkerRuntime(
          makeConfig(dataDirectory, await reservePort()),
          { objectStoreWriter: new MemoryWriter(), executorDeps: mediaDeps() },
        );
        await runtimeA.listen();
        const created = runtimeA.store.createJob(
          { url: MEDIA_URL, formatId: FORMAT_ID, principalId: "private-access-user" },
          randomUUID(),
        );
        jobId = created.type === "created" ? created.job.jobId : "";
        await runtimeA.shutdown();
      }

      const runtimeB = await createWorkerRuntime(
        makeConfig(dataDirectory, await reservePort()),
        { objectStoreWriter: new MemoryWriter(), executorDeps: mediaDeps() },
      );
      try {
        assert.equal(
          runtimeB.store.getJob(jobId)?.status,
          "queued",
          "an operator restart must never become a user cancellation",
        );
      } finally {
        await runtimeB.shutdown();
      }
    });

    it("is bounded and completes even with an idle keep-alive connection open", async () => {
      const port = await reservePort();
      const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), port), {
        objectStoreWriter: new MemoryWriter(),
        shutdownGraceMs: 250,
        executorDeps: mediaDeps(),
      });
      const address = await runtime.listen();
      const agent = { keepAlive: true };
      void agent;

      // Establish a real connection, then leave it idle across shutdown.
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/healthz`);
      assert.equal(res.status, 200);

      const started = Date.now();
      await runtime.shutdown();
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 5000, `shutdown must be bounded, took ${elapsed}ms`);
    });
  });
});

// ── §37 no R2 network during startup ────────────────────────────────────────
describe("R2 startup network isolation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worker-r2-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("performs ZERO PutObject/HeadObject/DeleteObject during startup, health, migration and recovery", async () => {
    // The REAL CloudflareR2ObjectStoreWriter is constructed here; only its S3
    // send-client is replaced, so any attempted request is counted rather than
    // dispatched. Nothing reaches a network.
    const sends: string[] = [];
    const countingClient = {
      send: async (command: unknown) => {
        sends.push(command?.constructor?.name ?? "Unknown");
        throw new Error("no R2 request may occur during startup");
      },
    };

    const port = await reservePort();
    const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), port), {
      r2Credentials: fakeCredentials(),
      r2CreateWriter: delegatedWriterFactory(countingClient),
      probeBinaries: async () => ({ ffmpeg: true, ytdlp: false, ytdlpVersion: null }),
      analyze: async () => metadata(),
      executorDeps: mediaDeps(),
    });

    try {
      // Construction ran migrations and recovery.
      assert.deepEqual(sends, [], "no R2 request during construction, migration or recovery");

      const address = await runtime.listen();
      assert.deepEqual(sends, [], "no R2 request during listen");

      const health = await fetch(`http://127.0.0.1:${address.port}/v1/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(sends, [], "no R2 request during health");

      // A restart over the same volume also performs no request.
      runtime.store.recover();
      assert.deepEqual(sends, [], "no R2 request during recovery");

      // Maintenance with nothing expired still issues no request.
      await runtime.maintenance.runOnce();
      assert.deepEqual(sends, [], "no R2 request when nothing has expired");
    } finally {
      await runtime.shutdown();
    }

    assert.deepEqual(sends, [], "no R2 request during shutdown");
  });

  it("starts and serves health without ever minting an R2 credential", async () => {
    const mints: Array<{ action: string; objectKey: string; ttlSeconds: number }> = [];
    const port = await reservePort();
    const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), port), {
      r2Credentials: fakeCredentials(mints),
      r2CreateWriter: delegatedWriterFactory({
        send: async () => {
          throw new Error("credentials were never validated against a live endpoint");
        },
      }),
      executorDeps: mediaDeps(),
    });

    try {
      const address = await runtime.listen();
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/healthz`);
      assert.equal(res.status, 200);

      // Credentials are minted just-in-time, so an idle Worker has asked the
      // broker for nothing at all.
      assert.deepEqual(mints, [], "startup and health mint no credential");
    } finally {
      await runtime.shutdown();
    }
  });

  it("issues the first DeleteObject only when maintenance finds an expired object", async () => {
    const sends: string[] = [];
    const mints: Array<{ action: string; objectKey: string; ttlSeconds: number }> = [];
    const port = await reservePort();
    const runtime = await createWorkerRuntime(makeConfig(join(root, "state"), port), {
      r2Credentials: fakeCredentials(mints),
      r2CreateWriter: delegatedWriterFactory({
        send: async (command: unknown) => {
          sends.push(command?.constructor?.name ?? "Unknown");
          return {};
        },
      }),
      executorDeps: mediaDeps(),
    });

    try {
      await runtime.listen();
      assert.deepEqual(sends, [], "startup issued nothing");

      const jobId = "0".repeat(32);
      const objectKey = `videofetch/jobs/${jobId}/${"a".repeat(32)}`;
      const now = Date.now();
      runtime.db
        .prepare(
          `INSERT INTO worker_jobs
            (job_id, url, format_id, principal_id, status, object_key,
             created_at_ms, updated_at_ms, expires_at_ms)
           VALUES (?, ?, ?, 'private-access-user', 'ready', ?, ?, ?, ?)`,
        )
        .run(jobId, MEDIA_URL, FORMAT_ID, objectKey, now - 10_000, now - 10_000, now - 1);

      await runtime.maintenance.runOnce();

      assert.deepEqual(sends, ["DeleteObjectCommand"], "exactly one exact-key delete");

      // Maintenance minted a FRESH DeleteObject-only credential for exactly
      // that key rather than reusing an upload credential.
      assert.equal(mints.length, 1, "exactly one credential minted");
      assert.equal(mints[0].action, "DeleteObject");
      assert.equal(mints[0].objectKey, objectKey);
    } finally {
      await runtime.shutdown();
    }
  });
});

// ── §14/§15 import purity ───────────────────────────────────────────────────
describe("import-time purity", () => {
  it("importing the runtime and executable modules starts nothing", async () => {
    const exitCodeBefore = process.exitCode;

    const runtimeModule = await import("./runtime.server.ts");
    // Importing main.server.ts runs its entry-point guard, which is false under
    // the test runner, so no server, database or signal handler is created.
    const mainModule = await import("./main.server.ts");

    assert.equal(typeof runtimeModule.createWorkerRuntime, "function");
    assert.equal(typeof mainModule.startWorker, "function");
    assert.equal(process.exitCode, exitCodeBefore, "importing must not set an exit status");
  });

  it("describes a startup failure without disclosing values", async () => {
    const { describeStartupFailure } = await import("./main.server.ts");
    const { WorkerRuntimeConfigError } = await import("./config.server.ts");

    const configLine = describeStartupFailure(
      new WorkerRuntimeConfigError(["WORKER_CONTROL_SECRET", "R2_BUCKET"]),
    );
    assert.ok(configLine.includes("WORKER_CONTROL_SECRET"));
    assert.ok(configLine.includes("R2_BUCKET"));

    // The retired Phase-8A lock had its own error class and its own message.
    // It is now reported through the ordinary configuration error, which still
    // names the offending variable precisely — so a stale deployment carrying
    // the retired contract is diagnosed just as clearly, with one fewer
    // bespoke failure mode.
    const retiredLine = describeStartupFailure(
      new WorkerRuntimeConfigError(["YTDLP_NETWORK_ISOLATED"]),
    );
    assert.ok(retiredLine.includes("YTDLP_NETWORK_ISOLATED"));

    // An arbitrary error contributes only its class name, never its message.
    const opaque = describeStartupFailure(
      new AppError("PROCESSING_FAILED", "secret-bearing detail AKIA-DO-NOT-LOG"),
    );
    assert.ok(!opaque.includes("AKIA-DO-NOT-LOG"), "raw messages must never be rendered");
  });
});
