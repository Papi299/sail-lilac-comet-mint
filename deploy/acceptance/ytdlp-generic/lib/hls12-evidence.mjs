// The HLS-12 release-image separate-audio child record
// (HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001).
//
// Pure. The orchestrator (`hls12-full-path.mjs`) decides WHERE the record goes;
// this module decides what may be in it, refuses to emit a PASS the record
// itself does not earn, and refuses to emit anything that leaks. The SPLIT-07
// parent re-reads the exact bytes and validates them here too
// (`validateHls12ReleaseChildRecord`).
//
// ── What a PASS claims ─────────────────────────────────────────────────────
//
// Inside the ACTUAL release candidate image, offline, against deterministic
// local fixtures of real media: for three pairs of a video-only fMP4 HLS
// rendition and the ONE audio-only fMP4 rendition of the AUDIO group its
// variant names — audio presented ~0.48 s after the video, video presented
// ~0.52 s after the audio, and a control whose halves both start at exactly 0
// — the candidate's own source proved the pair from a Master Playlist it
// fetched ITSELF during analysis (one request, no redirect, while the job said
// `analyzing`), advertised preset:1080 with nothing withheld, planned the
// private separate-audio operation, preflighted both media playlists and
// acquired the video half and then the audio half through the real safe-HTTP
// stack while the job said `downloading`, and — after `beginProcessing()` —
// probed both halves and merged them with ONE FFmpeg stream copy whose
// synchronization reference was the earlier-starting input, into a faststart
// MP4 that was uploaded and reached `ready`. The harness measured every pair's
// source timing BEFORE the job, and the delivered file preserves it within a
// tolerance derived from the time bases, with every packet payload identical;
// the control equals the historical merge byte for byte. Four master negatives
// (an ambiguous group, a variant naming no group beside a convenient one, a
// redirecting master, a master that re-signed the video URL) advertised
// nothing, and five execution negatives (an MPEG-TS audio half, a muxed
// "video" half, a video "audio" half, the one shared byte budget, a 404 audio
// map) failed closed before any upload.
//
// Import-free apart from the harness's own import-free modules, so the parent
// validates a record on an older Node.

import { FORBIDDEN_EVIDENCE_KEYS, stripForbiddenKeys } from "./evidence.mjs";
import { unmetPassConditions } from "./hls-evidence.mjs";
import { HLS09_RELEASE_IDENTITY_CHECKS } from "./hls-release-evidence.mjs";
import { RELEASE_DOCKERFILE } from "./release-container.mjs";
import { isFullGitSha } from "./split-provenance.mjs";
import {
  HLS12_EXECUTION_NEGATIVE_CASES,
  HLS12_MASTER_NEGATIVE_CASES,
  HLS12_POSITIVE_CASES,
} from "./hls12-fixture-url.mjs";

/**
 * The schema identifier. Bump it when the record's meaning changes; never
 * rewrite an older record.
 *
 *   -01  the first separate-audio release child: three positive pairs (audio
 *        late, video late, a zero-aligned control), four master-proof
 *        negatives and five execution negatives.
 */
export const HLS12_RELEASE_EVIDENCE_SCHEMA = "hls12-release-image-separate-audio-01";

export { HLS12_EXECUTION_NEGATIVE_CASES, HLS12_MASTER_NEGATIVE_CASES, HLS12_POSITIVE_CASES };

export const HLS12_PREFLIGHT_CHECKS = Object.freeze([
  "preflight/node-runtime-family",
  "preflight/ytdlp-available",
  "preflight/ytdlp-exact-pin",
  "preflight/ffmpeg-path-is-the-worker-ffmpeg",
  "preflight/ffmpeg-executes",
  "preflight/ffprobe-is-the-ffmpeg-sibling",
  "preflight/ffprobe-executes",
]);

export const HLS12_INVARIANT_CHECKS = Object.freeze([
  "invariants/generic-source-protocols-reviewed-vocabulary",
  "invariants/master-grammar-is-the-closed-five-tag-vocabulary",
  "invariants/master-proof-bounds",
  "invariants/harness-file-names-match-the-product",
  "invariants/merge-argv-carries-the-shared-sync-policy",
]);

export const HLS12_FIXTURE_CHECKS = Object.freeze([
  "fixture/video-halves-are-1920x1080-h264-video-only-iso-bmff",
  "fixture/audio-halves-are-aac-audio-only-iso-bmff",
  "fixture/negative-renditions-have-their-stated-shapes",
  "fixture/inits-are-ftyp-moov-and-fragments-are-moof-mdat",
  "fixture/recipes-are-bit-exact",
  "fixture/media-playlists-are-the-v2-grammar",
  "fixture/masters-are-the-closed-master-grammar",
  "fixture/service-binds-loopback-only",
  "validator/admits-exactly-the-case-pages",
  "validator/refuses-every-nearby-alternative",
  "transport/no-refused-request",
  "fixture/no-unexpected-route",
  "fixture/no-range-request",
  "privacy/no-private-material-in-process-output",
]);

