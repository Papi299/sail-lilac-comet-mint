// The SPLIT-07 release-image candidate acceptance record.
//
// Pure. The driver decides WHERE to write the record; this module decides what
// may be in it, and refuses to produce one that leaks or one that claims a PASS
// it did not earn.
//
// ── Why a NEW schema rather than an extension of SPLIT-06's ────────────────
//
// A `split06-deterministic-full-path-04` record describes ONE family's split
// chain executing in some image. A SPLIT-07 record describes something
// strictly larger and different in kind: a named Git commit, an image built
// from it by the real `Dockerfile.worker`, that image's identity, hardening and
// runtime, and TWO nested SPLIT-06 results. Reusing SPLIT-06's identifier would
// make those two very different claims indistinguishable to anyone reading the
// artifacts later.
//
// ── Why SPLIT-06's schema is NOT bumped ────────────────────────────────────
//
// SPLIT-06's meaning has not changed. The same chain, the same fixtures, the
// same checks and the same PASS conditions apply whether the subject image is
// an overlay or a release build; what changed is who CALLS it. So SPLIT-07
// wraps each child record — validates it, hashes its exact bytes, and records
// its schema, verdict and digest — and never rewrites one. A SPLIT-06 bump
// would be justified only if SPLIT-06 itself changed what PASS means.

import { createHash } from "node:crypto";

import { FORBIDDEN_EVIDENCE_KEYS, stripForbiddenKeys } from "./evidence.mjs";
import { isFullGitSha, RELEASE_INPUT_FILES } from "./release-provenance.mjs";
import { FORBIDDEN_CANDIDATE_TAGS, RELEASE_DOCKERFILE } from "./release-container.mjs";

/**
 * The schema identifier. Bump it when the record's MEANING changes.
 *
 *   -01  the first release-image candidate record. `source` holds what the
 *        driver OBSERVED in a clean Git worktree before AND after the build;
 *        `image` holds the immutable id of an image built by the real
 *        `Dockerfile.worker`; `sourceToImage` holds a deterministic path +
 *        SHA-256 manifest comparison between that commit and that image;
 *        `hardening` holds forbidden-tool, forbidden-environment and static
 *        policy-verifier outcomes; and `splitAcceptance` holds one validated,
 *        byte-hashed SPLIT-06 child record per family, mp4 AND webm, both
 *        required to PASS.
 */
export const SPLIT07_EVIDENCE_SCHEMA = "split07-release-image-candidate-01";

/** The exact SPLIT-06 schema a SPLIT-07 PASS accepts as a child. */
export const REQUIRED_CHILD_SCHEMA = "split06-deterministic-full-path-04";

/** Both families are required. One is not a release-image acceptance. */
export const REQUIRED_SPLIT_FAMILIES = Object.freeze(["mp4", "webm"]);

/**
 * The image configuration a release candidate must present.
 *
 * `container-policy.test.ts` already asserts each of these against the
 * Dockerfile TEXT. SPLIT-07 asserts them against the BUILT IMAGE, which is a
 * different claim: a recipe can say `USER node` and still produce an image
 * whose config lost it to a base-image change, a build-time `--build-arg`, or a
 * layer someone added on top.
 */
export const EXPECTED_IMAGE_CONFIG = Object.freeze({
  os: "linux",
  user: "node",
  workingDir: "/app",
  cmd: Object.freeze([
    "node",
    "--import",
    "./scripts/register-ts-aliases.mjs",
    "--experimental-strip-types",
    "src/worker/runtime/main.server.ts",
  ]),
  exposedPorts: Object.freeze(["8080/tcp"]),
});

/**
 * Non-secret defaults the release image is expected to carry, by NAME.
 *
 * These are values `Dockerfile.worker` deliberately commits: bind address,
 * port, the two filesystem roles and the FFmpeg path. They are configuration,
 * not credentials, and the deployment contract reads them.
 */
export const EXPECTED_IMAGE_ENVIRONMENT_NAMES = Object.freeze([
  "NODE_ENV",
  "WORKER_BIND_HOST",
  "WORKER_PORT",
  "WORKER_DATA_DIRECTORY",
  "TEMP_DIRECTORY",
  "FFMPEG_PATH",
]);

