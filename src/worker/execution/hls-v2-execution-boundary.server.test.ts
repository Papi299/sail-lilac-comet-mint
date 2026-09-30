import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { config } from "@/lib/config";
import { setSafeHttpTestHooks, type DnsAnswer, type SafeRequestOnce } from "@/lib/security/safe-http.server.ts";
import { resolveFfprobePath } from "@/services/processing/ffprobe.server.ts";
import { setProcessRunnerTestHooks, type SpawnImpl } from "@/services/processing/process-runner.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import type { ObjectStorePutInput, ObjectStoreWriter } from "@/worker/storage/writer.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import { AGGREGATE_FILE_NAME, FMP4_AGGREGATE_FILE_NAME } from "../hls/hls-fragment-acquisition.server.ts";
import { buildClearHlsFmp4RemuxArgs, buildClearHlsRemuxArgs } from "../hls/hls-processing.server.ts";
import { deriveClearHlsExecutionPlan } from "./format-plan.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";

/**
 * HLS-V2-ADAPTIVE-VOD-EXPANSION-001 §23 / §31 / §37: the durable lifecycle
 * boundary, measured through the PRODUCTION HLS composition.
 *
 * Unlike `hls-job-execution.server.test.ts`, NOTHING here replaces the HLS
 * acquisition or processing seams: the executor runs its own defaults — the
 * real HLS-2 preflight, the real HLS-3 acquisition of whichever family the
 * playlist declares, and the real HLS-4 primitive. Only the two lowest layers
 * are scripted:
 *
 *   - safe-HTTP's DNS answer and one-shot request (`setSafeHttpTestHooks`), so
 *     every playlist, map and fragment request is served locally; and
 *   - the process runner's spawn (`setProcessRunnerTestHooks`), so ffprobe
 *     answers with the pinned captures and FFmpeg writes a file.
 *
 * Both record the durable job status at the exact instant each request or
 * process begins. The load-bearing claim is the Product's lifecycle invariant:
 *
 *   downloading  = network acquisition only (playlist, map, fragments)
 *   processing   = ffprobe + FFmpeg only
 *   uploading    = the object store
 *
 * and, for every failure below, that no ffprobe or FFmpeg process ever starts.
 */

const PUBLIC: DnsAnswer = { address: "8.8.8.8", family: 4 };
const PRIVATE: DnsAnswer = { address: "10.0.0.7", family: 4 };
const PAGE_URL = "https://example.invalid/watch/v2";
const PLAYLIST_URL = "https://media.example.invalid/hls/1080/media.m3u8?sig=PRIVATE_V2_TOKEN";
const MEDIA_DIR = "https://media.example.invalid/hls/1080/";
const INIT_URL = `${MEDIA_DIR}init.mp4`;
const FRAGMENTS = [`${MEDIA_DIR}seg-0.m4s`, `${MEDIA_DIR}seg-1.m4s`, `${MEDIA_DIR}seg-2.m4s`];
const TS_FRAGMENTS = [`${MEDIA_DIR}seg-0.ts`, `${MEDIA_DIR}seg-1.ts`];

const INIT_BYTES = Buffer.alloc(40, 0x49);
const FRAGMENT_BYTES = [Buffer.alloc(100, 0x41), Buffer.alloc(120, 0x42), Buffer.alloc(140, 0x43)];
const PRODUCED_MP4 = Buffer.alloc(333, 0x4d);

const TESTDATA = path.join(import.meta.dirname, "../../services/processing/testdata");
const pinned = (name: string) => fs.readFileSync(path.join(TESTDATA, `pinned-ffprobe-${name}.json`), "utf8");

function fmp4Playlist(mapLine = '#EXT-X-MAP:URI="init.mp4"'): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    mapLine,
    ...FRAGMENTS.flatMap((url) => ["#EXTINF:2.0,", url.slice(MEDIA_DIR.length)]),
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

