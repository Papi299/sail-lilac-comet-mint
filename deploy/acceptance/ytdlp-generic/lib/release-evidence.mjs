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
//
// ── The clear-HLS child (since -03) ─────────────────────────────────────────
//
// HLS is not a SPLIT-06 family, so it is not in `splitAcceptance`. Its child is
// the HLS-09 release record (`hls09-release-image-full-path-02` since -04), recorded in
// its own `hlsAcceptance` block and validated from its exact bytes exactly as
// the SPLIT-06 children are: schema, verdict, every check, the release source
// and the candidate image it names, the network mode, and a digest re-checked
// immediately before the parent is assembled.
//
// ── The segmented-DASH child (since -05) ────────────────────────────────────
//
// GENERIC-SEGMENTED-DASH-EXECUTION-001 made `http_dash_segments` executable as
// split halves. The DASH-01 child (`dash01-release-image-full-path-01`) is the
// real-media proof of that path in the candidate image: the pinned native
// `DashSegmentsFD`, the real ffprobe and the real `mergeSplitMedia` FFmpeg, on
// a deterministic 1920x1080 segmented fixture. It has its own `dashAcceptance`
// block and is validated from its exact bytes exactly as the clear-HLS child is.
//
// ── The clear-HLS v2 child (since -06) ──────────────────────────────────────
//
// HLS-V2-ADAPTIVE-VOD-EXPANSION-001 made fMP4 (init + fragment) HLS media
// playlists executable. The HLS-11 child (`hls11-release-image-full-path-01`;
// `-02` since -08) is the real-media proof in the candidate image: a 1920x1080
// MPEG-TS control and a 1920x1080 fMP4 rendition through the real HLS-2/3/4
// chain, the real ffprobe and FFmpeg, eight fail-closed negatives, and the
// split-master case that re-proves the pinned yt-dlp exposes no audio pairing
// (and, since its `-02`, that the Product's own master proof refuses that
// master). It has its own `hls11Acceptance` block. The HLS-09 child stays,
// unchanged, beside it.
//
// ── The timestamp-aware children (since -07) ───────────────────────────────
//
// SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001 corrected a split merge that
// re-based each input to zero independently. Three children now carry the
// synchronization oracle the earlier schemas lacked: SPLIT-06 children at
// `split06-deterministic-full-path-05` (a control and an offset full path, the
// parent re-checking their mandatory sync checks), the DASH-01 child at
// `dash01-release-image-full-path-02` (its own 83.3 ms A/V offset preserved),
// and the new SYNC-01 child (`sync01-release-image-merge-timing-01`): the
// maintained timing matrix through the candidate's own merge, with its own
// `syncAcceptance` block.
//
// ── The separate-audio child (since -08) ────────────────────────────────────
//
// HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001 made ONE further HLS family
// executable: a video-only fMP4 rendition plus the single audio-only fMP4
// rendition of the AUDIO group its variant names, proven from a Master
// Playlist the Product fetches itself, acquired as two halves and merged by
// the shared split merge. The HLS-12 child
// (`hls12-release-image-separate-audio-01`) is its real-media proof in the
// candidate image — an audio-late, a video-late and a zero-aligned pair to
// `ready` with the source timing preserved, four master-proof negatives and
// five execution negatives — with its own `hls12Acceptance` block. The HLS-11
// child moves to `hls11-release-image-full-path-02`, because the Product now
// consults its split master too.
//
// ── The shared-deadline separate-audio child (since -09) ───────────────────
//
// HLS-SEPARATE-AUDIO-HLS12-SHARED-DEADLINE-HARDENING-001. The Product's two
// separate-audio halves share ONE acquisition deadline, but HLS-12 `-01` never
// approached a deadline, so an `-08` PASS did not release-prove it. The HLS-12
// child moves to `hls12-release-image-separate-audio-02`, whose `neg-deadline`
// case drives the candidate's real acquisition under a narrowed configured
// budget and fails closed only if the audio half is stopped AT the shared
// deadline. Same seven children, same candidate-run purposes, same harness
// checkpoints: only the separate-audio child's required schema changes.

import { createHash } from "node:crypto";

import { DASH01_RELEASE_EVIDENCE_SCHEMA, validateDashReleaseChildRecord } from "./dash-evidence.mjs";
import { SPLIT06_EVIDENCE_SCHEMA, unmetSplit06SyncChecks } from "./split-evidence.mjs";
import { SYNC01_RELEASE_EVIDENCE_SCHEMA, validateSyncReleaseChildRecord } from "./sync-evidence.mjs";
import { HLS11_RELEASE_EVIDENCE_SCHEMA, validateHls11ReleaseChildRecord } from "./hls11-evidence.mjs";
import { HLS12_RELEASE_EVIDENCE_SCHEMA, validateHls12ReleaseChildRecord } from "./hls12-evidence.mjs";
import { FORBIDDEN_EVIDENCE_KEYS, stripForbiddenKeys } from "./evidence.mjs";
import {
  HLS09_RELEASE_EVIDENCE_SCHEMA,
  validateHlsReleaseChildRecord,
} from "./hls-release-evidence.mjs";
import { HARNESS_DIRECTORY, HARNESS_DRIVER_PATH, isFullGitSha, RELEASE_INPUT_FILES } from "./release-provenance.mjs";
import {
  assertCandidateReference,
  FORBIDDEN_CANDIDATE_TAGS,
  IMAGE_ID_PATTERN,
  POLICY_VERIFIERS,
  RELEASE_DOCKERFILE,
} from "./release-container.mjs";

