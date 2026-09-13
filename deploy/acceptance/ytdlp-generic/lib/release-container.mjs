// The SPLIT-07 release-image container model: what is built, and how every
// candidate container is invoked.
//
// Pure argv/document construction, so the properties that matter are pinned by
// tests that spawn nothing: the real `Dockerfile.worker`, a structurally
// non-deployable tag, `--network none`, a read-only root, no capability, no
// credential, and — the property SPLIT-06's overlay could not have — NO bind
// mount that replaces product source.
//
// ── Why a REAL BUILD rather than SPLIT-06's overlay ────────────────────────
//
// SPLIT-06 deliberately overlays the already accepted Worker image with the
// candidate's `/app/src`. That isolates an application-source change from
// unrelated Bookworm/npm rebuild drift, which is exactly what SPLIT-01..05
// needed. It also means a SPLIT-06 PASS says nothing about the image a
// deployment would actually run: the overlay's runtime layers are the OLD
// image's, its `/app/src` came from a `COPY` this repository wrote for the
// test, and it carries the acceptance harness baked in.
//
// SPLIT-07 is the release-image gate, so the subject must be an image built by
// the repository's real `Dockerfile.worker` from a clean, verified Git source.
// Legitimate base/package drift is then one of the things the run absorbs or
// exposes, instead of something the test design hides.
//
// ── Why test code may be MOUNTED, and why that is not a source overlay ─────
//
// The acceptance harness deliberately does not ship in a release image, so the
// only way to execute it against that image is to mount it. That is sound
// precisely because of what is NOT mounted: `FORBIDDEN_RELEASE_MOUNT_TARGETS`
// below refuses every path that would substitute product source or runtime, and
// `assertNoForbiddenMounts` is applied to every argv this module produces. The
// harness is the observer; everything observed is the image's own.

/** The one repository name a SPLIT-07 candidate may use. */
export const CANDIDATE_IMAGE_REPOSITORY = "videofetch-worker";

/**
 * Tags this harness refuses to produce, because each one is load-bearing
 * somewhere a deployment reads it. `latest` is the accepted Production tag on
 * this machine; the other three are the names an operator or a future unit
 * would most plausibly reach for.
 */
export const FORBIDDEN_CANDIDATE_TAGS = Object.freeze(["latest", "stable", "production", "current"]);

/** The real release recipe. SPLIT-07 has no alternate Dockerfile. */
export const RELEASE_DOCKERFILE = "Dockerfile.worker";

/**
 * Container paths that must never be bind-mounted into a candidate container.
 *
 * Mounting any of these would mean the run no longer characterizes the release
 * image: the product source, the alias loader the entry point starts with, the
 * dependency graph, the installed module tree, the pinned media runtime, and
 * the interpreters/tools the chain executes would all come from the host
 * instead of from the image under test.
 */
export const FORBIDDEN_RELEASE_MOUNT_TARGETS = Object.freeze([
  "/app/src",
  "/app/scripts",
  "/app/package.json",
  "/app/package-lock.json",
  "/app/node_modules",
  "/usr/local/lib/videofetch",
  "/usr/local/lib/videofetch/yt-dlp",
  "/usr/local/bin/node",
  "/usr/bin/python3",
  "/usr/bin/ffmpeg",
  "/usr/bin/ffprobe",
]);

/**
 * The ONLY container path a SPLIT-07 run may mount repository code at, and the
 * neutral path the standalone probes use.
 *
 * `/app/deploy/acceptance/ytdlp-generic` exists because `split-full-path.mjs`
 * imports the product through `../../../src/...`: the harness must sit at its
 * own repository-relative position for those imports to resolve to the IMAGE's
 * `/app/src`. It is a leaf directory the release image does not contain, so the
 * mount adds the harness without shadowing anything.
 *
 * `/verify` is outside `/app` entirely and is used by everything that does not
 * need relative product imports — the Python policy verifiers and the image
 * probes — so those runs cannot reach into the application tree at all.
 */