/** The source timing of every pair, measured by the harness BEFORE any job. */
export const HLS12_TIMING_CHECKS = Object.freeze([
  "timing/audio-late-pair-is-discriminating",
  "timing/video-late-pair-is-discriminating",
  "timing/control-pair-is-exactly-zero-aligned",
  "timing/oracle-detects-per-input-zeroing",
]);

/** Every check each positive case records, un-prefixed. */
export const HLS12_CASE_CHECKS = Object.freeze([
  "analysis/advertises-preset-1080-and-best",
  "analysis/separate-preset-facts",
  "analysis/source-quality-1080-deliverable-nothing-withheld",
  "analysis/public-metadata-omits-private-material",
  "analysis/pinned-ytdlp-exposes-no-pairing-relationship",
  "analysis/ytdlp-read-only-page-and-master",
  "analysis/product-fetched-only-the-master-once",
  "executor/only-the-fresh-analysis-seam-injected",
  "execution/separate-map-owns-1080",
  "plan/clear-hls-separate-audio-remux-to-mp4",
  "acquisition/master-then-playlists-then-video-then-audio",
  "acquisition/each-resource-requested-exactly-once",
  "acquisition/one-request-at-a-time",
  "acquisition/fixed-product-request-profile",
  "acquisition/halves-are-the-exact-concatenations",
  "processing/both-halves-probed-through-mov-before-the-merge",
  "processing/one-ffmpeg-stream-copy-no-overwrite-of-both-halves",
  "processing/sync-reference-is-the-earlier-input",
  "processing/output-probe-ran",
  "lifecycle/durable-trace",
  "lifecycle/master-proof-while-analyzing",
  "lifecycle/every-media-request-while-downloading",
  "lifecycle/no-media-tool-while-downloading",
  "lifecycle/media-tools-only-while-processing",
  "lifecycle/no-ytdlp-after-execution-analysis",
  "lifecycle/upload-while-uploading",
  "workspace/acquisition-peak-within-the-two-halves",
  "workspace/processing-peak-within-halves-plus-output",
  "output/container-is-a-faststart-mp4",
  "output/exactly-one-h264-video-and-one-aac-audio",
  "output/resolution-is-1920x1080",
  "output/duration-matches-the-pair-span",
  "output/size-positive-and-within-the-limit",
  "output/packet-payloads-identical",
  "timing/relative-offset-preserved-within-the-time-base-tolerance",
  "upload/exactly-one-put-of-the-merged-mp4",
  "ready/final-status-ready-with-matching-metadata",
  "privacy/no-private-material-on-any-public-or-durable-surface",
  "cleanup/job-workdir-removed",
]);

/** The control's own extra check: a zero-aligned pair merges exactly as it always did. */
export const HLS12_CONTROL_CHECKS = Object.freeze(["ctl-aligned/output/identical-to-the-historical-merge"]);

/** Every check each master negative records, un-prefixed. */
export const HLS12_MASTER_NEGATIVE_COMMON_CHECKS = Object.freeze([
  "pinned-ytdlp-exposes-a-video-only-rendition",
  "no-hls-video-preset-advertised",
  "separate-selections-empty",
  "source-quality-withholds-unsupported-protocol-at-1080",
  "plan-refuses-preset-1080",
  "product-requested-only-the-master",
]);

export const HLS12_MASTER_NEGATIVE_CHECKS = Object.freeze([
  ...HLS12_MASTER_NEGATIVE_CASES.flatMap((caseName) =>
    HLS12_MASTER_NEGATIVE_COMMON_CHECKS.map((name) => `${caseName}/${name}`),
  ),
  "neg-ambiguous-group/master-group-has-two-uri-renditions",
  "neg-no-audio-group/variant-names-no-group-beside-an-unreferenced-one",
  "neg-master-redirect/product-got-a-redirect-and-followed-nothing",
  "neg-master-changed/product-master-names-only-a-re-signed-video-url",
]);

