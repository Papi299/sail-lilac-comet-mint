#!/usr/bin/env node
//
// The deterministic SPLIT-06 fixture pair: recipes, manifests and digests.
//
// ── What this produces ─────────────────────────────────────────────────────
//
// FOUR physically separate source files — two per closed pair family — each
// carrying exactly ONE stream:
//
//   mp4  family : `split-video.mp4`  (1 video, 0 audio, H.264 in ISO-BMFF)
//                 `split-audio.m4a`  (0 video, 1 audio, AAC-LC in ISO-BMFF)
//   webm family : `split-video.webm` (1 video, 0 audio, VP9 in Matroska)
//                 `split-audio.webm` (0 video, 1 audio, Opus in Matroska)
//
// plus the DASH manifests that make the pinned Generic extractor describe one
// of those pairs as ONE media item. The manifests are the reason SPLIT-06
// needs no `--load-info-json` adapter; see `splitManifest` below.
//
// ── Why the recipes live here and not as checked-in binaries ───────────────
//
// The same rule the direct/generic fixtures follow (`prepare-media.mjs`): the
// acceptance case asserts byte identity between what the fixture served and
// what the Worker produced, so every expected digest must be computable BEFORE
// the job runs and must never be derived from something that travelled through
// VideoFetch. A recipe makes those digests reproducible by a reviewer on
// demand, from the same image the Worker itself runs.
//
// ── Why the output is bit-exact ────────────────────────────────────────────
//
// `-fflags +bitexact`, `-flags:v +bitexact`, `-flags:a +bitexact` and
// `-map_metadata -1` strip the encoder tag, the creation timestamp and the
// other wall-clock fields. `-threads 1` (x264) and `-threads 1 -row-mt 1`
// (libvpx-vp9) pin the encoders' output to something that does not depend on
// the host CPU count. All four recipes were verified to reproduce identical
// SHA-256 digests across separate runs in the accepted Worker image.
//
// ── Why the halves are small ───────────────────────────────────────────────
//
// SPLIT-06 is a correctness proof, not a bandwidth benchmark. 2 s at 640x360,
// 20 fps lands each half in the tens of kilobytes: large enough to be real
// media with many compressed packets to compare, small enough that the whole
// deterministic chain runs in seconds and stays far below any configured
// `maxFileSizeBytes`.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The closed set of pair families SPLIT-06 can drive a full path with. */
export const SPLIT_FAMILIES = Object.freeze(["mp4", "webm"]);

/** Which role each half plays. Never inferred from a file extension. */
export const SPLIT_ROLES = Object.freeze(["video", "audio"]);

/**
 * The SYNTHETIC upstream format identifiers the manifests declare.
 *
 * Harness-owned and deliberately conspicuous, so a privacy sweep over public
 * metadata, durable rows, object keys and evidence has an unambiguous needle to
 * look for. They satisfy `SAFE_FORMAT_ID_PATTERN` (`[A-Za-z0-9._-]{1,128}`),
 * because a candidate whose upstream id does not is not executable at all.
 *
 * They are NOT production identifiers and never describe a real site.
 */
export const SPLIT_SYNTHETIC_FORMAT_IDS = Object.freeze({
  video: "SPLIT06_VIDEO_01",
  audio: "SPLIT06_AUDIO_01",
});

/**
 * Every generated artifact, keyed `<family>:<role>`.
 *
 * `container` is the SOURCE container the product must derive from the
 * manifest's mimeType, and `family` is the ffprobe demuxer family the Worker's
 * own `probeLocalMedia` must report. Stating both here is what lets the
 * orchestrator check the pinned runtime's answer against a declared
 * expectation rather than against whatever it happened to return.
 */
export const SPLIT_FIXTURE_ARTIFACTS = Object.freeze({
  "mp4:video": Object.freeze({
    family: "mp4", role: "video", basename: "split-video.mp4",
    container: "mp4", probeFamily: "iso-bmff", contentType: "video/mp4",
    streams: Object.freeze({ video: 1, audio: 0 }),
    durationSeconds: 2, width: 640, height: 360, fps: 20,
  }),
  "mp4:audio": Object.freeze({
    family: "mp4", role: "audio", basename: "split-audio.m4a",
    container: "m4a", probeFamily: "iso-bmff", contentType: "audio/mp4",
    streams: Object.freeze({ video: 0, audio: 1 }),
    durationSeconds: 2, width: null, height: null, fps: null,
  }),
  "webm:video": Object.freeze({
    family: "webm", role: "video", basename: "split-video.webm",
    container: "webm", probeFamily: "webm", contentType: "video/webm",
    streams: Object.freeze({ video: 1, audio: 0 }),
    durationSeconds: 2, width: 640, height: 360, fps: 20,
  }),
  "webm:audio": Object.freeze({
    family: "webm", role: "audio", basename: "split-audio.webm",
    container: "webm", probeFamily: "webm", contentType: "audio/webm",
    streams: Object.freeze({ video: 0, audio: 1 }),
    durationSeconds: 2, width: null, height: null, fps: null,
  }),
});

