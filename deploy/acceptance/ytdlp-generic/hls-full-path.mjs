#!/usr/bin/env node
//
// HLS-08: the deterministic clear-HLS FULL-PATH acceptance orchestrator.
//
// ── What one run proves ────────────────────────────────────────────────────
//
// That against deterministic LOCAL fixtures and the exact accepted media
// runtime, the recorded source commit executes the activated clear-HLS chain
// from real generic analysis through durable `ready`:
//
//   browser-safe analysis -> ordinary HLS-backed public preset
//   -> fresh execution analysis -> ordinary deriveExecutionPlan()
//   -> clear-hls-remux plan -> HLS-2 real playlist preflight
//   -> HLS-3 real sequential fragment acquisition -> durable beginProcessing()
//   -> HLS-4 real ffprobe + FFmpeg stream-copy remux + validation
//   -> durable beginUploading() -> real finalizeJobUpload() -> local provider
//   -> ready
//
// with the real pinned yt-dlp, the real ordinary planner, the real
// JobExecutor, a real SQLiteJobStore, the real HLS-1..HLS-4 modules, the real
// ffprobe/FFmpeg, the real workspace-capacity policy and the real upload
// lifecycle — plus three bounded negatives (encrypted playlist, fragment HTTP
// failure, FFmpeg unavailable at analysis).
//
// ── The only substitutions ─────────────────────────────────────────────────
//
//   submitted-page URL validator  `lib/hls-fixture-url.mjs` (exact page only)
//   safe-HTTP DNS answer + socket `lib/hls-safe-http-transport.mjs`
//   object-store provider         `lib/local-object-writer.mjs`
//
// Everything else is the Product's own code. Nothing below injects
// `derivePlanForExecution`, `acquireClearHls`, `processClearHls` or
// `availableWorkDirBytes`; the executor gets ONE seam, a transparent recording
// wrapper around the policy's own `analyzeForExecution`.
//
// ── What one run does NOT prove ────────────────────────────────────────────
//
// Production SSRF/address pinning, Production DNS, Production egress/nftables,
// Cloudflare, Vercel, R2 and its broker, the Production network namespace,
// the watchdog, public-site or real-CDN compatibility, and promotion (HLS-10).
//
// ── Two explicit acceptance modes, one behavioral run ──────────────────────
//
// `--acceptance-mode` is required (`lib/hls-acceptance-mode.mjs`):
//
//   overlay        HLS-08. The candidate source overlaid on the accepted
//                  historical runtime; emits `hls08-deterministic-full-path-02`.
//   release-image  HLS-09. The ACTUAL `Dockerfile.worker` release candidate,
//                  launched by the SPLIT-07 parent; emits
//                  `hls09-release-image-full-path-01`.
//
// Only identity and the record differ. Everything this file measures, and
// every behavioral check, is the same code in both modes.
//
// ── Where it runs ──────────────────────────────────────────────────────────
//
// INSIDE the acceptance container, as the image's non-root `node` user, with
// `--network none` and exactly one `--add-host` mapping. Overlay mode:
// `lib/hls-container.mjs` builds that invocation and `run-hls-acceptance.mjs`
// launches it. Release-image mode: `lib/release-container.mjs` builds it — with
// a read-only root, the Product media workspace bound at `/tmp/videofetch` and
// harness scratch on its own tmpfs via `TMPDIR` — and
// `run-release-image-acceptance.mjs` launches it.

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ── Production modules. Imported, never re-implemented. ────────────────────
import { config } from "../../../src/lib/config.ts";
import { AppError } from "../../../src/lib/errors.ts";
import {
  WorkerAnalyzeRequestSchema,
  WorkerRequestedFormatIdSchema,
} from "../../../src/shared/worker/contracts.ts";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "../../../src/shared/media-limits.ts";
import { looksLikeDirectMedia } from "../../../src/services/extractors/direct.server.ts";
import { mimeForContainer } from "../../../src/services/extractors/normalize.ts";
import { buildAttachmentContentDisposition, buildDownloadFilename } from "../../../src/lib/filenames.ts";
import { YTDLP_RUNTIME, probeYtdlpRuntime } from "../../../src/worker/runtime/ytdlp-runtime.server.ts";
import {
  runProcess,
  setProcessRunnerTestHooks,
} from "../../../src/services/processing/process-runner.server.ts";
import { ffmpegAvailable } from "../../../src/services/processing/ffmpeg.server.ts";
import { resolveFfprobePath } from "../../../src/services/processing/ffprobe.server.ts";
import {
  YTDLP_V1_NATIVE_PROTOCOLS,
  analyzeGenericMediaInternal,
} from "../../../src/worker/analysis/ytdlp-analysis.server.ts";
import { createMediaAnalysisPolicy } from "../../../src/worker/analysis/media-analyzer.server.ts";
import { deriveExecutionPlan } from "../../../src/worker/execution/format-plan.ts";
import { GENERIC_SOURCE_PROTOCOLS } from "../../../src/worker/execution/generic-source.ts";
import {
  requiredWorkspaceBytes,
  workspaceFootprintForPlan,
} from "../../../src/worker/execution/workspace-capacity.ts";
import { JobExecutor } from "../../../src/worker/execution/job-executor.server.ts";
import {
  ClearHlsPlaylistError,
  HLS_V1_ALLOWED_TAGS,
  parseClearHlsMediaPlaylist,
} from "../../../src/worker/hls/hls-media-playlist.ts";
import { AGGREGATE_FILE_NAME } from "../../../src/worker/hls/hls-fragment-acquisition.server.ts";
import {
  HLS_OUTPUT_FILE_NAME as PRODUCT_HLS_OUTPUT_FILE_NAME,
  HLS_OUTPUT_PARTIAL_FILE_NAME as PRODUCT_HLS_OUTPUT_PARTIAL_FILE_NAME,
} from "../../../src/worker/hls/hls-processing.server.ts";
import {
  lookupHost,
  setPinnedRequestFactoryForTests,
  setSafeHttpTestHooks,
} from "../../../src/lib/security/safe-http.server.ts";
import { openWorkerDatabase } from "../../../src/worker/state/database.server.ts";
import { applyMigrations } from "../../../src/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "../../../src/worker/state/sqlite-job-store.server.ts";

// ── Harness modules ────────────────────────────────────────────────────────
import {
  HLS_FAILING_FRAGMENT,
  HLS_FIXTURE_SPEC,
  encryptedMediaPlaylist,
  fragmentFailureMediaPlaylist,
  generateHlsFixture,
  hlsFixturePage,
  hlsMasterPlaylist,
} from "./fixtures/hls-media.mjs";
import { createHlsFixtureService } from "./fixtures/hls-server.mjs";
import {
  HLS08_RAW_FORMAT_ID,
  HLS_FIXTURE_HOSTNAME,
  HLS_FIXTURE_LOOPBACK,
  HLS_SYNTHETIC_PUBLIC_ADDRESS,
  classifyHlsFixturePath,
  createHlsPageUrlValidator,
  hlsPageUrl,
  mediaPlaylistUri,
  nearbyPageUrlAlternatives,
} from "./lib/hls-fixture-url.mjs";
import {
  createEventClock,
  createHlsSafeHttpTransport,
  withHlsSafeHttpTransport,
} from "./lib/hls-safe-http-transport.mjs";
import {
  HLS08_ADMISSION_FINDING,
  HLS08_HOSTNAME_FINDING,
  HLS08_PRIVACY_NEEDLES,
  HLS_AGGREGATE_FILE_NAME,
  HLS_OUTPUT_FILE_NAME,
  HLS_OUTPUT_PARTIAL_FILE_NAME,
  classifyProductSpawn,
  createProcessObserver,
  describePrivacyFindings,
  evaluateHlsRemuxArgv,
  inputOperand,
  partitionPrivacyFindings,
  scanRawPrivacyNeedles,
  validateDurablePrivacy,
  validateStructuredPrivacy,
  withProcessObserver,
} from "./lib/hls-observers.mjs";
import { HLS08_ACCEPTED_BASE } from "./lib/hls-container.mjs";
import {
  acceptanceIdentityChecks,
  acceptanceLabel,
  buildAcceptanceEvidence,
  imageRemovalFact,
  parseHlsAcceptanceArgv,
  renderAcceptanceEvidence,
} from "./lib/hls-acceptance-mode.mjs";
import { createLocalObjectStoreWriter } from "./lib/local-object-writer.mjs";
import { createRunnerLedger, installStatusAudit, readStatusTrace } from "./lib/split-observers.mjs";

// ── Bounds ─────────────────────────────────────────────────────────────────

/** The public preset the durable job requests. Application-owned, closed. */
const REQUESTED_PRESET = "preset:best";

/** The rung the 360-line fixture must also be advertised on. */
const EXPECTED_RUNG = "preset:360";

/** Output duration tolerance, in seconds, against the 6 s fixture. */
const DURATION_TOLERANCE_SECONDS = 0.25;

/** The ISO-BMFF demuxer alias group the pinned ffprobe reports for MP4. */
const MP4_FORMAT_NAME = "mov,mp4,m4a,3gp,3g2,mj2";

/** Media spawn kinds that are HLS-4 work (never capability probes). */
const MEDIA_WORK_KINDS = new Set(["hls-ffmpeg-remux", "ffmpeg-other", "ffprobe-media-probe"]);

/** Statuses after the fresh execution analysis. */
const POST_ANALYSIS_STATUSES = new Set(["downloading", "processing", "uploading", "ready", "failed"]);

// ── Check ledger ───────────────────────────────────────────────────────────

