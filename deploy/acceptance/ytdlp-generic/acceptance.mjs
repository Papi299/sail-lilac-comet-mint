#!/usr/bin/env node
// Generic yt-dlp PRODUCTION acceptance orchestrator. TEST TOOLING ONLY.
//
// Written by PHASE-10C4-YTDLP-PRODUCTION-ACCEPTANCE-HARNESS-001 for the LATER
// task PHASE-10D-YTDLP-PRODUCTION-STAGED-DEPLOYMENT-AND-LIVE-ACCEPTANCE-001.
// Phase 10C4 did NOT run it against Production, did not deploy, and did not set
// YTDLP_ENABLED. See README.md.
//
// ── Default behaviour ──────────────────────────────────────────────────────
//
//   NO NETWORK.  NO PRODUCTION MUTATION.  NO JOB CREATION.
//
// Running this file with no arguments prints the plan and exits. Live execution
// needs BOTH `--live` and `VIDEOFETCH_ACCEPT_LIVE=1` (§9), and there is no
// auto-detection anywhere that can supply either.
//
// ── What it will never do ──────────────────────────────────────────────────
//
//   * enable yt-dlp (§10) — it does not write worker.env or restart the Worker
//   * repair a failed service, policy or route (§50)
//   * create or rotate a credential (§51)
//   * print a secret, a raw query string, a raw process argv or raw stderr
//
// Usage:
//   node acceptance.mjs --stage A                 # plan only, the default
//   node acceptance.mjs --stage A --live          # still refuses: env missing
//   VIDEOFETCH_ACCEPT_LIVE=1 node acceptance.mjs --stage A --live \
//       --base-url https://<control-plane> --evidence ./stage-a.json
//
// Options:
//   --stage A|B          required; the contract being asserted (§11)
//   --live               half of the double opt-in
//   --base-url <url>     control-plane origin (live only)
//   --evidence <path>    where to write the sanitized JSON record (§44)
//   --stage-a <path>     a prior PASSING Stage A record; REQUIRED for Stage B
//   --container <name>   Worker container name (default videofetch-worker)
//   --expected-sha <sha> the authorized main SHA the image must correspond to
//
// Environment (live only):
//   VIDEOFETCH_ACCEPT_LIVE=1          the second opt-in signal
//   VIDEOFETCH_ACCESS_SECRET          existing private-access secret (§19)
//   VIDEOFETCH_ACCEPT_GENERIC_URL     operator-supplied public test URL (§23)

import { writeFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evaluateLiveGate, readOption, readStage, LIVE_ENV_NAME, LIVE_ENV_VALUE } from "./lib/gate.mjs";
import { OUTCOMES } from "./lib/verdict.mjs";
import {
  evaluateStageA,
  enablementAuthorized,
  rejectsStageBConfiguration,
  REQUIRED_SERVICES,
  FORBIDDEN_WORKER_ENVIRONMENT,
  REQUIRED_WORKER_ENVIRONMENT,
} from "./lib/stage-a.mjs";
import { evaluateStageB } from "./lib/stage-b.mjs";
import { buildEvidence, renderEvidence } from "./lib/evidence.mjs";
import { describePresence, redactUrl } from "./lib/redact.mjs";
import { makeSystemObservers, notMeasured, observe } from "./lib/observers.mjs";

const EXIT = Object.freeze({ PASS: 0, FAIL: 1, BLOCKED: 2, USAGE: 3 });

/**
 * The whole CLI, as a function over its inputs.
 *
 * `argv`, `env` and every side-effecting dependency are parameters, so the test
 * suite drives the real decision logic — including the live gate — without any
 * possibility of reaching a real system.
 */
