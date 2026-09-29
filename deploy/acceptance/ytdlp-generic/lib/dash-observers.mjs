// DASH-01's observation primitives.
//
// All of them are OBSERVERS: they record what the real modules did and change
// nothing about what they do. Nothing here decides an outcome; the orchestrator
// compares their output against expectations it stated before the run.
//
//   1. the SPAWN observer  — every subprocess the Worker process starts, with
//                            the DURABLE job status read at the instant of the
//                            spawn call. This is the exact, not sampled, proof
//                            of "acquisition only while `downloading`, media
//                            tools only while `processing`".
//   2. the WORKSPACE sampler — the job directory's entries and sizes, sampled
//                            continuously, classified by the pinned FragmentFD
//                            grammar (an independent copy, not the product's).
//   3. the DOWNLOADER identity — the pinned runtime's own fragment-downloader
//                            banner read from a yt-dlp run's stdout, reduced to
//                            closed tags and one integer.

import { createRequire, syncBuiltinESMExports } from "node:module";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/** The pinned runtime's interpreter + artifact, as the product invokes it. */
export const YTDLP_ARTIFACT_PATH = "/usr/local/lib/videofetch/yt-dlp";

/** Product-owned basenames a media-tool spawn may name. A closed set. */
export const PRODUCT_MEDIA_BASENAMES = Object.freeze([
  "video-source.mp4",
  "audio-source.m4a",
  "merged.mp4",
]);

// ── 1. The spawn observer ──────────────────────────────────────────────────

/**
 * Reduces one spawn call to sanitized facts. Pure.
 *
 * Nothing of the argv survives except closed classifications: which tool, what
 * yt-dlp was asked to do, which PRODUCT-named files a media tool named, and
 * whether an FFmpeg run was a stream copy that refuses to overwrite.
 */
export function describeSpawn(command, args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const base = String(command ?? "").split("/").pop();
  let tool = "other";
  if (base === "ffmpeg" || base === "ffprobe") tool = base;
  else if (/^python3(\.\d+)?$/.test(base) && argv[0] === YTDLP_ARTIFACT_PATH) tool = "yt-dlp";

  let role = null;
  if (tool === "yt-dlp") {
    if (argv.includes("--version")) role = "runtime-probe";
    else if (argv.some((arg) => arg.startsWith("--format="))) role = "acquisition";
    else if (argv.includes("--dump-single-json")) role = "analysis";
    else role = "other";
  } else if (tool === "ffmpeg" || tool === "ffprobe") {
    role = argv.length === 1 && argv[0] === "-version" ? "capability-probe" : "media";
  }

  const touched =
    tool === "ffmpeg" || tool === "ffprobe"
      ? argv.map((arg) => arg.split("/").pop()).filter((name) => PRODUCT_MEDIA_BASENAMES.includes(name))
      : [];

  let streamCopy = null;
  let refusesOverwrite = null;
  if (tool === "ffmpeg" && role === "media") {
    const valuesOf = (flag) => argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1]] : []));
    const codecFlags = argv.filter((arg) => /^-(c|codec|vcodec|acodec)(:[a-z0-9]+)*$/.test(arg));
    streamCopy =
      valuesOf("-c:v").length === 1 && valuesOf("-c:v")[0] === "copy" &&
      valuesOf("-c:a").length === 1 && valuesOf("-c:a")[0] === "copy" &&
      codecFlags.length === 2;
    refusesOverwrite = argv.includes("-n") && !argv.includes("-y");
  }
  return { tool, role, touched, streamCopy, refusesOverwrite };
}

/**
 * Installs the observer over `child_process.spawn` for THIS process.
 *
 * `syncBuiltinESMExports` propagates the wrapped function to every ESM
 * `import { spawn } from "node:child_process"` binding, which is how the
 * product's `runProcess` reaches it. The wrapper records, then calls the
 * ORIGINAL with the caller's arguments untouched: the subprocess that runs is
 * the one the product would have run.
 *
 * `context()` is read synchronously at the spawn call and returns
 * `{ status, phase }` — the durable status straight out of the job store.
 *
 * The harness's own tools must be started with `originalSpawn` so they never
 * enter the product ledger.
 */
