// HLS-12's observation primitives. OBSERVERS only: they record what the real
// modules did and change nothing about what they do. The spawn observer and
// the workspace sampler are HLS-11's (`lib/hls11-observers.mjs`), handed this
// module's reducers:
//
//   1. the SPAWN reducer      — one subprocess call reduced to closed facts:
//                               the tool, its role, the HLS-12 product file
//                               behind EACH input and the demuxer named for
//                               it, the output's product name, and for FFmpeg
//                               the stream-copy / no-overwrite flags and the
//                               merge's closed synchronization tokens.
//   2. the WORKSPACE grammar  — the separate-audio artifact names, restated
//                               independently of the product's constants.
//   3. the ANALYSIS-DOCUMENT reducer — sanitized facts about one pinned-yt-dlp
//                               `-J` document: which HLS renditions it lists,
//                               that nothing in it relates the video to the
//                               audio, and that every row names one manifest.

import { describeSpawn } from "./dash-observers.mjs";

/** The separate-audio product file names a media tool may name. A closed set. */
export const HLS12_PRODUCT_BASENAMES = Object.freeze(["hls-video.fmp4", "hls-audio.fmp4", "merged.mp4"]);

const productName = (path) => {
  const leaf = String(path).split("/").pop();
  return HLS12_PRODUCT_BASENAMES.includes(leaf) ? leaf : "<other>";
};

/** Reduces one spawn call to sanitized HLS-12 facts. Pure. */
export function describeHls12Spawn(command, args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const base = describeSpawn(command, argv);
  const media = base.tool === "ffmpeg" || base.tool === "ffprobe";
  const inputAt = media ? argv.flatMap((arg, i) => (arg === "-i" ? [i] : [])) : [];
  const inputs = inputAt.map((i) => (typeof argv[i + 1] === "string" ? productName(argv[i + 1]) : "<other>"));
  // The demuxer named for each input: the last `-f` after the previous input.
  const demuxers = inputAt.map((i, k) => {
    const from = k === 0 ? 0 : inputAt[k - 1] + 2;
    const at = argv.lastIndexOf("-f", i);
    return at >= from && at < i ? argv[at + 1] : null;
  });
  return {
    tool: base.tool,
    role: base.role,
    touched: media ? argv.map((arg) => arg.split("/").pop()).filter((name) => HLS12_PRODUCT_BASENAMES.includes(name)) : [],
    inputs: Object.freeze(inputs),
    demuxers: Object.freeze(demuxers),
    input: inputs[0] ?? null,
    demuxer: demuxers[0] ?? null,
    output: base.tool === "ffmpeg" && base.role === "media" ? productName(argv[argv.length - 1]) : null,
    streamCopy: base.streamCopy,
    refusesOverwrite: base.refusesOverwrite,
    sync: base.sync,
  };
}

/** Classifies one job-directory entry by the separate-audio artifact grammar. */
export function classifyHls12WorkspaceEntry(name) {
  if (name === "hls-video.fmp4" || name === "hls-audio.fmp4") return "half";
  if (name === "hls-video.fmp4.part" || name === "hls-audio.fmp4.part") return "half-partial";
  if (name === "merged.mp4") return "output";
  return "unexpected";
}

/**
 * Sanitized facts about one pinned-yt-dlp `-J` document. `expectedMasterUrl`
 * is compared, never retained: only booleans and counts leave this function.
 */
export function hls12AnalysisDocumentFacts(stdout, expectedMasterUrl) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { parsed: false };
  }
  const formats = Array.isArray(doc?.formats) ? doc.formats.filter((f) => f?.protocol === "m3u8_native") : [];
  const hasVideo = (f) => typeof f.vcodec === "string" && f.vcodec !== "none";
  const audioOnly = formats.filter((f) => f.vcodec === "none");
  const videoOnly = formats.filter((f) => hasVideo(f) && f.acodec === "none");
  const muxed = formats.filter((f) => hasVideo(f) && f.acodec !== "none");
  const relationshipKeys = [...new Set(formats.flatMap((f) => Object.keys(f)))]
    .filter((key) => /group/i.test(key) || key.startsWith("_"))
    .sort();
  return {
    parsed: true,
    extractorKey: typeof doc?.extractor_key === "string" ? doc.extractor_key : null,
    hlsFormats: formats.length,
    videoOnlyRenditions: videoOnly.length,
    audioOnlyRenditions: audioOnly.length,
    muxedRenditions: muxed.length,
    videoOnlyHeights: videoOnly.map((f) => (Number.isInteger(f.height) ? f.height : null)).sort(),
    relationshipKeys,
    everyRowNamesTheSubmittedMaster:
      formats.length > 0 && formats.every((f) => typeof f.manifest_url === "string" && f.manifest_url === expectedMasterUrl),
  };
}