export async function main(argv, env, deps = {}) {
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;
  const write = deps.writeFile ?? writeFile;
  const read = deps.readFile ?? readFile;

  const stageArg = readStage(argv);
  if (!stageArg.ok) {
    errorLog(`usage error: ${stageArg.error}`);
    return EXIT.USAGE;
  }
  const stage = stageArg.stage;

  const gate = evaluateLiveGate(argv, env);
  const startedAt = new Date().toISOString();

  // ── The default path: refuse, explain, and prove nothing ran ────────────
  if (!gate.live) {
    printDryRun(log, stage, gate);
    const record = buildEvidence({
      stage,
      mode: "dry-run",
      startedAt,
      finishedAt: new Date().toISOString(),
      checks: [],
      summary: {
        verdict: OUTCOMES.BLOCKED,
        counts: { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXERCISED: 0 },
        blocking: ["dry-run"],
        notExercised: [],
      },
    });
    const evidencePath = readOption(argv, "--evidence");
    if (evidencePath) await write(evidencePath, renderEvidence(record, []), "utf8");
    return EXIT.BLOCKED;
  }

  // ── Live orchestration ─────────────────────────────────────────────────
  //
  // Reached only with both signals present. Everything below is measurement;
  // no branch here mutates Production.
  const baseUrl = readOption(argv, "--base-url");
  const expectedSha = readOption(argv, "--expected-sha");
  const container = readOption(argv, "--container") ?? "videofetch-worker";
  const acceptanceUrl = env.VIDEOFETCH_ACCEPT_GENERIC_URL ?? null;

  if (!baseUrl) {
    errorLog("usage error: --base-url is required for a live run");
    return EXIT.USAGE;
  }

  log(`LIVE ACCEPTANCE — stage ${stage}`);
  log(`control plane : ${redactUrl(baseUrl)}`);
  log(`container     : ${container}`);
  if (acceptanceUrl) log(`acceptance URL: ${redactUrl(acceptanceUrl)}`);
  log("");

  const collect = deps.collectObservations ?? collectObservations;
  const obs = await collect({ container, baseUrl, env, stage, expectedSha, deps });

  // ── §11 stage confusion is refused, not graded ──────────────────────────
  if (stage === "A" && rejectsStageBConfiguration(obs)) {
    errorLog(
      "STAGE MISMATCH: YTDLP_ENABLED is 'true' in the deployed configuration, " +
        "so this is a Stage B deployment. Refusing to grade Stage A assertions against it.",
    );
    return EXIT.BLOCKED;
  }
  if (stage === "B" && obs.ytdlpEnabledRaw?.measured === true && obs.ytdlpEnabledRaw.value !== "true") {
    errorLog(
      "STAGE MISMATCH: YTDLP_ENABLED is not 'true' in the deployed configuration, " +
        "so this is a Stage A deployment. Refusing to grade Stage B assertions against it.",
    );
    return EXIT.BLOCKED;
  }

  let result;
  if (stage === "A") {
    result = evaluateStageA(obs);
  } else {
    // Stage B is authorized ONLY by a prior PASSING Stage A record (§20). A
    // missing or non-passing record is BLOCKED, never an implicit pass.
    const stageAPath = readOption(argv, "--stage-a");
    const priorStageA = await loadStageA(stageAPath, read);
    if (!priorStageA) {
      errorLog(
        "BLOCKED: Stage B requires --stage-a pointing at a Stage A record whose verdict is PASS.",
      );
      return EXIT.BLOCKED;
    }
    result = evaluateStageB(obs, priorStageA);
  }

  printChecks(log, result);

  if (stage === "A") {
    const authorization = enablementAuthorized(result);
    log("");
    log(
      authorization.authorized
        ? "ENABLEMENT AUTHORIZED — Stage A passed. The operator may now set YTDLP_ENABLED=true."
        : authorization.reason,
    );
    log("The harness does NOT perform that change (§10).");
  }

  const record = buildEvidence({
    stage,
    mode: "live",
    startedAt,
    finishedAt: new Date().toISOString(),
    expectedSha,
    runningImageId: obs.runningImageId?.value ?? null,
    imageTags: obs.imageShaTag?.value ?? null,
    runtime: {
      ytdlpVersion: obs.ytdlpVersion?.value ?? null,
      pythonVersion: obs.pythonVersion?.value ?? null,
      nodeVersion: obs.nodeVersion?.value ?? null,
      bundledEjsVersion: obs.bundledEjsVersion?.value ?? null,
    },
    services: summarizeServices(obs.services),
    egressVerifier: obs.egressVerifier?.value ?? null,
    capabilities: obs.capabilities?.value ?? null,
    workerEnvironment: summarizeEnvironment(obs.workerEnvironmentNames),
    job: obs.genericJob?.value ?? null,
    processEvidence: summarizeProcess(obs.downloadingSample),
    negativeCases: {
      egress: obs.egressNegative?.value ?? null,
      cancellation: obs.cancellation?.value ?? null,
      byteLimit: obs.byteLimitCase?.value ?? null,
      shutdown: obs.shutdownCase?.value ?? null,
      failClosedRuntime: obs.failClosedRuntime?.value ?? null,
      killSwitch: obs.killSwitch?.value ?? null,
    },
    delivery: obs.vercelDelivery?.value ?? null,
    acceptanceUrl,
    sentinelSweep: obs.sentinelSweep?.value ?? null,
    checks: result.checks,
    summary: result.summary,
  });

  const evidencePath = readOption(argv, "--evidence");
  if (evidencePath) {
    await write(evidencePath, renderEvidence(record, [obs.sentinel].filter(Boolean)), "utf8");
    log(`\nevidence written: ${evidencePath}`);
  }

  log(`\nVERDICT: ${result.summary.verdict}`);
  if (result.summary.verdict === OUTCOMES.PASS) return EXIT.PASS;
  return result.summary.verdict === OUTCOMES.FAIL ? EXIT.FAIL : EXIT.BLOCKED;
}