/**
 * The schema identifier. Bump it when the record's MEANING changes. Never
 * rewrite an older record as a newer one.
 *
 *   -01  the first release-image candidate record. `source` holds what the
 *        driver OBSERVED in a clean Git worktree before AND after the build;
 *        `image` holds the immutable id of an image built by the real
 *        `Dockerfile.worker`; `sourceToImage` holds a deterministic path +
 *        SHA-256 manifest comparison between that commit and that image;
 *        `hardening` holds forbidden-tool, forbidden-environment and static
 *        policy-verifier outcomes; and `splitAcceptance` holds one validated,
 *        byte-hashed SPLIT-06 child record per family, mp4 AND webm, both
 *        required to PASS. -01 records are HISTORICAL: never rewritten, never
 *        re-read under -02 rules, and never sufficient to authorize SPLIT-07B.
 *   -02  a PASS additionally means the EXECUTABLE ACCEPTANCE HARNESS itself was
 *        provenance-bound and unchanged for the whole run, and that the image
 *        executed was the image recorded:
 *          - `harness` holds the harness checkout's OBSERVED commit and tree,
 *            verified clean against explicit `--harness-source` /
 *            `--harness-tree` expectations before any Docker command and again
 *            at every checkpoint through the end of both SPLIT-06 children,
 *            plus the proof that the executing driver is that checkout's own;
 *          - every candidate container ran the immutable `sha256:` image ID
 *            the driver inspected, never the mutable tag, and
 *            `image.candidateRuns` records each run subject as parsed from the
 *            argv Docker was given;
 *          - the record is created exclusively (`wx`), so it can never
 *            truncate or replace an artifact that already exists at its path.
 *        -01 recorded the harness HEAD without verifying it and ran candidates
 *        by tag, so a -01 PASS does not carry these claims.
 *        -02 remains VALID historical/current split-stream release
 *        qualification for exactly what it proved — mp4 + webm — but it does
 *        NOT qualify clear HLS, and is insufficient for HLS-9.
 *   -03  everything -02 means, PLUS a validated, byte-hashed HLS-09 clear-HLS
 *        release child (`hls09-release-image-full-path-01`) PASS, executed by
 *        the SAME immutable candidate image id as every other candidate
 *        container, naming the same release source, offline; the harness
 *        re-verified before that child and again after it; and a candidate run
 *        ledger that includes it. The HLS-aware release-image qualification
 *        for sources whose generic yt-dlp vocabulary was `http`/`https`:
 *        mp4 + webm + clear-HLS. -03 records stay VALID for exactly the
 *        candidates they qualified (e.g. RC e5b1144c) and are never re-read
 *        under -04.
 *   -04  everything -03 means, with the clear-HLS child's schema moved to
 *        `hls09-release-image-full-path-02` (GENERIC-SEGMENTED-DASH-EXECUTION-001
 *        restated HLS-7's protocol invariant for the one shared vocabulary that
 *        now carries `http_dash_segments`). mp4 + webm + clear-HLS. It runs no
 *        segmented-DASH child, so it proves nothing about real fragmented-DASH
 *        media reaching the Worker's FFmpeg; no -04 record was ever produced.
 *        Historical; never read as -05.
 *   -05  everything -04 means, PLUS a validated, byte-hashed DASH-01
 *        segmented-DASH real-media child (`dash01-release-image-full-path-01`)
 *        PASS, executed by the SAME immutable candidate image id, naming the
 *        same release source, offline; the harness re-verified before that
 *        child and again after it; `dash01:segmented-dash` in the candidate run
 *        ledger. mp4 + webm + clear-HLS + segmented DASH. -05 records stay
 *        VALID for exactly the candidates they qualified (e.g. RC db11b5ba,
 *        Production 2026-09-30 -> 2026-10-01) and are never re-read under -06.
 *   -06  everything -05 means, PLUS a validated, byte-hashed HLS-11 clear-HLS v2
 *        real-media child (`hls11-release-image-full-path-01`) PASS, executed by
 *        the SAME immutable candidate image id, naming the same release source,
 *        offline; the harness re-verified before that child and again after it;
 *        `hls11:clear-hls-v2` in the candidate run ledger.
 *        mp4 + webm + clear-HLS + segmented DASH + clear-HLS v2 (fMP4). -06
 *        records stay VALID for exactly the candidates they qualified (RC
 *        99ddf3d8, Production 2026-10-01 -> 2026-10-02) and are never re-read
 *        under -07: none of their children measured the merge's A/V timing.
 *   -07  everything -06 means, with the split-merge SYNCHRONIZATION oracle
 *        (SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001): both SPLIT-06
 *        children at `split06-deterministic-full-path-05` (control and offset
 *        full paths; their mandatory sync checks re-checked by the parent), the
 *        DASH-01 child at `dash01-release-image-full-path-02`, PLUS a validated,
 *        byte-hashed SYNC-01 split-merge timing child
 *        (`sync01-release-image-merge-timing-01`) PASS, executed by the SAME
 *        immutable candidate image id, naming the same release source, offline;
 *        the harness re-verified before that child and again after it;
 *        `sync01:merge-timing` in the candidate run ledger. mp4 + webm +
 *        clear-HLS + segmented DASH + clear-HLS v2 (fMP4) + split-merge timing.
 *        -07 records stay VALID for exactly the candidates they qualified (RC
 *        2efb85da, Production since 2026-10-02) and are never re-read under
 *        -08: that source has no separate-audio HLS family to qualify.
 *   -08  everything -07 means, with the clear-HLS v2 child at
 *        `hls11-release-image-full-path-02` (its split master is now consulted
 *        by the Product's own master proof, and refused), PLUS a validated,
 *        byte-hashed HLS-12 separate-audio clear-HLS child
 *        (`hls12-release-image-separate-audio-01`) PASS, executed by the SAME
 *        immutable candidate image id, naming the same release source, offline;
 *        the harness re-verified before that child and again after it;
 *        `hls12:clear-hls-separate-audio` in the candidate run ledger. mp4 +
 *        webm + clear-HLS + segmented DASH + clear-HLS v2 (fMP4) + split-merge
 *        timing + separate-audio clear HLS (fMP4 + fMP4). -08 records stay
 *        VALID historical evidence for exactly the candidate they qualified (RC
 *        `videofetch-worker:rc-b095dfa12f62-262f5633bc38`, `sha256:262f5633…`,
 *        from source `b095dfa1`; never promoted) and for exactly what they
 *        proved — including the separate-audio halves' ONE byte budget — and
 *        are never re-read under -09: their HLS-12 `-01` child never approached
 *        a deadline, so they do NOT release-prove that the two halves share ONE
 *        acquisition deadline.
 *   -09  everything -08 means, with the separate-audio child at
 *        `hls12-release-image-separate-audio-02`: its `neg-deadline` case PASSes
 *        in the SAME immutable candidate image — the video half completed
 *        inside a narrowed configured download budget having used most of it,
 *        and the audio half was stopped, unanswered, AT that same deadline
 *        (`TIMEOUT`, no media tool, no upload) rather than given a fresh one.
 *        The seven children, the candidate run ledger and the harness
 *        checkpoints are -08's. The current release-image qualification: mp4 +
 *        webm + clear-HLS + segmented DASH + clear-HLS v2 (fMP4) + split-merge
 *        timing + separate-audio clear HLS (fMP4 + fMP4, one byte budget and
 *        one acquisition deadline).
 */
export const SPLIT07_EVIDENCE_SCHEMA = "split07-release-image-candidate-09";

