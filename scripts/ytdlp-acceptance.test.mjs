// Tests for the generic yt-dlp Production acceptance harness (§54).
//
// Lives under `scripts/` so `npm test` picks it up through the existing
// `node --test 'scripts/**/*.test.mjs'` glob, alongside every other .mjs suite
// in this repository. The subject under test lives in
// `deploy/acceptance/ytdlp-generic/`.
//
// NOTHING HERE RUNS LIVE. Every test drives the pure evaluators or the CLI's
// `main()` with injected fakes; the observer layer is never invoked, no command
// is spawned, no socket is opened, and `VIDEOFETCH_ACCEPT_LIVE` is never set in
// the real process environment — the tests pass their own env objects instead.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateLiveGate,
  readStage,
  readOption,
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
} from "../deploy/acceptance/ytdlp-generic/lib/redact.mjs";
import {
  classifyAcquisitionTree,
  evaluateNamespaceIdentity,
  evaluateNodeContainment,
  evaluateTerminationCleanliness,
  validateSampleShape,
  descendantsOf,
} from "../deploy/acceptance/ytdlp-generic/lib/process-tree.mjs";
import {
  evaluateStageA,
  enablementAuthorized,
  rejectsStageBConfiguration,
} from "../deploy/acceptance/ytdlp-generic/lib/stage-a.mjs";
import {
  evaluateStageB,
  transitionsAreOrdered,
} from "../deploy/acceptance/ytdlp-generic/lib/stage-b.mjs";
import {
  buildEvidence,
  renderEvidence,
  mintSentinel,
  withSentinel,
  sweepForSentinel,
} from "../deploy/acceptance/ytdlp-generic/lib/evidence.mjs";
import { isReadOnlyCommand } from "../deploy/acceptance/ytdlp-generic/lib/observers.mjs";
import { main } from "../deploy/acceptance/ytdlp-generic/acceptance.mjs";

// ── Fixtures ───────────────────────────────────────────────────────────────

const measured = (value) => ({ measured: true, value });
const unmeasured = (reason) => ({ measured: false, reason });

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const DIGEST = "b".repeat(64);

/** A Stage A observation bundle in which every gate passes. */
function passingStageAObservations(overrides = {}) {
  const services = {};
  for (const unit of [
    "videofetch-media-dns",
    "videofetch-media-netns",
    "videofetch-egress-policy",
    "videofetch-egress-watchdog",
    "videofetch-r2-broker",
    "videofetch-worker",
    "vf-cloudflared",
  ]) {
    services[unit] = measured({ unit, activeState: "active" });
  }

  return {
    services,
    runningImageId: measured(IMAGE_ID),
    imageShaTag: measured({
      expectedSha: "90be3d079a26b851c5f7496801647568533e6a2d",
      taggedImageId: IMAGE_ID,
      runningImageId: IMAGE_ID,
    }),
    imageLatestAlias: measured({ latestImageId: IMAGE_ID, taggedImageId: IMAGE_ID }),
    egressVerifier: measured({ exitCode: 0 }),
    workerNetworkMode: measured("container:videofetch-media-netns"),
    ytdlpVersion: measured("2026.08.19"),
    pythonVersion: measured("3.11.2"),
    nodeVersion: measured("v22.23.2"),
    bundledEjsVersion: measured("0.8.0"),
    capabilities: measured({
      ytdlp: false,
      ytdlpInstalled: true,
      ytdlpEnabled: false,
      ffmpeg: true,
    }),
    ytdlpEnabledRaw: measured(null),
    workerEnvironmentNames: measured([
      "WORKER_CONTROL_KEY_ID",
      "WORKER_CONTROL_SECRET",
      "R2_ACCOUNT_ID",
      "R2_BUCKET",
      "R2_BROKER_SOCKET_PATH",
    ]),
    directRegression: measured({
      status: "ready",
      extractor: "direct",
      expectedDigest: DIGEST,
      deliveredDigest: DIGEST,
      expectedBytes: 83089,
      deliveredBytes: 83089,
    }),
    ...overrides,
  };
}

const passingStageA = () => evaluateStageA(passingStageAObservations());

/** A process sample in which acquisition looks exactly as designed. */
function acquisitionSample(extra = []) {
  return [
    { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "net:[4026532001]" },
    { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: "net:[4026532001]" },
    ...extra,
  ];
}

function passingStageBObservations(overrides = {}) {
  return {
    capabilities: measured({ ytdlp: true, ytdlpInstalled: true, ytdlpEnabled: true, ffmpeg: true }),
    ytdlpEnabledRaw: measured("true"),
    genericAnalysis: measured({
      extractor: "yt-dlp",
      directAttempted: true,
      formats: [],
      presets: ["preset:720", "preset:audio"],
      thumbnail: null,
    }),
    genericJob: measured({
      transitions: ["queued", "analyzing", "downloading", "processing", "uploading", "ready"],
      requestedFormatId: "preset:720",
    }),
    durableJobRow: measured({ extractor: "yt-dlp", status: "ready" }),
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
      workerDigest: DIGEST,
      clientDigest: DIGEST,
      workerBytes: 83089,
      clientBytes: 83089,
    }),
    sentinelSweep: measured({
      leaked: false,
      leakedSurfaces: [],
      surfacesChecked: ["journal", "docker-logs", "durable-error", "job-metadata", "api-error"],
    }),
    cancellation: measured({
      finalStatus: "cancelled",
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
    directAfterEnable: measured({
      status: "ready",
      extractor: "direct",
      sampledBasenames: ["node"],
    }),
    failClosedRuntime: measured({
      genericUsable: false,
      fellBackToPath: false,
      directStillWorks: true,
    }),
    killSwitch: measured({ genericUsableAfterDisable: false, directWorks: true }),
    siteCatalog: measured({ limitedEntriesPromoted: false }),
    ...overrides,
  };
}

