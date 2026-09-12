// Self-tests for the SPLIT-07 release-image candidate acceptance harness.
//
// These prove the HARNESS, not the product. They spawn no container, no Docker
// daemon, no FFmpeg, no ffprobe and no yt-dlp, and they reach no network:
// everything here is pure argv/document construction or a scripted fake world
// standing in for Git and Docker. The real release-image acceptance is a
// separate, explicitly invoked run —
// `deploy/acceptance/ytdlp-generic/run-release-image-acceptance.mjs`.
//
// The fake world (`createWorld` below) is the point of this file. It builds ONE
// internally consistent run — a clean worktree, a real-looking image config, a
// matching source-to-image manifest, two passing SPLIT-06 children — and every
// test then mutates exactly one fact and asserts what the harness does about
// it. That is what makes these discrimination tests rather than smoke tests: a
// check that cannot fail proves nothing, so each one is shown failing.

// The fake world is deliberately FAITHFUL where the real run surprised us: the
// image inherits the node base's ENTRYPOINT, a child SPLIT-06 record echoes the
// image flags it was given (it cannot introspect Docker), a tag is a mutable
// pointer that can be retargeted, and a `wx` write fails with EEXIST exactly as
// `node:fs` does. Exactly one test touches the real filesystem, on purpose, to
// prove the `wx` boundary against the kernel rather than against a fake.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile as readFileFs, rm, writeFile as writeFileFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCandidateReference,
  assertImmutableImageId,
  assertNoForbiddenMounts,
  candidateImageTag,
  candidateRemoveArgs,
  CANDIDATE_IMAGE_REPOSITORY,
  dockerRunSubject,
  FORBIDDEN_CANDIDATE_TAGS,
  FORBIDDEN_RELEASE_MOUNT_TARGETS,
  HARNESS_MOUNT_TARGET,
  HARNESS_SCRATCH_TARGET,
  HARNESS_SCRATCH_TMPFS,
  IMAGE_ID_PATTERN,
  imageIdArgs,
  imageInspectArgs,
  mountTargets,
  POLICY_VERIFIERS,
  policyVerifierRunArgs,
  probeRunArgs,
  PRODUCT_MEDIA_TMPFS,
  RELEASE_DOCKERFILE,
  RELEASE_RUN_ENVIRONMENT,
  releaseAcceptanceRunArgs,
  releaseBuildArgs,
  VERIFY_MOUNT_TARGET,
} from "../deploy/acceptance/ytdlp-generic/lib/release-container.mjs";
import {
  buildExpectedSourceManifest,
  compareSourceManifests,
  HARNESS_DIRECTORY,
  HARNESS_DRIVER_PATH,
  IMAGE_SOURCE_EXCLUDED_PREFIX,
  isFullGitSha,
  manifestDigest,
  RELEASE_INPUT_FILES,
  ReleaseProvenanceError,
  renderManifest,
  verifyHarnessProvenance,
  verifyReleaseContextProvenance,
} from "../deploy/acceptance/ytdlp-generic/lib/release-provenance.mjs";
import {
  ALLOWED_IMAGE_ENTRYPOINTS,
  assertChildUnchanged,
  buildReleaseEvidence,
  ENTRYPOINT_SHIM_PATH,
  EXPECTED_IMAGE_CONFIG,
  EXPECTED_YTDLP_RUNTIME,
  FORBIDDEN_IMAGE_ENVIRONMENT_NAMES,
  ReleaseEvidenceError,
  REQUIRED_CANDIDATE_RUN_PURPOSES,
  REQUIRED_CHILD_SCHEMA,
  REQUIRED_PASS_CHECKS,
  REQUIRED_SPLIT_FAMILIES,
  renderReleaseEvidence,
  SPLIT07_EVIDENCE_SCHEMA,
  validateChildRecord,
} from "../deploy/acceptance/ytdlp-generic/lib/release-evidence.mjs";
import {
  parseArgv,
  runReleaseImageAcceptance,
} from "../deploy/acceptance/ytdlp-generic/run-release-image-acceptance.mjs";

const SOURCE = "7400a51b578d4b0fb5a118f173e38d95a358a5de";
const TREE = "c04a4e4cdcf420612c98f73d6f6eb014284dd8f3";
const HARNESS_COMMIT = "1111111111111111111111111111111111111111";
const CONTEXT = "/build/vf-release";
const HARNESS = "/build/vf-harness";
const REPORT = "/var/tmp/split07";
const IMAGE_ID = "sha256:ea08b43366eede351dadf07b5f1bca69cd1da9911705e2cbd0040d737ea09173";
const LATEST_ID = "sha256:c3995e18dd3c51d6ddb186e3a3186360d24a2053439e067b71c7dec029f878fa";
/** A DIFFERENT image the candidate tag can be retargeted to mid-run. */
const IMAGE_B = `sha256:${"b".repeat(64)}`;
const HARNESS_TREE = "2222222222222222222222222222222222222222";
const HARNESS_DIR_TREE = "3333333333333333333333333333333333333333";
const DRIVER_OBJECT = "4444444444444444444444444444444444444444";
const TAG = `${CANDIDATE_IMAGE_REPOSITORY}:split07-${SOURCE.slice(0, 12)}-local-test`;
const PARENT = `${REPORT}/split07-release-image-1700000000000.json`;
const STATUS_TRACKED = "status --porcelain=v1 --untracked-files=all --ignored=no --ignore-submodules=none";
const STATUS_IGNORED = "status --porcelain=v1 --untracked-files=all --ignored=matching --ignore-submodules=none";
const HARNESS_POINTS = ["before-docker", "after-build", "before-split06-mp4", "before-split06-webm", "after-children"];

/** The application files the fake commit carries, plus the broker it removes. */
const SOURCE_FILES = {
  "package.json": '{"name":"videofetch"}\n',
  "package-lock.json": '{"lockfileVersion":3}\n',
  "scripts/register-ts-aliases.mjs": "// aliases\n",
  "scripts/ts-alias-hooks.mjs": "// hooks\n",
  "src/worker/runtime/main.server.ts": "export const main = 1;\n",
  "src/worker/runtime/ytdlp-runtime.server.ts": "export const YTDLP_RUNTIME = {};\n",
  "src/lib/config.ts": "export const config = {};\n",
  "src/broker/mint.server.ts": "export const mint = 1;\n",
  "src/broker/index.ts": "export * from './mint.server.ts';\n",
};

/** `Dockerfile.worker` is a release INPUT, not an `/app` file. */
const DOCKERFILE_BODY = "FROM node:22-bookworm-slim\n";

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** A stable fake Git object name for a path, so tests can assert identity. */
function fakeObject(path) {
  return createHash("sha1").update(`blob:${path}`).digest("hex");
}

function appFiles() {
  return Object.keys(SOURCE_FILES)
    .filter((path) => !path.startsWith(IMAGE_SOURCE_EXCLUDED_PREFIX))
    .sort();
}

function brokerFiles() {
  return Object.keys(SOURCE_FILES).filter((path) => path.startsWith(IMAGE_SOURCE_EXCLUDED_PREFIX)).sort();
}

/** The image-side manifest the probe would report for a faithful build. */
function faithfulImageManifest() {
  return appFiles().map((path) => ({
    path,
    sha256: sha256(SOURCE_FILES[path]),
    bytes: SOURCE_FILES[path].length,
  }));
}

/** The inherited ENTRYPOINT shim as a faithful image reports it. */
function shimObservation(overrides = {}) {
  return {
    path: ENTRYPOINT_SHIM_PATH,
    present: true,
    isRegularFile: true,
    realpath: ENTRYPOINT_SHIM_PATH,
    uid: 0,
    gid: 0,
    mode: "0755",
    sha256: "a15ac9589c04baf9da95b08e0e79b5cf1d75ab8dc64e06a5e68e4ceb0ad7c8ea",
    ...overrides,
  };
}

/** The pinned artifact observation a faithful image reports, with one knob. */
function pinnedArtifact(overrides = {}) {
  return {
    path: EXPECTED_YTDLP_RUNTIME.path,
    sha256: EXPECTED_YTDLP_RUNTIME.sha256,
    version: EXPECTED_YTDLP_RUNTIME.version,
    bytes: 3_000_000,
    uid: 0,
    gid: 0,
    mode: "0555",
    isRegularFile: true,
    realpath: EXPECTED_YTDLP_RUNTIME.path,
    writeAttempt: { attempted: true, succeeded: false, code: "EROFS" },
    ...overrides,
  };
}

/**
 * A PASS child, shaped as the REAL `split-full-path.mjs` shapes it: it records
 * the image and source flags it was GIVEN. It cannot introspect Docker, which
 * is exactly why the parent binds these to its own run subject.
 */
function passingChild(family, overrides = {}, flags = null) {
  const f = flags ?? {
    baseImage: TAG, baseDigest: IMAGE_ID, overlayImage: IMAGE_ID, overlayImageId: IMAGE_ID,
    sourceCommit: SOURCE, sourceTree: TREE,
  };
  return {
    schema: REQUIRED_CHILD_SCHEMA,
    verdict: "PASS",
    family,
    source: { commit: f.sourceCommit, tree: f.sourceTree, contextClean: true },
    image: {
      acceptedBaseImage: f.baseImage,
      acceptedBaseDigest: f.baseDigest,
      overlayImage: f.overlayImage,
      overlayImageId: f.overlayImageId,
      deployable: false,
    },
    network: { mode: "none" },
    checks: [
      { name: "full-path/ready", ok: true, detail: null },
      { name: "processing/merged", ok: true, detail: null },
    ],
    ...overrides,
  };
}

/**
 * One internally consistent fake run, and the knobs that break exactly one
 * thing about it.
 *
 * `spec` fields:
 *   git / harnessGit        overrides for individual release-context / harness git answers
 *   harnessChange           { after: "start"|"build"|"split06:mp4"|"split06:webm", kind }
 *                           makes the harness stop verifying from that event on
 *   imageConfig / configOverrides / probes   what image A (the inspected one) reports
 *   imageBProbes            what image B reports, if it is ever executed
 *   retargetTagAfterInspect the candidate tag points at B once it has been inspected
 *   inspectId               the id the tag inspect reports, to test the id grammar
 *   children                per-family child record overrides (or `null` to omit the file)
 *   verifiers               per-verifier exit code
 *   production / productionAfter             Production observations
 *   files                   [path, bytes] entries already on the fake filesystem
 *   competitorAtWrite       bytes another actor creates at the parent path at write time
 */
