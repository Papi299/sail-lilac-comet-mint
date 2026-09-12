#!/usr/bin/env node
//
// The SPLIT-07 host driver: verify a clean release source, build the ACTUAL
// `Dockerfile.worker` image, characterize it, and run the existing SPLIT-06
// deterministic full path against it — mp4 AND webm — before emitting one
// release-image candidate record.
//
// Runs wherever Docker is; on this project that is inside the Lima VM, not on
// the Mac. Deliberately plain ESM with no repository imports beyond the pure
// harness modules, so it works on the guest's older Node.
//
// ── Two provenance ROLES, deliberately separate ────────────────────────────
//
//   --context   the RELEASE BUILD CONTEXT: a clean Git worktree fixed to the
//               product commit whose image is being characterized. This is
//               what `Dockerfile.worker` is run against, and the only thing
//               the evidence's `source` block describes.
//
//   --harness   the DRIVER/HARNESS checkout that supplies this file and the
//               acceptance code mounted into the candidate. During SPLIT-07A
//               it is an UNMERGED branch, which is exactly why it must not be
//               the build context: the acceptance changes are deliberately not
//               part of `Dockerfile.worker`, and an image built from them would
//               be ambiguously attributed.
//
// They may be the same directory only when the harness is already merged into
// the product commit; the driver records them as distinct roles either way.
//
// ── What it changes about any deployment: nothing ──────────────────────────
//
// It never pushes, never retags `latest`, never touches a systemd unit, never
// reads a credential, never stops or replaces the running Worker, and records
// the Production image identity before and after so that claim is measured
// rather than asserted. Its candidate carries a structurally non-deployable
// tag and is removed unless a failure is being held for diagnosis.
//
// Usage:
//   node run-release-image-acceptance.mjs \
//     --source   <full 40-hex release product commit> \
//     --tree     <full 40-hex release product tree> \
//     --context  /home/user/vf-build-<sha>      (clean worktree at --source) \
//     --harness  /home/user/vf-split07a-harness (this checkout's repo root) \
//     --report   /var/tmp/split07 \
//     [--docker docker] [--keep-image]

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertCandidateReference,
  assertNoForbiddenMounts,
  candidateImageTag,
  candidateRemoveArgs,
  imageInspectArgs,
  POLICY_VERIFIERS,
  policyVerifierRunArgs,
  probeRunArgs,
  releaseAcceptanceRunArgs,
  releaseBuildArgs,
} from "./lib/release-container.mjs";
import {
  buildExpectedSourceManifest,
  compareSourceManifests,
  IMAGE_SOURCE_EXCLUDED_PREFIX,
  isFullGitSha,
  verifyReleaseContextProvenance,
} from "./lib/release-provenance.mjs";
import {
  assertChildUnchanged,
  buildReleaseEvidence,
  EXPECTED_IMAGE_CONFIG,
  EXPECTED_IMAGE_ENVIRONMENT_NAMES,
  EXPECTED_YTDLP_RUNTIME,
  FORBIDDEN_IMAGE_ENVIRONMENT_NAMES,
  REQUIRED_SPLIT_FAMILIES,
  renderReleaseEvidence,
  SPLIT07_EVIDENCE_SCHEMA,
  validateChildRecord,
} from "./lib/release-evidence.mjs";

/** The accepted Production tag, read ONLY to prove it was not disturbed. */
const PRODUCTION_TAG = "videofetch-worker:latest";
const PRODUCTION_CONTAINER = "videofetch-worker";

/** The harness subdirectory mounted into candidate containers. */
const HARNESS_SUBDIRECTORY = "deploy/acceptance/ytdlp-generic";

function spawnRunner(command, args, { capture = false, binary = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: capture || binary ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    const chunks = [];
    let stderr = "";
    if (capture || binary) {
      child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      const stdoutBuffer = Buffer.concat(chunks);
      resolvePromise({
        code,
        stdout: binary ? "" : stdoutBuffer.toString("utf8"),
        stdoutBuffer,
        stderr,
      });
    });
  });
}

