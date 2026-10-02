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
import { buildSplitMergeArgs } from "@/services/processing/ffmpeg.server.ts";
import { resolveFfprobePath } from "@/services/processing/ffprobe.server.ts";
import { decideMergeSync } from "@/services/processing/merge-sync.ts";
import { setProcessRunnerTestHooks, type SpawnImpl } from "@/services/processing/process-runner.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema, type WorkerVideoMetadata } from "@/shared/worker/contracts";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import type { ObjectStorePutInput, ObjectStoreWriter } from "@/worker/storage/writer.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import {
  SEPARATE_AUDIO_FMP4_FILE_NAME,
  SEPARATE_VIDEO_FMP4_FILE_NAME,
} from "../hls/hls-fragment-acquisition.server.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";

/**
 * HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001: the durable lifecycle
 * boundary for the separate-audio family, through the PRODUCTION composition.
 *
 * Nothing above the two lowest layers is replaced: the ORDINARY planner
 * (`deriveExecutionPlan`, three-way ownership), the separate-audio orchestration
 * seam, the real HLS-2 preflights, the real HLS-3 acquisitions, and the SHARED
 * local merge (`mergeSplitMedia`) with its real synchronization decision all
 * run. Only safe-HTTP's DNS answer and one-shot request, and the process
 * runner's spawn, are scripted — both recording the durable job status at the
 * instant each request or process begins.
 *
 *   downloading  = BOTH media-playlist preflights + BOTH fMP4 acquisitions
 *   processing   = ffprobe (both halves) + ONE FFmpeg merge + output probe
 *   uploading    = the object store
 *
 * Any media processing that leaked back into `downloading` fails here.
 */

const PUBLIC: DnsAnswer = { address: "8.8.8.8", family: 4 };
const PAGE_URL = "https://example.com/watch/separate";
const TOKEN = "PRIVATE_SEPARATE_TOKEN";
const DIR = "https://media.example.com/hls/";
const VIDEO_PL = `${DIR}video/media.m3u8?vtok=${TOKEN}`;
const AUDIO_PL = `${DIR}audio/media.m3u8?atok=${TOKEN}`;
const V_INIT = `${DIR}video/init.mp4`;
const A_INIT = `${DIR}audio/init.mp4`;
const V_FRAGS = [`${DIR}video/seg-0.m4s`, `${DIR}video/seg-1.m4s`];
const A_FRAGS = [`${DIR}audio/seg-0.m4s`, `${DIR}audio/seg-1.m4s`, `${DIR}audio/seg-2.m4s`];

const V_INIT_BYTES = Buffer.alloc(30, 0x76);
const A_INIT_BYTES = Buffer.alloc(20, 0x61);
const V_FRAG_BYTES = [Buffer.alloc(100, 0x56), Buffer.alloc(110, 0x57)];
const A_FRAG_BYTES = [Buffer.alloc(40, 0x41), Buffer.alloc(41, 0x42), Buffer.alloc(42, 0x43)];
const PRODUCED_MP4 = Buffer.alloc(321, 0x4d);

const TESTDATA = path.join(import.meta.dirname, "../../services/processing/testdata");
const pinned = (name: string) => fs.readFileSync(path.join(TESTDATA, `pinned-ffprobe-${name}.json`), "utf8");

function fmp4Playlist(init: string, frags: readonly string[], extra: string[] = []): string {
  const base = init.slice(0, init.lastIndexOf("/") + 1);
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:1",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...extra,
    `#EXT-X-MAP:URI="${init.slice(base.length)}"`,
    ...frags.flatMap((url) => ["#EXTINF:1.0,", url.slice(base.length)]),
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

function tsPlaylist(): string {
  return ["#EXTM3U", "#EXT-X-TARGETDURATION:1", "#EXTINF:1.0,", "seg-0.ts", "#EXT-X-ENDLIST", ""].join("\n");
}

// ── Durable state, the object store, the executor ───────────────────────────

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "separate-hls-boundary-"));
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
  const preset = (id: string) => ({
    id,
    label: id,
    resolution: "1080p",
    container: "mp4",
    fileSize: null,
    hasVideo: true,
    hasAudio: true,
    formatId: id,
    videoCodec: null,
    audioCodec: null,
    fps: null,
  });
  return VideoMetadataSchema.parse({
    title: "A separate-audio clip",
    thumbnail: null,
    duration: 3,
    source: "example.com",
    extractor: "yt-dlp",
    webpageUrl: PAGE_URL,
    formats: [],
    presets: [preset("preset:best"), preset("preset:1080")],
    capabilities: { mp3: false, merge: false },
  });
}