/** Captures a `main()` run without letting it touch anything real. */
async function runCli(argv, env, deps = {}) {
  const lines = [];
  const errors = [];
  const code = await main(argv, env, {
    log: (line) => lines.push(String(line)),
    errorLog: (line) => errors.push(String(line)),
    writeFile: async () => {},
    readFile: async () => {
      throw new Error("no stage A record");
    },
    // If a test does not supply this, any attempt to observe a real system
    // fails loudly rather than silently shelling out.
    collectObservations: async () => {
      throw new Error("collectObservations must be injected in tests");
    },
    ...deps,
  });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

// ── 1-3. Accidental-live prevention (§9, §54.1-3) ──────────────────────────

describe("accidental live execution", () => {
  it("1. default invocation cannot run live", async () => {
    const gate = evaluateLiveGate([], {});
    assert.equal(gate.live, false);
    assert.equal(gate.mode, "dry-run");

    const run = await runCli(["--stage", "A"], {});
    assert.equal(run.code, 2, "a dry run exits BLOCKED, never 0");
    assert.match(run.out, /LIVE EXECUTION REFUSED/);
    assert.match(run.out, /Production mutation\s*:\s*NONE/);
    assert.match(run.out, /network media request\s*:\s*NONE/);
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
      assert.equal(
        evaluateLiveGate(["--live"], { [LIVE_ENV_NAME]: value }).live,
        false,
        `${JSON.stringify(value)} must not be accepted as the opt-in`,
      );
    }
    assert.equal(evaluateLiveGate(["--live"], { [LIVE_ENV_NAME]: "1" }).live, true);
  });

  it("2c. nothing auto-detects a live run", () => {
    // A rich environment that looks exactly like a Production host must still
    // produce a dry run. There is no host, docker, URL or CI heuristic.
    const productionish = {
      DOCKER_HOST: "unix:///var/run/docker.sock",
      VIDEOFETCH_ACCEPT_GENERIC_URL: "https://example.invalid/v",
      VIDEOFETCH_ACCESS_SECRET: "x".repeat(40),
      CI: "true",
      NODE_ENV: "production",
    };
    assert.equal(evaluateLiveGate([], productionish).live, false);
    assert.equal(evaluateLiveGate(["--stage", "A"], productionish).live, false);
  });

  it("3. both live gates enter the live orchestration seam", async () => {
    let entered = false;
    const run = await runCli(
      ["--stage", "A", "--live", "--base-url", "https://control.invalid"],
      { [LIVE_ENV_NAME]: "1" },
      {
        collectObservations: async () => {
          entered = true;
          return passingStageAObservations();
        },
      },
    );
    assert.equal(entered, true, "the live seam must be reached with both signals");
    assert.equal(run.code, 0);
    assert.match(run.out, /LIVE ACCEPTANCE — stage A/);
    assert.match(run.out, /ENABLEMENT AUTHORIZED/);
  });

  it("3b. a live run still refuses without a control-plane target", async () => {
    const run = await runCli(["--stage", "A", "--live"], { [LIVE_ENV_NAME]: "1" });
    assert.equal(run.code, 3);
    assert.match(run.err, /--base-url is required/);
  });
});

// ── 4. Stage confusion (§11, §54.4) ────────────────────────────────────────

describe("stage separation", () => {
  it("4. Stage A assertions are refused against a Stage B configuration", async () => {
    const run = await runCli(
      ["--stage", "A", "--live", "--base-url", "https://control.invalid"],
      { [LIVE_ENV_NAME]: "1" },
      {
        collectObservations: async () =>
          passingStageAObservations({ ytdlpEnabledRaw: measured("true") }),
      },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /STAGE MISMATCH/);
    assert.match(run.err, /Refusing to grade Stage A/);
  });

  it("4b. Stage B assertions are refused against a Stage A configuration", async () => {
    const run = await runCli(
      ["--stage", "B", "--live", "--base-url", "https://control.invalid"],
      { [LIVE_ENV_NAME]: "1" },
      { collectObservations: async () => passingStageBObservations({ ytdlpEnabledRaw: measured(null) }) },
    );
    assert.equal(run.code, 2);
    assert.match(run.err, /STAGE MISMATCH/);
    assert.match(run.err, /Refusing to grade Stage B/);
  });

  it("4c. the stage is never inferred", () => {
    assert.equal(readStage([]).ok, false);
    assert.equal(readStage(["--stage"]).ok, false);
    assert.equal(readStage(["--stage", "C"]).ok, false);
    assert.equal(readStage(["--stage", "a"]).ok, false, "the stage is case-exact");
    assert.deepEqual(readStage(["--stage", "B"]), { ok: true, stage: "B" });
  });

  it("4d. Stage B refuses to grade without a PASSING Stage A record", async () => {
    // No --stage-a at all.
    const missing = await runCli(
      ["--stage", "B", "--live", "--base-url", "https://control.invalid"],
      { [LIVE_ENV_NAME]: "1" },
      { collectObservations: async () => passingStageBObservations() },
    );
    assert.equal(missing.code, 2);
    assert.match(missing.err, /requires --stage-a/);

    // Present, but the record itself did not pass.
    const failed = await runCli(
      ["--stage", "B", "--live", "--base-url", "https://control.invalid", "--stage-a", "x.json"],
      { [LIVE_ENV_NAME]: "1" },
      {
        collectObservations: async () => passingStageBObservations(),
        readFile: async () => JSON.stringify({ stage: "A", verdict: "FAIL" }),
      },
    );
    assert.equal(failed.code, 2);
    assert.match(failed.err, /requires --stage-a/);
  });

  it("4e. evaluateStageB refuses directly, not only through the CLI", () => {
    const result = evaluateStageB(passingStageBObservations(), {
      summary: { verdict: OUTCOMES.FAIL },
    });
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.equal(result.checks[0].id, "stage-b.authorized-by-stage-a");
  });
});