/** Provenance arguments: full, lowercase Git object names, never abbreviations. */
const FULL_SHA_ARGUMENTS = [
  ["--source", "source"],
  ["--tree", "tree"],
];

export function parseArgv(argv) {
  const out = {
    source: null, tree: null, context: null, harness: null, report: null,
    docker: "docker", keepImage: false,
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
      case "--source": take("source"); break;
      case "--tree": take("tree"); break;
      case "--context": take("context"); break;
      case "--harness": take("harness"); break;
      case "--report": take("report"); break;
      case "--docker": take("docker"); break;
      case "--keep-image": out.keepImage = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const required of ["source", "tree", "context", "harness", "report"]) {
    if (!out[required]) throw new Error(`--${required} is required`);
  }
  for (const [flag, key] of FULL_SHA_ARGUMENTS) {
    if (!isFullGitSha(out[key])) throw new Error(`${flag} must be a full lowercase 40-hex SHA`);
  }
  for (const [flag, key] of [["--context", "context"], ["--harness", "harness"], ["--report", "report"]]) {
    if (!out[key].startsWith("/")) throw new Error(`${flag} must be an absolute path`);
  }
  return out;
}

/**
 * `git` against a directory. `--no-optional-locks` because a context may be a
 * read-only mount, and verifying it must never write to it.
 */
function directoryGit(run, directory) {
  return (args, options = {}) =>
    run("git", ["--no-optional-locks", "-C", directory, ...args], {
      capture: !options.binary,
      binary: Boolean(options.binary),
    });
}

/** A named-check ledger. The record's own statement of what was observed. */
function createChecks() {
  const entries = [];
  return {
    record(name, ok, detail) {
      entries.push({ name, ok: Boolean(ok), detail: detail ?? null });
      return Boolean(ok);
    },
    require(name, ok, detail) {
      if (!entries.some((entry) => entry.name === name)) this.record(name, ok, detail);
      if (!ok) throw new Error(`required check failed: ${name}`);
      return true;
    },
    get entries() {
      return entries.map((entry) => ({ ...entry }));
    },
    get failed() {
      return entries.filter((entry) => !entry.ok).map((entry) => entry.name);
    },
  };
}

/**
 * One release-image acceptance run.
 *
 * `deps.run` is the only way this reaches a process, which is what lets the
 * self-tests pin that a provenance refusal starts NO Docker command at all.
 */
