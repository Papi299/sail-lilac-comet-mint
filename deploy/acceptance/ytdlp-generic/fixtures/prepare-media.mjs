#!/usr/bin/env node
//
// Generates the deterministic acceptance fixture MP4 and reports its digest.
//
// ── Why this is a script and not a checked-in binary ───────────────────────
//
// The direct case asserts byte identity between what the fixture served and
// what the Worker delivered through R2, so the fixture's digest has to be known
// BEFORE any acceptance job runs and must never be derived from the artifact
// that came back through VideoFetch. A recipe that regenerates the same bytes
// makes that digest reproducible by a reviewer, on demand, from the same image
// the Worker itself runs.
//
// ── Why FFmpeg comes from the Worker image ─────────────────────────────────
//
// The host is not required to have FFmpeg, and pulling a third-party FFmpeg
// image to make a test fixture would add an unreviewed supply-chain dependency
// to an acceptance run. The VideoFetch Worker image already carries
// `/usr/bin/ffmpeg`, so the fixture is produced by the same binary the product
// deploys. The container runs `--network none`: the sources are synthetic
// `lavfi` generators, nothing is fetched, and no external media is involved.
//
// ── Why the output is bit-exact ────────────────────────────────────────────
//
// `-fflags +bitexact`, `-flags:v +bitexact`, `-flags:a +bitexact` and
// `-map_metadata -1` remove the encoder tag, the creation timestamp and the
// other wall-clock fields that would otherwise make two runs of the same recipe
// differ. Without them the "known digest" would be known only until the next
// regeneration.
//
// ── Why there are TWO fixtures ─────────────────────────────────────────────
//
// PHASE-10D-STAGE-B-SUCCESS-BLOCKER-REMEDIATION-001. The direct and generic
// families used to share ONE 48,497-byte body, and `/generic-media.mp4` serves
// its body throttled across `GENERIC_THROTTLE_TARGET_MS` (14 s) so the
// cancellation and shutdown cases have a real `downloading` window to observe.
//
// A 48 KB body spread over 14 s is small enough that the pinned yt-dlp asks for
// it in essentially ONE socket read, and that read then spans the whole 14 s —
// past the Worker's `--socket-timeout=10`. The first live Stage-B `success`
// attempt therefore failed as `TIMEOUT` after three internal download attempts,
// with the deployment behaving exactly as configured.
//
// The Worker's timeout is NOT the thing that changes. The generic fixture is
// made large enough that the same 14 s transfer arrives as many completed reads
// instead of one long one, which is what a real slow source looks like.
//
// Usage:
//   node prepare-media.mjs --image videofetch-worker:<tag> --out <dir>

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The DIRECT fixture's basename inside the chosen directory. */
export const FIXTURE_BASENAME = "acceptance-fixture.mp4";

/**
 * The GENERIC fixture's basename. A distinct file, never the direct one.
 *
 * `/direct.mp4` and `/byte-limit-media.mp4`'s valid-MP4 prefix keep using
 * FIXTURE_BASENAME; only `/generic-media.mp4` uses this one.
 */
export const GENERIC_FIXTURE_BASENAME = "acceptance-generic-fixture.mp4";

/**
 * The generic fixture's ceiling, asserted by the test suite.
 *
 * The point is a body large enough that a throttled 14 s transfer is many
 * completed socket reads, not a body large enough to overwhelm anything. The
 * pinned downloader never asks for more than 4 MiB in one read, so a fixture in
 * the 8-16 MiB range already leaves a wide margin; 32 MiB is a hard stop so a
 * future retune cannot quietly turn acceptance into a bandwidth test.
 */
export const GENERIC_FIXTURE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The exact FFmpeg recipe.
 *
 * 3 seconds, 320x240 at 15 fps, H.264 baseline (`avc1.42E01E`) plus mono
 * AAC-LC (`mp4a.40.2`) at 44.1 kHz in an mp4 container with `faststart`. Those
 * two codec strings are what the fixture pages declare in their HTML5 `type`
 * attribute, so this recipe and `MP4_SOURCE_TYPE` in `server.mjs` must change
 * together — the test suite asserts the pair.
 */
export function ffmpegArgs(outPath) {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-fflags",
    "+bitexact",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=15:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=3",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "baseline",
    "-level",
    "3.0",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-ac",
    "1",
    "-shortest",
    "-movflags",
    "+faststart",
    "-flags:v",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    "-fflags",
    "+bitexact",
    "-map_metadata",
    "-1",
    "-t",
    "3",
    outPath,
  ];
}

