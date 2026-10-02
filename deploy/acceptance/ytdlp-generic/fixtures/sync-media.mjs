// SYNC-01: the deterministic split-merge TIMING matrix — cases and recipes.
//
// SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001. Each case is a video-only
// and an audio-only half authored on ONE presentation timeline: the video
// covers [video start, video end), the audio [audio start, audio end), and both
// carry a single SYNC EVENT at presentation time EVENT_MS — a full-white video
// frame, and a 1 kHz burst over a quiet 220 Hz bed. Each file's container
// timestamps place its first media unit at `base + start`, in the container
// form the case names (progressive MP4 with edit lists, fragmented MP4 with the
// muxer's own zeroing or with absolute `tfdt`, WebM), so a correct merge keeps
// the click on the flash and every packet where the source put it.
//
// Every time here is an INTEGER number of milliseconds; the recipes format
// them as exact decimal seconds. Video starts, ends and pre-roll are multiples
// of 100 ms, so every frame boundary is exact at 30 fps.
//
// Pure and import-free, so the script tests pin it without FFmpeg.

export const SYNC_FPS = 30;
export const SYNC_AUDIO_RATE = 48_000;
export const SYNC_EVENT_MS = 2_000;

const MP4 = "mp4";
const WEBM = "webm";

/**
 * The matrix. `kind` says what each case controls for:
 *
 *   control    zero-aligned on disk; the corrected merge must produce exactly
 *              what the historical merge produced (bytes for MP4, the packet
 *              timeline for WebM), and nothing may move;
 *   offset     a legitimate relative A/V offset the merge must preserve;
 *   duration   an offset case whose EARLIER-starting stream is the SHORTER
 *              one, so a direction chosen from duration rather than start time
 *              trims media.
 */
export const SYNC_CASES = Object.freeze([
  // ── MP4 ──────────────────────────────────────────────────────────────────
  c("mp4-prog-zero", MP4, "prog", { kind: "control", note: "zero-aligned; AAC priming hidden by its edit list" }),
  c("mp4-prog-zero-bframes", MP4, "prog", { kind: "control", bframes: 2, note: "B-frames: negative video DTS under an edit list" }),
  c("mp4-prog-audio-late", MP4, "prog", { kind: "offset", audioStartMs: 478, note: "audio empty edit ~456 ms" }),
  c("mp4-prog-video-late", MP4, "prog", { kind: "offset", videoStartMs: 400 }),
  c("mp4-prog-shared-base", MP4, "prog", { kind: "offset", baseMs: 10_000, videoStartMs: 100, audioStartMs: 578 }),
  c("mp4-prog-audio-leads", MP4, "prog", { kind: "offset", baseMs: 10_000, videoStartMs: 500, audioStartMs: 100, bframes: 2 }),
  c("mp4-frag-dashlike-bframes", MP4, "frag-auto", { kind: "offset", bframes: 2, note: "B-frame composition delay, no edit list" }),
  c("mp4-frag-tfdt-audio-late", MP4, "frag-abs", { kind: "offset", audioStartMs: 478, note: "absolute tfdt" }),
  c("mp4-frag-tfdt-shared-base", MP4, "frag-abs", { kind: "offset", baseMs: 10_000, videoStartMs: 100, audioStartMs: 578, bframes: 2 }),
  c("mp4-prog-preroll-cut", MP4, "prog", { kind: "control", prerollMs: 500, note: "0.5 s of video pre-roll hidden by its edit list" }),
  c("mp4-prog-audio-leads-short", MP4, "prog", { kind: "duration", videoStartMs: 400, audioEndMs: 3_000 }),
  c("mp4-prog-video-leads-short", MP4, "prog", { kind: "duration", audioStartMs: 478, videoEndMs: 3_000 }),
  // ── WebM ─────────────────────────────────────────────────────────────────
  c("webm-opus-zero", WEBM, "webm", { kind: "control", note: "Opus CodecDelay: demuxed audio starts -7 ms" }),
  c("webm-opus-audio-late", WEBM, "webm", { kind: "offset", audioStartMs: 478 }),
  c("webm-opus-video-late", WEBM, "webm", { kind: "offset", videoStartMs: 400 }),
  c("webm-opus-shared-base", WEBM, "webm", { kind: "offset", baseMs: 10_000, videoStartMs: 100, audioStartMs: 578 }),
  c("webm-opus-audio-leads", WEBM, "webm", { kind: "offset", baseMs: 10_000, videoStartMs: 500, audioStartMs: 100 }),
  c("webm-vorbis-zero", WEBM, "webm", { kind: "control", audioCodec: "vorbis" }),
  c("webm-vorbis-audio-late", WEBM, "webm", { kind: "offset", audioCodec: "vorbis", audioStartMs: 478 }),
]);

