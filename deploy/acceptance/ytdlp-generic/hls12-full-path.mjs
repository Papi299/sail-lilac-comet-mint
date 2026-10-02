#!/usr/bin/env node
//
// HLS-12: the separate-audio clear-HLS REAL-MEDIA release child
// (HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001).
//
// ── What one run proves ────────────────────────────────────────────────────
//
// That inside the ACTUAL release candidate image, offline, against
// deterministic local fixtures of REAL media, the candidate's own source runs
// the ONE new HLS family end to end — a video-only fMP4 rendition plus the
// single audio-only fMP4 rendition of the AUDIO group its variant names:
//
//   browser-safe analysis (real pinned yt-dlp, metadata only)
//   -> the Product's OWN Master Playlist proof (one safe-HTTP GET, zero
//      redirects) -> preset:1080
//   -> fresh execution analysis (the proof again, while `analyzing`)
//   -> ordinary deriveExecutionPlan() -> clear-hls-separate-audio-remux
//   -> HLS-2 real preflight of the video playlist, then the audio playlist
//   -> HLS-3 real acquisition of the video half, then the audio half, under
//      ONE byte budget -> beginProcessing()
//   -> the SHARED split merge: real ffprobe of each half, ONE real FFmpeg
//      stream copy with the earlier-starting input as the `-isync` reference,
//      real output validation -> beginUploading() -> upload -> ready
//
// for three pairs: audio presented ~0.48 s after the video, video presented
// ~0.52 s after the audio, and a control whose halves both start at exactly 0.
// The harness measures each pair's source timing with the shared packet oracle
// BEFORE the job, then holds the delivered MP4 to it: relative offset within
// the time-base tolerance, every packet payload identical, and — for the
// control — byte-identical to the historical merge.
//
// Four master negatives (analysis only) and five execution negatives (full
// jobs) fail closed through the same Product path; see `lib/hls12-evidence.mjs`.
//
// ── The only substitutions ─────────────────────────────────────────────────
//
//   submitted-page URL validator  `lib/hls12-fixture-url.mjs` (exact pages only)
//   safe-HTTP DNS answer + socket `lib/hls-safe-http-transport.mjs`
//   object-store provider         `lib/local-object-writer.mjs`
//
// ── Where it runs ──────────────────────────────────────────────────────────
//
// INSIDE the release candidate container, as the image's non-root `node`
// user, `--network none` with exactly one `--add-host`, launched by the
// SPLIT-07 driver (`releaseHls12AcceptanceRunArgs`).

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
import { buildSplitMergeArgs, ffmpegAvailable } from "../../../src/services/processing/ffmpeg.server.ts";
import { resolveFfprobePath } from "../../../src/services/processing/ffprobe.server.ts";
import { decideMergeSync } from "../../../src/services/processing/merge-sync.ts";
import { deriveExecutionPlan } from "../../../src/worker/execution/format-plan.ts";
import { GENERIC_SOURCE_PROTOCOLS } from "../../../src/worker/execution/generic-source.ts";
import { JobExecutor } from "../../../src/worker/execution/job-executor.server.ts";
import { ClearHlsPlaylistError, parseClearHlsMediaPlaylist } from "../../../src/worker/hls/hls-media-playlist.ts";
import {
  ClearHlsMasterPlaylistError,
  HLS_MASTER_ALLOWED_TAGS,
  HLS_MASTER_MAX_PLAYLIST_BYTES,
  parseClearHlsMasterPlaylist,
} from "../../../src/worker/hls/hls-master-playlist.ts";
import {
  SEPARATE_HLS_MASTER_FETCH_TIMEOUT_MS,
  SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS,
} from "../../../src/worker/hls/hls-master-pairing.server.ts";
import {
  SEPARATE_AUDIO_FMP4_FILE_NAME,
  SEPARATE_VIDEO_FMP4_FILE_NAME,
} from "../../../src/worker/hls/hls-fragment-acquisition.server.ts";
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
  HLS12_FIXTURE_SPEC,
  generateHls12Recipe,
  hls12Master,
  hls12Page,
  topLevelBoxTypes,
} from "./fixtures/hls12-media.mjs";
import { createHls12FixtureService } from "./fixtures/hls12-server.mjs";
import { historicalSplitMergeArgs } from "./fixtures/sync-media.mjs";
import {
  HLS12_CASES,
  HLS12_FIXTURE_HOSTNAME,
  HLS12_FIXTURE_LOOPBACK,
  HLS12_GROUP_PREFIX,
  HLS12_LANGUAGE_PREFIX,
  HLS12_MARKER_ROLES,
  HLS12_MASTER_NEGATIVE_CASES,
  HLS12_PRIVATE_MARKER_PREFIX,
  HLS12_RAW_NAME_PREFIX,
  HLS12_ROUTE_PREFIX,
  classifyHls12FixturePath,
  createHls12PageUrlValidator,
  hls12AltAudioPlaylistUri,
  hls12AudioPlaylistUri,
  hls12FixtureOrigin,
  hls12GroupId,
  hls12Language,
  hls12Marker,
  hls12MasterUri,
  hls12MovedMasterPath,
  hls12NearbyPageUrlAlternatives,
  hls12PageUrl,
  hls12RenditionName,
  hls12VideoPlaylistUri,
} from "./lib/hls12-fixture-url.mjs";
import {
  HLS_MASTER_PROOF_ADMITTED_KINDS,
  createEventClock,
  createHlsSafeHttpTransport,
  withHlsSafeHttpTransport,
} from "./lib/hls-safe-http-transport.mjs";
import { createHlsWorkspaceSampler, installHlsSpawnObserver } from "./lib/hls11-observers.mjs";
import {
  HLS12_PRODUCT_BASENAMES,
  classifyHls12WorkspaceEntry,
  describeHls12Spawn,
  hls12AnalysisDocumentFacts,
} from "./lib/hls12-observers.mjs";
import {
  describeMergeSync,
  evaluateMergeTiming,
  expectedMergeSync,
  firstPresented,
  mergeSyncMatches,
  mp4MovieTimescale,
  pairSourceTiming,
  probePacketTimeline,
  ratEq,
  rational,
} from "./lib/merge-timing.mjs";
import { createLocalObjectStoreWriter } from "./lib/local-object-writer.mjs";
import { installStatusAudit, readStatusTrace } from "./lib/split-observers.mjs";
import { releaseIdentityChecks } from "./lib/hls-release-evidence.mjs";
import {
  HLS12_POSITIVE_CASES,
  HLS12_RELEASE_EVIDENCE_SCHEMA,
  buildHls12ReleaseEvidence,
  findHls12ForbiddenSubstring,
  renderHls12ReleaseEvidence,
} from "./lib/hls12-evidence.mjs";
import { parseDashArgv as parseReleaseChildArgv } from "./lib/dash-argv.mjs";

// ── Bounds ─────────────────────────────────────────────────────────────────

const REQUESTED_PRESET = "preset:1080";
const ISO_BMFF_FORMAT_NAME = "mov,mp4,m4a,3gp,3g2,mj2";
const DURATION_TOLERANCE_SECONDS = 0.25;
const MERGED_OUTPUT_NAME = "merged.mp4";
const EXPECTED_TRACE = ["queued", "analyzing", "downloading", "processing", "uploading", "ready"];
const FAILED_IN_DOWNLOADING = ["queued", "analyzing", "downloading", "failed"];
const FAILED_IN_PROCESSING = ["queued", "analyzing", "downloading", "processing", "failed"];
const POST_ANALYSIS = new Set(["downloading", "processing", "uploading", "ready", "failed"]);

/**
 * What each case serves: the recipe rendition behind its `video/` and
 * `audio/` playlists, and the master shape yt-dlp receives. Fixed before the
 * service starts.
 */
