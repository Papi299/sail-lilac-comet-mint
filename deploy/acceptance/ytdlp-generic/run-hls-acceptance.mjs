#!/usr/bin/env node
//
// The HLS-08 host driver: verify the build context and the accepted base,
// build the NON-DEPLOYABLE overlay, run the isolated acceptance container, and
// validate the evidence it wrote.
//
// Runs wherever Docker is — on this project that is inside the `videofetch`
// Lima VM, on its Node 18 — so it is plain ESM whose only imports are the
// import-free harness modules.
//
// It changes nothing about any deployment: it never retags anything, never
// pushes, never touches a systemd unit, never reads a credential, and mounts
// exactly one directory — the one the run writes its own evidence into.
//
// ── Order (fail-closed; no step falls back to another base) ────────────────
//
//   1. verify exact Git source provenance            (no Docker before this)
//   2. inspect the exact accepted base image digest  (no build before this)
//   3. build the non-deployable overlay
//   4. re-verify Git provenance after the build consumed the context
//   5. inspect the overlay image id; prove it was built ON the accepted base
//   6. admit a NEW report target (refuse an existing one)
//   7. run the isolated acceptance container, by immutable id
//   8. read the evidence back and validate it against the observations
//   9. remove the overlay (unless --keep-image)
//
// Restoring the VM's initial power state is the operator's step, outside this
// driver: the driver never starts or stops the VM.
//
// Usage:
//   node run-hls-acceptance.mjs \
//     --base-image  videofetch-worker:rc-593f47dfffe7-5925515fb002 \
//     --base-digest sha256:5925515fb002cd7203228325e1d30fd5987eafde3043ca1663162b9fe04df21e \
//     --base-source 593f47dfffe79f166d40af6575c6130668e56af0 \
//     --head        <full 40-hex candidate commit> \
//     --tree        <full 40-hex candidate tree> \
//     --context     <clean in-VM clone at --head> \
//     --report      /var/tmp/hls08 \
//     [--docker <docker command>] [--keep-image]

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  HLS08_ACCEPTED_BASE,
  hlsAcceptanceRunArgs,
  hlsOverlayBuildArgs,
  hlsOverlayDockerfile,
  hlsOverlayImageTag,
  hlsRunPostureViolations,
} from "./lib/hls-container.mjs";
import { isFullGitSha, verifyOverlayContextProvenance } from "./lib/split-provenance.mjs";
import { HLS08_EVIDENCE_SCHEMA, validateHlsEvidenceRecord } from "./lib/hls-evidence.mjs";