/**
 * Only the fresh analysis and the capacity reader are injected. Plan
 * derivation is the ORDINARY planner, and every HLS / merge seam is the
 * executor's production default.
 */
function productionDeps(): JobExecutorDeps {
  const pair = Object.freeze({ videoPlaylistUrl: VIDEO_PL, audioPlaylistUrl: AUDIO_PL, height: 1080 });
  const analysis: ExecutionAnalysis = {
    strategy: "yt-dlp",
    video: meta(),
    selections: {},
    hlsSelections: {},
    separateHlsSelections: Object.freeze({ "preset:best": pair, "preset:1080": pair }),
  };
  return {
    analyzeForExecution: async () => analysis,
    availableWorkDirBytes: async () => Number.MAX_SAFE_INTEGER,
  };
}

async function runJob(executorRef?: { executor?: JobExecutor }) {
  world.store.createJob({ url: PAGE_URL, formatId: "preset:1080", principalId: "private-access-user" }, randomUUID());
  const job = world.store.claimNextQueuedJob();
  assert.ok(job);
  world.jobId = job.jobId;
  const executor = new JobExecutor(world.store, world.writer, () => Date.now(), new Map(), productionDeps());
  if (executorRef) executorRef.executor = executor;
  await executor.execute(job);
  const final = world.store.getJob(job.jobId);
  const workDirGone = !fs.existsSync(path.join(world.tempDir, "jobs", job.jobId));
  return { final, workDirGone, jobId: job.jobId };
}

// ── The two scripted layers ──────────────────────────────────────────────────

type Served = { status?: number; headers?: IncomingHttpHeaders; body?: Readable | null };
type Route = Served | ((args: Parameters<SafeRequestOnce>[0]) => Served | Promise<Served>);

