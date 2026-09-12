#!/usr/bin/env node
//
// SPLIT-06: the deterministic split-stream FULL-PATH acceptance orchestrator.
//
// ── What one run proves ────────────────────────────────────────────────────
//
// That against deterministic LOCAL fixtures and the exact accepted media
// runtime, the CURRENT source executes the real split application chain:
//
//   analysis -> split-backed public preset -> fresh execution analysis
//   -> merge-split plan -> video acquisition -> audio acquisition
//   -> beginProcessing() -> ffprobe input validation -> FFmpeg stream-copy
//   -> ffprobe output validation -> beginUploading() -> upload -> ready
//
// using the actual pinned yt-dlp executable, the actual ffprobe and FFmpeg
// binaries, a real SQLite job store and the real `JobExecutor`.
//
// ── What one run does NOT prove ────────────────────────────────────────────
//
// Cloudflare, the R2 broker, Vercel, the Production egress namespace, and
// public YouTube compatibility. Those have their own acceptance stages. The
// object-storage PROVIDER here is a deterministic local writer, and the SSRF
// policy is deliberately replaced by an exact-fixture validator because the
// fixture serves from loopback inside a `--network none` container.
//
// ── Where it runs ──────────────────────────────────────────────────────────
//
// INSIDE the acceptance container, as the image's non-root `node` user, with
// `--network none`. `lib/split-container.mjs` builds that invocation; this file
// assumes it and re-checks the parts it can observe.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// ── Production modules. Imported, never re-implemented. ────────────────────
import { config } from "../../../src/lib/config.ts";
import { AppError } from "../../../src/lib/errors.ts";
import { WorkerAnalyzeRequestSchema } from "../../../src/shared/worker/contracts.ts";
import { looksLikeDirectMedia } from "../../../src/services/extractors/direct.server.ts";
import { mimeForContainer } from "../../../src/services/extractors/normalize.ts";
import { buildDownloadFilename, buildAttachmentContentDisposition } from "../../../src/lib/filenames.ts";
import {
  YTDLP_RUNTIME,
  probeYtdlpRuntime,
} from "../../../src/worker/runtime/ytdlp-runtime.server.ts";
import { runProcess } from "../../../src/services/processing/process-runner.server.ts";
import { ffmpegAvailable } from "../../../src/services/processing/ffmpeg.server.ts";
import {
  probeLocalMedia,
  resolveFfprobePath,
  hasExactStreamShape,
} from "../../../src/services/processing/ffprobe.server.ts";
import { mergeSplitMedia } from "../../../src/services/processing/ffmpeg.server.ts";
import { analyzeGenericMediaInternal } from "../../../src/worker/analysis/ytdlp-analysis.server.ts";
import { createMediaAnalysisPolicy } from "../../../src/worker/analysis/media-analyzer.server.ts";
import {
  deriveGenericExecutionPlan,
} from "../../../src/worker/execution/format-plan.ts";
import {
  GenericSplitSourceSelectionSchema,
  splitTargetContainer,
} from "../../../src/worker/execution/generic-source.ts";
import {
  downloadGenericSplitSources,
  isPinnedMaxFilesizeRefusal,
} from "../../../src/worker/execution/ytdlp-download.server.ts";
import { JobExecutor } from "../../../src/worker/execution/job-executor.server.ts";
import { openWorkerDatabase } from "../../../src/worker/state/database.server.ts";
import { applyMigrations } from "../../../src/worker/state/migrations.server.ts";
import { SQLiteJobStore } from "../../../src/worker/state/sqlite-job-store.server.ts";

// ── Harness modules ────────────────────────────────────────────────────────
import { createFixtureService } from "./fixtures/server.mjs";
import {
  SPLIT_FIXTURE_ARTIFACTS,
  SPLIT_SYNTHETIC_FORMAT_IDS,
  SPLIT_TARGET_CONTAINER,
  SPLIT_TARGET_MIME,
  generateSplitFixtures,
  splitIncompatibleManifest,
  splitManifest,
} from "./fixtures/split-media.mjs";
import { createExactFixtureUrlValidator } from "./lib/split-fixture-url.mjs";
import { createLocalObjectStoreWriter } from "./lib/local-object-writer.mjs";
import {
  createMediaToolSampler,
  createRunnerLedger,
  installStatusAudit,
  readStatusTrace,
} from "./lib/split-observers.mjs";
import {
  MAX_FILESIZE_REFUSAL_REQUIRED_CODE,
  buildSplitEvidence,
  evaluateMaxFilesizeRefusal,
  renderSplitEvidence,
} from "./lib/split-evidence.mjs";
import { isFullGitSha } from "./lib/split-provenance.mjs";

// ── Bounds ─────────────────────────────────────────────────────────────────

/** The manifest route each family's full path is driven from. */
const MANIFEST_ROUTE = Object.freeze({ mp4: "/split-mp4.mpd", webm: "/split-webm.mpd" });
const INCOMPATIBLE_ROUTE = "/split-incompatible.mpd";

/** The media route each half must be acquired from, per family. */
const MEDIA_ROUTE = Object.freeze({
  mp4: { video: "/split-video.mp4", audio: "/split-audio.m4a" },
  webm: { video: "/split-video.webm", audio: "/split-audio.webm" },
});

/** The expected upstream resolution rung for the fixture's 360-line video. */
const EXPECTED_RUNG = "preset:360";

/** The public preset the durable job requests. Application-owned, closed. */
const REQUESTED_PRESET = "preset:best";

/** Output duration tolerance, in seconds (§44). Both halves are 2 s by recipe. */
const DURATION_TOLERANCE_SECONDS = 0.25;

// ── Check ledger ───────────────────────────────────────────────────────────

