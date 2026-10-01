// The HLS-11 release-image clear-HLS v2 child record
// (HLS-V2-ADAPTIVE-VOD-EXPANSION-001).
//
// Pure. The orchestrator (`hls11-full-path.mjs`) decides WHERE the record goes;
// this module decides what may be in it, refuses to emit a PASS the record
// itself does not earn, and refuses to emit anything that leaks. The SPLIT-07
// parent re-reads the exact bytes and validates them here too
// (`validateHls11ReleaseChildRecord`).
//
// ── What a PASS claims ─────────────────────────────────────────────────────
//
// Inside the ACTUAL release candidate image, offline, against deterministic
// local fixtures of real media: a 1920x1080 MPEG-TS rendition (the v1 control)
// and a 1920x1080 fMP4 rendition (init + fragments) each went from real
// pinned-yt-dlp analysis through the ordinary planner, the real HLS-2 preflight,
// the real HLS-3 acquisition (the map first for fMP4), `beginProcessing()`, the
// real ffprobe through that family's explicit demuxer, ONE real FFmpeg stream
// copy and real output validation, to upload and `ready`; every HLS request
// happened while the job said `downloading` and every ffprobe/FFmpeg process
// while it said `processing`; the delivered MP4 is one H.264 1920x1080 video
// and one AAC audio stream, faststart, of the fixture's duration, within the
// limit, with its packets preserved. The fMP4 playlist was the pinned
// packager's own `#EXT-X-VERSION:7` + `#EXT-X-INDEPENDENT-SEGMENTS` output, and
// the candidate's parser admitted it into the same model as without that
// declaration. Eight bounded negatives failed closed before any upload —
// three of them grammar refusals (version 5, no version, a valued
// independent-segments line) before the map was requested — and a split
// master proved, against the candidate's own pinned yt-dlp, that separate HLS
// audio is exposed with no pairing relationship and is therefore not
// advertised.
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
 *   -01  the first clear-HLS v2 release child: the v1 MPEG-TS control and the
 *        v2 muxed-fMP4 positive (version 7 + independent segments, as the
 *        pinned packager writes them), the grammar checks, eight fail-closed
 *        negatives, and the split-master pairing-provenance case. Split HLS
 *        audio is NOT a positive case: it was not implemented, because pairing
 *        provenance is insufficient.
 *
 *        Its mandatory set was corrected inside unmerged PR #105 (the fMP4
 *        version gate and the independent-segments admission) without a bump:
 *        no merged or deployed release had consumed an `-01` record, and every
 *        record names the exact source commit and tree it ran.
 */
export const HLS11_RELEASE_EVIDENCE_SCHEMA = "hls11-release-image-full-path-01";

/** The two positive cases, in run order. */
export const HLS11_POSITIVE_CASES = Object.freeze(["v1-ts", "v2-fmp4"]);

export const HLS11_PREFLIGHT_CHECKS = Object.freeze([
  "preflight/node-runtime-family",
  "preflight/ytdlp-available",
  "preflight/ytdlp-exact-pin",
  "preflight/ffmpeg-path-is-the-worker-ffmpeg",
  "preflight/ffmpeg-executes",
  "preflight/ffprobe-is-the-ffmpeg-sibling",
  "preflight/ffprobe-executes",
]);

export const HLS11_INVARIANT_CHECKS = Object.freeze([
  "invariants/generic-source-protocols-reviewed-vocabulary",
  "invariants/v2-grammar-admits-exactly-the-map-and-independent-segments",
  "invariants/harness-file-names-match-the-product",
  "invariants/remux-argvs-differ-only-in-the-demuxer",
]);

export const HLS11_FIXTURE_CHECKS = Object.freeze([
  "fixture/ts-is-1920x1080-h264-aac-mpegts",
  "fixture/fmp4-is-1920x1080-h264-aac-iso-bmff",
  "fixture/fmp4-video-only-is-video-only",
  "fixture/fmp4-init-is-ftyp-moov-and-fragments-are-moof-mdat",
  "fixture/recipes-are-bit-exact",
  "fixture/ts-playlist-is-the-v1-subset",
  "fixture/fmp4-playlist-is-the-v2-grammar",
  "fixture/negative-playlists-are-refused-by-the-parser",
  "fixture/service-binds-loopback-only",
  "validator/admits-exactly-the-case-pages",
  "validator/refuses-every-nearby-alternative",
  "transport/no-refused-request",
  "fixture/no-unexpected-route",
  "fixture/no-range-request",
]);