/** The execution negatives and what each must record. */
export const HLS12_EXECUTION_NEGATIVE_CHECKS = Object.freeze([
  "neg-audio-ts/format-unavailable",
  "neg-audio-ts/no-upload-never-ready",
  "neg-audio-ts/workdir-removed",
  "neg-audio-ts/only-the-two-playlists-requested",
  "neg-audio-ts/never-processing-no-media-tool",
  "neg-video-muxed/processing-failed",
  "neg-video-muxed/no-upload-never-ready",
  "neg-video-muxed/workdir-removed",
  "neg-video-muxed/refused-by-the-real-video-probe-before-any-ffmpeg",
  "neg-audio-video/processing-failed",
  "neg-audio-video/no-upload-never-ready",
  "neg-audio-video/workdir-removed",
  "neg-audio-video/refused-by-the-real-audio-probe-before-any-ffmpeg",
  "neg-budget/too-large",
  "neg-budget/no-upload-never-ready",
  "neg-budget/workdir-removed",
  "neg-budget/refused-only-because-the-halves-share-one-budget",
  "neg-budget/limit-restored",
  "neg-budget/never-processing-no-media-tool",
  "neg-audio-map-404/network-error",
  "neg-audio-map-404/no-upload-never-ready",
  "neg-audio-map-404/workdir-removed",
  "neg-audio-map-404/video-half-complete-then-no-audio-fragment",
  "neg-audio-map-404/never-processing-no-media-tool",
]);

/**
 * Every check an HLS-12 PASS requires, each present EXACTLY once and passing.
 * No partial PASS: a stage that never ran is a missing check.
 */
export const HLS12_MANDATORY_CHECKS = Object.freeze([
  ...HLS09_RELEASE_IDENTITY_CHECKS,
  ...HLS12_PREFLIGHT_CHECKS,
  ...HLS12_INVARIANT_CHECKS,
  ...HLS12_FIXTURE_CHECKS,
  ...HLS12_TIMING_CHECKS,
  ...HLS12_POSITIVE_CASES.flatMap((caseName) => HLS12_CASE_CHECKS.map((name) => `${caseName}/${name}`)),
  ...HLS12_CONTROL_CHECKS,
  ...HLS12_MASTER_NEGATIVE_CHECKS,
  ...HLS12_EXECUTION_NEGATIVE_CHECKS,
]);

/** What a PASS does not prove. Recorded verbatim in every record. */
export const HLS12_NON_CLAIMS = Object.freeze([
  "ONE separate-audio family only: a video-only fMP4 rendition plus the single URI-bearing audio-only fMP4 rendition of the AUDIO group its variant names, in a master the Product fetched itself with no redirect",
  "no MPEG-TS separate audio, no audio group with more than one rendition (no language or DEFAULT preference policy), no subtitles, I-frame playlists, content steering, session keys, encryption or byte-range media",
  "no real public HLS source, real CDN, signed-URL lifetime or public packager compatibility: the masters are hand-authored inside the candidate's closed master grammar",
  "Production SSRF/DNS/egress policy is NOT re-proven (the acceptance transport answers a synthetic public address)",
  "no real Cloudflare Tunnel/Access, Vercel, Cloudflare R2 or R2 credential broker",
  "no Production startup of this candidate, no promotion and no long-term uptime claim",
]);

/** The acceptance substitutions, stated rather than hidden. */
export const HLS12_SUBSTITUTIONS = Object.freeze({
  urlValidation: "exact-page validator (one fixture hostname, exact port, exact case pages) in place of assertSafeUrl",
  safeHttp: "safe-HTTP DNS answer and socket hooks: a synthetic public answer, then the socket re-pointed at loopback",
  productOnlyAnswers:
    "in two master negatives the fixture answers the Product's own master request (recognised by its fixed request profile) with a redirect or a re-signed master, while the pinned yt-dlp receives the ordinary master",
  objectStore: "harness local ObjectStoreWriter in place of Cloudflare R2",
  database: "a fresh temporary SQLite job store per job with a harness status-audit trigger",
});

/** Strings no record may contain anywhere, key or value. */
export const HLS12_FORBIDDEN_EVIDENCE_SUBSTRINGS = Object.freeze([
  "HLS12_PRIVATE_",
  "HLS12_RAW_",
  "HLS12_GROUP_",
  "HLS12LANG",
  "hls12-fixture.example.invalid",
  "/hls12/",
  "master.m3u8",
  "media.m3u8",
  "alt.m3u8",
  "init.mp4",
  "init_",
  ".m4s",
  "seg-",
  "127.0.0.1",
  "http://",
  "https://",
  "/tmp/videofetch",
  "/acceptance-scratch",
]);