/** Loads a prior Stage A record and accepts it only if it genuinely passed. */
async function loadStageA(path, read) {
  if (!path) return null;
  try {
    const parsed = JSON.parse(await read(path, "utf8"));
    if (parsed?.stage !== "A" || parsed?.verdict !== OUTCOMES.PASS) return null;
    return { summary: { verdict: parsed.verdict } };
  } catch {
    return null;
  }
}

/**
 * Builds the observation bundle.
 *
 * Every surface this harness cannot reach non-interactively comes back as
 * `notMeasured(...)`, which the stage evaluators turn into BLOCKED. That is the
 * intended behaviour: an operator-assisted step (§18/§19) is an evidence gap
 * until the operator supplies its result, never a silent pass.
 */
export async function collectObservations({ container, baseUrl, env, stage, expectedSha, deps = {} }) {
  const system = deps.system ?? makeSystemObservers({ container });
  const control = deps.control ?? null;

  const services = {};
  for (const unit of REQUIRED_SERVICES) {
    services[unit] = await system.serviceState(unit);
  }

  const runningImageId = await system.runningImageId();

  const bundle = {
    services,
    runningImageId,
    workerNetworkMode: await system.networkMode(),
    workerEnvironmentNames: await system.environmentNames(),
    ytdlpEnabledRaw: await system.ytdlpEnabledRaw(),
    egressVerifier: await system.egressVerifier(),
    pythonVersion: await system.pythonVersion(),
    nodeVersion: await system.nodeVersion(),

    // Image tag relationships (§14). Supplied by the operator's build step,
    // which is the only thing that knows which SHA was built from a clean
    // checkout; the harness verifies the relationship rather than asserting it.
    imageShaTag: deps.imageShaTag ?? notMeasured("no --expected-sha tag relationship supplied"),
    imageLatestAlias:
      deps.imageLatestAlias ?? notMeasured("latest-tag relationship not supplied"),

    // Control-plane surfaces.
    capabilities: control ? await control.capabilities() : notMeasured("no control-plane session"),
    ytdlpVersion: control
      ? await observe("diagnostics runtime.ytdlpVersion", async () => {
          const diagnostics = await control.diagnostics();
          if (diagnostics.measured === false) throw new Error(diagnostics.reason);
          return diagnostics.value.runtime.ytdlpVersion;
        })
      : notMeasured("no control-plane session"),
    bundledEjsVersion: deps.bundledEjsVersion ?? notMeasured("EJS version probe not supplied"),

    // Operator-assisted and job-lifecycle surfaces. Each is BLOCKED until the
    // Phase-10D operator supplies it through `deps`; see README §"Operator
    // steps" for exactly what each one must contain.
    directRegression: deps.directRegression ?? notMeasured("direct-media regression not supplied"),
    genericAnalysis: deps.genericAnalysis ?? notMeasured("generic analysis not performed"),
    genericJob: deps.genericJob ?? notMeasured("generic job not performed"),
    durableJobRow: deps.durableJobRow ?? notMeasured("durable job evidence not supplied"),
    selectorConstraints: deps.selectorConstraints ?? notMeasured("selector evidence not supplied"),
    downloadingSample: deps.downloadingSample ?? notMeasured("process tree not sampled"),
    egressNegative: deps.egressNegative ?? notMeasured("safe-egress negative case not performed"),
    egressPolicyFingerprint:
      deps.egressPolicyFingerprint ?? notMeasured("policy fingerprint not captured"),
    r2Evidence: deps.r2Evidence ?? notMeasured("R2 evidence not supplied"),
    vercelDelivery: deps.vercelDelivery ?? notMeasured("signed GET not performed"),
    sentinelSweep: deps.sentinelSweep ?? notMeasured("sentinel sweep not performed"),
    cancellation: deps.cancellation ?? notMeasured("cancellation case not performed"),
    byteLimitCase:
      deps.byteLimitCase ?? notMeasured("LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN"),
    shutdownCase: deps.shutdownCase ?? notMeasured("shutdown case not performed"),
    directAfterEnable: deps.directAfterEnable ?? notMeasured("post-enable direct regression not performed"),
    failClosedRuntime: deps.failClosedRuntime ?? notMeasured("fail-closed runtime case not performed"),
    killSwitch: deps.killSwitch ?? notMeasured("kill-switch case not performed"),
    siteCatalog: deps.siteCatalog ?? notMeasured("catalog comparison not supplied"),

    sentinel: deps.sentinel ?? null,
    stage,
    expectedSha,
    baseUrl,
    env,
  };

  return bundle;
}

