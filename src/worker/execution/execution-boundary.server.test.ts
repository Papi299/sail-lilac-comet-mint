import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import type { DurableWorkerJob } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";

type PresetSpec = { id: string; container: string; hasVideo: boolean };

function buildMeta(
  original: { container: string; hasVideo: boolean },
  presets: PresetSpec[] = [],
): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "clip",
    thumbnail: null,
    duration: null,
    source: "cdn.example.com",
    extractor: "direct",
    webpageUrl: "https://cdn.example.com/clip",
    formats: [
      {
        id: "direct-original",
        resolution: original.hasVideo ? "unknown" : "audio",
        width: null,
        height: null,
        fps: null,
        container: original.container,
        videoCodec: original.hasVideo ? "unknown" : null,
        audioCodec: "unknown",
        bitrate: null,
        fileSize: 8,
        hasVideo: original.hasVideo,
        hasAudio: true,
        formatNote: null,
      },
    ],
    presets: presets.map((p) => ({
      id: p.id,
      label: p.id,
      resolution: p.hasVideo ? "unknown" : "audio",
      container: p.container,
      fileSize: null,
      hasVideo: p.hasVideo,
      hasAudio: true,
      formatId: p.id,
      videoCodec: p.hasVideo ? "unknown" : null,
      audioCodec: "unknown",
      fps: null,
    })),
    capabilities: { mp3: true, merge: true },
  });
}

