// The SPLIT-06 container model: the overlay image, and the acceptance run.
//
// Pure argv construction, so the properties that matter — `--network none`, a
// non-deployable tag, no credential, no bind mount of anything but the report
// directory — are pinned by tests that spawn nothing.
//
// ── Why an OVERLAY image rather than a rebuild ─────────────────────────────
//
// The accepted Worker image already contains the exact pinned yt-dlp runtime
// and the exact accepted FFmpeg/ffprobe. SPLIT-01..05 changed application
// source only: `package.json`, `package-lock.json`, `Dockerfile.worker`, the
// pinned runtime module and the alias loader are byte-identical between the
// accepted image's source commit and the SPLIT-06 candidate. That premise is
// not assumed: `lib/split-provenance.mjs` checks it as Git objects on every run,
// and the driver refuses to build the overlay when it no longer holds.
// Rebuilding Bookworm packages to test a source change would introduce
// unrelated runtime drift into the one run that is supposed to isolate the
// source.
//
// ── Why the overlay is NOT a release artifact ──────────────────────────────
//
// It carries an unmistakably local tag, is never pushed, never retagged
// `latest`, never enters a systemd unit, and never serves a Production job. It
// also carries the acceptance harness itself, which a release image must not.
// Building it is authorized for SPLIT-06 alone; the release-image build is a
// separate, later, separately authorized stage.

/** The one repository name the overlay may use. */
export const OVERLAY_IMAGE_REPOSITORY = "videofetch-worker";

/**
 * Tags this harness refuses to produce, because each one is load-bearing
 * somewhere a deployment reads it.
 */
export const FORBIDDEN_OVERLAY_TAGS = Object.freeze(["latest", "stable", "production", "current"]);

/**
 * The ONLY repository paths the overlay copies from the build context; every
 * other file in the image is the accepted image's own. The provenance gate
 * reads this same list, so what is verified clean is exactly what is copied.
 */
export const OVERLAY_COPIED_PATHS = Object.freeze(["src", "deploy/acceptance/ytdlp-generic"]);

/**
 * The overlay tag for one candidate head.
 *
 * `-local-test` is not decoration: it is the string an operator greps for
 * before wondering whether an image on this machine is deployable.
 */
export function overlayImageTag(headSha) {
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("the overlay tag needs the full candidate head SHA");
  }
  const tag = `split06-${headSha.slice(0, 12)}-local-test`;
  if (FORBIDDEN_OVERLAY_TAGS.includes(tag)) throw new Error("refusing a deployable overlay tag");
  return `${OVERLAY_IMAGE_REPOSITORY}:${tag}`;
}

/**
 * The overlay Dockerfile.
 *
 * `--chown=node:node` mirrors the base image's ownership, and `src/broker` is
 * removed exactly as `Dockerfile.worker` removes it: the media container must
 * contain no code that knows how to mint from the R2 parent secret, and a test
 * image that quietly reinstated it would be a worse container than the one it
 * is standing in for.
 */
export function overlayDockerfile(baseImage) {
  if (typeof baseImage !== "string" || !baseImage.includes(":")) {
    throw new Error("the overlay needs an exact base image reference");
  }
  return [
    "# SPLIT-06 acceptance overlay. NOT A DEPLOYMENT ARTIFACT.",
    "#",
    "# Replaces /app/src with the exact candidate source and adds the",
    "# deterministic acceptance harness. Everything else — the pinned yt-dlp",
    "# artifact, ffmpeg/ffprobe, the production dependency graph, the runtime",
    "# user and the environment — is inherited from the accepted image.",
    `FROM ${baseImage}`,
    "USER root",
    ...OVERLAY_COPIED_PATHS.map((path) => `COPY --chown=node:node ${path} /app/${path}`),
    "# The trusted R2 credential broker is NOT part of the media container.",
    "RUN rm -rf /app/src/broker",
    "USER node",
    "",
  ].join("\n");
}

/** `docker build` argv for the overlay. The context is the repository root. */
export function overlayBuildArgs({ image, dockerfile, context }) {
  return ["build", "-f", dockerfile, "-t", image, context];
}

/**
 * The acceptance `docker run` argv.
 *
 * `--network none` is MANDATORY and is asserted by its own test. It leaves the
 * container with a loopback interface and nothing else: the fixture service
 * binds `127.0.0.1` inside this namespace, and no DNS, no public address, no
 * proxy and no host service is reachable. A run that lost this flag would be
 * running against whatever the machine happens to be able to reach.
 */
export function acceptanceRunArgs({ image, family, reportDir, containerReportDir = "/report", evidenceName }) {
  if (typeof image !== "string" || image.length === 0) throw new Error("an image is required");
  if (family !== "mp4" && family !== "webm") throw new Error("family must be mp4 or webm");
  if (typeof reportDir !== "string" || !reportDir.startsWith("/")) {
    throw new Error("the report directory must be an absolute host path");
  }
  if (typeof evidenceName !== "string" || !/^[A-Za-z0-9._-]+$/.test(evidenceName)) {
    throw new Error("the evidence filename must be a plain basename");
  }
  return [
    "run",
    "--rm",
    // The single most important flag in this file.
    "--network",
    "none",
    // The ONLY bind mount: where the run writes its own evidence. No source
    // tree, no socket, no credential file, no Docker socket.
    "-v",
    `${reportDir}:${containerReportDir}`,
    "-w",
    "/app",
    "--entrypoint",
    "/usr/local/bin/node",
    image,
    "--import",
    "./scripts/register-ts-aliases.mjs",
    "--experimental-strip-types",
    "deploy/acceptance/ytdlp-generic/split-full-path.mjs",
    "--family",
    family,
    "--evidence",
    `${containerReportDir}/${evidenceName}`,
  ];
}