/**
 * The v2 grammar, measured on the served fMP4 text with the candidate's own
 * parser: the packager's declarations, the independent-segments declaration
 * deriving nothing, and the version gate on both sides of 6.
 */
export const HLS11_GRAMMAR_CHECKS = Object.freeze([
  "grammar/fmp4-fixture-declares-one-version-at-least-6",
  "grammar/fmp4-fixture-declares-independent-segments-once",
  "grammar/independent-segments-derives-no-state",
  "grammar/version-6-admitted-into-the-same-model",
  "grammar/incompatible-versions-refused",
  "grammar/valued-independent-segments-refused",
]);

/** Every check each positive case records, un-prefixed. */
export const HLS11_CASE_CHECKS = Object.freeze([
  "analysis/advertises-preset-1080-and-best",
  "analysis/hls-preset-facts",
  "analysis/source-quality-1080-deliverable-nothing-withheld",
  "analysis/public-metadata-omits-private-material",
  "analysis/ytdlp-read-only-page-and-master",
  "executor/only-the-fresh-analysis-seam-injected",
  "execution/hls-map-owns-1080",
  "plan/clear-hls-remux-to-mp4",
  "acquisition/playlist-then-map-then-fragments-in-order",
  "acquisition/each-resource-requested-exactly-once",
  "acquisition/one-request-at-a-time",
  "acquisition/fixed-product-request-profile",
  "acquisition/aggregate-is-the-exact-concatenation",
  "acquisition/aggregate-has-the-family-name",
  "processing/source-probe-used-the-family-demuxer",
  "processing/one-ffmpeg-stream-copy-no-overwrite",
  "processing/output-probes-ran",
  "lifecycle/durable-trace",
  "lifecycle/every-hls-request-while-downloading",
  "lifecycle/no-media-tool-while-downloading",
  "lifecycle/media-tools-only-while-processing",
  "lifecycle/no-ytdlp-after-execution-analysis",
  "lifecycle/upload-while-uploading",
  "workspace/acquisition-peak-is-the-aggregate-alone",
  "workspace/processing-peak-within-inputs-plus-output",
  "output/container-is-a-faststart-mp4",
  "output/exactly-one-h264-video",
  "output/exactly-one-aac-audio",
  "output/exactly-two-streams",
  "output/resolution-is-1920x1080",
  "output/duration-matches-the-fixture",
  "output/size-positive-and-within-the-limit",
  "output/stream-copy-packets-preserved",
  "upload/exactly-one-put-of-the-produced-mp4",
  "ready/final-status-ready-with-matching-metadata",
  "privacy/no-private-material-on-any-public-surface",
  "cleanup/job-workdir-removed",
]);

/** The fMP4 positive's own extra check: the job consumed the declaration-bearing playlist. */
export const HLS11_FMP4_CASE_CHECKS = Object.freeze([
  "v2-fmp4/acquisition/consumed-the-independent-segments-playlist",
]);

/** The bounded negatives and what each must record. */
export const HLS11_NEGATIVE_CHECKS = Object.freeze([
  "neg-byterange/format-unavailable",
  "neg-byterange/no-upload-never-ready",
  "neg-byterange/workdir-removed",
  "neg-byterange/only-the-playlist-requested",
  "neg-byterange/never-processing-no-media-tool",
  "neg-encrypted/format-unavailable",
  "neg-encrypted/no-upload-never-ready",
  "neg-encrypted/workdir-removed",
  "neg-encrypted/no-key-map-or-fragment-requested",
  "neg-encrypted/never-processing-no-media-tool",
  "neg-init-404/network-error",
  "neg-init-404/no-upload-never-ready",
  "neg-init-404/workdir-removed",
  "neg-init-404/no-fragment-requested",
  "neg-init-404/never-processing-no-media-tool",
  "neg-budget/too-large",
  "neg-budget/no-upload-never-ready",
  "neg-budget/workdir-removed",
  "neg-budget/refused-only-because-the-map-counts",
  "neg-budget/limit-restored",
  "neg-budget/never-processing-no-media-tool",
  "neg-video-only/processing-failed",
  "neg-video-only/no-upload-never-ready",
  "neg-video-only/workdir-removed",
  "neg-video-only/refused-by-the-real-source-probe-before-any-ffmpeg",
  "neg-version-5/format-unavailable",
  "neg-version-5/no-upload-never-ready",
  "neg-version-5/workdir-removed",
  "neg-version-5/refused-before-the-map-request",
  "neg-version-5/never-processing-no-media-tool",
  "neg-version-missing/format-unavailable",
  "neg-version-missing/no-upload-never-ready",
  "neg-version-missing/workdir-removed",
  "neg-version-missing/refused-before-the-map-request",
  "neg-version-missing/never-processing-no-media-tool",
  "neg-independent-segments-value/format-unavailable",
  "neg-independent-segments-value/no-upload-never-ready",
  "neg-independent-segments-value/workdir-removed",
  "neg-independent-segments-value/refused-before-the-map-request",
  "neg-independent-segments-value/never-processing-no-media-tool",
]);

