import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "@/lib/config";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { setProcessRunnerTestHooks } from "@/services/processing/process-runner.server";
import { resolveFfprobePath } from "@/services/processing/ffprobe.server";
import { VideoMetadataSchema, type WorkerRequestedFormatId } from "@/shared/worker/contracts";
import type { DurableWorkerJob } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import { JobExecutor, type DownloadGenericSplitFn } from "./job-executor.server.ts";
import type { ExecutionAnalysis } from "../analysis/media-analyzer.server.ts";
import { GenericPresetSourceSchema } from "./generic-source.ts";
import { downloadGenericSplitSources } from "./ytdlp-download.server.ts";
import { YTDLP_RUNTIME } from "../runtime/ytdlp-runtime.server.ts";

/**
 * SPLIT-04: the REAL primitives inside the executor.
 *
 * SPLIT-03's `downloadGenericSplitSources` and SPLIT-02's `mergeSplitMedia` —
 * the latter as the executor's own PRODUCTION DEFAULT, never injected — run
 * unmodified inside JobExecutor. Only what lies beyond them is faked:
 *
 *   - SPLIT-03's yt-dlp runner, runtime probe and URL validation: no network
 *     and no yt-dlp. The fake runner writes the file the REAL argv's
 *     `--output` template names;
 *   - SPLIT-02's subprocesses, through the process-runner hooks: ffprobe
 *     answers by the INPUT PATH it was given, and FFmpeg writes the output its
 *     REAL argv names. `processKill` is always hooked, so no real process
 *     group is ever signalled.
 *
 * Every subprocess records the durable status at the instant it is spawned.
 */

const SPLIT_URL = "https://example.invalid/watch/split";
const LIMITS = { maxFileSizeBytes: 1000, downloadTimeoutSeconds: 600 };
const ISO = "mov,mp4,m4a,3gp,3g2,mj2";
const WEBM = "matroska,webm";

type SplitTarget = "mp4" | "webm";
const PAIR_SHAPE = {
  mp4: { video: "mp4", audio: "m4a", preset: "preset:1080" },
  webm: { video: "webm", audio: "webm", preset: "preset:720" },
} as const;

const VIDEO_BYTES = "VIDEO-HALF-BYTES";
const AUDIO_BYTES = "AUDIO-HALF";
const mergedBytes = (target: string) => `MERGED-${target.toUpperCase()}-ARTIFACT`;

function splitAnalysis(target: SplitTarget): ExecutionAnalysis {
  const shape = PAIR_SHAPE[target];
  const member = (role: "video" | "audio") => ({
    formatId: role === "video" ? "137" : "140",
    protocol: "https",
    container: shape[role],
    hasVideo: role === "video",
    hasAudio: role === "audio",
    videoConstraint: role === "video" ? "codec-present" : "absent",
    audioConstraint: role === "audio" ? "codec-present" : "absent",
    fileSize: null,
  });
  return {
    strategy: "yt-dlp",
    video: VideoMetadataSchema.parse({
      title: "A Split Clip",
      thumbnail: null,
      duration: 120,
      source: "example.invalid",
      extractor: "yt-dlp",
      webpageUrl: SPLIT_URL,
      formats: [],
      presets: [
        {
          id: shape.preset,
          label: shape.preset,
          resolution: "1080p",
          container: target,
          fileSize: null,
          hasVideo: true,
          hasAudio: true,
          formatId: shape.preset,
          videoCodec: "h264",
          audioCodec: "aac",
          fps: null,
        },
      ],
      capabilities: { mp3: true, merge: false },
    }),
    selections: {
      [shape.preset]: GenericPresetSourceSchema.parse({
        kind: "split",
        pair: { video: member("video"), audio: member("audio") },
      }),
    },
    // No preset here is owned by clear HLS, so the HLS half of the fresh
    // analysis is empty — which the ordinary planner reads since HLS-7.
    hlsSelections: {},
  };
}

