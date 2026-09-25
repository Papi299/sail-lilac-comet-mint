// The HLS-08 machine-readable acceptance record.
//
// Pure. The orchestrator decides WHERE the record goes; this module decides
// what may be in it, and refuses to produce one that leaks or over-claims.
//
// A NEW schema, not an extension of SPLIT-06's: a clear-HLS run substitutes a
// different set of boundaries (an acceptance DNS/socket transport under the
// real safe-HTTP policy) and proves a different chain, and reusing an
// identifier would make two different claims indistinguishable later.
//
// Import-free apart from the shared forbidden-key list and the import-free
// provenance/fixture modules, so the host driver validates a record on the
// VM's Node 18.

import { FORBIDDEN_EVIDENCE_KEYS, stripForbiddenKeys } from "./evidence.mjs";
import { OVERLAY_RUNTIME_COMPATIBILITY_FILES, isFullGitSha } from "./split-provenance.mjs";
import {
  HLS08_PRIVATE_MARKER_PREFIX,
  HLS08_RAW_FORMAT_NAME,
  HLS_FIXTURE_HOSTNAME,
} from "./hls-fixture-url.mjs";

/**
 * The schema identifier. Bump it when the record's meaning changes.
 *
 *   -01  HISTORICAL. The first HLS-08 record (PR #78 head da4f63d9…): one
 *        positive clear-HLS full path plus the three bounded negatives
 *        (encrypted playlist, fragment failure, FFmpeg unavailable at
 *        analysis). NOT accepted for HLS-8 closure: its hostname/page-echo
 *        placement validation was too permissive — it admitted any hostname
 *        occurrence not followed by `:` or `/` (so `<host>.evil`, `<host>X`,
 *        `<host>?x=1`, or the bare host in any unrelated field) and any page
 *        URL prefix (so `<page>?x=1`, `<page>#x`, `<page>/extra`).
 *   -02  Field-aware privacy placement. The fixture hostname is admitted only
 *        as exact field/value pairs — public `webpageUrl`/`source`, durable
 *        `url`/`source` of each expected job, job-view `source` — and refused
 *        in every other structured field and key; the hostname-free surfaces
 *        refuse it entirely; raw SQLite bytes are scanned for HLS acquisition
 *        provenance only. The single durable privacy check of -01 is split
 *        into exact-echo, rows, views and raw-bytes checks.
 */
export const HLS08_EVIDENCE_SCHEMA = "hls08-deterministic-full-path-02";

/**
 * Keys that must never appear anywhere in a record, on top of the shared list.
 * A record is an allowlist, so one of these reaching it means its producer is
 * wrong; the builder refuses loudly rather than withholding quietly.
 */
export const HLS08_FORBIDDEN_EVIDENCE_KEYS = Object.freeze([
  ...FORBIDDEN_EVIDENCE_KEYS,
  "stdout",
  "playlistUrl",
  "fragmentUrl",
  "manifestUrl",
  "mediaPlaylistUrl",
  "url",
  "href",
  "headers",
  "args",
]);

/**
 * Substrings that must never appear in a serialized record: every private
 * marker (by their shared prefix), the raw upstream format name, the fixture
 * hostname, any URL at all, the fixture's signature parameter, any temporary
 * path, and any playlist location.
 */
export const HLS08_FORBIDDEN_EVIDENCE_SUBSTRINGS = Object.freeze([
  HLS08_PRIVATE_MARKER_PREFIX,
  HLS08_RAW_FORMAT_NAME,
  HLS_FIXTURE_HOSTNAME,
  "://",
  "sig=",
  "/tmp/",
  ".m3u8",
]);

/**
 * The three external boundaries HLS-08 substitutes, stated in the record so
 * no reader can mistake the run for more than it is.
 */
