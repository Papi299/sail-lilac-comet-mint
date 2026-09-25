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

import {
  HLS08_PRIVATE_MARKERS,
  HLS08_PRIVATE_MARKER_PREFIX,
  HLS08_RAW_FORMAT_NAME,
  HLS_FRAGMENT_FAMILIES,
  HLS_KEY_ROUTE,
  HLS_MASTER_ROUTE,
  HLS_MEDIA_ROUTE,
  HLS_MEDIA_SIGNATURE_PARAMETER,
} from "./hls-fixture-url.mjs";

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

// ── Privacy placement ──────────────────────────────────────────────────────
//
// Two different questions, answered by two different tools.
//
// WHERE may the fixture hostname appear? Only a structured value can answer
// that, because only a structured value has fields. The Product legitimately
// echoes the page the user submitted: the browser-safe analysis carries it as
// `webpageUrl` and its hostname as `source`, and the durable row keeps `url`
// and `source` because the job re-analyzes its own URL. Those are ordinary
// Product echoes, not HLS acquisition provenance. `validateStructuredPrivacy`
// admits EXACTLY those field/value pairs — each named by its path and required
// to hold its exact value — and refuses the hostname in every other field and
// key. There is no "bare hostname anywhere" or "page URL prefix" allowance.
//
// Is any HLS acquisition provenance present? That is a needle question, and it
// can be asked of any text — including raw SQLite bytes, which are NOT
// field-delimited and legitimately contain the page URL and `source`.
// `scanRawPrivacyNeedles` makes no hostname claim at all; the structured rows
// are the authority on where the hostname is stored.

/**
 * HLS acquisition provenance, by label. Findings report the LABEL, never the
 * needle. Every one is refused on every scanned surface and admitted nowhere.
 * Needles match exactly as the harness authored them.
 */
export const HLS08_PRIVACY_NEEDLES = Object.freeze({
  "private-marker-prefix": HLS08_PRIVATE_MARKER_PREFIX,
  "browser-marker": HLS08_PRIVATE_MARKERS.browser,
  "execution-marker": HLS08_PRIVATE_MARKERS.execution,
  "encrypted-marker": HLS08_PRIVATE_MARKERS.encrypted,
  "fragment-marker": HLS08_PRIVATE_MARKERS["fragment-failure"],
  "no-ffmpeg-marker": HLS08_PRIVATE_MARKERS["no-ffmpeg"],
  "raw-hls-format-name": HLS08_RAW_FORMAT_NAME,
  "playlist-extension": "m3u8",
  "signature-parameter": `${HLS_MEDIA_SIGNATURE_PARAMETER}=`,
  "master-playlist-route": HLS_MASTER_ROUTE.replace(/\.m3u8$/, ""),
  "media-playlist-route": HLS_MEDIA_ROUTE.replace(/\.m3u8$/, ""),
  "key-name": HLS_KEY_ROUTE.split("/").pop().replace(/\.bin$/, ""),
  // `seg-` is also the tail of the failure family's `fail-seg-`.
  "fragment-name": HLS_FRAGMENT_FAMILIES.positive,
  "playlistUrl-field": "playlistUrl",
  "hlsSelections-field": "hlsSelections",
  "clear-hls-operation": "clear-hls-remux",
});

/** An admitted field that is absent, not a string, or not its exact value. */
export const HLS08_ADMISSION_FINDING = "admitted-field-not-the-exact-echo";
/** The fixture hostname in any field or key other than an exact admitted echo. */
export const HLS08_HOSTNAME_FINDING = "fixture-hostname-outside-an-admitted-field";

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function needleLabels(text, needles) {
  const labels = [];
  for (const [label, needle] of Object.entries(needles)) {
    if (typeof needle !== "string" || needle.length === 0) throw new TypeError(`empty privacy needle: ${label}`);
    if (text.includes(needle)) labels.push(label);
  }
  return labels;
}

/** Hostnames are case-insensitive, so the hostname is found in any letter case. */
function containsHostname(text, hostname) {
  return text.toLowerCase().includes(hostname.toLowerCase());
}

/** A key as it may appear in a finding: only a plain identifier that carries no needle. */
function safeSegment(key, needles, hostname) {
  return PLAIN_KEY.test(key) && needleLabels(key, needles).length === 0 && !containsHostname(key, hostname)
    ? key
    : "<key>";
}

/**
 * Field-aware privacy validation of ONE structured surface. Pure.
 *
 * `admitted` maps a field path (`webpageUrl`, `source`, `presets[0].label`) to
 * the exact string that field must hold. Each admitted path must be present
 * and hold exactly that value, or the surface fails with
 * `HLS08_ADMISSION_FINDING`. An admitted field holding its exact value is the
 * ONLY place the fixture hostname may appear: the hostname in any other string
 * value or object key, in any letter case, fails with `HLS08_HOSTNAME_FINDING`.
 * Every string value and key — admitted or not — is also scanned for every
 * needle.
 *
 * Returns `{ surface, field, finding }` records: the surface name, a sanitized
 * field path and a label. A scanned value never leaves this function.
 */