/** The dotted path of the first forbidden KEY, or null. */
export function findHls12ForbiddenKey(value, path = "$", depth = 0) {
  if (depth > 16) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findHls12ForbiddenKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_EVIDENCE_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) return `${path}.${key}`;
      const hit = findHls12ForbiddenKey(entry, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** The dotted path of the first string (value OR key) with a forbidden substring, or null. */
export function findHls12ForbiddenSubstring(value, path = "$", depth = 0) {
  if (depth > 16) return null;
  if (typeof value === "string") {
    return HLS12_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => value.includes(needle)) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findHls12ForbiddenSubstring(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (HLS12_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => key.includes(needle))) return `${path}.<key>`;
      const hit = findHls12ForbiddenSubstring(entry, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Assembles the record from an ALLOWLIST; refuses an unearned PASS or any leak. */
export function buildHls12ReleaseEvidence(input) {
  const record = {
    schema: HLS12_RELEASE_EVIDENCE_SCHEMA,
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
    substitutions: { ...HLS12_SUBSTITUTIONS },
    nonClaims: [...HLS12_NON_CLAIMS],
    toolchain: input.toolchain ?? null,
    invariants: input.invariants ?? null,
    fixture: input.fixture ?? null,
    timing: input.timing ?? null,
    cases: input.cases ?? null,
    masterNegatives: input.masterNegatives ?? null,
    executionNegatives: input.executionNegatives ?? null,
    checks: input.checks,
  };
  if (record.verdict !== "PASS" && record.verdict !== "FAIL" && record.verdict !== "BLOCKED") {
    throw new Error("the verdict must be PASS, FAIL or BLOCKED");
  }
  if (record.verdict === "PASS") {
    const unmet = unmetPassConditions(record.checks, HLS12_MANDATORY_CHECKS);
    if (unmet.length > 0) {
      throw new Error(`refusing to emit a PASS ${HLS12_RELEASE_EVIDENCE_SCHEMA} record: ${unmet.join("; ")}`);
    }
  }
  const forbiddenKey = findHls12ForbiddenKey(record);
  if (forbiddenKey !== null) throw new Error(`refusing to emit an evidence record containing a '${forbiddenKey}' field`);
  const cleaned = stripForbiddenKeys(record);
  const leak = findHls12ForbiddenSubstring(cleaned);
  if (leak !== null) throw new Error(`refusing to emit an evidence record containing private fixture material (at ${leak})`);
  return cleaned;
}

/** One deterministic JSON document, pretty-printed for review. */
export function renderHls12ReleaseEvidence(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * The SPLIT-07 parent's validation of a PARSED child record against its own
 * observations. Returns the problems; empty means a valid PASS naming exactly
 * the release source and the candidate image.
 */
export function validateHls12ReleaseChildRecord(record, expected) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["the record is not an object"];
  const problems = [];
  if (record.schema !== HLS12_RELEASE_EVIDENCE_SCHEMA) {
    problems.push(`schema is ${String(record.schema)}, not ${HLS12_RELEASE_EVIDENCE_SCHEMA}`);
  }
  if (record.verdict !== "PASS") problems.push(`verdict is ${String(record.verdict)}, not PASS`);
  const checks = Array.isArray(record.checks) ? record.checks : [];
  const failed = checks.filter((check) => check?.ok !== true).length;
  if (checks.length === 0) problems.push("the record carries no checks");
  else if (failed > 0) problems.push(`${failed} of ${checks.length} checks did not pass`);
  const unmet = unmetPassConditions(checks, HLS12_MANDATORY_CHECKS).filter((reason) => !reason.endsWith(": failed"));
  if (unmet.length > 0) problems.push(`mandatory checks absent or duplicated: ${unmet.length}`);
  if (record.source?.commit !== expected.sourceCommit) problems.push("source commit is not the release source");
  if (record.source?.tree !== expected.sourceTree) problems.push("source tree is not the release tree");
  if (record.source?.contextClean !== true) problems.push("source context not asserted clean");
  if (record.image?.imageId !== expected.candidateImageId) problems.push("candidate image id is not the parent's");
  if (record.image?.runSubject !== expected.candidateImageId) problems.push("run image id is not the parent's candidate id");
  if (record.image?.candidateTag !== expected.candidateTag) problems.push("candidate label is not the parent's build tag");
  if (record.image?.deployable !== false) problems.push("candidate not marked non-deployable");
  if (record.network?.mode !== "none") problems.push("network mode is not none");
  if (findHls12ForbiddenKey(record) !== null) problems.push("a forbidden raw-material key is present");
  if (findHls12ForbiddenSubstring(record) !== null) problems.push("private fixture material is present");
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
    throw new Error(`refusing to emit a ${HLS12_RELEASE_EVIDENCE_SCHEMA} record without parent-verified release source identity`);
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