export const HARNESS_MOUNT_TARGET = "/app/deploy/acceptance/ytdlp-generic";
export const VERIFY_MOUNT_TARGET = "/verify";

/** The report directory inside every candidate container. */
export const REPORT_MOUNT_TARGET = "/report";

/**
 * Hardening applied to EVERY candidate container this module launches.
 *
 * `--network none` leaves the container a loopback interface and nothing else.
 * It is what makes the run offline and deterministic; it proves nothing about
 * the Production egress namespace, which is an external host-owned boundary
 * this container could not observe even if it wanted to.
 */
export const RELEASE_HARDENING_ARGS = Object.freeze([
  "--network", "none",
  "--cap-drop=ALL",
  "--security-opt", "no-new-privileges",
]);

/**
 * The writable surfaces a hardened SPLIT-06 run is granted, and nothing else.
 *
 * `--read-only` makes the image's own root immutable for the run, which is both
 * the deployment's posture and the control that makes "the pinned runtime
 * cannot be rewritten" observable rather than asserted.
 *
 * PRODUCT media workspace has the SHAPE of the Production unit's mount
 * (`deploy/systemd/videofetch-worker.service`), and a self-test reads the unit
 * to keep it that way. Since MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001 that mount is
 * no longer a tmpfs: a 4 GiB ceiling needs an 8 GiB successful peak, which the
 * 4 GiB-RAM, swapless VM cannot hold in memory, so Production binds a bounded,
 * disk-backed ext4 workspace with `--mount type=bind,...,target=/tmp/videofetch`.
 * A candidate run binds a HOST-SUPPLIED, empty, disk-backed directory at the
 * same target in the same `--mount type=bind` form — never `-v`, which would
 * silently create a missing source — and never an 8+ GiB tmpfs. Only the source
 * differs: the harness cannot use the host's Production workspace.
 *
 * A bind over `/tmp/videofetch` shadows the node-owned directory the image
 * prepares exactly as the tmpfs did, so the host directory must be writable by
 * the image's uid 1000 — the WORKER-TEMP-TMPFS-OWNERSHIP-001 lesson, unchanged.
 * The first real SPLIT-07A run put a tmpfs on `/tmp` instead, hid
 * `/tmp/videofetch` from the product, and both families failed
 * `PROCESSING_FAILED` before upload — the gate catching exactly the
 * filesystem-layout drift it exists to catch.
 *
 * HARNESS scratch: SPLIT-06 keeps its fixtures, temporary database and object
 * sink under `mkdtemp(tmpdir())`. That is a harness need, not a product one, so
 * it gets its own tmpfs OUTSIDE every product path, and `TMPDIR` points there.
 * `/tmp` itself stays read-only, as in Production, so a product write to `/tmp`
 * outside `TEMP_DIRECTORY` still fails here exactly as it would there.
 *
 * The one ambient difference from Production is therefore `TMPDIR`. The product
 * never reads it for its own placement (`config.tempDirectory` is the image's
 * baked `TEMP_DIRECTORY`); yt-dlp receives a sealed environment whose `TMPDIR`
 * is the job's own workDir; only FFmpeg/ffprobe inherit it, for stream-copy and
 * probing, which write to explicit paths.
 *
 * Nothing in the chain executes a file it wrote: the harness scratch tmpfs is
 * `noexec`, and Production's workspace mount is `noexec` on the host (a bind
 * cannot set that itself; an operator runs this harness on a VM filesystem).
 * The pinned yt-dlp is the platform-independent zipimport artifact precisely so
 * it never unpacks itself into a temporary directory.
 */
export const PRODUCT_MEDIA_TARGET = "/tmp/videofetch";
export const HARNESS_SCRATCH_TARGET = "/acceptance-scratch";
export const HARNESS_SCRATCH_TMPFS =
  `${HARNESS_SCRATCH_TARGET}:rw,noexec,nosuid,nodev,size=512m,uid=1000,gid=1000`;