/** The split-master pairing-provenance case. */
export const HLS11_SPLIT_MASTER_CHECKS = Object.freeze([
  "split-master/pinned-ytdlp-exposes-separate-audio-renditions",
  "split-master/pinned-ytdlp-exposes-no-pairing-relationship",
  "split-master/no-hls-video-preset-advertised",
  "split-master/hls-selections-empty",
  "split-master/source-quality-withholds-unsupported-protocol-at-1080",
  "split-master/plan-refuses-preset-1080",
  "split-master/no-product-media-request",
]);

/**
 * Every check an HLS-11 PASS requires, each present EXACTLY once and passing.
 * No partial PASS: a stage that never ran is a missing check.
 */
export const HLS11_MANDATORY_CHECKS = Object.freeze([
  ...HLS09_RELEASE_IDENTITY_CHECKS,
  ...HLS11_PREFLIGHT_CHECKS,
  ...HLS11_INVARIANT_CHECKS,
  ...HLS11_FIXTURE_CHECKS,
  ...HLS11_GRAMMAR_CHECKS,
  ...HLS11_POSITIVE_CASES.flatMap((caseName) => HLS11_CASE_CHECKS.map((name) => `${caseName}/${name}`)),
  ...HLS11_FMP4_CASE_CHECKS,
  ...HLS11_NEGATIVE_CHECKS,
  ...HLS11_SPLIT_MASTER_CHECKS,
]);

/** What a PASS does not prove. Recorded verbatim in every record. */
export const HLS11_NON_CLAIMS = Object.freeze([
  "separate HLS audio (split TS or split fMP4) is NOT supported and NOT exercised as a positive: pairing provenance is insufficient",
  "no real public HLS source, real CDN, signed-URL lifetime or public fMP4 packager compatibility",
  "Production SSRF/DNS/egress policy is NOT re-proven (the acceptance transport answers a synthetic public address)",
  "no real Cloudflare Tunnel/Access, Vercel, Cloudflare R2 or R2 credential broker",
  "no Production startup of this candidate, no promotion and no long-term uptime claim",
]);

/** The acceptance substitutions, stated rather than hidden. */
export const HLS11_SUBSTITUTIONS = Object.freeze({
  urlValidation: "exact-page validator (one fixture hostname, exact port, exact case pages) in place of assertSafeUrl",
  safeHttp: "safe-HTTP DNS answer and socket hooks: a synthetic public answer, then the socket re-pointed at loopback",
  objectStore: "harness local ObjectStoreWriter in place of Cloudflare R2",
  database: "a fresh temporary SQLite job store per job with a harness status-audit trigger",
});

/** Strings no record may contain anywhere, key or value. */
export const HLS11_FORBIDDEN_EVIDENCE_SUBSTRINGS = Object.freeze([
  "HLS11_PRIVATE_",
  "HLS11_RAW_",
  "hls11-fixture.example.invalid",
  "/hls11/",
  "media.m3u8",
  "init.mp4",
  ".m4s",
  "127.0.0.1",
  "http://",
  "https://",
  "/tmp/videofetch",
  "/acceptance-scratch",
]);

