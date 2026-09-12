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
 * PRODUCT media temp is EXACTLY the Production unit's mount
 * (`deploy/systemd/videofetch-worker.service`), and a self-test reads the unit
 * to keep it that way. A tmpfs mounted over `/tmp/videofetch` shadows the
 * node-owned directory the image prepares, so its uid/gid options are
 * load-bearing, not cosmetic (WORKER-TEMP-TMPFS-OWNERSHIP-001). The first real
 * SPLIT-07A run put a tmpfs on `/tmp` instead, hid `/tmp/videofetch` from the
 * product, and both families failed `PROCESSING_FAILED` before upload — the
 * gate catching exactly the filesystem-layout drift it exists to catch.
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
 * Neither mount grants `exec`: nothing in the chain executes a file it wrote.
 * The pinned yt-dlp is the platform-independent zipimport artifact precisely so
 * it never unpacks itself into a temporary directory.
 */
export const PRODUCT_MEDIA_TMPFS = "/tmp/videofetch:rw,noexec,nosuid,size=2g,uid=1000,gid=1000";
export const HARNESS_SCRATCH_TARGET = "/acceptance-scratch";
export const HARNESS_SCRATCH_TMPFS =
  `${HARNESS_SCRATCH_TARGET}:rw,noexec,nosuid,nodev,size=512m,uid=1000,gid=1000`;

/** The environment a candidate run may add. Deliberately tiny, and non-secret. */
export const RELEASE_RUN_ENVIRONMENT = Object.freeze([`TMPDIR=${HARNESS_SCRATCH_TARGET}`]);

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
export function probeRunArgs({ image, harnessDir, mode, extra = [] }) {
  assertCandidateReference(image);
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
    image,
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
export function policyVerifierRunArgs({ image, harnessDir, verifier }) {
  assertCandidateReference(image);
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
    image,
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
 *     Production's exact media tmpfs and a separate harness scratch tmpfs;
 *   - `assertNoForbiddenMounts` runs over the finished argv, so a future edit
 *     that reached for `/app/src` fails here instead of silently producing a
 *     run that proves nothing about the release image.
 *
 * Every `--source-*`/`--base-*`/`--overlay-*` value is supplied by the driver
 * from its own observations; this function owns only the container shape.
 */
export function releaseAcceptanceRunArgs({
  image,
  family,
  harnessDir,
  reportDir,
  evidenceName,
  containerReportDir = REPORT_MOUNT_TARGET,
}) {
  assertCandidateReference(image);
  if (family !== "mp4" && family !== "webm") throw new Error("family must be mp4 or webm");
  requireAbsoluteHostPath("the harness directory", harnessDir);
  requireAbsoluteHostPath("the report directory", reportDir);
  if (typeof evidenceName !== "string" || !/^[A-Za-z0-9._-]+$/.test(evidenceName)) {
    throw new Error("the evidence filename must be a plain basename");
  }
  return assertNoForbiddenMounts([
    "run",
    "--rm",
    ...RELEASE_HARDENING_ARGS,
    "--read-only",
    // The product's writable media surface, exactly as Production mounts it.
    "--tmpfs",
    PRODUCT_MEDIA_TMPFS,
    // The harness's own scratch, disjoint from every product path.
    "--tmpfs",
    HARNESS_SCRATCH_TMPFS,
    ...RELEASE_RUN_ENVIRONMENT.flatMap((entry) => ["-e", entry]),
    // The acceptance harness: test machinery the release image does not ship.
    "-v",
    `${harnessDir}:${HARNESS_MOUNT_TARGET}:ro`,
    // The one WRITABLE surface, and the only thing the run writes off tmpfs.
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