/** The historical parent schemas. Never rewritten, and never read as -09. */
export const HISTORICAL_SPLIT07_SCHEMAS = Object.freeze([
  "split07-release-image-candidate-01",
  "split07-release-image-candidate-02",
  "split07-release-image-candidate-03",
  "split07-release-image-candidate-04",
  "split07-release-image-candidate-05",
  "split07-release-image-candidate-06",
  "split07-release-image-candidate-07",
  "split07-release-image-candidate-08",
]);

/** The exact SPLIT-06 schema a SPLIT-07 PASS accepts as a child (`-05` since -07). */
export const REQUIRED_CHILD_SCHEMA = SPLIT06_EVIDENCE_SCHEMA;

/** Both families are required. One is not a release-image acceptance. */
export const REQUIRED_SPLIT_FAMILIES = Object.freeze(["mp4", "webm"]);

/** The exact HLS child schema a PASS accepts (a child since -03; its `-02` since -04). */
export const REQUIRED_HLS_CHILD_SCHEMA = HLS09_RELEASE_EVIDENCE_SCHEMA;

/** The candidate-run purpose of the clear-HLS release child. */
export const HLS_CANDIDATE_RUN_PURPOSE = "hls09:clear-hls";

/** The exact segmented-DASH child schema a PASS accepts (since -05). */
export const REQUIRED_DASH_CHILD_SCHEMA = DASH01_RELEASE_EVIDENCE_SCHEMA;

/** The candidate-run purpose of the segmented-DASH release child. */
export const DASH_CANDIDATE_RUN_PURPOSE = "dash01:segmented-dash";

/** The exact clear-HLS v2 child schema a PASS accepts (a child since -06; its `-02` since -08). */
export const REQUIRED_HLS11_CHILD_SCHEMA = HLS11_RELEASE_EVIDENCE_SCHEMA;

/** The candidate-run purpose of the clear-HLS v2 release child. */
export const HLS11_CANDIDATE_RUN_PURPOSE = "hls11:clear-hls-v2";

/** The exact split-merge timing child schema a PASS accepts (since -07). */
export const REQUIRED_SYNC_CHILD_SCHEMA = SYNC01_RELEASE_EVIDENCE_SCHEMA;

/** The candidate-run purpose of the split-merge timing release child. */
export const SYNC_CANDIDATE_RUN_PURPOSE = "sync01:merge-timing";

/** The exact separate-audio clear-HLS child schema a PASS accepts (a child since -08; its `-02` since -09). */
export const REQUIRED_HLS12_CHILD_SCHEMA = HLS12_RELEASE_EVIDENCE_SCHEMA;

/** The candidate-run purpose of the separate-audio clear-HLS release child. */
export const HLS12_CANDIDATE_RUN_PURPOSE = "hls12:clear-hls-separate-audio";

/**
 * Every candidate container a PASS requires, by purpose: four image probes,
 * two policy verifiers, SPLIT-06 mp4 and webm, (since -03) the HLS-09
 * clear-HLS child, (since -05) the DASH-01 segmented-DASH child, (since -06)
 * the HLS-11 clear-HLS v2 child, (since -07) the SYNC-01 split-merge timing
 * child and (since -08) the HLS-12 separate-audio child. Each one must have
 * executed the immutable image ID; a purpose missing from the record is a
 * characterization that never ran.
 */
export const REQUIRED_CANDIDATE_RUN_PURPOSES = Object.freeze([
  "probe:manifest",
  "probe:tools",
  "probe:env",
  "probe:runtime",
  ...POLICY_VERIFIERS.map((verifier) => `verifier:${verifier}`),
  ...REQUIRED_SPLIT_FAMILIES.map((family) => `split06:${family}`),
  HLS_CANDIDATE_RUN_PURPOSE,
  DASH_CANDIDATE_RUN_PURPOSE,
  HLS11_CANDIDATE_RUN_PURPOSE,
  SYNC_CANDIDATE_RUN_PURPOSE,
  HLS12_CANDIDATE_RUN_PURPOSE,
]);

/**
 * Where the harness is re-verified, in order (exactly). The harness is consumed
 * by every child, so it is verified before any Docker command, after the
 * build, before EACH child, and once more after the last child — since -08 the
 * separate-audio clear-HLS one — before the parent record is assembled.
 */
export const HARNESS_VERIFICATION_POINTS = Object.freeze([
  "before-docker",
  "after-build",
  ...REQUIRED_SPLIT_FAMILIES.map((family) => `before-split06-${family}`),
  "before-hls09-clear-hls",
  "before-dash01-segmented-dash",
  "before-hls11-clear-hls-v2",
  "before-sync01-merge-timing",
  "before-hls12-clear-hls-separate-audio",
  "after-children",
]);

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
 * The ENTRYPOINTs a release candidate may carry: none, or exactly the one the
 * `node:22-bookworm-slim` base declares and `Dockerfile.worker` inherits.
 *
 * That shim is `exec "$@"`, prefixing `node` only when the first argument is a
 * flag or not a command; with `CMD[0] = "node"` it execs the Worker entry point
 * unchanged. It is accepted by NAME here and by OBSERVATION in the driver —
 * root-owned, not writable, a regular file at its own real path, digest
 * recorded — because anything that runs before the Worker is part of what the
 * image starts, and a replaced or writable shim would make "CMD is the Worker
 * entry point" a partial claim.
 */
export const ALLOWED_IMAGE_ENTRYPOINTS = Object.freeze([
  Object.freeze([]),
  Object.freeze(["docker-entrypoint.sh"]),
]);

