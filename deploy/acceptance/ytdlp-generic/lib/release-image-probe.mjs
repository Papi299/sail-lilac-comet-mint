#!/usr/bin/env node
//
// The in-image observer for SPLIT-07.
//
// Runs INSIDE the release candidate container, as the image's own non-root
// user, with `--network none`, a read-only root and no capability. It is
// mounted at `/verify` — OUTSIDE `/app` — and imports nothing at all, so it can
// neither reach into the application tree nor be confused with product source.
//
// It OBSERVES and prints JSON. It judges nothing: every expectation lives in
// the driver and in `lib/release-evidence.mjs`, so a probe that is wrong about
// what "good" means cannot turn a bad image into a PASS.
//
// Modes:
//   manifest   sorted `path` + SHA-256 for the files the recipe puts in /app
//   tools      whether each forbidden administrative tool resolves
//   env        the image's environment NAMES (never values)
//   runtime    Node/Python/ffmpeg/ffprobe/yt-dlp identity, and the pinned
//              artifact's ownership, mode and writability
//
// Plain ESM, CommonJS-free, no dependency, no repository import.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

/** The application paths the recipe COPYs into `/app`, as the image sees them. */
const APP_ROOT = "/app";
const APP_SOURCE_ROOTS = ["package.json", "package-lock.json", "scripts/register-ts-aliases.mjs", "scripts/ts-alias-hooks.mjs", "src"];

/** The pinned media runtime, at the exact path the Worker executes. */
const YTDLP_ARTIFACT = "/usr/local/lib/videofetch/yt-dlp";
const PYTHON = "/usr/bin/python3";

/**
 * Administrative and network-policy tooling the Worker contract deliberately
 * excludes. `nft`/`iptables` would let the container read or weaken the
 * host-owned egress boundary; `docker` would let it reach a daemon; `sudo`/`ssh`
 * are remote administration; `curl`/`wget` are the download tooling the pinned
 * `ADD --checksum` exists to avoid needing.
 */
const FORBIDDEN_TOOLS = ["docker", "sudo", "ssh", "nft", "iptables", "curl", "wget"];

/**
 * Where a tool would be if it were installed. PATH alone is not enough: a
 * binary present but off PATH is still present in the image, and normalizing
 * that away is exactly what §12 forbids.
 */
const TOOL_SEARCH_DIRECTORIES = [
  "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
  "/usr/local/games", "/usr/games", "/opt/bin", "/snap/bin",
];

/** Where the base image's inherited ENTRYPOINT shim resolves. */
const ENTRYPOINT_SHIM = "/usr/local/bin/docker-entrypoint.sh";

/** The broker subtree the media image must not contain. */
const BROKER_PATH = "/app/src/broker";

/**
 * Paths whose PRESENCE would mean the acceptance harness was baked into the
 * release image. A release image must ship no acceptance machinery: this probe
 * runs with `/verify` as its only mount, so anything found here was copied by
 * the recipe.
 */
const HARNESS_PATHS = [
  "/app/deploy",
  "/app/deploy/acceptance",
  "/app/verify",
  "/app/scripts/ytdlp-split-acceptance.test.mjs",
  "/app/scripts/ytdlp-release-image-acceptance.test.mjs",
];

async function main(argv) {
  const mode = argv[0];
  const handlers = { manifest, tools, env, runtime };
  if (!Object.prototype.hasOwnProperty.call(handlers, mode)) {
    throw new Error(`unknown probe mode: ${String(mode)}`);
  }
  const observation = await handlers[mode](argv.slice(1));
  process.stdout.write(`${JSON.stringify({ mode, ...observation })}\n`);
}

/**
 * The image side of the source-to-image identity comparison.
 *
 * Walks the COPYed roots and hashes every regular file's bytes. A symlink or a
 * non-regular entry is REPORTED rather than followed: the driver compares
 * against a manifest of committed blobs, and silently resolving a link would
 * make two different things look identical.
 */
async function manifest() {
  const entries = [];
  const irregular = [];
  for (const root of APP_SOURCE_ROOTS) {
    await walk(join(APP_ROOT, root), root, entries, irregular);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  irregular.sort();
  return {
    entries,
    irregular,
    brokerPresent: await pathExists(BROKER_PATH),
    // Reported as a list so a positive result names WHICH artefact leaked,
    // rather than only that something did.
    harnessPathsPresent: await presentPaths(HARNESS_PATHS),
  };
}

async function walk(absolute, relative, entries, irregular) {
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      irregular.push(`${relative}: absent`);
      return;
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    irregular.push(`${relative}: symlink`);
    return;
  }
  if (info.isDirectory()) {
    for (const name of (await readdir(absolute)).sort()) {
      await walk(join(absolute, name), `${relative}/${name}`, entries, irregular);
    }
    return;
  }
  if (!info.isFile()) {
    irregular.push(`${relative}: not a regular file`);
    return;
  }
  entries.push({ path: relative, sha256: await fileSha256(absolute), bytes: info.size });
}