function network(routes: Record<string, Route>) {
  const requests: { url: string; status: string }[] = [];
  setSafeHttpTestHooks({
    lookup: async () => [PUBLIC],
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

function routes(): Record<string, Route> {
  return {
    [VIDEO_PL]: () => body(fmp4Playlist(V_INIT, V_FRAGS)),
    [AUDIO_PL]: () => body(fmp4Playlist(A_INIT, A_FRAGS)),
    [V_INIT]: () => body(V_INIT_BYTES),
    [A_INIT]: () => body(A_INIT_BYTES),
    ...Object.fromEntries(V_FRAGS.map((url, i) => [url, () => body(V_FRAG_BYTES[i]!)])),
    ...Object.fromEntries(A_FRAGS.map((url, i) => [url, () => body(A_FRAG_BYTES[i]!)])),
  };
}

const ALL_REQUESTS = [VIDEO_PL, AUDIO_PL, V_INIT, ...V_FRAGS, A_INIT, ...A_FRAGS];

type Spawned = { tool: "ffprobe" | "ffmpeg" | "other"; status: string; args: string[]; inputBytes: Buffer | null };

/**
 * Every spawn is recorded with the durable status at that instant. ffprobe
 * answers by WHICH half it was handed (the pinned timed captures), and the
 * merge writes the produced MP4 to its last argument.
 */
function processes(captures: { video?: string; audio?: string; output?: string } = {}): Spawned[] {
  const spawned: Spawned[] = [];
  const ffprobe = resolveFfprobePath();
  const children: (EventEmitter & { pid: number })[] = [];
  const spawn: SpawnImpl = (command, args) => {
    const tool = command === ffprobe ? "ffprobe" : command === config.ffmpegPath ? "ffmpeg" : "other";
    const input = args[args.indexOf("-i") + 1];
    spawned.push({ tool, status: world.status(), args: [...args], inputBytes: input && fs.existsSync(input) ? fs.readFileSync(input) : null });
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.pid = 92_000 + spawned.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    children.push(child);
    queueMicrotask(() => {
      if (tool === "ffprobe") {
        const name = path.basename(input ?? "");
        const capture =
          name === SEPARATE_VIDEO_FMP4_FILE_NAME
            ? (captures.video ?? "timed-iso-bmff-video-only")
            : name === SEPARATE_AUDIO_FMP4_FILE_NAME
              ? (captures.audio ?? "timed-iso-bmff-audio-only-late")
              : (captures.output ?? "iso-bmff-merged");
        child.stdout.write(pinned(capture));
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

function durableRow(): string {
  return JSON.stringify(world.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(world.jobId));
}

const PRIVATE_NEEDLES = [TOKEN, "media.example.com", "m3u8", "init.mp4", "seg-", "clear-hls-separate-audio-remux", "hls-video", "hls-audio"];

// ─────────────────────────────────────────────────────────────────────────────

describe("separate-audio boundary: a proven pair through the production composition", () => {
  it("acquires only while downloading, merges only while processing, and reaches ready", async () => {
    const requests = network(routes());
    const spawned = processes();
    const { final, workDirGone } = await runJob();

    assert.equal(final?.status, "ready", `final ${final?.status} ${final?.errorCode ?? ""}`);
    // BOTH preflights, then the whole video half, then the whole audio half.
    assert.deepEqual(requests.map((r) => r.url), ALL_REQUESTS);
    assert.ok(requests.every((r) => r.status === "downloading"), JSON.stringify(requests.map((r) => r.status)));
    // No media tool while downloading; every one while processing.
    assert.equal(spawned.filter((s) => s.status === "downloading").length, 0, "no ffprobe/FFmpeg while downloading");
    assert.deepEqual(spawned.map((s) => `${s.tool}@${s.status}`), [
      "ffprobe@processing",
      "ffprobe@processing",
      "ffmpeg@processing",
      "ffprobe@processing",
    ]);

    // The two input probes are the timed ones, on the explicit ISO-BMFF demuxer,
    // over exactly the bytes each half acquired.
    const [videoProbe, audioProbe, merge, outputProbe] = spawned as [Spawned, Spawned, Spawned, Spawned];
    for (const probe of [videoProbe, audioProbe]) {
      assert.equal(probe.args[probe.args.indexOf("-f") + 1], "mov");
      assert.equal(probe.args[probe.args.indexOf("-show_entries") + 1], "format=format_name,start_time:stream=codec_type");
    }
    assert.equal(path.basename(videoProbe.args.at(-1)!), SEPARATE_VIDEO_FMP4_FILE_NAME);
    assert.deepEqual(videoProbe.inputBytes, Buffer.concat([V_INIT_BYTES, ...V_FRAG_BYTES]));
    assert.equal(path.basename(audioProbe.args.at(-1)!), SEPARATE_AUDIO_FMP4_FILE_NAME);
    assert.deepEqual(audioProbe.inputBytes, Buffer.concat([A_INIT_BYTES, ...A_FRAG_BYTES]));

    // The merge is EXACTLY the shared seam's argv for the shared decision: the
    // audio half starts later (0.453991 s vs 0.000000 s), so the video input is
    // the reference and `-isync 0` precedes the audio input.
    const videoPath = merge.args[merge.args.indexOf("-i") + 1]!;
    const audioPath = merge.args[merge.args.lastIndexOf("-i") + 1]!;
    assert.deepEqual(
      merge.args,
      buildSplitMergeArgs({
        target: "mp4",
        videoPath,
        audioPath,
        outputPath: merge.args.at(-1)!,
        sync: decideMergeSync({ target: "mp4", videoStartUs: 0, audioStartUs: 453_991 }),
      }),
    );
    assert.deepEqual(merge.args.slice(merge.args.indexOf("-isync"), merge.args.indexOf("-isync") + 2), ["-isync", "0"]);
    assert.ok(merge.args.indexOf("-isync") > merge.args.indexOf(videoPath), "the option belongs to the audio input");
    for (const forbidden of ["-copyts", "-start_at_zero", "-avoid_negative_ts", "-itsoffset", "-shortest", "-y"]) {
      assert.equal(merge.args.includes(forbidden), false, forbidden);
    }
    assert.equal(path.basename(outputProbe.args.at(-1)!), "merged.mp4");

    // Upload: once, while uploading, the merged MP4 — never a half.
    assert.equal(world.puts.length, 1);
    assert.equal(world.puts[0]!.status, "uploading");
    assert.equal(world.puts[0]!.input.contentLength, PRODUCED_MP4.length);
    assert.equal(world.puts[0]!.input.contentType, "video/mp4");
    assert.equal(final?.fileSize, PRODUCED_MP4.length);
    assert.equal(final?.container, "mp4");
    assert.ok(workDirGone, "the job workDir is removed");

    // Nothing private reached durable state, the ready view, or the object.
    const surfaces = [durableRow(), JSON.stringify(final), world.puts[0]!.input.objectKey, JSON.stringify({ ...world.puts[0]!.input, body: null })];
    for (const surface of surfaces) {
      for (const needle of PRIVATE_NEEDLES) assert.equal(surface.includes(needle), false, needle);
    }
  });

  it("takes the shared decision in BOTH directions: a later video is synced to the audio", async () => {
    network(routes());
    const spawned = processes({ video: "timed-iso-bmff-video-only-late", audio: "timed-iso-bmff-audio-only" });
    const { final } = await runJob();
    assert.equal(final?.status, "ready");
    const merge = spawned.find((s) => s.tool === "ffmpeg")!;
    const firstInput = merge.args.indexOf("-i");
    assert.deepEqual(merge.args.slice(merge.args.indexOf("-isync"), merge.args.indexOf("-isync") + 2), ["-isync", "1"]);
    assert.ok(merge.args.indexOf("-isync") < firstInput, "the option belongs to the video input");
  });

  it("makes the video the reference on an exact tie", async () => {
    network(routes());
    const spawned = processes({ video: "timed-iso-bmff-video-only", audio: "timed-iso-bmff-audio-only" });
    await runJob();
    const merge = spawned.find((s) => s.tool === "ffmpeg")!;
    assert.deepEqual(merge.args.slice(merge.args.indexOf("-isync"), merge.args.indexOf("-isync") + 2), ["-isync", "0"]);
  });
});

describe("separate-audio boundary: every failure fails closed before any media tool", () => {
  const failsClosed = async (expectedCode: string) => {
    const { final, workDirGone } = await runJob();
    assert.equal(final?.status, "failed", `status ${final?.status}`);
    assert.equal(final?.errorCode, expectedCode);
    assert.equal(world.puts.length, 0, "no upload");
    assert.ok(workDirGone, "no media residue: the job workDir is removed");
    const row = durableRow();
    for (const needle of PRIVATE_NEEDLES) assert.equal(row.includes(needle), false, needle);
  };

  it("refuses an MPEG-TS audio half after both preflights, requesting no map and no fragment", async () => {
    const requests = network({ ...routes(), [AUDIO_PL]: () => body(tsPlaylist()) });
    const spawned = processes();
    await failsClosed("FORMAT_UNAVAILABLE");
    assert.deepEqual(requests.map((r) => r.url), [VIDEO_PL, AUDIO_PL]);
    assert.equal(spawned.length, 0);
  });

  it("refuses an MPEG-TS video half the same way", async () => {
    const requests = network({ ...routes(), [VIDEO_PL]: () => body(tsPlaylist()) });
    processes();
    await failsClosed("FORMAT_UNAVAILABLE");
    assert.deepEqual(requests.map((r) => r.url), [VIDEO_PL, AUDIO_PL]);
  });

  it("refuses an encrypted video playlist before the audio playlist is even requested", async () => {
    const requests = network({
      ...routes(),
      [VIDEO_PL]: () => body(fmp4Playlist(V_INIT, V_FRAGS, ['#EXT-X-KEY:METHOD=AES-128,URI="k.bin"'])),
    });
    const spawned = processes();
    await failsClosed("FORMAT_UNAVAILABLE");
    assert.deepEqual(requests.map((r) => r.url), [VIDEO_PL]);
    assert.equal(spawned.length, 0);
  });

  it("refuses byte ranges, discontinuities and live shapes on the audio half", async () => {
    for (const extra of [["#EXT-X-BYTERANGE:10@0"], ["#EXT-X-DISCONTINUITY"], []]) {
      world.puts.length = 0;
      const text = extra.length > 0 ? fmp4Playlist(A_INIT, A_FRAGS, extra) : fmp4Playlist(A_INIT, A_FRAGS).replace("#EXT-X-ENDLIST\n", "");
      const requests = network({ ...routes(), [AUDIO_PL]: () => body(text) });
      const spawned = processes();
      await failsClosed("FORMAT_UNAVAILABLE");
      assert.deepEqual(requests.map((r) => r.url), [VIDEO_PL, AUDIO_PL]);
      assert.equal(spawned.length, 0);
    }
  });

  it("fails on the audio map after the whole video half, with nothing processed", async () => {
    const requests = network({ ...routes(), [A_INIT]: { status: 404 } });
    const spawned = processes();
    await failsClosed("NETWORK_ERROR");
    assert.deepEqual(requests.map((r) => r.url), [VIDEO_PL, AUDIO_PL, V_INIT, ...V_FRAGS, A_INIT]);
    assert.equal(spawned.length, 0);
  });

  it("holds BOTH halves to ONE byte budget: TOO_LARGE inside the audio half, nothing processed", async () => {
    const total = [V_INIT_BYTES, ...V_FRAG_BYTES, A_INIT_BYTES, ...A_FRAG_BYTES].reduce((n, b) => n + b.length, 0);
    const saved = config.maxFileSize;
    Object.assign(config, { maxFileSize: total - 1 });
    try {
      const requests = network(routes());
      const spawned = processes();
      await failsClosed("TOO_LARGE");
      assert.deepEqual(requests.map((r) => r.url), ALL_REQUESTS, "the video half fits; the audio half's last fragment does not");
      assert.equal(spawned.length, 0);
    } finally {
      Object.assign(config, { maxFileSize: saved });
    }
  });

  it("refuses a 'video' half whose real probe shows audio, before any FFmpeg", async () => {
    network(routes());
    const spawned = processes({ video: "iso-bmff-merged" });
    await failsClosed("PROCESSING_FAILED");
    assert.deepEqual(spawned.map((s) => `${s.tool}@${s.status}`), ["ffprobe@processing"]);
  });

  it("refuses an 'audio' half whose real probe shows video, before any FFmpeg", async () => {
    network(routes());
    const spawned = processes({ audio: "timed-iso-bmff-video-only" });
    await failsClosed("PROCESSING_FAILED");
    assert.deepEqual(spawned.map((s) => s.tool), ["ffprobe", "ffprobe"]);
  });

  it("cancels during the audio half with no residue, no processing and no upload", async () => {
    const ref: { executor?: JobExecutor } = {};
    const requests = network({
      ...routes(),
      [A_INIT]: (args) => {
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
    assert.deepEqual(requests.map((r) => r.url), [VIDEO_PL, AUDIO_PL, V_INIT, ...V_FRAGS, A_INIT]);
    assert.equal(spawned.length, 0);
    assert.equal(world.puts.length, 0);
    assert.ok(workDirGone);
  });

  it("times out on the ONE shared acquisition deadline", async () => {
    const saved = config.downloadTimeoutMs;
    Object.assign(config, { downloadTimeoutMs: 60 });
    try {
      const requests = network({
        ...routes(),
        [A_FRAGS[1]!]: (args) =>
          new Promise<Served>((_, reject) => {
            args.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      });
      const spawned = processes();
      await failsClosed("TIMEOUT");
      assert.ok(requests.length >= 1);
      assert.equal(spawned.length, 0);
    } finally {
      Object.assign(config, { downloadTimeoutMs: saved });
    }
  });
});