/**
 * Environment names the release image must NEVER bake.
 *
 * Three distinct reasons, all fail-closed in the Worker runtime as well:
 *
 *   feature gate     `YTDLP_ENABLED` — absent means disabled, and no image may
 *                    enable generic execution by itself;
 *   retired contract `YTDLP_NETWORK_ISOLATED`, `YTDLP_PATH` — the runtime
 *                    REFUSES TO START if either is present at all, even as
 *                    `false`, so a stale image fails closed;
 *   credentials      everything else here. The media container holds no Worker
 *                    HMAC secret, no Cloudflare Access credential, no R2
 *                    parent credential, no superseded persistent writer
 *                    credential and no Vercel signer identity.
 */
export const FORBIDDEN_IMAGE_ENVIRONMENT_NAMES = Object.freeze([
  "YTDLP_ENABLED",
  "YTDLP_NETWORK_ISOLATED",
  "YTDLP_PATH",
  "WORKER_CONTROL_SECRET",
  "WORKER_CONTROL_PREVIOUS_SECRET",
  "VIDEOFETCH_ACCESS_SECRET",
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  "R2_BROKER_PARENT_ACCESS_KEY_ID",
  "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
  "R2_WRITER_ACCESS_KEY_ID",
  "R2_WRITER_SECRET_ACCESS_KEY",
  "R2_WRITER_SESSION_TOKEN",
  "R2_SIGNER_ACCESS_KEY_ID",
  "R2_SIGNER_SECRET_ACCESS_KEY",
  "R2_SIGNER_SESSION_TOKEN",
]);

/** The pinned media runtime a release candidate must ship, exactly. */
export const EXPECTED_YTDLP_RUNTIME = Object.freeze({
  path: "/usr/local/lib/videofetch/yt-dlp",
  version: "2026.08.19",
  sha256: "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6",
  uid: 0,
  gid: 0,
  mode: "0555",
});

/**
 * Every check a PASS requires.
 *
 * `buildReleaseEvidence` re-derives this set from the record it was handed and
 * refuses to emit a PASS unless all of them are present AND passing. That is
 * the difference between "the driver believed it passed" and "the record itself
 * says so": a driver that forgot to run a stage produces a record missing the
 * check, and a missing required check is a refusal, not a default.
 */
export const REQUIRED_PASS_CHECKS = Object.freeze([
  "source/context-verified-before-build",
  "source/context-unchanged-after-build",
  "image/built-from-the-real-dockerfile",
  "image/candidate-tag-is-not-deployable",
  "image/os-is-linux",
  "image/architecture-recorded",
  "image/working-directory",
  "image/runtime-user-is-non-root-node",
  "image/cmd-is-the-worker-entry-point",
  "image/only-the-worker-port-is-exposed",
  "image/no-in-image-healthcheck",
  "image/no-host-mount-in-the-image-config",
  "image/expected-non-secret-environment-present",
  "image/no-forbidden-environment-name-baked",
  "sourceToImage/manifest-matches-the-verified-commit",
  "sourceToImage/broker-source-absent",
  "sourceToImage/acceptance-harness-not-baked",
  "sourceToImage/no-irregular-application-file",
  "runtime/ytdlp-version",
  "runtime/ytdlp-sha256",
  "runtime/ytdlp-root-owned-and-unwritable",
  "runtime/ytdlp-not-self-updatable-by-the-runtime-user",
  "runtime/python-can-execute-the-pinned-artifact",
  "runtime/ffmpeg-present-and-executable",
  "runtime/ffprobe-present-and-executable",
  "runtime/node-version-recorded",
  "hardening/no-forbidden-administrative-tool",
  "hardening/selector-verifier-exit-zero",
  "hardening/download-policy-verifier-exit-zero",
  "split/mp4-child-passed",
  "split/webm-child-passed",
  "split/both-families-executed",
  "split/children-ran-in-the-candidate-image",
  "production/latest-image-id-unchanged",
  "production/worker-container-unchanged",
]);

/** A refusal to emit. Its message is for the operator. */
export class ReleaseEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseEvidenceError";
  }
}

/**
 * Validates one SPLIT-06 child record read from disk.
 *
 * SPLIT-07 must not trust the child process's exit code alone: a harness that
 * crashed after writing a `BLOCKED` record, or one that wrote a record from an
 * older schema, would both exit in ways a parent could misread. So the PARENT
 * reads the bytes, parses them, and requires the exact schema, the exact
 * family, a `PASS` verdict and a non-empty all-passing check ledger.
 *
 * Returns an observation. Throwing is reserved for input that is not a record
 * at all; a record that simply did not pass comes back with `ok: false` so the
 * driver can record a FAIL rather than abort.
 */