export const HLS08_SUBSTITUTIONS = Object.freeze({
  submittedUrlValidator:
    "exact deterministic fixture validator for the ONE submitted page URL — NOT Production SSRF acceptance",
  safeHttpTransport:
    "the Product's real safe-HTTP policy with an acceptance DNS answer and loopback socket — NOT Production DNS, address-pinning or egress acceptance",
  objectStoreProvider:
    "local deterministic ObjectStoreWriter whose HEAD measures the persisted file — NOT Cloudflare R2 acceptance",
});

/** What a PASS does not prove. Recorded verbatim in every record. */
export const HLS08_NON_CLAIMS = Object.freeze([
  "Production SSRF/address-pinning is NOT re-proven here",
  "Production DNS is NOT re-proven here",
  "Production egress/nftables is NOT re-proven here (Phase 9 remains the authority)",
  "no Production deployment, release-image qualification (HLS-9) or promotion (HLS-10)",
  "no Cloudflare Tunnel/Access, Vercel, Cloudflare R2 or R2 credential broker",
  "no Production media network namespace, watchdog or workspace provisioning",
  "no public-site, real CDN or real signed-URL lifetime compatibility",
]);

/**
 * The OVERLAY identity checks: source provenance, the accepted historical
 * base, and the overlay built on it. They are what makes a record HLS-08
 * overlay evidence, and the only checks HLS-09's release-image child replaces
 * (`lib/hls-release-evidence.mjs`).
 */
export const HLS08_OVERLAY_IDENTITY_CHECKS = Object.freeze([
  "provenance/driver-verified-source",
  "image/accepted-base-digest-is-the-recorded-runtime",
  "image/accepted-base-source-is-the-recorded-runtime",
  "image/overlay-is-non-deployable",
]);

/**
 * The BEHAVIORAL checks: the clear-HLS chain itself, from the toolchain to the
 * three negatives. Shared, unchanged, by every mode that runs the chain — an
 * overlay (HLS-08) and a release image (HLS-09) must both earn every one.
 */