function tsPlaylist(): string {
  return [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...TS_FRAGMENTS.flatMap((url) => ["#EXTINF:2.0,", url.slice(MEDIA_DIR.length)]),
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

// ── Durable state, the object store, and the executor ────────────────────────

type World = {
  tempDir: string;
  store: SQLiteJobStore;
  db: DatabaseSync;
  puts: { input: ObjectStorePutInput; status: string }[];
  writer: ObjectStoreWriter;
  jobId: string | null;
  status(): string;
};

let world: World;

beforeEach(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hls-v2-boundary-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const store = new SQLiteJobStore({ db });
  const puts: World["puts"] = [];
  world = {
    tempDir,
    store,
    db,
    puts,
    jobId: null,
    status() {
      return world.jobId ? (world.store.getJob(world.jobId)?.status ?? "<missing>") : "<no-job>";
    },
    writer: {
      async put(input) {
        puts.push({ input, status: world.status() });
        for await (const chunk of input.body) void chunk;
      },
      async head(key) {
        const last = puts.find((p) => p.input.objectKey === key)?.input;
        return last
          ? {
              objectKey: last.objectKey,
              contentLength: last.contentLength,
              contentType: last.contentType,
              contentDisposition: last.contentDisposition,
            }
          : null;
      },
      async delete() {},
    },
  };
});

afterEach(() => {
  setSafeHttpTestHooks(null);
  setProcessRunnerTestHooks(null);
  world.db.close();
  setTempDirectoryForTests(null);
  fs.rmSync(world.tempDir, { recursive: true, force: true });
});

function meta(): WorkerVideoMetadata {
  return VideoMetadataSchema.parse({
    title: "An HLS v2 Clip",
    thumbnail: null,
    duration: 6,
    source: "example.invalid",
    extractor: "yt-dlp",
    webpageUrl: PAGE_URL,
    formats: [],
    presets: [],
    capabilities: { mp3: false, merge: false },
  });
}

/**
 * Only analysis and plan derivation are injected (as in the HLS-6 matrix), plus
 * an unbounded capacity reader so the host's free space cannot decide a case.
 * `acquireClearHls` and `processClearHls` are deliberately ABSENT: the executor
 * uses the production `worker/hls` composition.
 */
function productionHlsDeps(): JobExecutorDeps {
  const analysis: ExecutionAnalysis = {
    strategy: "yt-dlp",
    video: meta(),
    selections: {},
    hlsSelections: Object.freeze({
      "preset:1080": Object.freeze({ playlistUrl: PLAYLIST_URL, height: 1080 }),
    }),
  };
  return {
    analyzeForExecution: async () => analysis,
    derivePlanForExecution: (a, requested) => ({
      strategy: "yt-dlp",
      generic: deriveClearHlsExecutionPlan((a as ExecutionAnalysis).hlsSelections, requested),
    }),
    availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
  };
}

async function runJob(executorRef?: { executor?: JobExecutor }) {
  world.store.createJob({ url: PAGE_URL, formatId: "preset:1080", principalId: "private-access-user" }, randomUUID());
  const job = world.store.claimNextQueuedJob();
  assert.ok(job);
  world.jobId = job.jobId;
  const executor = new JobExecutor(world.store, world.writer, () => Date.now(), new Map(), productionHlsDeps());
  if (executorRef) executorRef.executor = executor;
  await executor.execute(job);
  const final = world.store.getJob(job.jobId);
  const workDirGone = !fs.existsSync(path.join(world.tempDir, "jobs", job.jobId));
  return { final, workDirGone, jobId: job.jobId };
}

// ── The two scripted layers ──────────────────────────────────────────────────

type Served = { status?: number; headers?: IncomingHttpHeaders; body?: Readable | null };
type Route = Served | ((args: Parameters<SafeRequestOnce>[0]) => Served | Promise<Served>);
type Request = { url: string; status: string };

function network(routes: Record<string, Route>, dns: Record<string, DnsAnswer[]> = {}) {
  const requests: Request[] = [];
  setSafeHttpTestHooks({
    lookup: async (hostname) => dns[hostname] ?? [PUBLIC],
    requestOnce: async (args) => {
      requests.push({ url: args.url.href, status: world.status() });
      const route = routes[args.url.href];
      if (route === undefined) throw new Error("unrouted synthetic request");
      const served = typeof route === "function" ? await route(args) : route;
      return { status: served.status ?? 200, headers: served.headers ?? {}, body: served.body ?? null };
    },
  });
  return requests;
}

const body = (bytes: Buffer | string): Served => ({ status: 200, body: Readable.from([Buffer.from(bytes)]) });

function fmp4Routes(): Record<string, Route> {
  return {
    [PLAYLIST_URL]: () => body(fmp4Playlist()),
    [INIT_URL]: () => body(INIT_BYTES),
    ...Object.fromEntries(FRAGMENTS.map((url, i) => [url, () => body(FRAGMENT_BYTES[i]!)])),
  };
}

type Spawned = { tool: "ffprobe" | "ffmpeg" | "other"; status: string; args: string[]; inputBytes: Buffer | null };

/** Every spawn is recorded with the durable status at that instant. */
function processes(): Spawned[] {
  const spawned: Spawned[] = [];
  const ffprobe = resolveFfprobePath();
  const children: (EventEmitter & { pid: number })[] = [];
  const spawn: SpawnImpl = (command, args) => {
    const tool = command === ffprobe ? "ffprobe" : command === config.ffmpegPath ? "ffmpeg" : "other";
    const input = args[args.indexOf("-i") + 1];
    spawned.push({
      tool,
      status: world.status(),
      args: [...args],
      inputBytes: input && fs.existsSync(input) ? fs.readFileSync(input) : null,
    });
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.pid = 91_000 + spawned.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    children.push(child);
    queueMicrotask(() => {
      if (tool === "ffprobe") {
        const demuxer = args[args.indexOf("-f") + 1];
        child.stdout.write(pinned(demuxer === "mpegts" ? "mpegts-muxed" : "iso-bmff-merged"));
        setImmediate(() => child.emit("close", 0));
      } else if (tool === "ffmpeg") {
        fs.writeFileSync(args[args.length - 1]!, PRODUCED_MP4);
        setImmediate(() => child.emit("close", 0));
      } else {
        setImmediate(() => child.emit("close", 97));
      }
    });
    return child as unknown as ChildProcess;
  };
  setProcessRunnerTestHooks({
    platform: "linux",
    spawn,
    processKill: (pid) => {
      const owner = children.find((c) => c.pid === -pid);
      if (owner) queueMicrotask(() => owner.emit("close", null));
      return true;
    },
  });
  return spawned;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("HLS v2 boundary: an fMP4 job through the production composition", () => {
  it("acquires only while downloading, processes only while processing, and reaches ready", async () => {
    const requests = network(fmp4Routes());
    const spawned = processes();
    const { final, workDirGone } = await runJob();

    assert.equal(final?.status, "ready", `final ${final?.status} ${final?.errorCode ?? ""}`);
    // Network: the playlist, the map, then the fragments in order — all while downloading.
    assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL, INIT_URL, ...FRAGMENTS]);
    assert.ok(requests.every((r) => r.status === "downloading"), JSON.stringify(requests.map((r) => r.status)));
    // Processes: NONE while downloading; every one while processing.
    assert.equal(spawned.filter((s) => s.status === "downloading").length, 0, "no ffprobe/FFmpeg while downloading");
    assert.deepEqual(spawned.map((s) => `${s.tool}@${s.status}`), [
      "ffprobe@processing",
      "ffmpeg@processing",
      "ffprobe@processing",
      "ffprobe@processing",
    ]);
    // The source probe and the remux read the ONE fMP4 aggregate through the
    // ISO-BMFF demuxer, and its bytes are exactly map + fragments.
    const probe = spawned[0]!;
    assert.equal(probe.args[probe.args.indexOf("-f") + 1], "mov");
    assert.equal(path.basename(probe.args[probe.args.length - 1]!), FMP4_AGGREGATE_FILE_NAME);
    assert.deepEqual(probe.inputBytes, Buffer.concat([INIT_BYTES, ...FRAGMENT_BYTES]));
    const remux = spawned[1]!;
    const sourcePath = remux.args[remux.args.indexOf("-i") + 1]!;
    assert.deepEqual(
      remux.args,
      buildClearHlsFmp4RemuxArgs({ sourcePath, outputPath: remux.args[remux.args.length - 1]! }),
    );
    // Upload: once, while uploading, the produced MP4 — never the aggregate.
    assert.equal(world.puts.length, 1);
    assert.equal(world.puts[0]!.status, "uploading");
    assert.equal(world.puts[0]!.input.contentLength, PRODUCED_MP4.length);
    assert.equal(world.puts[0]!.input.contentType, "video/mp4");
    assert.equal(final?.fileSize, PRODUCED_MP4.length);
    assert.equal(final?.container, "mp4");
    assert.ok(workDirGone, "the job workDir is removed");
  });

  it("keeps the v1 MPEG-TS path on the MPEG-TS demuxer and the unchanged argv", async () => {
    const requests = network({
      [PLAYLIST_URL]: () => body(tsPlaylist()),
      ...Object.fromEntries(TS_FRAGMENTS.map((url, i) => [url, () => body(FRAGMENT_BYTES[i]!)])),
    });
    const spawned = processes();
    const { final } = await runJob();
    assert.equal(final?.status, "ready");
    assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL, ...TS_FRAGMENTS]);
    assert.ok(requests.every((r) => r.status === "downloading"));
    assert.equal(spawned.filter((s) => s.status !== "processing").length, 0);
    const probe = spawned[0]!;
    assert.equal(probe.args[probe.args.indexOf("-f") + 1], "mpegts");
    assert.equal(path.basename(probe.args[probe.args.length - 1]!), AGGREGATE_FILE_NAME);
    const remux = spawned[1]!;
    assert.deepEqual(
      remux.args,
      buildClearHlsRemuxArgs({
        sourcePath: remux.args[remux.args.indexOf("-i") + 1]!,
        outputPath: remux.args[remux.args.length - 1]!,
      }),
    );
  });
});