function c(name, target, layout, opts) {
  return Object.freeze({
    name,
    target,
    layout,
    kind: opts.kind,
    videoStartMs: opts.videoStartMs ?? 0,
    audioStartMs: opts.audioStartMs ?? 0,
    baseMs: opts.baseMs ?? 0,
    videoEndMs: opts.videoEndMs ?? 4_000,
    audioEndMs: opts.audioEndMs ?? 4_000,
    prerollMs: opts.prerollMs ?? 0,
    bframes: opts.bframes ?? 0,
    audioCodec: target === MP4 ? "aac" : (opts.audioCodec ?? "opus"),
    note: opts.note ?? null,
  });
}

/** The cases whose corrected output must equal the historical merge's (see `kind`). */
export const SYNC_CONTROL_CASES = Object.freeze(SYNC_CASES.filter((x) => x.kind === "control").map((x) => x.name));

/** The offset cases the oracle-sensitivity control runs the historical merge on. */
export const SYNC_SENSITIVITY_CASES = Object.freeze(["mp4-prog-audio-late", "webm-opus-audio-late"]);

/** File names of each half, per target. */
export function syncHalfNames(target) {
  return target === MP4
    ? { video: "video-source.mp4", audio: "audio-source.m4a", output: "merged.mp4" }
    : { video: "video-source.webm", audio: "audio-source.webm", output: "merged.webm" };
}

