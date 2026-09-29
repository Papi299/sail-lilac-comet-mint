#!/usr/bin/env node
//
// DASH-01: the segmented-DASH REAL-MEDIA release child.
//
// ── What one run proves ────────────────────────────────────────────────────
//
// That inside the ACTUAL release candidate image, offline, against a
// deterministic local segmented-DASH fixture, the CURRENT source executes the
// real split application chain with real media end to end:
//
//   analysis -> preset:1080 -> fresh execution analysis -> merge-split plan
//   -> pinned yt-dlp DashSegmentsFD video acquisition (fragment by fragment)
//   -> audio acquisition (segmented DASH; and, separately, progressive)
//   -> beginProcessing() -> real ffprobe input validation
//   -> real mergeSplitMedia FFmpeg stream copy -> real output validation
//   -> beginUploading() -> upload -> ready
//
// with NO faked yt-dlp, FFmpeg or ffprobe: every media byte is acquired by the
// image's own pinned runtime from the loopback fixture, and every probe and the
// merge execute the image's own `/usr/bin/ffprobe` and `/usr/bin/ffmpeg`. On
// top of the product's own validation it independently measures:
//
//   - the downloader the child ACTUALLY used (the pinned FragmentFD banner),
//     the fragment count, and the fixture's per-fragment request ledger;
//   - that each acquired artifact is byte-for-byte the init + fragment
//     concatenation, and that nothing but the two finals was left behind;
//   - the durable job status at the instant of EVERY subprocess spawn;
//   - the job directory's on-disk bytes throughout (the workspace bound);
//   - the delivered file's streams, 1920x1080 geometry and packet identity.
//
// Three bounded negatives prove the fragment-aware byte guard, the combined
// split budget and the missing-fragment abort, each failing closed before any
// processing.
//
// ── What one run does NOT prove ────────────────────────────────────────────
//
// Real public DASH sources, YouTube, Cloudflare, R2, Vercel, the Production
// egress namespace. See `DASH01_NON_CLAIMS`. The URL validator is an exact
// loopback-fixture validator, exactly as SPLIT-06 documents.
//
// ── Where it runs ──────────────────────────────────────────────────────────
//
// INSIDE the release candidate container, as the image's non-root `node`
// user, `--network none`, launched by the SPLIT-07 driver
// (`releaseDashAcceptanceRunArgs`). It records the release identity the parent
// observed; the parent re-validates the record against its own observations.

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// ── Production modules. Imported, never re-implemented. ────────────────────
import { config } from "../../../src/lib/config.ts";
import { mimeForContainer } from "../../../src/services/extractors/normalize.ts";
import { YTDLP_RUNTIME, probeYtdlpRuntime } from "../../../src/worker/runtime/ytdlp-runtime.server.ts";
import { runProcess } from "../../../src/services/processing/process-runner.server.ts";
import { ffmpegAvailable, mergeSplitMedia } from "../../../src/services/processing/ffmpeg.server.ts";
import { resolveFfprobePath } from "../../../src/services/processing/ffprobe.server.ts";
import { deriveGenericExecutionPlan } from "../../../src/worker/execution/format-plan.ts";
import { GenericSplitSourceSelectionSchema } from "../../../src/worker/execution/generic-source.ts";
import { downloadGenericSplitSources } from "../../../src/worker/execution/ytdlp-download.server.ts";
import { JobExecutor } from "../../../src/worker/execution/job-executor.server.ts";
import { openWorkerDatabase } from "../../../src/worker/state/database.server.ts";
import { applyMigrations } from "../../../src/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "../../../src/worker/state/sqlite-job-store.server.ts";

// ── Harness modules ────────────────────────────────────────────────────────
import { createAnalysisPolicy, createChecks } from "./split-full-path.mjs";
import {
  DASH_CASES,
  DASH_CASE_AUDIO_PROTOCOL,
  DASH_EXPECTED_RESOLUTION,
  DASH_FIXTURE_SPEC,
  DASH_MANIFEST_ROUTE,
  DASH_PROGRESSIVE_AUDIO_ROUTE,
  DASH_REQUESTED_PRESET,
  DASH_SYNTHETIC_FORMAT_IDS,
  DASH_TARGET_CONTAINER,
  DASH_TARGET_MIME,
  dashFfmpegArgs,
  dashInitRoute,
  dashRouteTable,
  dashSegmentRoute,
  generateDashFixtures,
} from "./fixtures/dash-media.mjs";
import { DASH_FIXTURE_LISTEN_ADDRESS, createDashFixtureService } from "./fixtures/dash-server.mjs";
import { createExactFixtureUrlValidator } from "./lib/split-fixture-url.mjs";
import { createLocalObjectStoreWriter } from "./lib/local-object-writer.mjs";
import { createMediaToolSampler, installStatusAudit, readStatusTrace } from "./lib/split-observers.mjs";
import {
  createWorkspaceSampler,
  createYtdlpLedger,
  installSpawnObserver,
} from "./lib/dash-observers.mjs";
import { releaseIdentityChecks } from "./lib/hls-release-evidence.mjs";
import {
  DASH01_RELEASE_EVIDENCE_SCHEMA,
  buildDashReleaseEvidence,
  findDashForbiddenSubstring,
  renderDashReleaseEvidence,
} from "./lib/dash-evidence.mjs";
import { parseDashArgv as parseArgv } from "./lib/dash-argv.mjs";

// ── Bounds ─────────────────────────────────────────────────────────────────

/** The ISO-BMFF demuxer family name ffprobe reports for every input and the output. */
const ISO_BMFF_FORMAT_NAME = "mov,mp4,m4a,3gp,3g2,mj2";

/** Output duration tolerance, in seconds. Both halves are 2 s by recipe. */
const DURATION_TOLERANCE_SECONDS = 0.25;

/** The positive fixture pacing: every media segment is written in two halves. */
const POSITIVE_PACE = Object.freeze({ pauseMs: 60 });

/** The fragment-guard negative's hold on the last video segment. */
const GUARD_HOLD_MS = 8_000;
const GUARD_HOLD_TAIL_BYTES = 1024;

/** The canonical failure the missing-fragment negative must produce. */
const MISSING_FRAGMENT_EXPECTED_CODE = "EXTRACTION_FAILED";
const MISSING_FRAGMENT_ORDINAL = 2;

// ── Small helpers ──────────────────────────────────────────────────────────

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = async (path) => sha256(await readFile(path));

const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Runs one bounded HARNESS tool through the ORIGINAL spawn, so it never enters
 * the product's spawn ledger. Harness observation only.
 */
function createToolRunner(spawnFn) {
  return (command, args, { timeoutMs = 60_000 } = {}) =>
    new Promise((resolvePromise, reject) => {
      const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 8 * 1024 * 1024) stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 64 * 1024) stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolvePromise({ code, stdout, stderr });
      });
    });
}

/**
 * The harness's OWN ffprobe observation of one ISO-BMFF file: format, duration
 * and per-stream type, codec and geometry. Separate from the product's
 * `probeLocalMedia`, which deliberately reads only what the product needs.
 */
async function probeMedia(runTool, ffprobePath, path) {
  const result = await runTool(ffprobePath, [
    "-v", "error", "-protocol_whitelist", "file", "-f", "mov",
    "-print_format", "json",
    "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height",
    "-i", path,
  ]);
  if (result.code !== 0) return { readable: false, formatName: null, duration: null, streams: [] };
  const doc = JSON.parse(result.stdout);
  return {
    readable: true,
    formatName: doc.format?.format_name ?? null,
    duration: doc.format?.duration === undefined ? null : Number(doc.format.duration),
    streams: (doc.streams ?? []).map((s) => ({
      type: s.codec_type ?? null,
      codec: s.codec_name ?? null,
      width: Number.isInteger(s.width) ? s.width : null,
      height: Number.isInteger(s.height) ? s.height : null,
    })),
  };
}