function createChecks() {
  const entries = [];
  return {
    /** Records one named expectation and whether the observation satisfied it. */
    record(name, ok, detail) {
      entries.push({ name, ok: Boolean(ok), detail: detail ?? null });
      return Boolean(ok);
    },
    /** Records, and throws on failure — for expectations later stages rely on. */
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
      return entries.every((e) => e.ok);
    },
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────

const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

/** Runs one bounded command and returns its streams. Harness observation only. */
function runTool(command, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < 256 * 1024) stderr += String(c);
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
 * The harness's OWN ffprobe observation of a finished artifact.
 *
 * Deliberately separate from `probeLocalMedia`: the product's probe asks for
 * exactly `format_name` and `codec_type` and nothing else, which is correct for
 * the product and insufficient for acceptance. This one additionally reads the
 * duration and the compressed packet hashes, which is what makes "the merge
 * was a stream copy" and "the output is as long as its sources" measurable
 * rather than assumed. It never feeds a product decision.
 */
async function harnessProbe(ffprobePath, inputPath, demuxer) {
  const format = await runTool(ffprobePath, [
    "-v", "error", "-protocol_whitelist", "file",
    "-f", demuxer, "-print_format", "json",
    "-show_entries", "format=format_name,duration:stream=codec_type,codec_name",
    "-i", inputPath,
  ]);
  if (format.code !== 0) throw new Error(`harness ffprobe failed on ${inputPath}`);
  const doc = JSON.parse(format.stdout);
  return {
    formatName: doc.format?.format_name ?? null,
    duration: doc.format?.duration === undefined ? null : Number(doc.format.duration),
    streams: (doc.streams ?? []).map((s) => s.codec_type),
    codecs: (doc.streams ?? []).map((s) => s.codec_name),
  };
}

/**
 * The SHA-256 of one stream's COMPRESSED PACKET DATA, in order.
 *
 * `ffprobe -show_packets -show_data_hash sha256` emits a per-packet
 * `data_hash` over the packet payload as stored — before any decode. Folding
 * that ordered list into one digest gives a value that is equal for two files
 * exactly when they carry the same compressed bitstream for that stream, and
 * differs for any re-encode however visually similar. That is a much stronger
 * statement than comparing decoded frames, which a lossless-looking transcode
 * could pass.
 */
async function streamPacketDigest(ffprobePath, inputPath, demuxer, selector) {
  const res = await runTool(ffprobePath, [
    "-v", "error", "-protocol_whitelist", "file",
    "-f", demuxer, "-select_streams", selector,
    "-show_packets", "-show_data_hash", "sha256",
    "-print_format", "json", "-i", inputPath,
  ]);
  if (res.code !== 0) throw new Error(`packet probe failed on ${inputPath} ${selector}`);
  const packets = JSON.parse(res.stdout).packets ?? [];
  if (packets.length === 0) throw new Error(`no packets on ${inputPath} ${selector}`);
  const rolling = createHash("sha256");
  for (const packet of packets) {
    const hash = packet.data_hash;
    if (typeof hash !== "string" || !hash.startsWith("SHA256:")) {
      throw new Error("the pinned ffprobe did not emit a packet data hash");
    }
    rolling.update(hash);
  }
  return { digest: rolling.digest("hex"), packetCount: packets.length };
}

const FFPROBE_DEMUXER = Object.freeze({ "iso-bmff": "mov", webm: "matroska" });

/**
 * Replaces the upstream identifier inside a yt-dlp format expression with a
 * role placeholder, so the expression's SHAPE can be published while the id
 * it binds stays private.
 *
 * Substitution is by exact synthetic value, not by pattern: a redactor that
 * guessed at "things that look like ids" would either miss one or mangle the
 * closed literals (`"none"`, `"http"`, `"mp4"`) the shape is made of.
 */
function redactSelector(selector) {
  let out = selector;
  for (const [role, id] of Object.entries(SPLIT_SYNTHETIC_FORMAT_IDS)) {
    out = out.split(id).join(`<synthetic-${role}-id>`);
  }
  return out;
}

// ── 1. Runtime preflight (§10/§11) ─────────────────────────────────────────

/**
 * Proves the toolchain inside THIS container before any full-path work.
 *
 * Every tool is EXECUTED. "The Debian ffmpeg package normally ships ffprobe"
 * is not evidence that this container has a usable one — that inference is the
 * exact gap the SPLIT-05 merge recorded as a runtime-acceptance blocker, and
 * closing it is one of SPLIT-06's jobs.
 */
async function preflight(checks) {
  const nodeVersion = process.version;
  checks.require(
    "preflight/node-runtime-family",
    /^v22\./.test(nodeVersion),
    `node ${nodeVersion}`,
  );

  // yt-dlp, through the REAL pinned-runtime probe rather than a bare --version.
  const runtime = await probeYtdlpRuntime();
  checks.require("preflight/ytdlp-available", runtime.available === true, runtime.reason);
  checks.require(
    "preflight/ytdlp-exact-pin",
    runtime.version === YTDLP_RUNTIME.expectedVersion,
    `${runtime.version} vs ${YTDLP_RUNTIME.expectedVersion}`,
  );

  // FFmpeg: the CONFIGURED absolute path, executed.
  const ffmpegPath = config.ffmpegPath;
  checks.require("preflight/ffmpeg-path-absolute", ffmpegPath === "/usr/bin/ffmpeg", ffmpegPath);
  const ffmpegVersion = await runTool(ffmpegPath, ["-hide_banner", "-version"]);
  checks.require("preflight/ffmpeg-executes", ffmpegVersion.code === 0);
  checks.require(
    "preflight/ffmpeg-available-predicate",
    (await ffmpegAvailable()) === true,
    "the product's own availability probe",
  );

  // ffprobe: DERIVED as the configured FFmpeg's sibling, then executed. Never a
  // PATH lookup — a Worker whose PATH can be influenced must not thereby choose
  // which program parses untrusted media.
  const ffprobePath = resolveFfprobePath();
  checks.require(
    "preflight/ffprobe-is-ffmpeg-sibling",
    ffprobePath === "/usr/bin/ffprobe",
    ffprobePath,
  );
  checks.require(
    "preflight/ffprobe-derived-from-configured-ffmpeg",
    dirname(ffprobePath) === dirname(ffmpegPath),
  );
  const ffprobeVersion = await runTool(ffprobePath, ["-hide_banner", "-version"]);
  checks.require("preflight/ffprobe-executes", ffprobeVersion.code === 0);

  const firstLine = (text) => text.split(/\r?\n/)[0]?.trim() ?? "";
  return {
    node: nodeVersion,
    ytdlpVersion: runtime.version,
    ytdlpArtifactPath: YTDLP_RUNTIME.artifactPath,
    ffmpegPath,
    ffmpegVersion: firstLine(ffmpegVersion.stdout),
    ffprobePath,
    ffprobeVersion: firstLine(ffprobeVersion.stdout),
    probeLocalMediaResult: null,
  };
}

// ── 2. The FFmpeg `-n` runtime proof (§36) ─────────────────────────────────

/**
 * Closes the carried-forward SPLIT-02 question with runtime evidence.
 *
 * `mergeSplitMedia` refuses a pre-existing output before it spawns anything;
 * `-n` is what covers the window between that check and FFmpeg's own open. The
 * argv carries `-n` and a test pins the argv — but argv inspection is not proof
 * that THIS binary honours it, so this runs the real binary against a real
 * occupied output and measures the file afterwards.
 */
async function proveFfmpegRefusesOverwrite(checks, ffmpegPath, scratchDir) {
  const outputPath = join(scratchDir, "occupied-output.mp4");
  const original = Buffer.from("SPLIT-06 pre-existing output, must survive -n\n", "utf8");
  await writeFile(outputPath, original);
  const before = createHash("sha256").update(original).digest("hex");

  const result = await runTool(ffmpegPath, [
    "-n", "-nostdin", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5:duration=1",
    "-c:v", "libx264", "-threads", "1", "-t", "1",
    "-f", "mp4", outputPath,
  ]);

  const afterBytes = await readFile(outputPath);
  const after = createHash("sha256").update(afterBytes).digest("hex");

  checks.require("ffmpeg/-n-refuses-existing-output", result.code !== 0, `exit ${result.code}`);
  checks.require("ffmpeg/-n-leaves-bytes-unchanged", afterBytes.byteLength === original.byteLength);
  checks.require("ffmpeg/-n-leaves-digest-unchanged", after === before);

  await rm(outputPath, { force: true });
  return {
    binary: ffmpegPath,
    exitCode: result.code,
    refused: result.code !== 0,
    digestBefore: before,
    digestAfter: after,
    unchanged: after === before,
  };
}

// ── 3. Fixtures and the fixture service ────────────────────────────────────

async function startFixtureService(artifacts) {
  const manifests = {
    "/split-mp4.mpd": Buffer.from(splitManifest("mp4"), "utf8"),
    "/split-webm.mpd": Buffer.from(splitManifest("webm"), "utf8"),
    "/split-incompatible.mpd": Buffer.from(splitIncompatibleManifest(), "utf8"),
  };
  const media = {};
  for (const artifact of Object.values(artifacts)) {
    media[`/${artifact.basename}`] = artifact.bytes;
  }
  const service = createFixtureService({ split: { manifests, artifacts: media } });
  const address = await service.listen(0);
  return { service, port: address.port };
}

// ── 4. The direct-first router's DIRECT half ───────────────────────────────

/**
 * The direct analyzer the router is given, with `assertSafeUrl` substituted.
 *
 * This is NOT a stub that simply says "not mine". It performs exactly the steps
 * `analyzeDirectMedia` performs before it would probe anything:
 *
 *   1. `WorkerAnalyzeRequestSchema` — the real request-shape gate;
 *   2. URL validation — the acceptance validator standing in for `assertSafeUrl`,
 *      which correctly refuses loopback and is not injectable there;
 *   3. `looksLikeDirectMedia` — the REAL product predicate, which decides the
 *      outcome here.
 *
 * A `.mpd` URL is not direct media by that predicate, so the real code path
 * yields `EXTRACTOR_UNAVAILABLE` — the one code the router accepts as
 * permission to consider the generic strategy. The probe branch below step 3 is
 * unreachable for this fixture, which is why nothing stands in for it.
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

// ── 5. Analysis composition ────────────────────────────────────────────────

/**
 * The REAL analysis policy, with exactly two acceptance substitutions:
 * the URL validator (§22) and a recording delegate around the process runner.
 *
 * Everything that decides anything stays production code: the direct-first
 * routing rule, the single fallback code, the `ytdlpEnabled` gate, the lazy
 * FFmpeg-capability resolution, candidate selection, pairing, preset
 * construction and the private selection map.
 */
function createAnalysisPolicy({ validateUrl, ledger, limits, ffmpegAvailableFn }) {
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
        runner: ledger.runner,
      }),
  });
}

// ── 6. The mandatory full path ─────────────────────────────────────────────

/**
 * One complete deterministic run for ONE family.
 *
 * Reads top to bottom in the order the product executes, and every expectation
 * is stated before the observation it is compared against.
 */
