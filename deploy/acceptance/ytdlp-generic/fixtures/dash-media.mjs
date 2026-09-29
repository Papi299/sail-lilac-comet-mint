// The deterministic DASH-01 fixture: recipes, the fragmented-MP4 splitter, the
// closed route table and the two MPD manifests.
//
// ── What this produces ─────────────────────────────────────────────────────
//
// THREE harness-generated media files, each carrying exactly ONE stream:
//
//   video-fragmented  1920x1080 H.264, fragmented ISO-BMFF, no audio
//   audio-fragmented  AAC-LC, fragmented ISO-BMFF, no video
//   audio-progressive AAC-LC, ordinary (faststart) ISO-BMFF `.m4a`, no video
//
// The two fragmented files are cut at their top-level box boundaries into an
// INITIALIZATION segment (`ftyp` + `moov`) and N MEDIA segments (`moof` +
// `mdat` each), and served as a static MPD `SegmentList`. The pinned yt-dlp
// therefore sees `http_dash_segments` renditions and acquires them with its
// native `DashSegmentsFD`, fragment by fragment. The progressive audio is
// served whole through a `<BaseURL>`, which the pinned GenericIE resolves to an
// ordinary `http` progressive source (see `split-media.mjs` for that branch).
//
// Two manifests, one per pairing:
//
//   dash-dash         segmented video + segmented audio
//   dash-progressive  segmented video + progressive audio
//
// ── Why the recipes live here and not as checked-in binaries ───────────────
//
// The same rule SPLIT-06 and HLS-08 follow: every expected digest must exist
// BEFORE the job runs and must never be derived from something that travelled
// through VideoFetch. A recipe executed by the candidate image's own FFmpeg
// makes that reproducible by a reviewer from the same image the Worker runs.
// `-fflags +bitexact`, the per-stream `+bitexact` flags, `-map_metadata -1`
// and single-threaded encoders pin the output; the orchestrator regenerates
// the fragmented video a second time and requires identical bytes.
//
// ── Why this is small ──────────────────────────────────────────────────────
//
// It is a correctness proof of the real segmented chain, not a bandwidth
// test: 2 s of 1920x1080 at a low bitrate is well under a megabyte, and every
// media segment is far below any configured `--max-filesize`.
//
// Import-free apart from Node built-ins, so a script test can pin the pure
// parts without FFmpeg.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The SYNTHETIC upstream format identifiers the manifests declare.
 *
 * Harness-owned and conspicuous, so the privacy sweep has an unambiguous
 * needle. They satisfy the product's safe-id grammar, and they are not
 * production identifiers.
 */
export const DASH_SYNTHETIC_FORMAT_IDS = Object.freeze({
  video: "DASH01_VIDEO_1080",
  audio: "DASH01_AUDIO_SEGMENTED",
  progressiveAudio: "DASH01_AUDIO_PROGRESSIVE",
});

/** The two positive pairings, in the order the orchestrator runs them. */
export const DASH_CASES = Object.freeze(["dash-dash", "dash-progressive"]);

/** The audio half each case must pair with, by protocol the pinned runtime reports. */
export const DASH_CASE_AUDIO_PROTOCOL = Object.freeze({
  "dash-dash": "http_dash_segments",
  // The fixture is plain HTTP on loopback inside a `--network none` container,
  // so the progressive half is `http`. `https` differs only in transport: the
  // pinned runtime acquires both with the same native `HttpFD`.
  "dash-progressive": "http",
});

/** What the media must be. Every value is asserted against an observation. */
export const DASH_FIXTURE_SPEC = Object.freeze({
  video: Object.freeze({
    width: 1920,
    height: 1080,
    fps: 24,
    gop: 12,
    durationSeconds: 2,
    codecs: "avc1.640028",
    bandwidth: 600000,
  }),
  audio: Object.freeze({ sampleRate: 44100, durationSeconds: 2, codecs: "mp4a.40.2", bandwidth: 64000 }),
  /** Nominal segment duration the manifests declare, in milliseconds. */
  segmentMilliseconds: 500,
  /** A segmented rendition with fewer media segments proves too little. */
  minMediaSegments: 3,
  /** Ceiling on any one generated file; a guard against a recipe retune, not a product bound. */
  maxFileBytes: 2 * 1024 * 1024,
});

/** The requested public preset and its expected rung. */
export const DASH_REQUESTED_PRESET = "preset:1080";
export const DASH_EXPECTED_RESOLUTION = "1080p";

/** The merged artifact's container and MIME, from the closed pair table. */
export const DASH_TARGET_CONTAINER = "mp4";
export const DASH_TARGET_MIME = "video/mp4";

/** Route prefixes. Every route the service can answer is derived from these. */
const ROUTE_PREFIX = "/dash01";