/** The SHA-256 of one stream's compressed packet payloads, in order (see SPLIT-06). */
async function streamPacketDigest(runTool, ffprobePath, path, selector) {
  const result = await runTool(ffprobePath, [
    "-v", "error", "-protocol_whitelist", "file", "-f", "mov",
    "-select_streams", selector, "-show_packets", "-show_data_hash", "sha256",
    "-print_format", "json", "-i", path,
  ]);
  if (result.code !== 0) return { digest: null, packetCount: 0 };
  const packets = JSON.parse(result.stdout).packets ?? [];
  const rolling = createHash("sha256");
  for (const packet of packets) {
    if (typeof packet.data_hash !== "string" || !packet.data_hash.startsWith("SHA256:")) {
      return { digest: null, packetCount: 0 };
    }
    rolling.update(packet.data_hash);
  }
  return { digest: packets.length > 0 ? rolling.digest("hex") : null, packetCount: packets.length };
}

const streamCount = (probe, type) => probe.streams.filter((s) => s.type === type).length;
const isVideoOnly1080 = (probe) =>
  probe.readable &&
  probe.formatName === ISO_BMFF_FORMAT_NAME &&
  probe.streams.length === 1 &&
  probe.streams[0].type === "video" &&
  probe.streams[0].width === DASH_FIXTURE_SPEC.video.width &&
  probe.streams[0].height === DASH_FIXTURE_SPEC.video.height;
const isAudioOnly = (probe) =>
  probe.readable && probe.formatName === ISO_BMFF_FORMAT_NAME && probe.streams.length === 1 && probe.streams[0].type === "audio";

const nonDecreasing = (values) => values.every((value, i) => i === 0 || value >= values[i - 1]);

// ── 1. Preflight ───────────────────────────────────────────────────────────

async function preflight(checks, runTool) {
  checks.require("preflight/node-runtime-family", /^v22\./.test(process.version), process.version);

  const runtime = await probeYtdlpRuntime();
  checks.require("preflight/ytdlp-available", runtime.available === true, runtime.reason);
  checks.require(
    "preflight/ytdlp-exact-pin",
    runtime.version === YTDLP_RUNTIME.expectedVersion,
    `${runtime.version} vs ${YTDLP_RUNTIME.expectedVersion}`,
  );

  const ffmpegPath = config.ffmpegPath;
  checks.require("preflight/ffmpeg-path-is-the-worker-ffmpeg", ffmpegPath === "/usr/bin/ffmpeg", ffmpegPath);
  const ffmpegVersion = await runTool(ffmpegPath, ["-hide_banner", "-version"]);
  checks.require(
    "preflight/ffmpeg-executes",
    ffmpegVersion.code === 0 && (await ffmpegAvailable()) === true,
    "executed, and the product's own availability probe agrees",
  );

  // Derived as the configured FFmpeg's sibling, never a PATH lookup.
  const ffprobePath = resolveFfprobePath();
  checks.require(
    "preflight/ffprobe-is-the-ffmpeg-sibling",
    ffprobePath === "/usr/bin/ffprobe" && dirname(ffprobePath) === dirname(ffmpegPath),
    ffprobePath,
  );
  const ffprobeVersion = await runTool(ffprobePath, ["-hide_banner", "-version"]);
  checks.require("preflight/ffprobe-executes", ffprobeVersion.code === 0);

  // The tag the pinned FragmentFD prints is `FD_NAME`; read it out of the
  // pinned artifact itself, so "the child printed [dashsegments]" maps to
  // `DashSegmentsFD` by measurement in THIS image rather than by memory.
  const fdName = await runTool(YTDLP_RUNTIME.pythonPath, [
    "-I", "-c",
    "import sys; sys.path.insert(0, sys.argv[1]); " +
      "from yt_dlp.downloader.dash import DashSegmentsFD as C; print(C.__name__ + ' ' + C.FD_NAME)",
    YTDLP_RUNTIME.artifactPath,
  ]);
  checks.require(
    "preflight/pinned-dash-fragment-downloader-is-dashsegments",
    fdName.code === 0 && fdName.stdout.trim() === "DashSegmentsFD dashsegments",
    fdName.code === 0 ? fdName.stdout.trim() : `exit ${fdName.code}`,
  );

  const firstLine = (text) => text.split(/\r?\n/)[0]?.trim() ?? "";
  return {
    node: process.version,
    ytdlpVersion: runtime.version,
    ffmpegPath,
    ffmpegVersion: firstLine(ffmpegVersion.stdout),
    ffprobePath,
    ffprobeVersion: firstLine(ffprobeVersion.stdout),
    dashFragmentDownloader: { className: "DashSegmentsFD", fdName: "dashsegments" },
  };
}

// ── 2. Fixture ─────────────────────────────────────────────────────────────

async function prepareFixture(checks, runTool, toolchain, workRoot) {
  const outDir = join(workRoot, "fixture");
  await mkdir(outDir, { recursive: true });
  const fixtures = await generateDashFixtures({ ffmpegPath: toolchain.ffmpegPath, outDir });

  const video = await probeMedia(runTool, toolchain.ffprobePath, fixtures.video.path);
  const audio = await probeMedia(runTool, toolchain.ffprobePath, fixtures.audio.path);
  const progressive = await probeMedia(runTool, toolchain.ffprobePath, fixtures.progressiveAudio.path);
  checks.require("fixture/video-is-1920x1080-video-only", isVideoOnly1080(video), JSON.stringify(video.streams));
  checks.require("fixture/segmented-audio-is-audio-only", isAudioOnly(audio), JSON.stringify(audio.streams));
  checks.require("fixture/progressive-audio-is-audio-only", isAudioOnly(progressive), JSON.stringify(progressive.streams));
  for (const role of ["video", "audio"]) {
    const rendition = fixtures[role];
    checks.require(
      `fixture/${role}-has-an-init-and-media-segments`,
      rendition.init.byteLength > 0 &&
        rendition.segments.length >= DASH_FIXTURE_SPEC.minMediaSegments &&
        rendition.topLevelTypes[0] === "ftyp" && rendition.topLevelTypes[1] === "moov",
      `${rendition.segments.length} media segments`,
    );
  }

  // Determinism, measured: the fragmented video recipe again, byte-identical.
  const again = join(outDir, "regenerated-video.mp4");
  const regen = await runTool(toolchain.ffmpegPath, dashFfmpegArgs("video-fragmented", again));
  const regenerated = regen.code === 0 ? await sha256File(again) : null;
  checks.require("fixture/recipes-are-bit-exact", regenerated === fixtures.video.sha256, "fragmented video regenerated");
  await rm(again, { force: true });

  return {
    fixtures,
    summary: {
      video: {
        width: video.streams[0]?.width ?? null,
        height: video.streams[0]?.height ?? null,
        codec: video.streams[0]?.codec ?? null,
        streams: video.streams.map((s) => s.type),
        container: "fragmented ISO-BMFF (ftyp+moov init, moof+mdat media segments)",
        mediaSegments: fixtures.video.segments.length,
        manifestFragments: fixtures.video.segments.length + 1,
        initBytes: fixtures.video.init.byteLength,
        segmentBytes: fixtures.video.segments.map((s) => s.byteLength),
        totalBytes: fixtures.video.byteLength,
        sha256: fixtures.video.sha256,
        durationSeconds: video.duration,
      },
      segmentedAudio: {
        codec: audio.streams[0]?.codec ?? null,
        streams: audio.streams.map((s) => s.type),
        container: "fragmented ISO-BMFF (ftyp+moov init, moof+mdat media segments)",
        mediaSegments: fixtures.audio.segments.length,
        manifestFragments: fixtures.audio.segments.length + 1,
        initBytes: fixtures.audio.init.byteLength,
        segmentBytes: fixtures.audio.segments.map((s) => s.byteLength),
        totalBytes: fixtures.audio.byteLength,
        sha256: fixtures.audio.sha256,
        durationSeconds: audio.duration,
      },
      progressiveAudio: {
        codec: progressive.streams[0]?.codec ?? null,
        streams: progressive.streams.map((s) => s.type),
        container: "ISO-BMFF m4a (faststart), served whole",
        totalBytes: fixtures.progressiveAudio.byteLength,
        sha256: fixtures.progressiveAudio.sha256,
        durationSeconds: progressive.duration,
      },
      origin: "generated in this container by the candidate image's own /usr/bin/ffmpeg from lavfi generators; " +
        "served by a closed-route loopback service; one static MPD Period with SegmentList renditions",
      deterministic: regenerated === fixtures.video.sha256,
    },
  };
}