export async function runReleaseImageAcceptance(opts, deps = {}) {
  const run = deps.run ?? spawnRunner;
  const log = deps.log ?? ((line) => process.stdout.write(line));
  const now = deps.now ?? Date.now;
  const readFileBytes = deps.readFile ?? readFile;
  const writeEvidence = deps.writeFile ?? writeFile;
  const makeDirectory = deps.mkdir ?? mkdir;
  const startedAt = new Date(now()).toISOString();

  const checks = createChecks();
  const contextGit = directoryGit(run, opts.context);
  const harnessGit = directoryGit(run, opts.harness);
  const harnessDir = join(opts.harness, HARNESS_SUBDIRECTORY);
  const expectations = { git: contextGit, expectedSource: opts.source, expectedTree: opts.tree };

  // ── 0. Source provenance, BEFORE any Docker command ──────────────────────
  //
  // A refusal here means no image is inspected, built or run. That ordering is
  // the point: an image can only be tied to a source if the source was
  // established first.
  const provenance = await verifyReleaseContextProvenance(expectations);
  checks.require("source/context-verified-before-build", provenance.contextClean);
  log(`[split07] release source verified: commit ${provenance.source} tree ${provenance.tree}, clean\n`);
  log(`[split07] ${provenance.dockerfilePath} blob ${provenance.dockerfileObject}\n`);

  // The harness's own identity, recorded as a SEPARATE role. It is not part of
  // the release build context and never reaches the image.
  const harnessCommit = (await harnessGit(["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim();
  const harnessRef = (await harnessGit(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  log(`[split07] harness role: ${harnessRef || "(detached)"} ${harnessCommit || "(unknown)"} — NOT the build context\n`);

  // The expected source manifest, read from the OBSERVED commit's Git objects.
  const expectedManifest = await buildExpectedSourceManifest({ git: contextGit, source: provenance.source });
  log(`[split07] expected /app manifest: ${expectedManifest.entries.length} files, ` +
    `${expectedManifest.excludedEntries.length} ${IMAGE_SOURCE_EXCLUDED_PREFIX} files excluded\n`);

  // ── 1. Production identity, BEFORE. Read-only, and never assumed ─────────
  const productionBefore = await observeProduction(run, opts.docker);
  log(`[split07] production before: latest=${productionBefore.latestImageId ?? "(absent)"} ` +
    `worker=${productionBefore.containerImageId ?? "(absent)"} restarts=${productionBefore.restartCount ?? "n/a"}\n`);

  // ── 2. The ACTUAL release build ──────────────────────────────────────────
  const image = candidateImageTag(provenance.source);
  checks.record("image/candidate-tag-is-not-deployable", isNotDeployable(image), image);
  const buildArgs = releaseBuildArgs({ image, context: opts.context });
  checks.record(
    "image/built-from-the-real-dockerfile",
    buildArgs.includes(`${opts.context}/Dockerfile.worker`),
    "Dockerfile.worker",
  );
  log(`[split07] building ${image} from the real Dockerfile.worker\n`);
  const build = await run(opts.docker, buildArgs);
  if (build.code !== 0) throw new Error(`the release image build failed (${build.code})`);

  let evidencePath = null;
  let verdict = "BLOCKED";
  let record = null;

  try {
    // 2b. The context must STILL be exactly what was verified, now that the
    //     build has read it. Otherwise the image may hold source the evidence
    //     does not name.
    let after;
    try {
      after = await verifyReleaseContextProvenance(expectations);
    } catch (error) {
      throw new Error(`the release build context changed while the image was being built: ${error.message}`);
    }
    checks.require(
      "source/context-unchanged-after-build",
      after.source === provenance.source && after.tree === provenance.tree && after.contextClean === true,
    );
    log(`[split07] release source re-verified after the build\n`);

    // ── 3. Image identity and configuration ────────────────────────────────
    const inspected = await run(opts.docker, imageInspectArgs(image), { capture: true });
    if (inspected.code !== 0) throw new Error(`the candidate image ${image} could not be inspected`);
    const info = JSON.parse(inspected.stdout);
    const config = info.Config ?? {};
    const imageId = String(info.Id ?? "");
    log(`[split07] candidate ${image} ${imageId} (NOT DEPLOYABLE)\n`);

    const exposedPorts = Object.keys(config.ExposedPorts ?? {}).sort();
    const configuredVolumes = Object.keys(config.Volumes ?? {}).sort();
    const environmentNames = asArray(config.Env).map((entry) => entry.split("=")[0]).sort();

    checks.record("image/os-is-linux", info.Os === EXPECTED_IMAGE_CONFIG.os, String(info.Os));
    checks.record("image/architecture-recorded", typeof info.Architecture === "string" && info.Architecture.length > 0, String(info.Architecture));
    checks.record("image/working-directory", config.WorkingDir === EXPECTED_IMAGE_CONFIG.workingDir, String(config.WorkingDir));
    checks.record("image/runtime-user-is-non-root-node", config.User === EXPECTED_IMAGE_CONFIG.user, String(config.User));
    checks.record(
      "image/cmd-is-the-worker-entry-point",
      sameList(asArray(config.Cmd), EXPECTED_IMAGE_CONFIG.cmd) && asArray(config.Entrypoint).length === 0,
      asArray(config.Cmd).join(" "),
    );
    checks.record(
      "image/only-the-worker-port-is-exposed",
      sameList(exposedPorts, EXPECTED_IMAGE_CONFIG.exposedPorts),
      exposedPorts.join(","),
    );
    checks.record("image/no-in-image-healthcheck", config.Healthcheck === undefined || config.Healthcheck === null, "absent");
    checks.record(
      "image/no-host-mount-in-the-image-config",
      configuredVolumes.length === 0,
      configuredVolumes.join(",") || "none",
    );
    const missingEnvironment = EXPECTED_IMAGE_ENVIRONMENT_NAMES.filter((name) => !environmentNames.includes(name));
    checks.record(
      "image/expected-non-secret-environment-present",
      missingEnvironment.length === 0,
      missingEnvironment.join(",") || null,
    );

    // The accepted Worker's architecture, for comparison. Absent is not a
    // failure — a machine that has never deployed simply has nothing to compare.
    const acceptedArchitecture = productionBefore.latestImageId
      ? (await run(opts.docker, ["image", "inspect", PRODUCTION_TAG, "--format", "{{.Architecture}}"], { capture: true })).stdout.trim() || null
      : null;
    if (acceptedArchitecture !== null) {
      checks.record(
        "image/architecture-matches-the-accepted-worker",
        info.Architecture === acceptedArchitecture,
        `${String(info.Architecture)} vs accepted ${acceptedArchitecture}`,
      );
    }

    // ── 4. In-image observations ───────────────────────────────────────────
    const manifestProbe = await probeJson(run, opts, { image, harnessDir, mode: "manifest" });
    const toolProbe = await probeJson(run, opts, { image, harnessDir, mode: "tools" });
    const envProbe = await probeJson(run, opts, { image, harnessDir, mode: "env" });
    const runtimeProbe = await probeJson(run, opts, { image, harnessDir, mode: "runtime" });

    // 4a. Source-to-image identity. Path + byte content, both directions.
    const comparison = compareSourceManifests({
      expected: expectedManifest.entries,
      observed: asArray(manifestProbe.entries),
    });
    checks.record(
      "sourceToImage/manifest-matches-the-verified-commit",
      comparison.equal,
      comparison.equal
        ? `${comparison.comparedFileCount} files`
        : `missing=${comparison.missingFromImage.length} mismatched=${comparison.contentMismatched.length} unexpected=${comparison.unexpectedInImage.length}`,
    );
    checks.record(
      "sourceToImage/broker-source-absent",
      manifestProbe.brokerPresent === false,
      `${expectedManifest.excludedEntries.length} committed broker files accounted for`,
    );
    checks.record(
      "sourceToImage/acceptance-harness-not-baked",
      asArray(manifestProbe.harnessPathsPresent).length === 0,
      asArray(manifestProbe.harnessPathsPresent).join(",") || "none",
    );
    checks.record(
      "sourceToImage/no-irregular-application-file",
      asArray(manifestProbe.irregular).length === 0,
      asArray(manifestProbe.irregular).join(",") || "none",
    );

    // 4b. Forbidden administrative tooling. A present tool is a FINDING, never
    //     normalized away, and the check names exactly where it was found.
    const presentTools = asArray(toolProbe.tools).filter((entry) => entry.present === true);
    checks.record(
      "hardening/no-forbidden-administrative-tool",
      presentTools.length === 0,
      presentTools.map((entry) => `${entry.tool}@${entry.locations.join("|")}`).join(", ") || "none",
    );

    // 4c. Forbidden environment NAMES, observed from inside the running
    //     container — which is the environment the Worker would actually see,
    //     not merely what the image config declares.
    const runtimeEnvironmentNames = asArray(envProbe.names);
    const bakedForbidden = FORBIDDEN_IMAGE_ENVIRONMENT_NAMES.filter(
      (name) => environmentNames.includes(name) || runtimeEnvironmentNames.includes(name),
    );
    checks.record(
      "image/no-forbidden-environment-name-baked",
      bakedForbidden.length === 0,
      bakedForbidden.join(",") || "none",
    );

    // 4d. The pinned media runtime.
    const ytdlp = runtimeProbe.ytdlp ?? {};
    checks.record("runtime/ytdlp-version", ytdlp.version === EXPECTED_YTDLP_RUNTIME.version, String(ytdlp.version));
    checks.record("runtime/ytdlp-sha256", ytdlp.sha256 === EXPECTED_YTDLP_RUNTIME.sha256, String(ytdlp.sha256));
    checks.record(
      "runtime/ytdlp-root-owned-and-unwritable",
      ytdlp.uid === EXPECTED_YTDLP_RUNTIME.uid &&
        ytdlp.gid === EXPECTED_YTDLP_RUNTIME.gid &&
        ytdlp.mode === EXPECTED_YTDLP_RUNTIME.mode &&
        ytdlp.path === EXPECTED_YTDLP_RUNTIME.path &&
        ytdlp.isRegularFile === true &&
        ytdlp.realpath === EXPECTED_YTDLP_RUNTIME.path,
      `uid=${String(ytdlp.uid)} gid=${String(ytdlp.gid)} mode=${String(ytdlp.mode)}`,
    );
    // The control, measured rather than inferred: an ATTEMPTED open-for-write
    // by the runtime user must be refused by the kernel.
    checks.record(
      "runtime/ytdlp-not-self-updatable-by-the-runtime-user",
      ytdlp.writeAttempt?.attempted === true &&
        ytdlp.writeAttempt?.succeeded === false &&
        typeof ytdlp.writeAttempt?.code === "string" &&
        ytdlp.writeAttempt.code.length > 0,
      String(ytdlp.writeAttempt?.code),
    );
    checks.record(
      "runtime/python-can-execute-the-pinned-artifact",
      typeof ytdlp.version === "string" && ytdlp.version === EXPECTED_YTDLP_RUNTIME.version &&
        typeof runtimeProbe.python?.version === "string" && runtimeProbe.python.version.startsWith("Python 3."),
      String(runtimeProbe.python?.version),
    );
    checks.record(
      "runtime/ffmpeg-present-and-executable",
      runtimeProbe.ffmpeg?.present === true && runtimeProbe.ffmpeg?.executable === true,
      String(runtimeProbe.ffmpeg?.version),
    );
    checks.record(
      "runtime/ffprobe-present-and-executable",
      runtimeProbe.ffprobe?.present === true && runtimeProbe.ffprobe?.executable === true,
      String(runtimeProbe.ffprobe?.version),
    );
    checks.record(
      "runtime/node-version-recorded",
      typeof runtimeProbe.node === "string" && /^v\d+\./.test(runtimeProbe.node),
      String(runtimeProbe.node),
    );

    // ── 5. The committed offline policy verifiers, against THIS image ──────
    const policyVerifiers = [];
    for (const verifier of POLICY_VERIFIERS) {
      const args = policyVerifierRunArgs({ image, harnessDir, verifier });
      const result = await run(opts.docker, args, { capture: true });
      policyVerifiers.push({ verifier, exitCode: result.code, ok: result.code === 0 });
      log(`[split07] ${verifier} exit ${result.code}\n`);
    }
    checks.record(
      "hardening/selector-verifier-exit-zero",
      policyVerifiers.find((entry) => entry.verifier === "verify-selector.py")?.ok === true,
    );
    checks.record(
      "hardening/download-policy-verifier-exit-zero",
      policyVerifiers.find((entry) => entry.verifier === "verify-download-policy.py")?.ok === true,
    );

    // ── 6. The real SPLIT-06 deterministic full path, BOTH families ────────
    //
    // The existing harness, unchanged, executing the CANDIDATE image's own
    // `/app/src`, package graph, alias loader, Node, Python, yt-dlp, FFmpeg and
    // ffprobe. The only repository code in the container is the harness itself,
    // read-only, at its repository-relative path.
    //
    // The `--accepted-base-source`/`--overlay-*` values SPLIT-06 requires are
    // satisfied truthfully in release mode: the image's runtime WAS built from
    // exactly this commit, so it is its own base source, and no overlay layer
    // was applied, so the base and the run image are one image. Recording the
    // same identity for both is what lets `split/children-ran-in-the-candidate-image`
    // positively prove no overlay stood in for the release build.
    await makeDirectory(opts.report, { recursive: true });
    const familiesExecuted = [];
    const childObservations = [];
    for (const family of REQUIRED_SPLIT_FAMILIES) {
      const evidenceName = `split06-${family}-${now()}.json`;
      const args = releaseAcceptanceRunArgs({ image, family, harnessDir, reportDir: opts.report, evidenceName });
      args.push(
        "--source-commit", provenance.source,
        "--source-tree", provenance.tree,
        "--accepted-base-source", provenance.source,
        "--source-context-clean",
        "--overlay-runtime-compatible",
        "--base-image", image,
        "--base-digest", imageId,
        "--overlay-image", image,
        "--overlay-image-id", imageId,
      );
      assertNoForbiddenMounts(args);
      log(`[split07] SPLIT-06 ${family} against the release candidate\n`);
      const result = await run(opts.docker, args);
      familiesExecuted.push(family);
      const childPath = join(opts.report, evidenceName);

      // Validate the RECORD, not the exit code. A harness that crashed after
      // writing a non-PASS record, or one that wrote an older schema, would
      // both exit in ways a parent could misread.
      let child;
      try {
        child = validateChildRecord({ family, bytes: await readFileBytes(childPath) });
      } catch {
        child = {
          family, ok: false, schema: null, verdict: null, sha256: null, bytes: 0,
          checkCount: 0, failedCheckCount: 0, reason: `the ${family} child record is unreadable`,
          sourceCommit: null, sourceTree: null, baseImage: null, baseImageId: null,
          ranImage: null, ranImageId: null, networkMode: null,
        };
      }
      childObservations.push({ ...child, path: evidenceName, exitCode: result.code });
      log(`[split07] SPLIT-06 ${family}: ${child.verdict ?? "UNREADABLE"} ` +
        `${child.checkCount} checks sha256=${child.sha256 ?? "n/a"}\n`);
    }

    // The children are re-read and re-hashed here, so the digests the parent
    // records describe bytes that were still identical at assembly time.
    const children = [];
    for (const child of childObservations) {
      if (child.sha256 !== null) {
        assertChildUnchanged({
          family: child.family,
          expectedSha256: child.sha256,
          bytes: await readFileBytes(join(opts.report, child.path)),
        });
      }
      children.push(child);
    }

    for (const family of REQUIRED_SPLIT_FAMILIES) {
      const child = children.find((entry) => entry.family === family);
      checks.record(`split/${family}-child-passed`, child?.ok === true, child?.reason ?? null);
    }
    checks.record(
      "split/both-families-executed",
      sameList([...familiesExecuted].sort(), [...REQUIRED_SPLIT_FAMILIES].sort()),
      familiesExecuted.join(","),
    );
    // No overlay stood in for the release image: every child ran in exactly the
    // candidate, and SPLIT-06's base and run image are the same image id.
    checks.record(
      "split/children-ran-in-the-candidate-image",
      children.length > 0 &&
        children.every(
          (child) =>
            child.ranImage === image &&
            child.ranImageId === imageId &&
            child.baseImage === image &&
            child.baseImageId === imageId &&
            child.sourceCommit === provenance.source &&
            child.networkMode === "none",
        ),
      imageId,
    );

    // ── 7. Production identity, AFTER ──────────────────────────────────────
    const productionAfter = await observeProduction(run, opts.docker);
    checks.record(
      "production/latest-image-id-unchanged",
      productionBefore.latestImageId === productionAfter.latestImageId,
      `${String(productionBefore.latestImageId)} -> ${String(productionAfter.latestImageId)}`,
    );
    checks.record(
      "production/worker-container-unchanged",
      productionBefore.containerImageId === productionAfter.containerImageId &&
        productionBefore.startedAt === productionAfter.startedAt &&
        productionBefore.restartCount === productionAfter.restartCount,
      `restarts ${String(productionBefore.restartCount)} -> ${String(productionAfter.restartCount)}`,
    );

    // ── 8. The record ──────────────────────────────────────────────────────
    verdict = checks.failed.length === 0 ? "PASS" : "FAIL";
    evidencePath = join(opts.report, `split07-release-image-${now()}.json`);
    await admitEvidencePath(evidencePath, deps);

    record = buildReleaseEvidence({
      verdict,
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      source: {
        commit: provenance.source,
        tree: provenance.tree,
        contextClean: true,
        verifiedBeforeBuild: true,
        verifiedAfterBuild: true,
        dockerfileObject: provenance.dockerfileObject,
        dockerfileSha256: provenance.dockerfileSha256,
        releaseInputs: provenance.releaseInputs,
        harnessCommit: isFullGitSha(harnessCommit) ? harnessCommit : null,
        harnessRef: harnessRef.length > 0 ? harnessRef : null,
      },
      image: {
        candidateTag: image,
        imageId,
        os: String(info.Os),
        architecture: String(info.Architecture),
        acceptedWorkerArchitecture: acceptedArchitecture,
        user: String(config.User),
        workingDir: String(config.WorkingDir),
        cmd: asArray(config.Cmd),
        entrypoint: asArray(config.Entrypoint),
        exposedPorts,
        healthcheckPresent: !(config.Healthcheck === undefined || config.Healthcheck === null),
        configuredVolumes,
        environmentNames,
      },
      sourceToImage: {
        method: "sorted relative-path + SHA-256 manifest, git objects at the verified commit vs the image's /app",
        expectedFileCount: comparison.expectedFileCount,
        observedFileCount: comparison.observedFileCount,
        comparedFileCount: comparison.comparedFileCount,
        expectedManifestDigest: comparison.expectedManifestDigest,
        observedManifestDigest: comparison.observedManifestDigest,
        equal: comparison.equal,
        missingFromImage: comparison.missingFromImage,
        contentMismatched: comparison.contentMismatched,
        unexpectedInImage: comparison.unexpectedInImage,
        irregularApplicationFiles: asArray(manifestProbe.irregular),
        brokerSourcePresent: manifestProbe.brokerPresent === true,
        brokerFilesExcludedFromManifest: expectedManifest.excludedEntries.length,
        acceptanceHarnessPathsPresent: asArray(manifestProbe.harnessPathsPresent),
      },
      runtime: {
        node: String(runtimeProbe.node),
        python: String(runtimeProbe.python?.version),
        ytdlpVersion: String(ytdlp.version),
        ytdlpSha256: String(ytdlp.sha256),
        ytdlpPath: String(ytdlp.path),
        ytdlpUid: ytdlp.uid ?? null,
        ytdlpGid: ytdlp.gid ?? null,
        ytdlpMode: String(ytdlp.mode),
        ytdlpWriteRefusalCode: String(ytdlp.writeAttempt?.code),
        ffmpeg: String(runtimeProbe.ffmpeg?.version),
        ffprobe: String(runtimeProbe.ffprobe?.version),
        runtimeUid: runtimeProbe.uid ?? null,
      },
      hardening: {
        forbiddenTools: asArray(toolProbe.tools).map((entry) => ({
          tool: entry.tool,
          present: entry.present === true,
          locations: asArray(entry.locations),
        })),
        forbiddenEnvironmentNamesFound: bakedForbidden,
        policyVerifiers,
      },
      splitAcceptance: {
        familiesExecuted,
        children: children.map((child) => ({
          family: child.family,
          schema: child.schema,
          verdict: child.verdict,
          ok: child.ok,
          sha256: child.sha256,
          bytes: child.bytes,
          checkCount: child.checkCount,
          failedCheckCount: child.failedCheckCount,
          evidenceFile: child.path,
          sourceCommit: child.sourceCommit,
          sourceTree: child.sourceTree,
          ranImage: child.ranImage,
          ranImageId: child.ranImageId,
          networkMode: child.networkMode,
          reason: child.reason,
        })),
      },
      production: {
        latestTag: PRODUCTION_TAG,
        latestImageIdBefore: productionBefore.latestImageId,
        latestImageIdAfter: productionAfter.latestImageId,
        workerContainerImageIdBefore: productionBefore.containerImageId,
        workerContainerImageIdAfter: productionAfter.containerImageId,
        workerStartedAtBefore: productionBefore.startedAt,
        workerStartedAtAfter: productionAfter.startedAt,
        workerRestartCountBefore: productionBefore.restartCount,
        workerRestartCountAfter: productionAfter.restartCount,
        retaggedLatest: false,
        workerRestarted: false,
        systemdMutations: 0,
      },
      checks: checks.entries,
    });

    await writeEvidence(evidencePath, renderReleaseEvidence(record));
    log(`[split07] ${SPLIT07_EVIDENCE_SCHEMA} ${verdict}: ${evidencePath}\n`);
  } finally {
    // The candidate exists only to execute SPLIT-07A — and is removed even
    // when the run above was refused, unless it is being held for diagnosis.
    if (!opts.keepImage) {
      await run(opts.docker, candidateRemoveArgs(image), { capture: true });
      log(`[split07] candidate ${image} removed\n`);
    } else {
      log(`[split07] candidate ${image} RETAINED for diagnosis (still not deployable)\n`);
    }
  }

  return { code: verdict === "PASS" ? 0 : 1, verdict, image, evidencePath, record, checks: checks.entries };
}

/** A probe run, parsed. Its stdout is one JSON document and nothing else. */
async function probeJson(run, opts, { image, harnessDir, mode }) {
  const args = probeRunArgs({ image, harnessDir, mode });
  const result = await run(opts.docker, args, { capture: true });
  if (result.code !== 0) throw new Error(`the ${mode} image probe failed (${result.code})`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`the ${mode} image probe did not emit a JSON observation`);
  }
}

/**
 * Read-only Production observation.
 *
 * Absence is recorded as `null` rather than treated as an error: a machine that
 * has never deployed has no `latest` and no running Worker, and SPLIT-07A must
 * still be runnable there. What matters is that whatever was observed BEFORE is
 * observed identically AFTER.
 */
async function observeProduction(run, docker) {
  const latest = await run(docker, ["image", "inspect", PRODUCTION_TAG, "--format", "{{.Id}}"], { capture: true });
  const container = await run(
    docker,
    ["inspect", PRODUCTION_CONTAINER, "--format", "{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}"],
    { capture: true },
  );
  const fields = container.code === 0 ? container.stdout.trim().split("|") : [];
  return {
    latestImageId: latest.code === 0 ? latest.stdout.trim() || null : null,
    containerImageId: fields[0] ?? null,
    startedAt: fields[1] ?? null,
    restartCount: fields[2] ?? null,
    running: fields[3] ?? null,
  };
}

/** Evidence is append-only BY PATH: an existing target is refused, never replaced. */
async function admitEvidencePath(path, deps) {
  const list = deps.readdir ?? readdir;
  const directory = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  let existing = [];
  try {
    existing = await list(directory);
  } catch {
    existing = [];
  }
  if (existing.includes(name)) {
    throw new Error(`refusing to replace an existing evidence artifact: ${path}`);
  }
}

function isNotDeployable(reference) {
  try {
    assertCandidateReference(reference);
    return true;
  } catch {
    return false;
  }
}

function sameList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i]);
}

/** An array, or an empty one. Never `undefined` reaching a `.map`. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function main(argv) {
  const result = await runReleaseImageAcceptance(parseArgv(argv));
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[split07] ${error?.message ?? error}\n`);
    process.exit(2);
  });
}