export function validateChildRecord({ family, bytes }) {
  if (!REQUIRED_SPLIT_FAMILIES.includes(family)) {
    throw new ReleaseEvidenceError(`unknown split family: ${String(family)}`);
  }
  if (!Buffer.isBuffer(bytes)) {
    throw new ReleaseEvidenceError("a child record must be validated from its exact bytes");
  }
  const digest = sha256Hex(bytes);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      family, ok: false, schema: null, verdict: null, sha256: digest, bytes: bytes.length,
      checkCount: 0, failedCheckCount: 0, reason: "the child record is not parseable JSON",
    };
  }
  const checks = Array.isArray(record?.checks) ? record.checks : [];
  const failed = checks.filter((check) => check?.ok !== true);
  const schemaOk = record?.schema === REQUIRED_CHILD_SCHEMA;
  const familyOk = record?.family === family;
  const verdictOk = record?.verdict === "PASS";
  const checksOk = checks.length > 0 && failed.length === 0;
  const reasons = [];
  if (!schemaOk) reasons.push(`schema is ${String(record?.schema)}, not ${REQUIRED_CHILD_SCHEMA}`);
  if (!familyOk) reasons.push(`family is ${String(record?.family)}, not ${family}`);
  if (!verdictOk) reasons.push(`verdict is ${String(record?.verdict)}, not PASS`);
  if (checks.length === 0) reasons.push("the record carries no checks");
  else if (failed.length > 0) reasons.push(`${failed.length} of ${checks.length} checks did not pass`);
  return {
    family,
    ok: schemaOk && familyOk && verdictOk && checksOk,
    schema: typeof record?.schema === "string" ? record.schema : null,
    verdict: typeof record?.verdict === "string" ? record.verdict : null,
    sha256: digest,
    bytes: bytes.length,
    checkCount: checks.length,
    failedCheckCount: failed.length,
    // The child's own OBSERVED source identity, so the evidence graph can be
    // walked without reopening the child: parent and child must name one commit.
    sourceCommit: isFullGitSha(record?.source?.commit) ? record.source.commit : null,
    sourceTree: isFullGitSha(record?.source?.tree) ? record.source.tree : null,
    // Which image the child actually ran in. For a release-image run the base
    // and the overlay are ONE image, because no overlay layer was applied —
    // that identity is what `split/children-ran-in-the-candidate-image` checks.
    baseImage: stringOrNull(record?.image?.acceptedBaseImage),
    baseImageId: stringOrNull(record?.image?.acceptedBaseDigest),
    ranImage: stringOrNull(record?.image?.overlayImage),
    ranImageId: stringOrNull(record?.image?.overlayImageId),
    networkMode: stringOrNull(record?.network?.mode),
    reason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}

/**
 * Confirms a child record's bytes have not changed since they were observed.
 *
 * The driver hashes each child ONCE, then re-reads and re-hashes before it
 * assembles the parent. Without this, the parent's digest would be a claim
 * about bytes nobody checked again, and a child edited between the two moments
 * would be recorded under a digest that no longer describes it.
 */
export function assertChildUnchanged({ family, expectedSha256, bytes }) {
  if (!Buffer.isBuffer(bytes)) {
    throw new ReleaseEvidenceError("re-verification needs the child's exact bytes");
  }
  const digest = sha256Hex(bytes);
  if (digest !== expectedSha256) {
    throw new ReleaseEvidenceError(
      `the ${family} child evidence changed after it was observed: ${expectedSha256} -> ${digest}`,
    );
  }
  return digest;
}

/**
 * Assembles the record from an ALLOWLIST.
 *
 * Every field is named here. Nothing is spread in from an observation object,
 * so a future field added elsewhere cannot arrive by accident — which is what
 * makes the forbidden-key sweep below a second gate rather than the mechanism.
 */
