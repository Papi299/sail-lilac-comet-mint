#!/usr/bin/env node
//
// SYNC-01: the release-image split-merge TIMING matrix child
// (SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001).
//
// ── What one run proves ────────────────────────────────────────────────────
//
// For every case of `fixtures/sync-media.mjs`, generated in this container by
// the candidate image's own FFmpeg, the candidate's own `mergeSplitMedia`:
//
//   1. preserved the source's relative A/V timing — measured from PACKET
//      timestamps of payload-identical packets and from a DECODED sync event,
//      against an oracle the harness established BEFORE the merge;
//   2. carried exactly the closed synchronization policy that oracle derived
//      (the `-isync` direction from the measured start order; for WebM Opus
//      the CodecDelay compensation), and no forbidden timestamp flag;
//   3. hid nothing the source presented and presented nothing it hid;
//   4. for every zero-aligned control, produced exactly what the historical
//      merge produced (bytes for MP4, the packet timeline for WebM).
//
// And the oracle is shown able to FAIL: the historical merge of an offset pair
// is run as a frozen reference and must be reported as not preserving timing.
//
// ── Where it runs ──────────────────────────────────────────────────────────
//
// INSIDE the release candidate container, as the image's non-root `node`
// user, `--network none`, launched by the SPLIT-07 driver
// (`releaseSyncAcceptanceRunArgs`). It records the release identity the parent
// observed; the parent re-validates the record against its own observations.

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// ── Production modules. Imported, never re-implemented. ────────────────────
import { config } from "../../../src/lib/config.ts";
import { ffmpegAvailable, mergeSplitMedia } from "../../../src/services/processing/ffmpeg.server.ts";
import { resolveFfprobePath } from "../../../src/services/processing/ffprobe.server.ts";

// ── Harness modules ────────────────────────────────────────────────────────
import { createChecks } from "./split-full-path.mjs";
import {
  SYNC_CASES,
  SYNC_SENSITIVITY_CASES,
  historicalSplitMergeArgs,
  syncAudioArgs,
  syncHalfNames,
  syncVideoArgs,
} from "./fixtures/sync-media.mjs";
import { installSpawnObserver } from "./lib/dash-observers.mjs";
import { parseDashArgv as parseArgv } from "./lib/dash-argv.mjs";
import { releaseIdentityChecks } from "./lib/hls-release-evidence.mjs";
import {
  evaluateMergeTiming,
  expectedMergeSync,
  firstPresented,
  fixtureOpusCodecDelayNs,
  lastPresentedEnd,
  mergeSyncMatches,
  mp4MovieTimescale,
  pairSourceTiming,
  probePacketTimeline,
  rational,
  ratAbs,
  ratAdd,
  ratCmp,
  ratSub,
  ratToMicros,
} from "./lib/merge-timing.mjs";
import {
  SYNC01_RELEASE_EVIDENCE_SCHEMA,
  buildSyncReleaseEvidence,
  renderSyncReleaseEvidence,
} from "./lib/sync-evidence.mjs";

const DEMUXER = Object.freeze({ mp4: "mov", webm: "matroska" });
const MERGE_TIMEOUT_MS = 120_000;
const FLASH_LUMA_THRESHOLD = 200;
const CLICK_AMPLITUDE_THRESHOLD = 0.4;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** One bounded HARNESS tool, through the ORIGINAL spawn (never the product ledger). */
function createToolRunner(spawnFn) {
  return (command, args, { timeoutMs = 120_000 } = {}) =>
    new Promise((resolvePromise, reject) => {
      const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const out = [];
      let outBytes = 0;
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk) => {
        if (outBytes < 64 * 1024 * 1024) {
          out.push(chunk);
          outBytes += chunk.length;
        }
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 4 * 1024 * 1024) stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        const buffer = Buffer.concat(out);
        resolvePromise({ code, stdout: buffer.toString("utf8"), stdoutBytes: buffer, stderr });
      });
    });
}