function createWorld(spec = {}) {
  const calls = [];
  const dockerCalls = [];
  const files = new Map(spec.files ?? []);
  const written = new Map();
  const writeCalls = [];
  const executed = [];
  const events = new Set();
  const tag = TAG;
  let tagTarget = IMAGE_ID;

  const contextAnswers = {
    "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
    "rev-parse --show-toplevel": { code: 0, stdout: `${CONTEXT}\n` },
    "rev-parse --show-prefix": { code: 0, stdout: "\n" },
    "rev-parse --verify --quiet HEAD": { code: 0, stdout: `${SOURCE}\n` },
    [`rev-parse --verify --quiet ${SOURCE}^{tree}`]: { code: 0, stdout: `${TREE}\n` },
    [STATUS_TRACKED]: { code: 0, stdout: "" },
    [STATUS_IGNORED]: { code: 0, stdout: "" },
    [`diff-index --cached --name-only ${SOURCE}`]: { code: 0, stdout: "" },
    "ls-files -v": { code: 0, stdout: appFiles().map((path) => `H ${path}`).join("\n") },
    ...(spec.git ?? {}),
  };

  const harnessAnswers = {
    "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
    "rev-parse --show-toplevel": { code: 0, stdout: `${HARNESS}\n` },
    "rev-parse --show-prefix": { code: 0, stdout: "\n" },
    "rev-parse --verify --quiet HEAD": { code: 0, stdout: `${HARNESS_COMMIT}\n` },
    [`rev-parse --verify --quiet ${HARNESS_COMMIT}^{tree}`]: { code: 0, stdout: `${HARNESS_TREE}\n` },
    [STATUS_TRACKED]: { code: 0, stdout: "" },
    [STATUS_IGNORED]: { code: 0, stdout: "" },
    [`diff-index --cached --name-only ${HARNESS_COMMIT}`]: { code: 0, stdout: "" },
    "ls-files -v": { code: 0, stdout: `H ${HARNESS_DRIVER_PATH}\nH ${HARNESS_DIRECTORY}/split-full-path.mjs\n` },
    [`rev-parse --verify --quiet ${HARNESS_COMMIT}:${HARNESS_DIRECTORY}`]: { code: 0, stdout: `${HARNESS_DIR_TREE}\n` },
    [`rev-parse --verify --quiet ${HARNESS_COMMIT}:${HARNESS_DRIVER_PATH}`]: { code: 0, stdout: `${DRIVER_OBJECT}\n` },
    ...(spec.harnessGit ?? {}),
  };

  /** How a harness stops verifying, one kind of change at a time. */
  const harnessChanges = {
    modified: { [STATUS_TRACKED]: { code: 0, stdout: ` M ${HARNESS_DIRECTORY}/split-full-path.mjs\n` } },
    staged: {
      [`diff-index --cached --name-only ${HARNESS_COMMIT}`]: { code: 0, stdout: `${HARNESS_DIRECTORY}/lib/release-evidence.mjs\n` },
    },
    untracked: { [STATUS_TRACKED]: { code: 0, stdout: `?? ${HARNESS_DIRECTORY}/lib/extra.mjs\n` } },
    ignored: { [STATUS_IGNORED]: { code: 0, stdout: `!! ${HARNESS_DIRECTORY}/node_modules/\n` } },
    hidden: { "ls-files -v": { code: 0, stdout: `S ${HARNESS_DIRECTORY}/split-full-path.mjs\n` } },
    moved: { "rev-parse --verify --quiet HEAD": { code: 0, stdout: `${"5".repeat(40)}\n` } },
  };

  function harnessAnswer(key) {
    const change = spec.harnessChange;
    if (change && (change.after === "start" || events.has(change.after))) {
      const overrides = harnessChanges[change.kind];
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    }
    return Object.prototype.hasOwnProperty.call(harnessAnswers, key) ? harnessAnswers[key] : { code: 1, stdout: "" };
  }

  const knownObjects = new Set([RELEASE_DOCKERFILE, HARNESS_DIRECTORY, HARNESS_DRIVER_PATH, ...Object.keys(SOURCE_FILES)]);
  function contextAnswer(args) {
    const key = args.join(" ");
    if (Object.prototype.hasOwnProperty.call(contextAnswers, key)) return contextAnswers[key];
    const objectMatch = /^rev-parse --verify --quiet [0-9a-f]{40}:(.+)$/.exec(key);
    if (objectMatch) {
      return knownObjects.has(objectMatch[1]) ? { code: 0, stdout: `${fakeObject(objectMatch[1])}\n` } : { code: 1, stdout: "" };
    }
    const blobMatch = /^cat-file blob [0-9a-f]{40}:(.+)$/.exec(key);
    if (blobMatch) {
      const path = blobMatch[1];
      const body = path === RELEASE_DOCKERFILE ? DOCKERFILE_BODY : SOURCE_FILES[path];
      return body === undefined
        ? { code: 1, stdout: "", stdoutBuffer: Buffer.alloc(0) }
        : { code: 0, stdout: "", stdoutBuffer: Buffer.from(body, "utf8") };
    }
    if (key.startsWith("ls-tree -r -z --full-tree ")) {
      const records = Object.keys(SOURCE_FILES)
        .sort()
        .map((path) => `100644 blob ${fakeObject(path)}\t${path}\0`)
        .join("");
      return { code: 0, stdout: records };
    }
    return { code: 1, stdout: "" };
  }

  const imageConfig = {
    Id: IMAGE_ID,
    Os: "linux",
    Architecture: "arm64",
    Config: {
      User: "node",
      WorkingDir: "/app",
      Cmd: [...EXPECTED_IMAGE_CONFIG.cmd],
      // What the real node:22-bookworm-slim base declares and the recipe
      // inherits. A fake that said `null` here once certified a check the real
      // image then failed.
      Entrypoint: ["docker-entrypoint.sh"],
      ExposedPorts: { "8080/tcp": {} },
      Env: [
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "NODE_ENV=production",
        "WORKER_BIND_HOST=0.0.0.0",
        "WORKER_PORT=8080",
        "WORKER_DATA_DIRECTORY=/var/lib/videofetch",
        "TEMP_DIRECTORY=/tmp/videofetch",
        "FFMPEG_PATH=/usr/bin/ffmpeg",
      ],
      Volumes: null,
    },
    ...(spec.imageConfig ?? {}),
  };
  if (spec.configOverrides) Object.assign(imageConfig.Config, spec.configOverrides);

  const probes = {
    manifest: {
      entries: faithfulImageManifest(),
      irregular: [],
      brokerPresent: false,
      harnessPathsPresent: [],
    },
    tools: {
      tools: ["docker", "sudo", "ssh", "nft", "iptables", "curl", "wget"].map((tool) => ({
        tool, present: false, locations: [],
      })),
      path: "/usr/local/bin:/usr/bin:/bin",
    },
    env: { names: ["FFMPEG_PATH", "NODE_ENV", "PATH", "TEMP_DIRECTORY", "WORKER_BIND_HOST", "WORKER_DATA_DIRECTORY", "WORKER_PORT"] },
    runtime: {
      node: "v22.23.2",
      uid: 1000,
      gid: 1000,
      cwd: "/app",
      ytdlp: pinnedArtifact(),
      python: { path: "/usr/bin/python3", version: "Python 3.11.2" },
      entrypointShim: shimObservation(),
      ffmpeg: { path: "/usr/bin/ffmpeg", present: true, executable: true, exitCode: 0, version: "ffmpeg version 5.1.8" },
      ffprobe: { path: "/usr/bin/ffprobe", present: true, executable: true, exitCode: 0, version: "ffprobe version 5.1.8" },
    },
  };
  // Image B starts as an exact copy, so only the run SUBJECT could tell the two
  // apart — unless a test gives B observations of its own.
  const probesB = JSON.parse(JSON.stringify(probes));
  for (const [mode, override] of Object.entries(spec.probes ?? {})) {
    probes[mode] = { ...probes[mode], ...override };
  }
  for (const [mode, override] of Object.entries(spec.imageBProbes ?? {})) {
    probesB[mode] = { ...probesB[mode], ...override };
  }
  const images = {
    [IMAGE_ID]: { config: imageConfig, probes },
    [IMAGE_B]: { config: JSON.parse(JSON.stringify(imageConfig)), probes: probesB },
  };

  const production = {
    latestImageId: LATEST_ID,
    containerImageId: LATEST_ID,
    startedAt: "2026-09-12T03:02:18.020046145Z",
    restartCount: "0",
    ...(spec.production ?? {}),
  };
  const productionAfter = { ...production, ...(spec.productionAfter ?? {}) };
  // The driver observes Production twice: once before the build, once after
  // the children. Each observation starts with the `latest` inspect, so that
  // call advances the phase and the container inspect reads the same phase.
  let productionObservations = 0;
  const productionPhase = () => (productionObservations <= 1 ? production : productionAfter);

  const childSpec = spec.children ?? {};

  async function run(command, args) {
    calls.push({ command, args: [...args] });
    if (command === "git") {
      // `--no-optional-locks -C <dir> ...`
      const directory = args[2];
      const rest = args.slice(3);
      const answer = directory === HARNESS ? harnessAnswer(rest.join(" ")) : contextAnswer(rest);
      return {
        code: answer.code,
        stdout: answer.stdout ?? "",
        stdoutBuffer: answer.stdoutBuffer ?? Buffer.from(String(answer.stdout ?? ""), "utf8"),
        stderr: "",
      };
    }
    dockerCalls.push({ command, args: [...args] });
    return dockerAnswer(args);
  }

  function flagValue(args, name) {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  }

  function dockerAnswer(args) {
    const key = args.join(" ");
    if (key === "image inspect videofetch-worker:latest --format {{.Id}}") {
      productionObservations += 1;
      const value = productionPhase().latestImageId;
      return ok(value === null ? "" : `${value}\n`, value === null ? 1 : 0);
    }
    if (key.startsWith("inspect videofetch-worker --format")) {
      const which = productionPhase();
      if (which.containerImageId === null) return ok("", 1);
      return ok(`${which.containerImageId}|${which.startedAt}|${which.restartCount}|true\n`);
    }
    if (key === "image inspect videofetch-worker:latest --format {{.Architecture}}") {
      return ok(`${spec.acceptedArchitecture ?? "arm64"}\n`);
    }
    if (args[0] === "build") {
      events.add("build");
      return ok("", spec.buildExit ?? 0);
    }
    if (key === `image inspect ${tag} --format {{json .}}`) {
      if (tagTarget === null) return ok("", 1);
      const body = { ...images[tagTarget].config, Id: spec.inspectId ?? tagTarget };
      // The tag is a mutable pointer: once inspected, it can be moved.
      if (spec.retargetTagAfterInspect) tagTarget = IMAGE_B;
      return ok(`${JSON.stringify(body)}\n`, spec.inspectExit ?? 0);
    }
    if (key === `image inspect ${tag} --format {{.Id}}`) {
      return tagTarget === null ? ok("", 1) : ok(`${tagTarget}\n`);
    }
    if (args[0] === "image" && args[1] === "rm") {
      if (args[2] === tag) tagTarget = null;
      return ok("");
    }
    if (args[0] === "run") {
      // Docker resolves a tag to whatever it names NOW; an id names one image.
      const subject = args.find((arg) => arg === tag || /^sha256:[0-9a-f]{64}$/.test(String(arg)));
      const resolved = subject === tag ? tagTarget : subject;
      if (!resolved || !images[resolved]) return ok("", 125);
      executed.push(resolved);
      const probeMode = probeModeOf(args);
      if (probeMode !== null) {
        return ok(`${JSON.stringify({ mode: probeMode, ...images[resolved].probes[probeMode] })}\n`);
      }
      const verifier = POLICY_VERIFIERS.find((name) => args.some((arg) => String(arg).endsWith(name)));
      if (verifier) return ok("", (spec.verifiers ?? {})[verifier] ?? 0);
      const family = flagValue(args, "--family");
      const evidenceArg = String(flagValue(args, "--evidence"));
      const name = evidenceArg.slice(evidenceArg.lastIndexOf("/") + 1);
      const reportMount = args.find((arg) => String(arg).endsWith(":/report"));
      const hostReport = reportMount ? String(reportMount).slice(0, -":/report".length) : REPORT;
      const override = Object.prototype.hasOwnProperty.call(childSpec, family) ? childSpec[family] : {};
      if (override !== null) {
        const flags = {
          baseImage: flagValue(args, "--base-image"),
          baseDigest: flagValue(args, "--base-digest"),
          overlayImage: flagValue(args, "--overlay-image"),
          overlayImageId: flagValue(args, "--overlay-image-id"),
          sourceCommit: flagValue(args, "--source-commit"),
          sourceTree: flagValue(args, "--source-tree"),
        };
        files.set(`${hostReport}/${name}`, Buffer.from(
          `${JSON.stringify(passingChild(family, override, flags), null, 2)}\n`, "utf8",
        ));
      }
      events.add(`split06:${family}`);
      return ok("", (spec.splitExit ?? {})[family] ?? 0);
    }
    return ok("");
  }

  function probeModeOf(args) {
    const index = args.findIndex((arg) => String(arg).endsWith("lib/release-image-probe.mjs"));
    return index < 0 ? null : String(args[index + 1]);
  }

  function ok(stdout, code = 0) {
    return { code, stdout, stdoutBuffer: Buffer.from(stdout, "utf8"), stderr: "" };
  }

  return {
    tag,
    calls,
    dockerCalls,
    files,
    written,
    writeCalls,
    executed,
    deps: {
      run,
      log: () => {},
      now: () => 1_700_000_000_000,
      // The fake world never touches the real filesystem unless a test opts in.
      mkdir: async () => undefined,
      // A faithful `node:fs` writeFile against the fake filesystem: `wx` fails
      // with EEXIST and leaves the existing bytes alone; the options are kept.
      writeFile: async (path, contents, options) => {
        const key = String(path);
        writeCalls.push({ path: key, options: options ?? null });
        if (options?.flag === "wx" && files.has(key)) {
          const error = new Error(`EEXIST: file already exists, open '${key}'`);
          error.code = "EEXIST";
          throw error;
        }
        files.set(key, Buffer.from(String(contents), "utf8"));
        written.set(key, String(contents));
      },
      readFile: async (path) => {
        if (!files.has(String(path))) {
          const error = new Error("ENOENT");
          error.code = "ENOENT";
          throw error;
        }
        return files.get(String(path));
      },
      readdir: async () => [...files.keys()].map((path) => path.slice(path.lastIndexOf("/") + 1)),
      driverPath: `${HARNESS}/${HARNESS_DRIVER_PATH}`,
      realpath: async (path) => String(path),
    },
    options: {
      source: SOURCE, tree: TREE, context: CONTEXT, harness: HARNESS,
      harnessSource: HARNESS_COMMIT, harnessTree: HARNESS_TREE,
      report: REPORT, docker: "docker", keepImage: false,
    },
  };
}

/**
 * Runs the driver against a fake world and returns its result or its error.
 *
 * Every side effect is injected, so these tests write nothing real. The
 * world's `writeFile` honours `wx` exactly as `node:fs` does; `competitorAtWrite`
 * lets another actor win the race between the pre-flight and the write.
 */
async function drive(spec = {}, optionOverrides = {}, depOverrides = {}) {
  const world = createWorld(spec);
  const deps = {
    ...world.deps,
    writeFile: async (path, contents, options) => {
      const key = String(path);
      if (typeof spec.competitorAtWrite === "string" && !world.files.has(key)) {
        world.files.set(key, Buffer.from(spec.competitorAtWrite, "utf8"));
      }
      return world.deps.writeFile(path, contents, options);
    },
    ...depOverrides,
  };
  try {
    const result = await runReleaseImageAcceptance({ ...world.options, ...optionOverrides }, deps);
    return { world, result, error: null };
  } catch (error) {
    return { world, result: null, error };
  }
}

const startedFinished = {
  startedAt: "2026-09-12T00:00:00.000Z",
  finishedAt: "2026-09-12T00:10:00.000Z",
};