export function buildReleaseEvidence(input) {
  const record = {
    schema: SPLIT07_EVIDENCE_SCHEMA,
    verdict: input.verdict,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,

    source: verifiedSource(input.source),

    image: {
      candidateTag: input.image.candidateTag,
      imageId: input.image.imageId,
      os: input.image.os,
      architecture: input.image.architecture,
      acceptedWorkerArchitecture: input.image.acceptedWorkerArchitecture,
      user: input.image.user,
      workingDir: input.image.workingDir,
      cmd: input.image.cmd,
      entrypoint: input.image.entrypoint,
      exposedPorts: input.image.exposedPorts,
      healthcheckPresent: input.image.healthcheckPresent,
      configuredVolumes: input.image.configuredVolumes,
      environmentNames: input.image.environmentNames,
      builtFromDockerfile: RELEASE_DOCKERFILE,
      // SPLIT-07A characterizes the release-image HARNESS against a real
      // build. The image it produces is a local-test artifact, removed after
      // the run; the retained candidate is SPLIT-07B's, from merged `main`.
      deployable: false,
      retainedCandidate: false,
    },

    sourceToImage: {
      method: input.sourceToImage.method,
      expectedFileCount: input.sourceToImage.expectedFileCount,
      observedFileCount: input.sourceToImage.observedFileCount,
      comparedFileCount: input.sourceToImage.comparedFileCount,
      expectedManifestDigest: input.sourceToImage.expectedManifestDigest,
      observedManifestDigest: input.sourceToImage.observedManifestDigest,
      equal: input.sourceToImage.equal,
      missingFromImage: input.sourceToImage.missingFromImage,
      contentMismatched: input.sourceToImage.contentMismatched,
      unexpectedInImage: input.sourceToImage.unexpectedInImage,
      irregularApplicationFiles: input.sourceToImage.irregularApplicationFiles,
      brokerSourcePresent: input.sourceToImage.brokerSourcePresent,
      brokerFilesExcludedFromManifest: input.sourceToImage.brokerFilesExcludedFromManifest,
      acceptanceHarnessPathsPresent: input.sourceToImage.acceptanceHarnessPathsPresent,
    },

    runtime: {
      node: input.runtime.node,
      python: input.runtime.python,
      ytdlpVersion: input.runtime.ytdlpVersion,
      ytdlpSha256: input.runtime.ytdlpSha256,
      ytdlpPath: input.runtime.ytdlpPath,
      ytdlpUid: input.runtime.ytdlpUid,
      ytdlpGid: input.runtime.ytdlpGid,
      ytdlpMode: input.runtime.ytdlpMode,
      ytdlpWriteRefusalCode: input.runtime.ytdlpWriteRefusalCode,
      ffmpeg: input.runtime.ffmpeg,
      ffprobe: input.runtime.ffprobe,
      runtimeUid: input.runtime.runtimeUid,
    },

    hardening: {
      forbiddenTools: input.hardening.forbiddenTools,
      forbiddenEnvironmentNamesFound: input.hardening.forbiddenEnvironmentNamesFound,
      brokerSourcePresent: input.sourceToImage.brokerSourcePresent,
      policyVerifiers: input.hardening.policyVerifiers,
      containerInvocation: {
        network: "none",
        readOnlyRoot: true,
        capabilitiesDropped: "ALL",
        noNewPrivileges: true,
        privileged: false,
        dockerSocketMounted: false,
        productSourceMounted: false,
      },
    },

    splitAcceptance: {
      requiredChildSchema: REQUIRED_CHILD_SCHEMA,
      familiesRequired: [...REQUIRED_SPLIT_FAMILIES],
      familiesExecuted: input.splitAcceptance.familiesExecuted,
      children: input.splitAcceptance.children,
    },

    production: input.production,

    checks: input.checks,
  };

  if (record.verdict === "PASS") {
    assertPassEarned(record);
  }

  // Order matters. The forbidden-key check runs on the RAW record, so a field
  // that should never have been assembled is a loud refusal rather than a
  // quietly withheld value: this record is an allowlist, and a `stderr` key
  // reaching it means the producer, not the sweep, is wrong.
  const raw = JSON.stringify(record);
  for (const key of FORBIDDEN_EVIDENCE_KEYS) {
    if (raw.includes(`"${key}":`)) {
      throw new ReleaseEvidenceError(`refusing to emit an evidence record containing a '${key}' field`);
    }
  }
  return stripForbiddenKeys(record);
}

/**
 * A PASS must be EARNED by the record's own contents.
 *
 * Three independent conditions, because each catches a different kind of wrong
 * record: every required check must be present (a stage that never ran cannot
 * be silently absent), every check in the ledger must pass (including ones not
 * on the required list), and both children must independently be validated
 * PASS records of the exact SPLIT-06 schema.
 */
