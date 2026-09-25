// HLS-08's subprocess observer and the pure policy readers it feeds.
//
// OBSERVER ONLY. `createProcessObserver` is installed through the Product's
// existing `setProcessRunnerTestHooks({ spawn })` seam, and its `spawn`
// delegates to the REAL `child_process.spawn` with the exact command, argv and
// options it received. It fakes no output, no exit code and no argv. What it
// adds is a ledger: which Product process started, classified, and the durable
// job status at that instant.
//
// Nothing here retains raw argv. The remux argv is read in memory by
// `evaluateHlsRemuxArgv`, which returns BOOLEAN policy facts; temporary paths,
// URLs and upstream ids never leave this module in a ledger entry.

import { basename, dirname, isAbsolute } from "node:path";

/** The spawn classes the ledger distinguishes. */
export const SPAWN_KINDS = Object.freeze([
  "ytdlp-runtime-probe",
  "ytdlp-analysis",
  "ytdlp-other",
  "ffmpeg-capability-probe",
  "hls-ffmpeg-remux",
  "ffmpeg-other",
  "ffprobe-media-probe",
  "other",
]);

/** The file names HLS-3 and HLS-4 own inside a job's work directory. */
export const HLS_AGGREGATE_FILE_NAME = "hls-source.ts";
export const HLS_OUTPUT_PARTIAL_FILE_NAME = "hls-output.mp4.part";
export const HLS_OUTPUT_FILE_NAME = "hls-output.mp4";

const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Classifies one Product spawn. Pure.
 *
 * @param {{command: string, args: readonly string[]}} spawnRecord
 * @param {{ytdlpPython: string, ytdlpArtifact: string, ffmpegPath: string, ffprobePath: string}} tools
 */
export function classifyProductSpawn({ command, args }, tools) {
  const argv = Array.isArray(args) ? args : [];
  if (command === tools.ytdlpPython && argv[0] === tools.ytdlpArtifact) {
    if (argv.includes("--version")) return "ytdlp-runtime-probe";
    if (argv.includes("--dump-single-json") && argv.includes("--skip-download")) return "ytdlp-analysis";
    return "ytdlp-other";
  }
  if (command === tools.ffmpegPath) {
    if (argv.length === 1 && argv[0] === "-version") return "ffmpeg-capability-probe";
    if (argv.includes("-i") && hasPair(argv, "-f", "mpegts") && hasPair(argv, "-c:v", "copy")) {
      return "hls-ffmpeg-remux";
    }
    return "ffmpeg-other";
  }
  if (command === tools.ffprobePath) return "ffprobe-media-probe";
  return "other";
}

/** The `-i` operand of an argv, or null. Used transiently, never recorded. */
export function inputOperand(args) {
  const argv = Array.isArray(args) ? args : [];
  const i = argv.indexOf("-i");
  return i >= 0 && typeof argv[i + 1] === "string" ? argv[i + 1] : null;
}

function hasPair(argv, a, b) {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === a && argv[i + 1] === b) return true;
  }
  return false;
}

function pairIndex(argv, a, b) {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === a && argv[i + 1] === b) return i;
  }
  return -1;
}

function count(argv, token) {
  return argv.filter((a) => a === token).length;
}

/** Codec/filter selectors that would mean something other than a pure copy. */
const NON_COPY_SELECTORS = Object.freeze([
  "-c", "-codec", "-vcodec", "-acodec", "-c:v:0", "-c:a:0", "-codec:v", "-codec:a",
  "-bsf", "-bsf:v", "-bsf:a", "-vf", "-af", "-filter", "-filter:v", "-filter:a",
  "-filter_complex", "-lavfi", "-q", "-q:v", "-q:a", "-b:v", "-b:a", "-crf", "-preset",
]);

/**
 * The reviewed HLS-4 remux policy, read from the argv that ACTUALLY executed.
 *
 * Returns one boolean per rule plus `ok` (all of them). Never returns an argv
 * element: the two operands are absolute temporary paths.
 */
export function evaluateHlsRemuxArgv(args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const inputIdx = argv.indexOf("-i");
  const input = inputIdx >= 0 ? argv[inputIdx + 1] ?? null : null;
  const output = argv.length > 0 ? argv[argv.length - 1] : null;
  const before = (idx) => idx >= 0 && inputIdx >= 0 && idx < inputIdx;
  const after = (idx) => idx >= 0 && inputIdx >= 0 && idx > inputIdx;

  const facts = {
    noOverwriteFirst: argv[0] === "-n",
    neverOverwriteFlagAbsent: !argv.includes("-y"),
    noStdin: argv.includes("-nostdin"),
    logLevelError: hasPair(argv, "-v", "error"),
    protocolWhitelistFileOnInput: before(pairIndex(argv, "-protocol_whitelist", "file")),
    inputDemuxerMpegts: before(pairIndex(argv, "-f", "mpegts")),
    exactlyOneInput: count(argv, "-i") === 1,
    inputIsTheHls3Aggregate:
      typeof input === "string" && isAbsolute(input) && basename(input) === HLS_AGGREGATE_FILE_NAME,
    mapsVideo00: hasPair(argv, "-map", "0:v:0"),
    mapsAudio00: hasPair(argv, "-map", "0:a:0"),
    exactlyTwoMaps: count(argv, "-map") === 2,
    videoStreamCopy: hasPair(argv, "-c:v", "copy") && count(argv, "-c:v") === 1,
    audioStreamCopy: hasPair(argv, "-c:a", "copy") && count(argv, "-c:a") === 1,
    noEncoderOrFilterSelection: !argv.some((a) => NON_COPY_SELECTORS.includes(a)),
    metadataDropped: hasPair(argv, "-map_metadata", "-1"),
    chaptersDropped: hasPair(argv, "-map_chapters", "-1"),
    faststart: hasPair(argv, "-movflags", "+faststart"),
    outputMuxerMp4: after(pairIndex(argv, "-f", "mp4")),
    outputIsThePartialName:
      typeof output === "string" &&
      isAbsolute(output) &&
      basename(output) === HLS_OUTPUT_PARTIAL_FILE_NAME &&
      typeof input === "string" &&
      dirname(output) === dirname(input),
    noUrlInArgv: !argv.some((a) => URL_LIKE.test(a)),
  };
  return { ok: Object.values(facts).every(Boolean), facts };
}

