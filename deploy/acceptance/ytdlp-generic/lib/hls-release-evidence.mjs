// The HLS-09 release-image clear-HLS child record.
//
// Pure. The orchestrator (`hls-full-path.mjs`, in `release-image` mode) decides
// WHERE the record goes; this module decides what may be in it, and refuses to
// produce one that leaks or over-claims. The SPLIT-07 parent re-reads the exact
// bytes and validates them here too (`validateHlsReleaseChildRecord`).
//
// ── Why a NEW schema rather than HLS-08's ───────────────────────────────────
//
// `hls08-deterministic-full-path-02` is OVERLAY evidence: it asserts an
// accepted historical base source and digest, and an overlay image that
// differs from that base. For a freshly built release candidate every one of
// those assertions is false — there is no historical base and no overlay — and
// filling them in to reuse the schema would make the record lie. So the
// behavioral chain and its checks are shared unchanged
// (`HLS_BEHAVIORAL_MANDATORY_CHECKS`), and only the IDENTITY differs:
//
//   HLS-08 overlay   source commit/tree + accepted historical base + overlay id
//   HLS-09 release   source commit/tree + source-context-clean (from the
//                    parent) + candidate build label + candidate immutable
//                    image id + the run subject Docker executed + network none
//
// The child cannot introspect Docker. It records the identity the SPLIT-07
// parent observed and handed it; the PARENT is the authority that the image was
// built from that source and that Docker executed that immutable id, and it
// re-validates this record's identity against its own observations.
//
// Import-free apart from the harness's own import-free modules, so the parent
// validates a record on the VM's Node 18.

import { stripForbiddenKeys } from "./evidence.mjs";
import {
  HLS08_SUBSTITUTIONS,
  HLS_BEHAVIORAL_MANDATORY_CHECKS,
  findForbiddenKey,
  findForbiddenSubstring,
  unmetPassConditions,
} from "./hls-evidence.mjs";
import { IMAGE_ID_PATTERN, RELEASE_DOCKERFILE, candidateImageTag } from "./release-container.mjs";
import { isFullGitSha } from "./split-provenance.mjs";

/**
 * The schema identifier. Bump it when the record's meaning changes.
 *
 *   -01  The accepted HLS-08 clear-HLS positive full path and its three bounded
 *        negatives, executed by the ACTUAL release candidate image's own
 *        `/app` source, Node, dependencies, Python, yt-dlp, FFmpeg and ffprobe,
 *        with HLS-08 `-02`'s field-aware privacy placement. Identity is the
 *        release candidate's, as observed by the SPLIT-07 parent; there is no
 *        historical-base or overlay assertion.
 */
export const HLS09_RELEASE_EVIDENCE_SCHEMA = "hls09-release-image-full-path-01";

/**
 * The RELEASE identity checks, replacing HLS-08's four overlay identity checks
 * one-for-one in meaning: where the source came from, that it was clean, which
 * immutable image ran, and that it ran offline under a non-production label.
 */
export const HLS09_RELEASE_IDENTITY_CHECKS = Object.freeze([
  "release/source-identity-present",
  "release/source-context-clean",
  "release/candidate-image-id-valid",
  "release/run-subject-is-candidate-image-id",
  "release/candidate-label-is-non-production",
  "release/network-namespace-is-loopback-only",
]);

/**
 * Every check an HLS-09 PASS requires: the release identity above plus EVERY
 * behavioral check HLS-08 requires, unchanged. No partial PASS.
 */
export const HLS09_MANDATORY_CHECKS = Object.freeze([
  ...HLS09_RELEASE_IDENTITY_CHECKS,
  ...HLS_BEHAVIORAL_MANDATORY_CHECKS,
]);

/** What a PASS does not prove. Recorded verbatim in every record. */
export const HLS09_NON_CLAIMS = Object.freeze([
  "Production SSRF/address-pinning is NOT re-proven here",
  "Production DNS is NOT re-proven here",
  "Production egress/nftables is NOT re-proven here (Phase 9 remains the authority)",
  "no real Cloudflare Tunnel/Access, Vercel, Cloudflare R2 or R2 credential broker",
  "no real public HLS source compatibility, real CDN or real signed-URL lifetime",
  "no Production startup of this candidate, no promotion (HLS-10) and no long-term uptime claim",
  "no Production media network namespace, watchdog or workspace provisioning",
]);

