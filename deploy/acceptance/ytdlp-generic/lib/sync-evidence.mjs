// The SYNC-01 release-image split-merge TIMING child record.
//
// Pure. The orchestrator (`sync-matrix.mjs`) decides WHERE the record goes;
// this module decides what may be in it, refuses to emit a PASS the record
// itself does not earn, and refuses to emit anything that leaks. The SPLIT-07
// parent re-reads the exact bytes and validates them here too
// (`validateSyncReleaseChildRecord`).
//
// ── What a PASS claims ─────────────────────────────────────────────────────
//
// SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001. Inside the ACTUAL release
// candidate image, offline: for every case of the deterministic timing matrix
// (`fixtures/sync-media.mjs`) — progressive and fragmented MP4, WebM with Opus
// and Vorbis; zero-aligned controls, legitimate relative offsets, shared
// non-zero bases, B-frame composition delay, absolute `tfdt`, edit-list
// pre-roll and encoder priming, and duration discriminators — the candidate's
// own `mergeSplitMedia` preserved the source's relative A/V timing, as measured
// from PACKET timestamps and from a DECODED sync event against an oracle
// established before the merge; carried exactly the closed synchronization
// policy the oracle derived; hid and un-hid nothing; and left every
// zero-aligned control exactly as the historical merge left it. The same
// oracle, run on the historical merge of an offset pair, reports the per-input
// zeroing — so it is shown able to fail.
//
// Import-free apart from the harness's own import-free modules, so the parent
// validates a record on an older Node.

import { FORBIDDEN_EVIDENCE_KEYS, stripForbiddenKeys } from "./evidence.mjs";
import { unmetPassConditions } from "./hls-evidence.mjs";
import { HLS09_RELEASE_IDENTITY_CHECKS } from "./hls-release-evidence.mjs";
import { RELEASE_DOCKERFILE } from "./release-container.mjs";
import { isFullGitSha } from "./split-provenance.mjs";
import { SYNC_CASES, SYNC_SENSITIVITY_CASES } from "../fixtures/sync-media.mjs";

/**
 * The schema identifier. Bump it when the record's meaning changes; never
 * rewrite an older record.
 *
 *   -01  the first split-merge timing matrix child
 *        (SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001).
 */
export const SYNC01_RELEASE_EVIDENCE_SCHEMA = "sync01-release-image-merge-timing-01";

export const SYNC01_PREFLIGHT_CHECKS = Object.freeze([
  "preflight/node-runtime-family",
  "preflight/ffmpeg-path-is-the-worker-ffmpeg",
  "preflight/ffmpeg-executes",
  "preflight/ffprobe-is-the-ffmpeg-sibling",
  "preflight/ffprobe-executes",
]);

/** The checks every case records, whatever its kind. */
export const SYNC01_COMMON_CASE_CHECKS = Object.freeze([
  "fixture/halves-generated",
  "fixture/source-timing-established-before-the-merge",
  "fixture/decoded-sync-event-measured-in-both-halves",
  "merge/product-merge-returned-the-merged-artifact",
  "merge/one-ffmpeg-merge-with-the-pre-job-sync-policy",
  "sync/payload-identical",
  "sync/codec-parameters-preserved",
  "sync/relative-offset-preserved",
  "sync/each-stream-shifted-by-one-constant",
  "sync/no-media-hidden-or-unhidden",
  "sync/no-leading-gap",
  "sync/stream-spans-preserved",
  "sync/decoded-sync-event-preserved",
]);

/** The un-prefixed checks one case must record, by its kind. */
export function syncCaseChecks(kind) {
  const extra = [];
  if (kind === "offset" || kind === "duration") extra.push("fixture/pair-carries-a-discriminating-av-offset");
  if (kind === "duration") extra.push("fixture/earlier-starting-half-is-the-shorter");
  if (kind === "control") extra.push("compat/output-identical-to-the-historical-merge");
  if (!["control", "offset", "duration"].includes(kind)) throw new Error(`unknown case kind ${String(kind)}`);
  return Object.freeze([...SYNC01_COMMON_CASE_CHECKS, ...extra]);
}

/** The oracle-sensitivity control: the historical merge of an offset pair must be DETECTED. */
export const SYNC01_SENSITIVITY_CHECKS = Object.freeze(
  SYNC_SENSITIVITY_CASES.map((name) => `oracle/detects-per-input-zeroing/${name}`),
);

/**
 * Every check a SYNC-01 PASS requires, each present EXACTLY once and passing.
 */
export const SYNC01_MANDATORY_CHECKS = Object.freeze([
  ...HLS09_RELEASE_IDENTITY_CHECKS,
  ...SYNC01_PREFLIGHT_CHECKS,
  ...SYNC_CASES.flatMap((sync) => syncCaseChecks(sync.kind).map((name) => `${sync.name}/${name}`)),
  ...SYNC01_SENSITIVITY_CHECKS,
]);

