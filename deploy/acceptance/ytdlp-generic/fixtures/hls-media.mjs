// HLS-08's deterministic clear-HLS VOD fixture: generated at runtime by the
// accepted image's REAL FFmpeg, inside the acceptance container, before any
// Product process is observed.
//
// The fixture is HARNESS work. Its FFmpeg run is counted as "fixture tool
// use" and is never mistaken for HLS-4 processing: it runs through the
// harness's own spawn, before the Product subprocess observer is installed.
//
// ── Shape ──────────────────────────────────────────────────────────────────
//
//   H.264 (baseline 3.0) video, 640x360, 20 fps
//   AAC-LC audio, mono, 44.1 kHz
//   6 s total, a forced keyframe every 2 s, so FFmpeg's own HLS muxer cuts
//   exactly 3 MPEG-TS segments at stable boundaries
//   an FFmpeg-authored VOD media playlist: #EXTM3U, VERSION, TARGETDURATION,
//   MEDIA-SEQUENCE, PLAYLIST-TYPE:VOD, #EXTINF per segment, #EXT-X-ENDLIST
//
// No encryption, key, DRM, initialization map, fMP4, byte range, separate
// audio rendition, subtitle or discontinuity: the playlist stays inside the
// HLS-1 accepted subset, which the orchestrator re-checks with the Product's
// own parser before the run.
//
// The two NEGATIVE playlists are derived from the positive one by exactly one
// textual change each, so a negative outcome can only come from that change.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  HLS08_RAW_FORMAT_NAME,
  HLS_FRAGMENT_FAMILIES,
  HLS_KEY_ROUTE,
  HLS_MASTER_ROUTE,
} from "../lib/hls-fixture-url.mjs";

/** The fixture's declared shape. Every number here is asserted after generation. */
export const HLS_FIXTURE_SPEC = Object.freeze({
  width: 640,
  height: 360,
  fps: 20,
  durationSeconds: 6,
  segmentSeconds: 2,
  segmentCount: 3,
  videoCodec: "h264",
  audioCodec: "aac",
  /** RFC 6381 tags for the master's CODECS attribute: H.264 baseline 3.0, AAC-LC. */
  codecsAttribute: "avc1.42c01e,mp4a.40.2",
  bandwidth: 500000,
});

/** The FFmpeg-authored playlist's file name inside the generation directory. */
export const HLS_FIXTURE_PLAYLIST_FILE = "media.m3u8";

/** Ceiling on one generated segment; a runaway encode is refused, not served. */
export const HLS_FIXTURE_MAX_SEGMENT_BYTES = 2 * 1024 * 1024;

/**
 * The exact FFmpeg argv. Pure, so the determinism levers are pinned by a test
 * that spawns nothing. Every input is a `lavfi` generator: nothing is fetched.
 */
