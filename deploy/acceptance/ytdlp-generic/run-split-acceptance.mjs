#!/usr/bin/env node
//
// The SPLIT-06 host driver: verify the build context and the accepted base,
// build the NON-DEPLOYABLE overlay, and run the deterministic acceptance
// container.
//
// Runs wherever Docker is — on this project that is inside the Lima VM, not on
// the Mac. It is deliberately plain ESM with no repository imports beyond the
// pure harness modules, so it works on the guest's older Node.
//
// It changes nothing about any deployment: it never retags `latest`, never
// pushes, never touches a systemd unit, never reads a credential, and mounts
// exactly one directory — the one the run writes its own evidence into.
//
// ── Provenance: expectations in, observations out ──────────────────────────
//
// `--head`, `--tree` and `--base-source` are EXPECTATIONS. Before any Docker
// command runs, `lib/split-provenance.mjs` checks them against Git in
// `--context`: exact commit, exact tree, a clean context, the accepted source
// commit present, and the runtime-compatibility files unchanged. The same
// checks run again once the build has read the context, so a context that
// changed underneath Docker is refused too. What reaches the container — and
// so the evidence — are the OBSERVED values, never the CLI text.
//
// Usage:
//   node run-split-acceptance.mjs \
//     --base-image  videofetch-worker:<accepted source sha> \
//     --base-digest sha256:<accepted image id> \
//     --base-source <accepted image's full 40-hex source commit> \
//     --head        <full 40-hex candidate commit> \
//     --tree        <full 40-hex candidate tree> \
//     --context     /repo \
//     --report      /var/tmp/split06 \
//     --family      mp4 [--keep-image]

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  acceptanceRunArgs,
  overlayBuildArgs,
  overlayDockerfile,
  overlayImageTag,
} from "./lib/split-container.mjs";
import { isFullGitSha, verifyOverlayContextProvenance } from "./lib/split-provenance.mjs";

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
    report: null, family: "mp4", keepImage: false, docker: "docker",
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
      case "--family": take("family"); break;
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
  if (out.family !== "mp4" && out.family !== "webm") throw new Error("--family must be mp4 or webm");
  return out;
}

/**
 * `git` against the build context. `--no-optional-locks` because the context
 * may be a read-only mount, and verifying it must never write to it.
 */
function contextGit(run, context) {
  return (args) => run("git", ["--no-optional-locks", "-C", context, ...args], { capture: true });
}

/**
 * One acceptance run. `deps.run` is the only way this reaches a process, which
 * is what lets the self-tests pin that a provenance refusal starts no Docker
 * command at all.
 */
async function runSplitAcceptance(opts, deps = {}) {
  const run = deps.run ?? spawnRunner;
  const log = deps.log ?? ((line) => process.stdout.write(line));
  const scratchRoot = deps.scratchRoot ?? tmpdir();
  const now = deps.now ?? Date.now;
  const expectations = {
    git: contextGit(run, opts.context),
    expectedHead: opts.head,
    expectedTree: opts.tree,
    baseSource: opts.baseSource,
  };

  // 0. Source provenance, BEFORE any Docker command: a refusal here means no
  //    image is inspected, built or run.
  const provenance = await verifyOverlayContextProvenance(expectations);
  log(`[split06] context verified: commit ${provenance.commit} tree ${provenance.tree}, clean\n`);
  log(`[split06] accepted base source ${provenance.acceptedBaseSourceCommit} present\n`);
  for (const file of provenance.runtimeCompatibilityFiles) {
    log(`[split06]   ${file.state} ${file.path}\n`);
  }

  // 1. The base image must resolve to the EXACT accepted digest. A run against
  //    a different base is not a run against the accepted runtime, and the
  //    whole overlay argument rests on the base being unchanged.
  const inspected = await run(opts.docker, ["image", "inspect", opts.baseImage, "--format", "{{.Id}}"], { capture: true });
  if (inspected.code !== 0) throw new Error(`the accepted base image ${opts.baseImage} is not present locally`);
  const baseDigest = inspected.stdout.trim();
  if (baseDigest !== opts.baseDigest) {
    throw new Error(`base image digest mismatch: ${baseDigest} != ${opts.baseDigest}`);
  }
  log(`[split06] accepted base verified ${baseDigest}\n`);

  // 2. The overlay. Non-deployable tag, named after the OBSERVED commit.
  const image = overlayImageTag(provenance.commit);
  const dockerfileDir = join(scratchRoot, `split06-overlay-${process.pid}`);
  await mkdir(dockerfileDir, { recursive: true });
  const dockerfile = join(dockerfileDir, "Dockerfile.split06");
  await writeFile(dockerfile, overlayDockerfile(opts.baseImage));
  const build = await run(opts.docker, overlayBuildArgs({ image, dockerfile, context: opts.context }));
  await rm(dockerfileDir, { recursive: true, force: true });
  if (build.code !== 0) throw new Error(`overlay build failed (${build.code})`);

  let acceptance;
  try {
    // 2b. The context must STILL be exactly what was verified, now that the
    //     build has read it. Otherwise the image may hold source the evidence
    //     does not name.
    try {
      await verifyOverlayContextProvenance(expectations);
    } catch (error) {
      throw new Error(`the build context changed while the overlay was being built: ${error.message}`);
    }

    const overlayId = (await run(opts.docker, ["image", "inspect", image, "--format", "{{.Id}}"], { capture: true })).stdout.trim();
    log(`[split06] overlay ${image} ${overlayId} (NOT DEPLOYABLE)\n`);

    // 3. The acceptance run. `--network none` comes from the pure argv module,
    //    and every provenance value below is an observation from steps 0-2.
    await mkdir(opts.report, { recursive: true });
    const evidenceName = `split06-${opts.family}-${now()}.json`;
    const runArgs = acceptanceRunArgs({
      image, family: opts.family, reportDir: opts.report, evidenceName,
    });
    runArgs.push(
      "--source-commit", provenance.commit,
      "--source-tree", provenance.tree,
      "--accepted-base-source", provenance.acceptedBaseSourceCommit,
      "--source-context-clean",
      "--overlay-runtime-compatible",
      "--base-image", opts.baseImage,
      "--base-digest", baseDigest,
      "--overlay-image", image,
      "--overlay-image-id", overlayId,
    );
    acceptance = await run(opts.docker, runArgs);
    log(`[split06] evidence: ${join(opts.report, evidenceName)}\n`);
  } finally {
    // 4. The overlay exists only to execute SPLIT-06 — and is removed even
    //    when the run above was refused.
    if (!opts.keepImage) {
      await run(opts.docker, ["image", "rm", image], { capture: true });
      log(`[split06] overlay removed\n`);
    }
  }

  return { code: acceptance.code === 0 ? 0 : 1, provenance, image };
}

async function main(argv) {
  const result = await runSplitAcceptance(parseArgv(argv));
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[split06] ${error?.message ?? error}\n`);
    process.exit(2);
  });
}

export { parseArgv, runSplitAcceptance };