function assertPassEarned(record) {
  const checks = Array.isArray(record.checks) ? record.checks : [];
  const byName = new Map(checks.map((check) => [check?.name, check?.ok === true]));

  const missing = REQUIRED_PASS_CHECKS.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new ReleaseEvidenceError(
      `refusing to emit a PASS ${SPLIT07_EVIDENCE_SCHEMA} record missing required checks: ${missing.join(", ")}`,
    );
  }
  const failed = checks.filter((check) => check?.ok !== true).map((check) => String(check?.name));
  if (failed.length > 0) {
    throw new ReleaseEvidenceError(
      `refusing to emit a PASS ${SPLIT07_EVIDENCE_SCHEMA} record with failed checks: ${failed.join(", ")}`,
    );
  }

  const children = Array.isArray(record.splitAcceptance?.children) ? record.splitAcceptance.children : [];
  for (const family of REQUIRED_SPLIT_FAMILIES) {
    const child = children.find((entry) => entry?.family === family);
    if (!child) {
      throw new ReleaseEvidenceError(
        `refusing to emit a PASS record without a ${family} SPLIT-06 child result`,
      );
    }
    if (child.schema !== REQUIRED_CHILD_SCHEMA) {
      throw new ReleaseEvidenceError(
        `refusing to emit a PASS record whose ${family} child is ${String(child.schema)}, ` +
          `not ${REQUIRED_CHILD_SCHEMA}`,
      );
    }
    if (child.verdict !== "PASS" || child.ok !== true) {
      throw new ReleaseEvidenceError(
        `refusing to emit a PASS record whose ${family} child did not pass`,
      );
    }
    if (typeof child.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(child.sha256)) {
      throw new ReleaseEvidenceError(
        `refusing to emit a PASS record whose ${family} child has no content digest`,
      );
    }
  }
  const executed = Array.isArray(record.splitAcceptance?.familiesExecuted)
    ? [...record.splitAcceptance.familiesExecuted].sort()
    : [];
  const required = [...REQUIRED_SPLIT_FAMILIES].sort();
  if (executed.length !== required.length || executed.some((family, i) => family !== required[i])) {
    throw new ReleaseEvidenceError(
      `refusing to emit a PASS record that did not execute exactly ${required.join(" and ")}: ` +
        `executed ${executed.join(", ") || "nothing"}`,
    );
  }

  // The candidate tag is re-checked at emit time, so a record can never name a
  // deployable tag even if a future driver bypassed the container model.
  const tag = String(record.image?.candidateTag ?? "");
  const separator = tag.lastIndexOf(":");
  if (separator < 0 || FORBIDDEN_CANDIDATE_TAGS.includes(tag.slice(separator + 1))) {
    throw new ReleaseEvidenceError(`refusing to emit a PASS record naming a deployable tag: ${tag}`);
  }
}

/**
 * The `source` block, admitted only when it is the driver's VERIFIED
 * observation, before AND after the build. A record naming an unverified
 * source, or one whose context could have changed while Docker read it, would
 * be a false statement, so none is produced.
 */
function verifiedSource(source) {
  const verified =
    source !== null &&
    typeof source === "object" &&
    isFullGitSha(source.commit) &&
    isFullGitSha(source.tree) &&
    source.contextClean === true &&
    source.verifiedBeforeBuild === true &&
    source.verifiedAfterBuild === true &&
    isFullGitSha(source.dockerfileObject) &&
    typeof source.dockerfileSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(source.dockerfileSha256) &&
    Array.isArray(source.releaseInputs) &&
    source.releaseInputs.length === RELEASE_INPUT_FILES.length;
  if (!verified) {
    throw new ReleaseEvidenceError(
      `refusing to emit a ${SPLIT07_EVIDENCE_SCHEMA} record without driver-verified release provenance`,
    );
  }
  return {
    commit: source.commit,
    tree: source.tree,
    contextClean: true,
    verifiedBeforeBuild: true,
    verifiedAfterBuild: true,
    dockerfilePath: RELEASE_DOCKERFILE,
    dockerfileObject: source.dockerfileObject,
    dockerfileSha256: source.dockerfileSha256,
    releaseInputs: source.releaseInputs.map((input) => ({
      path: input.path,
      object: input.object,
      sha256: input.sha256,
    })),
    // The two provenance ROLES §7 keeps distinct. The release build context is
    // a clean worktree fixed to a merged product commit; the harness that drove
    // the run is a separate checkout, and during SPLIT-07A it is an UNMERGED
    // branch. Conflating them would attribute the image to acceptance code that
    // is deliberately not part of `Dockerfile.worker`.
    harnessRole: {
      harnessCommit: source.harnessCommit ?? null,
      harnessRef: source.harnessRef ?? null,
      harnessIsReleaseContext: false,
      note: "the harness drove the run; it is not part of the release build context",
    },
    verifiedBy:
      "run-release-image-acceptance.mjs: git against the release build context, before and after the build",
  };
}

/** One deterministic JSON document, pretty-printed for review. */
export function renderReleaseEvidence(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