async function runFullPath(ctx) {
  const {
    checks, family, fixtures, service, port, toolchain, limits, workRoot,
  } = ctx;

  const validateUrl = createExactFixtureUrlValidator({ port, routes: ctx.routes });
  const manifestUrl = validateUrl.urlFor(MANIFEST_ROUTE[family]);

  // ── the exact-fixture validator's own policy (§22/§23) ──────────────────
  //
  // Recorded as checks because this validator is the one deliberate weakening
  // in the run, and "narrow" has to be a measured property rather than an
  // intention. SPLIT-06 is not re-proving Production SSRF policy here.
  const refused = [
    "http://127.0.0.1:1/split-mp4.mpd",
    `http://localhost:${port}${MANIFEST_ROUTE[family]}`,
    `http://127.0.0.2:${port}${MANIFEST_ROUTE[family]}`,
    `http://10.0.0.1:${port}${MANIFEST_ROUTE[family]}`,
    `https://127.0.0.1:${port}${MANIFEST_ROUTE[family]}`,
    `http://127.0.0.1:${port}/etc/passwd`,
    `http://127.0.0.1:${port}${MANIFEST_ROUTE[family]}?x=1`,
    `http://user:pw@127.0.0.1:${port}${MANIFEST_ROUTE[family]}`,
    `file:///${MANIFEST_ROUTE[family]}`,
  ];
  for (const candidate of refused) {
    let rejected = false;
    try {
      await validateUrl(candidate);
    } catch {
      rejected = true;
    }
    checks.record(`validator/refuses ${candidate}`, rejected);
  }
  checks.require(
    "validator/admits-the-exact-fixture-url",
    (await validateUrl(manifestUrl)).url === manifestUrl,
  );

  // ── analysis (§24/§25) ───────────────────────────────────────────────────
  const analysisLedger = createRunnerLedger(runProcess);
  analysisLedger.setPhase("analysis-public");
  const policy = createAnalysisPolicy({
    validateUrl,
    ledger: analysisLedger,
    limits,
    ffmpegAvailableFn: () => ffmpegAvailable(),
  });

  const first = await policy.analyzeForExecution(manifestUrl);
  checks.require("analysis/strategy-is-yt-dlp", first.strategy === "yt-dlp", first.strategy);

  const meta = first.video;
  const presetIds = meta.presets.map((p) => p.id);
  const best = meta.presets.find((p) => p.id === REQUESTED_PRESET);
  const rung = meta.presets.find((p) => p.id === EXPECTED_RUNG);

  checks.require("analysis/advertises-preset-best", Boolean(best), presetIds.join(","));
  checks.require("analysis/advertises-expected-rung", Boolean(rung), presetIds.join(","));
  checks.require("analysis/best-has-video", best.hasVideo === true);
  checks.require("analysis/best-has-audio", best.hasAudio === true);
  checks.require(
    "analysis/best-container-is-table-target",
    best.container === SPLIT_TARGET_CONTAINER[family],
    best.container,
  );
  checks.require("analysis/best-resolution-rung", best.resolution === "360p", best.resolution);
  checks.require("analysis/preset-id-equals-format-id", best.formatId === best.id);
  checks.require("analysis/capabilities-merge-true", meta.capabilities.merge === true);
  checks.require("analysis/advertises-no-raw-formats", meta.formats.length === 0);
  const publicJson = JSON.stringify(meta);
  for (const [role, id] of Object.entries(SPLIT_SYNTHETIC_FORMAT_IDS)) {
    // The check NAME carries the role, never the id: the check ledger is part
    // of the evidence record, and a check called "omits SPLIT06_VIDEO_01" would
    // itself be the leak it is asserting against.
    checks.require(`analysis/public-metadata-omits-the-synthetic-${role}-id`, !publicJson.includes(id));
  }

  // The PRIVATE half of the same analysis.
  const selection = first.selections[REQUESTED_PRESET];
  checks.require("analysis/private-selection-exists", Boolean(selection));
  checks.require("analysis/private-selection-is-split", selection.kind === "split", selection.kind);
  checks.require(
    "analysis/pair-validates-against-the-schema",
    GenericSplitSourceSelectionSchema.safeParse(selection.pair).success,
  );
  checks.require(
    "analysis/pair-names-the-synthetic-video-id",
    selection.pair.video.formatId === SPLIT_SYNTHETIC_FORMAT_IDS.video,
  );
  checks.require(
    "analysis/pair-names-the-synthetic-audio-id",
    selection.pair.audio.formatId === SPLIT_SYNTHETIC_FORMAT_IDS.audio,
  );
  checks.require(
    "analysis/video-half-audio-proven-absent",
    selection.pair.video.audioConstraint === "absent",
  );
  checks.require(
    "analysis/audio-half-video-proven-absent",
    selection.pair.audio.videoConstraint === "absent",
  );
  checks.require(
    "analysis/audio-half-audio-proven-present",
    selection.pair.audio.audioConstraint === "codec-present",
  );
  checks.require(
    "analysis/pair-target-is-the-closed-table-result",
    splitTargetContainer(selection.pair.video.container, selection.pair.audio.container) ===
      SPLIT_TARGET_CONTAINER[family],
  );

  // ── plan derivation (§26) ────────────────────────────────────────────────
  const plan = deriveGenericExecutionPlan(meta, first.selections, REQUESTED_PRESET);
  checks.require("plan/strategy-yt-dlp", plan.strategy === "yt-dlp");
  checks.require("plan/operation-merge-split", plan.operation === "merge-split", plan.operation);
  checks.require("plan/requested-format-is-the-app-preset", plan.requestedFormatId === REQUESTED_PRESET);
  checks.require(
    "plan/target-container-from-the-closed-table",
    plan.targetContainer === SPLIT_TARGET_CONTAINER[family],
  );
  checks.require(
    "plan/pair-is-the-analyzer-produced-pair",
    JSON.stringify(plan.pair) === JSON.stringify(selection.pair),
  );

  const analysisSpawns = analysisLedger.ytdlp().length;
  checks.require("analysis/ran-real-ytdlp-subprocesses", analysisSpawns >= 1, String(analysisSpawns));

  // ── durable store (§28) ──────────────────────────────────────────────────
  const dbDir = await mkdtemp(join(workRoot, "split06-db-"));
  const dbPath = join(dbDir, "worker.sqlite");
  const db = openWorkerDatabase({ path: dbPath });
  applyMigrations(db);
  installStatusAudit(db);
  const store = new SQLiteJobStore({ db });

  // ── observation state ────────────────────────────────────────────────────
  const sampler = createMediaToolSampler();
  const executionLedger = createRunnerLedger(runProcess);
  const trace = [];
  const note = (event, detail) => trace.push({ event, detail: detail ?? null });

  let jobId = null;
  const statusNow = () => (jobId ? (store.getJob(jobId)?.status ?? "<missing>") : "<no-job>");

  const observed = {
    statusAtSplitEntry: null,
    statusesDuringAcquisition: new Set(),
    statusAtMergeEntry: null,
    // EVERY put's status, not just the last one. A second, earlier upload
    // would otherwise be overwritten by the legitimate one and look fine.
    statusesAtPut: [],
    acquiredVideoBytes: null,
    acquiredAudioBytes: null,
    mergedPath: null,
    mergedSize: null,
    preUploadSha256: null,
    secondAnalysisPair: null,
    executionAnalyses: 0,
    runtimeProbes: 0,
  };

  // ── writer (§37/§39) ─────────────────────────────────────────────────────
  const sinkDir = join(workRoot, "object-sink");
  await mkdir(sinkDir, { recursive: true });
  const writer = createLocalObjectStoreWriter({
    sinkDir,
    onPut: () => {
      const status = statusNow();
      observed.statusesAtPut.push(status);
      note("object put", `status=${status}`);
    },
  });

  // ── executor seams (§29) ─────────────────────────────────────────────────
  const executionPolicy = createAnalysisPolicy({
    validateUrl,
    ledger: executionLedger,
    limits,
    ffmpegAvailableFn: () => ffmpegAvailable(),
  });

  const executor = new JobExecutor(store, writer, () => Date.now(), new Map(), {
    // The FRESH execution analysis. Production re-analyzes its own stored URL
    // at execution time and never reuses the browser's earlier result, so the
    // harness must not hand the first analysis's pair back here.
    analyzeForExecution: async (url, signal) => {
      executionLedger.setPhase("analysis-execution");
      sampler.setPhase("analysis-execution");
      const result = await executionPolicy.analyzeForExecution(url, signal);
      observed.executionAnalyses += 1;
      const fresh = result.selections[REQUESTED_PRESET];
      observed.secondAnalysisPair = fresh?.kind === "split" ? fresh.pair : null;
      note("analysis complete", `strategy=${result.strategy}`);
      return result;
    },

    // The REAL SPLIT-03 primitive. The wrapper forwards every argument
    // untouched and adds the two acceptance dependencies plus observation.
    downloadGenericSplit: async (url, workDir, splitPlan, acqCtx) => {
      executionLedger.setPhase("acquisition");
      sampler.setPhase("acquisition");
      observed.statusAtSplitEntry = statusNow();
      note("job downloading", `status=${observed.statusAtSplitEntry}`);

      // §32: the durable state is sampled for the WHOLE time either media
      // subprocess could be live, not only at entry.
      const poll = setInterval(() => observed.statusesDuringAcquisition.add(statusNow()), 15);
      if (typeof poll.unref === "function") poll.unref();
      observed.statusesDuringAcquisition.add(observed.statusAtSplitEntry);
      try {
        const sources = await downloadGenericSplitSources(url, workDir, splitPlan, {
          limits: acqCtx.limits,
          ...(acqCtx.signal ? { signal: acqCtx.signal } : {}),
          ...(acqCtx.onProgress ? { onProgress: acqCtx.onProgress } : {}),
          validateUrl,
          runner: executionLedger.runner,
          // The pinned-runtime probe runs through `probeYtdlpRuntime`'s own
          // module-level runner, not through the injected one, so it is
          // counted here instead. This delegate forwards the options
          // untouched and calls the REAL probe: "one probe for both halves" is
          // then a measured number rather than an inference from the source.
          probeRuntime: async (probeOpts) => {
            observed.runtimeProbes += 1;
            return probeYtdlpRuntime(probeOpts);
          },
        });
        observed.acquiredVideoBytes = sources.video.fileSize;
        observed.acquiredAudioBytes = sources.audio.fileSize;
        note("video validated", `${sources.video.container} ${sources.video.fileSize}B`);
        note("audio validated", `${sources.audio.container} ${sources.audio.fileSize}B`);
        return sources;
      } finally {
        clearInterval(poll);
      }
    },

    // The REAL SPLIT-02 merge. Observation only: the options object is passed
    // through exactly as the executor built it.
    mergeSplit: async (mergeOpts) => {
      executionLedger.setPhase("processing");
      sampler.setPhase("processing");
      observed.statusAtMergeEntry = statusNow();
      note("beginProcessing committed", `status=${observed.statusAtMergeEntry}`);
      note("input probes", "probeLocalMedia x2 (inside mergeSplitMedia)");
      const produced = await mergeSplitMedia(mergeOpts);
      note("FFmpeg merge", `-> ${produced.split("/").pop()}`);
      note("output probe", "probeLocalMedia (inside mergeSplitMedia)");
      observed.mergedPath = produced;
      // §41: an independent observation of the artifact the Worker is about to
      // upload, taken before the upload body stream is opened.
      observed.preUploadSha256 = await sha256File(produced);
      const info = await lstat(produced);
      observed.mergedSize = info.size;
      executionLedger.setPhase("upload");
      sampler.setPhase("upload");
      return produced;
    },
  });

  // ── run it ───────────────────────────────────────────────────────────────
  sampler.start();
  const created = store.createJob(
    { url: manifestUrl, formatId: REQUESTED_PRESET, principalId: "private-access-user" },
    randomUUID(),
  );
  checks.require("durable/job-created", created.type === "created", created.type);
  jobId = created.job.jobId;

  const claimed = store.claimNextQueuedJob();
  checks.require("durable/job-claimed-to-analyzing", claimed?.status === "analyzing", claimed?.status);

  await executor.execute(claimed);
  sampler.stop();

  const finalJob = store.getJob(jobId);
  note("ready committed", `status=${finalJob?.status}`);

  // ── the provider boundary, as the REAL lifecycle drove it (§37/§40) ──────
  // `finalizeJobUpload` puts, HEADs, compares the provider's own observation
  // with what it expected, and only then commits `ready` — otherwise it deletes
  // the object and refuses. The local writer's HEAD MEASURES the persisted
  // object, so a provider that stored different bytes is refused here, by the
  // product, before any harness assertion reads a byte. This check reports that
  // boundary's outcome and names the head field that disagreed; it is not the
  // mechanism that refuses.
  const lifecycleHeads = writer.headLog();
  const lifecycleHead = lifecycleHeads.length === 1 ? lifecycleHeads[0] : null;
  const lifecyclePut = lifecycleHead
    ? (writer.putLog().find((p) => p.objectKey === lifecycleHead.objectKey) ?? null)
    : null;
  const headDisagreements =
    lifecycleHead && lifecyclePut
      ? [
          lifecycleHead.contentLength !== lifecyclePut.declaredLength ? "contentLength" : null,
          lifecycleHead.contentType !== lifecyclePut.declaredContentType ? "contentType" : null,
          lifecycleHead.contentDisposition !== lifecyclePut.declaredContentDisposition
            ? "contentDisposition"
            : null,
        ].filter(Boolean)
      : [`${lifecycleHeads.length} lifecycle heads`];
  const cleanupDeletes = writer.deleteLog().length;
  checks.require(
    "upload/real-lifecycle-accepted-the-provider-head",
    finalJob?.status === "ready" && cleanupDeletes === 0 && headDisagreements.length === 0,
    `status=${finalJob?.status} error=${finalJob?.errorCode ?? "none"} ` +
      `declared=${lifecyclePut?.declaredLength ?? "?"} stored=${lifecyclePut?.observedBytes ?? "?"} ` +
      `head=${lifecycleHead?.contentLength ?? "?"} disagreed=[${headDisagreements.join(",")}] ` +
      `cleanupDeletes=${cleanupDeletes}`,
  );

  // ── lifecycle (§31/§32/§34/§39/§40) ──────────────────────────────────────
  const statusTrace = readStatusTrace(db, jobId);
  checks.require(
    "lifecycle/durable-trace",
    JSON.stringify(statusTrace) ===
      JSON.stringify(["queued", "analyzing", "downloading", "processing", "uploading", "ready"]),
    statusTrace.join(" -> "),
  );
  checks.require(
    "lifecycle/status-at-split-downloader-entry",
    observed.statusAtSplitEntry === "downloading",
    String(observed.statusAtSplitEntry),
  );
  const duringAcquisition = [...observed.statusesDuringAcquisition].sort();
  checks.require(
    "lifecycle/never-processing-or-uploading-during-acquisition",
    duringAcquisition.every((s) => s === "downloading"),
    duringAcquisition.join(","),
  );
  checks.require(
    "lifecycle/status-at-merge-entry",
    observed.statusAtMergeEntry === "processing",
    String(observed.statusAtMergeEntry),
  );
  checks.require(
    "lifecycle/status-at-object-put",
    observed.statusesAtPut.length > 0 &&
      observed.statusesAtPut.every((status) => status === "uploading"),
    observed.statusesAtPut.join(","),
  );
  checks.require("lifecycle/final-status-ready", finalJob?.status === "ready", finalJob?.status);

  // ── fresh execution analysis (§27) ───────────────────────────────────────
  checks.require("analysis/execution-reanalyzed", observed.executionAnalyses === 1);
  checks.require(
    "analysis/two-independent-analyses-agree-on-the-pair",
    JSON.stringify(observed.secondAnalysisPair) === JSON.stringify(selection.pair),
  );

  // ── acquisition (§30/§35) ────────────────────────────────────────────────
  const acquisitionSpawns = executionLedger.inPhase("acquisition");
  const acquisitionYtdlp = acquisitionSpawns.filter((s) => s.args[0]?.endsWith("/yt-dlp"));
  const selectors = acquisitionYtdlp
    .map((s) => s.args.find((a) => a.startsWith("--format=")))
    .filter(Boolean);
  const templates = acquisitionYtdlp
    .map((s) => s.args.find((a) => a.startsWith("--output=")))
    .filter(Boolean);

  checks.require(
    "acquisition/exactly-one-runtime-probe-for-both-halves",
    observed.runtimeProbes === 1,
    `${observed.runtimeProbes} probes`,
  );
  checks.require(
    "acquisition/exactly-two-yt-dlp-media-processes",
    acquisitionYtdlp.length === 2,
    `${acquisitionYtdlp.length} yt-dlp spawns`,
  );
  checks.require("acquisition/every-invocation-names-one-source", selectors.length === 2);
  checks.require(
    "acquisition/video-first",
    templates[0]?.includes("video-source.") === true,
    templates[0] ?? "",
  );
  checks.require(
    "acquisition/audio-second",
    templates[1]?.includes("audio-source.") === true,
    templates[1] ?? "",
  );
  checks.require(
    "acquisition/no-merge-selector",
    selectors.every((sel) => !sel.includes("+")),
  );
  checks.require(
    "acquisition/no-fallback-selector",
    selectors.every((sel) => !sel.includes("/")),
  );
  checks.require(
    "acquisition/video-selector-binds-proven-absent-audio",
    selectors[0]?.includes('[acodec="none"]') === true,
  );
  checks.require(
    "acquisition/audio-selector-binds-proven-absent-video",
    selectors[1]?.includes('[vcodec="none"]') === true,
  );
  checks.require(
    "acquisition/ffmpeg-location-is-nonexistent",
    acquisitionYtdlp
      .filter((s) => s.args.some((a) => a.startsWith("--format=")))
      .every((s) => s.args.some((a) => a === "--ffmpeg-location=/nonexistent/videofetch-yt-dlp-no-ffmpeg")),
  );
  checks.require(
    "acquisition/native-downloader",
    acquisitionYtdlp.every((s) => s.args.includes("--downloader=native")),
  );
  checks.require(
    "acquisition/no-load-info-json",
    executionLedger.all().every((s) => !s.args.some((a) => a.startsWith("--load-info-json"))),
    "the pinned GenericIE expressed the pair itself",
  );
  checks.require(
    "acquisition/no-media-tool-spawned-during-acquisition",
    sampler.sightingsIn("acquisition").length === 0,
    sampler.distinctToolsIn("acquisition").join(","),
  );
  checks.require(
    "processing/worker-owned-media-tools-ran",
    sampler.sightingsIn("processing").length > 0,
    sampler.distinctToolsIn("processing").join(","),
  );

  // ── fixture request accounting (§48) ─────────────────────────────────────
  const requests = service.splitRequests();
  const getsOf = (route) =>
    requests.filter((r) => r.route === route && r.method === "GET").length;
  checks.require(
    "fixture/manifest-was-read",
    getsOf(MANIFEST_ROUTE[family]) >= 1,
    String(getsOf(MANIFEST_ROUTE[family])),
  );
  checks.require(
    "fixture/video-route-was-acquired",
    getsOf(MEDIA_ROUTE[family].video) === 1,
    String(getsOf(MEDIA_ROUTE[family].video)),
  );
  checks.require(
    "fixture/audio-route-was-acquired",
    getsOf(MEDIA_ROUTE[family].audio) === 1,
    String(getsOf(MEDIA_ROUTE[family].audio)),
  );
  const unexpectedMedia = requests.filter(
    (r) =>
      r.route !== MANIFEST_ROUTE[family] &&
      r.route !== MEDIA_ROUTE[family].video &&
      r.route !== MEDIA_ROUTE[family].audio,
  );
  checks.require(
    "fixture/no-unexpected-route-was-requested",
    unexpectedMedia.length === 0,
    unexpectedMedia.map((r) => r.route).join(","),
  );

  // ── acquired bytes match the pre-run fixtures ────────────────────────────
  const videoFixture = fixtures[`${family}:video`];
  const audioFixture = fixtures[`${family}:audio`];
  checks.require(
    "acquisition/video-bytes-equal-the-fixture",
    observed.acquiredVideoBytes === videoFixture.byteLength,
    `${observed.acquiredVideoBytes} vs ${videoFixture.byteLength}`,
  );
  checks.require(
    "acquisition/audio-bytes-equal-the-fixture",
    observed.acquiredAudioBytes === audioFixture.byteLength,
    `${observed.acquiredAudioBytes} vs ${audioFixture.byteLength}`,
  );

  // ── the uploaded object (§40/§41/§42/§43) ────────────────────────────────
  checks.require("upload/exactly-one-put", writer.putCount() === 1, String(writer.putCount()));
  const object = writer.soleObject();
  checks.require("upload/object-recorded", Boolean(object));
  checks.require(
    "upload/declared-length-equals-observed",
    object.declaredLength === object.observedBytes,
    `${object.declaredLength} vs ${object.observedBytes}`,
  );
  checks.require(
    "upload/provider-head-reported-the-persisted-length",
    lifecycleHead?.contentLength === object.observedBytes &&
      (await lstat(object.path)).size === object.observedBytes,
    `${lifecycleHead?.contentLength} vs ${object.observedBytes}`,
  );
  checks.require(
    "upload/uploaded-digest-equals-pre-upload-digest",
    object.sha256 === observed.preUploadSha256,
    "byte identity, not merely equal length",
  );
  checks.require(
    "upload/declared-length-equals-merged-size",
    object.declaredLength === observed.mergedSize,
  );
  checks.require(
    "upload/content-type-is-the-target-mime",
    object.contentType === SPLIT_TARGET_MIME[family],
    object.contentType,
  );

  const expectedFilename = buildDownloadFilename({
    title: finalJob.title,
    quality: "best",
    container: SPLIT_TARGET_CONTAINER[family],
  });
  checks.require(
    "upload/content-disposition-is-the-application-name",
    object.contentDisposition === buildAttachmentContentDisposition(expectedFilename),
  );

  // Durable ready metadata.
  checks.require("ready/object-key-present", typeof finalJob.objectKey === "string");
  checks.require(
    "ready/object-key-binds-this-job",
    finalJob.objectKey.startsWith(`videofetch/jobs/${jobId}/`),
  );
  checks.require(
    "ready/file-size-equals-uploaded-bytes",
    finalJob.fileSize === object.observedBytes,
    `${finalJob.fileSize} vs ${object.observedBytes}`,
  );
  checks.require(
    "ready/container-is-the-target",
    finalJob.container === SPLIT_TARGET_CONTAINER[family],
    finalJob.container,
  );
  checks.require(
    "ready/mime-is-the-target",
    finalJob.mime === mimeForContainer(SPLIT_TARGET_CONTAINER[family]),
    finalJob.mime,
  );
  checks.require(
    "ready/filename-extension-is-the-target",
    finalJob.filename?.endsWith(`.${SPLIT_TARGET_CONTAINER[family]}`) === true,
    finalJob.filename,
  );
  checks.require(
    "ready/extractor-is-the-application-strategy",
    finalJob.extractor === "yt-dlp",
    finalJob.extractor,
  );
  const durableRow = db.prepare("SELECT * FROM worker_jobs WHERE job_id = ?").get(jobId);
  checks.require(
    "ready/durable-row-keeps-the-application-preset",
    durableRow.format_id === REQUESTED_PRESET,
    durableRow.format_id,
  );

  // ── privacy across the whole chain (§46) ─────────────────────────────────
  const privacySurfaces = {
    "public metadata": JSON.stringify(meta),
    "durable row": JSON.stringify(
      Object.fromEntries(
        Object.entries(durableRow).filter(([, v]) => typeof v === "string"),
      ),
    ),
    filename: String(finalJob.filename ?? ""),
    quality: String(finalJob.quality ?? ""),
    mime: String(finalJob.mime ?? ""),
    "object key": String(finalJob.objectKey ?? ""),
    "content disposition": object.contentDisposition,
    "content type": object.contentType,
    "acceptance trace": JSON.stringify(trace),
  };
  const leaks = [];
  for (const [surface, text] of Object.entries(privacySurfaces)) {
    for (const id of Object.values(SPLIT_SYNTHETIC_FORMAT_IDS)) {
      if (text.includes(id)) leaks.push(surface);
    }
  }
  checks.require("privacy/no-raw-source-id-on-any-public-surface", leaks.length === 0, leaks.join(","));

  // ── the delivered media itself (§42/§43/§44) ─────────────────────────────
  const demuxer = FFPROBE_DEMUXER[videoFixture.probeFamily];
  const outputProbe = await harnessProbe(toolchain.ffprobePath, object.path, demuxer);
  const videoStreams = outputProbe.streams.filter((s) => s === "video").length;
  const audioStreams = outputProbe.streams.filter((s) => s === "audio").length;
  checks.require(
    "output/family-is-the-target",
    outputProbe.formatName === (family === "mp4" ? "mov,mp4,m4a,3gp,3g2,mj2" : "matroska,webm"),
    outputProbe.formatName,
  );
  checks.require("output/exactly-one-video-stream", videoStreams === 1, String(videoStreams));
  checks.require("output/exactly-one-audio-stream", audioStreams === 1, String(audioStreams));
  checks.require(
    "output/exactly-two-streams",
    outputProbe.streams.length === 2,
    String(outputProbe.streams.length),
  );
  checks.require(
    "output/duration-matches-the-fixtures",
    outputProbe.duration !== null &&
      Math.abs(outputProbe.duration - videoFixture.durationSeconds) <= DURATION_TOLERANCE_SECONDS,
    `${outputProbe.duration}s vs ${videoFixture.durationSeconds}s`,
  );

  // Compressed packet identity: the merged streams ARE the source streams.
  const sourceVideoPackets = await streamPacketDigest(
    toolchain.ffprobePath, videoFixture.path, demuxer, "v:0",
  );
  const sourceAudioPackets = await streamPacketDigest(
    toolchain.ffprobePath, audioFixture.path, demuxer, "a:0",
  );
  const outVideoPackets = await streamPacketDigest(
    toolchain.ffprobePath, object.path, demuxer, "v:0",
  );
  const outAudioPackets = await streamPacketDigest(
    toolchain.ffprobePath, object.path, demuxer, "a:0",
  );
  checks.require(
    "stream-identity/video-packets-came-from-the-video-fixture",
    outVideoPackets.digest === sourceVideoPackets.digest,
    `${outVideoPackets.packetCount} packets`,
  );
  checks.require(
    "stream-identity/audio-packets-came-from-the-audio-fixture",
    outAudioPackets.digest === sourceAudioPackets.digest,
    `${outAudioPackets.packetCount} packets`,
  );
  checks.require(
    "stream-identity/the-two-streams-are-distinct",
    outVideoPackets.digest !== outAudioPackets.digest,
  );

  // ── cleanup (§45) ────────────────────────────────────────────────────────
  const jobWorkDir = join(config.tempDirectory, "jobs", jobId);
  const workDirGone = !(await pathExists(jobWorkDir));
  checks.require("cleanup/job-workdir-removed", workDirGone);
  checks.require("cleanup/uploaded-copy-survives-in-the-harness-sink", await pathExists(object.path));

  db.close();
  await rm(dbDir, { recursive: true, force: true });
  const dbGone = !(await pathExists(dbPath));
  checks.require("cleanup/temporary-database-removed", dbGone);

  return {
    jobId,
    manifestRoute: MANIFEST_ROUTE[family],
    statusTrace,
    trace,
    observed,
    object,
    providerHead: { contentLength: lifecycleHead?.contentLength ?? null },
    outputProbe,
    packets: {
      sourceVideo: sourceVideoPackets,
      sourceAudio: sourceAudioPackets,
      outputVideo: outVideoPackets,
      outputAudio: outAudioPackets,
    },
    fixtureRequests: requests,
    acquisition: {
      runtimeProbes: observed.runtimeProbes,
      ytdlpMediaProcesses: acquisitionYtdlp.length,
      mediaInvocations: selectors.length,
      // The selector expression EMBEDS the upstream format id, which is one of
      // the surfaces §46 says must stay private — so what reaches the record is
      // the redacted form plus the properties that were actually asserted.
      // The unredacted expressions exist only inside this process, where the
      // assertions above read them.
      redactedSelectors: selectors.map(redactSelector),
      selectorHasMergeOperator: selectors.some((sel) => sel.includes("+")),
      selectorHasFallbackOperator: selectors.some((sel) => sel.includes("/")),
      // Basenames only: the work directory is a per-job temporary path.
      outputBasenames: templates.map((t) => t.split("/").pop()),
      videoBytes: observed.acquiredVideoBytes,
      audioBytes: observed.acquiredAudioBytes,
      combinedBytes: observed.acquiredVideoBytes + observed.acquiredAudioBytes,
      // Byte COUNTS of the two acquisition runs' console streams, never their
      // text: acquisition runs `--no-quiet`, and these bound what that leaves
      // in Worker memory for an ordinary successful run.
      ytdlpStdoutBytes: acquisitionYtdlp.map((s) => s.stdoutBytes),
      ytdlpStderrBytes: acquisitionYtdlp.map((s) => s.stderrBytes),
      mediaToolsDuringAcquisition: sampler.distinctToolsIn("acquisition"),
      mediaToolsDuringProcessing: sampler.distinctToolsIn("processing"),
      samplerTicks: sampler.tickCount(),
    },
    analysis: {
      publicPresets: presetIds,
      selectedPreset: REQUESTED_PRESET,
      capabilitiesMerge: meta.capabilities.merge,
      privateSelectionKind: selection.kind,
      pairValidated: true,
      freshExecutionAnalyses: observed.executionAnalyses,
      pairsAgree: true,
      analysisYtdlpSpawns: analysisSpawns,
    },
    plan: {
      strategy: plan.strategy,
      operation: plan.operation,
      requestedFormatId: plan.requestedFormatId,
      targetContainer: plan.targetContainer,
    },
    cleanup: { workDirGone, dbGone, sinkRetained: true },
  };
}