// ── Decoded sync event ─────────────────────────────────────────────────────

const fields = (line) =>
  Object.fromEntries(
    line.slice(line.indexOf("]") + 1).trim().split(/\s+/).filter((t) => t.includes(":")).map((t) => {
      const at = t.indexOf(":");
      return [t.slice(0, at), t.slice(at + 1)];
    }),
  );

/** The presentation time of the first full-white decoded frame, exact, or null. */
async function decodedFlash(runTool, ffmpegPath, demuxer, path, timeBase) {
  const result = await runTool(ffmpegPath, [
    "-hide_banner", "-nostdin", "-v", "info", "-copyts",
    "-protocol_whitelist", "file", "-f", demuxer, "-i", path,
    "-map", "0:v:0", "-vf", "signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG", "-f", "null", "-",
  ]);
  if (result.code !== 0) return null;
  let frame = null;
  for (const line of result.stderr.split("\n")) {
    if (!line.includes("Parsed_metadata")) continue;
    if (line.includes(" pts:") && line.includes("frame:")) {
      const f = fields(line);
      frame = { pts: BigInt(f.pts), ptsTime: Number(f.pts_time) };
    } else if (line.includes("YAVG=") && frame !== null) {
      if (Number(line.slice(line.lastIndexOf("=") + 1)) > FLASH_LUMA_THRESHOLD) {
        const exact = rational(frame.pts * timeBase.n, timeBase.d);
        // The filter's time base must be the stream's: cross-check the printed time.
        if (Math.abs(Number(exact.n) / Number(exact.d) - frame.ptsTime) > 1e-3) return null;
        return exact;
      }
    }
  }
  return null;
}

/** The presentation time of the first decoded sample above the burst threshold, exact, or null. */
async function decodedClick(runTool, ffmpegPath, demuxer, path) {
  const result = await runTool(ffmpegPath, [
    "-hide_banner", "-nostdin", "-v", "info", "-copyts",
    "-protocol_whitelist", "file", "-f", demuxer, "-i", path,
    "-map", "0:a:0", "-af", "ashowinfo", "-ac", "1", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1",
  ]);
  if (result.code !== 0) return null;
  const frames = result.stderr
    .split("\n")
    .filter((line) => line.includes("Parsed_ashowinfo") && line.includes(" pts:"))
    .map(fields)
    .map((f) => ({ pts: BigInt(f.pts), rate: BigInt(f.rate), samples: Number(f.nb_samples) }));
  const pcm = result.stdoutBytes;
  const total = frames.reduce((sum, f) => sum + f.samples, 0);
  if (total * 4 !== pcm.length) return null;
  let index = 0;
  for (const frame of frames) {
    for (let j = 0; j < frame.samples; j += 1) {
      if (Math.abs(pcm.readFloatLE((index + j) * 4)) > CLICK_AMPLITUDE_THRESHOLD) {
        return rational(frame.pts + BigInt(j), frame.rate);
      }
    }
    index += frame.samples;
  }
  return null;
}

// ── Packet-timeline identity (WebM controls) ───────────────────────────────

function timelineIdentical(a, b) {
  const flat = (stream) => stream?.packets.map((p) => `${p.pts}|${p.dts}|${p.duration}|${p.discard}|${p.hash}`) ?? null;
  return (
    a.streamCount === b.streamCount &&
    JSON.stringify(flat(a.video)) === JSON.stringify(flat(b.video)) &&
    JSON.stringify(flat(a.audio)) === JSON.stringify(flat(b.audio)) &&
    a.video?.timeBase.n === b.video?.timeBase.n && a.video?.timeBase.d === b.video?.timeBase.d &&
    a.audio?.timeBase.n === b.audio?.timeBase.n && a.audio?.timeBase.d === b.audio?.timeBase.d
  );
}

// ── 1. Preflight ───────────────────────────────────────────────────────────

