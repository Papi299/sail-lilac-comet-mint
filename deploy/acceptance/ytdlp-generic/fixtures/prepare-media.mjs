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
// Usage:
//   node prepare-media.mjs --image videofetch-worker:<tag> --out <dir>

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The output basename inside the chosen directory. */
export const FIXTURE_BASENAME = "acceptance-fixture.mp4";

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

/** The full `docker run` argv. `--network none` is not optional. */
export function dockerArgs({ image, outDir }) {
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
    ...ffmpegArgs(`/out/${FIXTURE_BASENAME}`),
  ];
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

  // The digest is computed AFTER FFmpeg exits successfully, on the file that
  // was produced — never on an in-flight buffer and never on anything that
  // travelled through VideoFetch.
  const path = resolve(opts.outDir, FIXTURE_BASENAME);
  const bytes = await readFile(path);
  process.stdout.write(
    `${JSON.stringify({
      path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
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