// ── 7. Negative cases ──────────────────────────────────────────────────────

/**
 * §51: an INCOMPATIBLE pair — ISO-BMFF video beside Matroska audio.
 *
 * Both halves are individually ordinary candidates, so nothing about candidate
 * selection refuses them. The closed container table does, because a stream
 * copy across families is exactly the case that would need codec knowledge the
 * merge path never consults. The point of running it through the real analyzer
 * is to show the harness is not simply forcing every fixture down the happy
 * path: this one must reach `FORMAT_UNAVAILABLE` at the plan boundary, having
 * acquired nothing.
 */
async function runIncompatibleCase(ctx) {
  const { checks, service, port, limits, routes } = ctx;
  const validateUrl = createExactFixtureUrlValidator({ port, routes });
  const url = validateUrl.urlFor(INCOMPATIBLE_ROUTE);
  const ledger = createRunnerLedger(runProcess);
  ledger.setPhase("negative-incompatible");
  const before = service.splitRequests().length;

  const policy = createAnalysisPolicy({
    validateUrl, ledger, limits, ffmpegAvailableFn: () => ffmpegAvailable(),
  });
  const result = await policy.analyzeForExecution(url);
  const presets = result.video.presets.map((p) => p.id);
  const videoPresets = presets.filter((id) => id !== "preset:audio" && id !== "preset:mp3");

  checks.require(
    "negative/incompatible-advertises-no-video-preset",
    videoPresets.length === 0,
    videoPresets.join(","),
  );
  checks.require(
    "negative/incompatible-capabilities-merge-false",
    result.video.capabilities.merge === false,
  );
  checks.require(
    "negative/incompatible-has-no-split-selection",
    Object.values(result.selections).every((s) => s.kind !== "split"),
  );

  let planCode = null;
  try {
    deriveGenericExecutionPlan(result.video, result.selections, REQUESTED_PRESET);
  } catch (err) {
    planCode = err instanceof AppError ? err.code : String(err?.name ?? "unknown");
  }
  checks.require(
    "negative/incompatible-plan-is-format-unavailable",
    planCode === "FORMAT_UNAVAILABLE",
    String(planCode),
  );

  const newRequests = service.splitRequests().slice(before);
  const mediaGets = newRequests.filter((r) => r.route !== INCOMPATIBLE_ROUTE);
  checks.require(
    "negative/incompatible-downloaded-no-media",
    mediaGets.length === 0,
    mediaGets.map((r) => r.route).join(","),
  );
  const mediaSpawns = ledger
    .all()
    .filter((s) => s.args.some((a) => a.startsWith("--format=")));
  checks.require("negative/incompatible-ran-no-acquisition", mediaSpawns.length === 0);

  return {
    manifestRoute: INCOMPATIBLE_ROUTE,
    advertisedPresets: presets,
    videoPresets,
    capabilitiesMerge: result.video.capabilities.merge,
    planErrorCode: planCode,
    mediaRequests: mediaGets.length,
    acquisitionSpawns: mediaSpawns.length,
    uploads: 0,
  };
}

