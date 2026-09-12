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
import { OVERLAY_RUNTIME_COMPATIBILITY_FILES, isFullGitSha } from "./split-provenance.mjs";

/**
 * The schema identifier. Bump it when the record's meaning changes.
 *
 *   -01  `source` held whatever commit and tree the CALLER asserted.
 *   -02  `source` holds what the host driver OBSERVED in the Docker build
 *        context after verifying it: the exact commit, the exact tree, a clean
 *        context, the accepted base source present, and every
 *        runtime-compatibility file the same Git object as in that accepted
 *        source. -01 records are historical and are never rewritten.
 *   -03  the `--max-filesize` case is an ACCEPTANCE CONDITION, no longer a
 *        characterization. A -02 record carried `maxFilesizeCharacterization`,
 *        whose canonical code was recorded but never required, so a -02 PASS
 *        coexisted with PROCESSING_FAILED. A -03 record carries
 *        `maxFilesizeRefusal` instead, and a PASS requires it to satisfy
 *        `evaluateMaxFilesizeRefusal` — TOO_LARGE, with nothing acquired.
 *        -01 and -02 records are historical: never rewritten, and never
 *        re-read under -03 rules.
 *   -04  the CHUNKED `--max-filesize` refusal is an acceptance condition too.
 *        A pinned `HttpFD` fetching a source in HTTP chunks — an extractor's
 *        `downloader_options.http_chunk_size`, as the pinned YouTube extractor
 *        sets on every https format — refuses a LATER chunk after the earlier
 *        ones filled the run's `.part`, and the Worker now classifies that
 *        shape TOO_LARGE as well. A -03 PASS proved only the refusal of a
 *        download's first response, with nothing written, so a -04 record
 *        adds `maxFilesizeChunkedRefusal`, and a PASS requires it to satisfy
 *        `evaluateChunkedMaxFilesizeRefusal` besides the unchanged -03
 *        condition. -01, -02 and -03 records are historical: never
 *        rewritten, and never re-read under -04 rules.
 */
export const SPLIT06_EVIDENCE_SCHEMA = "split06-deterministic-full-path-04";

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

/** The canonical code a -03 PASS requires for the `--max-filesize` refusal. */
export const MAX_FILESIZE_REFUSAL_REQUIRED_CODE = "TOO_LARGE";

/**
 * The -03 acceptance condition for the `--max-filesize` refusal case.
 *
 * Pure, and the single definition of it: the orchestrator records each result
 * as a named check, and `buildSplitEvidence` re-evaluates the record's own
 * block before it emits a PASS.
 *
 * The yt-dlp exit code is deliberately NOT a condition. The pinned release
 * exits 0 on this refusal; SPLIT-06 pins the PRODUCT's canonical outcome, not
 * yt-dlp's opinion of it. The exit code is recorded beside the result.
 */
export function evaluateMaxFilesizeRefusal(observation) {
  const o = observation ?? {};
  const positive = (n) => Number.isSafeInteger(n) && n > 0;
  const tooLarge = o.canonicalErrorCode === MAX_FILESIZE_REFUSAL_REQUIRED_CODE;
  return [
    {
      name: "max-filesize/declared-length-exceeds-allowance",
      ok:
        positive(o.ceilingBytes) &&
        positive(o.declaredContentLengthBytes) &&
        o.declaredContentLengthBytes > o.ceilingBytes,
      detail: null,
    },
    { name: "max-filesize/acquisition-was-refused", ok: o.threw === true, detail: null },
    {
      // The video half, alone: a refused video half never starts the audio one.
      name: "max-filesize/one-yt-dlp-run-carrying-the-run-allowance",
      ok:
        o.acquisitionRuns === 1 &&
        positive(o.ceilingBytes) &&
        o.maxFilesizeArgument === String(o.ceilingBytes),
      detail: null,
    },
    { name: "max-filesize/left-no-final-file", ok: o.finalFileExists === false, detail: null },
    { name: "max-filesize/left-no-part-file", ok: o.partFileExists === false, detail: null },
    {
      name: "max-filesize/classified-canonical-too-large",
      ok: tooLarge,
      detail: tooLarge ? null : `observed ${String(o.canonicalErrorCode)}`,
    },
  ];
}