/** The dotted path of the first forbidden KEY, or null. */
export function findHls11ForbiddenKey(value, path = "$", depth = 0) {
  if (depth > 16) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findHls11ForbiddenKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_EVIDENCE_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) return `${path}.${key}`;
      const hit = findHls11ForbiddenKey(entry, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** The dotted path of the first string (value OR key) with a forbidden substring, or null. */
export function findHls11ForbiddenSubstring(value, path = "$", depth = 0) {
  if (depth > 16) return null;
  if (typeof value === "string") {
    return HLS11_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => value.includes(needle)) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findHls11ForbiddenSubstring(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (HLS11_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => key.includes(needle))) return `${path}.<key>`;
      const hit = findHls11ForbiddenSubstring(entry, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Assembles the record from an ALLOWLIST; refuses an unearned PASS or any leak. */
export function buildHls11ReleaseEvidence(input) {
  const record = {
    schema: HLS11_RELEASE_EVIDENCE_SCHEMA,
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
    substitutions: { ...HLS11_SUBSTITUTIONS },
    nonClaims: [...HLS11_NON_CLAIMS],
    toolchain: input.toolchain ?? null,
    invariants: input.invariants ?? null,
    fixture: input.fixture ?? null,
    cases: input.cases ?? null,
    negativeCases: input.negativeCases ?? null,
    splitMaster: input.splitMaster ?? null,
    checks: input.checks,
  };
  if (record.verdict !== "PASS" && record.verdict !== "FAIL" && record.verdict !== "BLOCKED") {
    throw new Error("the verdict must be PASS, FAIL or BLOCKED");
  }
  if (record.verdict === "PASS") {
    const unmet = unmetPassConditions(record.checks, HLS11_MANDATORY_CHECKS);
    if (unmet.length > 0) {
      throw new Error(`refusing to emit a PASS ${HLS11_RELEASE_EVIDENCE_SCHEMA} record: ${unmet.join("; ")}`);
    }
  }
  const forbiddenKey = findHls11ForbiddenKey(record);
  if (forbiddenKey !== null) throw new Error(`refusing to emit an evidence record containing a '${forbiddenKey}' field`);
  const cleaned = stripForbiddenKeys(record);
  const leak = findHls11ForbiddenSubstring(cleaned);
  if (leak !== null) throw new Error(`refusing to emit an evidence record containing private fixture material (at ${leak})`);
  return cleaned;
}

/** One deterministic JSON document, pretty-printed for review. */
export function renderHls11ReleaseEvidence(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * The SPLIT-07 parent's validation of a PARSED child record against its own
 * observations. Returns the problems; empty means a valid PASS naming exactly
 * the release source and the candidate image.
 */
export function validateHls11ReleaseChildRecord(record, expected) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["the record is not an object"];
  const problems = [];
  if (record.schema !== HLS11_RELEASE_EVIDENCE_SCHEMA) {
    problems.push(`schema is ${String(record.schema)}, not ${HLS11_RELEASE_EVIDENCE_SCHEMA}`);
  }
  if (record.verdict !== "PASS") problems.push(`verdict is ${String(record.verdict)}, not PASS`);
  const checks = Array.isArray(record.checks) ? record.checks : [];
  const failed = checks.filter((check) => check?.ok !== true).length;
  if (checks.length === 0) problems.push("the record carries no checks");
  else if (failed > 0) problems.push(`${failed} of ${checks.length} checks did not pass`);
  const unmet = unmetPassConditions(checks, HLS11_MANDATORY_CHECKS).filter((reason) => !reason.endsWith(": failed"));
  if (unmet.length > 0) problems.push(`mandatory checks absent or duplicated: ${unmet.length}`);
  if (record.source?.commit !== expected.sourceCommit) problems.push("source commit is not the release source");
  if (record.source?.tree !== expected.sourceTree) problems.push("source tree is not the release tree");
  if (record.source?.contextClean !== true) problems.push("source context not asserted clean");
  if (record.image?.imageId !== expected.candidateImageId) problems.push("candidate image id is not the parent's");
  if (record.image?.runSubject !== expected.candidateImageId) problems.push("run image id is not the parent's candidate id");
  if (record.image?.candidateTag !== expected.candidateTag) problems.push("candidate label is not the parent's build tag");
  if (record.image?.deployable !== false) problems.push("candidate not marked non-deployable");
  if (record.network?.mode !== "none") problems.push("network mode is not none");
  if (findHls11ForbiddenKey(record) !== null) problems.push("a forbidden raw-material key is present");
  if (findHls11ForbiddenSubstring(record) !== null) problems.push("private fixture material is present");
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
    throw new Error(`refusing to emit a ${HLS11_RELEASE_EVIDENCE_SCHEMA} record without parent-verified release source identity`);
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