function fileSha256(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/**
 * Forbidden-tool presence.
 *
 * Each name is looked up on PATH AND in every plausible binary directory, and
 * the answer includes WHERE it was found so a transitive dependency can be
 * reported precisely instead of normalized away.
 */
async function tools() {
  const found = [];
  for (const tool of FORBIDDEN_TOOLS) {
    const locations = [];
    for (const directory of TOOL_SEARCH_DIRECTORIES) {
      const candidate = join(directory, tool);
      if (await pathExists(candidate)) locations.push(candidate);
    }
    const onPath = resolveOnPath(tool);
    if (onPath !== null && !locations.includes(onPath)) locations.push(onPath);
    found.push({ tool, present: locations.length > 0, locations });
  }
  return { tools: found, path: String(process.env.PATH ?? "") };
}

function resolveOnPath(tool) {
  for (const directory of String(process.env.PATH ?? "").split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, tool);
    // Presence, not executability, is the question: a non-executable binary
    // sitting in the image is still a tool the contract excludes.
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The image's environment NAMES, and nothing else.
 *
 * Values are deliberately never printed. The driver's question is which names
 * the image bakes — a baked `YTDLP_ENABLED` is a failure whatever its value,
 * and a baked secret must not be echoed in order to be detected.
 */
async function env() {
  return { names: Object.keys(process.env).sort() };
}

/**
 * Runtime identity, plus the pinned artifact's actual filesystem posture.
 *
 * The writability test is an ATTEMPTED WRITE as the runtime user, not an
 * inference from the mode bits: "the Worker cannot self-update its media
 * runtime" is a claim about what the kernel refuses, and the only honest way to
 * observe it is to try and record the refusal.
 */
async function runtime() {
  const info = await lstat(YTDLP_ARTIFACT);
  let writeAttempt = { attempted: true, succeeded: false, code: null };
  let handle = null;
  try {
    handle = await open(YTDLP_ARTIFACT, "r+");
    writeAttempt.succeeded = true;
  } catch (error) {
    writeAttempt.code = String(error && error.code ? error.code : "UNKNOWN");
  } finally {
    if (handle !== null) await handle.close();
  }
  return {
    node: process.version,
    uid: process.getuid(),
    gid: process.getgid(),
    cwd: process.cwd(),
    ytdlp: {
      path: YTDLP_ARTIFACT,
      sha256: await fileSha256(YTDLP_ARTIFACT),
      bytes: info.size,
      uid: info.uid,
      gid: info.gid,
      mode: (info.mode & 0o7777).toString(8).padStart(4, "0"),
      isRegularFile: info.isFile(),
      realpath: await realpath(YTDLP_ARTIFACT),
      writeAttempt,
      // The pinned artifact is executed BY the interpreter, exactly as the
      // Worker runs it, so the version it reports is the one Production gets.
      version: firstLine(run(PYTHON, [YTDLP_ARTIFACT, "--version"])),
    },
    python: { path: PYTHON, version: firstLine(run(PYTHON, ["--version"])) },
    entrypointShim: await describeFile(ENTRYPOINT_SHIM),
    ffmpeg: describeMediaTool("/usr/bin/ffmpeg"),
    ffprobe: describeMediaTool("/usr/bin/ffprobe"),
  };
}

/**
 * A file's identity and posture, or `{ present: false }`.
 *
 * Used for the inherited ENTRYPOINT shim: whatever runs before the Worker is
 * part of what the image starts, so its owner, mode, real path and digest are
 * observed rather than assumed from the image config's `Entrypoint` string.
 */
async function describeFile(path) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { path, present: false };
  }
  return {
    path,
    present: true,
    isRegularFile: info.isFile(),
    realpath: await realpath(path),
    uid: info.uid,
    gid: info.gid,
    mode: (info.mode & 0o7777).toString(8).padStart(4, "0"),
    sha256: info.isFile() ? await fileSha256(path) : null,
  };
}

/**
 * A media tool's identity AND whether the runtime user can execute it.
 *
 * The banner's first line is the build identity; `-version` exiting 0 as this
 * user is the executability fact. Both are recorded: a present-but-unexecutable
 * ffprobe would break the split chain while looking installed.
 */
function describeMediaTool(path) {
  const result = run(path, ["-version"]);
  return {
    path,
    present: result.status === 0 || result.stdout.length > 0,
    executable: result.status === 0,
    exitCode: result.status,
    version: firstLine(result),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/**
 * The first line of a tool banner.
 *
 * Only the first line is ever returned, and stderr is used only when stdout is
 * empty: a banner is identity, but a full stderr dump is exactly the raw
 * process output SPLIT-07 evidence must not carry.
 */
function firstLine(result) {
  const text = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
  const line = String(text).split("\n")[0] ?? "";
  return line.trim().slice(0, 200);
}

async function presentPaths(paths) {
  const present = [];
  for (const path of paths) {
    if (await pathExists(path)) present.push(path);
  }
  return present;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`[split07-probe] ${error && error.message ? error.message : String(error)}\n`);
  process.exit(2);
});