/** Integer milliseconds as exact decimal seconds, e.g. 10_578 → "10.578", -500 → "-0.5". */
export function msToSeconds(ms) {
  if (!Number.isSafeInteger(ms)) throw new Error(`not an integer millisecond count: ${String(ms)}`);
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const fraction = String(abs % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${Math.floor(abs / 1000)}${fraction ? `.${fraction}` : ""}`;
}

function containerArgs(sync, role, startMs) {
  const offset = startMs !== 0 ? ["-output_ts_offset", msToSeconds(startMs)] : [];
  if (sync.target === WEBM) return [...offset, "-f", "webm"];
  if (sync.layout === "prog") return [...offset, "-movflags", "+faststart", "-f", role === "video" ? "mp4" : "ipod"];
  const fragment = role === "audio" ? ["-frag_duration", "500000"] : [];
  const keyframe = role === "video" ? "+frag_keyframe" : "";
  if (sync.layout === "frag-auto") {
    // The fragmented muxer's own default (auto avoid_negative_ts → make_zero,
    // no edit list): the shape the DASH-01 fixture has.
    return [...offset, ...fragment, "-movflags", `+empty_moov+default_base_moof+skip_trailer${keyframe}`, "-f", "mp4"];
  }
  if (sync.layout === "frag-abs") {
    // FFmpeg's own mid-stream-segment mode: the first fragment's tfdt is the
    // absolute decode time, as a DASH segment cut from a longer timeline is.
    return [
      ...offset, ...fragment,
      "-use_editlist", "0", "-avoid_negative_ts", "disabled",
      "-movflags", `+empty_moov+default_base_moof+skip_trailer+frag_discont${keyframe}`,
      "-f", "mp4",
    ];
  }
  throw new Error(`unknown layout ${sync.layout}`);
}

const HEAD = ["-hide_banner", "-nostdin", "-v", "error", "-y", "-fflags", "+bitexact"];

/** The exact FFmpeg recipe for one case's VIDEO half. */
export function syncVideoArgs(sync, outPath) {
  const spanMs = sync.videoEndMs - sync.videoStartMs + sync.prerollMs;
  const eventFrameMs = SYNC_EVENT_MS - sync.videoStartMs + sync.prerollMs;
  if (spanMs % 100 !== 0 || eventFrameMs % 100 !== 0) throw new Error(`${sync.name}: video times must be 100 ms multiples`);
  const eventFrame = (eventFrameMs * SYNC_FPS) / 1000;
  const source =
    `testsrc2=size=320x180:rate=${SYNC_FPS}:duration=${msToSeconds(spanMs)},` +
    `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,${eventFrame})'`;
  const codec =
    sync.target === MP4
      ? ["-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
         "-bf", String(sync.bframes), "-pix_fmt", "yuv420p", "-b:v", "300k", "-flags:v", "+bitexact"]
      : ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-threads", "1", "-g", "30",
         "-b:v", "300k", "-pix_fmt", "yuv420p", "-flags:v", "+bitexact"];
  return [
    ...HEAD, "-f", "lavfi", "-i", source, "-an", "-map_metadata", "-1", ...codec,
    ...containerArgs(sync, "video", sync.baseMs + sync.videoStartMs - sync.prerollMs),
    outPath,
  ];
}

/** The exact FFmpeg recipe for one case's AUDIO half. */
export function syncAudioArgs(sync, outPath) {
  const clickMs = SYNC_EVENT_MS - sync.audioStartMs;
  const expression =
    `0.8*sin(2*PI*1000*t)*between(t,${msToSeconds(clickMs)},${msToSeconds(clickMs + 20)})` +
    "+0.02*sin(2*PI*220*t)";
  const source = `aevalsrc=exprs='${expression}':s=${SYNC_AUDIO_RATE}:d=${msToSeconds(sync.audioEndMs - sync.audioStartMs)}`;
  const encoder = { aac: "aac", opus: "libopus", vorbis: "libvorbis" }[sync.audioCodec];
  if (!encoder) throw new Error(`${sync.name}: unknown audio codec`);
  return [
    ...HEAD, "-f", "lavfi", "-i", source, "-vn", "-map_metadata", "-1",
    "-c:a", encoder, "-b:a", "64k", "-ac", "1", "-ar", String(SYNC_AUDIO_RATE), "-flags:a", "+bitexact",
    ...containerArgs(sync, "audio", sync.baseMs + sync.audioStartMs),
    outPath,
  ];
}

/**
 * The HISTORICAL merge argv — `buildSplitMergeArgs()` exactly as `main`
 * `73176b20` built it (pinned there by `ffmpeg.server.test.ts`), with NO
 * cross-input synchronization. A frozen REFERENCE, never product code: the
 * harness runs it to prove the corrected merge leaves zero-aligned inputs
 * exactly as they always were, and that the timing oracle detects the
 * per-input zeroing it produces on an offset pair.
 */
export function historicalSplitMergeArgs(target, videoPath, audioPath, outputPath) {
  const demuxer = target === MP4 ? "mov" : "matroska";
  return [
    "-n", "-nostdin", "-v", "error",
    "-protocol_whitelist", "file", "-f", demuxer, "-i", videoPath,
    "-protocol_whitelist", "file", "-f", demuxer, "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "copy",
    "-map_metadata", "-1", "-map_chapters", "-1",
    ...(target === MP4 ? ["-movflags", "+faststart"] : []),
    "-f", target, outputPath,
  ];
}