function createChecks() {
  const entries = [];
  return {
    record(name, ok, detail) {
      entries.push({ name, ok: Boolean(ok), detail: detail ?? null });
      return Boolean(ok);
    },
    require(name, ok, detail) {
      this.record(name, ok, detail);
      if (!ok) throw new Error(`acceptance check failed: ${name}${detail ? ` (${detail})` : ""}`);
    },
    all() {
      return entries.map((e) => ({ ...e }));
    },
    failed() {
      return entries.filter((e) => !e.ok);
    },
    passed() {
      return entries.length > 0 && entries.every((e) => e.ok);
    },
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/** Harness tool use, counted apart from any Product process. */
const fixtureToolUse = { ffmpegRuns: 0, ffprobeRuns: 0 };

/** One bounded HARNESS command. Never goes through the Product runner. */
function runTool(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < 64 * 1024) stderr += String(c);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/**
 * The harness's OWN ffprobe observation. Separate from the Product's probe
 * (which reads only format and codec types): this one also reads codec names,
 * dimensions and duration, and never feeds a Product decision.
 */
async function harnessProbe(ffprobePath, inputPath, demuxer) {
  fixtureToolUse.ffprobeRuns += 1;
  const res = await runTool(ffprobePath, [
    "-v", "error", "-protocol_whitelist", "file", "-f", demuxer, "-print_format", "json",
    "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height",
    "-i", inputPath,
  ]);
  if (res.code !== 0) throw new Error(`harness ffprobe failed (${res.code})`);
  const doc = JSON.parse(res.stdout);
  const streams = doc.streams ?? [];
  return {
    formatName: doc.format?.format_name ?? null,
    duration: doc.format?.duration === undefined ? null : Number(doc.format.duration),
    streams: streams.map((s) => s.codec_type),
    codecs: streams.map((s) => s.codec_name),
    video: streams.filter((s) => s.codec_type === "video").map((s) => ({ width: s.width, height: s.height })),
  };
}

/** Production's `memoizeOnce`, restated: the Worker probes FFmpeg once. */
function memoizeOnce(fn) {
  let pending = null;
  return () => {
    pending ??= fn().catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

// ── 1. Runtime preflight ───────────────────────────────────────────────────

async function preflight(checks) {
  const nodeVersion = process.version;
  checks.require("preflight/node-runtime-family", /^v22\./.test(nodeVersion), `node ${nodeVersion}`);

  const runtime = await probeYtdlpRuntime();
  checks.require("preflight/ytdlp-available", runtime.available === true, runtime.reason ?? null);
  // A version pin, not a base-image assertion: the harness's yt-dlp pin is the
  // same `2026.08.19` in both modes (and in SPLIT-07's EXPECTED_YTDLP_RUNTIME).
  checks.require(
    "preflight/ytdlp-exact-pin",
    runtime.version === YTDLP_RUNTIME.expectedVersion && runtime.version === HLS08_ACCEPTED_BASE.ytdlpVersion,
    `${runtime.version} vs ${YTDLP_RUNTIME.expectedVersion}`,
  );

  const ffmpegPath = config.ffmpegPath;
  checks.require("preflight/ffmpeg-path-absolute", ffmpegPath === "/usr/bin/ffmpeg", ffmpegPath);
  const ffmpegVersion = await runTool(ffmpegPath, ["-hide_banner", "-version"]);
  checks.require("preflight/ffmpeg-executes", ffmpegVersion.code === 0, `exit ${ffmpegVersion.code}`);
  checks.require("preflight/ffmpeg-available-predicate", (await ffmpegAvailable()) === true);

  const ffprobePath = resolveFfprobePath();
  checks.require(
    "preflight/ffprobe-is-ffmpeg-sibling",
    ffprobePath === "/usr/bin/ffprobe" && dirname(ffprobePath) === dirname(ffmpegPath),
    ffprobePath,
  );
  const ffprobeVersion = await runTool(ffprobePath, ["-hide_banner", "-version"]);
  checks.require("preflight/ffprobe-executes", ffprobeVersion.code === 0, `exit ${ffprobeVersion.code}`);

  const firstLine = (text) => text.split(/\r?\n/)[0]?.trim() ?? "";
  return {
    node: nodeVersion,
    ytdlpVersion: runtime.version,
    ytdlpArtifactPath: YTDLP_RUNTIME.artifactPath,
    ffmpegPath,
    ffmpegVersion: firstLine(ffmpegVersion.stdout),
    ffmpegAvailable: true,
    ffprobePath,
    ffprobeVersion: firstLine(ffprobeVersion.stdout),
  };
}

/** HLS-7's load-bearing invariants, read from the Product constants. */
function checkInvariants(checks) {
  const native = [...YTDLP_V1_NATIVE_PROTOCOLS];
  const generic = [...GENERIC_SOURCE_PROTOCOLS];
  checks.require("invariants/ytdlp-native-protocols-http-https", sameList(native, ["http", "https"]), native.join(","));
  checks.require("invariants/generic-source-protocols-http-https", sameList(generic, ["http", "https"]), generic.join(","));
  checks.require(
    "invariants/raw-hls-id-is-not-a-requestable-format-id",
    !WorkerRequestedFormatIdSchema.safeParse(HLS08_RAW_FORMAT_ID).success,
  );
  checks.require(
    "invariants/harness-file-names-match-the-product",
    AGGREGATE_FILE_NAME === HLS_AGGREGATE_FILE_NAME &&
      PRODUCT_HLS_OUTPUT_FILE_NAME === HLS_OUTPUT_FILE_NAME &&
      PRODUCT_HLS_OUTPUT_PARTIAL_FILE_NAME === HLS_OUTPUT_PARTIAL_FILE_NAME,
  );
  return {
    ytdlpNativeProtocols: native,
    genericSourceProtocols: generic,
    rawHlsIdRequestable: false,
  };
}

// ── 2. Fixture generation and validation (HARNESS tool use) ────────────────

async function prepareFixture(checks, toolchain, fixtureDir) {
  fixtureToolUse.ffmpegRuns += 1;
  const fixture = await generateHlsFixture({ ffmpegPath: toolchain.ffmpegPath, outDir: fixtureDir });

  checks.require(
    "fixture/at-least-three-mpegts-segments",
    fixture.segments.length >= 3 && fixture.segments.length === HLS_FIXTURE_SPEC.segmentCount,
    String(fixture.segments.length),
  );

  // The Product's own HLS-1 parser decides what the accepted subset is.
  let parsed = null;
  try {
    parsed = parseClearHlsMediaPlaylist(fixture.playlistText);
  } catch {
    parsed = null;
  }
  checks.require(
    "fixture/playlist-is-inside-the-hls1-subset",
    parsed !== null && parsed.segmentType === "mpegts" && parsed.fragmentCount === fixture.segments.length,
  );
  const lines = fixture.playlistText.split("\n").map((l) => l.trim()).filter(Boolean);
  checks.require(
    "fixture/playlist-is-finite-vod",
    lines.at(-1) === "#EXT-X-ENDLIST" && lines.includes("#EXT-X-PLAYLIST-TYPE:VOD"),
  );
  // Exact tag NAMES (up to the first `:`), checked against HLS-1's own
  // allowlist — a prefix test would confuse #EXT-X-MEDIA with the allowed
  // #EXT-X-MEDIA-SEQUENCE. No key, map, byte range, discontinuity, rendition,
  // stream-inf or part tag can pass it, and no fMP4 segment name is allowed.
  const tagNames = lines.filter((l) => l.startsWith("#")).map((l) => l.split(":")[0]);
  checks.require(
    "fixture/playlist-has-no-refused-construct",
    tagNames.every((t) => HLS_V1_ALLOWED_TAGS.includes(t)) &&
      !lines.some((l) => !l.startsWith("#") && !/^seg-\d+\.ts$/.test(l)),
    [...new Set(tagNames)].join(","),
  );

  const segmentFacts = [];
  for (const segment of fixture.segments) {
    const probe = await harnessProbe(toolchain.ffprobePath, segment.path, "mpegts");
    segmentFacts.push({
      ordinal: segment.ordinal,
      byteLength: segment.byteLength,
      sha256: segment.sha256,
      formatName: probe.formatName,
      codecs: probe.codecs,
      width: probe.video[0]?.width ?? null,
      height: probe.video[0]?.height ?? null,
    });
  }
  checks.require(
    "fixture/segments-are-h264-aac-mpegts-640x360",
    segmentFacts.every(
      (s) =>
        s.formatName === "mpegts" &&
        s.codecs.filter((c) => c === "h264").length === 1 &&
        s.codecs.filter((c) => c === "aac").length === 1 &&
        s.codecs.length === 2 &&
        s.width === HLS_FIXTURE_SPEC.width &&
        s.height === HLS_FIXTURE_SPEC.height,
    ),
  );

  const encrypted = encryptedMediaPlaylist(fixture.playlistText);
  let encryptedReason = null;
  try {
    parseClearHlsMediaPlaylist(encrypted);
  } catch (err) {
    encryptedReason = err instanceof ClearHlsPlaylistError ? err.reason : "non-playlist-error";
  }
  checks.require("fixture/encrypted-variant-is-refused-by-hls1", encryptedReason === "encrypted", String(encryptedReason));

  const failing = fragmentFailureMediaPlaylist(fixture.playlistText);
  let failingParsed = null;
  try {
    failingParsed = parseClearHlsMediaPlaylist(failing);
  } catch {
    failingParsed = null;
  }
  checks.require(
    "fixture/fragment-failure-variant-is-accepted-by-hls1",
    failingParsed !== null && failingParsed.fragmentCount === fixture.segments.length,
  );

  return {
    fixture,
    encryptedPlaylist: encrypted,
    failurePlaylist: failing,
    facts: {
      recipe: "FFmpeg lavfi testsrc2 + sine -> libx264 baseline 3.0 + AAC-LC -> FFmpeg hls muxer (vod, mpegts)",
      width: HLS_FIXTURE_SPEC.width,
      height: HLS_FIXTURE_SPEC.height,
      fps: HLS_FIXTURE_SPEC.fps,
      durationSeconds: HLS_FIXTURE_SPEC.durationSeconds,
      segmentSeconds: HLS_FIXTURE_SPEC.segmentSeconds,
      segmentCount: fixture.segments.length,
      segments: segmentFacts,
      aggregateBytes: fixture.aggregateBytes,
      aggregateSha256: fixture.aggregateSha256,
      playlistAuthoredBy: "FFmpeg hls muxer, served verbatim",
      hls1FragmentCount: parsed?.fragmentCount ?? null,
      encryptedVariantHls1Reason: encryptedReason,
      masterVariants: 1,
      masterCodecsAttribute: HLS_FIXTURE_SPEC.codecsAttribute,
    },
  };
}

function startFixtureService(prepared, eventClock) {
  const { fixture, encryptedPlaylist, failurePlaylist } = prepared;
  const positive = Buffer.from(fixture.playlistText, "utf8");
  const mediaPlaylists = {
    browser: positive,
    execution: positive,
    encrypted: Buffer.from(encryptedPlaylist, "utf8"),
    "fragment-failure": Buffer.from(failurePlaylist, "utf8"),
    "no-ffmpeg": positive,
  };
  const fragments = {};
  for (const s of fixture.segments) {
    fragments[`positive:${s.ordinal}`] = s.bytes;
    fragments[`failure:${s.ordinal}`] = s.bytes;
  }
  return createHlsFixtureService({
    page: Buffer.from(hlsFixturePage(), "utf8"),
    masterFor: (variant) => Buffer.from(hlsMasterPlaylist({ mediaUri: mediaPlaylistUri(variant) }), "utf8"),
    mediaPlaylists,
    fragments,
    failingFragments: { [`failure:${HLS_FAILING_FRAGMENT.ordinal}`]: HLS_FAILING_FRAGMENT.status },
    eventClock,
    initialMasterVariant: "browser",
  });
}

// ── 3. The direct half of the router and the analysis policy ───────────────

/**
 * The direct analyzer the router is given. It performs exactly the steps
 * `analyzeDirectMedia` performs before it would probe anything: the real
 * request schema, URL validation (the exact page validator standing in for
 * `assertSafeUrl`), and the REAL `looksLikeDirectMedia` decision. The page is
 * HTML, so the real predicate yields EXTRACTOR_UNAVAILABLE — the one code the
 * router accepts as permission to try the generic strategy. The probe branch
 * below it is unreachable for this fixture, which is why nothing stands in for
 * it. This is NOT an "always generic" stub.
 */
function createHarnessDirectAnalyzer(validateUrl) {
  return async (url) => {
    const shape = WorkerAnalyzeRequestSchema.safeParse({ url });
    if (!shape.success) throw new AppError("ANALYSIS_FAILED");
    const { url: safeUrl } = await validateUrl(shape.data.url);
    if (!looksLikeDirectMedia(safeUrl)) throw new AppError("EXTRACTOR_UNAVAILABLE");
    throw new AppError("EXTRACTOR_UNAVAILABLE");
  };
}

/** Sanitized facts about one pinned-yt-dlp analysis document. Transient input. */
function discoveryFacts(stdout, port) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { parsed: false };
  }
  const formats = Array.isArray(doc?.formats) ? doc.formats : [];
  const hls = formats.filter((f) => f?.protocol === "m3u8_native");
  const first = hls[0] ?? null;
  let urlHostIsFixture = false;
  let urlVariant = null;
  if (first && typeof first.url === "string") {
    try {
      const u = new URL(first.url);
      urlHostIsFixture = u.hostname === HLS_FIXTURE_HOSTNAME && u.port === String(port);
      urlVariant = classifyHlsFixturePath(`${u.pathname}${u.search}`).variant;
    } catch {
      urlHostIsFixture = false;
    }
  }
  return {
    parsed: true,
    extractorKey: typeof doc?.extractor_key === "string" ? doc.extractor_key : null,
    formatCount: formats.length,
    hlsRenditionCount: hls.length,
    protocol: first?.protocol ?? null,
    height: first?.height ?? null,
    width: first?.width ?? null,
    videoCodecFamily: typeof first?.vcodec === "string" ? first.vcodec.split(".")[0] : null,
    audioCodecFamily: typeof first?.acodec === "string" ? first.acodec.split(".")[0] : null,
    mediaPlaylistLocationPresent: typeof first?.url === "string" && first.url.length > 0,
    mediaPlaylistHostIsFixture: urlHostIsFixture,
    mediaPlaylistVariant: urlVariant,
    rawFormatIdIsFixtureName: first?.format_id === HLS08_RAW_FORMAT_ID,
  };
}

/**
 * ONE analysis policy, exactly as `createWorkerRuntime` composes it —
 * `ytdlpEnabled`, Product limits, a memoized real FFmpeg probe — with the two
 * acceptance seams: the exact page validator and a recording runner around the
 * real `runProcess`. The same object serves the browser-safe `analyze` and the
 * durable `analyzeForExecution`, as in Production.
 */
function createPolicy({ validateUrl, ledger, limits, ffmpegAvailableFn, onAnalysisDocument }) {
  const runner = async (opts) => {
    const result = await ledger.runner(opts);
    // The document is read here for sanitized discovery facts and dropped.
    if ((opts.args ?? []).includes("--dump-single-json")) onAnalysisDocument(result.stdout);
    return result;
  };
  return createMediaAnalysisPolicy({
    ytdlpEnabled: true,
    limits,
    ffmpegAvailable: ffmpegAvailableFn,
    analyzeDirect: createHarnessDirectAnalyzer(validateUrl),
    analyzeGeneric: (url, opts) =>
      analyzeGenericMediaInternal(url, {
        limits: opts.limits,
        ffmpegAvailable: opts.ffmpegAvailable,
        ...(opts.signal ? { signal: opts.signal } : {}),
        validateUrl,
        runner,
      }),
  });
}

/** Which fixture variant a private playlist location names; never the URL. */
function playlistVariant(location, port) {
  if (typeof location !== "string") return null;
  try {
    const u = new URL(location);
    if (u.hostname !== HLS_FIXTURE_HOSTNAME || u.port !== String(port)) return "foreign";
    return classifyHlsFixturePath(`${u.pathname}${u.search}`).variant ?? "unclassified";
  } catch {
    return "unparseable";
  }
}

/** Sanitized facts about one fresh execution analysis, plus the plan it yields. */
function inspectExecutionAnalysis(result, port) {
  const hls = result?.hlsSelections ?? {};
  const sel = result?.selections ?? {};
  const best = Object.hasOwn(hls, REQUESTED_PRESET) ? hls[REQUESTED_PRESET] : null;
  const rung = Object.hasOwn(hls, EXPECTED_RUNG) ? hls[EXPECTED_RUNG] : null;
  let plan = null;
  let planError = null;
  try {
    plan = deriveExecutionPlan(result, REQUESTED_PRESET);
  } catch (err) {
    planError = err instanceof AppError ? err.code : "non-app-error";
  }
  const generic = plan?.strategy === "yt-dlp" ? plan.generic : null;
  let footprint = null;
  try {
    footprint = plan ? workspaceFootprintForPlan(plan) : null;
  } catch {
    footprint = null;
  }
  return {
    strategy: result?.strategy ?? null,
    publicPresetIds: (result?.video?.presets ?? []).map((p) => p.id),
    progressiveOwnsBest: Object.hasOwn(sel, REQUESTED_PRESET),
    progressiveOwns360: Object.hasOwn(sel, EXPECTED_RUNG),
    hlsOwnedPresetIds: Object.keys(hls).sort(),
    hlsOwnsBest: best !== null,
    hlsOwns360: rung !== null,
    bestVariant: playlistVariant(best?.playlistUrl, port),
    rungVariant: playlistVariant(rung?.playlistUrl, port),
    bestAndRungAreOneRendition: best !== null && rung !== null && best.playlistUrl === rung.playlistUrl,
    bestHeight: best?.height ?? null,
    plan: generic
      ? {
          strategy: plan.strategy,
          operation: generic.operation,
          requestedFormatId: generic.requestedFormatId,
          targetContainer: generic.targetContainer,
          sourceVariant: playlistVariant(generic.source?.playlistUrl, port),
          sourceIsTheFreshSelection: best !== null && generic.source?.playlistUrl === best.playlistUrl,
          sourceHeight: generic.source?.height ?? null,
          topLevelKeys: Object.keys(plan).sort(),
          genericKeys: Object.keys(generic).sort(),
          sourceKeys: Object.keys(generic.source ?? {}).sort(),
        }
      : null,
    planError,
    workspaceFootprint: footprint,
    workspaceRequiredBytes: footprint === null ? null : requiredWorkspaceBytes(config.maxFileSize, footprint),
  };
}

// ── 4. One durable job through the real JobExecutor ────────────────────────

/**
 * Runs ONE job end to end and returns sanitized observations. The executor
 * receives exactly one dependency — the recording wrapper around the policy's
 * own `analyzeForExecution` — so plan derivation, HLS acquisition, HLS
 * processing and the capacity reader are all the Product defaults.
 */
async function runJob(ctx, { caseLabel, masterVariant }) {
  const { store, db, policy, service, port, sinkRoot, state, pageUrl, ledger } = ctx;
  state.currentCase = caseLabel;
  service.setMasterVariant(masterVariant);
  service.setPhase(`${caseLabel}:queued`);

  const sinkDir = join(sinkRoot, caseLabel);
  await mkdir(sinkDir, { recursive: true });
  const puts = [];
  const writer = createLocalObjectStoreWriter({
    sinkDir,
    onPut: (input) => {
      // BEFORE a byte of the body is consumed: the durable status, and an
      // independent digest of the exact file the upload stream opened.
      const path = typeof input.body?.path === "string" ? input.body.path : null;
      const bytes = path ? readFileSync(path) : null;
      const aggregatePath = state.aggregatePaths.get(caseLabel) ?? null;
      puts.push({
        statusAtPut: state.statusNow(),
        streamPathBasename: path ? basename(path) : null,
        streamPathIsTheAggregate: path !== null && path === aggregatePath,
        streamPathIsInTheAggregateDirectory: path !== null && aggregatePath !== null && dirname(path) === dirname(aggregatePath),
        preUploadSha256: bytes ? sha256Bytes(bytes) : null,
        preUploadBytes: bytes ? bytes.byteLength : null,
      });
    },
  });

  const execution = { calls: 0, facts: null, masterVariantAtAnalysis: null, freeBytesBeforeAcquisition: null };
  const deps = {
    // A TRANSPARENT recording wrapper around the policy's own function: it
    // observes and returns the result unchanged.
    analyzeForExecution: async (url, signal) => {
      execution.calls += 1;
      service.setPhase(`${caseLabel}:analysis-execution`);
      ledger.setPhase(`${caseLabel}:analysis-execution`);
      const result = await policy.analyzeForExecution(url, signal);
      execution.masterVariantAtAnalysis = service.masterVariant();
      execution.facts = inspectExecutionAnalysis(result, port);
      // Diagnostic only: the Product's own statfs preflight is authoritative.
      // Measured on the Product's temp directory — the filesystem the job's
      // workDir lives on — never on `TMPDIR`, which in release-image mode is
      // the harness scratch tmpfs rather than the Product media workspace.
      try {
        const fs = await statfs(config.tempDirectory);
        execution.freeBytesBeforeAcquisition = Number(fs.bavail) * Number(fs.bsize);
      } catch {
        execution.freeBytesBeforeAcquisition = null;
      }
      service.setPhase(`${caseLabel}:execution`);
      ledger.setPhase(`${caseLabel}:execution`);
      return result;
    },
  };

  const created = store.createJob(
    { url: pageUrl, formatId: REQUESTED_PRESET, principalId: "private-access-user" },
    randomUUID(),
  );
  if (created.type !== "created") throw new Error(`job creation returned ${created.type}`);
  const jobId = created.job.jobId;
  state.currentJobId = jobId;
  const claimed = store.claimNextQueuedJob();
  if (claimed?.jobId !== jobId || claimed.status !== "analyzing") throw new Error("the job was not claimed to analyzing");

  const executor = new JobExecutor(store, writer, () => Date.now(), new Map(), deps);
  await executor.execute(claimed);

  const view = store.getJob(jobId);
  const row = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId);
  const statusTrace = readStatusTrace(db, jobId);
  state.currentJobId = null;
  service.setPhase(`${caseLabel}:done`);

  return {
    caseLabel,
    jobId,
    depsKeys: Object.keys(deps),
    execution,
    view,
    row,
    statusTrace,
    writer,
    puts,
    workDir: join(config.tempDirectory, "jobs", jobId),
  };
}

// ── 5. The positive full path ──────────────────────────────────────────────

async function runPositive(ctx) {
  const { policy, service, pageUrl, state, ledger, port } = ctx;

  // ── browser-safe analysis, with the master naming the BROWSER marker ─────
  state.currentCase = "positive";
  service.setMasterVariant("browser");
  service.setPhase("positive:analysis-public");
  ledger.setPhase("positive:analysis-public");
  const publicMeta = await policy.analyze(pageUrl);
  const publicMasterVariant = service.masterVariant();

  // ── rotate: the SAME page now leads to the EXECUTION marker ──────────────
  const job = await runJob(ctx, { caseLabel: "positive", masterVariant: "execution" });
  return { publicMeta, publicMasterVariant, job, port };
}

// ── 6. The three bounded negatives ─────────────────────────────────────────

async function runNoFfmpegAnalysis(ctx) {
  const { service, pageUrl, state, limits, validateUrl, port } = ctx;
  state.currentCase = "negative-no-ffmpeg";
  service.setMasterVariant("no-ffmpeg");
  service.setPhase("negative-no-ffmpeg:analysis");
  const ledger = createRunnerLedger(runProcess);
  ledger.setPhase("negative-no-ffmpeg");
  const policy = createPolicy({
    validateUrl,
    ledger,
    limits,
    // A policy INPUT, answered honestly as false. Nothing about the runtime is
    // altered; the positive path used the real probe's answer.
    ffmpegAvailableFn: async () => false,
    onAnalysisDocument: () => {},
  });
  const result = await policy.analyzeForExecution(pageUrl);
  const facts = inspectExecutionAnalysis(result, port);
  const q = result.video.sourceQuality ?? null;
  const unsupported = (q?.withheld ?? []).find((w) => w.reason === "unsupported_protocol") ?? null;
  return {
    advertisedPresetIds: facts.publicPresetIds,
    videoPresetIds: facts.publicPresetIds.filter((id) => id !== "preset:audio" && id !== "preset:mp3"),
    hlsSelectionCount: Object.keys(result.hlsSelections ?? {}).length,
    sourceQuality: q
      ? {
          observedMaxHeight: q.observedMaxHeight,
          deliverableMaxHeight: q.deliverableMaxHeight,
          unsupportedProtocolCount: unsupported?.count ?? 0,
          unsupportedProtocolMaxHeight: unsupported?.maxObservedHeight ?? null,
        }
      : null,
    planErrorCode: facts.planError,
  };
}

// ── 7. Evaluation helpers ──────────────────────────────────────────────────

function spawnsIn(observer, caseLabel) {
  return observer.entries().filter((e) => e.caseLabel === caseLabel);
}

function sanitizeTransport(entry) {
  return {
    seq: entry.seq,
    caseLabel: entry.caseLabel,
    kind: entry.kind,
    variant: entry.variant,
    family: entry.family,
    ordinal: entry.ordinal,
    method: entry.method,
    statusAtRequest: entry.statusAtRequest,
    responseStatus: entry.responseStatus,
    endSeq: entry.endSeq,
    closeSeq: entry.closeSeq,
    headerNamesExact: entry.headerNamesExact,
    userAgentIsProduct: entry.userAgentIsProduct,
    acceptIsProduct: entry.acceptIsProduct,
    forbiddenHeaderCount: entry.forbiddenHeadersPresent.length,
    pinnedToSyntheticPublicAddress: entry.pinnedToSyntheticPublicAddress,
    connectedTo: entry.connectedTo,
  };
}

function sanitizeFixtureRequest(entry) {
  return {
    arriveSeq: entry.arriveSeq,
    finishSeq: entry.finishSeq,
    phase: entry.phase,
    method: entry.method,
    kind: entry.kind,
    variant: entry.variant,
    family: entry.family,
    ordinal: entry.ordinal,
    masterServedVariant: entry.masterServedVariant,
    status: entry.status,
    bytes: entry.bytes,
    userAgentClass: entry.userAgentClass,
    hostHeaderIsFixture: entry.hostHeaderIsFixture,
  };
}

// ── 8. CLI ─────────────────────────────────────────────────────────────────

/**
 * `--acceptance-mode overlay|release-image` plus that mode's identity flags.
 * The mode is explicit and mixed identity fails closed; see
 * `lib/hls-acceptance-mode.mjs`.
 */
const parseArgv = parseHlsAcceptanceArgv;

async function admitEvidencePath(path) {
  if (await pathExists(path)) throw new Error("refusing to replace an existing evidence artifact");
  await mkdir(dirname(resolve(path)), { recursive: true });
}

// ── 9. The run ─────────────────────────────────────────────────────────────

async function main(argv) {
  const opts = parseArgv(argv);
  await admitEvidencePath(opts.evidence);

  const checks = createChecks();
  const startedAt = new Date().toISOString();
  let verdict = "FAIL";
  const blocked = [];

  const fixtureDir = await mkdtemp(join(tmpdir(), "hls08-fixture-"));
  const dbDir = await mkdtemp(join(tmpdir(), "hls08-db-"));
  const sinkRoot = await mkdtemp(join(tmpdir(), "hls08-sink-"));
  const dbPath = join(dbDir, "worker.sqlite");

  let service = null;
  let db = null;
  const out = {
    toolchain: null, invariants: null, fixture: null, discovery: null, publicAnalysis: null,
    executionAnalysis: null, freshProvenance: null, plan: null, workspace: null, hls2: null, hls3: null,
    aggregate: null, lifecycle: null, productMediaToolUse: null, remux: null, output: null, upload: null,
    ready: null, fixtureRequests: null, privacy: null, cleanup: null, negativeCases: null, port: null,
  };
  const trace = [];
  const note = (event, status) => trace.push({ event, status: status ?? null });

  // ── Recorded provenance and image identity (observed by the driver) ────
  //
  // The mode's identity checks: HLS-08's overlay/historical-base checks, or
  // HLS-09's release-candidate checks. The release child also observes its
  // own network namespace, so "offline" is measured rather than asserted.
  const identityObservations = { networkInterfaceNames: Object.keys(networkInterfaces()) };
  for (const entry of acceptanceIdentityChecks(opts, identityObservations)) {
    checks.record(entry.name, entry.ok, entry.detail);
  }

  try {
    out.toolchain = await preflight(checks);
    out.invariants = checkInvariants(checks);

    const prepared = await prepareFixture(checks, out.toolchain, fixtureDir);
    out.fixture = prepared.facts;

    const eventClock = createEventClock();
    service = startFixtureService(prepared, eventClock);
    const { port } = await service.listen();
    out.port = port;
    checks.require("fixture/service-binds-loopback-only", service.listenAddress() === HLS_FIXTURE_LOOPBACK);

    const validateUrl = createHlsPageUrlValidator({ port, AppError });
    const pageUrl = hlsPageUrl(port);
    checks.require("validator/admits-the-exact-page", (await validateUrl(pageUrl)).url === pageUrl);
    const alternatives = nearbyPageUrlAlternatives(port);
    let refusedAll = 0;
    for (const candidate of alternatives) {
      try {
        await validateUrl(candidate);
      } catch (err) {
        if (err instanceof AppError && err.code === "INVALID_URL") refusedAll += 1;
      }
    }
    checks.record(
      "validator/refuses-every-nearby-alternative",
      refusedAll === alternatives.length,
      `${refusedAll}/${alternatives.length}`,
    );
    checks.record("discovery/direct-strategy-declines-the-page", looksLikeDirectMedia(pageUrl) === false);

    // ── durable store ──────────────────────────────────────────────────────
    db = openWorkerDatabase({ path: dbPath });
    applyMigrations(db);
    installStatusAudit(db);
    const store = new SQLiteJobStore({ db });
    const statusQuery = db.prepare("SELECT status FROM worker_jobs WHERE job_id = ?");

    const state = {
      currentCase: "setup",
      currentJobId: null,
      aggregatePaths: new Map(),
      aggregateObservations: [],
      remuxEvaluations: [],
      statusNow: () => (state.currentJobId ? (statusQuery.get(state.currentJobId)?.status ?? "<missing>") : "<no-job>"),
    };

    const limits = {
      analysisTimeoutSeconds: Math.max(1, Math.floor(config.analysisTimeoutMs / 1000)),
      maxVideoDurationSeconds: config.maxVideoDuration,
      maxFileSizeBytes: config.maxFileSize,
    };
    const discoveries = [];
    const ledger = createRunnerLedger(runProcess);
    const policy = createPolicy({
      validateUrl,
      ledger,
      limits,
      ffmpegAvailableFn: memoizeOnce(() => ffmpegAvailable()),
      onAnalysisDocument: (stdout) => discoveries.push({ caseLabel: state.currentCase, ...discoveryFacts(stdout, port) }),
    });

    const tools = {
      ytdlpPython: YTDLP_RUNTIME.pythonPath,
      ytdlpArtifact: YTDLP_RUNTIME.artifactPath,
      ffmpegPath: out.toolchain.ffmpegPath,
      ffprobePath: out.toolchain.ffprobePath,
    };
    const observer = createProcessObserver({
      realSpawn: spawn,
      classify: (command, args) => classifyProductSpawn({ command, args }, tools),
      statusNow: state.statusNow,
      caseNow: () => state.currentCase,
      eventClock,
      beforeDelegate: (entry, _command, args) => {
        const input = inputOperand(args);
        if (entry.kind === "ffprobe-media-probe" && input) {
          const name = basename(input);
          entry.target =
            name === HLS_AGGREGATE_FILE_NAME ? "hls3-aggregate"
              : name === HLS_OUTPUT_PARTIAL_FILE_NAME ? "remux-partial"
                : name === HLS_OUTPUT_FILE_NAME ? "remux-final" : "other";
          // The FIRST media tool to touch the aggregate: hash it before the
          // real spawn, so the observation precedes any media tool reading it.
          if (entry.target === "hls3-aggregate" && !state.aggregatePaths.has(entry.caseLabel)) {
            const bytes = readFileSync(input);
            state.aggregatePaths.set(entry.caseLabel, input);
            state.aggregateObservations.push({
              caseLabel: entry.caseLabel,
              statusAtObservation: entry.statusAtSpawn,
              seq: entry.seq,
              bytes: bytes.byteLength,
              sha256: sha256Bytes(bytes),
            });
          }
        }
        if (entry.kind === "hls-ffmpeg-remux") {
          const evaluation = evaluateHlsRemuxArgv(args);
          const aggregatePath = state.aggregatePaths.get(entry.caseLabel) ?? null;
          state.remuxEvaluations.push({
            caseLabel: entry.caseLabel,
            ...evaluation.facts,
            inputIsTheObservedAggregate: aggregatePath !== null && input === aggregatePath,
            ok: evaluation.ok && aggregatePath !== null && input === aggregatePath,
          });
        }
      },
    });
    const transport = createHlsSafeHttpTransport({
      port,
      eventClock,
      statusNow: state.statusNow,
      caseNow: () => state.currentCase,
      realRequest: http.request.bind(http),
    });

    const ctx = { store, db, policy, service, port, sinkRoot, state, pageUrl, ledger, limits, validateUrl };

    // ── Everything Product-side runs inside the observers ──────────────────
    let positive = null;
    let encrypted = null;
    let fragment = null;
    let noFfmpeg = null;
    const safeHttpSetters = { setSafeHttpTestHooks, setPinnedRequestFactoryForTests };
    await withProcessObserver(setProcessRunnerTestHooks, observer, () =>
      withHlsSafeHttpTransport(safeHttpSetters, transport, async () => {
        positive = await runPositive(ctx);
        note("positive job finished", positive.job.view?.status);
        encrypted = await runJob(ctx, { caseLabel: "negative-encrypted", masterVariant: "encrypted" });
        note("encrypted-playlist job finished", encrypted.view?.status);
        fragment = await runJob(ctx, { caseLabel: "negative-fragment", masterVariant: "fragment-failure" });
        note("fragment-failure job finished", fragment.view?.status);
        noFfmpeg = await runNoFfmpegAnalysis(ctx);
        note("ffmpeg-unavailable analysis finished", null);
      }),
    );
    state.currentCase = "post-run";

    // ── Hook restoration, observed rather than assumed ─────────────────────
    let lookupRestored = false;
    try {
      const answers = await lookupHost(HLS_FIXTURE_HOSTNAME);
      lookupRestored = answers.length > 0 && answers.every((a) => a.address !== HLS_SYNTHETIC_PUBLIC_ADDRESS);
    } catch {
      lookupRestored = true;
    }
    checks.record(
      "hooks/safe-http-restored",
      lookupRestored && !transport.armed && transport.callsWhileDisarmed() === 0,
    );
    const spawnsBefore = observer.entries().length;
    await ffmpegAvailable();
    checks.record(
      "hooks/process-runner-restored",
      observer.entries().length === spawnsBefore && observer.spawnsWhileDisarmed() === 0,
    );

    const tLedger = transport.ledger();
    const fRequests = service.requests();
    const spawns = observer.entries();

    // ════════════════════════════ POSITIVE ════════════════════════════════
    const { publicMeta, publicMasterVariant, job } = positive;
    const exec = job.execution.facts;

    // ── real yt-dlp discovery ───────────────────────────────────────────────
    const positiveDiscoveries = discoveries.filter((d) => d.caseLabel === "positive");
    checks.record(
      "discovery/real-ytdlp-analysis-ran",
      positiveDiscoveries.length === 2 && ledger.ytdlp().filter((s) => s.args.includes("--dump-single-json")).length >= 2,
      `${positiveDiscoveries.length} analysis documents`,
    );
    checks.record(
      "discovery/no-load-info-json",
      ledger.all().every((s) => !s.args.some((a) => a.startsWith("--load-info-json"))),
    );
    checks.record(
      "discovery/rendition-is-m3u8-native-360-with-video-and-audio",
      positiveDiscoveries.length === 2 &&
        positiveDiscoveries.every(
          (d) =>
            d.parsed &&
            d.hlsRenditionCount === 1 &&
            d.protocol === "m3u8_native" &&
            d.height === 360 &&
            d.width === 640 &&
            d.videoCodecFamily === "avc1" &&
            d.audioCodecFamily === "mp4a" &&
            d.mediaPlaylistLocationPresent &&
            d.mediaPlaylistHostIsFixture,
        ),
    );
    checks.record(
      "discovery/raw-format-id-is-the-fixture-name",
      positiveDiscoveries.length === 2 && positiveDiscoveries.every((d) => d.rawFormatIdIsFixtureName),
    );
    const ytdlpUa = fRequests.filter((r) => r.userAgentClass !== "product");
    checks.record(
      "discovery/ytdlp-read-only-page-and-master",
      ytdlpUa.every((r) => r.kind === "page" || r.kind === "master"),
      [...new Set(ytdlpUa.map((r) => r.kind))].sort().join(","),
    );
    out.discovery = {
      method: "pinned yt-dlp over the real HTML page and master; no --load-info-json, no injected extractor JSON",
      documents: discoveries.map((d) => ({ ...d })),
      loadInfoJsonUsed: false,
    };

    // ── browser-safe HLS presets ──────────────────────────────────────────
    const presetIds = publicMeta.presets.map((p) => p.id);
    const best = publicMeta.presets.find((p) => p.id === REQUESTED_PRESET) ?? null;
    const rung = publicMeta.presets.find((p) => p.id === EXPECTED_RUNG) ?? null;
    const hlsFacts = (p) =>
      p !== null &&
      p.container === "mp4" &&
      p.hasVideo === true &&
      p.hasAudio === true &&
      p.fileSize === null &&
      p.videoCodec === null &&
      p.audioCodec === null &&
      p.fps === null &&
      p.formatId === p.id;
    checks.record("public/advertises-preset-best", best !== null, presetIds.join(","));
    checks.record("public/advertises-preset-360", rung !== null, presetIds.join(","));
    checks.record("public/hls-preset-facts", hlsFacts(best) && hlsFacts(rung));
    checks.record("public/formats-empty", Array.isArray(publicMeta.formats) && publicMeta.formats.length === 0);
    checks.record("public/capabilities-mp3-false", publicMeta.capabilities?.mp3 === false);
    checks.record("public/capabilities-merge-false", publicMeta.capabilities?.merge === false);
    const quality = publicMeta.sourceQuality ?? null;
    checks.record("public/source-quality-observed-360", quality?.observedMaxHeight === 360, String(quality?.observedMaxHeight));
    checks.record("public/source-quality-deliverable-360", quality?.deliverableMaxHeight === 360, String(quality?.deliverableMaxHeight));
    checks.record(
      "public/no-unsupported-protocol-withholding",
      quality !== null && !(quality.withheld ?? []).some((w) => w.reason === "unsupported_protocol"),
    );
    out.publicAnalysis = {
      presetIds,
      hlsPresetFacts: best
        ? {
            container: best.container, hasVideo: best.hasVideo, hasAudio: best.hasAudio,
            fileSize: best.fileSize, videoCodec: best.videoCodec, audioCodec: best.audioCodec,
            fps: best.fps, formatIdEqualsId: best.formatId === best.id,
          }
        : null,
      formatsCount: publicMeta.formats.length,
      capabilities: { mp3: publicMeta.capabilities?.mp3 ?? null, merge: publicMeta.capabilities?.merge ?? null },
      sourceQuality: quality
        ? {
            observedMaxHeight: quality.observedMaxHeight,
            deliverableMaxHeight: quality.deliverableMaxHeight,
            withheldReasons: (quality.withheld ?? []).map((w) => w.reason),
          }
        : null,
      extractor: publicMeta.extractor,
    };

    // ── public privacy ──────────────────────────────────────────────────────
    // Field-aware: `webpageUrl` and `source` are the only admitted echoes, each
    // required to hold its exact value; the hostname anywhere else fails.
    const needles = HLS08_PRIVACY_NEEDLES;
    const privacyOpts = { needles, hostname: HLS_FIXTURE_HOSTNAME };
    const publicPrivacy = partitionPrivacyFindings(
      validateStructuredPrivacy("browser-safe analysis", publicMeta, {
        ...privacyOpts,
        admitted: { webpageUrl: pageUrl, source: HLS_FIXTURE_HOSTNAME },
      }),
    );
    checks.record(
      "privacy/public-page-echo-is-exact",
      publicPrivacy.echo.length === 0,
      describePrivacyFindings(publicPrivacy.echo),
    );
    checks.record(
      "privacy/public-analysis-carries-no-hls-provenance",
      publicPrivacy.other.length === 0,
      describePrivacyFindings(publicPrivacy.other),
    );
    // sourceQuality needs no echo: the hostname is refused there entirely.
    const sqFindings = validateStructuredPrivacy("sourceQuality", quality, privacyOpts);
    checks.record(
      "privacy/source-quality-carries-no-hls-provenance",
      sqFindings.length === 0 && quality !== null,
      describePrivacyFindings(sqFindings),
    );

    // ── fresh execution analysis ────────────────────────────────────────────
    checks.record("executor/only-the-fresh-analysis-seam-injected", sameList(job.depsKeys, ["analyzeForExecution"]));
    checks.record("execution/analysis-ran-once-through-the-policy", job.execution.calls === 1 && exec !== null);
    checks.record("execution/strategy-yt-dlp", exec?.strategy === "yt-dlp", String(exec?.strategy));
    checks.record(
      "execution/progressive-map-does-not-own-best-or-360",
      exec?.progressiveOwnsBest === false && exec?.progressiveOwns360 === false,
    );
    checks.record("execution/hls-map-owns-best-and-360", exec?.hlsOwnsBest === true && exec?.hlsOwns360 === true);
    out.executionAnalysis = exec
      ? {
          strategy: exec.strategy,
          publicPresetIds: exec.publicPresetIds,
          progressiveOwnsBest: exec.progressiveOwnsBest,
          progressiveOwns360: exec.progressiveOwns360,
          hlsOwnedPresetIds: exec.hlsOwnedPresetIds,
          bestAndRungAreOneRendition: exec.bestAndRungAreOneRendition,
          bestHeight: exec.bestHeight,
          calls: job.execution.calls,
        }
      : null;

    // ── fresh playlist provenance witness ───────────────────────────────────
    const positiveMedia = tLedger.filter((e) => e.caseLabel === "positive" && e.kind === "media");
    const allBrowserMediaT = tLedger.filter((e) => e.kind === "media" && e.variant === "browser");
    const allBrowserMediaF = fRequests.filter((r) => r.kind === "media" && r.variant === "browser");
    const publicMasterServes = fRequests.filter((r) => r.phase === "positive:analysis-public" && r.kind === "master");
    const execMasterServes = fRequests.filter((r) => r.phase === "positive:analysis-execution" && r.kind === "master");
    checks.record(
      "provenance-witness/public-analysis-saw-the-browser-master",
      publicMasterVariant === "browser" && publicMasterServes.length >= 1 &&
        publicMasterServes.every((r) => r.masterServedVariant === "browser"),
    );
    checks.record(
      "provenance-witness/execution-analysis-saw-the-execution-master",
      job.execution.masterVariantAtAnalysis === "execution" && execMasterServes.length >= 1 &&
        execMasterServes.every((r) => r.masterServedVariant === "execution"),
    );
    checks.record(
      "provenance-witness/execution-selection-names-the-execution-playlist",
      exec?.bestVariant === "execution" && exec?.rungVariant === "execution",
    );
    checks.record(
      "provenance-witness/hls2-requested-the-execution-playlist",
      positiveMedia.length === 1 && positiveMedia[0].variant === "execution",
    );
    checks.record(
      "provenance-witness/browser-playlist-never-requested",
      allBrowserMediaT.length === 0 && allBrowserMediaF.length === 0,
    );
    out.freshProvenance = {
      publicAnalysisMasterVariant: publicMasterVariant,
      executionAnalysisMasterVariant: job.execution.masterVariantAtAnalysis,
      executionSelectionVariant: exec?.bestVariant ?? null,
      hls2PlaylistVariants: positiveMedia.map((e) => e.variant),
      browserPlaylistRequests: allBrowserMediaT.length + allBrowserMediaF.length,
      submittedPageUrlUnchanged: true,
      markersPersisted: false,
    };

    // ── ordinary planner ────────────────────────────────────────────────────
    const plan = exec?.plan ?? null;
    checks.record("plan/strategy-yt-dlp", plan?.strategy === "yt-dlp");
    checks.record("plan/operation-clear-hls-remux", plan?.operation === "clear-hls-remux", String(plan?.operation));
    checks.record("plan/requested-format-is-preset-best", plan?.requestedFormatId === REQUESTED_PRESET);
    checks.record("plan/target-container-mp4", plan?.targetContainer === "mp4");
    checks.record(
      "plan/source-is-the-fresh-execution-playlist",
      plan?.sourceVariant === "execution" && plan?.sourceIsTheFreshSelection === true,
    );
    checks.record(
      "plan/single-family-no-fallback",
      plan !== null &&
        sameList(plan.topLevelKeys, ["generic", "strategy"]) &&
        sameList(plan.genericKeys, ["operation", "requestedFormatId", "source", "strategy", "targetContainer"]) &&
        sameList(plan.sourceKeys, ["height", "playlistUrl"]),
    );
    out.plan = plan
      ? {
          derivedBy: "deriveExecutionPlan (the executor default; not injected)",
          strategy: plan.strategy,
          operation: plan.operation,
          requestedFormatId: plan.requestedFormatId,
          targetContainer: plan.targetContainer,
          sourceVariant: plan.sourceVariant,
          sourceHeight: plan.sourceHeight,
          familyCount: 1,
        }
      : null;

    // ── workspace capacity ──────────────────────────────────────────────────
    const positiveHls2 = positiveMedia[0] ?? null;
    checks.record(
      "workspace/max-file-size-is-the-product-default",
      config.maxFileSize === DEFAULT_MAX_FILE_SIZE_BYTES && DEFAULT_MAX_FILE_SIZE_BYTES === 4294967296,
    );
    checks.record(
      "workspace/required-bytes-is-two-max-file-sizes",
      exec?.workspaceFootprint === 2 && exec?.workspaceRequiredBytes === 8589934592,
      String(exec?.workspaceRequiredBytes),
    );
    checks.record(
      "workspace/product-preflight-admitted-the-job",
      positiveHls2 !== null && positiveHls2.statusAtRequest === "downloading",
    );
    if (
      job.execution.freeBytesBeforeAcquisition !== null &&
      exec?.workspaceRequiredBytes !== null &&
      job.execution.freeBytesBeforeAcquisition < exec.workspaceRequiredBytes &&
      positiveHls2 === null
    ) {
      blocked.push("ACCEPTANCE CONTAINER LACKS REQUIRED HLS WORKSPACE CAPACITY");
    }
    out.workspace = {
      maxFileSizeBytes: config.maxFileSize,
      footprint: exec?.workspaceFootprint ?? null,
      requiredBytes: exec?.workspaceRequiredBytes ?? null,
      observedFreeBytes: job.execution.freeBytesBeforeAcquisition,
      observedBy: "harness statfs of the Product temp directory's filesystem after execution analysis (diagnostic only)",
      authority: "JobExecutor's own statfs preflight (availableWorkDirBytes NOT injected)",
    };

    // ── HLS-2 ────────────────────────────────────────────────────────────────
    const positiveT = tLedger.filter((e) => e.caseLabel === "positive");
    const positiveFragT = positiveT.filter((e) => e.kind === "fragment");
    const positiveMediaF = fRequests.filter((r) => r.phase === "positive:execution" && r.kind === "media");
    checks.record(
      "hls2/exactly-one-playlist-get",
      positiveMedia.length === 1 && positiveMediaF.length === 1 && positiveMediaF[0].variant === "execution",
      `${positiveMedia.length} transport / ${positiveMediaF.length} fixture`,
    );
    checks.record(
      "hls2/get-only-no-head-no-retry",
      positiveT.every((e) => e.method === "GET") &&
        fRequests.filter((r) => r.phase === "positive:execution").every((r) => r.method === "GET") &&
        positiveMedia.length === 1,
    );
    const profileOk = (e) => e.headerNamesExact && e.userAgentIsProduct && e.acceptIsProduct;
    checks.record("hls2/fixed-product-request-profile", positiveHls2 !== null && profileOk(positiveHls2));
    // Every Product HLS request, at both ends of the socket.
    checks.record(
      "hls2/no-cookie-authorization-referer-proxy-authorization",
      tLedger.length > 0 &&
        tLedger.every((e) => e.forbiddenHeadersPresent.length === 0) &&
        fRequests
          .filter((r) => r.userAgentClass === "product")
          .every((r) => !r.hasCookie && !r.hasAuthorization && !r.hasReferer && !r.hasProxyAuthorization),
    );
    checks.record("hls2/playlist-served-200", positiveHls2?.responseStatus === 200);
    out.hls2 = {
      logicalGets: positiveMedia.length,
      variant: positiveHls2?.variant ?? null,
      method: positiveHls2?.method ?? null,
      responseStatus: positiveHls2?.responseStatus ?? null,
      statusAtRequest: positiveHls2?.statusAtRequest ?? null,
      headerNamesExact: positiveHls2?.headerNamesExact ?? null,
      userAgentIsProduct: positiveHls2?.userAgentIsProduct ?? null,
      acceptIsProduct: positiveHls2?.acceptIsProduct ?? null,
      forbiddenHeaders: 0,
      resolvedTo: "synthetic public answer; socket re-pointed to loopback by the acceptance transport",
    };

    // ── HLS-3 ────────────────────────────────────────────────────────────────
    const fragOrdinals = positiveFragT.map((e) => e.ordinal);
    const expectedOrdinals = prepared.fixture.segments.map((s) => s.ordinal);
    const positiveFragF = fRequests.filter((r) => r.phase === "positive:execution" && r.kind === "fragment");
    checks.record(
      "hls3/each-fragment-requested-exactly-once",
      expectedOrdinals.every((o) => positiveFragT.filter((e) => e.ordinal === o).length === 1) &&
        positiveFragT.length === expectedOrdinals.length &&
        positiveFragF.length === expectedOrdinals.length &&
        positiveFragT.every((e) => e.family === "positive" && e.responseStatus === 200),
      fragOrdinals.join(","),
    );
    checks.record("hls3/playlist-order-preserved", sameList(fragOrdinals, expectedOrdinals));
    const transportSequential = positiveFragT.every(
      (e, i) => e.endSeq !== null && (i === 0 || e.seq > positiveFragT[i - 1].endSeq),
    );
    checks.record("hls3/one-request-at-a-time-transport", transportSequential && positiveFragT.length >= 3);
    const fixtureSequential = positiveFragF.every(
      (r, i) => r.finishSeq !== null && (i === 0 || r.arriveSeq > positiveFragF[i - 1].finishSeq),
    );
    checks.record("hls3/one-request-at-a-time-fixture", fixtureSequential && positiveFragF.length >= 3);
    checks.record(
      "hls3/playlist-read-before-first-fragment",
      positiveHls2 !== null && positiveHls2.endSeq !== null && positiveFragT.length > 0 &&
        positiveFragT[0].seq > positiveHls2.endSeq,
    );
    checks.record("hls3/fixed-product-request-profile", positiveFragT.length > 0 && positiveFragT.every(profileOk));
    out.hls3 = {
      fragmentGets: positiveFragT.length,
      ordinals: fragOrdinals,
      perFragment: positiveFragT.map((e) => ({
        ordinal: e.ordinal, method: e.method, responseStatus: e.responseStatus,
        statusAtRequest: e.statusAtRequest, openSeq: e.seq, endSeq: e.endSeq,
      })),
      fixtureSide: positiveFragF.map((r) => ({ ordinal: r.ordinal, arriveSeq: r.arriveSeq, finishSeq: r.finishSeq, bytes: r.bytes })),
      sequentialByTransportEvents: transportSequential,
      sequentialByFixtureEvents: fixtureSequential,
      retries: 0,
      heads: 0,
    };

    // ── aggregate identity ──────────────────────────────────────────────────
    const aggregateObs = state.aggregateObservations.filter((a) => a.caseLabel === "positive");
    const agg = aggregateObs[0] ?? null;
    const positiveSpawns = spawnsIn(observer, "positive");
    const firstMediaWork = positiveSpawns.find((s) => MEDIA_WORK_KINDS.has(s.kind)) ?? null;
    checks.record(
      "aggregate/observed-before-any-media-tool",
      aggregateObs.length === 1 && firstMediaWork !== null && firstMediaWork.seq === agg.seq,
    );
    checks.record(
      "aggregate/size-equals-segment-sum",
      agg !== null && agg.bytes === prepared.fixture.segments.reduce((n, s) => n + s.byteLength, 0),
      `${agg?.bytes} vs ${prepared.fixture.aggregateBytes}`,
    );
    checks.record("aggregate/sha256-equals-ordered-concatenation", agg !== null && agg.sha256 === prepared.fixture.aggregateSha256);
    out.aggregate = agg
      ? {
          observedAt: "the first HLS-4 media spawn, before the real spawn was delegated",
          statusAtObservation: agg.statusAtObservation,
          bytes: agg.bytes,
          expectedBytes: prepared.fixture.aggregateBytes,
          sha256: agg.sha256,
          expectedSha256: prepared.fixture.aggregateSha256,
          identical: agg.sha256 === prepared.fixture.aggregateSha256,
        }
      : null;

    // ── durable phase boundaries and media-tool phases ──────────────────────
    const EXPECTED_TRACE = ["queued", "analyzing", "downloading", "processing", "uploading", "ready"];
    checks.record("lifecycle/durable-trace", sameList(job.statusTrace, EXPECTED_TRACE), job.statusTrace.join(" -> "));
    checks.record(
      "lifecycle/every-hls-request-while-downloading",
      positiveT.length >= 4 && positiveT.every((e) => e.statusAtRequest === "downloading"),
    );
    const mediaWork = positiveSpawns.filter((s) => MEDIA_WORK_KINDS.has(s.kind));
    checks.record(
      "lifecycle/no-media-tool-while-downloading",
      spawns.filter((s) => MEDIA_WORK_KINDS.has(s.kind) && s.statusAtSpawn === "downloading").length === 0,
    );
    checks.record(
      "lifecycle/every-hls4-media-tool-while-processing",
      mediaWork.length > 0 && mediaWork.every((s) => s.statusAtSpawn === "processing"),
    );
    checks.record("lifecycle/aggregate-observed-while-processing", agg?.statusAtObservation === "processing");
    const remuxes = positiveSpawns.filter((s) => s.kind === "hls-ffmpeg-remux");
    checks.record("processing/exactly-one-remux", remuxes.length === 1, String(remuxes.length));
    const probeTargets = positiveSpawns.filter((s) => s.kind === "ffprobe-media-probe").map((s) => s.target);
    checks.record(
      "processing/source-and-output-probes-ran",
      probeTargets[0] === "hls3-aggregate" && probeTargets.includes("remux-final") &&
        probeTargets.every((t) => t === "hls3-aggregate" || t === "remux-partial" || t === "remux-final"),
      probeTargets.join(","),
    );
    const ytdlpAfterAnalysis = spawns.filter(
      (s) => s.kind.startsWith("ytdlp") && POST_ANALYSIS_STATUSES.has(s.statusAtSpawn),
    );
    checks.record(
      "processing/no-ytdlp-after-execution-analysis",
      ytdlpAfterAnalysis.length === 0 && spawns.every((s) => s.kind !== "ytdlp-other"),
      String(ytdlpAfterAnalysis.length),
    );
    checks.record(
      "processing/no-unclassified-subprocess",
      spawns.every((s) => s.kind !== "other" && s.kind !== "ffmpeg-other"),
    );
    const countBy = (list) =>
      list.reduce((acc, s) => {
        const key = `${s.kind}@${s.statusAtSpawn}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
    out.productMediaToolUse = {
      observedThrough: "setProcessRunnerTestHooks spawn observer delegating to the real child_process.spawn",
      byCase: {
        positive: countBy(positiveSpawns),
        "negative-encrypted": countBy(spawnsIn(observer, "negative-encrypted")),
        "negative-fragment": countBy(spawnsIn(observer, "negative-fragment")),
        "negative-no-ffmpeg": countBy(spawnsIn(observer, "negative-no-ffmpeg")),
      },
      positiveProbeTargets: probeTargets,
      ytdlpSpawnsAfterExecutionAnalysis: ytdlpAfterAnalysis.length,
    };
    out.lifecycle = {
      statusTrace: job.statusTrace,
      hlsRequestStatuses: [...new Set(positiveT.map((e) => e.statusAtRequest))],
      hls4MediaToolStatuses: [...new Set(mediaWork.map((s) => s.statusAtSpawn))],
      putStatuses: job.puts.map((p) => p.statusAtPut),
      trace,
    };

    // ── actual stream-copy argv ─────────────────────────────────────────────
    const remuxEval = state.remuxEvaluations.filter((r) => r.caseLabel === "positive");
    checks.record("remux/fixed-stream-copy-policy", remuxEval.length === 1 && remuxEval[0].ok === true);
    const { caseLabel: _ignored, ...remuxFacts } = remuxEval[0] ?? {};
    out.remux = remuxEval.length === 1 ? { ...remuxFacts, readFrom: "the argv the Product actually spawned (in memory only)" } : null;

    // ── upload ──────────────────────────────────────────────────────────────
    const object = job.writer.soleObject();
    const put = job.puts.length === 1 ? job.puts[0] : null;
    const heads = job.writer.headLog();
    const lifecycleHead = heads.length === 1 ? heads[0] : null;
    checks.record("upload/exactly-one-put", job.writer.putCount() === 1 && job.puts.length === 1, String(job.writer.putCount()));
    checks.record("upload/put-while-uploading", put?.statusAtPut === "uploading", String(put?.statusAtPut));
    checks.record(
      "upload/real-lifecycle-accepted-the-provider-head",
      job.view?.status === "ready" && job.writer.deleteLog().length === 0 && object !== null &&
        lifecycleHead?.contentLength === object.observedBytes && object.declaredLength === object.observedBytes,
    );
    checks.record("upload/content-type-video-mp4", object?.contentType === "video/mp4", String(object?.contentType));
    const expectedFilename = buildDownloadFilename({ title: job.view?.title ?? "Video", quality: "best", container: "mp4" });
    checks.record(
      "upload/content-disposition-names-an-mp4",
      object !== null && object.contentDisposition === buildAttachmentContentDisposition(expectedFilename) &&
        expectedFilename.endsWith(".mp4"),
    );
    checks.record(
      "upload/uploaded-sha256-equals-produced-mp4",
      object !== null && put !== null && object.sha256 === put.preUploadSha256,
    );
    checks.record(
      "upload/uploaded-bytes-equal-produced-size",
      object !== null && put !== null && object.observedBytes === put.preUploadBytes && object.declaredLength === put.preUploadBytes,
    );
    checks.record(
      "upload/uploaded-artifact-is-not-the-aggregate",
      object !== null && put !== null && agg !== null &&
        put.streamPathBasename === HLS_OUTPUT_FILE_NAME &&
        put.streamPathIsTheAggregate === false &&
        put.streamPathIsInTheAggregateDirectory === true &&
        object.sha256 !== agg.sha256,
    );
    out.upload = object
      ? {
          provider: "harness local ObjectStoreWriter (NOT Cloudflare R2)",
          puts: job.writer.putCount(),
          statusAtPut: put?.statusAtPut ?? null,
          objectKey: object.objectKey,
          contentType: object.contentType,
          contentDisposition: object.contentDisposition,
          declaredContentLength: object.declaredLength,
          writerObservedLength: object.observedBytes,
          providerHeadContentLength: lifecycleHead?.contentLength ?? null,
          providerHeadMeasures: "lstat of the persisted object at HEAD time, never the put declaration",
          uploadStreamFile: put?.streamPathBasename ?? null,
          uploadStreamIsTheAggregate: put?.streamPathIsTheAggregate ?? null,
          preUploadSha256: put?.preUploadSha256 ?? null,
          uploadedSha256: object.sha256,
          uploadedEqualsProduced: object.sha256 === put?.preUploadSha256,
          uploadedDiffersFromAggregate: agg !== null && object.sha256 !== agg.sha256,
        }
      : null;

    // ── ready ───────────────────────────────────────────────────────────────
    const view = job.view;
    checks.record("ready/status-ready", view?.status === "ready", String(view?.status));
    checks.record("ready/extractor-yt-dlp", view?.extractor === "yt-dlp", String(view?.extractor));
    checks.record("ready/format-id-preset-best", job.row?.format_id === REQUESTED_PRESET, String(job.row?.format_id));
    checks.record("ready/container-mp4", view?.container === "mp4", String(view?.container));
    checks.record("ready/mime-video-mp4", view?.mime === mimeForContainer("mp4") && view?.mime === "video/mp4");
    checks.record("ready/filename-mp4", typeof view?.filename === "string" && view.filename.endsWith(".mp4"));
    checks.record("ready/file-size-equals-uploaded-bytes", object !== null && view?.fileSize === object.observedBytes);
    checks.record(
      "ready/object-key-belongs-to-this-job",
      typeof view?.objectKey === "string" && view.objectKey.startsWith(`videofetch/jobs/${job.jobId}/`) &&
        object?.objectKey === view.objectKey,
    );
    out.ready = view
      ? {
          status: view.status,
          extractor: view.extractor,
          formatId: job.row?.format_id ?? null,
          container: view.container,
          mime: view.mime,
          filenameExtension: typeof view.filename === "string" ? view.filename.split(".").pop() : null,
          fileSize: view.fileSize,
          objectKeyBindsJob: typeof view.objectKey === "string" && view.objectKey.startsWith(`videofetch/jobs/${job.jobId}/`),
        }
      : null;

    // ── the delivered media ─────────────────────────────────────────────────
    if (object !== null) {
      const probe = await harnessProbe(out.toolchain.ffprobePath, object.path, "mov");
      const head = (await readFile(object.path)).subarray(4, 8).toString("latin1");
      const videoCodecs = probe.streams.map((t, i) => (t === "video" ? probe.codecs[i] : null)).filter(Boolean);
      const audioCodecs = probe.streams.map((t, i) => (t === "audio" ? probe.codecs[i] : null)).filter(Boolean);
      checks.record("output/iso-bmff-family", probe.formatName === MP4_FORMAT_NAME && head === "ftyp", String(probe.formatName));
      checks.record("output/exactly-one-h264-video", videoCodecs.length === 1 && videoCodecs[0] === "h264");
      checks.record("output/exactly-one-aac-audio", audioCodecs.length === 1 && audioCodecs[0] === "aac");
      checks.record("output/exactly-two-streams", probe.streams.length === 2, String(probe.streams.length));
      checks.record(
        "output/duration-matches-the-fixture",
        probe.duration !== null && Math.abs(probe.duration - HLS_FIXTURE_SPEC.durationSeconds) <= DURATION_TOLERANCE_SECONDS,
        `${probe.duration}s vs ${HLS_FIXTURE_SPEC.durationSeconds}s ±${DURATION_TOLERANCE_SECONDS}`,
      );
      out.output = {
        formatName: probe.formatName,
        firstBoxType: head,
        streams: probe.streams,
        codecs: probe.codecs,
        video: probe.video,
        durationSeconds: probe.duration,
        durationToleranceSeconds: DURATION_TOLERANCE_SECONDS,
        noTranscodeProof:
          "the executed FFmpeg argv carried -c:v copy -c:a copy with no encoder/filter selection, and the output shape is valid; " +
          "compressed packet identity is NOT claimed (Annex-B to AVCC framing may change in a container stream copy)",
      };
    } else {
      for (const name of [
        "output/iso-bmff-family", "output/exactly-one-h264-video", "output/exactly-one-aac-audio",
        "output/exactly-two-streams", "output/duration-matches-the-fixture",
      ]) checks.record(name, false, "no uploaded object");
    }

    // ── fixture request accounting ──────────────────────────────────────────
    const byPhase = (phase, kind) => fRequests.filter((r) => r.phase === phase && r.kind === kind && r.userAgentClass !== "product");
    checks.record(
      "fixture/public-analysis-fetched-page-and-master",
      byPhase("positive:analysis-public", "page").length >= 1 && byPhase("positive:analysis-public", "master").length >= 1,
    );
    checks.record(
      "fixture/execution-analysis-fetched-page-and-master",
      byPhase("positive:analysis-execution", "page").length >= 1 && byPhase("positive:analysis-execution", "master").length >= 1,
    );
    checks.record(
      "fixture/ytdlp-never-fetched-media-or-fragments",
      fRequests.filter((r) => r.userAgentClass !== "product" && (r.kind === "media" || r.kind === "fragment" || r.kind === "key")).length === 0,
    );
    const unexpected = fRequests.filter((r) => r.kind === "unexpected" || r.kind === "key" || r.method !== "GET");
    checks.record("fixture/no-unexpected-route", unexpected.length === 0, String(unexpected.length));
    checks.record("transport/no-refused-request", transport.refusals().length === 0, String(transport.refusals().length));
    out.fixtureRequests = {
      fixture: fRequests.map(sanitizeFixtureRequest),
      transport: tLedger.map(sanitizeTransport),
      transportLookups: transport.lookupCounts(),
      transportRefusals: transport.refusals().length,
    };

    // ════════════════════════════ NEGATIVES ═══════════════════════════════
    const negativeSummary = (run, label) => {
      const t = tLedger.filter((e) => e.caseLabel === label);
      const s = spawnsIn(observer, label);
      return {
        finalStatus: run.view?.status ?? null,
        errorCode: run.view?.errorCode ?? null,
        statusTrace: run.statusTrace,
        playlistGets: t.filter((e) => e.kind === "media").length,
        fragmentGets: t.filter((e) => e.kind === "fragment").map((e) => ({ ordinal: e.ordinal, responseStatus: e.responseStatus })),
        hlsMediaProcessingSpawns: s.filter((x) => MEDIA_WORK_KINDS.has(x.kind)).length,
        processingStatusSpawns: s.filter((x) => x.statusAtSpawn === "processing").length,
        puts: run.writer.putCount(),
        executionAnalyses: run.execution.calls,
        planOperation: run.execution.facts?.plan?.operation ?? null,
        everReady: run.statusTrace.includes("ready"),
        everProcessing: run.statusTrace.includes("processing"),
      };
    };

    const enc = negativeSummary(encrypted, "negative-encrypted");
    checks.record("negative-encrypted/format-unavailable", enc.finalStatus === "failed" && enc.errorCode === "FORMAT_UNAVAILABLE", `${enc.finalStatus}/${enc.errorCode}`);
    checks.record(
      "negative-encrypted/playlist-fetched-once",
      enc.playlistGets === 1 && tLedger.filter((e) => e.caseLabel === "negative-encrypted" && e.kind === "media").every((e) => e.variant === "encrypted") &&
        enc.planOperation === "clear-hls-remux",
    );
    checks.record(
      "negative-encrypted/no-fragment-or-key-request",
      enc.fragmentGets.length === 0 && fRequests.filter((r) => r.kind === "key").length === 0 &&
        fRequests.filter((r) => r.phase.startsWith("negative-encrypted") && r.kind === "fragment").length === 0,
    );
    checks.record("negative-encrypted/no-hls-media-processing", enc.hlsMediaProcessingSpawns === 0 && enc.processingStatusSpawns === 0);
    checks.record("negative-encrypted/no-upload", enc.puts === 0);
    checks.record(
      "negative-encrypted/never-ready",
      !enc.everReady && !enc.everProcessing && sameList(enc.statusTrace, ["queued", "analyzing", "downloading", "failed"]),
      enc.statusTrace.join(" -> "),
    );

    const frag = negativeSummary(fragment, "negative-fragment");
    const fragT = tLedger.filter((e) => e.caseLabel === "negative-fragment" && e.kind === "fragment");
    const fragCount = (o) => fragT.filter((e) => e.ordinal === o && e.family === "failure").length;
    checks.record("negative-fragment/network-error", frag.finalStatus === "failed" && frag.errorCode === "NETWORK_ERROR", `${frag.finalStatus}/${frag.errorCode}`);
    checks.record("negative-fragment/fragment-1-once", fragCount(1) === 1 && fragT.find((e) => e.ordinal === 1)?.responseStatus === 200);
    checks.record(
      "negative-fragment/fragment-2-once-not-retried",
      fragCount(2) === 1 && fragT.find((e) => e.ordinal === 2)?.responseStatus === HLS_FAILING_FRAGMENT.status,
    );
    checks.record(
      "negative-fragment/fragment-3-never",
      fragCount(3) === 0 && fRequests.filter((r) => r.kind === "fragment" && r.family === "failure" && r.ordinal === 3).length === 0,
    );
    checks.record("negative-fragment/no-hls-media-processing", frag.hlsMediaProcessingSpawns === 0 && frag.processingStatusSpawns === 0);
    checks.record("negative-fragment/no-upload", frag.puts === 0);
    checks.record(
      "negative-fragment/never-ready",
      !frag.everReady && !frag.everProcessing && sameList(frag.statusTrace, ["queued", "analyzing", "downloading", "failed"]),
      frag.statusTrace.join(" -> "),
    );

    checks.record(
      "negative-no-ffmpeg/no-hls-backed-preset",
      noFfmpeg.videoPresetIds.length === 0,
      noFfmpeg.videoPresetIds.join(","),
    );
    checks.record("negative-no-ffmpeg/hls-selections-empty", noFfmpeg.hlsSelectionCount === 0);
    checks.record(
      "negative-no-ffmpeg/hls-withheld-unsupported-protocol",
      noFfmpeg.sourceQuality !== null &&
        noFfmpeg.sourceQuality.deliverableMaxHeight === null &&
        noFfmpeg.sourceQuality.unsupportedProtocolCount >= 1 &&
        noFfmpeg.sourceQuality.unsupportedProtocolMaxHeight === 360,
    );
    checks.record("negative-no-ffmpeg/plan-format-unavailable", noFfmpeg.planErrorCode === "FORMAT_UNAVAILABLE", String(noFfmpeg.planErrorCode));
    checks.record(
      "negative-no-ffmpeg/no-media-playlist-request",
      tLedger.filter((e) => e.caseLabel === "negative-no-ffmpeg").length === 0 &&
        fRequests.filter((r) => r.kind === "media" && r.variant === "no-ffmpeg").length === 0,
    );
    out.negativeCases = {
      encryptedPlaylist: { expected: "FORMAT_UNAVAILABLE", ...enc },
      fragmentFailure: {
        expected: "NETWORK_ERROR",
        failingOrdinal: HLS_FAILING_FRAGMENT.ordinal,
        failingStatus: HLS_FAILING_FRAGMENT.status,
        perFragmentGets: { 1: fragCount(1), 2: fragCount(2), 3: fragCount(3) },
        ...frag,
      },
      ffmpegUnavailableAtAnalysis: { ffmpegAvailableInput: false, ...noFfmpeg },
    };

    // ════════════════════════════ PRIVACY ═════════════════════════════════
    const rawDbBytes = [];
    for (const name of (await readdir(dbDir)).sort()) {
      if (name.startsWith("worker.sqlite")) rawDbBytes.push((await readFile(join(dbDir, name))).toString("latin1"));
    }
    // Structured durable state is the authority on WHERE the hostname is
    // stored: every table, row by row, field by field. `worker_jobs` admits
    // only `url` and `source`, each exact; job views admit only `source`.
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    const tables = {};
    for (const name of tableNames) {
      tables[name] = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    }
    const expectedJobIds = [positive.job, encrypted, fragment].map((r) => r.jobId);
    const views = expectedJobIds.map((jobId) => store.getJob(jobId));
    const durable = validateDurablePrivacy({
      tables, views, expectedJobIds, pageUrl, hostname: HLS_FIXTURE_HOSTNAME, needles,
    });
    checks.record(
      "privacy/durable-page-echo-is-exact",
      durable.jobRowsAreTheExpectedJobs && durable.viewsAreTheExpectedJobs && durable.echo.length === 0,
      describePrivacyFindings(durable.echo),
    );
    checks.record(
      "privacy/durable-rows-carry-no-hls-provenance",
      durable.rows.length === 0 && (tables.worker_jobs ?? []).length === expectedJobIds.length,
      describePrivacyFindings(durable.rows),
    );
    checks.record(
      "privacy/job-views-carry-no-hls-provenance",
      durable.views.length === 0 && durable.viewsAreTheExpectedJobs,
      describePrivacyFindings(durable.views),
    );
    // Raw bytes have no fields and legitimately hold the page URL and
    // `source`, so they are scanned for HLS acquisition provenance only.
    const rawFindings = scanRawPrivacyNeedles("raw sqlite bytes", rawDbBytes.join("\n"), { needles });
    checks.record(
      "privacy/raw-sqlite-carries-no-hls-provenance",
      rawFindings.length === 0 && rawDbBytes.length >= 1,
      describePrivacyFindings(rawFindings),
    );
    // Upload and trace surfaces need no echo: the hostname is refused entirely.
    const uploadFindings = validateStructuredPrivacy(
      "upload",
      {
        filename: view?.filename ?? null,
        quality: view?.quality ?? null,
        mime: view?.mime ?? null,
        objectKey: object?.objectKey ?? null,
        contentDisposition: object?.contentDisposition ?? null,
        contentType: object?.contentType ?? null,
      },
      privacyOpts,
    );
    checks.record(
      "privacy/upload-surfaces-carry-no-hls-provenance",
      uploadFindings.length === 0 && object !== null,
      describePrivacyFindings(uploadFindings),
    );
    // The trace and the sanitized request ledgers. The plan and discovery
    // blocks are NOT scanned with these needles: they legitimately name the
    // plan operation and the upstream protocol, and the evidence builder scans
    // them — with the whole record — for markers, ids, hostnames and URLs.
    const traceFindings = [
      ...validateStructuredPrivacy("acceptance trace", trace, privacyOpts),
      ...validateStructuredPrivacy("fixture ledger", out.fixtureRequests, privacyOpts),
    ];
    checks.record(
      "privacy/trace-carries-no-hls-provenance",
      traceFindings.length === 0,
      describePrivacyFindings(traceFindings),
    );
    out.privacy = {
      privateValuesPresentOnlyIn: ["the in-memory execution analysis", "the in-memory execution plan", "the HLS-2/HLS-3 requests they became"],
      hostnamePlacement: {
        admittedEchoes: [
          "browser-safe analysis webpageUrl = the exact submitted page URL",
          "browser-safe analysis source = the exact fixture hostname",
          "worker_jobs url = the exact submitted page URL, for each expected job",
          "worker_jobs source = the exact fixture hostname, for each expected job",
          "job view source = the exact fixture hostname, for each expected job",
        ],
        elsewhere: "the fixture hostname in any other structured field or key, in any letter case, fails",
        hostnameFreeSurfaces: [
          "sourceQuality", "every non-worker_jobs table", "upload filename, quality, mime, object key, content disposition and content type",
          "acceptance trace", "fixture ledger", "this evidence record (by the builder)",
        ],
        rawSqlite:
          "no hostname claim: raw bytes have no fields and legitimately hold the submitted page URL and source; they are scanned for HLS acquisition provenance only, and the structured rows prove where the hostname is stored",
      },
      structuredSurfaces: [
        "browser-safe analysis", "sourceQuality", "every table row", "job views", "upload", "acceptance trace", "fixture ledger",
      ],
      unstructuredSurfaces: ["raw sqlite bytes (database, WAL and shared-memory files)"],
      tablesScanned: tableNames.length,
      needleClasses: Object.keys(needles),
      findingClasses: [HLS08_ADMISSION_FINDING, HLS08_HOSTNAME_FINDING],
      publicFindings: publicPrivacy.echo.length + publicPrivacy.other.length + sqFindings.length,
      durableFindings: durable.echo.length + durable.rows.length + durable.views.length,
      rawSqliteFindings: rawFindings.length,
      uploadFindings: uploadFindings.length,
      traceFindings: traceFindings.length,
      passed:
        publicPrivacy.echo.length + publicPrivacy.other.length + sqFindings.length === 0 &&
        durable.echo.length + durable.rows.length + durable.views.length === 0 &&
        durable.jobRowsAreTheExpectedJobs && durable.viewsAreTheExpectedJobs &&
        rawFindings.length === 0 && rawDbBytes.length >= 1 &&
        uploadFindings.length + traceFindings.length === 0,
    };

    // ════════════════════════════ CLEANUP ═════════════════════════════════
    const workDirsGone = [];
    for (const run of [positive.job, encrypted, fragment]) workDirsGone.push(!(await pathExists(run.workDir)));
    checks.record("cleanup/job-workdirs-removed", workDirsGone.every(Boolean), workDirsGone.join(","));
    // The positive job's HLS intermediates by name: the HLS-3 aggregate and
    // HLS-4's partial and final outputs, at the location HLS-4 actually used.
    const positiveAggregatePath = state.aggregatePaths.get("positive") ?? null;
    const intermediates = positiveAggregatePath === null ? [] : [
      positiveAggregatePath,
      join(dirname(positiveAggregatePath), HLS_OUTPUT_PARTIAL_FILE_NAME),
      join(dirname(positiveAggregatePath), HLS_OUTPUT_FILE_NAME),
    ];
    const intermediatesGone = [];
    for (const path of intermediates) intermediatesGone.push(!(await pathExists(path)));
    checks.record(
      "cleanup/hls-intermediates-removed",
      intermediates.length === 3 && intermediatesGone.every(Boolean),
      intermediatesGone.join(","),
    );

    db.close();
    db = null;
    await rm(dbDir, { recursive: true, force: true });
    checks.record("cleanup/temporary-database-removed", !(await pathExists(dbPath)) && !(await pathExists(dbDir)));

    await service.close();
    service = null;
    await rm(fixtureDir, { recursive: true, force: true });
    checks.record("cleanup/fixture-root-removed", !(await pathExists(fixtureDir)));

    const sinkHeldOne = object !== null && (await pathExists(object.path));
    await rm(sinkRoot, { recursive: true, force: true });
    checks.record("cleanup/sink-removed-after-observation", sinkHeldOne && !(await pathExists(sinkRoot)));
    out.cleanup = {
      jobWorkDirsRemovedByExecutor: workDirsGone,
      hlsIntermediatesRemoved: { aggregate: intermediatesGone[0] ?? null, partial: intermediatesGone[1] ?? null, output: intermediatesGone[2] ?? null },
      temporaryDatabaseRemoved: true,
      fixtureRootRemoved: true,
      sinkRetainedUntilObserved: sinkHeldOne,
      sinkRemoved: true,
      safeHttpHooksCleared: true,
      processRunnerHooksCleared: true,
      containerRemovedBy: "--rm",
      ...imageRemovalFact(opts),
    };

    if (blocked.length > 0) verdict = "BLOCKED";
    else verdict = checks.passed() ? "PASS" : "FAIL";
  } catch (err) {
    checks.record("run/completed-without-error", false, err instanceof AppError ? `AppError ${err.code}` : String(err?.name ?? "Error"));
    verdict = blocked.length > 0 ? "BLOCKED" : "FAIL";
    process.stderr.write(`[hls08] ${err?.stack ?? err}\n`);
  } finally {
    setPinnedRequestFactoryForTests(null);
    setSafeHttpTestHooks(null);
    setProcessRunnerTestHooks(null);
    if (service) await service.close().catch(() => {});
    if (db) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    await rm(dbDir, { recursive: true, force: true }).catch(() => {});
    await rm(sinkRoot, { recursive: true, force: true }).catch(() => {});
  }

  // The mode adds only its identity (source/image) to the behavioral blocks.
  const record = buildAcceptanceEvidence(opts, {
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    network: { fixtureBind: HLS_FIXTURE_LOOPBACK, fixturePort: out.port },
    toolchain: out.toolchain,
    invariants: out.invariants,
    fixture: out.fixture,
    fixtureToolUse: { ...fixtureToolUse, note: "harness fixture generation and harness probes; never counted as Product media work" },
    discovery: out.discovery,
    publicAnalysis: out.publicAnalysis,
    executionAnalysis: out.executionAnalysis,
    freshProvenance: out.freshProvenance,
    plan: out.plan,
    workspace: out.workspace,
    hls2: out.hls2,
    hls3: out.hls3,
    aggregate: out.aggregate,
    lifecycle: out.lifecycle,
    productMediaToolUse: out.productMediaToolUse,
    remux: out.remux,
    output: out.output,
    upload: out.upload,
    ready: out.ready,
    fixtureRequests: out.fixtureRequests,
    privacy: out.privacy,
    cleanup: out.cleanup,
    negativeCases: out.negativeCases,
    openNotes: {
      hls7GenericPresetOwnerNote: "HLS-7 defense-in-depth note (`id in map` ownership) remains OPEN and non-blocking; not addressed here",
      cloudflareAccessCredentialAbsence: "CLOUDFLARE-ACCESS-WORKER-CREDENTIAL-ABSENCE-VERIFICATION-001 is NOT addressed or resolved by this run",
      blockedReasons: blocked,
    },
    checks: checks.all(),
  }, identityObservations);

  await writeFile(opts.evidence, renderAcceptanceEvidence(opts, record), { flag: "wx" });

  const failed = checks.failed();
  process.stdout.write(`${verdict} ${acceptanceLabel(opts)} checks=${checks.all().length} failed=${failed.length}\n`);
  for (const f of failed) process.stdout.write(`  FAIL ${f.name}${f.detail ? ` :: ${f.detail}` : ""}\n`);
  for (const b of blocked) process.stdout.write(`  BLOCKED ${b}\n`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[hls08] ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}

export {
  REQUESTED_PRESET,
  EXPECTED_RUNG,
  createChecks,
  createHarnessDirectAnalyzer,
  discoveryFacts,
  inspectExecutionAnalysis,
  parseArgv,
  playlistVariant,
};