/** The one network interface a `--network none` container has. */
const LOOPBACK_INTERFACE = "lo";

/**
 * The release identity checks, derived from the identity the parent handed the
 * child and the interfaces the child observed. Pure; returns ledger entries in
 * `HLS09_RELEASE_IDENTITY_CHECKS` order.
 */
export function releaseIdentityChecks(identity, { networkInterfaceNames }) {
  const id = identity ?? {};
  const names = Array.isArray(networkInterfaceNames) ? [...networkInterfaceNames].sort() : [];
  let labelOk = false;
  try {
    // The label must be exactly the non-deployable temporary tag the SPLIT-07
    // container model derives from THIS source commit — never `latest`, never
    // an RC, never a label naming another commit.
    labelOk = isFullGitSha(id.sourceCommit) && id.candidateTag === candidateImageTag(id.sourceCommit);
  } catch {
    labelOk = false;
  }
  return [
    ["release/source-identity-present", isFullGitSha(id.sourceCommit) && isFullGitSha(id.sourceTree), null],
    ["release/source-context-clean", id.sourceContextClean === true, null],
    ["release/candidate-image-id-valid", typeof id.candidateImageId === "string" && IMAGE_ID_PATTERN.test(id.candidateImageId), null],
    [
      "release/run-subject-is-candidate-image-id",
      typeof id.runImageId === "string" && IMAGE_ID_PATTERN.test(id.runImageId) && id.runImageId === id.candidateImageId,
      null,
    ],
    ["release/candidate-label-is-non-production", labelOk, null],
    [
      "release/network-namespace-is-loopback-only",
      names.length > 0 && names.every((name) => name === LOOPBACK_INTERFACE),
      names.join(",") || "none observed",
    ],
  ].map(([name, ok, detail]) => ({ name, ok: Boolean(ok), detail }));
}

/**
 * Assembles the record from an ALLOWLIST: every top-level field is named here,
 * and nothing is spread in from an observation object. The behavioral blocks
 * are exactly HLS-08's, under the same names.
 */
export function buildHlsReleaseEvidence(input) {
  const record = {
    schema: HLS09_RELEASE_EVIDENCE_SCHEMA,
    verdict: input.verdict,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    source: releaseSource(input.source),
    image: {
      candidateTag: stringOrNull(input.image?.candidateTag),
      imageId: stringOrNull(input.image?.imageId),
      runSubject: stringOrNull(input.image?.runSubject),
      builtFromDockerfile: RELEASE_DOCKERFILE,
      deployable: false,
      identityAuthority:
        "the SPLIT-07 parent built the image, inspected its immutable id and handed that id to Docker as this " +
        "container's run subject; this child records those observations and cannot introspect Docker itself",
    },
    network: {
      mode: "none",
      observedInterfaceNames: Array.isArray(input.network?.observedInterfaceNames)
        ? [...input.network.observedInterfaceNames].sort()
        : [],
      fixtureBind: input.network?.fixtureBind,
      fixturePort: input.network?.fixturePort,
      acceptanceHostMappings: 1,
      publicHostsContacted: 0,
    },
    substitutions: { ...HLS08_SUBSTITUTIONS },
    nonClaims: [...HLS09_NON_CLAIMS],
    toolchain: input.toolchain,
    invariants: input.invariants,
    fixture: input.fixture,
    fixtureToolUse: input.fixtureToolUse,
    discovery: input.discovery,
    publicAnalysis: input.publicAnalysis,
    executionAnalysis: input.executionAnalysis,
    freshProvenance: input.freshProvenance,
    plan: input.plan,
    workspace: input.workspace,
    hls2: input.hls2,
    hls3: input.hls3,
    aggregate: input.aggregate,
    lifecycle: input.lifecycle,
    productMediaToolUse: input.productMediaToolUse,
    remux: input.remux,
    output: input.output,
    upload: input.upload,
    ready: input.ready,
    fixtureRequests: input.fixtureRequests,
    privacy: input.privacy,
    cleanup: input.cleanup,
    negativeCases: input.negativeCases,
    openNotes: input.openNotes,
    checks: input.checks,
  };

  if (record.verdict !== "PASS" && record.verdict !== "FAIL" && record.verdict !== "BLOCKED") {
    throw new Error("the verdict must be PASS, FAIL or BLOCKED");
  }
  if (record.verdict === "PASS") {
    const unmet = unmetPassConditions(record.checks, HLS09_MANDATORY_CHECKS);
    if (unmet.length > 0) {
      throw new Error(`refusing to emit a PASS ${HLS09_RELEASE_EVIDENCE_SCHEMA} record: ${unmet.join("; ")}`);
    }
  }

  // The same privacy gates as HLS-08 `-02`, unrelaxed: a forbidden key reaching
  // an allowlist is a producer bug and must be loud; then no private marker,
  // raw upstream id, fixture hostname, URL, `sig=`, temporary path or playlist
  // name may appear in any key or value.
  const forbiddenKey = findForbiddenKey(record);
  if (forbiddenKey !== null) {
    throw new Error(`refusing to emit an evidence record containing a '${forbiddenKey}' field`);
  }
  const cleaned = stripForbiddenKeys(record);
  const leak = findForbiddenSubstring(cleaned);
  if (leak !== null) {
    throw new Error(`refusing to emit an evidence record containing private HLS material (at ${leak})`);
  }
  return cleaned;
}