/** The container the closed product table must derive for each family. */
export const SPLIT_TARGET_CONTAINER = Object.freeze({ mp4: "mp4", webm: "webm" });

/** The MIME the product must deliver for each family's merged artifact. */
export const SPLIT_TARGET_MIME = Object.freeze({ mp4: "video/mp4", webm: "video/webm" });

/**
 * A ceiling on any single generated half.
 *
 * Asserted after generation. It is not a product bound — it exists so a future
 * retune of the recipes cannot quietly turn a correctness fixture into a
 * multi-megabyte transfer test.
 */
export const SPLIT_FIXTURE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The EXACT FFmpeg recipe for one half.
 *
 * Pure, and exported argument-for-argument so the determinism levers can be
 * pinned by a test that spawns nothing. Every input is a `lavfi` generator:
 * nothing is fetched, and no external media is involved.
 */
export function splitFfmpegArgs(family, role, outPath) {
  const key = `${family}:${role}`;
  if (!Object.hasOwn(SPLIT_FIXTURE_ARTIFACTS, key)) {
    throw new Error(`unknown split fixture ${key}`);
  }
  const head = [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-fflags", "+bitexact",
  ];
  const tail = ["-fflags", "+bitexact", "-map_metadata", "-1", "-t", "2"];

  if (key === "mp4:video") {
    return [
      ...head,
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=20:duration=2",
      // Exactly one stream: the audio side is refused, not merely unused.
      "-an",
      "-c:v", "libx264", "-preset", "veryfast",
      // x264's output is a function of its thread count, which is otherwise
      // derived from the host CPU count.
      "-threads", "1",
      "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level", "3.0",
      "-b:v", "400k", "-maxrate", "400k", "-bufsize", "400k",
      "-flags:v", "+bitexact",
      ...tail,
      "-movflags", "+faststart",
      // The muxer is chosen explicitly; the filename extension does not decide
      // the container.
      "-f", "mp4", outPath,
    ];
  }
  if (key === "mp4:audio") {
    return [
      ...head,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
      "-vn",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
      "-flags:a", "+bitexact",
      ...tail,
      "-movflags", "+faststart",
      // `ipod` is the ISO-BMFF audio muxer this FFmpeg exposes for `.m4a`; the
      // demuxer alias group it produces is the same `mov,mp4,m4a,3gp,3g2,mj2`
      // the Worker's `iso-bmff` family expects.
      "-f", "ipod", outPath,
    ];
  }
  if (key === "webm:video") {
    return [
      ...head,
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=20:duration=2",
      "-an",
      "-c:v", "libvpx-vp9", "-b:v", "400k",
      "-threads", "1", "-speed", "5", "-deadline", "good", "-cpu-used", "5",
      "-row-mt", "1",
      "-pix_fmt", "yuv420p", "-flags:v", "+bitexact",
      ...tail,
      "-f", "webm", outPath,
    ];
  }
  return [
    ...head,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-vn",
    "-c:a", "libopus", "-b:a", "64k", "-ac", "1",
    "-flags:a", "+bitexact",
    ...tail,
    "-f", "webm", outPath,
  ];
}

/**
 * The `docker run` argv that regenerates ONE half on a host that has Docker.
 *
 * SPLIT-06 itself generates the halves INSIDE the acceptance container, where
 * there is no Docker; this exists so a reviewer can reproduce a digest from the
 * accepted image without running the whole harness. `--network none` is not
 * optional here either.
 */
export function splitDockerArgs({ image, outDir, family, role }) {
  const artifact = SPLIT_FIXTURE_ARTIFACTS[`${family}:${role}`];
  if (!artifact) throw new Error(`unknown split fixture ${family}:${role}`);
  return [
    "run", "--rm", "--network", "none",
    "-v", `${outDir}:/out`,
    "--entrypoint", "/usr/bin/ffmpeg",
    image,
    ...splitFfmpegArgs(family, role, `/out/${artifact.basename}`),
  ];
}