/**
 * §52: analysis with `ffmpegAvailable = false` against the PAIRABLE source.
 *
 * A capability check, not a runtime corruption test — nothing is deleted or
 * renamed. A pair can only ever be fulfilled by the Worker's own FFmpeg, so
 * with that capability absent the analyzer must advertise no split-backed
 * video preset and must report `capabilities.merge: false`.
 */
async function runNoFfmpegCase(ctx) {
  const { checks, family, port, limits, routes } = ctx;
  const validateUrl = createExactFixtureUrlValidator({ port, routes });
  const url = validateUrl.urlFor(MANIFEST_ROUTE[family]);
  const ledger = createRunnerLedger(runProcess);
  ledger.setPhase("negative-no-ffmpeg");

  const policy = createAnalysisPolicy({
    validateUrl,
    ledger,
    limits,
    // The capability the generic branch consults, answered honestly as false.
    ffmpegAvailableFn: async () => false,
  });
  const result = await policy.analyzeForExecution(url);
  const presets = result.video.presets.map((p) => p.id);
  const videoPresets = presets.filter((id) => id !== "preset:audio" && id !== "preset:mp3");

  checks.require(
    "negative/no-ffmpeg-advertises-no-split-video-preset",
    videoPresets.length === 0,
    videoPresets.join(","),
  );
  checks.require(
    "negative/no-ffmpeg-capabilities-merge-false",
    result.video.capabilities.merge === false,
  );
  checks.require(
    "negative/no-ffmpeg-has-no-split-selection",
    Object.values(result.selections).every((s) => s.kind !== "split"),
  );

  let planCode = null;
  try {
    deriveGenericExecutionPlan(result.video, result.selections, REQUESTED_PRESET);
  } catch (err) {
    planCode = err instanceof AppError ? err.code : String(err?.name ?? "unknown");
  }
  checks.require(
    "negative/no-ffmpeg-plan-is-format-unavailable",
    planCode === "FORMAT_UNAVAILABLE",
    String(planCode),
  );

  return {
    ffmpegAvailable: false,
    advertisedPresets: presets,
    videoPresets,
    capabilitiesMerge: result.video.capabilities.merge,
    planErrorCode: planCode,
  };
}