describe("HLS v2 boundary: every fMP4 failure fails closed before any media tool", () => {
  const failsClosed = async (expectedCode: string) => {
    const { final, workDirGone } = await runJob();
    assert.equal(final?.status, "failed", `status ${final?.status}`);
    assert.equal(final?.errorCode, expectedCode);
    assert.equal(world.puts.length, 0, "no upload");
    assert.ok(workDirGone, "no media residue: the job workDir is removed");
  };

  it("refuses a drifted playlist with a byte-range map, requesting neither map nor fragment", async () => {
    const requests = network({
      [PLAYLIST_URL]: () => body(fmp4Playlist('#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"')),
    });
    const spawned = processes();
    await failsClosed("FORMAT_UNAVAILABLE");
    assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL]);
    assert.equal(spawned.length, 0);
  });

  it("refuses a drifted playlist that became live, encrypted or discontinuous", async () => {
    for (const drift of [
      (text: string) => text.replace("#EXT-X-ENDLIST\n", ""),
      (text: string) => text.replace("#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-PLAYLIST-TYPE:EVENT"),
      (text: string) => text.replace("#EXT-X-VERSION:7", '#EXT-X-VERSION:7\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"'),
      (text: string) => text.replace("#EXTINF:2.0,\nseg-1.m4s", "#EXT-X-DISCONTINUITY\n#EXTINF:2.0,\nseg-1.m4s"),
    ]) {
      world.puts.length = 0;
      const requests = network({ [PLAYLIST_URL]: () => body(drift(fmp4Playlist())) });
      const spawned = processes();
      await failsClosed("FORMAT_UNAVAILABLE");
      assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL]);
      assert.equal(spawned.length, 0);
    }
  });

  it("fails on an initialization-map HTTP failure without requesting a fragment", async () => {
    const requests = network({ ...fmp4Routes(), [INIT_URL]: { status: 404 } });
    const spawned = processes();
    await failsClosed("NETWORK_ERROR");
    assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL, INIT_URL]);
    assert.equal(spawned.length, 0);
  });

  it("fails on a fragment failure after the map, with nothing processed", async () => {
    const requests = network({ ...fmp4Routes(), [FRAGMENTS[1]!]: { status: 500 } });
    const spawned = processes();
    await failsClosed("NETWORK_ERROR");
    assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL, INIT_URL, FRAGMENTS[0], FRAGMENTS[1]]);
    assert.equal(spawned.length, 0);
  });

  it("refuses a map that redirects to a private destination", async () => {
    const requests = network(
      { ...fmp4Routes(), [INIT_URL]: { status: 302, headers: { location: "https://private.example.invalid/init.mp4" } } },
      { "private.example.invalid": [PRIVATE] },
    );
    const spawned = processes();
    await failsClosed("NETWORK_ERROR");
    assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL, INIT_URL]);
    assert.equal(spawned.length, 0);
  });

  it("counts the map against the ONE byte limit: TOO_LARGE with nothing processed", async () => {
    const total = INIT_BYTES.length + FRAGMENT_BYTES.reduce((n, b) => n + b.length, 0);
    const saved = config.maxFileSize;
    Object.assign(config, { maxFileSize: total - 1 });
    try {
      const requests = network(fmp4Routes());
      const spawned = processes();
      await failsClosed("TOO_LARGE");
      assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL, INIT_URL, ...FRAGMENTS]);
      assert.equal(spawned.length, 0);
    } finally {
      Object.assign(config, { maxFileSize: saved });
    }
  });

  it("times out on the one acquisition deadline while the map never answers", async () => {
    const saved = config.downloadTimeoutMs;
    Object.assign(config, { downloadTimeoutMs: 60 });
    try {
      const requests = network({
        ...fmp4Routes(),
        [INIT_URL]: (args) =>
          new Promise<Served>((_, reject) => {
            args.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      });
      const spawned = processes();
      await failsClosed("TIMEOUT");
      assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL, INIT_URL]);
      assert.equal(spawned.length, 0);
    } finally {
      Object.assign(config, { downloadTimeoutMs: saved });
    }
  });

  it("cancels during the map with no residue, no processing and no upload", async () => {
    const ref: { executor?: JobExecutor } = {};
    const requests = network({
      ...fmp4Routes(),
      [INIT_URL]: (args) => {
        ref.executor!.cancel(world.jobId!);
        return new Promise<Served>((_, reject) => {
          if (args.signal?.aborted) reject(new Error("aborted"));
          args.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const spawned = processes();
    const { final, workDirGone } = await runJob(ref);
    assert.equal(final?.status, "cancelled");
    assert.deepEqual(requests.map((r) => r.url), [PLAYLIST_URL, INIT_URL]);
    assert.equal(spawned.length, 0);
    assert.equal(world.puts.length, 0);
    assert.ok(workDirGone);
  });
});