function printDryRun(log, stage, gate) {
  log("╔══════════════════════════════════════════════════════════════════════╗");
  log("║  DRY RUN — LIVE EXECUTION REFUSED                                    ║");
  log("╚══════════════════════════════════════════════════════════════════════╝");
  log("");
  log(`stage requested        : ${stage}`);
  log(`live execution         : REFUSED`);
  log(`Production mutation    : NONE`);
  log(`network media request  : NONE`);
  log(`job created            : NONE`);
  log("");
  log(`reason                 : ${gate.reason}`);
  log("");
  log("To run live, BOTH signals are required:");
  log(`  1. the ${"--live"} flag`);
  log(`  2. ${LIVE_ENV_NAME}=${LIVE_ENV_VALUE} in the environment`);
  log("");
  log("Neither is inferred from anything. See README.md before supplying them.");
}

function printChecks(log, result) {
  log(`── STAGE ${result.stage} ─────────────────────────────────────────────`);
  for (const entry of result.checks) {
    const mark = { PASS: "ok  ", FAIL: "FAIL", BLOCKED: "BLKD", NOT_EXERCISED: "n/ex" }[entry.outcome];
    log(`  [${mark}] ${entry.id}${entry.detail ? ` — ${entry.detail}` : ""}`);
  }
  log("");
  log(
    `  PASS ${result.summary.counts.PASS}  FAIL ${result.summary.counts.FAIL}  ` +
      `BLOCKED ${result.summary.counts.BLOCKED}  NOT_EXERCISED ${result.summary.counts.NOT_EXERCISED}`,
  );
}

function summarizeServices(services) {
  if (!services) return null;
  const out = {};
  for (const [unit, observation] of Object.entries(services)) {
    out[unit] = observation?.measured === true ? observation.value.activeState : "<not-measured>";
  }
  return out;
}

/**
 * Names and booleans only (§16, §17).
 *
 * `boundNames` is the raw evidence; the two audits below are the READABLE form,
 * so a reviewer does not have to diff a name list by eye to see whether a
 * retired credential variable is bound. Both are built with `describePresence`,
 * which returns `{ name, present }` and structurally cannot carry a value, a
 * length or a hash.
 */
function summarizeEnvironment(observation) {
  if (observation?.measured !== true) return { measured: false };
  const bound = new Set(observation.value);
  const presence = (name) => describePresence(name, bound.has(name) ? "bound" : undefined);
  return {
    measured: true,
    boundNames: [...observation.value].sort(),
    forbiddenAudit: FORBIDDEN_WORKER_ENVIRONMENT.map(presence),
    requiredAudit: REQUIRED_WORKER_ENVIRONMENT.map(presence),
  };
}

/** Basenames and namespace ids only (§29). Never a pid-to-command-line map. */
function summarizeProcess(observation) {
  if (observation?.measured !== true) return { measured: false, reason: observation?.reason ?? null };
  const { sample, expectedNetns } = observation.value;
  return {
    measured: true,
    expectedNetns: expectedNetns ?? null,
    basenames: [...new Set((sample ?? []).map((row) => String(row.comm ?? "").toLowerCase()))].sort(),
    namespaces: [...new Set((sample ?? []).map((row) => row.netns ?? null))],
  };
}

// Run only when invoked directly, never on import — the test suite imports this
// module, and importing a CLI must not execute it.
// `pathToFileURL` rather than string concatenation: a repository path containing
// a space percent-encodes in `import.meta.url` and would silently never match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2), process.env);
  process.exit(code);
}