// ── 8. The `--max-filesize` refusal: REQUIRED since -03 ────────────────────

/**
 * What the exact pinned runtime does when the declared `Content-Length`
 * already exceeds the supplied `--max-filesize` — and what the PRODUCT makes
 * of it.
 *
 * The pinned `HttpFD` refuses before opening any destination, prints one
 * status line and exits 0. -02 characterized that and recorded the resulting
 * PROCESSING_FAILED as an observed follow-up. Since
 * YTDLP-MAX-FILESIZE-REFUSAL-CLASSIFICATION-001 the Worker recognizes the
 * refusal, and a -03 PASS REQUIRES the canonical code to be TOO_LARGE with
 * nothing acquired. `evaluateMaxFilesizeRefusal` is the single definition.
 *
 * It runs through the REAL SPLIT-03 primitive, the real plan and the real
 * pinned runtime, so what is measured is the product's own classification of
 * the product's own subprocess. The yt-dlp exit code is recorded, never
 * required.
 */
async function acceptMaxFilesizeRefusal(ctx) {
  const { checks, family, fixtures, port, limits, routes, workRoot } = ctx;
  const validateUrl = createExactFixtureUrlValidator({ port, routes });
  const url = validateUrl.urlFor(MANIFEST_ROUTE[family]);
  const ledger = createRunnerLedger(runProcess);
  ledger.setPhase("max-filesize");

  const policy = createAnalysisPolicy({
    validateUrl, ledger, limits, ffmpegAvailableFn: () => ffmpegAvailable(),
  });
  const analysis = await policy.analyzeForExecution(url);
  const plan = deriveGenericExecutionPlan(analysis.video, analysis.selections, REQUESTED_PRESET);

  // A ceiling BELOW the video half's real size, so the fixture's honest
  // `Content-Length` is already over budget when yt-dlp reads it. Nothing
  // about the fixture is altered to create the condition.
  const videoFixture = fixtures[`${family}:video`];
  const ceiling = Math.max(1, Math.floor(videoFixture.byteLength / 2));

  const workDir = join(workRoot, "max-filesize-workdir");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  // Each acquisition's stdout is read HERE for one derived fact — did it end
  // with the pinned refusal of THIS ceiling — and then dropped. The ledger
  // keeps byte counts only; no stream text reaches the record.
  const refusalLineWasFinal = [];
  const runner = async (opts) => {
    const result = await ledger.runner(opts);
    refusalLineWasFinal.push(isPinnedMaxFilesizeRefusal(result.stdout, ceiling));
    return result;
  };

  let code = null;
  let threw = false;
  try {
    await downloadGenericSplitSources(url, workDir, plan, {
      limits: { maxFileSizeBytes: ceiling, downloadTimeoutSeconds: 60 },
      validateUrl,
      runner,
    });
  } catch (err) {
    threw = true;
    code = err instanceof AppError ? err.code : String(err?.name ?? "unknown");
  }

  const ytdlpRuns = ledger.all().filter((s) => s.args.some((a) => a.startsWith("--format=")));
  const last = ytdlpRuns[ytdlpRuns.length - 1];
  const entries = (await readdir(workDir).catch(() => [])).sort();
  await rm(workDir, { recursive: true, force: true });

  const observation = {
    ceilingBytes: ceiling,
    declaredContentLengthBytes: videoFixture.byteLength,
    refusedHalf: "video",
    threw,
    acquisitionRuns: ytdlpRuns.length,
    // The one value this case needs from the command — never the command.
    maxFilesizeArgument:
      last?.args.find((a) => a.startsWith("--max-filesize="))?.slice("--max-filesize=".length) ?? null,
    // Recorded, never required: the pinned release exits 0 on this refusal.
    ytdlpExitCode: last ? last.exitCode : null,
    ytdlpRefusalLineWasFinal: refusalLineWasFinal.at(-1) ?? null,
    ytdlpStdoutBytes: last?.stdoutBytes ?? null,
    ytdlpStderrBytes: last?.stderrBytes ?? null,
    finalFileExists: entries.some((e) => !e.endsWith(".part")),
    partFileExists: entries.some((e) => e.endsWith(".part")),
    workDirEntries: entries,
    canonicalErrorCode: code,
    requiredCanonicalErrorCode: MAX_FILESIZE_REFUSAL_REQUIRED_CODE,
  };
  for (const check of evaluateMaxFilesizeRefusal(observation)) {
    checks.record(check.name, check.ok, check.detail);
  }
  return observation;
}