/** The environment a candidate run may add. Deliberately tiny, and non-secret. */
export const RELEASE_RUN_ENVIRONMENT = Object.freeze([`TMPDIR=${HARNESS_SCRATCH_TARGET}`]);

/**
 * The `--mount` operand binding a host-supplied Product media workspace at
 * `/tmp/videofetch`, in exactly the Production unit's `type=bind` form.
 *
 * The source is an operand of a comma-separated option list, so a comma, a
 * quote or a control character in it could smuggle an extra mount option; such
 * a path is refused rather than escaped. So is anything that is not a clean
 * absolute path below `/`.
 */
export function productMediaWorkspaceMount(hostDirectory) {
  requireAbsoluteHostPath("the Product media workspace", hostDirectory);
  if (
    hostDirectory.replace(/\/+$/, "") === "" ||
    // eslint-disable-next-line no-control-regex
    /[,"'\u0000-\u001F\u007F]/.test(hostDirectory) ||
    hostDirectory.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      "the Product media workspace must be a clean absolute directory: not /, no relative " +
        "segment, and no comma, quote or control character",
    );
  }
  return `type=bind,source=${hostDirectory},target=${PRODUCT_MEDIA_TARGET}`;
}

/**
 * Component-aware containment, in either direction: true when `a` and `b` are
 * the same path or one lies beneath the other. Not a string prefix test —
 * `/var/tmp/split07-media` is not under `/var/tmp/split07`.
 */
export function hostPathsOverlap(a, b) {
  const parts = (p) => String(p).split("/").filter((segment) => segment.length > 0);
  const left = parts(a);
  const right = parts(b);
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  return shorter.every((segment, index) => segment === longer[index]);
}

/**
 * The candidate tag for one release source commit.
 *
 * `-local-test` is not decoration: it is the string an operator greps for
 * before wondering whether an image on this machine is deployable. SPLIT-07A
 * produces only this shape; the retained SPLIT-07B candidate is a later,
 * separately authorized artifact.
 */
export function candidateImageTag(sourceSha) {
  if (typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("the candidate tag needs the full release source commit SHA");
  }
  return assertCandidateReference(`${CANDIDATE_IMAGE_REPOSITORY}:split07-${sourceSha.slice(0, 12)}-local-test`);
}

/**
 * The one gate every candidate reference passes through.
 *
 * Exported so the driver can re-check a reference it did not mint itself, and
 * so a test can prove the refusal directly. The check is on the TAG, not on
 * the whole string, so `videofetch-worker:latest` is refused while a tag that
 * merely contains the word is not confused with it.
 */
export function assertCandidateReference(reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new Error("a candidate image reference is required");
  }
  const separator = reference.lastIndexOf(":");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`a candidate image reference must carry an explicit tag: ${reference}`);
  }
  const repository = reference.slice(0, separator);
  const tag = reference.slice(separator + 1);
  if (repository !== CANDIDATE_IMAGE_REPOSITORY) {
    throw new Error(`refusing a candidate outside ${CANDIDATE_IMAGE_REPOSITORY}: ${reference}`);
  }
  if (FORBIDDEN_CANDIDATE_TAGS.includes(tag)) {
    throw new Error(`refusing a deployable candidate tag: ${reference}`);
  }
  if (!/^split07-[0-9a-f]{12}-local-test$/.test(tag)) {
    throw new Error(`refusing a candidate tag that is not unmistakably temporary: ${reference}`);
  }
  return reference;
}

/**
 * The exact grammar of an immutable local Docker image ID.
 *
 * Since `-02` every container that CHARACTERIZES the candidate executes this,
 * never the tag. A tag is a mutable pointer: between the moment the driver
 * inspects it and the moment a probe runs, it can be retargeted, and a record
 * could then claim image A while Docker executed image B. The tag keeps its
 * other jobs — `docker build -t`, human diagnostics, cleanup — and keeps every
 * restriction `assertCandidateReference` places on it.
 *
 * Full and lowercase only. The daemon would happily run an abbreviated id, a
 * repository reference or `latest`; this harness refuses all three.
 */
