// The HLS-08 container model: the non-deployable overlay image, and the
// isolated acceptance run.
//
// Pure argv construction, so every property that matters is pinned by tests
// that spawn nothing:
//
//   - the overlay is FROM the exact accepted Worker image and copies exactly
//     the paths SPLIT-06 copies — `OVERLAY_COPIED_PATHS` is imported, never
//     restated, so the provenance gate verifies clean exactly what is copied;
//   - the trusted R2 broker code is removed, as `Dockerfile.worker` removes it;
//   - the tag is unmistakably local and never a deployable spelling;
//   - the run is `--network none`, `--rm`, carries exactly ONE acceptance-only
//     host mapping, runs the IMMUTABLE overlay image id, inherits the image's
//     non-root `node` user, and bind-mounts exactly one directory: the report
//     directory it writes its own evidence into.
//
// Why an overlay rather than a rebuild, and why it is not a release artifact:
// see `lib/split-container.mjs`. The same premise is re-checked on every run by
// `lib/split-provenance.mjs`; HLS-08 changes nothing about it.
//
// Plain ESM whose only imports are two import-free harness modules, so the host
// driver runs it on the VM's Node 18.

import {
  FORBIDDEN_OVERLAY_TAGS,
  OVERLAY_COPIED_PATHS,
  OVERLAY_IMAGE_REPOSITORY,
} from "./split-container.mjs";
import { HLS_FIXTURE_HOSTNAME, HLS_FIXTURE_LOOPBACK } from "./hls-fixture-url.mjs";

/**
 * The accepted Worker runtime HLS-08 must run against, as the repository
 * runbook records it. The driver refuses any other base: HLS-08 qualifies the
 * candidate SOURCE against THIS runtime, and a run on a different base would be
 * a different claim. Changing these is a reviewed change, never a flag.
 */
export const HLS08_ACCEPTED_BASE = Object.freeze({
  sourceCommit: "593f47dfffe79f166d40af6575c6130668e56af0",
  imageDigest: "sha256:5925515fb002cd7203228325e1d30fd5987eafde3043ca1663162b9fe04df21e",
  retainedTag: "videofetch-worker:rc-593f47dfffe7-5925515fb002",
  ytdlpVersion: "2026.08.19",
});

/** The copied paths: SPLIT-06's authority, re-exported rather than restated. */
export const HLS08_OVERLAY_COPIED_PATHS = OVERLAY_COPIED_PATHS;

/** The ONE acceptance-only `/etc/hosts` entry, for the pinned yt-dlp subprocess. */
export const HLS08_FIXTURE_HOST_MAPPING = `${HLS_FIXTURE_HOSTNAME}:${HLS_FIXTURE_LOOPBACK}`;

/** Where the container writes its evidence; the only bind-mount target. */
export const HLS08_CONTAINER_REPORT_DIR = "/report";

/** The in-image orchestrator the run executes. */
export const HLS08_ORCHESTRATOR = "deploy/acceptance/ytdlp-generic/hls-full-path.mjs";

/**
 * The orchestrator's explicit acceptance MODE. Every invocation names exactly
 * one, and the orchestrator never infers it from which identity flags happen
 * to be present (`lib/hls-acceptance-mode.mjs`):
 *
 *   overlay        HLS-08: the candidate source overlaid on the accepted
 *                  historical runtime; emits `hls08-deterministic-full-path-02`.
 *   release-image  HLS-09: the real `Dockerfile.worker` release candidate,
 *                  launched by the SPLIT-07 parent; emits
 *                  `hls09-release-image-full-path-01`.
 */
export const HLS_ACCEPTANCE_MODE_FLAG = "--acceptance-mode";
export const HLS_ACCEPTANCE_MODES = Object.freeze({
  overlay: "overlay",
  releaseImage: "release-image",
});

const FULL_SHA = /^[0-9a-f]{40}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The non-deployable overlay tag for one candidate head. */
export function hlsOverlayImageTag(headSha) {
  if (typeof headSha !== "string" || !FULL_SHA.test(headSha)) {
    throw new Error("the overlay tag needs the full candidate head SHA");
  }
  return assertNonDeployableTag(`${OVERLAY_IMAGE_REPOSITORY}:hls08-${headSha.slice(0, 12)}-local-test`);
}