// ── 5, 19. Redaction (§45, §54.5, §54.19) ──────────────────────────────────

describe("redaction", () => {
  it("5. query strings are redacted", () => {
    assert.equal(
      redactUrl("https://host.example/path?token=secret&x=1"),
      "https://host.example/path?<redacted>",
    );
    assert.equal(redactUrl("https://host.example/path"), "https://host.example/path");
    // A fragment is dropped entirely.
    assert.equal(redactUrl("https://host.example/p#tok=abc"), "https://host.example/p");
    // Credentials in the authority are never re-emitted.
    assert.equal(redactUrl("https://user:pw@host.example/p"), "https://host.example/p");
  });

  it("5b. an unparseable value is not passed through", () => {
    assert.equal(redactUrl("not a url ?token=secret"), "<unparseable-url>");
    assert.equal(redactUrl(""), "<no-url>");
    assert.equal(redactUrl(undefined), "<no-url>");
  });

  it("19. full URLs with secret query values are never printed", () => {
    const secretUrl = "https://media.invalid/v?sig=SUPERSECRETVALUE&expires=99";
    const text = `failed to fetch ${secretUrl} after 2 retries`;
    const rendered = redactText(text);
    assert.doesNotMatch(rendered, /SUPERSECRETVALUE/);
    assert.doesNotMatch(rendered, /expires=99/);
    assert.match(rendered, /media\.invalid\/v\?<redacted>/);
  });

  it("5c. redaction is IDEMPOTENT", () => {
    // The evidence record is redacted at more than one level, so an already
    // redacted URL is re-processed in normal operation. A non-idempotent pass
    // renders `https://host/path<redacted>` — unparseable, and no longer
    // showing that a query was removed at all.
    const once = redactUrl("https://host.example/path?token=secret");
    assert.equal(once, "https://host.example/path?<redacted>");
    assert.equal(redactText(once), once);
    assert.equal(redactText(redactText(once)), once);
    assert.equal(redactUrl(once), once);
  });

  it("19b. redaction reaches nested evidence values", () => {
    const deep = redactDeep({
      a: { b: ["see https://h.invalid/p?k=SECRET"] },
      n: 5,
    });
    assert.doesNotMatch(JSON.stringify(deep), /SECRET/);
    assert.equal(deep.n, 5);
  });

  it("19c. the whole evidence record is redacted, at every depth", () => {
    const record = buildEvidence({
      stage: "B",
      acceptanceUrl: "https://media.invalid/watch?v=abc&token=LEAKME",
      checks: [
        {
          id: "x",
          outcome: "FAIL",
          required: true,
          detail: "upstream said https://media.invalid/e?err=LEAKME",
        },
      ],
      summary: { verdict: "FAIL", counts: {}, blocking: ["x"], notExercised: [] },
    });
    const rendered = renderEvidence(record, []);
    assert.doesNotMatch(rendered, /LEAKME/);
    assert.doesNotMatch(rendered, /v=abc/);
    assert.match(rendered, /media\.invalid/);
  });
});

// ── 6. Sentinel (§46, §54.6) ───────────────────────────────────────────────

describe("sentinel", () => {
  it("6. the sentinel never reaches evidence output", () => {
    const sentinel = mintSentinel();
    assert.match(sentinel, /^VF_ACCEPT_SECRET_[0-9a-f]{32}$/);

    const submitted = withSentinel("https://media.invalid/watch?v=abc", sentinel);
    assert.ok(submitted.includes(sentinel), "the sentinel does travel in the submitted URL");

    const sweep = sweepForSentinel(
      {
        journal: "worker started; job ready",
        "docker-logs": "no errors",
        "durable-error": "",
        "job-metadata": JSON.stringify({ status: "ready" }),
        "api-error": "",
      },
      sentinel,
    );
    assert.equal(sweep.value.leaked, false);

    const record = buildEvidence({
      stage: "B",
      acceptanceUrl: submitted,
      sentinelSweep: sweep.value,
      checks: [],
      summary: { verdict: "PASS", counts: {}, blocking: [], notExercised: [] },
    });
    const rendered = renderEvidence(record, [sentinel]);
    assert.doesNotMatch(rendered, new RegExp(sentinel), "the sentinel must never be written out");
    assert.match(rendered, /"leaked": false/);
    // The record states the sweep happened without naming the needle.
    assert.doesNotMatch(rendered, /VF_ACCEPT_SECRET/);
  });

  it("6b. a leak is DETECTED and reported without disclosing the value", () => {
    const sentinel = mintSentinel();
    const sweep = sweepForSentinel(
      { journal: `GET /media?vf_accept=${sentinel} failed`, "docker-logs": "" },
      sentinel,
    );
    assert.equal(sweep.value.leaked, true);
    assert.deepEqual(sweep.value.leakedSurfaces, ["journal"]);
    assert.doesNotMatch(JSON.stringify(sweep.value), new RegExp(sentinel));
  });

  it("6c. the scrub backstop catches a value that escaped redaction", () => {
    const sentinel = mintSentinel();
    assert.doesNotMatch(scrubSecrets(`raw ${sentinel} here`, [sentinel]), new RegExp(sentinel));
    // safeOutput redacts first, so a sentinel inside a query is removed as a
    // query rather than surviving to the scrub stage.
    const out = safeOutput(`see https://h.invalid/p?vf_accept=${sentinel}`, [sentinel]);
    assert.equal(out, "see https://h.invalid/p?<redacted>");
  });

  it("6d. a Stage B run whose sentinel leaked FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        sentinelSweep: measured({
          leaked: true,
          leakedSurfaces: ["journal"],
          surfacesChecked: ["journal", "docker-logs", "durable-error", "job-metadata", "api-error"],
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("privacy.sentinel-not-leaked"));
  });
});

