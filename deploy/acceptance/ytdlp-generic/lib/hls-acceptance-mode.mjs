// The clear-HLS orchestrator's two acceptance MODES, and the only place they
// differ: identity and the record that identity goes into.
//
//   overlay        HLS-08. The candidate SOURCE overlaid on the accepted
//                  historical runtime (`run-hls-acceptance.mjs`). Identity is
//                  the source commit/tree, the accepted historical base source
//                  and digest, and the overlay image. Record:
//                  `hls08-deterministic-full-path-02`, unchanged.
//   release-image  HLS-09. The ACTUAL `Dockerfile.worker` release candidate,
//                  launched by the SPLIT-07 parent
//                  (`run-release-image-acceptance.mjs`). Identity is the release
//                  source commit/tree, the parent's source-context-clean
//                  assertion, the candidate build label, the candidate immutable
//                  image id and the run subject Docker executed. Record:
//                  `hls09-release-image-full-path-01`.
//
// The behavioral run — real analysis, real yt-dlp discovery, the ordinary
// planner, HLS-2/3/4, the upload lifecycle, `ready`, the three negatives — is
// ONE implementation in `hls-full-path.mjs`, identical in both modes.
//
// The mode is EXPLICIT (`--acceptance-mode`), required exactly once, and never
// inferred from which identity flags happen to be present. A flag belonging to
// the other mode is a refusal, not something to ignore: mixed identity fails
// closed before anything runs.
//
// Pure and import-free apart from the harness's own import-free modules, so the
// self-tests exercise it without the Product.

import {
  HLS08_ACCEPTED_BASE,
  HLS_ACCEPTANCE_MODES,
  HLS_ACCEPTANCE_MODE_FLAG,
  assertNonDeployableTag,
} from "./hls-container.mjs";
import { HLS08_EVIDENCE_SCHEMA, buildHlsEvidence, renderHlsEvidence } from "./hls-evidence.mjs";
import {
  HLS09_RELEASE_EVIDENCE_SCHEMA,
  buildHlsReleaseEvidence,
  releaseIdentityChecks,
  renderHlsReleaseEvidence,
} from "./hls-release-evidence.mjs";
import { isFullGitSha } from "./split-provenance.mjs";

/** Value flags every mode takes. */
const SHARED_VALUE_FLAGS = Object.freeze({
  "--evidence": "evidence",
  "--source-commit": "sourceCommit",
  "--source-tree": "sourceTree",
});

/** Switches every mode takes. */
const SHARED_SWITCHES = Object.freeze({
  "--source-context-clean": "sourceContextClean",
});

/** HLS-08 overlay identity: the accepted historical base and the overlay. */
const OVERLAY_VALUE_FLAGS = Object.freeze({
  "--accepted-base-source": "acceptedBaseSource",
  "--base-image": "baseImage",
  "--base-digest": "baseDigest",
  "--overlay-image": "overlayImage",
  "--overlay-image-id": "overlayImageId",
});
const OVERLAY_SWITCHES = Object.freeze({
  "--overlay-runtime-compatible": "overlayRuntimeCompatible",
});

/** HLS-09 release identity: the candidate the SPLIT-07 parent built and ran. */
const RELEASE_VALUE_FLAGS = Object.freeze({
  "--candidate-tag": "candidateTag",
  "--candidate-image-id": "candidateImageId",
  "--run-image-id": "runImageId",
});

const MODE_FLAGS = Object.freeze({
  [HLS_ACCEPTANCE_MODES.overlay]: { values: OVERLAY_VALUE_FLAGS, switches: OVERLAY_SWITCHES },
  [HLS_ACCEPTANCE_MODES.releaseImage]: { values: RELEASE_VALUE_FLAGS, switches: {} },
});

/** The record each mode emits, by schema. */
export const HLS_MODE_EVIDENCE_SCHEMAS = Object.freeze({
  [HLS_ACCEPTANCE_MODES.overlay]: HLS08_EVIDENCE_SCHEMA,
  [HLS_ACCEPTANCE_MODES.releaseImage]: HLS09_RELEASE_EVIDENCE_SCHEMA,
});