// ── 9. CLI ─────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = { family: null, evidence: null, sourceCommit: null, sourceTree: null,
    acceptedBaseSource: null, sourceContextClean: false, overlayRuntimeCompatible: false,
    baseImage: null, baseDigest: null, overlayImage: null, overlayImageId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    const take = (key) => {
      if (value === undefined) throw new Error(`${arg} requires a value`);
      out[key] = value;
      i += 1;
    };
    switch (arg) {
      case "--family": take("family"); break;
      case "--evidence": take("evidence"); break;
      case "--source-commit": take("sourceCommit"); break;
      case "--source-tree": take("sourceTree"); break;
      case "--accepted-base-source": take("acceptedBaseSource"); break;
      case "--source-context-clean": out.sourceContextClean = true; break;
      case "--overlay-runtime-compatible": out.overlayRuntimeCompatible = true; break;
      case "--base-image": take("baseImage"); break;
      case "--base-digest": take("baseDigest"); break;
      case "--overlay-image": take("overlayImage"); break;
      case "--overlay-image-id": take("overlayImageId"); break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (out.family !== "mp4" && out.family !== "webm") {
    throw new Error("--family must be exactly `mp4` or `webm`");
  }
  // Following the harness's existing rule: a run that produces a verdict must
  // name where the record goes, before it does any work.
  if (!out.evidence) throw new Error("--evidence <path> is required");
  // Source provenance is OBSERVED by the host driver, which verifies the Docker
  // build context before and after building this overlay. This process runs
  // inside that overlay and cannot see Git, so it records exactly what the
  // driver observed, and refuses to start without it: a record naming an
  // unverified source would be a false statement.
  for (const [flag, key] of [
    ["--source-commit", "sourceCommit"],
    ["--source-tree", "sourceTree"],
    ["--accepted-base-source", "acceptedBaseSource"],
  ]) {
    if (!isFullGitSha(out[key])) {
      throw new Error(`${flag} must be the full 40-hex value run-split-acceptance.mjs observed`);
    }
  }
  if (!out.sourceContextClean || !out.overlayRuntimeCompatible) {
    throw new Error(
      "the build context was not verified clean and runtime-compatible by run-split-acceptance.mjs",
    );
  }
  return out;
}

/** The evidence path must be PRESENT and UNOCCUPIED, checked before any work. */
async function admitEvidencePath(path) {
  if (await pathExists(path)) {
    throw new Error(`refusing to replace an existing evidence artifact: ${path}`);
  }
  await mkdir(dirname(resolve(path)), { recursive: true });
}