// ── The DASH manifests ─────────────────────────────────────────────────────

/**
 * Why a DASH manifest and not an HTML5 page.
 *
 * The pinned `_parse_html5_media_entries` builds each plain-media format as
 * `{'url': …, 'vcodec': 'none' if media_type == 'audio' else None}` and then
 * runs `f.update(formats[0])`, which OVERWRITES whatever `parse_codecs`
 * derived from the `<source type="…; codecs=…">` attribute. Inside a `<video>`
 * element every format therefore carries `vcodec: null` — never PROVEN
 * video-absent — so the audio half of a pair is inexpressible there, and a page
 * carrying both a `<video>` and an `<audio>` element returns two entries, which
 * is a playlist the single-item contract refuses.
 *
 * `_parse_mpd_periods` has no such clobber. It sets
 * `'vcodec': 'none' if content_type == 'audio' else …` from `parse_codecs` on
 * the Representation's own `@codecs`, so BOTH proven-absent markers are
 * expressible, and a representation carrying only a `<BaseURL>` takes the
 * "Assuming direct URL to unfragmented media" branch — leaving `protocol`
 * unset, which `determine_protocol` then resolves to the URL's own scheme.
 * That is an ordinary `http` progressive source acquired by the NATIVE
 * downloader, not `http_dash_segments`.
 *
 * Verified against yt-dlp 2026.08.19 in the accepted image: one `GET` of the
 * manifest yields `_type: "video"`, no `entries`, and exactly two formats —
 *
 *   video : ext mp4  protocol http  vcodec avc1.42E01E  acodec "none"
 *   audio : ext m4a  protocol http  vcodec "none"       acodec mp4a.40.2
 *
 * which is precisely the shape SPLIT-05 pairs. Nothing about the product was
 * relaxed to make this work.
 */
function representation({ id, codecs, bandwidth, width, height, fps, sampleRate, baseUrl }) {
  const attrs = [
    `id="${id}"`,
    `codecs="${codecs}"`,
    `bandwidth="${bandwidth}"`,
    width === null ? null : `width="${width}"`,
    height === null ? null : `height="${height}"`,
    fps === null ? null : `frameRate="${fps}"`,
    sampleRate === null ? null : `audioSamplingRate="${sampleRate}"`,
  ].filter((a) => a !== null);
  return [
    `      <Representation ${attrs.join(" ")}>`,
    `        <BaseURL>${baseUrl}</BaseURL>`,
    "      </Representation>",
  ].join("\n");
}

function manifestDocument(videoSet, audioSet) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"',
    '     profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"',
    // `static`, so GenericIE sets `live_status: null` rather than `is_live`.
    // A live source is out of scope for generic v1 and would be refused.
    '     type="static" mediaPresentationDuration="PT2.0S" minBufferTime="PT1.5S">',
    '  <Period id="0" duration="PT2.0S">',
    `    <AdaptationSet contentType="video" mimeType="${videoSet.mimeType}" segmentAlignment="true" startWithSAP="1">`,
    representation(videoSet.representation),
    "    </AdaptationSet>",
    `    <AdaptationSet contentType="audio" mimeType="${audioSet.mimeType}" segmentAlignment="true" startWithSAP="1">`,
    representation(audioSet.representation),
    "    </AdaptationSet>",
    "  </Period>",
    "</MPD>",
    "",
  ].join("\n");
}

const VIDEO_CODEC = Object.freeze({ mp4: "avc1.42E01E", webm: "vp9" });
const AUDIO_CODEC = Object.freeze({ mp4: "mp4a.40.2", webm: "opus" });
const AUDIO_SAMPLE_RATE = Object.freeze({ mp4: 44100, webm: 48000 });

/**
 * The PAIRABLE manifest for one family.
 *
 * Media references are RELATIVE. That is a privacy property rather than a
 * convenience: a manifest that reflected the request's `Host` (or any other
 * request input) into an absolute media URL would make the fixture's media
 * destination a function of untrusted input.
 */