export const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** The one gate every candidate RUN SUBJECT passes through. */
export function assertImmutableImageId(value) {
  if (typeof value !== "string" || !IMAGE_ID_PATTERN.test(value)) {
    throw new Error(`refusing a candidate run subject that is not an immutable image ID: ${String(value)}`);
  }
  return value;
}

/**
 * `docker build` argv for the actual release image.
 *
 * The Dockerfile is ALWAYS the repository's real `Dockerfile.worker`, resolved
 * inside the verified build context, and the context is that same directory.
 * There is no build arg, no `--secret`, no `--network host` and no
 * `--build-context`: the recipe must obtain its normal pinned inputs over
 * ordinary build networking, and nothing else may enter the image.
 */
export function releaseBuildArgs({ image, context }) {
  assertCandidateReference(image);
  if (typeof context !== "string" || !context.startsWith("/")) {
    throw new Error("the release build context must be an absolute path");
  }
  return ["build", "-f", `${context}/${RELEASE_DOCKERFILE}`, "-t", image, context];
}

/**
 * Refuses any argv that would mount over product source or runtime.
 *
 * Applied to every argv this module returns, so the prohibition is a property
 * of the module rather than a convention its callers are trusted to follow. It
 * reads `-v`/`--volume`/`--mount`/`--tmpfs` operands and compares the TARGET
 * path, which is the half that decides what gets shadowed — an empty tmpfs
 * over `/app/src` replaces product source just as surely as a bind would.
 */
export function assertNoForbiddenMounts(args) {
  for (const target of mountTargets(args)) {
    for (const forbidden of FORBIDDEN_RELEASE_MOUNT_TARGETS) {
      if (target === forbidden || target.startsWith(`${forbidden}/`)) {
        throw new Error(`refusing to mount over the candidate image's own ${forbidden}`);
      }
    }
  }
  return args;
}

/** Every bind, mount and tmpfs TARGET path in a `docker run` argv, in order. */
export function mountTargets(args) {
  const targets = [];
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === "-v" || arg === "--volume") {
      targets.push(volumeTarget(list[i + 1]));
      i += 1;
      continue;
    }
    if (arg === "--mount") {
      targets.push(mountOptionTarget(list[i + 1]));
      i += 1;
      continue;
    }
    if (arg === "--tmpfs") {
      targets.push(tmpfsTarget(list[i + 1]));
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--tmpfs=")) {
      targets.push(tmpfsTarget(arg.slice("--tmpfs=".length)));
      continue;
    }
    if (typeof arg === "string" && (arg.startsWith("--volume=") || arg.startsWith("-v="))) {
      targets.push(volumeTarget(arg.slice(arg.indexOf("=") + 1)));
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--mount=")) {
      targets.push(mountOptionTarget(arg.slice("--mount=".length)));
    }
  }
  return targets.filter((target) => typeof target === "string" && target.length > 0);
}

/** `host:container[:opts]` — the container half, absolute paths only. */
function volumeTarget(spec) {
  if (typeof spec !== "string") return null;
  const parts = spec.split(":");
  return parts.length >= 2 ? parts[1] : null;
}

/** `target[:options]` — a tmpfs is named by its mount target alone. */
function tmpfsTarget(spec) {
  if (typeof spec !== "string") return null;
  const colon = spec.indexOf(":");
  return colon < 0 ? spec : spec.slice(0, colon);
}

/** `type=bind,source=...,target=...` — the `target`/`destination` operand. */
function mountOptionTarget(spec) {
  if (typeof spec !== "string") return null;
  for (const field of spec.split(",")) {
    const eq = field.indexOf("=");
    if (eq < 0) continue;
    const key = field.slice(0, eq).trim();
    if (key === "target" || key === "destination" || key === "dst") return field.slice(eq + 1).trim();
  }
  return null;
}

/**
 * `docker image inspect <ref> --format {{.Id}}`: what a reference names NOW.
 *
 * Used before cleanup, so a tag that was retargeted after the run is never
 * removed on the strength of an identity it no longer has.
 */