/**
 * Refuses a reference whose tag is deployable. Exported so the same rule the
 * builder applies can be applied to anything an operator passes in.
 */
export function assertNonDeployableTag(reference) {
  if (typeof reference !== "string") throw new Error("an image reference is required");
  const colon = reference.lastIndexOf(":");
  const tag = colon > reference.lastIndexOf("/") ? reference.slice(colon + 1) : "latest";
  if (FORBIDDEN_OVERLAY_TAGS.includes(tag.toLowerCase())) {
    throw new Error(`refusing a deployable overlay tag: ${tag}`);
  }
  if (!tag.endsWith("-local-test")) throw new Error("the overlay tag must end in -local-test");
  if (!reference.startsWith(`${OVERLAY_IMAGE_REPOSITORY}:hls08-`)) {
    throw new Error("the overlay must be an hls08 videofetch-worker test image");
  }
  return reference;
}

/**
 * The overlay Dockerfile. `--chown=node:node` mirrors the base image, and the
 * broker is removed exactly as `Dockerfile.worker` removes it.
 */
export function hlsOverlayDockerfile(baseImage) {
  if (typeof baseImage !== "string" || !baseImage.includes(":")) {
    throw new Error("the overlay needs an exact base image reference");
  }
  return [
    "# HLS-08 acceptance overlay. NOT A DEPLOYMENT ARTIFACT.",
    "#",
    "# Replaces /app/src with the exact candidate source and adds the",
    "# deterministic acceptance harness. Everything else — the pinned yt-dlp",
    "# artifact, ffmpeg/ffprobe, the production dependency graph, the Node",
    "# runtime, the runtime user and the environment — is the accepted image's.",
    `FROM ${baseImage}`,
    "USER root",
    ...HLS08_OVERLAY_COPIED_PATHS.map((path) => `COPY --chown=node:node ${path} /app/${path}`),
    "# The trusted R2 credential broker is NOT part of the media container.",
    "RUN rm -rf /app/src/broker",
    "USER node",
    "",
  ].join("\n");
}

/** `docker build` argv for the overlay. The context is the repository root. */
export function hlsOverlayBuildArgs({ image, dockerfile, context }) {
  assertNonDeployableTag(image);
  if (typeof dockerfile !== "string" || typeof context !== "string") {
    throw new Error("the overlay build needs a Dockerfile and a context");
  }
  return ["build", "-f", dockerfile, "-t", image, context];
}

/**
 * The acceptance `docker run` argv.
 *
 * Every provenance value is an OBSERVATION the driver made; this function only
 * places them.
 */
export function hlsAcceptanceRunArgs({ imageId, reportDir, evidenceName, provenance, image }) {
  if (typeof imageId !== "string" || !IMAGE_ID.test(imageId)) {
    throw new Error("the acceptance run must name the immutable overlay image id");
  }
  if (typeof reportDir !== "string" || !reportDir.startsWith("/") || reportDir.includes(":")) {
    throw new Error("the report directory must be an absolute host path");
  }
  if (typeof evidenceName !== "string" || !/^[A-Za-z0-9._-]+$/.test(evidenceName)) {
    throw new Error("the evidence filename must be a plain basename");
  }
  assertNonDeployableTag(image);
  const p = provenance ?? {};
  for (const key of ["commit", "tree", "acceptedBaseSourceCommit"]) {
    if (!FULL_SHA.test(String(p[key]))) throw new Error(`provenance ${key} must be a full SHA`);
  }
  if (p.contextClean !== true || p.overlayRuntimeCompatibilityVerified !== true) {
    throw new Error("the build context was not verified clean and runtime-compatible");
  }
  if (!IMAGE_ID.test(String(p.baseDigest))) throw new Error("provenance baseDigest must be an image id");
  if (typeof p.baseImage !== "string" || p.baseImage.length === 0) {
    throw new Error("provenance baseImage is required");
  }

  return [
    "run",
    "--rm",
    // Never pull: the run tests what is on this machine, by id.
    "--pull",
    "never",
    // Loopback and nothing else.
    "--network",
    "none",
    // The ONE acceptance-only name mapping, for the pinned yt-dlp subprocess.
    "--add-host",
    HLS08_FIXTURE_HOST_MAPPING,
    // The ONLY bind mount.
    "-v",
    `${reportDir}:${HLS08_CONTAINER_REPORT_DIR}`,
    "-w",
    "/app",
    "--entrypoint",
    "/usr/local/bin/node",
    imageId,
    "--import",
    "./scripts/register-ts-aliases.mjs",
    "--experimental-strip-types",
    HLS08_ORCHESTRATOR,
    HLS_ACCEPTANCE_MODE_FLAG,
    HLS_ACCEPTANCE_MODES.overlay,
    "--evidence",
    `${HLS08_CONTAINER_REPORT_DIR}/${evidenceName}`,
    "--source-commit",
    p.commit,
    "--source-tree",
    p.tree,
    "--accepted-base-source",
    p.acceptedBaseSourceCommit,
    "--source-context-clean",
    "--overlay-runtime-compatible",
    "--base-image",
    p.baseImage,
    "--base-digest",
    p.baseDigest,
    "--overlay-image",
    image,
    "--overlay-image-id",
    imageId,
  ];
}