// ── 3. One durable job through the real executor ───────────────────────────

/**
 * Runs ONE job through the real `JobExecutor` with the real acquisition and
 * merge primitives, observing everything and substituting only the URL
 * validator and the object store.
 */
async function runJob(ctx, { label, url, genericLimits }) {
  const { validateUrl, analysisLimits, service, spawnContext, spawnObserver, workRoot, runTool, toolchain } = ctx;

  const dbDir = await mkdtemp(join(workRoot, "dash01-db-"));
  const db = openWorkerDatabase({ path: join(dbDir, "worker.sqlite") });
  applyMigrations(db);
  installStatusAudit(db);
  const store = new SQLiteJobStore({ db });

  let jobId = null;
  const statusNow = () => (jobId ? (store.getJob(jobId)?.status ?? "<missing>") : "<no-job>");
  const setPhase = (phase) => {
    spawnContext.phase = phase;
    ledger.setPhase(phase);
    service.setPhase(`${label}:${phase}`);
    workspace.setPhase(phase);
    mediaTools.setPhase(phase);
  };
  spawnContext.statusNow = statusNow;

  const ledger = createYtdlpLedger(runProcess);
  const workspace = createWorkspaceSampler({ intervalMs: 3 });
  const mediaTools = createMediaToolSampler();
  const progress = [];
  const downloadedBytes = [];
  const observed = {
    statusAtSplitEntry: null,
    statusesDuringAcquisition: new Set(),
    statusAtMergeEntry: null,
    statusesAtPut: [],
    mergeEntryListing: null,
    inputs: null,
    mergeReturned: false,
    mergedName: null,
    mergedSize: null,
    preUploadSha256: null,
    secondPair: null,
    executionAnalyses: 0,
    runtimeProbes: 0,
  };

  const sinkDir = await mkdtemp(join(workRoot, "dash01-sink-"));
  const writer = createLocalObjectStoreWriter({ sinkDir, onPut: () => observed.statusesAtPut.push(statusNow()) });
  const executionPolicy = createAnalysisPolicy({
    validateUrl, ledger, limits: analysisLimits, ffmpegAvailableFn: () => ffmpegAvailable(),
  });

  const executor = new JobExecutor(store, writer, () => Date.now(), new Map(), {
    genericLimits,
    // The FRESH execution analysis: Production re-analyzes its own stored URL.
    analyzeForExecution: async (u, signal) => {
      setPhase("analysis-execution");
      const result = await executionPolicy.analyzeForExecution(u, signal);
      observed.executionAnalyses += 1;
      const fresh = result.selections[DASH_REQUESTED_PRESET];
      observed.secondPair = fresh?.kind === "split" ? fresh.pair : null;
      return result;
    },
    // The REAL split acquisition primitive; the wrapper forwards everything and
    // adds only the acceptance URL validator and observation.
    downloadGenericSplit: async (u, workDir, plan, acq) => {
      setPhase("acquisition");
      workspace.setDirectory(workDir);
      observed.statusAtSplitEntry = statusNow();
      observed.statusesDuringAcquisition.add(observed.statusAtSplitEntry);
      const poll = setInterval(() => {
        observed.statusesDuringAcquisition.add(statusNow());
        const current = store.getJob(jobId);
        if (typeof current?.progress === "number") progress.push(current.progress);
        if (typeof current?.downloadedBytes === "number") downloadedBytes.push(current.downloadedBytes);
      }, 10);
      try {
        return await downloadGenericSplitSources(u, workDir, plan, {
          limits: acq.limits,
          ...(acq.signal ? { signal: acq.signal } : {}),
          ...(acq.onProgress ? { onProgress: acq.onProgress } : {}),
          validateUrl,
          runner: ledger.runner,
          probeRuntime: async (probeOpts) => {
            observed.runtimeProbes += 1;
            return probeYtdlpRuntime(probeOpts);
          },
        });
      } finally {
        clearInterval(poll);
      }
    },
    // The REAL merge. Before it runs, the harness observes the ACQUIRED inputs
    // it is about to be handed — the directory, the bytes and what the real
    // ffprobe reads from them — while the durable job says `processing`.
    mergeSplit: async (mergeOpts) => {
      setPhase("processing");
      observed.statusAtMergeEntry = statusNow();
      const names = (await readdir(mergeOpts.workDir)).sort();
      observed.mergeEntryListing = [];
      for (const name of names) {
        const info = await lstat(join(mergeOpts.workDir, name));
        observed.mergeEntryListing.push({ name, bytes: info.isFile() ? info.size : null, regularFile: info.isFile() });
      }
      const video = await probeMedia(runTool, toolchain.ffprobePath, mergeOpts.videoPath);
      const audio = await probeMedia(runTool, toolchain.ffprobePath, mergeOpts.audioPath);
      observed.inputs = {
        video,
        audio,
        videoName: basename(mergeOpts.videoPath),
        audioName: basename(mergeOpts.audioPath),
        videoSha256: await sha256File(mergeOpts.videoPath),
        audioSha256: await sha256File(mergeOpts.audioPath),
        videoBytes: (await lstat(mergeOpts.videoPath)).size,
        audioBytes: (await lstat(mergeOpts.audioPath)).size,
        videoPackets: await streamPacketDigest(runTool, toolchain.ffprobePath, mergeOpts.videoPath, "v:0"),
        audioPackets: await streamPacketDigest(runTool, toolchain.ffprobePath, mergeOpts.audioPath, "a:0"),
      };
      await workspace.sampleNow();
      const produced = await mergeSplitMedia(mergeOpts);
      await workspace.sampleNow();
      observed.mergeReturned = true;
      observed.mergedName = basename(produced);
      observed.mergedSize = (await lstat(produced)).size;
      observed.preUploadSha256 = await sha256File(produced);
      setPhase("upload");
      return produced;
    },
  });

  setPhase("queued");
  workspace.start();
  mediaTools.start();
  const spawnMark = spawnObserver.count();
  const created = store.createJob(
    { url, formatId: DASH_REQUESTED_PRESET, principalId: "private-access-user" },
    randomUUID(),
  );
  if (created.type !== "created") throw new Error(`the ${label} job was not created (${created.type})`);
  jobId = created.job.jobId;
  const claimed = store.claimNextQueuedJob();
  if (claimed?.status !== "analyzing") throw new Error(`the ${label} job was not claimed to analyzing`);
  setPhase("analysis-execution");
  await executor.execute(claimed);
  setPhase("finished");
  await workspace.stop();
  mediaTools.stop();

  const spawns = spawnObserver.records().slice(spawnMark);
  const finalJob = store.getJob(jobId);
  const trace = readStatusTrace(db, jobId);
  const durableRow = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId);
  const workDirGone = !(await pathExists(join(config.tempDirectory, "jobs", jobId)));
  const finalProgress = finalJob?.progress;
  if (typeof finalProgress === "number") progress.push(finalProgress);
  // The spawn observer must never read a closed database.
  spawnContext.statusNow = () => "<no-job>";
  db.close();
  await rm(dbDir, { recursive: true, force: true });

  return {
    jobId, finalJob, trace, durableRow, spawns, ledger, observed, writer, progress, downloadedBytes, workDirGone,
    workspace: workspace.summary(),
    mediaToolSightingsDuringAcquisition: mediaTools.sightingsIn("acquisition").length,
    requests: (phase) => service.requests(`${label}:${phase}`),
  };
}