export function installSpawnObserver({ context }) {
  if (typeof context !== "function") throw new Error("the spawn observer needs a context reader");
  const childProcess = require("node:child_process");
  const originalSpawn = childProcess.spawn;
  const records = [];
  let seq = 0;
  childProcess.spawn = function observedSpawn(command, args) {
    let ctx = { status: "<unreadable>", phase: "<unknown>" };
    try {
      ctx = context();
    } catch {
      // An unreadable status is recorded as such; it never blocks the spawn.
    }
    records.push({ seq: (seq += 1), status: String(ctx.status), phase: String(ctx.phase), ...describeSpawn(command, args) });
    // `arguments`, not the named parameters: every argument the caller passed
    // (options included) reaches the original exactly as given.
    return originalSpawn.apply(this, arguments);
  };
  syncBuiltinESMExports();
  return {
    originalSpawn,
    records() {
      return records.map((record) => ({ ...record, touched: [...record.touched] }));
    },
    count() {
      return records.length;
    },
    uninstall() {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    },
  };
}

// ── 2. The workspace sampler ───────────────────────────────────────────────

const FRAGMENT_IN_FLIGHT = /^\.part-Frag[1-9][0-9]{0,8}\.part$/;
const FRAGMENT_COMPLETE = /^\.part-Frag[1-9][0-9]{0,8}$/;

/**
 * Classifies one job-directory entry by the pinned FragmentFD grammar.
 *
 * An independent restatement, deliberately NOT the product's classifier: the
 * harness must not use the code under test to judge it.
 */
export function classifyWorkspaceEntry(name) {
  if (name === "merged.mp4") return "output";
  const match = /^(video|audio)-source\.(mp4|m4a)(.*)$/.exec(name);
  if (match === null) return "unexpected";
  const suffix = match[3];
  if (suffix === "") return "final";
  if (suffix === ".part") return "aggregate";
  if (suffix === ".ytdl") return "bookkeeping";
  if (FRAGMENT_IN_FLIGHT.test(suffix)) return "fragment-in-flight";
  if (FRAGMENT_COMPLETE.test(suffix)) return "fragment-complete";
  return "unexpected";
}

/**
 * Samples one job directory while the job runs.
 *
 * Per phase it keeps the peak of all bytes, the peak of MEDIA bytes (every
 * entry except `.ytdl` bookkeeping) and every entry class seen. A sampler can
 * miss a state that lives between two ticks, so a peak here is a lower bound
 * on the true peak — corroboration, never the guard itself.
 */
export function createWorkspaceSampler({ intervalMs = 3 } = {}) {
  let directory = null;
  let phase = "idle";
  let timer = null;
  let busy = false;
  const perPhase = new Map();

  const bucket = (name) => {
    if (!perPhase.has(name)) {
      perPhase.set(name, { samples: 0, peakBytes: 0, peakMediaBytes: 0, classes: new Set() });
    }
    return perPhase.get(name);
  };

  const tick = async () => {
    if (busy || directory === null) return;
    busy = true;
    const at = phase;
    try {
      let names;
      try {
        names = await readdir(directory);
      } catch {
        return;
      }
      let total = 0;
      let media = 0;
      const classes = new Set();
      for (const name of names) {
        const kind = classifyWorkspaceEntry(name);
        classes.add(kind);
        try {
          const info = await lstat(join(directory, name));
          if (info.isFile()) {
            total += info.size;
            if (kind !== "bookkeeping") media += info.size;
          }
        } catch {
          // Gone between readdir and lstat: an entry renamed or deleted mid-sample.
        }
      }
      const b = bucket(at);
      b.samples += 1;
      b.peakBytes = Math.max(b.peakBytes, total);
      b.peakMediaBytes = Math.max(b.peakMediaBytes, media);
      for (const kind of classes) b.classes.add(kind);
    } finally {
      busy = false;
    }
  };

  return {
    setDirectory(path) {
      directory = path;
    },
    setPhase(next) {
      phase = String(next);
    },
    start() {
      if (timer === null) timer = setInterval(() => void tick(), intervalMs);
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      while (busy) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      directory = null;
    },
    /** One final synchronous-looking sample, for a state the caller is holding still. */
    async sampleNow() {
      while (busy) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      await tick();
    },
    summary() {
      return Object.fromEntries(
        [...perPhase].map(([name, b]) => [
          name,
          { samples: b.samples, peakBytes: b.peakBytes, peakMediaBytes: b.peakMediaBytes, classes: [...b.classes].sort() },
        ]),
      );
    },
  };
}

