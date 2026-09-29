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
import { applyMigrations } from "@/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "@/worker/state/sqlite-job-store.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { setProcessRunnerTestHooks, type RunResult } from "@/services/processing/process-runner.server";
import { resolveFfprobePath } from "@/services/processing/ffprobe.server";
import type { WorkerRequestedFormatId } from "@/shared/worker/contracts";
import type { DurableWorkerJob } from "@/worker/state/job-store";
import type { ObjectStoreWriter, ObjectStorePutInput } from "@/worker/storage/writer.ts";
import { JobExecutor, type DownloadGenericSplitFn } from "./job-executor.server.ts";
import { downloadGenericSplitSources } from "./ytdlp-download.server.ts";
import { YTDLP_RUNTIME } from "../runtime/ytdlp-runtime.server.ts";
import { analyzeGenericMediaInternal } from "../analysis/ytdlp-analysis.server.ts";

/**
 * GENERIC-SEGMENTED-DASH-EXECUTION-001 — the deterministic full path.
 *
 *   analysis (REAL analyzer, pinned-shaped segmented `-J` document)
 *   -> preset:1080 advertised
 *   -> job created for it -> FRESH execution analysis (REAL analyzer again)
 *   -> merge-split plan (REAL derivation)
 *   -> native DASH video acquisition -> native DASH (or HTTPS) audio acquisition
 *      (REAL `downloadGenericSplitSources`; the yt-dlp child EMULATES the
 *      pinned `FragmentFD` file lifecycle, fragment by fragment)
 *   -> beginProcessing()
 *   -> Worker-owned merge (REAL `mergeSplitMedia`, its FFmpeg/ffprobe children
 *      faked through the process-runner hooks)
 *   -> local validation -> uploading -> ready
 *
 * Every child — each yt-dlp run, each ffprobe, the FFmpeg merge — records the
 * durable status at the instant it starts. That is the lifecycle assertion:
 * `downloading` = acquisition only, `processing` = Worker FFmpeg only.
 *
 * What this does NOT prove, stated so it is not over-read: the media here is
 * synthetic, and FFmpeg/ffprobe are faked. The emulation's fidelity to the
 * pinned downloader is proven against the artifact itself by
 * `ytdlp-dash-downloader-contract.server.test.ts`; real-media merging of a
 * fragmented source by the image's own FFmpeg belongs to the release-image
 * acceptance run.
 */

const URL = "https://example.invalid/watch/dash";
const LIMITS = { maxFileSizeBytes: 100_000, downloadTimeoutSeconds: 600 };
const ISO = "mov,mp4,m4a,3gp,3g2,mj2";
const MERGED = "MERGED-MP4-FROM-DASH";

const frag = (tag: string, n: number, size: number) => Buffer.alloc(size, `${tag}${n}|`);
const VIDEO_FRAGMENTS = [frag("VINIT", 0, 700), frag("V", 1, 9_000), frag("V", 2, 8_000), frag("V", 3, 8_500)];
const AUDIO_FRAGMENTS = [frag("AINIT", 0, 600), frag("A", 1, 1_500), frag("A", 2, 1_400)];

type Row = Record<string, unknown>;
const dashRow = (over: Row): Row => ({
  protocol: "http_dash_segments",
  url: "https://media.example.invalid/dash/clip.mpd?sig=PRIVATE_DASH_TOKEN",
  fragment_base_url: "https://media.example.invalid/dash/",
  fragments: [{ path: "init.mp4" }, { path: "1.m4s" }],
  is_dash_periods: true,
  ...over,
});
const DASH_VIDEO_ROW = dashRow({
  format_id: "v1080", ext: "mp4", container: "mp4_dash", height: 1080, width: 1920, fps: 30,
  vcodec: "avc1.640028", acodec: "none", video_ext: "mp4", audio_ext: "none",
});
const DASH_AUDIO_ROW = dashRow({
  format_id: "a128", ext: "m4a", container: "m4a_dash", vcodec: "none", acodec: "mp4a.40.2",
  video_ext: "none", audio_ext: "m4a",
});
const HTTPS_AUDIO_ROW: Row = {
  format_id: "140", ext: "m4a", protocol: "https", vcodec: "none", acodec: "mp4a.40.2",
  video_ext: "none", audio_ext: "m4a", filesize: 2_900,
};