/** Where the inherited shim resolves on the image's PATH. */
export const ENTRYPOINT_SHIM_PATH = "/usr/local/bin/docker-entrypoint.sh";

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
  "harness/verified-before-execution",
  "harness/driver-is-inside-the-verified-harness",
  "harness/unchanged-after-execution",
  "image/built-from-the-real-dockerfile",
  "image/candidate-tag-is-not-deployable",
  "image/candidate-image-id-valid",
  "image/every-candidate-container-ran-the-immutable-id",
  "image/os-is-linux",
  "image/architecture-recorded",
  "image/working-directory",
  "image/runtime-user-is-non-root-node",
  "image/cmd-is-the-worker-entry-point",
  "image/entrypoint-shim-root-owned-and-unwritable",
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
  "hls/clear-hls-child-executed",
  "hls/clear-hls-child-passed",
  "hls/child-names-the-release-source",
  "hls/child-ran-in-the-candidate-image",
  "hls/child-evidence-unchanged-before-assembly",
  "dash/segmented-dash-child-executed",
  "dash/segmented-dash-child-passed",
  "dash/child-names-the-release-source",
  "dash/child-ran-in-the-candidate-image",
  "dash/child-evidence-unchanged-before-assembly",
  "hls11/clear-hls-v2-child-executed",
  "hls11/clear-hls-v2-child-passed",
  "hls11/child-names-the-release-source",
  "hls11/child-ran-in-the-candidate-image",
  "hls11/child-evidence-unchanged-before-assembly",
  "sync/merge-timing-child-executed",
  "sync/merge-timing-child-passed",
  "sync/child-names-the-release-source",
  "sync/child-ran-in-the-candidate-image",
  "sync/child-evidence-unchanged-before-assembly",
  "hls12/separate-audio-child-executed",
  "hls12/separate-audio-child-passed",
  "hls12/child-names-the-release-source",
  "hls12/child-ran-in-the-candidate-image",
  "hls12/child-evidence-unchanged-before-assembly",
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
  // -07: the child must carry the synchronization oracle on both full-path
  // pairs, each mandatory check exactly once — not merely "every recorded
  // check passed", which a run that skipped the oracle would also satisfy.
  const unmetSync = unmetSplit06SyncChecks(checks).filter((reason) => !reason.endsWith(": failed"));
  const syncOk = unmetSync.length === 0;
  const reasons = [];
  if (!schemaOk) reasons.push(`schema is ${String(record?.schema)}, not ${REQUIRED_CHILD_SCHEMA}`);
  if (!syncOk) reasons.push(`synchronization checks absent or duplicated: ${unmetSync.length}`);
  if (!familyOk) reasons.push(`family is ${String(record?.family)}, not ${family}`);
  if (!verdictOk) reasons.push(`verdict is ${String(record?.verdict)}, not PASS`);
  if (checks.length === 0) reasons.push("the record carries no checks");
  else if (failed.length > 0) reasons.push(`${failed.length} of ${checks.length} checks did not pass`);
  return {
    family,
    ok: schemaOk && familyOk && verdictOk && checksOk && syncOk,
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
 * Validates the HLS-09 clear-HLS child record read from disk (since -03).
 *
 * A dedicated validator, not a presence check: the PARENT reads the exact
 * bytes, hashes them, parses them, and requires the exact HLS-09 schema, a
 * `PASS` verdict, every one of the child's mandatory checks present and every
 * recorded check passing, the release source commit AND tree, the candidate's
 * immutable id as both the child's candidate image and its run subject, the
 * parent's build label, `--network none`, and no private HLS material.
 *
 * `expected`: the parent's OWN observations —
 *   { sourceCommit, sourceTree, candidateTag, candidateImageId }.
 *
 * Returns an observation. Throwing is reserved for input that is not bytes; a
 * record that did not pass comes back `ok: false` so the driver records a FAIL.
 * Only grammar-checked values are echoed, so a hostile child cannot smuggle
 * text into the parent record.
 */
export function validateHlsChildRecord({ bytes, expected }) {
  if (!Buffer.isBuffer(bytes)) {
    throw new ReleaseEvidenceError("the HLS child record must be validated from its exact bytes");
  }
  const digest = sha256Hex(bytes);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      ...emptyHlsChildObservation(),
      sha256: digest, bytes: bytes.length, reason: "the HLS child record is not parseable JSON",
    };
  }
  const problems = validateHlsReleaseChildRecord(record, expected);
  const checks = Array.isArray(record?.checks) ? record.checks : [];
  return {
    ok: problems.length === 0,
    schema: typeof record?.schema === "string" && /^[a-z0-9-]{1,80}$/.test(record.schema) ? record.schema : null,
    verdict: ["PASS", "FAIL", "BLOCKED"].includes(record?.verdict) ? record.verdict : null,
    sha256: digest,
    bytes: bytes.length,
    checkCount: checks.length,
    failedCheckCount: checks.filter((check) => check?.ok !== true).length,
    sourceCommit: isFullGitSha(record?.source?.commit) ? record.source.commit : null,
    sourceTree: isFullGitSha(record?.source?.tree) ? record.source.tree : null,
    candidateTag: isCandidateReference(record?.image?.candidateTag) ? record.image.candidateTag : null,
    candidateImageId: imageIdOrNull(record?.image?.imageId),
    runImageId: imageIdOrNull(record?.image?.runSubject),
    networkMode: typeof record?.network?.mode === "string" && /^[a-z]{1,16}$/.test(record.network.mode)
      ? record.network.mode
      : null,
    reason: problems.length > 0 ? problems.join("; ") : null,
  };
}

/** The observation for an HLS child that never produced readable bytes. */
export function emptyHlsChildObservation(reason = null) {
  return {
    ok: false, schema: null, verdict: null, sha256: null, bytes: 0, checkCount: 0, failedCheckCount: 0,
    sourceCommit: null, sourceTree: null, candidateTag: null, candidateImageId: null, runImageId: null,
    networkMode: null, reason,
  };
}

/**
 * Validates the DASH-01 segmented-DASH child record read from disk (since -05).
 *
 * The same discipline as the clear-HLS child: the PARENT reads the exact bytes,
 * hashes them, parses them, and requires the exact DASH-01 schema, a `PASS`
 * verdict, every one of the child's mandatory checks present exactly once and
 * every recorded check passing, the release source commit AND tree, the
 * candidate's immutable id as both candidate image and run subject, the
 * parent's build label, `--network none`, and no private fixture material.
 * Only grammar-checked values are echoed.
 */
export function validateDashChildRecord({ bytes, expected }) {
  if (!Buffer.isBuffer(bytes)) {
    throw new ReleaseEvidenceError("the DASH child record must be validated from its exact bytes");
  }
  const digest = sha256Hex(bytes);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      ...emptyDashChildObservation(),
      sha256: digest, bytes: bytes.length, reason: "the DASH child record is not parseable JSON",
    };
  }
  const problems = validateDashReleaseChildRecord(record, expected);
  const checks = Array.isArray(record?.checks) ? record.checks : [];
  return {
    ok: problems.length === 0,
    schema: typeof record?.schema === "string" && /^[a-z0-9-]{1,80}$/.test(record.schema) ? record.schema : null,
    verdict: ["PASS", "FAIL", "BLOCKED"].includes(record?.verdict) ? record.verdict : null,
    sha256: digest,
    bytes: bytes.length,
    checkCount: checks.length,
    failedCheckCount: checks.filter((check) => check?.ok !== true).length,
    sourceCommit: isFullGitSha(record?.source?.commit) ? record.source.commit : null,
    sourceTree: isFullGitSha(record?.source?.tree) ? record.source.tree : null,
    candidateTag: isCandidateReference(record?.image?.candidateTag) ? record.image.candidateTag : null,
    candidateImageId: imageIdOrNull(record?.image?.imageId),
    runImageId: imageIdOrNull(record?.image?.runSubject),
    networkMode: typeof record?.network?.mode === "string" && /^[a-z]{1,16}$/.test(record.network.mode)
      ? record.network.mode
      : null,
    reason: problems.length > 0 ? problems.join("; ") : null,
  };
}