/** One deterministic JSON document, pretty-printed for review. */
export function renderHlsReleaseEvidence(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * The SPLIT-07 parent's validation of a PARSED child record against its own
 * observations. Returns the problems; an empty list means the record is a
 * valid PASS naming exactly the release source and the candidate image.
 *
 * `expected`: { sourceCommit, sourceTree, candidateTag, candidateImageId }.
 */
export function validateHlsReleaseChildRecord(record, expected) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["the record is not an object"];
  const problems = [];
  if (record.schema !== HLS09_RELEASE_EVIDENCE_SCHEMA) {
    problems.push(`schema is ${String(record.schema)}, not ${HLS09_RELEASE_EVIDENCE_SCHEMA}`);
  }
  if (record.verdict !== "PASS") problems.push(`verdict is ${String(record.verdict)}, not PASS`);
  const checks = Array.isArray(record.checks) ? record.checks : [];
  const failed = checks.filter((check) => check?.ok !== true).length;
  if (checks.length === 0) problems.push("the record carries no checks");
  else if (failed > 0) problems.push(`${failed} of ${checks.length} checks did not pass`);
  const unmet = unmetPassConditions(checks, HLS09_MANDATORY_CHECKS).filter((reason) => !reason.endsWith(": failed"));
  if (unmet.length > 0) problems.push(`mandatory checks absent or duplicated: ${unmet.length}`);
  if (record.source?.commit !== expected.sourceCommit) problems.push("source commit is not the release source");
  if (record.source?.tree !== expected.sourceTree) problems.push("source tree is not the release tree");
  if (record.source?.contextClean !== true) problems.push("source context not asserted clean");
  if (record.image?.imageId !== expected.candidateImageId) problems.push("candidate image id is not the parent's");
  if (record.image?.runSubject !== expected.candidateImageId) problems.push("run image id is not the parent's candidate id");
  if (record.image?.candidateTag !== expected.candidateTag) problems.push("candidate label is not the parent's build tag");
  if (record.image?.deployable !== false) problems.push("candidate not marked non-deployable");
  if (record.network?.mode !== "none") problems.push("network mode is not none");
  const key = findForbiddenKey(record);
  if (key !== null) problems.push("a forbidden raw-material key is present");
  const leak = findForbiddenSubstring(record);
  if (leak !== null) problems.push("private HLS material is present");
  return problems;
}

/**
 * The `source` block: the release identity the PARENT verified — before and
 * after the real build — and handed to this child. A record naming an
 * unverified or abbreviated source would be a false statement, so none is
 * produced, PASS or FAIL.
 */
function releaseSource(source) {
  const verified =
    source !== null &&
    typeof source === "object" &&
    isFullGitSha(source.commit) &&
    isFullGitSha(source.tree) &&
    source.contextClean === true;
  if (!verified) {
    throw new Error(`refusing to emit a ${HLS09_RELEASE_EVIDENCE_SCHEMA} record without parent-verified release source identity`);
  }
  return {
    commit: source.commit,
    tree: source.tree,
    contextClean: true,
    verifiedBy:
      "run-release-image-acceptance.mjs: git against the release build context, before and after the real " +
      "Dockerfile.worker build",
  };
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