export const DASH_MANIFEST_ROUTE = Object.freeze({
  "dash-dash": `${ROUTE_PREFIX}-dash-dash.mpd`,
  "dash-progressive": `${ROUTE_PREFIX}-dash-progressive.mpd`,
});

/** The init route of a segmented rendition. Relative names keep the MPD free of any origin. */
export function dashInitRoute(role) {
  assertRole(role);
  return `${ROUTE_PREFIX}-${role}-init.mp4`;
}

/** The route of media segment `ordinal` (1-based) of a segmented rendition. */
export function dashSegmentRoute(role, ordinal) {
  assertRole(role);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 999) {
    throw new Error("a media segment ordinal is a positive integer");
  }
  return `${ROUTE_PREFIX}-${role}-${ordinal}.m4s`;
}

/** The progressive audio route. */
export const DASH_PROGRESSIVE_AUDIO_ROUTE = `${ROUTE_PREFIX}-audio-progressive.m4a`;

function assertRole(role) {
  if (role !== "video" && role !== "audio") throw new Error(`unknown segmented role ${String(role)}`);
}

/**
 * Classifies one request path against the closed route table.
 *
 * Returns `{ kind, role, ordinal }` where kind is `manifest` | `init` |
 * `segment` | `progressive` | `unknown`. Pure: the service records only this
 * classification, never the path.
 */
export function classifyDashRoute(path, { segmentCounts }) {
  for (const [name, route] of Object.entries(DASH_MANIFEST_ROUTE)) {
    if (path === route) return { kind: "manifest", role: null, ordinal: null, caseName: name };
  }
  if (path === DASH_PROGRESSIVE_AUDIO_ROUTE) return { kind: "progressive", role: "audio", ordinal: null, caseName: null };
  for (const role of ["video", "audio"]) {
    if (path === dashInitRoute(role)) return { kind: "init", role, ordinal: 0, caseName: null };
    const count = segmentCounts?.[role] ?? 0;
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      if (path === dashSegmentRoute(role, ordinal)) return { kind: "segment", role, ordinal, caseName: null };
    }
  }
  return { kind: "unknown", role: null, ordinal: null, caseName: null };
}

// ── Recipes ────────────────────────────────────────────────────────────────

/**
 * The EXACT FFmpeg recipe for one fixture file. Pure; every input is a `lavfi`
 * generator, so nothing is fetched and no external media is involved.
 *
 * The fragmented recipes use `empty_moov` + `default_base_moof` (a
 * self-contained init segment and position-independent fragments, the shape a
 * DASH packager emits) and `skip_trailer` (no `mfra` index after the last
 * fragment). The video's fixed GOP puts a keyframe, and therefore a fragment
 * boundary, every 0.5 s.
 */
export function dashFfmpegArgs(kind, outPath) {
  const head = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-fflags", "+bitexact"];
  const { video, audio } = DASH_FIXTURE_SPEC;
  if (kind === "video-fragmented") {
    return [
      ...head,
      "-f", "lavfi",
      "-i", `testsrc2=size=${video.width}x${video.height}:rate=${video.fps}:duration=${video.durationSeconds}`,
      "-an",
      "-c:v", "libx264", "-preset", "veryfast",
      // x264's output depends on its thread count, which is otherwise derived
      // from the host CPU count.
      "-threads", "1",
      "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0",
      "-g", String(video.gop), "-keyint_min", String(video.gop), "-sc_threshold", "0",
      "-b:v", "600k", "-maxrate", "600k", "-bufsize", "600k",
      "-flags:v", "+bitexact", "-map_metadata", "-1", "-t", String(video.durationSeconds),
      "-movflags", "+empty_moov+default_base_moof+frag_keyframe+skip_trailer",
      "-f", "mp4", outPath,
    ];
  }
  if (kind === "audio-fragmented") {
    return [
      ...head,
      "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${audio.sampleRate}:duration=${audio.durationSeconds}`,
      "-vn",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
      "-flags:a", "+bitexact", "-map_metadata", "-1", "-t", String(audio.durationSeconds),
      "-frag_duration", String(DASH_FIXTURE_SPEC.segmentMilliseconds * 1000),
      "-movflags", "+empty_moov+default_base_moof+skip_trailer",
      "-f", "mp4", outPath,
    ];
  }
  if (kind === "audio-progressive") {
    return [
      ...head,
      // A different tone, so the two audio renditions can never be one file.
      "-f", "lavfi", "-i", `sine=frequency=660:sample_rate=${audio.sampleRate}:duration=${audio.durationSeconds}`,
      "-vn",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
      "-flags:a", "+bitexact", "-map_metadata", "-1", "-t", String(audio.durationSeconds),
      "-movflags", "+faststart",
      "-f", "ipod", outPath,
    ];
  }
  throw new Error(`unknown DASH fixture kind ${String(kind)}`);
}