async function preflight(checks, runTool) {
  checks.require("preflight/node-runtime-family", /^v22\./.test(process.version), process.version);
  const ffmpegPath = config.ffmpegPath;
  checks.require("preflight/ffmpeg-path-is-the-worker-ffmpeg", ffmpegPath === "/usr/bin/ffmpeg", ffmpegPath);
  const ffmpegVersion = await runTool(ffmpegPath, ["-hide_banner", "-version"]);
  checks.require(
    "preflight/ffmpeg-executes",
    ffmpegVersion.code === 0 && (await ffmpegAvailable()) === true,
    "executed, and the product's own availability probe agrees",
  );
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
    ffmpegPath,
    ffmpegVersion: firstLine(ffmpegVersion.stdout),
    ffprobePath,
    ffprobeVersion: firstLine(ffprobeVersion.stdout),
  };
}

// ── 2. One case ────────────────────────────────────────────────────────────

async function runCase(ctx, sync) {
  const { checks, runTool, toolchain, workRoot, observer } = ctx;
  const C = (name) => `${sync.name}/${name}`;
  const demuxer = DEMUXER[sync.target];
  const names = syncHalfNames(sync.target);

  // ── fixtures, and the oracle, BEFORE the merge ───────────────────────────
  const fixtureDir = join(workRoot, "fixtures", sync.name);
  await mkdir(fixtureDir, { recursive: true });
  const videoFixture = join(fixtureDir, names.video);
  const audioFixture = join(fixtureDir, names.audio);
  const videoGen = await runTool(toolchain.ffmpegPath, syncVideoArgs(sync, videoFixture));
  const audioGen = await runTool(toolchain.ffmpegPath, syncAudioArgs(sync, audioFixture));
  checks.require(C("fixture/halves-generated"), videoGen.code === 0 && audioGen.code === 0);

  const videoIn = await probePacketTimeline(runTool, toolchain.ffprobePath, demuxer, videoFixture);
  const audioIn = await probePacketTimeline(runTool, toolchain.ffprobePath, demuxer, audioFixture);
  const source = pairSourceTiming(videoIn, audioIn);
  checks.require(
    C("fixture/source-timing-established-before-the-merge"),
    source.measurable === true && videoIn.streamCount === 1 && audioIn.streamCount === 1,
    `audio-video ${source.relativeUs}us`,
  );
  const sourceFlash = await decodedFlash(runTool, toolchain.ffmpegPath, demuxer, videoFixture, videoIn.video.timeBase);
  const sourceClick = await decodedClick(runTool, toolchain.ffmpegPath, demuxer, audioFixture);
  checks.require(C("fixture/decoded-sync-event-measured-in-both-halves"), sourceFlash !== null && sourceClick !== null);
  const sourceEvent = ratSub(sourceClick, sourceFlash);
  if (sync.kind === "offset" || sync.kind === "duration") {
    checks.require(C("fixture/pair-carries-a-discriminating-av-offset"), source.discriminating === true, `${source.relativeUs}us`);
  }
  if (sync.kind === "duration") {
    // The EARLIER-starting half must be the SHORTER one, so a direction chosen
    // from duration picks the wrong reference and trims media.
    const span = (stream) => ratSub(lastPresentedEnd(stream), firstPresented(stream));
    const audioFirst = ratCmp(firstPresented(audioIn.audio), firstPresented(videoIn.video)) < 0;
    const earlier = audioFirst ? span(audioIn.audio) : span(videoIn.video);
    const later = audioFirst ? span(videoIn.video) : span(audioIn.audio);
    checks.require(C("fixture/earlier-starting-half-is-the-shorter"), ratCmp(earlier, later) < 0);
  }
  const opusCodecDelayNs = sync.target === "webm" ? fixtureOpusCodecDelayNs(await readFile(audioFixture)) : 0;
  const expected = expectedMergeSync({ target: sync.target, videoInput: videoIn, audioInput: audioIn, opusCodecDelayNs });

  // ── the PRODUCT merge, in a fresh directory of the Product workspace ─────
  const workDir = join(config.tempDirectory, "sync01", sync.name);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await copyFile(videoFixture, join(workDir, names.video));
  await copyFile(audioFixture, join(workDir, names.audio));
  const spawnsBefore = observer.count();
  let produced = null;
  let productError = null;
  try {
    produced = await mergeSplitMedia({
      videoPath: join(workDir, names.video),
      audioPath: join(workDir, names.audio),
      workDir,
      target: sync.target,
      timeoutMs: MERGE_TIMEOUT_MS,
      maxOutputBytes: config.maxFileSize,
    });
  } catch (error) {
    productError = typeof error?.code === "string" ? error.code : "error";
  }
  const realWorkDir = await realpath(workDir);
  checks.record(
    C("merge/product-merge-returned-the-merged-artifact"),
    produced === join(realWorkDir, names.output),
    productError ?? "returned",
  );
  const merges = observer.records().slice(spawnsBefore).filter((r) => r.tool === "ffmpeg" && r.role === "media");
  checks.record(
    C("merge/one-ffmpeg-merge-with-the-pre-job-sync-policy"),
    merges.length === 1 && mergeSyncMatches(merges[0].sync, expected),
    JSON.stringify({ observed: merges.map((m) => m.sync), expected }),
  );

  let timing = null;
  let outputEvent = null;
  if (produced !== null) {
    const outputTimeline = await probePacketTimeline(runTool, toolchain.ffprobePath, demuxer, produced);
    timing = evaluateMergeTiming({
      videoInput: videoIn,
      audioInput: audioIn,
      output: outputTimeline,
      movieTimescale: sync.target === "mp4" ? mp4MovieTimescale(await readFile(produced)) : null,
    });
    const outFlash = timing.measurable
      ? await decodedFlash(runTool, toolchain.ffmpegPath, demuxer, produced, outputTimeline.video.timeBase)
      : null;
    const outClick = timing.measurable ? await decodedClick(runTool, toolchain.ffmpegPath, demuxer, produced) : null;
    outputEvent = outFlash !== null && outClick !== null ? ratSub(outClick, outFlash) : null;
  }
  const measured = timing?.measurable === true;
  const tolerance = measured ? rational(BigInt(timing.toleranceUs), 1_000_000n) : null;
  const detail =
    measured
      ? `source ${timing.sourceRelativeUs}us -> output ${timing.outputRelativeUs}us; shift delta ` +
        `${timing.packetShiftDeltaUs}us; tolerance ${timing.toleranceUs}us`
      : "no merged artifact";
  checks.record(C("sync/payload-identical"), measured && timing.payloadIdentical, JSON.stringify(timing?.packets ?? null));
  checks.record(C("sync/codec-parameters-preserved"), measured && timing.codecParametersPreserved);
  checks.record(C("sync/relative-offset-preserved"), measured && timing.relativeTimingPreserved, detail);
  checks.record(C("sync/each-stream-shifted-by-one-constant"), measured && timing.shiftsConstant);
  checks.record(C("sync/no-media-hidden-or-unhidden"), measured && timing.noMediaHiddenOrUnhidden, JSON.stringify(timing?.packets ?? null));
  checks.record(C("sync/no-leading-gap"), measured && timing.noLeadingGap, `${timing?.outputEarliestPresentedUs ?? null}us`);
  checks.record(C("sync/stream-spans-preserved"), measured && timing.streamSpansPreserved);
  // The decoded event offset is held to the same time-base tolerance (with one
  // microsecond for the evidence rounding of that tolerance).
  checks.record(
    C("sync/decoded-sync-event-preserved"),
    measured && outputEvent !== null &&
      ratCmp(ratAbs(ratSub(outputEvent, sourceEvent)), ratAdd(tolerance, rational(1n, 1_000_000n))) <= 0,
    `click-flash source ${ratToMicros(sourceEvent)}us -> output ${outputEvent === null ? null : ratToMicros(outputEvent)}us`,
  );

  // ── zero-aligned controls: exactly what the historical merge produced ────
  let historicalIdentity = null;
  if (sync.kind === "control") {
    const historicalDir = join(workRoot, "historical", sync.name);
    await mkdir(historicalDir, { recursive: true });
    const hVideo = join(historicalDir, names.video);
    const hAudio = join(historicalDir, names.audio);
    const hOut = join(historicalDir, names.output);
    await copyFile(videoFixture, hVideo);
    await copyFile(audioFixture, hAudio);
    const historical = await runTool(toolchain.ffmpegPath, historicalSplitMergeArgs(sync.target, hVideo, hAudio, hOut));
    let identical = false;
    if (historical.code === 0 && produced !== null) {
      if (sync.target === "mp4") {
        // The MP4 muxer is deterministic: identical bytes.
        identical = sha256(await readFile(hOut)) === sha256(await readFile(produced));
        historicalIdentity = "bytes";
      } else {
        // The WebM muxer writes a random SegmentUID: identical packet timelines.
        identical = timelineIdentical(
          await probePacketTimeline(runTool, toolchain.ffprobePath, demuxer, hOut),
          await probePacketTimeline(runTool, toolchain.ffprobePath, demuxer, produced),
        );
        historicalIdentity = "packet-timeline";
      }
    }
    checks.record(C("compat/output-identical-to-the-historical-merge"), identical, historicalIdentity ?? "not compared");
  }

  await rm(workDir, { recursive: true, force: true });
  return {
    kind: sync.kind,
    target: sync.target,
    layout: sync.layout,
    audioCodec: sync.audioCodec,
    note: sync.note,
    design: {
      videoStartMs: sync.baseMs + sync.videoStartMs,
      audioStartMs: sync.baseMs + sync.audioStartMs,
      videoEndMs: sync.baseMs + sync.videoEndMs,
      audioEndMs: sync.baseMs + sync.audioEndMs,
      prerollMs: sync.prerollMs,
      bframes: sync.bframes,
    },
    source: {
      videoFirstPresentedUs: source.videoFirstPresentedUs,
      audioFirstPresentedUs: source.audioFirstPresentedUs,
      relativeUs: source.relativeUs,
      decodedEventOffsetUs: ratToMicros(sourceEvent),
      opusCodecDelayNs,
    },
    expectedSync: expected,
    observedSync: merges.map((m) => m.sync),
    productError,
    output: measured
      ? {
          relativeUs: timing.outputRelativeUs,
          relativeDeltaUs: timing.relativeDeltaUs,
          videoShiftUs: timing.videoShiftUs,
          audioShiftUs: timing.audioShiftUs,
          packetShiftDeltaUs: timing.packetShiftDeltaUs,
          toleranceUs: timing.toleranceUs,
          earliestPresentedUs: timing.outputEarliestPresentedUs,
          decodedEventOffsetUs: outputEvent === null ? null : ratToMicros(outputEvent),
          packets: timing.packets,
        }
      : null,
    historicalIdentity,
  };
}

