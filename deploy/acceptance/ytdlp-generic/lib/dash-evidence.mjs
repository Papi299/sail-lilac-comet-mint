// The DASH-01 release-image segmented-DASH child record.
//
// Pure. The orchestrator (`dash-full-path.mjs`) decides WHERE the record goes;
// this module decides what may be in it, refuses to emit a PASS the record
// itself does not earn, and refuses to emit anything that leaks. The SPLIT-07
// parent re-reads the exact bytes and validates them here too
// (`validateDashReleaseChildRecord`).
//
// ── What a PASS claims ─────────────────────────────────────────────────────
//
// Against a deterministic local segmented-DASH fixture, inside the ACTUAL
// release candidate image, offline: the pinned yt-dlp's native `DashSegmentsFD`
// acquired a 1920x1080 video-only rendition fragment by fragment, and a
// compatible audio half (segmented DASH, and separately progressive), through
// the real analysis, plan, split acquisition, `beginProcessing()`, real
// ffprobe input validation, the real `mergeSplitMedia` FFmpeg stream copy,
// real output validation, the upload lifecycle and `ready`; no FFmpeg or
// ffprobe ran while the durable job said `downloading`; and three bounded
// negatives (fragment-aware byte guard, combined split budget, missing
// fragment) failed closed.
//
// ── Identity ────────────────────────────────────────────────────────────────
//
// Release identity exactly as HLS-09 records it (`releaseIdentityChecks`): the
// parent built the image, inspected its immutable id and handed that id to
// Docker as this container's run subject; the child records those observations
// and the loopback-only interfaces it sees. It cannot introspect Docker.
//
// Import-free apart from the harness's own import-free modules, so the parent
// validates a record on an older Node.

import { FORBIDDEN_EVIDENCE_KEYS, stripForbiddenKeys } from "./evidence.mjs";
import { unmetPassConditions } from "./hls-evidence.mjs";
import { HLS09_RELEASE_IDENTITY_CHECKS } from "./hls-release-evidence.mjs";
import { RELEASE_DOCKERFILE } from "./release-container.mjs";
import { isFullGitSha } from "./split-provenance.mjs";

/**
 * The schema identifier. Bump it when the record's meaning changes; never
 * rewrite an older record.
 *
 *   -01  the first segmented-DASH release child (GENERIC-SEGMENTED-DASH-
 *        EXECUTION-001 review corrections): two positive pairings — segmented
 *        video + segmented audio, and segmented video + progressive audio —
 *        and three bounded negatives, all executed by the candidate image's own
 *        source and media runtime. Historical: it hashed packet PAYLOADS only
 *        and checked duration to ±0.25 s, so it could not see that the merge
 *        erased the fixture's own 83.3 ms A/V offset.
 *   -02  everything in -01, plus the synchronization oracle
 *        (SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001): before any job the
 *        harness measures each pairing's source relative A/V offset from packet
 *        timestamps and requires it to be discriminating; after the merge the
 *        delivered artifact must preserve it within the time-base tolerance,
 *        shift each stream by one constant, hide and un-hide nothing, open with
 *        no leading gap, keep each stream's span, and carry exactly the closed
 *        synchronization policy the pre-job oracle derived.
 */
export const DASH01_RELEASE_EVIDENCE_SCHEMA = "dash01-release-image-full-path-02";

/** The two positive pairings. Mirrors `DASH_CASES` in `fixtures/dash-media.mjs`. */
export const DASH01_CASES = Object.freeze(["dash-dash", "dash-progressive"]);

export const DASH01_PREFLIGHT_CHECKS = Object.freeze([
  "preflight/node-runtime-family",
  "preflight/ytdlp-available",
  "preflight/ytdlp-exact-pin",
  "preflight/ffmpeg-path-is-the-worker-ffmpeg",
  "preflight/ffmpeg-executes",
  "preflight/ffprobe-is-the-ffmpeg-sibling",
  "preflight/ffprobe-executes",
  "preflight/pinned-dash-fragment-downloader-is-dashsegments",
]);

