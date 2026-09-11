// The SPLIT-06 machine-readable acceptance record.
//
// Pure. The orchestrator decides WHERE to write the record; this module decides
// what may be in it, and refuses to produce one that leaks.
//
// Deliberately a NEW schema rather than an extension of the Phase-10D record:
// that one describes a live, tunnelled, R2-backed Production run, and reusing
// its identifier for a `--network none` local-writer run would make two very
// different claims indistinguishable to anyone reading the artifacts later.

import { FORBIDDEN_EVIDENCE_KEYS, stripForbiddenKeys } from "./evidence.mjs";

/** The schema identifier. Bump it when the record's meaning changes. */
export const SPLIT06_EVIDENCE_SCHEMA = "split06-deterministic-full-path-01";

/**
 * Values that must not appear ANYWHERE in a serialized record.
 *
 * The synthetic upstream format ids are here for the same reason a sentinel is
 * in the Phase-10D record: the record is one of the public surfaces §46 says
 * must not carry a raw source identifier, and the cheapest way to keep that
 * true is to refuse to write one.
 */
export const SPLIT06_FORBIDDEN_EVIDENCE_SUBSTRINGS = Object.freeze([
  "SPLIT06_VIDEO_01",
  "SPLIT06_AUDIO_01",
]);

/**
 * Assembles the record from an ALLOWLIST.
 *
 * Every field is named here. Nothing is spread in from an observation object,
 * so a future field added elsewhere cannot arrive by accident — which is what
 * makes the forbidden-key sweep below a second gate rather than the mechanism.
 */
export function buildSplitEvidence(input) {
  const record = {
    schema: SPLIT06_EVIDENCE_SCHEMA,
    verdict: input.verdict,
    family: input.family,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,

    source: {
      commit: input.source.commit,
      tree: input.source.tree,
    },
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
      publicHostsContacted: 0,
      dnsLookups: 0,
    },
    toolchain: {
      node: input.toolchain.node,
      ytdlpVersion: input.toolchain.ytdlpVersion,
      ytdlpArtifactPath: input.toolchain.ytdlpArtifactPath,
      ffmpegPath: input.toolchain.ffmpegPath,
      ffmpegVersion: input.toolchain.ffmpegVersion,
      ffprobePath: input.toolchain.ffprobePath,
      ffprobeVersion: input.toolchain.ffprobeVersion,
      probeLocalMediaResult: input.toolchain.probeLocalMediaResult,
    },

    fixtures: input.fixtures,
    sourceDiscovery: input.sourceDiscovery,
    analysis: input.analysis,
    plan: input.plan,
    acquisition: input.acquisition,
    lifecycle: input.lifecycle,
    processing: input.processing,
    streamIdentity: input.streamIdentity,
    upload: input.upload,
    privacy: input.privacy,
    cleanup: input.cleanup,
    negativeCases: input.negativeCases,
    maxFilesizeCharacterization: input.maxFilesizeCharacterization,
    ffmpegOverwriteRefusal: input.ffmpegOverwriteRefusal,
    checks: input.checks,
  };

  // Order matters. The forbidden-key check runs on the RAW record, so a field
  // that should never have been assembled is a loud refusal rather than a
  // quietly withheld value: this record is an allowlist, and a `stderr` key
  // reaching it means the producer, not the sweep, is wrong.
  const raw = JSON.stringify(record);
  for (const key of FORBIDDEN_EVIDENCE_KEYS) {
    if (raw.includes(`"${key}":`)) {
      throw new Error(`refusing to emit an evidence record containing a '${key}' field`);
    }
  }

  // The shared recursive sweep still runs, as the second gate.
  const cleaned = stripForbiddenKeys(record);
  const serialized = JSON.stringify(cleaned);
  for (const needle of SPLIT06_FORBIDDEN_EVIDENCE_SUBSTRINGS) {
    if (!serialized.includes(needle)) continue;
    // Naming WHERE it was found — never the needle itself — is what makes this
    // guard usable while developing the harness instead of merely fatal.
    const where = locateNeedle(cleaned, needle) ?? "<unknown path>";
    throw new Error(
      `refusing to emit an evidence record containing a raw source identifier (at ${where})`,
    );
  }
  return cleaned;
}

/** One deterministic JSON line, pretty-printed for review. */
export function renderSplitEvidence(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** The dotted path of the first value containing `needle`, or null. */
function locateNeedle(value, needle, path = "$") {
  if (typeof value === "string") return value.includes(needle) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = locateNeedle(value[i], needle, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key.includes(needle)) return `${path}.<key>`;
      const hit = locateNeedle(entry, needle, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}