/**
 * The GENERIC fixture recipe.
 *
 * Same codecs, same container, same profile/level and the same bit-exact flags
 * as the direct recipe — the HTML5 `type` declaration in `server.mjs` describes
 * BOTH bodies, so the pair must stay accurate for both.
 *
 * What differs is size. 720x576 at 25 fps is exactly H.264 level 3.0's ceiling
 * (1620 macroblocks, MaxMBPS 40500), so the stream stays inside `avc1.42E01E`
 * while carrying far more data per second than 320x240 at 15 fps. 14 seconds at
 * a 6 Mb/s target lands in the 8-16 MiB band this fixture wants.
 *
 * `-threads 1` is present here and deliberately NOT added to the direct recipe.
 * x264's slice/frame threading makes its output a function of the encoder's
 * thread count, which is derived from the host's CPU count — fine for a 3-second
 * 320x240 clip that has reproduced identically, but not something to rely on for
 * a 350-frame 720x576 encode a reviewer is expected to reproduce on their own
 * machine. Pinning it costs a few seconds of encode time and buys determinism
 * that does not depend on the host.
 *
 * `testsrc2` rather than `testsrc`: more varied synthetic content, so the ABR
 * target is met by real picture data instead of by padding a near-static frame.
 * Still `lavfi`-only — nothing is fetched, and no external media is involved.
 */
export function genericFfmpegArgs(outPath) {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-fflags",
    "+bitexact",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=720x576:rate=25:duration=14",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=14",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "baseline",
    "-level",
    "3.0",
    "-b:v",
    "6M",
    "-maxrate",
    "6M",
    "-bufsize",
    "6M",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-ac",
    "1",
    "-shortest",
    "-movflags",
    "+faststart",
    "-flags:v",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    "-fflags",
    "+bitexact",
    "-map_metadata",
    "-1",
    "-t",
    "14",
    outPath,
  ];
}

/** The full `docker run` argv for ONE recipe. `--network none` is not optional. */
export function dockerArgs({ image, outDir, basename = FIXTURE_BASENAME, args = ffmpegArgs }) {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${outDir}:/out`,
    "--entrypoint",
    "/usr/bin/ffmpeg",
    image,
    ...args(`/out/${basename}`),
  ];
}

/** The generic fixture's `docker run` argv. */
export function genericDockerArgs({ image, outDir }) {
  return dockerArgs({ image, outDir, basename: GENERIC_FIXTURE_BASENAME, args: genericFfmpegArgs });
}

function parseArgv(argv) {
  const out = { image: null, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--image") {
      if (!value) throw new Error("--image requires a value");
      out.image = value;
      i += 1;
    } else if (arg === "--out") {
      if (!value) throw new Error("--out requires a value");
      out.outDir = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.image) throw new Error("--image <videofetch worker image> is required");
  if (!out.outDir) throw new Error("--out <directory> is required");
  return out;
}

async function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

async function main(argv) {
  const opts = parseArgv(argv);
  await mkdir(opts.outDir, { recursive: true });
  await run("docker", dockerArgs(opts));
  await run("docker", genericDockerArgs(opts));

  // Each digest is computed AFTER its FFmpeg exits successfully, on the file
  // that was produced — never on an in-flight buffer and never on anything that
  // travelled through VideoFetch. The two bodies are reported SEPARATELY: one
  // digest describing two different files is exactly the ambiguity this
  // correction removes.
  const directPath = resolve(opts.outDir, FIXTURE_BASENAME);
  const genericPath = resolve(opts.outDir, GENERIC_FIXTURE_BASENAME);
  const directBytes = await readFile(directPath);
  const genericBytes = await readFile(genericPath);

  if (genericBytes.byteLength > GENERIC_FIXTURE_MAX_BYTES) {
    throw new Error(
      `the generic fixture is ${genericBytes.byteLength} bytes, above the ` +
        `${GENERIC_FIXTURE_MAX_BYTES}-byte ceiling`,
    );
  }
  if (genericBytes.byteLength <= directBytes.byteLength) {
    throw new Error("the generic fixture must be larger than the direct fixture");
  }

  process.stdout.write(
    `${JSON.stringify({
      directPath,
      directBytes: directBytes.byteLength,
      directSha256: createHash("sha256").update(directBytes).digest("hex"),
      genericPath,
      genericBytes: genericBytes.byteLength,
      genericSha256: createHash("sha256").update(genericBytes).digest("hex"),
      videoCodec: "avc1.42E01E",
      audioCodec: "mp4a.40.2",
      container: "mp4",
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[prepare-media] ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
