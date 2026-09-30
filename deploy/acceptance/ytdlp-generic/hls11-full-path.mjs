#!/usr/bin/env node
//
// HLS-11: the clear-HLS v2 REAL-MEDIA release child
// (HLS-V2-ADAPTIVE-VOD-EXPANSION-001).
//
// ── What one run proves ────────────────────────────────────────────────────
//
// That inside the ACTUAL release candidate image, offline, against
// deterministic local fixtures of REAL media, the candidate's own source runs
// the clear-HLS chain end to end for BOTH segment families:
//
//   v1-ts    HLS-V1-MUXED-TS control: 1920x1080 H.264 + AAC MPEG-TS
//   v2-fmp4  HLS-V2-MUXED-FMP4: 1920x1080 H.264 + AAC, init + fMP4 fragments
//
//   browser-safe analysis (real pinned yt-dlp) -> preset:1080
//   -> fresh execution analysis -> ordinary deriveExecutionPlan()
//   -> clear-hls-remux -> HLS-2 real preflight (safe-HTTP)
//   -> HLS-3 real acquisition (the map first for fMP4) -> beginProcessing()
//   -> HLS-4 real ffprobe (the family's explicit demuxer) + real FFmpeg stream
//      copy + real output validation -> beginUploading() -> upload -> ready
//
// with nothing of the Product replaced: plan derivation, HLS acquisition, HLS
// processing and the workspace preflight are the executor's defaults. It then
// measures the delivered MP4 independently (streams, 1920x1080, duration,
// faststart, packet preservation) and the durable status at EVERY request and
// EVERY subprocess.
//
// Five bounded negatives fail closed before any upload — a byte-range map, an
// encrypted playlist, a 404 map, the one byte budget, and a master that claims
// audio for a video-only fMP4 rendition (refused by the REAL ffprobe after
// acquisition, before any FFmpeg run). A split-master case re-proves, against
// the candidate's own pinned yt-dlp, the HLS v2 finding that separate HLS audio
// cannot be paired: no relationship survives into `-J`, so the Product
// advertises nothing for it.
//
// ── The only substitutions ─────────────────────────────────────────────────
//
//   submitted-page URL validator  `lib/hls11-fixture-url.mjs` (exact pages only)
//   safe-HTTP DNS answer + socket `lib/hls-safe-http-transport.mjs`
//   object-store provider         `lib/local-object-writer.mjs`
//
// ── Where it runs ──────────────────────────────────────────────────────────
//
// INSIDE the release candidate container, as the image's non-root `node`
// user, `--network none` with exactly one `--add-host`, launched by the
// SPLIT-07 driver (`releaseHls11AcceptanceRunArgs`).

import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// ── Production modules. Imported, never re-implemented. ────────────────────
import { config } from "../../../src/lib/config.ts";
import { AppError } from "../../../src/lib/errors.ts";
import { mimeForContainer } from "../../../src/services/extractors/normalize.ts";
import { YTDLP_RUNTIME, probeYtdlpRuntime } from "../../../src/worker/runtime/ytdlp-runtime.server.ts";
import { runProcess } from "../../../src/services/processing/process-runner.server.ts";
import { ffmpegAvailable } from "../../../src/services/processing/ffmpeg.server.ts";
import { resolveFfprobePath } from "../../../src/services/processing/ffprobe.server.ts";
import { deriveExecutionPlan } from "../../../src/worker/execution/format-plan.ts";
import { GENERIC_SOURCE_PROTOCOLS } from "../../../src/worker/execution/generic-source.ts";
import { JobExecutor } from "../../../src/worker/execution/job-executor.server.ts";
import {
  ClearHlsPlaylistError,
  HLS_V1_ALLOWED_TAGS,
  HLS_V2_ALLOWED_TAGS,
  parseClearHlsMediaPlaylist,
} from "../../../src/worker/hls/hls-media-playlist.ts";
import {
  AGGREGATE_FILE_NAME,
  FMP4_AGGREGATE_FILE_NAME,
} from "../../../src/worker/hls/hls-fragment-acquisition.server.ts";
import {
  HLS_OUTPUT_FILE_NAME,
  HLS_OUTPUT_PARTIAL_FILE_NAME,
  buildClearHlsFmp4RemuxArgs,
  buildClearHlsRemuxArgs,
} from "../../../src/worker/hls/hls-processing.server.ts";
import {
  setPinnedRequestFactoryForTests,
  setSafeHttpTestHooks,
} from "../../../src/lib/security/safe-http.server.ts";
import { openWorkerDatabase } from "../../../src/worker/state/database.server.ts";
import { applyMigrations } from "../../../src/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "../../../src/worker/state/sqlite-job-store.server.ts";

// ── Harness modules ────────────────────────────────────────────────────────
import { createAnalysisPolicy, createChecks } from "./split-full-path.mjs";
import {
  HLS11_FIXTURE_SPEC,
  generateHls11Rendition,
  hls11ByteRangePlaylist,
  hls11EncryptedPlaylist,
  hls11Master,
  hls11Page,
  hls11SplitMaster,
  topLevelBoxTypes,
} from "./fixtures/hls11-media.mjs";
import { createHls11FixtureService } from "./fixtures/hls11-server.mjs";
import {
  HLS11_FIXTURE_HOSTNAME,
  HLS11_FIXTURE_LOOPBACK,
  classifyHls11FixturePath,
  createHls11PageUrlValidator,
  hls11Marker,
  hls11MediaPlaylistUri,
  hls11NearbyPageUrlAlternatives,
  hls11PagePath,
  hls11PageUrl,
} from "./lib/hls11-fixture-url.mjs";
import {
  HLS_V2_ADMITTED_KINDS,
  createEventClock,
  createHlsSafeHttpTransport,
  withHlsSafeHttpTransport,
} from "./lib/hls-safe-http-transport.mjs";
import {
  analysisDocumentFacts,
  createHlsWorkspaceSampler,
  installHlsSpawnObserver,
} from "./lib/hls11-observers.mjs";
import { createLocalObjectStoreWriter } from "./lib/local-object-writer.mjs";
import { installStatusAudit, readStatusTrace } from "./lib/split-observers.mjs";
import { releaseIdentityChecks } from "./lib/hls-release-evidence.mjs";
import {
  HLS11_POSITIVE_CASES,
  HLS11_RELEASE_EVIDENCE_SCHEMA,
  buildHls11ReleaseEvidence,
  findHls11ForbiddenSubstring,
  renderHls11ReleaseEvidence,
} from "./lib/hls11-evidence.mjs";
import { parseDashArgv as parseReleaseChildArgv } from "./lib/dash-argv.mjs";

// ── Bounds ─────────────────────────────────────────────────────────────────

const REQUESTED_PRESET = "preset:1080";
const ISO_BMFF_FORMAT_NAME = "mov,mp4,m4a,3gp,3g2,mj2";
const DURATION_TOLERANCE_SECONDS = 0.25;
const EXPECTED_TRACE = ["queued", "analyzing", "downloading", "processing", "uploading", "ready"];
const FAILED_IN_DOWNLOADING = ["queued", "analyzing", "downloading", "failed"];
const POST_ANALYSIS = new Set(["downloading", "processing", "uploading", "ready", "failed"]);

/** The family facts per positive case. */
const FAMILY = Object.freeze({
  "v1-ts": { rendition: "ts", aggregate: AGGREGATE_FILE_NAME, demuxer: "mpegts", buildArgs: buildClearHlsRemuxArgs },
  "v2-fmp4": { rendition: "fmp4", aggregate: FMP4_AGGREGATE_FILE_NAME, demuxer: "mov", buildArgs: buildClearHlsFmp4RemuxArgs },
});

// ── Small helpers ──────────────────────────────────────────────────────────

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