export function imageIdArgs(reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new Error("an image reference is required");
  }
  return ["image", "inspect", reference, "--format", "{{.Id}}"];
}

/**
 * The image a `docker run` argv executes, parsed from the argv itself.
 *
 * A CLOSED grammar: exactly the options this module emits are understood, and
 * any other option is a refusal rather than a guess. The driver records this
 * value for every candidate container it launches, from the very argv it hands
 * to Docker, so "every candidate container ran the immutable image" is measured
 * from what was executed rather than asserted from what was intended.
 */
const RUN_OPTIONS_WITH_VALUE = new Set([
  "--network", "--security-opt", "--tmpfs", "-e", "--env", "-v", "--volume", "--mount", "-w", "--entrypoint",
]);
const RUN_FLAGS = new Set(["--rm", "--read-only"]);

export function dockerRunSubject(args) {
  if (!Array.isArray(args) || args[0] !== "run") throw new Error("not a docker run argv");
  for (let i = 1; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (RUN_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (RUN_FLAGS.has(arg) || /^--[a-z][a-z-]*=/.test(arg)) continue;
    if (arg.startsWith("-")) throw new Error(`unrecognized docker run option: ${arg}`);
    return arg;
  }
  throw new Error("a docker run argv without an image");
}

/** `docker image inspect <ref> --format {{json .}}`: the whole config, once. */
export function imageInspectArgs(reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new Error("an image reference is required");
  }
  return ["image", "inspect", reference, "--format", "{{json .}}"];
}

/**
 * A hardened, read-only, offline candidate container running one image probe.
 *
 * The probes live in `lib/` and import nothing from `/app`, so they are mounted
 * at `/verify` rather than inside the application tree. What they report are
 * OBSERVATIONS; every judgement about them is the driver's.
 */
export function probeRunArgs({ imageId, harnessDir, mode, extra = [] }) {
  assertImmutableImageId(imageId);
  requireAbsoluteHostPath("the harness directory", harnessDir);
  if (typeof mode !== "string" || !/^[a-z-]+$/.test(mode)) throw new Error("a probe mode is required");
  return assertNoForbiddenMounts([
    "run",
    "--rm",
    ...RELEASE_HARDENING_ARGS,
    "--read-only",
    "-v",
    `${harnessDir}:${VERIFY_MOUNT_TARGET}:ro`,
    "--entrypoint",
    "/usr/local/bin/node",
    imageId,
    `${VERIFY_MOUNT_TARGET}/lib/release-image-probe.mjs`,
    mode,
    ...extra,
  ]);
}

/**
 * A hardened, read-only, offline candidate container running one Python policy
 * verifier against the image's own pinned yt-dlp artifact.
 *
 * Mirrors the invocation the acceptance README already documents, and adds
 * `--cap-drop=ALL` plus `no-new-privileges`. The verifier directory is the only
 * mount, read-only, outside `/app`, and no media URL or credential is supplied.
 */
export function policyVerifierRunArgs({ imageId, harnessDir, verifier }) {
  assertImmutableImageId(imageId);
  requireAbsoluteHostPath("the harness directory", harnessDir);
  if (!POLICY_VERIFIERS.includes(verifier)) {
    throw new Error(`unknown policy verifier: ${String(verifier)}`);
  }
  return assertNoForbiddenMounts([
    "run",
    "--rm",
    ...RELEASE_HARDENING_ARGS,
    "--read-only",
    "-v",
    `${harnessDir}:${VERIFY_MOUNT_TARGET}:ro`,
    imageId,
    "/usr/bin/python3",
    `${VERIFY_MOUNT_TARGET}/${verifier}`,
    "/usr/local/lib/videofetch/yt-dlp",
  ]);
}

/** The committed offline verifiers SPLIT-07 runs against the candidate image. */
export const POLICY_VERIFIERS = Object.freeze(["verify-selector.py", "verify-download-policy.py"]);