/** The observation for a DASH child that never produced readable bytes. */
export function emptyDashChildObservation(reason = null) {
  return emptyHlsChildObservation(reason);
}

/**
 * Validates the HLS-11 clear-HLS v2 child record read from disk (since -06),
 * with exactly the DASH-01 child's discipline: the exact bytes are hashed and
 * parsed, and the exact HLS-11 schema, a `PASS` verdict, every mandatory check
 * present once and every recorded check passing, the release source commit AND
 * tree, the immutable id as candidate image and run subject, the parent's build
 * label, `--network none` and no private fixture material are required.
 */
export function validateHls11ChildRecord({ bytes, expected }) {
  if (!Buffer.isBuffer(bytes)) {
    throw new ReleaseEvidenceError("the HLS-11 child record must be validated from its exact bytes");
  }
  const digest = sha256Hex(bytes);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      ...emptyHls11ChildObservation(),
      sha256: digest, bytes: bytes.length, reason: "the HLS-11 child record is not parseable JSON",
    };
  }
  const problems = validateHls11ReleaseChildRecord(record, expected);
  const checks = Array.isArray(record?.checks) ? record.checks : [];
  return {
    ok: problems.length === 0,
    schema: typeof record?.schema === "string" && /^[a-z0-9-]{1,80}$/.test(record.schema) ? record.schema : null,
    verdict: ["PASS", "FAIL", "BLOCKED"].includes(record?.verdict) ? record.verdict : null,
    sha256: digest,
    bytes: bytes.length,
    checkCount: checks.length,
    failedCheckCount: checks.filter((check) => check?.ok !== true).length,
    sourceCommit: isFullGitSha(record?.source?.commit) ? record.source.commit : null,
    sourceTree: isFullGitSha(record?.source?.tree) ? record.source.tree : null,
    candidateTag: isCandidateReference(record?.image?.candidateTag) ? record.image.candidateTag : null,
    candidateImageId: imageIdOrNull(record?.image?.imageId),
    runImageId: imageIdOrNull(record?.image?.runSubject),
    networkMode: typeof record?.network?.mode === "string" && /^[a-z]{1,16}$/.test(record.network.mode)
      ? record.network.mode
      : null,
    reason: problems.length > 0 ? problems.join("; ") : null,
  };
}

/** The observation for an HLS-11 child that never produced readable bytes. */
export function emptyHls11ChildObservation(reason = null) {
  return emptyHlsChildObservation(reason);
}

/**
 * Validates the SYNC-01 split-merge timing child record read from disk (since
 * -07), with exactly the DASH-01 child's discipline: the exact bytes hashed and
 * parsed; the exact SYNC-01 schema, a `PASS` verdict, every mandatory check
 * present once and every recorded check passing, the release source commit AND
 * tree, the immutable id as candidate image and run subject, the parent's build
 * label, `--network none` and no forbidden material required.
 */
export function validateSyncChildRecord({ bytes, expected }) {
  if (!Buffer.isBuffer(bytes)) {
    throw new ReleaseEvidenceError("the SYNC child record must be validated from its exact bytes");
  }
  const digest = sha256Hex(bytes);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      ...emptySyncChildObservation(),
      sha256: digest, bytes: bytes.length, reason: "the SYNC child record is not parseable JSON",
    };
  }
  const problems = validateSyncReleaseChildRecord(record, expected);
  const checks = Array.isArray(record?.checks) ? record.checks : [];
  return {
    ok: problems.length === 0,
    schema: typeof record?.schema === "string" && /^[a-z0-9-]{1,80}$/.test(record.schema) ? record.schema : null,
    verdict: ["PASS", "FAIL", "BLOCKED"].includes(record?.verdict) ? record.verdict : null,
    sha256: digest,
    bytes: bytes.length,
    checkCount: checks.length,
    failedCheckCount: checks.filter((check) => check?.ok !== true).length,
    sourceCommit: isFullGitSha(record?.source?.commit) ? record.source.commit : null,
    sourceTree: isFullGitSha(record?.source?.tree) ? record.source.tree : null,
    candidateTag: isCandidateReference(record?.image?.candidateTag) ? record.image.candidateTag : null,
    candidateImageId: imageIdOrNull(record?.image?.imageId),
    runImageId: imageIdOrNull(record?.image?.runSubject),
    networkMode: typeof record?.network?.mode === "string" && /^[a-z]{1,16}$/.test(record.network.mode)
      ? record.network.mode
      : null,
    reason: problems.length > 0 ? problems.join("; ") : null,
  };
}

/** The observation for a SYNC child that never produced readable bytes. */
export function emptySyncChildObservation(reason = null) {
  return emptyHlsChildObservation(reason);
}

/**
 * Validates the HLS-12 separate-audio clear-HLS child record read from disk
 * (since -08), with exactly the HLS-11 child's discipline: the exact bytes
 * hashed and parsed; the exact HLS-12 schema, a `PASS` verdict, every
 * mandatory check present once and every recorded check passing, the release
 * source commit AND tree, the immutable id as candidate image and run subject,
 * the parent's build label, `--network none` and no private fixture material.
 */