export function validateStructuredPrivacy(surface, value, { needles, hostname, admitted = {} }) {
  if (typeof hostname !== "string" || hostname.length === 0) throw new TypeError("a fixture hostname is required");
  const admittedPaths = new Map(Object.entries(admitted));
  for (const [path, expected] of admittedPaths) {
    if (typeof expected !== "string" || expected.length === 0) throw new TypeError(`admitted field ${path} needs an exact value`);
  }
  const findings = [];
  const exact = new Set();
  const seen = new WeakSet();
  const scanText = (text, field, admittedValue) => {
    for (const label of needleLabels(text, needles)) findings.push({ surface, field, finding: label });
    if (admittedValue !== undefined && text === admittedValue) {
      exact.add(field);
      return;
    }
    if (containsHostname(text, hostname)) findings.push({ surface, field, finding: HLS08_HOSTNAME_FINDING });
  };
  const walk = (node, path) => {
    const field = path === "" ? "<root>" : path;
    if (typeof node === "string") {
      scanText(node, field, admittedPaths.get(path));
      return;
    }
    if (node instanceof Uint8Array) {
      scanText(Buffer.from(node).toString("latin1"), field, undefined);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) {
      findings.push({ surface, field, finding: "cyclic-value" });
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const key of Object.keys(node)) {
      const segment = safeSegment(key, needles, hostname);
      const childPath = path === "" ? segment : `${path}.${segment}`;
      // A key is never an admitted echo.
      scanText(key, childPath, undefined);
      walk(node[key], childPath);
    }
  };
  walk(value, "");
  for (const path of admittedPaths.keys()) {
    if (!exact.has(path)) findings.push({ surface, field: path, finding: HLS08_ADMISSION_FINDING });
  }
  return findings;
}

/**
 * Needle-only scan of text that has no fields: raw SQLite database bytes. Pure.
 *
 * It answers only "is HLS acquisition provenance present?" and makes NO claim
 * about the fixture hostname. A SQLite file legitimately stores the submitted
 * page URL and `source`, possibly more than once (free pages, the WAL), and
 * its bytes cannot be attributed to a column. The structured rows are the
 * authority on where the hostname is stored — see `validateDurablePrivacy`.
 */
export function scanRawPrivacyNeedles(surface, bytes, { needles }) {
  const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("latin1");
  return needleLabels(text, needles).map((finding) => ({ surface, field: null, finding }));
}

/**
 * Field-aware validation of the durable state. Pure.
 *
 * @param {object} input
 * @param {Record<string, object[]>} input.tables every table of the database, by name, as rows
 * @param {Array<object|null>} input.views the Product's job view of each expected job
 * @param {string[]} input.expectedJobIds the jobs this run created
 *
 * `worker_jobs` must hold exactly the expected jobs, and each row admits only
 * `url` = the exact submitted page URL and `source` = the exact fixture
 * hostname. Each job view admits only `source` = the exact fixture hostname
 * (the view has no `url` field). Every other table admits nothing.
 */
export function validateDurablePrivacy({ tables, views, expectedJobIds, pageUrl, hostname, needles }) {
  const echo = [];
  const rows = [];
  const viewFindings = [];
  const split = (findings, into) => {
    for (const f of findings) (f.finding === HLS08_ADMISSION_FINDING ? echo : into).push(f);
  };
  const jobRows = tables.worker_jobs ?? [];
  const rowIds = jobRows.map((r) => r.job_id).sort();
  const expected = [...expectedJobIds].sort();
  const jobRowsAreTheExpectedJobs =
    expected.length > 0 && rowIds.length === expected.length && rowIds.every((id, i) => id === expected[i]);
  for (const [table, tableRows] of Object.entries(tables)) {
    const name = safeSegment(table, needles, hostname);
    const admitted = table === "worker_jobs" ? { url: pageUrl, source: hostname } : {};
    tableRows.forEach((row, i) => {
      split(validateStructuredPrivacy(`${name}[${i}]`, row, { needles, hostname, admitted }), rows);
    });
  }
  const viewsAreTheExpectedJobs =
    views.length === expected.length && views.every((v, i) => v !== null && typeof v === "object" && v.jobId === expectedJobIds[i]);
  views.forEach((view, i) => {
    split(validateStructuredPrivacy(`job view ${i}`, view, { needles, hostname, admitted: { source: hostname } }), viewFindings);
  });
  return { jobRowsAreTheExpectedJobs, viewsAreTheExpectedJobs, echo, rows, views: viewFindings };
}

/** Splits one surface's findings into exact-echo failures and everything else. */
export function partitionPrivacyFindings(findings) {
  return {
    echo: findings.filter((f) => f.finding === HLS08_ADMISSION_FINDING),
    other: findings.filter((f) => f.finding !== HLS08_ADMISSION_FINDING),
  };
}

/** `surface:field:finding` — labels only, safe for a check detail. */
export function describePrivacyFindings(findings) {
  return findings.map((f) => (f.field === null ? `${f.surface}:${f.finding}` : `${f.surface}:${f.field}:${f.finding}`)).join(",");
}
