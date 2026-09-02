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
  CASE_NAMES,
  CASE_SCHEMA_VERSION,
  HARNESS_ID,
} from "../deploy/acceptance/ytdlp-generic/lib/cases.mjs";
import {
  producerFor,
  hasConcreteProducer,
} from "../deploy/acceptance/ytdlp-generic/lib/coverage.mjs";
import { main } from "../deploy/acceptance/ytdlp-generic/acceptance.mjs";

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
      directAttempted: true,
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
    selectorConstraints: measured({ satisfied: true }),
    downloadingSample: measured({
      sample: acquisitionSample(),
      workerPid: 100,
      ytdlpPid: 200,
      expectedNetns: "net:[4026532001]",
    }),
    egressNegative: measured({ denied: true, attributedToBoundary: true }),
    egressPolicyFingerprint: measured({ beforeMatchesAfter: true }),
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
    cancellation: measured({
      transitions: ["queued", "analyzing", "downloading", "cancelled"],
      lateReady: false,
      postSample: [{ pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[4026532001]" }],
      workerPid: 100,
      beganProcessing: false,
      uploaded: false,
      workDirPresent: false,
    }),
    byteLimitCase: measured({
      declaredLengthUnknown: true,
      outcome: "TOO_LARGE",
      beganProcessing: false,
      uploaded: false,
      workDirPresent: false,
    }),
    shutdownCase: measured({ descendantsGone: true, recoveredStatus: "failed" }),
    directAfterEnable: measured({ status: "ready", extractor: "direct", sampledBasenames: ["node"] }),
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

  // Job state machine: each status poll advances one rung.
  const jobs = new Map();
  function nextJob(jobId, extractor) {
    const job = jobs.get(jobId);
    if (job.index < FULL_LADDER.length - 1) job.index += 1;
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
      jobs.set(jobId, { index: 0, extractor: body.url.includes("generic") ? "yt-dlp" : "direct" });
      return json({ jobId, status: "queued", extractor: null });
    }
    if (url.pathname.endsWith("/status")) {
      const jobId = url.pathname.split("/")[3];
      return json(nextJob(jobId, jobs.get(jobId).extractor));
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
  const files = new Map();
  const code = await main(argv, env, {
    log: (line) => lines.push(String(line)),
    errorLog: (line) => errors.push(String(line)),
    writeFile: async (path, contents) => files.set(path, contents),
    readFile: async (path) => {
      if (files.has(path)) return files.get(path);
      if (deps.files?.has(path)) return deps.files.get(path);
      throw new Error(`no such file ${path}`);
    },
    sleep: async () => {},
    ...deps,
  });
  return { code, out: lines.join("\n"), err: errors.join("\n"), files };
}

const LIVE_ENV = (extra = {}) => ({
  [LIVE_ENV_NAME]: "1",
  VIDEOFETCH_ACCESS_SECRET: "an-actual-access-secret-value",
  ...extra,
});

const LIVE_ARGS = ["--live", "--base-url", "https://control.invalid", "--expected-sha", SHA];

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

  it("35c. a Stage B success case produces a real case record", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const run = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/case-success.json"],
      LIVE_ENV({
        VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
        VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
      }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
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
    assert.equal(record.payload.downloadingSample.ytdlpPid, 200);
    assert.equal(record.payload.sentinelSweep.leaked, false);
  });

  it("35d. Stage B aggregation turns real case records into a verdict", async () => {
    const world = makeFakeWorld({
      ytdlpEnabled: "true",
      sites: { ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true },
    });
    const shared = { runReadOnly: world.runReadOnly, fetch: world.fetch };
    const liveEnv = LIVE_ENV({
      VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic/watch?v=abc",
      VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4",
    });

    const success = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/c-success.json"],
      liveEnv,
      shared,
    );
    assert.equal(success.code, 0);

    // A Stage A PASS record, produced by the real Stage A run.
    const stageAWorld = makeFakeWorld();
    const stageA = await runCli(
      ["--stage", "A", ...LIVE_ARGS, "--evidence", "/tmp/stage-a.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_DIRECT_URL: "https://fixture.invalid/clip.mp4" }),
      { runReadOnly: stageAWorld.runReadOnly, fetch: stageAWorld.fetch },
    );
    assert.equal(stageA.code, 0);

    const files = new Map([
      ["/tmp/stage-a.json", stageA.files.get("/tmp/stage-a.json")],
      ["/tmp/c-success.json", success.files.get("/tmp/c-success.json")],
    ]);

    const aggregate = await runCli(
      [
        "--stage", "B", "--aggregate", ...LIVE_ARGS,
        "--stage-a", "/tmp/stage-a.json",
        "--case-evidence", "/tmp/c-success.json",
        "--evidence", "/tmp/stage-b.json",
      ],
      liveEnv,
      { ...shared, files },
    );

    assert.match(aggregate.out, /accepted case evidence: success/);
    // The success case's own checks passed…
    for (const id of [
      "analysis.routed-to-generic",
      "analysis.presets-application-owned",
      "job.lifecycle-complete",
      "durable.application-format-id",
      "process.ytdlp-identified",
      "process.no-ffmpeg-during-downloading",
      "vercel.byte-integrity",
      "privacy.sentinel-not-leaked",
    ]) {
      assert.match(aggregate.out, new RegExp(`\\[ok  \\] ${id.replace(/\./g, "\\.")}`), `${id}`);
    }
    // …while the cases that were NOT run are BLOCKED, never skipped to PASS.
    assert.match(aggregate.out, /\[BLKD\] cancel\.durable-cancelled/);
    assert.match(aggregate.out, /\[BLKD\] limit\.actual-byte-guard/);
    assert.equal(aggregate.code, 2, "an incomplete Stage B is BLOCKED");
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

  it("36. every emitted check has a concrete, non-test producer", () => {
    const missing = [];
    for (const id of allEmittedCheckIds()) {
      if (!hasConcreteProducer(id)) missing.push(id);
    }
    assert.deepEqual(missing, [], `these checks have no concrete live producer: ${missing.join(", ")}`);
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
      if (match) assert.ok(CASE_NAMES.includes(match[1]), `${id} names unknown case ${match[1]}`);
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
    // Same basename, but NOT its own process-group leader: it inherited the
    // Worker's group, so it is not the detached acquisition process.
    const sample = [
      { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: NS },
      { pid: 300, ppid: 100, pgid: 100, comm: "python3", netns: NS },
    ];
    const identity = evaluateYtdlpIdentity(sample, 100, 300, NS);
    assert.equal(identity.identified, false);
    assert.match(identity.reason, /process-group leader/);

    // And the sampler refuses to establish it in the first place.
    assert.equal(establishYtdlpPid(sample, 100).established, false);
  });

  it("22c. a missing, absent or non-descendant PID is BLOCKED", () => {
    assert.equal(evaluateYtdlpIdentity(acquisitionSample(), 100, null, NS).identified, false);
    assert.match(
      evaluateYtdlpIdentity(acquisitionSample(), 100, 999, NS).reason,
      /absent from the sample/,
    );
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

  it("22e. an unidentified owned process BLOCKS Stage B", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        downloadingSample: measured({
          sample: acquisitionSample(),
          workerPid: 100,
          ytdlpPid: null,
          expectedNetns: NS,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("process.ytdlp-identified"));
  });

  it("23. Node containment is anchored to the verified owned PID", () => {
    const sample = acquisitionSample([
      { pid: 300, ppid: 200, pgid: 200, comm: "node", netns: NS },
    ]);
    const identity = evaluateYtdlpIdentity(sample, 100, 200, NS);
    const contained = evaluateNodeContainment(classifyAcquisitionTree(sample, 100), identity, NS);
    assert.equal(contained.anchored, true);
    assert.equal(contained.contained, true);

    // Node parented by the WORKER rather than the owned yt-dlp process.
    const detached = acquisitionSample([
      { pid: 300, ppid: 100, pgid: 200, comm: "node", netns: NS },
    ]);
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
    const identity = evaluateYtdlpIdentity(sample, 100, null, NS);
    const result = evaluateNodeContainment(classifyAcquisitionTree(sample, 100), identity, NS);
    assert.equal(result.anchored, false);
    assert.equal(result.contained, false);

    const stageB = evaluateStageB(
      passingStageBObservations({
        downloadingSample: measured({ sample, workerPid: 100, ytdlpPid: null, expectedNetns: NS }),
      }),
      passingStageA(),
    );
    const entry = stageB.checks.find((c) => c.id === "process.node-ejs-containment");
    assert.equal(entry.outcome, OUTCOMES.BLOCKED, "unanchored containment is BLOCKED, not contained");
  });

  it("23c. a source that never invokes Node reports NOT_EXERCISED", () => {
    const result = evaluateStageB(passingStageBObservations(), passingStageA());
    const node = result.checks.find((c) => c.id === "process.node-ejs-containment");
    assert.equal(node.outcome, OUTCOMES.NOT_EXERCISED);
    assert.match(node.detail, /NODE\/EJS DESCENDANT NOT EXERCISED BY THIS SOURCE/);
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
    assert.ok(result.summary.notExercised.includes("process.node-ejs-containment"));
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
    // An explicit null netns IS allowed — it means "measurement failed".
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
        downloadingSample: measured({
          sample: [
            { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[1]" },
            { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: "net:[1]", cmdline: "yt-dlp https://x" },
          ],
          workerPid: 100,
          ytdlpPid: 200,
          expectedNetns: "net:[1]",
        }),
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
    assert.equal(validateSampleShape(rows.map((r) => ({ ...r, netns: "net:[1]" }))).ok, true);
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

// ── Process rules that survive from the original suite ─────────────────────

describe("process-tree rules", () => {
  const NS = "net:[4026532001]";
  const withDescendant = (comm) =>
    measured({
      sample: acquisitionSample([{ pid: 300, ppid: 200, pgid: 200, comm, netns: NS }]),
      workerPid: 100,
      ytdlpPid: 200,
      expectedNetns: NS,
    });

  it("11/12. ffmpeg and ffprobe during downloading FAIL", () => {
    for (const comm of ["ffmpeg", "ffprobe"]) {
      const result = evaluateStageB(
        passingStageBObservations({ downloadingSample: withDescendant(comm) }),
        passingStageA(),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, comm);
      assert.ok(result.summary.blocking.includes("process.no-ffmpeg-during-downloading"));
    }
  });

  it("12b. every other forbidden acquisition helper also FAILS", () => {
    for (const comm of ["curl", "wget", "aria2c", "axel", "sh", "bash", "rtmpdump"]) {
      const result = evaluateStageB(
        passingStageBObservations({ downloadingSample: withDescendant(comm) }),
        passingStageA(),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, comm);
    }
  });

  it("13. an allowed Node descendant is accepted structurally", () => {
    const result = evaluateStageB(
      passingStageBObservations({ downloadingSample: withDescendant("node") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
  });

  it("13b. an UNKNOWN descendant is not quietly tolerated", () => {
    const result = evaluateStageB(
      passingStageBObservations({ downloadingSample: withDescendant("perl") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.no-unknown-descendants"));
  });

  it("14. inability to inspect descendants is BLOCKED, not PASS", () => {
    const result = evaluateStageB(
      passingStageBObservations({ downloadingSample: unmeasured("ps unavailable") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("process.sample-available"));
    for (const id of ["process.no-ffmpeg-during-downloading", "process.namespace-identity"]) {
      assert.equal(result.checks.find((c) => c.id === id), undefined);
    }
  });

  it("15. an unexpected network namespace FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        downloadingSample: measured({
          sample: acquisitionSample([
            { pid: 300, ppid: 200, pgid: 200, comm: "node", netns: "net:[4026599999]" },
          ]),
          workerPid: 100,
          ytdlpPid: 200,
          expectedNetns: NS,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.namespace-identity"));
  });

  it("15b. an unreadable namespace is a mismatch, never agreement", () => {
    const classified = classifyAcquisitionTree(
      acquisitionSample([{ pid: 300, ppid: 200, pgid: 200, comm: "node", netns: null }]),
      100,
    );
    const evaluation = evaluateNamespaceIdentity(classified, NS);
    assert.equal(evaluation.consistent, false);
    assert.deepEqual(evaluation.offenders.map((o) => o.pid), [300]);
  });

  it("15d. descendant walking survives a malformed (cyclic) sample", () => {
    const cyclic = [
      { pid: 1, ppid: 2, pgid: 1, comm: "a" },
      { pid: 2, ppid: 1, pgid: 1, comm: "b" },
    ];
    assert.deepEqual(descendantsOf(cyclic, 1).map((r) => r.pid), [2]);
  });

  it("17b. a surviving descendant after cancellation FAILS", () => {
    assert.equal(
      evaluateTerminationCleanliness(
        [
          { pid: 100, ppid: 1, pgid: 100, comm: "node" },
          { pid: 200, ppid: 100, pgid: 200, comm: "python3" },
        ],
        100,
      ).clean,
      false,
    );
    const result = evaluateStageB(
      passingStageBObservations({
        cancellation: measured({
          transitions: ["queued", "analyzing", "downloading", "cancelled"],
          lateReady: false,
          postSample: [
            { pid: 100, ppid: 1, pgid: 100, comm: "node" },
            { pid: 200, ppid: 100, pgid: 200, comm: "python3" },
          ],
          workerPid: 100,
          beganProcessing: false,
          uploaded: false,
          workDirPresent: false,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("cancel.processes-gone"));
  });

  it("17. a late ready after cancellation FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        cancellation: measured({
          transitions: ["queued", "analyzing", "downloading", "cancelled"],
          lateReady: true,
          postSample: [],
          workerPid: 100,
          beganProcessing: false,
          uploaded: false,
          workDirPresent: false,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("cancel.no-late-ready"));
  });

  it("17c. an upload or leftover workDir after cancellation FAILS", () => {
    for (const patch of [{ uploaded: true }, { workDirPresent: true }, { beganProcessing: true }]) {
      const result = evaluateStageB(
        passingStageBObservations({
          cancellation: measured({
            transitions: ["queued", "analyzing", "downloading", "cancelled"],
            lateReady: false,
            postSample: [{ pid: 100, ppid: 1, pgid: 100, comm: "node" }],
            workerPid: 100,
            beganProcessing: false,
            uploaded: false,
            workDirPresent: false,
            ...patch,
          }),
        }),
        passingStageA(),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, JSON.stringify(patch));
    }
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
      const files = new Map([["/tmp/sa.json", body]]);
      const run = await runCli(
        ["--stage", "B", "--aggregate", ...LIVE_ARGS, "--stage-a", "/tmp/sa.json"],
        LIVE_ENV(),
        { runReadOnly: world.runReadOnly, fetch: world.fetch, files },
      );
      assert.equal(run.code, 2, body.slice(0, 40));
      assert.match(run.err, /must name a Stage A record whose verdict is PASS/);
    }
  });
});

// ── CORRECTION-01 §9: case records cannot be forged ────────────────────────

describe("case evidence validation", () => {
  const binding = { expectedSha: SHA, runningImageId: IMAGE_ID };
  const goodPayload = {
    cancellation: {
      transitions: ["queued", "analyzing", "downloading", "cancelled"],
      lateReady: false,
      postSample: [],
      workerPid: 100,
      beganProcessing: false,
      uploaded: false,
      workDirPresent: false,
    },
  };

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
    for (const name of CASE_NAMES) {
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
      }),
      { runReadOnly: world.runReadOnly, fetch: spyFetch },
    );
    assert.equal(run.code, 0);

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
      [{ genericAnalysis: measured({ extractor: "yt-dlp", directAttempted: false, formats: [], presets: APP_PRESETS, thumbnail: null }) }, "analysis.routed-to-generic"],
      [{ genericAnalysis: measured({ extractor: "yt-dlp", directAttempted: true, formats: [{ format_id: "22" }], presets: APP_PRESETS, thumbnail: null }) }, "analysis.no-raw-formats"],
      [{ genericAnalysis: measured({ extractor: "yt-dlp", directAttempted: true, formats: [], presets: APP_PRESETS, thumbnail: "https://t.invalid/x.jpg" }) }, "analysis.no-generic-thumbnail"],
      [{ egressNegative: measured({ denied: true, attributedToBoundary: false }) }, "safe-egress.forbidden-destination-denied"],
      [{ egressPolicyFingerprint: measured({ beforeMatchesAfter: false }) }, "safe-egress.policy-unchanged"],
      [{ workerEnvironmentNames: measured(["R2_WRITER_ACCESS_KEY_ID"]) }, "r2.worker-holds-no-credential"],
      [{ directAfterEnable: measured({ status: "ready", extractor: "direct", sampledBasenames: ["node", "python3"] }) }, "direct.no-ytdlp-spawned"],
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

  it("4b. a Stage B case is refused against a disabled deployment", async () => {
    const world = makeFakeWorld({ ytdlpEnabled: null });
    const run = await runCli(
      ["--stage", "B", "--case", "success", ...LIVE_ARGS, "--evidence", "/tmp/c.json"],
      LIVE_ENV({ VIDEOFETCH_ACCEPT_GENERIC_URL: "https://media.invalid/generic", VIDEOFETCH_ACCEPT_DIRECT_URL: "https://f.invalid/c.mp4" }),
      { runReadOnly: world.runReadOnly, fetch: world.fetch },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /STAGE MISMATCH/);
    assert.match(run.err, /Refusing to run a Stage B case/);
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