/** The generated files, by kind. */
export const DASH_FIXTURE_FILES = Object.freeze({
  "video-fragmented": "dash01-video-fragmented.mp4",
  "audio-fragmented": "dash01-audio-fragmented.mp4",
  "audio-progressive": "dash01-audio-progressive.m4a",
});

// ── The fragmented-MP4 splitter ────────────────────────────────────────────

/** The top-level ISO-BMFF boxes of `bytes`, strictly: any malformed length is a refusal. */
export function topLevelBoxes(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("the fragmented file must be a Buffer");
  const boxes = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error(`truncated box header at ${offset}`);
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > bytes.length) throw new Error(`truncated large box header at ${offset}`);
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`box too large at ${offset}`);
      size = Number(large);
    } else if (size === 0) {
      throw new Error(`a to-end-of-file box at ${offset} is not a fixture shape`);
    }
    if (size < 8 || offset + size > bytes.length) throw new Error(`bad box length at ${offset}`);
    boxes.push({ type, start: offset, end: offset + size });
    offset += size;
  }
  return boxes;
}

/**
 * Cuts one fragmented ISO-BMFF file into its DASH shape.
 *
 * The init segment is everything before the first `moof`, and must be exactly
 * `ftyp` then `moov`. Every media segment is exactly one `moof` immediately
 * followed by its `mdat`. Anything else — an `mfra` trailer, a `sidx`, a stray
 * `free`, a `moof` without its `mdat` — is refused rather than tolerated, so
 * the served bytes are exactly the shape the manifest describes.
 *
 * Returns the init, the segments, and the top-level box types (for evidence).
 * The concatenation `init + segments` equals the input byte for byte.
 */
export function splitFragmentedMp4(bytes) {
  const boxes = topLevelBoxes(bytes);
  const types = boxes.map((box) => box.type);
  const firstMoof = types.indexOf("moof");
  if (firstMoof !== 2 || types[0] !== "ftyp" || types[1] !== "moov") {
    throw new Error(`the init segment must be exactly ftyp+moov, found ${types.slice(0, Math.max(firstMoof, 0)).join(",")}`);
  }
  const init = bytes.subarray(0, boxes[firstMoof].start);
  const segments = [];
  for (let i = firstMoof; i < boxes.length; i += 2) {
    if (boxes[i].type !== "moof" || boxes[i + 1]?.type !== "mdat") {
      throw new Error(`media segment ${segments.length + 1} is not exactly moof+mdat`);
    }
    segments.push(bytes.subarray(boxes[i].start, boxes[i + 1].end));
  }
  const rejoined = Buffer.concat([init, ...segments]);
  if (!rejoined.equals(bytes)) throw new Error("the split does not reassemble to the input");
  return { init, segments, topLevelTypes: types };
}

// ── The manifests ──────────────────────────────────────────────────────────

function segmentList(role, count) {
  const entries = [`<Initialization sourceURL="${dashInitRoute(role).slice(1)}"/>`];
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    entries.push(`<SegmentURL media="${dashSegmentRoute(role, ordinal).slice(1)}"/>`);
  }
  return [
    `        <SegmentList timescale="1000" duration="${DASH_FIXTURE_SPEC.segmentMilliseconds}">`,
    ...entries.map((entry) => `          ${entry}`),
    "        </SegmentList>",
  ].join("\n");
}

/**
 * The MPD for one case. Static, one Period, relative media references only —
 * a manifest that reflected any request input into a media location would
 * make the fixture's destinations a function of untrusted input.
 */