function spawnRunner(command, args, { capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.stderr.on("data", (c) => (stderr += String(c)));
    }
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** Provenance arguments: full, lowercase Git object names, never abbreviations. */
const FULL_SHA_ARGUMENTS = [
  ["--head", "head"],
  ["--tree", "tree"],
  ["--base-source", "baseSource"],
];

function parseArgv(argv) {
  const out = {
    baseImage: null, baseDigest: null, baseSource: null, head: null, tree: null, context: null,
    report: null, keepImage: false, docker: "docker",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    const take = (key) => {
      if (value === undefined) throw new Error(`${arg} requires a value`);
      out[key] = value;
      i += 1;
    };
    switch (arg) {
      case "--base-image": take("baseImage"); break;
      case "--base-digest": take("baseDigest"); break;
      case "--base-source": take("baseSource"); break;
      case "--head": take("head"); break;
      case "--tree": take("tree"); break;
      case "--context": take("context"); break;
      case "--report": take("report"); break;
      case "--docker": take("docker"); break;
      case "--keep-image": out.keepImage = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const required of ["baseImage", "baseDigest", "baseSource", "head", "tree", "context", "report"]) {
    if (!out[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  for (const [flag, key] of FULL_SHA_ARGUMENTS) {
    if (!isFullGitSha(out[key])) throw new Error(`${flag} must be a full lowercase 40-hex SHA`);
  }
  // HLS-08 qualifies the candidate against THE accepted runtime; any other
  // base is a different claim and is refused before anything runs.
  if (out.baseDigest !== HLS08_ACCEPTED_BASE.imageDigest) {
    throw new Error(`--base-digest must be the accepted runtime ${HLS08_ACCEPTED_BASE.imageDigest}`);
  }
  if (out.baseSource !== HLS08_ACCEPTED_BASE.sourceCommit) {
    throw new Error(`--base-source must be the accepted runtime's source ${HLS08_ACCEPTED_BASE.sourceCommit}`);
  }
  if (!out.report.startsWith("/")) throw new Error("--report must be an absolute path");
  return out;
}

function contextGit(run, context) {
  return (args) => run("git", ["--no-optional-locks", "-C", context, ...args], { capture: true });
}

/** A new, unoccupied evidence name. UTC, second resolution, plain basename. */
function evidenceNameFor(now) {
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `hls08-${stamp}.json`;
}

async function inspectId(run, docker, reference) {
  const res = await run(docker, ["image", "inspect", reference, "--format", "{{.Id}}"], { capture: true });
  const id = String(res.stdout ?? "").trim();
  return res.code === 0 && /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
}

async function inspectLayers(run, docker, reference) {
  const res = await run(docker, ["image", "inspect", reference, "--format", "{{json .RootFS.Layers}}"], { capture: true });
  if (res.code !== 0) return null;
  try {
    const layers = JSON.parse(String(res.stdout ?? "").trim());
    return Array.isArray(layers) ? layers : null;
  } catch {
    return null;
  }
}

/**
 * One acceptance run. `deps.run` is the only way this reaches a process, which
 * lets the self-tests pin that a provenance refusal starts no Docker command
 * and a base mismatch starts no build.
 */
async function runHlsAcceptance(opts, deps = {}) {
  const run = deps.run ?? spawnRunner;
  const log = deps.log ?? ((line) => process.stdout.write(line));
  const scratchRoot = deps.scratchRoot ?? tmpdir();
  const now = deps.now ?? Date.now;
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? ((path) => readFile(path, "utf8"));
  const expectations = {
    git: contextGit(run, opts.context),
    expectedHead: opts.head,
    expectedTree: opts.tree,
    baseSource: opts.baseSource,
  };

  // 1. Source provenance, BEFORE any Docker command.
  const provenance = await verifyOverlayContextProvenance(expectations);
  log(`[hls08] context verified: commit ${provenance.commit} tree ${provenance.tree}, clean\n`);
  log(`[hls08] accepted base source ${provenance.acceptedBaseSourceCommit} present\n`);
  for (const file of provenance.runtimeCompatibilityFiles) log(`[hls08]   ${file.state} ${file.path}\n`);

  // 2. The exact accepted base, by id. A tag is not evidence.
  const baseDigest = await inspectId(run, opts.docker, opts.baseImage);
  if (baseDigest === null) throw new Error(`BLOCKED — ACCEPTED RUNTIME IMAGE UNAVAILABLE (${opts.baseImage})`);
  if (baseDigest !== opts.baseDigest) {
    throw new Error(`BLOCKED — ACCEPTED RUNTIME IMAGE UNAVAILABLE: ${opts.baseImage} is ${baseDigest}, not ${opts.baseDigest}`);
  }
  const baseLayers = await inspectLayers(run, opts.docker, opts.baseDigest);
  if (baseLayers === null || baseLayers.length === 0) throw new Error("the accepted base image layers could not be read");
  log(`[hls08] accepted base verified ${baseDigest} (${baseLayers.length} layers)\n`);

  // 3. The overlay. Non-deployable tag, named after the OBSERVED commit.
  const image = hlsOverlayImageTag(provenance.commit);
  const dockerfileDir = join(scratchRoot, `hls08-overlay-${process.pid}-${now()}`);
  await mkdir(dockerfileDir, { recursive: true });
  const dockerfile = join(dockerfileDir, "Dockerfile.hls08");
  await writeFile(dockerfile, hlsOverlayDockerfile(opts.baseImage));
  const build = await run(opts.docker, hlsOverlayBuildArgs({ image, dockerfile, context: opts.context }));
  await rm(dockerfileDir, { recursive: true, force: true });
  if (build.code !== 0) {
    await run(opts.docker, ["image", "rm", image], { capture: true });
    throw new Error(`overlay build failed (${build.code})`);
  }

  let result = { code: 1, provenance, image, overlayId: null, evidencePath: null, evidenceSha256: null, problems: [] };
  try {
    // 4. The context must STILL be what was verified.
    try {
      await verifyOverlayContextProvenance(expectations);
    } catch (error) {
      throw new Error(`the build context changed while the overlay was being built: ${error.message}`);
    }

    // 5. The overlay's identity, and proof it sits on the accepted base.
    const overlayId = await inspectId(run, opts.docker, image);
    if (overlayId === null) throw new Error("the overlay image id could not be read");
    if (overlayId === baseDigest) throw new Error("the overlay is identical to the base; nothing was overlaid");
    const overlayLayers = await inspectLayers(run, opts.docker, overlayId);
    const onBase =
      Array.isArray(overlayLayers) &&
      overlayLayers.length > baseLayers.length &&
      baseLayers.every((layer, i) => overlayLayers[i] === layer);
    if (!onBase) throw new Error("the overlay was not built on the accepted base image's layers");
    result.overlayId = overlayId;
    log(`[hls08] overlay ${image} ${overlayId} (NOT DEPLOYABLE; ${overlayLayers.length - baseLayers.length} layers over the accepted base)\n`);

    // 6. A NEW report target.
    const reportInfo = await (deps.statDir ?? stat)(opts.report).catch(() => null);
    if (!reportInfo || !reportInfo.isDirectory()) {
      throw new Error(`the report directory ${opts.report} must already exist, writable by the image's node user`);
    }
    const evidenceName = evidenceNameFor(now);
    const evidencePath = join(opts.report, evidenceName);
    if (exists(evidencePath)) throw new Error(`refusing to replace an existing evidence artifact: ${evidencePath}`);

    // 7. The isolated run, by immutable id, posture re-checked on the argv.
    const runArgs = hlsAcceptanceRunArgs({
      imageId: overlayId,
      image,
      reportDir: opts.report,
      evidenceName,
      provenance: { ...provenance, baseImage: opts.baseImage, baseDigest },
    });
    const violations = hlsRunPostureViolations(runArgs, { reportDir: opts.report });
    if (violations.length > 0) throw new Error(`refusing an acceptance run with posture violations: ${violations.join("; ")}`);
    const acceptance = await run(opts.docker, runArgs);
    log(`[hls08] acceptance container exited ${acceptance.code}\n`);

    // 8. Read the evidence back and validate it against the OBSERVATIONS.
    if (!exists(evidencePath)) throw new Error("the acceptance run wrote no evidence");
    const text = await readText(evidencePath);
    const sha = createHash("sha256").update(text).digest("hex");
    let record = null;
    try {
      record = JSON.parse(text);
    } catch {
      record = null;
    }
    const problems = validateHlsEvidenceRecord(record, {
      commit: provenance.commit,
      tree: provenance.tree,
      baseDigest,
      overlayImage: image,
      overlayImageId: overlayId,
    });
    log(`[hls08] evidence ${evidencePath}\n`);
    log(`[hls08] evidence sha256 ${sha}\n`);
    log(`[hls08] schema ${record?.schema ?? "?"} (expected ${HLS08_EVIDENCE_SCHEMA}) verdict ${record?.verdict ?? "?"}\n`);
    for (const p of problems) log(`[hls08]   evidence problem: ${p}\n`);
    result = {
      ...result,
      code: acceptance.code === 0 && problems.length === 0 ? 0 : 1,
      evidencePath,
      evidenceSha256: sha,
      verdict: record?.verdict ?? null,
      problems,
    };
  } finally {
    // 9. The overlay exists only to execute HLS-08.
    if (!opts.keepImage) {
      await run(opts.docker, ["image", "rm", image], { capture: true });
      log(`[hls08] overlay removed\n`);
    }
  }
  return result;
}

async function main(argv) {
  const result = await runHlsAcceptance(parseArgv(argv));
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[hls08] ${error?.message ?? error}\n`);
    process.exit(2);
  });
}

export { evidenceNameFor, parseArgv, runHlsAcceptance };