/** What a PASS does not prove. Recorded verbatim in every record. */
export const SYNC01_NON_CLAIMS = Object.freeze([
  "no acquisition: the halves are generated locally and handed to the merge primitive directly (SPLIT-06 and DASH-01 carry the full path)",
  "no real public source, site or CDN; prevalence of offset pairs in the wild is not measured",
  "no MPD presentationTimeOffset: the pinned yt-dlp does not carry it, so a source whose AdaptationSets differ only by PTO is outside this claim",
  "no player-specific rendering claim: synchronization is measured with the pinned FFmpeg's own demuxer and decoder",
  "no Production startup of this candidate, no promotion and no long-term uptime claim",
]);

/** Strings no record may contain anywhere, key or value. */
export const SYNC01_FORBIDDEN_EVIDENCE_SUBSTRINGS = Object.freeze([
  "/tmp/videofetch",
  "/acceptance-scratch",
  "http://",
  "https://",
]);

function findForbidden(value, path = "$", depth = 0) {
  if (depth > 14) return null;
  if (typeof value === "string") {
    return SYNC01_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => value.includes(needle)) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbidden(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_EVIDENCE_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) return `${path}.${key}`;
      if (SYNC01_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => key.includes(needle))) return `${path}.<key>`;
      const hit = findForbidden(entry, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Assembles the record from an ALLOWLIST. */
export function buildSyncReleaseEvidence(input) {
  const record = {
    schema: SYNC01_RELEASE_EVIDENCE_SCHEMA,
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
      publicHostsContacted: 0,
    },
    method: {
      oracle:
        "harness ffprobe packet timestamps (pts, dts, duration, discard flag, payload SHA-256) of each half before " +
        "the merge and of the merged artifact after it; per-stream shift of payload-identical packets; decoded " +
        "white-frame and 1 kHz-burst event times",
      tolerance:
        "one tick of the output video time base + one tick of the output audio time base + (MP4) one tick of the " +
        "output movie timescale, which the MP4 muxer rounds each track's start delay down to",
      historicalReference: "the main 73176b20 merge argv, run by the harness as a frozen reference only",
    },
    nonClaims: [...SYNC01_NON_CLAIMS],
    toolchain: input.toolchain ?? null,
    cases: input.cases ?? null,
    sensitivity: input.sensitivity ?? null,
    checks: input.checks,
  };

  if (record.verdict !== "PASS" && record.verdict !== "FAIL" && record.verdict !== "BLOCKED") {
    throw new Error("the verdict must be PASS, FAIL or BLOCKED");
  }
  if (record.verdict === "PASS") {
    const unmet = unmetPassConditions(record.checks, SYNC01_MANDATORY_CHECKS);
    if (unmet.length > 0) {
      throw new Error(`refusing to emit a PASS ${SYNC01_RELEASE_EVIDENCE_SCHEMA} record: ${unmet.join("; ")}`);
    }
  }
  const leak = findForbidden(record);
  if (leak !== null) throw new Error(`refusing to emit an evidence record containing forbidden material (at ${leak})`);
  return stripForbiddenKeys(record);
}

export function renderSyncReleaseEvidence(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * The SPLIT-07 parent's validation of a PARSED child record against its own
 * observations. Returns the problems; empty means a valid PASS naming exactly
 * the release source and the candidate image.
 */
export function validateSyncReleaseChildRecord(record, expected) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["the record is not an object"];
  const problems = [];
  if (record.schema !== SYNC01_RELEASE_EVIDENCE_SCHEMA) {
    problems.push(`schema is ${String(record.schema)}, not ${SYNC01_RELEASE_EVIDENCE_SCHEMA}`);
  }
  if (record.verdict !== "PASS") problems.push(`verdict is ${String(record.verdict)}, not PASS`);
  const checks = Array.isArray(record.checks) ? record.checks : [];
  const failed = checks.filter((check) => check?.ok !== true).length;
  if (checks.length === 0) problems.push("the record carries no checks");
  else if (failed > 0) problems.push(`${failed} of ${checks.length} checks did not pass`);
  const unmet = unmetPassConditions(checks, SYNC01_MANDATORY_CHECKS).filter((reason) => !reason.endsWith(": failed"));
  if (unmet.length > 0) problems.push(`mandatory checks absent or duplicated: ${unmet.length}`);
  if (record.source?.commit !== expected.sourceCommit) problems.push("source commit is not the release source");
  if (record.source?.tree !== expected.sourceTree) problems.push("source tree is not the release tree");
  if (record.source?.contextClean !== true) problems.push("source context not asserted clean");
  if (record.image?.imageId !== expected.candidateImageId) problems.push("candidate image id is not the parent's");
  if (record.image?.runSubject !== expected.candidateImageId) problems.push("run image id is not the parent's candidate id");
  if (record.image?.candidateTag !== expected.candidateTag) problems.push("candidate label is not the parent's build tag");
  if (record.image?.deployable !== false) problems.push("candidate not marked non-deployable");
  if (record.network?.mode !== "none") problems.push("network mode is not none");
  if (findForbidden(record) !== null) problems.push("forbidden material is present");
  return problems;
}

function releaseSource(source) {
  const verified =
    source !== null &&
    typeof source === "object" &&
    isFullGitSha(source.commit) &&
    isFullGitSha(source.tree) &&
    source.contextClean === true;
  if (!verified) {
    throw new Error(`refusing to emit a ${SYNC01_RELEASE_EVIDENCE_SCHEMA} record without parent-verified release source identity`);
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