export const HLS_BEHAVIORAL_MANDATORY_CHECKS = Object.freeze([
  // toolchain
  "preflight/node-runtime-family",
  "preflight/ytdlp-available",
  "preflight/ytdlp-exact-pin",
  "preflight/ffmpeg-path-absolute",
  "preflight/ffmpeg-executes",
  "preflight/ffmpeg-available-predicate",
  "preflight/ffprobe-is-ffmpeg-sibling",
  "preflight/ffprobe-executes",
  // HLS-7 invariants
  "invariants/ytdlp-native-protocols-http-https",
  "invariants/generic-source-protocols-http-https",
  "invariants/raw-hls-id-is-not-a-requestable-format-id",
  // fixture validity
  "fixture/at-least-three-mpegts-segments",
  "fixture/playlist-is-inside-the-hls1-subset",
  "fixture/playlist-is-finite-vod",
  "fixture/playlist-has-no-refused-construct",
  "fixture/segments-are-h264-aac-mpegts-640x360",
  "fixture/encrypted-variant-is-refused-by-hls1",
  "fixture/fragment-failure-variant-is-accepted-by-hls1",
  "fixture/service-binds-loopback-only",
  "validator/admits-the-exact-page",
  "validator/refuses-every-nearby-alternative",
  // real yt-dlp discovery
  "discovery/direct-strategy-declines-the-page",
  "discovery/real-ytdlp-analysis-ran",
  "discovery/no-load-info-json",
  "discovery/rendition-is-m3u8-native-360-with-video-and-audio",
  "discovery/raw-format-id-is-the-fixture-name",
  "discovery/ytdlp-read-only-page-and-master",
  // browser-safe HLS preset
  "public/advertises-preset-best",
  "public/advertises-preset-360",
  "public/hls-preset-facts",
  "public/formats-empty",
  "public/capabilities-mp3-false",
  "public/capabilities-merge-false",
  "public/source-quality-observed-360",
  "public/source-quality-deliverable-360",
  "public/no-unsupported-protocol-withholding",
  // public privacy
  "privacy/public-page-echo-is-exact",
  "privacy/public-analysis-carries-no-hls-provenance",
  "privacy/source-quality-carries-no-hls-provenance",
  // fresh execution analysis
  "executor/only-the-fresh-analysis-seam-injected",
  "execution/analysis-ran-once-through-the-policy",
  "execution/strategy-yt-dlp",
  "execution/progressive-map-does-not-own-best-or-360",
  "execution/hls-map-owns-best-and-360",
  // fresh playlist provenance
  "provenance-witness/public-analysis-saw-the-browser-master",
  "provenance-witness/execution-analysis-saw-the-execution-master",
  "provenance-witness/execution-selection-names-the-execution-playlist",
  "provenance-witness/hls2-requested-the-execution-playlist",
  "provenance-witness/browser-playlist-never-requested",
  // ordinary planner
  "plan/strategy-yt-dlp",
  "plan/operation-clear-hls-remux",
  "plan/requested-format-is-preset-best",
  "plan/target-container-mp4",
  "plan/source-is-the-fresh-execution-playlist",
  "plan/single-family-no-fallback",
  // workspace capacity
  "workspace/max-file-size-is-the-product-default",
  "workspace/required-bytes-is-two-max-file-sizes",
  "workspace/product-preflight-admitted-the-job",
  // HLS-2
  "hls2/exactly-one-playlist-get",
  "hls2/get-only-no-head-no-retry",
  "hls2/fixed-product-request-profile",
  "hls2/no-cookie-authorization-referer-proxy-authorization",
  "hls2/playlist-served-200",
  // HLS-3
  "hls3/each-fragment-requested-exactly-once",
  "hls3/playlist-order-preserved",
  "hls3/one-request-at-a-time-transport",
  "hls3/one-request-at-a-time-fixture",
  "hls3/playlist-read-before-first-fragment",
  "hls3/fixed-product-request-profile",
  // aggregate identity
  "aggregate/observed-before-any-media-tool",
  "aggregate/size-equals-segment-sum",
  "aggregate/sha256-equals-ordered-concatenation",
  // durable boundaries
  "lifecycle/durable-trace",
  "lifecycle/every-hls-request-while-downloading",
  "lifecycle/no-media-tool-while-downloading",
  "lifecycle/every-hls4-media-tool-while-processing",
  "lifecycle/aggregate-observed-while-processing",
  "processing/exactly-one-remux",
  "processing/source-and-output-probes-ran",
  "processing/no-ytdlp-after-execution-analysis",
  "processing/no-unclassified-subprocess",
  // actual stream-copy argv
  "remux/fixed-stream-copy-policy",
  // output shape
  "output/iso-bmff-family",
  "output/exactly-one-h264-video",
  "output/exactly-one-aac-audio",
  "output/exactly-two-streams",
  "output/duration-matches-the-fixture",
  // upload lifecycle and identity
  "upload/exactly-one-put",
  "upload/put-while-uploading",
  "upload/real-lifecycle-accepted-the-provider-head",
  "upload/content-type-video-mp4",
  "upload/content-disposition-names-an-mp4",
  "upload/uploaded-sha256-equals-produced-mp4",
  "upload/uploaded-bytes-equal-produced-size",
  "upload/uploaded-artifact-is-not-the-aggregate",
  // ready
  "ready/status-ready",
  "ready/extractor-yt-dlp",
  "ready/format-id-preset-best",
  "ready/container-mp4",
  "ready/mime-video-mp4",
  "ready/filename-mp4",
  "ready/file-size-equals-uploaded-bytes",
  "ready/object-key-belongs-to-this-job",
  // fixture accounting
  "fixture/public-analysis-fetched-page-and-master",
  "fixture/execution-analysis-fetched-page-and-master",
  "fixture/ytdlp-never-fetched-media-or-fragments",
  "fixture/no-unexpected-route",
  "transport/no-refused-request",
  // durable privacy
  "privacy/durable-page-echo-is-exact",
  "privacy/durable-rows-carry-no-hls-provenance",
  "privacy/job-views-carry-no-hls-provenance",
  "privacy/raw-sqlite-carries-no-hls-provenance",
  "privacy/upload-surfaces-carry-no-hls-provenance",
  "privacy/trace-carries-no-hls-provenance",
  // cleanup and hooks
  "cleanup/job-workdirs-removed",
  "cleanup/hls-intermediates-removed",
  "cleanup/temporary-database-removed",
  "cleanup/fixture-root-removed",
  "cleanup/sink-removed-after-observation",
  "hooks/safe-http-restored",
  "hooks/process-runner-restored",
  // negative A — encrypted playlist
  "negative-encrypted/format-unavailable",
  "negative-encrypted/playlist-fetched-once",
  "negative-encrypted/no-fragment-or-key-request",
  "negative-encrypted/no-hls-media-processing",
  "negative-encrypted/no-upload",
  "negative-encrypted/never-ready",
  // negative B — fragment failure
  "negative-fragment/network-error",
  "negative-fragment/fragment-1-once",
  "negative-fragment/fragment-2-once-not-retried",
  "negative-fragment/fragment-3-never",
  "negative-fragment/no-hls-media-processing",
  "negative-fragment/no-upload",
  "negative-fragment/never-ready",
  // negative C — FFmpeg unavailable at analysis
  "negative-no-ffmpeg/no-hls-backed-preset",
  "negative-no-ffmpeg/hls-selections-empty",
  "negative-no-ffmpeg/hls-withheld-unsupported-protocol",
  "negative-no-ffmpeg/plan-format-unavailable",
  "negative-no-ffmpeg/no-media-playlist-request",
]);