export function dashManifest(caseName, { segmentCounts }) {
  if (!DASH_CASES.includes(caseName)) throw new Error(`unknown DASH case ${String(caseName)}`);
  const { video, audio } = DASH_FIXTURE_SPEC;
  for (const role of caseName === "dash-dash" ? ["video", "audio"] : ["video"]) {
    const count = segmentCounts?.[role];
    if (!Number.isSafeInteger(count) || count < DASH_FIXTURE_SPEC.minMediaSegments) {
      throw new Error(`the ${role} rendition needs at least ${DASH_FIXTURE_SPEC.minMediaSegments} media segments`);
    }
  }
  const audioBody =
    caseName === "dash-dash"
      ? segmentList("audio", segmentCounts.audio)
      : `        <BaseURL>${DASH_PROGRESSIVE_AUDIO_ROUTE.slice(1)}</BaseURL>`;
  const audioId =
    caseName === "dash-dash" ? DASH_SYNTHETIC_FORMAT_IDS.audio : DASH_SYNTHETIC_FORMAT_IDS.progressiveAudio;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"',
    '     profiles="urn:mpeg:dash:profile:isoff-live:2011"',
    // `static`: a live source is out of scope and would be refused.
    `     type="static" mediaPresentationDuration="PT${video.durationSeconds}.0S" minBufferTime="PT1.5S">`,
    `  <Period id="0" duration="PT${video.durationSeconds}.0S">`,
    '    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">',
    `      <Representation id="${DASH_SYNTHETIC_FORMAT_IDS.video}" codecs="${video.codecs}" bandwidth="${video.bandwidth}" ` +
      `width="${video.width}" height="${video.height}" frameRate="${video.fps}">`,
    segmentList("video", segmentCounts.video),
    "      </Representation>",
    "    </AdaptationSet>",
    '    <AdaptationSet contentType="audio" mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1">',
    `      <Representation id="${audioId}" codecs="${audio.codecs}" bandwidth="${audio.bandwidth}" ` +
      `audioSamplingRate="${audio.sampleRate}">`,
    audioBody,
    "      </Representation>",
    "    </AdaptationSet>",
    "  </Period>",
    "</MPD>",
    "",
  ].join("\n");
}

// ── Generation ─────────────────────────────────────────────────────────────

function runOnce(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      // Bounded, and never surfaced into evidence.
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
 * Generates every fixture file into `outDir` and returns the served shape with
 * each identity computed BEFORE any job runs.
 *
 *   video / audio:     { file, init, segments, total, sha256, byteLength, topLevelTypes }
 *   progressiveAudio:  { file, bytes, sha256, byteLength }
 *
 * `total` is `init + segments`, byte-identical to the generated file; it is
 * what a correct native segmented acquisition must reproduce exactly.
 */
export async function generateDashFixtures({ ffmpegPath, outDir, run = runOnce }) {
  const read = async (kind) => {
    const path = join(outDir, DASH_FIXTURE_FILES[kind]);
    await run(ffmpegPath, dashFfmpegArgs(kind, path));
    const bytes = await readFile(path);
    if (bytes.byteLength === 0) throw new Error(`${DASH_FIXTURE_FILES[kind]} is empty`);
    if (bytes.byteLength > DASH_FIXTURE_SPEC.maxFileBytes) {
      throw new Error(`${DASH_FIXTURE_FILES[kind]} is above the fixture ceiling`);
    }
    return { path, bytes };
  };
  const segmented = async (kind) => {
    const { path, bytes } = await read(kind);
    const { init, segments, topLevelTypes } = splitFragmentedMp4(bytes);
    if (segments.length < DASH_FIXTURE_SPEC.minMediaSegments) {
      throw new Error(`${DASH_FIXTURE_FILES[kind]} has only ${segments.length} media segments`);
    }
    return Object.freeze({
      path,
      init,
      segments: Object.freeze([...segments]),
      total: bytes,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      topLevelTypes: Object.freeze([...topLevelTypes]),
      maxFragmentBytes: Math.max(init.byteLength, ...segments.map((segment) => segment.byteLength)),
    });
  };
  const video = await segmented("video-fragmented");
  const audio = await segmented("audio-fragmented");
  const progressive = await read("audio-progressive");
  const progressiveAudio = Object.freeze({
    path: progressive.path,
    bytes: progressive.bytes,
    byteLength: progressive.bytes.byteLength,
    sha256: sha256(progressive.bytes),
  });
  if (new Set([video.sha256, audio.sha256, progressiveAudio.sha256]).size !== 3) {
    throw new Error("the DASH fixture files must be three distinct files");
  }
  return Object.freeze({ video, audio, progressiveAudio });
}

/**
 * The closed body table the fixture service serves: every route, its bytes and
 * its content type. Nothing outside this table can be answered.
 */
export function dashRouteTable(fixtures) {
  const table = new Map();
  const segmentCounts = { video: fixtures.video.segments.length, audio: fixtures.audio.segments.length };
  for (const caseName of DASH_CASES) {
    table.set(DASH_MANIFEST_ROUTE[caseName], {
      body: Buffer.from(dashManifest(caseName, { segmentCounts }), "utf8"),
      contentType: "application/dash+xml",
    });
  }
  for (const role of ["video", "audio"]) {
    const rendition = fixtures[role];
    table.set(dashInitRoute(role), { body: rendition.init, contentType: `${role}/mp4` });
    rendition.segments.forEach((segment, index) => {
      table.set(dashSegmentRoute(role, index + 1), { body: segment, contentType: `${role}/mp4` });
    });
  }
  table.set(DASH_PROGRESSIVE_AUDIO_ROUTE, { body: fixtures.progressiveAudio.bytes, contentType: "audio/mp4" });
  return { table, segmentCounts };
}
