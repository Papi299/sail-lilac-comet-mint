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
// the product commit. Since `-02` BOTH are verified clean against explicit
// expectations, the harness again at every checkpoint through the end of the
// run, and the record states — as an observation — whether they coincided.
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
//     --harness-source <full 40-hex commit the harness checkout must be at> \
//     --harness-tree   <full 40-hex tree of that commit> \
//     --report   /var/tmp/split07 \
//     --media-workspace /var/tmp/split07-media \
//     [--docker docker] [--keep-image]
//
// ── The Product media workspace (MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001) ─────
//
// Production binds a bounded, disk-backed workspace at `/tmp/videofetch`; the
// retired 2 GiB tmpfs could not hold a 4 GiB job's 8 GiB peak. Each SPLIT-06
// child binds `--media-workspace` at that same target in that same
// `--mount type=bind` form. It must be an EXISTING, EMPTY directory on disk,
// writable by the image's uid 1000 and cleanable by the operator — for example
// `sudo install -d -m 2770 -o 1000 -g 1000 /var/tmp/split07-media` for an
// operator in gid 1000 — and never the report directory. The driver refuses to
// start unless it is empty, re-checks that before each family, and explicitly
// clears what each family left behind; a workspace it cannot clear stops the
// run rather than contaminating the next family.

import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertCandidateReference,
  assertImmutableImageId,
  assertNoForbiddenMounts,
  candidateImageTag,
  candidateRemoveArgs,
  dockerRunSubject,
  hostPathsOverlap,
  IMAGE_ID_PATTERN,
  imageIdArgs,
  imageInspectArgs,
  POLICY_VERIFIERS,
  policyVerifierRunArgs,
  probeRunArgs,
  productMediaWorkspaceMount,
  releaseAcceptanceRunArgs,
  releaseBuildArgs,
} from "./lib/release-container.mjs";
import {
  buildExpectedSourceManifest,
  compareSourceManifests,
  HARNESS_DRIVER_PATH,
  IMAGE_SOURCE_EXCLUDED_PREFIX,
  isFullGitSha,
  ReleaseProvenanceError,
  verifyHarnessProvenance,
  verifyReleaseContextProvenance,
} from "./lib/release-provenance.mjs";
import {
  ALLOWED_IMAGE_ENTRYPOINTS,
  assertChildUnchanged,
  buildReleaseEvidence,
  ENTRYPOINT_SHIM_PATH,
  EXPECTED_IMAGE_CONFIG,
  EXPECTED_IMAGE_ENVIRONMENT_NAMES,
  EXPECTED_YTDLP_RUNTIME,
  FORBIDDEN_IMAGE_ENVIRONMENT_NAMES,
  REQUIRED_CANDIDATE_RUN_PURPOSES,
  REQUIRED_SPLIT_FAMILIES,
  renderReleaseEvidence,
  SPLIT07_EVIDENCE_SCHEMA,
  validateChildRecord,
} from "./lib/release-evidence.mjs";
// The repository's accepted exclusive-create writer (Phase-10D §5): `wx`, and a
// lost race is a refusal — never "adopt the winner", never truncate.
import { writeEvidenceExclusive } from "./lib/provenance.mjs";

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