/** A PASS-shaped evidence input, which individual tests then break. */
function evidenceInput(overrides = {}) {
  const base = {
    verdict: "PASS",
    ...startedFinished,
    source: {
      commit: SOURCE,
      tree: TREE,
      contextClean: true,
      verifiedBeforeBuild: true,
      verifiedAfterBuild: true,
      dockerfileObject: fakeObject(RELEASE_DOCKERFILE),
      dockerfileSha256: sha256(DOCKERFILE_BODY),
      releaseInputs: RELEASE_INPUT_FILES.map((path) => ({
        path, object: fakeObject(path), sha256: sha256(path),
      })),
    },
    harness: {
      commit: HARNESS_COMMIT,
      tree: HARNESS_TREE,
      directory: HARNESS_DIRECTORY,
      directoryTree: HARNESS_DIR_TREE,
      driverPath: HARNESS_DRIVER_PATH,
      driverObject: DRIVER_OBJECT,
      contextClean: true,
      verifiedBeforeRun: true,
      verifiedAfterRun: true,
      verificationPoints: [...HARNESS_POINTS],
      driverInsideHarness: true,
      worktreeIsReleaseContext: false,
      commitIsReleaseSource: false,
    },
    image: {
      candidateTag: TAG,
      imageId: IMAGE_ID,
      runSubject: IMAGE_ID,
      candidateRuns: REQUIRED_CANDIDATE_RUN_PURPOSES.map((purpose) => ({ purpose, subject: IMAGE_ID })),
      os: "linux",
      architecture: "arm64",
      acceptedWorkerArchitecture: "arm64",
      user: "node",
      workingDir: "/app",
      cmd: [...EXPECTED_IMAGE_CONFIG.cmd],
      entrypoint: ["docker-entrypoint.sh"],
      entrypointShim: { path: ENTRYPOINT_SHIM_PATH, sha256: "a".repeat(64), uid: 0, mode: "0755" },
      exposedPorts: ["8080/tcp"],
      healthcheckPresent: false,
      configuredVolumes: [],
      environmentNames: ["NODE_ENV", "WORKER_PORT"],
    },
    sourceToImage: {
      method: "manifest",
      expectedFileCount: 7,
      observedFileCount: 7,
      comparedFileCount: 7,
      expectedManifestDigest: sha256("expected"),
      observedManifestDigest: sha256("expected"),
      equal: true,
      missingFromImage: [],
      contentMismatched: [],
      unexpectedInImage: [],
      irregularApplicationFiles: [],
      brokerSourcePresent: false,
      brokerFilesExcludedFromManifest: 2,
      acceptanceHarnessPathsPresent: [],
    },
    runtime: {
      node: "v22.23.2", python: "Python 3.11.2",
      ytdlpVersion: EXPECTED_YTDLP_RUNTIME.version, ytdlpSha256: EXPECTED_YTDLP_RUNTIME.sha256,
      ytdlpPath: EXPECTED_YTDLP_RUNTIME.path, ytdlpUid: 0, ytdlpGid: 0, ytdlpMode: "0555",
      ytdlpWriteRefusalCode: "EROFS",
      ffmpeg: "ffmpeg version 5.1.8", ffprobe: "ffprobe version 5.1.8", runtimeUid: 1000,
    },
    hardening: {
      forbiddenTools: [{ tool: "docker", present: false, locations: [] }],
      forbiddenEnvironmentNamesFound: [],
      policyVerifiers: POLICY_VERIFIERS.map((verifier) => ({ verifier, exitCode: 0, ok: true })),
    },
    splitAcceptance: {
      familiesExecuted: ["mp4", "webm"],
      children: REQUIRED_SPLIT_FAMILIES.map((family) => ({
        family, schema: REQUIRED_CHILD_SCHEMA, verdict: "PASS", ok: true,
        sha256: sha256(family), bytes: 100, checkCount: 2, failedCheckCount: 0,
        evidenceFile: `split06-${family}.json`, sourceCommit: SOURCE, sourceTree: TREE,
        ranImage: IMAGE_ID, ranImageId: IMAGE_ID, networkMode: "none", reason: null,
      })),
    },
    production: { latestTag: "videofetch-worker:latest", retaggedLatest: false },
    checks: REQUIRED_PASS_CHECKS.map((name) => ({ name, ok: true, detail: null })),
  };
  return deepMerge(base, overrides);
}

function deepMerge(base, overrides) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
        ? deepMerge(base[key], value)
        : value;
  }
  return out;
}

// ── 1. The container model ─────────────────────────────────────────────────

describe("SPLIT-07 candidate image tags", () => {
  it("derives an unmistakably temporary tag from the release source commit", () => {
    assert.equal(candidateImageTag(SOURCE), `${CANDIDATE_IMAGE_REPOSITORY}:split07-7400a51b578d-local-test`);
  });

  it("needs the full source SHA, never an abbreviation", () => {
    assert.throws(() => candidateImageTag("7400a51b"), /full release source commit SHA/);
    assert.throws(() => candidateImageTag(SOURCE.toUpperCase()), /full release source commit SHA/);
  });

  // §22.5 — a forbidden candidate tag is refused.
  it("refuses every deployable tag", () => {
    for (const tag of FORBIDDEN_CANDIDATE_TAGS) {
      assert.throws(
        () => assertCandidateReference(`${CANDIDATE_IMAGE_REPOSITORY}:${tag}`),
        /refusing a deployable candidate tag/,
        `${tag} must be refused`,
      );
    }
  });

  it("refuses a tag that is merely plausible, and a repository that is not ours", () => {
    assert.throws(() => assertCandidateReference("videofetch-worker:split07-candidate"), /unmistakably temporary/);
    assert.throws(() => assertCandidateReference("videofetch-worker"), /explicit tag/);
    assert.throws(
      () => assertCandidateReference(`other-worker:split07-${SOURCE.slice(0, 12)}-local-test`),
      /refusing a candidate outside/,
    );
  });

  // §22.6 — the driver can never retag `latest`.
  it("never produces a `docker tag` argv at all, and `image rm` only for a candidate", () => {
    assert.deepEqual(candidateRemoveArgs(candidateImageTag(SOURCE)), [
      "image", "rm", `${CANDIDATE_IMAGE_REPOSITORY}:split07-7400a51b578d-local-test`,
    ]);
    assert.throws(() => candidateRemoveArgs("videofetch-worker:latest"), /refusing a deployable candidate tag/);
  });

  it("builds from the REAL Dockerfile.worker inside the verified context", () => {
    const args = releaseBuildArgs({ image: candidateImageTag(SOURCE), context: CONTEXT });
    assert.deepEqual(args, [
      "build", "-f", `${CONTEXT}/${RELEASE_DOCKERFILE}`, "-t",
      `${CANDIDATE_IMAGE_REPOSITORY}:split07-7400a51b578d-local-test`, CONTEXT,
    ]);
    assert.equal(RELEASE_DOCKERFILE, "Dockerfile.worker");
    // No build arg, no secret, no alternate network.
    for (const forbidden of ["--build-arg", "--secret", "--network", "--build-context", "--ssh"]) {
      assert.ok(!args.includes(forbidden), `${forbidden} must not appear in a release build`);
    }
  });

  it("inspects images read-only, as one JSON document", () => {
    assert.deepEqual(imageInspectArgs(candidateImageTag(SOURCE)), [
      "image", "inspect", `${CANDIDATE_IMAGE_REPOSITORY}:split07-7400a51b578d-local-test`, "--format", "{{json .}}",
    ]);
    assert.throws(() => imageInspectArgs(""), /image reference is required/);
  });

  it("refuses a relative build context", () => {
    assert.throws(
      () => releaseBuildArgs({ image: candidateImageTag(SOURCE), context: "vf-release" }),
      /absolute path/,
    );
  });
});