export function validateHls12ChildRecord({ bytes, expected }) {
  if (!Buffer.isBuffer(bytes)) {
    throw new ReleaseEvidenceError("the HLS-12 child record must be validated from its exact bytes");
  }
  const digest = sha256Hex(bytes);
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      ...emptyHls12ChildObservation(),
      sha256: digest, bytes: bytes.length, reason: "the HLS-12 child record is not parseable JSON",
    };
  }
  const problems = validateHls12ReleaseChildRecord(record, expected);
  const checks = Array.isArray(record?.checks) ? record.checks : [];
  return {
    ok: problems.length === 0,
    schema: typeof record?.schema === "string" && /^[a-z0-9-]{1,80}$/.test(record.schema) ? record.schema : null,
    verdict: ["PASS", "FAIL", "BLOCKED"].includes(record?.verdict) ? record.verdict : null,
    sha256: digest,
    bytes: bytes.length,
    checkCount: checks.length,
    failedCheckCount: checks.filter((check) => check?.ok !== true).length,
    sourceCommit: isFullGitSha(record?.source?.commit) ? record.source.commit : null,
    sourceTree: isFullGitSha(record?.source?.tree) ? record.source.tree : null,
    candidateTag: isCandidateReference(record?.image?.candidateTag) ? record.image.candidateTag : null,
    candidateImageId: imageIdOrNull(record?.image?.imageId),
    runImageId: imageIdOrNull(record?.image?.runSubject),
    networkMode: typeof record?.network?.mode === "string" && /^[a-z]{1,16}$/.test(record.network.mode)
      ? record.network.mode
      : null,
    reason: problems.length > 0 ? problems.join("; ") : null,
  };
}

/** The observation for an HLS-12 child that never produced readable bytes. */
export function emptyHls12ChildObservation(reason = null) {
  return emptyHlsChildObservation(reason);
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
    harness: verifiedHarness(input.harness),

    image: {
      candidateTag: input.image.candidateTag,
      imageId: input.image.imageId,
      // What Docker was actually told to execute, per candidate container,
      // parsed from the argv it was given. The tag above is a build/diagnostic
      // label only.
      runSubject: input.image.runSubject,
      candidateRuns: (Array.isArray(input.image.candidateRuns) ? input.image.candidateRuns : []).map((entry) => ({
        purpose: entry?.purpose ?? null,
        subject: entry?.subject ?? null,
      })),
      os: input.image.os,
      architecture: input.image.architecture,
      acceptedWorkerArchitecture: input.image.acceptedWorkerArchitecture,
      user: input.image.user,
      workingDir: input.image.workingDir,
      cmd: input.image.cmd,
      entrypoint: input.image.entrypoint,
      entrypointShim: input.image.entrypointShim ?? null,
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

    // HLS is not a SPLIT-06 family; its child has its own block. Sanitized
    // facts and a digest only — never the child document itself.
    hlsAcceptance: hlsAcceptanceBlock(input.hlsAcceptance),

    // Since -05: the segmented-DASH real-media child. Sanitized facts and a
    // digest only — never the child document itself.
    dashAcceptance: dashAcceptanceBlock(input.dashAcceptance),

    // Since -06: the clear-HLS v2 real-media child. Sanitized facts and a
    // digest only — never the child document itself.
    hls11Acceptance: hls11AcceptanceBlock(input.hls11Acceptance),

    // Since -07: the split-merge timing child. Sanitized facts and a digest
    // only — never the child document itself.
    syncAcceptance: syncAcceptanceBlock(input.syncAcceptance),

    // Since -08: the separate-audio clear-HLS child. Sanitized facts and a
    // digest only — never the child document itself.
    hls12Acceptance: hls12AcceptanceBlock(input.hls12Acceptance),

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
 * Independent conditions, because each catches a different kind of wrong
 * record: every required check must be present (a stage that never ran cannot
 * be silently absent), every check in the ledger must pass (including ones not
 * on the required list), both SPLIT-06 children must independently be
 * validated PASS records of the exact SPLIT-06 schema, (since -03) the
 * clear-HLS child must be a validated PASS of the exact HLS-09 schema naming
 * this source and this image, (since -05) so must the DASH-01 segmented-DASH
 * child, (since -06) the HLS-11 clear-HLS v2 child, (since -07) the SYNC-01
 * split-merge timing child and (since -08) the HLS-12 separate-audio child.
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

  // -02: the image recorded is the image executed. The id must be a full
  // immutable id, and every required candidate container must have run it.
  const imageId = String(record.image?.imageId ?? "");
  if (!IMAGE_ID_PATTERN.test(imageId)) {
    throw new ReleaseEvidenceError(
      `refusing to emit a PASS record without a valid immutable image ID: ${imageId}`,
    );
  }

  // -03: the clear-HLS release child executed, passed, and names exactly this
  // release source and this candidate image, offline. Missing, failed, of
  // another schema, or naming another source or image: no PASS.
  const hls = record.hlsAcceptance;
  if (hls?.executed !== true || hls.child === null || typeof hls.child !== "object") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record without an executed HLS-09 clear-HLS child");
  }
  if (hls.child.schema !== REQUIRED_HLS_CHILD_SCHEMA) {
    throw new ReleaseEvidenceError(
      `refusing to emit a PASS record whose clear-HLS child is ${String(hls.child.schema)}, not ${REQUIRED_HLS_CHILD_SCHEMA}`,
    );
  }
  if (
    hls.child.verdict !== "PASS" || hls.child.ok !== true ||
    !(hls.child.checkCount > 0) || hls.child.failedCheckCount !== 0
  ) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS child did not pass");
  }
  if (typeof hls.child.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(hls.child.sha256)) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS child has no content digest");
  }
  if (hls.child.sourceCommit !== record.source?.commit || hls.child.sourceTree !== record.source?.tree) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS child names another source");
  }
  if (hls.child.candidateImageId !== imageId || hls.child.runImageId !== imageId) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS child names another image");
  }
  if (hls.child.networkMode !== "none") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS child was not offline");
  }

  // -05: the segmented-DASH real-media child executed, passed, and names
  // exactly this release source and this candidate image, offline.
  const dash = record.dashAcceptance;
  if (dash?.executed !== true || dash.child === null || typeof dash.child !== "object") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record without an executed DASH-01 segmented-DASH child");
  }
  if (dash.child.schema !== REQUIRED_DASH_CHILD_SCHEMA) {
    throw new ReleaseEvidenceError(
      `refusing to emit a PASS record whose segmented-DASH child is ${String(dash.child.schema)}, not ${REQUIRED_DASH_CHILD_SCHEMA}`,
    );
  }
  if (
    dash.child.verdict !== "PASS" || dash.child.ok !== true ||
    !(dash.child.checkCount > 0) || dash.child.failedCheckCount !== 0
  ) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose segmented-DASH child did not pass");
  }
  if (typeof dash.child.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(dash.child.sha256)) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose segmented-DASH child has no content digest");
  }
  if (dash.child.sourceCommit !== record.source?.commit || dash.child.sourceTree !== record.source?.tree) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose segmented-DASH child names another source");
  }
  if (dash.child.candidateImageId !== imageId || dash.child.runImageId !== imageId) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose segmented-DASH child names another image");
  }
  if (dash.child.networkMode !== "none") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose segmented-DASH child was not offline");
  }

  // -06: the clear-HLS v2 real-media child executed, passed, and names exactly
  // this release source and this candidate image, offline.
  const hls11 = record.hls11Acceptance;
  if (hls11?.executed !== true || hls11.child === null || typeof hls11.child !== "object") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record without an executed HLS-11 clear-HLS v2 child");
  }
  if (hls11.child.schema !== REQUIRED_HLS11_CHILD_SCHEMA) {
    throw new ReleaseEvidenceError(
      `refusing to emit a PASS record whose clear-HLS v2 child is ${String(hls11.child.schema)}, not ${REQUIRED_HLS11_CHILD_SCHEMA}`,
    );
  }
  if (
    hls11.child.verdict !== "PASS" || hls11.child.ok !== true ||
    !(hls11.child.checkCount > 0) || hls11.child.failedCheckCount !== 0
  ) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS v2 child did not pass");
  }
  if (typeof hls11.child.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(hls11.child.sha256)) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS v2 child has no content digest");
  }
  if (hls11.child.sourceCommit !== record.source?.commit || hls11.child.sourceTree !== record.source?.tree) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS v2 child names another source");
  }
  if (hls11.child.candidateImageId !== imageId || hls11.child.runImageId !== imageId) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS v2 child names another image");
  }
  if (hls11.child.networkMode !== "none") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose clear-HLS v2 child was not offline");
  }

  // -07: the split-merge timing child executed, passed, and names exactly this
  // release source and this candidate image, offline.
  const sync = record.syncAcceptance;
  if (sync?.executed !== true || sync.child === null || typeof sync.child !== "object") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record without an executed SYNC-01 split-merge timing child");
  }
  if (sync.child.schema !== REQUIRED_SYNC_CHILD_SCHEMA) {
    throw new ReleaseEvidenceError(
      `refusing to emit a PASS record whose split-merge timing child is ${String(sync.child.schema)}, not ${REQUIRED_SYNC_CHILD_SCHEMA}`,
    );
  }
  if (
    sync.child.verdict !== "PASS" || sync.child.ok !== true ||
    !(sync.child.checkCount > 0) || sync.child.failedCheckCount !== 0
  ) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose split-merge timing child did not pass");
  }
  if (typeof sync.child.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sync.child.sha256)) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose split-merge timing child has no content digest");
  }
  if (sync.child.sourceCommit !== record.source?.commit || sync.child.sourceTree !== record.source?.tree) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose split-merge timing child names another source");
  }
  if (sync.child.candidateImageId !== imageId || sync.child.runImageId !== imageId) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose split-merge timing child names another image");
  }
  if (sync.child.networkMode !== "none") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose split-merge timing child was not offline");
  }

  // -08: the separate-audio clear-HLS child executed, passed, and names exactly
  // this release source and this candidate image, offline.
  const hls12 = record.hls12Acceptance;
  if (hls12?.executed !== true || hls12.child === null || typeof hls12.child !== "object") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record without an executed HLS-12 separate-audio child");
  }
  if (hls12.child.schema !== REQUIRED_HLS12_CHILD_SCHEMA) {
    throw new ReleaseEvidenceError(
      `refusing to emit a PASS record whose separate-audio child is ${String(hls12.child.schema)}, not ${REQUIRED_HLS12_CHILD_SCHEMA}`,
    );
  }
  if (
    hls12.child.verdict !== "PASS" || hls12.child.ok !== true ||
    !(hls12.child.checkCount > 0) || hls12.child.failedCheckCount !== 0
  ) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose separate-audio child did not pass");
  }
  if (typeof hls12.child.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(hls12.child.sha256)) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose separate-audio child has no content digest");
  }
  if (hls12.child.sourceCommit !== record.source?.commit || hls12.child.sourceTree !== record.source?.tree) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose separate-audio child names another source");
  }
  if (hls12.child.candidateImageId !== imageId || hls12.child.runImageId !== imageId) {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose separate-audio child names another image");
  }
  if (hls12.child.networkMode !== "none") {
    throw new ReleaseEvidenceError("refusing to emit a PASS record whose separate-audio child was not offline");
  }
  const runs = Array.isArray(record.image?.candidateRuns) ? record.image.candidateRuns : [];
  const purposes = runs.map((entry) => String(entry?.purpose)).sort();
  const expectedPurposes = [...REQUIRED_CANDIDATE_RUN_PURPOSES].sort();
  if (
    record.image?.runSubject !== imageId ||
    runs.some((entry) => entry?.subject !== imageId) ||
    purposes.length !== expectedPurposes.length ||
    purposes.some((purpose, i) => purpose !== expectedPurposes[i])
  ) {
    throw new ReleaseEvidenceError(
      "refusing to emit a PASS record whose candidate containers did not all execute the immutable image ID",
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
    verifiedBy:
      "run-release-image-acceptance.mjs: git against the release build context, before and after the build",
  };
}