/** The sanitized spawn table for the record: tool, role and durable status at spawn. */
function spawnTable(spawns) {
  return spawns.map((s) => ({
    tool: s.tool,
    role: s.role,
    statusAtSpawn: s.status,
    ...(s.touched.length > 0 ? { productFiles: [...s.touched] } : {}),
    ...(s.streamCopy === null ? {} : { streamCopy: s.streamCopy, refusesOverwrite: s.refusesOverwrite }),
  }));
}

const isMediaTool = (s) => s.tool === "ffmpeg" || s.tool === "ffprobe";

// ── 4. A positive case ─────────────────────────────────────────────────────

async function runPositiveCase(ctx, caseName) {
  const { checks, service, validateUrl, fixtures, runTool, toolchain } = ctx;
  const C = (name) => `${caseName}/${name}`;
  ctx.spawnContext.phase = "analysis-public";
  const url = validateUrl.urlFor(DASH_MANIFEST_ROUTE[caseName]);
  const audioFixture = caseName === "dash-dash" ? fixtures.audio : fixtures.progressiveAudio;
  const audioId = caseName === "dash-dash" ? DASH_SYNTHETIC_FORMAT_IDS.audio : DASH_SYNTHETIC_FORMAT_IDS.progressiveAudio;
  const privateNeedles = [
    ...Object.values(DASH_SYNTHETIC_FORMAT_IDS),
    ".m4s",
    dashInitRoute("video").slice(1),
    dashInitRoute("audio").slice(1),
    DASH_PROGRESSIVE_AUDIO_ROUTE.slice(1),
  ];

  // ── the browser-facing analysis ──────────────────────────────────────────
  service.setBehavior({});
  service.setPhase(`${caseName}:analysis-public`);
  const analysisLedger = createYtdlpLedger(runProcess);
  analysisLedger.setPhase("analysis-public");
  const policy = createAnalysisPolicy({
    validateUrl, ledger: analysisLedger, limits: ctx.analysisLimits, ffmpegAvailableFn: () => ffmpegAvailable(),
  });
  const first = await policy.analyzeForExecution(url);
  const meta = first.video;
  const preset = meta.presets.find((p) => p.id === DASH_REQUESTED_PRESET);
  const sq = meta.sourceQuality ?? null;
  const publicJson = JSON.stringify(meta);
  checks.require(C("analysis/strategy-is-yt-dlp"), first.strategy === "yt-dlp", first.strategy);
  checks.require(C("analysis/advertises-preset-1080"), Boolean(preset), meta.presets.map((p) => p.id).join(","));
  checks.require(
    C("analysis/preset-1080-is-video-with-audio-in-mp4"),
    preset.hasVideo === true && preset.hasAudio === true &&
      preset.container === DASH_TARGET_CONTAINER && preset.resolution === DASH_EXPECTED_RESOLUTION,
    `${preset.resolution} ${preset.container} video=${preset.hasVideo} audio=${preset.hasAudio}`,
  );
  checks.require(
    C("analysis/source-quality-1080-deliverable-nothing-withheld"),
    sq !== null && sq.observedMaxHeight === 1080 && sq.deliverableMaxHeight === 1080 &&
      Array.isArray(sq.withheld) && sq.withheld.length === 0,
    JSON.stringify(sq),
  );
  checks.require(
    C("analysis/public-metadata-omits-private-material"),
    meta.formats.length === 0 && privateNeedles.every((needle) => !publicJson.includes(needle)),
  );
  const publicRequests = service.requests(`${caseName}:analysis-public`);
  checks.require(
    C("analysis/no-media-fetched-during-analysis"),
    publicRequests.length > 0 && publicRequests.every((r) => r.kind === "manifest"),
    publicRequests.map((r) => r.kind).join(","),
  );
  const selection = first.selections[DASH_REQUESTED_PRESET];
  const pair = selection?.pair;
  checks.require(
    C("analysis/private-selection-is-a-proven-split"),
    selection?.kind === "split" &&
      GenericSplitSourceSelectionSchema.safeParse(pair).success &&
      pair.video.audioConstraint === "absent" &&
      pair.audio.videoConstraint === "absent" &&
      pair.audio.audioConstraint === "codec-present",
    selection?.kind,
  );
  checks.require(C("analysis/video-half-is-segmented-dash"), pair.video.protocol === "http_dash_segments", pair.video.protocol);
  checks.require(
    C("analysis/audio-half-has-the-expected-protocol"),
    pair.audio.protocol === DASH_CASE_AUDIO_PROTOCOL[caseName],
    pair.audio.protocol,
  );
  checks.require(
    C("analysis/pair-names-the-synthetic-renditions"),
    pair.video.formatId === DASH_SYNTHETIC_FORMAT_IDS.video && pair.audio.formatId === audioId,
  );

  const plan = deriveGenericExecutionPlan(meta, first.selections, DASH_REQUESTED_PRESET);
  checks.require(
    C("plan/merge-split-to-mp4"),
    plan.strategy === "yt-dlp" && plan.operation === "merge-split" &&
      plan.requestedFormatId === DASH_REQUESTED_PRESET && plan.targetContainer === DASH_TARGET_CONTAINER &&
      JSON.stringify(plan.pair) === JSON.stringify(pair),
    `${plan.operation} -> ${plan.targetContainer}`,
  );

  // ── the durable job, paced so fragment files are observable on disk ──────
  service.setBehavior({ pace: POSITIVE_PACE });
  const job = await runJob(ctx, { label: caseName, url, genericLimits: ctx.productGenericLimits });
  service.setBehavior({});
  const { observed, spawns, ledger, finalJob, writer } = job;

  checks.require(
    C("plan/execution-reanalyzed-to-the-same-pair"),
    observed.executionAnalyses === 1 && JSON.stringify(observed.secondPair) === JSON.stringify(pair),
  );

  // ── acquisition ──────────────────────────────────────────────────────────
  const acquisitions = ledger.acquisitions();
  const [videoRun, audioRun] = acquisitions;
  checks.require(
    C("acquisition/one-runtime-probe-two-media-runs-video-first"),
    observed.runtimeProbes === 1 && acquisitions.length === 2 &&
      videoRun.template?.includes("video-source.") === true && audioRun.template?.includes("audio-source.") === true,
    `${observed.runtimeProbes} probe(s), ${acquisitions.length} media run(s)`,
  );
  checks.require(
    C("acquisition/pinned-policy-argv"),
    acquisitions.every((a) => Object.values(a.policy).every((v) => v === true)),
    "native, fixup=never, one fragment at a time, no kept fragments, abort on unavailable fragment, no ffmpeg location",
  );
  checks.require(
    C("acquisition/no-merge-or-fallback-selector"),
    acquisitions.every((a) => typeof a.selector === "string" && !a.selector.includes("+") && !a.selector.includes("/")) &&
      videoRun.selector.includes('[acodec="none"]') && audioRun.selector.includes('[vcodec="none"]'),
  );
  const expectedVideoFragments = fixtures.video.segments.length + 1;
  checks.require(
    C("acquisition/video-used-the-native-dash-fragment-downloader"),
    videoRun.exitCode === 0 &&
      JSON.stringify(videoRun.identity?.fragmentDownloaders) === JSON.stringify(["DashSegmentsFD"]),
    (videoRun.identity?.tags ?? []).join(","),
  );
  checks.require(
    C("acquisition/video-fragment-count-equals-the-manifest"),
    JSON.stringify(videoRun.identity?.totalFragments) === JSON.stringify([expectedVideoFragments]),
    `${JSON.stringify(videoRun.identity?.totalFragments)} vs [${expectedVideoFragments}]`,
  );
  const audioExpectation =
    caseName === "dash-dash"
      ? { downloaders: ["DashSegmentsFD"], totals: [fixtures.audio.segments.length + 1] }
      : { downloaders: [], totals: [] };
  checks.require(
    C("acquisition/audio-used-the-expected-downloader"),
    audioRun.exitCode === 0 &&
      JSON.stringify(audioRun.identity?.fragmentDownloaders) === JSON.stringify(audioExpectation.downloaders) &&
      JSON.stringify(audioRun.identity?.totalFragments) === JSON.stringify(audioExpectation.totals),
    `${(audioRun.identity?.tags ?? []).join(",")} totals=${JSON.stringify(audioRun.identity?.totalFragments)}`,
  );
  checks.require(
    C("acquisition/no-postprocessor-or-other-downloader-ran"),
    acquisitions.every((a) => Array.isArray(a.identity?.unexpectedTags) && a.identity.unexpectedTags.length === 0),
    acquisitions.flatMap((a) => a.identity?.unexpectedTags ?? []).join(",") || "none",
  );

  const acq = job.requests("acquisition");
  const renditionRequests = (role) => acq.filter((r) => r.role === role && (r.kind === "init" || r.kind === "segment"));
  const inOrder = (role, count) => {
    const got = renditionRequests(role);
    return (
      got.length === count + 1 &&
      got.every((r, i) => r.ordinal === i && r.status === 200 && r.finished === true && r.bytesWritten === r.declaredLength)
    );
  };
  const progressiveGets = acq.filter((r) => r.kind === "progressive");
  const audioServedOk =
    caseName === "dash-dash"
      ? inOrder("audio", fixtures.audio.segments.length) && progressiveGets.length === 0
      : renditionRequests("audio").length === 0 &&
        progressiveGets.length === 1 && progressiveGets[0].status === 200 && progressiveGets[0].finished === true;
  checks.require(
    C("acquisition/fixture-served-every-fragment-once-in-order"),
    inOrder("video", fixtures.video.segments.length) && audioServedOk &&
      acq.every((r) => r.kind !== "unknown" && r.method === "GET") &&
      acq.filter((r) => r.kind === "manifest").length === 2,
    acq.map((r) => `${r.kind}:${r.role ?? "-"}:${r.ordinal ?? "-"}`).join(" "),
  );
  const acqClasses = job.workspace.acquisition?.classes ?? [];
  checks.require(
    C("acquisition/fragment-files-observed-on-disk"),
    acqClasses.includes("fragment-in-flight") && acqClasses.includes("aggregate"),
    acqClasses.join(","),
  );
  const inputs = observed.inputs;
  checks.require(
    C("acquisition/video-bytes-are-the-exact-fragment-concatenation"),
    inputs?.videoSha256 === fixtures.video.sha256 && inputs?.videoBytes === fixtures.video.byteLength,
    `${inputs?.videoBytes} vs ${fixtures.video.byteLength}`,
  );
  checks.require(
    C("acquisition/audio-bytes-are-the-exact-fixture"),
    inputs?.audioSha256 === audioFixture.sha256 && inputs?.audioBytes === audioFixture.byteLength,
    `${inputs?.audioBytes} vs ${audioFixture.byteLength}`,
  );
  const listingNames = (observed.mergeEntryListing ?? []).map((e) => e.name);
  checks.require(
    C("acquisition/no-fragment-residue-at-processing-entry"),
    JSON.stringify(listingNames) === JSON.stringify(["audio-source.m4a", "video-source.mp4"]) &&
      observed.mergeEntryListing.every((e) => e.regularFile),
    listingNames.join(","),
  );

  // ── real input validation ────────────────────────────────────────────────
  checks.require(
    C("input/video-ffprobe-1920x1080-video-only"),
    inputs !== null && isVideoOnly1080(inputs.video),
    JSON.stringify(inputs?.video?.streams ?? []),
  );
  checks.require(
    C("input/audio-ffprobe-audio-only"),
    inputs !== null && isAudioOnly(inputs.audio),
    JSON.stringify(inputs?.audio?.streams ?? []),
  );
  const media = spawns.filter((s) => isMediaTool(s) && s.role === "media");
  const sig = media.map((s) => `${s.tool}:${[...s.touched].sort().join("+")}`);
  checks.require(
    C("input/product-probed-both-inputs-before-the-merge"),
    sig.length === 4 && sig[0] === "ffprobe:video-source.mp4" && sig[1] === "ffprobe:audio-source.m4a",
    sig.join(" "),
  );
  const ffmpegRuns = media.filter((s) => s.tool === "ffmpeg");
  checks.require(
    C("merge/one-real-ffmpeg-stream-copy"),
    ffmpegRuns.length === 1 && ffmpegRuns[0].streamCopy === true && ffmpegRuns[0].refusesOverwrite === true &&
      sig[2] === "ffmpeg:audio-source.m4a+merged.mp4+video-source.mp4",
    sig[2] ?? "no ffmpeg",
  );
  checks.require(
    C("merge/merge-split-media-returned-the-merged-artifact"),
    observed.mergeReturned === true && observed.mergedName === `merged.${DASH_TARGET_CONTAINER}`,
    observed.mergedName,
  );
  checks.require(C("output/product-validated-the-output-after-the-merge"), sig[3] === "ffprobe:merged.mp4", sig[3]);

  // ── lifecycle ────────────────────────────────────────────────────────────
  checks.require(
    C("lifecycle/durable-trace"),
    JSON.stringify(job.trace) === JSON.stringify(["queued", "analyzing", "downloading", "processing", "uploading", "ready"]),
    job.trace.join(" -> "),
  );
  const ytdlpAcq = spawns.filter((s) => s.tool === "yt-dlp" && s.role === "acquisition");
  const whileDownloading = spawns.filter((s) => s.status === "downloading");
  checks.require(
    C("lifecycle/acquisition-only-while-downloading"),
    ytdlpAcq.length === 2 && ytdlpAcq.every((s) => s.status === "downloading") &&
      whileDownloading.every((s) => s.tool === "yt-dlp" && (s.role === "acquisition" || s.role === "runtime-probe")) &&
      [...observed.statusesDuringAcquisition].every((s) => s === "downloading"),
    whileDownloading.map((s) => `${s.tool}:${s.role}`).join(","),
  );
  checks.require(
    C("lifecycle/no-media-tool-while-downloading"),
    whileDownloading.filter(isMediaTool).length === 0,
  );
  checks.require(
    C("lifecycle/media-tools-only-while-processing"),
    media.length === 4 && media.every((s) => s.status === "processing") && observed.statusAtMergeEntry === "processing",
    media.map((s) => s.status).join(","),
  );
  checks.require(
    C("lifecycle/sampler-saw-no-media-tool-during-acquisition"),
    job.mediaToolSightingsDuringAcquisition === 0,
  );
  // Honest, monotonic progress: a segmented source declares no total, so the
  // durable percentage stays unknown (null) while bytes are counted; the byte
  // count must rise monotonically, never past the real artifacts, and the
  // percentage, wherever one was written, must too — ending at 100 at `ready`.
  const artifactBytes = fixtures.video.byteLength + audioFixture.byteLength;
  checks.require(
    C("lifecycle/progress-monotonic"),
    job.downloadedBytes.length >= 2 && nonDecreasing(job.downloadedBytes) &&
      job.downloadedBytes.every((b) => b >= 0 && b <= artifactBytes) &&
      nonDecreasing(job.progress) && job.progress.every((p) => p >= 0 && p <= 100) &&
      job.progress[job.progress.length - 1] === 100,
    `${job.downloadedBytes.length} byte readings, max ${Math.max(0, ...job.downloadedBytes)} of ${artifactBytes}; ` +
      `${job.progress.length} percentage readings`,
  );

  // ── workspace ────────────────────────────────────────────────────────────
  const allowance = ctx.productGenericLimits.maxFileSizeBytes;
  const acqPeak = job.workspace.acquisition?.peakMediaBytes ?? Number.POSITIVE_INFINITY;
  const procPeak = job.workspace.processing?.peakBytes ?? Number.POSITIVE_INFINITY;
  const largestFragment = Math.max(fixtures.video.maxFragmentBytes, fixtures.audio.maxFragmentBytes);
  checks.require(C("workspace/acquisition-peak-within-the-allowance"), acqPeak <= allowance, `${acqPeak} <= ${allowance}`);
  checks.require(
    C("workspace/acquisition-peak-within-artifacts-plus-one-fragment"),
    acqPeak <= fixtures.video.byteLength + audioFixture.byteLength + largestFragment,
    `${acqPeak} <= ${fixtures.video.byteLength + audioFixture.byteLength + largestFragment}`,
  );
  checks.require(
    C("workspace/processing-peak-within-twice-the-limit"),
    procPeak <= 2 * allowance &&
      procPeak <= (inputs?.videoBytes ?? 0) + (inputs?.audioBytes ?? 0) + (observed.mergedSize ?? 0),
    `${procPeak} <= inputs + output`,
  );

  // ── upload and ready ─────────────────────────────────────────────────────
  const heads = writer.headLog();
  const head = heads.length === 1 ? heads[0] : null;
  const put = head ? (writer.putLog().find((p) => p.objectKey === head.objectKey) ?? null) : null;
  checks.require(
    C("upload/lifecycle-accepted-the-provider-head"),
    finalJob?.status === "ready" && writer.deleteLog().length === 0 && writer.putCount() === 1 &&
      head !== null && put !== null && head.contentLength === put.declaredLength &&
      head.contentType === put.declaredContentType && observed.statusesAtPut.every((s) => s === "uploading") &&
      observed.statusesAtPut.length === 1,
    `status=${finalJob?.status} error=${finalJob?.errorCode ?? "none"}`,
  );
  const object = writer.soleObject();
  checks.require(
    C("upload/uploaded-bytes-are-the-merged-bytes"),
    object !== null && object.sha256 === observed.preUploadSha256 &&
      object.declaredLength === object.observedBytes && object.observedBytes === observed.mergedSize,
  );
  checks.require(C("upload/content-type-is-video-mp4"), object?.contentType === DASH_TARGET_MIME, object?.contentType);
  checks.require(C("ready/final-status-ready"), finalJob?.status === "ready", finalJob?.status);
  checks.require(
    C("ready/metadata-matches-the-upload"),
    finalJob.fileSize === object.observedBytes && finalJob.container === DASH_TARGET_CONTAINER &&
      finalJob.mime === mimeForContainer(DASH_TARGET_CONTAINER) && finalJob.extractor === "yt-dlp" &&
      finalJob.objectKey.startsWith(`videofetch/jobs/${job.jobId}/`) &&
      job.durableRow.format_id === DASH_REQUESTED_PRESET,
  );
  const surfaces = [
    publicJson,
    JSON.stringify(Object.fromEntries(Object.entries(job.durableRow).filter(([, v]) => typeof v === "string"))),
    String(finalJob.filename ?? ""),
    String(finalJob.objectKey ?? ""),
    String(object.contentDisposition ?? ""),
  ];
  checks.require(
    C("privacy/no-private-material-on-any-public-surface"),
    surfaces.every((text) => privateNeedles.every((needle) => !text.includes(needle))),
  );

  // ── the delivered media itself ───────────────────────────────────────────
  const out = await probeMedia(runTool, toolchain.ffprobePath, object.path);
  const outVideo = out.streams.find((s) => s.type === "video");
  checks.require(C("output/container-is-mp4"), out.readable && out.formatName === ISO_BMFF_FORMAT_NAME, out.formatName);
  checks.require(C("output/exactly-one-video-stream"), streamCount(out, "video") === 1, String(streamCount(out, "video")));
  checks.require(C("output/exactly-one-audio-stream"), streamCount(out, "audio") === 1, String(streamCount(out, "audio")));
  checks.require(C("output/exactly-two-streams"), out.streams.length === 2, String(out.streams.length));
  checks.require(
    C("output/resolution-is-1920x1080"),
    outVideo?.width === DASH_FIXTURE_SPEC.video.width && outVideo?.height === DASH_FIXTURE_SPEC.video.height,
    `${outVideo?.width}x${outVideo?.height}`,
  );
  checks.require(
    C("output/duration-matches-the-fixture"),
    out.duration !== null && Math.abs(out.duration - DASH_FIXTURE_SPEC.video.durationSeconds) <= DURATION_TOLERANCE_SECONDS,
    `${out.duration}s`,
  );
  checks.require(
    C("output/size-positive-and-within-the-limit"),
    object.observedBytes > 0 && object.observedBytes <= config.maxFileSize,
    String(object.observedBytes),
  );
  const outVideoPackets = await streamPacketDigest(runTool, toolchain.ffprobePath, object.path, "v:0");
  const outAudioPackets = await streamPacketDigest(runTool, toolchain.ffprobePath, object.path, "a:0");
  checks.require(
    C("output/stream-copy-packet-identity"),
    outVideoPackets.digest !== null && outVideoPackets.digest === inputs?.videoPackets?.digest &&
      outAudioPackets.digest !== null && outAudioPackets.digest === inputs?.audioPackets?.digest &&
      outVideoPackets.digest !== outAudioPackets.digest,
    `${outVideoPackets.packetCount} video + ${outAudioPackets.packetCount} audio packets`,
  );

  checks.require(C("cleanup/job-workdir-removed"), job.workDirGone);

  return {
    requestedPreset: DASH_REQUESTED_PRESET,
    analysis: {
      presetIds: meta.presets.map((p) => p.id),
      preset1080: { resolution: preset.resolution, container: preset.container, hasVideo: preset.hasVideo, hasAudio: preset.hasAudio },
      sourceQuality: sq,
      publicRawFormats: meta.formats.length,
    },
    plan: {
      operation: plan.operation,
      targetContainer: plan.targetContainer,
      videoProtocol: pair.video.protocol,
      audioProtocol: pair.audio.protocol,
      videoContainer: pair.video.container,
      audioContainer: pair.audio.container,
    },
    acquisition: {
      downloaders: acquisitions.map((a) => ({
        half: a === videoRun ? "video" : "audio",
        fragmentDownloaders: a.identity?.fragmentDownloaders ?? [],
        consoleTags: a.identity?.tags ?? [],
        totalFragments: a.identity?.totalFragments ?? [],
        exitCode: a.exitCode,
      })),
      videoBytes: inputs?.videoBytes ?? null,
      audioBytes: inputs?.audioBytes ?? null,
      videoSha256: inputs?.videoSha256 ?? null,
      audioSha256: inputs?.audioSha256 ?? null,
      directoryAtProcessingEntry: observed.mergeEntryListing,
      fixtureRequests: acq.map((r) => ({ kind: r.kind, role: r.role, ordinal: r.ordinal, status: r.status, finished: r.finished })),
    },
    inputProbes: {
      video: inputs?.video ?? null,
      audio: inputs?.audio ?? null,
    },
    merge: {
      returned: observed.mergeReturned,
      outputName: observed.mergedName,
      outputBytes: observed.mergedSize,
      behavior: "stream copy (-c:v copy -c:a copy), -n; no encoder named, no transcode fallback",
    },
    output: {
      formatName: out.formatName,
      durationSeconds: out.duration,
      streams: out.streams,
      bytes: object.observedBytes,
      videoPacketCount: outVideoPackets.packetCount,
      audioPacketCount: outAudioPackets.packetCount,
      packetIdentityWithAcquiredInputs: outVideoPackets.digest === inputs?.videoPackets?.digest &&
        outAudioPackets.digest === inputs?.audioPackets?.digest,
    },
    lifecycle: {
      durableTrace: job.trace,
      spawns: spawnTable(spawns),
      downloadedBytesReadings: job.downloadedBytes.length,
      maxDownloadedBytesWhileDownloading: Math.max(0, ...job.downloadedBytes),
      percentageReadings: job.progress.length,
    },
    workspace: {
      allowanceBytes: allowance,
      acquisitionPeakMediaBytes: job.workspace.acquisition?.peakMediaBytes ?? null,
      acquisitionPeakBytes: job.workspace.acquisition?.peakBytes ?? null,
      acquisitionEntryClasses: acqClasses,
      processingPeakBytes: job.workspace.processing?.peakBytes ?? null,
      largestFragmentBytes: largestFragment,
    },
    upload: {
      provider: "harness local ObjectStoreWriter (NOT Cloudflare R2)",
      contentType: object.contentType,
      bytes: object.observedBytes,
      sha256: object.sha256,
      bytesIdenticalToMerged: object.sha256 === observed.preUploadSha256,
    },
    cleanup: { jobWorkdirRemoved: job.workDirGone },
  };
}