/**
 * Where the chunked case's chunk size must come from: the operand of the pinned
 * `HttpFD.real_download` an extractor feeds, never the CLI's
 * `--http-chunk-size`, which Production never passes.
 */
export const CHUNKED_REFUSAL_CHUNK_SIZE_SOURCE = "info_dict.downloader_options.http_chunk_size";

/** The one argument the chunked case adds to the product's own acquisition argv. */
export const CHUNKED_REFUSAL_HARNESS_ARGUMENT = "--load-info-json";

/**
 * The -04 acceptance condition for the CHUNKED `--max-filesize` refusal.
 *
 * Two halves, both required:
 *
 *   RUNTIME — what the exact pinned `HttpFD` does with a source carrying an
 *   extractor-owned `downloader_options.http_chunk_size`: it admits whole
 *   earlier chunks into the run's `.part`, then refuses a LATER one, exits 0
 *   with the refusal as its final stdout line, and leaves that `.part` behind;
 *
 *   PRODUCT — what the Worker makes of it: the refused audio half, run with
 *   exactly `combined − actual video bytes`, is TOO_LARGE.
 *
 * Pure, and the single definition: the orchestrator records each result as a
 * named check, and `buildSplitEvidence` re-evaluates the record's own block
 * before it emits a PASS. Unlike the -03 case, the yt-dlp exit code IS a
 * condition here — this block characterizes the pinned runtime itself, and
 * only a zero exit reaches the refusal witness at all.
 */
