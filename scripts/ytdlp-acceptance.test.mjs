// Tests for the generic yt-dlp Production acceptance harness (§54; CORRECTION-01 §35/§36).
//
// Lives under `scripts/` so `npm test` picks it up through the existing
// `node --test 'scripts/**/*.test.mjs'` glob. The subject under test lives in
// `deploy/acceptance/ytdlp-generic/`.
//
// NOTHING HERE RUNS LIVE. The CLI-shaped tests substitute the EXTERNAL SYSTEMS
// — a fake read-only command runner and a fake fetch — and let the real
// orchestration run against them. They deliberately do NOT hand the evaluators
// finished truth objects, because that is exactly the gap CORRECTION-01 closes.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  evaluateLiveGate,
  readStage,
  readOption,
  readOptionList,
  LIVE_ENV_NAME,
} from "../deploy/acceptance/ytdlp-generic/lib/gate.mjs";
import {
  OUTCOMES,
  check,
  measuredCheck,
  summarize,
  stageBPermitted,
} from "../deploy/acceptance/ytdlp-generic/lib/verdict.mjs";
import {
  redactUrl,
  redactText,
  redactDeep,
  describePresence,
  scrubSecrets,
  safeOutput,
  createSafeConsole,
} from "../deploy/acceptance/ytdlp-generic/lib/redact.mjs";
import {
  classifyAcquisitionTree,
  evaluateNamespaceIdentity,
  evaluateNodeContainment,
  evaluateTerminationCleanliness,
  evaluateYtdlpIdentity,
  evaluateGroupTermination,
  validateSampleShape,
  descendantsOf,
  ALLOWED_SAMPLE_FIELDS,
  YTDLP_RUNTIME_BASENAMES,
  ALLOWED_ACQUISITION_DESCENDANTS,
} from "../deploy/acceptance/ytdlp-generic/lib/process-tree.mjs";
import {
  establishYtdlpPid,
  makeProcessSampler,
  parseDockerTop,
  UNCLASSIFIED_COMM,
} from "../deploy/acceptance/ytdlp-generic/lib/process-sampler.mjs";
import * as processSamplerModule from "../deploy/acceptance/ytdlp-generic/lib/process-sampler.mjs";
import {
  evaluateTransitionTrace,
  classifyTransitionTrace,
  classifySuccessTransitionTrace,
  classifyCancellationTrace,
  REQUIRED_TRANSITIONS,
} from "../deploy/acceptance/ytdlp-generic/lib/lifecycle.mjs";
import {
  evaluateStageA,
  enablementAuthorized,
  rejectsStageBConfiguration,
  REQUIRED_SERVICES,
} from "../deploy/acceptance/ytdlp-generic/lib/stage-a.mjs";
import {
  rowContentObservation,
  evaluateStageB,
  stageBAuthorization,
  presetsAreApplicationOwned,
  isApplicationOwnedFormatId,
  FORBIDDEN_DURABLE_FIELDS,
  RESTART_RECOVERY,
} from "../deploy/acceptance/ytdlp-generic/lib/stage-b.mjs";
import {
  buildEvidence,
  renderEvidence,
  mintSentinel,
  withSentinel,
  sweepForSentinel,
} from "../deploy/acceptance/ytdlp-generic/lib/evidence.mjs";
import {
  isReadOnlyCommand,
  assertDurableJobId,
  durableProbeArgv,
  parseDurableProbeResponse,
  DURABLE_PROBE_SOURCE,
  DURABLE_PROBE_ERROR_CODES,
  DURABLE_PROBE_MAX_STDOUT,
  WORKER_NODE_PATH,
  workDirProbeArgv,
  makeSystemObservers,
  parseMaxFileSize,
  decodeEnvProbe,
  DOCKER_TOP_COLUMNS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DURABLE_JOB_QUERY,
  DURABLE_SAFE_COLUMNS,
  WORKER_STATE_DB,
  WORKER_STATE_DIRECTORY,
  WORKER_DATABASE_FILENAME,
  WORKER_JOBS_TABLE,
  EJS_PROBE_ARGV,
  ENV_NAMES_PROBE_ARGV,
  YTDLP_ENABLED_PROBE_ARGV,
  MAX_FILE_SIZE_PROBE_ARGV,
} from "../deploy/acceptance/ytdlp-generic/lib/observers.mjs";
import {
  buildCaseRecord,
  validateCaseRecord,
  evaluateFeatureContinuity,
  pickPreset,
  caseNames,
  liveCaseNames,
  hasExecutableProducer,
  evaluateCaseFeatureState,
  evaluateContainerEpoch,
  expectedFeatureStateFor,
  restartEndpointsOf,
  spansOneRestart,
  CONTAINER_INSTANCE_PATTERN,
  CASE_PRODUCERS,
  CASE_SCHEMA_VERSION,
  GENERIC_EXPECTED_DIGEST_ENV,
  HARNESS_ID,
  parseGenericExpectedDigest,
  runSuccessCase,
} from "../deploy/acceptance/ytdlp-generic/lib/cases.mjs";
import {
  readDenyCounter,
  fingerprintChain,
  attributeDenial,
  parseDenyClass,
  DENY_CLASSES,
} from "../deploy/acceptance/ytdlp-generic/lib/egress-policy.mjs";
import { parseHostProcessList } from "../deploy/acceptance/ytdlp-generic/lib/observers.mjs";
import { readFile } from "node:fs/promises";
import {
  producerFor,
  hasConcreteProducer,
  nonLiveCheckIds,
} from "../deploy/acceptance/ytdlp-generic/lib/coverage.mjs";
import {
  aggregateDownloadWindow,
  createDownloadWindowCollector,
  nodeContained,
  nodeExercised,
  ytdlpIdentified,
} from "../deploy/acceptance/ytdlp-generic/lib/download-window.mjs";
import {
  canonicalize,
  sealRecord,
  verifySeal,
  verifyRecord,
  validateDeploymentBinding,
  bindingAgreesWithRecord,
  loadOrCreateRun,
  loadRun,
  EVIDENCE_SCHEMA_VERSION,
  RUN_ID_PATTERN,
} from "../deploy/acceptance/ytdlp-generic/lib/provenance.mjs";
import { main, loadStageA, observeRuntimeEpoch } from "../deploy/acceptance/ytdlp-generic/acceptance.mjs";

// ── Fixtures ───────────────────────────────────────────────────────────────

const measured = (value) => ({ measured: true, value });
const unmeasured = (reason) => ({ measured: false, reason });

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
/**
 * Container OBJECT ids — the runtime epoch tokens (§9 of CORRECTION-07).
 *
 * Deliberately unlike the image id: the whole point of the epoch model is that
 * these two identities answer different questions and can move independently.
 */
const CONTAINER_A = "c".repeat(64);
const CONTAINER_B = "b".repeat(64);
const CONTAINER_C = "d".repeat(64);
const SHA = "90be3d079a26b851c5f7496801647568533e6a2d";
const JOB_ID = "fb63f3170c2342717c7dd8af11d09418";
/** The byte-limit case runs its own job, so its ladder cannot disturb the success case. */
const BYTE_JOB_ID = "bb63f3170c2342717c7dd8af11d09418";
const FULL_LADDER = [...REQUIRED_TRANSITIONS];

const digestOf = (text) => createHash("sha256").update(text).digest("hex");
/** The namespace holder's PID in the fake world; distinct from the Worker's. */
const MEDIA_NETNS_PID = 1391;

/** A canonical 64-hex Docker container id, as `{{.Id}}` renders one. */
const MEDIA_NETNS_ID = "6c81c4cd406a8660a0accba4f6c9c46417ecee96d8b508577d359c10affa3537";

const FIXTURE_BODY = "acceptance-fixture-bytes";
const FIXTURE_DIGEST = digestOf(FIXTURE_BODY);

function passingStageAObservations(overrides = {}) {
  const services = {};
  for (const unit of REQUIRED_SERVICES) services[unit] = measured({ unit, activeState: "active" });

  return {
    expectedSha: SHA,
    services,
    runningImageId: measured(IMAGE_ID),
    imageShaTag: measured({ expectedSha: SHA, taggedImageId: IMAGE_ID, runningImageId: IMAGE_ID }),
    imageLatestAlias: measured({ latestImageId: IMAGE_ID, taggedImageId: IMAGE_ID }),
    egressVerifier: measured({ exitCode: 0 }),
    workerNetworkPlacement: measured({
      // The shape Docker ACTUALLY reports: `--network container:<name>` is
      // resolved at creation time and stored as the target's canonical id.
      targetContainerId: MEDIA_NETNS_ID,
      mediaNetnsContainerId: MEDIA_NETNS_ID,
      workerPid: 14312,
      mediaNetnsPid: 1391,
      workerNetNamespace: "net:[4026532355]",
      mediaNetNamespace: "net:[4026532355]",
    }),
    ytdlpVersion: measured("2026.08.19"),
    pythonVersion: measured("3.11.2"),
    nodeVersion: measured("v22.23.2"),
    bundledEjsVersion: measured("0.8.0"),
    capabilities: measured({ ytdlp: false, ytdlpInstalled: true, ytdlpEnabled: false, ffmpeg: true }),
    ytdlpEnabledRaw: measured(null),
    workerEnvironmentNames: measured([
      "WORKER_CONTROL_KEY_ID",
      "WORKER_CONTROL_SECRET",
      "R2_ACCOUNT_ID",
      "R2_BUCKET",
    ]),
    directRegression: measured({
      status: "ready",
      extractor: "direct",
      expectedDigest: FIXTURE_DIGEST,
      deliveredDigest: FIXTURE_DIGEST,
      expectedBytes: FIXTURE_BODY.length,
      deliveredBytes: FIXTURE_BODY.length,
    }),
    ...overrides,
  };
}

const passingStageA = () => evaluateStageA(passingStageAObservations());

/** A process sample in which acquisition looks exactly as designed. */
function acquisitionSample(extra = []) {
  return [
    { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[4026532001]" },
    // The owned acquisition process: its own group leader (detached spawn).
    { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: "net:[4026532001]" },
    ...extra,
  ];
}

/** A downloading-window observation built from a list of process samples. */
function windowOf(samples, opts = {}) {
  return {
    samples: samples.map((sample) => ({
      sample,
      ytdlpPid: opts.ytdlpPid === undefined ? 200 : opts.ytdlpPid,
      at: "2026-09-02T00:00:00.000Z",
    })),
    workerPid: opts.workerPid ?? 100,
    expectedNetns: opts.expectedNetns ?? "net:[4026532001]",
    observedDownloading: opts.observedDownloading ?? true,
    // The two coverage gaps travel WITH the window; they are not equivalent and
    // the aggregate treats them differently.
    samplerErrors: opts.samplerErrors ?? [],
    ambiguousSamples: opts.ambiguousSamples ?? [],
  };
}

function cancellationEvidence(overrides = {}) {
  return {
    jobId: JOB_ID,
    extractor: "yt-dlp",
    transitions: ["queued", "analyzing", "downloading", "cancelled"],
    lateReady: false,
    // The EXACT captured acquisition group, and its host-level survivors.
    capturedPgid: 200,
    capturedYtdlpPid: 200,
    capturedComm: "python3",
    groupMembersMeasured: true,
    groupSurvivors: [],
    groupQueryReason: null,
    beganProcessing: false,
    uploaded: false,
    workDirMeasured: true,
    workDirPresent: false,
    ...overrides,
  };
}

function shutdownEvidence(overrides = {}) {
  return {
    jobId: JOB_ID,
    extractor: "yt-dlp",
    transitions: ["queued", "analyzing", "downloading"],
    capturedPgid: 200,
    capturedYtdlpPid: 200,
    capturedComm: "python3",
    restartObserved: true,
    previousContainerPid: 100,
    currentContainerPid: 400,
    groupMembersMeasured: true,
    groupSurvivors: [],
    groupQueryReason: null,
    // The Worker's deterministic restart-recovery result.
    recoveredStatus: "failed",
    recoveredErrorCode: "PROCESSING_FAILED",
    recoveredSafeErrorMessage: "Worker restarted before the job completed.",
    recoveryPolls: 3,
    lateReady: false,
    ...overrides,
  };
}

/** The deployed default, as `MEDIA_DEFAULTS.maxFileSizeBytes` sets it. */
const DEFAULT_LIMIT_BYTES = 500 * 1024 * 1024;
const CASE_ID = "9".repeat(32);

/**
 * Values the harness must NEVER retrieve (§7 of CORRECTION-05).
 *
 * Deliberately unmistakable: any occurrence anywhere in a command, a result, a
 * log line, an evidence record or an error is a genuine leak, not a false
 * positive from a short or generic string.
 */
const SECRET_SENTINELS = Object.freeze({
  workerControl: "VF_MUST_NEVER_BE_OBSERVED_worker_control_2f9c1a",
  access: "VF_SECOND_SECRET_access_7d4b8e",
});

function byteLimitEvidence(overrides = {}) {
  return {
    jobId: JOB_ID,
    // §10-§12 of CORRECTION-04: causally bound to one case, and carrying BOTH
    // sides of the threshold comparison it asserts.
    caseId: CASE_ID,
    extractor: "yt-dlp",
    declaredLengthUnknown: true,
    actualMediaRequestObserved: true,
    mediaRequestCount: 1,
    contentLengthPresent: false,
    transferMode: "chunked",
    bytesServed: 600_000_000,
    effectiveMaxFileSizeBytes: DEFAULT_LIMIT_BYTES,
    limitSource: "default",
    exceededLimit: true,
    outcome: "TOO_LARGE",
    transitions: ["queued", "analyzing", "downloading"],
    beganProcessing: false,
    uploaded: false,
    workDirPresent: false,
    ...overrides,
  };
}

/**
 * A case record carrying the feature state that case is defined to run in.
 *
 * The harness measures this live; the tests fill it from the same registry the
 * validator consults, so a test record is realistic by construction.
 */
function caseRecord({
  caseName,
  binding,
  payload,
  state,
  imageContinuity,
  featureContinuity,
  containerEpoch,
  ...rest
}) {
  const imageId = binding?.runningImageId ?? IMAGE_ID;
  const phase = featureState(state ?? expectedFeatureStateFor(caseName) ?? "enabled");
  return buildCaseRecord({
    caseName,
    binding,
    payload,
    featureState: phase,
    // The producing CLI measures BOTH the image and the feature state on either
    // side of the producer; a realistic test record carries the same evidence.
    featureContinuity:
      featureContinuity ?? { before: phase, after: phase, sameRequiredState: true },
    imageContinuity:
      imageContinuity ?? { before: imageId, after: imageId, taggedImageId: imageId, same: true },
    // §9-§14 of CORRECTION-07: which running instance produced the evidence.
    // `shutdown` is the one case that pins a transition rather than one epoch.
    containerEpoch: containerEpoch ?? defaultEpochFor(caseName, payload),
    ...rest,
  });
}

/** The container epoch a truthful record for this case would carry. */
function defaultEpochFor(caseName, payload) {
  if (caseName !== "shutdown") {
    return { mode: "continuous", before: CONTAINER_A, restartFrom: null, restartTo: null, after: CONTAINER_A };
  }
  const shutdownCase = payload?.shutdownCase ?? {};
  const from = shutdownCase.previousContainerInstanceId ?? CONTAINER_A;
  const to = shutdownCase.currentContainerInstanceId ?? CONTAINER_B;
  return { mode: "one-restart", before: from, restartFrom: from, restartTo: to, after: to };
}

/** A sealed feature state, as the harness measures it when a case runs. */
function featureState(state = "enabled", overrides = {}) {
  const enabled = state === "enabled";
  return {
    state,
    ytdlpEnabledRaw: enabled ? "true" : null,
    sites: { ytdlp: enabled, ytdlpInstalled: true, ytdlpEnabled: enabled },
    observedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function egressEvidence(overrides = {}) {
  return {
    jobId: JOB_ID,
    genericPathEstablished: true,
    extractor: "yt-dlp",
    forbiddenClass: "deny-v4",
    denied: true,
    attributedToBoundary: true,
    denyCounterBefore: 10,
    denyCounterAfter: 12,
    denyCounterDelta: 2,
    policyVerifiedBefore: true,
    policyVerifiedAfter: true,
    ...overrides,
  };
}

const APP_PRESETS = [
  { id: "preset:720", formatId: "preset:720", container: "mp4", label: "720p", resolution: "720p" },
  { id: "preset:audio", formatId: "preset:audio", container: "m4a", label: "Audio", resolution: null },
];

function passingStageBObservations(overrides = {}) {
  return {
    expectedSha: SHA,
    runningImageId: measured(IMAGE_ID),
    capabilities: measured({ ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true }),
    ytdlpEnabledRaw: measured("true"),
    // The two historical phases, each from the case that observed it, plus the
    // state at aggregation time (recorded, never used to grade a phase).
    enabledFeatureState: measured(featureState("enabled")),
    disabledFeatureState: measured(featureState("disabled")),
    finalFeatureState: measured(featureState("enabled")),
    genericAnalysis: measured({
      extractor: "yt-dlp",
      directControlExtractor: "direct",
      formats: [],
      presets: APP_PRESETS,
      thumbnail: null,
    }),
    genericJob: measured({
      jobId: JOB_ID,
      transitions: FULL_LADDER,
      requestedFormatId: "preset:720",
    }),
    durableJobRow: measured({
      present: true,
      jobId: JOB_ID,
      status: "ready",
      formatId: "preset:720",
      extractor: "yt-dlp",
    }),
    selectorConstraints: measured({ containerMatches: true }),
    downloadingWindow: measured(windowOf([acquisitionSample()])),
    egressNegative: measured(egressEvidence()),
    egressPolicyFingerprint: measured({ beforeMatchesAfter: true, rulesetFingerprintStable: true }),
    r2Evidence: measured({ objectExists: true, contentLength: 83089 }),
    workerEnvironmentNames: measured(["WORKER_CONTROL_KEY_ID", "R2_ACCOUNT_ID"]),
    vercelDelivery: measured({
      redirectStatus: 303,
      presigned: true,
      clientBytes: 83089,
      clientDigest: "b".repeat(64),
      durableFileSize: 83089,
      r2ContentLength: 83089,
      // CORRECTION-01 §8: the independently known fixture digest, and it must
      // equal what the client received.
      expectedDigest: "b".repeat(64),
    }),
    sentinelSweep: measured({
      leaked: false,
      leakedSurfaces: [],
      surfacesChecked: ["journal", "docker-logs", "durable-row", "job-metadata", "api-error"],
    }),
    cancellation: measured(cancellationEvidence()),
    byteLimitCase: measured(byteLimitEvidence()),
    shutdownCase: measured(shutdownEvidence()),
    directAfterEnable: measured({
      status: "ready",
      extractor: "direct",
      processSamplingMeasured: true,
      samplesTaken: 5,
      // The coverage gaps travel with the evidence; zero is a MEASURED zero.
      samplingErrors: [],
      samplingErrorCount: 0,
      sampledBasenames: ["node"],
    }),
    failClosedRuntime: measured({ genericUsable: false, fellBackToPath: false, directStillWorks: true }),
    killSwitch: measured({ genericUsableAfterDisable: false, directWorks: true }),
    siteCatalog: measured({ limitedEntriesPromoted: false }),
    ...overrides,
  };
}

// ── A fake external world for the CLI-shaped tests ─────────────────────────
//
// Substitutes the SYSTEMS (command runner, fetch), never the observations. The
// CLI, the observers, the control-plane driver, the sampler, the case producers
// and the evaluators all run for real against it.

// ── Disposable durable databases ───────────────────────────────────────────
//
// The durable observer is no longer a fake-able external command, so these
// tests do not fake it. They build a REAL SQLite database using the Worker's
// OWN `CREATE TABLE worker_jobs` statement — extracted from the migration
// source rather than retyped — and run the real read-only reader against it.
//
// Extracting the DDL is the point. A retyped schema is a third parallel
// description of the deployment, and a third thing that can drift out of
// agreement with Production; that drift is the entire defect this change
// exists to correct, so reintroducing it here would be self-defeating.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS_SOURCE = readFileSync(
  join(REPO_ROOT, "src/worker/state/migrations.server.ts"),
  "utf8",
);
const STATE_DIRECTORY_SOURCE = readFileSync(
  join(REPO_ROOT, "src/worker/runtime/state-directory.server.ts"),
  "utf8",
);

/** The Worker's own `worker_jobs` DDL, taken verbatim from its migration. */
const WORKER_JOBS_DDL = (() => {
  const match = MIGRATIONS_SOURCE.match(/CREATE TABLE worker_jobs \([\s\S]*?\) STRICT;/);
  assert.ok(match, "the Worker migration must define CREATE TABLE worker_jobs");
  return match[0];
})();

const DURABLE_TMP_ROOT = mkdtempSync(join(tmpdir(), "vf-durable-"));
let durableDbSeq = 0;

after(() => {
  rmSync(DURABLE_TMP_ROOT, { recursive: true, force: true });
});

/**
 * Creates a disposable durable database carrying the Worker's real schema.
 *
 * `url` is seeded with a sentinel on purpose: the projection must leave it in
 * the database, and every assertion about "the sentinel did not leak" is
 * meaningless unless the sentinel was genuinely there to leak.
 */
function makeDurableDatabase(rows = [], opts = {}) {
  const dir = join(DURABLE_TMP_ROOT, `db-${durableDbSeq++}`);
  mkdirSync(dir, { recursive: true });
  const databasePath = join(dir, WORKER_DATABASE_FILENAME);

  const db = new DatabaseSync(databasePath);
  db.exec(WORKER_JOBS_DDL);
  if (opts.wal === true) db.exec("PRAGMA journal_mode = WAL");
  const insert = db.prepare(
    `INSERT INTO ${WORKER_JOBS_TABLE}
       (job_id, url, format_id, principal_id, status, extractor,
        created_at_ms, updated_at_ms, expires_at_ms)
     VALUES (?, ?, ?, 'private-access-user', ?, ?, 1, 1, 2)`,
  );
  for (const row of rows) {
    insert.run(
      row.jobId,
      row.url ?? "https://example.invalid/watch?v=x",
      row.formatId ?? "preset:720",
      row.status ?? "ready",
      row.extractor ?? "yt-dlp",
    );
  }
  // A WAL database is left OPEN when the caller asks for one, so the `-wal` and
  // `-shm` sidecars are present and uncheckpointed while it is read — which is
  // the state the live Worker's database is always in.
  if (opts.keepOpen === true) return { databasePath, db, dir };
  db.close();
  return { databasePath, db: null, dir };
}

function makeFakeWorld(options = {}) {
  const env = {
    ytdlpEnabled: options.ytdlpEnabled ?? null,
    services: options.services ?? "active",
    egressExit: options.egressExit ?? 0,
    ytdlpVersion: options.ytdlpVersion ?? "2026.08.19",
    sites: options.sites ?? { ytdlp: false, ytdlpInstalled: true, ytdlpEnabled: false, ffmpeg: true },
    imageIds: options.imageIds ?? { [`videofetch-worker:${SHA}`]: IMAGE_ID, "videofetch-worker:latest": IMAGE_ID },
    runningImage: options.runningImage ?? IMAGE_ID,
    // Simulated deployment drift, counted rather than scheduled, because a
    // CLI-shaped test cannot intervene part-way through `main()`.
    //
    //   imageDriftsAfterReads      — the running image changes after this many
    //                                `{{.Image}}` reads (redeployed mid-case)
    //   restartAfterIdReads        — the operator's Worker restart lands after
    //                                this many `{{.Id}}` reads
    //   restartAfterPidReads       — …or after this many `{{.State.Pid}}` reads,
    //                                which is how a restart is placed INSIDE
    //                                the watcher's id -> pid -> id bracket
    imageDriftsAfterReads: options.imageDriftsAfterReads ?? null,
    imageAfterDrift: options.imageAfterDrift ?? `sha256:${"e".repeat(64)}`,
    restartAfterIdReads: options.restartAfterIdReads ?? null,
    restartAfterPidReads: options.restartAfterPidReads ?? null,
    imageAfterRestart: options.imageAfterRestart ?? null,
    pidAfterRestart: options.pidAfterRestart,
    pidAfterRecreation: options.pidAfterRecreation,
    // §9-§14 of CORRECTION-07: the RUNTIME EPOCH, modelled independently of
    // the image so a recreation that keeps image and feature state identical —
    // the case endpoint equality cannot see — is representable.
    //
    //   instanceAfterRestart        the object the observed restart brings back
    //   recreateAfterIdReads        a SECOND recreation, after N id reads
    //   recreateAfterPidReads       …or after N PID reads
    //   instanceAfterRecreation     the object that one brings back
    //   containerIdUnreadable       the epoch cannot be measured at all
    //   idUnreadableAtReads         the container is DOWN for exactly these
    //                               `{{.Id}}` reads — a transient stop, which
    //                               is an UNOBSERVED interval rather than an
    //                               observed intermediate epoch (§4 of
    //                               CORRECTION-09)
    instanceAfterRestart: options.instanceAfterRestart ?? null,
    recreateAfterIdReads: options.recreateAfterIdReads ?? null,
    recreateAfterPidReads: options.recreateAfterPidReads ?? null,
    instanceAfterRecreation: options.instanceAfterRecreation ?? CONTAINER_C,
    containerIdUnreadable: options.containerIdUnreadable ?? false,
    idUnreadableAtReads: options.idUnreadableAtReads ?? [],
    // §15 of CORRECTION-06: a restart may bring the SAME image back with a
    // DIFFERENT deployment feature state. Modelling that explicitly is what
    // proves image continuity does not stand in for feature continuity.
    ytdlpEnabledAfterRestart: options.ytdlpEnabledAfterRestart,
    sitesAfterRestart: options.sitesAfterRestart,
    // A restart is not the only way the deployment state can move under a
    // case. This flips it after N reads of the YTDLP_ENABLED probe, which is a
    // deterministic point for cases that never touch the container PID.
    featureFlipsAfterEnvReads: options.featureFlipsAfterEnvReads ?? null,
    ytdlpEnabledAfterFlip: options.ytdlpEnabledAfterFlip,
    sitesAfterFlip: options.sitesAfterFlip,
    // The single non-secret deployment variable the byte-limit case reads.
    // `undefined` means the deployment does not set it and the Worker's own
    // 500 MiB default applies.
    maxFileSize: options.maxFileSize,
  };
  const calls = { commands: [], fetches: [], logins: 0 };

  // Mutable container identity. A restart changes the PID AND the container
  // object; whether it changes the IMAGE is exactly what the continuity checks
  // exist to detect, and whether it changes the FEATURE STATE is what the
  // CORRECTION-06 checks exist to detect.
  const live = {
    image: env.runningImage,
    pid: 100,
    containerInstanceId: options.containerInstanceId ?? CONTAINER_A,
    imageReads: 0,
    pidReads: 0,
    idReads: 0,
    downReadsServed: 0,
    envReads: 0,
    restarted: false,
    recreated: false,
    flipped: false,
  };

  function currentImage() {
    live.imageReads += 1;
    if (env.imageDriftsAfterReads !== null && live.imageReads > env.imageDriftsAfterReads) {
      live.image = env.imageAfterDrift;
    }
    return live.image;
  }

  /**
   * The operator's Worker restart, as ONE atomic event (§13 of CORRECTION-08).
   *
   * A real restart changes the container object, the main PID, the resolved
   * image and the bound environment together — it is not a PID change that the
   * instance id happens to follow. Modelling it as one mutation is what lets a
   * test assert that the watcher's endpoints are coherent, because an
   * incoherent pairing can then only come from the harness, never from the fake.
   */
  function applyRestart() {
    live.restarted = true;
    live.pid = env.pidAfterRestart ?? 400;
    // The unit is `docker run --rm` behind an `ExecStartPre=-docker rm -f`,
    // so a Worker restart is a container RECREATION: a new object id.
    live.containerInstanceId = env.instanceAfterRestart ?? CONTAINER_B;
    if (env.imageAfterRestart) live.image = env.imageAfterRestart;
    // The container comes back with whatever the operator left in the
    // environment file — which may not be what it went down with.
    if (env.ytdlpEnabledAfterRestart !== undefined) {
      if (env.ytdlpEnabledAfterRestart === null) delete workerEnvironment.YTDLP_ENABLED;
      else workerEnvironment.YTDLP_ENABLED = String(env.ytdlpEnabledAfterRestart);
    }
    if (env.sitesAfterRestart) env.sites = env.sitesAfterRestart;
  }

  /** A second, UNOBSERVED recreation — the container moves again, on its own. */
  function applyRecreation() {
    live.recreated = true;
    live.containerInstanceId = env.instanceAfterRecreation;
    if (env.pidAfterRecreation !== undefined) live.pid = env.pidAfterRecreation;
  }

  /**
   * Runtime mutations are hung off a NAMED read, so a test can place an event
   * at an exact point in the harness's own observation sequence.
   *
   * Both `id` and `pid` are available as trigger points because the watcher's
   * coherence bracket is `id -> pid -> id`: placing a restart on the PID read
   * is precisely how §13's "race between old instance and old PID" is
   * reproduced, and it must be impossible to express through an id-only knob.
   */
  function noteRuntimeRead(kind) {
    const count = kind === "id" ? (live.idReads += 1) : (live.pidReads += 1);
    const restartAfter = kind === "id" ? env.restartAfterIdReads : env.restartAfterPidReads;
    const recreateAfter = kind === "id" ? env.recreateAfterIdReads : env.recreateAfterPidReads;
    if (!live.restarted && restartAfter !== null && count > restartAfter) applyRestart();
    if (!live.recreated && recreateAfter !== null && count > recreateAfter) applyRecreation();
  }

  function currentContainerInstanceId() {
    noteRuntimeRead("id");
    return live.containerInstanceId;
  }

  function currentContainerPid() {
    noteRuntimeRead("pid");
    return live.pid;
  }

  // The controlled byte-limit fixture, as a state machine rather than a static
  // document: it remembers the case id the submitted URL carried and answers
  // only for that case (§10-§12 of CORRECTION-04).
  const fixture = {
    submittedCaseIds: [],
    ...options.byteLimitFixture,
  };

  // The fake container's REAL environment, values and all.
  //
  // The secrets are deliberately unmistakable: the harness is supposed to never
  // retrieve them, so the fake models a container that genuinely holds them and
  // the tests assert they never come back. A fake that simply had no secrets
  // could not catch a regression to a full-environment dump.
  //
  // Mutable, because a restart can legitimately change it — see
  // `ytdlpEnabledAfterRestart`.
  const workerEnvironment = {
    WORKER_CONTROL_KEY_ID: "acceptance-key-id",
    WORKER_CONTROL_SECRET: SECRET_SENTINELS.workerControl,
    VIDEOFETCH_ACCESS_SECRET: SECRET_SENTINELS.access,
    R2_ACCOUNT_ID: "an-account",
    R2_BUCKET: "a-bucket",
    ...(env.maxFileSize === undefined ? {} : { MAX_FILE_SIZE: String(env.maxFileSize) }),
    ...(env.ytdlpEnabled === null ? {} : { YTDLP_ENABLED: String(env.ytdlpEnabled) }),
    ...options.extraEnvironment,
  };

  async function runReadOnly(file, argv) {
    calls.commands.push([file, ...argv].join(" "));
    // The real allowlist still governs: a fake world must not be able to run
    // something the harness would refuse in Production.
    if (!isReadOnlyCommand(file, argv)) throw new Error(`fake world refused: ${file}`);

    const joined = argv.join(" ");
    if (file === "systemctl") return { exitCode: 0, stdout: `${env.services}\n`, stderr: "" };
    if (file === "/usr/local/sbin/vf-egress-policy-verify") {
      return { exitCode: env.egressExit, stdout: "", stderr: "" };
    }
    if (file === "readlink") return { exitCode: 0, stdout: "net:[4026532001]\n", stderr: "" };
    if (file === "docker") {
      if (argv[0] === "image" && argv[1] === "inspect") {
        const ref = argv[argv.length - 1];
        const id = env.imageIds[ref];
        return id
          ? { exitCode: 0, stdout: `${id}\n`, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "no such image" };
      }
      if (argv[0] === "inspect") {
        if (joined.includes("{{.Image}}")) {
          return { exitCode: 0, stdout: `${currentImage()}\n`, stderr: "" };
        }
        if (joined.includes("NetworkMode")) {
          // The shape Docker ACTUALLY stores: the RESOLVED target id, never the
          // name. The fake emitted the name until REMEDIATION-02, which is why
          // the retired evaluator looked correct in tests and failed a healthy
          // Production Worker.
          return { exitCode: 0, stdout: `container:${MEDIA_NETNS_ID}\n`, stderr: "" };
        }
        // Deliberately still answered with the COMPLETE NAME=value environment.
        // The allowlist now refuses this template, so the branch is unreachable
        // — and if a regression ever reopens it, the secret-non-observation
        // tests catch a real leak rather than a sanitized stand-in.
        if (joined.includes(".Config.Env")) {
          const lines = Object.entries(workerEnvironment).map(([k, v]) => `${k}=${v}`);
          return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
        }
        if (joined.includes(".State.Pid")) {
          // The namespace holder is a DIFFERENT container with its own PID.
          if (argv[argv.length - 1] === "videofetch-media-netns") {
            return { exitCode: 0, stdout: `${MEDIA_NETNS_PID}\n`, stderr: "" };
          }
          return { exitCode: 0, stdout: `${currentContainerPid()}\n`, stderr: "" };
        }
        if (joined.includes("{{.Id}}")) {
          if (argv[argv.length - 1] === "videofetch-media-netns") {
            return { exitCode: 0, stdout: `${MEDIA_NETNS_ID}\n`, stderr: "" };
          }
          if (env.containerIdUnreadable) {
            return { exitCode: 1, stdout: "", stderr: "no such container" };
          }
          // The read still ADVANCES the sequence — a stopped container is an
          // attempt that happened — but reports the container as gone, which is
          // how the watcher learns the stop half occurred.
          const id = currentContainerInstanceId();
          if (env.idUnreadableAtReads.includes(live.idReads)) {
            live.downReadsServed += 1;
            return { exitCode: 1, stdout: "", stderr: "no such container" };
          }
          return { exitCode: 0, stdout: `${id}\n`, stderr: "" };
        }
      }
      if (argv[0] === "top") {
        return {
          exitCode: 0,
          // Overridable so a test can present the exact listing that would
          // defeat the downloading-window assertions.
          stdout:
            options.dockerTopStdout ??
            "PID PPID PGID COMMAND\n100 1 100 node\n200 100 200 python3\n",
          stderr: "",
        };
      }
      if (argv[0] === "logs") return { exitCode: 0, stdout: "worker started\n", stderr: "" };
      if (argv[0] === "exec") {
        // The three narrow environment probes, answered exactly as a real
        // container would: names only, or one named variable only.
        const probe = argv.slice(2).join(" ");
        if (probe === ENV_NAMES_PROBE_ARGV.join(" ")) {
          return { exitCode: 0, stdout: `${Object.keys(workerEnvironment).sort().join("\n")}\n`, stderr: "" };
        }
        if (probe === YTDLP_ENABLED_PROBE_ARGV.join(" ")) {
          const value = workerEnvironment.YTDLP_ENABLED;
          const answer = value === undefined ? "<UNSET>" : `SET:${value}`;
          live.envReads += 1;
          if (
            env.featureFlipsAfterEnvReads !== null &&
            live.envReads >= env.featureFlipsAfterEnvReads &&
            !live.flipped
          ) {
            live.flipped = true;
            if (env.ytdlpEnabledAfterFlip === null) delete workerEnvironment.YTDLP_ENABLED;
            else if (env.ytdlpEnabledAfterFlip !== undefined) {
              workerEnvironment.YTDLP_ENABLED = String(env.ytdlpEnabledAfterFlip);
            }
            if (env.sitesAfterFlip) env.sites = env.sitesAfterFlip;
          }
          // The answer is the state BEFORE this read's flip took effect, which
          // is what a real read at that instant would have returned.
          return { exitCode: 0, stdout: `${answer}\n`, stderr: "" };
        }
        if (probe === MAX_FILE_SIZE_PROBE_ARGV.join(" ")) {
          const value = workerEnvironment.MAX_FILE_SIZE;
          return { exitCode: 0, stdout: `${value === undefined ? "<UNSET>" : `SET:${value}`}\n`, stderr: "" };
        }
        if (joined.includes("node --version")) return { exitCode: 0, stdout: "v22.23.2\n", stderr: "" };
        if (joined.endsWith("/usr/bin/python3 --version")) {
          return { exitCode: 0, stdout: "Python 3.11.2\n", stderr: "" };
        }
        if (argv.slice(2).join(" ") === EJS_PROBE_ARGV.join(" ")) {
          return { exitCode: 0, stdout: "0.8.0\n", stderr: "" };
        }
        if (joined.includes("os.path.isdir")) return { exitCode: 0, stdout: "False\n", stderr: "" };
      }
    }
    // The durable read is now ONE fixed in-container probe. The fake answers
    // it with the same closed response contract the real probe emits, so the
    // command boundary and the response parser are both exercised for real.
    if (file === "docker" && argv[0] === "exec" && argv[3] === "-e") {
      if (options.durableProbe === "process-failed") {
        return { exitCode: 1, stdout: JSON.stringify({ kind: "row" }), stderr: "boom" };
      }
      if (options.durableProbe === "malformed") {
        return { exitCode: 0, stdout: "{not json", stderr: "" };
      }
      if (options.durableProbe) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ kind: "error", code: options.durableProbe }),
          stderr: "",
        };
      }
      const jobId = argv[5];
      if (jobId !== JOB_ID) {
        return { exitCode: 0, stdout: JSON.stringify({ kind: "absent", jobId }), stderr: "" };
      }
      if (options.durableRowAbsent === true) {
        return { exitCode: 0, stdout: JSON.stringify({ kind: "absent", jobId }), stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          kind: "row",
          jobId,
          status: options.durableStatus ?? "ready",
          formatId: options.durableFormatId ?? "preset:720",
          extractor: options.durableExtractor ?? "yt-dlp",
        }),
        stderr: "",
      };
    }
    if (file === "journalctl") return { exitCode: 0, stdout: "no errors\n", stderr: "" };
    // There is deliberately NO `sqlite3` branch: `isReadOnlyCommand` no longer
    // admits that command in any shape, so a stub could only describe a path
    // that cannot run.
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  // Job state machine: each status poll advances one rung, EXCEPT `downloading`,
  // which is held for several polls. A real acquisition dwells there for
  // seconds; a fake that leaves after one poll gives the process sampler no
  // window to complete a snapshot in, and every sample would straddle the close.
  const DOWNLOADING_POLLS = options.downloadingPolls ?? 4;
  // The byte guard aborts DURING acquisition, so this job never reaches
  // `processing` — which is exactly what `limit.actual-byte-guard` asserts.
  const BYTE_LIMIT_LADDER = ["queued", "analyzing", "downloading", "failed"];
  const jobs = new Map();

  /**
   * The Worker's own restart recovery, modelled faithfully.
   *
   * `recover()` in `src/worker/state/sqlite-job-store.server.ts` moves every job
   * left in `analyzing`, `downloading`, `processing` or `uploading` to failed /
   * PROCESSING_FAILED / 'Worker restarted before the job completed.'. A fake
   * that let an interrupted job march on to `ready` would let the acceptance
   * harness assert a contract nothing had to satisfy.
   */
  const RECOVERABLE = new Set(["analyzing", "downloading", "processing", "uploading"]);
  function recoveredView(jobId, extractor) {
    return {
      jobId,
      status: "failed",
      extractor,
      fileSize: null,
      container: null,
      quality: null,
      filename: null,
      errorCode: "PROCESSING_FAILED",
      // The browser projection of `safeErrorMessage`; see public-job.ts.
      error: "Worker restarted before the job completed.",
      stageLabel: "Worker restarted",
      expiresAt: Date.now() + 60_000,
    };
  }

  function nextJob(jobId, extractor) {
    const job = jobs.get(jobId);
    const ladder = job.ladder ?? FULL_LADDER;
    if (live.restarted && (job.recovered || RECOVERABLE.has(ladder[job.index]))) {
      job.recovered = true;
      return recoveredView(jobId, extractor);
    }
    const current = ladder[job.index];
    if (current === "downloading" && job.dwell < DOWNLOADING_POLLS) {
      job.dwell += 1;
    } else if (job.index < ladder.length - 1) {
      job.index += 1;
    }
    const status = ladder[job.index];
    return {
      jobId,
      status,
      extractor,
      fileSize: status === "ready" ? FIXTURE_BODY.length : null,
      container: "mp4",
      quality: "720p",
      filename: "acceptance.mp4",
      // The durable error code IS the byte-limit outcome.
      errorCode: status === "failed" && job.ladder ? "TOO_LARGE" : undefined,
      expiresAt: Date.now() + 60_000,
    };
  }

  async function fetchImpl(target, init = {}) {
    const url = new URL(String(target));
    calls.fetches.push(`${init.method ?? "GET"} ${url.pathname}`);
    const json = (body, status = 200, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      json: async () => body,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
    });

    if (url.pathname === "/api/access/login") {
      calls.logins += 1;
      if (options.loginFails) return json({ error: "nope" }, 401);
      return json({ ok: true }, 200, { "set-cookie": "vf_access=token; Path=/; HttpOnly" });
    }
    if (url.pathname === "/api/sites") return json(env.sites);
    if (url.pathname === "/api/diagnostics") {
      return json({ runtime: { ytdlpVersion: env.ytdlpVersion }, binaries: { ytdlp: true, ffmpeg: true } });
    }
    if (url.pathname === "/api/analyze") {
      const body = JSON.parse(init.body);
      const isGeneric = body.url.includes("generic");
      return json({
        success: true,
        video: {
          title: "t",
          thumbnail: null,
          duration: 10,
          source: "s",
          extractor: isGeneric ? "yt-dlp" : "direct",
          webpageUrl: body.url,
          formats: [],
          presets: isGeneric ? APP_PRESETS : [],
          capabilities: { mp3: false, merge: false },
        },
      });
    }
    if (url.pathname === "/api/download") {
      const body = JSON.parse(init.body);
      const submitted = new URL(body.url);
      const isByteLimit = submitted.pathname.includes("bytelimit");
      const isGeneric = body.url.includes("generic");
      if (isByteLimit) {
        // The fixture associates the media request it is about to serve with
        // the case id the submitted URL carried.
        fixture.submittedCaseIds.push(submitted.searchParams.get("vf_case"));
      }
      const jobId = isByteLimit ? BYTE_JOB_ID : isGeneric ? JOB_ID : "aa".repeat(16);
      jobs.set(jobId, {
        index: 0,
        dwell: 0,
        extractor: isGeneric ? "yt-dlp" : "direct",
        ladder: isByteLimit ? BYTE_LIMIT_LADDER : undefined,
      });
      return json({ jobId, status: "queued", extractor: null });
    }
    // The controlled fixture's own read-only evidence endpoint.
    if (url.pathname === "/byte-evidence") {
      const asked = url.searchParams.get("vf_case");
      const known = fixture.submittedCaseIds[fixture.submittedCaseIds.length - 1] ?? null;
      if (fixture.notFound) return json({ error: "unknown case" }, 404);
      return json({
        caseId: fixture.caseIdOverride ?? (asked === known ? known : null),
        actualMediaRequestObserved: fixture.actualMediaRequestObserved ?? true,
        mediaRequestCount: fixture.mediaRequestCount ?? 1,
        contentLengthPresent: fixture.contentLengthPresent ?? false,
        transferMode: fixture.transferMode ?? "chunked",
        bytesServed: fixture.bytesServed ?? 600_000_000,
        observedAt: "2026-01-01T00:00:00.000Z",
      });
    }
    if (url.pathname.endsWith("/status")) {
      const jobId = url.pathname.split("/")[3];
      // An unknown job is a genuine 404 error body — which is what the sentinel
      // sweep's `api-error` surface deliberately exercises.
      if (!jobs.has(jobId)) return json({ error: "Not found", code: "NOT_FOUND" }, 404);
      return json(nextJob(jobId, jobs.get(jobId).extractor));
    }
    // The Worker's own authenticated routes (cancel + job view).
    if (url.pathname.startsWith("/v1/jobs/")) {
      const jobId = url.pathname.split("/")[3];
      if (url.pathname.endsWith("/cancel")) return json({ success: true, job: { jobId, status: "cancelled" } });
      return json({
        success: true,
        job: {
          jobId,
          status: "ready",
          fileSize: FIXTURE_BODY.length,
          objectKey: `videofetch/jobs/${jobId}/${"9".repeat(32)}`,
        },
      });
    }
    if (url.pathname.endsWith("/file")) {
      return {
        ok: false,
        status: 303,
        headers: new Headers({
          location: "https://object.invalid/videofetch/jobs/x/y?X-Amz-Signature=deadbeef",
        }),
        json: async () => null,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    // The fixture and the presigned object both return the same bytes.
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "video/mp4" }),
      json: async () => ({}),
      arrayBuffer: async () => new TextEncoder().encode(FIXTURE_BODY).buffer,
    };
  }

  return { runReadOnly, fetch: fetchImpl, calls, env, live, workerEnvironment };
}

/** Runs the real CLI against a fake external world. */
async function runCli(argv, env, deps = {}) {
  const lines = [];
  const errors = [];
  const files = deps.files ?? new Map();
  // Filesystem entries that exist WITHOUT readable contents — a symlink is the
  // real case. `lstat` must see them (so an evidence path they occupy is
  // refused) while `readFile` still cannot produce bytes.
  const links = deps.links ?? new Set();
  const modes = new Map();
  const writeOptions = new Map();
  const code = await main(argv, env, {
    log: (line) => lines.push(String(line)),
    errorLog: (line) => errors.push(String(line)),
    // The filesystem is a SUBSTITUTED EXTERNAL SYSTEM, like the command runner
    // and fetch. The CLI's own provenance logic still runs for real against it.
    //
    // §15 of CORRECTION-07: `flag: "wx"` is honoured exactly as `node:fs` would
    // honour it — an exclusive create against an existing path fails EEXIST.
    // Modelling it is what lets a CLI-level test observe the race at all.
    writeFile: async (path, contents, options) => {
      if (options?.flag === "wx" && files.has(path)) {
        throw Object.assign(new Error(`file already exists: ${path}`), { code: "EEXIST" });
      }
      files.set(path, contents);
      if (options) writeOptions.set(path, options);
      if (options?.mode) modes.set(path, options.mode);
    },
    readFile: async (path) => {
      if (files.has(path)) return files.get(path);
      throw new Error(`no such file ${path}`);
    },
    mkdir: async () => {},
    chmod: async (path, mode) => modes.set(path, mode),
    // §26 of CORRECTION-04: the run-key permission check is now strict — an
    // unmeasurable mode fails closed on the real filesystem. The controlled
    // adapter reports the private mode the harness itself writes, and ENOENT
    // for a file that does not exist, exactly as `node:fs/promises` would.
    stat: async (path) => {
      if (!files.has(path)) {
        const error = new Error(`no such file ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return { mode: modes.get(path) ?? 0o600 };
    },
    // §6 of CORRECTION-08: the evidence-path gate uses `lstat`, so a SYMLINK
    // occupying the path is the entry itself rather than whatever it points at.
    // Modelling it separately from `stat` is what lets a CLI-level test prove
    // the gate does not follow the link.
    lstat: async (path) => {
      if (links.has(path)) return { isSymbolicLink: () => true };
      if (files.has(path)) return { isSymbolicLink: () => false };
      const error = new Error(`no such file ${path}`);
      error.code = "ENOENT";
      throw error;
    },
    sleep: async () => {},
    // A monotonic counter clock. The real harness uses `performance.now()`;
    // the tests need strictly increasing values so a snapshot's interval can be
    // ordered against the window close deterministically.
    monotonicNow: (() => {
      let tick = 0;
      return () => (tick += 1);
    })(),
    ...deps,
  });
  return { code, out: lines.join("\n"), err: errors.join("\n"), files, links, modes, writeOptions };
}

const LIVE_ENV = (extra = {}) => ({
  [LIVE_ENV_NAME]: "1",
  VIDEOFETCH_ACCESS_SECRET: "an-actual-access-secret-value",
  // CORRECTION-01: the generic fixture's pre-job digest. The fake control plane
  // serves FIXTURE_BODY, so a run whose delivery is honest hashes to exactly
  // this — which is what makes a DIVERGENT digest a discriminating failure
  // rather than a fixture mismatch. Cases that must refuse it override it.
  VIDEOFETCH_ACCEPT_GENERIC_SHA256: FIXTURE_DIGEST,
  ...extra,
});

/** The Worker control credential, for cases that use the Worker's own routes. */
const WORKER_ENV = {
  VF_WORKER_ORIGIN: "http://127.0.0.1:8080",
  VF_CONTROL_KEY_ID: "acceptance-key",
  VF_CONTROL_SECRET: "an-acceptance-worker-control-secret",
};

const LIVE_ARGS = ["--live", "--base-url", "https://control.invalid", "--expected-sha", SHA];

/**
 * A pre-existing acceptance run, as Stage A would have created.
 *
 * Stage B cases and the aggregation JOIN a run rather than minting one, so the
 * tests seed the key file exactly as a real operator's Stage A run leaves it.
 */
const RUN_KEY_PATH = "./.vf-acceptance-run.json";
function seedRun(files = new Map()) {
  files.set(RUN_KEY_PATH, JSON.stringify({ runId: "a1b2c3d4e5f60718", key: "c".repeat(64) }));
  return files;
}

// ── 1-3. Accidental-live prevention (§9, §27) ──────────────────────────────

describe("accidental live execution", () => {
  it("1. default invocation cannot run live", async () => {
    assert.equal(evaluateLiveGate([], {}).live, false);
    const run = await runCli(["--stage", "A"], {});
    assert.equal(run.code, 2);
    assert.match(run.out, /LIVE EXECUTION REFUSED/);
    assert.match(run.out, /Production mutation\s*:\s*NONE/);
    assert.match(run.out, /network media request\s*:\s*NONE/);
    assert.match(run.out, /job created\s*:\s*NONE/);
  });

  it("2. one live gate missing refuses — either half alone", async () => {
    assert.equal(evaluateLiveGate(["--live"], {}).live, false);
    assert.equal(evaluateLiveGate([], { [LIVE_ENV_NAME]: "1" }).live, false);

    const flagOnly = await runCli(["--stage", "A", "--live"], {});
    assert.equal(flagOnly.code, 2);
    assert.match(flagOnly.out, /missing VIDEOFETCH_ACCEPT_LIVE=1/);

    const envOnly = await runCli(["--stage", "A"], { [LIVE_ENV_NAME]: "1" });
    assert.equal(envOnly.code, 2);
    assert.match(envOnly.out, /missing --live/);
  });

  it("2b. the environment half requires an EXACT value", () => {
    for (const value of ["true", "yes", "0", " 1", "1 ", "1\n", "01", ""]) {
      assert.equal(evaluateLiveGate(["--live"], { [LIVE_ENV_NAME]: value }).live, false);
    }
    assert.equal(evaluateLiveGate(["--live"], { [LIVE_ENV_NAME]: "1" }).live, true);
  });

  it("2c. nothing auto-detects a live run", () => {
    const productionish = {
      DOCKER_HOST: "unix:///var/run/docker.sock",
      VIDEOFETCH_ACCEPT_GENERIC_URL: "https://example.invalid/generic",
      VIDEOFETCH_ACCESS_SECRET: "x".repeat(40),
      CI: "true",
      NODE_ENV: "production",
    };
    assert.equal(evaluateLiveGate([], productionish).live, false);
    assert.equal(evaluateLiveGate(["--stage", "A"], productionish).live, false);
  });

  it("2d. EVERY subcommand goes through the same gate (§27)", async () => {
    for (const argv of [
      ["--stage", "A"],
      ["--stage", "B", "--case", "success"],
      ["--stage", "B", "--case", "cancellation"],
      ["--stage", "B", "--case", "kill-switch"],
      ["--stage", "B", "--aggregate"],
    ]) {
      const run = await runCli(argv, {});
      assert.equal(run.code, 2, `${argv.join(" ")} must dry-run`);
      assert.match(run.out, /LIVE EXECUTION REFUSED/);
      // No subcommand may reach a system or the network without both signals.
      assert.doesNotMatch(run.out, /LIVE ACCEPTANCE/);
    }
  });
});

// ── CORRECTION-01 §35: the CLI is a real orchestrator ──────────────────────

describe("real CLI orchestration", () => {
  it("35. a full Stage A run reaches PASS through real observers", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/stage-a.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
      }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );

    assert.equal(run.code, 0, `expected PASS, got:\n${run.out}\n${run.err}`);
    assert.match(run.out, /ENABLEMENT AUTHORIZED/);
    assert.match(run.out, /VERDICT: PASS/);

    // Every gate was genuinely measured by the CLI, not injected.
    for (const id of [
      "image.identity",
      "image.matches-authorized-sha",
      "image.latest-alias-is-same-object",
      "safe-egress.verifier",
      "worker.network-mode",
      "runtime.ytdlp-version",
      "runtime.python-series",
      "runtime.node-family",
      "runtime.bundled-ejs",
      "capability.implemented",
      "config.ytdlp-disabled",
      "capability.generic-not-usable",
      "worker-env.forbidden-absent",
      "worker-env.required-present",
      "direct.regression-ready",
      "direct.byte-integrity",
    ]) {
      assert.match(run.out, new RegExp(`\\[ok  \\] ${id.replace(/\./g, "\\.")}`), `${id} must pass`);
    }
    for (const unit of REQUIRED_SERVICES) {
      assert.match(run.out, new RegExp(`\\[ok  \\] service\\.${unit}`));
    }

    // And it actually talked to the fake systems.
    assert.ok(world.calls.commands.some((c) => c.startsWith("systemctl is-active")));
    assert.ok(world.calls.commands.some((c) => c.includes("vf-egress-policy-verify")));
    assert.ok(world.calls.commands.some((c) => c.includes("image inspect")));
    assert.ok(world.calls.fetches.includes("GET /api/sites"));
    assert.ok(world.calls.fetches.includes("GET /api/diagnostics"));
    assert.ok(world.calls.fetches.includes("POST /api/download"));
  });

  it("35b. the Stage A evidence record carries the deployment binding", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/stage-a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    const record = JSON.parse(run.files.get("/tmp/stage-a.json"));
    assert.equal(record.verdict, "PASS");
    assert.equal(record.binding.expectedSha, SHA);
    assert.equal(record.binding.runningImageId, IMAGE_ID);
    assert.equal(record.harness, HARNESS_ID);
  });

  it("35c. a Stage B success case produces a real, sealed case record", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const run = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/case-success.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
        ...WORKER_ENV,
      }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);

    const record = JSON.parse(run.files.get("/tmp/case-success.json"));
    assert.equal(record.harness, HARNESS_ID);
    assert.equal(record.case, "success");
    assert.equal(record.schemaVersion, CASE_SCHEMA_VERSION);
    assert.equal(record.expectedSha, SHA);
    // Produced by the real pipeline: a full ladder, a real digest, a real sample.
    assert.deepEqual(record.payload.genericJob.transitions, FULL_LADDER);
    assert.equal(record.payload.genericJob.requestedFormatId, "preset:720");
    assert.equal(record.payload.durableJobRow.formatId, "preset:720");
    assert.match(record.payload.vercelDelivery.clientDigest, /^[0-9a-f]{64}$/);
    assert.equal(record.payload.downloadingWindow.observedDownloading, true);
    assert.ok(record.payload.downloadingWindow.samples.length > 0);
    assert.equal(record.payload.sentinelSweep.leaked, false);
  });

  it("35d. Stage B aggregation turns real case records into a verdict", async () => {
    // ONE acceptance run, as on the VM: Stage A creates the run key, then every
    // Stage B case joins it, then the aggregation verifies against it.
    const files = new Map();

    const stageAWorld = makeFakeWorld();
    const stageA = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/stage-a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: stageAWorld.runReadOnly, fetch: stageAWorld.fetch, files },
    );
    assert.equal(stageA.code, 0, `${stageA.out}\n${stageA.err}`);
    assert.ok(files.has(RUN_KEY_PATH), "Stage A must create the acceptance run key");

    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const liveEnv = LIVE_ENV({
      VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
      VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
      ...WORKER_ENV,
    });
    const shared = { runReadOnly: world.runReadOnly, fetch: world.fetch, files };

    const success = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/c-success.json"],
      liveEnv,
      shared,
    );
    assert.equal(success.code, 0, `${success.out}\n${success.err}`);

    const aggregate = await runCli(
      [
        "--stage", "B", "--aggregate", ...LIVE_ARGS,
        "--stage-a", "/tmp/stage-a.json",
        "--case-evidence", "/tmp/c-success.json",
        "--evidence", "/tmp/stage-b.json",
      ],
      liveEnv,
      shared,
    );

    assert.match(aggregate.out, /accepted case evidence: success/, `${aggregate.out}\n${aggregate.err}`);
    // The success case's own checks passed…
    for (const id of [
      "analysis.generic-selected",
      "analysis.direct-still-selected",
      "analysis.presets-application-owned",
      "job.lifecycle-complete",
      "durable.application-format-id",
      "process.window-observed",
      "process.ytdlp-identified",
      "process.no-ffmpeg-during-downloading",
      "vercel.byte-integrity",
      "privacy.sentinel-not-leaked",
      "r2.delegated-write",
    ]) {
      assert.match(aggregate.out, new RegExp(`\\[ok  \\] ${id.replace(/\./g, "\\.")}`), id);
    }
    // …while the cases that were NOT run are BLOCKED, never skipped to PASS.
    assert.match(aggregate.out, /\[BLKD\] cancel\.durable-cancelled/);
    assert.match(aggregate.out, /\[BLKD\] limit\.actual-byte-guard/);
    assert.match(aggregate.out, /\[BLKD\] shutdown\.group-terminated/);
    assert.match(aggregate.out, /\[BLKD\] safe-egress\.forbidden-destination-denied/);
    assert.equal(aggregate.code, 2, "an incomplete Stage B is BLOCKED");
  });

  it("35e. a case record from ANOTHER acceptance run is rejected", async () => {
    const files = new Map();
    const stageAWorld = makeFakeWorld();
    const stageA = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/stage-a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: stageAWorld.runReadOnly, fetch: stageAWorld.fetch, files },
    );
    assert.equal(stageA.code, 0);

    // A case record sealed by a DIFFERENT run's key.
    const foreign = sealRecord(
      caseRecord({
        caseName: "cancellation",
        binding: { expectedSha: SHA, runningImageId: IMAGE_ID },
        payload: { cancellation: cancellationEvidence({ postSample: [] }) },
        runId: "ffffffffffffffff",
      }),
      "d".repeat(64),
    );
    files.set("/tmp/foreign.json", JSON.stringify(foreign));

    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const aggregate = await runCli(
      [
        "--stage", "B", "--aggregate", ...LIVE_ARGS,
        "--stage-a", "/tmp/stage-a.json",
        "--case-evidence", "/tmp/foreign.json",
        "--evidence", "/tmp/aggregate-foreign.json",
      ],
      LIVE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );
    assert.match(aggregate.err, /rejected case evidence/);
    assert.match(aggregate.out, /accepted case evidence: none/);
  });
});

// ── CORRECTION-01 §4/§5: control-plane authentication ──────────────────────

describe("control-plane authentication", () => {
  it("5. a live run with the access secret invokes login exactly once", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/login-once.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.equal(run.code, 0);
    assert.equal(world.calls.logins, 1, "login must be invoked exactly once per run");
    assert.match(run.out, /session established \(cookie held in memory only\)/);
  });

  it("5b. a missing access secret is a USAGE failure, not a capability failure", async () => {
    const world = makeFakeWorld();
    const run = await runCli(["--stage", "A", ...LIVE_ARGS], { [LIVE_ENV_NAME]: "1" }, {
      runReadOnly: world.runReadOnly,
      fetch: world.fetch,
    });
    assert.equal(run.code, 3, "usage failure, never a graded run");
    assert.match(run.err, /VIDEOFETCH_ACCESS_SECRET is required/);
    assert.match(run.err, /rather than a missing credential/);
    assert.equal(world.calls.logins, 0);
    assert.equal(world.calls.fetches.length, 0, "no probe may be attempted unauthenticated");
  });

  it("5c. a failed login BLOCKS rather than continuing unauthenticated", async () => {
    const world = makeFakeWorld({ loginFails: true });
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/login-fails.json"],
      LIVE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /BLOCKED/);
    assert.match(run.err, /refusing to continue/);
    assert.ok(
      !world.calls.fetches.some((f) => f.includes("/api/sites")),
      "no control-plane evidence may be gathered after a failed login",
    );
  });

  it("5d. the access secret never reaches output", async () => {
    const secret = "SUPER-SECRET-ACCESS-VALUE-0123456789";
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/a.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCESS_SECRET: secret,
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
      }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.doesNotMatch(run.out, new RegExp(secret));
    assert.doesNotMatch(run.err, new RegExp(secret));
    assert.doesNotMatch(run.files.get("/tmp/a.json") ?? "", new RegExp(secret));
  });

  it("5e. --expected-sha is mandatory for a live run (§6)", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", "--live", "--base-url", "https://control.invalid"],
      LIVE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.equal(run.code, 3);
    assert.match(run.err, /--expected-sha is required/);
  });
});

// ── CORRECTION-01 §36: no required check is test-deps-only ─────────────────

describe("check coverage", () => {
  /** Every check id either evaluator can emit, across measured and unmeasured worlds. */
  function allEmittedCheckIds() {
    const ids = new Set();
    const collect = (result) => result.checks.forEach((entry) => ids.add(entry.id));

    collect(evaluateStageA(passingStageAObservations()));
    collect(evaluateStageA({ expectedSha: SHA }));
    collect(evaluateStageB(passingStageBObservations(), passingStageA()));
    collect(
      evaluateStageB(
        passingStageBObservations({
          downloadingSample: unmeasured("x"),
          genericJob: unmeasured("x"),
          cancellation: unmeasured("x"),
        }),
        passingStageA(),
      ),
    );
    collect(evaluateStageB(passingStageBObservations(), { summary: { verdict: OUTCOMES.FAIL } }));
    collect(
      evaluateStageB(
        passingStageBObservations({
          downloadingSample: measured({
            sample: acquisitionSample(),
            workerPid: 100,
            ytdlpPid: null,
            expectedNetns: "net:[4026532001]",
          }),
        }),
        passingStageA(),
      ),
    );
    return [...ids];
  }

  /** Check ids the evaluators emit as NOT required (optional coverage). */
  function optionalCheckIds() {
    const ids = new Set();
    for (const result of [
      evaluateStageB(passingStageBObservations(), passingStageA()),
      evaluateStageB(
        passingStageBObservations({ failClosedRuntime: unmeasured("not performed") }),
        passingStageA(),
      ),
    ]) {
      for (const entry of result.checks) if (entry.required === false) ids.add(entry.id);
    }
    return ids;
  }

  it("36. every REQUIRED check has a concrete, executable producer", () => {
    const optional = optionalCheckIds();
    const missing = [];
    for (const id of allEmittedCheckIds()) {
      if (optional.has(id)) continue;
      if (!hasConcreteProducer(id)) missing.push(id);
    }
    assert.deepEqual(missing, [], `these required checks have no concrete live producer: ${missing.join(", ")}`);
  });

  it("36d. a check with a non-live producer MUST be optional (§4)", () => {
    // The one declared non-live case is `fail-closed-runtime`. It is allowed to
    // exist only because the evaluator can never let it satisfy a required
    // assertion — so that relationship is asserted rather than assumed.
    const optional = optionalCheckIds();
    for (const id of nonLiveCheckIds()) {
      assert.ok(
        optional.has(id),
        `${id} has no live producer, so it must be emitted as an optional check`,
      );
    }
    assert.ok(nonLiveCheckIds().includes("runtime.fail-closed"));
  });

  it("36e. every advertised case name resolves to a real callable producer (§37)", () => {
    for (const name of liveCaseNames()) {
      assert.equal(hasExecutableProducer(name), true, `${name} must be executable`);
      assert.equal(typeof CASE_PRODUCERS[name].run, "function", `${name}.run must be a function`);
    }
    // And a declared-but-non-live case is honestly marked, not silently absent.
    for (const name of caseNames()) {
      const entry = CASE_PRODUCERS[name];
      if (entry.live === false) {
        assert.equal(entry.run, null);
        assert.match(entry.summary, /not a live case command/);
      }
    }
  });

  it("36f. the four previously-missing cases are now executable", () => {
    // CORRECTION-02 §3: these were advertised in CASE_NAMES and counted as
    // concrete producers in coverage.mjs while no dispatch entry existed.
    for (const name of ["byte-limit", "shutdown", "safe-egress"]) {
      assert.equal(hasExecutableProducer(name), true, `${name} must now be executable`);
    }
    assert.equal(hasExecutableProducer("fail-closed-runtime"), false, "declared non-live");
  });

  it("36b. every producer names a real CLI command", () => {
    for (const id of allEmittedCheckIds()) {
      const producer = producerFor(id);
      assert.ok(producer, id);
      assert.notEqual(producer.kind, "test-seam", `${id} must not be satisfied by a test seam`);
      assert.match(producer.command, /^--stage (A|B)/, `${id} must name a CLI invocation`);
      assert.ok(producer.producer.length > 0);
    }
  });

  it("36c. every case named by a producer is a real case name", () => {
    for (const id of allEmittedCheckIds()) {
      const producer = producerFor(id);
      const match = /--case ([\w-]+)/.exec(producer.command);
      if (match) assert.ok(caseNames().includes(match[1]), `${id} names unknown case ${match[1]}`);
    }
  });
});

// ── CORRECTION-01 §14-§17: lifecycle evidence ──────────────────────────────

describe("durable lifecycle evidence", () => {
  it("16. the complete ladder passes", () => {
    assert.equal(classifyTransitionTrace(FULL_LADDER).outcome, OUTCOMES.PASS);
  });

  it("16b. polling duplicates are allowed", () => {
    const withDuplicates = [
      "queued", "queued", "analyzing", "downloading", "downloading",
      "processing", "uploading", "ready",
    ];
    assert.equal(classifyTransitionTrace(withDuplicates).outcome, OUTCOMES.PASS);
  });

  it('16c. ["ready"] alone CANNOT pass', () => {
    const classified = classifyTransitionTrace(["ready"]);
    assert.equal(classified.outcome, OUTCOMES.BLOCKED);
    assert.deepEqual(classified.trace.missing, [
      "queued", "analyzing", "downloading", "processing", "uploading",
    ]);
  });

  it("16d. every incomplete trace is BLOCKED, never PASS", () => {
    for (const trace of [
      ["ready"],
      ["processing", "uploading", "ready"],
      ["queued", "analyzing", "ready"],
      ["queued", "analyzing", "downloading", "uploading", "ready"],
      ["queued", "analyzing", "downloading", "processing", "ready"],
      [],
    ]) {
      const classified = classifyTransitionTrace(trace);
      assert.equal(
        classified.outcome,
        OUTCOMES.BLOCKED,
        `${JSON.stringify(trace)} must be BLOCKED, not ${classified.outcome}`,
      );
    }
  });

  it("16e. an out-of-order trace FAILS (not BLOCKED)", () => {
    const classified = classifyTransitionTrace([
      "queued", "downloading", "analyzing", "processing", "uploading", "ready",
    ]);
    assert.equal(classified.outcome, OUTCOMES.FAIL);
    assert.match(classified.trace.reason, /backwards/);
  });

  it("16f. a state outside the durable vocabulary is rejected", () => {
    const classified = classifyTransitionTrace(["queued", "extracting", "ready"]);
    assert.equal(classified.outcome, OUTCOMES.FAIL);
    assert.deepEqual(classified.trace.unknown, ["extracting"]);
    assert.equal(classifyTransitionTrace("ready").outcome, OUTCOMES.FAIL);
  });

  it("16g. the evaluator distinguishes ordered / complete / missing", () => {
    const partial = evaluateTransitionTrace(["queued", "analyzing", "downloading"]);
    assert.equal(partial.valid, true);
    assert.equal(partial.ordered, true);
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.missing, ["processing", "uploading", "ready"]);
  });

  it("15. an incomplete lifecycle BLOCKS Stage B rather than passing it", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        genericJob: measured({ jobId: JOB_ID, transitions: ["ready"], requestedFormatId: "preset:720" }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("job.lifecycle-complete"));
  });

  it("15b. an unobserved lifecycle is BLOCKED", () => {
    const result = evaluateStageB(
      passingStageBObservations({ genericJob: unmeasured("polling failed") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("job.lifecycle-complete"));
  });

  it("cancellation requires a proven downloading window and a cancelled end", () => {
    assert.equal(
      classifyCancellationTrace(["queued", "analyzing", "downloading", "cancelled"]).outcome,
      OUTCOMES.PASS,
    );
    // Cancelled before acquisition began: proves nothing about killing a group.
    assert.equal(
      classifyCancellationTrace(["queued", "cancelled"]).outcome,
      OUTCOMES.BLOCKED,
    );
    assert.equal(
      classifyCancellationTrace(["queued", "analyzing", "downloading", "ready"]).outcome,
      OUTCOMES.FAIL,
    );
  });
});

// ── PHASE-10D STAGE-B LIFECYCLE OBSERVABILITY REMEDIATION ───────────────────
//
// Live run `132658924d1c7a1b` produced a fully successful Stage-B `success`
// case whose recorded trace omitted `processing`. The Worker did not skip that
// state — `job-executor.server.ts` commits it unconditionally — but on a
// `keep-original` plan its durable lifetime can be shorter than one 200 ms poll.
// `classifySuccessTransitionTrace` closes that ONE gap by proof, never by
// assumption, and only for `processing`.

/** The exact trace the live success case recorded. */
const LIVE_SUCCESS_TRACE = Object.freeze([
  "queued", "analyzing", "downloading", "uploading", "ready",
]);

describe("success-path lifecycle: observed vs. causally proven `processing`", () => {
  it("A. the full six-state trace PASSes with `processing` DIRECTLY OBSERVED", () => {
    const classified = classifySuccessTransitionTrace(FULL_LADDER);
    assert.equal(classified.outcome, OUTCOMES.PASS);
    assert.equal(classified.processing, "observed");
    assert.equal(classified.proof, null, "nothing needs proving when it was seen");
    assert.match(classified.trace.reason, /directly observed/);
    // The full trace is complete on its own terms.
    assert.deepEqual(classified.trace.missing, []);
  });

  it("B. LIVE BLOCKER SHAPE — the five-state trace PASSes, `processing` CAUSALLY PROVEN", () => {
    const classified = classifySuccessTransitionTrace(LIVE_SUCCESS_TRACE);
    assert.equal(classified.outcome, OUTCOMES.PASS);
    assert.equal(classified.processing, "causally-proven");
    assert.notEqual(classified.processing, "observed", "it must NEVER be reported as observed");

    // The proof is named, and it names the observation that carries it.
    assert.equal(classified.proof.state, "processing");
    assert.equal(classified.proof.observedWitness, "uploading");
    assert.equal(classified.proof.enforcedPredecessorOfWitness, "processing");
    assert.equal(classified.proof.directlyObserved, false);
    assert.match(classified.proof.basis, /beginUploading/);
    assert.match(classified.trace.reason, /CAUSALLY PROVEN/);

    // The RAW RECORD IS NOT REWRITTEN. `processing` is not spliced into the
    // trace, and it stays listed as never sampled. This is the line between
    // proving a state and fabricating one.
    assert.deepEqual(classified.trace.missing, ["processing"]);
    assert.ok(!classified.trace.collapsed.includes("processing"));
    assert.deepEqual(classified.trace.collapsed, [...LIVE_SUCCESS_TRACE]);
  });

  it("C. polling duplicates around downloading/uploading still PASS", () => {
    const withDuplicates = [
      "queued", "queued", "analyzing",
      "downloading", "downloading", "downloading",
      "uploading", "uploading", "ready",
    ];
    const classified = classifySuccessTransitionTrace(withDuplicates);
    assert.equal(classified.outcome, OUTCOMES.PASS);
    assert.equal(classified.processing, "causally-proven");

    // …and duplicates around a fully observed ladder stay directly observed.
    const fullWithDuplicates = [
      "queued", "analyzing", "analyzing", "downloading", "downloading",
      "processing", "processing", "uploading", "uploading", "ready", "ready",
    ];
    const full = classifySuccessTransitionTrace(fullWithDuplicates);
    assert.equal(full.outcome, OUTCOMES.PASS);
    assert.equal(full.processing, "observed");
  });

  // ── Only `processing` is inferable. Every other gap stays an evidence gap. ──
  it("D-H. any OTHER missing required state is BLOCKED, never inferred", () => {
    const cases = [
      { id: "D", trace: ["queued", "analyzing", "downloading", "ready"], missing: ["processing", "uploading"] },
      { id: "E", trace: ["queued", "downloading", "uploading", "ready"], missing: ["analyzing", "processing"] },
      { id: "F", trace: ["queued", "analyzing", "uploading", "ready"], missing: ["downloading", "processing"] },
      { id: "G", trace: ["analyzing", "downloading", "uploading", "ready"], missing: ["queued", "processing"] },
      { id: "H", trace: ["queued", "analyzing", "downloading", "uploading"], missing: ["processing", "ready"] },
    ];
    for (const { id, trace, missing } of cases) {
      const classified = classifySuccessTransitionTrace(trace);
      assert.equal(
        classified.outcome,
        OUTCOMES.BLOCKED,
        `${id}: ${JSON.stringify(trace)} must be BLOCKED, not ${classified.outcome}`,
      );
      assert.equal(classified.processing, "unproven", `${id}: nothing may be claimed proven`);
      assert.equal(classified.proof, null, `${id}: no proof object may be minted`);
      assert.deepEqual(classified.trace.missing, missing, `${id}: missing set`);
    }
  });

  it("no state OTHER than `processing` is inferable, even when it is the ONLY one missing", () => {
    // The §12 shapes above each drop `processing` alongside another state, so a
    // rule of the form "infer any single missing state" would never fire on
    // them and they cannot discriminate it. These traces are complete EXCEPT for
    // one non-`processing` state, which is precisely the case such a rule would
    // wrongly wave through. `processing` is inferable because `uploading` can
    // only commit from it; none of these has an analogous enforced witness, so
    // each must stay an evidence gap.
    const exactlyOneMissing = [
      { missing: "queued", trace: ["analyzing", "downloading", "processing", "uploading", "ready"] },
      { missing: "analyzing", trace: ["queued", "downloading", "processing", "uploading", "ready"] },
      { missing: "downloading", trace: ["queued", "analyzing", "processing", "uploading", "ready"] },
      { missing: "uploading", trace: ["queued", "analyzing", "downloading", "processing", "ready"] },
      { missing: "ready", trace: ["queued", "analyzing", "downloading", "processing", "uploading"] },
    ];
    for (const { missing, trace } of exactlyOneMissing) {
      const classified = classifySuccessTransitionTrace(trace);
      assert.equal(
        classified.outcome,
        OUTCOMES.BLOCKED,
        `only \`${missing}\` missing must be BLOCKED, not ${classified.outcome}`,
      );
      assert.deepEqual(classified.trace.missing, [missing]);
      assert.equal(classified.processing, "unproven");
      assert.equal(classified.proof, null);
    }
  });

  it("D. `processing` alone is NOT inferable without the observed `uploading` witness", () => {
    // The single most important negative: the witness IS the proof. Remove it
    // and the inference must not survive on the strength of `ready` alone.
    const classified = classifySuccessTransitionTrace(["queued", "analyzing", "downloading", "ready"]);
    assert.equal(classified.outcome, OUTCOMES.BLOCKED);
    assert.ok(classified.trace.missing.includes("processing"));
    assert.ok(classified.trace.missing.includes("uploading"));
  });

  it("I. an out-of-order trace FAILs, not BLOCKED", () => {
    const classified = classifySuccessTransitionTrace([
      "queued", "analyzing", "uploading", "downloading", "ready",
    ]);
    assert.equal(classified.outcome, OUTCOMES.FAIL);
    assert.equal(classified.processing, "unproven");
    assert.match(classified.trace.reason, /backwards/);
  });

  it("J. an unknown lifecycle value FAILs", () => {
    const classified = classifySuccessTransitionTrace([
      "queued", "analyzing", "downloading", "extracting", "uploading", "ready",
    ]);
    assert.equal(classified.outcome, OUTCOMES.FAIL);
    assert.deepEqual(classified.trace.unknown, ["extracting"]);
    assert.equal(classifySuccessTransitionTrace("ready").outcome, OUTCOMES.FAIL);
    assert.equal(classifySuccessTransitionTrace(null).outcome, OUTCOMES.FAIL);
  });

  it("K. a trace containing `failed` FAILs — a success lifecycle has no failure in it", () => {
    for (const trace of [
      ["queued", "analyzing", "downloading", "processing", "uploading", "failed"],
      ["queued", "analyzing", "downloading", "failed"],
      ["queued", "analyzing", "downloading", "uploading", "failed", "ready"],
    ]) {
      const classified = classifySuccessTransitionTrace(trace);
      assert.equal(classified.outcome, OUTCOMES.FAIL, JSON.stringify(trace));
      assert.match(classified.trace.reason, /must not contain a terminal/);
      assert.equal(classified.processing, "unproven");
    }
  });

  it("L. a trace containing `cancelled` FAILs", () => {
    for (const trace of [
      ["queued", "analyzing", "downloading", "processing", "uploading", "cancelled"],
      ["queued", "analyzing", "downloading", "uploading", "cancelled", "ready"],
    ]) {
      const classified = classifySuccessTransitionTrace(trace);
      assert.equal(classified.outcome, OUTCOMES.FAIL, JSON.stringify(trace));
      assert.match(classified.trace.reason, /must not contain a terminal/);
    }
  });

  it("M. the GENERIC classifier is untouched and remains strict", () => {
    // The live five-state shape is still BLOCKED for every other caller. The
    // remediation narrowed one check; it did not relax the contract.
    const generic = classifyTransitionTrace(LIVE_SUCCESS_TRACE);
    assert.equal(generic.outcome, OUTCOMES.BLOCKED);
    assert.deepEqual(generic.trace.missing, ["processing"]);
    assert.equal(generic.processing, undefined, "the generic classifier mints no proof metadata");

    assert.equal(classifyTransitionTrace(FULL_LADDER).outcome, OUTCOMES.PASS);
    assert.equal(classifyTransitionTrace(["ready"]).outcome, OUTCOMES.BLOCKED);
  });

  it("N. cancellation semantics are unchanged", () => {
    assert.equal(
      classifyCancellationTrace(["queued", "analyzing", "downloading", "cancelled"]).outcome,
      OUTCOMES.PASS,
    );
    assert.equal(classifyCancellationTrace(["queued", "cancelled"]).outcome, OUTCOMES.BLOCKED);
    assert.equal(
      classifyCancellationTrace(["queued", "analyzing", "downloading", "ready"]).outcome,
      OUTCOMES.FAIL,
    );
    // A cancellation trace is NOT graded by the success classifier, and the
    // success classifier does not soften cancellation in either direction.
    assert.equal(
      classifySuccessTransitionTrace(["queued", "analyzing", "downloading", "cancelled"]).outcome,
      OUTCOMES.FAIL,
    );
  });

  it("the six-state contract itself is unchanged", () => {
    assert.deepEqual([...REQUIRED_TRANSITIONS], [
      "queued", "analyzing", "downloading", "processing", "uploading", "ready",
    ]);
  });
});

// ── §13/§17: the load-bearing Stage-B evaluator regression ──────────────────

describe("Stage B `job.lifecycle-complete` under the corrected classifier", () => {
  /**
   * A synthetic success observation carrying the exact RELEVANT raw facts of the
   * live `stage-b/success.json` record from run `132658924d1c7a1b`: the trace it
   * recorded, the preset it requested, and the terminal state it reached.
   *
   * Deliberately synthetic. No secret, sentinel, URL or bearer value from the
   * real sealed artifact is reproduced here — the artifact itself remains
   * untouched, unre-sealed and authoritative, and this fixture only replays the
   * shape the evaluator must now grade correctly.
   */
  const liveSuccessObservations = (transitions) =>
    passingStageBObservations({
      genericJob: measured({
        jobId: JOB_ID,
        transitions: [...transitions],
        requestedFormatId: "preset:best",
      }),
      // The durable row must agree with the requested preset, exactly as the
      // live record does; otherwise `durable.application-format-id` would fail
      // for an unrelated reason and mask what this regression is measuring.
      durableJobRow: measured({
        present: true,
        jobId: JOB_ID,
        status: "ready",
        formatId: "preset:best",
        extractor: "yt-dlp",
      }),
    });

  const lifecycleCheck = (result) =>
    result.checks.find((c) => c.id === "job.lifecycle-complete");

  it("the exact live trace PASSes, and the reason states the causal proof", () => {
    const result = evaluateStageB(liveSuccessObservations(LIVE_SUCCESS_TRACE), passingStageA());

    const check = lifecycleCheck(result);
    assert.equal(check.outcome, OUTCOMES.PASS, check.detail);
    assert.ok(!result.summary.blocking.includes("job.lifecycle-complete"));

    // §17: the whole otherwise-passing success record now verdicts PASS. This is
    // the exact shape the sealed live artifact carries, and it was the ONLY
    // thing standing between it and a clean success grade.
    assert.equal(result.summary.verdict, OUTCOMES.PASS, JSON.stringify(result.summary.blocking));

    // The reason must carry the PROOF, not merely a verdict: a later reader of
    // the evidence has to be able to see why an unsampled state was accepted.
    assert.match(check.detail, /CAUSALLY PROVEN/);
    assert.match(check.detail, /uploading/);
    assert.match(check.detail, /beginUploading/);
    assert.match(check.detail, /not directly sampled/);
  });

  it("removing the proving `uploading` observation makes it BLOCKED again", () => {
    // The load-bearing mutation. `uploading` is what proves `processing`; with
    // it gone there is nothing left to reason from and the gap reopens.
    const withoutUploading = LIVE_SUCCESS_TRACE.filter((s) => s !== "uploading");
    const result = evaluateStageB(liveSuccessObservations(withoutUploading), passingStageA());

    const check = lifecycleCheck(result);
    assert.equal(check.outcome, OUTCOMES.BLOCKED, check.detail);
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("job.lifecycle-complete"));
  });

  it("the fully observed ladder still PASSes through the evaluator", () => {
    const result = evaluateStageB(liveSuccessObservations(FULL_LADDER), passingStageA());
    const check = lifecycleCheck(result);
    assert.equal(check.outcome, OUTCOMES.PASS);
    assert.match(check.detail, /directly observed/);
    assert.ok(!/CAUSALLY PROVEN/.test(check.detail));
  });

  it("an unobserved lifecycle is still BLOCKED, and a disordered one still FAILs", () => {
    const unobserved = evaluateStageB(
      passingStageBObservations({ genericJob: unmeasured("polling failed") }),
      passingStageA(),
    );
    assert.equal(lifecycleCheck(unobserved).outcome, OUTCOMES.BLOCKED);

    const disordered = evaluateStageB(
      liveSuccessObservations(["queued", "analyzing", "uploading", "downloading", "ready"]),
      passingStageA(),
    );
    assert.equal(lifecycleCheck(disordered).outcome, OUTCOMES.FAIL);
  });

  it("`shutdown.job-recovered` semantics are NOT weakened by this change", () => {
    // Explicitly re-pinned here because it is the check most at risk of being
    // collaterally softened by a lifecycle edit. It must still demand the exact
    // recovered triple.
    for (const override of [
      { recoveredStatus: "ready" },
      { recoveredErrorCode: "SOMETHING_ELSE" },
      { recoveredSafeErrorMessage: "Worker restarted." },
    ]) {
      const result = evaluateStageB(
        passingStageBObservations({ shutdownCase: measured(shutdownEvidence(override)) }),
        passingStageA(),
      );
      const check = result.checks.find((c) => c.id === "shutdown.job-recovered");
      assert.notEqual(
        check.outcome,
        OUTCOMES.PASS,
        `shutdown.job-recovered must reject ${JSON.stringify(override)}`,
      );
    }
  });
});

// ── CORRECTION-01 §18-§21: the durable format contract ─────────────────────

describe("durable format evidence", () => {
  it("18. the legitimate application formatId is ALLOWED", () => {
    for (const formatId of [
      "preset:best", "preset:1080", "preset:720", "preset:audio", "preset:mp3", "direct-original",
    ]) {
      assert.equal(isApplicationOwnedFormatId(formatId), true, formatId);
    }
    assert.ok(!FORBIDDEN_DURABLE_FIELDS.includes("formatId"));
    assert.ok(!FORBIDDEN_DURABLE_FIELDS.includes("format_id"));
  });

  it("21. a durable row with preset:1080 passes the durable policy", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        genericJob: measured({ jobId: JOB_ID, transitions: FULL_LADDER, requestedFormatId: "preset:1080" }),
        durableJobRow: measured({ present: true, jobId: JOB_ID, status: "ready", formatId: "preset:1080", extractor: "yt-dlp" }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
    const entry = result.checks.find((c) => c.id === "durable.application-format-id");
    assert.equal(entry.outcome, OUTCOMES.PASS);
  });

  it('21b. a durable formatId of "22" cannot satisfy the application-format check', () => {
    const result = evaluateStageB(
      passingStageBObservations({
        durableJobRow: measured({ present: true, jobId: JOB_ID, status: "ready", formatId: "22", extractor: "yt-dlp" }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("durable.application-format-id"));
    assert.equal(isApplicationOwnedFormatId("22"), false);
  });

  it("21c. the durable formatId must EQUAL the requested preset", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        genericJob: measured({ jobId: JOB_ID, transitions: FULL_LADDER, requestedFormatId: "preset:720" }),
        durableJobRow: measured({ present: true, jobId: JOB_ID, status: "ready", formatId: "preset:360", extractor: "yt-dlp" }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("durable.application-format-id"));
  });

  it("21d. a raw selector field still fails the forbidden-field check", () => {
    for (const field of [
      "source_format_id", "sourceFormatId", "rawFormatId", "raw_format_id",
      "selector", "format_selector", "ytdlpFormat", "sourceUrl",
    ]) {
      const result = evaluateStageB(
        passingStageBObservations({
          durableJobRow: measured({
            present: true,
            jobId: JOB_ID,
            status: "ready",
            formatId: "preset:720",
            extractor: "yt-dlp",
            [field]: "22",
          }),
        }),
        passingStageA(),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, `durable ${field} must fail`);
      assert.ok(result.summary.blocking.includes("durable.no-raw-selector-fields"));
    }
  });

  it("presets are objects whose id and formatId are both application-owned", () => {
    assert.equal(presetsAreApplicationOwned(APP_PRESETS), true);
    // A raw upstream id in either field fails.
    assert.equal(
      presetsAreApplicationOwned([{ id: "preset:720", formatId: "22", container: "mp4" }]),
      false,
    );
    assert.equal(
      presetsAreApplicationOwned([{ id: "22", formatId: "22", container: "mp4" }]),
      false,
    );
    // Mismatched halves fail even when both are presets.
    assert.equal(
      presetsAreApplicationOwned([{ id: "preset:720", formatId: "preset:360" }]),
      false,
    );
    assert.equal(presetsAreApplicationOwned([]), false);
    assert.equal(presetsAreApplicationOwned(["preset:720"]), false, "bare strings are not the contract");
  });

  it("the durable statement projects only safe columns — never the URL", () => {
    assert.equal(
      DURABLE_JOB_QUERY,
      "SELECT job_id, status, format_id, extractor FROM worker_jobs WHERE job_id = ?",
    );
    assert.doesNotMatch(DURABLE_JOB_QUERY, /\burl\b/, "the submitted URL must never be selected");
    // The id is BOUND, so it is data to SQLite and cannot close the statement.
    assert.match(DURABLE_JOB_QUERY, /WHERE job_id = \?$/);
    assert.doesNotMatch(DURABLE_JOB_QUERY, /'/, "no quoted literal is interpolated any more");
    assert.equal(assertDurableJobId(JOB_ID), JOB_ID);
    assert.throws(() => assertDurableJobId("'; DROP TABLE worker_jobs;--"), /malformed job id/);
    assert.throws(() => assertDurableJobId(JOB_ID.toUpperCase()), /malformed job id/);
    // §1 of CORRECTION-07's rule, applied here: admission is by TYPE first.
    assert.throws(() => assertDurableJobId(0), /malformed job id/);
    assert.throws(() => assertDurableJobId(null), /malformed job id/);
  });

  it("no `sqlite3` command is admissible in any shape", () => {
    // The durable read is in-process now, so the CLI boundary that used to
    // guard it is GONE rather than dormant. A dormant allowlist entry is a
    // SQL-console-shaped hole that a future caller only has to widen.
    for (const argv of [
      ["-readonly", WORKER_STATE_DB, DURABLE_JOB_QUERY],
      ["-readonly", "/var/lib/videofetch/videofetch.db", "SELECT job_id FROM jobs;"],
      ["-readonly", WORKER_STATE_DB, "SELECT url FROM worker_jobs;"],
      [WORKER_STATE_DB, ".dump"],
      [],
    ]) {
      assert.equal(isReadOnlyCommand("sqlite3", argv), false, `sqlite3 ${argv.join(" ")}`);
    }
  });
});

// ── CORRECTION-01 §22-§26: process identity and schema ─────────────────────

describe("process identity", () => {
  const NS = "net:[4026532001]";

  it("22. the exact owned yt-dlp process must be present and verified", () => {
    const identity = evaluateYtdlpIdentity(acquisitionSample(), 100, 200, NS);
    assert.equal(identity.identified, true);
    assert.equal(identity.pid, 200);
    assert.equal(identity.pgid, 200);
  });

  it("22b. an arbitrary Python descendant cannot satisfy yt-dlp presence", () => {
    const sample = [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: NS },
      { pid: 300, ppid: 100, pgid: 100, comm: "python3", netns: NS },
    ];
    const identity = evaluateYtdlpIdentity(sample, 100, 300, NS);
    assert.equal(identity.identified, false);
    assert.match(identity.reason, /process-group leader/);
    assert.equal(establishYtdlpPid(sample, 100).established, false);
  });

  it("22c. a missing, absent or non-descendant PID is not identified", () => {
    assert.equal(evaluateYtdlpIdentity(acquisitionSample(), 100, null, NS).identified, false);
    assert.match(evaluateYtdlpIdentity(acquisitionSample(), 100, 999, NS).reason, /absent from the sample/);
    const detached = [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: NS },
      { pid: 400, ppid: 1, pgid: 400, comm: "python3", netns: NS },
    ];
    assert.match(evaluateYtdlpIdentity(detached, 100, 400, NS).reason, /not a descendant/);
  });

  it("22d. a wrong basename or wrong namespace fails identification", () => {
    const wrongComm = [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: NS },
      { pid: 200, ppid: 100, pgid: 200, comm: "perl", netns: NS },
    ];
    assert.match(evaluateYtdlpIdentity(wrongComm, 100, 200, NS).reason, /not an approved yt-dlp runtime/);
    const wrongNs = [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: NS },
      { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: "net:[4026599999]" },
    ];
    assert.match(evaluateYtdlpIdentity(wrongNs, 100, 200, NS).reason, /media network namespace/);
  });

  it("22e. a window that never identified the owned process BLOCKS Stage B", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        downloadingWindow: measured(windowOf([acquisitionSample()], { ytdlpPid: null })),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("process.ytdlp-identified"));
  });

  it("23. Node containment is anchored to the verified owned PID", () => {
    const sample = acquisitionSample([{ pid: 300, ppid: 200, pgid: 200, comm: "node", netns: NS }]);
    const identity = evaluateYtdlpIdentity(sample, 100, 200, NS);
    const contained = evaluateNodeContainment(classifyAcquisitionTree(sample, 100), identity, NS);
    assert.equal(contained.anchored, true);
    assert.equal(contained.contained, true);

    const detached = acquisitionSample([{ pid: 300, ppid: 100, pgid: 200, comm: "node", netns: NS }]);
    const detachedResult = evaluateNodeContainment(
      classifyAcquisitionTree(detached, 100),
      evaluateYtdlpIdentity(detached, 100, 200, NS),
      NS,
    );
    assert.equal(detachedResult.contained, false);
    assert.match(detachedResult.failures.join(" "), /not a descendant/);
  });

  it("23b. containment cannot be claimed without an anchor", () => {
    const sample = [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: NS },
      { pid: 300, ppid: 100, pgid: 100, comm: "node", netns: NS },
    ];
    const result = evaluateNodeContainment(
      classifyAcquisitionTree(sample, 100),
      evaluateYtdlpIdentity(sample, 100, null, NS),
      NS,
    );
    assert.equal(result.anchored, false);
    assert.equal(result.contained, false);
  });
});

describe("process sample schema", () => {
  const validRow = { pid: 1, ppid: 0, pgid: 1, comm: "python3", netns: "net:[1]" };

  it("24. the minimal valid five-field row passes", () => {
    assert.equal(validateSampleShape([validRow]).ok, true);
    assert.deepEqual([...ALLOWED_SAMPLE_FIELDS], ["pid", "ppid", "pgid", "comm", "netns"]);
  });

  it("25. every field outside the closed schema is rejected", () => {
    for (const field of [
      "cmdline", "argv", "url", "exe", "environment", "headers", "query",
      "fullCommand", "processMetadata", "arbitraryUnknownField",
    ]) {
      const shape = validateSampleShape([{ ...validRow, [field]: "anything" }]);
      assert.equal(shape.ok, false, `${field} must be rejected`);
      assert.match(shape.violations.join(" "), new RegExp(`'${field}' is outside the closed sample schema`));
    }
  });

  it("25b. malformed required fields are rejected", () => {
    const cases = [
      [{ ...validRow, pid: 0 }, /pid must be a positive integer/],
      [{ ...validRow, pid: "1" }, /pid must be a positive integer/],
      [{ ...validRow, ppid: -1 }, /ppid must be a non-negative integer/],
      [{ ...validRow, pgid: null }, /pgid must be a positive integer/],
      [{ ...validRow, comm: "" }, /comm must be a non-empty string/],
      [{ ...validRow, comm: "/usr/bin/python3 https://x/?t=1" }, /bare basename/],
      [{ ...validRow, netns: "arbitrary text" }, /netns must be a namespace identity/],
    ];
    for (const [row, pattern] of cases) {
      const shape = validateSampleShape([row]);
      assert.equal(shape.ok, false, JSON.stringify(row));
      assert.match(shape.violations.join(" "), pattern);
    }
    assert.equal(validateSampleShape([{ ...validRow, netns: null }]).ok, true);
  });

  it("25c. a non-array or empty sample is rejected", () => {
    assert.equal(validateSampleShape(null).ok, false);
    assert.equal(validateSampleShape([]).ok, false);
    assert.equal(validateSampleShape(["not an object"]).ok, false);
  });

  it("25d. a schema violation FAILS Stage B", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        downloadingWindow: measured(
          windowOf([
            [
              { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[4026532001]" },
              { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: "net:[4026532001]", cmdline: "yt-dlp https://x" },
            ],
          ]),
        ),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.sample-shape"));
  });

  it("26. the real sampler parses docker top into closed-schema rows", () => {
    const parsed = parseDockerTop("PID PPID PGID COMMAND\n100 1 100 node\n200 100 200 python3\n");
    assert.equal(parsed.ok, true, parsed.reason);
    assert.deepEqual(parsed.rows, [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: null },
      { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: null },
    ]);
    assert.equal(establishYtdlpPid(parsed.rows, 100).pid, 200);

    // The real header is space-padded, exactly as `docker top` emits it.
    const padded = parseDockerTop(
      "PID                 PPID                PGID                COMMAND\n" +
        "66545               66520               66545               sh\n",
    );
    assert.equal(padded.ok, true, padded.reason);
    assert.deepEqual(padded.rows, [{ pid: 66545, ppid: 66520, pgid: 66545, comm: "sh", netns: null }]);
  });

  it("26b. ambiguity is a measurement failure, never a guess", () => {
    const twoCandidates = [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: null },
      { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: null },
      { pid: 201, ppid: 100, pgid: 201, comm: "python3", netns: null },
    ];
    const established = establishYtdlpPid(twoCandidates, 100);
    assert.equal(established.established, false);
    assert.match(established.reason, /ambiguous/);
  });
});

describe("process-tree primitives", () => {
  const NS = "net:[4026532001]";

  it("an unreadable namespace is a mismatch, never agreement", () => {
    const classified = classifyAcquisitionTree(
      acquisitionSample([{ pid: 300, ppid: 200, pgid: 200, comm: "node", netns: null }]),
      100,
    );
    const evaluation = evaluateNamespaceIdentity(classified, NS);
    assert.equal(evaluation.consistent, false);
    assert.deepEqual(evaluation.offenders.map((o) => o.pid), [300]);
  });

  it("an unknown expected namespace is not measurable", () => {
    const evaluation = evaluateNamespaceIdentity(classifyAcquisitionTree(acquisitionSample(), 100), null);
    assert.equal(evaluation.measured, false);
  });

  it("descendant walking survives a malformed (cyclic) sample", () => {
    const cyclic = [
      { pid: 1, ppid: 2, pgid: 1, comm: "a" },
      { pid: 2, ppid: 1, pgid: 1, comm: "b" },
    ];
    assert.deepEqual(descendantsOf(cyclic, 1).map((r) => r.pid), [2]);
  });

  it("termination cleanliness reports every survivor", () => {
    assert.equal(evaluateTerminationCleanliness([{ pid: 100, ppid: 1, pgid: 100, comm: "node" }], 100).clean, true);
    const dirty = evaluateTerminationCleanliness(
      [
        { pid: 100, ppid: 1, pgid: 100, comm: "node" },
        { pid: 200, ppid: 100, pgid: 200, comm: "python3" },
      ],
      100,
    );
    assert.equal(dirty.clean, false);
    assert.deepEqual(dirty.survivors.map((r) => r.comm), ["python3"]);
  });
});

// ── CORRECTION-02 §9-§12: the downloading window ───────────────────────────

describe("downloading-window process evidence", () => {
  const NS = "net:[4026532001]";
  const clean = acquisitionSample();
  const withComm = (comm, ppid = 200, pgid = 200) =>
    acquisitionSample([{ pid: 300, ppid, pgid, comm, netns: NS }]);

  it("39. a transient forbidden executable in ONE sample FAILS", () => {
    // The middle sample is not the largest and would have been discarded by a
    // "keep the best sample" collector.
    const window = windowOf([clean, withComm("ffmpeg"), clean]);
    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(window) }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.no-ffmpeg-during-downloading"));

    const aggregate = aggregateDownloadWindow(window);
    assert.equal(aggregate.forbiddenSeen.length, 1);
    assert.equal(aggregate.forbiddenSeen[0].sampleIndex, 1);
  });

  it("39b. a transient ffprobe or other helper in one sample FAILS", () => {
    for (const comm of ["ffprobe", "curl", "wget", "aria2c", "sh"]) {
      const result = evaluateStageB(
        passingStageBObservations({
          downloadingWindow: measured(windowOf([clean, withComm(comm), clean])),
        }),
        passingStageA(),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, comm);
    }
  });

  it("39c. a transient UNKNOWN executable in one sample FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        downloadingWindow: measured(windowOf([clean, withComm("perl"), clean])),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.no-unknown-descendants"));
  });

  it("39d. Node appearing in only ONE sample is EXERCISED, not NOT_EXERCISED", () => {
    const window = windowOf([clean, withComm("node"), clean]);
    assert.equal(nodeExercised(aggregateDownloadWindow(window)), true);

    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(window) }),
      passingStageA(),
    );
    const node = result.checks.find((c) => c.id === "process.node-ejs-containment");
    assert.equal(node.outcome, OUTCOMES.PASS, "a transient Node must be judged, not skipped");
    assert.ok(!result.summary.notExercised.includes("process.node-ejs-containment"));
  });

  it("39e. a transient UNCONTAINED Node in one sample FAILS", () => {
    // Escaped the owned process group in the middle sample only.
    const window = windowOf([clean, withComm("node", 200, 999), clean]);
    assert.equal(nodeContained(aggregateDownloadWindow(window)), false);
    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(window) }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.node-ejs-containment"));
  });

  it("39f. a transient namespace mismatch in one sample FAILS", () => {
    const window = windowOf([
      clean,
      acquisitionSample([{ pid: 300, ppid: 200, pgid: 200, comm: "node", netns: "net:[4026599999]" }]),
      clean,
    ]);
    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(window) }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.namespace-identity"));
  });

  it("39g. a source with no Node anywhere in the window is NOT_EXERCISED", () => {
    const result = evaluateStageB(passingStageBObservations(), passingStageA());
    const node = result.checks.find((c) => c.id === "process.node-ejs-containment");
    assert.equal(node.outcome, OUTCOMES.NOT_EXERCISED);
    assert.match(node.detail, /NODE\/EJS DESCENDANT NOT EXERCISED BY THIS SOURCE/);
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
  });

  it("39h. no downloading sample at all is BLOCKED", () => {
    for (const window of [
      windowOf([]),
      { samples: [], workerPid: 100, expectedNetns: NS, observedDownloading: false },
    ]) {
      const result = evaluateStageB(
        passingStageBObservations({ downloadingWindow: measured(window) }),
        passingStageA(),
      );
      assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
      assert.ok(result.summary.blocking.includes("process.window-observed"));
    }
    const unmeasured2 = evaluateStageB(
      passingStageBObservations({ downloadingWindow: unmeasured("sampler failed") }),
      passingStageA(),
    );
    assert.equal(unmeasured2.summary.verdict, OUTCOMES.BLOCKED);
  });

  it("12. FFmpeg during PROCESSING does not fail the downloading boundary", () => {
    // This is the lifecycle boundary the acceptance exists to prove. Worker
    // FFmpeg is legitimate in `processing` — preset:mp3 and preset:audio from a
    // muxed source are Worker-side operations after beginProcessing() commits.
    const collector = createDownloadWindowCollector({});
    collector.noteState("queued");
    collector.addSample({ sample: withComm("ffmpeg"), workerPid: 100, expectedNetns: NS });
    assert.equal(collector.result().samples.length, 0, "pre-downloading samples are not admitted");

    collector.noteState("downloading");
    collector.addSample({ sample: clean, workerPid: 100, ytdlpPid: 200, expectedNetns: NS });

    collector.noteState("processing");
    collector.addSample({ sample: withComm("ffmpeg"), workerPid: 100, expectedNetns: NS });
    assert.equal(collector.result().samples.length, 1, "processing samples are not admitted");

    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(collector.result()) }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.PASS, "processing FFmpeg must not fail acquisition");
  });

  it("12b. the window closes permanently once the job leaves downloading", () => {
    const collector = createDownloadWindowCollector({});
    collector.noteState("downloading");
    assert.equal(collector.open, true);
    collector.noteState("processing");
    assert.equal(collector.open, false);
    // A late `downloading` report cannot reopen it.
    collector.noteState("downloading");
    assert.equal(collector.open, false);
    assert.equal(collector.observedDownloading, true);
  });

  it("aggregation reports every sample, not just the widest", () => {
    const aggregate = aggregateDownloadWindow(windowOf([clean, withComm("node"), clean]));
    assert.equal(aggregate.samplesTaken, 3);
    assert.equal(aggregate.usableSamples, 3);
    assert.equal(ytdlpIdentified(aggregate), true);
    assert.equal(aggregate.ytdlpIdentities.length, 3);
    assert.deepEqual(aggregate.basenamesSeen, ["node", "python3"]);
  });
});

// ── Stage A gates ──────────────────────────────────────────────────────────

describe("Stage A gates", () => {
  it("a fully healthy Stage A deployment passes and authorizes enablement", () => {
    const result = passingStageA();
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
    assert.equal(enablementAuthorized(result).authorized, true);
  });

  it("8. a failed safe-egress prerequisite is BLOCKED or FAIL; never authorized", () => {
    const unmeasurable = evaluateStageA(
      passingStageAObservations({ egressVerifier: unmeasured("verifier not executable") }),
    );
    assert.equal(unmeasurable.summary.verdict, OUTCOMES.BLOCKED);
    assert.equal(enablementAuthorized(unmeasurable).authorized, false);

    const failing = evaluateStageA(passingStageAObservations({ egressVerifier: measured({ exitCode: 1 }) }));
    assert.equal(failing.summary.verdict, OUTCOMES.FAIL);
    assert.match(enablementAuthorized(failing).reason, /STOP BEFORE GENERIC ENABLEMENT/);
  });

  it("8b. any missing required service blocks enablement", () => {
    for (const unit of REQUIRED_SERVICES) {
      const services = { ...passingStageAObservations().services };
      services[unit] = measured({ unit, activeState: "failed" });
      const result = evaluateStageA(passingStageAObservations({ services }));
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, unit);
    }
  });

  it("9. an inexact runtime is never accepted", () => {
    for (const version of ["2026.09.01", "2025.01.01", "latest", "2026.08.19.1", ""]) {
      const result = evaluateStageA(passingStageAObservations({ ytdlpVersion: measured(version) }));
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, version);
    }
    assert.equal(
      evaluateStageA(passingStageAObservations({ ytdlpVersion: unmeasured("x") })).summary.verdict,
      OUTCOMES.BLOCKED,
    );
    for (const [key, bad] of [
      ["pythonVersion", "3.9.2"],
      ["nodeVersion", "v20.11.0"],
      ["bundledEjsVersion", "0.9.0"],
    ]) {
      assert.equal(
        evaluateStageA(passingStageAObservations({ [key]: measured(bad) })).summary.verdict,
        OUTCOMES.FAIL,
        key,
      );
    }
  });

  it("9c-9e. image identity failures are caught", () => {
    assert.equal(
      evaluateStageA(passingStageAObservations({ runningImageId: unmeasured("not running") })).summary.verdict,
      OUTCOMES.BLOCKED,
    );
    assert.equal(
      evaluateStageA(
        passingStageAObservations({
          imageShaTag: measured({ expectedSha: SHA, taggedImageId: `sha256:${"c".repeat(64)}`, runningImageId: IMAGE_ID }),
        }),
      ).summary.verdict,
      OUTCOMES.FAIL,
    );
    assert.equal(
      evaluateStageA(
        passingStageAObservations({
          imageLatestAlias: measured({ latestImageId: `sha256:${"d".repeat(64)}`, taggedImageId: IMAGE_ID }),
        }),
      ).summary.verdict,
      OUTCOMES.FAIL,
    );
  });

  it("9g. a forbidden Worker environment variable fails, by NAME alone", () => {
    for (const name of [
      "YTDLP_NETWORK_ISOLATED", "YTDLP_PATH", "R2_WRITER_ACCESS_KEY_ID", "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
    ]) {
      const result = evaluateStageA(
        passingStageAObservations({
          workerEnvironmentNames: measured([
            "WORKER_CONTROL_KEY_ID", "WORKER_CONTROL_SECRET", "R2_ACCOUNT_ID", "R2_BUCKET", name,
          ]),
        }),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, name);
    }
  });

  it("10. a failed direct regression forbids Stage B", () => {
    const failed = evaluateStageA(
      passingStageAObservations({ directRegression: measured({ status: "failed", extractor: "direct" }) }),
    );
    assert.equal(failed.summary.verdict, OUTCOMES.FAIL);
    assert.equal(stageBPermitted(failed.summary), false);
    const stageB = evaluateStageB(passingStageBObservations(), failed);
    assert.equal(stageB.summary.verdict, OUTCOMES.BLOCKED);
    assert.equal(stageB.checks.length, 1);
  });

  it("10b. an unperformed direct regression is BLOCKED", () => {
    const result = evaluateStageA(
      passingStageAObservations({ directRegression: unmeasured("no fixture supplied") }),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
  });

  it("10c. a byte mismatch in the direct regression fails", () => {
    const result = evaluateStageA(
      passingStageAObservations({
        directRegression: measured({
          status: "ready",
          extractor: "direct",
          expectedDigest: FIXTURE_DIGEST,
          deliveredDigest: "c".repeat(64),
          expectedBytes: 10,
          deliveredBytes: 10,
        }),
      }),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("direct.byte-integrity"));
  });
});

// ── CORRECTION-01 §29/§30: Stage A record binding ──────────────────────────

describe("Stage A record binding", () => {
  it("11. a Stage A PASS from another SHA cannot authorize Stage B", () => {
    const other = evaluateStageA(passingStageAObservations({ expectedSha: "0".repeat(40) }));
    assert.equal(other.summary.verdict, OUTCOMES.PASS, "it passed — for a DIFFERENT source");

    const result = evaluateStageB(passingStageBObservations(), other);
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.match(result.checks[0].detail, /binds to source 0{40}, not to/);
  });

  it("11b. a Stage A PASS against another IMAGE cannot authorize Stage B", () => {
    const stageA = passingStageA();
    const result = evaluateStageB(
      passingStageBObservations({ runningImageId: measured(`sha256:${"e".repeat(64)}`) }),
      stageA,
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.match(result.checks[0].detail, /different image object/);
  });

  it("11c. a record with no binding at all is refused", () => {
    const result = evaluateStageB(passingStageBObservations(), {
      summary: { verdict: OUTCOMES.PASS },
    });
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.match(result.checks[0].detail, /carries no deployment binding/);
  });

  it("11d. an unidentifiable running image refuses Stage B", () => {
    const result = evaluateStageB(
      passingStageBObservations({ runningImageId: unmeasured("not running") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.match(result.checks[0].detail, /could not be identified/);
  });

  it("11e. authorization is exposed as a function, not only via the CLI", () => {
    assert.equal(stageBAuthorization(passingStageBObservations(), passingStageA()).permitted, true);
    assert.equal(
      stageBAuthorization(passingStageBObservations(), { summary: { verdict: OUTCOMES.FAIL } }).permitted,
      false,
    );
  });

  it("11f. the CLI refuses a Stage A file that is not a passing bound record", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    for (const body of [
      JSON.stringify({ stage: "A", verdict: "FAIL" }),
      JSON.stringify({ stage: "A", verdict: "PASS" }), // no harness id / binding
      JSON.stringify({ harness: HARNESS_ID, stage: "A", verdict: "PASS" }), // no binding
      "not json",
    ]) {
      const files = seedRun(new Map([["/tmp/sa.json", body]]));
      const run = await runCli(
        [
          "--stage", "B", "--aggregate", ...LIVE_ARGS,
          "--stage-a", "/tmp/sa.json",
          "--evidence", "/tmp/aggregate-unusable.json",
        ],
        LIVE_ENV(),
        { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
      );
      assert.equal(run.code, 2, body.slice(0, 40));
      assert.match(run.err, /the Stage A record is not usable/);
    }
  });
});

// ── CORRECTION-01 §9: case records cannot be forged ────────────────────────

describe("case evidence validation", () => {
  const binding = { expectedSha: SHA, runningImageId: IMAGE_ID };
  const goodPayload = { cancellation: cancellationEvidence({ postSample: [] }) };

  it("accepts a record this harness produced for this deployment", () => {
    const record = caseRecord({ caseName: "cancellation", binding, payload: goodPayload });
    const validated = validateCaseRecord(record, binding);
    assert.equal(validated.ok, true, validated.reason);
    assert.equal(validated.observations.cancellation.measured, true);
  });

  it("9. an operator-authored assertion cannot become a PASS", () => {
    for (const [record, pattern] of [
      [{ passed: true }, /not produced by this harness/],
      [{ harness: HARNESS_ID, schemaVersion: "made-up", stage: "B", case: "cancellation" }, /schema/],
      [{ harness: HARNESS_ID, schemaVersion: CASE_SCHEMA_VERSION, stage: "A", case: "cancellation" }, /not a Stage B/],
      [
        { harness: HARNESS_ID, schemaVersion: CASE_SCHEMA_VERSION, stage: "B", case: "invented" },
        /unknown case name/,
      ],
    ]) {
      const validated = validateCaseRecord(record, binding);
      assert.equal(validated.ok, false);
      assert.match(validated.reason, pattern);
    }
  });

  it("9b. a record bound to another SHA or image is rejected", () => {
    const wrongSha = caseRecord({
      caseName: "cancellation",
      binding: { expectedSha: "0".repeat(40), runningImageId: IMAGE_ID },
      payload: goodPayload,
    });
    assert.match(validateCaseRecord(wrongSha, binding).reason, /binds to source/);

    const wrongImage = caseRecord({
      caseName: "cancellation",
      binding: { expectedSha: SHA, runningImageId: `sha256:${"f".repeat(64)}` },
      payload: goodPayload,
    });
    assert.match(validateCaseRecord(wrongImage, binding).reason, /different image object/);
  });

  it("9c. unknown or missing observations in a payload are rejected", () => {
    const extra = caseRecord({
      caseName: "cancellation",
      binding,
      payload: { ...goodPayload, killSwitch: { genericUsableAfterDisable: false, directWorks: true } },
    });
    assert.match(validateCaseRecord(extra, binding).reason, /unexpected observation 'killSwitch'/);

    const missing = caseRecord({ caseName: "cancellation", binding, payload: {} });
    assert.match(validateCaseRecord(missing, binding).reason, /missing observation 'cancellation'/);
  });

  it("9d. a malformed payload field is rejected", () => {
    const malformed = caseRecord({
      caseName: "cancellation",
      binding,
      payload: { cancellation: { ...goodPayload.cancellation, lateReady: "no" } },
    });
    assert.match(validateCaseRecord(malformed, binding).reason, /malformed/);
  });

  it("9e. every case name has a payload validator", () => {
    for (const name of caseNames()) {
      const validated = validateCaseRecord(
        caseRecord({ caseName: name, binding, payload: {} }),
        binding,
      );
      // Empty payloads are rejected for a REASON specific to that case, which
      // proves a validator exists for it.
      assert.equal(validated.ok, false);
      assert.match(validated.reason, new RegExp(`case '${name}'`));
    }
  });
});

// ── Redaction, sentinel, secrets ───────────────────────────────────────────

describe("redaction", () => {
  it("5. query strings are redacted", () => {
    assert.equal(redactUrl("https://host.example/path?token=secret&x=1"), "https://host.example/path?<redacted>");
    assert.equal(redactUrl("https://host.example/path"), "https://host.example/path");
    assert.equal(redactUrl("https://host.example/p#tok=abc"), "https://host.example/p");
    assert.equal(redactUrl("https://user:pw@host.example/p"), "https://host.example/p");
    assert.equal(redactUrl("not a url ?token=secret"), "<unparseable-url>");
    assert.equal(redactUrl(""), "<no-url>");
  });

  it("5c. redaction is IDEMPOTENT", () => {
    const once = redactUrl("https://host.example/path?token=secret");
    assert.equal(once, "https://host.example/path?<redacted>");
    assert.equal(redactText(once), once);
    assert.equal(redactText(redactText(once)), once);
  });

  it("13. the console safety pipeline is structural, not per-call-site", () => {
    const lines = [];
    const errors = [];
    const needles = [];
    const safe = createSafeConsole({ log: (l) => lines.push(l), errorLog: (e) => errors.push(e), needles });
    // A secret registered AFTER wiring still protects later output — the CLI
    // registers the sentinel mid-run.
    needles.push("LATE-REGISTERED-SECRET");
    safe.log("saw https://media.invalid/v?sig=abc and LATE-REGISTERED-SECRET");
    safe.error("error at https://media.invalid/e?token=xyz");
    assert.equal(lines[0], "saw https://media.invalid/v?<redacted> and <scrubbed>");
    assert.equal(errors[0], "error at https://media.invalid/e?<redacted>");
  });

  it("19. full URLs with secret query values are never printed", () => {
    const rendered = redactText("failed to fetch https://media.invalid/v?sig=SUPERSECRET&expires=99");
    assert.doesNotMatch(rendered, /SUPERSECRET/);
    assert.match(rendered, /media\.invalid\/v\?<redacted>/);
    assert.doesNotMatch(JSON.stringify(redactDeep({ a: { b: ["see https://h.invalid/p?k=S3CRET"] } })), /S3CRET/);
  });

  it("19c. the whole evidence record is redacted at every depth", () => {
    const record = buildEvidence({
      stage: "B",
      acceptanceUrl: "https://media.invalid/watch?v=abc&token=LEAKME",
      checks: [{ id: "x", outcome: "FAIL", required: true, detail: "see https://media.invalid/e?err=LEAKME" }],
      summary: { verdict: "FAIL", counts: {}, blocking: ["x"], notExercised: [] },
    });
    const rendered = renderEvidence(record, []);
    assert.doesNotMatch(rendered, /LEAKME/);
    assert.match(rendered, /media\.invalid/);
  });
});

describe("sentinel", () => {
  it("12. the real CLI mints and exercises a sentinel", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const submitted = [];
    const spyFetch = async (target, init) => {
      submitted.push(String(target));
      if (init?.body) submitted.push(String(init.body));
      return world.fetch(target, init);
    };
    const run = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
        ...WORKER_ENV,
      }),
      { runReadOnly: world.runReadOnly, fetch: spyFetch, files: seedRun() },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);

    // The sentinel genuinely travelled through the application path…
    const carrier = submitted.find((s) => s.includes("vf_accept="));
    assert.ok(carrier, "a sentinel-bearing URL must be submitted");
    const sentinel = /vf_accept=(VF_ACCEPT_SECRET_[0-9a-f]{32})/.exec(carrier)?.[1];
    assert.ok(sentinel, "the sentinel must match the minted shape");

    // …and never reached output or the record.
    assert.doesNotMatch(run.out, new RegExp(sentinel));
    assert.doesNotMatch(run.err, new RegExp(sentinel));
    const record = run.files.get("/tmp/c.json");
    assert.doesNotMatch(record, new RegExp(sentinel));
    assert.doesNotMatch(record, /VF_ACCEPT_SECRET/);
    // The sweep result IS recorded.
    assert.match(record, /"leaked": false/);
    assert.match(record, /"surfacesChecked"/);
  });

  it("6. a leak is DETECTED and reported without disclosing the value", () => {
    const sentinel = mintSentinel();
    assert.match(sentinel, /^VF_ACCEPT_SECRET_[0-9a-f]{32}$/);
    const submitted = withSentinel("https://media.invalid/watch?v=abc", sentinel);
    assert.ok(submitted.includes(sentinel));

    const sweep = sweepForSentinel({ journal: `GET ?vf_accept=${sentinel}`, "docker-logs": "" }, sentinel);
    assert.equal(sweep.value.leaked, true);
    assert.deepEqual(sweep.value.leakedSurfaces, ["journal"]);
    assert.doesNotMatch(JSON.stringify(sweep.value), new RegExp(sentinel));
  });

  it("6c. the scrub backstop catches a value that escaped redaction", () => {
    const sentinel = mintSentinel();
    assert.doesNotMatch(scrubSecrets(`raw ${sentinel} here`, [sentinel]), new RegExp(sentinel));
    assert.equal(
      safeOutput(`see https://h.invalid/p?vf_accept=${sentinel}`, [sentinel]),
      "see https://h.invalid/p?<redacted>",
    );
  });

  it("6d. a Stage B run whose sentinel leaked FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        sentinelSweep: measured({
          leaked: true,
          leakedSurfaces: ["journal"],
          surfacesChecked: ["a", "b", "c", "d", "e"],
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("privacy.sentinel-not-leaked"));
  });
});

describe("secret handling", () => {
  it("7. secret environment variables are reported only as present/absent", () => {
    const presence = describePresence("WORKER_CONTROL_SECRET", "an-actual-secret-value");
    assert.deepEqual(presence, { name: "WORKER_CONTROL_SECRET", present: true });
    assert.equal(Object.keys(presence).length, 2);
  });

  it("7c. forbidden evidence keys are withheld even if an observer supplies them", () => {
    const record = buildEvidence({
      stage: "A",
      job: { id: "abc", cookie: "session=xyz", stderr: "raw tool output", nested: { token: "t" } },
      checks: [],
      summary: { verdict: "PASS", counts: {}, blocking: [], notExercised: [] },
    });
    const rendered = renderEvidence(record, []);
    assert.doesNotMatch(rendered, /session=xyz/);
    assert.doesNotMatch(rendered, /raw tool output/);
    assert.match(rendered, /<withheld>/);
  });

  it("28. the observer allowlist forbids repair, rotation and mutation", () => {
    for (const [file, argv] of [
      ["systemctl", ["restart", "videofetch-egress-policy"]],
      ["systemctl", ["stop", "videofetch-worker"]],
      ["systemctl", ["start", "videofetch-worker"]],
      ["nft", ["flush", "ruleset"]],
      ["iptables", ["-F"]],
      ["ip", ["route", "add", "default", "via", "10.0.0.1"]],
      ["docker", ["network", "connect", "bridge", "videofetch-worker"]],
      ["docker", ["run", "-d", "videofetch-worker:latest"]],
      ["docker", ["tag", "a", "b"]],
      ["docker", ["build", "-t", "x", "."]],
      ["docker", ["exec", "videofetch-worker", "sh", "-c", "echo YTDLP_ENABLED=true >> /etc/x"]],
      ["docker", ["exec", "videofetch-worker", "cat", "/etc/videofetch/worker.env"]],
      ["sh", ["-c", "anything"]],
      ["bash", ["-c", "anything"]],
      ["/usr/local/sbin/vf-egress-policy-install", []],
      ["readlink", ["/etc/videofetch/worker.env"]],
    ]) {
      assert.equal(isReadOnlyCommand(file, argv), false, `${file} ${argv[0]} must be refused`);
    }
  });

  it("28b. the allowlist admits exactly the read-only observations needed", () => {
    assert.equal(isReadOnlyCommand("systemctl", ["is-active", "videofetch-worker"]), true);
    // §4 of CORRECTION-05: `docker inspect` is admitted only with one of the
    // three named templates — a bare inspect returns the whole container JSON,
    // environment values included.
    assert.equal(isReadOnlyCommand("docker", ["inspect", "videofetch-worker"]), false);
    for (const format of ["{{.Image}}", "{{.HostConfig.NetworkMode}}", "{{.State.Pid}}"]) {
      assert.equal(
        isReadOnlyCommand("docker", ["inspect", "--format", format, "videofetch-worker"]),
        true,
        format,
      );
    }
    assert.equal(isReadOnlyCommand("docker", ["top", "videofetch-worker", "-o", "pid,ppid,pgid,comm"]), true);
    assert.equal(isReadOnlyCommand("/usr/local/sbin/vf-egress-policy-verify", []), true);
    assert.equal(isReadOnlyCommand("docker", ["exec", "videofetch-worker", "node", "--version"]), true);
    assert.equal(isReadOnlyCommand("docker", ["exec", "videofetch-worker", ...EJS_PROBE_ARGV]), true);
    assert.equal(isReadOnlyCommand("readlink", ["/proc/200/ns/net"]), true);
    assert.equal(
      isReadOnlyCommand("docker", ["exec", "videofetch-worker", ...workDirProbeArgv(JOB_ID)]),
      true,
    );
  });

  it("28c. the workDir probe cannot become a container shell", () => {
    assert.throws(() => workDirProbeArgv("../../etc"), /malformed job id/);
    assert.equal(
      isReadOnlyCommand("docker", [
        "exec", "videofetch-worker", "/usr/bin/python3", "-c", "import os;os.system('id')",
      ]),
      false,
    );
  });
});

// ── Remaining Stage B matrix ───────────────────────────────────────────────

describe("Stage B outcome matrix", () => {
  it("a fully successful Stage B run passes", () => {
    assert.equal(evaluateStageB(passingStageBObservations(), passingStageA()).summary.verdict, OUTCOMES.PASS);
  });

  it("16. a byte-integrity failure FAILS", () => {
    for (const patch of [
      { clientDigest: "" },
      { clientBytes: 4 },
      { r2ContentLength: 1 },
      { durableFileSize: 7 },
      { expectedDigest: "f".repeat(64) },
      { expectedDigest: null },
      { expectedDigest: "B".repeat(64) },
    ]) {
      const result = evaluateStageB(
        passingStageBObservations({
          vercelDelivery: measured({
            redirectStatus: 303,
            presigned: true,
            clientBytes: 83089,
            clientDigest: "b".repeat(64),
            durableFileSize: 83089,
            r2ContentLength: 83089,
            expectedDigest: "b".repeat(64),
            ...patch,
          }),
        }),
        passingStageA(),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, JSON.stringify(patch));
      assert.ok(result.summary.blocking.includes("vercel.byte-integrity"));
    }
  });

  it("18. incomplete byte-limit evidence is BLOCKED, never substituted", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        byteLimitCase: unmeasured("LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN"),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    const entry = result.checks.find((c) => c.id === "limit.actual-byte-guard");
    assert.match(entry.detail, /NOT MEASURABLE/);
    assert.match(entry.detail, /LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN/);
  });

  it("31. a KNOWN declared length does not satisfy the byte-watcher case", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        byteLimitCase: measured({
          declaredLengthUnknown: false,
          outcome: "TOO_LARGE",
          beganProcessing: false,
          uploaded: false,
          workDirPresent: false,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("limit.actual-byte-guard"));
  });

  it("other Stage B violations fail as expected", () => {
    const cases = [
      [{ genericAnalysis: measured({ extractor: "direct", directControlExtractor: "direct", formats: [], presets: APP_PRESETS, thumbnail: null }) }, "analysis.generic-selected"],
      [{ genericAnalysis: measured({ extractor: "yt-dlp", directControlExtractor: "yt-dlp", formats: [], presets: APP_PRESETS, thumbnail: null }) }, "analysis.direct-still-selected"],
      [{ genericAnalysis: measured({ extractor: "yt-dlp", directControlExtractor: "direct", formats: [{ format_id: "22" }], presets: APP_PRESETS, thumbnail: null }) }, "analysis.no-raw-formats"],
      [{ genericAnalysis: measured({ extractor: "yt-dlp", directControlExtractor: "direct", formats: [], presets: APP_PRESETS, thumbnail: "https://t.invalid/x.jpg" }) }, "analysis.no-generic-thumbnail"],
      [{ egressNegative: measured({ denied: true, attributedToBoundary: false }) }, "safe-egress.forbidden-destination-denied"],
      [{ egressPolicyFingerprint: measured({ beforeMatchesAfter: false }) }, "safe-egress.policy-unchanged"],
      [{ workerEnvironmentNames: measured(["R2_WRITER_ACCESS_KEY_ID"]) }, "r2.worker-holds-no-credential"],
      [{ directAfterEnable: measured({ status: "ready", extractor: "direct", processSamplingMeasured: true, samplesTaken: 3, sampledBasenames: ["node", "python3"] }) }, "direct.no-ytdlp-spawned"],
      [{ killSwitch: measured({ genericUsableAfterDisable: true, directWorks: true }) }, "killswitch.rollback"],
      [{ siteCatalog: measured({ limitedEntriesPromoted: true }) }, "catalog.unchanged"],
      [{ shutdownCase: measured({ descendantsGone: false, recoveredStatus: "failed" }) }, "shutdown.group-terminated"],
    ];
    for (const [override, expectedId] of cases) {
      const result = evaluateStageB(passingStageBObservations(override), passingStageA());
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, expectedId);
      assert.ok(result.summary.blocking.includes(expectedId), expectedId);
    }
  });

  it("records an unperformed fail-closed runtime case as NOT_EXERCISED", () => {
    const result = evaluateStageB(
      passingStageBObservations({ failClosedRuntime: unmeasured("not performed") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
    assert.ok(result.summary.notExercised.includes("runtime.fail-closed"));
  });

  it("still FAILS an optional case that was measured and violated", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        failClosedRuntime: measured({ genericUsable: true, fellBackToPath: true, directStillWorks: true }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
  });

  it("picks the highest-fidelity advertised preset", () => {
    assert.equal(pickPreset(APP_PRESETS).id, "preset:720");
    assert.equal(pickPreset([{ id: "preset:audio", formatId: "preset:audio" }]).id, "preset:audio");
    assert.equal(pickPreset([]), null);
  });
});

// ── Stage separation ───────────────────────────────────────────────────────

describe("stage separation", () => {
  it("4. Stage A is refused against an enabled deployment", async () => {
    const world = makeFakeWorld({ ytdlpEnabled: "true" });
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/stage-mismatch.json"],
      LIVE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /STAGE MISMATCH/);
    assert.match(run.err, /Refusing to grade Stage A/);
  });

  it("4b. an enabled-state case is refused against a disabled deployment", async () => {
    const world = makeFakeWorld({ ytdlpEnabled: null });
    const run = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic", VIDEOFETCH_ACCEPT_DIRECT_URL: "https://f.invalid/c.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /STAGE MISMATCH/);
    assert.match(run.err, /requires generic enabled, but the deployment is disabled/);
  });

  it("4c. the stage is never inferred", () => {
    assert.equal(readStage([]).ok, false);
    assert.equal(readStage(["--stage", "C"]).ok, false);
    assert.equal(readStage(["--stage", "a"]).ok, false);
    assert.deepEqual(readStage(["--stage", "B"]), { ok: true, stage: "B" });
  });

  it("4d. Stage B requires an explicit case or aggregate", async () => {
    const run = await runCli(["--stage", "B", ...LIVE_ARGS], LIVE_ENV());
    assert.equal(run.code, 3);
    assert.match(run.err, /requires either --case <name> or --aggregate/);
  });

  it("4e. an unknown case name is refused", async () => {
    const run = await runCli(["--stage", "B", "--case", "invented", ...LIVE_ARGS], LIVE_ENV());
    assert.equal(run.code, 3);
    assert.match(run.err, /--case must be one of/);
  });

  it("rejects Stage A grading of an enabled deployment (pure)", () => {
    assert.equal(rejectsStageBConfiguration({ ytdlpEnabledRaw: measured("true") }), true);
    assert.equal(rejectsStageBConfiguration({ ytdlpEnabledRaw: measured("false") }), false);
    assert.equal(rejectsStageBConfiguration({ ytdlpEnabledRaw: unmeasured("x") }), false);
  });
});

// ── Verdict algebra ────────────────────────────────────────────────────────

describe("verdict algebra", () => {
  it("never converts an unmeasurable required property into a pass", () => {
    const entry = measuredCheck("x", { measured: false, reason: "no access" }, () => true, "d");
    assert.equal(entry.outcome, OUTCOMES.BLOCKED);
    assert.equal(summarize([entry]).verdict, OUTCOMES.BLOCKED);
  });

  it("refuses to construct a required NOT_EXERCISED check", () => {
    assert.throws(() => check("x", OUTCOMES.NOT_EXERCISED, "d"), /required/);
    assert.doesNotThrow(() => check("x", OUTCOMES.NOT_EXERCISED, "d", { required: false }));
  });

  it("treats an empty check list as BLOCKED, not PASS", () => {
    assert.equal(summarize([]).verdict, OUTCOMES.BLOCKED);
  });

  it("ranks FAIL above BLOCKED", () => {
    const summary = summarize([
      check("a", OUTCOMES.BLOCKED, ""),
      check("b", OUTCOMES.FAIL, ""),
      check("c", OUTCOMES.PASS, ""),
    ]);
    assert.equal(summary.verdict, OUTCOMES.FAIL);
    assert.deepEqual([...summary.blocking].sort(), ["a", "b"]);
  });
});

// ── CORRECTION-02 §22-§29: evidence provenance ─────────────────────────────

describe("evidence provenance", () => {
  const KEY = "a".repeat(64);
  const RUN = { runId: "0123456789abcdef", key: KEY };
  const expectations = { runId: RUN.runId, expectedSha: SHA, runningImageId: IMAGE_ID };

  const genuineCase = () =>
    sealRecord(
      caseRecord({
        caseName: "cancellation",
        binding: { expectedSha: SHA, runningImageId: IMAGE_ID },
        payload: { cancellation: cancellationEvidence({ postSample: [] }) },
        runId: RUN.runId,
      }),
      KEY,
    );

  const genuineStageA = () =>
    sealRecord(
      {
        harness: HARNESS_ID,
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        runId: RUN.runId,
        stage: "A",
        verdict: "PASS",
        expectedSha: SHA,
        runningImageId: IMAGE_ID,
        taggedImageId: IMAGE_ID,
        binding: { expectedSha: SHA, runningImageId: IMAGE_ID, taggedImageId: IMAGE_ID },
      },
      KEY,
    );

  it("29. a genuine case artifact is accepted", () => {
    const record = genuineCase();
    assert.equal(verifySeal(record, KEY).ok, true);
    assert.equal(verifyRecord(record, KEY, expectations).ok, true);
    assert.equal(validateCaseRecord(record, { expectedSha: SHA, runningImageId: IMAGE_ID }).ok, true);
  });

  it("29b. a genuine Stage A artifact is accepted", async () => {
    const record = genuineStageA();
    const loaded = await loadStageA("/x", async () => JSON.stringify(record), {
      run: RUN,
      expectedSha: SHA,
    });
    assert.equal(loaded.ok, true, loaded.reason);
  });

  it("29c. editing ANY authenticated field invalidates the seal", () => {
    const edits = [
      ["a boolean", (r) => { r.payload.cancellation.lateReady = true; }],
      ["a nested boolean", (r) => { r.payload.cancellation.workDirPresent = true; }],
      ["a PID", (r) => { r.payload.cancellation.workerPid = 999; }],
      ["a transition", (r) => { r.payload.cancellation.transitions.push("ready"); }],
      ["the case name", (r) => { r.case = "success"; }],
      ["the expected SHA", (r) => { r.expectedSha = "0".repeat(40); }],
      ["the running image id", (r) => { r.runningImageId = `sha256:${"b".repeat(64)}`; }],
      ["the run id", (r) => { r.runId = "ffffffffffffffff"; }],
      ["the schema version", (r) => { r.schemaVersion = "made-up"; }],
      ["the harness id", (r) => { r.harness = "somewhere/else.mjs"; }],
    ];
    for (const [what, mutate] of edits) {
      const record = JSON.parse(JSON.stringify(genuineCase()));
      mutate(record);
      const verified = verifyRecord(record, KEY, expectations);
      assert.equal(verified.ok, false, `editing ${what} must invalidate the record`);
    }
  });

  it("29d. editing a DIGEST invalidates a success record", () => {
    const record = sealRecord(
      buildCaseRecord({
        caseName: "success",
        binding: { expectedSha: SHA, runningImageId: IMAGE_ID },
        payload: { vercelDelivery: { clientDigest: "a".repeat(64) } },
        runId: RUN.runId,
      }),
      KEY,
    );
    assert.equal(verifySeal(record, KEY).ok, true);
    record.payload.vercelDelivery.clientDigest = "b".repeat(64);
    assert.equal(verifySeal(record, KEY).ok, false);
  });

  it("29e. a missing or malformed authenticator is rejected", () => {
    const noAuth = genuineCase();
    delete noAuth.authenticator;
    assert.match(verifySeal(noAuth, KEY).reason, /no usable authenticator/);

    const badAlg = genuineCase();
    badAlg.authenticator.alg = "none";
    assert.match(verifySeal(badAlg, KEY).reason, /no usable authenticator/);

    const badMac = genuineCase();
    badMac.authenticator.mac = "short";
    assert.match(verifySeal(badMac, KEY).reason, /malformed/);
  });

  it("29f. the wrong key rejects a genuine record", () => {
    assert.equal(verifySeal(genuineCase(), "b".repeat(64)).ok, false);
  });

  it("29g. a record from another run is rejected", () => {
    const record = genuineCase();
    assert.equal(verifyRecord(record, KEY, { ...expectations, runId: "other-run" }).ok, false);
    assert.match(
      verifyRecord(record, KEY, { ...expectations, runId: "other-run" }).reason,
      /different acceptance run/,
    );
  });

  it("29h. a record from another image is rejected", () => {
    const verified = verifyRecord(genuineCase(), KEY, {
      ...expectations,
      runningImageId: `sha256:${"c".repeat(64)}`,
    });
    assert.equal(verified.ok, false);
    assert.match(verified.reason, /different image object/);
  });

  it("29i. a hand-written record cannot be accepted, however well-shaped", () => {
    const forged = {
      harness: HARNESS_ID,
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      runId: RUN.runId,
      stage: "B",
      case: "cancellation",
      expectedSha: SHA,
      runningImageId: IMAGE_ID,
      payload: { cancellation: cancellationEvidence({ postSample: [] }) },
    };
    assert.equal(verifyRecord(forged, KEY, expectations).ok, false);
    // Even with an invented authenticator.
    forged.authenticator = { alg: "HMAC-SHA256", mac: "0".repeat(64) };
    assert.equal(verifyRecord(forged, KEY, expectations).ok, false);
  });

  it("27. a Stage A record with runningImageId:null cannot authorize Stage B", async () => {
    const record = sealRecord(
      {
        harness: HARNESS_ID,
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        runId: RUN.runId,
        stage: "A",
        verdict: "PASS",
        expectedSha: SHA,
        runningImageId: null,
        taggedImageId: null,
        binding: { expectedSha: SHA, runningImageId: null, taggedImageId: null },
      },
      KEY,
    );
    const loaded = await loadStageA("/x", async () => JSON.stringify(record), {
      run: RUN,
      expectedSha: SHA,
    });
    assert.equal(loaded.ok, false);
    assert.match(loaded.reason, /valid running image identity|valid running image id/);
  });

  it("27b. the deployment binding must be complete and self-consistent", () => {
    const good = { expectedSha: SHA, runningImageId: IMAGE_ID, taggedImageId: IMAGE_ID };
    assert.equal(validateDeploymentBinding(good, SHA).ok, true);

    const cases = [
      [null, /no deployment binding/],
      [{ ...good, expectedSha: "zzz" }, /valid expected source SHA/],
      [{ ...good, runningImageId: null }, /valid running image id/],
      [{ ...good, taggedImageId: null }, /valid SHA-tagged image id/],
      [{ ...good, taggedImageId: `sha256:${"e".repeat(64)}` }, /not the image tagged with/],
    ];
    for (const [binding, pattern] of cases) {
      const result = validateDeploymentBinding(binding, SHA);
      assert.equal(result.ok, false, JSON.stringify(binding));
      assert.match(result.reason, pattern);
    }
    // A binding for a different source SHA is refused.
    assert.match(validateDeploymentBinding(good, "0".repeat(40)).reason, /is for source/);
  });

  it("28. canonicalization is order-independent", () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
    assert.equal(canonicalize({ a: [1, { d: 4, c: 3 }] }), '{"a":[1,{"c":3,"d":4}]}');
  });

  it("24. the run key file is created 0600 and never printed", async () => {
    const files = new Map();
    const modes = new Map();
    const deps = {
      readFile: async (path) => {
        if (files.has(path)) return files.get(path);
        throw new Error("no such file");
      },
      writeFile: async (path, contents, options) => {
        files.set(path, contents);
        if (options?.mode) modes.set(path, options.mode);
      },
      mkdir: async () => {},
      chmod: async (path, mode) => modes.set(path, mode),
      stat: async (path) => {
        if (!files.has(path)) {
          const error = new Error("no such file");
          error.code = "ENOENT";
          throw error;
        }
        return { mode: modes.get(path) ?? 0o600 };
      },
    };
    const created = await loadOrCreateRun("/tmp/run.json", deps);
    assert.equal(created.created, true);
    assert.match(created.runId, /^[0-9a-f]{16}$/);
    assert.match(created.key, /^[0-9a-f]{64}$/);
    assert.equal(modes.get("/tmp/run.json"), 0o600, "the key file must be 0600");

    // Loading again returns the SAME run, never a fresh key.
    const again = await loadRun("/tmp/run.json", deps);
    assert.equal(again.runId, created.runId);
    assert.equal(again.key, created.key);

    // §23 of CORRECTION-05: a malformed file that EXISTS is an error on both
    // paths — never `null` (which reads as "no run started"), and never
    // overwritten. See the dedicated lifecycle suite for the full matrix.
    files.set("/tmp/run.json", "{}");
    assert.match((await loadRun("/tmp/run.json", deps)).error, /does not carry a usable runId/);
    assert.match(
      (await loadOrCreateRun("/tmp/run.json", deps)).error,
      /Refusing to overwrite it/,
    );
    assert.equal(files.get("/tmp/run.json"), "{}", "the damaged file is left exactly as it was");
  });

  it("24b. the run key never appears in any evidence record", async () => {
    const files = new Map();
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );
    assert.equal(run.code, 0);
    const key = JSON.parse(files.get(RUN_KEY_PATH)).key;
    const record = files.get("/tmp/a.json");
    assert.doesNotMatch(record, new RegExp(key), "the run key must never reach evidence");
    assert.doesNotMatch(run.out, new RegExp(key));
    // The non-secret runId fingerprint IS reported, for correlation.
    assert.match(run.out, /acceptance run [0-9a-f]{12} created/);
  });
});

// ── CORRECTION-02 §38: measurement-failure propagation ─────────────────────

describe("measurement failure propagation", () => {
  /**
   * Each entry replaces a measurement with the FAVOURABLE-LOOKING value an
   * earlier draft produced on failure, and asserts the verdict is BLOCKED
   * rather than PASS.
   */
  it("38. an unavailable measurement is BLOCKED, never a clean result", () => {
    const cases = [
      ["R2 read unavailable", { r2Evidence: unmeasured("worker job view unreadable") }, "r2.delegated-write"],
      ["sentinel surfaces unavailable", { sentinelSweep: unmeasured("journal unreadable") }, "privacy.sentinel-not-leaked"],
      ["post-cancel group query unavailable", {
        cancellation: measured(
          cancellationEvidence({ groupMembersMeasured: false, groupSurvivors: [], groupQueryReason: "ps failed" }),
        ),
      }, "cancel.processes-gone"],
      ["workDir probe unavailable", {
        cancellation: measured(cancellationEvidence({ workDirMeasured: false })),
      }, "cancel.no-upload-no-workdir"],
      ["direct process sampling unavailable", {
        directAfterEnable: measured({
          status: "ready",
          extractor: "direct",
          processSamplingMeasured: false,
          samplesTaken: 0,
          sampledBasenames: [],
        }),
      }, "direct.process-sampling-available"],
      ["download window unavailable", { downloadingWindow: unmeasured("sampler failed") }, "process.window-observed"],
      ["durable read unavailable", { durableJobRow: unmeasured("sqlite unreadable") }, "durable.extractor-is-ytdlp"],
    ];
    for (const [label, override, expectedId] of cases) {
      const result = evaluateStageB(passingStageBObservations(override), passingStageA());
      assert.equal(result.summary.verdict, OUTCOMES.BLOCKED, label);
      assert.ok(result.summary.blocking.includes(expectedId), `${label} must block ${expectedId}`);
    }
  });

  it("38b. an EMPTY basename list cannot read as 'no yt-dlp'", () => {
    // The exact fallback an earlier draft produced: `sampledBasenames: []` from
    // a failed sampler, which PASSED the no-yt-dlp check.
    const result = evaluateStageB(
      passingStageBObservations({
        directAfterEnable: measured({
          status: "ready",
          extractor: "direct",
          processSamplingMeasured: false,
          samplesTaken: 0,
          sampledBasenames: [],
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    const noYtdlp = result.checks.find((c) => c.id === "direct.no-ytdlp-spawned");
    assert.notEqual(noYtdlp.outcome, OUTCOMES.PASS, "an unmeasured sample must not pass");
  });

  it("38c. an unqueryable process group cannot read as 'processes gone'", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        cancellation: measured(
          cancellationEvidence({ groupMembersMeasured: false, groupSurvivors: [] }),
        ),
      }),
      passingStageA(),
    );
    const gone = result.checks.find((c) => c.id === "cancel.processes-gone");
    assert.equal(gone.outcome, OUTCOMES.BLOCKED);
  });

  it("38d. a measured NEGATIVE is still FAIL, not BLOCKED", () => {
    // The distinction the tri-state exists for: measurement failure vs a
    // measured cleanup failure are different findings.
    const result = evaluateStageB(
      passingStageBObservations({
        cancellation: measured(cancellationEvidence({ workDirMeasured: true, workDirPresent: true })),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    const entry = result.checks.find((c) => c.id === "cancel.no-upload-no-workdir");
    assert.equal(entry.outcome, OUTCOMES.FAIL);
  });
});

// ── CORRECTION-02 §40: claim truthfulness ──────────────────────────────────

describe("claim truthfulness", () => {
  function allStageBChecks() {
    return [
      ...evaluateStageB(passingStageBObservations(), passingStageA()).checks,
      ...evaluateStageA(passingStageAObservations()).checks,
    ];
  }

  it("40. no check claims a direct fall-through was observed", () => {
    for (const entry of allStageBChecks()) {
      assert.doesNotMatch(
        `${entry.id} ${entry.detail}`,
        /fell through|fall.?through|direct was attempted/i,
        `${entry.id} must not claim an unobservable internal fall-through`,
      );
    }
    // The replacement names say exactly what was measured.
    const ids = allStageBChecks().map((c) => c.id);
    assert.ok(ids.includes("analysis.generic-selected"));
    assert.ok(ids.includes("analysis.direct-still-selected"));
    assert.ok(!ids.includes("analysis.routed-to-generic"));
  });

  it("40b. no check claims the private selector was observed", () => {
    for (const entry of allStageBChecks()) {
      assert.doesNotMatch(
        `${entry.id} ${entry.detail}`,
        /selector constraints satisfied/i,
        `${entry.id} must not present a container comparison as selector proof`,
      );
    }
    const ids = allStageBChecks().map((c) => c.id);
    assert.ok(ids.includes("delivery.matches-advertised-preset"));
    assert.ok(!ids.includes("selector.constraints-satisfied"));
  });

  it("40c. the byte claim names the boundaries it actually measured", () => {
    const entry = allStageBChecks().find((c) => c.id === "vercel.byte-integrity");
    assert.ok(entry);
    assert.match(entry.detail, /durable fileSize/);
    assert.match(entry.detail, /provider contentLength/);
    // It must NOT claim an independent Worker-side digest comparison.
    assert.doesNotMatch(entry.detail, /Worker-produced/i);
    assert.doesNotMatch(entry.detail, /independent/i);
  });
});

// ── CORRECTION-03 §33: the per-case deployment-state contract ──────────────

describe("per-case deployment state", () => {
  const enabled = measured("true");
  const disabledFalse = measured("false");
  const disabledUnset = measured(null);
  const unknown = unmeasured("docker inspect failed");

  it("33. enabled-state cases run only when generic is enabled", () => {
    for (const name of ["success", "cancellation", "byte-limit", "shutdown", "safe-egress", "direct-regression"]) {
      assert.equal(expectedFeatureStateFor(name), "enabled", name);
      assert.equal(evaluateCaseFeatureState(name, enabled).ok, true, `${name} + enabled`);
      assert.equal(evaluateCaseFeatureState(name, disabledFalse).ok, false, `${name} + "false"`);
      assert.equal(evaluateCaseFeatureState(name, disabledUnset).ok, false, `${name} + unset`);
      assert.equal(evaluateCaseFeatureState(name, unknown).ok, false, `${name} + unmeasured`);
    }
  });

  it("33b. the kill-switch case runs only when generic is DISABLED", () => {
    // The previous global guard demanded enabled for every Stage B case, which
    // made this case — whose purpose is to prove the switch works — impossible.
    assert.equal(expectedFeatureStateFor("kill-switch"), "disabled");
    assert.equal(evaluateCaseFeatureState("kill-switch", disabledFalse).ok, true);
    assert.equal(evaluateCaseFeatureState("kill-switch", disabledUnset).ok, true);
    assert.equal(evaluateCaseFeatureState("kill-switch", enabled).ok, false);
    assert.equal(evaluateCaseFeatureState("kill-switch", unknown).ok, false);
  });

  it("33c. an unmeasured feature state BLOCKS every live case", () => {
    for (const name of liveCaseNames()) {
      const result = evaluateCaseFeatureState(name, unknown);
      assert.equal(result.ok, false, name);
      assert.equal(result.blocked, true, name);
      assert.match(result.reason, /deployment stage is unknown/);
    }
  });

  it("33d. an out-of-grammar YTDLP_ENABLED blocks rather than guessing", () => {
    const result = evaluateCaseFeatureState("success", measured("TRUE"));
    assert.equal(result.ok, false);
    assert.match(result.reason, /out-of-grammar/);
  });

  it("33e. the kill-switch case actually runs in the disabled state, end to end", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: null,
      sites: { ytdlp: false, ytdlpInstalled: true, ytdlpEnabled: false, ffmpeg: true },
    });
    const run = await runCli(
      ["--stage", "B", "--case", "kill-switch", ...LIVE_ARGS, "--evidence", "/tmp/ks.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    assert.match(run.out, /deployment state: generic disabled/);
    const record = JSON.parse(run.files.get("/tmp/ks.json"));
    assert.equal(record.payload.killSwitch.genericUsableAfterDisable, false);
    assert.equal(record.payload.killSwitch.directWorks, true);
  });
});

// ── CORRECTION-03 §34: exact process-group termination ─────────────────────

describe("exact process-group termination", () => {
  const captured = { pgid: 200, pid: 200, comm: "python3" };

  it("34. a captured group with no survivors is a PASS candidate", () => {
    const result = evaluateGroupTermination(captured, []);
    assert.equal(result.measured, true);
    assert.equal(result.terminated, true);

    const stageB = evaluateStageB(passingStageBObservations(), passingStageA());
    const check = stageB.checks.find((c) => c.id === "cancel.processes-gone");
    assert.equal(check.outcome, OUTCOMES.PASS);
  });

  it("34b. an ORPHANED survivor fails even though the Worker tree is clean", () => {
    // The exact case an ancestry check misses: after cancellation the leaked
    // acquisition is re-parented away from the Worker, so `descendantsOf(worker)`
    // sees nothing while the process is still running.
    const result = evaluateGroupTermination(captured, [
      { pid: 201, ppid: 1, pgid: 200, comm: "python3" },
    ]);
    assert.equal(result.terminated, false);

    const stageB = evaluateStageB(
      passingStageBObservations({
        cancellation: measured(
          cancellationEvidence({
            groupSurvivors: [{ pid: 201, ppid: 1, pgid: 200, comm: "python3" }],
          }),
        ),
      }),
      passingStageA(),
    );
    assert.equal(stageB.summary.verdict, OUTCOMES.FAIL);
    assert.ok(stageB.summary.blocking.includes("cancel.processes-gone"));
  });

  it("34c. an unqueryable group is BLOCKED", () => {
    assert.equal(evaluateGroupTermination(captured, null).measured, false);
    assert.equal(evaluateGroupTermination(null, []).measured, false);

    const stageB = evaluateStageB(
      passingStageBObservations({
        cancellation: measured(cancellationEvidence({ groupMembersMeasured: false })),
      }),
      passingStageA(),
    );
    assert.equal(stageB.summary.verdict, OUTCOMES.BLOCKED);
  });

  it("34d. PID/PGID reuse is ambiguous, never a clean pass", () => {
    const result = evaluateGroupTermination(captured, [
      { pid: 9, ppid: 1, pgid: 200, comm: "sshd" },
    ]);
    assert.equal(result.measured, false);
    assert.equal(result.ambiguous, true);
    assert.match(result.reason, /reuse/);
  });

  it("34e. shutdown: a surviving OLD group fails even with a fresh Worker", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        shutdownCase: measured(
          shutdownEvidence({
            groupSurvivors: [{ pid: 201, ppid: 1, pgid: 200, comm: "python3" }],
          }),
        ),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("shutdown.group-terminated"));
  });

  it("34f. shutdown: restart observation and group termination are separate", () => {
    const ids = evaluateStageB(passingStageBObservations(), passingStageA()).checks.map((c) => c.id);
    assert.ok(ids.includes("shutdown.group-terminated"));
    assert.ok(ids.includes("shutdown.job-recovered"), "recovery is its own assertion");

    const noRestart = evaluateStageB(
      passingStageBObservations({
        shutdownCase: measured(shutdownEvidence({ restartObserved: false })),
      }),
      passingStageA(),
    );
    assert.equal(noRestart.summary.verdict, OUTCOMES.FAIL);
    assert.ok(noRestart.summary.blocking.includes("shutdown.job-recovered"));
  });

  it("34g. the host process list carries no command line", () => {
    const parsed = parseHostProcessList("  100     1   100 node\n  200   100   200 python3\n");
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.rows, [
      { pid: 100, ppid: 1, pgid: 100, comm: "node" },
      { pid: 200, ppid: 100, pgid: 200, comm: "python3" },
    ]);

    // A trailing field that does not look like a plain basename is neither
    // dropped nor copied: the row SURVIVES (it may be the leak) with its name
    // replaced by a fixed token (§21 of CORRECTION-05).
    const odd = parseHostProcessList("200 100 200 python3 /usr/local/lib/yt-dlp https://x");
    assert.equal(odd.ok, true);
    assert.deepEqual(odd.rows, [{ pid: 200, ppid: 100, pgid: 200, comm: UNCLASSIFIED_COMM }]);
    assert.doesNotMatch(JSON.stringify(odd), /yt-dlp|https/, "no raw text reaches the evidence");
  });
});

// ── CORRECTION-03 §35: safe-egress deny-counter attribution ────────────────

describe("safe-egress attribution", () => {
  const chain = (packets) => ({
    nftables: [
      { rule: { comment: "deny-v4", expr: [{ counter: { packets, bytes: packets * 40 } }, { drop: null }] } },
      { rule: { comment: "allow-https", expr: [{ counter: { packets: 5, bytes: 200 } }, { accept: null }] } },
    ],
  });

  it("35. a flat deny counter can never PASS", () => {
    const attribution = attributeDenial({
      before: readDenyCounter(chain(10), "deny-v4"),
      after: readDenyCounter(chain(10), "deny-v4"),
      requestDenied: true,
    });
    assert.equal(attribution.measured, true);
    assert.equal(attribution.attributedToBoundary, false);
    assert.equal(attribution.denyCounterDelta, 0);
    assert.match(attribution.reason, /stopped by something other than the boundary/);

    const result = evaluateStageB(
      passingStageBObservations({
        egressNegative: measured(
          egressEvidence({ attributedToBoundary: false, denyCounterAfter: 10, denyCounterDelta: 0 }),
        ),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("safe-egress.forbidden-destination-denied"));
  });

  it("35b. a moved counter with a verified policy is a PASS candidate", () => {
    const attribution = attributeDenial({
      before: readDenyCounter(chain(10), "deny-v4"),
      after: readDenyCounter(chain(13), "deny-v4"),
      requestDenied: true,
    });
    assert.equal(attribution.attributedToBoundary, true);
    assert.equal(attribution.denyCounterDelta, 3);
    assert.equal(evaluateStageB(passingStageBObservations(), passingStageA()).summary.verdict, OUTCOMES.PASS);
  });

  it("35c. a direct-layer rejection cannot masquerade as generic egress proof", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        egressNegative: measured(
          egressEvidence({ genericPathEstablished: false, extractor: "direct" }),
        ),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("safe-egress.generic-path-established"));
  });

  it("35d. an unmeasurable counter is BLOCKED, not a pass", () => {
    const missing = readDenyCounter(chain(10), "deny-nonexistent");
    assert.equal(missing.measured, false);
    const attribution = attributeDenial({ before: missing, after: missing, requestDenied: true });
    assert.equal(attribution.measured, false);
    assert.match(attribution.reason, /cannot be attributed/);

    const result = evaluateStageB(
      passingStageBObservations({ egressNegative: unmeasured("counter unreadable") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
  });

  it("35e. a changed ruleset fingerprint FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        egressPolicyFingerprint: measured({ beforeMatchesAfter: false }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("safe-egress.policy-unchanged"));
  });

  it("35f. the fingerprint ignores counters but notices rule changes", () => {
    // Counters are EXPECTED to move — that movement is the evidence — so a
    // fingerprint that changed with every denied packet would be useless.
    const a = fingerprintChain(chain(10));
    const b = fingerprintChain(chain(9999));
    assert.equal(a.measured, true);
    assert.equal(a.normalized, b.normalized, "counter movement must not change the fingerprint");

    const widened = {
      nftables: [
        ...chain(10).nftables,
        { rule: { comment: "temporary-allow", expr: [{ accept: null }] } },
      ],
    };
    assert.notEqual(fingerprintChain(widened).normalized, a.normalized, "a new rule must change it");
  });

  it("35g. a malformed listing is unmeasurable, not empty", () => {
    assert.equal(readDenyCounter({}, "deny-v4").measured, false);
    assert.equal(fingerprintChain(null).measured, false);
  });
});

// ── CORRECTION-03 §36: byte-limit actual-media-GET evidence ────────────────

describe("byte-limit actual transfer evidence", () => {
  it("36. a declared Content-Length on the ACTUAL media GET cannot pass", () => {
    // The exact hole the old HEAD-on-submitted-URL check left: the page had no
    // length, the media resource did, and --max-filesize would have caught it.
    const result = evaluateStageB(
      passingStageBObservations({
        byteLimitCase: measured(byteLimitEvidence({ contentLengthPresent: true })),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("limit.actual-byte-guard"));
  });

  it("36b. an unknown-length actual transfer with TOO_LARGE is a PASS candidate", () => {
    assert.equal(evaluateStageB(passingStageBObservations(), passingStageA()).summary.verdict, OUTCOMES.PASS);
  });

  it("36c. a direct-strategy fixture cannot be generic byte-limit acceptance", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        byteLimitCase: measured(byteLimitEvidence({ extractor: "direct" })),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("limit.actual-byte-guard"));
  });

  it("36d. an unobserved media request cannot pass", () => {
    for (const patch of [
      { actualMediaRequestObserved: false },
      { outcome: "CANCELLED" },
      { beganProcessing: true },
      { uploaded: true },
      { workDirPresent: true },
    ]) {
      const result = evaluateStageB(
        passingStageBObservations({ byteLimitCase: measured(byteLimitEvidence(patch)) }),
        passingStageA(),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, JSON.stringify(patch));
    }
  });

  it("36e. unmeasurable transfer semantics remain fail-closed", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        byteLimitCase: unmeasured("LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN"),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    const entry = result.checks.find((c) => c.id === "limit.actual-byte-guard");
    assert.match(entry.detail, /LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN/);
  });
});

// ── CORRECTION-03 §37: complete-record provenance ──────────────────────────

describe("complete-record provenance", () => {
  const KEY = "a".repeat(64);
  const full = () =>
    sealRecord(
      {
        harness: HARNESS_ID,
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        runId: "0123456789abcdef",
        task: "PHASE-10D",
        stage: "A",
        verdict: "PASS",
        startedAt: "2026-09-03T00:00:00.000Z",
        expectedSha: SHA,
        runningImageId: IMAGE_ID,
        taggedImageId: IMAGE_ID,
        binding: { expectedSha: SHA, runningImageId: IMAGE_ID, taggedImageId: IMAGE_ID },
        runtime: { ytdlpVersion: "2026.08.19", nodeVersion: "v22.23.2" },
        services: { "videofetch-worker": "active" },
        delivery: { clientBytes: 83089, clientDigest: "b".repeat(64) },
        process: { samplesTaken: 3, basenamesSeen: ["node", "python3"] },
        checks: [{ id: "image.identity", outcome: "PASS", required: true, detail: "" }],
      },
      KEY,
    );

  it("37. EVERY acceptance-relevant field is inside the seal", () => {
    const mutations = [
      ["nested binding.runningImageId", (r) => { r.binding.runningImageId = `sha256:${"c".repeat(64)}`; }],
      ["nested binding.expectedSha", (r) => { r.binding.expectedSha = "0".repeat(40); }],
      ["nested binding.taggedImageId", (r) => { r.binding.taggedImageId = `sha256:${"d".repeat(64)}`; }],
      ["checks[0].outcome", (r) => { r.checks[0].outcome = "FAIL"; }],
      ["checks[0].id", (r) => { r.checks[0].id = "something.else"; }],
      ["runtime.ytdlpVersion", (r) => { r.runtime.ytdlpVersion = "9999.01.01"; }],
      ["services entry", (r) => { r.services["videofetch-worker"] = "failed"; }],
      ["delivery.clientBytes", (r) => { r.delivery.clientBytes = 1; }],
      ["delivery.clientDigest", (r) => { r.delivery.clientDigest = "e".repeat(64); }],
      ["process.samplesTaken", (r) => { r.process.samplesTaken = 99; }],
      ["process.basenamesSeen", (r) => { r.process.basenamesSeen.push("ffmpeg"); }],
      ["verdict", (r) => { r.verdict = "FAIL"; }],
      ["expectedSha", (r) => { r.expectedSha = "0".repeat(40); }],
      ["runningImageId", (r) => { r.runningImageId = `sha256:${"f".repeat(64)}`; }],
      ["taggedImageId", (r) => { r.taggedImageId = `sha256:${"f".repeat(64)}`; }],
      ["runId", (r) => { r.runId = "ffffffffffffffff"; }],
      ["startedAt", (r) => { r.startedAt = "2020-01-01T00:00:00.000Z"; }],
      ["task", (r) => { r.task = "SOMETHING-ELSE"; }],
      ["a NEW field", (r) => { r.injected = true; }],
    ];
    for (const [what, mutate] of mutations) {
      const record = JSON.parse(JSON.stringify(full()));
      mutate(record);
      assert.equal(verifySeal(record, KEY).ok, false, `editing ${what} must invalidate the record`);
    }
    // The unedited record still verifies.
    assert.equal(verifySeal(full(), KEY).ok, true);
  });

  it("37b. the nested binding must agree with the top-level identity", () => {
    assert.equal(bindingAgreesWithRecord(full()).ok, true);
    const skewed = JSON.parse(JSON.stringify(full()));
    skewed.binding.runningImageId = `sha256:${"c".repeat(64)}`;
    const agreement = bindingAgreesWithRecord(skewed);
    assert.equal(agreement.ok, false);
    assert.match(agreement.reason, /runningImageId disagrees/);
  });

  it("37c. a Stage A record whose binding disagrees is refused", async () => {
    const skewed = JSON.parse(JSON.stringify(full()));
    skewed.binding.expectedSha = "0".repeat(40);
    const resealed = sealRecord({ ...skewed, authenticator: undefined }, KEY);
    delete resealed.authenticator.undefined;
    const loaded = await loadStageA("/x", async () => JSON.stringify(resealed), {
      run: { runId: "0123456789abcdef", key: KEY },
      expectedSha: SHA,
    });
    assert.equal(loaded.ok, false);
  });

  it("25. a group- or world-readable run key is refused", async () => {
    // A run id of the exact shape the harness itself mints (§16 of
    // CORRECTION-06); the permission check is what is under test here.
    const deps = {
      readFile: async () => JSON.stringify({ runId: "a1b2c3d4e5f60718", key: "d".repeat(64) }),
      stat: async () => ({ mode: 0o644 }),
    };
    const loaded = await loadRun("/tmp/run.json", deps);
    assert.ok(loaded?.error, "a 0644 key file must be refused");
    assert.match(loaded.error, /must not be group- or world-accessible/);

    const safe = await loadRun("/tmp/run.json", { ...deps, stat: async () => ({ mode: 0o600 }) });
    assert.equal(safe.runId, "a1b2c3d4e5f60718");
  });
});

// ── CORRECTION-03 §38: final process JSON ──────────────────────────────────

describe("final process evidence JSON", () => {
  it("38. the record reports the real multi-sample aggregate", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const files = seedRun();
    const shared = { runReadOnly: world.runReadOnly, fetch: world.fetch, files };
    const liveEnv = LIVE_ENV({
      VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
      VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
      ...WORKER_ENV,
    });
    const success = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      liveEnv,
      shared,
    );
    assert.equal(success.code, 0, `${success.out}\n${success.err}`);

    // The aggregate the evaluator judges is the aggregate the record reports.
    const record = JSON.parse(success.files.get("/tmp/c.json"));
    const aggregate = aggregateDownloadWindow(record.payload.downloadingWindow);
    assert.ok(aggregate.samplesTaken > 0, "samples were actually taken");
    assert.ok(aggregate.basenamesSeen.includes("python3"), "the acquisition process is reported");
    assert.equal(ytdlpIdentified(aggregate), true);
  });

  it("38b. a transient Node and a transient forbidden descendant both survive into the JSON", () => {
    const NS = "net:[4026532001]";
    const withNode = acquisitionSample([{ pid: 300, ppid: 200, pgid: 200, comm: "node", netns: NS }]);
    const withFfmpeg = acquisitionSample([{ pid: 301, ppid: 200, pgid: 200, comm: "ffmpeg", netns: NS }]);

    const aggregate = aggregateDownloadWindow(
      windowOf([acquisitionSample(), withNode, withFfmpeg, acquisitionSample()]),
    );
    assert.equal(aggregate.samplesTaken, 4);
    assert.deepEqual(aggregate.basenamesSeen, ["ffmpeg", "node", "python3"]);
    assert.equal(nodeExercised(aggregate), true);
    assert.deepEqual([...new Set(aggregate.forbiddenSeen.map((r) => r.comm))], ["ffmpeg"]);
  });

  it("38c. a sampler failure inside the open window BLOCKS the negative claim", () => {
    const window = {
      ...windowOf([acquisitionSample(), acquisitionSample()]),
      samplerErrors: ["docker top failed"],
    };
    const aggregate = aggregateDownloadWindow(window);
    assert.equal(aggregate.usable, false);
    assert.match(aggregate.reason, /unobserved interval/);

    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(window) }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("process.window-observed"));
  });

  it("38d. a sample straddling the window close is discarded, and counted", () => {
    // Sampling is asynchronous, so the final in-flight snapshot always straddles
    // the close. It is not credited as coverage and cannot admit a `processing`
    // FFmpeg — but it is recorded, so the unresolvable tail is visible.
    // A fixed clock so the close timestamp is known exactly: the window closes
    // at t=10, the clean sample ran 1..2, and the straddling one 5..20.
    const collector = createDownloadWindowCollector({ now: () => 10 });
    collector.noteState("downloading");
    collector.addSample(
      { sample: acquisitionSample(), workerPid: 100, ytdlpPid: 200, expectedNetns: "net:[4026532001]" },
      { startedAt: 1, finishedAt: 2 },
    );
    collector.noteState("processing"); // closedAt = 10
    collector.addSample(
      {
        sample: acquisitionSample([
          { pid: 301, ppid: 200, pgid: 200, comm: "ffmpeg", netns: "net:[4026532001]" },
        ]),
        workerPid: 100,
        ytdlpPid: 200,
        expectedNetns: "net:[4026532001]",
      },
      { startedAt: 5, finishedAt: 20 },
    );
    const result = collector.result();
    assert.equal(result.samples.length, 1, "the straddling sample is not admitted");
    assert.equal(result.ambiguousSamples.length, 1, "and it is recorded");

    const aggregate = aggregateDownloadWindow(result);
    assert.equal(aggregate.usable, true, "a close-straddle alone does not block a healthy run");
    assert.deepEqual(aggregate.forbiddenSeen, [], "the discarded processing FFmpeg is not credited");
  });
});

// ── CORRECTION-04 §3-§9: the aggregate is state-neutral ────────────────────
//
// The acceptance sequence is Stage A (disabled) -> operator enables ->
// enabled-state cases -> operator disables -> kill-switch -> aggregate. Its
// terminal condition is therefore generic DISABLED, and an aggregate that
// re-graded the current deployment as if generic must be enabled would fail
// every correctly executed run.

describe("multi-state aggregation", () => {
  const binding = { expectedSha: SHA, runningImageId: IMAGE_ID };

  it("40. a complete sequence PASSES with the final state disabled", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        // The deployment as it stands AT AGGREGATION TIME: generic disabled,
        // because the kill-switch case has just run. This is the preferred
        // Phase-10D terminal condition.
        ytdlpEnabledRaw: measured(null),
        capabilities: measured({ ytdlp: false, ytdlpInstalled: true, ytdlpEnabled: false, ffmpeg: true }),
        finalFeatureState: measured(featureState("disabled")),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.PASS, result.summary.blocking.join(", "));
  });

  it("40b. a currently-disabled deployment does not retroactively fail the enabled phase", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        ytdlpEnabledRaw: measured("false"),
        capabilities: measured({ ytdlp: false, ytdlpInstalled: true, ytdlpEnabled: false, ffmpeg: true }),
        finalFeatureState: measured(featureState("disabled")),
      }),
      passingStageA(),
    );
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c.outcome]));
    assert.equal(byId["capability.generic-usable"], OUTCOMES.PASS);
    assert.equal(byId["config.ytdlp-enabled"], OUTCOMES.PASS);
  });

  it("40c. a currently-enabled deployment does not erase the kill-switch evidence", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        ytdlpEnabledRaw: measured("true"),
        finalFeatureState: measured(featureState("enabled")),
      }),
      passingStageA(),
    );
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c.outcome]));
    assert.equal(byId["killswitch.disabled-state-proven"], OUTCOMES.PASS);
    assert.equal(byId["killswitch.rollback"], OUTCOMES.PASS);
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
  });

  it("40d. an unproven enabled phase is BLOCKED, never substituted from the present", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        // Generic IS enabled right now — but no `success` artifact proves the
        // enabled-state case ran while it was.
        ytdlpEnabledRaw: measured("true"),
        capabilities: measured({ ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true }),
        enabledFeatureState: unmeasured("no accepted `success` case evidence"),
      }),
      passingStageA(),
    );
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c.outcome]));
    assert.equal(byId["capability.generic-usable"], OUTCOMES.BLOCKED);
    assert.equal(byId["config.ytdlp-enabled"], OUTCOMES.BLOCKED);
  });

  it("40e. an unproven disabled phase is BLOCKED", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        disabledFeatureState: unmeasured("no accepted `kill-switch` case evidence"),
      }),
      passingStageA(),
    );
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c.outcome]));
    assert.equal(byId["killswitch.disabled-state-proven"], OUTCOMES.BLOCKED);
  });

  it("40f. a `success` artifact recording the DISABLED state is rejected", () => {
    const record = buildCaseRecord({
      caseName: "success",
      binding,
      payload: { cancellation: cancellationEvidence() },
      featureState: featureState("disabled"),
    });
    const validated = validateCaseRecord(record, binding);
    assert.equal(validated.ok, false);
    assert.match(validated.reason, /requires generic enabled.*ran while generic was disabled/s);
  });

  it("40g. a `kill-switch` artifact recording the ENABLED state is rejected", () => {
    const record = buildCaseRecord({
      caseName: "kill-switch",
      binding,
      payload: { killSwitch: { genericUsableAfterDisable: false, directWorks: true } },
      featureState: featureState("enabled"),
    });
    const validated = validateCaseRecord(record, binding);
    assert.equal(validated.ok, false);
    assert.match(validated.reason, /requires generic disabled.*ran while generic was enabled/s);
  });

  it("40h. a record with no measured feature state at all is rejected", () => {
    const none = buildCaseRecord({ caseName: "cancellation", binding, payload: {} });
    assert.match(validateCaseRecord(none, binding).reason, /no well-formed measured feature state/);

    // Self-contradictory: claims `enabled` beside a raw value that means disabled.
    const contradictory = buildCaseRecord({
      caseName: "cancellation",
      binding,
      payload: {},
      featureState: { ...featureState("enabled"), ytdlpEnabledRaw: "false" },
    });
    assert.match(
      validateCaseRecord(contradictory, binding).reason,
      /no well-formed measured feature state/,
    );
  });

  it("40i. the feature state is sealed with the record and cannot be edited", () => {
    const KEY = "e".repeat(64);
    const sealed = sealRecord(
      caseRecord({
        caseName: "kill-switch",
        binding,
        payload: { killSwitch: { genericUsableAfterDisable: false, directWorks: true } },
        runId: "0123456789abcdef",
      }),
      KEY,
    );
    assert.equal(verifySeal(sealed, KEY).ok, true);
    sealed.featureState.state = "enabled";
    assert.equal(verifySeal(sealed, KEY).ok, false, "editing the sealed state must invalidate it");
  });

  it("40j. the final deployment state is recorded, and either value is accepted", () => {
    for (const state of ["enabled", "disabled"]) {
      const result = evaluateStageB(
        passingStageBObservations({ finalFeatureState: measured(featureState(state)) }),
        passingStageA(),
      );
      const check = result.checks.find((c) => c.id === "deployment.final-state-recorded");
      assert.equal(check.outcome, OUTCOMES.PASS, state);
    }
    // Unmeasurable is NOT a pass — the policy is explicit either way.
    const blocked = evaluateStageB(
      passingStageBObservations({ finalFeatureState: unmeasured("docker inspect failed") }),
      passingStageA(),
    );
    const check = blocked.checks.find((c) => c.id === "deployment.final-state-recorded");
    assert.equal(check.outcome, OUTCOMES.BLOCKED);
  });

  it("40k. end to end: enabled success + disabled kill-switch aggregate to PASS", async () => {
    const files = seedRun();

    // ── Phase 1: generic ENABLED. The success case seals that fact. ────────
    const enabledWorld = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const success = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/success.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
        ...WORKER_ENV,
      }),
      { runReadOnly: enabledWorld.runReadOnly, fetch: enabledWorld.fetch, files },
    );
    assert.equal(success.code, 0, `${success.out}\n${success.err}`);
    const successRecord = JSON.parse(files.get("/tmp/success.json"));
    assert.equal(successRecord.featureState.state, "enabled");
    assert.equal(successRecord.featureState.ytdlpEnabledRaw, "true");

    // ── Phase 2: the operator disables. The kill-switch case seals THAT. ───
    const disabledWorld = makeFakeWorld({
      ytdlpEnabled: null,
      sites: { ytdlp: false, ytdlpInstalled: true, ytdlpEnabled: false, ffmpeg: true },
    });
    const killSwitch = await runCli(
      ["--stage", "B", "--case", "kill-switch", ...LIVE_ARGS, "--evidence", "/tmp/kill.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: disabledWorld.runReadOnly, fetch: disabledWorld.fetch, files },
    );
    assert.equal(killSwitch.code, 0, `${killSwitch.out}\n${killSwitch.err}`);
    const killRecord = JSON.parse(files.get("/tmp/kill.json"));
    assert.equal(killRecord.featureState.state, "disabled");

    // ── Phase 3: aggregate while generic is still DISABLED. ────────────────
    //
    // Stage A shares the SAME run key and file store as the cases — every
    // artifact in one acceptance must join one run — and it grades the disabled
    // deployment, which is the state Stage A requires.
    const stageA = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/stage-a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: disabledWorld.runReadOnly, fetch: disabledWorld.fetch, files },
    );
    assert.equal(stageA.code, 0, `${stageA.out}\n${stageA.err}`);

    const aggregate = await runCli(
      [
        "--stage", "B", "--aggregate", ...LIVE_ARGS,
        "--stage-a", "/tmp/stage-a.json",
        "--case-evidence", "/tmp/success.json",
        "--case-evidence", "/tmp/kill.json",
        "--evidence", "/tmp/stage-b.json",
      ],
      LIVE_ENV(),
      { runReadOnly: disabledWorld.runReadOnly, fetch: disabledWorld.fetch, files },
    );
    // Not every case ran, so the run as a whole is not PASS — but the two
    // state-dependent claims must be graded from the sealed artifacts, and the
    // currently-disabled deployment must not have unmade the enabled phase.
    const record = JSON.parse(files.get("/tmp/stage-b.json"));
    const byId = Object.fromEntries(record.checks.map((c) => [c.id, c.outcome]));
    assert.equal(byId["capability.generic-usable"], "PASS", aggregate.out);
    assert.equal(byId["config.ytdlp-enabled"], "PASS");
    assert.equal(byId["killswitch.disabled-state-proven"], "PASS");
    assert.equal(record.stateSequence.enabledPhase.state, "enabled");
    assert.equal(record.stateSequence.disabledPhase.state, "disabled");
    assert.equal(record.stateSequence.finalState.state, "disabled");
  });
});

// ── CORRECTION-04 §10-§16: byte-limit causal binding ───────────────────────

describe("byte-limit causal binding", () => {
  const byteLimitEnv = (extra = {}) =>
    LIVE_ENV({
      VIDEOFETCH_ACCEPT_BYTELIMIT_URL: "https://media.invalid/generic/bytelimit",
      VIDEOFETCH_ACCEPT_BYTELIMIT_EVIDENCE_URL: "https://media.invalid/byte-evidence",
      ...extra,
    });

  async function runByteLimit(worldOptions = {}, envExtra = {}) {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
      ...worldOptions,
    });
    const files = seedRun();
    return runCli(
      ["--stage", "B", "--case", "byte-limit", ...LIVE_ARGS, "--evidence", "/tmp/bl.json"],
      byteLimitEnv(envExtra),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );
  }

  it("41. a correlated over-limit transfer produces a PASS candidate", async () => {
    const run = await runByteLimit();
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const payload = JSON.parse(run.files.get("/tmp/bl.json")).payload.byteLimitCase;
    assert.match(payload.caseId, /^[0-9a-f]{32}$/);
    assert.equal(payload.mediaRequestCount, 1);
    assert.equal(payload.effectiveMaxFileSizeBytes, 500 * 1024 * 1024);
    assert.equal(payload.limitSource, "default");
    assert.equal(payload.exceededLimit, true);
    assert.equal(payload.outcome, "TOO_LARGE");
    assert.equal(payload.beganProcessing, false);
    assert.equal(payload.uploaded, false);

    const stageB = evaluateStageB(
      passingStageBObservations({ byteLimitCase: measured(payload) }),
      passingStageA(),
    );
    const check = stageB.checks.find((c) => c.id === "limit.actual-byte-guard");
    assert.equal(check.outcome, OUTCOMES.PASS);
  });

  it("41b. a FOREIGN case id in the fixture evidence BLOCKS", async () => {
    const run = await runByteLimit({ byteLimitFixture: { caseIdOverride: "1".repeat(32) } });
    assert.equal(run.code, 2);
    assert.match(run.err, /evidence for a different case/);
    assert.equal(run.files.has("/tmp/bl.json"), false, "no record is written");
  });

  it("41c. stale/unassociated fixture evidence BLOCKS", async () => {
    const run = await runByteLimit({ byteLimitFixture: { notFound: true } });
    assert.equal(run.code, 2);
    assert.match(run.err, /no media-request evidence for this case/);
  });

  it("41d. an ambiguous media-request count BLOCKS", async () => {
    const run = await runByteLimit({ byteLimitFixture: { mediaRequestCount: 3 } });
    assert.equal(run.code, 2);
    assert.match(run.err, /attributed 3 media requests/);
  });

  it("41e. bytes at or below the deployed limit are NOT a pass", async () => {
    for (const bytesServed of [500 * 1024 * 1024, 400 * 1024 * 1024]) {
      const run = await runByteLimit({ byteLimitFixture: { bytesServed } });
      assert.equal(run.code, 2, `${bytesServed}`);
      assert.match(run.err, /never crossed the deployed threshold/);
    }
  });

  it("41f. a deployed MAX_FILE_SIZE override is what the case measures", async () => {
    // 600 MB served, but the deployment raised the limit to 1 GiB: the transfer
    // did NOT cross the threshold, and the default would have said it did.
    const raised = await runByteLimit({
      maxFileSize: String(1024 * 1024 * 1024),
      byteLimitFixture: { bytesServed: 600_000_000 },
    });
    assert.equal(raised.code, 2);
    assert.match(raised.err, /1073741824/);

    // Lowered to 1 MiB: a 2 MiB transfer now crosses it, where the default
    // would have said it did not.
    const lowered = await runByteLimit({
      maxFileSize: String(1024 * 1024),
      byteLimitFixture: { bytesServed: 2 * 1024 * 1024 },
    });
    assert.equal(lowered.code, 0, `${lowered.out}\n${lowered.err}`);
    const payload = JSON.parse(lowered.files.get("/tmp/bl.json")).payload.byteLimitCase;
    assert.equal(payload.effectiveMaxFileSizeBytes, 1024 * 1024);
    assert.equal(payload.limitSource, "deployment");
  });

  it("41g. a declared Content-Length on the actual media GET BLOCKS", async () => {
    const run = await runByteLimit({ byteLimitFixture: { contentLengthPresent: true } });
    assert.equal(run.code, 2);
    assert.match(run.err, /--max-filesize could have/);
  });

  it("41h. the evaluator refuses evidence that omits the comparison", () => {
    for (const overrides of [
      { bytesServed: 400 * 1024 * 1024, exceededLimit: false },
      { effectiveMaxFileSizeBytes: 0 },
      { mediaRequestCount: 2 },
      { caseId: "" },
    ]) {
      const result = evaluateStageB(
        passingStageBObservations({ byteLimitCase: measured(byteLimitEvidence(overrides)) }),
        passingStageA(),
      );
      const check = result.checks.find((c) => c.id === "limit.actual-byte-guard");
      assert.notEqual(check.outcome, OUTCOMES.PASS, JSON.stringify(overrides));
    }
  });

  it("41i. the deployed limit is parsed by the Worker's own grammar", () => {
    assert.deepEqual(parseMaxFileSize(undefined), {
      measured: true,
      bytes: DEFAULT_MAX_FILE_SIZE_BYTES,
      source: "default",
    });
    assert.deepEqual(parseMaxFileSize("  "), {
      measured: true,
      bytes: DEFAULT_MAX_FILE_SIZE_BYTES,
      source: "default",
    });
    assert.deepEqual(parseMaxFileSize("1048576"), {
      measured: true,
      bytes: 1048576,
      source: "deployment",
    });
    // Out of grammar: the Worker could not have started, so nothing is assumed.
    for (const raw of ["0", "-1", "12.5", "500MB", "1".repeat(18)]) {
      assert.equal(parseMaxFileSize(raw).measured, false, raw);
    }
  });
});

// ── CORRECTION-04 §17-§21: the deny-class vocabulary is closed ─────────────

describe("egress deny-class vocabulary", () => {
  it("42. the enum is exactly the deployed policy's deny rules", () => {
    assert.deepEqual([...DENY_CLASSES].sort(), ["deny-v4", "deny-v4-broadcast", "deny-v6"]);
  });

  it("42b. every real deny rule is accepted", () => {
    for (const name of ["deny-v4", "deny-v6", "deny-v4-broadcast"]) {
      const parsed = parseDenyClass(name);
      assert.equal(parsed.ok, true, name);
      assert.equal(parsed.denyClass, name);
    }
  });

  it("42c. an ACCEPT rule can never be selected as the denial counter", () => {
    for (const name of ["public-http", "established", "designated-dns-udp", "designated-dns-tcp"]) {
      const parsed = parseDenyClass(name);
      assert.equal(parsed.ok, false, name);
      assert.match(parsed.reason, /ACCEPT rule/);
    }
  });

  it("42d. the catch-all drop counter cannot be selected either", () => {
    const parsed = parseDenyClass("fallthrough-drop");
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /attributes nothing to a rule/);
  });

  it("42e. an unknown comment is refused", () => {
    for (const name of ["", "deny-anything", "DENY-V4", "deny-v4 ", "../deny-v4"]) {
      assert.equal(parseDenyClass(name).ok, false, JSON.stringify(name));
    }
  });

  it("42f. the CLI refuses a non-deny class BEFORE any live operation", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    for (const name of ["public-http", "established", "fallthrough-drop", "invented"]) {
      const run = await runCli(
        [
          "--stage", "B", "--case", "safe-egress", ...LIVE_ARGS,
          "--egress-deny-class", name,
          "--evidence", "/tmp/e.json",
        ],
        LIVE_ENV({ VIDEOFETCH_ACCEPT_EGRESS_REDIRECT_URL: "https://media.invalid/generic/egress" }),
        { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
      );
      assert.equal(run.code, 3, `${name}: ${run.out}${run.err}`);
      assert.match(run.err, /usage error: --egress-deny-class/);
      // Refused at PARSE time: no live acceptance banner, no commands run.
      assert.doesNotMatch(run.out, /LIVE ACCEPTANCE/);
      assert.equal(world.calls.commands.length, 0);
      assert.equal(world.calls.fetches.length, 0);
    }
  });

  it("42g. a moving ACCEPT counter cannot produce a PASS", () => {
    // The `public-http` accept counter moves on every ordinary media fetch. It
    // is not reachable as a deny class at all — which is the point — and the
    // deny counter it cannot substitute for stays flat.
    const listing = {
      nftables: [
        { rule: { comment: "deny-v4", expr: [{ counter: { packets: 7 } }, { reject: null }] } },
        { rule: { comment: "public-http", expr: [{ counter: { packets: 900 } }, { accept: null }] } },
      ],
    };
    const after = {
      nftables: [
        { rule: { comment: "deny-v4", expr: [{ counter: { packets: 7 } }, { reject: null }] } },
        { rule: { comment: "public-http", expr: [{ counter: { packets: 1200 } }, { accept: null }] } },
      ],
    };
    const attribution = attributeDenial({
      before: readDenyCounter(listing, "deny-v4"),
      after: readDenyCounter(after, "deny-v4"),
      requestDenied: true,
    });
    assert.equal(attribution.attributedToBoundary, false);
    assert.equal(parseDenyClass("public-http").ok, false);
  });
});

// ── CORRECTION-04 §22-§25: host process parsing fails closed ───────────────

describe("host process parsing", () => {
  const captured = { pgid: 200, pid: 200, comm: "python3" };

  it("43. a well-formed listing is measured", () => {
    const parsed = parseHostProcessList("100 1 100 node\n200 100 200 python3\n\n");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rows.length, 2);
  });

  it("43b. an absent captured group yields an empty survivor set", () => {
    const parsed = parseHostProcessList("100 1 100 node\n");
    assert.deepEqual(parsed.rows.filter((r) => r.pgid === 200), []);
    assert.equal(evaluateGroupTermination(captured, []).terminated, true);
  });

  it("43c. a real survivor of the captured group is returned", () => {
    const parsed = parseHostProcessList("200 1 200 python3\n");
    const survivors = parsed.rows.filter((r) => r.pgid === 200);
    assert.equal(survivors.length, 1);
    assert.equal(evaluateGroupTermination(captured, survivors).terminated, false);
  });

  it("43d. an unreadable NUMERIC PREFIX makes the WHOLE listing unmeasured", () => {
    // The listing answers exactly one question — does the captured PGID still
    // have members? — so the ids are what must parse. Each of these lines could
    // be a member of the captured group and cannot be shown not to be.
    for (const stdout of [
      "100 1 100\n", // no comm column at all: only two ids and a stray
      "1x0 1 100 node\n", // non-numeric pid
      "100 x 100 node\n", // non-numeric ppid
      "100 1 abc node\n", // non-numeric pgid
      "  node 1 100 python3\n", // ids missing entirely
      `${"9".repeat(20)} 1 100 node\n`, // an id outside the safe integer range
    ]) {
      const parsed = parseHostProcessList(stdout);
      assert.equal(parsed.ok, false, JSON.stringify(stdout));
      assert.equal(parsed.rows, undefined);
      assert.match(parsed.reason, /line 1 of the host process listing/);
      assert.doesNotMatch(parsed.reason, /node|python3/, "the refusal must not quote the row");
    }
  });

  it("43d2. a legal `comm` containing spaces is parsed, not refused", () => {
    // procps derives `comm` from the executable name and permits spaces. One
    // unrelated process with such a name must not make the host unreadable.
    const parsed = parseHostProcessList(
      "100 1 100 node\n300 1 300 some process\n400 1 400 (sd-pam)\n",
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rows.length, 3);
    assert.equal(parsed.rows[0].comm, "node");
    // Not a plain basename -> kept as a row, reported under the fixed token.
    assert.equal(parsed.rows[1].comm, UNCLASSIFIED_COMM);
    assert.equal(parsed.rows[2].comm, UNCLASSIFIED_COMM);
    assert.deepEqual(parsed.rows[1], { pid: 300, ppid: 1, pgid: 300, comm: UNCLASSIFIED_COMM });
  });

  it("43e. THE ATTACK (retained): the only survivor is unusual and must not become []", async () => {
    // The CORRECTION-04 regression, extended. One process survives the captured
    // group under a name the harness will not copy verbatim. Dropping it would
    // turn a leak into a clean termination PASS.
    //
    // CORRECTION-04 answered this by refusing the whole listing. CORRECTION-05
    // answers it better: the SURVIVOR IS RETURNED, under a fixed token, so the
    // termination proof sees it — and still cannot pass.
    const stdout = "100 1 100 node\n200 100 200 python3 --some-argv\n";
    const parsed = parseHostProcessList(stdout);
    assert.equal(parsed.ok, true);

    const survivors = parsed.rows.filter((row) => row.pgid === 200);
    assert.equal(survivors.length, 1, "the survivor must not disappear");
    assert.notDeepEqual(survivors, [], "and must never become an empty set");
    assert.equal(survivors[0].comm, UNCLASSIFIED_COMM);

    const observers = makeSystemObservers({
      runReadOnly: async (file) =>
        file === "ps" ? { exitCode: 0, stdout, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" },
    });
    const observed = await observers.processGroupMembers(200);
    assert.equal(observed.measured, true);
    assert.equal(observed.value.length, 1);
    assert.doesNotMatch(JSON.stringify(observed), /some-argv/);

    // A survivor the harness cannot classify is ambiguous, never terminated.
    const termination = evaluateGroupTermination(captured, observed.value);
    assert.equal(termination.measured, false, "an unclassifiable survivor cannot be measured away");
    assert.equal(termination.ambiguous, true);
    assert.notEqual(termination.terminated, true);

    const stageB = evaluateStageB(
      passingStageBObservations({
        cancellation: measured(
          cancellationEvidence({ groupMembersMeasured: true, groupSurvivors: observed.value }),
        ),
      }),
      passingStageA(),
    );
    const check = stageB.checks.find((c) => c.id === "cancel.processes-gone");
    assert.equal(check.outcome, OUTCOMES.BLOCKED);
  });

  it("43f. a malformed listing BLOCKS termination rather than passing it", () => {
    for (const key of ["cancellation", "shutdownCase"]) {
      const evidence =
        key === "cancellation"
          ? cancellationEvidence({ groupMembersMeasured: false, groupSurvivors: [] })
          : shutdownEvidence({ groupMembersMeasured: false, groupSurvivors: [] });
      const result = evaluateStageB(
        passingStageBObservations({ [key]: measured(evidence) }),
        passingStageA(),
      );
      const id = key === "cancellation" ? "cancel.processes-gone" : "shutdown.group-terminated";
      const check = result.checks.find((c) => c.id === id);
      assert.equal(check.outcome, OUTCOMES.BLOCKED, id);
    }
  });

  it("43g. an unrelated legal `comm` cannot block the target-group query", async () => {
    const observers = makeSystemObservers({
      runReadOnly: async (file) =>
        file === "ps"
          ? {
              exitCode: 0,
              // An unrelated process with a spaced/odd name. Under the previous
              // parser this single line made the whole host unreadable and every
              // termination check BLOCKED, for a reason with nothing to do with
              // the captured group.
              stdout: "1 0 1 systemd\n100 1 100 node\n300 1 300 some odd process\n",
              stderr: "",
            }
          : { exitCode: 0, stdout: "", stderr: "" },
    });
    const observed = await observers.processGroupMembers(200);
    assert.equal(observed.measured, true, "an unrelated oddity is not an unanswerable question");
    assert.deepEqual(observed.value, [], "and group 200 genuinely has no members");
    assert.equal(evaluateGroupTermination(captured, observed.value).terminated, true);
  });

  it("43h. an unreadable row still blocks the target-group query", async () => {
    const observers = makeSystemObservers({
      runReadOnly: async (file) =>
        file === "ps"
          ? { exitCode: 0, stdout: "1 0 1 systemd\n100 1 100 node\nnot-a-process-row\n", stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" },
    });
    const observed = await observers.processGroupMembers(200);
    assert.equal(observed.measured, false, "a row that cannot be assigned to a group blocks");
  });
});

// ── CORRECTION-04 §26: run-key permissions fail closed on every path ───────

describe("run-key permission hardening", () => {
  const KEY_BODY = JSON.stringify({ runId: "a1b2c3d4e5f60718", key: "c".repeat(64) });
  const enoent = () => {
    const error = new Error("no such file");
    error.code = "ENOENT";
    return error;
  };

  const adapter = ({ mode, statThrows } = {}) => ({
    readFile: async () => KEY_BODY,
    writeFile: async () => {},
    mkdir: async () => {},
    chmod: async () => {},
    stat: async () => {
      if (statThrows) throw statThrows;
      return { mode };
    },
  });

  it("44. a NEW key is minted 0600 when none exists", async () => {
    const written = new Map();
    const created = await loadOrCreateRun("/tmp/new.json", {
      readFile: async () => { throw enoent(); },
      writeFile: async (path, body, options) => written.set(path, options?.mode),
      mkdir: async () => {},
      chmod: async (path, mode) => written.set(path, mode),
      stat: async () => { throw enoent(); },
    });
    assert.equal(created.created, true);
    assert.equal(written.get("/tmp/new.json"), 0o600);
  });

  it("44b. an existing SAFE key is resumed", async () => {
    const resumed = await loadOrCreateRun("/tmp/run.json", adapter({ mode: 0o600 }));
    assert.equal(resumed.created, false);
    assert.equal(resumed.key, "c".repeat(64));
    assert.equal((await loadRun("/tmp/run.json", adapter({ mode: 0o600 }))).key, "c".repeat(64));
  });

  it("44c. an existing UNSAFE key is refused on BOTH paths", async () => {
    for (const mode of [0o644, 0o660, 0o604, 0o777]) {
      const resumed = await loadOrCreateRun("/tmp/run.json", adapter({ mode }));
      assert.match(resumed.error, /must not be group- or world-accessible/, `resume ${mode.toString(8)}`);
      assert.equal(resumed.key, undefined, "no key is handed back");

      const loaded = await loadRun("/tmp/run.json", adapter({ mode }));
      assert.match(loaded.error, /must not be group- or world-accessible/, `load ${mode.toString(8)}`);
    }
  });

  it("44d. a permission measurement FAILURE fails closed", async () => {
    const denied = new Error("permission denied");
    denied.code = "EACCES";
    for (const path of [loadOrCreateRun, loadRun]) {
      const result = await path("/tmp/run.json", adapter({ statThrows: denied }));
      assert.match(result.error, /could not be measured/);
      assert.equal(result.key, undefined);
    }
    // A stat that returns no usable mode is equally unmeasured.
    const noMode = await loadRun("/tmp/run.json", adapter({ mode: undefined }));
    assert.match(noMode.error, /no file mode/);
  });

  it("44e. Stage A refuses to resume an insecure key", async () => {
    const world = makeFakeWorld({});
    const files = seedRun();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/sa.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      {
        runReadOnly: world.runReadOnly,
        fetch: world.fetch,
        files,
        stat: async () => ({ mode: 0o644 }),
      },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /must not be group- or world-accessible/);
    assert.doesNotMatch(`${run.out}${run.err}`, /c{16}/, "the key is never printed");
  });

  it("44f. no run-key path ever prints the key", async () => {
    const results = [
      await loadOrCreateRun("/tmp/run.json", adapter({ mode: 0o644 })),
      await loadRun("/tmp/run.json", adapter({ mode: 0o644 })),
      await loadRun("/tmp/run.json", adapter({ statThrows: enoent() })),
    ];
    for (const result of results) {
      assert.doesNotMatch(JSON.stringify(result ?? null), /c{32}/);
    }
  });
});

// ── CORRECTION-04 §27-§28: the accepted ambiguity policy is unchanged ──────

describe("ambiguity policy preserved", () => {
  it("45. a sampler error still BLOCKS; a close-straddle still only counts", () => {
    const errored = aggregateDownloadWindow(
      windowOf([acquisitionSample()], { samplerErrors: ["docker top failed"] }),
    );
    assert.equal(errored.usable, false);
    assert.match(errored.reason, /unobserved interval/);

    const straddled = aggregateDownloadWindow(
      windowOf([acquisitionSample()], { ambiguousSamples: [{ startedAt: 5, finishedAt: 20, closedAt: 10 }] }),
    );
    assert.equal(straddled.usable, true);
    assert.equal(straddled.ambiguousSamples.length, 1);
  });

  it("45b. the module's own comment matches the implemented policy", async () => {
    const source = await readFile(
      new URL("../deploy/acceptance/ytdlp-generic/lib/download-window.mjs", import.meta.url),
      "utf8",
    );
    // The stale claim said a straddling sample made the window unusable, which
    // the implementation deliberately does not do.
    assert.doesNotMatch(source, /window becomes unusable/);
    assert.match(source, /DISCARDED AND COUNTED/);
  });
});

// ── CORRECTION-05 §4-§7: the harness never retrieves a secret value ────────

describe("narrow environment observation", () => {
  const secretValues = Object.values(SECRET_SENTINELS);

  /** Asserts no secret sentinel appears anywhere in a JSON-serializable thing. */
  function assertNoSecret(subject, what) {
    const text = typeof subject === "string" ? subject : JSON.stringify(subject ?? null);
    for (const secret of secretValues) {
      assert.equal(text.includes(secret), false, `${what} must not contain a secret value`);
    }
  }

  it("46. the three probes are the only environment access, and are exact", () => {
    // Each probe names its own variable inside a compile-time constant, so the
    // caller cannot redirect the read.
    assert.match(ENV_NAMES_PROBE_ARGV[2], /sorted\(os\.environ\)/);
    assert.match(YTDLP_ENABLED_PROBE_ARGV[2], /"YTDLP_ENABLED"/);
    assert.match(MAX_FILE_SIZE_PROBE_ARGV[2], /"MAX_FILE_SIZE"/);
    // No probe reaches a VALUE it was not asked for. Iterating `os.environ`
    // yields keys, which is exactly what the name probe wants; what must not
    // appear is any construct that materializes values.
    for (const probe of [ENV_NAMES_PROBE_ARGV, YTDLP_ENABLED_PROBE_ARGV, MAX_FILE_SIZE_PROBE_ARGV]) {
      assert.doesNotMatch(probe[2], /\.values\(\)|\.items\(\)|dict\(os\.environ\)|print\(os\.environ\)/);
      // And nothing joins a name to a value.
      assert.doesNotMatch(probe[2], /"="|'='/);
    }
    // The two value probes read exactly one variable each.
    for (const probe of [YTDLP_ENABLED_PROBE_ARGV, MAX_FILE_SIZE_PROBE_ARGV]) {
      assert.equal((probe[2].match(/os\.environ/g) ?? []).length, 1);
    }
  });

  it("46b. the full-environment dump is structurally unrepresentable", () => {
    for (const format of [
      "{{range .Config.Env}}{{println .}}{{end}}",
      "{{.Config.Env}}",
      "{{json .Config}}",
      "{{.}}",
    ]) {
      assert.equal(
        isReadOnlyCommand("docker", ["inspect", "--format", format, "videofetch-worker"]),
        false,
        format,
      );
    }
    assert.equal(isReadOnlyCommand("docker", ["inspect", "videofetch-worker"]), false);
  });

  it("46c. no probe can be redirected to another variable", () => {
    for (const source of [
      'import os;v=os.environ.get("WORKER_CONTROL_SECRET");print("<UNSET>" if v is None else "SET:"+v)',
      "import os;print(os.environ)",
      'import os;print(os.environ.get("MAX_FILE_SIZE","<UNSET>"))',
      "import os;print(dict(os.environ))",
    ]) {
      assert.equal(
        isReadOnlyCommand("docker", ["exec", "videofetch-worker", "/usr/bin/python3", "-c", source]),
        false,
        source.slice(0, 48),
      );
    }
  });

  it("47. a secret-bearing container never returns a secret value", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      maxFileSize: "123456",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
      extraEnvironment: { SOME_OTHER_SECRET: SECRET_SENTINELS.access },
    });
    // The fake container genuinely holds the secrets — otherwise this proves
    // nothing.
    assert.equal(world.workerEnvironment.WORKER_CONTROL_SECRET, SECRET_SENTINELS.workerControl);

    const observers = makeSystemObservers({ runReadOnly: world.runReadOnly });

    const names = await observers.environmentNames();
    assert.equal(names.measured, true);
    // The NAME is expected; the value never is.
    assert.ok(names.value.includes("WORKER_CONTROL_SECRET"), "names are still observable");
    assert.equal(names.value.some((n) => n.includes("=")), false, "no NAME=value pair");
    assertNoSecret(names, "the environment-name observation");

    const enabled = await observers.ytdlpEnabledRaw();
    assert.deepEqual(enabled, { measured: true, value: "true" });

    const limit = await observers.effectiveMaxFileSize();
    assert.deepEqual(limit, { measured: true, value: { bytes: 123456, source: "deployment" } });

    // And nothing secret was ever in a command, a result, or an error.
    assertNoSecret(world.calls.commands, "the issued commands");
    assertNoSecret([names, enabled, limit], "the observer results");
  });

  it("47b. a full live run never carries a secret value anywhere", async () => {
    const world = makeFakeWorld({
      extraEnvironment: { ANOTHER_SECRET: SECRET_SENTINELS.workerControl },
    });
    const files = seedRun(new Map());
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    assertNoSecret(run.out, "stdout");
    assertNoSecret(run.err, "stderr");
    assertNoSecret(world.calls.commands, "the issued commands");
    assertNoSecret(files.get("/tmp/a.json"), "the evidence record");

    // The names ARE still recorded — the check that forbids R2 credentials
    // needs them — so this is a narrowing, not a loss of evidence.
    const record = JSON.parse(files.get("/tmp/a.json"));
    assert.ok(record.workerEnvironment, "environment evidence is still produced");
  });

  it("47c. the probe decoder distinguishes UNSET from a literal <UNSET>", () => {
    assert.deepEqual(decodeEnvProbe("<UNSET>\n"), { measured: true, present: false, value: null });
    assert.deepEqual(decodeEnvProbe("SET:true\n"), { measured: true, present: true, value: "true" });
    // A variable literally set to the sentinel is NOT read as absent.
    assert.deepEqual(decodeEnvProbe("SET:<UNSET>\n"), {
      measured: true,
      present: true,
      value: "<UNSET>",
    });
    // A value containing a newline survives, because the prefix is stripped
    // from the whole output rather than from a first line.
    assert.deepEqual(decodeEnvProbe("SET:a\nb\n"), { measured: true, present: true, value: "a\nb" });
    assert.equal(decodeEnvProbe("something else\n").measured, false);
    assert.equal(decodeEnvProbe("").measured, false);
  });

  it("47d. a value-bearing line from the name probe is a measurement failure", async () => {
    const observers = makeSystemObservers({
      runReadOnly: async (file, argv) =>
        file === "docker" && argv[0] === "exec"
          ? { exitCode: 0, stdout: `WORKER_CONTROL_SECRET=${SECRET_SENTINELS.workerControl}\n`, stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" },
    });
    const names = await observers.environmentNames();
    assert.equal(names.measured, false, "a value-bearing line is never parsed into names");
    assertNoSecret(names, "the refusal");
  });
});

// ── CORRECTION-05 §8-§11: image continuity across every Stage-B case ───────

describe("image continuity", () => {
  const CASE_ENV = (extra = {}) =>
    LIVE_ENV({
      VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
      VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
      ...WORKER_ENV,
      ...extra,
    });

  const ENABLED = {
    ytdlpEnabled: "true",
    sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
  };

  it("48. an ordinary case on one image seals continuity evidence", async () => {
    const world = makeFakeWorld(ENABLED);
    const run = await runCli(
      ["--stage", "B", "--case", "cancellation", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      CASE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const record = JSON.parse(run.files.get("/tmp/c.json"));
    assert.deepEqual(record.imageContinuity, {
      before: IMAGE_ID,
      after: IMAGE_ID,
      taggedImageId: IMAGE_ID,
      same: true,
    });
    assert.equal(record.runningImageId, IMAGE_ID);
  });

  it("48b. an image change DURING a case BLOCKS and writes no evidence", async () => {
    const world = makeFakeWorld({ ...ENABLED, imageDriftsAfterReads: 1 });
    const run = await runCli(
      ["--stage", "B", "--case", "cancellation", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      CASE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /DEPLOYED IMAGE CHANGED DURING CASE 'cancellation'/);
    assert.equal(run.files.has("/tmp/c.json"), false, "no record may combine two images");
  });

  it("48c. an unmeasurable post-case image BLOCKS", async () => {
    let imageReads = 0;
    const world = makeFakeWorld(ENABLED);
    const run = await runCli(
      ["--stage", "B", "--case", "cancellation", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      CASE_ENV(),
      {
        runReadOnly: async (file, argv) => {
          if (file === "docker" && argv[0] === "image" && argv[1] === "inspect") {
            imageReads += 1;
            // The pre-case resolution succeeds; the post-case one cannot.
            if (imageReads > 1) return { exitCode: 1, stdout: "", stderr: "no such image" };
          }
          return world.runReadOnly(file, argv);
        },
        fetch: world.fetch,
        files: seedRun(),
      },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /could not be re-identified after the case/);
    assert.equal(run.files.has("/tmp/c.json"), false);
  });

  it("48d. a running image that is not the authorized SHA-tagged object BLOCKS", async () => {
    const world = makeFakeWorld({ ...ENABLED, runningImage: `sha256:${"c".repeat(64)}` });
    const run = await runCli(
      ["--stage", "B", "--case", "cancellation", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      CASE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /not the image tagged with the authorized source SHA/);
    assert.equal(run.files.has("/tmp/c.json"), false);
  });

  it("48e. the aggregate can never accept a record whose image drifted", () => {
    const binding = { expectedSha: SHA, runningImageId: IMAGE_ID };
    const other = `sha256:${"d".repeat(64)}`;
    for (const continuity of [
      { before: IMAGE_ID, after: other, taggedImageId: IMAGE_ID, same: true },
      // `same` is recomputed from the ids, never believed.
      { before: IMAGE_ID, after: other, taggedImageId: other, same: true },
      { before: IMAGE_ID, after: IMAGE_ID, taggedImageId: other, same: true },
      { before: IMAGE_ID, after: IMAGE_ID, taggedImageId: IMAGE_ID, same: false },
      { before: IMAGE_ID, after: IMAGE_ID, taggedImageId: IMAGE_ID },
      { before: IMAGE_ID },
      { before: "not-an-image-id", after: IMAGE_ID, taggedImageId: IMAGE_ID, same: true },
      null,
      undefined,
    ]) {
      // `buildCaseRecord` directly, so an ABSENT continuity object is genuinely
      // absent rather than filled in by the test helper's default.
      const phase = featureState("enabled");
      const record = buildCaseRecord({
        caseName: "cancellation",
        binding,
        payload: { cancellation: cancellationEvidence({ postSample: [] }) },
        featureState: phase,
        featureContinuity: { before: phase, after: phase, sameRequiredState: true },
        imageContinuity: continuity,
      });
      const validated = validateCaseRecord(record, binding);
      assert.equal(validated.ok, false, JSON.stringify(continuity ?? null));
      assert.match(validated.reason, /image-continuity|different image/);
    }

    // And a record whose continuity disagrees with the id it binds to.
    const mismatched = caseRecord({
      caseName: "cancellation",
      binding,
      payload: { cancellation: cancellationEvidence({ postSample: [] }) },
      imageContinuity: { before: other, after: other, taggedImageId: other, same: true },
    });
    assert.match(
      validateCaseRecord(mismatched, binding).reason,
      /different image before the case than it binds to/,
    );
  });

  it("48f. continuity evidence is sealed and cannot be edited", () => {
    const KEY = "f".repeat(64);
    const sealed = sealRecord(
      caseRecord({
        caseName: "cancellation",
        binding: { expectedSha: SHA, runningImageId: IMAGE_ID },
        payload: { cancellation: cancellationEvidence({ postSample: [] }) },
        runId: "0123456789abcdef",
      }),
      KEY,
    );
    assert.equal(verifySeal(sealed, KEY).ok, true);
    sealed.imageContinuity.after = `sha256:${"9".repeat(64)}`;
    assert.equal(verifySeal(sealed, KEY).ok, false);
  });
});

// ── CORRECTION-05 §12-§15: the deterministic restart-recovery contract ─────

describe("restart recovery contract", () => {
  /**
   * A sampler that needs no Docker, so the only `{{.State.Pid}}` reads in the
   * shutdown test come from the restart watcher — which makes the simulated
   * operator restart land at an exactly known point.
   */
  const fakeSampler = {
    async sample() {
      return {
        sample: acquisitionSample(),
        workerPid: 100,
        ytdlpPid: 200,
        expectedNetns: "net:[4026532001]",
      };
    },
  };

  async function runShutdown(worldOptions = {}, deps = {}) {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
      // Runtime reads for a shutdown case: the pre-case snapshot brackets
      // (id 1, id 2), then the watcher's own coherence bracket (id 3, pid 1,
      // id 4). Read 5 is its first POLL, which is where the operator's restart
      // is placed — the watcher now polls the container INSTANCE, not the PID.
      restartAfterIdReads: 4,
      ...worldOptions,
    });
    const run = await runCli(
      ["--stage", "B", "--case", "shutdown", ...LIVE_ARGS, "--evidence", "/tmp/s.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        ...WORKER_ENV,
      }),
      {
        runReadOnly: world.runReadOnly,
        fetch: world.fetch,
        files: seedRun(),
        sampler: fakeSampler,
        // `sleep` is a no-op in these tests, so a wall-clock window would spin
        // for its full duration rather than waiting. Both windows are shrunk to
        // keep the FAILURE paths bounded; the success paths return immediately.
        shutdownWindowMs: 2000,
        recoveryWindowMs: 2000,
        ...deps,
      },
    );
    return { run, world };
  }

  it("49. the contract mirrors the Worker's own recover()", () => {
    assert.deepEqual(RESTART_RECOVERY, {
      status: "failed",
      errorCode: "PROCESSING_FAILED",
      safeErrorMessage: "Worker restarted before the job completed.",
    });
  });

  it("49b. a non-empty status is no longer sufficient", () => {
    // The exact predicate CORRECTION-05 removes: any non-empty string passed.
    for (const status of ["ready", "queued", "analyzing", "downloading", "processing", "uploading", "cancelled"]) {
      const result = evaluateStageB(
        passingStageBObservations({
          shutdownCase: measured(
            shutdownEvidence({
              recoveredStatus: status,
              recoveredErrorCode: null,
              recoveredSafeErrorMessage: null,
              lateReady: status === "ready",
            }),
          ),
        }),
        passingStageA(),
      );
      const check = result.checks.find((c) => c.id === "shutdown.job-recovered");
      assert.equal(check.outcome, OUTCOMES.FAIL, `${status} must not pass restart recovery`);
    }
  });

  it("49c. failed with the wrong errorCode or message FAILS", () => {
    for (const overrides of [
      { recoveredErrorCode: "TIMEOUT" },
      { recoveredErrorCode: null },
      // The generic PROCESSING_FAILED copy, not the restart sentence: this is
      // what every ordinary internal acquisition failure produces.
      { recoveredSafeErrorMessage: "We couldn't process this video. Try another format or source." },
      { recoveredSafeErrorMessage: null },
      { recoveredSafeErrorMessage: "worker restarted before the job completed." },
      { restartObserved: false },
      { lateReady: true },
    ]) {
      const result = evaluateStageB(
        passingStageBObservations({ shutdownCase: measured(shutdownEvidence(overrides)) }),
        passingStageA(),
      );
      const check = result.checks.find((c) => c.id === "shutdown.job-recovered");
      assert.equal(check.outcome, OUTCOMES.FAIL, JSON.stringify(overrides));
    }
  });

  it("49d. failed + PROCESSING_FAILED + the restart message PASSES", () => {
    const result = evaluateStageB(
      passingStageBObservations({ shutdownCase: measured(shutdownEvidence()) }),
      passingStageA(),
    );
    const check = result.checks.find((c) => c.id === "shutdown.job-recovered");
    assert.equal(check.outcome, OUTCOMES.PASS);
  });

  it("49e. recovery and PGID termination are independent assertions", () => {
    // A perfect durable row says nothing about whether the process died.
    const leaked = evaluateStageB(
      passingStageBObservations({
        shutdownCase: measured(
          shutdownEvidence({ groupSurvivors: [{ pid: 200, ppid: 1, pgid: 200, comm: "python3" }] }),
        ),
      }),
      passingStageA(),
    );
    assert.equal(
      leaked.checks.find((c) => c.id === "shutdown.group-terminated").outcome,
      OUTCOMES.FAIL,
    );
    assert.equal(
      leaked.checks.find((c) => c.id === "shutdown.job-recovered").outcome,
      OUTCOMES.PASS,
      "a dead-process failure must not be laundered by a good durable row",
    );

    // And a dead process group says nothing about the durable row.
    const badRow = evaluateStageB(
      passingStageBObservations({
        shutdownCase: measured(shutdownEvidence({ recoveredStatus: "ready", lateReady: true })),
      }),
      passingStageA(),
    );
    assert.equal(
      badRow.checks.find((c) => c.id === "shutdown.group-terminated").outcome,
      OUTCOMES.PASS,
    );
    assert.equal(
      badRow.checks.find((c) => c.id === "shutdown.job-recovered").outcome,
      OUTCOMES.FAIL,
    );
  });

  it("50. end to end: the restart is observed and the recovery contract measured", async () => {
    const { run } = await runShutdown();
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const payload = JSON.parse(run.files.get("/tmp/s.json")).payload.shutdownCase;

    assert.equal(payload.restartObserved, true);
    assert.notEqual(payload.previousContainerPid, payload.currentContainerPid);
    assert.equal(payload.recoveredStatus, "failed");
    assert.equal(payload.recoveredErrorCode, "PROCESSING_FAILED");
    assert.equal(payload.recoveredSafeErrorMessage, "Worker restarted before the job completed.");
    assert.equal(payload.lateReady, false);
    assert.ok(payload.recoveryPolls >= 1, "recovery is polled, not assumed");

    const result = evaluateStageB(
      passingStageBObservations({ shutdownCase: measured(payload) }),
      passingStageA(),
    );
    assert.equal(
      result.checks.find((c) => c.id === "shutdown.job-recovered").outcome,
      OUTCOMES.PASS,
    );
  });

  it("50b. the image must be identical across the restart", async () => {
    // The container PID changes — that is expected. The IMAGE must not.
    const { run } = await runShutdown();
    const record = JSON.parse(run.files.get("/tmp/s.json"));
    assert.equal(record.imageContinuity.before, IMAGE_ID);
    assert.equal(record.imageContinuity.after, IMAGE_ID);
    assert.equal(record.imageContinuity.same, true);
    // Container identity is deliberately NOT the binding.
    assert.notEqual(
      record.payload.shutdownCase.previousContainerPid,
      record.payload.shutdownCase.currentContainerPid,
    );
  });

  it("50c. a restart that lands on a DIFFERENT image BLOCKS", async () => {
    const { run } = await runShutdown({ imageAfterRestart: `sha256:${"b".repeat(64)}` });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /DEPLOYED IMAGE CHANGED DURING CASE 'shutdown'/);
    assert.equal(run.files.has("/tmp/s.json"), false);
  });

  it("50d. a Worker that never answers again BLOCKS rather than defaulting", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
      restartAfterIdReads: 4,
    });
    let restarted = false;
    const run = await runCli(
      ["--stage", "B", "--case", "shutdown", ...LIVE_ARGS, "--evidence", "/tmp/s.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        ...WORKER_ENV,
      }),
      {
        runReadOnly: async (file, argv) => {
          const result = await world.runReadOnly(file, argv);
          if (file === "docker" && argv.join(" ").includes(".State.Pid")) restarted = world.live.restarted;
          return result;
        },
        // After the restart, the job view never answers again.
        fetch: async (target, init) => {
          if (restarted && String(target).includes("/status")) throw new Error("connection refused");
          return world.fetch(target, init);
        },
        files: seedRun(),
        sampler: fakeSampler,
        shutdownWindowMs: 2000,
        recoveryWindowMs: 2000,
      },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /did not report a terminal state|restart-recovery contract/);
    assert.equal(run.files.has("/tmp/s.json"), false);
  });
});

// ── CORRECTION-05 §16-§18: direct-regression sampling gaps ────────────────

describe("direct regression sampling gaps", () => {
  const directEvidence = (overrides = {}) => ({
    jobId: "aa".repeat(16),
    status: "ready",
    extractor: "direct",
    processSamplingMeasured: true,
    samplesTaken: 5,
    samplingErrors: [],
    samplingErrorCount: 0,
    sampledBasenames: ["node"],
    ...overrides,
  });

  const verdictFor = (overrides) => {
    const result = evaluateStageB(
      passingStageBObservations({ directAfterEnable: measured(directEvidence(overrides)) }),
      passingStageA(),
    );
    return Object.fromEntries(
      result.checks
        .filter((c) => c.id.startsWith("direct."))
        .map((c) => [c.id, c.outcome]),
    );
  };

  it("51. five clean samples and no errors is a PASS candidate", () => {
    const verdicts = verdictFor({});
    assert.equal(verdicts["direct.process-sampling-available"], OUTCOMES.PASS);
    assert.equal(verdicts["direct.no-ytdlp-spawned"], OUTCOMES.PASS);
  });

  it("51b. zero samples and one error is BLOCKED", () => {
    const verdicts = verdictFor({
      processSamplingMeasured: false,
      samplesTaken: 0,
      samplingErrors: ["docker top exited 1"],
      samplingErrorCount: 1,
      sampledBasenames: [],
    });
    assert.equal(verdicts["direct.process-sampling-available"], OUTCOMES.BLOCKED);
    assert.equal(verdicts["direct.no-ytdlp-spawned"], OUTCOMES.BLOCKED);
  });

  it("51c. clean samples EITHER SIDE of an error are still BLOCKED", () => {
    // The exact defect: a later successful sample used to erase the gap.
    const verdicts = verdictFor({
      samplesTaken: 2,
      samplingErrors: ["docker top exited 1"],
      samplingErrorCount: 1,
    });
    assert.equal(verdicts["direct.process-sampling-available"], OUTCOMES.BLOCKED);
    assert.equal(verdicts["direct.no-ytdlp-spawned"], OUTCOMES.BLOCKED);

    const result = evaluateStageB(
      passingStageBObservations({
        directAfterEnable: measured(
          directEvidence({ samplesTaken: 2, samplingErrors: ["x"], samplingErrorCount: 1 }),
        ),
      }),
      passingStageA(),
    );
    const blocked = result.checks.find((c) => c.id === "direct.process-sampling-available");
    assert.match(blocked.detail, /unobserved interval/);
  });

  it("51d. many clean samples cannot outvote a single gap", () => {
    const verdicts = verdictFor({ samplesTaken: 500, samplingErrorCount: 1, samplingErrors: ["x"] });
    assert.equal(verdicts["direct.no-ytdlp-spawned"], OUTCOMES.BLOCKED);
  });

  it("51e. yt-dlp observed in a clean run still FAILS, not BLOCKS", () => {
    for (const basename of ["python3", "yt-dlp"]) {
      const verdicts = verdictFor({ sampledBasenames: ["node", basename] });
      assert.equal(verdicts["direct.process-sampling-available"], OUTCOMES.PASS);
      assert.equal(verdicts["direct.no-ytdlp-spawned"], OUTCOMES.FAIL, basename);
    }
  });

  it("51f. the gap travels into the sealed record and the aggregate", async () => {
    // A sampler that fails once, then succeeds — the shape that previously
    // erased its own evidence.
    let calls = 0;
    const flakySampler = {
      async sample() {
        calls += 1;
        if (calls === 1) throw new Error("docker top exited 1");
        return {
          sample: [{ pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[4026532001]" }],
          workerPid: 100,
          ytdlpPid: null,
          expectedNetns: "net:[4026532001]",
        };
      },
    };
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const run = await runCli(
      ["--stage", "B", "--case", "direct-regression", ...LIVE_ARGS, "--evidence", "/tmp/d.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun(), sampler: flakySampler },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);

    const payload = JSON.parse(run.files.get("/tmp/d.json")).payload.directAfterEnable;
    assert.equal(payload.samplingErrorCount, 1, "the failed attempt is kept");
    assert.ok(payload.samplesTaken > 0, "and the successful ones too");
    assert.match(payload.samplingErrors[0], /docker top exited 1/);

    const result = evaluateStageB(
      passingStageBObservations({ directAfterEnable: measured(payload) }),
      passingStageA(),
    );
    assert.equal(
      result.checks.find((c) => c.id === "direct.no-ytdlp-spawned").outcome,
      OUTCOMES.BLOCKED,
      "a run with a known gap cannot claim an absence",
    );
  });
});

// ── CORRECTION-05 §23: the run key is never silently replaced ─────────────

describe("run-key lifecycle", () => {
  const VALID = JSON.stringify({ runId: "a1b2c3d4e5f60718", key: "c".repeat(64) });
  const enoent = () => Object.assign(new Error("no such file"), { code: "ENOENT" });

  function adapter({ contents = VALID, mode = 0o600, statThrows, readThrows } = {}) {
    const written = [];
    return {
      written,
      deps: {
        readFile: async () => {
          if (readThrows) throw readThrows;
          return contents;
        },
        writeFile: async (path, body) => written.push([path, body]),
        mkdir: async () => {},
        chmod: async () => {},
        stat: async () => {
          if (statThrows) throw statThrows;
          return { mode };
        },
      },
    };
  }

  it("52. ENOENT is the ONLY condition that mints a new run", async () => {
    const { deps, written } = adapter({ statThrows: enoent() });
    const created = await loadOrCreateRun("/tmp/run.json", deps);
    assert.equal(created.created, true);
    assert.match(created.key, /^[0-9a-f]{64}$/);
    assert.equal(written.length, 1);
    // And `loadRun` reports the absence rather than inventing a run.
    assert.equal(await loadRun("/tmp/run.json", deps), null);
  });

  it("52b. a valid private file is resumed, never rewritten", async () => {
    const { deps, written } = adapter();
    const resumed = await loadOrCreateRun("/tmp/run.json", deps);
    assert.equal(resumed.created, false);
    assert.equal(resumed.key, "c".repeat(64));
    assert.equal(written.length, 0, "an intact key file is never written to");
  });

  it("52c. every damaged-file condition BLOCKS and preserves the file", async () => {
    const cases = [
      ["unsafe permissions", { mode: 0o644 }, /group- or world-accessible/],
      ["stat failure", { statThrows: Object.assign(new Error("denied"), { code: "EACCES" }) }, /could not be measured/],
      ["unreadable content", { readThrows: Object.assign(new Error("denied"), { code: "EACCES" }) }, /could not be read/],
      ["malformed JSON", { contents: "{not json" }, /not valid JSON/],
      ["truncated JSON", { contents: '{"runId":"abc"' }, /not valid JSON/],
      ["missing key", { contents: '{"runId":"a1b2c3d4e5f60718"}' }, /usable runId/],
      ["short key", { contents: '{"runId":"a1b2c3d4e5f60718","key":"aa"}' }, /usable runId/],
      ["non-hex key", { contents: `{"runId":"a1b2c3d4e5f60718","key":"${"z".repeat(64)}"}` }, /usable runId/],
      ["missing runId", { contents: `{"key":"${"c".repeat(64)}"}` }, /usable runId/],
      ["an empty file", { contents: "" }, /not valid JSON/],
    ];
    for (const [what, options, pattern] of cases) {
      const create = adapter(options);
      const created = await loadOrCreateRun("/tmp/run.json", create.deps);
      assert.match(created.error, pattern, `loadOrCreateRun: ${what}`);
      assert.equal(created.key, undefined, `${what}: no key is handed back`);
      assert.deepEqual(create.written, [], `${what}: the damaged file must not be overwritten`);

      const load = adapter(options);
      const loaded = await loadRun("/tmp/run.json", load.deps);
      assert.match(loaded.error, pattern, `loadRun: ${what}`);
      assert.notEqual(loaded, null, `${what}: damaged is not the same as absent`);
    }
  });

  it("52d. the CLI refuses to run against a damaged key, on both stages", async () => {
    for (const stage of [["--stage", "A"], ["--stage", "B", "--case", "kill-switch"]]) {
      const world = makeFakeWorld();
      const files = new Map([["./.vf-acceptance-run.json", "{not json"]]);
      const run = await runCli(
        [...stage, ...LIVE_ARGS, "--evidence", "/tmp/x.json"],
        LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
        { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
      );
      assert.equal(run.code, 2, `${stage.join(" ")}: ${run.out}${run.err}`);
      assert.match(run.err, /Refusing to overwrite it|not valid JSON/);
      assert.equal(files.get("./.vf-acceptance-run.json"), "{not json", "the file is untouched");
    }
  });

  it("52e. no run-key path ever discloses the key", async () => {
    const results = [
      await loadOrCreateRun("/tmp/run.json", adapter({ mode: 0o644 }).deps),
      await loadOrCreateRun("/tmp/run.json", adapter({ contents: "{}" }).deps),
      await loadRun("/tmp/run.json", adapter({ contents: "{}" }).deps),
    ];
    for (const result of results) assert.doesNotMatch(JSON.stringify(result ?? null), /c{32}/);
  });
});

// ── CORRECTION-05 §29: a dry run touches nothing at all ───────────────────

describe("dry-run inertness", () => {
  const COMMANDS = [
    ["--stage", "A"],
    ["--stage", "B", "--case", "success"],
    ["--stage", "B", "--case", "cancellation"],
    ["--stage", "B", "--case", "byte-limit"],
    ["--stage", "B", "--case", "shutdown"],
    ["--stage", "B", "--case", "safe-egress"],
    ["--stage", "B", "--case", "direct-regression"],
    ["--stage", "B", "--case", "kill-switch"],
    ["--stage", "B", "--aggregate"],
  ];

  it("53. every live-capable command refuses without BOTH gates", async () => {
    for (const command of COMMANDS) {
      for (const [argv, env] of [
        [command, {}],
        [[...command, "--live"], {}],
        [command, { [LIVE_ENV_NAME]: "1" }],
      ]) {
        const world = makeFakeWorld();
        const files = new Map();
        const run = await runCli(
          [...argv, "--base-url", "https://control.invalid", "--expected-sha", SHA],
          { VIDEOFETCH_ACCESS_SECRET: "an-actual-access-secret-value", ...env },
          { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
        );
        const label = `${argv.join(" ")} / env=${JSON.stringify(env)}`;
        assert.equal(run.code, 2, label);
        assert.match(run.out, /LIVE EXECUTION REFUSED/, label);
        assert.doesNotMatch(run.out, /LIVE ACCEPTANCE/, label);

        // Nothing was touched: no authentication, no run key, no Docker, no
        // network, no job.
        assert.equal(world.calls.logins, 0, `${label}: authenticated`);
        assert.equal(world.calls.commands.length, 0, `${label}: ran a command`);
        assert.equal(world.calls.fetches.length, 0, `${label}: made a request`);
        assert.equal(files.size, 0, `${label}: touched the filesystem`);
      }
    }
  });

  it("53b. fail-closed-runtime stays a non-live declaration", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "B", "--case", "fail-closed-runtime", "--live", "--base-url", "https://c.invalid", "--expected-sha", SHA],
      { [LIVE_ENV_NAME]: "1", VIDEOFETCH_ACCESS_SECRET: "s" },
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.equal(run.code, 3);
    assert.match(run.err, /not a live case command/);
    assert.equal(world.calls.commands.length, 0);
  });
});

// ── CORRECTION-06 §3-§5: a positive finding outranks an observation gap ───

describe("direct regression: finding vs coverage", () => {
  const directEvidence = (overrides = {}) => ({
    jobId: "aa".repeat(16),
    status: "ready",
    extractor: "direct",
    processSamplingMeasured: true,
    samplesTaken: 5,
    samplingErrors: [],
    samplingErrorCount: 0,
    sampledBasenames: ["node"],
    ...overrides,
  });

  const verdicts = (overrides) => {
    const result = evaluateStageB(
      passingStageBObservations({ directAfterEnable: measured(directEvidence(overrides)) }),
      passingStageA(),
    );
    return {
      summary: result.summary.verdict,
      ...Object.fromEntries(
        result.checks.filter((c) => c.id.startsWith("direct.")).map((c) => [c.id, c.outcome]),
      ),
    };
  };

  const GAP = { samplingErrors: ["docker top exited 1"], samplingErrorCount: 1 };
  const FOUND = { sampledBasenames: ["node", "python3"] };

  it("54. clean run, no gap, no finding -> PASS + PASS", () => {
    const v = verdicts({});
    assert.equal(v["direct.process-sampling-available"], OUTCOMES.PASS);
    assert.equal(v["direct.no-ytdlp-spawned"], OUTCOMES.PASS);
  });

  it("54b. gap, no finding -> BLOCKED + BLOCKED", () => {
    const v = verdicts({ ...GAP });
    assert.equal(v["direct.process-sampling-available"], OUTCOMES.BLOCKED);
    assert.equal(v["direct.no-ytdlp-spawned"], OUTCOMES.BLOCKED);
  });

  it("54c. finding, no gap -> PASS + FAIL", () => {
    const v = verdicts({ ...FOUND });
    assert.equal(v["direct.process-sampling-available"], OUTCOMES.PASS);
    assert.equal(v["direct.no-ytdlp-spawned"], OUTCOMES.FAIL);
  });

  it("54d. THE DEFECT: finding AND gap -> BLOCKED coverage, FAIL finding", () => {
    // A gap in one interval must not erase a process positively observed in
    // another. The previous code routed both through one gate and downgraded
    // this to BLOCKED — losing the strongest evidence the case can produce.
    const v = verdicts({ ...FOUND, ...GAP });
    assert.equal(v["direct.process-sampling-available"], OUTCOMES.BLOCKED);
    assert.equal(v["direct.no-ytdlp-spawned"], OUTCOMES.FAIL);
    assert.equal(v.summary, OUTCOMES.FAIL, "FAIL outranks BLOCKED in the summary");
  });

  it("54e. 500 clean samples cannot outvote a gap, nor bury a finding", () => {
    const many = { samplesTaken: 500 };
    assert.equal(
      verdicts({ ...many, ...GAP })["direct.no-ytdlp-spawned"],
      OUTCOMES.BLOCKED,
      "no finding + gap stays BLOCKED",
    );
    const withFinding = verdicts({ ...many, ...GAP, ...FOUND });
    assert.equal(withFinding["direct.no-ytdlp-spawned"], OUTCOMES.FAIL);
    assert.equal(withFinding.summary, OUTCOMES.FAIL);
  });

  it("54f. every approved yt-dlp runtime basename is a finding", () => {
    for (const name of [...YTDLP_RUNTIME_BASENAMES, "yt-dlp"]) {
      assert.equal(
        verdicts({ sampledBasenames: ["node", name] })["direct.no-ytdlp-spawned"],
        OUTCOMES.FAIL,
        name,
      );
    }
    // An ordinary descendant is not a finding.
    for (const name of ["node", "sh", UNCLASSIFIED_COMM]) {
      assert.notEqual(
        verdicts({ sampledBasenames: ["node", name] })["direct.no-ytdlp-spawned"],
        OUTCOMES.FAIL,
        name,
      );
    }
  });

  it("54g. a finding is never inferred from an error message", () => {
    // The error text mentions python3; only SUCCESSFUL samples may produce the
    // positive finding, so this is a gap, not a finding.
    const v = verdicts({
      samplingErrors: ["docker top exited 1 while python3 was running"],
      samplingErrorCount: 1,
    });
    assert.equal(v["direct.no-ytdlp-spawned"], OUTCOMES.BLOCKED);
    assert.notEqual(v["direct.no-ytdlp-spawned"], OUTCOMES.FAIL);
  });

  it("55. CLI-shaped: a finding survives a sampling gap into the aggregate", async () => {
    // One failed attempt, then successful samples that DO contain yt-dlp.
    let calls = 0;
    const flakySampler = {
      async sample() {
        calls += 1;
        if (calls === 1) throw new Error("docker top exited 1");
        return {
          sample: [
            { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[4026532001]" },
            { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: "net:[4026532001]" },
          ],
          workerPid: 100,
          ytdlpPid: 200,
          expectedNetns: "net:[4026532001]",
        };
      },
    };
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const run = await runCli(
      ["--stage", "B", "--case", "direct-regression", ...LIVE_ARGS, "--evidence", "/tmp/d.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun(), sampler: flakySampler },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);

    const payload = JSON.parse(run.files.get("/tmp/d.json")).payload.directAfterEnable;
    assert.equal(payload.samplingErrorCount, 1, "the gap is sealed");
    assert.ok(payload.sampledBasenames.includes("python3"), "and so is the finding");

    const result = evaluateStageB(
      passingStageBObservations({ directAfterEnable: measured(payload) }),
      passingStageA(),
    );
    assert.equal(
      result.checks.find((c) => c.id === "direct.process-sampling-available").outcome,
      OUTCOMES.BLOCKED,
    );
    assert.equal(
      result.checks.find((c) => c.id === "direct.no-ytdlp-spawned").outcome,
      OUTCOMES.FAIL,
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
  });
});

// ── CORRECTION-06 §6-§10: the docker top boundary and parser ─────────────

describe("docker top boundary", () => {
  const SAFE = ["top", "videofetch-worker", "-o", "pid,ppid,pgid,comm"];

  it("56. exactly one process-listing shape is admissible", () => {
    assert.equal(isReadOnlyCommand("docker", SAFE), true);
    assert.equal(DOCKER_TOP_COLUMNS, "pid,ppid,pgid,comm");
  });

  it("56b. every command-line-bearing form is structurally refused", () => {
    for (const argv of [
      ["top", "videofetch-worker"],
      ["top", "videofetch-worker", "-eo", "args"],
      ["top", "videofetch-worker", "-o", "args"],
      ["top", "videofetch-worker", "-o", "pid,args"],
      ["top", "videofetch-worker", "-o", "command"],
      ["top", "videofetch-worker", "-o", "cmd"],
      ["top", "videofetch-worker", "-o", "pid,ppid,pgid,comm,args"],
      ["top", "videofetch-worker", "aux"],
      ["top", "videofetch-worker", "-ef"],
      ["top", "videofetch-worker", "-o", "pid,ppid,pgid,comm", "extra"],
      ["top", "videofetch-worker", "-O", "pid,ppid,pgid,comm"],
      // The one dynamic token is still bounded by Docker's own name grammar.
      ["top", "../etc", "-o", "pid,ppid,pgid,comm"],
      ["top", "-x", "-o", "pid,ppid,pgid,comm"],
      ["top", "", "-o", "pid,ppid,pgid,comm"],
    ]) {
      assert.equal(isReadOnlyCommand("docker", argv), false, argv.join(" "));
    }
  });

  it("57. the real space-padded header is accepted; an unknown one is refused", () => {
    const real =
      "PID                 PPID                PGID                COMMAND\n" +
      "66545               66520               66545               sh\n";
    assert.equal(parseDockerTop(real).ok, true);

    for (const [stdout, what] of [
      ["", "no output at all"],
      ["100 1 100 node\n", "no header"],
      ["PID PPID COMMAND\n100 1 node\n", "wrong column count"],
      ["PID PPID PGID CMD\n100 1 100 node\n", "an unexpected title"],
      ["UID PID PPID COMMAND\n1 2 3 node\n", "a different column set"],
      ["PID PPID PGID COMMAND\n", "a header with no rows"],
    ]) {
      const parsed = parseDockerTop(stdout);
      assert.equal(parsed.ok, false, what);
      assert.equal(parsed.rows, undefined, what);
    }
  });

  it("57b. a headerless listing does not lose its first row to the header slot", () => {
    // The previous parser dropped line 1 unconditionally. Here line 1 is a real
    // process, and losing it silently is exactly the failure mode.
    const parsed = parseDockerTop("100 1 100 node\n200 100 200 ffmpeg\n");
    assert.equal(parsed.ok, false, "unrecognized format is refused, not partially parsed");
    assert.doesNotMatch(parsed.reason, /ffmpeg/);
  });

  it("58. an unreadable numeric prefix makes the WHOLE sample unmeasured", () => {
    for (const stdout of [
      "PID PPID PGID COMMAND\nxxx 100 300 ffmpeg\n",
      "PID PPID PGID COMMAND\n100 x 100 node\n",
      "PID PPID PGID COMMAND\n100 1 abc node\n",
      "PID PPID PGID COMMAND\n100 1 100\n",
      `PID PPID PGID COMMAND\n${"9".repeat(20)} 1 100 node\n`,
    ]) {
      const parsed = parseDockerTop(stdout);
      assert.equal(parsed.ok, false, stdout);
      assert.equal(parsed.rows, undefined);
      assert.doesNotMatch(parsed.reason, /ffmpeg|node/, "the refusal must not quote the row");
    }
  });

  it("58b. THE ATTACK: the only forbidden descendant is the malformed row", () => {
    // Under the previous parser this row was silently skipped and the remaining
    // rows looked clean — a PASS built on the absence of the very process the
    // check exists to catch.
    const parsed = parseDockerTop(
      "PID PPID PGID COMMAND\n100 1 100 node\nxxx 100 300 ffmpeg\n200 100 200 python3\n",
    );
    assert.equal(parsed.ok, false, "the sample must be refused, not silently cleaned");
  });

  it("58c. a malformed row between two valid rows cannot disappear", () => {
    const clean = parseDockerTop("PID PPID PGID COMMAND\n100 1 100 node\n200 100 200 python3\n");
    assert.equal(clean.rows.length, 2);
    const withHole = parseDockerTop(
      "PID PPID PGID COMMAND\n100 1 100 node\nBAD ROW HERE\n200 100 200 python3\n",
    );
    assert.equal(withHole.ok, false);
    assert.equal(withHole.rows, undefined, "no partial row set is offered");
  });

  it("59. a valid row with an unusual comm is RETAINED under a safe token", () => {
    const parsed = parseDockerTop(
      "PID PPID PGID COMMAND\n100 1 100 node\n300 100 300 some odd thing\n",
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rows.length, 2, "the odd row must not disappear");
    assert.equal(parsed.rows[1].comm, UNCLASSIFIED_COMM);
    assert.doesNotMatch(JSON.stringify(parsed), /odd thing/, "no raw text reaches the evidence");
  });

  it("59b. an unclassified descendant FAILS the unknown-descendant check", () => {
    // Inside the Worker container it is not an approved acquisition executable,
    // so it must be a finding rather than a clean result.
    const NS = "net:[4026532001]";
    const window = windowOf([
      acquisitionSample([{ pid: 300, ppid: 200, pgid: 200, comm: UNCLASSIFIED_COMM, netns: NS }]),
    ]);
    const aggregate = aggregateDownloadWindow(window);
    assert.ok(
      aggregate.unknownSeen.some((row) => row.comm === UNCLASSIFIED_COMM),
      "an unclassified descendant is an unknown descendant",
    );
    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(window) }),
      passingStageA(),
    );
    assert.equal(
      result.checks.find((c) => c.id === "process.no-unknown-descendants").outcome,
      OUTCOMES.FAIL,
    );
  });

  it("59c. a retained ffmpeg row FAILS the downloading boundary", () => {
    const NS = "net:[4026532001]";
    const parsed = parseDockerTop(
      "PID PPID PGID COMMAND\n100 1 100 node\n200 100 200 python3\n300 200 200 ffmpeg\n",
    );
    assert.equal(parsed.ok, true);
    const window = windowOf([parsed.rows.map((row) => ({ ...row, netns: NS }))]);
    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(window) }),
      passingStageA(),
    );
    assert.equal(
      result.checks.find((c) => c.id === "process.no-ffmpeg-during-downloading").outcome,
      OUTCOMES.FAIL,
    );
  });

  it("60. CLI-shaped attack: a malformed forbidden row BLOCKS the window", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
      // The FFmpeg that would defeat the acquisition assertion is the one row
      // that cannot be parsed.
      dockerTopStdout:
        "PID PPID PGID COMMAND\n100 1 100 node\n200 100 200 python3\nxxx 200 200 ffmpeg\n",
    });
    const run = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
        ...WORKER_ENV,
      }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);

    const window = JSON.parse(run.files.get("/tmp/c.json")).payload.downloadingWindow;
    assert.ok(window.samplerErrors.length > 0, "the unreadable row became a sampler error");
    assert.doesNotMatch(JSON.stringify(window), /ffmpeg/, "and did not leak into the evidence");

    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(window) }),
      passingStageA(),
    );
    assert.equal(
      result.checks.find((c) => c.id === "process.window-observed").outcome,
      OUTCOMES.BLOCKED,
      "a window with an unobserved interval cannot support the negative claims",
    );
    // And the negative claims are not emitted as PASS on the strength of the
    // rows that DID parse.
    for (const id of ["process.no-ffmpeg-during-downloading", "process.no-unknown-descendants"]) {
      const emitted = result.checks.find((c) => c.id === id);
      assert.notEqual(emitted?.outcome, OUTCOMES.PASS, `${id} must not PASS`);
    }
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
  });
});

// ── CORRECTION-06 §12-§15: feature-state continuity ──────────────────────

describe("feature-state continuity", () => {
  const binding = { expectedSha: SHA, runningImageId: IMAGE_ID };

  const ENABLED = {
    ytdlpEnabled: "true",
    sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
  };
  const DISABLED_SITES = { ytdlp: false, ytdlpInstalled: true, ytdlpEnabled: false, ffmpeg: true };

  const CASE_ENV = (extra = {}) =>
    LIVE_ENV({
      VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
      VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
      ...WORKER_ENV,
      ...extra,
    });

  it("61. an ordinary enabled case seals both sides", async () => {
    const world = makeFakeWorld(ENABLED);
    const run = await runCli(
      ["--stage", "B", "--case", "cancellation", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      CASE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const record = JSON.parse(run.files.get("/tmp/c.json"));
    assert.equal(record.featureContinuity.before.state, "enabled");
    assert.equal(record.featureContinuity.after.state, "enabled");
    assert.equal(record.featureContinuity.sameRequiredState, true);
    assert.match(run.out, /deployment state held: generic enabled/);
  });

  it("61b. an enabled case that ends DISABLED BLOCKS and writes nothing", async () => {
    // The environment flips mid-case; the image never changes. The flip lands
    // after the pre-case read, so the post-case read sees the new state.
    const world = makeFakeWorld({
      ...ENABLED,
      featureFlipsAfterEnvReads: 1,
      ytdlpEnabledAfterFlip: null,
      sitesAfterFlip: DISABLED_SITES,
    });
    const run = await runCli(
      ["--stage", "B", "--case", "cancellation", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      CASE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /DEPLOYMENT FEATURE STATE CHANGED DURING THE CASE/);
    assert.equal(run.files.has("/tmp/c.json"), false, "no record may span two states");
  });

  it("62. THE ATTACK: shutdown, same image, feature state flipped by the restart", async () => {
    const fakeSampler = {
      async sample() {
        return {
          sample: acquisitionSample(),
          workerPid: 100,
          ytdlpPid: 200,
          expectedNetns: "net:[4026532001]",
        };
      },
    };
    const shared = {
      ...ENABLED,
      restartAfterIdReads: 4,
    };
    const args = ["--stage", "B", "--case", "shutdown", ...LIVE_ARGS, "--evidence", "/tmp/s.json"];
    const deps = (world) => ({
      runReadOnly: world.runReadOnly,
      fetch: world.fetch,
      files: seedRun(),
      sampler: fakeSampler,
      shutdownWindowMs: 2000,
      recoveryWindowMs: 2000,
    });

    // Control: the restart brings back the same image AND the same state.
    const ok = makeFakeWorld(shared);
    const good = await runCli(args, CASE_ENV(), deps(ok));
    assert.equal(good.code, 0, `${good.out}\n${good.err}`);
    const record = JSON.parse(good.files.get("/tmp/s.json"));
    assert.equal(record.imageContinuity.same, true);
    assert.equal(record.featureContinuity.after.state, "enabled");

    // The attack: SAME authorized image, but generic is now disabled. Image
    // continuity holds and restart recovery succeeds — only feature continuity
    // catches it.
    const attacked = makeFakeWorld({
      ...shared,
      ytdlpEnabledAfterRestart: null,
      sitesAfterRestart: DISABLED_SITES,
    });
    const bad = await runCli(args, CASE_ENV(), deps(attacked));
    assert.equal(bad.code, 2, `${bad.out}\n${bad.err}`);
    assert.match(bad.err, /DEPLOYMENT FEATURE STATE CHANGED DURING THE CASE/);
    assert.equal(bad.files.has("/tmp/s.json"), false);
    assert.equal(attacked.live.image, IMAGE_ID, "the image genuinely never changed");
  });

  it("63. kill-switch must stay disabled on both sides", async () => {
    const disabled = makeFakeWorld({ ytdlpEnabled: null, sites: DISABLED_SITES });
    const good = await runCli(
      ["--stage", "B", "--case", "kill-switch", ...LIVE_ARGS, "--evidence", "/tmp/k.json"],
      CASE_ENV(),
      { runReadOnly: disabled.runReadOnly, fetch: disabled.fetch, files: seedRun() },
    );
    assert.equal(good.code, 0, `${good.out}\n${good.err}`);
    assert.equal(JSON.parse(good.files.get("/tmp/k.json")).featureContinuity.after.state, "disabled");

    // Re-enabled mid-case.
    const flipped = makeFakeWorld({
      ytdlpEnabled: null,
      sites: DISABLED_SITES,
      featureFlipsAfterEnvReads: 1,
      ytdlpEnabledAfterFlip: "true",
      sitesAfterFlip: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const bad = await runCli(
      ["--stage", "B", "--case", "kill-switch", ...LIVE_ARGS, "--evidence", "/tmp/k2.json"],
      CASE_ENV(),
      { runReadOnly: flipped.runReadOnly, fetch: flipped.fetch, files: seedRun() },
    );
    assert.equal(bad.code, 2, `${bad.out}\n${bad.err}`);
    assert.match(bad.err, /FEATURE STATE CHANGED|CAPABILITY CHANGED/);
    assert.equal(bad.files.has("/tmp/k2.json"), false);
  });

  it("63b. an unmeasurable post-case state BLOCKS", async () => {
    for (const breaks of ["env", "sites"]) {
      const world = makeFakeWorld(ENABLED);
      let envReads = 0;
      let siteReads = 0;
      const run = await runCli(
        ["--stage", "B", "--case", "cancellation", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
        CASE_ENV(),
        {
          runReadOnly: async (file, argv) => {
            if (breaks === "env" && argv.join(" ").includes("YTDLP_ENABLED")) {
              envReads += 1;
              if (envReads > 1) return { exitCode: 1, stdout: "", stderr: "boom" };
            }
            return world.runReadOnly(file, argv);
          },
          fetch: async (target, init) => {
            if (breaks === "sites" && String(target).endsWith("/api/sites")) {
              siteReads += 1;
              if (siteReads > 1) throw new Error("connection refused");
            }
            return world.fetch(target, init);
          },
          files: seedRun(),
        },
      );
      assert.equal(run.code, 2, `${breaks}: ${run.out}${run.err}`);
      assert.match(run.err, /could not be re-measured after case/);
      assert.equal(run.files.has("/tmp/c.json"), false);
    }
  });

  it("64. the validator recomputes continuity rather than trusting it", () => {
    const enabled = featureState("enabled");
    const disabled = featureState("disabled");
    const cases = [
      ["a flipped after-state", { before: enabled, after: disabled, sameRequiredState: true }],
      ["a flipped before-state", { before: disabled, after: enabled, sameRequiredState: true }],
      ["a moved capability report", {
        before: enabled,
        after: { ...enabled, sites: { ...enabled.sites, ytdlpInstalled: false } },
        sameRequiredState: true,
      }],
      ["a false flag", { before: enabled, after: enabled, sameRequiredState: false }],
      ["a missing after", { before: enabled, sameRequiredState: true }],
      ["a missing before", { after: enabled, sameRequiredState: true }],
      ["nothing at all", null],
      ["a malformed measurement", {
        before: { ...enabled, ytdlpEnabledRaw: "false" },
        after: enabled,
        sameRequiredState: true,
      }],
    ];
    for (const [what, continuity] of cases) {
      // `buildCaseRecord` directly, so an ABSENT continuity object is genuinely
      // absent rather than filled in by the test helper's default.
      const record = buildCaseRecord({
        caseName: "cancellation",
        binding,
        payload: { cancellation: cancellationEvidence({ postSample: [] }) },
        featureState: enabled,
        featureContinuity: continuity,
        imageContinuity: { before: IMAGE_ID, after: IMAGE_ID, taggedImageId: IMAGE_ID, same: true },
      });
      const validated = validateCaseRecord(record, binding);
      assert.equal(validated.ok, false, what);
      assert.match(validated.reason, /continuity|contradicts/, what);
    }
  });

  it("64b. featureState must agree with the continuity it claims", () => {
    const enabled = featureState("enabled");
    const record = buildCaseRecord({
      caseName: "cancellation",
      binding,
      payload: { cancellation: cancellationEvidence({ postSample: [] }) },
      // Claims the enabled phase while its continuity describes a different
      // capability report.
      featureState: enabled,
      featureContinuity: {
        before: { ...enabled, sites: { ...enabled.sites, ytdlpInstalled: false } },
        after: { ...enabled, sites: { ...enabled.sites, ytdlpInstalled: false } },
        sameRequiredState: true,
      },
      imageContinuity: { before: IMAGE_ID, after: IMAGE_ID, taggedImageId: IMAGE_ID, same: true },
    });
    assert.match(validateCaseRecord(record, binding).reason, /contradicts/);
  });

  it("64c. continuity is sealed and cannot be edited", () => {
    const KEY = "b".repeat(64);
    const sealed = sealRecord(
      caseRecord({
        caseName: "cancellation",
        binding,
        payload: { cancellation: cancellationEvidence({ postSample: [] }) },
        runId: "0123456789abcdef",
      }),
      KEY,
    );
    assert.equal(verifySeal(sealed, KEY).ok, true);
    sealed.featureContinuity.after.state = "disabled";
    assert.equal(verifySeal(sealed, KEY).ok, false);
  });

  it("64d. a kill-switch capability finding is NOT converted into a refusal", () => {
    // /api/sites still reporting ytdlp:true while the configuration is disabled
    // is the most important finding this case can produce. It must reach the
    // evaluator as a FAIL, not be swallowed by a precondition gate.
    const broken = {
      state: "disabled",
      ytdlpEnabledRaw: null,
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true },
      observedAt: "2026-01-01T00:00:00.000Z",
    };
    const continuity = evaluateFeatureContinuity(broken, broken, "disabled");
    assert.equal(continuity.ok, true, "the gate is about the configuration, not the finding");

    const result = evaluateStageB(
      passingStageBObservations({
        killSwitch: measured({ genericUsableAfterDisable: true, directWorks: true }),
        disabledFeatureState: measured(broken),
      }),
      passingStageA(),
    );
    assert.equal(
      result.checks.find((c) => c.id === "killswitch.rollback").outcome,
      OUTCOMES.FAIL,
      "a broken kill switch must FAIL, never BLOCK",
    );
    assert.equal(
      result.checks.find((c) => c.id === "killswitch.disabled-state-proven").outcome,
      OUTCOMES.FAIL,
    );
  });
});

// ── CORRECTION-06 §16-§17: the run identity has one exact grammar ────────

describe("run identity grammar", () => {
  const KEY = "c".repeat(64);
  const enoent = () => Object.assign(new Error("no such file"), { code: "ENOENT" });

  function adapter(contents) {
    const written = [];
    return {
      written,
      deps: {
        readFile: async () => contents,
        writeFile: async (path, body) => written.push([path, body]),
        mkdir: async () => {},
        chmod: async () => {},
        stat: async () => ({ mode: 0o600 }),
      },
    };
  }

  it("65. the pattern is exactly what the harness mints", async () => {
    assert.equal(RUN_ID_PATTERN.source, "^[0-9a-f]{16}$");
    const { deps } = adapter(null);
    const created = await loadOrCreateRun("/tmp/run.json", {
      ...deps,
      stat: async () => { throw enoent(); },
    });
    assert.match(created.runId, RUN_ID_PATTERN, "the minted id matches the admitted grammar");
  });

  it("65b. every invalid runId shape BLOCKS both paths and preserves the file", async () => {
    const invalid = [
      ["empty", '""'],
      ["too short", '"abc"'],
      ["15 hex", `"${"a".repeat(15)}"`],
      ["17 hex", `"${"a".repeat(17)}"`],
      ["uppercase", '"A1B2C3D4E5F60718"'],
      ["non-hex", '"a1b2c3d4e5f6071g"'],
      ["null", "null"],
      ["a number", "12345678"],
    ];
    for (const [what, literal] of invalid) {
      const contents = `{"runId":${literal},"key":"${KEY}"}`;
      const create = adapter(contents);
      const created = await loadOrCreateRun("/tmp/run.json", create.deps);
      assert.match(created.error, /usable runId/, `loadOrCreateRun: ${what}`);
      assert.equal(created.key, undefined, what);
      assert.deepEqual(create.written, [], `${what}: the file must not be overwritten`);

      const load = adapter(contents);
      const loaded = await loadRun("/tmp/run.json", load.deps);
      assert.match(loaded.error, /usable runId/, `loadRun: ${what}`);
    }

    // A missing runId entirely.
    const missing = adapter(`{"key":"${KEY}"}`);
    assert.match((await loadOrCreateRun("/tmp/run.json", missing.deps)).error, /usable runId/);
    assert.deepEqual(missing.written, []);
  });

  it("65c. the exact shape the harness produces is still accepted", async () => {
    const { deps, written } = adapter(`{"runId":"a1b2c3d4e5f60718","key":"${KEY}"}`);
    const resumed = await loadOrCreateRun("/tmp/run.json", deps);
    assert.equal(resumed.created, false);
    assert.equal(resumed.runId, "a1b2c3d4e5f60718");
    assert.deepEqual(written, [], "an intact file is never written to");
  });
});


// ── CORRECTION-07 §3: run identity is admitted by TYPE, not by string form ─

describe("run identity type strictness", () => {
  const KEY = "c".repeat(64);
  const enoent = () => Object.assign(new Error("no such file"), { code: "ENOENT" });

  function adapter(contents) {
    const written = [];
    return {
      written,
      deps: {
        readFile: async () => contents,
        writeFile: async (path, body, opts) => written.push([path, body, opts]),
        mkdir: async () => {},
        chmod: async () => {},
        stat: async () => ({ mode: 0o600 }),
      },
    };
  }

  /**
   * THE regression this correction exists for.
   *
   * `String(1234567890123456)` is `"1234567890123456"`, which matches
   * /^[0-9a-f]{16}$/ exactly. The old coercing test therefore admitted a JSON
   * NUMBER as a run identity — and `verifyRecord` then compares
   * `record.runId !== expected.runId`, a string against a number, so every
   * artifact of the run becomes unverifiable for a reason nothing reports.
   */
  it("66. a 16-DIGIT JSON number is not a runId", async () => {
    const contents = `{"runId":1234567890123456,"key":"${KEY}"}`;
    assert.match(
      String(1234567890123456),
      RUN_ID_PATTERN,
      "precondition: its string form is what the grammar admits",
    );

    const create = adapter(contents);
    const created = await loadOrCreateRun("/tmp/run.json", create.deps);
    assert.match(created.error, /usable runId/);
    assert.equal(created.key, undefined, "no key is handed back");
    assert.equal(created.runId, undefined);
    assert.deepEqual(create.written, [], "the existing file is not overwritten");

    const load = adapter(contents);
    const loaded = await loadRun("/tmp/run.json", load.deps);
    assert.match(loaded.error, /usable runId/);
    assert.deepEqual(load.written, []);
  });

  it("66b. every non-string runId BLOCKS both paths, however it stringifies", async () => {
    const invalid = [
      ["empty string", '""'],
      ["too short", '"abc"'],
      ["15 hex", `"${"a".repeat(15)}"`],
      ["17 hex", `"${"a".repeat(17)}"`],
      ["uppercase", '"A1B2C3D4E5F60718"'],
      ["non-hex", '"a1b2c3d4e5f6071g"'],
      ["null", "null"],
      ["an 8-digit number", "12345678"],
      ["a 16-digit number", "1234567890123456"],
      ["a boolean", "true"],
      ["an array", '["a1b2c3d4e5f60718"]'],
      ["an object", '{"toString":"a1b2c3d4e5f60718"}'],
    ];
    for (const [what, literal] of invalid) {
      const contents = `{"runId":${literal},"key":"${KEY}"}`;
      const create = adapter(contents);
      const created = await loadOrCreateRun("/tmp/run.json", create.deps);
      assert.match(created.error, /usable runId/, `loadOrCreateRun: ${what}`);
      assert.equal(created.created, undefined, `${what}: no fresh run is minted`);
      assert.deepEqual(create.written, [], `${what}: the file must not be overwritten`);

      const load = adapter(contents);
      const loaded = await loadRun("/tmp/run.json", load.deps);
      assert.match(loaded.error, /usable runId/, `loadRun: ${what}`);
      assert.deepEqual(load.written, [], `${what}: loadRun never writes`);
    }

    // A missing runId entirely.
    const missing = adapter(`{"key":"${KEY}"}`);
    assert.match((await loadOrCreateRun("/tmp/run.json", missing.deps)).error, /usable runId/);
    assert.deepEqual(missing.written, []);
  });

  it("66c. the KEY must be an actual string too", async () => {
    const invalid = [
      ["null", "null"],
      ["a number", "12345678901234567890"],
      ["a boolean", "false"],
      ["an array", `["${KEY}"]`],
      ["short", '"aa"'],
      ["uppercase", `"${"C".repeat(64)}"`],
      ["non-hex", `"${"z".repeat(64)}"`],
    ];
    for (const [what, literal] of invalid) {
      const contents = `{"runId":"a1b2c3d4e5f60718","key":${literal}}`;
      const create = adapter(contents);
      const created = await loadOrCreateRun("/tmp/run.json", create.deps);
      assert.match(created.error, /usable runId/, `loadOrCreateRun: ${what}`);
      assert.deepEqual(create.written, [], `${what}: the file must not be overwritten`);

      const load = adapter(contents);
      assert.match((await loadRun("/tmp/run.json", load.deps)).error, /usable runId/, what);
    }
  });

  it("66d. the exact shape the harness mints is still admitted", async () => {
    const { deps, written } = adapter(`{"runId":"a1b2c3d4e5f60718","key":"${KEY}"}`);
    const resumed = await loadOrCreateRun("/tmp/run.json", deps);
    assert.equal(resumed.created, false);
    assert.equal(resumed.runId, "a1b2c3d4e5f60718");
    assert.equal(typeof resumed.runId, "string");
    assert.equal(resumed.key, KEY);
    assert.deepEqual(written, [], "an intact file is never written to");

    // And a freshly minted one satisfies its own admission rule, by type.
    const mint = adapter(null);
    const created = await loadOrCreateRun("/tmp/new.json", {
      ...mint.deps,
      stat: async () => { throw enoent(); },
    });
    assert.equal(typeof created.runId, "string");
    assert.equal(typeof created.key, "string");
    assert.match(created.runId, RUN_ID_PATTERN);
  });
});

// ── CORRECTION-07 §4-§5: raw `comm` is validated before normalization ─────

describe("raw comm classification", () => {
  const top = (...rows) => parseDockerTop(["PID PPID PGID COMMAND", ...rows].join("\n") + "\n");

  it("67. a plain basename survives verbatim", () => {
    const parsed = top("100 1 100 node", "200 100 200 python3", "300 200 300 ffmpeg");
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.rows.map((r) => r.comm), ["node", "python3", "ffmpeg"]);
  });

  /**
   * §5: the laundering table. Each of these WAS silently normalized into an
   * approved or classified executable by the previous parser.
   */
  it("67b. a path-like comm can never acquire an approved identity", () => {
    const cases = [
      ["foo/python3", "python3"],
      ["/usr/bin/ffmpeg", "ffmpeg"],
      ["foo/node", "node"],
      ["suspicious/python3", "python3"],
      ["../../bin/aria2c", "aria2c"],
      ["a/b/c/yt-dlp", "yt-dlp"],
    ];
    for (const [raw, laundered] of cases) {
      const parsed = top(`100 1 100 ${raw}`);
      assert.equal(parsed.ok, true, `${raw}: the row is still parsed`);
      assert.equal(parsed.rows.length, 1, `${raw}: the row is never dropped`);
      assert.equal(parsed.rows[0].comm, UNCLASSIFIED_COMM, `${raw} must not be classified`);
      assert.notEqual(parsed.rows[0].comm, laundered, `${raw} must not become ${laundered}`);
      // And the raw text itself is not copied into evidence either.
      assert.doesNotMatch(parsed.rows[0].comm, /\//);
    }
  });

  it("67c. an argv-looking or spaced comm is unclassified, never split", () => {
    for (const raw of ["python3 --something", "some odd thing", "node -e x", "ffmpeg -i in.mp4"]) {
      const parsed = top(`100 1 100 ${raw}`);
      assert.equal(parsed.ok, true, raw);
      assert.equal(parsed.rows.length, 1, `${raw}: one row, not several`);
      assert.equal(parsed.rows[0].comm, UNCLASSIFIED_COMM, raw);
    }
  });

  it("67d. an unclassified row is an UNKNOWN descendant, never an approved runtime", () => {
    // The only suspicious descendant is `foo/python3`.
    const parsed = top("100 1 100 node", "200 100 200 python3", "300 200 300 foo/python3");
    assert.equal(parsed.ok, true);

    const sample = parsed.rows.map((row) => ({ ...row, netns: "net:[1]" }));
    assert.equal(validateSampleShape(sample).ok, true, "an unclassified comm is still schema-valid");

    const classified = classifyAcquisitionTree(sample, 100);
    assert.deepEqual(
      classified.unknown.map((r) => r.pid),
      [300],
      "the suspicious descendant is reported, not tolerated",
    );
    assert.equal(classified.forbidden.length, 0);
    assert.equal(
      classified.basenames.includes(UNCLASSIFIED_COMM),
      true,
      "and it is visible in the evidence as unclassified",
    );

    // It must not be eligible to BE the owned acquisition process. Both
    // suspicious rows lead their own group, so under the old normalization
    // there would have been two `python3` candidates and the establishment
    // would have gone ambiguous — or worse, picked one.
    const detached = [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[1]" },
      { pid: 300, ppid: 100, pgid: 300, comm: UNCLASSIFIED_COMM, netns: "net:[1]" },
    ];
    const established = establishYtdlpPid(detached, 100);
    assert.equal(established.established, false);
    assert.match(established.reason, /no descendant matched/);

    // …and it is not on the approved list under either name.
    assert.equal(ALLOWED_ACQUISITION_DESCENDANTS.includes(UNCLASSIFIED_COMM), false);
    assert.equal(YTDLP_RUNTIME_BASENAMES.includes(UNCLASSIFIED_COMM), false);

    // The whole chain, parser to verdict: a listing whose ONLY suspicious
    // descendant is `foo/python3` must FAIL the unknown-descendant check. Under
    // the previous normalization this listing produced a clean PASS.
    const NS = "net:[4026532001]";
    const window = windowOf([
      parseDockerTop(
        "PID PPID PGID COMMAND\n100 1 100 node\n200 100 200 python3\n300 200 200 foo/python3\n",
      ).rows.map((row) => ({ ...row, netns: NS })),
    ]);
    const result = evaluateStageB(
      passingStageBObservations({ downloadingWindow: measured(window) }),
      passingStageA(),
    );
    assert.equal(
      result.checks.find((c) => c.id === "process.no-unknown-descendants").outcome,
      OUTCOMES.FAIL,
      "a path-like python3 is an unknown descendant, not an approved runtime",
    );
    assert.doesNotMatch(
      JSON.stringify(window),
      /foo/,
      "and its raw name never reaches the evidence",
    );
  });

  it("67e. a forbidden executable named plainly is still a forbidden finding", () => {
    const parsed = top("100 1 100 node", "300 100 300 ffmpeg");
    const sample = parsed.rows.map((row) => ({ ...row, netns: "net:[1]" }));
    const classified = classifyAcquisitionTree(sample, 100);
    assert.deepEqual(classified.forbidden.map((r) => r.comm), ["ffmpeg"]);
  });
});


// ── CORRECTION-07 §6-§8: favourable stdout requires a successful command ──

describe("measurement requires successful completion", () => {
  /**
   * A runner that answers a chosen command with a NON-ZERO exit AND the stdout
   * that would otherwise have produced a PASS. That pairing is the whole point:
   * an empty failure is easy to reject, and a failure carrying a perfect answer
   * is what the old code consumed.
   */
  function failing(match, stdout, base) {
    return async (file, argv) => {
      if (match(file, argv)) return { exitCode: 1, stdout, stderr: "" };
      return base(file, argv);
    };
  }

  it("68. a non-zero `docker top` cannot produce a measured sample", async () => {
    const world = makeFakeWorld();
    const perfect = "PID PPID PGID COMMAND\n100 1 100 node\n200 100 200 python3\n";
    // Precondition: this listing IS valid, so only the exit code can reject it.
    assert.equal(parseDockerTop(perfect).ok, true);

    const sampler = makeProcessSampler({
      runReadOnly: failing((file, argv) => file === "docker" && argv[0] === "top", perfect, world.runReadOnly),
    });
    await assert.rejects(() => sampler.sample(), /docker top exited 1/);
  });

  it("68b. a non-zero `docker inspect` cannot produce a Worker PID", async () => {
    const world = makeFakeWorld();
    const sampler = makeProcessSampler({
      runReadOnly: failing(
        (file, argv) => file === "docker" && argv[0] === "inspect" && argv.join(" ").includes("State.Pid"),
        "1234\n",
        world.runReadOnly,
      ),
    });
    await assert.rejects(() => sampler.sample(), /docker inspect exited 1/);
  });

  it("68c. a failed `readlink` cannot produce a namespace measurement", async () => {
    const world = makeFakeWorld();
    const sampler = makeProcessSampler({
      runReadOnly: failing((file) => file === "readlink", "net:[4026532001]\n", world.runReadOnly),
    });
    const result = await sampler.sample();
    // The namespace is EXPLICITLY null, which the evaluator reads as a
    // mismatch — never as agreement with the Worker's namespace.
    assert.equal(result.expectedNetns, null);
    for (const row of result.sample) assert.equal(row.netns, null);
    const identity = evaluateNamespaceIdentity(
      classifyAcquisitionTree(result.sample, result.workerPid),
      result.expectedNetns,
    );
    assert.equal(identity.measured, false, "an unmeasured namespace is never containment");
  });

  it("68d. every audited scalar observer refuses a favourable non-zero result", async () => {
    const world = makeFakeWorld({ ytdlpEnabled: "true" });
    const cases = [
      ["runningImageId", (o) => o.runningImageId(), (f, a) => f === "docker" && a[0] === "inspect" && a.join(" ").includes("{{.Image}}"), `${IMAGE_ID}\n`],
      ["containerPid", (o) => o.containerPid(), (f, a) => f === "docker" && a[0] === "inspect" && a.join(" ").includes("State.Pid"), "100\n"],
      ["containerInstanceId", (o) => o.containerInstanceId(), (f, a) => f === "docker" && a[0] === "inspect" && a.join(" ").includes("{{.Id}}"), `${CONTAINER_A}\n`],
      ["networkPlacement", (o) => o.networkPlacement(), (f, a) => f === "docker" && a[0] === "inspect" && a.join(" ").includes("NetworkMode"), `container:${MEDIA_NETNS_ID}\n`],
      ["imageShaTag", (o) => o.imageShaTag(SHA), (f, a) => f === "docker" && a[0] === "inspect" && a.join(" ").includes("{{.Image}}"), `${IMAGE_ID}\n`],
      ["mediaNetnsPid", (o) => o.mediaNetnsPid(), (f, a) => f === "docker" && a[0] === "inspect" && a.includes("videofetch-media-netns"), "4242\n"],
      ["pythonVersion", (o) => o.pythonVersion(), (f, a) => f === "docker" && a[0] === "exec" && a.join(" ").endsWith("/usr/bin/python3 --version"), "Python 3.11.2\n"],
      ["nodeVersion", (o) => o.nodeVersion(), (f, a) => f === "docker" && a[0] === "exec" && a.join(" ").includes("node --version"), "v22.23.2\n"],
      ["bundledEjsVersion", (o) => o.bundledEjsVersion(), (f, a) => f === "docker" && a[0] === "exec" && a.slice(2).join(" ") === EJS_PROBE_ARGV.join(" "), "0.8.0\n"],
      ["workDirPresent", (o) => o.workDirPresent(JOB_ID), (f, a) => f === "docker" && a[0] === "exec" && a.join(" ").includes("os.path.isdir"), "False\n"],
      ["environmentNames", (o) => o.environmentNames(), (f, a) => f === "docker" && a[0] === "exec" && a.slice(2).join(" ") === ENV_NAMES_PROBE_ARGV.join(" "), "PATH\nYTDLP_ENABLED\n"],
      ["ytdlpEnabledRaw", (o) => o.ytdlpEnabledRaw(), (f, a) => f === "docker" && a[0] === "exec" && a.slice(2).join(" ") === YTDLP_ENABLED_PROBE_ARGV.join(" "), "SET:true\n"],
      ["effectiveMaxFileSize", (o) => o.effectiveMaxFileSize(), (f, a) => f === "docker" && a[0] === "exec" && a.slice(2).join(" ") === MAX_FILE_SIZE_PROBE_ARGV.join(" "), "SET:104857600\n"],
      ["processGroupMembers", (o) => o.processGroupMembers(300), (f) => f === "ps", "100 1 100 node\n"],
      ["workerLogs", (o) => o.workerLogs(), (f, a) => f === "docker" && a[0] === "logs", "worker started\n"],
      ["unitJournal", (o) => o.unitJournal("videofetch-worker"), (f) => f === "journalctl", "no errors\n"],
    ];

    for (const [name, call, match, favourable] of cases) {
      // First: the observer genuinely PASSES on this stdout with exit 0, so the
      // negative result below is attributable to the exit code alone.
      const clean = makeSystemObservers({ runReadOnly: world.runReadOnly });
      const cleanResult = await call(clean);
      assert.equal(cleanResult.measured, true, `${name}: precondition — exit 0 measures`);

      const observers = makeSystemObservers({
        runReadOnly: failing(match, favourable, world.runReadOnly),
      });
      const result = await call(observers);
      assert.equal(result.measured, false, `${name}: a failed command is not a measurement`);
      assert.equal(result.value, undefined, `${name}: no value is handed back`);
    }
  });

  it("68e. status-as-data observers keep reporting the status", async () => {
    const world = makeFakeWorld({ services: "inactive", egressExit: 1 });
    const observers = makeSystemObservers({ runReadOnly: world.runReadOnly });

    // `systemctl is-active` exits non-zero BECAUSE the unit is inactive, and
    // inactive is the property under test. Turning that into BLOCKED would
    // convert the finding into a refusal.
    const state = await observers.serviceState("videofetch-worker");
    assert.equal(state.measured, true);
    assert.equal(state.value.activeState, "inactive");

    // Same for the egress verifier: the exit code IS the verdict.
    const verifier = await observers.egressVerifier();
    assert.equal(verifier.measured, true);
    assert.equal(verifier.value.exitCode, 1);
  });

  it("68f. exit-0 behaviour is unchanged across the whole observer surface", async () => {
    const world = makeFakeWorld({ ytdlpEnabled: "true", maxFileSize: 104857600 });
    const observers = makeSystemObservers({ runReadOnly: world.runReadOnly });
    assert.equal((await observers.runningImageId()).value, IMAGE_ID);
    assert.equal((await observers.containerPid()).value, 100);
    assert.equal((await observers.containerInstanceId()).value, CONTAINER_A);
    assert.equal((await observers.pythonVersion()).value, "3.11.2");
    assert.equal((await observers.nodeVersion()).value, "v22.23.2");
    assert.equal((await observers.bundledEjsVersion()).value, "0.8.0");
    assert.equal((await observers.workDirPresent(JOB_ID)).value, false);
    assert.equal((await observers.ytdlpEnabledRaw()).value, "true");
    assert.equal((await observers.effectiveMaxFileSize()).value.bytes, 104857600);
    assert.equal((await observers.imageShaTag(SHA)).value.taggedImageId, IMAGE_ID);
  });

  it("68g. a failed sampler interval gaps the window rather than being averaged away", async () => {
    // The end-to-end shape: a `docker top` that fails mid-acquisition makes the
    // WHOLE window unusable, and no number of clean samples repairs it.
    const NS = "net:[4026532001]";
    const collector = createDownloadWindowCollector({});
    collector.noteState("downloading");
    // One clean sample succeeds…
    collector.addSample({
      sample: [
        { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: NS },
        { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: NS },
      ],
      workerPid: 100,
      ytdlpPid: 200,
      expectedNetns: NS,
    });
    // …and one interval fails outright.
    collector.noteSamplerError("docker top exited 1; the process listing was not measured");
    collector.noteState("ready");

    const window = collector.result();
    assert.equal(window.samples.length, 1, "the clean sample was admitted");
    assert.deepEqual(window.samplerErrors.length, 1, "and the failure is retained, not averaged away");
    const aggregate = aggregateDownloadWindow(window);
    assert.equal(
      aggregate.usable,
      false,
      "a successful sample does not repair an interval that could not be observed",
    );
  });

  it("68h. `sampleWhile` is gone, not merely unused (§17)", () => {
    const world = makeFakeWorld();
    const sampler = makeProcessSampler({ runReadOnly: world.runReadOnly });
    assert.equal(
      "sampleWhile" in sampler,
      false,
      "the permissive best-sample helper must not be reachable at all",
    );
    assert.equal("sampleWhile" in processSamplerModule, false, "and it is not exported");
    assert.equal(typeof sampler.sample, "function", "the fail-closed primitive remains");
  });
});


// ── CORRECTION-07 §9-§14: every case is bound to a container EPOCH ────────

describe("container epoch binding", () => {
  const ENABLED = {
    ytdlpEnabled: "true",
    sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
  };
  const CASE_ENV = (extra = {}) =>
    LIVE_ENV({
      VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
      VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
      ...WORKER_ENV,
      ...extra,
    });

  async function runOrdinary(worldOptions = {}) {
    const world = makeFakeWorld({ ...ENABLED, ...worldOptions });
    const run = await runCli(
      ["--stage", "B", "--case", "cancellation", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      CASE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    return { run, world };
  }

  /** The same acquisition sampler the restart-recovery suite drives. */
  const epochSampler = {
    async sample() {
      return {
        sample: [
          { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[4026532001]" },
          { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: "net:[4026532001]" },
        ],
        workerPid: 100,
        ytdlpPid: 200,
        expectedNetns: "net:[4026532001]",
      };
    },
  };

  async function runShutdownEpoch(worldOptions = {}) {
    const world = makeFakeWorld({
      ...ENABLED,
      restartAfterIdReads: 4,
      ...worldOptions,
    });
    const run = await runCli(
      ["--stage", "B", "--case", "shutdown", ...LIVE_ARGS, "--evidence", "/tmp/s.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        ...WORKER_ENV,
      }),
      {
        runReadOnly: world.runReadOnly,
        fetch: world.fetch,
        files: seedRun(),
        sampler: epochSampler,
        shutdownWindowMs: 2000,
        recoveryWindowMs: 2000,
      },
    );
    return { run, world };
  }

  it("69. an ordinary case bound to ONE container instance is accepted", async () => {
    const { run } = await runOrdinary();
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const record = JSON.parse(run.files.get("/tmp/c.json"));
    assert.deepEqual(record.containerEpoch, {
      mode: "continuous",
      before: CONTAINER_A,
      restartFrom: null,
      restartTo: null,
      after: CONTAINER_A,
    });
    assert.match(run.out, /one container instance surrounded the whole case/);
    // The IMAGE binding is unchanged and still present — the epoch is
    // additional evidence, never a replacement for it.
    assert.equal(record.runningImageId, IMAGE_ID);
    assert.equal(record.imageContinuity.same, true);
  });

  /**
   * THE regression this correction exists for.
   *
   * The image is identical at both endpoints, the feature state is identical at
   * both endpoints, and the Worker was nonetheless recreated in between. Every
   * pre-CORRECTION-07 gate passes.
   */
  it("69b. the SAME image on a NEW container instance BLOCKS", async () => {
    // Reads: pre-snapshot open (1), pre-snapshot close (2), post-snapshot open
    // (3). Landing the recreation on read 3 means both snapshots are internally
    // consistent and only the ENDPOINT COMPARISON can refuse it.
    const { run, world } = await runOrdinary({ recreateAfterIdReads: 2 });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /RECREATED DURING THE CASE/);
    assert.equal(run.files.has("/tmp/c.json"), false, "no record is written");
    // Prove the image genuinely never moved, so the BLOCK is attributable to
    // the epoch alone.
    assert.equal(world.live.image, IMAGE_ID);
    assert.equal(world.live.containerInstanceId, CONTAINER_C);
  });

  it("69c. shutdown pins old -> new and accepts when that instance is still current", async () => {
    const { run } = await runShutdownEpoch();
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const record = JSON.parse(run.files.get("/tmp/s.json"));
    assert.deepEqual(record.containerEpoch, {
      mode: "one-restart",
      before: CONTAINER_A,
      restartFrom: CONTAINER_A,
      restartTo: CONTAINER_B,
      after: CONTAINER_B,
    });
    // The payload's own restart evidence agrees with the pinned transition.
    const payload = record.payload.shutdownCase;
    assert.equal(payload.previousContainerInstanceId, CONTAINER_A);
    assert.equal(payload.currentContainerInstanceId, CONTAINER_B);
    assert.notEqual(payload.previousContainerInstanceId, payload.currentContainerInstanceId);
    // And the image is the SAME across the restart — the two identities are
    // independent, and both are required.
    assert.equal(record.imageContinuity.before, IMAGE_ID);
    assert.equal(record.imageContinuity.after, IMAGE_ID);
    assert.match(run.out, /pinned end to end/);
  });

  it("69d. a SECOND recreation after the observed restart BLOCKS", async () => {
    // A -> B is observed by the watcher; the Worker is then recreated as C
    // before the evidence is sealed. Image and feature state agree throughout.
    // Id reads: pre snapshot (1, 2), the watcher's before bracket (3, 4), its
    // first poll (5), its after bracket (6, 7), then the post snapshot (8, 9).
    // Landing the extra recreation on read 8 leaves the watcher's observed
    // transition intact and moves only what is current at sealing time.
    const { run, world } = await runShutdownEpoch({ recreateAfterIdReads: 7 });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /RECREATED AGAIN AFTER THE OBSERVED RESTART/);
    assert.equal(run.files.has("/tmp/s.json"), false, "no record is written");
    assert.equal(world.live.image, IMAGE_ID, "the image never moved");
    assert.equal(world.live.containerInstanceId, CONTAINER_C);
  });

  it("69d2. a recreation DURING a snapshot makes the snapshot itself unusable", async () => {
    // Read 2 is the pre-snapshot's closing check. If the instance moved between
    // the opening and closing reads, the image and feature state in that
    // snapshot do not all describe one running instance.
    const { run } = await runOrdinary({ recreateAfterIdReads: 1 });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /SNAPSHOT WAS BEING TAKEN/);
    assert.equal(run.files.has("/tmp/c.json"), false);
  });

  it("69e. an unidentifiable container instance BLOCKS", async () => {
    const { run } = await runOrdinary({ containerIdUnreadable: true });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /container instance could not be identified before the case/);
    assert.equal(run.files.has("/tmp/c.json"), false);
  });

  it("69f. the image binding is still what BLOCKS an image change", async () => {
    // The epoch model must not have displaced the SHA binding: an image change
    // on a stable container instance is still refused.
    const { run } = await runOrdinary({ imageDriftsAfterReads: 1 });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /DEPLOYED IMAGE CHANGED/);
    assert.equal(run.files.has("/tmp/c.json"), false);
  });

  it("69i. a correct transition with the WRONG feature state on the new instance BLOCKS", async () => {
    // The transition itself is exactly right — A -> B, same authorized image —
    // and the Worker comes back with generic disabled. Epoch and image
    // continuity both hold; feature continuity is the only thing that can see
    // it, and it must still be checked when the epoch is satisfied.
    const { run, world } = await runShutdownEpoch({
      ytdlpEnabledAfterRestart: null,
      sitesAfterRestart: { ytdlp: false, ytdlpInstalled: true, ytdlpEnabled: false, ffmpeg: true },
    });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /DEPLOYMENT FEATURE STATE CHANGED DURING THE CASE/);
    assert.equal(run.files.has("/tmp/s.json"), false, "no record is written");
    assert.equal(world.live.image, IMAGE_ID, "the image never moved");
    assert.equal(world.live.containerInstanceId, CONTAINER_B, "and the transition was the expected one");
  });

  it("69j. an image change across the restart still BLOCKS, epoch notwithstanding", async () => {
    const { run } = await runShutdownEpoch({ imageAfterRestart: `sha256:${"e".repeat(64)}` });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /DEPLOYED IMAGE CHANGED/);
    assert.equal(run.files.has("/tmp/s.json"), false);
  });

  it("69g. the epoch algebra, exhaustively", () => {
    const A = CONTAINER_A;
    const B = CONTAINER_B;
    const C = CONTAINER_C;
    const cont = (before, after) => ({ mode: "continuous", before, after, restartFrom: null, restartTo: null });
    const one = (before, from, to, after) => ({ mode: "one-restart", before, restartFrom: from, restartTo: to, after });

    // Ordinary cases.
    assert.equal(evaluateContainerEpoch(cont(A, A), false).ok, true);
    assert.equal(evaluateContainerEpoch(cont(A, B), false).ok, false);
    assert.match(evaluateContainerEpoch(cont(A, B), false).reason, /RECREATED DURING THE CASE/);
    assert.equal(evaluateContainerEpoch(one(A, A, B, B), false).ok, false, "an ordinary case may not span a restart");
    assert.equal(evaluateContainerEpoch(null, false).ok, false);
    assert.equal(evaluateContainerEpoch({}, false).ok, false);
    assert.equal(evaluateContainerEpoch(cont("nope", "nope"), false).ok, false, "the id grammar is enforced");

    // Shutdown.
    assert.equal(evaluateContainerEpoch(one(A, A, B, B), true).ok, true);
    assert.equal(evaluateContainerEpoch(one(A, A, B, C), true).ok, false, "a later recreation fails");
    assert.match(evaluateContainerEpoch(one(A, A, B, C), true).reason, /RECREATED AGAIN/);
    assert.equal(evaluateContainerEpoch(one(A, B, C, C), true).ok, false, "an unobserved recreation BEFORE the transition fails");
    assert.equal(evaluateContainerEpoch(one(A, A, A, A), true).ok, false, "a no-op transition is not a restart");
    assert.equal(evaluateContainerEpoch(cont(A, A), true).ok, false, "shutdown must record its restart");
    assert.equal(evaluateContainerEpoch(one(A, A, B, null), true).ok, false);

    // Coercion is never a route in: a number that stringifies correctly is not
    // an instance id (§27).
    assert.equal(evaluateContainerEpoch({ mode: "continuous", before: 1, after: 1, restartFrom: null, restartTo: null }, false).ok, false);
    assert.equal(CONTAINER_INSTANCE_PATTERN.source, "^[0-9a-f]{64}$");
    assert.equal(spansOneRestart("shutdown"), true);
    for (const name of caseNames().filter((n) => n !== "shutdown")) {
      assert.equal(spansOneRestart(name), false, `${name} may not span a restart`);
    }
  });

  it("69h. a sealed record whose epoch contradicts its own restart evidence is refused", async () => {
    const binding = { expectedSha: SHA, runningImageId: IMAGE_ID };
    const payload = {
      shutdownCase: {
        jobId: JOB_ID,
        extractor: "yt-dlp",
        transitions: ["queued", "analyzing", "downloading"],
        capturedPgid: 200,
        capturedYtdlpPid: 200,
        capturedComm: "python3",
        restartObserved: true,
        previousContainerPid: 100,
        currentContainerPid: 400,
        previousContainerInstanceId: CONTAINER_A,
        currentContainerInstanceId: CONTAINER_B,
        groupMembersMeasured: true,
        groupSurvivors: [],
        groupQueryReason: null,
        recoveredStatus: "failed",
        recoveredErrorCode: "PROCESSING_FAILED",
        recoveredSafeErrorMessage: "Worker restarted before the job completed.",
        recoveryPolls: 1,
        lateReady: false,
      },
    };

    // Truthful: accepted.
    const honest = caseRecord({ caseName: "shutdown", binding, payload });
    assert.equal(validateCaseRecord(honest, binding).ok, true);

    // The epoch claims a transition the payload does not report.
    const forged = buildCaseRecord({
      ...honest,
      caseName: "shutdown",
      binding,
      payload,
      featureState: honest.featureState,
      featureContinuity: honest.featureContinuity,
      imageContinuity: honest.imageContinuity,
      containerEpoch: {
        mode: "one-restart",
        before: CONTAINER_A,
        restartFrom: CONTAINER_A,
        restartTo: CONTAINER_C,
        after: CONTAINER_C,
      },
    });
    const verdict = validateCaseRecord(forged, binding);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /contradicts/);

    // And a record with no epoch at all is refused rather than defaulted.
    const missing = buildCaseRecord({
      caseName: "shutdown",
      binding,
      payload,
      featureState: honest.featureState,
      featureContinuity: honest.featureContinuity,
      imageContinuity: honest.imageContinuity,
    });
    assert.equal(validateCaseRecord(missing, binding).ok, false);
    assert.match(validateCaseRecord(missing, binding).reason, /container-epoch/);

    assert.deepEqual(restartEndpointsOf("cancellation", payload), {
      restartFrom: null,
      restartTo: null,
    });
  });
});

// ── CORRECTION-07 §15-§16: the run key is created ATOMICALLY ─────────────

describe("atomic run-key creation", () => {
  const enoent = () => Object.assign(new Error("no such file"), { code: "ENOENT" });
  const eexist = () => Object.assign(new Error("file already exists"), { code: "EEXIST" });

  /**
   * A filesystem in which the run key does NOT exist at `stat` time but DOES
   * exist by the time the exclusive write lands — the race the check-then-write
   * sequence could not see.
   */
  function racingAdapter({ winner } = {}) {
    const written = [];
    const chmodded = [];
    let contents = null;
    return {
      written,
      chmodded,
      get contents() {
        return contents;
      },
      deps: {
        readFile: async () => contents,
        writeFile: async (path, body, opts) => {
          written.push({ path, body, opts });
          if (opts?.flag === "wx" && contents !== null) throw eexist();
          contents = body;
        },
        mkdir: async () => {},
        chmod: async (path, mode) => chmodded.push([path, mode]),
        stat: async () => {
          if (contents === null) {
            // The loser observes ENOENT — and the winner writes immediately
            // afterwards, before this process reaches its own write.
            if (winner !== undefined) contents = winner;
            throw enoent();
          }
          return { mode: 0o600 };
        },
      },
    };
  }

  it("70. creation uses an exclusive-create flag", async () => {
    const adapter = racingAdapter();
    const created = await loadOrCreateRun("/tmp/run.json", adapter.deps);
    assert.equal(created.created, true);
    assert.equal(adapter.written.length, 1);
    assert.equal(
      adapter.written[0].opts.flag,
      "wx",
      "the create must fail rather than truncate",
    );
    assert.equal(adapter.written[0].opts.mode, 0o600);
    // The minted identity still satisfies its own admission rule.
    assert.match(created.runId, RUN_ID_PATTERN);
    assert.match(created.key, /^[0-9a-f]{64}$/);
    assert.equal(typeof created.runId, "string");
    assert.deepEqual(adapter.chmodded, [["/tmp/run.json", 0o600]], "0600 is asserted after the write");
  });

  it("70b. losing the race BLOCKS and leaves the winner byte-identical", async () => {
    const winner = `${JSON.stringify({ runId: "a1b2c3d4e5f60718", key: "c".repeat(64) }, null, 2)}\n`;
    const adapter = racingAdapter({ winner });

    const result = await loadOrCreateRun("/tmp/run.json", adapter.deps);
    assert.match(result.error, /created by another process/);
    assert.equal(result.key, undefined, "no key is handed back");
    assert.equal(result.runId, undefined, "and no run identity either");
    assert.equal(result.created, undefined, "no fresh run is reported");
    assert.equal(adapter.contents, winner, "the winner's file is byte-identical");
    assert.deepEqual(adapter.chmodded, [], "somebody else's file is never chmodded");
    assert.equal(adapter.written.length, 1, "exactly one refused attempt");
    assert.equal(adapter.written[0].opts.flag, "wx");
    // The loser must NOT silently adopt the winner's identity in the same
    // invocation: the operator inspects it and re-runs deliberately.
    assert.doesNotMatch(JSON.stringify(result), /a1b2c3d4e5f60718/);
    assert.doesNotMatch(JSON.stringify(result), /c{32}/);
  });

  it("70c. a non-EEXIST creation failure also BLOCKS, without a key", async () => {
    const result = await loadOrCreateRun("/tmp/run.json", {
      readFile: async () => null,
      writeFile: async () => {
        throw Object.assign(new Error("read-only fs"), { code: "EROFS" });
      },
      mkdir: async () => {},
      chmod: async () => {},
      stat: async () => {
        throw enoent();
      },
    });
    assert.match(result.error, /could not be created/);
    assert.match(result.error, /EROFS/);
    assert.equal(result.key, undefined);
  });

  it("70d. a run key created through the real CLI is exclusive and 0600", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/a.json"],
      LIVE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.notEqual(run.code, 3, `usage error: ${run.out}\n${run.err}`);
    const opts = run.writeOptions.get(RUN_KEY_PATH);
    assert.ok(opts, "the run key was created");
    assert.equal(opts.flag, "wx", "through an exclusive create");
    assert.equal(opts.mode, 0o600);
    assert.equal(run.modes.get(RUN_KEY_PATH), 0o600, "and 0600 is asserted after the write");
    const minted = JSON.parse(run.files.get(RUN_KEY_PATH));
    assert.equal(typeof minted.runId, "string");
    assert.match(minted.runId, RUN_ID_PATTERN);
    assert.match(minted.key, /^[0-9a-f]{64}$/);
  });

  it("70e. the CLI refuses to overwrite a run key that appears mid-run", async () => {
    // The exclusive create is what makes this observable at CLI level: the
    // `stat` reports ENOENT, and the file exists by the time the write lands.
    const world = makeFakeWorld();
    const files = new Map();
    const winner = `${JSON.stringify({ runId: "a1b2c3d4e5f60718", key: "c".repeat(64) }, null, 2)}\n`;
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/a.json"],
      LIVE_ENV(),
      {
        runReadOnly: world.runReadOnly,
        fetch: world.fetch,
        files,
        stat: async (path) => {
          if (path === RUN_KEY_PATH) {
            // Another process wins the race between this answer and the write.
            files.set(RUN_KEY_PATH, winner);
            const error = new Error(`no such file ${path}`);
            error.code = "ENOENT";
            throw error;
          }
          const error = new Error(`no such file ${path}`);
          error.code = "ENOENT";
          throw error;
        },
      },
    );
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /created by another process/);
    assert.equal(files.get(RUN_KEY_PATH), winner, "the winner's file is byte-identical");
    assert.equal(files.has("/tmp/a.json"), false, "and no evidence is written");
  });
});


// ── CORRECTION-08 §3-§7: the schema identifies the PRODUCER CONTRACT ──────

describe("evidence producer contract version", () => {
  const KEY = "a".repeat(64);
  const RUN = { runId: "0123456789abcdef", key: KEY };
  /** The identifier every artifact carried before this correction. */
  // REMEDIATION-02: the previous schema is now `10d-remediation-01` — the exact
  // version the first authenticated Stage-A run (5e6670a858543d93) sealed. That
  // record is real, authentic and retained, so this is not a hypothetical
  // boundary: a cryptographically valid artifact from before the observer
  // corrections must not authorize anything.
  const PREVIOUS_SCHEMA = "10d-remediation-01";
  /**
   * The version retired by 10D-REM-03, and the one run `132658924d1c7a1b`
   * sealed: a Stage-A PASS (23/0/0/0) and a Stage-B `success` case that
   * genuinely reached `ready`. Nothing is wrong with those artifacts — they
   * were graded by an evaluator whose lifecycle observation model has since
   * been corrected, which is exactly what this boundary exists to identify.
   */
  const RETIRED_SCHEMA = "10d-remediation-02";

  /**
   * A Stage-A record that is perfect in EVERY respect except its schema: valid
   * HMAC under the current run key, `PASS` verdict, current source SHA, current
   * image binding, same acceptance run.
   *
   * This is the artifact the correction exists for. Stage-B case records are
   * already refused structurally when a required field is missing, but Stage
   * A's shape has not changed since CORRECTION-03 — so without a version bump
   * an artifact produced by a materially weaker harness revision still
   * satisfies `loadStageA()` and AUTHORIZES CURRENT STAGE B.
   */
  const stageA = (schemaVersion) =>
    sealRecord(
      {
        harness: HARNESS_ID,
        schemaVersion,
        runId: RUN.runId,
        task: "PHASE-10D",
        stage: "A",
        verdict: "PASS",
        startedAt: "2026-09-03T00:00:00.000Z",
        expectedSha: SHA,
        runningImageId: IMAGE_ID,
        taggedImageId: IMAGE_ID,
        binding: { expectedSha: SHA, runningImageId: IMAGE_ID, taggedImageId: IMAGE_ID },
        checks: [{ id: "image.identity", outcome: "PASS", required: true, detail: "" }],
      },
      KEY,
    );

  const load = (record) =>
    loadStageA("/x", async () => JSON.stringify(record), { run: RUN, expectedSha: SHA });

  it("71. the schema identifier is the corrected Stage-A observer contract", () => {
    assert.equal(EVIDENCE_SCHEMA_VERSION, "10d-remediation-03");
    assert.notEqual(EVIDENCE_SCHEMA_VERSION, PREVIOUS_SCHEMA);
    assert.notEqual(EVIDENCE_SCHEMA_VERSION, RETIRED_SCHEMA);
    // ONE constant governs Stage A, case records and the aggregate, so they
    // cannot drift into describing different producer contracts.
    assert.equal(CASE_SCHEMA_VERSION, EVIDENCE_SCHEMA_VERSION);
  });

  it("72. the REAL sealed 10d-remediation-01 artifact can authorize nothing", async () => {
    // Not a synthetic version string: `10d-remediation-01` is what run
    // 5e6670a858543d93 actually sealed, under observers that compared against a
    // NetworkMode string Docker never emits, asked EJS for an attribute it does
    // not export, and ran a Python SyntaxError as the environment probe. The
    // version boundary rejects it independently of its FAIL verdict.
    const stale = stageA(PREVIOUS_SCHEMA);

    // The seal is genuinely good — the rejection is not an authenticity
    // failure in disguise.
    assert.equal(verifySeal(stale, KEY).ok, true, "precondition: the old artifact is authentic");

    const loaded = await load(stale);
    assert.equal(loaded.ok, false);
    assert.match(loaded.reason, new RegExp(`${PREVIOUS_SCHEMA}.*is not.*${EVIDENCE_SCHEMA_VERSION}`));
    assert.equal(loaded.binding, undefined, "and it authorizes nothing");
  });

  it("72b. the current Stage-A artifact is still accepted", async () => {
    const loaded = await load(stageA(EVIDENCE_SCHEMA_VERSION));
    assert.equal(loaded.ok, true, loaded.reason);
    assert.equal(loaded.summary.verdict, OUTCOMES.PASS);
    assert.equal(loaded.binding.runningImageId, IMAGE_ID);
  });

  it("72c. a valid old seal does not alter the result", async () => {
    // Sealed under the SAME key, so both records are equally authentic. Only
    // the producer contract differs, and only that decides.
    for (const [schema, expected] of [
      [PREVIOUS_SCHEMA, false],
      [RETIRED_SCHEMA, false],
      [EVIDENCE_SCHEMA_VERSION, true],
    ]) {
      const record = stageA(schema);
      assert.equal(verifySeal(record, KEY).ok, true, `${schema}: authentic`);
      assert.equal((await load(record)).ok, expected, `${schema}: admitted`);
    }
    // Nor does re-sealing an old-schema record with the current key rescue it:
    // the HMAC proves the artifact is unchanged, never which semantics made it.
    const resealed = sealRecord({ ...stageA(PREVIOUS_SCHEMA), authenticator: undefined }, KEY);
    delete resealed.authenticator.undefined;
    assert.equal((await load(resealed)).ok, false);
  });

  it("73. a VALID case artifact on the previous schema is rejected", async () => {
    const binding = { expectedSha: SHA, runningImageId: IMAGE_ID };
    const payload = { cancellation: cancellationEvidence() };
    const current = caseRecord({ caseName: "cancellation", binding, payload, runId: RUN.runId });

    // Current: accepted.
    assert.equal(validateCaseRecord(current, binding).ok, true);

    // The SAME record on the previous schema: refused, with the seal intact.
    const stale = sealRecord({ ...current, schemaVersion: PREVIOUS_SCHEMA }, KEY);
    assert.equal(verifySeal(stale, KEY).ok, true, "precondition: authentic");
    const verdict = validateCaseRecord(stale, binding);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, new RegExp(`${PREVIOUS_SCHEMA} is not ${EVIDENCE_SCHEMA_VERSION}`));

    // And `verifyRecord` refuses it on the same grounds, before any field of it
    // is believed.
    const verified = verifyRecord(stale, KEY, { runId: RUN.runId, expectedSha: SHA, runningImageId: IMAGE_ID });
    assert.equal(verified.ok, false);
    assert.match(verified.reason, /is not/);
  });

  it("73b. the live CLI stamps the current contract on everything it writes", async () => {
    const world = makeFakeWorld({ ytdlpEnabled: "true", sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true } });
    const run = await runCli(
      ["--stage", "B", "--case", "cancellation", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
        ...WORKER_ENV,
      }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    assert.equal(JSON.parse(run.files.get("/tmp/c.json")).schemaVersion, "10d-remediation-03");
  });
});

// ── CORRECTION-08 §8-§13: restart endpoints are coherent observations ─────

describe("restart endpoint coherence", () => {
  const ENABLED = {
    ytdlpEnabled: "true",
    sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
  };
  const epochSampler = {
    async sample() {
      return {
        sample: [
          { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[4026532001]" },
          { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: "net:[4026532001]" },
        ],
        workerPid: 100,
        ytdlpPid: 200,
        expectedNetns: "net:[4026532001]",
      };
    },
  };

  async function runShutdown(worldOptions = {}) {
    const world = makeFakeWorld({ ...ENABLED, restartAfterIdReads: 4, ...worldOptions });
    const run = await runCli(
      ["--stage", "B", "--case", "shutdown", ...LIVE_ARGS, "--evidence", "/tmp/s.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        ...WORKER_ENV,
      }),
      {
        runReadOnly: world.runReadOnly,
        fetch: world.fetch,
        files: seedRun(),
        sampler: epochSampler,
        shutdownWindowMs: 2000,
        recoveryWindowMs: 2000,
      },
    );
    return { run, world };
  }

  /** A system stub whose two runtime observers can be driven independently. */
  function fakeSystem(script) {
    let idCall = 0;
    let pidCall = 0;
    return {
      async containerInstanceId() {
        const value = script.ids[Math.min(idCall++, script.ids.length - 1)];
        return value === null
          ? { measured: false, reason: "the container is not running" }
          : { measured: true, value };
      },
      async containerPid() {
        const value = script.pids[Math.min(pidCall++, script.pids.length - 1)];
        return value === null
          ? { measured: false, reason: "the container is not running" }
          : { measured: true, value };
      },
    };
  }

  it("74. a coherent runtime observation brackets the PID with one instance", async () => {
    const observed = await observeRuntimeEpoch(
      fakeSystem({ ids: [CONTAINER_A, CONTAINER_A], pids: [100] }),
    );
    assert.deepEqual(observed, { ok: true, instanceId: CONTAINER_A, pid: 100 });
  });

  /**
   * §13, "race between old instance and old PID".
   *
   * The instance is read as A, the container is recreated, and the PID read
   * belongs to B. The pairing `container A had PID <B's pid>` describes no
   * container that ever existed.
   */
  it("74b. an instance that moves INSIDE the bracket is ambiguous, never paired", async () => {
    const observed = await observeRuntimeEpoch(
      fakeSystem({ ids: [CONTAINER_A, CONTAINER_B], pids: [400] }),
    );
    assert.equal(observed.ok, false);
    assert.match(observed.reason, /recreated while its runtime was being observed/);
    assert.equal(observed.instanceId, undefined, "no instance is reported");
    assert.equal(observed.pid, undefined, "and no PID is attributed to one");
  });

  it("74c. an unmeasurable read at any point in the bracket is a failure", async () => {
    const cases = [
      ["opening instance", { ids: [null], pids: [100] }, /could not be identified/],
      ["the PID", { ids: [CONTAINER_A], pids: [null] }, /could not be read/],
      ["closing instance", { ids: [CONTAINER_A, null], pids: [100] }, /could not be re-checked/],
    ];
    for (const [what, script, pattern] of cases) {
      const observed = await observeRuntimeEpoch(fakeSystem(script));
      assert.equal(observed.ok, false, what);
      assert.match(observed.reason, pattern, what);
    }
  });

  it("75. the watcher records the transition it actually observed", async () => {
    const { run } = await runShutdown();
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const payload = JSON.parse(run.files.get("/tmp/s.json")).payload.shutdownCase;
    assert.equal(payload.previousContainerInstanceId, CONTAINER_A);
    assert.equal(payload.currentContainerInstanceId, CONTAINER_B);
    // The PIDs are auxiliary, and each belongs to the instance beside it.
    assert.equal(payload.previousContainerPid, 100);
    assert.equal(payload.currentContainerPid, 400);
  });

  /**
   * §13, "same PID value on different instance" — the regression that makes the
   * instance the AUTHORITY rather than the PID.
   *
   * PIDs are not unique across container objects. Under PID-primary polling a
   * recreated Worker whose main process receives the same pid was INVISIBLE:
   * the watcher compared 100 to 100, saw no change, and timed out reporting
   * that no restart had happened while one plainly had.
   */
  it("76. PID REUSE cannot hide a container recreation", async () => {
    const { run } = await runShutdown({ pidAfterRestart: 100 });
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const record = JSON.parse(run.files.get("/tmp/s.json"));
    const payload = record.payload.shutdownCase;

    assert.equal(payload.previousContainerPid, 100);
    assert.equal(payload.currentContainerPid, 100, "the PID genuinely did not change");
    assert.notEqual(
      payload.previousContainerInstanceId,
      payload.currentContainerInstanceId,
      "and the recreation is still observed",
    );
    assert.equal(payload.restartObserved, true);
    assert.deepEqual(record.containerEpoch, {
      mode: "one-restart",
      before: CONTAINER_A,
      restartFrom: CONTAINER_A,
      restartTo: CONTAINER_B,
      after: CONTAINER_B,
    });
  });

  /**
   * THE CORRECTION-09 REGRESSION (§4, §8).
   *
   * The poll SUCCESSFULLY MEASURES B. The container then becomes C, and the
   * coherent endpoint settles on C.
   *
   * CORRECTION-08 recorded that as `A -> C` and asserted B was absent from the
   * record. That was wrong, and the assertion has been reversed rather than
   * relaxed: the harness did not merely fail to see an intermediate epoch, it
   * SAW one. Two distinct post-A epochs were positively measured, so no single
   * transition can be attributed to this restart — and compressing them to
   * `A -> C` would require un-seeing a measurement that was actually made.
   */
  it("77. a POSITIVELY OBSERVED intermediate epoch is a finding, not A -> C", async () => {
    // Id reads: pre snapshot (1, 2), before bracket (3, 4), poll (5) MEASURES
    // B, endpoint bracket (6, 7). The second recreation lands on read 6, so the
    // endpoint resolves coherently to C while B has already been observed.
    const { run } = await runShutdown({
      recreateAfterIdReads: 5,
      instanceAfterRecreation: CONTAINER_C,
      pidAfterRecreation: 900,
    });

    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /AN ADDITIONAL WORKER RECREATION WAS OBSERVED WHILE ESTABLISHING THE RESTART ENDPOINT/);
    assert.match(run.err, /two different container epochs were positively measured/);
    assert.equal(run.files.has("/tmp/s.json"), false, "no record is written");
    assert.doesNotMatch(run.out, /case evidence written/);

    // §10: the finding names no container id — it does not need to.
    assert.doesNotMatch(run.err, new RegExp(CONTAINER_B));
    assert.doesNotMatch(run.err, new RegExp(CONTAINER_C));
  });

  /**
   * §9, "endpoint bracket itself moves".
   *
   * The poll measures B; the endpoint bracket then reads `B -> PID -> C`, which
   * is ambiguous and retried. The retry settles coherently on C — and that
   * retry must not erase the successful B probe that preceded it.
   */
  it("77c. an endpoint RETRY cannot erase the instance the poll measured", async () => {
    // Recreation on id read 7, which is the CLOSING read of the first endpoint
    // bracket attempt: B (open) -> PID -> C (close) is ambiguous, and the retry
    // then resolves entirely against C.
    const { run, world } = await runShutdown({
      recreateAfterIdReads: 6,
      instanceAfterRecreation: CONTAINER_C,
      pidAfterRecreation: 900,
    });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /AN ADDITIONAL WORKER RECREATION WAS OBSERVED/);
    assert.equal(run.files.has("/tmp/s.json"), false, "no record is written");
    // The retry genuinely ran: pre snapshot (2) + before bracket (2) + poll (1)
    // + the AMBIGUOUS first endpoint attempt (2) + the retry (2) = 9. A path
    // without a retry would have stopped at 7.
    assert.equal(world.live.idReads, 9, "the endpoint bracket was retried");
  });

  /**
   * §9, "temporary down interval" — the other side of the §19 line.
   *
   * The container is UNAVAILABLE at the poll, so nothing is measured during the
   * gap. One coherent endpoint follows. Recording that transition discards no
   * observation, because none was made, so it remains a usable candidate — and
   * the harness claims nothing about what may have existed in the interval.
   */
  it("77d. an UNOBSERVED interval is not invented into an intermediate epoch", async () => {
    const { run, world } = await runShutdown({
      // Id read 5 finds the container gone; the restart has landed by read 6.
      idUnreadableAtReads: [5],
      restartAfterIdReads: 5,
    });
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    // The stop half was genuinely served, and the watcher treated it as
    // information rather than as a failure — a watcher that threw on an
    // unmeasurable probe could not have reached a PASS here.
    assert.equal(world.live.downReadsServed, 1, "the container was observed down");
    const record = JSON.parse(run.files.get("/tmp/s.json"));
    const payload = record.payload.shutdownCase;

    assert.equal(payload.previousContainerInstanceId, CONTAINER_A);
    assert.equal(payload.currentContainerInstanceId, CONTAINER_B);
    assert.deepEqual(record.containerEpoch, {
      mode: "one-restart",
      before: CONTAINER_A,
      restartFrom: CONTAINER_A,
      restartTo: CONTAINER_B,
      after: CONTAINER_B,
    });
    // The stop half was seen, and that is all the gap is reported as.
    assert.equal(payload.restartObserved, true);
  });

  it("77b. an endpoint that never settles is a measurement failure", async () => {
    // The container is recreated on EVERY id read, so no bracket can ever close
    // on one instance. Bounded retries, then BLOCKED — never a pairing accepted
    // on the last attempt.
    let ids = 0;
    const world = makeFakeWorld(ENABLED);
    const run = await runCli(
      ["--stage", "B", "--case", "shutdown", ...LIVE_ARGS, "--evidence", "/tmp/s.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        ...WORKER_ENV,
      }),
      {
        runReadOnly: async (file, argv) => {
          if (file === "docker" && argv[0] === "inspect" && argv.join(" ").includes("{{.Id}}")) {
            // A fresh, valid, DIFFERENT instance every single time.
            ids += 1;
            return { exitCode: 0, stdout: `${ids.toString(16).padStart(64, "0")}\n`, stderr: "" };
          }
          return world.runReadOnly(file, argv);
        },
        fetch: world.fetch,
        files: seedRun(),
        sampler: epochSampler,
        shutdownWindowMs: 2000,
        recoveryWindowMs: 2000,
      },
    );
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.equal(run.files.has("/tmp/s.json"), false, "no record is written");
  });

  it("78. an additional observed recreation after the transition still BLOCKS", async () => {
    // Unchanged CORRECTION-07 behaviour: the outer bracketed snapshots catch a
    // recreation that lands after the watcher's accepted transition.
    const { run, world } = await runShutdown({ recreateAfterIdReads: 7 });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /RECREATED AGAIN AFTER THE OBSERVED RESTART/);
    assert.equal(run.files.has("/tmp/s.json"), false);
    assert.equal(world.live.image, IMAGE_ID, "the image never moved");
  });

  /**
   * §13, "race between old instance and old PID", in full.
   *
   * The restart lands on the FIRST PID read — inside the watcher's
   * `id -> pid -> id` bracket — so a sequential reader would record
   * `container A had PID 400`, a pairing describing no container that ever
   * existed. A second recreation then gives the watcher a transition to
   * observe, which is what makes the recorded old endpoint visible.
   *
   * Id reads: pre snapshot (1, 2); bracket attempt 1 (3 = A, then PID → the
   * restart, then 4 = B → AMBIGUOUS); retry (5, 6 = B → coherent); poll (7).
   */
  it("79. a restart inside the before-bracket cannot pair A with B's PID", async () => {
    const { run } = await runShutdown({
      restartAfterIdReads: null,
      restartAfterPidReads: 0,
      recreateAfterIdReads: 6,
      instanceAfterRecreation: CONTAINER_C,
      pidAfterRecreation: 900,
    });

    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.equal(run.files.has("/tmp/s.json"), false, "no record is written");

    // THE PROOF. The bracket retried and settled coherently on B, so the
    // watcher's old endpoint is B — not A, and never A carrying B's PID. The
    // outer epoch check then catches that the case did not BEGIN in that epoch,
    // which is the honest description of what happened.
    assert.match(
      run.err,
      /the container instance the case began on is not the instance the observed restart replaced/,
    );
    assert.match(run.err, /an unobserved recreation happened before the transition/);
    assert.doesNotMatch(run.out, /case evidence written/);
  });

  it("79b. an ambiguous bracket that never settles times out rather than pairing", async () => {
    // The same opening race, with no second transition to observe. The watcher
    // retries, settles on B, and finds no further change — so it reports that
    // no restart was observed rather than inventing the A -> B one it never saw
    // coherently from A's side.
    const { run } = await runShutdown({ restartAfterIdReads: null, restartAfterPidReads: 0 });
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /no Worker restart was observed/);
    assert.equal(run.files.has("/tmp/s.json"), false);
  });
});

// ── Suite safety ───────────────────────────────────────────────────────────

describe("test-suite safety", () => {
  it("20. no live run happens as part of `npm test`", () => {
    assert.notEqual(process.env[LIVE_ENV_NAME], "1", `${LIVE_ENV_NAME} must not be set during tests`);
    assert.equal(evaluateLiveGate(process.argv.slice(2), process.env).live, false);
  });

  it("20b. importing the CLI module does not execute it", async () => {
    const again = await import("../deploy/acceptance/ytdlp-generic/acceptance.mjs");
    assert.equal(typeof again.main, "function");
  });

  it("20c. option parsing does not swallow the next flag as a value", () => {
    assert.equal(readOption(["--base-url", "--live"], "--base-url"), null);
    assert.equal(readOption(["--base-url", "https://x.invalid"], "--base-url"), "https://x.invalid");
    assert.deepEqual(readOptionList(["--case-evidence", "a.json", "b.json", "--live"], "--case-evidence"), [
      "a.json",
      "b.json",
    ]);
    assert.deepEqual(readOptionList([], "--case-evidence"), []);
  });
});

// ── PHASE-10D-BLOCKER-REMEDIATION-01: the durable-state observer ───────────
//
// The original observer named a database file, a table and an executable the
// deployment does not have. CORRECTION-01 then found that reading from the
// HOST with `node:sqlite` traded one unmet prerequisite for another — the Lima
// host is Node v18.19.1 — so the read now happens inside the Worker container,
// on the runtime that ships with the reviewed image.
//
// Two properties are load-bearing and are tested structurally, not by fake:
// `docker exec` must not become general remote execution, and a row that is
// PROVABLY ABSENT is a measurement, not an inability to look.

describe("durable-state observer (10D-REM-01)", () => {
  const OTHER_JOB_ID = "ab".repeat(16);

  it("70. the database identity is the Worker's, cross-checked against its source", () => {
    assert.equal(WORKER_STATE_DB, "/var/lib/videofetch/worker.sqlite");
    assert.equal(WORKER_STATE_DIRECTORY, "/var/lib/videofetch");
    assert.equal(WORKER_DATABASE_FILENAME, "worker.sqlite");
    assert.equal(WORKER_JOBS_TABLE, "worker_jobs");

    // PROVEN against the contracts that define them. The harness cannot import
    // these constants (standalone `.mjs`, no TypeScript loader), so every
    // restatement is checked rather than trusted.
    assert.match(STATE_DIRECTORY_SOURCE, /export const WORKER_DATABASE_FILENAME = "worker\.sqlite";/);
    assert.ok(STATE_DIRECTORY_SOURCE.includes(`"${WORKER_DATABASE_FILENAME}"`));
    assert.match(MIGRATIONS_SOURCE, new RegExp(`CREATE TABLE ${WORKER_JOBS_TABLE} \\(`));
    for (const column of DURABLE_SAFE_COLUMNS) {
      assert.match(WORKER_JOBS_DDL, new RegExp(`\\b${column}\\b`), `${column} must exist in the schema`);
    }
    // The column that must never be projected has to exist for its omission to
    // mean anything.
    assert.match(WORKER_JOBS_DDL, /\burl\b/);
  });

  it("70a. the retired identifiers survive only as history, never as code", () => {
    const harnessDir = join(REPO_ROOT, "deploy/acceptance/ytdlp-generic");
    const sources = [
      "acceptance.mjs",
      ...["observers", "cases", "coverage", "stage-a", "stage-b", "evidence", "provenance"].map(
        (name) => `lib/${name}.mjs`,
      ),
    ];
    const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
    for (const relative of sources) {
      readFileSync(join(harnessDir, relative), "utf8")
        .split("\n")
        .forEach((line, index) => {
          for (const [pattern, what] of [
            [/videofetch\.db/, "the retired videofetch.db path"],
            [/\bFROM jobs\b/, "the retired bare jobs table"],
          ]) {
            if (!pattern.test(line)) continue;
            assert.ok(isCommentLine(line), `${relative}:${index + 1} references ${what} in code`);
          }
        });
    }
  });

  // ── The host requires nothing new ────────────────────────────────────────

  it("71. the production observer never imports node:sqlite on the host", () => {
    const observerSource = readFileSync(
      join(REPO_ROOT, "deploy/acceptance/ytdlp-generic/lib/observers.mjs"),
      "utf8",
    );
    // The ONLY `node:sqlite` outside a comment is inside the probe source
    // string, which runs in the container. A host-side import would reintroduce
    // the Node >= 22.5 prerequisite this correction exists to remove.
    for (const [index, line] of observerSource.split("\n").entries()) {
      if (!/node:sqlite/.test(line)) continue;
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
      const isProbeString = /^\s*'/.test(line);
      assert.ok(isComment || isProbeString, `observers.mjs:${index + 1} imports node:sqlite on the host`);
    }
    assert.doesNotMatch(observerSource, /^import .*node:sqlite/m);
    assert.doesNotMatch(observerSource, /await import\("node:sqlite"\)/);
  });

  it("71a. the harness exposes no host database path and opens no database", () => {
    // §11: the production CLI must carry no operator- or test-selectable
    // database seam. A path that can be pointed somewhere is a path an operator
    // can point at an answer they prefer.
    for (const relative of ["acceptance.mjs", "lib/observers.mjs", "lib/cases.mjs"]) {
      const text = readFileSync(join(REPO_ROOT, "deploy/acceptance/ytdlp-generic", relative), "utf8");
      assert.ok(!/databasePath/.test(text), `${relative} must expose no databasePath seam`);
    }
  });

  // ── The command boundary is structural ───────────────────────────────────

  it("72. exactly one durable-probe command shape is admissible", () => {
    const argv = durableProbeArgv("videofetch-worker", JOB_ID);
    assert.deepEqual(argv, [
      "exec",
      "videofetch-worker",
      "/usr/local/bin/node",
      "-e",
      DURABLE_PROBE_SOURCE,
      JOB_ID,
    ]);
    assert.equal(isReadOnlyCommand("docker", argv), true);
    assert.equal(WORKER_NODE_PATH, "/usr/local/bin/node");
  });

  it("72a. every neighbouring shape is refused before a process is spawned", () => {
    const ok = durableProbeArgv("videofetch-worker", JOB_ID);
    const refused = [
      // Arbitrary Node execution — the whole point of matching the source whole.
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "-e", "require('fs').readFileSync('/etc/videofetch/worker.env')", JOB_ID],
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "--eval", DURABLE_PROBE_SOURCE, JOB_ID],
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "-e", `${DURABLE_PROBE_SOURCE};process.stdout.write("x")`, JOB_ID],
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE.replace("worker_jobs", "jobs"), JOB_ID],
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE.replace("worker.sqlite", "videofetch.db"), JOB_ID],
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE.replace("job_id, status, format_id, extractor", "*"), JOB_ID],
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE.replace("job_id, status, format_id, extractor", "job_id, url"), JOB_ID],
      // A different interpreter, or a shell.
      ["exec", "videofetch-worker", "/bin/sh", "-c", DURABLE_PROBE_SOURCE, JOB_ID],
      ["exec", "videofetch-worker", "node", "-e", DURABLE_PROBE_SOURCE, JOB_ID],
      ["exec", "videofetch-worker", "/usr/bin/env", WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE],
      ["exec", "videofetch-worker", "../../usr/local/bin/node", "-e", DURABLE_PROBE_SOURCE, JOB_ID],
      // Argument-shape drift.
      [...ok, "--extra"],
      ok.slice(0, 5),
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE, JOB_ID.toUpperCase()],
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE, "'; DROP TABLE worker_jobs;--"],
      ["exec", "videofetch-worker", WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE, "../../etc/passwd"],
      ["exec", "videofetch worker", WORKER_NODE_PATH, "-e", DURABLE_PROBE_SOURCE, JOB_ID],
    ];
    for (const argv of refused) {
      assert.equal(isReadOnlyCommand("docker", argv), false, `must refuse: ${argv[2]} ${argv[3]}`);
    }
    // And the constructor refuses to build a bad one at all.
    assert.throws(() => durableProbeArgv("videofetch-worker", "nope"), /malformed job id/);
    assert.throws(() => durableProbeArgv("bad name", JOB_ID), /malformed container name/);
  });

  it("72b. the probe source is the fixed, safe question", () => {
    assert.ok(DURABLE_PROBE_SOURCE.includes('"/var/lib/videofetch/worker.sqlite"'));
    assert.ok(DURABLE_PROBE_SOURCE.includes("SELECT job_id, status, format_id, extractor FROM worker_jobs WHERE job_id = ?"));
    assert.ok(DURABLE_PROBE_SOURCE.includes("readOnly:true"));
    assert.doesNotMatch(DURABLE_PROBE_SOURCE, /SELECT \*/);
    assert.doesNotMatch(DURABLE_PROBE_SOURCE, /\burl\b/, "the URL is never selected");
    assert.doesNotMatch(DURABLE_PROBE_SOURCE, /child_process|readFileSync|process\.env|require\("fs"\)/);
    // No raw error text may cross the boundary: every catch is bare.
    assert.doesNotMatch(DURABLE_PROBE_SOURCE, /catch\s*\(/, "the probe must not bind an error object");
    assert.doesNotMatch(DURABLE_PROBE_SOURCE, /e\.message|\.stack/);
  });

  // ── The response contract ────────────────────────────────────────────────

  it("73. a present row is measured, and an absent row is measured too", async () => {
    const present = await makeSystemObservers({
      runReadOnly: makeFakeWorld().runReadOnly,
    }).durableJobRow(JOB_ID);
    assert.equal(present.measured, true);
    assert.deepEqual(present.value, {
      present: true,
      jobId: JOB_ID,
      status: "ready",
      formatId: "preset:720",
      extractor: "yt-dlp",
    });

    // The probe RAN and proved the row is not there. That is a measurement.
    const absent = await makeSystemObservers({
      runReadOnly: makeFakeWorld({ durableRowAbsent: true }).runReadOnly,
    }).durableJobRow(JOB_ID);
    assert.equal(absent.measured, true, "a proven absence is a measurement, not a gap");
    assert.deepEqual(absent.value, {
      present: false,
      jobId: JOB_ID,
      status: null,
      formatId: null,
      extractor: null,
    });
  });

  it("73a. every unreadable condition is unmeasured, and they stay distinguishable", async () => {
    const cases = [
      ["database-open-failed", /could not be opened read-only/],
      ["query-failed", /the durable query failed/],
      ["probe-runtime-failed", /could not run inside the Worker/],
      ["malformed", /was not valid JSON/],
      ["process-failed", /did not run inside the Worker container/],
    ];
    for (const [durableProbe, expected] of cases) {
      const observed = await makeSystemObservers({
        runReadOnly: makeFakeWorld({ durableProbe }).runReadOnly,
      }).durableJobRow(JOB_ID);
      assert.equal(observed.measured, false, `${durableProbe} must be unmeasured`);
      assert.match(observed.reason, expected);
      // None of them may be confused with a proven absence.
      assert.ok(!/row is absent|no worker_jobs row/.test(observed.reason), durableProbe);
    }
  });

  it("73b. the parser refuses anything it cannot fully account for", () => {
    const good = { kind: "row", jobId: JOB_ID, status: "ready", formatId: "preset:720", extractor: "yt-dlp" };
    assert.equal(parseDurableProbeResponse(JSON.stringify(good), JOB_ID).present, true);
    assert.equal(parseDurableProbeResponse(JSON.stringify({ kind: "absent", jobId: JOB_ID }), JOB_ID).present, false);

    const refused = [
      ["", /produced no response/],
      ["not json", /not valid JSON/],
      ["[]", /not an object/],
      ["null", /not an object/],
      [JSON.stringify({ kind: "mystery" }), /unknown kind/],
      [JSON.stringify({ ...good, url: "https://leak" }), /did not match the projected columns/],
      [JSON.stringify({ kind: "row", jobId: JOB_ID, status: "ready", formatId: "p" }), /did not match the projected columns/],
      [JSON.stringify({ ...good, jobId: OTHER_JOB_ID }), /a different job/],
      [JSON.stringify({ ...good, status: 7 }), /carried no status/],
      [JSON.stringify({ kind: "absent", jobId: OTHER_JOB_ID }), /a different job/],
      [JSON.stringify({ kind: "absent", jobId: JOB_ID, extra: 1 }), /unknown fields/],
      [JSON.stringify({ kind: "error", code: "made-up" }), /unknown failure class/],
      ["x".repeat(DURABLE_PROBE_MAX_STDOUT + 1), /exceeded its size bound/],
    ];
    for (const [stdout, expected] of refused) {
      assert.throws(() => parseDurableProbeResponse(stdout, JOB_ID), expected, stdout.slice(0, 40));
    }
    // Every advertised failure class maps to a sanitized reason.
    for (const code of Object.keys(DURABLE_PROBE_ERROR_CODES)) {
      assert.throws(
        () => parseDurableProbeResponse(JSON.stringify({ kind: "error", code }), JOB_ID),
        new RegExp(DURABLE_PROBE_ERROR_CODES[code].slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  });

  // ── Row absence is a FAIL, not a BLOCKED ─────────────────────────────────

  it("74. a proven-absent row FAILS row-presence and BLOCKS only the content claims", () => {
    const absent = measured({ present: false, jobId: JOB_ID, status: null, formatId: null, extractor: null });

    const presence = measuredCheck("durable.row-present", absent, (v) => v?.present === true, "row", {});
    assert.equal(presence.outcome, OUTCOMES.FAIL, "a measured absence is a FAIL");

    // The content claims report that there is no row to judge — one finding,
    // stated once, rather than three derived restatements of it.
    const content = rowContentObservation(absent);
    assert.equal(content.measured, false);
    assert.match(content.reason, /the durable row is absent/);
    assert.equal(
      measuredCheck("durable.extractor-is-ytdlp", content, (v) => v?.extractor === "yt-dlp", "x", {}).outcome,
      OUTCOMES.BLOCKED,
    );

    // A present row passes straight through unchanged.
    const present = measured({ present: true, jobId: JOB_ID, status: "ready", formatId: "preset:720", extractor: "yt-dlp" });
    assert.equal(rowContentObservation(present), present);
    assert.equal(
      measuredCheck("durable.row-present", present, (v) => v?.present === true, "row", {}).outcome,
      OUTCOMES.PASS,
    );

    // An unmeasured observation stays unmeasured — never upgraded to a finding.
    const gap = unmeasured("the durable probe did not run inside the Worker container");
    assert.equal(rowContentObservation(gap), gap);
    assert.equal(
      measuredCheck("durable.row-present", gap, (v) => v?.present === true, "row", {}).outcome,
      OUTCOMES.BLOCKED,
    );
  });

  it("74a. a Stage B run with an absent durable row is FAIL, not BLOCKED", () => {
    const base = passingStageBObservations();
    const result = evaluateStageB(
      {
        ...base,
        durableJobRow: measured({ present: false, jobId: JOB_ID, status: null, formatId: null, extractor: null }),
      },
      passingStageA(),
    );
    const byId = (id) => result.checks.find((entry) => entry.id === id);
    assert.equal(byId("durable.row-present").outcome, OUTCOMES.FAIL);
    // The content claims report "no row to judge" rather than three derived
    // restatements of the same finding.
    for (const id of [
      "durable.extractor-is-ytdlp",
      "durable.application-format-id",
      "durable.no-raw-selector-fields",
    ]) {
      assert.equal(byId(id).outcome, OUTCOMES.BLOCKED, id);
      assert.match(byId(id).detail, /the durable row is absent/);
    }
    assert.equal(result.summary.verdict, OUTCOMES.FAIL, "FAIL outranks the BLOCKED content checks");

    // The control: the same run with the row present passes all four.
    const clean = evaluateStageB(base, passingStageA());
    for (const id of [
      "durable.row-present",
      "durable.extractor-is-ytdlp",
      "durable.application-format-id",
      "durable.no-raw-selector-fields",
    ]) {
      assert.equal(clean.checks.find((e) => e.id === id).outcome, OUTCOMES.PASS, id);
    }
  });

  // ── Privacy ──────────────────────────────────────────────────────────────

  it("75. a sentinel in the durable URL reaches no surface the harness produces", async () => {
    const sentinel = "VF_ACCEPT_SECRET_durable_url_must_not_leak";
    // The projection excludes `url` at SQL time, so a compliant probe never has
    // the sentinel to emit. Prove that against a REAL database, using the exact
    // statement the probe runs.
    const { databasePath } = makeDurableDatabase([
      {
        jobId: JOB_ID,
        status: "ready",
        formatId: "preset:720",
        extractor: "yt-dlp",
        url: `https://example.invalid/watch?token=${sentinel}`,
      },
    ]);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const projected = db.prepare(DURABLE_JOB_QUERY).get(JOB_ID);
    const stored = db.prepare("SELECT url FROM worker_jobs WHERE job_id = ?").get(JOB_ID);
    db.close();
    assert.ok(String(stored.url).includes(sentinel), "the fixture must genuinely carry the sentinel");
    assert.ok(!JSON.stringify(projected).includes(sentinel), "the projection must not carry it");
    assert.ok(!("url" in projected));

    // And nothing downstream reintroduces it: observation, record and evidence.
    const world = makeFakeWorld();
    const observed = await makeSystemObservers({ runReadOnly: world.runReadOnly }).durableJobRow(JOB_ID);
    assert.ok(!JSON.stringify(observed).includes(sentinel));

    const enabled = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const run = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/case-success.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
        ...WORKER_ENV,
      }),
      { runReadOnly: enabled.runReadOnly, fetch: enabled.fetch, files: seedRun() },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const everything = [run.out, run.err, ...run.files.values()].join("\n");
    assert.ok(!everything.includes(sentinel), "no console, error, record or evidence surface may carry it");
  });

  // ── SQLite semantics, against real databases ─────────────────────────────
  //
  // These exercise the exact statement and open options the in-container probe
  // uses. The helper is test-only and unreachable from the production CLI.

  it("76. the read-only open rejects writes and never creates a missing database", () => {
    const { databasePath, dir } = makeDurableDatabase([
      { jobId: JOB_ID, status: "ready", formatId: "preset:720", extractor: "yt-dlp" },
    ]);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare(DURABLE_JOB_QUERY).get(JOB_ID).status, "ready");
    assert.throws(() => db.exec("UPDATE worker_jobs SET status = 'cancelled'"), /readonly|read-only/i);
    db.close();

    const missing = join(dir, "absent.sqlite");
    assert.throws(() => new DatabaseSync(missing, { readOnly: true }));
    assert.equal(existsSync(missing), false, "a missing durable database must not be created");
  });

  it("77. a live WAL database is read without copying it", () => {
    const { databasePath, db, dir } = makeDurableDatabase(
      [{ jobId: JOB_ID, status: "downloading", formatId: "preset:720", extractor: "yt-dlp" }],
      { wal: true, keepOpen: true },
    );
    try {
      assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.ok(existsSync(`${databasePath}-wal`), "the -wal sidecar must be present");

      // A committed write from the still-open writer must be what the reader sees.
      db.prepare("UPDATE worker_jobs SET status = ? WHERE job_id = ?").run("ready", JOB_ID);
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(reader.prepare(DURABLE_JOB_QUERY).get(JOB_ID).status, "ready");
      reader.close();

      const stray = readdirSync(dir).filter((name) => !name.startsWith(WORKER_DATABASE_FILENAME));
      assert.deepEqual(stray, [], "the reader must not copy the database anywhere");
    } finally {
      db.close();
    }
  });
});

// ── CORRECTION-08: acceptance artifacts are append-only by path ─────────────
//
// Discovered immediately after the `10d-remediation-02` Stage A PASS
// (`a9ce1c400db8d817`): a dry run handed `--evidence` wrote a BLOCKED stub to
// that path, and every live producer sealed its record with an ordinary
// `writeFile`, which truncates whatever is already there. Together those made
// the single artifact the whole staged programme depends on silently
// destroyable — by a mistyped path, a repeated command, or a second operator.
//
// The run key has been fail-closed since CORRECTION-05. These tests hold the
// evidence artifacts to the same standard.

describe("acceptance evidence immutability (CORRECTION-08)", () => {
  const OCCUPIED = "/tmp/occupied-evidence.json";
  const SENTINEL = '{"pre-existing":"operator bytes that must survive"}';

  it("78. a dry run writes no evidence file even when --evidence is supplied", async () => {
    const run = await runCli(["--stage", "A", "--evidence", "/tmp/dry-a.json"], {});
    assert.equal(run.code, 2);
    assert.match(run.out, /LIVE EXECUTION REFUSED/);
    // The refusal is explained on the console; nothing reaches the filesystem.
    assert.equal(run.files.has("/tmp/dry-a.json"), false, "a dry run must create no evidence file");
    assert.equal(run.files.size, 0, "a dry run must not touch the filesystem at all");
  });

  it("78b. every dry-run subcommand is observational", async () => {
    for (const argv of [
      ["--stage", "A"],
      ["--stage", "B", "--case", "success"],
      ["--stage", "B", "--aggregate"],
    ]) {
      const run = await runCli([...argv, "--evidence", "/tmp/dry-sub.json"], {});
      assert.equal(run.code, 2, `${argv.join(" ")} must dry-run`);
      assert.equal(run.files.size, 0, `${argv.join(" ")} must write nothing`);
    }
  });

  it("79. a dry run leaves pre-existing bytes at the evidence path exactly unchanged", async () => {
    const files = new Map([[OCCUPIED, SENTINEL]]);
    const run = await runCli(["--stage", "A", "--evidence", OCCUPIED], {}, { files });
    assert.equal(run.code, 2);
    assert.equal(run.files.get(OCCUPIED), SENTINEL, "the operator's bytes must be byte-identical");
  });

  it("80. live Stage A refuses an occupied evidence path BEFORE creating the direct job", async () => {
    const world = makeFakeWorld();
    const files = new Map([[OCCUPIED, SENTINEL]]);
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", OCCUPIED],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /EVIDENCE PATH ALREADY EXISTS/);
    assert.equal(run.files.get(OCCUPIED), SENTINEL, "the existing artifact must be untouched");
    // The gate is EARLY: no acceptance job may have been created.
    assert.ok(
      !world.calls.fetches.includes("POST /api/download"),
      "no direct-media job may be created when the evidence path is occupied",
    );
    // And no acceptance run may be minted for a run that cannot record itself.
    assert.equal(run.files.has(RUN_KEY_PATH), false, "no run key may be created");
  });

  it("81. a Stage B case refuses an occupied evidence path BEFORE the producer runs", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const files = seedRun(new Map([[OCCUPIED, SENTINEL]]));
    const run = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", OCCUPIED],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        ...WORKER_ENV,
      }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /EVIDENCE PATH ALREADY EXISTS/);
    assert.equal(run.files.get(OCCUPIED), SENTINEL);
    assert.ok(
      !world.calls.fetches.includes("POST /api/download"),
      "the case producer must not run when the evidence path is occupied",
    );
  });

  it("82. Stage B aggregation refuses an occupied output artifact", async () => {
    const world = makeFakeWorld();
    const files = seedRun(new Map([[OCCUPIED, SENTINEL]]));
    const run = await runCli(
      ["--stage", "B", "--aggregate", ...LIVE_ARGS, "--evidence", OCCUPIED],
      LIVE_ENV(),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /EVIDENCE PATH ALREADY EXISTS/);
    assert.equal(run.files.get(OCCUPIED), SENTINEL, "the existing artifact must be untouched");
  });

  it("83. a file appearing AFTER the preflight loses the final exclusive create", async () => {
    const world = makeFakeWorld();
    // The winner's bytes are already present, but `lstat` reports ENOENT — the
    // exact shape of a file created inside the gate-to-seal window.
    const files = new Map([[OCCUPIED, SENTINEL]]);
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", OCCUPIED],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      {
        runReadOnly: world.runReadOnly,
        fetch: world.fetch,
        files,
        lstat: async (path) => {
          if (path === OCCUPIED) {
            const error = new Error(`no such file ${path}`);
            error.code = "ENOENT";
            throw error;
          }
          const error = new Error(`no such file ${path}`);
          error.code = "ENOENT";
          throw error;
        },
      },
    );
    assert.equal(run.code, 2, `expected BLOCKED, got:\n${run.out}\n${run.err}`);
    assert.match(run.err, /EVIDENCE PATH ALREADY EXISTS/);
    // Losing the race NEVER adopts, truncates, unlinks or retries.
    assert.equal(run.files.get(OCCUPIED), SENTINEL, "the winner's artifact must be untouched");
    assert.doesNotMatch(run.err, /retry/i);
  });

  it("84. an unused evidence path still seals and writes normally", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/fresh-stage-a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);
    const record = JSON.parse(run.files.get("/tmp/fresh-stage-a.json"));
    assert.equal(record.verdict, "PASS");
    assert.equal(record.schemaVersion, EVIDENCE_SCHEMA_VERSION);
    assert.equal(record.harness, HARNESS_ID);
    // The creation must have been exclusive, not an ordinary overwrite.
    assert.equal(run.writeOptions.get("/tmp/fresh-stage-a.json")?.flag, "wx");
  });

  it("85. a sealed remediation-03 Stage A PASS is still admitted by loadStageA()", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/admissible-stage-a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);

    const sealed = run.files.get("/tmp/admissible-stage-a.json");
    assert.equal(JSON.parse(sealed).schemaVersion, "10d-remediation-03");
    const key = JSON.parse(run.files.get(RUN_KEY_PATH));

    // Exactly what the eventual Stage B aggregation does with the artifact the
    // accepted run left behind: this correction must not have changed what a
    // FRESHLY SEALED PASS means. The version boundary retires OLD artifacts; it
    // must never make the harness unable to admit its own current output.
    const loaded = await loadStageA("/tmp/admissible-stage-a.json", async () => sealed, {
      run: { runId: key.runId, key: key.key },
      expectedSha: SHA,
    });
    assert.equal(loaded.ok, true, loaded.reason);
    assert.equal(loaded.summary.verdict, "PASS");
    assert.equal(loaded.binding.expectedSha, SHA);
  });

  it("86. a SYMLINK occupying the evidence path is occupied, not followed", async () => {
    const world = makeFakeWorld();
    // Present to `lstat`, absent to `readFile` — a dangling symlink.
    const links = new Set([OCCUPIED]);
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", OCCUPIED],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, links },
    );
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /EVIDENCE PATH ALREADY EXISTS/);
    assert.equal(run.files.has(OCCUPIED), false, "the link target must not be written through");
  });

  it("87. an unmeasurable evidence path fails closed rather than proceeding", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", OCCUPIED],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      {
        runReadOnly: world.runReadOnly,
        fetch: world.fetch,
        lstat: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      },
    );
    assert.equal(run.code, 2, `${run.out}\n${run.err}`);
    assert.match(run.err, /evidence path/i);
    assert.ok(!world.calls.fetches.includes("POST /api/download"));
  });
});

// ── CORRECTION-08.1: a live command must NAME its destination ──────────────
//
// CORRECTION-08 made an artifact impossible to overwrite. It left the other
// half open: `--evidence` was still OPTIONAL for a live run, and the Stage B
// case producer only checked for it AFTER it had already run. An operator who
// forgot the flag got a real generic job, a real cancellation or a real Worker
// restart — and then a usage error instead of a record.
//
// A missing filename is not a free filename. For a production-changing case it
// is the absence of authorization to execute the case at all.

describe("live acceptance requires a durable destination (CORRECTION-08.1)", () => {
  it("88. live Stage A without --evidence refuses before ANY live work", async () => {
    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.equal(run.code, 3, `usage failure expected:\n${run.out}\n${run.err}`);
    assert.match(run.err, /--evidence <path> is required for a live acceptance command/);

    assert.equal(world.calls.logins, 0, "no login");
    assert.equal(world.calls.fetches.length, 0, "no product request, no direct job");
    assert.equal(world.calls.commands.length, 0, "no system observation");
    assert.equal(run.files.size, 0, "no run key, no filesystem mutation");
    assert.doesNotMatch(run.out, /VERDICT/);
  });

  it("89. a live Stage B case without --evidence never enters the producer", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const files = seedRun();
    const run = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
        ...WORKER_ENV,
      }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );
    assert.equal(run.code, 3, `${run.out}\n${run.err}`);
    assert.match(run.err, /--evidence <path> is required/);
    assert.equal(world.calls.logins, 0, "no login");
    assert.equal(world.calls.fetches.length, 0, "no generic job, no product request");
    assert.equal(world.calls.commands.length, 0, "no pre-case deployment snapshot");
    // Only the seeded run key remains; nothing was written.
    assert.deepEqual([...run.files.keys()], [RUN_KEY_PATH]);
  });

  it("90. EVERY executable case producer is gated on --evidence", async () => {
    // Table-driven over the real producer registry, so a case added later
    // cannot quietly escape the gate.
    for (const name of liveCaseNames()) {
      const world = makeFakeWorld({
        ytdlpEnabled: "true",
        sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
      });
      const run = await runCli(
        ["--stage", "B", "--case", name, ...LIVE_ARGS],
        LIVE_ENV({
          VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
          VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
          ...WORKER_ENV,
        }),
        { runReadOnly: world.runReadOnly, fetch: world.fetch, files: seedRun() },
      );
      assert.equal(run.code, 3, `${name} must refuse:\n${run.out}\n${run.err}`);
      assert.match(run.err, /--evidence <path> is required/, name);
      // No cancellation, no restart choreography, no fixture transfer, no
      // deny-counter read — the producer was never entered.
      assert.equal(world.calls.fetches.length, 0, `${name}: made a product request`);
      assert.equal(world.calls.commands.length, 0, `${name}: ran a system command`);
      assert.equal(world.calls.logins, 0, `${name}: logged in`);
    }
  });

  it("91. a live aggregate without --evidence refuses before reading any artifact", async () => {
    const world = makeFakeWorld();
    const reads = [];
    const files = seedRun(new Map([["/tmp/sa.json", "{}"], ["/tmp/case.json", "{}"]]));
    const run = await runCli(
      [
        "--stage", "B", "--aggregate", ...LIVE_ARGS,
        "--stage-a", "/tmp/sa.json",
        "--case-evidence", "/tmp/case.json",
      ],
      LIVE_ENV(),
      {
        runReadOnly: world.runReadOnly,
        fetch: world.fetch,
        files,
        readFile: async (path) => {
          reads.push(path);
          if (files.has(path)) return files.get(path);
          throw new Error(`no such file ${path}`);
        },
      },
    );
    assert.equal(run.code, 3, `${run.out}\n${run.err}`);
    assert.match(run.err, /--evidence <path> is required/);
    // The Stage B verdict is the final durable acceptance result; it may never
    // be announced without a sealed artifact.
    assert.doesNotMatch(run.out, /VERDICT/);
    assert.deepEqual(reads, [], "no Stage-A or case artifact may be read first");
    assert.equal(world.calls.logins, 0);
  });

  it("92. dry runs still never require --evidence", async () => {
    for (const argv of [
      ["--stage", "A"],
      ["--stage", "B", "--case", "success"],
      ["--stage", "B", "--aggregate"],
    ]) {
      const world = makeFakeWorld();
      const run = await runCli(argv, {}, { runReadOnly: world.runReadOnly, fetch: world.fetch });
      assert.equal(run.code, 2, `${argv.join(" ")} must BLOCK as a dry run, not fail usage`);
      assert.match(run.out, /LIVE EXECUTION REFUSED/);
      assert.doesNotMatch(run.err, /--evidence <path> is required/);
      assert.equal(run.files.size, 0, "a dry run writes nothing");
      assert.equal(world.calls.fetches.length, 0);
      assert.equal(world.calls.commands.length, 0);
    }
  });
});

// ── success-case terminal classification ───────────────────────────────────
//
// PHASE-10D-STAGE-B-SUCCESS-BLOCKER-REMEDIATION-001 §14/§15.
//
// `runSuccessCase` used to poll to a terminal state and then call
// `signedDownload()` unconditionally. `/api/download/:id/file` signs only
// `ready` jobs, so a job that had genuinely FAILED produced "no object bytes
// were delivered through the signed GET" — a delivery accusation against the
// one subsystem that was never reached. The first live Stage-B `success`
// attempt reported exactly that for a job whose durable row said
// `failed` / `TIMEOUT`.
//
// These tests pin the causal order: job failure is reported as job failure,
// and delivery is attempted (and blamed) only for a job that became ready.

/** A generic analysis the case will accept, with one usable preset. */
const SUCCESS_ANALYSIS = Object.freeze({
  extractor: "yt-dlp",
  presets: [{ id: "preset:best", formatId: "preset:best", container: "mp4" }],
  formats: [],
  thumbnail: null,
});

/**
 * Drives `runSuccessCase` against a scripted job lifecycle.
 *
 * Everything the producer touches is a counter or a fixed value, so an assertion
 * about "did delivery run" is a fact about the call, not an inference from a
 * thrown message.
 */
function makeSuccessCaseCtx({
  finalStatus,
  errorCode = null,
  timedOut = false,
  trace = ["queued", "analyzing", "downloading", finalStatus],
  location = "https://object.invalid/o",
  redirectStatus = 303,
  genericExpectedDigest = "c".repeat(64),
  deliveredDigest = "c".repeat(64),
}) {
  const calls = { analyze: 0, createJob: 0, signedDownload: 0, fetchDigest: 0, r2Evidence: 0, sweepSurfaces: 0 };
  const finalJob = finalStatus
    ? { status: finalStatus, errorCode, container: "mp4", fileSize: 1024 }
    : null;

  const ctx = {
    genericUrl: "https://fixture.invalid/generic",
    directUrl: "https://fixture.invalid/direct.mp4",
    genericExpectedDigest,
    registerSecret: () => {},
    sleep: async () => {},
    monotonicNow: () => 0,
    sampler: { sample: async () => ({ rows: [] }) },
    session: {
      analyze: async () => {
        calls.analyze += 1;
        return SUCCESS_ANALYSIS;
      },
      createJob: async () => {
        calls.createJob += 1;
        return { jobId: "a".repeat(32), status: "queued" };
      },
      pollTrace: async () => ({ trace, timeline: [], final: finalJob, timedOut }),
      signedDownload: async () => {
        calls.signedDownload += 1;
        return { redirectStatus, location, presigned: true };
      },
      fetchDigest: async () => {
        calls.fetchDigest += 1;
        return { bytes: 1024, digest: deliveredDigest };
      },
    },
    system: {
      // Shaped exactly as the strict success validator requires, so a payload
      // produced here is admissible and the digest field is the only variable.
      durableJobRow: async () => ({
        measured: true,
        value: {
          present: true,
          jobId: "a".repeat(32),
          status: finalStatus,
          formatId: "preset:best",
          extractor: "yt-dlp",
          errorCode,
        },
      }),
    },
    r2Evidence: async () => {
      calls.r2Evidence += 1;
      return { objectExists: true, contentLength: 1024 };
    },
    sweepSurfaces: async () => {
      calls.sweepSurfaces += 1;
      return {
        measured: true,
        value: {
          leaked: false,
          leakedSurfaces: [],
          surfacesChecked: ["journal", "docker-logs", "durable-row", "job-metadata", "api-error"],
        },
      };
    },
  };
  return { ctx, calls };
}

describe("success-case terminal classification", () => {
  it("reports a FAILED job as a job failure and never attempts delivery", async () => {
    const { ctx, calls } = makeSuccessCaseCtx({ finalStatus: "failed", errorCode: "TIMEOUT" });

    await assert.rejects(
      () => runSuccessCase(ctx),
      (error) => {
        assert.match(error.message, /terminal status failed/);
        assert.match(error.message, /errorCode TIMEOUT/);
        assert.match(error.message, /queued>analyzing>downloading>failed/);
        // The exact misdiagnosis this correction removes.
        assert.ok(
          !/no object bytes/i.test(error.message),
          "a failed job must not be reported as a delivery failure",
        );
        assert.ok(!/signed GET/i.test(error.message));
        return true;
      },
    );

    assert.equal(calls.signedDownload, 0, "delivery must not be attempted for a failed job");
    assert.equal(calls.fetchDigest, 0);
    assert.equal(calls.r2Evidence, 0);
    assert.equal(calls.sweepSurfaces, 0);
  });

  it("reports a CANCELLED job as a job failure and never attempts delivery", async () => {
    const { ctx, calls } = makeSuccessCaseCtx({
      finalStatus: "cancelled",
      trace: ["queued", "analyzing", "downloading", "cancelled"],
    });

    await assert.rejects(() => runSuccessCase(ctx), /terminal status cancelled/);
    assert.equal(calls.signedDownload, 0);
    assert.equal(calls.r2Evidence, 0);
  });

  it("reports a POLL TIMEOUT as a poll timeout and never attempts delivery", async () => {
    const { ctx, calls } = makeSuccessCaseCtx({
      finalStatus: "downloading",
      timedOut: true,
      trace: ["queued", "analyzing", "downloading"],
    });

    await assert.rejects(
      () => runSuccessCase(ctx),
      (error) => {
        assert.match(error.message, /did not reach a terminal status within the poll window/);
        assert.match(error.message, /last observed downloading/);
        assert.match(error.message, /queued>analyzing>downloading/);
        return true;
      },
    );
    assert.equal(calls.signedDownload, 0);
    assert.equal(calls.r2Evidence, 0);
  });

  it("carries no URL, sentinel, object key or raw extractor output in the diagnostic", async () => {
    const { ctx } = makeSuccessCaseCtx({ finalStatus: "failed", errorCode: "TIMEOUT" });
    await assert.rejects(
      () => runSuccessCase(ctx),
      (error) => {
        const message = error.message.toLowerCase();
        for (const forbidden of ["http://", "https://", "vf_accept", "object.invalid"]) {
          assert.ok(!message.includes(forbidden), `diagnostic must not carry '${forbidden}'`);
        }
        // Closed vocabulary only: durable statuses, the canonical error code and
        // the transition trace. Raw extractor output is never persisted, so the
        // whole message is asserted rather than probed for known fragments.
        assert.match(
          error.message,
          /^the generic success job reached terminal status [a-z]+ \(errorCode [A-Z_]+\); trace [a-z>]+$/,
        );
        return true;
      },
    );
  });

  it("still runs the normal delivery path for a READY job", async () => {
    const { ctx, calls } = makeSuccessCaseCtx({
      finalStatus: "ready",
      trace: ["queued", "analyzing", "downloading", "processing", "uploading", "ready"],
    });

    const payload = await runSuccessCase(ctx);
    assert.equal(calls.signedDownload, 1);
    assert.equal(calls.fetchDigest, 1);
    assert.equal(calls.r2Evidence, 1);
    assert.equal(calls.sweepSurfaces, 1);
    assert.equal(payload.vercelDelivery.redirectStatus, 303);
    assert.equal(payload.vercelDelivery.clientBytes, 1024);
  });

  it("keeps a READY job's undeliverable object a DELIVERY failure", async () => {
    // The distinction the correction exists to preserve in both directions: a
    // ready job that cannot be delivered is a delivery finding, and says so.
    const { ctx, calls } = makeSuccessCaseCtx({
      finalStatus: "ready",
      location: null,
      redirectStatus: 500,
      trace: ["queued", "analyzing", "downloading", "processing", "uploading", "ready"],
    });

    await assert.rejects(
      () => runSuccessCase(ctx),
      (error) => {
        assert.match(error.message, /ready generic job could not be delivered/);
        assert.match(error.message, /HTTP 500/);
        assert.match(error.message, /no usable Location/);
        return true;
      },
    );
    assert.equal(calls.signedDownload, 1, "delivery IS attempted for a ready job");
    assert.equal(calls.r2Evidence, 0);
  });
});

// ── the independent generic byte-integrity proof ───────────────────────────
//
// PHASE-10D-STAGE-B-SUCCESS-BLOCKER-REMEDIATION-001-CORRECTION-01.
//
// The success record used to seal `expectedDigest: null`, and the evaluator used
// to accept that (`expectedDigest == null || expectedDigest === clientDigest`).
// The reasoning — "no independently known digest can exist for a generic
// source" — is true of an ARBITRARY PUBLIC source and false of the controlled
// Stage-B fixture, which is generated locally and hashed before it is exposed.
//
// With the comparison optional, a self-consistent WRONG object passed every
// remaining clause: three lengths agreeing prove the pipeline was internally
// coherent, and say nothing about WHICH bytes it carried.

describe("generic delivery is proven against a pre-job fixture digest", () => {
  const VALID = "c".repeat(64);

  it("A. refuses a success run with no expected digest, before any product request", async () => {
    // Exactly what the CLI puts on the context when the variable is absent.
    const { ctx, calls } = makeSuccessCaseCtx({
      finalStatus: "ready",
      genericExpectedDigest: null,
    });
    await assert.rejects(() => runSuccessCase(ctx), new RegExp(GENERIC_EXPECTED_DIGEST_ENV));
    assert.equal(calls.analyze, 0, "no analysis may be submitted");
    assert.equal(calls.createJob, 0, "no job may be created");
    assert.equal(calls.signedDownload, 0);
  });

  it("B. refuses a malformed expected digest, before any product request", async () => {
    for (const malformed of ["", "not-a-digest", "C".repeat(64), "c".repeat(63), `${VALID} `, 42]) {
      const { ctx, calls } = makeSuccessCaseCtx({
        finalStatus: "ready",
        genericExpectedDigest: malformed,
      });
      await assert.rejects(() => runSuccessCase(ctx), new RegExp(GENERIC_EXPECTED_DIGEST_ENV));
      assert.equal(calls.analyze, 0, `no analysis for ${JSON.stringify(malformed)}`);
      assert.equal(calls.createJob, 0, `no job for ${JSON.stringify(malformed)}`);
    }
  });

  it("B2. the CLI refuses before the success producer runs at all", async () => {
    // The same refusal at the command boundary, where the operator meets it.
    for (const value of [undefined, "not-a-digest"]) {
      const world = makeFakeWorld({
        ytdlpEnabled: "true",
        sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
      });
      let jobRequests = 0;
      const countingFetch = async (url, init) => {
        const path = String(url);
        if (path.includes("/api/analyze") || (path.includes("/api/download") && init?.method === "POST")) {
          jobRequests += 1;
        }
        return world.fetch(url, init);
      };
      const run = await runCli(
        ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/c-digest.json"],
        LIVE_ENV({
          VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
          VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
          ...WORKER_ENV,
          [GENERIC_EXPECTED_DIGEST_ENV]: value,
        }),
        { runReadOnly: world.runReadOnly, fetch: countingFetch, files: seedRun() },
      );
      assert.equal(run.code, 3, `usage exit expected: ${run.out}\n${run.err}`);
      assert.match(run.err, new RegExp(GENERIC_EXPECTED_DIGEST_ENV));
      assert.equal(jobRequests, 0, "no analyze and no job creation may reach the control plane");
      assert.ok(!run.files.has("/tmp/c-digest.json"), "no record may be written");
    }
  });

  it("B3. other Stage-B cases are not forced to supply a digest they do not consume", () => {
    for (const name of ["cancellation", "byte-limit", "shutdown", "safe-egress", "direct-regression", "kill-switch"]) {
      assert.ok(
        !(CASE_PRODUCERS[name].needs ?? []).includes("genericExpectedDigest"),
        `${name} makes no claim about the generic fixture's content identity`,
      );
    }
    assert.ok(CASE_PRODUCERS.success.needs.includes("genericExpectedDigest"));
  });

  it("C. carries the admitted digest unchanged into the sealed payload", async () => {
    const { ctx } = makeSuccessCaseCtx({
      finalStatus: "ready",
      trace: FULL_LADDER,
      genericExpectedDigest: VALID,
      deliveredDigest: VALID,
    });
    const payload = await runSuccessCase(ctx);
    assert.equal(payload.vercelDelivery.expectedDigest, VALID);
    // Provenance: it is the ADMITTED value, never a restatement of the delivery.
    assert.notEqual(payload.vercelDelivery.expectedDigest, "d".repeat(64));
  });

  it("C2. the sealed digest is the admitted one, not the delivered one", async () => {
    // If the producer ever sourced `expectedDigest` from what came back, this
    // would pass silently and the whole comparison would be circular.
    const { ctx } = makeSuccessCaseCtx({
      finalStatus: "ready",
      trace: FULL_LADDER,
      genericExpectedDigest: VALID,
      deliveredDigest: "e".repeat(64),
    });
    const payload = await runSuccessCase(ctx);
    assert.equal(payload.vercelDelivery.expectedDigest, VALID);
    assert.equal(payload.vercelDelivery.clientDigest, "e".repeat(64));
    assert.notEqual(payload.vercelDelivery.expectedDigest, payload.vercelDelivery.clientDigest);
  });

  it("D. a matching delivered digest keeps vercel.byte-integrity PASS", () => {
    const result = evaluateStageB(passingStageBObservations(), passingStageA());
    const check = result.checks.find((c) => c.id === "vercel.byte-integrity");
    assert.equal(check.outcome, "PASS");
  });

  it("E. a divergent delivered digest FAILS vercel.byte-integrity", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        vercelDelivery: measured({
          redirectStatus: 303,
          presigned: true,
          clientBytes: 83089,
          clientDigest: "b".repeat(64),
          durableFileSize: 83089,
          r2ContentLength: 83089,
          expectedDigest: "a".repeat(64),
        }),
      }),
      passingStageA(),
    );
    const check = result.checks.find((c) => c.id === "vercel.byte-integrity");
    assert.equal(check.outcome, "FAIL");
    assert.equal(result.summary.verdict, "FAIL");
  });

  it("F. a SELF-CONSISTENT WRONG OBJECT fails — the load-bearing regression", () => {
    // Every length agrees with every other length. The pipeline is internally
    // coherent end to end. The bytes are simply not the fixture's, and that is
    // the only thing separating a real delivery from a plausible one.
    //
    // BOTH shapes must fail, and the second is the one that discriminates: with
    // the comparison optional, an ABSENT expected digest let this exact object
    // through every remaining clause.
    for (const [label, expectedDigest] of [
      ["a divergent expected digest", "c".repeat(64)],
      ["NO expected digest at all", null],
    ]) {
      const wrongObject = measured({
        redirectStatus: 303,
        presigned: true,
        clientBytes: 4242,
        clientDigest: "9".repeat(64),
        durableFileSize: 4242,
        r2ContentLength: 4242,
        expectedDigest,
      });
      const result = evaluateStageB(
        passingStageBObservations({ vercelDelivery: wrongObject }),
        passingStageA(),
      );
      const check = result.checks.find((c) => c.id === "vercel.byte-integrity");
      assert.equal(
        check.outcome,
        "FAIL",
        `three agreeing lengths must not substitute for identity (${label})`,
      );
      assert.equal(result.summary.verdict, "FAIL", label);

      // And prove the trap is real: every OTHER clause of the check is satisfied.
      assert.equal(wrongObject.value.clientBytes, wrongObject.value.durableFileSize);
      assert.equal(wrongObject.value.clientBytes, wrongObject.value.r2ContentLength);
      assert.ok(wrongObject.value.clientBytes > 0);
      assert.match(wrongObject.value.clientDigest, /^[0-9a-f]{64}$/);
    }
  });

  it("G. a success case record with a null expected digest is not admissible", async () => {
    const binding = { expectedSha: SHA, runningImageId: IMAGE_ID };
    // A genuine payload from the real producer, so the ONLY thing under test is
    // the digest field — everything else in the record is as it would really be.
    const { ctx } = makeSuccessCaseCtx({
      finalStatus: "ready",
      trace: FULL_LADDER,
      genericExpectedDigest: VALID,
      deliveredDigest: VALID,
    });
    const genuine = await runSuccessCase(ctx);
    assert.equal(
      validateCaseRecord(caseRecord({ caseName: "success", binding, payload: genuine }), binding).ok,
      true,
      "the unpatched payload must be admissible",
    );

    for (const bad of [null, "", "not-a-digest", "C".repeat(64), "c".repeat(63)]) {
      const payload = {
        ...genuine,
        vercelDelivery: { ...genuine.vercelDelivery, expectedDigest: bad },
      };
      const verdict = validateCaseRecord(
        caseRecord({ caseName: "success", binding, payload }),
        binding,
      );
      assert.equal(verdict.ok, false, `expectedDigest ${JSON.stringify(bad)} must be refused`);
      assert.match(verdict.reason, /vercelDelivery/);
    }
  });

  it("H. the accepted Stage-A run a9ce1c400db8d817 remains admissible", async () => {
    // CORRECTION-01 §10. This correction touches the success case's delivery
    // evidence and nothing about Stage-A observer or evaluator semantics, so a
    // record sealed by the accepted run must still authorize Stage B under this
    // branch's own loader. Seeded with the EXACT accepted runId so the assertion
    // names the artifact it is protecting rather than a stand-in.
    const files = new Map();
    files.set(RUN_KEY_PATH, JSON.stringify({ runId: "a9ce1c400db8d817", key: "d".repeat(64) }));

    const world = makeFakeWorld();
    const run = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/accepted-stage-a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );
    assert.equal(run.code, 0, `${run.out}\n${run.err}`);

    const sealed = run.files.get("/tmp/accepted-stage-a.json");
    const record = JSON.parse(sealed);
    assert.equal(record.runId, "a9ce1c400db8d817");
    assert.equal(record.schemaVersion, "10d-remediation-03");
    assert.equal(CASE_SCHEMA_VERSION, "10d-remediation-03");

    const loaded = await loadStageA("/tmp/accepted-stage-a.json", async () => sealed, {
      run: { runId: "a9ce1c400db8d817", key: "d".repeat(64) },
      expectedSha: SHA,
    });
    assert.equal(loaded.ok, true, loaded.reason);
    assert.equal(loaded.summary.verdict, "PASS");
    assert.equal(loaded.binding.expectedSha, SHA);
  });

  it("G2. the grammar itself refuses anything but 64 lowercase hex", () => {
    assert.equal(parseGenericExpectedDigest("c".repeat(64)).ok, true);
    for (const bad of [undefined, null, "", "C".repeat(64), "c".repeat(63), "c".repeat(65), "zz", 1]) {
      assert.equal(parseGenericExpectedDigest(bad).ok, false, JSON.stringify(bad));
    }
  });
});

// ── CORRECTION-01 §4-§7: the 10D-REM-03 evaluator-semantics boundary ───────
//
// This is the sharpest case the schema boundary has had to carry. Every earlier
// bump retired artifacts whose OBSERVERS were weaker. This one retires
// artifacts whose observers were fine and whose EVALUATOR has since become more
// permissive about the very same raw bytes:
//
//     the same sealed five-state success trace
//     graded BLOCKED under 10d-remediation-02
//     graded PASS    under 10d-remediation-03
//
// A valid HMAC proves "this artifact has not changed since it was produced". It
// does NOT prove "this artifact was produced and evaluated under today's
// lifecycle semantics". Nothing in the record's shape, fields or seal separates
// the two readings, so the version boundary is the only thing that can — and a
// permissive change is not exempt from it just because it points the friendly
// way.

describe("10D-REM-03 — the lifecycle evaluator boundary retires remediation-02", () => {
  const KEY = "a".repeat(64);
  const RUN = { runId: "0123456789abcdef", key: KEY };
  const RETIRED = "10d-remediation-02";
  const BINDING = { expectedSha: SHA, runningImageId: IMAGE_ID };
  const expectations = { runId: RUN.runId, expectedSha: SHA, runningImageId: IMAGE_ID };

  /** A Stage-A PASS that is perfect in every respect except its schema. */
  const stageAAt = (schemaVersion) =>
    sealRecord(
      {
        harness: HARNESS_ID,
        schemaVersion,
        runId: RUN.runId,
        task: "PHASE-10D",
        stage: "A",
        verdict: "PASS",
        startedAt: "2026-09-04T00:00:00.000Z",
        expectedSha: SHA,
        runningImageId: IMAGE_ID,
        taggedImageId: IMAGE_ID,
        binding: { expectedSha: SHA, runningImageId: IMAGE_ID, taggedImageId: IMAGE_ID },
        checks: [{ id: "image.identity", outcome: "PASS", required: true, detail: "" }],
      },
      KEY,
    );

  const loadA = (record) =>
    loadStageA("/x", async () => JSON.stringify(record), { run: RUN, expectedSha: SHA });

  /**
   * A REALISTIC `success` case record carrying the exact live five-state trace,
   * built by the real producer so nothing but the schema version is synthetic.
   *
   * Synthetic on purpose: no secret, sentinel, URL or bearer value from the
   * real sealed `stage-b/success.json` is reproduced here. That artifact stays
   * untouched on the acceptance host.
   */
  const liveSuccessCaseAt = async (schemaVersion) => {
    const { ctx } = makeSuccessCaseCtx({
      finalStatus: "ready",
      trace: [...LIVE_SUCCESS_TRACE],
      genericExpectedDigest: "c".repeat(64),
      deliveredDigest: "c".repeat(64),
    });
    const payload = await runSuccessCase(ctx);
    const record = caseRecord({ caseName: "success", binding: BINDING, payload, runId: RUN.runId });
    return sealRecord({ ...record, schemaVersion }, KEY);
  };

  it("A. a correctly sealed remediation-02 Stage A is refused SOLELY on the version", async () => {
    const stale = stageAAt(RETIRED);

    // The seal is genuinely good, and every other admission condition holds —
    // same run, same key, same source SHA, same image, PASS verdict, complete
    // and self-consistent binding. The version is the only thing wrong.
    assert.equal(verifySeal(stale, KEY).ok, true, "precondition: the artifact is authentic");

    const loaded = await loadA(stale);
    assert.equal(loaded.ok, false);
    assert.match(loaded.reason, new RegExp(`${RETIRED}.*is not.*10d-remediation-03`));
    assert.equal(loaded.binding, undefined, "and it authorizes nothing");

    // The identical record at the current version IS admitted, which is what
    // proves the refusal above is the version boundary and nothing else.
    const fresh = await loadA(stageAAt(EVIDENCE_SCHEMA_VERSION));
    assert.equal(fresh.ok, true, fresh.reason);
  });

  it("B. a sealed remediation-02 success is refused BEFORE the classifier can pass it", async () => {
    const stale = await liveSuccessCaseAt(RETIRED);

    // Precondition 1: the artifact is authentic.
    assert.equal(verifySeal(stale, KEY).ok, true, "precondition: authentic");
    // Precondition 2: it carries the exact trace the new classifier accepts, so
    // the ONLY thing standing between it and a PASS is the version boundary.
    assert.deepEqual(stale.payload.genericJob.transitions, [...LIVE_SUCCESS_TRACE]);
    assert.equal(
      classifySuccessTransitionTrace(stale.payload.genericJob.transitions).outcome,
      OUTCOMES.PASS,
      "precondition: the corrected classifier would pass this trace",
    );

    // …and it is refused at ADMISSION, by both gates the aggregate runs, before
    // any payload field is believed and long before the classifier sees it.
    const validated = validateCaseRecord(stale, BINDING);
    assert.equal(validated.ok, false);
    assert.match(validated.reason, new RegExp(`${RETIRED} is not 10d-remediation-03`));
    assert.equal(validated.observations, undefined, "no observation may escape a refused record");

    const verified = verifyRecord(stale, KEY, expectations);
    assert.equal(verified.ok, false);
    assert.match(verified.reason, new RegExp(`${RETIRED} is not 10d-remediation-03`));
  });

  it("C. the same success at remediation-03 IS admitted and PASSes by causal proof", async () => {
    const fresh = await liveSuccessCaseAt(EVIDENCE_SCHEMA_VERSION);

    const validated = validateCaseRecord(fresh, BINDING);
    assert.equal(validated.ok, true, validated.reason);
    assert.equal(verifyRecord(fresh, KEY, expectations).ok, true);

    // Admitted, and its lifecycle check passes on causal proof — `processing`
    // reported as proven, never as observed, and never spliced into the trace.
    const result = evaluateStageB(
      passingStageBObservations({
        ...validated.observations,
        durableJobRow: measured({
          present: true,
          jobId: fresh.payload.genericJob.jobId,
          status: "ready",
          formatId: fresh.payload.genericJob.requestedFormatId,
          extractor: "yt-dlp",
        }),
      }),
      passingStageA(),
    );
    const check = result.checks.find((c) => c.id === "job.lifecycle-complete");
    assert.equal(check.outcome, OUTCOMES.PASS, check.detail);
    assert.match(check.detail, /CAUSALLY PROVEN/);
    assert.ok(!fresh.payload.genericJob.transitions.includes("processing"));
  });

  it("D. cross-version case aggregation is refused", async () => {
    // Two case records for one run, differing ONLY in contract version. The
    // aggregate must not build a verdict from a mixed-semantics corpus.
    const fresh = await liveSuccessCaseAt(EVIDENCE_SCHEMA_VERSION);
    const stale = await liveSuccessCaseAt(RETIRED);

    assert.equal(validateCaseRecord(fresh, BINDING).ok, true);
    assert.equal(validateCaseRecord(stale, BINDING).ok, false);

    const admitted = [fresh, stale].filter((r) => validateCaseRecord(r, BINDING).ok);
    assert.equal(admitted.length, 1, "a mixed-version corpus never aggregates whole");
    assert.equal(admitted[0].schemaVersion, EVIDENCE_SCHEMA_VERSION);
  });

  it("E. a remediation-03 Stage A cannot be joined to a remediation-02 case", async () => {
    const files = new Map();
    files.set("/tmp/stage-a-03.json", JSON.stringify(stageAAt(EVIDENCE_SCHEMA_VERSION)));
    files.set("/tmp/case-02.json", JSON.stringify(await liveSuccessCaseAt(RETIRED)));
    files.set(RUN_KEY_PATH, JSON.stringify({ runId: RUN.runId, key: KEY }));

    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const aggregate = await runCli(
      [
        "--stage", "B", "--aggregate", ...LIVE_ARGS,
        "--stage-a", "/tmp/stage-a-03.json",
        "--case-evidence", "/tmp/case-02.json",
        "--evidence", "/tmp/aggregate-mixed-e.json",
      ],
      LIVE_ENV({ ...WORKER_ENV }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );

    // The Stage A authorized, the stale case did not, and the lifecycle claim
    // it would have carried lands BLOCKED rather than PASS.
    assert.match(aggregate.err, /rejected case evidence/);
    assert.match(aggregate.err, new RegExp(`${RETIRED} is not 10d-remediation-03`));
    assert.match(aggregate.out, /accepted case evidence: none/);
    assert.match(aggregate.out, /\[BLKD\] job\.lifecycle-complete/);
    assert.notEqual(aggregate.code, 0);
  });

  it("F. a remediation-02 Stage A cannot authorize remediation-03 cases", async () => {
    const files = new Map();
    files.set("/tmp/stage-a-02.json", JSON.stringify(stageAAt(RETIRED)));
    files.set("/tmp/case-03.json", JSON.stringify(await liveSuccessCaseAt(EVIDENCE_SCHEMA_VERSION)));
    files.set(RUN_KEY_PATH, JSON.stringify({ runId: RUN.runId, key: KEY }));

    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const aggregate = await runCli(
      [
        "--stage", "B", "--aggregate", ...LIVE_ARGS,
        "--stage-a", "/tmp/stage-a-02.json",
        "--case-evidence", "/tmp/case-03.json",
        "--evidence", "/tmp/aggregate-mixed-f.json",
      ],
      LIVE_ENV({ ...WORKER_ENV }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
    );

    // The stale Stage A cannot authorize ANYTHING, so the run stops at the
    // authorization edge and the fresh case is never even considered.
    assert.match(aggregate.err, /BLOCKED: the Stage A record is not usable/);
    assert.match(aggregate.err, new RegExp(`${RETIRED}.*is not.*10d-remediation-03`));
    assert.notEqual(aggregate.code, 0);
  });

  it("admission never NORMALIZES a retired artifact — it refuses it", async () => {
    // The tempting shortcut as a HARNESS BEHAVIOUR: quietly relabel a retired
    // record to the current version on the way in, reseal it, and carry on.
    // That is not admission, it is manufacturing the provenance of meaning the
    // boundary exists to establish — so every gate must leave the artifact it
    // rejected byte-for-byte as it found it.
    const stale = await liveSuccessCaseAt(RETIRED);
    const before = JSON.stringify(stale);

    const staleA = stageAAt(RETIRED);
    const beforeA = JSON.stringify(staleA);

    assert.equal(validateCaseRecord(stale, BINDING).ok, false);
    assert.equal(verifyRecord(stale, KEY, expectations).ok, false);
    assert.equal((await loadA(staleA)).ok, false);

    assert.equal(JSON.stringify(stale), before, "a refused case record must not be rewritten");
    assert.equal(JSON.stringify(staleA), beforeA, "a refused Stage A must not be rewritten");
    assert.equal(stale.schemaVersion, RETIRED, "its contract version must survive the refusal");
    assert.equal(staleA.schemaVersion, RETIRED);
  });

  it("re-sealing a retired artifact as remediation-03 does not launder it", async () => {
    // The same shortcut performed by hand, and equally refused. Historical
    // evidence is immutable, not upgradeable: a reseal forges exactly the
    // provenance of MEANING the boundary exists to establish, and the HMAC
    // cannot attest to it.
    const stale = await liveSuccessCaseAt(RETIRED);
    assert.equal(validateCaseRecord(stale, BINDING).ok, false);

    const laundered = sealRecord(
      { ...stale, schemaVersion: EVIDENCE_SCHEMA_VERSION, authenticator: undefined },
      KEY,
    );
    delete laundered.authenticator.undefined;

    // The reseal is cryptographically valid — that is the whole problem, and
    // why the seal alone can never be the thing that decides this.
    assert.equal(verifySeal(laundered, KEY).ok, true);

    // The ORIGINAL artifact is untouched by the attempt: it still carries its
    // own version and its own seal.
    assert.equal(stale.schemaVersion, RETIRED);
    assert.equal(verifySeal(stale, KEY).ok, true);

    // A relabelled record is a NEW claim about provenance, not the old
    // artifact's, and it is not evidence that the retired run was evaluated
    // under today's semantics. Producing one is the workflow this correction
    // forbids; the required response to a retired artifact is a FRESH run.
    assert.notEqual(laundered.authenticator.mac, stale.authenticator.mac);
  });
});