// ── 5. The bounded negatives ───────────────────────────────────────────────

async function runNegative(ctx, { name, caseName, genericLimits, behavior }) {
  const { checks, service, validateUrl } = ctx;
  const N = (check) => `negative/${name}/${check}`;
  service.setBehavior(behavior);
  const job = await runJob(ctx, { label: `negative-${name}`, url: validateUrl.urlFor(DASH_MANIFEST_ROUTE[caseName]), genericLimits });
  service.setBehavior({});
  const media = job.spawns.filter((s) => isMediaTool(s) && s.role === "media");
  checks.require(
    N("never-processing-no-media-tool-no-upload"),
    !job.trace.includes("processing") && !job.trace.includes("uploading") && job.finalJob?.status === "failed" &&
      media.length === 0 && job.writer.putCount() === 0,
    job.trace.join(" -> "),
  );
  checks.require(N("workdir-removed"), job.workDirGone);
  return job;
}

async function runNegatives(ctx) {
  const { checks, fixtures } = ctx;
  const timeout = ctx.productGenericLimits.downloadTimeoutSeconds;

  // ── fragment-aware byte guard ────────────────────────────────────────────
  // The allowance admits every byte before the LAST video segment plus half of
  // it. The service writes all but that segment's last KiB, then holds. A guard
  // that counts the in-flight fragment trips during the hold; one that counted
  // only the aggregate `.part` would wait for the fragment to complete.
  const last = fixtures.video.segments[fixtures.video.segments.length - 1];
  if (last.byteLength < 24 * 1024) throw new Error("the last video segment is too small for the guard negative");
  const beforeLast = fixtures.video.byteLength - last.byteLength;
  const guardAllowance = beforeLast + Math.floor(last.byteLength / 2);
  const heldRoute = dashSegmentRoute("video", fixtures.video.segments.length);
  const guard = await runNegative(ctx, {
    name: "fragment-guard",
    caseName: "dash-dash",
    genericLimits: { maxFileSizeBytes: guardAllowance, downloadTimeoutSeconds: timeout },
    behavior: { hold: { route: heldRoute, tailBytes: GUARD_HOLD_TAIL_BYTES, holdMs: GUARD_HOLD_MS } },
  });
  const held = guard.requests("acquisition").filter((r) => r.held);
  checks.require(
    "negative/fragment-guard/too-large",
    guard.finalJob?.status === "failed" && guard.finalJob?.errorCode === "TOO_LARGE",
    String(guard.finalJob?.errorCode),
  );
  checks.require(
    "negative/fragment-guard/stopped-inside-the-held-fragment",
    held.length === 1 && held[0].finished === false && held[0].clientClosedEarly === true &&
      held[0].bytesWritten < held[0].declaredLength,
    held.map((r) => `finished=${r.finished} closedEarly=${r.clientClosedEarly}`).join(","),
  );
  checks.require(
    "negative/fragment-guard/audio-never-started",
    guard.ledger.acquisitions().length === 1 &&
      guard.requests("acquisition").every((r) => r.role !== "audio"),
  );

  // ── the combined split budget ────────────────────────────────────────────
  // Video fits; video + audio exceeds by one byte. The budget is ONE for the
  // pair, so the audio half must be refused.
  const combinedAllowance = fixtures.video.byteLength + fixtures.audio.byteLength - 1;
  const combined = await runNegative(ctx, {
    name: "combined-budget",
    caseName: "dash-dash",
    genericLimits: { maxFileSizeBytes: combinedAllowance, downloadTimeoutSeconds: timeout },
    behavior: {},
  });
  checks.require(
    "negative/combined-budget/too-large",
    combined.finalJob?.status === "failed" && combined.finalJob?.errorCode === "TOO_LARGE",
    String(combined.finalJob?.errorCode),
  );
  checks.require(
    "negative/combined-budget/both-halves-ran",
    combined.ledger.acquisitions().length === 2,
    `${combined.ledger.acquisitions().length} media run(s)`,
  );

  // ── the missing fragment ─────────────────────────────────────────────────
  // One media segment answers 404. The pinned default would SKIP it and exit 0
  // with media missing; `--abort-on-unavailable-fragments` must make it fail,
  // and no later segment may be requested.
  const missingRoute = dashSegmentRoute("video", MISSING_FRAGMENT_ORDINAL);
  const missing = await runNegative(ctx, {
    name: "missing-fragment",
    caseName: "dash-dash",
    genericLimits: ctx.productGenericLimits,
    behavior: { failing: { route: missingRoute, status: 404 } },
  });
  const videoSegments = missing.requests("acquisition").filter((r) => r.role === "video" && r.kind === "segment");
  checks.require(
    "negative/missing-fragment/extraction-failed",
    missing.finalJob?.status === "failed" && missing.finalJob?.errorCode === MISSING_FRAGMENT_EXPECTED_CODE,
    String(missing.finalJob?.errorCode),
  );
  checks.require(
    "negative/missing-fragment/aborted-not-skipped",
    videoSegments.some((r) => r.ordinal === MISSING_FRAGMENT_ORDINAL && r.status === 404) &&
      videoSegments.every((r) => r.ordinal <= MISSING_FRAGMENT_ORDINAL) &&
      missing.ledger.acquisitions().length === 1,
    videoSegments.map((r) => `${r.ordinal}:${r.status}`).join(","),
  );

  const summarize = (job, extra) => ({
    finalStatus: job.finalJob?.status ?? null,
    errorCode: job.finalJob?.errorCode ?? null,
    durableTrace: job.trace,
    mediaRuns: job.ledger.acquisitions().length,
    spawns: spawnTable(job.spawns),
    uploads: job.writer.putCount(),
    jobWorkdirRemoved: job.workDirGone,
    acquisitionPeakMediaBytes: job.workspace.acquisition?.peakMediaBytes ?? null,
    ...extra,
  });
  return {
    fragmentGuard: summarize(guard, {
      allowanceBytes: guardAllowance,
      heldFragment: held.map((r) => ({ ordinal: r.ordinal, declaredLength: r.declaredLength, bytesWritten: r.bytesWritten, finished: r.finished })),
      holdMs: GUARD_HOLD_MS,
    }),
    combinedBudget: summarize(combined, { allowanceBytes: combinedAllowance }),
    missingFragment: summarize(missing, {
      missingOrdinal: MISSING_FRAGMENT_ORDINAL,
      status: 404,
      videoSegmentRequests: videoSegments.map((r) => ({ ordinal: r.ordinal, status: r.status })),
    }),
  };
}