function analyzer(rows: Row[], counter: { runs: number }) {
  return async () => {
    counter.runs += 1;
    const internal = await analyzeGenericMediaInternal(URL, {
      limits: { analysisTimeoutSeconds: 45, maxVideoDurationSeconds: 7200, maxFileSizeBytes: LIMITS.maxFileSizeBytes },
      ffmpegAvailable: true,
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({ _type: "video", title: "Segmented clip", duration: 8, live_status: "not_live", formats: rows }),
        stderr: "",
      }),
      probeRuntime: async () => ({ available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" as const }),
      validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
    });
    return { strategy: "yt-dlp" as const, ...internal };
  };
}

type Harness = {
  tempDir: string;
  jobsRoot: string;
  db: DatabaseSync;
  store: SQLiteJobStore;
  puts: ObjectStorePutInput[];
  uploaded: Buffer[];
  writer: ObjectStoreWriter;
  cleanup: () => void;
};

function makeHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-exec-"));
  setTempDirectoryForTests(tempDir);
  const db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
  applyMigrations(db);
  const store = new SQLiteJobStore({ db });
  const puts: ObjectStorePutInput[] = [];
  const uploaded: Buffer[] = [];
  const writer: ObjectStoreWriter = {
    async put(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      uploaded.push(Buffer.concat(chunks));
      puts.push(input);
    },
    async head(key) {
      const last = puts.find((p) => p.objectKey === key);
      return last
        ? { objectKey: last.objectKey, contentLength: last.contentLength, contentType: last.contentType, contentDisposition: last.contentDisposition }
        : null;
    },
    async delete() {},
  };
  return {
    tempDir,
    jobsRoot: path.join(fs.realpathSync(tempDir), "jobs"),
    db,
    store,
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
  store.createJob({ url: URL, formatId, principalId: "private-access-user" }, randomUUID());
  const job = store.claimNextQueuedJob();
  assert.ok(job);
  return job;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pinned FragmentFD lifecycle, on the REAL job directory. */
async function emulateFragmentFd(final: string, fragments: readonly Buffer[], onFragment: () => void) {
  const part = `${final}.part`;
  fs.writeFileSync(`${final}.ytdl`, JSON.stringify({ downloader: { current_fragment: { index: 0 } } }));
  fs.writeFileSync(part, "");
  for (let i = 0; i < fragments.length; i += 1) {
    const n = i + 1;
    fs.writeFileSync(`${part}-Frag${n}.part`, fragments[i]!.subarray(0, fragments[i]!.length >> 1));
    await sleep(4);
    fs.writeFileSync(`${part}-Frag${n}.part`, fragments[i]!);
    await sleep(4);
    fs.renameSync(`${part}-Frag${n}.part`, `${part}-Frag${n}`);
    fs.appendFileSync(part, fs.readFileSync(`${part}-Frag${n}`));
    await sleep(4);
    fs.unlinkSync(`${part}-Frag${n}`);
    fs.writeFileSync(`${final}.ytdl`, JSON.stringify({ downloader: { current_fragment: { index: n } } }));
    onFragment();
  }
  fs.unlinkSync(`${final}.ytdl`);
  fs.renameSync(part, final);
}

type YtdlpRun = { role: "video" | "audio"; status: string; protocol: string; fragments: number };

function realSplitDownload(h: Harness, jobId: string, runs: YtdlpRun[]): DownloadGenericSplitFn {
  return (url, workDir, plan, ctx) =>
    downloadGenericSplitSources(url, workDir, plan, {
      limits: ctx.limits,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      validateUrl: async (raw) => ({ url: raw, hostname: "example.invalid" }),
      probeRuntime: async () => ({ available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" as const }),
      sizePollMs: 1,
      runner: async (call): Promise<RunResult> => {
        const template = call.args.find((a) => a.startsWith("--output="))!.slice("--output=".length);
        const role = path.basename(template).startsWith("video-source") ? "video" : "audio";
        const selector = call.args.find((a) => a.startsWith("--format="))!;
        const protocol = /\[protocol="([^"]+)"\]/.exec(selector)![1]!;
        const run: YtdlpRun = { role, status: h.store.getJob(jobId)!.status, protocol, fragments: 0 };
        runs.push(run);
        const final = template.replace("%(ext)s", role === "video" ? "mp4" : "m4a");
        if (protocol === "http_dash_segments") {
          await emulateFragmentFd(final, role === "video" ? VIDEO_FRAGMENTS : AUDIO_FRAGMENTS, () => {
            run.fragments += 1;
          });
        } else {
          fs.writeFileSync(`${final}.part`, Buffer.concat(AUDIO_FRAGMENTS));
          fs.renameSync(`${final}.part`, final);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
}

type Spawn = { command: string; target: string; status: string; inputs: Record<string, Buffer> };

/** Fakes the Worker's own ffprobe/FFmpeg children; records status at spawn. */
function hookSubprocesses(h: Harness, jobId: string) {
  const spawns: Spawn[] = [];
  setProcessRunnerTestHooks({
    platform: "linux",
    spawn: (command, args) => {
      const child = new EventEmitter() as EventEmitter & { pid?: number; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      child.pid = 91_000 + spawns.length;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      const inputs: Record<string, Buffer> = {};
      args.forEach((a, i) => {
        if (args[i - 1] === "-i" && fs.existsSync(a)) inputs[path.basename(a)] = fs.readFileSync(a);
      });
      const last = args[args.length - 1]!;
      spawns.push({ command, target: path.basename(last), status: h.store.getJob(jobId)!.status, inputs });
      queueMicrotask(() => {
        if (command === config.ffmpegPath) {
          fs.writeFileSync(last, MERGED);
        } else {
          const base = path.basename(last);
          const kinds = base.startsWith("video-source") ? ["video"] : base.startsWith("audio-source") ? ["audio"] : ["video", "audio"];
          child.stdout.write(JSON.stringify({ programs: [], streams: kinds.map((codec_type) => ({ codec_type })), format: { format_name: ISO } }));
        }
        setImmediate(() => child.emit("close", 0));
      });
      return child as unknown as ChildProcess;
    },
    processKill: () => true,
  });
  return spawns;
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  setProcessRunnerTestHooks(null);
  h.cleanup();
});

describe("segmented DASH full path: analysis → split → acquisition → processing → ready", () => {
  const cases = [
    { name: "DASH video + DASH audio", rows: [DASH_VIDEO_ROW, DASH_AUDIO_ROW], audioProtocol: "http_dash_segments" },
    { name: "DASH video + HTTPS audio", rows: [DASH_VIDEO_ROW, HTTPS_AUDIO_ROW], audioProtocol: "https" },
  ];
  for (const c of cases) {
    it(`${c.name}: downloading is acquisition only, processing is the Worker's FFmpeg only`, async () => {
      // 1. The BROWSER's analysis advertises the 1080 preset.
      const counter = { runs: 0 };
      const analyze = analyzer(c.rows, counter);
      const browser = await analyze();
      const preset = browser.video.presets.find((p) => p.id === "preset:1080");
      assert.ok(preset, "preset:1080 is advertised");
      assert.deepEqual([preset.container, preset.hasVideo, preset.hasAudio], ["mp4", true, true]);
      assert.equal(browser.video.sourceQuality?.observedMaxHeight, 1080);
      assert.equal(browser.video.sourceQuality?.deliverableMaxHeight, 1080);
      assert.deepEqual(browser.video.sourceQuality?.withheld, []);
      const publicText = JSON.stringify(browser.video);
      for (const needle of ["v1080", "a128", "http_dash_segments", "PRIVATE_DASH_TOKEN", "fragment"]) {
        assert.equal(publicText.includes(needle), false, needle);
      }

      // 2. The job persists only the application-owned preset id.
      const job = claimJob(h.store, "preset:1080");
      const runs: YtdlpRun[] = [];
      const spawns = hookSubprocesses(h, job.jobId);
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
        analyzeForExecution: analyze,
        availableWorkDirBytes: async () => 2 * LIMITS.maxFileSizeBytes,
        genericLimits: LIMITS,
        downloadGenericSplit: realSplitDownload(h, job.jobId, runs),
        downloadGeneric: async () => {
          throw new Error("unreachable: a split preset never reaches the single-source seam");
        },
        processLocally: async () => {
          throw new Error("unreachable: one-input seam");
        },
      });
      await executor.execute(job);

      const view = h.store.getJob(job.jobId)!;
      assert.equal(view.status, "ready", `${view.errorCode}`);
      assert.equal(counter.runs, 2, "exactly one FRESH execution analysis after the browser's");

      // 3. Acquisition: video first, then audio, both while `downloading`.
      assert.deepEqual(
        runs.map((r) => [r.role, r.status, r.protocol]),
        [
          ["video", "downloading", "http_dash_segments"],
          ["audio", "downloading", c.audioProtocol],
        ],
      );
      assert.equal(runs[0]!.fragments, VIDEO_FRAGMENTS.length, "every video fragment (init included) was fetched");

      // 4. ZERO FFmpeg/ffprobe while downloading; every one of them while processing.
      const ffprobe = resolveFfprobePath();
      assert.deepEqual(
        spawns.map((s) => [s.command, s.target, s.status]),
        [
          [ffprobe, "video-source.mp4", "processing"],
          [ffprobe, "audio-source.m4a", "processing"],
          [config.ffmpegPath, "merged.mp4", "processing"],
          [ffprobe, "merged.mp4", "processing"],
        ],
      );
      // The merge consumed exactly the acquired aggregates, byte for byte.
      const merge = spawns[2]!;
      assert.deepEqual(merge.inputs["video-source.mp4"], Buffer.concat(VIDEO_FRAGMENTS));
      assert.deepEqual(
        merge.inputs["audio-source.m4a"],
        Buffer.concat(AUDIO_FRAGMENTS),
        "the audio half's bytes, whichever protocol acquired them",
      );

      // 5. The delivered object is the merge's output, with the planned facts.
      assert.equal(view.container, "mp4");
      assert.equal(view.mime, "video/mp4");
      assert.equal(h.uploaded.length, 1);
      assert.equal(h.uploaded[0]!.toString("utf8"), MERGED);
      assert.equal(fs.existsSync(path.join(h.jobsRoot, job.jobId)), false, "the job directory is gone");

      // 6. Durable state carries no DASH provenance.
      const row = h.db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(job.jobId) as Record<string, unknown>;
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string") continue;
        for (const needle of ["v1080", "a128", "http_dash_segments", "PRIVATE_DASH_TOKEN", "Frag", "mpd"]) {
          assert.equal(value.includes(needle), false, `${column} carries ${needle}`);
        }
      }
      assert.equal(row.format_id, "preset:1080");
    });
  }

  it("a fresh analysis that has LOST the DASH rendition fails FORMAT_UNAVAILABLE before any acquisition", async () => {
    const job = claimJob(h.store, "preset:1080");
    const runs: YtdlpRun[] = [];
    const spawns = hookSubprocesses(h, job.jobId);
    const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), {
      analyzeForExecution: analyzer([DASH_AUDIO_ROW], { runs: 0 }),
      availableWorkDirBytes: async () => 2 * LIMITS.maxFileSizeBytes,
      genericLimits: LIMITS,
      downloadGenericSplit: realSplitDownload(h, job.jobId, runs),
      downloadGeneric: async () => {
        throw new Error("unreachable");
      },
      processLocally: async () => {
        throw new Error("unreachable");
      },
    });
    await executor.execute(job);
    const view = h.store.getJob(job.jobId)!;
    assert.equal(view.status, "failed");
    assert.equal(view.errorCode, "FORMAT_UNAVAILABLE");
    assert.equal(runs.length, 0);
    assert.equal(spawns.length, 0);
  });
});