export function evaluateChunkedMaxFilesizeRefusal(observation) {
  const o = observation ?? {};
  const positive = (n) => Number.isSafeInteger(n) && n > 0;
  const sameList = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  const tooLarge = o.canonicalErrorCode === MAX_FILESIZE_REFUSAL_REQUIRED_CODE;
  return [
    {
      name: "max-filesize-chunked/chunk-size-was-extractor-owned",
      ok:
        o.chunkSizeSource === CHUNKED_REFUSAL_CHUNK_SIZE_SOURCE &&
        positive(o.httpChunkSizeBytes) &&
        Number.isSafeInteger(o.httpFormatCount) &&
        o.httpFormatCount >= 2 &&
        o.chunkedFormatCount === o.httpFormatCount &&
        o.paramsHttpChunkSizePassed === false &&
        o.harnessArgumentAdded === CHUNKED_REFUSAL_HARNESS_ARGUMENT,
      detail: null,
    },
    {
      // Nothing was re-extracted: both halves were driven by the loaded
      // document, so its `downloader_options` is what `HttpFD` received.
      name: "max-filesize-chunked/acquisition-used-the-loaded-info-document",
      ok: o.manifestGetsDuringAcquisition === 0,
      detail: null,
    },
    {
      name: "max-filesize-chunked/audio-run-carried-the-remainder",
      ok:
        o.acquisitionRuns === 2 &&
        positive(o.combinedLimitBytes) &&
        positive(o.videoBytes) &&
        positive(o.audioAllowanceBytes) &&
        o.audioAllowanceBytes === o.combinedLimitBytes - o.videoBytes &&
        sameList(o.maxFilesizeArguments, [String(o.combinedLimitBytes), String(o.audioAllowanceBytes)]),
      detail: null,
    },
    {
      name: "max-filesize-chunked/video-half-was-acquired-in-chunks",
      ok:
        Number.isSafeInteger(o.videoRangedGets) &&
        o.videoRangedGets >= 2 &&
        o.videoRangesContiguous === true &&
        o.videoArtifactMatchesFixture === true,
      detail: null,
    },
    {
      name: "max-filesize-chunked/earlier-chunks-landed-before-a-later-one-was-refused",
      ok:
        Number.isSafeInteger(o.earlierChunksServed) &&
        o.earlierChunksServed >= 1 &&
        o.earlierChunksServed === o.expectedEarlierChunks &&
        o.audioRangesContiguous === true &&
        positive(o.partBytes) &&
        o.refusedRangeStartBytes === o.partBytes,
      detail: null,
    },
    {
      name: "max-filesize-chunked/declared-length-exceeds-allowance",
      ok:
        positive(o.declaredBytes) &&
        positive(o.audioAllowanceBytes) &&
        o.declaredBytes > o.audioAllowanceBytes,
      detail: null,
    },
    {
      name: "max-filesize-chunked/pinned-exit-0-with-the-refusal-as-final-line",
      ok: o.ytdlpExitCode === 0 && o.ytdlpRefusalLineWasFinal === true,
      detail: null,
    },
    {
      name: "max-filesize-chunked/left-exactly-the-video-artifact-and-the-audio-part",
      ok:
        o.finalFileExists === false &&
        Array.isArray(o.expectedWorkDirEntries) &&
        o.expectedWorkDirEntries.length === 2 &&
        sameList(o.workDirEntries, o.expectedWorkDirEntries),
      detail: null,
    },
    {
      name: "max-filesize-chunked/part-is-a-regular-file-within-the-allowance",
      ok:
        o.partIsRegularFile === true &&
        positive(o.partBytes) &&
        positive(o.audioAllowanceBytes) &&
        o.partBytes <= o.audioAllowanceBytes,
      detail: null,
    },
    {
      name: "max-filesize-chunked/part-holds-exactly-the-earlier-chunks",
      ok: o.partMatchesFixturePrefix === true,
      detail: null,
    },
    {
      name: "max-filesize-chunked/classified-canonical-too-large",
      ok: tooLarge,
      detail: tooLarge ? null : `observed ${String(o.canonicalErrorCode)}`,
    },
  ];
}

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
    maxFilesizeRefusal: input.maxFilesizeRefusal,
    maxFilesizeChunkedRefusal: input.maxFilesizeChunkedRefusal,
    ffmpegOverwriteRefusal: input.ffmpegOverwriteRefusal,
    checks: input.checks,
  };

  // -03: a PASS is also a claim that the `--max-filesize` refusal was
  // classified TOO_LARGE with nothing acquired; -04 adds the chunked refusal,
  // classified TOO_LARGE with only the refused half's partial `.part` left. No
  // PASS record is emitted unless the record's own blocks satisfy both.
  if (record.verdict === "PASS") {
    for (const [label, evaluate, block] of [
      ["max-filesize refusal", evaluateMaxFilesizeRefusal, record.maxFilesizeRefusal],
      ["chunked max-filesize refusal", evaluateChunkedMaxFilesizeRefusal, record.maxFilesizeChunkedRefusal],
    ]) {
      const unmet = evaluate(block).filter((c) => !c.ok);
      if (unmet.length > 0) {
        throw new Error(
          `refusing to emit a PASS ${SPLIT06_EVIDENCE_SCHEMA} record whose ${label} failed: ` +
            unmet.map((c) => c.name).join(", "),
        );
      }
    }
  }

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

/**
 * The `source` block, admitted only when it is the driver's VERIFIED
 * observation. A -02 record naming an unverified source would be a false
 * statement, so none is produced.
 */
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
    throw new Error(
      `refusing to emit a ${SPLIT06_EVIDENCE_SCHEMA} record without driver-verified source provenance`,
    );
  }
  return {
    commit: source.commit,
    tree: source.tree,
    contextClean: true,
    acceptedBaseSourceCommit: source.acceptedBaseSourceCommit,
    overlayRuntimeCompatibilityVerified: true,
    runtimeCompatibilityFilesCompared: [...OVERLAY_RUNTIME_COMPATIBILITY_FILES],
    verifiedBy: "run-split-acceptance.mjs: git against the build context, before and after the overlay build",
  };
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