async function main(argv) {
  const opts = parseArgv(argv);
  await admitEvidencePath(opts.evidence);

  const checks = createChecks();
  const startedAt = new Date().toISOString();
  const workRoot = await mkdtemp(join(tmpdir(), "split06-"));
  let service = null;
  let verdict = "BLOCKED";
  let full = null;
  let incompatible = null;
  let noFfmpeg = null;
  let maxFilesize = null;
  let overwrite = null;
  let toolchain = null;
  let fixtureSummary = null;
  let port = null;

  try {
    // The container this runs in must have no reachable network but loopback.
    // Recorded rather than asserted from inside: a process cannot prove its own
    // namespace has no route, and `lib/split-container.mjs` owns `--network
    // none` with its own test. What IS checked here is that nothing in the run
    // needed a name to be resolved.
    toolchain = await preflight(checks);
    overwrite = await proveFfmpegRefusesOverwrite(checks, toolchain.ffmpegPath, workRoot);

    // ── fixtures, with identities established BEFORE the job ───────────────
    const fixtureDir = join(workRoot, "fixtures");
    await mkdir(fixtureDir, { recursive: true });
    const fixtures = await generateSplitFixtures({
      ffmpegPath: toolchain.ffmpegPath,
      outDir: fixtureDir,
    });

    // The product's OWN probe, on the real fixtures, executing the derived
    // ffprobe sibling. This is what makes "ffprobe is usable for split
    // processing" a measured fact rather than a package-layout inference.
    const fixtureFacts = {};
    for (const [key, artifact] of Object.entries(fixtures)) {
      const probe = await probeLocalMedia({
        inputPath: artifact.path,
        workDir: fixtureDir,
        family: artifact.probeFamily,
        timeoutMs: 30_000,
      });
      checks.require(
        `fixture/${key}-has-the-declared-stream-shape`,
        hasExactStreamShape(probe, {
          family: artifact.probeFamily,
          video: artifact.streams.video,
          audio: artifact.streams.audio,
        }),
        probe.streams.join(","),
      );
      fixtureFacts[key] = {
        role: artifact.role,
        family: artifact.family,
        container: artifact.container,
        probeFamily: probe.family,
        streams: probe.streams,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
        durationSeconds: artifact.durationSeconds,
        width: artifact.width,
        height: artifact.height,
        fps: artifact.fps,
      };
      if (toolchain.probeLocalMediaResult === null) {
        toolchain.probeLocalMediaResult = `${probe.family} [${probe.streams.join(",")}]`;
      }
    }
    fixtureSummary = fixtureFacts;

    const started = await startFixtureService(fixtures);
    service = started.service;
    port = started.port;
    checks.require(
      "fixture/service-binds-loopback-only",
      service.manifest().listenAddress === "127.0.0.1",
    );

    const limits = {
      analysisTimeoutSeconds: Math.max(1, Math.floor(config.analysisTimeoutMs / 1000)),
      maxVideoDurationSeconds: config.maxVideoDuration,
      maxFileSizeBytes: config.maxFileSize,
    };
    const routes = [
      ...Object.values(MANIFEST_ROUTE),
      INCOMPATIBLE_ROUTE,
      ...Object.values(SPLIT_FIXTURE_ARTIFACTS).map((a) => `/${a.basename}`),
    ];
    const ctx = {
      checks, family: opts.family, fixtures, service, port, toolchain, limits, workRoot, routes,
    };

    full = await runFullPath(ctx);
    incompatible = await runIncompatibleCase(ctx);
    noFfmpeg = await runNoFfmpegCase(ctx);
    maxFilesize = await acceptMaxFilesizeRefusal(ctx);

    verdict = checks.passed() ? "PASS" : "FAIL";
  } catch (err) {
    checks.record("run/completed-without-error", false, err?.message ?? String(err));
    verdict = "FAIL";
    process.stderr.write(`[split06] ${err?.stack ?? err}\n`);
  } finally {
    if (service) await service.close();
  }

  const record = buildSplitEvidence({
    verdict,
    family: opts.family,
    startedAt,
    finishedAt: new Date().toISOString(),
    // Observed by the host driver in the Docker build context (see parseArgv).
    source: {
      commit: opts.sourceCommit,
      tree: opts.sourceTree,
      contextClean: opts.sourceContextClean,
      acceptedBaseSourceCommit: opts.acceptedBaseSource,
      overlayRuntimeCompatibilityVerified: opts.overlayRuntimeCompatible,
    },
    image: {
      acceptedBaseImage: opts.baseImage,
      acceptedBaseDigest: opts.baseDigest,
      overlayImage: opts.overlayImage,
      overlayImageId: opts.overlayImageId,
    },
    network: { fixtureBind: "127.0.0.1", fixturePort: port },
    toolchain: toolchain ?? {
      node: process.version, ytdlpVersion: null, ytdlpArtifactPath: null,
      ffmpegPath: null, ffmpegVersion: null, ffprobePath: null, ffprobeVersion: null,
      probeLocalMediaResult: null,
    },
    fixtures: fixtureSummary,
    sourceDiscovery: {
      method: "pinned-generic-extractor",
      manifestRoute: full?.manifestRoute ?? MANIFEST_ROUTE[opts.family],
      loadInfoJsonAdapterUsed: false,
      note:
        "the pinned GenericIE parsed the local DASH manifest into ONE media item " +
        "carrying a proven video-only and a proven audio-only format; no harness " +
        "source adapter was required",
    },
    analysis: full?.analysis ?? null,
    plan: full?.plan ?? null,
    acquisition: full?.acquisition ?? null,
    lifecycle: full
      ? {
          statusTrace: full.statusTrace,
          statusAtSplitDownloaderEntry: full.observed.statusAtSplitEntry,
          statusAtMergeEntry: full.observed.statusAtMergeEntry,
          statusesAtObjectPut: full.observed.statusesAtPut,
          trace: full.trace,
          fixtureRequests: full.fixtureRequests,
        }
      : null,
    processing: full
      ? {
          mergedBytes: full.observed.mergedSize,
          outputFamily: full.outputProbe.formatName,
          outputStreams: full.outputProbe.streams,
          outputCodecs: full.outputProbe.codecs,
          outputDurationSeconds: full.outputProbe.duration,
          streamCopy: true,
          overwriteFlag: "-n",
        }
      : null,
    streamIdentity: full
      ? {
          sourceVideoPacketDigest: full.packets.sourceVideo.digest,
          outputVideoPacketDigest: full.packets.outputVideo.digest,
          videoPacketCount: full.packets.outputVideo.packetCount,
          sourceAudioPacketDigest: full.packets.sourceAudio.digest,
          outputAudioPacketDigest: full.packets.outputAudio.digest,
          audioPacketCount: full.packets.outputAudio.packetCount,
          method: "ffprobe -show_packets -show_data_hash sha256, folded in order",
        }
      : null,
    upload: full
      ? {
          provider: "harness local ObjectStoreWriter (NOT Cloudflare R2)",
          objectKey: full.object.objectKey,
          contentType: full.object.contentType,
          contentDisposition: full.object.contentDisposition,
          declaredContentLength: full.object.declaredLength,
          writerObservedLength: full.object.observedBytes,
          providerHeadContentLength: full.providerHead.contentLength,
          providerHeadMeasures: "lstat of the persisted object at HEAD time, never the put declaration",
          preUploadSha256: full.observed.preUploadSha256,
          uploadedSha256: full.object.sha256,
          bytesIdentical: full.object.sha256 === full.observed.preUploadSha256,
        }
      : null,
    privacy: {
      syntheticSourceIdsPresentIn: ["analysis selection", "execution plan"],
      syntheticSourceIdsAbsentFrom: [
        "public metadata", "durable row", "filename", "quality", "mime",
        "object key", "content disposition", "acceptance trace", "this record",
      ],
    },
    cleanup: full?.cleanup ?? null,
    negativeCases: { incompatiblePair: incompatible, ffmpegUnavailableAtAnalysis: noFfmpeg },
    maxFilesizeRefusal: maxFilesize,
    ffmpegOverwriteRefusal: overwrite,
    checks: checks.all(),
  });

  await writeFile(opts.evidence, renderSplitEvidence(record), { flag: "wx" });
  await rm(workRoot, { recursive: true, force: true });

  const failed = checks.failed();
  process.stdout.write(`${verdict} split06 family=${opts.family} checks=${checks.all().length} failed=${failed.length}\n`);
  for (const f of failed) {
    process.stdout.write(`  FAIL ${f.name}${f.detail ? ` :: ${f.detail}` : ""}\n`);
  }
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[split06] ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}

export {
  MANIFEST_ROUTE,
  INCOMPATIBLE_ROUTE,
  MEDIA_ROUTE,
  REQUESTED_PRESET,
  EXPECTED_RUNG,
  createChecks,
  createAnalysisPolicy,
  createHarnessDirectAnalyzer,
  parseArgv,
  harnessProbe,
  streamPacketDigest,
  FFPROBE_DEMUXER,
};