export const DASH01_FIXTURE_CHECKS = Object.freeze([
  "fixture/video-is-1920x1080-video-only",
  "fixture/segmented-audio-is-audio-only",
  "fixture/progressive-audio-is-audio-only",
  "fixture/video-has-an-init-and-media-segments",
  "fixture/audio-has-an-init-and-media-segments",
  "fixture/recipes-are-bit-exact",
  "fixture/service-binds-loopback-only",
  "fixture/timing-oracle-established-before-the-job",
  "fixture/both-pairings-carry-a-discriminating-av-offset",
]);

/** Every check each positive case must record, un-prefixed. */
export const DASH01_CASE_CHECKS = Object.freeze([
  "analysis/strategy-is-yt-dlp",
  "analysis/advertises-preset-1080",
  "analysis/preset-1080-is-video-with-audio-in-mp4",
  "analysis/source-quality-1080-deliverable-nothing-withheld",
  "analysis/public-metadata-omits-private-material",
  "analysis/no-media-fetched-during-analysis",
  "analysis/private-selection-is-a-proven-split",
  "analysis/video-half-is-segmented-dash",
  "analysis/audio-half-has-the-expected-protocol",
  "analysis/pair-names-the-synthetic-renditions",
  "plan/merge-split-to-mp4",
  "plan/execution-reanalyzed-to-the-same-pair",
  "acquisition/one-runtime-probe-two-media-runs-video-first",
  "acquisition/pinned-policy-argv",
  "acquisition/no-merge-or-fallback-selector",
  "acquisition/video-used-the-native-dash-fragment-downloader",
  "acquisition/video-fragment-count-equals-the-manifest",
  "acquisition/audio-used-the-expected-downloader",
  "acquisition/no-postprocessor-or-other-downloader-ran",
  "acquisition/fixture-served-every-fragment-once-in-order",
  "acquisition/fragment-files-observed-on-disk",
  "acquisition/video-bytes-are-the-exact-fragment-concatenation",
  "acquisition/audio-bytes-are-the-exact-fixture",
  "acquisition/no-fragment-residue-at-processing-entry",
  "input/video-ffprobe-1920x1080-video-only",
  "input/audio-ffprobe-audio-only",
  "input/product-probed-both-inputs-before-the-merge",
  "merge/one-real-ffmpeg-stream-copy",
  "merge/sync-policy-is-the-pre-job-decision",
  "merge/merge-split-media-returned-the-merged-artifact",
  "output/container-is-mp4",
  "output/exactly-one-video-stream",
  "output/exactly-one-audio-stream",
  "output/exactly-two-streams",
  "output/resolution-is-1920x1080",
  "output/duration-matches-the-fixture",
  "output/size-positive-and-within-the-limit",
  "output/stream-copy-packet-identity",
  "output/product-validated-the-output-after-the-merge",
  "sync/relative-offset-preserved",
  "sync/each-stream-shifted-by-one-constant",
  "sync/no-media-hidden-or-unhidden",
  "sync/no-leading-gap",
  "sync/stream-spans-preserved",
  "lifecycle/durable-trace",
  "lifecycle/acquisition-only-while-downloading",
  "lifecycle/no-media-tool-while-downloading",
  "lifecycle/media-tools-only-while-processing",
  "lifecycle/sampler-saw-no-media-tool-during-acquisition",
  "lifecycle/progress-monotonic",
  "workspace/acquisition-peak-within-the-allowance",
  "workspace/acquisition-peak-within-artifacts-plus-one-fragment",
  "workspace/processing-peak-within-twice-the-limit",
  "upload/lifecycle-accepted-the-provider-head",
  "upload/uploaded-bytes-are-the-merged-bytes",
  "upload/content-type-is-video-mp4",
  "ready/final-status-ready",
  "ready/metadata-matches-the-upload",
  "privacy/no-private-material-on-any-public-surface",
  "cleanup/job-workdir-removed",
]);