/**
 * The ONLY docker-run options the model uses, with whether each takes a value.
 * Anything else — including every option that could widen the container
 * (`--privileged`, `--mount`, `--env*`, `--user`, `--cap-add`, `-p`, ...) — is
 * a violation by construction, so the list cannot fall behind Docker.
 */
const ALLOWED_RUN_OPTIONS = Object.freeze({
  "--rm": false,
  "--pull": true,
  "--network": true,
  "--add-host": true,
  "-v": true,
  "-w": true,
  "--entrypoint": true,
});

/**
 * The run posture, re-derived STRUCTURALLY from an argv. Pure; returns the
 * violations (empty when the argv is exactly the model). The driver applies it
 * to the argv it is about to execute, and the self-tests to mutated argv.
 *
 * The docker options are parsed left to right until the first positional
 * token, which is the image and must be an immutable id: an argv that names a
 * tag, or hides an option behind an unknown spelling, is refused.
 */
export function hlsRunPostureViolations(args, { reportDir }) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const violations = [];
  if (argv[0] !== "run") violations.push("not a docker run");

  const options = [];
  let i = 1;
  while (i < argv.length && argv[i].startsWith("-")) {
    const raw = argv[i];
    const eq = raw.indexOf("=");
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    if (!Object.hasOwn(ALLOWED_RUN_OPTIONS, name)) {
      violations.push(`option outside the model: ${name}`);
      i += 1;
      continue;
    }
    if (ALLOWED_RUN_OPTIONS[name]) {
      if (eq > 0) {
        options.push([name, raw.slice(eq + 1)]);
        i += 1;
      } else {
        options.push([name, argv[i + 1]]);
        i += 2;
      }
    } else {
      options.push([name, null]);
      i += 1;
    }
  }
  const image = argv[i];
  if (typeof image !== "string" || !IMAGE_ID.test(image)) {
    violations.push("the run must name the immutable image id");
  }

  const values = (name) => options.filter(([n]) => n === name).map(([, v]) => v);
  const exactlyOnce = (name, expected, message) => {
    const found = values(name);
    if (found.length !== 1 || found[0] !== expected) violations.push(message);
  };
  if (values("--rm").length !== 1) violations.push("--rm missing");
  exactlyOnce("--network", "none", "--network none missing or overridden");
  exactlyOnce("--add-host", HLS08_FIXTURE_HOST_MAPPING, "exactly one --add-host with the fixture mapping is required");
  exactlyOnce("-v", `${reportDir}:${HLS08_CONTAINER_REPORT_DIR}`, "exactly one bind mount, the report directory, is allowed");
  exactlyOnce("--pull", "never", "--pull never missing");
  exactlyOnce("-w", "/app", "the working directory must be /app");
  exactlyOnce("--entrypoint", "/usr/local/bin/node", "the entrypoint must be the image's node");

  if (argv.some((a) => /docker\.sock|containerd\.sock|videofetch-r2-broker|worker\.env|\/etc\/videofetch|\/var\/lib\/videofetch|cloudflared|\.aws|\.config\/gcloud|\.ssh|\.vercel/.test(a))) {
    violations.push("a socket, credential or Production path is named");
  }
  return violations;
}