// ── 3. The oracle can fail ─────────────────────────────────────────────────

async function oracleSensitivity(ctx) {
  const { checks, runTool, toolchain, workRoot } = ctx;
  const out = {};
  for (const name of SYNC_SENSITIVITY_CASES) {
    const sync = SYNC_CASES.find((x) => x.name === name);
    const demuxer = DEMUXER[sync.target];
    const names = syncHalfNames(sync.target);
    const fixtureDir = join(workRoot, "fixtures", name);
    const dir = join(workRoot, "sensitivity", name);
    await mkdir(dir, { recursive: true });
    await copyFile(join(fixtureDir, names.video), join(dir, names.video));
    await copyFile(join(fixtureDir, names.audio), join(dir, names.audio));
    const run = await runTool(
      toolchain.ffmpegPath,
      historicalSplitMergeArgs(sync.target, join(dir, names.video), join(dir, names.audio), join(dir, names.output)),
    );
    let timing = null;
    if (run.code === 0) {
      timing = evaluateMergeTiming({
        videoInput: await probePacketTimeline(runTool, toolchain.ffprobePath, demuxer, join(fixtureDir, names.video)),
        audioInput: await probePacketTimeline(runTool, toolchain.ffprobePath, demuxer, join(fixtureDir, names.audio)),
        output: await probePacketTimeline(runTool, toolchain.ffprobePath, demuxer, join(dir, names.output)),
        movieTimescale: sync.target === "mp4" ? mp4MovieTimescale(await readFile(join(dir, names.output))) : null,
      });
    }
    const detected = timing?.measurable === true && timing.relativeTimingPreserved === false;
    checks.record(
      `oracle/detects-per-input-zeroing/${name}`,
      detected,
      timing?.measurable ? `historical merge shift delta ${timing.packetShiftDeltaUs}us` : "historical merge failed",
    );
    out[name] = timing?.measurable
      ? { historicalShiftDeltaUs: timing.packetShiftDeltaUs, toleranceUs: timing.toleranceUs, detected }
      : { detected: false };
  }
  return out;
}