/**
 * Every check an HLS-08 PASS requires, by name. A PASS record must carry each
 * one, exactly once, passed. Additional recorded checks must pass too.
 */
export const HLS08_MANDATORY_CHECKS = Object.freeze([
  ...HLS08_OVERLAY_IDENTITY_CHECKS,
  ...HLS_BEHAVIORAL_MANDATORY_CHECKS,
]);

/**
 * The PASS conditions over a check list. Pure; returns the unmet reasons.
 * No partial PASS: every mandatory check present exactly once and passed, and
 * every other recorded check passed too. `mandatory` defaults to HLS-08's list;
 * HLS-09's release child passes its own.
 */
export function unmetPassConditions(checks, mandatory = HLS08_MANDATORY_CHECKS) {
  const list = Array.isArray(checks) ? checks : [];
  const unmet = [];
  for (const name of mandatory) {
    const found = list.filter((c) => c?.name === name);
    if (found.length !== 1) unmet.push(`${name}: recorded ${found.length} times`);
    else if (found[0].ok !== true) unmet.push(`${name}: failed`);
  }
  for (const check of list) {
    if (check?.ok !== true && !mandatory.includes(check?.name)) {
      unmet.push(`${String(check?.name)}: failed`);
    }
  }
  if (list.length === 0) unmet.push("no checks recorded");
  return unmet;
}

/**
 * Assembles the record from an ALLOWLIST: every top-level field is named here,
 * and nothing is spread in from an observation object.
 */