/**
 * Parses the orchestrator's argv into `{ mode, ... }`.
 *
 * Refuses: a missing, repeated or unknown mode; an unknown flag; any flag given
 * twice; any flag belonging to the OTHER mode; and a missing or non-SHA
 * identity value for the named mode. The overlay result carries exactly the
 * fields HLS-08's parser always produced.
 */
export function parseHlsAcceptanceArgv(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const allValueFlags = { ...SHARED_VALUE_FLAGS, ...OVERLAY_VALUE_FLAGS, ...RELEASE_VALUE_FLAGS };
  const allSwitches = { ...SHARED_SWITCHES, ...OVERLAY_SWITCHES };
  const seen = new Set();
  const values = {};
  const switches = {};
  let mode = null;

  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (seen.has(arg)) throw new Error(`${arg} may be given only once`);
    seen.add(arg);
    if (arg === HLS_ACCEPTANCE_MODE_FLAG) {
      const value = list[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      mode = value;
      i += 1;
      continue;
    }
    if (Object.hasOwn(allValueFlags, arg)) {
      const value = list[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      values[arg] = value;
      i += 1;
      continue;
    }
    if (Object.hasOwn(allSwitches, arg)) {
      switches[arg] = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (mode === null) {
    throw new Error(
      `${HLS_ACCEPTANCE_MODE_FLAG} is required: ${Object.values(HLS_ACCEPTANCE_MODES).join(" or ")}`,
    );
  }
  if (!Object.hasOwn(MODE_FLAGS, mode)) {
    throw new Error(`unknown ${HLS_ACCEPTANCE_MODE_FLAG}: ${mode}`);
  }

  // Mixed identity fails closed: a flag of the OTHER mode is never ignored.
  for (const [otherMode, flags] of Object.entries(MODE_FLAGS)) {
    if (otherMode === mode) continue;
    for (const flag of [...Object.keys(flags.values), ...Object.keys(flags.switches)]) {
      if (seen.has(flag)) {
        throw new Error(`mixed acceptance identity: ${flag} belongs to ${otherMode} mode, not ${mode}`);
      }
    }
  }

  const own = MODE_FLAGS[mode];
  const out = { mode };
  for (const [flag, key] of Object.entries({ ...SHARED_VALUE_FLAGS, ...own.values })) out[key] = values[flag] ?? null;
  for (const [flag, key] of Object.entries({ ...SHARED_SWITCHES, ...own.switches })) out[key] = switches[flag] === true;

  if (!out.evidence) throw new Error("--evidence <path> is required");
  if (mode === HLS_ACCEPTANCE_MODES.overlay) {
    for (const [flag, key] of [
      ["--source-commit", "sourceCommit"],
      ["--source-tree", "sourceTree"],
      ["--accepted-base-source", "acceptedBaseSource"],
    ]) {
      if (!isFullGitSha(out[key])) throw new Error(`${flag} must be the full 40-hex value the driver observed`);
    }
    if (!out.sourceContextClean || !out.overlayRuntimeCompatible) {
      throw new Error("the build context was not verified clean and runtime-compatible by run-hls-acceptance.mjs");
    }
    for (const key of ["baseImage", "baseDigest", "overlayImage", "overlayImageId"]) {
      if (!out[key]) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
    }
    return out;
  }
  for (const [flag, key] of [
    ["--source-commit", "sourceCommit"],
    ["--source-tree", "sourceTree"],
  ]) {
    if (!isFullGitSha(out[key])) throw new Error(`${flag} must be the full 40-hex value the SPLIT-07 parent observed`);
  }
  if (!out.sourceContextClean) {
    throw new Error("the release context was not verified clean by run-release-image-acceptance.mjs");
  }
  for (const key of ["candidateTag", "candidateImageId", "runImageId"]) {
    if (!out[key]) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return out;
}

/**
 * The mode's identity checks, as ledger entries in their mandatory order.
 *
 * Overlay: HLS-08's four checks, with exactly the logic and details HLS-08
 * always recorded. Release: `releaseIdentityChecks` — no historical-base or
 * overlay assertion at all.
 */
export function acceptanceIdentityChecks(opts, observed = {}) {
  if (opts?.mode === HLS_ACCEPTANCE_MODES.overlay) {
    let overlayNonDeployable = false;
    try {
      assertNonDeployableTag(opts.overlayImage);
      overlayNonDeployable = /^sha256:[0-9a-f]{64}$/.test(opts.overlayImageId) && opts.overlayImageId !== opts.baseDigest;
    } catch {
      overlayNonDeployable = false;
    }
    return [
      [
        "provenance/driver-verified-source",
        isFullGitSha(opts.sourceCommit) && isFullGitSha(opts.sourceTree) && opts.sourceContextClean && opts.overlayRuntimeCompatible,
      ],
      ["image/accepted-base-digest-is-the-recorded-runtime", opts.baseDigest === HLS08_ACCEPTED_BASE.imageDigest],
      ["image/accepted-base-source-is-the-recorded-runtime", opts.acceptedBaseSource === HLS08_ACCEPTED_BASE.sourceCommit],
      ["image/overlay-is-non-deployable", overlayNonDeployable],
    ].map(([name, ok]) => ({ name, ok: Boolean(ok), detail: null }));
  }
  if (opts?.mode === HLS_ACCEPTANCE_MODES.releaseImage) {
    return releaseIdentityChecks(opts, { networkInterfaceNames: observed.networkInterfaceNames });
  }
  throw new Error(`unknown acceptance mode: ${String(opts?.mode)}`);
}

/**
 * The mode's record. `behavioral` carries every block the orchestrator
 * measured — identical in both modes — plus `verdict`, timestamps, the fixture
 * network facts and the check ledger; this function adds only the identity.
 */
export function buildAcceptanceEvidence(opts, behavioral, observed = {}) {
  const { network, ...rest } = behavioral;
  if (opts?.mode === HLS_ACCEPTANCE_MODES.overlay) {
    return buildHlsEvidence({
      ...rest,
      network,
      source: {
        commit: opts.sourceCommit,
        tree: opts.sourceTree,
        contextClean: opts.sourceContextClean,
        acceptedBaseSourceCommit: opts.acceptedBaseSource,
        overlayRuntimeCompatibilityVerified: opts.overlayRuntimeCompatible,
      },
      image: {
        acceptedBaseImage: opts.baseImage,
        acceptedBaseDigest: opts.baseDigest,
        overlayImage: opts.overlayImage,
        overlayImageId: opts.overlayImageId,
      },
    });
  }
  if (opts?.mode === HLS_ACCEPTANCE_MODES.releaseImage) {
    return buildHlsReleaseEvidence({
      ...rest,
      network: { ...network, observedInterfaceNames: observed.networkInterfaceNames ?? [] },
      source: { commit: opts.sourceCommit, tree: opts.sourceTree, contextClean: opts.sourceContextClean },
      image: { candidateTag: opts.candidateTag, imageId: opts.candidateImageId, runSubject: opts.runImageId },
    });
  }
  throw new Error(`unknown acceptance mode: ${String(opts?.mode)}`);
}

/** Renders the mode's record. Both renderings are the same deterministic JSON. */
export function renderAcceptanceEvidence(opts, record) {
  return opts?.mode === HLS_ACCEPTANCE_MODES.releaseImage ? renderHlsReleaseEvidence(record) : renderHlsEvidence(record);
}

/** Which driver removes the image this mode ran in — a cleanup fact, per mode. */
export function imageRemovalFact(opts) {
  return opts?.mode === HLS_ACCEPTANCE_MODES.releaseImage
    ? { candidateRemovedBy: "run-release-image-acceptance.mjs unless --keep-image" }
    : { overlayRemovedBy: "run-hls-acceptance.mjs unless --keep-image" };
}

/** A short console label for the mode's summary line. */
export function acceptanceLabel(opts) {
  return opts?.mode === HLS_ACCEPTANCE_MODES.releaseImage ? "hls09" : "hls08";
}