const CASE_MEDIA = Object.freeze({
  "pos-audio-late": { video: ["pair-audio-late", "video"], audio: ["pair-audio-late", "audio"], master: "paired" },
  "pos-video-late": { video: ["pair-video-late", "video"], audio: ["pair-video-late", "audio"], master: "paired" },
  "ctl-aligned": { video: ["aligned-video", "main"], audio: ["aligned-audio", "main"], master: "paired" },
  "neg-ambiguous-group": { video: ["aligned-video", "main"], audio: ["aligned-audio", "main"], master: "ambiguous" },
  "neg-no-audio-group": { video: ["aligned-video", "main"], audio: ["aligned-audio", "main"], master: "no-audio-group" },
  "neg-master-redirect": { video: ["aligned-video", "main"], audio: ["aligned-audio", "main"], master: "paired" },
  "neg-master-changed": { video: ["aligned-video", "main"], audio: ["aligned-audio", "main"], master: "paired" },
  "neg-audio-ts": { video: ["aligned-video", "main"], audio: ["audio-ts", "main"], master: "paired" },
  "neg-video-muxed": { video: ["muxed-fmp4", "main"], audio: ["aligned-audio", "main"], master: "paired" },
  "neg-audio-video": { video: ["aligned-video", "main"], audio: ["aligned-video", "main"], master: "paired" },
  "neg-budget": { video: ["aligned-video", "main"], audio: ["aligned-audio", "main"], master: "paired" },
  "neg-audio-map-404": { video: ["aligned-video", "main"], audio: ["aligned-audio", "main"], master: "paired" },
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
const casePath = (caseName, reference) => `${HLS12_ROUTE_PREFIX}${caseName}/${reference}`;
const caseUrl = (port, caseName, reference) => `${hls12FixtureOrigin(port)}${casePath(caseName, reference)}`;
const masterUrlFor = (port, caseName) => caseUrl(port, caseName, hls12MasterUri(caseName));

/**
 * The PRIVATE fixture material no public, durable or process-output surface may
 * carry: every signed query, every master/media reference spelling, and the
 * descriptive group slots. The fixture hostname and route prefix are absent on
 * purpose: they are part of the user-submitted page URL, which the durable job
 * legitimately stores.
 */
const PRIVATE_NEEDLES = Object.freeze([
  HLS12_PRIVATE_MARKER_PREFIX,
  HLS12_RAW_NAME_PREFIX,
  HLS12_GROUP_PREFIX,
  HLS12_LANGUAGE_PREFIX,
  "master.m3u8",
  "media.m3u8",
  "alt.m3u8",
  "init.mp4",
  "init_",
  ".m4s",
  "seg-",
]);

/** Every private sentinel one case's fixture carries, by its exact spelling too. */
function caseNeedles(caseName) {
  return [
    ...HLS12_MARKER_ROLES.map((role) => hls12Marker(caseName, role)),
    hls12GroupId(caseName),
    hls12RenditionName(caseName),
    hls12Language(caseName),
    ...PRIVATE_NEEDLES,
  ];
}

function createToolRunner(spawnFn) {
  return (command, args, { timeoutMs = 60_000 } = {}) =>
    new Promise((resolvePromise, reject) => {
      const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 64 * 1024 * 1024) stdout += String(chunk);
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

const isVideoOnly1080 = (probe) =>
  probe.readable && probe.formatName === ISO_BMFF_FORMAT_NAME && probe.streams.length === 1 &&
  probe.streams[0].type === "video" && probe.streams[0].codec === "h264" &&
  probe.streams[0].width === HLS12_FIXTURE_SPEC.width && probe.streams[0].height === HLS12_FIXTURE_SPEC.height;
const isAudioOnlyAac = (probe, formatName = ISO_BMFF_FORMAT_NAME) =>
  probe.readable && probe.formatName === formatName && probe.streams.length === 1 &&
  probe.streams[0].type === "audio" && probe.streams[0].codec === "aac";

/** The Product's own media-playlist parser, as a value. */
function parsedMedia(text) {
  try {
    return parseClearHlsMediaPlaylist(text);
  } catch (error) {
    return error instanceof ClearHlsPlaylistError ? { refused: error.reason } : { refused: "non-playlist-error" };
  }
}

/** The Product's own master parser, as a value. */
function parsedMaster(text) {
  try {
    return parseClearHlsMasterPlaylist(text);
  } catch (error) {
    return error instanceof ClearHlsMasterPlaylistError ? { refused: error.reason } : { refused: "non-master-error" };
  }
}

const TAP_ARMED_LINE = "[hls12] process-output tap armed";

/** A tap on this process's stdout/stderr: everything any module printed during the cases. */
function tapProcessOutput() {
  const chunks = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const wrap = (original) =>
    function tapped(chunk, ...rest) {
      try {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      } catch {
        // An unreadable chunk is still written; it is just not scanned.
      }
      return original.call(this, chunk, ...rest);
    };
  process.stdout.write = wrap(out);
  process.stderr.write = wrap(err);
  return {
    text: () => chunks.join(""),
    restore() {
      process.stdout.write = out;
      process.stderr.write = err;
    },
  };
}

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
  checks.record(
    "invariants/master-grammar-is-the-closed-five-tag-vocabulary",
    sameList([...HLS_MASTER_ALLOWED_TAGS], [
      "#EXTM3U", "#EXT-X-VERSION", "#EXT-X-INDEPENDENT-SEGMENTS", "#EXT-X-MEDIA", "#EXT-X-STREAM-INF",
    ]),
    [...HLS_MASTER_ALLOWED_TAGS].join(","),
  );
  checks.record(
    "invariants/master-proof-bounds",
    SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS === 4 && HLS_MASTER_MAX_PLAYLIST_BYTES === 256 * 1024 &&
      SEPARATE_HLS_MASTER_FETCH_TIMEOUT_MS === 10_000,
    `${SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS} masters, ${HLS_MASTER_MAX_PLAYLIST_BYTES} B, ${SEPARATE_HLS_MASTER_FETCH_TIMEOUT_MS} ms`,
  );
  checks.require(
    "invariants/harness-file-names-match-the-product",
    SEPARATE_VIDEO_FMP4_FILE_NAME === "hls-video.fmp4" && SEPARATE_AUDIO_FMP4_FILE_NAME === "hls-audio.fmp4" &&
      HLS12_PRODUCT_BASENAMES.includes(SEPARATE_VIDEO_FMP4_FILE_NAME) &&
      HLS12_PRODUCT_BASENAMES.includes(SEPARATE_AUDIO_FMP4_FILE_NAME) && HLS12_PRODUCT_BASENAMES.includes(MERGED_OUTPUT_NAME),
  );
  // The shared merge's MP4 synchronization tokens, read from the Product's own
  // argv builder for each closed decision, and the decision on a tie.
  const argv = (reference) =>
    buildSplitMergeArgs({ target: "mp4", videoPath: "/w/v", audioPath: "/w/a", outputPath: "/w/o", sync: { target: "mp4", reference } });
  const tie = decideMergeSync({ target: "mp4", videoStartUs: 0, audioStartUs: 0 });
  const audioFirst = decideMergeSync({ target: "mp4", videoStartUs: 500_000, audioStartUs: 0 });
  checks.require(
    "invariants/merge-argv-carries-the-shared-sync-policy",
    mergeSyncMatches(describeMergeSync(argv("video")), { input0: [], input1: ["-isync", "0"] }) &&
      mergeSyncMatches(describeMergeSync(argv("audio")), { input0: ["-isync", "1"], input1: [] }) &&
      tie.reference === "video" && audioFirst.reference === "audio",
  );
  return {
    genericSourceProtocols: generic,
    masterAllowedTags: [...HLS_MASTER_ALLOWED_TAGS],
    masterProofBounds: {
      mastersPerAnalysis: SEPARATE_HLS_MAX_MASTERS_PER_ANALYSIS,
      masterBytes: HLS_MASTER_MAX_PLAYLIST_BYTES,
      fetchTimeoutMs: SEPARATE_HLS_MASTER_FETCH_TIMEOUT_MS,
    },
  };
}

// ── 2. Fixtures and the source timing, before any job ──────────────────────

async function prepareFixtures(checks, runTool, toolchain, workRoot) {
  const recipes = {};
  for (const recipeName of ["pair-audio-late", "pair-video-late", "aligned-video", "aligned-audio", "muxed-fmp4", "audio-ts"]) {
    const dir = join(workRoot, "fixture", recipeName);
    await mkdir(dir, { recursive: true });
    recipes[recipeName] = await generateHls12Recipe({ ffmpegPath: toolchain.ffmpegPath, runTool, recipeName, dir });
    for (const [role, rendition] of Object.entries(recipes[recipeName])) {
      rendition.aggregatePath = join(workRoot, "fixture", `${recipeName}.${role}.aggregate`);
      await writeFile(rendition.aggregatePath, rendition.aggregate);
    }
  }
  const rendition = ([recipeName, role]) => recipes[recipeName][role];
  const probe = (r, demuxer = "mov") => probeMedia(runTool, toolchain.ffprobePath, r.aggregatePath, demuxer);

  const videoHalves = [rendition(["pair-audio-late", "video"]), rendition(["pair-video-late", "video"]), rendition(["aligned-video", "main"])];
  const audioHalves = [rendition(["pair-audio-late", "audio"]), rendition(["pair-video-late", "audio"]), rendition(["aligned-audio", "main"])];
  const videoProbes = await Promise.all(videoHalves.map((r) => probe(r)));
  const audioProbes = await Promise.all(audioHalves.map((r) => probe(r)));
  checks.require(
    "fixture/video-halves-are-1920x1080-h264-video-only-iso-bmff",
    videoProbes.every(isVideoOnly1080),
    JSON.stringify(videoProbes.map((p) => p.streams)),
  );
  checks.require(
    "fixture/audio-halves-are-aac-audio-only-iso-bmff",
    audioProbes.every((p) => isAudioOnlyAac(p)),
    JSON.stringify(audioProbes.map((p) => p.streams)),
  );
  const muxed = rendition(["muxed-fmp4", "main"]);
  const audioTs = rendition(["audio-ts", "main"]);
  const muxedProbe = await probe(muxed);
  const audioTsProbe = await probe(audioTs, "mpegts");
  checks.require(
    "fixture/negative-renditions-have-their-stated-shapes",
    muxedProbe.readable && muxedProbe.streams.length === 2 &&
      muxedProbe.streams.some((s) => s.type === "video" && s.codec === "h264") &&
      muxedProbe.streams.some((s) => s.type === "audio" && s.codec === "aac") &&
      isAudioOnlyAac(audioTsProbe, "mpegts") && audioTs.segmentType === "mpegts",
    `${JSON.stringify(muxedProbe.streams)} / ${JSON.stringify(audioTsProbe.streams)}`,
  );
  const fmp4Renditions = [...videoHalves, ...audioHalves, muxed];
  checks.require(
    "fixture/inits-are-ftyp-moov-and-fragments-are-moof-mdat",
    fmp4Renditions.every((r) =>
      r.init !== null && sameList(topLevelBoxTypes(r.init.bytes), ["ftyp", "moov"]) && r.segments.length >= 3 &&
      r.segments.every((s) => {
        const boxes = topLevelBoxTypes(s.bytes);
        return boxes.includes("moof") && boxes.includes("mdat") && !boxes.includes("moov");
      }),
    ),
  );

  // Determinism, measured: one pair recipe again, both halves byte-identical.
  const againDir = join(workRoot, "fixture", "pair-audio-late-again");
  await mkdir(againDir, { recursive: true });
  const again = await generateHls12Recipe({ ffmpegPath: toolchain.ffmpegPath, runTool, recipeName: "pair-audio-late", dir: againDir });
  checks.require(
    "fixture/recipes-are-bit-exact",
    again.video.aggregateSha256 === recipes["pair-audio-late"].video.aggregateSha256 &&
      again.audio.aggregateSha256 === recipes["pair-audio-late"].audio.aggregateSha256,
  );

  // The Product's own media parser decides each served playlist's family.
  const mediaOk = fmp4Renditions.every((r) => {
    const model = parsedMedia(r.playlistText);
    return model.segmentType === "fmp4" && model.initializationMap?.reference === r.init.name &&
      model.fragmentCount === r.segments.length;
  });
  const tsModel = parsedMedia(audioTs.playlistText);
  checks.record(
    "fixture/media-playlists-are-the-v2-grammar",
    mediaOk && tsModel.segmentType === "mpegts" && tsModel.fragmentCount === audioTs.segments.length,
    String(tsModel.refused ?? tsModel.segmentType),
  );

  // The Product's own master parser on every master the fixture serves.
  const audioRef = (caseName) => hls12AudioPlaylistUri(caseName);
  const masterModels = HLS12_CASES.map((caseName) => {
    const shape = CASE_MEDIA[caseName].master;
    const model = parsedMaster(hls12Master(caseName, shape));
    if (model.refused) return false;
    const variant = model.variants.length === 1 ? model.variants[0] : null;
    if (variant === null || variant.reference !== hls12VideoPlaylistUri(caseName)) return false;
    if (variant.resolution?.width !== HLS12_FIXTURE_SPEC.width || variant.resolution?.height !== HLS12_FIXTURE_SPEC.height) {
      return false;
    }
    if (shape === "paired") {
      return variant.audioGroup === 0 && model.audioGroups.length === 1 &&
        sameList(model.audioGroups[0].map((m) => m.reference), [audioRef(caseName)]);
    }
    if (shape === "ambiguous") {
      return variant.audioGroup === 0 && model.audioGroups.length === 1 &&
        sameList(model.audioGroups[0].map((m) => m.reference), [audioRef(caseName), hls12AltAudioPlaylistUri(caseName)]);
    }
    // no-audio-group: the variant names none; one unreferenced group sits beside it.
    return variant.audioGroup === null && model.audioGroups.length === 1 &&
      sameList(model.audioGroups[0].map((m) => m.reference), [audioRef(caseName)]);
  });
  const resigned = parsedMaster(hls12Master("neg-master-changed", "resigned"));
  const moved = parsedMaster(hls12Master("neg-master-redirect", "paired", { referenceBase: casePath("neg-master-redirect", "") }));
  checks.record(
    "fixture/masters-are-the-closed-master-grammar",
    masterModels.every(Boolean) &&
      resigned.variants?.[0]?.reference === hls12VideoPlaylistUri("neg-master-changed", "RESIGNED") &&
      moved.variants?.length === 1 && moved.audioGroups?.[0]?.length === 1,
    masterModels.map((ok, i) => (ok ? null : HLS12_CASES[i])).filter(Boolean).join(",") || "all admitted",
  );

  const cases = Object.fromEntries(
    HLS12_CASES.map((caseName) => [caseName, { video: rendition(CASE_MEDIA[caseName].video), audio: rendition(CASE_MEDIA[caseName].audio) }]),
  );
  const facts = (r) => ({
    segmentType: r.segmentType,
    segments: r.segments.length,
    initBytes: r.init?.byteLength ?? null,
    aggregateBytes: r.aggregateBytes,
    aggregateSha256: r.aggregateSha256,
  });
  return {
    recipes,
    cases,
    summary: {
      recipe:
        "FFmpeg lavfi testsrc2 + sine -> libx264 (1 thread, bit-exact) + AAC-LC -> FFmpeg hls muxer (fMP4, " +
        "independent segments); offset pairs from ONE packager run with -itsoffset on the audio input; the control " +
        "from two separate packager runs; masters hand-authored inside the candidate's closed master grammar",
      spec: { ...HLS12_FIXTURE_SPEC },
      renditions: Object.fromEntries(
        Object.entries(recipes).flatMap(([recipeName, roles]) => Object.entries(roles).map(([role, r]) => [`${recipeName}.${role}`, facts(r)])),
      ),
      deterministic: again.video.aggregateSha256 === recipes["pair-audio-late"].video.aggregateSha256,
    },
  };
}

/**
 * The source timing of every positive pair, measured BEFORE any job by the
 * shared packet oracle, and the expected merge synchronization derived from it
 * by the harness alone. The historical merge (no cross-input synchronization)
 * runs twice here, harness-side: on the audio-late pair, where the oracle must
 * detect its per-input zeroing, and on the control, whose bytes the Product's
 * merge must reproduce exactly.
 */
async function measureTiming(checks, runTool, toolchain, prepared, workRoot) {
  const out = {};
  const timelines = {};
  for (const caseName of HLS12_POSITIVE_CASES) {
    const { video, audio } = prepared.cases[caseName];
    const v = await probePacketTimeline(runTool, toolchain.ffprobePath, "mov", video.aggregatePath);
    const a = await probePacketTimeline(runTool, toolchain.ffprobePath, "mov", audio.aggregatePath);
    timelines[caseName] = { video: v, audio: a };
    const source = pairSourceTiming(v, a);
    const expected = expectedMergeSync({ target: "mp4", videoInput: v, audioInput: a });
    out[caseName] = {
      source,
      expected,
      expectedReference: expected.input0.length > 0 ? "audio" : "video",
    };
  }
  const late = out["pos-audio-late"].source;
  const early = out["pos-video-late"].source;
  const control = out["ctl-aligned"].source;
  checks.require(
    "timing/audio-late-pair-is-discriminating",
    late.measurable && late.discriminating && late.relativeUs > 0 && out["pos-audio-late"].expectedReference === "video",
    `audio-video ${late.relativeUs}us`,
  );
  checks.require(
    "timing/video-late-pair-is-discriminating",
    early.measurable && early.discriminating && early.relativeUs < 0 && out["pos-video-late"].expectedReference === "audio",
    `audio-video ${early.relativeUs}us`,
  );
  const zero = rational(0n);
  checks.require(
    "timing/control-pair-is-exactly-zero-aligned",
    control.measurable && ratEq(firstPresented(timelines["ctl-aligned"].video.video), zero) &&
      ratEq(firstPresented(timelines["ctl-aligned"].audio.audio), zero) && out["ctl-aligned"].expectedReference === "video",
    `audio-video ${control.relativeUs}us`,
  );

  const historical = async (caseName) => {
    const dir = join(workRoot, "historical", caseName);
    await mkdir(dir, { recursive: true });
    const { video, audio } = prepared.cases[caseName];
    const output = join(dir, MERGED_OUTPUT_NAME);
    const result = await runTool(toolchain.ffmpegPath, historicalSplitMergeArgs("mp4", video.aggregatePath, audio.aggregatePath, output));
    if (result.code !== 0) throw new Error(`the historical merge of ${caseName} failed (exit ${result.code})`);
    const bytes = await readFile(output);
    return { path: output, bytes, sha256: sha256(bytes) };
  };
  // Oracle sensitivity: the historical merge zeroes each input on its own, so
  // the offset pair's relative timing must come out NOT preserved.
  const lateHistorical = await historical("pos-audio-late");
  const lateVerdict = evaluateMergeTiming({
    videoInput: timelines["pos-audio-late"].video,
    audioInput: timelines["pos-audio-late"].audio,
    output: await probePacketTimeline(runTool, toolchain.ffprobePath, "mov", lateHistorical.path),
    movieTimescale: mp4MovieTimescale(lateHistorical.bytes),
  });
  checks.require(
    "timing/oracle-detects-per-input-zeroing",
    lateVerdict.measurable === true && lateVerdict.relativeTimingPreserved === false,
    `historical output relative ${lateVerdict.outputRelativeUs}us vs source ${lateVerdict.sourceRelativeUs}us`,
  );
  const controlHistorical = await historical("ctl-aligned");
  return {
    timelines,
    perCase: out,
    controlHistoricalSha256: controlHistorical.sha256,
    summary: {
      ...Object.fromEntries(
        Object.entries(out).map(([caseName, t]) => [
          caseName,
          {
            sourceRelativeUs: t.source.relativeUs,
            sourceVideoFirstPresentedUs: t.source.videoFirstPresentedUs,
            sourceAudioFirstPresentedUs: t.source.audioFirstPresentedUs,
            sourceSpanUs: t.source.spanUs,
            discriminating: t.source.discriminating,
            expectedReference: t.expectedReference,
          },
        ]),
      ),
      oracleSensitivity: {
        pair: "pos-audio-late",
        historicalOutputRelativeUs: lateVerdict.outputRelativeUs,
        sourceRelativeUs: lateVerdict.sourceRelativeUs,
        relativeTimingPreserved: lateVerdict.relativeTimingPreserved,
      },
    },
  };
}

/** The complete route table, before the service starts. */
function routeTable(prepared) {
  const routes = new Map();
  const add = (path, kind, body, product = undefined) => {
    if (routes.has(path)) throw new Error("a route is served twice");
    routes.set(path, {
      kind,
      body: Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"),
      ...(product === undefined ? {} : { product }),
    });
  };
  for (const caseName of HLS12_CASES) {
    const { video, audio } = prepared.cases[caseName];
    const shape = CASE_MEDIA[caseName].master;
    add(casePath(caseName, "watch.html"), "page", hls12Page(caseName));
    let product;
    if (caseName === "neg-master-redirect") product = { status: 302, location: hls12MovedMasterPath(caseName) };
    if (caseName === "neg-master-changed") product = { status: 200, body: Buffer.from(hls12Master(caseName, "resigned"), "utf8") };
    add(casePath(caseName, hls12MasterUri(caseName)), "master", hls12Master(caseName, shape), product);
    if (caseName === "neg-master-redirect") {
      // Where the redirect points: a pairable master with root-relative
      // references, so a Product that FOLLOWED it would find a provable pair.
      add(hls12MovedMasterPath(caseName), "master-moved", hls12Master(caseName, "paired", { referenceBase: casePath(caseName, "") }));
    }
    const serveRendition = (directory, r, playlistReference) => {
      add(casePath(caseName, playlistReference), "media", r.playlistText);
      if (r.init) add(casePath(caseName, `${directory}/${r.init.name}`), "init", r.init.bytes);
      for (const s of r.segments) add(casePath(caseName, `${directory}/${s.name}`), "fragment", s.bytes);
    };
    serveRendition("video", video, hls12VideoPlaylistUri(caseName));
    serveRendition("audio", audio, hls12AudioPlaylistUri(caseName));
    // The re-signed video URL is live, and the ambiguous group's second
    // rendition is real: neither negative fails for lack of a resource.
    if (caseName === "neg-master-changed") add(casePath(caseName, hls12VideoPlaylistUri(caseName, "RESIGNED")), "media", video.playlistText);
    if (caseName === "neg-ambiguous-group") add(casePath(caseName, hls12AltAudioPlaylistUri(caseName)), "media", audio.playlistText);
  }
  // Every Product-visible path must classify to the kind it is served as.
  for (const [path, served] of routes) {
    if (classifyHls12FixturePath(path).kind !== served.kind) throw new Error("a route does not classify as its kind");
  }
  return routes;
}

// ── 3. One durable job through the real executor ───────────────────────────

async function runJob(ctx, caseName) {
  const { policy, service, workRoot, spawnContext, spawnObserver, transport } = ctx;
  const dbDir = await mkdtemp(join(workRoot, "hls12-db-"));
  const db = openWorkerDatabase({ path: join(dbDir, "worker.sqlite") });
  applyMigrations(db);
  installStatusAudit(db);
  const store = new SQLiteJobStore({ db });
  let jobId = null;
  const statusNow = () => (jobId ? (store.getJob(jobId)?.status ?? "<missing>") : "<no-job>");
  spawnContext.statusNow = statusNow;
  ctx.transportState.statusNow = statusNow;
  ctx.transportState.caseNow = () => caseName;

  const workspace = createHlsWorkspaceSampler({ intervalMs: 2, classify: classifyHls12WorkspaceEntry });
  const sinkDir = await mkdtemp(join(workRoot, "hls12-sink-"));
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
    // analyzeForExecution. Plan derivation, HLS acquisition, the shared merge
    // and the capacity reader are all the executor's defaults.
    analyzeForExecution: async (url, signal) => {
      setPhase("analysis-execution");
      const result = await policy.analyzeForExecution(url, signal);
      observed.executionAnalyses += 1;
      const separate = result.separateHlsSelections ?? {};
      const selection = Object.hasOwn(separate, REQUESTED_PRESET) ? separate[REQUESTED_PRESET] : null;
      observed.facts = {
        separateOwns1080: selection !== null,
        hlsOwns1080: Object.hasOwn(result.hlsSelections ?? {}, REQUESTED_PRESET),
        progressiveOwns1080: Object.hasOwn(result.selections ?? {}, REQUESTED_PRESET),
        separateOwnedPresetIds: Object.keys(separate).sort(),
        selectionKeys: selection ? Object.keys(selection).sort() : [],
        selectionHeight: selection?.height ?? null,
        // Compared, never retained: the pair must be exactly the master-proven one.
        selectionIsTheProvenPair:
          selection !== null &&
          selection.videoPlaylistUrl === caseUrl(ctx.port, caseName, hls12VideoPlaylistUri(caseName)) &&
          selection.audioPlaylistUrl === caseUrl(ctx.port, caseName, hls12AudioPlaylistUri(caseName)),
      };
      try {
        const plan = deriveExecutionPlan(result, REQUESTED_PRESET);
        observed.facts.plan = plan.strategy === "yt-dlp"
          ? {
              operation: plan.generic.operation,
              targetContainer: plan.generic.targetContainer,
              requestedFormatId: plan.generic.requestedFormatId,
              genericKeys: Object.keys(plan.generic).sort(),
              sourceKeys: Object.keys(plan.generic.source ?? {}).sort(),
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
    { url: hls12PageUrl(ctx.port, caseName), formatId: REQUESTED_PRESET, principalId: "private-access-user" },
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
    if (statusNow() === "processing") workspace.setPhase("processing");
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
const requestLabel = (e) => `${e.kind}${e.family ? `:${e.family}` : ""}${e.ordinal ?? ""}`;

/** The exact Product request sequence of one complete separate-audio job. */
function expectedJobRequests(video, audio) {
  return [
    "master",
    "media:video",
    "media:audio",
    "init:video",
    ...video.segments.map((s) => `fragment:video${s.ordinal}`),
    "init:audio",
    ...audio.segments.map((s) => `fragment:audio${s.ordinal}`),
  ];
}

/** The durable row's string columns, as one searchable text. */
const durableText = (row) =>
  JSON.stringify(Object.fromEntries(Object.entries(row ?? {}).filter(([, v]) => typeof v === "string")));

// ── 4. A positive case ─────────────────────────────────────────────────────

async function runPositiveCase(ctx, caseName) {
  const { checks, service, runTool, toolchain, prepared, timing } = ctx;
  const C = (name) => `${caseName}/${name}`;
  const { video, audio } = prepared.cases[caseName];
  const pageUrl = hls12PageUrl(ctx.port, caseName);
  const needles = caseNeedles(caseName);
  const caseTiming = timing.perCase[caseName];

  // ── browser-safe analysis ────────────────────────────────────────────────
  ctx.currentCase = caseName;
  ctx.transportState.caseNow = () => caseName;
  service.setPhase(`${caseName}:analysis-public`);
  ctx.spawnContext.phase = `${caseName}:analysis-public`;
  const transportMark = ctx.transport.ledger().length;
  const documentsBefore = ctx.documents.length;
  const meta = await ctx.policy.analyze(pageUrl);
  const doc = ctx.documents.slice(documentsBefore).at(-1) ?? { parsed: false };
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
    C("analysis/separate-preset-facts"),
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
    meta.formats.length === 0 && needles.every((needle) => !publicJson.includes(needle)),
  );
  checks.record(
    C("analysis/pinned-ytdlp-exposes-no-pairing-relationship"),
    doc.parsed === true && doc.videoOnlyRenditions === 1 && doc.audioOnlyRenditions === 1 && doc.muxedRenditions === 0 &&
      doc.relationshipKeys.length === 0 && doc.everyRowNamesTheSubmittedMaster === true,
    `${doc.videoOnlyRenditions} video-only / ${doc.audioOnlyRenditions} audio-only / keys ${(doc.relationshipKeys ?? []).join(",") || "none"}`,
  );
  const publicRequests = service.requests(`${caseName}:analysis-public`);
  const ytdlpRequests = publicRequests.filter((r) => r.userAgentClass !== "product");
  const productRequests = publicRequests.filter((r) => r.userAgentClass === "product");
  checks.record(
    C("analysis/ytdlp-read-only-page-and-master"),
    ytdlpRequests.length >= 2 && ytdlpRequests.every((r) => r.kind === "page" || r.kind === "master"),
    ytdlpRequests.map((r) => r.kind).join(","),
  );
  const publicHttp = ctx.transport.ledger().slice(transportMark);
  checks.record(
    C("analysis/product-fetched-only-the-master-once"),
    productRequests.length === 1 && productRequests[0].kind === "master" && productRequests[0].status === 200 &&
      productRequests[0].productAnswer === false &&
      publicHttp.length === 1 && publicHttp[0].kind === "master" && publicHttp[0].responseStatus === 200,
    productRequests.map((r) => `${r.kind}:${r.status}`).join(","),
  );

  // ── the durable job ──────────────────────────────────────────────────────
  const job = await runJob(ctx, caseName);
  const facts = job.observed.facts ?? {};
  checks.record(C("executor/only-the-fresh-analysis-seam-injected"), sameList(job.depsKeys, ["analyzeForExecution"]));
  checks.record(
    C("execution/separate-map-owns-1080"),
    job.observed.executionAnalyses === 1 && facts.separateOwns1080 === true && facts.hlsOwns1080 === false &&
      facts.progressiveOwns1080 === false && sameList(facts.selectionKeys, ["audioPlaylistUrl", "height", "videoPlaylistUrl"]) &&
      facts.selectionHeight === 1080 && facts.selectionIsTheProvenPair === true,
    (facts.separateOwnedPresetIds ?? []).join(","),
  );
  checks.record(
    C("plan/clear-hls-separate-audio-remux-to-mp4"),
    facts.plan?.operation === "clear-hls-separate-audio-remux" && facts.plan?.targetContainer === "mp4" &&
      facts.plan?.requestedFormatId === REQUESTED_PRESET &&
      sameList(facts.plan?.genericKeys ?? [], ["operation", "requestedFormatId", "source", "strategy", "targetContainer"]) &&
      sameList(facts.plan?.sourceKeys ?? [], ["audioPlaylistUrl", "height", "videoPlaylistUrl"]),
    String(facts.plan?.operation ?? facts.planError),
  );

  // ── acquisition ──────────────────────────────────────────────────────────
  const httpLedger = job.http;
  const expected = expectedJobRequests(video, audio);
  checks.record(
    C("acquisition/master-then-playlists-then-video-then-audio"),
    sameList(httpLedger.map(requestLabel), expected) &&
      httpLedger.every((e) => e.variant === caseName && e.responseStatus === 200),
    httpLedger.map(requestLabel).join(","),
  );
  const fixtureAcq = service.requests(`${caseName}:acquisition`).filter((r) => r.userAgentClass === "product");
  checks.record(
    C("acquisition/each-resource-requested-exactly-once"),
    fixtureAcq.length === expected.length - 1 && fixtureAcq.every((r) => r.method === "GET" && r.status === 200) &&
      new Set(fixtureAcq.map((r) => `${r.kind}:${r.role}:${r.ordinal}`)).size === fixtureAcq.length,
    `${fixtureAcq.length} vs ${expected.length - 1}`,
  );
  checks.record(
    C("acquisition/one-request-at-a-time"),
    httpLedger.every((e, i) => e.endSeq !== null && (i === 0 || e.seq > httpLedger[i - 1].endSeq)),
  );
  checks.record(
    C("acquisition/fixed-product-request-profile"),
    httpLedger.length > 0 &&
      httpLedger.every((e) => e.headerNamesExact && e.userAgentIsProduct && e.acceptIsProduct && e.forbiddenHeadersPresent.length === 0) &&
      fixtureAcq.every((r) => !r.hasCookie && !r.hasAuthorization && !r.hasReferer && !r.hasRange),
  );
  const halves = ctx.halves.get(caseName) ?? null;
  checks.record(
    C("acquisition/halves-are-the-exact-concatenations"),
    halves !== null && halves.video.sha256 === video.aggregateSha256 && halves.video.bytes === video.aggregateBytes &&
      halves.audio.sha256 === audio.aggregateSha256 && halves.audio.bytes === audio.aggregateBytes &&
      halves.status === "processing",
    halves ? `${halves.video.bytes}+${halves.audio.bytes} vs ${video.aggregateBytes}+${audio.aggregateBytes}` : "never observed",
  );

  // ── processing ───────────────────────────────────────────────────────────
  const media = job.spawns.filter((s) => isMediaTool(s) && s.role === "media");
  const signature = media.map((s) => `${s.tool}:${s.input}`);
  checks.record(
    C("processing/both-halves-probed-through-mov-before-the-merge"),
    media[0]?.tool === "ffprobe" && media[0]?.input === SEPARATE_VIDEO_FMP4_FILE_NAME && media[0]?.demuxer === "mov" &&
      media[1]?.tool === "ffprobe" && media[1]?.input === SEPARATE_AUDIO_FMP4_FILE_NAME && media[1]?.demuxer === "mov" &&
      media[2]?.tool === "ffmpeg",
    signature.join(" "),
  );
  const ffmpegRuns = media.filter((s) => s.tool === "ffmpeg");
  const merge = ffmpegRuns[0] ?? null;
  checks.record(
    C("processing/one-ffmpeg-stream-copy-no-overwrite-of-both-halves"),
    ffmpegRuns.length === 1 && merge.streamCopy === true && merge.refusesOverwrite === true &&
      sameList(merge.inputs, [SEPARATE_VIDEO_FMP4_FILE_NAME, SEPARATE_AUDIO_FMP4_FILE_NAME]) &&
      sameList(merge.demuxers, ["mov", "mov"]) && merge.output === MERGED_OUTPUT_NAME &&
      ctx.mergeArgvMatches.get(caseName) === true,
    signature.join(" "),
  );
  checks.record(
    C("processing/sync-reference-is-the-earlier-input"),
    merge !== null && mergeSyncMatches(merge.sync, caseTiming.expected),
    merge ? `${JSON.stringify(merge.sync?.input0)} ${JSON.stringify(merge.sync?.input1)} (expected reference ${caseTiming.expectedReference})` : "no merge",
  );
  checks.record(
    C("processing/output-probe-ran"),
    sameList(signature, [
      `ffprobe:${SEPARATE_VIDEO_FMP4_FILE_NAME}`,
      `ffprobe:${SEPARATE_AUDIO_FMP4_FILE_NAME}`,
      `ffmpeg:${SEPARATE_VIDEO_FMP4_FILE_NAME}`,
      `ffprobe:${MERGED_OUTPUT_NAME}`,
    ]),
    signature.join(" "),
  );

  // ── lifecycle ────────────────────────────────────────────────────────────
  const masterHttp = httpLedger.filter((e) => e.kind === "master");
  const mediaHttp = httpLedger.filter((e) => e.kind !== "master");
  const executionAnalysis = service.requests(`${caseName}:analysis-execution`);
  checks.record(C("lifecycle/durable-trace"), sameList(job.trace, EXPECTED_TRACE), job.trace.join(" -> "));
  checks.record(
    C("lifecycle/master-proof-while-analyzing"),
    masterHttp.length === 1 && masterHttp[0].statusAtRequest === "analyzing" &&
      sameList(executionAnalysis.filter((r) => r.userAgentClass === "product").map((r) => r.kind), ["master"]) &&
      executionAnalysis.filter((r) => r.userAgentClass !== "product").every((r) => r.kind === "page" || r.kind === "master"),
    masterHttp.map((e) => e.statusAtRequest).join(","),
  );
  checks.record(
    C("lifecycle/every-media-request-while-downloading"),
    mediaHttp.length === expected.length - 1 && mediaHttp.every((e) => e.statusAtRequest === "downloading"),
    [...new Set(mediaHttp.map((e) => e.statusAtRequest))].join(","),
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
  const halvesBytes = video.aggregateBytes + audio.aggregateBytes;
  const acqPeak = job.workspace.acquisition?.peakBytes ?? Number.POSITIVE_INFINITY;
  const procPeak = job.workspace.processing?.peakBytes ?? Number.POSITIVE_INFINITY;
  const outputBytes = job.puts[0]?.preUploadBytes ?? 0;
  checks.record(
    C("workspace/acquisition-peak-within-the-two-halves"),
    acqPeak <= halvesBytes &&
      (job.workspace.acquisition?.classes ?? []).every((c) => c === "half-partial" || c === "half"),
    `${acqPeak} <= ${halvesBytes}`,
  );
  checks.record(
    C("workspace/processing-peak-within-halves-plus-output"),
    procPeak <= halvesBytes + outputBytes && procPeak <= 2 * config.maxFileSize &&
      (job.workspace.processing?.classes ?? []).every((c) => c === "half" || c === "output"),
    `${procPeak} <= ${halvesBytes + outputBytes}`,
  );

  // ── the delivered media ──────────────────────────────────────────────────
  const object = job.writer.soleObject();
  const objectBytes = object ? await readFile(object.path) : null;
  const out = object ? await probeMedia(runTool, toolchain.ffprobePath, object.path, "mov") : { readable: false, streams: [], duration: null };
  const outBoxes = objectBytes ? topLevelBoxTypes(objectBytes) : [];
  const outVideo = out.streams.find((s) => s.type === "video");
  checks.record(
    C("output/container-is-a-faststart-mp4"),
    out.readable && out.formatName === ISO_BMFF_FORMAT_NAME && outBoxes[0] === "ftyp" &&
      outBoxes.indexOf("moov") > 0 && outBoxes.indexOf("moov") < outBoxes.indexOf("mdat") && !outBoxes.includes("moof"),
    outBoxes.join(","),
  );
  checks.record(
    C("output/exactly-one-h264-video-and-one-aac-audio"),
    out.streams.length === 2 &&
      out.streams.filter((s) => s.type === "video" && s.codec === "h264").length === 1 &&
      out.streams.filter((s) => s.type === "audio" && s.codec === "aac").length === 1,
    JSON.stringify(out.streams),
  );
  checks.record(
    C("output/resolution-is-1920x1080"),
    outVideo?.width === HLS12_FIXTURE_SPEC.width && outVideo?.height === HLS12_FIXTURE_SPEC.height,
    `${outVideo?.width}x${outVideo?.height}`,
  );
  checks.record(
    C("output/duration-matches-the-pair-span"),
    out.duration !== null && out.duration > 0 &&
      Math.abs(out.duration - caseTiming.source.spanUs / 1_000_000) <= DURATION_TOLERANCE_SECONDS,
    `${out.duration}s vs ${caseTiming.source.spanUs}us`,
  );
  checks.record(
    C("output/size-positive-and-within-the-limit"),
    object !== null && object.observedBytes > 0 && object.observedBytes <= config.maxFileSize,
    String(object?.observedBytes),
  );
  const verdict = object
    ? evaluateMergeTiming({
        videoInput: timing.timelines[caseName].video,
        audioInput: timing.timelines[caseName].audio,
        output: await probePacketTimeline(runTool, toolchain.ffprobePath, "mov", object.path),
        movieTimescale: mp4MovieTimescale(objectBytes),
      })
    : { measurable: false };
  checks.record(
    C("output/packet-payloads-identical"),
    verdict.measurable === true && verdict.payloadIdentical === true && verdict.codecParametersPreserved === true,
    verdict.measurable ? `video ${verdict.packets.video.input}->${verdict.packets.video.output}, audio ${verdict.packets.audio.input}->${verdict.packets.audio.output}` : "unmeasurable",
  );
  checks.record(
    C("timing/relative-offset-preserved-within-the-time-base-tolerance"),
    verdict.measurable === true && verdict.relativeTimingPreserved === true && verdict.shiftsConstant === true &&
      verdict.noMediaHiddenOrUnhidden === true && verdict.noLeadingGap === true && verdict.streamSpansPreserved === true,
    verdict.measurable
      ? `source ${verdict.sourceRelativeUs}us -> output ${verdict.outputRelativeUs}us (delta ${verdict.relativeDeltaUs}us, tolerance ${verdict.toleranceUs}us)`
      : "unmeasurable",
  );
  if (caseName === "ctl-aligned") {
    checks.record(
      "ctl-aligned/output/identical-to-the-historical-merge",
      object !== null && object.sha256 === timing.controlHistoricalSha256,
    );
  }

  // ── upload and ready ─────────────────────────────────────────────────────
  const put = job.puts[0] ?? null;
  checks.record(
    C("upload/exactly-one-put-of-the-merged-mp4"),
    job.writer.putCount() === 1 && put !== null && object !== null &&
      put.streamBasename === MERGED_OUTPUT_NAME && object.sha256 === put.preUploadSha256 &&
      object.observedBytes === put.preUploadBytes && object.contentType === "video/mp4" &&
      object.sha256 !== video.aggregateSha256 && object.sha256 !== audio.aggregateSha256 &&
      job.writer.deleteLog().length === 0,
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
    durableText(job.durableRow),
    JSON.stringify(view ?? null),
    String(object?.contentDisposition ?? ""),
  ];
  checks.record(
    C("privacy/no-private-material-on-any-public-or-durable-surface"),
    surfaces.every((text) => needles.every((needle) => !text.includes(needle))),
  );
  checks.record(C("cleanup/job-workdir-removed"), job.workDirGone);
  await rm(job.sinkDir, { recursive: true, force: true });

  return {
    requestedPreset: REQUESTED_PRESET,
    analysis: {
      presetIds,
      preset1080: preset ? { resolution: preset.resolution, container: preset.container, hasVideo: preset.hasVideo, hasAudio: preset.hasAudio } : null,
      sourceQuality: sq ? { observedMaxHeight: sq.observedMaxHeight, deliverableMaxHeight: sq.deliverableMaxHeight, withheldReasons: (sq.withheld ?? []).map((w) => w.reason) } : null,
      pinnedYtdlpDocument: {
        extractorKey: doc.extractorKey ?? null,
        videoOnlyRenditions: doc.videoOnlyRenditions ?? null,
        audioOnlyRenditions: doc.audioOnlyRenditions ?? null,
        muxedRenditions: doc.muxedRenditions ?? null,
        relationshipKeys: doc.relationshipKeys ?? null,
      },
      productMasterRequests: productRequests.length,
    },
    plan: facts.plan ?? null,
    acquisition: {
      requests: httpLedger.map((e) => ({ kind: e.kind, role: e.family ?? null, ordinal: e.ordinal, statusAtRequest: e.statusAtRequest, responseStatus: e.responseStatus })),
      halves: halves ? { videoBytes: halves.video.bytes, audioBytes: halves.audio.bytes, statusAtObservation: halves.status } : null,
    },
    processing: {
      spawns: job.spawns.map((s) => ({ tool: s.tool, role: s.role, statusAtSpawn: s.status, inputs: s.inputs, demuxers: s.demuxers, output: s.output, streamCopy: s.streamCopy, refusesOverwrite: s.refusesOverwrite })),
      mergeSync: merge ? { input0: merge.sync?.input0 ?? null, input1: merge.sync?.input1 ?? null, forbiddenFlags: merge.sync?.forbiddenFlags ?? null } : null,
      expectedReference: caseTiming.expectedReference,
    },
    lifecycle: { durableTrace: job.trace },
    workspace: {
      maxFileSizeBytes: config.maxFileSize,
      acquisitionPeakBytes: job.workspace.acquisition?.peakBytes ?? null,
      acquisitionEntryClasses: job.workspace.acquisition?.classes ?? [],
      processingPeakBytes: job.workspace.processing?.peakBytes ?? null,
      processingEntryClasses: job.workspace.processing?.classes ?? [],
      halvesBytes,
      outputBytes,
    },
    output: {
      formatName: out.formatName ?? null,
      topLevelBoxes: outBoxes,
      durationSeconds: out.duration ?? null,
      streams: out.streams,
      bytes: object?.observedBytes ?? null,
    },
    timing: verdict.measurable
      ? {
          sourceRelativeUs: verdict.sourceRelativeUs,
          outputRelativeUs: verdict.outputRelativeUs,
          relativeDeltaUs: verdict.relativeDeltaUs,
          videoShiftUs: verdict.videoShiftUs,
          audioShiftUs: verdict.audioShiftUs,
          toleranceUs: verdict.toleranceUs,
          outputVideoFirstPresentedUs: verdict.outputVideoFirstPresentedUs,
          outputAudioFirstPresentedUs: verdict.outputAudioFirstPresentedUs,
          payloadIdentical: verdict.payloadIdentical,
          relativeTimingPreserved: verdict.relativeTimingPreserved,
        }
      : null,
    ready: view ? { status: view.status, container: view.container, mime: view.mime, fileSize: view.fileSize } : null,
  };
}

// ── 5. The master negatives (analysis only) ────────────────────────────────

async function runMasterNegative(ctx, caseName) {
  const { checks, service } = ctx;
  const C = (name) => `${caseName}/${name}`;
  ctx.currentCase = caseName;
  ctx.transportState.caseNow = () => caseName;
  service.setPhase(`${caseName}:analysis`);
  ctx.spawnContext.phase = `${caseName}:analysis`;
  const transportMark = ctx.transport.ledger().length;
  const documentsBefore = ctx.documents.length;
  const result = await ctx.policy.analyzeForExecution(hls12PageUrl(ctx.port, caseName));
  const doc = ctx.documents.slice(documentsBefore).at(-1) ?? { parsed: false };
  const presetIds = result.video.presets.map((p) => p.id);
  const videoPresetIds = presetIds.filter((id) => id !== "preset:audio" && id !== "preset:mp3");
  const q = result.video.sourceQuality ?? null;
  const unsupported = (q?.withheld ?? []).find((w) => w.reason === "unsupported_protocol") ?? null;
  let planError = null;
  try {
    deriveExecutionPlan(result, REQUESTED_PRESET);
  } catch (error) {
    planError = error instanceof AppError ? error.code : "non-app-error";
  }
  const httpLedger = ctx.transport.ledger().slice(transportMark);
  const phaseRequests = service.requests(`${caseName}:analysis`);
  const productRequests = phaseRequests.filter((r) => r.userAgentClass === "product");
  const expectedAudioOnly = caseName === "neg-ambiguous-group" ? 2 : 1;
  checks.record(
    C("pinned-ytdlp-exposes-a-video-only-rendition"),
    doc.parsed === true && doc.videoOnlyRenditions === 1 && doc.audioOnlyRenditions === expectedAudioOnly &&
      doc.muxedRenditions === 0 && doc.relationshipKeys.length === 0 && doc.everyRowNamesTheSubmittedMaster === true,
    `${doc.videoOnlyRenditions} video-only / ${doc.audioOnlyRenditions} audio-only`,
  );
  checks.record(C("no-hls-video-preset-advertised"), videoPresetIds.length === 0, presetIds.join(","));
  checks.record(
    C("separate-selections-empty"),
    Object.keys(result.separateHlsSelections ?? {}).length === 0 && Object.keys(result.hlsSelections ?? {}).length === 0,
  );
  checks.record(
    C("source-quality-withholds-unsupported-protocol-at-1080"),
    q !== null && q.observedMaxHeight === 1080 && q.deliverableMaxHeight === null &&
      unsupported !== null && unsupported.maxObservedHeight === 1080,
    JSON.stringify(q),
  );
  checks.record(C("plan-refuses-preset-1080"), planError === "FORMAT_UNAVAILABLE", String(planError));
  checks.record(
    C("product-requested-only-the-master"),
    httpLedger.length === 1 && httpLedger[0].kind === "master" &&
      productRequests.length === 1 && productRequests[0].kind === "master" &&
      phaseRequests.filter((r) => r.userAgentClass !== "product").every((r) => r.kind === "page" || r.kind === "master"),
    httpLedger.map(requestLabel).join(","),
  );
  return {
    pinnedYtdlpDocument: {
      videoOnlyRenditions: doc.videoOnlyRenditions ?? null,
      audioOnlyRenditions: doc.audioOnlyRenditions ?? null,
      relationshipKeys: doc.relationshipKeys ?? null,
    },
    videoPresetIds,
    separateSelections: Object.keys(result.separateHlsSelections ?? {}).length,
    sourceQuality: q ? { observedMaxHeight: q.observedMaxHeight, deliverableMaxHeight: q.deliverableMaxHeight, unsupportedProtocolMaxHeight: unsupported?.maxObservedHeight ?? null } : null,
    planErrorCode: planError,
    productRequests: httpLedger.map((e) => ({ kind: e.kind, responseStatus: e.responseStatus })),
    productAnswerServed: productRequests.map((r) => r.productAnswer),
    httpLedger,
  };
}

async function runMasterNegatives(ctx) {
  const { checks, service } = ctx;
  const results = {};
  for (const caseName of HLS12_MASTER_NEGATIVE_CASES) results[caseName] = await runMasterNegative(ctx, caseName);

  // Option A: the selected variant's group holds TWO URI renditions. The
  // Product has no preference policy, so the group is not a pair.
  const ambiguous = parsedMaster(hls12Master("neg-ambiguous-group", "ambiguous"));
  checks.record(
    "neg-ambiguous-group/master-group-has-two-uri-renditions",
    ambiguous.variants?.[0]?.audioGroup === 0 && ambiguous.audioGroups?.[0]?.length === 2 &&
      ambiguous.audioGroups[0].every((m) => typeof m.reference === "string") &&
      results["neg-ambiguous-group"].httpLedger[0]?.responseStatus === 200,
  );
  // The variant names no group; the only audio rendition sits in a group
  // nothing references — the "convenient" row a heuristic would take.
  const ungrouped = parsedMaster(hls12Master("neg-no-audio-group", "no-audio-group"));
  checks.record(
    "neg-no-audio-group/variant-names-no-group-beside-an-unreferenced-one",
    ungrouped.variants?.[0]?.audioGroup === null && ungrouped.audioGroups?.length === 1 &&
      ungrouped.audioGroups[0].length === 1 && typeof ungrouped.audioGroups[0][0].reference === "string" &&
      results["neg-no-audio-group"].httpLedger[0]?.responseStatus === 200,
  );
  // The master answers the PRODUCT with a redirect: refused, and the target —
  // a pairable master — is never requested by anyone, ever. "Followed nothing"
  // is measured at both ends: the Product made exactly ONE request for this
  // case and attempted no other (the transport refused none for it), and the
  // fixture never saw the target.
  const redirectPhase = service.requests("neg-master-redirect:analysis");
  checks.record(
    "neg-master-redirect/product-got-a-redirect-and-followed-nothing",
    results["neg-master-redirect"].httpLedger.length === 1 &&
      results["neg-master-redirect"].httpLedger[0]?.responseStatus === 302 &&
      ctx.transport.refusals().filter((r) => r.caseLabel === "neg-master-redirect").length === 0 &&
      redirectPhase.some((r) => r.kind === "master" && r.userAgentClass === "product" && r.productAnswer === true && r.status === 302) &&
      redirectPhase.some((r) => r.kind === "master" && r.userAgentClass !== "product" && r.status === 200) &&
      service.requests().filter((r) => r.kind === "master-moved").length === 0,
  );
  // A dynamic master: the one the Product fetched names the same video under a
  // different signature. The URL yt-dlp saw is not in it, and a path-only
  // comparison would have matched — exact identity is what refused it.
  const resigned = parsedMaster(hls12Master("neg-master-changed", "resigned"));
  const changedPhase = service.requests("neg-master-changed:analysis");
  checks.record(
    "neg-master-changed/product-master-names-only-a-re-signed-video-url",
    resigned.variants?.length === 1 &&
      resigned.variants[0].reference === hls12VideoPlaylistUri("neg-master-changed", "RESIGNED") &&
      resigned.variants[0].reference.split("?")[0] === hls12VideoPlaylistUri("neg-master-changed").split("?")[0] &&
      results["neg-master-changed"].httpLedger[0]?.responseStatus === 200 &&
      changedPhase.some((r) => r.kind === "master" && r.userAgentClass === "product" && r.productAnswer === true && r.status === 200),
  );
  return Object.fromEntries(
    // The raw ledger served the checks above; the record keeps only the summary.
    Object.entries(results).map(([caseName, { httpLedger: _httpLedger, ...rest }]) => [caseName, rest]),
  );
}

// ── 6. The execution negatives (full jobs) ─────────────────────────────────

async function runExecutionNegative(ctx, caseName, { expectedCode, before = null, after = null }) {
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

async function runExecutionNegatives(ctx) {
  const { checks, prepared, service } = ctx;
  const summary = (job, extra = {}) => ({
    finalStatus: job.finalJob?.status ?? null,
    errorCode: job.finalJob?.errorCode ?? null,
    durableTrace: job.trace,
    requests: job.http.map((e) => ({ kind: e.kind, role: e.family ?? null, ordinal: e.ordinal, statusAtRequest: e.statusAtRequest, responseStatus: e.responseStatus })),
    mediaToolSpawns: job.spawns.filter(isMediaTool).map((s) => ({ tool: s.tool, statusAtSpawn: s.status, inputs: s.inputs })),
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
  const labels = (job) => job.http.map(requestLabel);

  // An MPEG-TS audio half: both preflights run, the family check refuses it
  // before any map or fragment of EITHER half is requested.
  const ts = await runExecutionNegative(ctx, "neg-audio-ts", { expectedCode: "FORMAT_UNAVAILABLE" });
  checks.record(
    "neg-audio-ts/only-the-two-playlists-requested",
    sameList(labels(ts.job), ["master", "media:video", "media:audio"]) &&
      service.requests().filter((r) => r.caseName === "neg-audio-ts" && (r.kind === "init" || r.kind === "fragment")).length === 0,
    labels(ts.job).join(","),
  );
  neverProcessed("neg-audio-ts", ts);

  // A "video" playlist that serves a MUXED rendition: acquired whole, then
  // refused by the real ffprobe of the video half before the audio probe and
  // before any FFmpeg.
  const muxed = await runExecutionNegative(ctx, "neg-video-muxed", { expectedCode: "PROCESSING_FAILED" });
  const muxedMedia = muxed.media.filter((s) => s.role === "media");
  const muxedCase = prepared.cases["neg-video-muxed"];
  checks.record(
    "neg-video-muxed/refused-by-the-real-video-probe-before-any-ffmpeg",
    sameList(muxed.job.trace, FAILED_IN_PROCESSING) &&
      sameList(labels(muxed.job), expectedJobRequests(muxedCase.video, muxedCase.audio)) &&
      muxedMedia.length === 1 && muxedMedia[0].tool === "ffprobe" && muxedMedia[0].status === "processing" &&
      muxedMedia[0].input === SEPARATE_VIDEO_FMP4_FILE_NAME && muxedMedia[0].demuxer === "mov",
    muxedMedia.map((s) => `${s.tool}:${s.input}@${s.status}`).join(","),
  );

  // An "audio" playlist that serves a VIDEO-only rendition: the video half
  // probes clean, the audio half's real probe refuses it, no FFmpeg runs.
  const swapped = await runExecutionNegative(ctx, "neg-audio-video", { expectedCode: "PROCESSING_FAILED" });
  const swappedMedia = swapped.media.filter((s) => s.role === "media");
  checks.record(
    "neg-audio-video/refused-by-the-real-audio-probe-before-any-ffmpeg",
    sameList(swapped.job.trace, FAILED_IN_PROCESSING) &&
      sameList(swappedMedia.map((s) => `${s.tool}:${s.input}`), [
        `ffprobe:${SEPARATE_VIDEO_FMP4_FILE_NAME}`,
        `ffprobe:${SEPARATE_AUDIO_FMP4_FILE_NAME}`,
      ]) &&
      swappedMedia.every((s) => s.status === "processing"),
    swappedMedia.map((s) => `${s.tool}:${s.input}@${s.status}`).join(","),
  );

  // ONE byte budget for both halves. The allowance is their sum minus one
  // byte, so EACH half alone fits it: a transfer that gave each half its own
  // ceiling would succeed here. The video half is acquired whole; the audio
  // half is handed what is left and is refused at its last fragment.
  const budgetCase = prepared.cases["neg-budget"];
  const videoBytes = budgetCase.video.aggregateBytes;
  const audioBytes = budgetCase.audio.aggregateBytes;
  const budget = videoBytes + audioBytes - 1;
  const savedMax = config.maxFileSize;
  const budgetRun = await runExecutionNegative(ctx, "neg-budget", {
    expectedCode: "TOO_LARGE",
    before: () => Object.assign(config, { maxFileSize: budget }),
    after: () => Object.assign(config, { maxFileSize: savedMax }),
  });
  checks.record(
    "neg-budget/refused-only-because-the-halves-share-one-budget",
    videoBytes <= budget && audioBytes <= budget && videoBytes + audioBytes === budget + 1 &&
      sameList(labels(budgetRun.job), expectedJobRequests(budgetCase.video, budgetCase.audio)),
    labels(budgetRun.job).join(","),
  );
  checks.record("neg-budget/limit-restored", config.maxFileSize === savedMax);
  neverProcessed("neg-budget", budgetRun);

  // The audio map answers 404: the video half was complete, the audio half
  // fails at its map, and no audio fragment is ever requested.
  ctx.service.fail(casePath("neg-audio-map-404", `audio/${prepared.cases["neg-audio-map-404"].audio.init.name}`), 404);
  const map404 = await runExecutionNegative(ctx, "neg-audio-map-404", { expectedCode: "NETWORK_ERROR" });
  const map404Case = prepared.cases["neg-audio-map-404"];
  checks.record(
    "neg-audio-map-404/video-half-complete-then-no-audio-fragment",
    sameList(labels(map404.job), [
      "master", "media:video", "media:audio", "init:video",
      ...map404Case.video.segments.map((s) => `fragment:video${s.ordinal}`),
      "init:audio",
    ]) &&
      map404.job.http.at(-1)?.responseStatus === 404 &&
      service.requests().filter((r) => r.caseName === "neg-audio-map-404" && r.kind === "fragment" && r.role === "audio").length === 0,
    map404.job.http.map((e) => `${requestLabel(e)}:${e.responseStatus}`).join(","),
  );
  neverProcessed("neg-audio-map-404", map404);

  return {
    audioHalfMpegTs: summary(ts.job, { expected: "FORMAT_UNAVAILABLE" }),
    videoHalfMuxed: summary(muxed.job, { expected: "PROCESSING_FAILED" }),
    audioHalfIsVideo: summary(swapped.job, { expected: "PROCESSING_FAILED" }),
    sharedByteBudget: summary(budgetRun.job, { expected: "TOO_LARGE", allowanceBytes: budget, videoBytes, audioBytes }),
    audioMap404: summary(map404.job, { expected: "NETWORK_ERROR" }),
  };
}

// ── 7. Main ────────────────────────────────────────────────────────────────

function sanitizeDetail(detail) {
  if (detail === null || detail === undefined) return null;
  const text = String(detail).slice(0, 400);
  return findHls12ForbiddenSubstring(text) === null ? text : "<withheld: named fixture material>";
}

async function main(argv) {
  const opts = parseReleaseChildArgv(argv);
  if (await pathExists(opts.evidence)) throw new Error("refusing to replace an existing evidence artifact");

  const checks = createChecks();
  const startedAt = new Date().toISOString();
  const workRoot = await mkdtemp(join(tmpdir(), "hls12-"));
  const interfaces = Object.keys(networkInterfaces()).sort();
  let verdict = "BLOCKED";
  let toolchain = null;
  let invariants = null;
  let fixtureSummary = null;
  let timingSummary = null;
  const cases = {};
  let masterNegatives = null;
  let executionNegatives = null;
  let service = null;
  let spawnObserver = null;
  let tap = null;

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
    const timing = await measureTiming(checks, plainRunTool, toolchain, prepared, workRoot);
    timingSummary = timing.summary;

    const eventClock = createEventClock();
    service = createHls12FixtureService({ routes: routeTable(prepared), eventClock });
    const bound = await service.listen();
    checks.require("fixture/service-binds-loopback-only", bound.address === HLS12_FIXTURE_LOOPBACK);
    const validateUrl = createHls12PageUrlValidator({ port: bound.port, AppError });
    checks.require(
      "validator/admits-exactly-the-case-pages",
      validateUrl.admitted.length === HLS12_CASES.length &&
        (await Promise.all(validateUrl.admitted.map(async (u) => (await validateUrl(u)).url === u))).every(Boolean),
    );
    let refused = 0;
    const alternatives = hls12NearbyPageUrlAlternatives(bound.port);
    for (const candidate of alternatives) {
      try {
        await validateUrl(candidate);
      } catch (error) {
        if (error instanceof AppError && error.code === "INVALID_URL") refused += 1;
      }
    }
    checks.record("validator/refuses-every-nearby-alternative", refused === alternatives.length, `${refused}/${alternatives.length}`);

    // Every Worker spawn from here on is observed with its durable status.
    const spawnContext = { statusNow: () => "<no-job>", phase: "setup" };
    const ctx = {
      checks, service, prepared, toolchain, workRoot, timing, spawnContext, port: bound.port,
      currentCase: "setup", documents: [], halves: new Map(), mergeArgvMatches: new Map(),
      transportState: { statusNow: () => "<no-job>", caseNow: () => "setup" },
    };
    const ledger = {
      runner: async (runOpts) => {
        const result = await runProcess(runOpts);
        if ((runOpts.args ?? []).includes("--dump-single-json")) {
          ctx.documents.push(hls12AnalysisDocumentFacts(result.stdout, masterUrlFor(bound.port, ctx.currentCase)));
        }
        return result;
      },
    };
    let ffmpegProbe = null;
    ctx.policy = createAnalysisPolicy({
      validateUrl,
      ledger,
      limits: {
        analysisTimeoutSeconds: Math.max(1, Math.floor(config.analysisTimeoutMs / 1000)),
        maxVideoDurationSeconds: config.maxVideoDuration,
        maxFileSizeBytes: config.maxFileSize,
      },
      ffmpegAvailableFn: () => (ffmpegProbe ??= ffmpegAvailable()),
    });
    spawnObserver = installHlsSpawnObserver({
      context: () => ({ status: spawnContext.statusNow(), phase: spawnContext.phase }),
      describe: describeHls12Spawn,
      beforeDelegate: (record, _command, args) => {
        const argv = args.map(String);
        if (record.tool === "ffprobe" && record.role === "media" && record.input === SEPARATE_VIDEO_FMP4_FILE_NAME &&
            !ctx.halves.has(ctx.currentCase)) {
          // BEFORE the real spawn: the first media tool to touch the halves.
          const videoPath = argv[argv.indexOf("-i") + 1];
          const audioPath = join(dirname(videoPath), SEPARATE_AUDIO_FMP4_FILE_NAME);
          const v = readFileSync(videoPath);
          const a = readFileSync(audioPath);
          ctx.halves.set(ctx.currentCase, {
            status: record.status,
            video: { bytes: v.byteLength, sha256: sha256(v) },
            audio: { bytes: a.byteLength, sha256: sha256(a) },
          });
        }
        if (record.tool === "ffmpeg" && record.role === "media" && Object.hasOwn(timing.perCase, ctx.currentCase)) {
          // The observed argv must be EXACTLY the Product's shared builder's,
          // for the decision the harness derived from its own measurement.
          const inputs = argv.flatMap((arg, i) => (arg === "-i" ? [argv[i + 1]] : []));
          let expected = null;
          try {
            expected = buildSplitMergeArgs({
              target: "mp4",
              videoPath: inputs[0],
              audioPath: inputs[1],
              outputPath: argv[argv.length - 1],
              sync: { target: "mp4", reference: timing.perCase[ctx.currentCase].expectedReference },
            });
          } catch {
            expected = null;
          }
          ctx.mergeArgvMatches.set(ctx.currentCase, expected !== null && sameList(argv, expected));
        }
      },
    });
    ctx.spawnObserver = spawnObserver;
    ctx.runTool = createToolRunner(spawnObserver.originalSpawn);
    ctx.transport = createHlsSafeHttpTransport({
      port: bound.port,
      eventClock,
      statusNow: () => ctx.transportState.statusNow(),
      caseNow: () => ctx.transportState.caseNow(),
      realRequest: http.request.bind(http),
      hostname: HLS12_FIXTURE_HOSTNAME,
      classify: classifyHls12FixturePath,
      admittedKinds: HLS_MASTER_PROOF_ADMITTED_KINDS,
    });

    tap = tapProcessOutput();
    // One benign line through the ordinary console, so the check below also
    // proves the tap sees what any module prints.
    console.error(TAP_ARMED_LINE);
    try {
      await withHlsSafeHttpTransport({ setSafeHttpTestHooks, setPinnedRequestFactoryForTests }, ctx.transport, async () => {
        for (const caseName of HLS12_POSITIVE_CASES) cases[caseName] = await runPositiveCase(ctx, caseName);
        masterNegatives = await runMasterNegatives(ctx);
        executionNegatives = await runExecutionNegatives(ctx);
      });
    } finally {
      tap.restore();
    }
    const printed = tap.text();
    checks.record(
      "privacy/no-private-material-in-process-output",
      printed.includes(TAP_ARMED_LINE) && PRIVATE_NEEDLES.every((needle) => !printed.includes(needle)),
      `${Buffer.byteLength(printed, "utf8")} bytes printed, tap ${printed.includes(TAP_ARMED_LINE) ? "live" : "NOT live"}`,
    );
    checks.record("transport/no-refused-request", ctx.transport.refusals().length === 0, String(ctx.transport.refusals().length));
    checks.record(
      "fixture/no-unexpected-route",
      service.requests().every((r) => r.kind !== "unexpected" && r.kind !== "master-moved" && r.method === "GET"),
    );
    checks.record("fixture/no-range-request", service.requests().every((r) => r.hasRange === false));

    verdict = checks.passed() ? "PASS" : "FAIL";
  } catch (error) {
    checks.record("run/completed-without-error", false, error?.message ?? String(error));
    verdict = "FAIL";
    process.stderr.write(`[hls12] ${sanitizeDetail(error?.stack ?? error)}\n`);
  } finally {
    setPinnedRequestFactoryForTests(null);
    setSafeHttpTestHooks(null);
    if (spawnObserver) spawnObserver.uninstall();
    if (service) await service.close();
  }

  const record = buildHls12ReleaseEvidence({
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: { commit: opts.sourceCommit, tree: opts.sourceTree, contextClean: opts.sourceContextClean },
    image: { candidateTag: opts.candidateTag, imageId: opts.candidateImageId, runSubject: opts.runImageId },
    network: { observedInterfaceNames: interfaces },
    toolchain,
    invariants,
    fixture: fixtureSummary,
    timing: timingSummary,
    cases,
    masterNegatives,
    executionNegatives,
    checks: checks.all().map((check) => ({ ...check, detail: sanitizeDetail(check.detail) })),
  });
  await writeFile(opts.evidence, renderHls12ReleaseEvidence(record), { flag: "wx" });
  await rm(workRoot, { recursive: true, force: true });

  const failed = checks.failed();
  process.stdout.write(`${verdict} ${HLS12_RELEASE_EVIDENCE_SCHEMA} checks=${checks.all().length} failed=${failed.length}\n`);
  for (const f of failed) process.stdout.write(`  FAIL ${f.name}${f.detail ? ` :: ${sanitizeDetail(f.detail)}` : ""}\n`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[hls12] ${sanitizeDetail(error?.stack ?? error)}\n`);
    process.exit(2);
  });
}

export { CASE_MEDIA, routeTable, expectedJobRequests };
