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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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
} from "../deploy/acceptance/ytdlp-generic/lib/process-tree.mjs";
import {
  establishYtdlpPid,
  parseDockerTop,
} from "../deploy/acceptance/ytdlp-generic/lib/process-sampler.mjs";
import {
  evaluateTransitionTrace,
  classifyTransitionTrace,
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
  evaluateStageB,
  stageBAuthorization,
  presetsAreApplicationOwned,
  isApplicationOwnedFormatId,
  FORBIDDEN_DURABLE_FIELDS,
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
  durableJobQuery,
  workDirProbeArgv,
  EJS_PROBE_ARGV,
} from "../deploy/acceptance/ytdlp-generic/lib/observers.mjs";
import {
  buildCaseRecord,
  validateCaseRecord,
  pickPreset,
  caseNames,
  liveCaseNames,
  hasExecutableProducer,
  evaluateCaseFeatureState,
  expectedFeatureStateFor,
  CASE_PRODUCERS,
  CASE_SCHEMA_VERSION,
  HARNESS_ID,
} from "../deploy/acceptance/ytdlp-generic/lib/cases.mjs";
import {
  readDenyCounter,
  fingerprintChain,
  attributeDenial,
} from "../deploy/acceptance/ytdlp-generic/lib/egress-policy.mjs";
import { parseHostProcessList } from "../deploy/acceptance/ytdlp-generic/lib/observers.mjs";
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
} from "../deploy/acceptance/ytdlp-generic/lib/provenance.mjs";
import { main, loadStageA } from "../deploy/acceptance/ytdlp-generic/acceptance.mjs";

// ── Fixtures ───────────────────────────────────────────────────────────────

const measured = (value) => ({ measured: true, value });
const unmeasured = (reason) => ({ measured: false, reason });

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const SHA = "90be3d079a26b851c5f7496801647568533e6a2d";
const JOB_ID = "fb63f3170c2342717c7dd8af11d09418";
const FULL_LADDER = [...REQUIRED_TRANSITIONS];

const digestOf = (text) => createHash("sha256").update(text).digest("hex");
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
    workerNetworkMode: measured("container:videofetch-media-netns"),
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
    recoveredStatus: "failed",
    ...overrides,
  };
}