/**
 * The SPLIT-06 acceptance `docker run` argv, against the RELEASE image.
 *
 * Differences from `lib/split-container.mjs`'s overlay invocation, all of them
 * consequences of the subject being a release image rather than a test overlay:
 *
 *   - the harness is MOUNTED read-only, because a release image must not carry
 *     it, and mounted at its repository-relative path so `split-full-path.mjs`
 *     resolves `../../../src/...` to the IMAGE's `/app/src`;
 *   - `--read-only`, `--cap-drop=ALL` and `no-new-privileges` are added, with
 *     the Product media workspace bound at `/tmp/videofetch` in Production's
 *     exact `--mount type=bind` form and a separate harness scratch tmpfs;
 *   - `assertNoForbiddenMounts` runs over the finished argv, so a future edit
 *     that reached for `/app/src` fails here instead of silently producing a
 *     run that proves nothing about the release image.
 *
 * The run subject is the candidate's immutable image ID (since `-02`), so the
 * image that executes is exactly the image the driver inspected. Every
 * `--source-*`/`--base-*`/`--overlay-*` value is supplied by the driver from its
 * own observations; this function owns only the container shape.
 */
export function releaseAcceptanceRunArgs({
  imageId,
  family,
  harnessDir,
  reportDir,
  mediaWorkspaceDir,
  evidenceName,
  containerReportDir = REPORT_MOUNT_TARGET,
}) {
  assertImmutableImageId(imageId);
  if (family !== "mp4" && family !== "webm") throw new Error("family must be mp4 or webm");
  requireAbsoluteHostPath("the harness directory", harnessDir);
  requireAbsoluteHostPath("the report directory", reportDir);
  const productMediaMount = productMediaWorkspaceMount(mediaWorkspaceDir);
  // The Product workspace is product scratch, wiped between runs: it is never
  // the evidence directory, and never inside (or around) the harness.
  if (hostPathsOverlap(mediaWorkspaceDir, reportDir)) {
    throw new Error("the Product media workspace must not overlap the report directory");
  }
  if (hostPathsOverlap(mediaWorkspaceDir, harnessDir)) {
    throw new Error("the Product media workspace must not overlap the harness directory");
  }
  if (typeof evidenceName !== "string" || !/^[A-Za-z0-9._-]+$/.test(evidenceName)) {
    throw new Error("the evidence filename must be a plain basename");
  }
  return assertNoForbiddenMounts([
    "run",
    "--rm",
    ...RELEASE_HARDENING_ARGS,
    "--read-only",
    // The product's writable media surface, bound exactly as Production binds
    // its disk-backed workspace. `--mount`, never `-v`: a missing source fails.
    "--mount",
    productMediaMount,
    // The harness's own scratch, disjoint from every product path.
    "--tmpfs",
    HARNESS_SCRATCH_TMPFS,
    ...RELEASE_RUN_ENVIRONMENT.flatMap((entry) => ["-e", entry]),
    // The acceptance harness: test machinery the release image does not ship.
    "-v",
    `${harnessDir}:${HARNESS_MOUNT_TARGET}:ro`,
    // The evidence directory: the only writable surface besides the Product
    // workspace and the harness scratch.
    "-v",
    `${reportDir}:${containerReportDir}`,
    "-w",
    "/app",
    "--entrypoint",
    "/usr/local/bin/node",
    imageId,
    "--import",
    "./scripts/register-ts-aliases.mjs",
    "--experimental-strip-types",
    `${HARNESS_MOUNT_TARGET.slice("/app/".length)}/split-full-path.mjs`,
    "--family",
    family,
    "--evidence",
    `${containerReportDir}/${evidenceName}`,
  ]);
}

/** `docker image rm` for the temporary candidate. Never `latest`, by construction. */
export function candidateRemoveArgs(image) {
  return ["image", "rm", assertCandidateReference(image)];
}

function requireAbsoluteHostPath(label, value) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(`${label} must be an absolute host path`);
  }
}