type Harness = {
  store: SQLiteJobStore;
  puts: ObjectStorePutInput[];
  deletes: string[];
  heads: string[];
  writer: ObjectStoreWriter;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-exec-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const store = new SQLiteJobStore({ db });

  const puts: ObjectStorePutInput[] = [];
  const deletes: string[] = [];
  const heads: string[] = [];

  const writer: ObjectStoreWriter = {
    async put(input) {
      puts.push(input);
      for await (const _chunk of input.body) {
        void _chunk;
      }
    },
    async head(key) {
      heads.push(key);
      const last = puts.find((p) => p.objectKey === key);
      if (!last) return null;
      return {
        objectKey: last.objectKey,
        contentLength: last.contentLength,
        contentType: last.contentType,
        contentDisposition: last.contentDisposition,
      };
    },
    async delete(key) {
      deletes.push(key);
    },
  };

  return {
    store,
    puts,
    deletes,
    heads,
    writer,
    cleanup: () => {
      db.close();
      setTempDirectoryForTests(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function claimJob(store: SQLiteJobStore, formatId: string): DurableWorkerJob {
  store.createJob(
    { url: "https://cdn.example.com/clip.mp4", formatId, principalId: "private-access-user" },
    randomUUID(),
  );
  const job = store.claimNextQueuedJob();
  assert.ok(job, "a job must be claimable");
  return job;
}

/** Writes the fake "downloaded original" into the executor-supplied workDir. */
function writeOriginal(workDir: string, container: string, bytes = "mockdata") {
  const filePath = path.join(workDir, `source.${container}`);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

describe("download → processing execution boundary", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.cleanup();
  });

  it("HARD GATE: the durable status is `processing`, never `downloading`, when local processing starts", async () => {
    const job = claimJob(h.store, "preset:audio");
    const statusesAtInvocation: string[] = [];

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }, [
        { id: "preset:audio", container: "m4a", hasVideo: false },
      ]),
      downloadOriginal: async (_url, ctx) => {
        statusesAtInvocation.push(`download=${h.store.getJob(job.jobId)!.status}`);
        return {
          filePath: writeOriginal(ctx.workDir, "mp4"),
          container: "mp4",
          mime: "video/mp4",
          fileSize: 8,
        };
      },
      processLocally: async (opts) => {
        // The fake conversion inspects the durable state at the exact moment
        // FFmpeg would have been invoked.
        statusesAtInvocation.push(`process=${h.store.getJob(job.jobId)!.status}`);
        const out = path.join(opts.workDir, `converted.${opts.target}`);
        fs.writeFileSync(out, "converted-bytes");
        return out;
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.deepEqual(statusesAtInvocation, ["download=downloading", "process=processing"]);
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
  });

  it("keep-original plans never invoke local processing at all", async () => {
    const job = claimJob(h.store, "direct-original");
    let processCalls = 0;

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
      processLocally: async () => {
        processCalls += 1;
        throw new Error("keep-original must not convert");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.equal(processCalls, 0);
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "ready");
    assert.equal(view.container, "mp4");
  });

  it("the download primitive receives no format instruction of any kind", async () => {
    const job = claimJob(h.store, "preset:mp3");
    let observedCtxKeys: string[] = [];
    let downloadArgCount = 0;

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }, [
        { id: "preset:mp3", container: "mp3", hasVideo: false },
      ]),
      downloadOriginal: async function (_url, ctx) {
        downloadArgCount = arguments.length;
        observedCtxKeys = Object.keys(ctx).sort();
        return {
          filePath: writeOriginal(ctx.workDir, "mp4"),
          container: "mp4",
          mime: "video/mp4",
          fileSize: 8,
        };
      },
      processLocally: async (opts) => {
        const out = path.join(opts.workDir, `converted.${opts.target}`);
        fs.writeFileSync(out, "mp3-bytes");
        return out;
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.equal(downloadArgCount, 2, "download takes only (url, ctx)");
    assert.deepEqual(observedCtxKeys, ["onProgress", "signal", "workDir"]);
  });

  it("§10: the advertised preset equals the produced artifact end-to-end", async () => {
    const cases = [
      { formatId: "direct-original", source: "mp4", advertised: "mp4", expectProcess: false, mime: "video/mp4" },
      { formatId: "preset:best", source: "mkv", advertised: "mp4", expectProcess: true, mime: "video/mp4" },
      { formatId: "preset:best", source: "mkv", advertised: "webm", expectProcess: true, mime: "video/webm" },
      { formatId: "preset:audio", source: "mp4", advertised: "m4a", expectProcess: true, mime: "audio/mp4" },
      { formatId: "preset:mp3", source: "mp4", advertised: "mp3", expectProcess: true, mime: "audio/mpeg" },
    ];

    for (const c of cases) {
      const local = makeHarness();
      try {
        const job = claimJob(local.store, c.formatId);
        const hasVideo = c.formatId !== "preset:audio" && c.formatId !== "preset:mp3";
        const presets =
          c.formatId === "direct-original"
            ? []
            : [{ id: c.formatId, container: c.advertised, hasVideo }];

        let processed = false;
        const deps: JobExecutorDeps = {
          analyze: async () => buildMeta({ container: c.source, hasVideo: true }, presets),
          downloadOriginal: async (_url, ctx) => ({
            filePath: writeOriginal(ctx.workDir, c.source),
            container: c.source,
            mime: "video/mp4",
            fileSize: 8,
          }),
          processLocally: async (opts) => {
            processed = true;
            assert.equal(opts.target, c.advertised, `${c.formatId}: target must be the advertised container`);
            const out = path.join(opts.workDir, `converted.${opts.target}`);
            fs.writeFileSync(out, "bytes");
            return out;
          },
        };

        const executor = new JobExecutor(local.store, local.writer, () => Date.now(), new Map(), deps);
        await executor.execute(job);

        const view = local.store.getJob(job.jobId)!;
        assert.equal(view.status, "ready", `${c.formatId} → ready`);
        assert.equal(processed, c.expectProcess, `${c.formatId}: processing expectation`);
        assert.equal(view.container, c.advertised, `${c.formatId}: durable container`);
        assert.equal(view.mime, c.mime, `${c.formatId}: durable mime`);
        assert.ok(
          view.filename!.endsWith(`.${c.advertised}`),
          `${c.formatId}: filename extension ${view.filename}`,
        );
        assert.equal(local.puts.length, 1);
        assert.equal(local.puts[0]!.contentType, c.mime, `${c.formatId}: uploaded content-type`);
      } finally {
        local.cleanup();
      }
    }
  });

  it("a non-canonical produced path is canonicalized, and that canonical file is what gets uploaded", async () => {
    const job = claimJob(h.store, "direct-original");
    let canonicalDuringRun = "";
    let handedToValidator = "";
    let uploadedBytes = "";

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async (_url, ctx) => {
        const written = writeOriginal(ctx.workDir, "mp4", "canonical-payload");
        canonicalDuringRun = fs.realpathSync(written);
        // Deliberately hand back a lexically non-canonical spelling of the very
        // same file; containment must canonicalize before opening anything.
        handedToValidator = `${ctx.workDir}/./source.mp4`;
        return {
          filePath: handedToValidator,
          container: "mp4",
          mime: "video/mp4",
          fileSize: 17,
        };
      },
    };

    const writer: ObjectStoreWriter = {
      ...h.writer,
      async put(input) {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
        uploadedBytes = Buffer.concat(chunks).toString("utf8");
        h.puts.push(input);
      },
    };

    const executor = new JobExecutor(h.store, writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.notEqual(handedToValidator, canonicalDuringRun, "the input path was non-canonical");
    assert.equal(h.store.getJob(job.jobId)!.status, "ready");
    assert.equal(uploadedBytes, "canonical-payload");
    assert.equal(h.puts[0]!.contentLength, 17);
  });

  it("an unknown requested format fails before any download or processing", async () => {
    const job = claimJob(h.store, "preset:does-not-exist");
    let downloads = 0;
    let processes = 0;

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }),
      downloadOriginal: async () => {
        downloads += 1;
        throw new Error("unreachable");
      },
      processLocally: async () => {
        processes += 1;
        throw new Error("unreachable");
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    assert.equal(downloads, 0);
    assert.equal(processes, 0);
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "FORMAT_UNAVAILABLE");
    assert.equal(h.puts.length, 0);
  });

  it("a plan whose produced artifact has the wrong extension fails safely", async () => {
    const job = claimJob(h.store, "preset:mp3");

    const deps: JobExecutorDeps = {
      analyze: async () => buildMeta({ container: "mp4", hasVideo: true }, [
        { id: "preset:mp3", container: "mp3", hasVideo: false },
      ]),
      downloadOriginal: async (_url, ctx) => ({
        filePath: writeOriginal(ctx.workDir, "mp4"),
        container: "mp4",
        mime: "video/mp4",
        fileSize: 8,
      }),
      processLocally: async (opts) => {
        // A misbehaving processor returns a different container than planned.
        const out = path.join(opts.workDir, "converted.wav");
        fs.writeFileSync(out, "wrong-container");
        return out;
      },
    };

    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), deps);
    await executor.execute(job);

    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "PROCESSING_FAILED");
    assert.equal(h.puts.length, 0);
  });
});