/**
 * The `harness` block (since `-02`), admitted only when it is the driver's
 * VERIFIED observation, before AND after the run. Every emitted record carries
 * it: the driver refuses to assemble any record once a harness check fails, so
 * a record whose harness was not verified throughout would be a false
 * statement, and none is produced.
 *
 * The topology facts are OBSERVED, not assumed. SPLIT-07A drives a release
 * context at a merged product commit from a separate, unmerged harness
 * checkout; SPLIT-07B may legitimately use one merged commit, and even one
 * checkout, for both roles. The record says which happened.
 */
function verifiedHarness(harness) {
  const verified =
    harness !== null &&
    typeof harness === "object" &&
    isFullGitSha(harness.commit) &&
    isFullGitSha(harness.tree) &&
    isFullGitSha(harness.directoryTree) &&
    isFullGitSha(harness.driverObject) &&
    harness.directory === HARNESS_DIRECTORY &&
    harness.driverPath === HARNESS_DRIVER_PATH &&
    harness.contextClean === true &&
    harness.verifiedBeforeRun === true &&
    harness.verifiedAfterRun === true &&
    harness.driverInsideHarness === true &&
    typeof harness.worktreeIsReleaseContext === "boolean" &&
    typeof harness.commitIsReleaseSource === "boolean" &&
    // EXACTLY every checkpoint, in order — including the ones before the
    // clear-HLS (-03), segmented-DASH (-05), clear-HLS v2 (-06), split-merge
    // timing (-07) and separate-audio (-08) children — and the last one after
    // all seven children.
    Array.isArray(harness.verificationPoints) &&
    harness.verificationPoints.length === HARNESS_VERIFICATION_POINTS.length &&
    harness.verificationPoints.every((point, i) => point === HARNESS_VERIFICATION_POINTS[i]);
  if (!verified) {
    throw new ReleaseEvidenceError(
      `refusing to emit a ${SPLIT07_EVIDENCE_SCHEMA} record without driver-verified harness provenance`,
    );
  }
  return {
    commit: harness.commit,
    tree: harness.tree,
    directory: harness.directory,
    directoryTree: harness.directoryTree,
    driverPath: harness.driverPath,
    driverObject: harness.driverObject,
    contextClean: true,
    verifiedBeforeRun: true,
    verifiedAfterRun: true,
    verificationPoints: [...harness.verificationPoints],
    driverInsideHarness: true,
    worktreeIsReleaseContext: harness.worktreeIsReleaseContext,
    commitIsReleaseSource: harness.commitIsReleaseSource,
    verifiedBy:
      "run-release-image-acceptance.mjs: git against --harness, before any Docker command and at every checkpoint " +
      "to the end of all seven children (SPLIT-06 mp4, SPLIT-06 webm, HLS-09 clear-HLS, DASH-01 segmented DASH, " +
      "HLS-11 clear-HLS v2, SYNC-01 split-merge timing, HLS-12 separate-audio clear HLS)",
  };
}

