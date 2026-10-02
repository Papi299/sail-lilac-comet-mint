// HLS-11's observation primitives. OBSERVERS only: they record what the real
// modules did and change nothing about what they do.
//
//   1. the SPAWN observer    — every subprocess the Worker process starts, with
//                              the DURABLE job status read at the spawn call,
//                              reduced to closed facts (tool, role, the HLS
//                              product files it named, the input demuxer, and
//                              for FFmpeg whether it was a no-overwrite stream
//                              copy). An optional hook sees the call BEFORE it
//                              is delegated, so the acquired aggregate can be
//                              hashed before any media tool has read it.
//   2. the WORKSPACE sampler — the job directory's entries and sizes, sampled
//                              continuously and classified by the HLS artifact
//                              grammar (an independent restatement, not the
//                              product's constants).
//   3. the ANALYSIS-DOCUMENT reducer — sanitized facts about one pinned-yt-dlp
//                              `-J` document: which HLS renditions it lists and
//                              what, if anything, relates video to audio.

import { createRequire, syncBuiltinESMExports } from "node:module";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describeSpawn } from "./dash-observers.mjs";

const require = createRequire(import.meta.url);

/** The HLS product file names a media tool may name. A closed set. */
export const HLS11_PRODUCT_BASENAMES = Object.freeze([
  "hls-source.ts",
  "hls-source.fmp4",
  "hls-output.mp4.part",
  "hls-output.mp4",
]);

/** Reduces one spawn call to sanitized HLS facts. Pure. */
export function describeHlsSpawn(command, args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const base = describeSpawn(command, argv);
  const touched =
    base.tool === "ffmpeg" || base.tool === "ffprobe"
      ? argv.map((arg) => arg.split("/").pop()).filter((name) => HLS11_PRODUCT_BASENAMES.includes(name))
      : [];
  let demuxer = null;
  const input = argv.indexOf("-i");
  if ((base.tool === "ffmpeg" || base.tool === "ffprobe") && input > 0) {
    const format = argv.lastIndexOf("-f", input);
    demuxer = format >= 0 && format < input ? argv[format + 1] : null;
  }
  const inputName = input >= 0 && typeof argv[input + 1] === "string" ? argv[input + 1].split("/").pop() : null;
  return {
    tool: base.tool,
    role: base.role,
    touched,
    demuxer,
    input: HLS11_PRODUCT_BASENAMES.includes(inputName) ? inputName : inputName === null ? null : "<other>",
    streamCopy: base.streamCopy,
    refusesOverwrite: base.refusesOverwrite,
  };
}

/**
 * Installs the observer over `child_process.spawn` for THIS process (the same
 * mechanism as DASH-01's: `syncBuiltinESMExports` reaches the product's
 * `import { spawn }` binding). `beforeDelegate(record, command, args)` runs
 * synchronously before the real spawn and must not throw. `describe` reduces
 * one call to its closed facts: this module's HLS-11 reducer by default; HLS-12
 * passes its own, for its own product file names.
 */
export function installHlsSpawnObserver({ context, beforeDelegate = null, describe = describeHlsSpawn }) {
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
    const record = { seq: (seq += 1), status: String(ctx.status), phase: String(ctx.phase), ...describe(command, args) };
    records.push(record);
    if (beforeDelegate !== null) {
      try {
        beforeDelegate(record, command, args);
      } catch {
        // An observer failure never changes what the product runs.
      }
    }
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

/** Classifies one job-directory entry by the HLS artifact grammar. */
export function classifyHlsWorkspaceEntry(name) {
  if (name === "hls-source.ts" || name === "hls-source.fmp4") return "aggregate";
  if (name === "hls-source.ts.part" || name === "hls-source.fmp4.part") return "aggregate-partial";
  if (name === "hls-output.mp4.part") return "output-partial";
  if (name === "hls-output.mp4") return "output";
  return "unexpected";
}

/**
 * Samples one job directory while the job runs: per phase, the peak of all
 * bytes and every entry class seen. A peak is a LOWER bound on the true peak —
 * corroboration, never the guard itself. `classify` is the artifact grammar:
 * HLS-11's by default; HLS-12 passes its own.
 */
export function createHlsWorkspaceSampler({ intervalMs = 3, classify = classifyHlsWorkspaceEntry } = {}) {
  let directory = null;
  let phase = "idle";
  let timer = null;
  let busy = false;
  const perPhase = new Map();
  const bucket = (name) => {
    if (!perPhase.has(name)) perPhase.set(name, { samples: 0, peakBytes: 0, classes: new Set() });
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
      const classes = new Set();
      for (const name of names) {
        classes.add(classify(name));
        try {
          const info = await lstat(join(directory, name));
          if (info.isFile()) total += info.size;
        } catch {
          // Renamed or removed between readdir and lstat.
        }
      }
      const b = bucket(at);
      b.samples += 1;
      b.peakBytes = Math.max(b.peakBytes, total);
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
    async sampleNow() {
      while (busy) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      await tick();
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      while (busy) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      directory = null;
    },
    summary() {
      return Object.fromEntries(
        [...perPhase].map(([name, b]) => [name, { samples: b.samples, peakBytes: b.peakBytes, classes: [...b.classes].sort() }]),
      );
    },
  };
}

// ── 3. Analysis document facts (the pairing evidence) ──────────────────────

/**
 * Sanitized facts about one pinned-yt-dlp `-J` document: which HLS formats it
 * lists and what, if anything, relates a video rendition to an audio one. The
 * document itself is dropped.
 */
export function analysisDocumentFacts(stdout) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { parsed: false };
  }
  const formats = Array.isArray(doc?.formats) ? doc.formats.filter((f) => f?.protocol === "m3u8_native") : [];
  const isAudioOnly = (f) => f.vcodec === "none";
  const video = formats.filter((f) => !isAudioOnly(f));
  const audio = formats.filter(isAudioOnly);
  const keysOf = (f) => Object.keys(f).sort();
  const relationshipKeys = [...new Set(formats.flatMap((f) => Object.keys(f)))]
    .filter((key) => /group/i.test(key) || key.startsWith("_"))
    .sort();
  const byHeight = (h) => video.find((f) => f.height === h) ?? null;
  const grouped = byHeight(1080);
  const control = byHeight(720);
  return {
    parsed: true,
    extractorKey: typeof doc?.extractor_key === "string" ? doc.extractor_key : null,
    hlsFormats: formats.length,
    videoRenditions: video.length,
    audioRenditions: audio.length,
    audioRenditionsHaveNoAudioCodec: audio.every((f) => f.acodec === undefined || f.acodec === null),
    videoRenditionsAudioCodecIsNone: video.every((f) => f.acodec === "none"),
    relationshipKeys,
    groupedAndControlVariantsShareOneKeySet:
      grouped !== null && control !== null && sameStringList(keysOf(grouped), keysOf(control)),
    groupedAndControlVariantsBothAcodecNone: grouped?.acodec === "none" && control?.acodec === "none",
    audioSourcePreferences: audio.map((f) => (typeof f.source_preference === "number" ? f.source_preference : null)).sort(),
  };
}

function sameStringList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