/** The three bounded negatives and what each must record. */
export const DASH01_NEGATIVE_CHECKS = Object.freeze([
  "negative/fragment-guard/too-large",
  "negative/fragment-guard/stopped-inside-the-held-fragment",
  "negative/fragment-guard/audio-never-started",
  "negative/fragment-guard/never-processing-no-media-tool-no-upload",
  "negative/fragment-guard/workdir-removed",
  "negative/combined-budget/too-large",
  "negative/combined-budget/both-halves-ran",
  "negative/combined-budget/never-processing-no-media-tool-no-upload",
  "negative/combined-budget/workdir-removed",
  "negative/missing-fragment/extraction-failed",
  "negative/missing-fragment/aborted-not-skipped",
  "negative/missing-fragment/never-processing-no-media-tool-no-upload",
  "negative/missing-fragment/workdir-removed",
]);

/**
 * Every check a DASH-01 PASS requires, each present EXACTLY once and passing.
 * No partial PASS: a stage that never ran is a missing check, and a missing
 * check is a refusal, not a default.
 */
export const DASH01_MANDATORY_CHECKS = Object.freeze([
  ...HLS09_RELEASE_IDENTITY_CHECKS,
  ...DASH01_PREFLIGHT_CHECKS,
  ...DASH01_FIXTURE_CHECKS,
  ...DASH01_CASES.flatMap((caseName) => DASH01_CASE_CHECKS.map((name) => `${caseName}/${name}`)),
  ...DASH01_NEGATIVE_CHECKS,
]);

/** What a PASS does not prove. Recorded verbatim in every record. */
export const DASH01_NON_CLAIMS = Object.freeze([
  "no real public DASH source, real CDN, signed-URL lifetime or multi-Period manifest",
  "no YouTube or any other site; the supplied YouTube regression is NOT exercised or resolved here",
  "Production SSRF/DNS/egress policy is NOT re-proven (an exact-fixture URL validator stands in, loopback only)",
  "no real Cloudflare Tunnel/Access, Vercel, Cloudflare R2 or R2 credential broker",
  "no Production startup of this candidate, no promotion and no long-term uptime claim",
]);

/** The acceptance substitutions, stated rather than hidden. */
export const DASH01_SUBSTITUTIONS = Object.freeze({
  urlValidation: "exact-fixture validator (loopback, exact port, exact routes) in place of assertSafeUrl",
  objectStore: "harness local ObjectStoreWriter in place of Cloudflare R2",
  database: "a fresh temporary SQLite job store with a harness status-audit trigger",
  directAnalyzer: "the real request-shape and direct-media predicates, which route an MPD to the generic strategy",
});

/**
 * Strings no record may contain anywhere, key or value: the synthetic upstream
 * ids, any fixture route, the loopback origin, any URL, and the product's
 * temporary paths.
 */
export const DASH01_FORBIDDEN_EVIDENCE_SUBSTRINGS = Object.freeze([
  "DASH01_VIDEO_1080",
  "DASH01_AUDIO_SEGMENTED",
  "DASH01_AUDIO_PROGRESSIVE",
  "/dash01-",
  ".m4s",
  ".mpd",
  "127.0.0.1",
  "http://",
  "https://",
  "/tmp/videofetch",
  "/acceptance-scratch",
  "--format",
]);