export function splitManifest(family) {
  if (!SPLIT_FAMILIES.includes(family)) throw new Error(`unknown split family ${family}`);
  const video = SPLIT_FIXTURE_ARTIFACTS[`${family}:video`];
  const audio = SPLIT_FIXTURE_ARTIFACTS[`${family}:audio`];
  return manifestDocument(
    {
      mimeType: video.contentType,
      representation: {
        id: SPLIT_SYNTHETIC_FORMAT_IDS.video,
        codecs: VIDEO_CODEC[family],
        bandwidth: 400000,
        width: video.width, height: video.height, fps: video.fps,
        sampleRate: null,
        baseUrl: video.basename,
      },
    },
    {
      mimeType: audio.contentType,
      representation: {
        id: SPLIT_SYNTHETIC_FORMAT_IDS.audio,
        codecs: AUDIO_CODEC[family],
        bandwidth: 64000,
        width: null, height: null, fps: null,
        sampleRate: AUDIO_SAMPLE_RATE[family],
        baseUrl: audio.basename,
      },
    },
  );
}

/**
 * The INCOMPATIBLE manifest: an ISO-BMFF video half beside a Matroska audio
 * half.
 *
 * Both halves are individually perfectly ordinary candidates — the video is
 * proven audio-absent, the audio is proven video-absent and proven
 * audio-present — so nothing about candidate selection refuses them. What
 * refuses them is the CLOSED container table, which has no `mp4 + webm` row.
 * A stream copy of Vorbis or Opus into ISO-BMFF is exactly the case that would
 * need codec knowledge the merge path deliberately never consults.
 *
 * The expected outcome is therefore "no split-backed video preset", and a
 * `preset:best` request against it is `FORMAT_UNAVAILABLE` at the plan
 * boundary — reached without acquiring a single media byte.
 */
export function splitIncompatibleManifest() {
  const video = SPLIT_FIXTURE_ARTIFACTS["mp4:video"];
  const audio = SPLIT_FIXTURE_ARTIFACTS["webm:audio"];
  return manifestDocument(
    {
      mimeType: video.contentType,
      representation: {
        id: SPLIT_SYNTHETIC_FORMAT_IDS.video,
        codecs: VIDEO_CODEC.mp4, bandwidth: 400000,
        width: video.width, height: video.height, fps: video.fps,
        sampleRate: null, baseUrl: video.basename,
      },
    },
    {
      mimeType: audio.contentType,
      representation: {
        id: SPLIT_SYNTHETIC_FORMAT_IDS.audio,
        codecs: AUDIO_CODEC.webm, bandwidth: 64000,
        width: null, height: null, fps: null,
        sampleRate: AUDIO_SAMPLE_RATE.webm, baseUrl: audio.basename,
      },
    },
  );
}

// ── Generation ─────────────────────────────────────────────────────────────

function runOnce(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      // Bounded, and never surfaced into evidence: it exists so a generation
      // failure can be diagnosed by the operator at the console.
      if (stderr.length < 4096) stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/**
 * Generates every half into `outDir` and returns each one's PRE-RUN identity.
 *
 * The digest is computed AFTER FFmpeg exits successfully, on the file that was
 * produced — never on an in-flight buffer, and never on anything that has
 * travelled through VideoFetch. This is the evidence-immutability rule: the
 * expected identity exists before the job starts, and the uploaded digest can
 * only ever be an observation compared against it.
 */
export async function generateSplitFixtures({ ffmpegPath, outDir, run = runOnce }) {
  const out = {};
  for (const key of Object.keys(SPLIT_FIXTURE_ARTIFACTS)) {
    const artifact = SPLIT_FIXTURE_ARTIFACTS[key];
    const path = join(outDir, artifact.basename);
    await run(ffmpegPath, splitFfmpegArgs(artifact.family, artifact.role, path));
    const bytes = await readFile(path);
    if (bytes.byteLength === 0) throw new Error(`${artifact.basename} is empty`);
    if (bytes.byteLength > SPLIT_FIXTURE_MAX_BYTES) {
      throw new Error(
        `${artifact.basename} is ${bytes.byteLength} bytes, above the ` +
          `${SPLIT_FIXTURE_MAX_BYTES}-byte fixture ceiling`,
      );
    }
    out[key] = Object.freeze({
      ...artifact,
      path,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    });
  }

  // Four DIFFERENT files. A recipe change that made two halves identical would
  // silently turn a pair proof into a self-comparison.
  const digests = new Set(Object.values(out).map((a) => a.sha256));
  if (digests.size !== Object.keys(SPLIT_FIXTURE_ARTIFACTS).length) {
    throw new Error("the split fixture halves must all be distinct files");
  }
  return out;
}