/** The entries of a REAL directory; a symlink or a non-directory is refused. */
async function listRealDirectory(directory) {
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${directory} is not a real directory`);
  }
  return readdir(directory);
}

/** Provenance arguments: full, lowercase Git object names, never abbreviations. */
const FULL_SHA_ARGUMENTS = [
  ["--source", "source"],
  ["--tree", "tree"],
  ["--harness-source", "harnessSource"],
  ["--harness-tree", "harnessTree"],
];

export function parseArgv(argv) {
  const out = {
    source: null, tree: null, context: null, harness: null, harnessSource: null, harnessTree: null,
    report: null, mediaWorkspace: null, docker: "docker", keepImage: false,
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
      case "--harness-source": take("harnessSource"); break;
      case "--harness-tree": take("harnessTree"); break;
      case "--report": take("report"); break;
      case "--media-workspace": take("mediaWorkspace"); break;
      case "--docker": take("docker"); break;
      case "--keep-image": out.keepImage = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const [flag, key] of [
    ["--source", "source"], ["--tree", "tree"], ["--context", "context"], ["--harness", "harness"],
    ["--harness-source", "harnessSource"], ["--harness-tree", "harnessTree"], ["--report", "report"],
    ["--media-workspace", "mediaWorkspace"],
  ]) {
    if (!out[key]) throw new Error(`${flag} is required`);
  }
  for (const [flag, key] of FULL_SHA_ARGUMENTS) {
    if (!isFullGitSha(out[key])) throw new Error(`${flag} must be a full lowercase 40-hex SHA`);
  }
  for (const [flag, key] of [
    ["--context", "context"], ["--harness", "harness"], ["--report", "report"], ["--media-workspace", "mediaWorkspace"],
  ]) {
    if (!out[key].startsWith("/")) throw new Error(`${flag} must be an absolute path`);
  }
  // Refuses a path that could not be expressed as a clean `--mount` source.
  productMediaWorkspaceMount(out.mediaWorkspace);
  for (const [flag, key] of [["--context", "context"], ["--harness", "harness"], ["--report", "report"]]) {
    if (hostPathsOverlap(out.mediaWorkspace, out[key])) {
      throw new Error(`--media-workspace must not overlap ${flag}`);
    }
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
  const makeDirectory = deps.mkdir ?? mkdir;
  const resolvePath = deps.realpath ?? realpath;
  const listMediaWorkspace = deps.listMediaWorkspace ?? listRealDirectory;
  const removeMediaWorkspaceEntry =
    deps.removeMediaWorkspaceEntry ??
    ((directory, name) => rm(join(directory, name), { recursive: true, force: true }));
  const startedAt = new Date(now()).toISOString();

  const checks = createChecks();
  const contextGit = directoryGit(run, opts.context);
  const harnessGit = directoryGit(run, opts.harness);
  const harnessDir = join(opts.harness, HARNESS_SUBDIRECTORY);
  const expectations = { git: contextGit, expectedSource: opts.source, expectedTree: opts.tree };
  const harnessExpectations = { git: harnessGit, expectedCommit: opts.harnessSource, expectedTree: opts.harnessTree };

  // Every candidate container goes through here, so the run SUBJECT recorded
  // for it is parsed from the very argv Docker receives — not from what the
  // driver meant to pass.
  const candidateRuns = [];
  const runCandidate = async (purpose, args, options = {}) => {
    candidateRuns.push({ purpose, subject: dockerRunSubject(args) });
    return run(opts.docker, args, options);
  };

  // ── 0. Source provenance, BEFORE any Docker command ──────────────────────
  //
  // A refusal here means no image is inspected, built or run. That ordering is
  // the point: an image can only be tied to a source if the source was
  // established first.
  const provenance = await verifyReleaseContextProvenance(expectations);
  checks.require("source/context-verified-before-build", provenance.contextClean);
  log(`[split07] release source verified: commit ${provenance.source} tree ${provenance.tree}, clean\n`);
  log(`[split07] ${provenance.dockerfilePath} blob ${provenance.dockerfileObject}\n`);

  // ── 0b. Harness provenance, ALSO before any Docker command (since -02) ────
  //
  // The harness is executable acceptance code — this driver, the SPLIT-06
  // orchestrator, the Python verifiers, the image probe, the evidence evaluator
  // — and it is mounted into the candidate. It is verified against the
  // operator's explicit expectations exactly as strictly as the release context,
  // then re-verified at every later checkpoint.
  const harness = await verifyHarnessProvenance(harnessExpectations);
  const harnessVerificationPoints = ["before-docker"];
  checks.require("harness/verified-before-execution", harness.contextClean);
  log(`[split07] harness verified: commit ${harness.commit} tree ${harness.tree}, clean\n`);

  // The EXECUTING driver must be the verified harness's own. Otherwise a clean
  // checkout could be named while different code actually ran the proof.
  const runningDriver = await resolvePath(deps.driverPath ?? fileURLToPath(import.meta.url));
  const verifiedDriver = await resolvePath(join(opts.harness, HARNESS_DRIVER_PATH));
  const driverInsideHarness = runningDriver === verifiedDriver;
  if (!driverInsideHarness) {
    throw new ReleaseProvenanceError(
      `the running driver ${runningDriver} is not the verified harness's own ${verifiedDriver}`,
    );
  }
  checks.record("harness/driver-is-inside-the-verified-harness", driverInsideHarness, HARNESS_DRIVER_PATH);

  // Topology, OBSERVED rather than assumed: SPLIT-07A drives a merged product
  // commit from a separate unmerged harness; SPLIT-07B may use one merged
  // commit, even one checkout, for both roles.
  const worktreeIsReleaseContext = (await resolvePath(opts.harness)) === (await resolvePath(opts.context));
  const commitIsReleaseSource = harness.commit === provenance.source;

  /** Re-verifies the harness; any change is a refusal of the whole record. */
  const verifyHarnessAt = async (point) => {
    let observed;
    try {
      observed = await verifyHarnessProvenance(harnessExpectations);
    } catch (error) {
      throw new ReleaseProvenanceError(`the acceptance harness changed during the run (${point}): ${error.message}`);
    }
    if (observed.directoryTree !== harness.directoryTree || observed.driverObject !== harness.driverObject) {
      throw new ReleaseProvenanceError(`the acceptance harness changed during the run (${point})`);
    }
    harnessVerificationPoints.push(point);
    log(`[split07] harness re-verified clean at ${point}\n`);
  };

  // An occupied evidence path fails HERE, before a long run, as a courtesy to the
  // operator. It is not the guarantee: the exclusive create at the end is.
  await makeDirectory(opts.report, { recursive: true });
  const evidencePath = join(opts.report, `split07-release-image-${now()}.json`);
  await admitEvidencePath(evidencePath, deps);

  /**
   * The Product media workspace must be an existing, real, EMPTY directory.
   * Anything else is a refusal of the whole run, never a PASS-shaped record:
   * residue would let one family's files stand in for the next family's.
   */
  const admitMediaWorkspace = async (point) => {
    let entries;
    try {
      entries = await listMediaWorkspace(opts.mediaWorkspace);
    } catch {
      throw new Error(
        `refusing to run: the Product media workspace ${opts.mediaWorkspace} is not an existing real directory (${point})`,
      );
    }
    if (!Array.isArray(entries) || entries.length !== 0) {
      throw new Error(
        `refusing to run: the Product media workspace ${opts.mediaWorkspace} is not empty (${point}); clean it explicitly`,
      );
    }
  };

  /** Explicit cleanup of what one family left, then proof that it is empty. */
  const clearMediaWorkspace = async (point) => {
    for (const name of await listMediaWorkspace(opts.mediaWorkspace)) {
      await removeMediaWorkspaceEntry(opts.mediaWorkspace, name);
    }
    await admitMediaWorkspace(point);
    log(`[split07] Product media workspace cleared after ${point}\n`);
  };

  // Before ANY Docker command, like every other operator input.
  await admitMediaWorkspace("before-docker");

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

  let verdict = "BLOCKED";
  let record = null;
  let imageId = null;

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
    await verifyHarnessAt("after-build");

    // ── 3. Image identity and configuration ────────────────────────────────
    const inspected = await run(opts.docker, imageInspectArgs(image), { capture: true });
    if (inspected.code !== 0) throw new Error(`the candidate image ${image} could not be inspected`);
    const info = JSON.parse(inspected.stdout);
    const config = info.Config ?? {};
    const inspectedId = String(info.Id ?? "");
    log(`[split07] candidate ${image} ${inspectedId} (NOT DEPLOYABLE)\n`);
    // From here on the candidate is its IMMUTABLE id. The config above and this
    // id came from one inspect, so they describe one image; every container
    // below executes exactly that image, whatever happens to the tag. The
    // tested identity exists only once it is valid.
    checks.require("image/candidate-image-id-valid", IMAGE_ID_PATTERN.test(inspectedId), inspectedId);
    imageId = assertImmutableImageId(inspectedId);
    const runSubject = imageId;

    const exposedPorts = Object.keys(config.ExposedPorts ?? {}).sort();
    const configuredVolumes = Object.keys(config.Volumes ?? {}).sort();
    const environmentNames = asArray(config.Env).map((entry) => entry.split("=")[0]).sort();

    checks.record("image/os-is-linux", info.Os === EXPECTED_IMAGE_CONFIG.os, String(info.Os));
    checks.record("image/architecture-recorded", typeof info.Architecture === "string" && info.Architecture.length > 0, String(info.Architecture));
    checks.record("image/working-directory", config.WorkingDir === EXPECTED_IMAGE_CONFIG.workingDir, String(config.WorkingDir));
    checks.record("image/runtime-user-is-non-root-node", config.User === EXPECTED_IMAGE_CONFIG.user, String(config.User));
    // CMD must be exactly the Worker entry point, and ENTRYPOINT at most the
    // base image's inherited exec shim. The shim's own posture is checked from
    // inside the image below, once the runtime probe has observed it.
    const entrypoint = asArray(config.Entrypoint);
    checks.record(
      "image/cmd-is-the-worker-entry-point",
      sameList(asArray(config.Cmd), EXPECTED_IMAGE_CONFIG.cmd) &&
        ALLOWED_IMAGE_ENTRYPOINTS.some((allowed) => sameList(entrypoint, allowed)),
      `entrypoint=${JSON.stringify(entrypoint)} cmd=${asArray(config.Cmd).join(" ")}`,
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
    const manifestProbe = await probeJson(runCandidate, { imageId: runSubject, harnessDir, mode: "manifest" });
    const toolProbe = await probeJson(runCandidate, { imageId: runSubject, harnessDir, mode: "tools" });
    const envProbe = await probeJson(runCandidate, { imageId: runSubject, harnessDir, mode: "env" });
    const runtimeProbe = await probeJson(runCandidate, { imageId: runSubject, harnessDir, mode: "runtime" });

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
    // The inherited shim runs BEFORE the Worker, so it is observed, not assumed:
    // a regular root-owned file at its own real path, writable by nobody but
    // root. With no ENTRYPOINT there is no shim in the start path at all.
    const shim = runtimeProbe.entrypointShim ?? { present: false };
    const shimModeBits = Number.parseInt(String(shim.mode ?? "7777"), 8);
    checks.record(
      "image/entrypoint-shim-root-owned-and-unwritable",
      entrypoint.length === 0 ||
        (shim.present === true &&
          shim.isRegularFile === true &&
          shim.path === ENTRYPOINT_SHIM_PATH &&
          shim.realpath === ENTRYPOINT_SHIM_PATH &&
          shim.uid === 0 &&
          (shimModeBits & 0o022) === 0 &&
          typeof shim.sha256 === "string" && /^[0-9a-f]{64}$/.test(shim.sha256)),
      entrypoint.length === 0
        ? "no entrypoint"
        : `uid=${String(shim.uid)} mode=${String(shim.mode)} sha256=${String(shim.sha256)}`,
    );
    checks.record(
      "runtime/node-version-recorded",
      typeof runtimeProbe.node === "string" && /^v\d+\./.test(runtimeProbe.node),
      String(runtimeProbe.node),
    );

    // ── 5. The committed offline policy verifiers, against THIS image ──────
    const policyVerifiers = [];
    for (const verifier of POLICY_VERIFIERS) {
      const args = policyVerifierRunArgs({ imageId: runSubject, harnessDir, verifier });
      const result = await runCandidate(`verifier:${verifier}`, args, { capture: true });
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
    // was applied, so the base and the run image are one image. The child
    // records the human build TAG as its base label and the immutable ID Docker
    // actually executed as its run image; `split/children-ran-in-the-candidate-image`
    // then binds both to the run subject this driver itself handed to Docker.
    await makeDirectory(opts.report, { recursive: true });
    const familiesExecuted = [];
    const childObservations = [];
    for (const family of REQUIRED_SPLIT_FAMILIES) {
      await verifyHarnessAt(`before-split06-${family}`);
      await admitMediaWorkspace(`before-split06-${family}`);
      const evidenceName = `split06-${family}-${now()}.json`;
      const args = releaseAcceptanceRunArgs({
        imageId: runSubject, family, harnessDir, reportDir: opts.report,
        mediaWorkspaceDir: opts.mediaWorkspace, evidenceName,
      });
      args.push(
        "--source-commit", provenance.source,
        "--source-tree", provenance.tree,
        "--accepted-base-source", provenance.source,
        "--source-context-clean",
        "--overlay-runtime-compatible",
        "--base-image", image,
        "--base-digest", imageId,
        "--overlay-image", runSubject,
        "--overlay-image-id", imageId,
      );
      assertNoForbiddenMounts(args);
      log(`[split07] SPLIT-06 ${family} against the release candidate\n`);
      const result = await runCandidate(`split06:${family}`, args);
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
      await clearMediaWorkspace(`split06-${family}`);
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

    // The harness must STILL be exactly what was verified, now that both
    // children have consumed it. A harness modified at any point in the run
    // makes the run's own measurements untrustworthy, so the record is refused
    // outright rather than emitted as a FAIL.
    await verifyHarnessAt("after-children");
    checks.record("harness/unchanged-after-execution", true, harnessVerificationPoints.join(","));

    for (const family of REQUIRED_SPLIT_FAMILIES) {
      const child = children.find((entry) => entry.family === family);
      checks.record(`split/${family}-child-passed`, child?.ok === true, child?.reason ?? null);
    }
    checks.record(
      "split/both-families-executed",
      sameList([...familiesExecuted].sort(), [...REQUIRED_SPLIT_FAMILIES].sort()),
      familiesExecuted.join(","),
    );
    // Every candidate container executed the immutable id — measured from the
    // argv Docker received, and complete: a required characterization that
    // never ran is as disqualifying as one that ran the wrong image.
    const runPurposes = candidateRuns.map((entry) => entry.purpose).sort();
    checks.record(
      "image/every-candidate-container-ran-the-immutable-id",
      candidateRuns.length > 0 &&
        candidateRuns.every((entry) => entry.subject === imageId) &&
        sameList(runPurposes, [...REQUIRED_CANDIDATE_RUN_PURPOSES].sort()),
      `${candidateRuns.length} runs; subjects ${[...new Set(candidateRuns.map((entry) => entry.subject))].join(",")}`,
    );
    // No overlay stood in for the release image, and the child names the image
    // Docker actually ran: the driver's own run subject for that child is the
    // immutable id, the child's run image is that id, and its base label is the
    // build tag whose inspected id it is.
    checks.record(
      "split/children-ran-in-the-candidate-image",
      children.length > 0 &&
        children.every((child) => {
          const ran = candidateRuns.find((entry) => entry.purpose === `split06:${child.family}`);
          return (
            ran?.subject === imageId &&
            child.ranImage === imageId &&
            child.ranImageId === imageId &&
            child.baseImage === image &&
            child.baseImageId === imageId &&
            child.sourceCommit === provenance.source &&
            child.networkMode === "none"
          );
        }),
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
      },
      harness: {
        commit: harness.commit,
        tree: harness.tree,
        directory: harness.directory,
        directoryTree: harness.directoryTree,
        driverPath: harness.driverPath,
        driverObject: harness.driverObject,
        contextClean: true,
        verifiedBeforeRun: true,
        verifiedAfterRun: harnessVerificationPoints[harnessVerificationPoints.length - 1] === "after-children",
        verificationPoints: [...harnessVerificationPoints],
        driverInsideHarness,
        worktreeIsReleaseContext,
        commitIsReleaseSource,
      },
      image: {
        candidateTag: image,
        imageId,
        runSubject,
        candidateRuns: candidateRuns.map((entry) => ({ purpose: entry.purpose, subject: entry.subject })),
        os: String(info.Os),
        architecture: String(info.Architecture),
        acceptedWorkerArchitecture: acceptedArchitecture,
        user: String(config.User),
        workingDir: String(config.WorkingDir),
        cmd: asArray(config.Cmd),
        entrypoint: asArray(config.Entrypoint),
        entrypointShim: shim.present === true
          ? { path: String(shim.path), sha256: String(shim.sha256), uid: shim.uid ?? null, mode: String(shim.mode) }
          : null,
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

    // The correctness boundary is HERE, not the directory pre-flight above: an
    // exclusive (`wx`) create either makes this file or fails, so a record that
    // appeared after the pre-flight is refused rather than truncated, and a lost
    // race is never "adopt the winner" — the other file is not this run's.
    const written = await writeEvidenceExclusive(evidencePath, renderReleaseEvidence(record), {
      writeFile: deps.writeFile,
    });
    if (!written.ok) {
      record = null;
      verdict = "BLOCKED";
      throw new Error(`refusing to claim a ${SPLIT07_EVIDENCE_SCHEMA} verdict: ${written.reason}`);
    }
    // Every failed check is named on the operator's console: a FAIL whose cause
    // is visible only inside the record is a FAIL that gets misdiagnosed.
    for (const name of checks.failed) log(`[split07]   FAIL ${name}\n`);
    log(`[split07] ${SPLIT07_EVIDENCE_SCHEMA} ${verdict}: ${evidencePath}\n`);
  } finally {
    // The candidate exists only to execute SPLIT-07A — and is removed even
    // when the run above was refused, unless it is being held for diagnosis.
    //
    // The TAG is removed only while it still names the image this run built and
    // tested: a tag retargeted in the meantime is not this run's to delete.
    if (!opts.keepImage) {
      const current = await run(opts.docker, imageIdArgs(image), { capture: true });
      const currentId = current.code === 0 ? String(current.stdout).trim() : null;
      if (currentId === null || currentId.length === 0) {
        log(`[split07] candidate ${image} is already gone\n`);
      } else if (imageId !== null && currentId !== imageId) {
        log(`[split07] candidate tag ${image} now names ${currentId}, not the tested ${imageId}; NOT removing it\n`);
      } else {
        await run(opts.docker, candidateRemoveArgs(image), { capture: true });
        log(`[split07] candidate ${image} removed\n`);
      }
    } else {
      log(`[split07] candidate ${image} RETAINED for diagnosis (still not deployable)\n`);
    }
  }

  return { code: verdict === "PASS" ? 0 : 1, verdict, image, evidencePath, record, checks: checks.entries };
}

/** A probe run, parsed. Its stdout is one JSON document and nothing else. */
async function probeJson(runCandidate, { imageId, harnessDir, mode }) {
  const args = probeRunArgs({ imageId, harnessDir, mode });
  const result = await runCandidate(`probe:${mode}`, args, { capture: true });
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

/**
 * An EARLY, human-friendly diagnostic only: it lets an occupied path fail before
 * a long run instead of after it. It is NOT the correctness boundary — a path
 * can appear between this check and the write — which is why the record itself
 * is created with `writeEvidenceExclusive` (`wx`).
 */
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