function byteLimitEvidence(overrides = {}) {
  return {
    jobId: JOB_ID,
    extractor: "yt-dlp",
    declaredLengthUnknown: true,
    actualMediaRequestObserved: true,
    contentLengthPresent: false,
    transferMode: "chunked",
    bytesServed: 600_000_000,
    outcome: "TOO_LARGE",
    transitions: ["queued", "analyzing", "downloading"],
    beganProcessing: false,
    uploaded: false,
    workDirPresent: false,
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
      expectedDigest: null,
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

function makeFakeWorld(options = {}) {
  const env = {
    ytdlpEnabled: options.ytdlpEnabled ?? null,
    services: options.services ?? "active",
    egressExit: options.egressExit ?? 0,
    ytdlpVersion: options.ytdlpVersion ?? "2026.08.19",
    sites: options.sites ?? { ytdlp: false, ytdlpInstalled: true, ytdlpEnabled: false, ffmpeg: true },
    imageIds: options.imageIds ?? { [`videofetch-worker:${SHA}`]: IMAGE_ID, "videofetch-worker:latest": IMAGE_ID },
    runningImage: options.runningImage ?? IMAGE_ID,
  };
  const calls = { commands: [], fetches: [], logins: 0 };

  const workerEnvLines = [
    "WORKER_CONTROL_KEY_ID=k",
    "WORKER_CONTROL_SECRET=s",
    "R2_ACCOUNT_ID=a",
    "R2_BUCKET=b",
    ...(env.ytdlpEnabled === null ? [] : [`YTDLP_ENABLED=${env.ytdlpEnabled}`]),
  ].join("\n");

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
        if (joined.includes("{{.Image}}")) return { exitCode: 0, stdout: `${env.runningImage}\n`, stderr: "" };
        if (joined.includes("NetworkMode")) {
          return { exitCode: 0, stdout: "container:videofetch-media-netns\n", stderr: "" };
        }
        if (joined.includes(".Config.Env")) return { exitCode: 0, stdout: `${workerEnvLines}\n`, stderr: "" };
        if (joined.includes(".State.Pid")) return { exitCode: 0, stdout: "100\n", stderr: "" };
      }
      if (argv[0] === "top") {
        return {
          exitCode: 0,
          stdout: "PID PPID PGID COMMAND\n100 1 100 node\n200 100 200 python3\n",
          stderr: "",
        };
      }
      if (argv[0] === "logs") return { exitCode: 0, stdout: "worker started\n", stderr: "" };
      if (argv[0] === "exec") {
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
    if (file === "journalctl") return { exitCode: 0, stdout: "no errors\n", stderr: "" };
    if (file === "sqlite3") {
      return { exitCode: 0, stdout: `${JOB_ID}|ready|preset:720|yt-dlp\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  // Job state machine: each status poll advances one rung, EXCEPT `downloading`,
  // which is held for several polls. A real acquisition dwells there for
  // seconds; a fake that leaves after one poll gives the process sampler no
  // window to complete a snapshot in, and every sample would straddle the close.
  const DOWNLOADING_POLLS = options.downloadingPolls ?? 4;
  const jobs = new Map();
  function nextJob(jobId, extractor) {
    const job = jobs.get(jobId);
    const current = FULL_LADDER[job.index];
    if (current === "downloading" && job.dwell < DOWNLOADING_POLLS) {
      job.dwell += 1;
    } else if (job.index < FULL_LADDER.length - 1) {
      job.index += 1;
    }
    const status = FULL_LADDER[job.index];
    return {
      jobId,
      status,
      extractor,
      fileSize: status === "ready" ? FIXTURE_BODY.length : null,
      container: "mp4",
      quality: "720p",
      filename: "acceptance.mp4",
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
      const jobId = body.url.includes("generic") ? JOB_ID : "aa".repeat(16);
      jobs.set(jobId, { index: 0, dwell: 0, extractor: body.url.includes("generic") ? "yt-dlp" : "direct" });
      return json({ jobId, status: "queued", extractor: null });
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

  return { runReadOnly, fetch: fetchImpl, calls, env };
}

/** Runs the real CLI against a fake external world. */
async function runCli(argv, env, deps = {}) {
  const lines = [];
  const errors = [];
  const files = deps.files ?? new Map();
  const modes = new Map();
  const code = await main(argv, env, {
    log: (line) => lines.push(String(line)),
    errorLog: (line) => errors.push(String(line)),
    // The filesystem is a SUBSTITUTED EXTERNAL SYSTEM, like the command runner
    // and fetch. The CLI's own provenance logic still runs for real against it.
    writeFile: async (path, contents, options) => {
      files.set(path, contents);
      if (options?.mode) modes.set(path, options.mode);
    },
    readFile: async (path) => {
      if (files.has(path)) return files.get(path);
      throw new Error(`no such file ${path}`);
    },
    mkdir: async () => {},
    chmod: async (path, mode) => modes.set(path, mode),
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
  return { code, out: lines.join("\n"), err: errors.join("\n"), files, modes };
}

const LIVE_ENV = (extra = {}) => ({
  [LIVE_ENV_NAME]: "1",
  VIDEOFETCH_ACCESS_SECRET: "an-actual-access-secret-value",
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
      buildCaseRecord({
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
      ["--stage", "A", ...LIVE_ARGS],
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
      ["--stage", "A", ...LIVE_ARGS],
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
        durableJobRow: measured({ jobId: JOB_ID, status: "ready", formatId: "preset:1080", extractor: "yt-dlp" }),
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
        durableJobRow: measured({ jobId: JOB_ID, status: "ready", formatId: "22", extractor: "yt-dlp" }),
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
        durableJobRow: measured({ jobId: JOB_ID, status: "ready", formatId: "preset:360", extractor: "yt-dlp" }),
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

  it("the durable reader projects only safe columns — never the URL", () => {
    const sql = durableJobQuery(JOB_ID);
    assert.match(sql, /^SELECT job_id, status, format_id, extractor FROM jobs/);
    assert.doesNotMatch(sql, /\burl\b/, "the submitted URL must never be selected");
    assert.throws(() => durableJobQuery("'; DROP TABLE jobs;--"), /malformed job id/);
    assert.equal(isReadOnlyCommand("sqlite3", ["-readonly", "/var/lib/videofetch/videofetch.db", sql]), true);
    assert.equal(
      isReadOnlyCommand("sqlite3", ["-readonly", "/var/lib/videofetch/videofetch.db", "SELECT url FROM jobs;"]),
      false,
    );
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
    const rows = parseDockerTop("PID PPID PGID COMMAND\n100 1 100 node\n200 100 200 python3\n");
    assert.deepEqual(rows, [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: null },
      { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: null },
    ]);
    assert.equal(establishYtdlpPid(rows, 100).pid, 200);
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
        ["--stage", "B", "--aggregate", ...LIVE_ARGS, "--stage-a", "/tmp/sa.json"],
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
    const record = buildCaseRecord({ caseName: "cancellation", binding, payload: goodPayload });
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
    const wrongSha = buildCaseRecord({
      caseName: "cancellation",
      binding: { expectedSha: "0".repeat(40), runningImageId: IMAGE_ID },
      payload: goodPayload,
    });
    assert.match(validateCaseRecord(wrongSha, binding).reason, /binds to source/);

    const wrongImage = buildCaseRecord({
      caseName: "cancellation",
      binding: { expectedSha: SHA, runningImageId: `sha256:${"f".repeat(64)}` },
      payload: goodPayload,
    });
    assert.match(validateCaseRecord(wrongImage, binding).reason, /different image object/);
  });

  it("9c. unknown or missing observations in a payload are rejected", () => {
    const extra = buildCaseRecord({
      caseName: "cancellation",
      binding,
      payload: { ...goodPayload, killSwitch: { genericUsableAfterDisable: false, directWorks: true } },
    });
    assert.match(validateCaseRecord(extra, binding).reason, /unexpected observation 'killSwitch'/);

    const missing = buildCaseRecord({ caseName: "cancellation", binding, payload: {} });
    assert.match(validateCaseRecord(missing, binding).reason, /missing observation 'cancellation'/);
  });

  it("9d. a malformed payload field is rejected", () => {
    const malformed = buildCaseRecord({
      caseName: "cancellation",
      binding,
      payload: { cancellation: { ...goodPayload.cancellation, lateReady: "no" } },
    });
    assert.match(validateCaseRecord(malformed, binding).reason, /malformed/);
  });

  it("9e. every case name has a payload validator", () => {
    for (const name of caseNames()) {
      const validated = validateCaseRecord(
        buildCaseRecord({ caseName: name, binding, payload: {} }),
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
    assert.equal(isReadOnlyCommand("docker", ["inspect", "videofetch-worker"]), true);
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
            expectedDigest: null,
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
    const run = await runCli(["--stage", "A", ...LIVE_ARGS], LIVE_ENV(), {
      runReadOnly: world.runReadOnly,
      fetch: world.fetch,
    });
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
      buildCaseRecord({
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

    // A malformed file does not silently mint a usable run for loadRun.
    files.set("/tmp/run.json", "{}");
    assert.equal(await loadRun("/tmp/run.json", deps), null);
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
    const rows = parseHostProcessList("  100     1   100 node\n  200   100   200 python3\n");
    assert.deepEqual(rows, [
      { pid: 100, ppid: 1, pgid: 100, comm: "node" },
      { pid: 200, ppid: 100, pgid: 200, comm: "python3" },
    ]);
    // A row whose `comm` column carried argv is dropped, not admitted.
    assert.deepEqual(parseHostProcessList("200 100 200 python3 /usr/local/lib/yt-dlp https://x"), []);
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
    const deps = {
      readFile: async () => JSON.stringify({ runId: "abc", key: "d".repeat(64) }),
      stat: async () => ({ mode: 0o644 }),
    };
    const loaded = await loadRun("/tmp/run.json", deps);
    assert.ok(loaded?.error, "a 0644 key file must be refused");
    assert.match(loaded.error, /must not be group- or world-accessible/);

    const safe = await loadRun("/tmp/run.json", { ...deps, stat: async () => ({ mode: 0o600 }) });
    assert.equal(safe.runId, "abc");
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