/** The dotted path of the first forbidden KEY, or null. */
export function findDashForbiddenKey(value, path = "$", depth = 0) {
  if (depth > 14) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findDashForbiddenKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_EVIDENCE_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) return `${path}.${key}`;
      const hit = findDashForbiddenKey(entry, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** The dotted path of the first string (value OR key) with a forbidden substring, or null. */
export function findDashForbiddenSubstring(value, path = "$", depth = 0) {
  if (depth > 14) return null;
  if (typeof value === "string") {
    return DASH01_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => value.includes(needle)) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findDashForbiddenSubstring(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (DASH01_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => key.includes(needle))) return `${path}.<key>`;
      const hit = findDashForbiddenSubstring(entry, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Assembles the record from an ALLOWLIST: every top-level field is named here,
 * nothing is spread in from an observation object.
 */
export function buildDashReleaseEvidence(input) {
  const record = {
    schema: DASH01_RELEASE_EVIDENCE_SCHEMA,
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
      fixtureBind: "loopback",
      publicHostsContacted: 0,
    },
    substitutions: { ...DASH01_SUBSTITUTIONS },
    nonClaims: [...DASH01_NON_CLAIMS],
    toolchain: input.toolchain ?? null,
    fixture: input.fixture ?? null,
    cases: input.cases ?? null,
    negativeCases: input.negativeCases ?? null,
    checks: input.checks,
  };

  if (record.verdict !== "PASS" && record.verdict !== "FAIL" && record.verdict !== "BLOCKED") {
    throw new Error("the verdict must be PASS, FAIL or BLOCKED");
  }
  if (record.verdict === "PASS") {
    const unmet = unmetPassConditions(record.checks, DASH01_MANDATORY_CHECKS);
    if (unmet.length > 0) {
      throw new Error(`refusing to emit a PASS ${DASH01_RELEASE_EVIDENCE_SCHEMA} record: ${unmet.join("; ")}`);
    }
  }

  // A forbidden key reaching an allowlist is a producer bug: loud. Then no
  // synthetic id, route, origin, URL or temporary path may appear anywhere.
  const forbiddenKey = findDashForbiddenKey(record);
  if (forbiddenKey !== null) {
    throw new Error(`refusing to emit an evidence record containing a '${forbiddenKey}' field`);
  }
  const cleaned = stripForbiddenKeys(record);
  const leak = findDashForbiddenSubstring(cleaned);
  if (leak !== null) {
    throw new Error(`refusing to emit an evidence record containing private fixture material (at ${leak})`);
  }
  return cleaned;
}

/** One deterministic JSON document, pretty-printed for review. */
export function renderDashReleaseEvidence(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * The SPLIT-07 parent's validation of a PARSED child record against its own
 * observations. Returns the problems; an empty list means the record is a valid
 * PASS naming exactly the release source and the candidate image.
 *
 * `expected`: { sourceCommit, sourceTree, candidateTag, candidateImageId }.
 */
export function validateDashReleaseChildRecord(record, expected) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["the record is not an object"];
  const problems = [];
  if (record.schema !== DASH01_RELEASE_EVIDENCE_SCHEMA) {
    problems.push(`schema is ${String(record.schema)}, not ${DASH01_RELEASE_EVIDENCE_SCHEMA}`);
  }
  if (record.verdict !== "PASS") problems.push(`verdict is ${String(record.verdict)}, not PASS`);
  const checks = Array.isArray(record.checks) ? record.checks : [];
  const failed = checks.filter((check) => check?.ok !== true).length;
  if (checks.length === 0) problems.push("the record carries no checks");
  else if (failed > 0) problems.push(`${failed} of ${checks.length} checks did not pass`);
  const unmet = unmetPassConditions(checks, DASH01_MANDATORY_CHECKS).filter((reason) => !reason.endsWith(": failed"));
  if (unmet.length > 0) problems.push(`mandatory checks absent or duplicated: ${unmet.length}`);
  if (record.source?.commit !== expected.sourceCommit) problems.push("source commit is not the release source");
  if (record.source?.tree !== expected.sourceTree) problems.push("source tree is not the release tree");
  if (record.source?.contextClean !== true) problems.push("source context not asserted clean");
  if (record.image?.imageId !== expected.candidateImageId) problems.push("candidate image id is not the parent's");
  if (record.image?.runSubject !== expected.candidateImageId) problems.push("run image id is not the parent's candidate id");
  if (record.image?.candidateTag !== expected.candidateTag) problems.push("candidate label is not the parent's build tag");
  if (record.image?.deployable !== false) problems.push("candidate not marked non-deployable");
  if (record.network?.mode !== "none") problems.push("network mode is not none");
  if (findDashForbiddenKey(record) !== null) problems.push("a forbidden raw-material key is present");
  if (findDashForbiddenSubstring(record) !== null) problems.push("private fixture material is present");
  return problems;
}

/**
 * The `source` block: the release identity the PARENT verified and handed to
 * this child. A record naming an unverified or abbreviated source would be a
 * false statement, so none is produced, PASS or FAIL.
 */
function releaseSource(source) {
  const verified =
    source !== null &&
    typeof source === "object" &&
    isFullGitSha(source.commit) &&
    isFullGitSha(source.tree) &&
    source.contextClean === true;
  if (!verified) {
    throw new Error(`refusing to emit a ${DASH01_RELEASE_EVIDENCE_SCHEMA} record without parent-verified release source identity`);
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