export function hlsFixtureFfmpegArgs(outDir) {
  if (typeof outDir !== "string" || !outDir.startsWith("/")) {
    throw new Error("the fixture needs an absolute output directory");
  }
  const s = HLS_FIXTURE_SPEC;
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${s.width}x${s.height}:rate=${s.fps}:duration=${s.durationSeconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${s.durationSeconds}`,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast",
    // x264 output depends on its thread count, otherwise derived from the CPU.
    "-threads", "1",
    "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level", "3.0",
    // A fixed keyframe cadence, so the muxer's cut points are stable.
    "-g", String(s.fps * s.segmentSeconds), "-keyint_min", String(s.fps * s.segmentSeconds),
    "-sc_threshold", "0", "-force_key_frames", `expr:gte(t,n_forced*${s.segmentSeconds})`,
    "-c:a", "aac", "-b:a", "64k", "-ac", "1",
    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    "-map_metadata", "-1",
    // FFmpeg's own HLS muxer writes the media playlist.
    "-f", "hls",
    "-hls_time", String(s.segmentSeconds),
    "-hls_list_size", "0",
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", join(outDir, `${HLS_FRAGMENT_FAMILIES.positive}%d.ts`),
    join(outDir, HLS_FIXTURE_PLAYLIST_FILE),
  ];
}

function runOnce(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Generates the fixture into `outDir` and returns its PRE-RUN identity: the
 * playlist text exactly as FFmpeg wrote it, and every segment's bytes, length
 * and digest, in playlist order, plus the digest of their ordered
 * concatenation — the value HLS-3's aggregate must later equal.
 */
export async function generateHlsFixture({ ffmpegPath, outDir, run = runOnce }) {
  await run(ffmpegPath, hlsFixtureFfmpegArgs(outDir));
  const playlistText = await readFile(join(outDir, HLS_FIXTURE_PLAYLIST_FILE), "utf8");

  const uris = playlistText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  const expected = Array.from(
    { length: HLS_FIXTURE_SPEC.segmentCount },
    (_, i) => `${HLS_FRAGMENT_FAMILIES.positive}${i}.ts`,
  );
  if (uris.length !== expected.length || uris.some((u, i) => u !== expected[i])) {
    throw new Error(
      `the generated playlist names ${uris.length} segments; the recipe requires exactly ` +
        `${expected.length} named ${expected.join(",")}`,
    );
  }
  const onDisk = (await readdir(outDir)).filter((f) => f.endsWith(".ts")).sort();
  if (onDisk.length !== expected.length) {
    throw new Error(`the generation directory holds ${onDisk.length} segments, not ${expected.length}`);
  }

  const segments = [];
  for (let i = 0; i < expected.length; i += 1) {
    const bytes = await readFile(join(outDir, expected[i]));
    if (bytes.byteLength === 0) throw new Error(`segment ${i + 1} is empty`);
    if (bytes.byteLength > HLS_FIXTURE_MAX_SEGMENT_BYTES) throw new Error(`segment ${i + 1} is oversized`);
    segments.push(
      Object.freeze({
        ordinal: i + 1,
        name: expected[i],
        path: join(outDir, expected[i]),
        bytes,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      }),
    );
  }
  if (new Set(segments.map((s) => s.sha256)).size !== segments.length) {
    throw new Error("the fixture segments must be distinct, or order could not be proven");
  }
  const aggregate = Buffer.concat(segments.map((s) => s.bytes));
  return Object.freeze({
    playlistText,
    segments: Object.freeze(segments),
    aggregateBytes: aggregate.byteLength,
    aggregateSha256: sha256(aggregate),
  });
}

/**
 * The master playlist: ONE ordinary variant. `NAME` makes the pinned
 * extractor's raw format id conspicuous (`hls-<NAME>`); the variant URI is
 * relative, carrying one private-by-contract marker in its query.
 */
export function hlsMasterPlaylist({ mediaUri }) {
  if (typeof mediaUri !== "string" || mediaUri.length === 0 || mediaUri.includes("\n")) {
    throw new Error("the master needs one relative media-playlist URI");
  }
  const s = HLS_FIXTURE_SPEC;
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-STREAM-INF:BANDWIDTH=${s.bandwidth},NAME="${HLS08_RAW_FORMAT_NAME}",` +
      `RESOLUTION=${s.width}x${s.height},CODECS="${s.codecsAttribute}"`,
    mediaUri,
    "",
  ].join("\n");
}

/** The submitted page: ordinary HTML5 markup naming the master. */
export function hlsFixturePage() {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>HLS-08 deterministic fixture</title></head>',
    "<body>",
    `<video controls><source src="${HLS_MASTER_ROUTE}" type="application/x-mpegURL"></video>`,
    "</body></html>",
    "",
  ].join("\n");
}

/**
 * NEGATIVE A: the positive playlist with ONE `#EXT-X-KEY` line inserted before
 * the first segment. HLS-1 refuses any key line, so HLS-2 must fail closed
 * after fetching it, before any fragment request.
 */
export function encryptedMediaPlaylist(playlistText) {
  const lines = playlistText.split("\n");
  const firstInf = lines.findIndex((l) => l.startsWith("#EXTINF"));
  if (firstInf < 0) throw new Error("the playlist has no segment");
  const keyUri = HLS_KEY_ROUTE.split("/").pop();
  lines.splice(firstInf, 0, `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}"`);
  return lines.join("\n");
}

/**
 * NEGATIVE B: the positive playlist with every segment renamed into the
 * failure family, so its requests can never be confused with the positive
 * run's. The fixture answers the SECOND of them with a non-200 status.
 */
export function fragmentFailureMediaPlaylist(playlistText) {
  const { positive, failure } = HLS_FRAGMENT_FAMILIES;
  return playlistText
    .split("\n")
    .map((l) => (l.startsWith(positive) && l.endsWith(".ts") ? `${failure}${l.slice(positive.length)}` : l))
    .join("\n");
}

/** The fragment-failure negative's failing ordinal, and the status it gets. */
export const HLS_FAILING_FRAGMENT = Object.freeze({ ordinal: 2, status: 503 });