function createToolRunner(spawnFn) {
  return (command, args, { timeoutMs = 60_000 } = {}) =>
    new Promise((resolvePromise, reject) => {
      const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 16 * 1024 * 1024) stdout += String(chunk);
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

/** The harness's OWN ffprobe of one file through an explicit demuxer. */
async function probeMedia(runTool, ffprobePath, path, demuxer) {
  const result = await runTool(ffprobePath, [
    "-v", "error", "-protocol_whitelist", "file", "-f", demuxer, "-print_format", "json",
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

/** The SHA-256 over one stream's ordered packet payload digests, and the packet count. */
async function packetDigest(runTool, ffprobePath, path, demuxer, selector) {
  const result = await runTool(ffprobePath, [
    "-v", "error", "-protocol_whitelist", "file", "-f", demuxer, "-select_streams", selector,
    "-show_packets", "-show_data_hash", "sha256", "-print_format", "json", "-i", path,
  ]);
  if (result.code !== 0) return { digest: null, count: 0 };
  const packets = JSON.parse(result.stdout).packets ?? [];
  const rolling = createHash("sha256");
  for (const packet of packets) rolling.update(String(packet.data_hash));
  return { digest: packets.length > 0 ? rolling.digest("hex") : null, count: packets.length };
}

const isMuxed1080 = (probe, family) =>
  probe.readable &&
  probe.formatName === family &&
  probe.streams.length === 2 &&
  probe.streams.filter((s) => s.type === "video" && s.codec === "h264" && s.width === 1920 && s.height === 1080).length === 1 &&
  probe.streams.filter((s) => s.type === "audio" && s.codec === "aac").length === 1;

// ── 1. Preflight and invariants ────────────────────────────────────────────

async function preflight(checks, runTool) {
  checks.require("preflight/node-runtime-family", /^v22\./.test(process.version), process.version);
  const runtime = await probeYtdlpRuntime();
  checks.require("preflight/ytdlp-available", runtime.available === true, runtime.reason ?? null);
  checks.require(
    "preflight/ytdlp-exact-pin",
    runtime.version === YTDLP_RUNTIME.expectedVersion,
    `${runtime.version} vs ${YTDLP_RUNTIME.expectedVersion}`,
  );
  const ffmpegPath = config.ffmpegPath;
  checks.require("preflight/ffmpeg-path-is-the-worker-ffmpeg", ffmpegPath === "/usr/bin/ffmpeg", ffmpegPath);
  const ffmpegVersion = await runTool(ffmpegPath, ["-hide_banner", "-version"]);
  checks.require("preflight/ffmpeg-executes", ffmpegVersion.code === 0 && (await ffmpegAvailable()) === true);
  const ffprobePath = resolveFfprobePath();
  checks.require(
    "preflight/ffprobe-is-the-ffmpeg-sibling",
    ffprobePath === "/usr/bin/ffprobe" && dirname(ffprobePath) === dirname(ffmpegPath),
    ffprobePath,
  );
  const ffprobeVersion = await runTool(ffprobePath, ["-hide_banner", "-version"]);
  checks.require("preflight/ffprobe-executes", ffprobeVersion.code === 0);
  const firstLine = (text) => text.split(/\r?\n/)[0]?.trim() ?? "";
  return {
    node: process.version,
    ytdlpVersion: runtime.version,
    ffmpegPath,
    ffmpegVersion: firstLine(ffmpegVersion.stdout),
    ffprobePath,
    ffprobeVersion: firstLine(ffprobeVersion.stdout),
  };
}

function checkInvariants(checks) {
  const generic = [...GENERIC_SOURCE_PROTOCOLS];
  checks.require(
    "invariants/generic-source-protocols-reviewed-vocabulary",
    sameList(generic, ["http", "https", "http_dash_segments"]) && generic.every((p) => !p.includes("m3u8")),
    generic.join(","),
  );
  checks.require(
    "invariants/v2-grammar-admits-exactly-one-more-tag",
    sameList([...HLS_V2_ALLOWED_TAGS], [...HLS_V1_ALLOWED_TAGS, "#EXT-X-MAP"]),
  );
  checks.require(
    "invariants/harness-file-names-match-the-product",
    AGGREGATE_FILE_NAME === "hls-source.ts" && FMP4_AGGREGATE_FILE_NAME === "hls-source.fmp4" &&
      HLS_OUTPUT_FILE_NAME === "hls-output.mp4" && HLS_OUTPUT_PARTIAL_FILE_NAME === "hls-output.mp4.part",
  );
  const ts = buildClearHlsRemuxArgs({ sourcePath: "/s", outputPath: "/o" });
  const fmp4 = buildClearHlsFmp4RemuxArgs({ sourcePath: "/s", outputPath: "/o" });
  const differing = ts.flatMap((arg, i) => (arg === fmp4[i] ? [] : [i]));
  checks.require(
    "invariants/remux-argvs-differ-only-in-the-demuxer",
    ts.length === fmp4.length && differing.length === 1 && ts[differing[0]] === "mpegts" && fmp4[differing[0]] === "mov",
  );
  return { genericSourceProtocols: generic, v2AllowedTags: [...HLS_V2_ALLOWED_TAGS] };
}

// ── 2. Fixtures ────────────────────────────────────────────────────────────

async function prepareFixtures(checks, runTool, toolchain, workRoot) {
  const renditions = {};
  for (const kind of ["ts", "fmp4", "fmp4-video"]) {
    const dir = join(workRoot, "fixture", kind);
    await mkdir(dir, { recursive: true });
    renditions[kind] = await generateHls11Rendition({ ffmpegPath: toolchain.ffmpegPath, runTool, kind, dir });
    // A harness-side copy of the exact concatenation, for packet measurements.
    const aggregate = Buffer.concat([
      ...(renditions[kind].init ? [renditions[kind].init.bytes] : []),
      ...renditions[kind].segments.map((s) => s.bytes),
    ]);
    renditions[kind].aggregatePath = join(workRoot, "fixture", `${kind}.aggregate`);
    await writeFile(renditions[kind].aggregatePath, aggregate);
  }
  const { ts, fmp4 } = renditions;
  const fmp4Video = renditions["fmp4-video"];
  const tsProbe = await probeMedia(runTool, toolchain.ffprobePath, ts.aggregatePath, "mpegts");
  const fmp4Probe = await probeMedia(runTool, toolchain.ffprobePath, fmp4.aggregatePath, "mov");
  const videoProbe = await probeMedia(runTool, toolchain.ffprobePath, fmp4Video.aggregatePath, "mov");
  checks.require("fixture/ts-is-1920x1080-h264-aac-mpegts", isMuxed1080(tsProbe, "mpegts"), JSON.stringify(tsProbe.streams));
  checks.require("fixture/fmp4-is-1920x1080-h264-aac-iso-bmff", isMuxed1080(fmp4Probe, ISO_BMFF_FORMAT_NAME), JSON.stringify(fmp4Probe.streams));
  checks.require(
    "fixture/fmp4-video-only-is-video-only",
    videoProbe.readable && videoProbe.streams.length === 1 && videoProbe.streams[0].type === "video",
    JSON.stringify(videoProbe.streams),
  );
  const initBoxes = topLevelBoxTypes(fmp4.init.bytes);
  const segmentBoxes = fmp4.segments.map((s) => topLevelBoxTypes(s.bytes));
  checks.require(
    "fixture/fmp4-init-is-ftyp-moov-and-fragments-are-moof-mdat",
    sameList(initBoxes, ["ftyp", "moov"]) &&
      fmp4.segments.length >= 3 &&
      segmentBoxes.every((boxes) => boxes.includes("moof") && boxes.includes("mdat") && !boxes.includes("moov")),
    `${initBoxes.join(",")} / ${segmentBoxes[0]?.join(",")}`,
  );

  // Determinism, measured: the fMP4 recipe again, byte-identical.
  const againDir = join(workRoot, "fixture", "fmp4-again");
  await mkdir(againDir, { recursive: true });
  const again = await generateHls11Rendition({ ffmpegPath: toolchain.ffmpegPath, runTool, kind: "fmp4", dir: againDir });
  checks.require("fixture/recipes-are-bit-exact", again.aggregateSha256 === fmp4.aggregateSha256);

  // The Product's own parser decides what the grammar is.
  const parsed = (text) => {
    try {
      return parseClearHlsMediaPlaylist(text);
    } catch (error) {
      return error instanceof ClearHlsPlaylistError ? { refused: error.reason } : { refused: "non-playlist-error" };
    }
  };
  const tsParsed = parsed(ts.playlistText);
  const tsTags = ts.playlistText.split("\n").filter((l) => l.startsWith("#")).map((l) => l.split(":")[0]);
  checks.require(
    "fixture/ts-playlist-is-the-v1-subset",
    tsParsed.segmentType === "mpegts" && tsParsed.fragmentCount === ts.segments.length &&
      tsTags.every((t) => HLS_V1_ALLOWED_TAGS.includes(t)),
  );
  const fmp4Parsed = parsed(fmp4.playlistText);
  checks.require(
    "fixture/fmp4-playlist-is-the-v2-grammar",
    fmp4Parsed.segmentType === "fmp4" && fmp4Parsed.initializationMap?.reference === "init.mp4" &&
      fmp4Parsed.fragmentCount === fmp4.segments.length,
  );
  const byteRange = hls11ByteRangePlaylist(fmp4.playlistText, fmp4.init.byteLength);
  const encrypted = hls11EncryptedPlaylist(fmp4.playlistText);
  checks.require(
    "fixture/negative-playlists-are-refused-by-the-parser",
    parsed(byteRange).refused === "byte_range" && parsed(encrypted).refused === "encrypted",
    `${parsed(byteRange).refused} ${parsed(encrypted).refused}`,
  );

  const facts = (r) => ({
    segmentType: r.segmentType,
    segments: r.segments.length,
    segmentBytes: r.segments.map((s) => s.byteLength),
    initBytes: r.init?.byteLength ?? null,
    aggregateBytes: r.aggregateBytes,
    aggregateSha256: r.aggregateSha256,
  });
  return {
    renditions,
    playlists: { byteRange, encrypted },
    summary: {
      recipe: "FFmpeg lavfi testsrc2 + sine -> libx264 (1 thread, bit-exact) + AAC-LC -> FFmpeg hls muxer, served verbatim",
      spec: { ...HLS11_FIXTURE_SPEC },
      ts: facts(ts),
      fmp4: { ...facts(fmp4), initTopLevelBoxes: initBoxes, fragmentTopLevelBoxes: segmentBoxes[0] ?? [] },
      fmp4VideoOnly: facts(fmp4Video),
      deterministic: again.aggregateSha256 === fmp4.aggregateSha256,
    },
  };
}

/** The complete route table, before the service starts. */
function routeTable(prepared) {
  const routes = new Map();
  const add = (caseName, leaf, kind, body) =>
    routes.set(`/hls11/${caseName}/${leaf}`, { kind, body: Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8") });
  const media = (caseName, playlistText) => add(caseName, hls11MediaPlaylistUri(caseName), "media", playlistText);
  const rendition = (caseName, r) => {
    if (r.init) add(caseName, "init.mp4", "init", r.init.bytes);
    for (const s of r.segments) add(caseName, s.name, "fragment", s.bytes);
  };
  const { ts, fmp4 } = prepared.renditions;
  const fmp4Video = prepared.renditions["fmp4-video"];
  for (const caseName of ["v1-ts", "v2-fmp4", "neg-byterange", "neg-encrypted", "neg-init-404", "neg-budget", "neg-video-only"]) {
    add(caseName, "watch.html", "page", hls11Page(caseName));
    add(caseName, "master.m3u8", "master", hls11Master(caseName));
  }
  media("v1-ts", ts.playlistText);
  rendition("v1-ts", ts);
  media("v2-fmp4", fmp4.playlistText);
  rendition("v2-fmp4", fmp4);
  media("neg-byterange", prepared.playlists.byteRange);
  rendition("neg-byterange", fmp4);
  media("neg-encrypted", prepared.playlists.encrypted);
  rendition("neg-encrypted", fmp4);
  media("neg-init-404", fmp4.playlistText);
  rendition("neg-init-404", fmp4);
  media("neg-budget", fmp4.playlistText);
  rendition("neg-budget", fmp4);
  media("neg-video-only", fmp4Video.playlistText);
  rendition("neg-video-only", fmp4Video);
  add("split-master", "watch.html", "page", hls11Page("split-master"));
  add("split-master", "master.m3u8", "master", hls11SplitMaster());
  for (const leaf of ["video-1080.m3u8", "video-720.m3u8", "audio-main.m3u8", "audio-alt.m3u8"]) {
    add("split-master", leaf, "media", fmp4.playlistText);
  }
  // Every Product-visible path must classify to the kind it is served as.
  for (const [path, served] of routes) {
    if (classifyHls11FixturePath(path).kind !== served.kind) throw new Error("a route does not classify as its kind");
  }
  return routes;
}

// ── 3. One durable job through the real executor ───────────────────────────

async function runJob(ctx, caseName) {
  const { policy, service, workRoot, spawnContext, spawnObserver, transport } = ctx;
  const dbDir = await mkdtemp(join(workRoot, "hls11-db-"));
  const db = openWorkerDatabase({ path: join(dbDir, "worker.sqlite") });
  applyMigrations(db);
  installStatusAudit(db);
  const store = new SQLiteJobStore({ db });
  let jobId = null;
  const statusNow = () => (jobId ? (store.getJob(jobId)?.status ?? "<missing>") : "<no-job>");
  spawnContext.statusNow = statusNow;
  ctx.transportState.statusNow = statusNow;
  ctx.transportState.caseNow = () => caseName;

  const workspace = createHlsWorkspaceSampler({ intervalMs: 2 });
  const sinkDir = await mkdtemp(join(workRoot, "hls11-sink-"));
  const puts = [];
  const writer = createLocalObjectStoreWriter({
    sinkDir,
    onPut: (input) => {
      const path = typeof input.body?.path === "string" ? input.body.path : null;
      const bytes = path ? readFileSync(path) : null;
      puts.push({
        status: statusNow(),
        streamBasename: path ? basename(path) : null,
        preUploadSha256: bytes ? sha256(bytes) : null,
        preUploadBytes: bytes ? bytes.byteLength : null,
      });
      workspace.setPhase("upload");
    },
  });
  const observed = { executionAnalyses: 0, facts: null };
  const setPhase = (phase) => {
    spawnContext.phase = `${caseName}:${phase}`;
    service.setPhase(`${caseName}:${phase}`);
    workspace.setPhase(phase);
  };
  const deps = {
    // ONE seam, a transparent recording wrapper around the policy's own
    // analyzeForExecution. Plan derivation, HLS acquisition, HLS processing and
    // the capacity reader are all the executor's defaults.
    analyzeForExecution: async (url, signal) => {
      setPhase("analysis-execution");
      const result = await policy.analyzeForExecution(url, signal);
      observed.executionAnalyses += 1;
      const hls = result.hlsSelections ?? {};
      observed.facts = {
        hlsOwns1080: Object.hasOwn(hls, REQUESTED_PRESET),
        progressiveOwns1080: Object.hasOwn(result.selections ?? {}, REQUESTED_PRESET),
        hlsOwnedPresetIds: Object.keys(hls).sort(),
      };
      try {
        const plan = deriveExecutionPlan(result, REQUESTED_PRESET);
        observed.facts.plan = plan.strategy === "yt-dlp"
          ? {
              operation: plan.generic.operation,
              targetContainer: plan.generic.targetContainer,
              requestedFormatId: plan.generic.requestedFormatId,
              genericKeys: Object.keys(plan.generic).sort(),
            }
          : { operation: "direct" };
      } catch (error) {
        observed.facts.planError = error instanceof AppError ? error.code : "non-app-error";
      }
      workspace.setDirectory(join(config.tempDirectory, "jobs", jobId));
      setPhase("acquisition");
      return result;
    },
  };

  const created = store.createJob(
    { url: hls11PageUrl(ctx.port, caseName), formatId: REQUESTED_PRESET, principalId: "private-access-user" },
    randomUUID(),
  );
  if (created.type !== "created") throw new Error(`the ${caseName} job was not created`);
  jobId = created.job.jobId;
  const claimed = store.claimNextQueuedJob();
  if (claimed?.status !== "analyzing") throw new Error(`the ${caseName} job was not claimed`);

  const spawnMark = spawnObserver.count();
  const transportMark = transport.ledger().length;
  workspace.start();
  const statusPoll = setInterval(() => {
    const status = statusNow();
    if (status === "processing") workspace.setPhase("processing");
  }, 2);
  const executor = new JobExecutor(store, writer, () => Date.now(), new Map(), deps);
  try {
    await executor.execute(claimed);
  } finally {
    clearInterval(statusPoll);
    await workspace.stop();
  }
  setPhase("finished");

  const finalJob = store.getJob(jobId);
  const trace = readStatusTrace(db, jobId);
  const durableRow = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId);
  const workDirGone = !(await pathExists(join(config.tempDirectory, "jobs", jobId)));
  spawnContext.statusNow = () => "<no-job>";
  ctx.transportState.statusNow = () => "<no-job>";
  db.close();
  await rm(dbDir, { recursive: true, force: true });
  return {
    jobId,
    finalJob,
    trace,
    durableRow,
    workDirGone,
    observed,
    puts,
    writer,
    sinkDir,
    depsKeys: Object.keys(deps),
    spawns: spawnObserver.records().slice(spawnMark),
    http: transport.ledger().slice(transportMark),
    workspace: workspace.summary(),
  };
}

const isMediaTool = (s) => s.tool === "ffmpeg" || s.tool === "ffprobe";

// ── 4. A positive case ─────────────────────────────────────────────────────

async function runPositiveCase(ctx, caseName) {
  const { checks, service, runTool, toolchain, prepared } = ctx;
  const C = (name) => `${caseName}/${name}`;
  const family = FAMILY[caseName];
  const fixture = prepared.renditions[family.rendition];
  const pageUrl = hls11PageUrl(ctx.port, caseName);
  const privateNeedles = [hls11Marker(caseName), "HLS11_RAW_", "media.m3u8", "init.mp4", ".m4s", "seg-"];

  // ── browser-safe analysis ────────────────────────────────────────────────
  ctx.currentCase = caseName;
  service.setPhase(`${caseName}:analysis-public`);
  ctx.spawnContext.phase = `${caseName}:analysis-public`;
  const meta = await ctx.policy.analyze(pageUrl);
  const publicJson = JSON.stringify(meta);
  const presetIds = meta.presets.map((p) => p.id);
  const preset = meta.presets.find((p) => p.id === REQUESTED_PRESET) ?? null;
  const sq = meta.sourceQuality ?? null;
  checks.record(
    C("analysis/advertises-preset-1080-and-best"),
    preset !== null && presetIds.includes("preset:best"),
    presetIds.join(","),
  );
  checks.record(
    C("analysis/hls-preset-facts"),
    preset !== null && preset.container === "mp4" && preset.hasVideo === true && preset.hasAudio === true &&
      preset.fileSize === null && preset.videoCodec === null && preset.audioCodec === null && preset.fps === null &&
      preset.formatId === preset.id && preset.resolution === "1080p",
  );
  checks.record(
    C("analysis/source-quality-1080-deliverable-nothing-withheld"),
    sq !== null && sq.observedMaxHeight === 1080 && sq.deliverableMaxHeight === 1080 &&
      !(sq.withheld ?? []).some((w) => w.reason === "unsupported_protocol"),
    JSON.stringify(sq),
  );
  checks.record(
    C("analysis/public-metadata-omits-private-material"),
    meta.formats.length === 0 && privateNeedles.every((needle) => !publicJson.includes(needle)),
  );
  const publicRequests = service.requests(`${caseName}:analysis-public`);
  checks.record(
    C("analysis/ytdlp-read-only-page-and-master"),
    publicRequests.length >= 2 &&
      publicRequests.every((r) => (r.kind === "page" || r.kind === "master") && r.userAgentClass !== "product"),
    publicRequests.map((r) => r.kind).join(","),
  );

  // ── the durable job ──────────────────────────────────────────────────────
  const job = await runJob(ctx, caseName);
  const facts = job.observed.facts ?? {};
  checks.record(C("executor/only-the-fresh-analysis-seam-injected"), sameList(job.depsKeys, ["analyzeForExecution"]));
  checks.record(
    C("execution/hls-map-owns-1080"),
    job.observed.executionAnalyses === 1 && facts.hlsOwns1080 === true && facts.progressiveOwns1080 === false,
    (facts.hlsOwnedPresetIds ?? []).join(","),
  );
  checks.record(
    C("plan/clear-hls-remux-to-mp4"),
    facts.plan?.operation === "clear-hls-remux" && facts.plan?.targetContainer === "mp4" &&
      facts.plan?.requestedFormatId === REQUESTED_PRESET &&
      sameList(facts.plan?.genericKeys ?? [], ["operation", "requestedFormatId", "source", "strategy", "targetContainer"]),
    String(facts.plan?.operation ?? facts.planError),
  );

  // ── acquisition ──────────────────────────────────────────────────────────
  const http = job.http;
  const expectedKinds = [
    "media",
    ...(fixture.init ? ["init"] : []),
    ...fixture.segments.map(() => "fragment"),
  ];
  const expectedOrdinals = fixture.segments.map((s) => s.ordinal);
  checks.record(
    C("acquisition/playlist-then-map-then-fragments-in-order"),
    sameList(http.map((e) => e.kind), expectedKinds) &&
      sameList(http.filter((e) => e.kind === "fragment").map((e) => e.ordinal), expectedOrdinals) &&
      http.every((e) => e.variant === caseName && e.responseStatus === 200),
    http.map((e) => `${e.kind}${e.ordinal ?? ""}`).join(","),
  );
  const fixtureAcq = service.requests(`${caseName}:acquisition`).filter((r) => r.userAgentClass === "product");
  checks.record(
    C("acquisition/each-resource-requested-exactly-once"),
    fixtureAcq.length === expectedKinds.length && fixtureAcq.every((r) => r.method === "GET" && r.status === 200),
    `${fixtureAcq.length} vs ${expectedKinds.length}`,
  );
  checks.record(
    C("acquisition/one-request-at-a-time"),
    http.every((e, i) => e.endSeq !== null && (i === 0 || e.seq > http[i - 1].endSeq)),
  );
  checks.record(
    C("acquisition/fixed-product-request-profile"),
    http.length > 0 &&
      http.every((e) => e.headerNamesExact && e.userAgentIsProduct && e.acceptIsProduct && e.forbiddenHeadersPresent.length === 0) &&
      fixtureAcq.every((r) => !r.hasCookie && !r.hasAuthorization && !r.hasReferer && !r.hasRange),
  );
  const agg = ctx.aggregates.get(caseName) ?? null;
  checks.record(
    C("acquisition/aggregate-is-the-exact-concatenation"),
    agg !== null && agg.sha256 === fixture.aggregateSha256 && agg.bytes === fixture.aggregateBytes,
    `${agg?.bytes} vs ${fixture.aggregateBytes}`,
  );
  checks.record(
    C("acquisition/aggregate-has-the-family-name"),
    agg !== null && agg.name === family.aggregate,
    String(agg?.name),
  );

  // ── processing ───────────────────────────────────────────────────────────
  const media = job.spawns.filter((s) => isMediaTool(s) && s.role === "media");
  const signature = media.map((s) => `${s.tool}:${s.input}`);
  checks.record(
    C("processing/source-probe-used-the-family-demuxer"),
    media[0]?.tool === "ffprobe" && media[0]?.input === family.aggregate && media[0]?.demuxer === family.demuxer,
    signature.join(" "),
  );
  const ffmpegRuns = media.filter((s) => s.tool === "ffmpeg");
  checks.record(
    C("processing/one-ffmpeg-stream-copy-no-overwrite"),
    ffmpegRuns.length === 1 && ffmpegRuns[0].streamCopy === true && ffmpegRuns[0].refusesOverwrite === true &&
      ffmpegRuns[0].demuxer === family.demuxer && ffmpegRuns[0].input === family.aggregate &&
      ctx.remuxArgvMatches.get(caseName) === true,
    signature.join(" "),
  );
  checks.record(
    C("processing/output-probes-ran"),
    sameList(signature, [
      `ffprobe:${family.aggregate}`,
      `ffmpeg:${family.aggregate}`,
      `ffprobe:${HLS_OUTPUT_PARTIAL_FILE_NAME}`,
      `ffprobe:${HLS_OUTPUT_FILE_NAME}`,
    ]),
    signature.join(" "),
  );

  // ── lifecycle ────────────────────────────────────────────────────────────
  checks.record(C("lifecycle/durable-trace"), sameList(job.trace, EXPECTED_TRACE), job.trace.join(" -> "));
  checks.record(
    C("lifecycle/every-hls-request-while-downloading"),
    http.length === expectedKinds.length && http.every((e) => e.statusAtRequest === "downloading"),
    [...new Set(http.map((e) => e.statusAtRequest))].join(","),
  );
  checks.record(
    C("lifecycle/no-media-tool-while-downloading"),
    job.spawns.filter((s) => isMediaTool(s) && s.status === "downloading").length === 0,
  );
  checks.record(
    C("lifecycle/media-tools-only-while-processing"),
    media.length === 4 && media.every((s) => s.status === "processing"),
    media.map((s) => s.status).join(","),
  );
  checks.record(
    C("lifecycle/no-ytdlp-after-execution-analysis"),
    job.spawns.filter((s) => s.tool === "yt-dlp" && POST_ANALYSIS.has(s.status)).length === 0,
  );
  checks.record(
    C("lifecycle/upload-while-uploading"),
    job.puts.length === 1 && job.puts[0].status === "uploading",
    job.puts.map((p) => p.status).join(","),
  );

  // ── workspace ────────────────────────────────────────────────────────────
  const acqPeak = job.workspace.acquisition?.peakBytes ?? Number.POSITIVE_INFINITY;
  const procPeak = job.workspace.processing?.peakBytes ?? Number.POSITIVE_INFINITY;
  const outputBytes = job.puts[0]?.preUploadBytes ?? 0;
  checks.record(
    C("workspace/acquisition-peak-is-the-aggregate-alone"),
    acqPeak <= fixture.aggregateBytes &&
      (job.workspace.acquisition?.classes ?? []).every((c) => c === "aggregate-partial" || c === "aggregate"),
    `${acqPeak} <= ${fixture.aggregateBytes}`,
  );
  checks.record(
    C("workspace/processing-peak-within-inputs-plus-output"),
    procPeak <= fixture.aggregateBytes + outputBytes && procPeak <= 2 * config.maxFileSize,
    `${procPeak} <= ${fixture.aggregateBytes + outputBytes}`,
  );

  // ── the delivered media ──────────────────────────────────────────────────
  const object = job.writer.soleObject();
  const out = object ? await probeMedia(runTool, toolchain.ffprobePath, object.path, "mov") : { readable: false, streams: [] };
  const outBoxes = object ? topLevelBoxTypes(await readFile(object.path)) : [];
  const outVideo = out.streams.find((s) => s.type === "video");
  checks.record(
    C("output/container-is-a-faststart-mp4"),
    out.readable && out.formatName === ISO_BMFF_FORMAT_NAME && outBoxes[0] === "ftyp" &&
      outBoxes.indexOf("moov") > 0 && outBoxes.indexOf("moov") < outBoxes.indexOf("mdat") && !outBoxes.includes("moof"),
    outBoxes.join(","),
  );
  checks.record(C("output/exactly-one-h264-video"), out.streams.filter((s) => s.type === "video" && s.codec === "h264").length === 1);
  checks.record(C("output/exactly-one-aac-audio"), out.streams.filter((s) => s.type === "audio" && s.codec === "aac").length === 1);
  checks.record(C("output/exactly-two-streams"), out.streams.length === 2, String(out.streams.length));
  checks.record(C("output/resolution-is-1920x1080"), outVideo?.width === 1920 && outVideo?.height === 1080, `${outVideo?.width}x${outVideo?.height}`);
  checks.record(
    C("output/duration-matches-the-fixture"),
    out.duration !== null && out.duration > 0 &&
      Math.abs(out.duration - HLS11_FIXTURE_SPEC.durationSeconds) <= DURATION_TOLERANCE_SECONDS,
    `${out.duration}s`,
  );
  checks.record(
    C("output/size-positive-and-within-the-limit"),
    object !== null && object.observedBytes > 0 && object.observedBytes <= config.maxFileSize,
    String(object?.observedBytes),
  );
  const inV = await packetDigest(runTool, toolchain.ffprobePath, fixture.aggregatePath, family.demuxer, "v:0");
  const inA = await packetDigest(runTool, toolchain.ffprobePath, fixture.aggregatePath, family.demuxer, "a:0");
  const outV = object ? await packetDigest(runTool, toolchain.ffprobePath, object.path, "mov", "v:0") : { digest: null, count: 0 };
  const outA = object ? await packetDigest(runTool, toolchain.ffprobePath, object.path, "mov", "a:0") : { digest: null, count: 0 };
  // fMP4 -> MP4 is a container copy between two ISO-BMFF framings, so every
  // packet payload must be byte-identical. MPEG-TS carries H.264 as Annex B and
  // AAC as ADTS, which a stream copy into MP4 legitimately reframes, so the TS
  // control claims preserved packet COUNTS only (as HLS-08 does).
  const preserved = family.demuxer === "mov"
    ? inV.digest !== null && inV.digest === outV.digest && inA.digest !== null && inA.digest === outA.digest
    : inV.count > 0 && inV.count === outV.count && inA.count > 0 && inA.count === outA.count;
  checks.record(
    C("output/stream-copy-packets-preserved"),
    preserved,
    `video ${inV.count}->${outV.count}, audio ${inA.count}->${outA.count}`,
  );

  // ── upload and ready ─────────────────────────────────────────────────────
  const put = job.puts[0] ?? null;
  checks.record(
    C("upload/exactly-one-put-of-the-produced-mp4"),
    job.writer.putCount() === 1 && put !== null && object !== null &&
      put.streamBasename === HLS_OUTPUT_FILE_NAME && object.sha256 === put.preUploadSha256 &&
      object.observedBytes === put.preUploadBytes && object.contentType === "video/mp4" &&
      object.sha256 !== fixture.aggregateSha256 && job.writer.deleteLog().length === 0,
  );
  const view = job.finalJob;
  checks.record(
    C("ready/final-status-ready-with-matching-metadata"),
    view?.status === "ready" && view.container === "mp4" && view.mime === mimeForContainer("mp4") &&
      view.extractor === "yt-dlp" && object !== null && view.fileSize === object.observedBytes &&
      typeof view.objectKey === "string" && view.objectKey.startsWith(`videofetch/jobs/${job.jobId}/`) &&
      job.durableRow.format_id === REQUESTED_PRESET && String(view.filename ?? "").endsWith(".mp4"),
    `${view?.status} ${view?.errorCode ?? ""}`,
  );
  const surfaces = [
    publicJson,
    JSON.stringify(Object.fromEntries(Object.entries(job.durableRow).filter(([, v]) => typeof v === "string"))),
    String(view?.filename ?? ""),
    String(view?.objectKey ?? ""),
    String(object?.contentDisposition ?? ""),
  ];
  checks.record(
    C("privacy/no-private-material-on-any-public-surface"),
    surfaces.every((text) => privateNeedles.every((needle) => !text.includes(needle))),
  );
  checks.record(C("cleanup/job-workdir-removed"), job.workDirGone);
  await rm(job.sinkDir, { recursive: true, force: true });

  const lifecycleMatrix = {
    playlistHttp: [...new Set(http.filter((e) => e.kind === "media").map((e) => e.statusAtRequest))],
    initHttp: [...new Set(http.filter((e) => e.kind === "init").map((e) => e.statusAtRequest))],
    fragmentHttp: [...new Set(http.filter((e) => e.kind === "fragment").map((e) => e.statusAtRequest))],
    ffprobeInput: media.filter((s) => s.tool === "ffprobe" && s.input === family.aggregate).map((s) => s.status),
    ffmpeg: ffmpegRuns.map((s) => s.status),
    ffprobeOutput: media.filter((s) => s.tool === "ffprobe" && s.input !== family.aggregate).map((s) => s.status),
    upload: job.puts.map((p) => p.status),
  };
  return {
    segmentFamily: fixture.segmentType,
    requestedPreset: REQUESTED_PRESET,
    analysis: {
      presetIds,
      preset1080: preset ? { resolution: preset.resolution, container: preset.container, hasVideo: preset.hasVideo, hasAudio: preset.hasAudio } : null,
      sourceQuality: sq ? { observedMaxHeight: sq.observedMaxHeight, deliverableMaxHeight: sq.deliverableMaxHeight, withheldReasons: (sq.withheld ?? []).map((w) => w.reason) } : null,
    },
    plan: facts.plan ?? null,
    acquisition: {
      requests: http.map((e) => ({ kind: e.kind, ordinal: e.ordinal, statusAtRequest: e.statusAtRequest, responseStatus: e.responseStatus })),
      aggregate: agg ? { name: agg.name, bytes: agg.bytes, sha256: agg.sha256, statusAtObservation: agg.status } : null,
      expectedAggregateSha256: fixture.aggregateSha256,
    },
    processing: {
      spawns: job.spawns.map((s) => ({ tool: s.tool, role: s.role, statusAtSpawn: s.status, demuxer: s.demuxer, input: s.input, streamCopy: s.streamCopy, refusesOverwrite: s.refusesOverwrite })),
    },
    lifecycle: { durableTrace: job.trace, matrix: lifecycleMatrix },
    workspace: {
      maxFileSizeBytes: config.maxFileSize,
      acquisitionPeakBytes: job.workspace.acquisition?.peakBytes ?? null,
      acquisitionEntryClasses: job.workspace.acquisition?.classes ?? [],
      processingPeakBytes: job.workspace.processing?.peakBytes ?? null,
      processingEntryClasses: job.workspace.processing?.classes ?? [],
      aggregateBytes: fixture.aggregateBytes,
      outputBytes,
    },
    output: {
      formatName: out.formatName ?? null,
      topLevelBoxes: outBoxes,
      durationSeconds: out.duration ?? null,
      streams: out.streams,
      bytes: object?.observedBytes ?? null,
      packets: { videoIn: inV.count, videoOut: outV.count, audioIn: inA.count, audioOut: outA.count },
      packetPayloadsIdentical: inV.digest !== null && inV.digest === outV.digest && inA.digest !== null && inA.digest === outA.digest,
    },
    ready: view ? { status: view.status, container: view.container, mime: view.mime, fileSize: view.fileSize } : null,
  };
}

// ── 5. The bounded negatives ───────────────────────────────────────────────

async function runNegative(ctx, caseName, { expectedCode, before = null, after = null }) {
  const { checks } = ctx;
  const C = (name) => `${caseName}/${name}`;
  ctx.currentCase = caseName;
  if (before) before();
  let job;
  try {
    job = await runJob(ctx, caseName);
  } finally {
    if (after) after();
  }
  const media = job.spawns.filter(isMediaTool);
  checks.record(
    C(expectedCode.toLowerCase().replaceAll("_", "-")),
    job.finalJob?.status === "failed" && job.finalJob?.errorCode === expectedCode,
    `${job.finalJob?.status}/${job.finalJob?.errorCode}`,
  );
  checks.record(C("no-upload-never-ready"), job.writer.putCount() === 0 && !job.trace.includes("ready") && !job.trace.includes("uploading"));
  checks.record(C("workdir-removed"), job.workDirGone);
  await rm(job.sinkDir, { recursive: true, force: true });
  return { job, media };
}

async function runNegatives(ctx) {
  const { checks, prepared } = ctx;
  const fmp4 = prepared.renditions.fmp4;
  const summary = (job, extra = {}) => ({
    finalStatus: job.finalJob?.status ?? null,
    errorCode: job.finalJob?.errorCode ?? null,
    durableTrace: job.trace,
    requests: job.http.map((e) => ({ kind: e.kind, ordinal: e.ordinal, statusAtRequest: e.statusAtRequest, responseStatus: e.responseStatus })),
    mediaToolSpawns: job.spawns.filter(isMediaTool).map((s) => ({ tool: s.tool, statusAtSpawn: s.status, demuxer: s.demuxer })),
    uploads: job.writer.putCount(),
    jobWorkdirRemoved: job.workDirGone,
    ...extra,
  });
  const neverProcessed = (name, run) =>
    checks.record(
      `${name}/never-processing-no-media-tool`,
      sameList(run.job.trace, FAILED_IN_DOWNLOADING) && run.media.length === 0,
      run.job.trace.join(" -> "),
    );

  // A byte-range initialization map: refused by the v2 grammar at preflight.
  const byteRange = await runNegative(ctx, "neg-byterange", { expectedCode: "FORMAT_UNAVAILABLE" });
  checks.record(
    "neg-byterange/only-the-playlist-requested",
    sameList(byteRange.job.http.map((e) => e.kind), ["media"]),
    byteRange.job.http.map((e) => e.kind).join(","),
  );
  neverProcessed("neg-byterange", byteRange);

  // An encrypted fMP4 playlist: refused; no key, map or fragment is requested.
  const encrypted = await runNegative(ctx, "neg-encrypted", { expectedCode: "FORMAT_UNAVAILABLE" });
  const keyRequests = ctx.service.requests().filter((r) => r.kind === "key");
  checks.record(
    "neg-encrypted/no-key-map-or-fragment-requested",
    sameList(encrypted.job.http.map((e) => e.kind), ["media"]) && keyRequests.length === 0,
  );
  neverProcessed("neg-encrypted", encrypted);

  // The map answers 404: the whole acquisition fails; no fragment is requested.
  ctx.service.fail("/hls11/neg-init-404/init.mp4", 404);
  const init404 = await runNegative(ctx, "neg-init-404", { expectedCode: "NETWORK_ERROR" });
  checks.record(
    "neg-init-404/no-fragment-requested",
    sameList(init404.job.http.map((e) => e.kind), ["media", "init"]) && init404.job.http[1]?.responseStatus === 404,
    init404.job.http.map((e) => `${e.kind}:${e.responseStatus}`).join(","),
  );
  neverProcessed("neg-init-404", init404);

  // The ONE byte budget counts the map. The allowance is the aggregate minus
  // one byte, so the fragments alone FIT it and only the map's bytes push the
  // job over: a transfer that did not count the map would succeed here. The
  // refusal lands on the last fragment, with every earlier resource requested.
  const fragmentBytes = fmp4.segments.reduce((n, segment) => n + segment.byteLength, 0);
  const budget = fmp4.aggregateBytes - 1;
  const savedMax = config.maxFileSize;
  const budgetRun = await runNegative(ctx, "neg-budget", {
    expectedCode: "TOO_LARGE",
    before: () => Object.assign(config, { maxFileSize: budget }),
    after: () => Object.assign(config, { maxFileSize: savedMax }),
  });
  const lastOrdinal = fmp4.segments.length;
  checks.record(
    "neg-budget/refused-only-because-the-map-counts",
    fragmentBytes <= budget && fmp4.aggregateBytes === budget + 1 &&
      sameList(
        budgetRun.job.http.map((e) => `${e.kind}${e.ordinal ?? ""}`),
        ["media", "init", ...fmp4.segments.map((segment) => `fragment${segment.ordinal}`)],
      ) &&
      budgetRun.job.http.at(-1)?.ordinal === lastOrdinal,
    budgetRun.job.http.map((e) => `${e.kind}${e.ordinal ?? ""}`).join(","),
  );
  checks.record("neg-budget/limit-restored", config.maxFileSize === savedMax);
  neverProcessed("neg-budget", budgetRun);

  // A master that claims audio for a video-only fMP4 rendition: acquired, then
  // refused by the REAL ffprobe stream-shape check before any FFmpeg run.
  const videoOnly = await runNegative(ctx, "neg-video-only", { expectedCode: "PROCESSING_FAILED" });
  const voMedia = videoOnly.media.filter((s) => s.role === "media");
  checks.record(
    "neg-video-only/refused-by-the-real-source-probe-before-any-ffmpeg",
    sameList(videoOnly.job.trace, ["queued", "analyzing", "downloading", "processing", "failed"]) &&
      voMedia.length === 1 && voMedia[0].tool === "ffprobe" && voMedia[0].status === "processing" &&
      voMedia[0].demuxer === "mov" && voMedia[0].input === FMP4_AGGREGATE_FILE_NAME &&
      videoOnly.media.filter((s) => s.tool === "ffmpeg").length === 0 &&
      videoOnly.job.http.every((e) => e.statusAtRequest === "downloading"),
    voMedia.map((s) => `${s.tool}@${s.status}`).join(","),
  );

  return {
    byteRangeMap: summary(byteRange.job, { expected: "FORMAT_UNAVAILABLE" }),
    encryptedPlaylist: summary(encrypted.job, { expected: "FORMAT_UNAVAILABLE", keyRequests: keyRequests.length }),
    initializationMap404: summary(init404.job, { expected: "NETWORK_ERROR" }),
    byteBudget: summary(budgetRun.job, { expected: "TOO_LARGE", allowanceBytes: budget, fragmentBytes, aggregateBytes: fmp4.aggregateBytes }),
    videoOnlyRenditionClaimingAudio: summary(videoOnly.job, { expected: "PROCESSING_FAILED" }),
  };
}

// ── 6. The split master: separate HLS audio stays unpaired ─────────────────

async function runSplitMaster(ctx) {
  const { checks, service } = ctx;
  const C = (name) => `split-master/${name}`;
  ctx.currentCase = "split-master";
  service.setPhase("split-master:analysis");
  ctx.spawnContext.phase = "split-master:analysis";
  const transportMark = ctx.transport.ledger().length;
  const documentsBefore = ctx.documents.length;
  const result = await ctx.policy.analyzeForExecution(hls11PageUrl(ctx.port, "split-master"));
  const doc = ctx.documents.slice(documentsBefore).at(-1) ?? { parsed: false };
  const videoPresetIds = result.video.presets.map((p) => p.id).filter((id) => id !== "preset:audio" && id !== "preset:mp3");
  const q = result.video.sourceQuality ?? null;
  const unsupported = (q?.withheld ?? []).find((w) => w.reason === "unsupported_protocol") ?? null;
  let planError = null;
  try {
    deriveExecutionPlan(result, REQUESTED_PRESET);
  } catch (error) {
    planError = error instanceof AppError ? error.code : "non-app-error";
  }
  checks.record(
    C("pinned-ytdlp-exposes-separate-audio-renditions"),
    doc.parsed && doc.videoRenditions === 2 && doc.audioRenditions === 2 && doc.audioRenditionsHaveNoAudioCodec,
    `${doc.videoRenditions} video / ${doc.audioRenditions} audio`,
  );
  checks.record(
    C("pinned-ytdlp-exposes-no-pairing-relationship"),
    doc.parsed && doc.relationshipKeys.length === 0 && doc.groupedAndControlVariantsShareOneKeySet === true &&
      doc.groupedAndControlVariantsBothAcodecNone === true && doc.videoRenditionsAudioCodecIsNone === true,
    (doc.relationshipKeys ?? []).join(",") || "no relationship key",
  );
  checks.record(C("no-hls-video-preset-advertised"), videoPresetIds.length === 0, videoPresetIds.join(","));
  checks.record(C("hls-selections-empty"), Object.keys(result.hlsSelections ?? {}).length === 0);
  checks.record(
    C("source-quality-withholds-unsupported-protocol-at-1080"),
    q !== null && q.observedMaxHeight === 1080 && q.deliverableMaxHeight === null &&
      unsupported !== null && unsupported.maxObservedHeight === 1080,
    JSON.stringify(q),
  );
  checks.record(C("plan-refuses-preset-1080"), planError === "FORMAT_UNAVAILABLE", String(planError));
  checks.record(
    C("no-product-media-request"),
    ctx.transport.ledger().length === transportMark &&
      service.requests("split-master:analysis").every((r) => r.kind === "page" || r.kind === "master"),
  );
  return {
    document: {
      extractorKey: doc.extractorKey ?? null,
      hlsFormats: doc.hlsFormats ?? null,
      videoRenditions: doc.videoRenditions ?? null,
      audioRenditions: doc.audioRenditions ?? null,
      relationshipKeys: doc.relationshipKeys ?? null,
      groupedAndControlVariantsShareOneKeySet: doc.groupedAndControlVariantsShareOneKeySet ?? null,
      audioSourcePreferences: doc.audioSourcePreferences ?? null,
    },
    videoPresetIds,
    hlsSelections: Object.keys(result.hlsSelections ?? {}).length,
    sourceQuality: q ? { observedMaxHeight: q.observedMaxHeight, deliverableMaxHeight: q.deliverableMaxHeight, unsupportedProtocolMaxHeight: unsupported?.maxObservedHeight ?? null } : null,
    planErrorCode: planError,
    finding: "HLS AUDIO PAIRING PROVENANCE INSUFFICIENT: the pinned runtime removes its internal audio-group id before -J, so a grouped video variant and an ungrouped video-only variant are indistinguishable",
  };
}

// ── 7. Main ────────────────────────────────────────────────────────────────

function sanitizeDetail(detail) {
  if (detail === null || detail === undefined) return null;
  const text = String(detail).slice(0, 400);
  return findHls11ForbiddenSubstring(text) === null ? text : "<withheld: named fixture material>";
}

async function main(argv) {
  const opts = parseReleaseChildArgv(argv);
  if (await pathExists(opts.evidence)) throw new Error("refusing to replace an existing evidence artifact");

  const checks = createChecks();
  const startedAt = new Date().toISOString();
  const workRoot = await mkdtemp(join(tmpdir(), "hls11-"));
  const interfaces = Object.keys(networkInterfaces()).sort();
  let verdict = "BLOCKED";
  let toolchain = null;
  let invariants = null;
  let fixtureSummary = null;
  const cases = {};
  let negatives = null;
  let splitMaster = null;
  let service = null;
  let spawnObserver = null;

  for (const entry of releaseIdentityChecks(
    {
      sourceCommit: opts.sourceCommit,
      sourceTree: opts.sourceTree,
      sourceContextClean: opts.sourceContextClean,
      candidateTag: opts.candidateTag,
      candidateImageId: opts.candidateImageId,
      runImageId: opts.runImageId,
    },
    { networkInterfaceNames: interfaces },
  )) {
    checks.record(entry.name, entry.ok, entry.detail);
  }

  try {
    const { spawn: plainSpawn } = await import("node:child_process");
    const plainRunTool = createToolRunner(plainSpawn);
    toolchain = await preflight(checks, plainRunTool);
    invariants = checkInvariants(checks);
    const prepared = await prepareFixtures(checks, plainRunTool, toolchain, workRoot);
    fixtureSummary = prepared.summary;

    const eventClock = createEventClock();
    service = createHls11FixtureService({ routes: routeTable(prepared), eventClock });
    const bound = await service.listen();
    checks.require("fixture/service-binds-loopback-only", bound.address === HLS11_FIXTURE_LOOPBACK);
    const validateUrl = createHls11PageUrlValidator({ port: bound.port, AppError });
    checks.require(
      "validator/admits-exactly-the-case-pages",
      validateUrl.admitted.length === 8 &&
        (await Promise.all(validateUrl.admitted.map(async (u) => (await validateUrl(u)).url === u))).every(Boolean),
    );
    let refused = 0;
    const alternatives = hls11NearbyPageUrlAlternatives(bound.port);
    for (const candidate of alternatives) {
      try {
        await validateUrl(candidate);
      } catch (error) {
        if (error instanceof AppError && error.code === "INVALID_URL") refused += 1;
      }
    }
    checks.record("validator/refuses-every-nearby-alternative", refused === alternatives.length, `${refused}/${alternatives.length}`);

    const documents = [];
    const ledger = {
      runner: async (runOpts) => {
        const result = await runProcess(runOpts);
        if ((runOpts.args ?? []).includes("--dump-single-json")) documents.push(analysisDocumentFacts(result.stdout));
        return result;
      },
    };
    let ffmpegProbe = null;
    const policy = createAnalysisPolicy({
      validateUrl,
      ledger,
      limits: {
        analysisTimeoutSeconds: Math.max(1, Math.floor(config.analysisTimeoutMs / 1000)),
        maxVideoDurationSeconds: config.maxVideoDuration,
        maxFileSizeBytes: config.maxFileSize,
      },
      ffmpegAvailableFn: () => (ffmpegProbe ??= ffmpegAvailable()),
    });

    // Every Worker spawn from here on is observed with its durable status.
    const spawnContext = { statusNow: () => "<no-job>", phase: "setup" };
    const ctx = {
      checks, service, prepared, toolchain, workRoot, policy, documents, spawnContext, port: bound.port,
      currentCase: "setup", aggregates: new Map(), remuxArgvMatches: new Map(),
      transportState: { statusNow: () => "<no-job>", caseNow: () => "setup" },
    };
    spawnObserver = installHlsSpawnObserver({
      context: () => ({ status: spawnContext.statusNow(), phase: spawnContext.phase }),
      beforeDelegate: (record, _command, args) => {
        const argv = args.map(String);
        const input = argv[argv.indexOf("-i") + 1];
        if (record.tool === "ffprobe" && record.role === "media" &&
            (record.input === AGGREGATE_FILE_NAME || record.input === FMP4_AGGREGATE_FILE_NAME) &&
            !ctx.aggregates.has(ctx.currentCase)) {
          // BEFORE the real spawn: the first media tool to touch the aggregate.
          const bytes = readFileSync(input);
          ctx.aggregates.set(ctx.currentCase, { name: record.input, bytes: bytes.byteLength, sha256: sha256(bytes), status: record.status });
        }
        if (record.tool === "ffmpeg" && record.role === "media" && Object.hasOwn(FAMILY, ctx.currentCase)) {
          const expected = FAMILY[ctx.currentCase].buildArgs({ sourcePath: input, outputPath: argv[argv.length - 1] });
          ctx.remuxArgvMatches.set(ctx.currentCase, sameList(argv, expected));
        }
      },
    });
    ctx.spawnObserver = spawnObserver;
    const runTool = createToolRunner(spawnObserver.originalSpawn);
    ctx.runTool = runTool;
    ctx.transport = createHlsSafeHttpTransport({
      port: bound.port,
      eventClock,
      statusNow: () => ctx.transportState.statusNow(),
      caseNow: () => ctx.transportState.caseNow(),
      realRequest: http.request.bind(http),
      hostname: HLS11_FIXTURE_HOSTNAME,
      classify: classifyHls11FixturePath,
      admittedKinds: HLS_V2_ADMITTED_KINDS,
    });

    await withHlsSafeHttpTransport({ setSafeHttpTestHooks, setPinnedRequestFactoryForTests }, ctx.transport, async () => {
      for (const caseName of HLS11_POSITIVE_CASES) cases[caseName] = await runPositiveCase(ctx, caseName);
      negatives = await runNegatives(ctx);
      splitMaster = await runSplitMaster(ctx);
    });
    checks.record("transport/no-refused-request", ctx.transport.refusals().length === 0, String(ctx.transport.refusals().length));
    checks.record(
      "fixture/no-unexpected-route",
      service.requests().every((r) => r.kind !== "unexpected" && r.kind !== "key" && r.method === "GET"),
    );
    checks.record(
      "fixture/no-range-request",
      service.requests().every((r) => r.hasRange === false),
    );

    verdict = checks.passed() ? "PASS" : "FAIL";
  } catch (error) {
    checks.record("run/completed-without-error", false, error?.message ?? String(error));
    verdict = "FAIL";
    process.stderr.write(`[hls11] ${error?.stack ?? error}\n`);
  } finally {
    setPinnedRequestFactoryForTests(null);
    setSafeHttpTestHooks(null);
    if (spawnObserver) spawnObserver.uninstall();
    if (service) await service.close();
  }

  const record = buildHls11ReleaseEvidence({
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: { commit: opts.sourceCommit, tree: opts.sourceTree, contextClean: opts.sourceContextClean },
    image: { candidateTag: opts.candidateTag, imageId: opts.candidateImageId, runSubject: opts.runImageId },
    network: { observedInterfaceNames: interfaces },
    toolchain,
    invariants,
    fixture: fixtureSummary,
    cases,
    negativeCases: negatives,
    splitMaster,
    checks: checks.all().map((check) => ({ ...check, detail: sanitizeDetail(check.detail) })),
  });
  await writeFile(opts.evidence, renderHls11ReleaseEvidence(record), { flag: "wx" });
  await rm(workRoot, { recursive: true, force: true });

  const failed = checks.failed();
  process.stdout.write(`${verdict} ${HLS11_RELEASE_EVIDENCE_SCHEMA} checks=${checks.all().length} failed=${failed.length}\n`);
  for (const f of failed) process.stdout.write(`  FAIL ${f.name}${f.detail ? ` :: ${sanitizeDetail(f.detail)}` : ""}\n`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[hls11] ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}

export { FAMILY, routeTable, hls11PagePath };