// ── 3. The downloader identity ─────────────────────────────────────────────

/**
 * The bracket tags a pinned acquisition run may print under the product's
 * console policy (`--no-quiet --no-progress --no-warnings`), and the fragment
 * downloader each fragment tag names. Anything else — `[ffmpeg]`, `[Merger]`,
 * a `[Fixup…]`, `[hlsnative]`, an external downloader — is outside the model.
 */
export const BENIGN_YTDLP_TAGS = Object.freeze(["download", "generic", "info"]);
export const FRAGMENT_DOWNLOADER_TAGS = Object.freeze({ dashsegments: "DashSegmentsFD" });

/**
 * Reads the downloader identity from one run's stdout. Pure.
 *
 * Returns only closed facts: the sorted distinct bracket tags (each reduced to
 * `[a-z0-9_]`, anything else recorded as `<other>`), the fragment downloader
 * classes those tags name, and the `Total fragments` count(s) the pinned
 * FragmentFD announced. No line text, path or URL survives.
 */
export function downloaderIdentity(stdout) {
  const tags = new Set();
  const totals = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    // Any bracketed prefix counts, spaces included (a postprocessor banner
    // may carry one); a tag outside the closed grammar is recorded as <other>.
    const tag = /^\[([^\]\r\n]{1,40})\]/.exec(line)?.[1];
    if (tag === undefined) continue;
    tags.add(/^[a-z0-9_]{1,24}$/.test(tag) ? tag : "<other>");
    const total = /^\[dashsegments\] Total fragments: ([1-9][0-9]{0,5})$/.exec(line);
    if (total) totals.push(Number(total[1]));
  }
  const sorted = [...tags].sort();
  return {
    tags: sorted,
    fragmentDownloaders: sorted.filter((tag) => Object.hasOwn(FRAGMENT_DOWNLOADER_TAGS, tag)).map((tag) => FRAGMENT_DOWNLOADER_TAGS[tag]),
    unexpectedTags: sorted.filter(
      (tag) => !BENIGN_YTDLP_TAGS.includes(tag) && !Object.hasOwn(FRAGMENT_DOWNLOADER_TAGS, tag),
    ),
    totalFragments: totals,
  };
}

/**
 * A recording delegate around the REAL `runProcess` for yt-dlp calls — the
 * product's documented `runner` seam. Forwards the options untouched; keeps
 * each call's phase, a closed role, the exit code and the downloader identity
 * read from its stdout. The stdout itself is never retained.
 */
export function createYtdlpLedger(realRunner) {
  const calls = [];
  let phase = "preflight";
  const runner = async (opts) => {
    const described = describeSpawn(opts.command, opts.args);
    const argv = [...(opts.args ?? [])].map(String);
    const entry = {
      phase,
      role: described.role,
      selector: argv.find((arg) => arg.startsWith("--format="))?.slice("--format=".length) ?? null,
      template: argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length) ?? null,
      policy: {
        nativeDownloader: argv.includes("--downloader=native"),
        fixupNever: argv.includes("--fixup=never"),
        oneFragmentAtATime: argv.includes("--concurrent-fragments=1"),
        noKeepFragments: argv.includes("--no-keep-fragments"),
        abortOnUnavailableFragments: argv.includes("--abort-on-unavailable-fragments"),
        ffmpegLocationNonexistent: argv.includes("--ffmpeg-location=/nonexistent/videofetch-yt-dlp-no-ffmpeg"),
        noLoadInfoJson: !argv.some((arg) => arg.startsWith("--load-info-json")),
      },
      exitCode: null,
      identity: null,
      failed: false,
    };
    calls.push(entry);
    try {
      const result = await realRunner(opts);
      entry.exitCode = result.code;
      entry.identity = downloaderIdentity(result.stdout);
      return result;
    } catch (error) {
      entry.failed = true;
      throw error;
    }
  };
  return {
    runner,
    setPhase(next) {
      phase = String(next);
    },
    calls() {
      return calls.map((call) => ({ ...call, policy: { ...call.policy } }));
    },
    acquisitions() {
      return this.calls().filter((call) => call.role === "acquisition");
    },
  };
}