type Harness = {
  tempDir: string;
  jobsRoot: string;
  db: DatabaseSync;
  store: SQLiteJobStore;
  failCalls: string[];
  puts: ObjectStorePutInput[];
  uploaded: string[];
  writer: ObjectStoreWriter;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "split-prim-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const store = new SQLiteJobStore({ db });
  const failCalls: string[] = [];
  const realFail = store.failJob.bind(store);
  store.failJob = (jobId: string, code: string, message: string) => {
    failCalls.push(code);
    return realFail(jobId, code, message);
  };
  const puts: ObjectStorePutInput[] = [];
  const uploaded: string[] = [];
  const writer: ObjectStoreWriter = {
    async put(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      uploaded.push(Buffer.concat(chunks).toString("utf8"));
      puts.push(input);
    },
    async head(key) {
      const last = puts.find((p) => p.objectKey === key);
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
  };
  return {
    tempDir,
    jobsRoot: path.join(fs.realpathSync(tempDir), "jobs"),
    db,
    store,
    failCalls,
    puts,
    uploaded,
    writer,
    cleanup: () => {
      db.close();
      setTempDirectoryForTests(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function claimJob(store: SQLiteJobStore, formatId: WorkerRequestedFormatId): DurableWorkerJob {
  store.createJob({ url: SPLIT_URL, formatId, principalId: "private-access-user" }, randomUUID());
  const job = store.claimNextQueuedJob();
  assert.ok(job);
  return job;
}

type YtdlpRun = { role: "video" | "audio"; status: string; signal?: AbortSignal };

/** The REAL SPLIT-03 primitive, with only its yt-dlp boundary faked. */
function realSplitDownload(
  h: Harness,
  jobId: string,
  target: SplitTarget,
  runs: YtdlpRun[],
  beforeWrite?: (run: YtdlpRun) => Promise<void> | void,
): DownloadGenericSplitFn {
  return (url, workDir, plan, ctx) =>
    downloadGenericSplitSources(url, workDir, plan, {
      limits: ctx.limits,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      validateUrl: async (raw) => ({ url: raw, hostname: "example.invalid" }),
      probeRuntime: async () => ({
        available: true,
        version: YTDLP_RUNTIME.expectedVersion,
        reason: "ok" as const,
      }),
      runner: async (call) => {
        const template = call.args.find((a) => a.startsWith("--output="))!.slice("--output=".length);
        const role = path.basename(template).startsWith("video-source") ? "video" : "audio";
        const run: YtdlpRun = { role, status: h.store.getJob(jobId)!.status, signal: call.signal };
        runs.push(run);
        await beforeWrite?.(run);
        const container = PAIR_SHAPE[target][role];
        fs.writeFileSync(template.replace("%(ext)s", container), role === "video" ? VIDEO_BYTES : AUDIO_BYTES);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
}

type Child = EventEmitter & {
  pid?: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
};
type Spawn = { command: string; args: string[]; status: string; pid: number };

/**
 * Fakes SPLIT-02's subprocesses. ffprobe answers by the basename of the input
 * it was ACTUALLY given, so a swapped half is probed as what it really is.
 * `hangAt` names a spawn that never exits unless its group is killed.
 */
function hookSubprocesses(
  h: Harness,
  jobId: string,
  target: SplitTarget,
  opts: { hangAt?: number; onSpawn?: (index: number) => void } = {},
) {
  const spawns: Spawn[] = [];
  const children: Child[] = [];
  const groupKills: number[] = [];
  setProcessRunnerTestHooks({
    platform: "linux",
    spawn: (command, args) => {
      const index = spawns.length;
      const child = new EventEmitter() as Child;
      child.pid = 81_000 + index;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      children.push(child);
      spawns.push({ command, args: [...args], status: h.store.getJob(jobId)!.status, pid: child.pid });
      queueMicrotask(() => {
        if (index === opts.hangAt) return;
        const last = args[args.length - 1]!;
        if (command === config.ffmpegPath) {
          fs.writeFileSync(last, mergedBytes(target));
        } else {
          const base = path.basename(last);
          const kinds = base.startsWith("video-source")
            ? ["video"]
            : base.startsWith("audio-source")
              ? ["audio"]
              : ["video", "audio"];
          child.stdout.write(
            JSON.stringify({
              programs: [],
              streams: kinds.map((codec_type) => ({ codec_type })),
              format: { format_name: target === "mp4" ? ISO : WEBM },
            }),
          );
        }
        setImmediate(() => child.emit("close", 0));
      });
      opts.onSpawn?.(index);
      return child as unknown as ChildProcess;
    },
    processKill: (pid) => {
      groupKills.push(pid);
      const owner = children.find((c) => c.pid === -pid);
      if (owner) queueMicrotask(() => owner.emit("close", null));
      return true;
    },
  });
  return { spawns, groupKills };
}

function executorFor(h: Harness, downloadGenericSplit: DownloadGenericSplitFn, target: SplitTarget) {
  // `mergeSplit` is deliberately NOT injected: the production default runs.
  return new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
    analyzeForExecution: async () => splitAnalysis(target),
    availableWorkDirBytes: async () => 2 * LIMITS.maxFileSizeBytes,
    genericLimits: LIMITS,
    downloadGenericSplit,
    downloadGeneric: async () => {
      throw new Error("unreachable: single-source seam");
    },
    processLocally: async () => {
      throw new Error("unreachable: one-input seam");
    },
  });
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  setProcessRunnerTestHooks(null);
  h.cleanup();
});

describe("SPLIT-04 real primitives: the lifecycle HARD GATE at every real subprocess", () => {
  for (const target of ["mp4", "webm"] as const) {
    it(`${target}: every yt-dlp run is downloading; every ffprobe and the FFmpeg merge are processing`, async () => {
      const shape = PAIR_SHAPE[target];
      const job = claimJob(h.store, shape.preset);
      const runs: YtdlpRun[] = [];
      const { spawns } = hookSubprocesses(h, job.jobId, target);

      await executorFor(h, realSplitDownload(h, job.jobId, target, runs), target).execute(job);

      const view = h.store.getJob(job.jobId)!;
      assert.equal(view.status, "ready", `${view.errorCode}`);
      assert.deepEqual(
        runs.map((r) => `${r.role}=${r.status}`),
        ["video=downloading", "audio=downloading"],
        "SPLIT-03 ran both halves, video first, while downloading",
      );

      const workDir = path.join(h.jobsRoot, job.jobId);
      const ffprobe = resolveFfprobePath();
      assert.deepEqual(
        spawns.map((s) => [s.command, path.basename(s.args[s.args.length - 1]!), s.status]),
        [
          [ffprobe, `video-source.${shape.video}`, "processing"],
          [ffprobe, `audio-source.${shape.audio}`, "processing"],
          [config.ffmpegPath, `merged.${target}`, "processing"],
          [ffprobe, `merged.${target}`, "processing"],
        ],
      );

      // The merge argv binds each half to its role and never overwrites.
      const merge = spawns[2]!.args;
      const inputs = merge.flatMap((arg, i) => (arg === "-i" ? [merge[i + 1]] : []));
      assert.deepEqual(inputs, [
        path.join(workDir, `video-source.${shape.video}`),
        path.join(workDir, `audio-source.${shape.audio}`),
      ]);
      assert.ok(merge.includes("-n") && !merge.includes("-y"));

      assert.equal(view.container, target);
      assert.equal(view.mime, target === "mp4" ? "video/mp4" : "video/webm");
      assert.equal(h.uploaded[0], mergedBytes(target), "the uploaded artifact is the merge's output");
      assert.equal(fs.existsSync(workDir), false);
    });
  }

  it("a processing transition that does not return updated spawns ZERO split subprocesses", async () => {
    const job = claimJob(h.store, "preset:1080");
    const runs: YtdlpRun[] = [];
    const { spawns } = hookSubprocesses(h, job.jobId, "mp4");
    // The durable row turns terminal during the audio run; the signal stays live.
    const download = realSplitDownload(h, job.jobId, "mp4", runs, (run) => {
      if (run.role === "audio") h.store.cancelJob(job.jobId);
    });
    await executorFor(h, download, "mp4").execute(job);

    assert.equal(runs.length, 2, "acquisition itself completed");
    assert.equal(spawns.length, 0, "no ffprobe and no FFmpeg without processing committed");
    assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
    assert.equal(h.puts.length, 0);
  });
});

describe("SPLIT-04 real primitives: cancellation and shutdown reach the owned subprocess", () => {
  const untilAborted = (signal?: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      const fail = () => reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    });

  for (const role of ["video", "audio"] as const) {
    it(`cancel during the ${role} yt-dlp run: SPLIT-03 aborts it; nothing is probed or merged`, async () => {
      const job = claimJob(h.store, "preset:1080");
      const runs: YtdlpRun[] = [];
      const active: { executor?: JobExecutor } = {};
      const { spawns } = hookSubprocesses(h, job.jobId, "mp4");
      const download = realSplitDownload(h, job.jobId, "mp4", runs, async (run) => {
        if (run.role !== role) return;
        setTimeout(() => active.executor!.cancel(job.jobId), 5);
        await untilAborted(run.signal);
      });
      active.executor = executorFor(h, download, "mp4");
      await active.executor!.execute(job);

      assert.deepEqual(runs.map((r) => r.role), role === "video" ? ["video"] : ["video", "audio"]);
      assert.equal(runs.at(-1)!.signal?.aborted, true, "the executor's abort reached the yt-dlp run");
      assert.equal(spawns.length, 0);
      assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
      assert.deepEqual(h.failCalls, []);
      assert.equal(fs.existsSync(path.join(h.jobsRoot, job.jobId)), false);
    });
  }

  // [label, the spawn index that hangs until its group is killed]
  const processingStages = [
    ["the video input probe", 0],
    ["the audio input probe", 1],
    ["the FFmpeg merge", 2],
    ["the output probe", 3],
  ] as const;

  for (const [label, hangAt] of processingStages) {
    it(`cancel during ${label}: its process group is killed, nothing is uploaded, cancelled wins`, async () => {
      const job = claimJob(h.store, "preset:1080");
      const active: { executor?: JobExecutor } = {};
      const { spawns, groupKills } = hookSubprocesses(h, job.jobId, "mp4", {
        hangAt,
        onSpawn: (index) => {
          if (index === hangAt) setTimeout(() => active.executor!.cancel(job.jobId), 5);
        },
      });
      active.executor = executorFor(h, realSplitDownload(h, job.jobId, "mp4", []), "mp4");
      await active.executor!.execute(job);

      assert.equal(spawns.length, hangAt + 1, "nothing is spawned after the cancelled subprocess");
      assert.deepEqual(groupKills, [-spawns[hangAt]!.pid], "exactly that owned group was killed");
      assert.equal(spawns[hangAt]!.status, "processing");
      assert.equal(h.store.getJob(job.jobId)!.status, "cancelled");
      assert.deepEqual(h.failCalls, [], "user cancellation is not converted into a failure");
      assert.equal(h.puts.length, 0);
      assert.equal(fs.existsSync(path.join(h.jobsRoot, job.jobId)), false);
    });
  }

  it("operator shutdown during the merge: group killed, row stays processing, recover() classifies", async () => {
    const job = claimJob(h.store, "preset:1080");
    const active: { executor?: JobExecutor } = {};
    let aborted = -1;
    const { spawns, groupKills } = hookSubprocesses(h, job.jobId, "mp4", {
      hangAt: 2,
      onSpawn: (index) => {
        if (index === 2) setTimeout(() => (aborted = active.executor!.abortActiveForShutdown()), 5);
      },
    });
    active.executor = executorFor(h, realSplitDownload(h, job.jobId, "mp4", []), "mp4");
    await active.executor!.execute(job);

    assert.equal(aborted, 1);
    assert.deepEqual(groupKills, [-spawns[2]!.pid], "the FFmpeg group does not outlive the Worker");
    assert.equal(h.store.getJob(job.jobId)!.status, "processing", "the row is left ACTIVE");
    assert.deepEqual(h.failCalls, [], "the dying process commits no ordinary failure");
    assert.equal(fs.existsSync(path.join(h.jobsRoot, job.jobId)), false);

    h.store.recover();
    const recovered = h.store.getJob(job.jobId)!;
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.safeErrorMessage, "Worker restarted before the job completed.");
    assert.equal(recovered.stageLabel, "Worker restarted");
  });

  it("operator shutdown during the audio yt-dlp run: row stays downloading, recover() classifies", async () => {
    const job = claimJob(h.store, "preset:1080");
    const active: { executor?: JobExecutor } = {};
    const { spawns } = hookSubprocesses(h, job.jobId, "mp4");
    const download = realSplitDownload(h, job.jobId, "mp4", [], async (run) => {
      if (run.role !== "audio") return;
      setTimeout(() => active.executor!.abortActiveForShutdown(), 5);
      await untilAborted(run.signal);
    });
    active.executor = executorFor(h, download, "mp4");
    await active.executor!.execute(job);

    assert.equal(spawns.length, 0);
    assert.equal(h.store.getJob(job.jobId)!.status, "downloading");
    assert.deepEqual(h.failCalls, []);
    assert.equal(fs.existsSync(path.join(h.jobsRoot, job.jobId)), false);
    h.store.recover();
    assert.equal(h.store.getJob(job.jobId)!.safeErrorMessage, "Worker restarted before the job completed.");
  });
});

describe("YTDLP-MAX-FILESIZE-REFUSAL-CLASSIFICATION-001: a refused AUDIO half fails the split job TOO_LARGE", () => {
  it("video acquired, audio refused by the pinned --max-filesize: failed / TOO_LARGE, zero merge, processing and upload", async () => {
    const job = claimJob(h.store, "preset:1080");
    const runs: Array<{ role: string; maxFilesize: string | undefined; status: string }> = [];
    const transitions: string[] = [];
    const realBeginProcessing = h.store.beginProcessing.bind(h.store);
    h.store.beginProcessing = (...a: Parameters<SQLiteJobStore["beginProcessing"]>) => {
      transitions.push("beginProcessing");
      return realBeginProcessing(...a);
    };
    const { spawns } = hookSubprocesses(h, job.jobId, "mp4");

    let workDirSeen = "";
    // The REAL SPLIT-03 primitive: the video run writes its half, and the audio
    // run is refused exactly as the pinned runtime refuses — exit 0, nothing
    // written, one line on stdout naming the run's own allowance.
    const download: DownloadGenericSplitFn = (url, workDir, plan, ctx) => {
      workDirSeen = workDir;
      return downloadGenericSplitSources(url, workDir, plan, {
        limits: ctx.limits,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        validateUrl: async (raw) => ({ url: raw, hostname: "example.invalid" }),
        probeRuntime: async () => ({
          available: true,
          version: YTDLP_RUNTIME.expectedVersion,
          reason: "ok" as const,
        }),
        runner: async (call) => {
          const template = call.args.find((a) => a.startsWith("--output="))!.slice("--output=".length);
          const role = path.basename(template).startsWith("video-source") ? "video" : "audio";
          const maxFilesize = call.args
            .find((a) => a.startsWith("--max-filesize="))
            ?.slice("--max-filesize=".length);
          runs.push({ role, maxFilesize, status: h.store.getJob(job.jobId)!.status });
          if (role === "video") {
            fs.writeFileSync(template.replace("%(ext)s", "mp4"), VIDEO_BYTES);
            return { code: 0, stdout: "", stderr: "" };
          }
          return {
            code: 0,
            stdout: `\r[download] File is larger than max-filesize (5000 bytes > ${maxFilesize} bytes). Aborting.\n`,
            stderr: "",
          };
        },
      });
    };

    await executorFor(h, download, "mp4").execute(job);

    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "TOO_LARGE");
    assert.equal(view.safeErrorMessage, ERROR_MESSAGES.TOO_LARGE);
    assert.deepEqual(runs, [
      { role: "video", maxFilesize: String(LIMITS.maxFileSizeBytes), status: "downloading" },
      {
        role: "audio",
        maxFilesize: String(LIMITS.maxFileSizeBytes - VIDEO_BYTES.length),
        status: "downloading",
      },
    ]);
    assert.deepEqual(transitions, [], "processing never began, although a video half was on disk");
    assert.equal(spawns.length, 0, "no ffprobe and no FFmpeg merge");
    assert.deepEqual(h.failCalls, ["TOO_LARGE"]);
    assert.equal(h.puts.length, 0, "nothing uploaded");
    assert.ok(workDirSeen);
    assert.equal(fs.existsSync(workDirSeen), false, "the executor's finally removed the workDir, video half included");
  });

  it("video acquired, audio refused on a LATER chunk: failed / TOO_LARGE, the partial audio .part removed by the executor", async () => {
    const job = claimJob(h.store, "preset:1080");
    const runs: Array<{ role: string; maxFilesize: string | undefined }> = [];
    const transitions: string[] = [];
    const realBeginProcessing = h.store.beginProcessing.bind(h.store);
    h.store.beginProcessing = (...a: Parameters<SQLiteJobStore["beginProcessing"]>) => {
      transitions.push("beginProcessing");
      return realBeginProcessing(...a);
    };
    const { spawns } = hookSubprocesses(h, job.jobId, "mp4");

    let workDirSeen = "";
    let leftWhenAcquisitionThrew: string[] = [];
    const remainder = LIMITS.maxFileSizeBytes - VIDEO_BYTES.length;
    // The REAL SPLIT-03 primitive. The audio run is refused as the pinned
    // HttpFD refuses a LATER chunk of a chunked source: the chunks it admitted
    // are already in the half's own `.part`, then it prints the refusal of the
    // run's own allowance and exits 0.
    const download: DownloadGenericSplitFn = async (url, workDir, plan, ctx) => {
      workDirSeen = workDir;
      try {
        return await downloadGenericSplitSources(url, workDir, plan, {
          limits: ctx.limits,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          validateUrl: async (raw) => ({ url: raw, hostname: "example.invalid" }),
          probeRuntime: async () => ({
            available: true,
            version: YTDLP_RUNTIME.expectedVersion,
            reason: "ok" as const,
          }),
          runner: async (call) => {
            const template = call.args.find((a) => a.startsWith("--output="))!.slice("--output=".length);
            const role = path.basename(template).startsWith("video-source") ? "video" : "audio";
            const maxFilesize = call.args
              .find((a) => a.startsWith("--max-filesize="))
              ?.slice("--max-filesize=".length);
            runs.push({ role, maxFilesize });
            if (role === "video") {
              fs.writeFileSync(template.replace("%(ext)s", "mp4"), VIDEO_BYTES);
              return { code: 0, stdout: "", stderr: "" };
            }
            fs.writeFileSync(`${template.replace("%(ext)s", "m4a")}.part`, "x".repeat(remainder - 1));
            return {
              code: 0,
              stdout:
                `[download] Destination: ${template.replace("%(ext)s", "m4a")}\n` +
                `\r[download] File is larger than max-filesize (5000 bytes > ${maxFilesize} bytes). Aborting.\n`,
              stderr: "",
            };
          },
        });
      } catch (err) {
        leftWhenAcquisitionThrew = fs.readdirSync(workDir).sort();
        throw err;
      }
    };

    await executorFor(h, download, "mp4").execute(job);

    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "TOO_LARGE");
    assert.equal(view.safeErrorMessage, ERROR_MESSAGES.TOO_LARGE);
    assert.deepEqual(runs, [
      { role: "video", maxFilesize: String(LIMITS.maxFileSizeBytes) },
      { role: "audio", maxFilesize: String(remainder) },
    ]);
    assert.deepEqual(
      leftWhenAcquisitionThrew,
      ["audio-source.m4a.part", "video-source.mp4"],
      "acquisition deleted nothing: the validated video and the partial audio were the executor's to remove",
    );
    assert.deepEqual(transitions, [], "processing never began");
    assert.equal(spawns.length, 0, "no ffprobe and no FFmpeg merge");
    assert.deepEqual(h.failCalls, ["TOO_LARGE"]);
    assert.equal(h.puts.length, 0, "nothing uploaded");
    assert.equal(fs.existsSync(workDirSeen), false, "the executor's finally removed the workDir, partial .part included");
  });
});