// ── 6. Main ────────────────────────────────────────────────────────────────

/**
 * A check DETAIL is a harness diagnostic, and an error message can quote a
 * fixture URL. Such a detail is withheld rather than allowed to block the
 * record; every structured field stays under the record's strict leak gate.
 */
function sanitizeDetail(detail) {
  if (detail === null || detail === undefined) return null;
  const text = String(detail).slice(0, 400);
  return findDashForbiddenSubstring(text) === null ? text : "<withheld: named fixture material>";
}

async function admitEvidencePath(path) {
  if (await pathExists(path)) throw new Error(`refusing to replace an existing evidence artifact: ${path}`);
}

async function main(argv) {
  const opts = parseArgv(argv);
  await admitEvidencePath(opts.evidence);

  const checks = createChecks();
  const startedAt = new Date().toISOString();
  const workRoot = await mkdtemp(join(tmpdir(), "dash01-"));
  const interfaces = Object.keys(networkInterfaces()).sort();
  let verdict = "BLOCKED";
  let toolchain = null;
  let fixtureSummary = null;
  const cases = {};
  let negatives = null;
  let service = null;
  let spawnObserver = null;

  const identity = {
    sourceCommit: opts.sourceCommit,
    sourceTree: opts.sourceTree,
    sourceContextClean: opts.sourceContextClean,
    candidateTag: opts.candidateTag,
    candidateImageId: opts.candidateImageId,
    runImageId: opts.runImageId,
  };
  for (const entry of releaseIdentityChecks(identity, { networkInterfaceNames: interfaces })) {
    checks.record(entry.name, entry.ok, entry.detail);
  }

  try {
    // Before the spawn observer: everything here is the harness's own.
    const { spawn: plainSpawn } = await import("node:child_process");
    const plainRunTool = createToolRunner(plainSpawn);
    toolchain = await preflight(checks, plainRunTool);
    const prepared = await prepareFixture(checks, plainRunTool, toolchain, workRoot);
    fixtureSummary = prepared.summary;
    const fixtures = prepared.fixtures;

    const { table, segmentCounts } = dashRouteTable(fixtures);
    service = createDashFixtureService({ table, segmentCounts });
    const bound = await service.listen();
    checks.require(
      "fixture/service-binds-loopback-only",
      bound.address === DASH_FIXTURE_LISTEN_ADDRESS,
      bound.address === DASH_FIXTURE_LISTEN_ADDRESS ? "loopback" : "not loopback",
    );
    const validateUrl = createExactFixtureUrlValidator({ port: bound.port, routes: Object.values(DASH_MANIFEST_ROUTE) });

    // From here on every Worker spawn is observed with its durable status.
    const spawnContext = { statusNow: () => "<no-job>", phase: "setup" };
    spawnObserver = installSpawnObserver({
      context: () => ({ status: spawnContext.statusNow(), phase: spawnContext.phase }),
    });
    const runTool = createToolRunner(spawnObserver.originalSpawn);

    const ctx = {
      checks, service, validateUrl, fixtures, toolchain, workRoot, runTool, spawnObserver, spawnContext,
      analysisLimits: {
        analysisTimeoutSeconds: Math.max(1, Math.floor(config.analysisTimeoutMs / 1000)),
        maxVideoDurationSeconds: config.maxVideoDuration,
        maxFileSizeBytes: config.maxFileSize,
      },
      productGenericLimits: {
        maxFileSizeBytes: config.maxFileSize,
        downloadTimeoutSeconds: Math.max(1, Math.floor(config.downloadTimeoutMs / 1000)),
      },
    };
    for (const caseName of DASH_CASES) {
      cases[caseName] = await runPositiveCase(ctx, caseName);
    }
    negatives = await runNegatives(ctx);

    verdict = checks.passed() ? "PASS" : "FAIL";
  } catch (error) {
    checks.record("run/completed-without-error", false, error?.message ?? String(error));
    verdict = "FAIL";
    process.stderr.write(`[dash01] ${error?.stack ?? error}\n`);
  } finally {
    if (spawnObserver) spawnObserver.uninstall();
    if (service) await service.close();
  }

  const record = buildDashReleaseEvidence({
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: { commit: opts.sourceCommit, tree: opts.sourceTree, contextClean: opts.sourceContextClean },
    image: { candidateTag: opts.candidateTag, imageId: opts.candidateImageId, runSubject: opts.runImageId },
    network: { observedInterfaceNames: interfaces },
    toolchain,
    fixture: fixtureSummary,
    cases,
    negativeCases: negatives,
    checks: checks.all().map((check) => ({ ...check, detail: sanitizeDetail(check.detail) })),
  });
  await writeFile(opts.evidence, renderDashReleaseEvidence(record), { flag: "wx" });
  await rm(workRoot, { recursive: true, force: true });

  const failed = checks.failed();
  process.stdout.write(`${verdict} ${DASH01_RELEASE_EVIDENCE_SCHEMA} checks=${checks.all().length} failed=${failed.length}\n`);
  for (const f of failed) process.stdout.write(`  FAIL ${f.name}${f.detail ? ` :: ${f.detail}` : ""}\n`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[dash01] ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}