// ── 7. Secret environment reporting (§16, §17, §54.7) ──────────────────────

describe("secret handling", () => {
  it("7. secret environment variables are reported only as present/absent", () => {
    const presence = describePresence("WORKER_CONTROL_SECRET", "an-actual-secret-value");
    assert.deepEqual(presence, { name: "WORKER_CONTROL_SECRET", present: true });
    assert.equal(Object.keys(presence).length, 2, "no value, no length, no hash");
    assert.deepEqual(describePresence("R2_WRITER_ACCESS_KEY_ID", undefined), {
      name: "R2_WRITER_ACCESS_KEY_ID",
      present: false,
    });
  });

  it("7b. the evidence record carries names only, never values", async () => {
    let written = "";
    await runCli(
      [
        "--stage",
        "A",
        "--live",
        "--base-url",
        "https://control.invalid",
        "--evidence",
        "/dev/null",
      ],
      { [LIVE_ENV_NAME]: "1" },
      {
        collectObservations: async () => passingStageAObservations(),
        writeFile: async (_path, contents) => {
          written = contents;
        },
      },
    );
    assert.match(written, /WORKER_CONTROL_SECRET/, "the NAME is recorded");
    assert.doesNotMatch(written, /an-actual-secret-value/);
    const parsed = JSON.parse(written);
    assert.ok(Array.isArray(parsed.workerEnvironment.boundNames));
    for (const entry of parsed.workerEnvironment.boundNames) {
      assert.equal(typeof entry, "string");
      assert.doesNotMatch(entry, /=/, "a name/value pair must never survive into evidence");
    }
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

  it("7d. the observer allowlist forbids repair and rotation commands", () => {
    // §50 / §51: these are not discouraged, they are unrepresentable.
    for (const [file, argv] of [
      ["systemctl", ["restart", "videofetch-egress-policy"]],
      ["systemctl", ["stop", "videofetch-worker"]],
      ["nft", ["flush", "ruleset"]],
      ["ip", ["route", "add", "default", "via", "10.0.0.1"]],
      ["docker", ["network", "connect", "bridge", "videofetch-worker"]],
      ["docker", ["run", "-d", "videofetch-worker:latest"]],
      ["docker", ["exec", "videofetch-worker", "sh", "-c", "echo YTDLP_ENABLED=true >> /etc/x"]],
      ["docker", ["exec", "videofetch-worker", "cat", "/etc/videofetch/worker.env"]],
      ["sh", ["-c", "anything"]],
      ["/usr/local/sbin/vf-egress-policy-install", []],
    ]) {
      assert.equal(
        isReadOnlyCommand(file, argv),
        false,
        `${file} ${argv[0]} must be outside the read-only allowlist`,
      );
    }
  });

  it("7e. the allowlist does admit the read-only observations the harness needs", () => {
    assert.equal(isReadOnlyCommand("systemctl", ["is-active", "videofetch-worker"]), true);
    assert.equal(isReadOnlyCommand("docker", ["inspect", "videofetch-worker"]), true);
    assert.equal(isReadOnlyCommand("/usr/local/sbin/vf-egress-policy-verify", []), true);
    assert.equal(
      isReadOnlyCommand("docker", ["exec", "videofetch-worker", "node", "--version"]),
      true,
    );
  });
});

// ── 8, 9, 10. Stage A gates (§15, §13, §18, §54.8-10) ──────────────────────

describe("Stage A gates", () => {
  it("a fully healthy Stage A deployment passes and authorizes enablement", () => {
    const result = passingStageA();
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
    assert.equal(enablementAuthorized(result).authorized, true);
  });

  it("8. a failed safe-egress prerequisite is BLOCKED, and enablement is refused", () => {
    // Unmeasurable -> BLOCKED (§49).
    const unmeasurable = evaluateStageA(
      passingStageAObservations({ egressVerifier: unmeasured("verifier not executable") }),
    );
    assert.equal(unmeasurable.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(unmeasurable.summary.blocking.includes("safe-egress.verifier"));
    assert.equal(enablementAuthorized(unmeasurable).authorized, false);

    // Measured and failing -> FAIL. Either way, not authorized.
    const failing = evaluateStageA(
      passingStageAObservations({ egressVerifier: measured({ exitCode: 1 }) }),
    );
    assert.equal(failing.summary.verdict, OUTCOMES.FAIL);
    assert.equal(enablementAuthorized(failing).authorized, false);
    assert.match(enablementAuthorized(failing).reason, /STOP BEFORE GENERIC ENABLEMENT/);
  });

  it("8b. any missing required service blocks enablement", () => {
    for (const unit of [
      "videofetch-egress-watchdog",
      "videofetch-r2-broker",
      "videofetch-media-dns",
      "vf-cloudflared",
    ]) {
      const result = evaluateStageA(
        passingStageAObservations({
          services: {
            ...passingStageAObservations().services,
            [unit]: measured({ unit, activeState: "failed" }),
          },
        }),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, `${unit} failing must fail Stage A`);
      assert.equal(enablementAuthorized(result).authorized, false);
    }
  });

  it("9. a failed exact runtime check is BLOCKED or FAIL, never a pass", () => {
    // Unmeasurable.
    const blocked = evaluateStageA(
      passingStageAObservations({ ytdlpVersion: unmeasured("diagnostics unreachable") }),
    );
    assert.equal(blocked.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(blocked.summary.blocking.includes("runtime.ytdlp-version"));

    // A NEWER date-shaped version is a different reviewed artifact, not an upgrade.
    for (const version of ["2026.09.01", "2025.01.01", "latest", "2026.08.19.1", ""]) {
      const result = evaluateStageA(passingStageAObservations({ ytdlpVersion: measured(version) }));
      assert.equal(
        result.summary.verdict,
        OUTCOMES.FAIL,
        `yt-dlp ${JSON.stringify(version)} must not be accepted`,
      );
    }
  });

  it("9b. Python, Node and EJS identities are asserted exactly", () => {
    assert.equal(
      evaluateStageA(passingStageAObservations({ pythonVersion: measured("3.9.2") })).summary
        .verdict,
      OUTCOMES.FAIL,
    );
    assert.equal(
      evaluateStageA(passingStageAObservations({ nodeVersion: measured("v20.11.0") })).summary
        .verdict,
      OUTCOMES.FAIL,
    );
    assert.equal(
      evaluateStageA(passingStageAObservations({ bundledEjsVersion: measured("0.9.0") })).summary
        .verdict,
      OUTCOMES.FAIL,
    );
  });

  it("9c. an unidentifiable running image is BLOCKED (§49)", () => {
    const result = evaluateStageA(
      passingStageAObservations({ runningImageId: unmeasured("container is not running") }),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("image.identity"));
  });

  it("9d. an image that is not the authorized SHA build fails", () => {
    const other = `sha256:${"c".repeat(64)}`;
    const result = evaluateStageA(
      passingStageAObservations({
        imageShaTag: measured({
          expectedSha: "90be3d0",
          taggedImageId: other,
          runningImageId: IMAGE_ID,
        }),
      }),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("image.matches-authorized-sha"));
  });

  it("9e. `latest` pointing at a different image object fails", () => {
    const result = evaluateStageA(
      passingStageAObservations({
        imageLatestAlias: measured({
          latestImageId: `sha256:${"d".repeat(64)}`,
          taggedImageId: IMAGE_ID,
        }),
      }),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("image.latest-alias-is-same-object"));
  });

  it("9f. a generic-enabled or untruthful capability report fails Stage A", () => {
    const enabled = evaluateStageA(
      passingStageAObservations({
        capabilities: measured({
          ytdlp: true,
          ytdlpInstalled: true,
          ytdlpEnabled: true,
          ffmpeg: true,
        }),
      }),
    );
    assert.equal(enabled.summary.verdict, OUTCOMES.FAIL);
    assert.ok(enabled.summary.blocking.includes("capability.generic-not-usable"));
  });

  it("9g. a forbidden Worker environment variable fails, by NAME alone", () => {
    for (const name of [
      "YTDLP_NETWORK_ISOLATED",
      "YTDLP_PATH",
      "R2_WRITER_ACCESS_KEY_ID",
      "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
    ]) {
      const result = evaluateStageA(
        passingStageAObservations({
          workerEnvironmentNames: measured([
            "WORKER_CONTROL_KEY_ID",
            "WORKER_CONTROL_SECRET",
            "R2_ACCOUNT_ID",
            "R2_BUCKET",
            name,
          ]),
        }),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, `${name} must fail the audit`);
      assert.ok(result.summary.blocking.includes("worker-env.forbidden-absent"));
    }
  });

  it("9h. a Worker outside the media network namespace fails", () => {
    const result = evaluateStageA(
      passingStageAObservations({ workerNetworkMode: measured("bridge") }),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("worker.network-mode"));
  });

  it("10. a failed direct regression forbids Stage B", () => {
    const failed = evaluateStageA(
      passingStageAObservations({
        directRegression: measured({ status: "failed", extractor: "direct" }),
      }),
    );
    assert.equal(failed.summary.verdict, OUTCOMES.FAIL);
    assert.equal(enablementAuthorized(failed).authorized, false);
    assert.equal(stageBPermitted(failed.summary), false);

    // And Stage B genuinely refuses to grade against it.
    const stageB = evaluateStageB(passingStageBObservations(), failed);
    assert.equal(stageB.summary.verdict, OUTCOMES.BLOCKED);
    assert.equal(stageB.checks.length, 1);
    assert.equal(stageB.checks[0].id, "stage-b.authorized-by-stage-a");
  });

  it("10b. a direct regression that never happened is BLOCKED, not skipped", () => {
    const result = evaluateStageA(
      passingStageAObservations({ directRegression: unmeasured("operator step not supplied") }),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.equal(stageBPermitted(result.summary), false);
  });

  it("10c. a byte mismatch in the direct regression fails", () => {
    const result = evaluateStageA(
      passingStageAObservations({
        directRegression: measured({
          status: "ready",
          extractor: "direct",
          expectedDigest: DIGEST,
          deliveredDigest: "c".repeat(64),
          expectedBytes: 83089,
          deliveredBytes: 83089,
        }),
      }),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("direct.byte-integrity"));
  });
});

// ── 11-15. Process evidence (§29-§32, §54.11-15) ───────────────────────────

describe("process-tree evidence", () => {
  const withDescendant = (comm) =>
    measured({
      sample: acquisitionSample([
        { pid: 300, ppid: 200, pgid: 200, comm, netns: "net:[4026532001]" },
      ]),
      workerPid: 100,
      ytdlpPid: 200,
      expectedNetns: "net:[4026532001]",
    });

  it("11. ffmpeg during downloading FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({ downloadingSample: withDescendant("ffmpeg") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.no-ffmpeg-during-downloading"));
  });

  it("12. ffprobe during downloading FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({ downloadingSample: withDescendant("ffprobe") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.no-ffmpeg-during-downloading"));
  });

  it("12b. every other forbidden acquisition helper also FAILS", () => {
    for (const comm of ["curl", "wget", "aria2c", "axel", "sh", "bash", "rtmpdump"]) {
      const result = evaluateStageB(
        passingStageBObservations({ downloadingSample: withDescendant(comm) }),
        passingStageA(),
      );
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, `${comm} must fail`);
    }
  });

  it("12c. an absolute path is classified by basename, not by string equality", () => {
    const classified = classifyAcquisitionTree(
      acquisitionSample([
        { pid: 300, ppid: 200, pgid: 200, comm: "/usr/bin/ffmpeg", netns: "n" },
      ]),
      100,
    );
    assert.deepEqual(
      classified.forbidden.map((r) => r.comm),
      ["ffmpeg"],
    );
  });

  it("13. allowed Python/Node descendants are accepted structurally", () => {
    const result = evaluateStageB(
      passingStageBObservations({ downloadingSample: withDescendant("node") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.PASS);

    const classified = classifyAcquisitionTree(
      acquisitionSample([{ pid: 300, ppid: 200, pgid: 200, comm: "node", netns: "n" }]),
      100,
    );
    assert.equal(classified.forbidden.length, 0);
    assert.equal(classified.unknown.length, 0);
    assert.deepEqual(classified.basenames, ["node", "python3"]);
  });

  it("13b. an UNKNOWN descendant is not quietly tolerated", () => {
    const result = evaluateStageB(
      passingStageBObservations({ downloadingSample: withDescendant("perl") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.no-unknown-descendants"));
  });

  it("13c. Node containment is MEASURED, never assumed", () => {
    const contained = evaluateNodeContainment(
      classifyAcquisitionTree(
        acquisitionSample([{ pid: 300, ppid: 200, pgid: 200, comm: "node", netns: "ns1" }]),
        100,
      ),
      200,
      "ns1",
    );
    assert.equal(contained.exercised, true);
    assert.equal(contained.contained, true);

    // Escaped the owned process group.
    const escaped = evaluateNodeContainment(
      classifyAcquisitionTree(
        acquisitionSample([{ pid: 300, ppid: 200, pgid: 999, comm: "node", netns: "ns1" }]),
        100,
      ),
      200,
      "ns1",
    );
    assert.equal(escaped.contained, false);
    assert.match(escaped.failures.join(" "), /left the owned process group/);

    // Not a descendant of the owned yt-dlp process.
    const detached = evaluateNodeContainment(
      classifyAcquisitionTree(
        [
          { pid: 100, ppid: 1, pgid: 100, comm: "node", netns: "ns1" },
          { pid: 200, ppid: 100, pgid: 200, comm: "python3", netns: "ns1" },
          { pid: 300, ppid: 100, pgid: 200, comm: "node", netns: "ns1" },
        ],
        100,
      ),
      200,
      "ns1",
    );
    assert.equal(detached.contained, false);
    assert.match(detached.failures.join(" "), /not a descendant/);
  });

  it("13d. a source that never invokes Node reports NOT_EXERCISED, not PASS", () => {
    const result = evaluateStageB(passingStageBObservations(), passingStageA());
    const node = result.checks.find((c) => c.id === "process.node-ejs-containment");
    assert.equal(node.outcome, OUTCOMES.NOT_EXERCISED);
    assert.match(node.detail, /NODE\/EJS DESCENDANT NOT EXERCISED BY THIS SOURCE/);
    // Optional coverage does not fail the run…
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
    // …but it IS recorded as unproven.
    assert.ok(result.summary.notExercised.includes("process.node-ejs-containment"));
  });

  it("14. inability to inspect descendants is BLOCKED, not PASS", () => {
    const result = evaluateStageB(
      passingStageBObservations({ downloadingSample: unmeasured("ps unavailable in namespace") }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("process.sample-available"));
    // And no downstream process check silently passed in its place.
    for (const id of ["process.no-ffmpeg-during-downloading", "process.namespace-identity"]) {
      assert.equal(result.checks.find((c) => c.id === id), undefined);
    }
  });

  it("14b. a sample carrying a command line is rejected outright (§29)", () => {
    const shape = validateSampleShape([
      { pid: 1, ppid: 0, pgid: 1, comm: "python3", cmdline: "yt-dlp https://x/?token=SECRET" },
    ]);
    assert.equal(shape.ok, false);
    assert.match(shape.violations.join(" "), /forbidden field 'cmdline'/);

    const result = evaluateStageB(
      passingStageBObservations({
        downloadingSample: measured({
          sample: [
            { pid: 100, ppid: 1, pgid: 100, comm: "node" },
            { pid: 200, ppid: 100, pgid: 200, comm: "python3", argv: ["yt-dlp", "https://x"] },
          ],
          workerPid: 100,
          ytdlpPid: 200,
          expectedNetns: "n",
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("process.sample-shape"));
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
          expectedNetns: "net:[4026532001]",
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
    const evaluation = evaluateNamespaceIdentity(classified, "net:[4026532001]");
    assert.equal(evaluation.consistent, false);
    assert.deepEqual(
      evaluation.offenders.map((o) => o.pid),
      [300],
    );
  });

  it("15c. an unknown expected namespace is BLOCKED", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        downloadingSample: measured({
          sample: acquisitionSample(),
          workerPid: 100,
          ytdlpPid: 200,
          expectedNetns: null,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.BLOCKED);
    assert.ok(result.summary.blocking.includes("process.namespace-identity"));
  });

  it("15d. descendant walking survives a malformed (cyclic) sample", () => {
    const cyclic = [
      { pid: 1, ppid: 2, pgid: 1, comm: "a" },
      { pid: 2, ppid: 1, pgid: 1, comm: "b" },
    ];
    assert.deepEqual(
      descendantsOf(cyclic, 1).map((r) => r.pid),
      [2],
    );
  });
});

// ── 16-18. Delivery, cancellation and the byte guard (§37-§39, §54.16-18) ──

describe("Stage B outcome matrix", () => {
  it("a fully successful Stage B run passes", () => {
    const result = evaluateStageB(passingStageBObservations(), passingStageA());
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
  });

  it("16. a final byte digest mismatch FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        vercelDelivery: measured({
          redirectStatus: 303,
          presigned: true,
          workerDigest: DIGEST,
          clientDigest: "e".repeat(64),
          workerBytes: 83089,
          clientBytes: 83089,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("vercel.byte-digest"));
  });

  it("16b. a 200 with no digest is NOT byte-integrity proof (§37)", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        vercelDelivery: measured({
          redirectStatus: 303,
          presigned: true,
          httpStatus: 200,
          workerBytes: 83089,
          clientBytes: 83089,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("vercel.byte-digest"));
  });

  it("16c. a length mismatch FAILS even when the digest field agrees", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        vercelDelivery: measured({
          redirectStatus: 303,
          presigned: true,
          workerDigest: DIGEST,
          clientDigest: DIGEST,
          workerBytes: 83089,
          clientBytes: 4,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
  });

  it("17. a late ready after cancellation FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        cancellation: measured({
          finalStatus: "cancelled",
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
    assert.ok(result.summary.blocking.includes("cancel.durable-cancelled"));
  });

  it("17b. a surviving descendant after cancellation FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        cancellation: measured({
          finalStatus: "cancelled",
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
  });

  it("17c. an upload or leftover workDir after cancellation FAILS", () => {
    for (const patch of [{ uploaded: true }, { workDirPresent: true }, { beganProcessing: true }]) {
      const result = evaluateStageB(
        passingStageBObservations({
          cancellation: measured({
            finalStatus: "cancelled",
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
      assert.equal(result.summary.verdict, OUTCOMES.FAIL, `${JSON.stringify(patch)} must fail`);
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
    assert.ok(result.summary.blocking.includes("limit.actual-byte-guard"));
    const entry = result.checks.find((c) => c.id === "limit.actual-byte-guard");
    assert.match(entry.detail, /NOT MEASURABLE/);
    assert.match(entry.detail, /LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN/);
  });

  it("18b. a byte-limit case with a KNOWN declared length does not satisfy §38", () => {
    // A source whose Content-Length was declared is caught by --max-filesize,
    // which is explicitly not evidence for the actual-byte watcher.
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

  it("18c. an over-limit source that was uploaded anyway FAILS", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        byteLimitCase: measured({
          declaredLengthUnknown: true,
          outcome: "TOO_LARGE",
          beganProcessing: false,
          uploaded: true,
          workDirPresent: false,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
  });

  it("routes generic only after direct was attempted first (§25)", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        genericAnalysis: measured({
          extractor: "yt-dlp",
          directAttempted: false,
          formats: [],
          presets: ["preset:720"],
          thumbnail: null,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("analysis.routed-to-generic"));
  });

  it("rejects a raw upstream format id anywhere it could surface (§25, §27, §28)", () => {
    // Advertised as a browser option.
    const advertised = evaluateStageB(
      passingStageBObservations({
        genericAnalysis: measured({
          extractor: "yt-dlp",
          directAttempted: true,
          formats: [],
          presets: ["22"],
          thumbnail: null,
        }),
      }),
      passingStageA(),
    );
    assert.equal(advertised.summary.verdict, OUTCOMES.FAIL);
    assert.ok(advertised.summary.blocking.includes("analysis.presets-application-owned"));

    // Exposed in the raw format list.
    const formats = evaluateStageB(
      passingStageBObservations({
        genericAnalysis: measured({
          extractor: "yt-dlp",
          directAttempted: true,
          formats: [{ format_id: "22" }],
          presets: ["preset:720"],
          thumbnail: null,
        }),
      }),
      passingStageA(),
    );
    assert.equal(formats.summary.verdict, OUTCOMES.FAIL);

    // Persisted durably.
    for (const field of ["format_id", "formatId", "sourceUrl", "selector"]) {
      const durable = evaluateStageB(
        passingStageBObservations({
          durableJobRow: measured({ extractor: "yt-dlp", [field]: "22" }),
        }),
        passingStageA(),
      );
      assert.equal(durable.summary.verdict, OUTCOMES.FAIL, `durable ${field} must fail`);
      assert.ok(durable.summary.blocking.includes("durable.no-raw-selector-fields"));
    }
  });

  it("requires ordered durable transitions ending in ready (§26)", () => {
    assert.equal(
      transitionsAreOrdered(["queued", "analyzing", "downloading", "uploading", "ready"]),
      true,
      "a missed poll of `processing` is legitimate",
    );
    assert.equal(transitionsAreOrdered(["queued", "ready"]), true);
    assert.equal(
      transitionsAreOrdered(["queued", "downloading", "analyzing", "ready"]),
      false,
      "the ladder must not run backwards",
    );
    assert.equal(transitionsAreOrdered(["queued", "analyzing"]), false, "ready is required");
    assert.equal(transitionsAreOrdered(["queued", "invented", "ready"]), false);
    assert.equal(transitionsAreOrdered("ready"), false);
  });

  it("requires the safe-egress negative case to be attributed to the boundary (§33)", () => {
    const unattributed = evaluateStageB(
      passingStageBObservations({
        egressNegative: measured({ denied: true, attributedToBoundary: false }),
      }),
      passingStageA(),
    );
    assert.equal(unattributed.summary.verdict, OUTCOMES.FAIL);
    assert.ok(unattributed.summary.blocking.includes("safe-egress.forbidden-destination-denied"));
  });

  it("fails if the egress policy changed across the run (§34)", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        egressPolicyFingerprint: measured({ beforeMatchesAfter: false }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("safe-egress.policy-unchanged"));
  });

  it("fails if the Worker gained an R2 credential (§35)", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        workerEnvironmentNames: measured(["WORKER_CONTROL_KEY_ID", "R2_WRITER_ACCESS_KEY_ID"]),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("r2.worker-holds-no-credential"));
  });

  it("fails if yt-dlp was spawned for a direct source after enablement (§41)", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        directAfterEnable: measured({
          status: "ready",
          extractor: "direct",
          sampledBasenames: ["node", "python3"],
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("direct.no-ytdlp-spawned"));
  });

  it("fails if the kill switch does not disable generic execution (§43)", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        killSwitch: measured({ genericUsableAfterDisable: true, directWorks: true }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
    assert.ok(result.summary.blocking.includes("killswitch.rollback"));
  });

  it("fails if the site catalog was promoted on the strength of the run (§22)", () => {
    const result = evaluateStageB(
      passingStageBObservations({ siteCatalog: measured({ limitedEntriesPromoted: true }) }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
  });

  it("records an unperformed fail-closed runtime case as NOT_EXERCISED (§42)", () => {
    const result = evaluateStageB(
      passingStageBObservations({ failClosedRuntime: unmeasured("not performed") }),
      passingStageA(),
    );
    // Optional: it does not block the run…
    assert.equal(result.summary.verdict, OUTCOMES.PASS);
    // …but it is reported as unproven rather than passed.
    assert.ok(result.summary.notExercised.includes("runtime.fail-closed"));
  });

  it("still FAILS an optional case that was measured and violated", () => {
    const result = evaluateStageB(
      passingStageBObservations({
        failClosedRuntime: measured({
          genericUsable: true,
          fellBackToPath: true,
          directStillWorks: true,
        }),
      }),
      passingStageA(),
    );
    assert.equal(result.summary.verdict, OUTCOMES.FAIL);
  });
});

// ── Verdict algebra (§49) ──────────────────────────────────────────────────

describe("verdict algebra", () => {
  it("never converts an unmeasurable required property into a pass", () => {
    const entry = measuredCheck("x", { measured: false, reason: "no access" }, () => true, "d");
    assert.equal(entry.outcome, OUTCOMES.BLOCKED);
    // Even a predicate that would return true cannot rescue it.
    assert.equal(summarize([entry]).verdict, OUTCOMES.BLOCKED);
  });

  it("refuses to construct a required NOT_EXERCISED check", () => {
    assert.throws(() => check("x", OUTCOMES.NOT_EXERCISED, "d"), /required/);
    assert.doesNotThrow(() => check("x", OUTCOMES.NOT_EXERCISED, "d", { required: false }));
  });

  it("treats an empty check list as BLOCKED, not PASS", () => {
    assert.equal(summarize([]).verdict, OUTCOMES.BLOCKED);
  });

  it("ranks FAIL above BLOCKED in the run verdict", () => {
    const summary = summarize([
      check("a", OUTCOMES.BLOCKED, ""),
      check("b", OUTCOMES.FAIL, ""),
      check("c", OUTCOMES.PASS, ""),
    ]);
    assert.equal(summary.verdict, OUTCOMES.FAIL);
    assert.deepEqual([...summary.blocking].sort(), ["a", "b"]);
  });

  it("permits Stage B only from a PASSING Stage A summary", () => {
    assert.equal(stageBPermitted({ verdict: OUTCOMES.PASS }), true);
    for (const verdict of [OUTCOMES.FAIL, OUTCOMES.BLOCKED, OUTCOMES.NOT_EXERCISED, undefined]) {
      assert.equal(stageBPermitted({ verdict }), false);
    }
    assert.equal(stageBPermitted(undefined), false);
  });

  it("rejects Stage A grading of an enabled deployment", () => {
    assert.equal(rejectsStageBConfiguration({ ytdlpEnabledRaw: measured("true") }), true);
    assert.equal(rejectsStageBConfiguration({ ytdlpEnabledRaw: measured("false") }), false);
    assert.equal(rejectsStageBConfiguration({ ytdlpEnabledRaw: measured(null) }), false);
    assert.equal(rejectsStageBConfiguration({ ytdlpEnabledRaw: unmeasured("x") }), false);
  });
});

// ── 20. The suite itself performs no live run (§54.20) ─────────────────────

describe("test-suite safety", () => {
  it("20. no live run happens as part of `npm test`", () => {
    // The real process environment must not carry the opt-in, and this suite
    // must never set it. If a developer's shell has it exported, that alone is
    // still not enough — but this assertion documents and enforces that the
    // suite does not supply it.
    assert.notEqual(
      process.env[LIVE_ENV_NAME],
      "1",
      `${LIVE_ENV_NAME} must not be set while running the test suite`,
    );

    // And the CLI's own default, under the REAL environment, is a dry run.
    assert.equal(evaluateLiveGate(process.argv.slice(2), process.env).live, false);
  });

  it("20b. importing the CLI module does not execute it", async () => {
    // `main` is exported and was imported at the top of this file. If importing
    // ran the CLI, this suite would already have printed a plan or attempted a
    // run. Re-importing is likewise inert.
    const again = await import("../deploy/acceptance/ytdlp-generic/acceptance.mjs");
    assert.equal(typeof again.main, "function");
  });

  it("20c. option parsing does not swallow the next flag as a value", () => {
    assert.equal(readOption(["--base-url", "--live"], "--base-url"), null);
    assert.equal(readOption(["--base-url", "https://x.invalid"], "--base-url"), "https://x.invalid");
    assert.equal(readOption([], "--base-url"), null);
  });
});