describe("SPLIT-07 hardened container invocations", () => {
  const imageId = IMAGE_ID;

  const invocations = () => [
    ["probe", probeRunArgs({ imageId, harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`, mode: "manifest" })],
    ["selector verifier", policyVerifierRunArgs({ imageId, harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`, verifier: "verify-selector.py" })],
    ["download-policy verifier", policyVerifierRunArgs({ imageId, harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`, verifier: "verify-download-policy.py" })],
    ["mp4 acceptance", releaseAcceptanceRunArgs({ imageId, family: "mp4", harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`, reportDir: REPORT, evidenceName: "a.json" })],
    ["webm acceptance", releaseAcceptanceRunArgs({ imageId, family: "webm", harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`, reportDir: REPORT, evidenceName: "b.json" })],
  ];

  // §22 / §16 — `--network none` on every candidate container, SPLIT-06 included.
  it("passes --network none, --cap-drop=ALL, no-new-privileges and --read-only everywhere", () => {
    for (const [label, args] of invocations()) {
      const joined = args.join(" ");
      assert.match(joined, /--network none/, `${label} must be offline`);
      assert.ok(args.includes("--cap-drop=ALL"), `${label} must drop all capabilities`);
      assert.match(joined, /--security-opt no-new-privileges/, `${label} must set no-new-privileges`);
      assert.ok(args.includes("--read-only"), `${label} must have a read-only root`);
      assert.ok(args.includes("--rm"), `${label} must not leave a container behind`);
    }
  });

  it("grants no privilege, no host network, no Docker socket and no capability", () => {
    for (const [label, args] of invocations()) {
      const joined = args.join(" ");
      for (const forbidden of ["--privileged", "--cap-add", "--network host", "NET_ADMIN", "SYS_ADMIN", "docker.sock", "--pid host", "--userns"]) {
        assert.ok(!joined.includes(forbidden), `${label} must not carry ${forbidden}`);
      }
    }
  });

  // §16 — the SPLIT-06 run gets Production's media tmpfs, a disjoint harness
  // scratch tmpfs, and exactly one writable bind: the report directory.
  it("gives the SPLIT-06 run two tmpfs mounts and exactly one writable bind", () => {
    const args = releaseAcceptanceRunArgs({
      imageId, family: "mp4", harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`,
      reportDir: REPORT, evidenceName: "a.json",
    });
    assert.deepEqual(mountTargets(args), ["/tmp/videofetch", HARNESS_SCRATCH_TARGET, HARNESS_MOUNT_TARGET, "/report"]);
    const tmpfs = args.flatMap((arg, i) => (arg === "--tmpfs" ? [args[i + 1]] : []));
    assert.deepEqual(tmpfs, [PRODUCT_MEDIA_TMPFS, HARNESS_SCRATCH_TMPFS]);
    // The harness mount is READ-ONLY; the report directory is the writable one.
    assert.ok(args.includes(`${HARNESS}/deploy/acceptance/ytdlp-generic:${HARNESS_MOUNT_TARGET}:ro`));
    assert.ok(args.includes(`${REPORT}:/report`));
    assert.deepEqual(RELEASE_RUN_ENVIRONMENT, [`TMPDIR=${HARNESS_SCRATCH_TARGET}`]);
  });

  // WORKER-TEMP-TMPFS-OWNERSHIP-001 — the product's media tmpfs must be the one
  // Production actually mounts, uid/gid included, or the run characterizes a
  // filesystem layout nobody deploys.
  it("mounts the product media tmpfs EXACTLY as the Production Worker unit does", () => {
    const unit = readFileSync(new URL("../deploy/systemd/videofetch-worker.service", import.meta.url), "utf8");
    const declared = [...unit.matchAll(/^\s*--tmpfs\s+(\S+)/gm)].map((match) => match[1]);
    assert.deepEqual(declared, [PRODUCT_MEDIA_TMPFS], "the unit's one --tmpfs must equal SPLIT-07's");
    assert.match(PRODUCT_MEDIA_TMPFS, /(^|[:,])uid=1000(,|$)/);
    assert.match(PRODUCT_MEDIA_TMPFS, /(^|[:,])gid=1000(,|$)/);
    assert.match(PRODUCT_MEDIA_TMPFS, /(^|[:,])noexec(,|$)/);
  });

  it("keeps harness scratch disjoint from every product path, and /tmp itself read-only", () => {
    for (const productPath of ["/tmp/videofetch", "/var/lib/videofetch", "/app", "/usr/local/lib/videofetch"]) {
      assert.ok(
        !HARNESS_SCRATCH_TARGET.startsWith(`${productPath}/`) && !productPath.startsWith(`${HARNESS_SCRATCH_TARGET}/`) &&
          HARNESS_SCRATCH_TARGET !== productPath,
        `${HARNESS_SCRATCH_TARGET} must not overlap ${productPath}`,
      );
    }
    for (const family of ["mp4", "webm"]) {
      const args = releaseAcceptanceRunArgs({ imageId, family, harnessDir: "/h", reportDir: REPORT, evidenceName: "a.json" });
      assert.ok(!mountTargets(args).includes("/tmp"), "a tmpfs on /tmp would hide /tmp/videofetch and loosen Production's posture");
      assert.match(HARNESS_SCRATCH_TMPFS, /(^|[:,])noexec(,|$)/);
    }
  });

  it("runs the harness from the image's own Node, entry point and /app workdir", () => {
    const args = releaseAcceptanceRunArgs({
      imageId, family: "webm", harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`,
      reportDir: REPORT, evidenceName: "b.json",
    });
    assert.ok(args.includes("/usr/local/bin/node"));
    assert.ok(args.includes("./scripts/register-ts-aliases.mjs"));
    assert.ok(args.includes("deploy/acceptance/ytdlp-generic/split-full-path.mjs"));
    assert.deepEqual(args.slice(args.indexOf("-w"), args.indexOf("-w") + 2), ["-w", "/app"]);
    assert.deepEqual(args.slice(args.indexOf("--family"), args.indexOf("--family") + 2), ["--family", "webm"]);
  });

  it("keeps the probes and the Python verifiers OUTSIDE /app", () => {
    for (const args of [
      probeRunArgs({ imageId, harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`, mode: "tools" }),
      ...POLICY_VERIFIERS.map((verifier) =>
        policyVerifierRunArgs({ imageId, harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`, verifier })),
    ]) {
      assert.deepEqual(mountTargets(args), [VERIFY_MOUNT_TARGET]);
      assert.ok(!args.join(" ").includes("/app/"), "a probe must not reach into the application tree");
    }
  });

  it("supplies the verifiers no credential and no media URL", () => {
    for (const verifier of POLICY_VERIFIERS) {
      const args = policyVerifierRunArgs({ imageId, harnessDir: `${HARNESS}/deploy/acceptance/ytdlp-generic`, verifier });
      assert.ok(!args.includes("-e") && !args.includes("--env") && !args.includes("--env-file"));
      assert.ok(!args.join(" ").includes("http"));
      assert.deepEqual(args.slice(-3), ["/usr/bin/python3", `${VERIFY_MOUNT_TARGET}/${verifier}`, EXPECTED_YTDLP_RUNTIME.path]);
    }
  });

  it("rejects an unknown verifier and a non-basename evidence file", () => {
    assert.throws(
      () => policyVerifierRunArgs({ imageId, harnessDir: "/h", verifier: "verify-anything.py" }),
      /unknown policy verifier/,
    );
    assert.throws(
      () => releaseAcceptanceRunArgs({ imageId, family: "mp4", harnessDir: "/h", reportDir: REPORT, evidenceName: "../escape.json" }),
      /plain basename/,
    );
    assert.throws(
      () => releaseAcceptanceRunArgs({ imageId, family: "mkv", harnessDir: "/h", reportDir: REPORT, evidenceName: "a.json" }),
      /mp4 or webm/,
    );
  });
});

// §22.10 / §3 — mounting over product source or runtime is structurally refused.
describe("SPLIT-07 forbidden mounts", () => {
  it("refuses a mount over every product source and runtime path", () => {
    for (const target of FORBIDDEN_RELEASE_MOUNT_TARGETS) {
      // A target nested under another forbidden path (the pinned artifact under
      // its directory) is refused by whichever enclosing entry matches first.
      assert.throws(
        () => assertNoForbiddenMounts(["run", "-v", `/host:${target}`, "image"]),
        /refusing to mount over the candidate image's own \//,
        `${target} must be refused`,
      );
    }
  });

  it("refuses a tmpfs over product source just as it refuses a bind", () => {
    assert.throws(() => assertNoForbiddenMounts(["run", "--tmpfs", "/app/src:rw", "i"]), /\/app\/src/);
    assert.throws(() => assertNoForbiddenMounts(["run", "--tmpfs=/app/node_modules", "i"]), /\/app\/node_modules/);
    assert.doesNotThrow(() => assertNoForbiddenMounts(["run", "--tmpfs", PRODUCT_MEDIA_TMPFS, "i"]));
  });

  it("refuses a mount UNDER a forbidden path, and the --mount long form", () => {
    assert.throws(() => assertNoForbiddenMounts(["run", "-v", "/host:/app/src/worker", "i"]), /\/app\/src/);
    assert.throws(
      () => assertNoForbiddenMounts(["run", "--mount", "type=bind,source=/host,target=/app/scripts,readonly", "i"]),
      /\/app\/scripts/,
    );
    assert.throws(() => assertNoForbiddenMounts(["run", "--volume=/host:/app/package.json", "i"]), /package\.json/);
  });

  it("allows the harness mount and the report directory", () => {
    assert.doesNotThrow(() =>
      assertNoForbiddenMounts(["run", "-v", `/h:${HARNESS_MOUNT_TARGET}:ro`, "-v", `${REPORT}:/report`, "i"]));
  });

  it("reads mount targets out of every spelling docker accepts", () => {
    assert.deepEqual(
      mountTargets([
        "-v", "/a:/one", "--volume", "/b:/two:ro",
        "--mount", "type=bind,source=/c,target=/three",
        "--mount=type=bind,src=/d,destination=/four",
        "--volume=/e:/five",
        "--tmpfs", "/six:rw,size=1m",
        "--tmpfs=/seven",
      ]),
      ["/one", "/two", "/three", "/four", "/five", "/six", "/seven"],
    );
  });
});

// ── 2. The provenance gate ─────────────────────────────────────────────────

describe("SPLIT-07 release provenance", () => {
  async function verify(spec = {}) {
    const world = createWorld(spec);
    const git = (args, options = {}) =>
      world.deps.run("git", ["--no-optional-locks", "-C", CONTEXT, ...args], options);
    return verifyReleaseContextProvenance({ git, expectedSource: SOURCE, expectedTree: TREE });
  }

  it("returns OBSERVATIONS for a clean worktree at the expected commit", async () => {
    const observed = await verify();
    assert.equal(observed.source, SOURCE);
    assert.equal(observed.tree, TREE);
    assert.equal(observed.contextClean, true);
    assert.equal(observed.dockerfilePath, RELEASE_DOCKERFILE);
    assert.equal(observed.dockerfileSha256, sha256(DOCKERFILE_BODY));
    assert.equal(observed.releaseInputs.length, RELEASE_INPUT_FILES.length);
    for (const input of observed.releaseInputs) assert.ok(isFullGitSha(input.object));
  });

  // §8 — a directory whose files merely resemble the commit is not provenance.
  it("refuses a context that is not a Git worktree at all", async () => {
    await assert.rejects(
      verify({ git: { "rev-parse --is-inside-work-tree": { code: 128, stdout: "" } } }),
      ReleaseProvenanceError,
    );
    await assert.rejects(
      verify({ git: { "rev-parse --is-inside-work-tree": { code: 0, stdout: "false\n" } } }),
      /not inside a Git worktree/,
    );
  });

  it("refuses a context that is a SUBDIRECTORY of a worktree", async () => {
    await assert.rejects(
      verify({ git: { "rev-parse --show-prefix": { code: 0, stdout: "deploy/\n" } } }),
      /subdirectory of a worktree/,
    );
  });

  // §22.1 — wrong expected source commit.
  it("refuses a commit that is not the expected one", async () => {
    await assert.rejects(
      verify({ git: { "rev-parse --verify --quiet HEAD": { code: 0, stdout: `${"b".repeat(40)}\n` } } }),
      /HEAD is bbbb.*not the expected/,
    );
  });

  // §22.2 — wrong expected source tree.
  it("refuses a tree that is not the expected one", async () => {
    await assert.rejects(
      verify({ git: { [`rev-parse --verify --quiet ${SOURCE}^{tree}`]: { code: 0, stdout: `${"c".repeat(40)}\n` } } }),
      /has tree cccc.*not the expected/,
    );
  });

  it("refuses an abbreviated expectation outright", async () => {
    const world = createWorld();
    const git = (args, options = {}) => world.deps.run("git", ["--no-optional-locks", "-C", CONTEXT, ...args], options);
    await assert.rejects(
      verifyReleaseContextProvenance({ git, expectedSource: "7400a51b", expectedTree: TREE }),
      /--source must be a full lowercase 40-hex SHA/,
    );
    await assert.rejects(
      verifyReleaseContextProvenance({ git, expectedSource: SOURCE, expectedTree: TREE.toUpperCase() }),
      /--tree must be a full lowercase 40-hex SHA/,
    );
  });

  // §22.3 — a dirty build context.
  it("refuses a modified, deleted or untracked worktree", async () => {
    for (const listing of [" M src/lib/config.ts", " D src/lib/config.ts", "?? src/stray.ts"]) {
      await assert.rejects(
        verify({
          git: {
            "status --porcelain=v1 --untracked-files=all --ignored=no --ignore-submodules=none": { code: 0, stdout: `${listing}\n` },
          },
        }),
        /is not clean/,
        `${listing} must be refused`,
      );
    }
  });

  it("refuses IGNORED content, which git status hides and docker build still sends", async () => {
    await assert.rejects(
      verify({
        git: {
          "status --porcelain=v1 --untracked-files=all --ignored=matching --ignore-submodules=none": { code: 0, stdout: "!! .env\n" },
        },
      }),
      /content Git does not track/,
    );
  });

  it("refuses staged changes as their own fact", async () => {
    await assert.rejects(
      verify({ git: { [`diff-index --cached --name-only ${SOURCE}`]: { code: 0, stdout: "package.json\n" } } }),
      /has staged changes/,
    );
  });

  it("refuses an index entry that hides a modification from status", async () => {
    for (const flag of ["h", "S"]) {
      await assert.rejects(
        verify({ git: { "ls-files -v": { code: 0, stdout: `${flag} package.json\n` } } }),
        /assume-unchanged or skip-worktree/,
        `ls-files flag ${flag} must be refused`,
      );
    }
  });

  it("refuses a commit missing a release input", async () => {
    await assert.rejects(
      verify({ git: { [`rev-parse --verify --quiet ${SOURCE}:${RELEASE_DOCKERFILE}`]: { code: 1, stdout: "" } } }),
      new RegExp(`release input ${RELEASE_DOCKERFILE} is absent`),
    );
  });
});

describe("SPLIT-07 source manifest", () => {
  async function manifest(spec = {}) {
    const world = createWorld(spec);
    const git = (args, options = {}) =>
      world.deps.run("git", ["--no-optional-locks", "-C", CONTEXT, ...args], options);
    return buildExpectedSourceManifest({ git, source: SOURCE });
  }

  it("hashes committed bytes, sorts by path, and accounts for the broker removal", async () => {
    const { entries, excludedEntries } = await manifest();
    assert.deepEqual(entries.map((entry) => entry.path), appFiles());
    assert.deepEqual(excludedEntries.map((entry) => entry.path), brokerFiles());
    for (const entry of entries) assert.equal(entry.sha256, sha256(SOURCE_FILES[entry.path]));
    // Sorted, so the digest is a deterministic function of the commit.
    assert.deepEqual([...entries.map((e) => e.path)].sort(), entries.map((e) => e.path));
  });

  it("renders a sha256sum-shaped manifest whose digest is stable", async () => {
    const { entries } = await manifest();
    // Code-unit order: '-' (0x2d) sorts before '.' (0x2e).
    assert.match(renderManifest(entries), /^[0-9a-f]{64} {2}package-lock\.json\n[0-9a-f]{64} {2}package\.json\n/);
    assert.equal(manifestDigest(entries), manifestDigest([...entries]));
    assert.notEqual(manifestDigest(entries), manifestDigest(entries.slice(1)));
  });

  it("refuses a symlink or a non-blob entry under /app", async () => {
    const world = createWorld();
    const withRecord = (record) => (args, options = {}) => {
      if (args[0] === "ls-tree") return Promise.resolve({ code: 0, stdout: record, stdoutBuffer: Buffer.alloc(0), stderr: "" });
      return world.deps.run("git", ["--no-optional-locks", "-C", CONTEXT, ...args], options);
    };
    await assert.rejects(
      buildExpectedSourceManifest({ git: withRecord(`120000 blob ${fakeObject("src/link")}\tsrc/link\0`), source: SOURCE }),
      /carries a symlink under \/app/,
    );
    await assert.rejects(
      buildExpectedSourceManifest({ git: withRecord(`160000 commit ${fakeObject("src/sub")}\tsrc/sub\0`), source: SOURCE }),
      /non-blob entry under \/app/,
    );
  });

  it("refuses a commit with no broker to account for, so the exclusion stays honest", async () => {
    const world = createWorld();
    const git = (args, options = {}) => {
      if (args[0] === "ls-tree") {
        const records = appFiles().map((path) => `100644 blob ${fakeObject(path)}\t${path}\0`).join("");
        return Promise.resolve({ code: 0, stdout: records, stdoutBuffer: Buffer.alloc(0), stderr: "" });
      }
      return world.deps.run("git", ["--no-optional-locks", "-C", CONTEXT, ...args], options);
    };
    await assert.rejects(buildExpectedSourceManifest({ git, source: SOURCE }), /no src\/broker\/ to account for/);
  });
});

// §22.13 — a source-to-image hash mismatch is detected in both directions.
describe("SPLIT-07 source-to-image comparison", () => {
  const expected = () => appFiles().map((path) => ({ path, sha256: sha256(SOURCE_FILES[path]) }));

  it("is equal only when every path and every byte agrees", () => {
    const result = compareSourceManifests({ expected: expected(), observed: faithfulImageManifest() });
    assert.equal(result.equal, true);
    assert.equal(result.comparedFileCount, appFiles().length);
    assert.equal(result.expectedManifestDigest, result.observedManifestDigest);
  });

  it("detects a file missing from the image", () => {
    const result = compareSourceManifests({ expected: expected(), observed: faithfulImageManifest().slice(1) });
    assert.equal(result.equal, false);
    assert.deepEqual(result.missingFromImage, [appFiles()[0]]);
  });

  it("detects a file whose bytes differ", () => {
    const observed = faithfulImageManifest();
    observed[2] = { ...observed[2], sha256: sha256("tampered") };
    const result = compareSourceManifests({ expected: expected(), observed });
    assert.equal(result.equal, false);
    assert.deepEqual(result.contentMismatched, [observed[2].path]);
    assert.notEqual(result.expectedManifestDigest, result.observedManifestDigest);
  });

  it("detects an unexplained application file the source does not have", () => {
    const observed = [...faithfulImageManifest(), { path: "src/smuggled.ts", sha256: sha256("x") }];
    const result = compareSourceManifests({ expected: expected(), observed });
    assert.equal(result.equal, false);
    assert.deepEqual(result.unexpectedInImage, ["src/smuggled.ts"]);
  });
});

// ── 3. The evidence contract ───────────────────────────────────────────────

describe("SPLIT-07 child record validation", () => {
  const bytesOf = (record) => Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");

  it("accepts a PASS child and reports its exact byte digest", () => {
    const bytes = bytesOf(passingChild("mp4"));
    const child = validateChildRecord({ family: "mp4", bytes });
    assert.equal(child.ok, true);
    assert.equal(child.schema, REQUIRED_CHILD_SCHEMA);
    assert.equal(child.verdict, "PASS");
    assert.equal(child.checkCount, 2);
    assert.equal(child.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(child.networkMode, "none");
  });

  // §22.23 — a child of the wrong SPLIT-06 schema cannot pass.
  it("rejects a child carrying a different SPLIT-06 schema", () => {
    for (const schema of ["split06-deterministic-full-path-03", "split06-deterministic-full-path-05", "10d-remediation-03"]) {
      const child = validateChildRecord({ family: "mp4", bytes: bytesOf(passingChild("mp4", { schema })) });
      assert.equal(child.ok, false, `${schema} must not be accepted`);
      assert.match(child.reason, /schema is/);
    }
  });

  it("rejects a non-PASS verdict, a mismatched family and a failed check", () => {
    assert.equal(validateChildRecord({ family: "mp4", bytes: bytesOf(passingChild("mp4", { verdict: "BLOCKED" })) }).ok, false);
    assert.equal(validateChildRecord({ family: "mp4", bytes: bytesOf(passingChild("webm")) }).ok, false);
    const failedCheck = passingChild("mp4");
    failedCheck.checks[1] = { name: "processing/merged", ok: false, detail: null };
    const child = validateChildRecord({ family: "mp4", bytes: bytesOf(failedCheck) });
    assert.equal(child.ok, false);
    assert.equal(child.failedCheckCount, 1);
  });

  it("rejects an empty check ledger and unparseable bytes", () => {
    assert.equal(validateChildRecord({ family: "mp4", bytes: bytesOf(passingChild("mp4", { checks: [] })) }).ok, false);
    const broken = validateChildRecord({ family: "mp4", bytes: Buffer.from("{not json", "utf8") });
    assert.equal(broken.ok, false);
    assert.match(broken.reason, /not parseable JSON/);
  });

  it("insists on exact bytes, never a decoded object", () => {
    assert.throws(() => validateChildRecord({ family: "mp4", bytes: JSON.stringify(passingChild("mp4")) }), /exact bytes/);
    assert.throws(() => validateChildRecord({ family: "mkv", bytes: bytesOf(passingChild("mp4")) }), /unknown split family/);
  });

  // §22.24 — a child edited after observation is detected.
  it("detects a child whose bytes changed after its digest was taken", () => {
    const bytes = bytesOf(passingChild("mp4"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(assertChildUnchanged({ family: "mp4", expectedSha256: digest, bytes }), digest);
    const tampered = bytesOf(passingChild("mp4", { verdict: "PASS", family: "mp4", startedAt: "later" }));
    assert.throws(
      () => assertChildUnchanged({ family: "mp4", expectedSha256: digest, bytes: tampered }),
      /child evidence changed after it was observed/,
    );
  });
});

describe("SPLIT-07 evidence builder", () => {
  it("emits a PASS record from a complete, all-passing input", () => {
    const record = buildReleaseEvidence(evidenceInput());
    assert.equal(record.schema, SPLIT07_EVIDENCE_SCHEMA);
    assert.equal(record.verdict, "PASS");
    assert.equal(record.image.deployable, false);
    assert.equal(record.image.retainedCandidate, false);
    assert.equal(record.image.builtFromDockerfile, RELEASE_DOCKERFILE);
    assert.equal(record.harness.commit, HARNESS_COMMIT);
    assert.equal(record.harness.tree, HARNESS_TREE);
    assert.equal(record.harness.verifiedBeforeRun, true);
    assert.equal(record.harness.verifiedAfterRun, true);
    assert.equal(record.harness.worktreeIsReleaseContext, false);
    assert.equal(record.image.runSubject, IMAGE_ID);
    assert.equal(record.source.harnessRole, undefined, "-01's unverified harnessRole is gone");
    assert.equal(record.splitAcceptance.requiredChildSchema, REQUIRED_CHILD_SCHEMA);
    assert.match(renderReleaseEvidence(record), /^\{\n {2}"schema"/);
  });

  // §22.25 — a PASS parent with any required failed check is refused.
  it("refuses a PASS whose ledger carries a failed check", () => {
    for (const name of REQUIRED_PASS_CHECKS) {
      const input = evidenceInput();
      input.checks = input.checks.map((check) => (check.name === name ? { ...check, ok: false } : check));
      assert.throws(
        () => buildReleaseEvidence(input),
        /refusing to emit a PASS .* with failed checks/,
        `a failed ${name} must refuse a PASS`,
      );
    }
  });

  it("refuses a PASS whose ledger is MISSING a required check", () => {
    for (const name of REQUIRED_PASS_CHECKS) {
      const input = evidenceInput();
      input.checks = input.checks.filter((check) => check.name !== name);
      assert.throws(
        () => buildReleaseEvidence(input),
        new RegExp(`missing required checks: ${name}`),
        `an absent ${name} must refuse a PASS`,
      );
    }
  });

  it("refuses a PASS whose ledger carries an unexpected failed check", () => {
    const input = evidenceInput();
    input.checks.push({ name: "something/else", ok: false, detail: null });
    assert.throws(() => buildReleaseEvidence(input), /with failed checks: something\/else/);
  });

  // §22.20 / §22.21 — either child failing fails the top level.
  it("refuses a PASS when a child did not pass, for each family independently", () => {
    for (const family of REQUIRED_SPLIT_FAMILIES) {
      const input = evidenceInput();
      input.splitAcceptance.children = input.splitAcceptance.children.map((child) =>
        child.family === family ? { ...child, ok: false, verdict: "FAIL" } : child);
      assert.throws(
        () => buildReleaseEvidence(input),
        new RegExp(`whose ${family} child did not pass`),
        `a failed ${family} child must refuse a PASS`,
      );
    }
  });

  // §22.22 — one family executed cannot PASS.
  it("refuses a PASS that executed only one split family", () => {
    for (const family of REQUIRED_SPLIT_FAMILIES) {
      const input = evidenceInput();
      input.splitAcceptance.familiesExecuted = [family];
      input.splitAcceptance.children = input.splitAcceptance.children.filter((child) => child.family === family);
      assert.throws(
        () => buildReleaseEvidence(input),
        /(without a (mp4|webm) SPLIT-06 child|did not execute exactly)/,
        `only ${family} must refuse a PASS`,
      );
    }
  });

  // Found by mutation testing: the test above also removes the other child, so
  // the missing-child refusal fires first and the executed-family requirement
  // itself was never isolated. Here BOTH children are present and passing.
  it("refuses a PASS whose executed-family list is not exactly mp4 and webm, even with both children", () => {
    for (const familiesExecuted of [["mp4"], ["webm"], ["mp4", "mp4"], ["mp4", "webm", "webm"], []]) {
      const input = evidenceInput();
      input.splitAcceptance.familiesExecuted = familiesExecuted;
      assert.equal(input.splitAcceptance.children.length, 2);
      assert.throws(
        () => buildReleaseEvidence(input),
        /did not execute exactly mp4 and webm/,
        `${JSON.stringify(familiesExecuted)} must refuse a PASS`,
      );
    }
  });

  it("refuses a PASS whose child is of the wrong schema or has no digest", () => {
    const wrongSchema = evidenceInput();
    wrongSchema.splitAcceptance.children[0].schema = "split06-deterministic-full-path-03";
    assert.throws(() => buildReleaseEvidence(wrongSchema), /child is split06-deterministic-full-path-03/);
    const noDigest = evidenceInput();
    noDigest.splitAcceptance.children[1].sha256 = null;
    assert.throws(() => buildReleaseEvidence(noDigest), /has no content digest/);
  });

  it("refuses a record without driver-verified provenance, before AND after the build", () => {
    for (const mutation of [
      { commit: "7400a51b" },
      { tree: null },
      { contextClean: false },
      { verifiedBeforeBuild: false },
      { verifiedAfterBuild: false },
      { dockerfileObject: "not-a-sha" },
      { dockerfileSha256: "short" },
      { releaseInputs: [] },
    ]) {
      const input = evidenceInput();
      Object.assign(input.source, mutation);
      assert.throws(
        () => buildReleaseEvidence(input),
        /without driver-verified release provenance/,
        `${JSON.stringify(mutation)} must be refused`,
      );
    }
  });

  it("refuses a PASS record naming a deployable tag even if the ledger is green", () => {
    const input = evidenceInput({ image: { candidateTag: "videofetch-worker:latest" } });
    assert.throws(() => buildReleaseEvidence(input), /naming a deployable tag/);
  });

  it("refuses with its own error type, distinguishable from an operational failure", () => {
    const input = evidenceInput();
    input.checks = input.checks.slice(1);
    assert.throws(() => buildReleaseEvidence(input), ReleaseEvidenceError);
  });

  it("carries no raw process output, credential or argv, at any depth", () => {
    const record = buildReleaseEvidence(evidenceInput());
    const serialized = JSON.stringify(record);
    for (const key of ["stderr", "argv", "cmdline", "token", "secret", "credential", "authorization", "cookie", "sessionToken"]) {
      assert.ok(!serialized.includes(`"${key}":`), `${key} must not appear in a SPLIT-07 record`);
    }
    assert.ok(!serialized.includes("http://") && !serialized.includes("https://"));
  });

  it("refuses to assemble a record carrying a forbidden field at all", () => {
    const input = evidenceInput();
    input.checks = [...input.checks, { name: "x", ok: true, stderr: "boom" }];
    assert.throws(() => buildReleaseEvidence(input), /containing a 'stderr' field/);
  });

  it("names a NEW schema, and never reuses or bumps SPLIT-06's", () => {
    assert.equal(SPLIT07_EVIDENCE_SCHEMA, "split07-release-image-candidate-02");
    assert.equal(REQUIRED_CHILD_SCHEMA, "split06-deterministic-full-path-04");
    assert.notEqual(SPLIT07_EVIDENCE_SCHEMA, REQUIRED_CHILD_SCHEMA);
  });

  it("keeps a FAIL record emittable, so a failure is reportable", () => {
    const input = evidenceInput({ verdict: "FAIL" });
    input.checks = input.checks.map((check) =>
      check.name === "runtime/ytdlp-sha256" ? { ...check, ok: false, detail: "digest mismatch" } : check);
    const record = buildReleaseEvidence(input);
    assert.equal(record.verdict, "FAIL");
    assert.equal(record.checks.find((check) => check.name === "runtime/ytdlp-sha256").ok, false);
  });
});

// ── 4. The driver, end to end, against a fake world ────────────────────────

describe("SPLIT-07 driver argument handling", () => {
  const base = [
    "--source", SOURCE, "--tree", TREE, "--context", CONTEXT, "--harness", HARNESS,
    "--harness-source", HARNESS_COMMIT, "--harness-tree", HARNESS_TREE, "--report", REPORT,
  ];
  const without = (flag) => {
    const copy = [...base];
    copy.splice(copy.indexOf(flag), 2);
    return copy;
  };

  it("requires four full SHAs and three absolute paths", () => {
    assert.deepEqual(parseArgv(base), {
      source: SOURCE, tree: TREE, context: CONTEXT, harness: HARNESS,
      harnessSource: HARNESS_COMMIT, harnessTree: HARNESS_TREE, report: REPORT,
      docker: "docker", keepImage: false,
    });
    for (const flag of ["--source", "--tree", "--context", "--harness", "--harness-source", "--harness-tree", "--report"]) {
      assert.throws(() => parseArgv(without(flag)), new RegExp(`${flag} is required`));
    }
    assert.throws(() => parseArgv([...without("--source"), "--source", "7400a51b"]), /--source must be a full/);
    assert.throws(() => parseArgv([...without("--harness-source"), "--harness-source", "7f3cdd3f"]), /--harness-source must be a full/);
    assert.throws(() => parseArgv([...without("--harness-tree"), "--harness-tree", "A".repeat(40)]), /--harness-tree must be a full/);
    assert.throws(() => parseArgv([...without("--context"), "--context", "rel"]), /--context must be an absolute path/);
    assert.throws(() => parseArgv([...base, "--tag", "x"]), /unknown argument: --tag/);
  });
});

describe("SPLIT-07 driver", () => {
  const dockerArgs = (world) => world.dockerCalls.map((call) => call.args.join(" "));

  it("PASSes a faithful release image and emits one record naming both children", async () => {
    const { result, error, world } = await drive();
    assert.equal(error, null, error ? String(error.message) : undefined);
    assert.equal(result.verdict, "PASS");
    assert.equal(result.code, 0);
    assert.equal(result.record.schema, SPLIT07_EVIDENCE_SCHEMA);
    assert.equal(result.record.image.imageId, IMAGE_ID);
    assert.equal(result.record.sourceToImage.equal, true);
    assert.deepEqual(result.record.splitAcceptance.familiesExecuted, ["mp4", "webm"]);
    assert.equal(result.record.splitAcceptance.children.length, 2);
    for (const child of result.record.splitAcceptance.children) {
      assert.equal(child.schema, REQUIRED_CHILD_SCHEMA);
      assert.equal(child.verdict, "PASS");
      assert.match(child.sha256, /^[0-9a-f]{64}$/);
    }
    // The candidate is removed, and `latest` was never written.
    assert.ok(dockerArgs(world).includes(`image rm ${world.tag}`));
    assert.ok(!dockerArgs(world).some((args) => args.startsWith("tag ")));
  });

  // §22.1 / §22.2 / §22.3 / §22.4 — no Docker command runs before provenance holds.
  for (const [label, spec] of [
    ["a wrong expected commit", { git: { "rev-parse --verify --quiet HEAD": { code: 0, stdout: `${"b".repeat(40)}\n` } } }],
    ["a wrong expected tree", { git: { [`rev-parse --verify --quiet ${SOURCE}^{tree}`]: { code: 0, stdout: `${"c".repeat(40)}\n` } } }],
    ["a dirty context", { git: { "status --porcelain=v1 --untracked-files=all --ignored=no --ignore-submodules=none": { code: 0, stdout: " M src/lib/config.ts\n" } } }],
    ["a context that is not a worktree", { git: { "rev-parse --is-inside-work-tree": { code: 0, stdout: "false\n" } } }],
  ]) {
    it(`starts NO docker command for ${label}`, async () => {
      const { result, error, world } = await drive(spec);
      assert.equal(result, null);
      assert.ok(error instanceof ReleaseProvenanceError, `expected a provenance refusal, got ${String(error)}`);
      assert.deepEqual(world.dockerCalls, [], "no docker command may run before provenance holds");
    });
  }

  // §22.4 — a context that changes DURING the build is refused.
  it("refuses a context that changed while the image was being built", async () => {
    const world = createWorld();
    let builds = 0;
    const guarded = {
      ...world.deps,
      run: async (command, args, options) => {
        if (command === "docker" && args[0] === "build") builds += 1;
        if (command === "git" && builds > 0 && args.slice(3).join(" ") === "status --porcelain=v1 --untracked-files=all --ignored=no --ignore-submodules=none") {
          return { code: 0, stdout: " M src/lib/config.ts\n", stdoutBuffer: Buffer.alloc(0), stderr: "" };
        }
        return world.deps.run(command, args, options);
      },
    };
    await assert.rejects(
      runReleaseImageAcceptance(world.options, guarded),
      /release build context changed while the image was being built/,
    );
    // The candidate is still cleaned up after the refusal.
    assert.ok(world.dockerCalls.map((c) => c.args.join(" ")).includes(`image rm ${world.tag}`));
  });

  // §22.7 — a root runtime user fails.
  it("FAILs an image whose runtime user is root or missing", async () => {
    for (const user of ["root", "", "0"]) {
      const { result } = await drive({ configOverrides: { User: user } });
      assert.equal(result.verdict, "FAIL", `User=${user} must fail`);
      assert.equal(result.checks.find((c) => c.name === "image/runtime-user-is-non-root-node").ok, false);
    }
  });

  it("FAILs an image whose workdir, CMD, ports or healthcheck deviate", async () => {
    const cases = [
      [{ WorkingDir: "/" }, "image/working-directory"],
      [{ Cmd: ["npm", "run", "preview"] }, "image/cmd-is-the-worker-entry-point"],
      [{ Entrypoint: ["/usr/bin/tini"] }, "image/cmd-is-the-worker-entry-point"],
      [{ ExposedPorts: { "8080/tcp": {}, "9229/tcp": {} } }, "image/only-the-worker-port-is-exposed"],
      [{ Healthcheck: { Test: ["CMD", "true"] } }, "image/no-in-image-healthcheck"],
      [{ Volumes: { "/var/lib/videofetch": {} } }, "image/no-host-mount-in-the-image-config"],
    ];
    for (const [configOverrides, check] of cases) {
      const { result } = await drive({ configOverrides });
      assert.equal(result.verdict, "FAIL", `${check} must fail`);
      assert.equal(result.checks.find((c) => c.name === check).ok, false, `${check} must be the failing check`);
    }
  });

  it("accepts no ENTRYPOINT, or exactly the inherited node exec shim, and nothing else", async () => {
    assert.deepEqual(ALLOWED_IMAGE_ENTRYPOINTS.map((entry) => [...entry]), [[], ["docker-entrypoint.sh"]]);
    for (const Entrypoint of [null, [], ["docker-entrypoint.sh"]]) {
      const { result } = await drive({ configOverrides: { Entrypoint } });
      assert.equal(result.verdict, "PASS", `Entrypoint=${JSON.stringify(Entrypoint)} must be accepted`);
    }
    for (const Entrypoint of [["/usr/bin/tini", "--"], ["sh", "-c", "node x"], ["docker-entrypoint.sh", "npm"], ["/usr/local/bin/docker-entrypoint.sh"]]) {
      const { result } = await drive({ configOverrides: { Entrypoint } });
      assert.equal(result.verdict, "FAIL", `Entrypoint=${JSON.stringify(Entrypoint)} must be refused`);
      assert.equal(result.checks.find((c) => c.name === "image/cmd-is-the-worker-entry-point").ok, false);
    }
  });

  it("FAILs an inherited shim that is missing, replaced, relinked or writable", async () => {
    for (const mutation of [
      { present: false },
      { uid: 1000 },
      { mode: "0777" },
      { mode: "0775" },
      { isRegularFile: false },
      { realpath: "/tmp/elsewhere.sh" },
      { sha256: null },
    ]) {
      const { result } = await drive({ probes: { runtime: { entrypointShim: shimObservation(mutation) } } });
      assert.equal(result.verdict, "FAIL", `shim ${JSON.stringify(mutation)} must fail`);
      assert.equal(result.checks.find((c) => c.name === "image/entrypoint-shim-root-owned-and-unwritable").ok, false);
    }
    // With no ENTRYPOINT there is no shim in the start path, so none is required.
    const none = await drive({ configOverrides: { Entrypoint: [] }, probes: { runtime: { entrypointShim: { present: false } } } });
    assert.equal(none.result.verdict, "PASS");
  });

  it("records the shim's observed digest in the evidence", async () => {
    const { result } = await drive();
    assert.deepEqual(result.record.image.entrypoint, ["docker-entrypoint.sh"]);
    assert.equal(result.record.image.entrypointShim.path, ENTRYPOINT_SHIM_PATH);
    assert.match(result.record.image.entrypointShim.sha256, /^[0-9a-f]{64}$/);
  });

  it("FAILs an image that is not Linux, and records the architecture", async () => {
    const { result } = await drive({ imageConfig: { Os: "windows" } });
    assert.equal(result.checks.find((c) => c.name === "image/os-is-linux").ok, false);
    const drifted = await drive({ imageConfig: { Architecture: "amd64" } });
    assert.equal(
      drifted.result.checks.find((c) => c.name === "image/architecture-matches-the-accepted-worker").ok,
      false,
    );
    // A FAIL is still recorded — a failure must be reportable — but as a FAIL.
    assert.equal(drifted.result.verdict, "FAIL");
    assert.equal(drifted.result.record.verdict, "FAIL");
  });

  // §22.8 / §22.9 / §22.10 — baked feature gate, retired contract, or path.
  it("FAILs an image that bakes a forbidden environment name", async () => {
    for (const name of FORBIDDEN_IMAGE_ENVIRONMENT_NAMES) {
      const viaConfig = await drive({
        configOverrides: {
          Env: ["NODE_ENV=production", "WORKER_BIND_HOST=0.0.0.0", "WORKER_PORT=8080",
            "WORKER_DATA_DIRECTORY=/var/lib/videofetch", "TEMP_DIRECTORY=/tmp/videofetch",
            "FFMPEG_PATH=/usr/bin/ffmpeg", `${name}=whatever`],
        },
      });
      assert.equal(viaConfig.result.verdict, "FAIL", `a baked ${name} must fail`);
      const check = viaConfig.result.checks.find((c) => c.name === "image/no-forbidden-environment-name-baked");
      assert.equal(check.ok, false);
      assert.match(check.detail, new RegExp(name));
    }
  });

  it("FAILs a forbidden environment name observed only INSIDE the container", async () => {
    const { result } = await drive({ probes: { env: { names: ["NODE_ENV", "YTDLP_ENABLED"] } } });
    assert.equal(result.checks.find((c) => c.name === "image/no-forbidden-environment-name-baked").ok, false);
  });

  it("FAILs an image missing an expected non-secret default", async () => {
    const { result } = await drive({ configOverrides: { Env: ["NODE_ENV=production"] } });
    assert.equal(result.checks.find((c) => c.name === "image/expected-non-secret-environment-present").ok, false);
  });

  // §22.11 — broker source present.
  it("FAILs an image that still contains the broker source", async () => {
    const { result } = await drive({ probes: { manifest: { brokerPresent: true } } });
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.checks.find((c) => c.name === "sourceToImage/broker-source-absent").ok, false);
  });

  // §22.12 — the acceptance harness baked into the image.
  it("FAILs an image with the acceptance harness baked in, and names the path", async () => {
    const { result } = await drive({ probes: { manifest: { harnessPathsPresent: ["/app/deploy/acceptance"] } } });
    assert.equal(result.verdict, "FAIL");
    const check = result.checks.find((c) => c.name === "sourceToImage/acceptance-harness-not-baked");
    assert.equal(check.ok, false);
    assert.match(check.detail, /\/app\/deploy\/acceptance/);
  });

  // §22.13 — a source-to-image content mismatch.
  it("FAILs an image whose /app content disagrees with the verified commit", async () => {
    const tampered = faithfulImageManifest();
    tampered[0] = { ...tampered[0], sha256: sha256("tampered") };
    const mismatch = await drive({ probes: { manifest: { entries: tampered } } });
    assert.equal(mismatch.result.verdict, "FAIL");
    assert.equal(mismatch.result.checks.find((c) => c.name === "sourceToImage/manifest-matches-the-verified-commit").ok, false);

    const smuggled = await drive({
      probes: { manifest: { entries: [...faithfulImageManifest(), { path: "src/smuggled.ts", sha256: sha256("x") }] } },
    });
    assert.equal(smuggled.result.verdict, "FAIL");

    const missing = await drive({ probes: { manifest: { entries: faithfulImageManifest().slice(1) } } });
    assert.equal(missing.result.verdict, "FAIL");
  });

  it("FAILs an image carrying a symlink or irregular file under /app", async () => {
    const { result } = await drive({ probes: { manifest: { irregular: ["src/link: symlink"] } } });
    assert.equal(result.checks.find((c) => c.name === "sourceToImage/no-irregular-application-file").ok, false);
  });

  // §22.14 / §22.15 — the pinned runtime's version and digest.
  it("FAILs a wrong pinned yt-dlp version", async () => {
    const { result } = await drive({ probes: { runtime: { ytdlp: pinnedArtifact({ version: "2026.09.01" }) } } });
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.checks.find((c) => c.name === "runtime/ytdlp-version").ok, false);
  });

  it("FAILs a wrong pinned yt-dlp digest", async () => {
    const { result } = await drive({ probes: { runtime: { ytdlp: pinnedArtifact({ sha256: "0".repeat(64) }) } } });
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.checks.find((c) => c.name === "runtime/ytdlp-sha256").ok, false);
  });

  it("FAILs a pinned artifact that is not root-owned, unwritable, or is writable in fact", async () => {
    for (const [mutation, check] of [
      [{ uid: 1000 }, "runtime/ytdlp-root-owned-and-unwritable"],
      [{ mode: "0755" }, "runtime/ytdlp-root-owned-and-unwritable"],
      [{ realpath: "/tmp/yt-dlp" }, "runtime/ytdlp-root-owned-and-unwritable"],
      [{ writeAttempt: { attempted: true, succeeded: true, code: null } }, "runtime/ytdlp-not-self-updatable-by-the-runtime-user"],
    ]) {
      const { result } = await drive({ probes: { runtime: { ytdlp: pinnedArtifact(mutation) } } });
      assert.equal(result.verdict, "FAIL", `${JSON.stringify(mutation)} must fail`);
      assert.equal(result.checks.find((c) => c.name === check).ok, false);
    }
  });

  // §22.18 / §22.19 — missing ffmpeg or ffprobe.
  it("FAILs a missing or unexecutable ffmpeg and ffprobe independently", async () => {
    for (const tool of ["ffmpeg", "ffprobe"]) {
      for (const mutation of [{ present: false, executable: false }, { present: true, executable: false }]) {
        const { result } = await drive({ probes: { runtime: { [tool]: { path: `/usr/bin/${tool}`, version: "", exitCode: 127, ...mutation } } } });
        assert.equal(result.verdict, "FAIL", `${tool} ${JSON.stringify(mutation)} must fail`);
        assert.equal(result.checks.find((c) => c.name === `runtime/${tool}-present-and-executable`).ok, false);
      }
    }
  });

  it("FAILs a Python that cannot execute the pinned artifact", async () => {
    const { result } = await drive({ probes: { runtime: { python: { path: "/usr/bin/python3", version: "" } } } });
    assert.equal(result.checks.find((c) => c.name === "runtime/python-can-execute-the-pinned-artifact").ok, false);
  });

  // §12 / §22 — a forbidden administrative tool is a finding, never normalized.
  it("FAILs an image containing any forbidden administrative tool, and names where", async () => {
    for (const tool of ["docker", "sudo", "ssh", "nft", "iptables", "curl", "wget"]) {
      const { result } = await drive({
        probes: {
          tools: {
            tools: ["docker", "sudo", "ssh", "nft", "iptables", "curl", "wget"].map((name) => ({
              tool: name, present: name === tool, locations: name === tool ? [`/usr/bin/${name}`] : [],
            })),
          },
        },
      });
      assert.equal(result.verdict, "FAIL", `${tool} must fail`);
      const check = result.checks.find((c) => c.name === "hardening/no-forbidden-administrative-tool");
      assert.equal(check.ok, false);
      assert.match(check.detail, new RegExp(`${tool}@/usr/bin/${tool}`));
    }
  });

  // §22.16 / §22.17 — either static verifier failing fails the run.
  it("FAILs when the selector or the download-policy verifier exits non-zero", async () => {
    for (const [verifier, check] of [
      ["verify-selector.py", "hardening/selector-verifier-exit-zero"],
      ["verify-download-policy.py", "hardening/download-policy-verifier-exit-zero"],
    ]) {
      const { result } = await drive({ verifiers: { [verifier]: 1 } });
      assert.equal(result.verdict, "FAIL", `${verifier} failing must fail the run`);
      assert.equal(result.checks.find((c) => c.name === check).ok, false);
    }
  });

  // §22.20 / §22.21 — either child failing fails the top level.
  it("FAILs the top level when the mp4 or the webm child does not pass", async () => {
    for (const family of REQUIRED_SPLIT_FAMILIES) {
      const { result } = await drive({ children: { [family]: { verdict: "BLOCKED" } } });
      assert.equal(result.verdict, "FAIL", `a failed ${family} child must fail the top level`);
      assert.equal(result.checks.find((c) => c.name === `split/${family}-child-passed`).ok, false);
      assert.equal(result.record.verdict, "FAIL", "a failed child yields a FAIL parent record, never a PASS");
    }
  });

  it("FAILs when a child record is absent or of the wrong schema", async () => {
    const absent = await drive({ children: { webm: null } });
    assert.equal(absent.result.verdict, "FAIL");
    assert.match(absent.result.checks.find((c) => c.name === "split/webm-child-passed").detail, /unreadable/);

    const wrongSchema = await drive({ children: { mp4: { schema: "split06-deterministic-full-path-03" } } });
    assert.equal(wrongSchema.result.verdict, "FAIL");
    assert.match(wrongSchema.result.checks.find((c) => c.name === "split/mp4-child-passed").detail, /schema is/);
  });

  // §16 / §19 — the children must have run in the candidate, with no overlay.
  it("FAILs when a child ran in a different image, or with a network", async () => {
    const otherImage = await drive({ children: { mp4: { image: { acceptedBaseImage: "videofetch-worker:latest", acceptedBaseDigest: LATEST_ID, overlayImage: "videofetch-worker:latest", overlayImageId: LATEST_ID, deployable: false } } } });
    assert.equal(otherImage.result.checks.find((c) => c.name === "split/children-ran-in-the-candidate-image").ok, false);

    const overlaid = await drive({ children: { webm: { image: { acceptedBaseImage: "videofetch-worker:e4fa646b", acceptedBaseDigest: LATEST_ID, overlayImage: `${CANDIDATE_IMAGE_REPOSITORY}:split07-${SOURCE.slice(0, 12)}-local-test`, overlayImageId: IMAGE_ID, deployable: false } } } });
    assert.equal(overlaid.result.checks.find((c) => c.name === "split/children-ran-in-the-candidate-image").ok, false);

    const networked = await drive({ children: { mp4: { network: { mode: "bridge" } } } });
    assert.equal(networked.result.checks.find((c) => c.name === "split/children-ran-in-the-candidate-image").ok, false);

    const otherCommit = await drive({ children: { webm: { source: { commit: "d".repeat(40), tree: TREE, contextClean: true } } } });
    assert.equal(otherCommit.result.checks.find((c) => c.name === "split/children-ran-in-the-candidate-image").ok, false);
  });

  // §22.27 — a Production mutation is detected and reported.
  it("FAILs and reports a mutation when `latest` or the Worker container moved", async () => {
    const retagged = await drive({ productionAfter: { latestImageId: IMAGE_ID } });
    assert.equal(retagged.result.verdict, "FAIL");
    assert.equal(retagged.result.checks.find((c) => c.name === "production/latest-image-id-unchanged").ok, false);

    for (const mutation of [
      { containerImageId: IMAGE_ID },
      { startedAt: "2026-09-12T09:00:00.000Z" },
      { restartCount: "1" },
    ]) {
      const { result } = await drive({ productionAfter: mutation });
      assert.equal(result.verdict, "FAIL", `${JSON.stringify(mutation)} must fail`);
      assert.equal(result.checks.find((c) => c.name === "production/worker-container-unchanged").ok, false);
    }
  });

  it("runs on a machine that has never deployed, where there is no `latest`", async () => {
    const { result, error } = await drive({ production: { latestImageId: null, containerImageId: null, startedAt: null, restartCount: null } });
    assert.equal(error, null, error ? String(error.message) : undefined);
    assert.equal(result.verdict, "PASS");
    assert.equal(result.record.image.acceptedWorkerArchitecture, null);
  });

  // §22.26 — an existing evidence path is refused, never overwritten.
  it("refuses to overwrite an existing evidence artifact", async () => {
    const world = createWorld();
    const taken = {
      ...world.deps,
      readdir: async () => ["split07-release-image-1700000000000.json"],
    };
    await assert.rejects(
      runReleaseImageAcceptance(world.options, taken),
      /refusing to replace an existing evidence artifact/,
    );
  });

  // §21 / §9 — the driver never retags, never pushes, never touches a unit.
  it("issues no tag, push, systemctl, stop, restart or rm of anything but the candidate", async () => {
    const { world } = await drive();
    for (const call of world.dockerCalls) {
      const verb = call.args[0];
      assert.ok(
        ["build", "image", "run", "inspect"].includes(verb),
        `unexpected docker verb: ${call.args.join(" ")}`,
      );
      if (verb === "image") {
        assert.ok(["inspect", "rm"].includes(call.args[1]), `unexpected image subcommand: ${call.args.join(" ")}`);
        if (call.args[1] === "rm") assert.equal(call.args[2], world.tag, "only the candidate may be removed");
      }
    }
    const joined = world.dockerCalls.map((call) => call.args.join(" ")).join("\n");
    // Verbs such as `commit`/`tag`/`push` are already excluded by the verb
    // allowlist above; these are substrings no argument may carry anywhere.
    for (const forbidden of ["--privileged", "--network host", "--cap-add", "systemctl", "docker.sock"]) {
      assert.ok(!joined.includes(forbidden), `no docker command may contain ${forbidden}`);
    }
    // `latest` is read, and only ever with a read-only inspect format.
    for (const line of joined.split("\n").filter((line) => line.includes("videofetch-worker:latest"))) {
      assert.match(line, /^image inspect videofetch-worker:latest --format \{\{\.(Id|Architecture)\}\}$/);
    }
  });

  it("keeps the candidate only when explicitly asked, and never renames it", async () => {
    const { world } = await drive({}, { keepImage: true });
    assert.ok(!world.dockerCalls.some((call) => call.args[0] === "image" && call.args[1] === "rm"));
  });
});

// ── 5. CORRECTION C — the immutable run subject ─────────────────────────────

describe("SPLIT-07 immutable run subjects (container model)", () => {
  const harnessDir = `${HARNESS}/deploy/acceptance/ytdlp-generic`;
  const builders = [
    ["probe", (imageId) => probeRunArgs({ imageId, harnessDir, mode: "runtime" })],
    ["selector verifier", (imageId) => policyVerifierRunArgs({ imageId, harnessDir, verifier: "verify-selector.py" })],
    ["download-policy verifier", (imageId) => policyVerifierRunArgs({ imageId, harnessDir, verifier: "verify-download-policy.py" })],
    ["mp4 acceptance", (imageId) => releaseAcceptanceRunArgs({ imageId, family: "mp4", harnessDir, reportDir: REPORT, evidenceName: "a.json" })],
    ["webm acceptance", (imageId) => releaseAcceptanceRunArgs({ imageId, family: "webm", harnessDir, reportDir: REPORT, evidenceName: "b.json" })],
  ];
  const notIds = [
    TAG, "videofetch-worker:latest", "latest", "sha256:ea08b43366ee", IMAGE_ID.slice("sha256:".length),
    `sha256:${"A".repeat(64)}`, `SHA256:${"a".repeat(64)}`, `sha256:${"a".repeat(63)}`, `sha256:${"a".repeat(65)}`, "",
  ];

  it("accepts exactly a full, lowercase sha256 image ID", () => {
    assert.ok(IMAGE_ID_PATTERN.test(IMAGE_ID));
    assert.equal(assertImmutableImageId(IMAGE_ID), IMAGE_ID);
    for (const bad of [...notIds, null, undefined]) {
      assert.throws(() => assertImmutableImageId(bad), /not an immutable image ID/, `${String(bad)} must be refused`);
    }
  });

  it("makes the immutable ID the run subject of every candidate container", () => {
    for (const [label, build] of builders) {
      const args = build(IMAGE_ID);
      assert.equal(dockerRunSubject(args), IMAGE_ID, `${label} must execute the id`);
      assert.ok(!args.includes(TAG), `${label} must not name the tag anywhere`);
    }
  });

  it("refuses a tag, latest or an abbreviated id as any candidate container's subject", () => {
    for (const [label, build] of builders) {
      for (const bad of notIds) {
        assert.throws(() => build(bad), /not an immutable image ID/, `${label} must refuse ${bad}`);
      }
    }
  });

  it("keeps the TAG gates for build and cleanup, which never take an id", () => {
    assert.throws(() => releaseBuildArgs({ image: IMAGE_ID, context: CONTEXT }), /refusing a candidate outside/);
    assert.throws(() => candidateRemoveArgs(IMAGE_ID), /refusing a candidate outside/);
    assert.throws(() => candidateRemoveArgs("videofetch-worker:latest"), /refusing a deployable candidate tag/);
    assert.deepEqual(imageIdArgs(TAG), ["image", "inspect", TAG, "--format", "{{.Id}}"]);
  });

  it("parses the run subject with a closed grammar", () => {
    assert.equal(dockerRunSubject(["run", "--rm", "--network", "none", "--cap-drop=ALL", IMAGE_ID, "--x"]), IMAGE_ID);
    assert.throws(() => dockerRunSubject(["run", "--privileged", IMAGE_ID]), /unrecognized docker run option: --privileged/);
    assert.throws(() => dockerRunSubject(["run", "--rm"]), /without an image/);
    assert.throws(() => dockerRunSubject(["build", "."]), /not a docker run argv/);
  });
});

describe("SPLIT-07 immutable run subjects (driver)", () => {
  it("runs every candidate container by the inspected immutable ID, and records it from the argv", async () => {
    const { result, error, world } = await drive();
    assert.equal(error, null, error ? String(error.message) : undefined);
    const runs = world.dockerCalls.filter((call) => call.args[0] === "run");
    assert.equal(runs.length, REQUIRED_CANDIDATE_RUN_PURPOSES.length);
    for (const call of runs) assert.equal(dockerRunSubject(call.args), IMAGE_ID);
    assert.equal(world.executed.length, runs.length);
    assert.ok(world.executed.every((id) => id === IMAGE_ID));
    assert.equal(result.record.image.runSubject, IMAGE_ID);
    assert.deepEqual(
      result.record.image.candidateRuns.map((entry) => entry.purpose).sort(),
      [...REQUIRED_CANDIDATE_RUN_PURPOSES].sort(),
    );
    assert.ok(result.record.image.candidateRuns.every((entry) => entry.subject === IMAGE_ID));
    assert.equal(result.checks.find((c) => c.name === "image/every-candidate-container-ran-the-immutable-id").ok, true);
    // Each child names the build tag only as its base LABEL, and the id as the image it ran.
    for (const child of result.record.splitAcceptance.children) {
      assert.equal(child.ranImage, IMAGE_ID);
      assert.equal(child.ranImageId, IMAGE_ID);
    }
  });

  it("still executes the inspected image A after the tag is retargeted to B, and never claims A while running B", async () => {
    const { result, error, world } = await drive({
      retargetTagAfterInspect: true,
      // B would fail loudly if it ever executed.
      imageBProbes: { runtime: { ytdlp: pinnedArtifact({ sha256: "0".repeat(64) }) }, manifest: { brokerPresent: true } },
    });
    assert.equal(error, null, error ? String(error.message) : undefined);
    assert.equal(result.verdict, "PASS");
    assert.equal(result.record.image.imageId, IMAGE_ID);
    assert.ok(!world.executed.includes(IMAGE_B), "image B must never execute");
    assert.equal(world.executed.length, REQUIRED_CANDIDATE_RUN_PURPOSES.length);
    // The retargeted tag is not this run's to delete.
    assert.ok(!world.dockerCalls.some((call) => call.args[0] === "image" && call.args[1] === "rm"));
  });

  it("refuses an inspected ID that is not full and immutable, before any candidate container", async () => {
    for (const inspectId of ["sha256:ea08b43366ee", IMAGE_ID.slice("sha256:".length), "videofetch-worker:latest", `sha256:${"A".repeat(64)}`, ""]) {
      const { result, error, world } = await drive({ inspectId });
      assert.equal(result, null, `${inspectId} must be refused`);
      assert.match(String(error?.message), /image\/candidate-image-id-valid/);
      assert.equal(world.dockerCalls.filter((call) => call.args[0] === "run").length, 0);
      assert.equal(world.writeCalls.length, 0);
      assert.ok(world.dockerCalls.some((call) => call.args.join(" ") === `image rm ${world.tag}`), "the built tag is still cleaned up");
    }
  });
});

// ── 6. CORRECTION B — harness provenance ────────────────────────────────────

describe("SPLIT-07 harness provenance (gate)", () => {
  async function verifyHarness(spec = {}, expected = {}) {
    const world = createWorld(spec);
    const git = (args, options = {}) => world.deps.run("git", ["--no-optional-locks", "-C", HARNESS, ...args], options);
    return verifyHarnessProvenance({
      git,
      expectedCommit: expected.commit ?? HARNESS_COMMIT,
      expectedTree: expected.tree ?? HARNESS_TREE,
    });
  }

  it("returns OBSERVATIONS for a clean harness at the expected commit and tree", async () => {
    const observed = await verifyHarness();
    assert.equal(observed.commit, HARNESS_COMMIT);
    assert.equal(observed.tree, HARNESS_TREE);
    assert.equal(observed.contextClean, true);
    assert.equal(observed.directory, HARNESS_DIRECTORY);
    assert.equal(observed.directoryTree, HARNESS_DIR_TREE);
    assert.equal(observed.driverPath, HARNESS_DRIVER_PATH);
    assert.equal(observed.driverObject, DRIVER_OBJECT);
  });

  for (const [label, spec, expected, pattern] of [
    ["a wrong expected commit", {}, { commit: "6".repeat(40) }, /harness's HEAD is 1111.*not the expected 6666/],
    ["a wrong expected tree", {}, { tree: "7".repeat(40) }, /has tree 2222.*not the expected 7777/],
    ["a modified file", { harnessChange: { after: "start", kind: "modified" } }, {}, /the harness is not clean/],
    ["a staged change", { harnessChange: { after: "start", kind: "staged" } }, {}, /the harness has staged changes/],
    ["an untracked file", { harnessChange: { after: "start", kind: "untracked" } }, {}, /the harness is not clean/],
    ["ignored content", { harnessChange: { after: "start", kind: "ignored" } }, {}, /the harness holds content Git does not track/],
    ["a skip-worktree entry", { harnessChange: { after: "start", kind: "hidden" } }, {}, /in the harness are marked assume-unchanged or skip-worktree/],
    ["a directory that is not a worktree", { harnessGit: { "rev-parse --is-inside-work-tree": { code: 128, stdout: "" } } }, {}, /the harness is not inside a Git worktree/],
    ["a subdirectory of a worktree", { harnessGit: { "rev-parse --show-prefix": { code: 0, stdout: "deploy/\n" } } }, {}, /the harness is a subdirectory/],
    ["a commit without the harness directory", { harnessGit: { [`rev-parse --verify --quiet ${HARNESS_COMMIT}:${HARNESS_DIRECTORY}`]: { code: 1, stdout: "" } } }, {}, /carries no deploy\/acceptance\/ytdlp-generic$/],
    ["a commit without the driver", { harnessGit: { [`rev-parse --verify --quiet ${HARNESS_COMMIT}:${HARNESS_DRIVER_PATH}`]: { code: 1, stdout: "" } } }, {}, /carries no .*run-release-image-acceptance\.mjs/],
  ]) {
    it(`refuses ${label}`, async () => {
      await assert.rejects(
        verifyHarness(spec, expected),
        (error) => error instanceof ReleaseProvenanceError && pattern.test(error.message),
      );
    });
  }

  it("refuses abbreviated harness expectations outright", async () => {
    await assert.rejects(verifyHarness({}, { commit: "1111111" }), /--harness-source must be a full lowercase 40-hex SHA/);
    await assert.rejects(verifyHarness({}, { tree: "A".repeat(40) }), /--harness-tree must be a full lowercase 40-hex SHA/);
  });
});

describe("SPLIT-07 harness provenance (driver)", () => {
  for (const [label, spec, optionOverrides] of [
    ["a wrong expected harness commit", {}, { harnessSource: "6".repeat(40) }],
    ["a wrong expected harness tree", {}, { harnessTree: "7".repeat(40) }],
    ["a dirty harness", { harnessChange: { after: "start", kind: "modified" } }, {}],
    ["a staged harness modification", { harnessChange: { after: "start", kind: "staged" } }, {}],
    ["an untracked harness file", { harnessChange: { after: "start", kind: "untracked" } }, {}],
    ["ignored content in the harness", { harnessChange: { after: "start", kind: "ignored" } }, {}],
    ["a harness entry hidden by skip-worktree", { harnessChange: { after: "start", kind: "hidden" } }, {}],
  ]) {
    it(`starts NO docker command for ${label}`, async () => {
      const { result, error, world } = await drive(spec, optionOverrides);
      assert.equal(result, null);
      assert.ok(error instanceof ReleaseProvenanceError, `expected a provenance refusal, got ${String(error)}`);
      assert.deepEqual(world.dockerCalls, [], "no docker command may run before the harness is verified");
      assert.equal(world.writeCalls.length, 0);
    });
  }

  it("starts NO docker command when the executing driver is not the verified harness's own", async () => {
    const { result, error, world } = await drive({}, {}, { driverPath: "/elsewhere/run-release-image-acceptance.mjs" });
    assert.equal(result, null);
    assert.ok(error instanceof ReleaseProvenanceError);
    assert.match(error.message, /is not the verified harness's own/);
    assert.deepEqual(world.dockerCalls, []);
  });

  it("accepts a clean, exact harness and records it, verified at every checkpoint", async () => {
    const { result, error } = await drive();
    assert.equal(error, null, error ? String(error.message) : undefined);
    assert.equal(result.verdict, "PASS");
    const harness = result.record.harness;
    assert.equal(harness.commit, HARNESS_COMMIT);
    assert.equal(harness.tree, HARNESS_TREE);
    assert.equal(harness.directoryTree, HARNESS_DIR_TREE);
    assert.equal(harness.driverObject, DRIVER_OBJECT);
    assert.equal(harness.contextClean, true);
    assert.equal(harness.verifiedBeforeRun, true);
    assert.equal(harness.verifiedAfterRun, true);
    assert.deepEqual(harness.verificationPoints, HARNESS_POINTS);
    assert.equal(harness.driverInsideHarness, true);
    assert.equal(harness.worktreeIsReleaseContext, false);
    assert.equal(harness.commitIsReleaseSource, false);
    for (const name of ["harness/verified-before-execution", "harness/driver-is-inside-the-verified-harness", "harness/unchanged-after-execution"]) {
      assert.equal(result.checks.find((c) => c.name === name)?.ok, true, name);
    }
  });

  it("refuses the record when the harness changes after the build, before any candidate container", async () => {
    const { result, error, world } = await drive({ harnessChange: { after: "build", kind: "modified" } });
    assert.equal(result, null);
    assert.match(String(error?.message), /acceptance harness changed during the run \(after-build\)/);
    assert.equal(world.dockerCalls.filter((c) => c.args[0] === "run").length, 0);
    assert.equal(world.writeCalls.length, 0);
    assert.ok(world.dockerCalls.some((c) => c.args.join(" ") === `image rm ${world.tag}`), "the candidate is still cleaned up");
  });

  it("refuses the record when the harness changes between the two children", async () => {
    const { result, error, world } = await drive({ harnessChange: { after: "split06:mp4", kind: "untracked" } });
    assert.equal(result, null);
    assert.match(String(error?.message), /\(before-split06-webm\)/);
    const families = world.dockerCalls.filter((c) => c.args.includes("--family")).map((c) => c.args[c.args.indexOf("--family") + 1]);
    assert.deepEqual(families, ["mp4"], "the webm child must never run on a changed harness");
    assert.equal(world.writeCalls.length, 0, "no parent evidence may be written");
  });

  it("refuses the record when the harness changes while the last child runs", async () => {
    for (const kind of ["modified", "staged", "ignored", "hidden", "moved"]) {
      const { result, error, world } = await drive({ harnessChange: { after: "split06:webm", kind } });
      assert.equal(result, null, `${kind} must be refused`);
      assert.match(String(error?.message), /\(after-children\)/);
      assert.equal(world.writeCalls.length, 0, "no parent evidence may be written");
    }
  });

  it("records the topology when one checkout at one commit serves both roles", async () => {
    const { result, error } = await drive(
      {},
      { harness: CONTEXT, harnessSource: SOURCE, harnessTree: TREE },
      { driverPath: `${CONTEXT}/${HARNESS_DRIVER_PATH}` },
    );
    assert.equal(error, null, error ? String(error.message) : undefined);
    assert.equal(result.verdict, "PASS");
    assert.equal(result.record.harness.worktreeIsReleaseContext, true);
    assert.equal(result.record.harness.commitIsReleaseSource, true);
  });
});

// ── 7. CORRECTION A — the parent record is created exclusively ─────────────

describe("SPLIT-07 parent evidence is created exclusively", () => {
  const PRIOR = Buffer.from('{"prior":"record"}\n', "utf8");

  it("creates the parent with an exclusive (wx) utf8 write", async () => {
    const { result, world } = await drive();
    assert.equal(result.verdict, "PASS");
    const writes = world.writeCalls.filter((call) => call.path === PARENT);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].options, { encoding: "utf8", flag: "wx" });
    assert.equal(JSON.parse(world.files.get(PARENT).toString("utf8")).schema, SPLIT07_EVIDENCE_SCHEMA);
  });

  // A1 — the path already exists.
  it("A1: refuses a path that already exists — early, before any Docker command — leaving it untouched", async () => {
    const { result, error, world } = await drive({ files: [[PARENT, PRIOR]] });
    assert.equal(result, null);
    assert.match(String(error?.message), /refusing to replace an existing evidence artifact/);
    assert.ok(world.files.get(PARENT).equals(PRIOR), "the existing bytes must be unchanged");
    assert.equal(world.writeCalls.length, 0);
    assert.deepEqual(world.dockerCalls, [], "an occupied path is diagnosed before the build");
  });

  it("A1: with the pre-flight blind, the exclusive create itself refuses and leaves the file untouched", async () => {
    const { result, error, world } = await drive({ files: [[PARENT, PRIOR]] }, {}, { readdir: async () => [] });
    assert.equal(result, null);
    assert.match(String(error?.message), /refusing to claim a split07-release-image-candidate-02 verdict/);
    assert.ok(world.files.get(PARENT).equals(PRIOR), "the existing bytes must be unchanged");
    assert.deepEqual(world.writeCalls.map((call) => call.options), [{ encoding: "utf8", flag: "wx" }]);
  });

  // A2 — another actor creates the path between the pre-flight and the write.
  it("A2: loses a race after the pre-flight without truncating the winner or claiming a PASS", async () => {
    const competitor = '{"competing":"invocation"}\n';
    const lines = [];
    const { result, error, world } = await drive({ competitorAtWrite: competitor }, {}, { log: (line) => lines.push(line) });
    assert.equal(result, null, "a lost race returns no result, and so no PASS");
    assert.match(String(error?.message), /refusing to claim a split07-release-image-candidate-02 verdict/);
    assert.match(String(error?.message), /has NOT been modified/);
    assert.equal(world.files.get(PARENT).toString("utf8"), competitor, "the competing record must be byte-identical");
    assert.deepEqual(
      world.writeCalls.filter((call) => call.path === PARENT).map((call) => call.options),
      [{ encoding: "utf8", flag: "wx" }],
    );
    assert.ok(!lines.some((line) => /PASS: /.test(line)), "no PASS may be announced");
  });

  it("A2 on the real filesystem: an exclusive create refuses a file that appeared after the pre-flight", async () => {
    const dir = await mkdtemp(join(tmpdir(), "split07-wx-"));
    try {
      const target = join(dir, "split07-release-image-1700000000000.json");
      await writeFileFs(target, "competitor\n");
      const world = createWorld();
      // The pre-flight is blinded, so only the kernel's O_EXCL stands between
      // this run and the existing file. `writeFile` is the REAL one.
      const deps = { ...world.deps, readdir: async () => [], writeFile: undefined };
      await assert.rejects(runReleaseImageAcceptance({ ...world.options, report: dir }, deps), /refusing to claim/);
      assert.equal(await readFileFs(target, "utf8"), "competitor\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── 8. The -02 evidence gates ───────────────────────────────────────────────

describe("SPLIT-07 -02 evidence gates", () => {
  it("refuses a PASS whose candidate containers did not all execute the immutable ID", () => {
    const tagged = evidenceInput();
    tagged.image.candidateRuns = tagged.image.candidateRuns.map((entry, i) => (i === 3 ? { ...entry, subject: TAG } : entry));
    assert.throws(() => buildReleaseEvidence(tagged), /did not all execute the immutable image ID/);

    const missing = evidenceInput();
    missing.image.candidateRuns = missing.image.candidateRuns.filter((entry) => entry.purpose !== "split06:webm");
    assert.throws(() => buildReleaseEvidence(missing), /did not all execute the immutable image ID/);

    const extra = evidenceInput();
    extra.image.candidateRuns = [...extra.image.candidateRuns, { purpose: "probe:extra", subject: IMAGE_ID }];
    assert.throws(() => buildReleaseEvidence(extra), /did not all execute the immutable image ID/);

    assert.throws(() => buildReleaseEvidence(evidenceInput({ image: { runSubject: IMAGE_B } })), /did not all execute the immutable image ID/);
    assert.throws(
      () => buildReleaseEvidence(evidenceInput({ image: { imageId: "sha256:ea08b43366ee", runSubject: "sha256:ea08b43366ee" } })),
      /without a valid immutable image ID/,
    );
  });

  it("refuses ANY record — PASS or FAIL — without harness provenance verified before and after", () => {
    for (const mutation of [
      { verifiedBeforeRun: false }, { verifiedAfterRun: false }, { driverInsideHarness: false },
      { contextClean: false }, { commit: "1111111" }, { tree: null }, { directoryTree: "x" }, { driverObject: null },
      { directory: "deploy" }, { driverPath: "run.mjs" },
      { worktreeIsReleaseContext: "no" }, { commitIsReleaseSource: undefined },
      { verificationPoints: ["before-docker"] }, { verificationPoints: ["after-build", "after-children"] },
    ]) {
      for (const verdict of ["PASS", "FAIL"]) {
        const input = evidenceInput({ verdict });
        Object.assign(input.harness, mutation);
        assert.throws(
          () => buildReleaseEvidence(input),
          /without driver-verified harness provenance/,
          `${verdict} ${JSON.stringify(mutation)} must be refused`,
        );
      }
    }
    const absent = evidenceInput();
    delete absent.harness;
    assert.throws(() => buildReleaseEvidence(absent), /without driver-verified harness provenance/);
  });

  it("records the observed harness topology, whatever it is", () => {
    const record = buildReleaseEvidence(evidenceInput({ harness: { worktreeIsReleaseContext: true, commitIsReleaseSource: true } }));
    assert.equal(record.harness.worktreeIsReleaseContext, true);
    assert.equal(record.harness.commitIsReleaseSource, true);
  });

  it("treats -01 as historical: the builder emits only -02", () => {
    assert.equal(buildReleaseEvidence(evidenceInput()).schema, "split07-release-image-candidate-02");
    assert.notEqual(SPLIT07_EVIDENCE_SCHEMA, "split07-release-image-candidate-01");
  });
});