/**
 * The `hlsAcceptance` block, from an allowlist. Absent input is recorded as
 * not executed — which a PASS then refuses — rather than assumed.
 */
function hlsAcceptanceBlock(input) {
  const child = input?.child ?? null;
  return {
    requiredChildSchema: REQUIRED_HLS_CHILD_SCHEMA,
    executed: input?.executed === true,
    child:
      child === null || typeof child !== "object"
        ? null
        : {
            schema: child.schema ?? null,
            verdict: child.verdict ?? null,
            ok: child.ok === true,
            sha256: child.sha256 ?? null,
            bytes: child.bytes ?? 0,
            checkCount: child.checkCount ?? 0,
            failedCheckCount: child.failedCheckCount ?? 0,
            evidenceFile: child.evidenceFile ?? null,
            sourceCommit: child.sourceCommit ?? null,
            sourceTree: child.sourceTree ?? null,
            candidateTag: child.candidateTag ?? null,
            candidateImageId: child.candidateImageId ?? null,
            runImageId: child.runImageId ?? null,
            networkMode: child.networkMode ?? null,
            reason: child.reason ?? null,
          },
  };
}

/**
 * The `dashAcceptance` block (since -05), from an allowlist. Absent input is
 * recorded as not executed — which a PASS then refuses — rather than assumed.
 */
function dashAcceptanceBlock(input) {
  const block = hlsAcceptanceBlock(input);
  return { ...block, requiredChildSchema: REQUIRED_DASH_CHILD_SCHEMA };
}

/** The `hls11Acceptance` block (since -06), on the same terms. */
function hls11AcceptanceBlock(input) {
  const block = hlsAcceptanceBlock(input);
  return { ...block, requiredChildSchema: REQUIRED_HLS11_CHILD_SCHEMA };
}

/** The `syncAcceptance` block (since -07), on the same terms. */
function syncAcceptanceBlock(input) {
  const block = hlsAcceptanceBlock(input);
  return { ...block, requiredChildSchema: REQUIRED_SYNC_CHILD_SCHEMA };
}

/** The `hls12Acceptance` block (since -08), on the same terms. */
function hls12AcceptanceBlock(input) {
  const block = hlsAcceptanceBlock(input);
  return { ...block, requiredChildSchema: REQUIRED_HLS12_CHILD_SCHEMA };
}

/**
 * Reads a parent record back under the CURRENT schema's rules.
 *
 * Returns the problems; an empty list means the record is a `-09` record for
 * exactly `expected` (`{ sourceCommit, imageId }`) and, when it says PASS,
 * that it earns PASS under -09 rules. A historical `-01`..`-08` record is never
 * silently read as `-09`: it is named as historical, because a `-02` PASS
 * proves mp4 + webm and nothing about clear HLS, a `-03` PASS proves clear HLS
 * under the protocol invariant `-04` restated, a `-04` PASS carries no
 * real-media segmented-DASH child, a `-05` PASS carries no clear-HLS v2 (fMP4)
 * child, a `-06` PASS carries no split-merge timing measurement, a `-07` PASS
 * carries no separate-audio clear-HLS child, and an `-08` PASS carries one
 * (HLS-12 `-01`) that never release-proved the ONE shared acquisition deadline.
 */
export function validateReleaseParentRecord(record, expected = {}) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["the record is not an object"];
  const problems = [];
  if (HISTORICAL_SPLIT07_SCHEMAS.includes(record.schema)) {
    // -08 carries the separate-audio child at HLS-12 `-01`, which never
    // approached a deadline. The other seven carry no separate-audio child at
    // all; -01..-06 also lack the split-merge timing children, -01..-05 the
    // clear-HLS v2 child, -01..-04 the segmented-DASH child.
    const why = record.schema === "split07-release-image-candidate-08"
      ? "its separate-audio clear-HLS child does not release-prove the shared acquisition deadline"
      : "it does not carry the separate-audio clear-HLS child";
    problems.push(`${record.schema} is a historical schema, not ${SPLIT07_EVIDENCE_SCHEMA}; ${why}`);
    return problems;
  }
  if (record.schema !== SPLIT07_EVIDENCE_SCHEMA) {
    problems.push(`schema is ${String(record.schema)}, not ${SPLIT07_EVIDENCE_SCHEMA}`);
    return problems;
  }
  if (expected.sourceCommit !== undefined && record.source?.commit !== expected.sourceCommit) {
    problems.push("source commit mismatch");
  }
  if (expected.imageId !== undefined && record.image?.imageId !== expected.imageId) problems.push("image id mismatch");
  for (const gate of [() => verifiedSource(record.source), () => verifiedHarness(record.harness)]) {
    try {
      gate();
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (record.verdict === "PASS") {
    try {
      assertPassEarned(record);
    } catch (error) {
      problems.push(error.message);
    }
  } else if (record.verdict !== "FAIL") {
    problems.push(`verdict is ${String(record.verdict)}`);
  }
  return problems;
}

/** One deterministic JSON document, pretty-printed for review. */
export function renderReleaseEvidence(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function imageIdOrNull(value) {
  return typeof value === "string" && IMAGE_ID_PATTERN.test(value) ? value : null;
}

function isCandidateReference(value) {
  try {
    assertCandidateReference(value);
    return true;
  } catch {
    return false;
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