export function buildHlsEvidence(input) {
  const record = {
    schema: HLS08_EVIDENCE_SCHEMA,
    verdict: input.verdict,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    source: verifiedSource(input.source),
    image: {
      acceptedBaseImage: input.image.acceptedBaseImage,
      acceptedBaseDigest: input.image.acceptedBaseDigest,
      overlayImage: input.image.overlayImage,
      overlayImageId: input.image.overlayImageId,
      deployable: false,
    },
    network: {
      mode: "none",
      fixtureBind: input.network.fixtureBind,
      fixturePort: input.network.fixturePort,
      acceptanceHostMappings: 1,
      publicHostsContacted: 0,
    },
    substitutions: { ...HLS08_SUBSTITUTIONS },
    nonClaims: [...HLS08_NON_CLAIMS],
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
    const unmet = unmetPassConditions(record.checks);
    if (unmet.length > 0) {
      throw new Error(`refusing to emit a PASS ${HLS08_EVIDENCE_SCHEMA} record: ${unmet.join("; ")}`);
    }
  }

  // Key gate on the RAW record: a forbidden key reaching an allowlist is a
  // producer bug and must be loud.
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
export function renderHlsEvidence(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * The host driver's post-run validation of a record it READ BACK from disk.
 * Returns the problems; an empty list means the record is a valid PASS for
 * exactly the observed source and images.
 */
export function validateHlsEvidenceRecord(record, expected) {
  const problems = [];
  if (record === null || typeof record !== "object") return ["the record is not an object"];
  if (record.schema !== HLS08_EVIDENCE_SCHEMA) problems.push("schema mismatch");
  if (record.verdict !== "PASS") problems.push(`verdict is ${String(record.verdict)}`);
  if (record.source?.commit !== expected.commit) problems.push("source commit mismatch");
  if (record.source?.tree !== expected.tree) problems.push("source tree mismatch");
  if (record.source?.contextClean !== true) problems.push("source context not clean");
  if (record.source?.overlayRuntimeCompatibilityVerified !== true) problems.push("runtime compatibility not verified");
  if (record.image?.acceptedBaseDigest !== expected.baseDigest) problems.push("base digest mismatch");
  if (record.image?.overlayImageId !== expected.overlayImageId) problems.push("overlay image id mismatch");
  if (record.image?.overlayImage !== expected.overlayImage) problems.push("overlay image tag mismatch");
  if (record.image?.deployable !== false) problems.push("overlay not marked non-deployable");
  for (const reason of unmetPassConditions(record.checks)) problems.push(reason);
  const key = findForbiddenKey(record);
  if (key !== null) problems.push(`forbidden key ${key}`);
  const leak = findForbiddenSubstring(record);
  if (leak !== null) problems.push(`private material at ${leak}`);
  return problems;
}

function verifiedSource(source) {
  const verified =
    source !== null &&
    typeof source === "object" &&
    isFullGitSha(source.commit) &&
    isFullGitSha(source.tree) &&
    isFullGitSha(source.acceptedBaseSourceCommit) &&
    source.contextClean === true &&
    source.overlayRuntimeCompatibilityVerified === true;
  if (!verified) {
    throw new Error(`refusing to emit a ${HLS08_EVIDENCE_SCHEMA} record without driver-verified source provenance`);
  }
  return {
    commit: source.commit,
    tree: source.tree,
    contextClean: true,
    acceptedBaseSourceCommit: source.acceptedBaseSourceCommit,
    overlayRuntimeCompatibilityVerified: true,
    runtimeCompatibilityFiles: [...OVERLAY_RUNTIME_COMPATIBILITY_FILES],
    verifiedBy: "run-hls-acceptance.mjs: git against the build context, before and after the overlay build",
  };
}

/** The dotted path of the first forbidden key, or null. Case-insensitive. */
export function findForbiddenKey(value, path = "$", depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (HLS08_FORBIDDEN_EVIDENCE_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) {
        return `${path}.${key}`;
      }
      const hit = findForbiddenKey(entry, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The dotted path of the first string (value OR key) containing a forbidden
 * substring, or null. The substring itself is never returned.
 */
export function findForbiddenSubstring(value, path = "$", depth = 0) {
  if (depth > 12) return null;
  if (typeof value === "string") {
    return HLS08_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => value.includes(needle)) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenSubstring(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (HLS08_FORBIDDEN_EVIDENCE_SUBSTRINGS.some((needle) => key.includes(needle))) return `${path}.<key>`;
      const hit = findForbiddenSubstring(entry, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