// ── 4. CLI ─────────────────────────────────────────────────────────────────

async function admitEvidencePath(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function main(argv) {
  const opts = parseArgv(argv);
  await admitEvidencePath(opts.evidence);

  const checks = createChecks();
  const startedAt = new Date().toISOString();
  const workRoot = await mkdtemp(join(tmpdir(), "sync01-"));
  const interfaces = Object.keys(networkInterfaces()).sort();
  let verdict = "BLOCKED";
  let toolchain = null;
  const cases = {};
  let sensitivity = null;
  let observer = null;

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
    // From here on every PRODUCT spawn is observed; the harness's own tools
    // run through the original spawn and never enter that ledger.
    observer = installSpawnObserver({ context: () => ({ status: "processing", phase: "merge" }) });
    const runTool = createToolRunner(observer.originalSpawn);
    toolchain = await preflight(checks, runTool);
    const ctx = { checks, runTool, toolchain, workRoot, observer };
    for (const sync of SYNC_CASES) {
      cases[sync.name] = await runCase(ctx, sync);
    }
    sensitivity = await oracleSensitivity(ctx);
    verdict = checks.passed() ? "PASS" : "FAIL";
  } catch (error) {
    checks.record("run/completed-without-error", false, error?.message ?? String(error));
    verdict = "FAIL";
    process.stderr.write(`[sync01] ${error?.stack ?? error}\n`);
  } finally {
    if (observer) observer.uninstall();
    await rm(join(config.tempDirectory, "sync01"), { recursive: true, force: true });
  }

  const record = buildSyncReleaseEvidence({
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: { commit: opts.sourceCommit, tree: opts.sourceTree, contextClean: opts.sourceContextClean },
    image: { candidateTag: opts.candidateTag, imageId: opts.candidateImageId, runSubject: opts.runImageId },
    network: { observedInterfaceNames: interfaces },
    toolchain,
    cases,
    sensitivity,
    checks: checks.all(),
  });
  await writeFile(opts.evidence, renderSyncReleaseEvidence(record), { flag: "wx" });
  await rm(workRoot, { recursive: true, force: true });

  const failed = checks.failed();
  process.stdout.write(`${verdict} ${SYNC01_RELEASE_EVIDENCE_SCHEMA} checks=${checks.all().length} failed=${failed.length}\n`);
  for (const f of failed) process.stdout.write(`  FAIL ${f.name}${f.detail ? ` :: ${f.detail}` : ""}\n`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[sync01] ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}

export { decodedClick, decodedFlash, timelineIdentical };
