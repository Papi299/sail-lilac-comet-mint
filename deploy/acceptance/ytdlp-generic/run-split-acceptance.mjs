#!/usr/bin/env node
//
// The SPLIT-06 host driver: verify the accepted base, build the NON-DEPLOYABLE
// overlay, and run the deterministic acceptance container.
//
// Runs wherever Docker is — on this project that is inside the Lima VM, not on
// the Mac. It is deliberately plain ESM with no repository imports beyond the
// pure argv module, so it works on the guest's older Node.
//
// It changes nothing about any deployment: it never retags `latest`, never
// pushes, never touches a systemd unit, never reads a credential, and mounts
// exactly one directory — the one the run writes its own evidence into.
//
// Usage:
//   node run-split-acceptance.mjs \
//     --base-image videofetch-worker:<accepted-source-sha> \
//     --base-digest sha256:<accepted image id> \
//     --head <candidate head sha> [--tree <candidate tree sha>] \
//     --context /repo \
//     --report /var/tmp/split06 \
//     --family mp4 [--keep-image]

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

function run(command, args, { capture = false } = {}) {
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

function parseArgv(argv) {
  const out = {
    baseImage: null, baseDigest: null, head: null, tree: null, context: null,
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
  for (const required of ["baseImage", "baseDigest", "head", "context", "report"]) {
    if (!out[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (out.family !== "mp4" && out.family !== "webm") throw new Error("--family must be mp4 or webm");
  return out;
}

async function main(argv) {
  const opts = parseArgv(argv);

  // 1. The base image must resolve to the EXACT accepted digest. A run against
  //    a different base is not a run against the accepted runtime, and the
  //    whole overlay argument rests on the base being unchanged.
  const inspected = await run(opts.docker, ["image", "inspect", opts.baseImage, "--format", "{{.Id}}"], { capture: true });
  if (inspected.code !== 0) throw new Error(`the accepted base image ${opts.baseImage} is not present locally`);
  const actual = inspected.stdout.trim();
  if (actual !== opts.baseDigest) {
    throw new Error(`base image digest mismatch: ${actual} != ${opts.baseDigest}`);
  }
  process.stdout.write(`[split06] accepted base verified ${actual}\n`);

  // 2. The overlay. Non-deployable tag, built from the candidate tree.
  const image = overlayImageTag(opts.head);
  const dockerfileDir = join(tmpdir(), `split06-overlay-${process.pid}`);
  await mkdir(dockerfileDir, { recursive: true });
  const dockerfile = join(dockerfileDir, "Dockerfile.split06");
  await writeFile(dockerfile, overlayDockerfile(opts.baseImage));

  const build = await run(opts.docker, overlayBuildArgs({ image, dockerfile, context: opts.context }));
  await rm(dockerfileDir, { recursive: true, force: true });
  if (build.code !== 0) throw new Error(`overlay build failed (${build.code})`);

  const overlayId = (await run(opts.docker, ["image", "inspect", image, "--format", "{{.Id}}"], { capture: true })).stdout.trim();
  process.stdout.write(`[split06] overlay ${image} ${overlayId} (NOT DEPLOYABLE)\n`);

  // 3. The acceptance run. `--network none` comes from the pure argv module.
  await mkdir(opts.report, { recursive: true });
  const evidenceName = `split06-${opts.family}-${Date.now()}.json`;
  const runArgs = acceptanceRunArgs({
    image, family: opts.family, reportDir: opts.report, evidenceName,
  });
  // The orchestrator records provenance it cannot discover from inside the
  // container. These are passed, never guessed.
  runArgs.push(
    "--source-commit", opts.head,
    ...(opts.tree ? ["--source-tree", opts.tree] : []),
    "--base-image", opts.baseImage,
    "--base-digest", opts.baseDigest,
    "--overlay-image", image,
    "--overlay-image-id", overlayId,
  );
  const acceptance = await run(opts.docker, runArgs);

  // 4. The overlay exists only to execute SPLIT-06.
  if (!opts.keepImage) {
    await run(opts.docker, ["image", "rm", image], { capture: true });
    process.stdout.write(`[split06] overlay removed\n`);
  }

  process.stdout.write(`[split06] evidence: ${join(opts.report, evidenceName)}\n`);
  process.exitCode = acceptance.code === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[split06] ${error?.message ?? error}\n`);
    process.exit(2);
  });
}

export { parseArgv };