/**
 * The spawn observer.
 *
 * @param {object} opts
 * @param {Function} opts.realSpawn        `child_process.spawn`
 * @param {(cmd: string, args: string[]) => string} opts.classify
 * @param {() => string} opts.statusNow    durable job status right now
 * @param {() => string} [opts.caseNow]    acceptance case label right now
 * @param {{next(): number}} opts.eventClock
 * @param {(entry: object, command: string, args: readonly string[]) => void} [opts.beforeDelegate]
 *        Synchronous observation run BEFORE the real spawn, e.g. hashing the
 *        HLS-3 aggregate before any media tool has opened it. It receives the
 *        argv transiently and must not retain it.
 */
export function createProcessObserver({ realSpawn, classify, statusNow, caseNow = () => "unlabelled", eventClock, beforeDelegate }) {
  if (typeof realSpawn !== "function") throw new Error("the observer needs the real spawn");
  const entries = [];
  let armed = true;
  let spawnsWhileDisarmed = 0;

  const spawn = (command, args, options) => {
    if (!armed) spawnsWhileDisarmed += 1;
    const entry = {
      seq: eventClock.next(),
      caseLabel: caseNow(),
      kind: classify(command, args),
      tool: basename(String(command)),
      statusAtSpawn: statusNow(),
    };
    entries.push(entry);
    if (beforeDelegate) beforeDelegate(entry, command, args);
    // The exact command, argv and options the Product built.
    return realSpawn(command, args, options);
  };

  return {
    spawn,
    entries() {
      return entries.map((e) => ({ ...e }));
    },
    disarm() {
      armed = false;
    },
    spawnsWhileDisarmed() {
      return spawnsWhileDisarmed;
    },
  };
}

/**
 * Installs the observer through the Product seam for exactly the duration of
 * `fn`, and always clears it afterwards.
 */
export async function withProcessObserver(setProcessRunnerTestHooks, observer, fn) {
  if (typeof setProcessRunnerTestHooks !== "function") {
    throw new Error("the Product process-runner hook setter is required");
  }
  try {
    setProcessRunnerTestHooks({ spawn: observer.spawn });
    return await fn();
  } finally {
    setProcessRunnerTestHooks(null);
    observer.disarm();
  }
}

// ── Privacy scanning ───────────────────────────────────────────────────────

/**
 * Where one surface mentions the fixture hostname in a way that is NOT the
 * Product's ordinary echo of the submitted page.
 *
 * The Product legitimately echoes the page the user submitted: `webpageUrl`
 * is that URL, `source` is its hostname, and the durable row keeps both (the
 * job must re-analyze its own URL). That echo is ordinary Product metadata,
 * not HLS provenance. Every OTHER hostname occurrence that begins a
 * host:port/path reference — a media playlist, a fragment, a master — is a
 * leak. So an occurrence is admitted only when it is immediately followed by
 * exactly `:<port><page route>` (the page URL), or is not followed by `:` or
 * `/` at all (a bare hostname, i.e. the `source` echo).
 *
 * What FOLLOWS an admitted page echo is deliberately not inspected: raw SQLite
 * records store column values back to back, so the byte after the page URL is
 * the next column's data. The page route is not a prefix of any HLS route, and
 * every private marker, the raw upstream id and the playlist extension are
 * scanned for independently, so nothing HLS-private can hide behind the echo.
 *
 * Returns the number of unadmitted occurrences; 0 means clean.
 */
export function unadmittedHostnameOccurrences(text, { hostname, port, pageRoute }) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const pageTail = `:${port}${pageRoute}`;
  let bad = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(hostname, from);
    if (at < 0) break;
    const rest = text.slice(at + hostname.length);
    const pageEcho = rest.startsWith(pageTail);
    const bare = !rest.startsWith(":") && !rest.startsWith("/");
    if (!pageEcho && !bare) bad += 1;
    from = at + hostname.length;
  }
  return bad;
}

/**
 * Scans named surfaces for private needles and unadmitted hostname use.
 * Returns the SURFACE NAMES and needle LABELS that failed — never the needles.
 */
export function scanPrivacySurfaces(surfaces, { needles, hostname, port, pageRoute }) {
  const findings = [];
  for (const [surface, text] of Object.entries(surfaces)) {
    const value = typeof text === "string" ? text : String(text ?? "");
    for (const [label, needle] of Object.entries(needles)) {
      if (value.includes(needle)) findings.push({ surface, needle: label });
    }
    if (unadmittedHostnameOccurrences(value, { hostname, port, pageRoute }) > 0) {
      findings.push({ surface, needle: "fixture-hostname-outside-the-page-echo" });
    }
  }
  return findings;
}
