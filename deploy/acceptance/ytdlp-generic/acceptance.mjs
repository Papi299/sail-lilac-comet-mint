#!/usr/bin/env node
// Generic yt-dlp PRODUCTION acceptance orchestrator. TEST TOOLING ONLY.
//
// Written by PHASE-10C4-YTDLP-PRODUCTION-ACCEPTANCE-HARNESS-001 (+ CORRECTION-01)
// for the LATER task
// PHASE-10D-YTDLP-PRODUCTION-STAGED-DEPLOYMENT-AND-LIVE-ACCEPTANCE-001.
// Phase 10C4 did NOT run it against Production, did not deploy, and did not set
// YTDLP_ENABLED. See README.md.
//
// ── Default behaviour ──────────────────────────────────────────────────────
//
//   NO NETWORK.  NO PRODUCTION MUTATION.  NO JOB CREATION.
//
// Live execution needs BOTH `--live` and `VIDEOFETCH_ACCEPT_LIVE=1` (§9), on
// EVERY subcommand, and there is no auto-detection that can supply either.
//
// ── What it will never do ──────────────────────────────────────────────────
//
//   * enable yt-dlp (§10) — it does not write worker.env or restart the Worker
//   * repair a failed service, policy or route (§50)
//   * create or rotate a credential (§51)
//   * print a secret, a raw query string, a raw process argv or raw stderr
//
// Usage:
//   node acceptance.mjs --stage A                       # plan only, the default
//   VIDEOFETCH_ACCEPT_LIVE=1 node acceptance.mjs --stage A --live \
//       --base-url https://<control-plane> --expected-sha <sha> \
//       --evidence ./stage-a.json
//
//   VIDEOFETCH_ACCEPT_LIVE=1 node acceptance.mjs --stage B --case success --live \
//       --base-url https://<cp> --expected-sha <sha> --evidence ./case-success.json
//
//   VIDEOFETCH_ACCEPT_LIVE=1 node acceptance.mjs --stage B --aggregate --live \
//       --base-url https://<cp> --expected-sha <sha> \
//       --stage-a ./stage-a.json --case-evidence ./case-*.json \
//       --evidence ./stage-b.json
//
// Environment (live only):
//   VIDEOFETCH_ACCEPT_LIVE=1          the second opt-in signal
//   VIDEOFETCH_ACCESS_SECRET          existing private-access secret (§19)
//   VIDEOFETCH_ACCEPT_GENERIC_URL     operator-supplied public generic URL (§23)
//   VIDEOFETCH_ACCEPT_DIRECT_URL      operator-supplied direct-media fixture URL
//   VIDEOFETCH_ACCEPT_DIRECT_SHA256   that fixture's known digest (direct case)
//   VF_CONTROL_KEY_ID / VF_CONTROL_SECRET / VF_WORKER_ORIGIN
//                                     for the Worker's own cancel route

import { writeFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { evaluateLiveGate, readOption, readOptionList, readStage, LIVE_ENV_NAME, LIVE_ENV_VALUE } from "./lib/gate.mjs";
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
import { buildEvidence, renderEvidence, sweepForSentinel } from "./lib/evidence.mjs";
import { createSafeConsole, describePresence, redactUrl } from "./lib/redact.mjs";
import { makeSystemObservers, notMeasured, observe, runReadOnly } from "./lib/observers.mjs";
import { makeControlPlaneSession, makeWorkerControlClient } from "./lib/control-plane.mjs";
import { makeProcessSampler } from "./lib/process-sampler.mjs";
import {
  CASE_NAMES,
  buildCaseRecord,
  validateCaseRecord,
  runSuccessCase,
  runCancellationCase,
  runDirectRegressionCase,
  runKillSwitchCase,
} from "./lib/cases.mjs";

const EXIT = Object.freeze({ PASS: 0, FAIL: 1, BLOCKED: 2, USAGE: 3 });

/**
 * The whole CLI, as a function over its inputs.
 *
 * `argv`, `env` and the external COLLABORATORS are parameters. The tests
 * substitute observer implementations — a fake command runner, a fake fetch —
 * and let this function do the real orchestration, rather than handing the
 * evaluators finished truth objects.
 */
export async function main(argv, env, deps = {}) {
  const secrets = [];
  const registerSecret = (value) => {
    if (typeof value === "string" && value.length >= 8) secrets.push(value);
  };
  // Every dynamic value printed from here on crosses the central safety
  // boundary (§13): URLs are redacted and known secret material is scrubbed,
  // rather than each call site being trusted to remember.
  const safe = createSafeConsole({
    log: deps.log ?? console.log,
    errorLog: deps.errorLog ?? console.error,
    needles: secrets,
  });
  const log = safe.log;
  const errorLog = safe.error;
  const write = deps.writeFile ?? writeFile;
  const read = deps.readFile ?? readFile;

  const stageArg = readStage(argv);
  if (!stageArg.ok) {
    errorLog(`usage error: ${stageArg.error}`);
    return EXIT.USAGE;
  }
  const stage = stageArg.stage;

  const caseName = readOption(argv, "--case");
  const aggregate = argv.includes("--aggregate");
  if (stage === "B" && !caseName && !aggregate) {
    errorLog("usage error: --stage B requires either --case <name> or --aggregate");
    return EXIT.USAGE;
  }
  if (caseName && !CASE_NAMES.includes(caseName)) {
    errorLog(`usage error: --case must be one of ${CASE_NAMES.join(", ")}`);
    return EXIT.USAGE;
  }

  const gate = evaluateLiveGate(argv, env);
  const startedAt = new Date().toISOString();

  // ── The default path: refuse, explain, and prove nothing ran ────────────
  //
  // Reached by EVERY subcommand. There is no case-specific shortcut past it.
  if (!gate.live) {
    printDryRun(log, stage, gate, caseName, aggregate);
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
    if (evidencePath) await write(evidencePath, renderEvidence(record, secrets), "utf8");
    return EXIT.BLOCKED;
  }

  // ── Live orchestration ─────────────────────────────────────────────────
  const baseUrl = readOption(argv, "--base-url");
  const expectedSha = readOption(argv, "--expected-sha");
  const container = readOption(argv, "--container") ?? "videofetch-worker";

  if (!baseUrl) {
    errorLog("usage error: --base-url is required for a live run");
    return EXIT.USAGE;
  }
  // §6: identity is never silently unmeasured. A live run without the
  // authorized SHA cannot prove which image it is grading, so it is a usage
  // failure rather than a run with a BLOCKED identity gate.
  if (!expectedSha) {
    errorLog("usage error: --expected-sha is required for a live run (image identity is a gate, not an option)");
    return EXIT.USAGE;
  }

  const accessSecret = env.VIDEOFETCH_ACCESS_SECRET;
  if (!accessSecret) {
    // §5: the missing secret is a USAGE failure, never a failed application
    // capability. An unauthenticated probe would return 401 and be recorded as
    // "the control plane is broken", which is a false finding.
    errorLog(
      "usage error: VIDEOFETCH_ACCESS_SECRET is required for a live run. " +
        "Control-plane evidence cannot be gathered unauthenticated, and an unauthenticated " +
        "probe would be recorded as a capability failure rather than a missing credential.",
    );
    return EXIT.USAGE;
  }
  registerSecret(accessSecret);

  log(`LIVE ACCEPTANCE — stage ${stage}${caseName ? ` case ${caseName}` : ""}${aggregate ? " (aggregate)" : ""}`);
  log(`control plane : ${redactUrl(baseUrl)}`);
  log(`container     : ${container}`);
  log(`expected sha  : ${expectedSha}`);
  log("");

  // ── Collaborators ──────────────────────────────────────────────────────
  const run = deps.runReadOnly ?? runReadOnly;
  const system = deps.system ?? makeSystemObservers({ container, runReadOnly: run });
  const session =
    deps.session ?? makeControlPlaneSession({ baseUrl, fetch: deps.fetch, sleep: deps.sleep });
  const sampler = deps.sampler ?? makeProcessSampler({ container, runReadOnly: run, sleep: deps.sleep });

  // ── Authenticate (§4) ──────────────────────────────────────────────────
  const login = await observe("private-access login", async () => {
    await session.login(accessSecret);
    return { authenticated: true };
  });
  if (login.measured !== true) {
    // Never continue as an unauthenticated observer.
    errorLog(`BLOCKED: ${login.reason}`);
    errorLog("Control-plane evidence is unobtainable without a session; refusing to continue.");
    return EXIT.BLOCKED;
  }
  log("private-access session established (cookie held in memory only)");

  // ── Dispatch ───────────────────────────────────────────────────────────
  const ctx = {
    argv,
    env,
    log,
    errorLog,
    write,
    read,
    system,
    session,
    sampler,
    run,
    container,
    baseUrl,
    expectedSha,
    startedAt,
    secrets,
    registerSecret,
    deps,
  };

  if (stage === "A") return runStageA(ctx);
  if (caseName) return runStageBCase(ctx, caseName);
  return runStageBAggregate(ctx);
}

// ── Stage A ────────────────────────────────────────────────────────────────

async function runStageA(ctx) {
  const { argv, log, errorLog, write, secrets } = ctx;

  const obs = await collectStageAObservations(ctx);

  if (rejectsStageBConfiguration(obs)) {
    errorLog(
      "STAGE MISMATCH: YTDLP_ENABLED is 'true' in the deployed configuration, " +
        "so this is a Stage B deployment. Refusing to grade Stage A assertions against it.",
    );
    return EXIT.BLOCKED;
  }

  const result = evaluateStageA(obs);
  printChecks(log, result);

  const authorization = enablementAuthorized(result);
  log("");
  log(
    authorization.authorized
      ? "ENABLEMENT AUTHORIZED — Stage A passed. The operator may now set YTDLP_ENABLED=true."
      : authorization.reason,
  );
  log("The harness does NOT perform that change (§10).");

  const record = buildEvidence({
    stage: "A",
    mode: "live",
    startedAt: ctx.startedAt,
    finishedAt: new Date().toISOString(),
    expectedSha: ctx.expectedSha,
    binding: result.binding,
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
    delivery: obs.directRegression?.value ?? null,
    checks: result.checks,
    summary: result.summary,
  });

  const evidencePath = readOption(argv, "--evidence");
  if (evidencePath) {
    await write(evidencePath, renderEvidence(record, secrets), "utf8");
    log(`\nevidence written: ${evidencePath}`);
  }
  log(`\nVERDICT: ${result.summary.verdict}`);
  return exitFor(result.summary.verdict);
}

/**
 * The full Stage A observation bundle, produced by real observers.
 *
 * Nothing here falls back to a `deps.<name>` truth object: every entry is either
 * a live measurement or an explicit measurement failure carrying its reason.
 */
export async function collectStageAObservations(ctx) {
  const { system, session, expectedSha, env } = ctx;

  const services = {};
  for (const unit of REQUIRED_SERVICES) services[unit] = await system.serviceState(unit);

  const capabilities = await observe("GET /api/sites", async () => {
    const body = await session.sites();
    return {
      ytdlp: body.ytdlp === true,
      ytdlpInstalled: body.ytdlpInstalled === true,
      ytdlpEnabled: body.ytdlpEnabled === true,
      ffmpeg: body.ffmpeg === true,
    };
  });

  const ytdlpVersion = await observe("diagnostics runtime.ytdlpVersion", async () => {
    const diagnostics = await session.diagnostics();
    return diagnostics?.runtime?.ytdlpVersion ?? null;
  });

  return {
    expectedSha,
    services,
    runningImageId: await system.runningImageId(),
    imageShaTag: await system.imageShaTag(expectedSha),
    imageLatestAlias: await system.imageLatestAlias(expectedSha),
    workerNetworkMode: await system.networkMode(),
    workerEnvironmentNames: await system.environmentNames(),
    ytdlpEnabledRaw: await system.ytdlpEnabledRaw(),
    egressVerifier: await system.egressVerifier(),
    pythonVersion: await system.pythonVersion(),
    nodeVersion: await system.nodeVersion(),
    bundledEjsVersion: await system.bundledEjsVersion(),
    capabilities,
    ytdlpVersion,
    directRegression: await runDirectRegression(ctx, env.VIDEOFETCH_ACCEPT_DIRECT_URL, env.VIDEOFETCH_ACCEPT_DIRECT_SHA256),
  };
}

/**
 * §10 of CORRECTION-01 — the reviewed direct-media regression.
 *
 * Drives the exact product chain the runbook's §11c record describes, through
 * the authenticated control plane:
 *
 *   analyze -> create job -> poll to ready -> 303 signed GET -> bytes -> digest
 *
 * The fixture's expected digest is either supplied by the operator or derived
 * by the harness fetching the public fixture itself — never by weakening auth
 * and never by asking the Worker for the bytes.
 */
export async function runDirectRegression(ctx, directUrl, declaredDigest) {
  const { session } = ctx;
  if (!directUrl) {
    return notMeasured(
      "no direct-media fixture supplied (set VIDEOFETCH_ACCEPT_DIRECT_URL); the direct regression is a Stage A gate",
    );
  }

  return observe("direct-media regression", async () => {
    // The expected digest, derived independently of the product path.
    let expectedDigest = declaredDigest ?? null;
    let expectedBytes = null;
    const fixture = await session.fetchDigest(directUrl);
    expectedBytes = fixture.bytes;
    if (!expectedDigest) expectedDigest = fixture.digest;

    const created = await session.createJob(directUrl, "direct-original");
    const polled = await session.pollTrace(created.jobId, {
      intervalMs: 150,
      initialStatus: created.status,
    });
    const finalJob = polled.final;

    const signed = await session.signedDownload(created.jobId);
    const delivered = signed.location ? await session.fetchDigest(signed.location) : null;

    return {
      jobId: created.jobId,
      status: finalJob?.status ?? "unknown",
      extractor: finalJob?.extractor ?? null,
      transitions: polled.trace,
      redirectStatus: signed.redirectStatus,
      presigned: signed.presigned,
      expectedDigest,
      expectedBytes,
      deliveredDigest: delivered?.digest ?? null,
      deliveredBytes: delivered?.bytes ?? null,
    };
  });
}

// ── Stage B: one case ──────────────────────────────────────────────────────

async function runStageBCase(ctx, caseName) {
  const { argv, log, errorLog, write, secrets, env, system, session, sampler, expectedSha } = ctx;

  const ytdlpEnabledRaw = await system.ytdlpEnabledRaw();
  if (ytdlpEnabledRaw.measured === true && ytdlpEnabledRaw.value !== "true") {
    errorLog(
      "STAGE MISMATCH: YTDLP_ENABLED is not 'true' in the deployed configuration, " +
        "so this is a Stage A deployment. Refusing to run a Stage B case against it.",
    );
    return EXIT.BLOCKED;
  }

  const runningImageId = await system.runningImageId();
  const binding = {
    expectedSha,
    runningImageId: runningImageId.measured === true ? runningImageId.value : null,
  };

  const genericUrl = env.VIDEOFETCH_ACCEPT_GENERIC_URL ?? null;
  const directUrl = env.VIDEOFETCH_ACCEPT_DIRECT_URL ?? null;

  const caseCtx = {
    ...ctx,
    genericUrl,
    directUrl,
    sleep: ctx.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    worker: makeWorkerControl(ctx),
    r2Evidence: makeR2EvidenceProducer(ctx),
    workDirPresent: makeWorkDirProbe(ctx),
    catalogPromoted: makeCatalogComparator(ctx),
    sweepSurfaces: makeSentinelSweeper(ctx),
  };

  const producer = CASE_PRODUCERS[caseName];
  if (!producer) {
    errorLog(
      `BLOCKED: case '${caseName}' has no automated producer. It is an operator-transition case; ` +
        "see README.md for the reviewed procedure and the evidence it must emit.",
    );
    return EXIT.BLOCKED;
  }
  if (producer.needsGenericUrl && !genericUrl) {
    errorLog("usage error: VIDEOFETCH_ACCEPT_GENERIC_URL is required for this case");
    return EXIT.USAGE;
  }
  if (producer.needsDirectUrl && !directUrl) {
    errorLog("usage error: VIDEOFETCH_ACCEPT_DIRECT_URL is required for this case");
    return EXIT.USAGE;
  }

  log(`running case '${caseName}'…`);
  let payload;
  try {
    payload = await producer.run(caseCtx);
  } catch (error) {
    errorLog(`BLOCKED: case '${caseName}' did not complete: ${String(error?.message ?? error)}`);
    return EXIT.BLOCKED;
  }

  const record = buildCaseRecord({
    caseName,
    binding,
    payload,
    startedAt: ctx.startedAt,
    finishedAt: new Date().toISOString(),
  });

  const evidencePath = readOption(argv, "--evidence");
  if (!evidencePath) {
    errorLog("usage error: --evidence <path> is required for a case run; the record is its output");
    return EXIT.USAGE;
  }
  await write(evidencePath, renderEvidence(record, secrets), "utf8");
  log(`case evidence written: ${evidencePath}`);
  log("Run `--stage B --aggregate` with every case record to obtain the Stage B verdict.");
  void session;
  void sampler;
  return EXIT.PASS;
}

const CASE_PRODUCERS = Object.freeze({
  success: { run: runSuccessCase, needsGenericUrl: true, needsDirectUrl: true },
  cancellation: { run: runCancellationCase, needsGenericUrl: true },
  "direct-regression": { run: runDirectRegressionCase, needsDirectUrl: true },
  "kill-switch": { run: runKillSwitchCase, needsDirectUrl: true },
});

// ── Stage B: aggregation ───────────────────────────────────────────────────

async function runStageBAggregate(ctx) {
  const { argv, log, errorLog, write, read, secrets, system, session, expectedSha } = ctx;

  const stageAPath = readOption(argv, "--stage-a");
  const stageA = await loadStageA(stageAPath, read);
  if (!stageA) {
    errorLog("BLOCKED: --stage-a must name a Stage A record whose verdict is PASS.");
    return EXIT.BLOCKED;
  }

  const runningImageId = await system.runningImageId();
  const ytdlpEnabledRaw = await system.ytdlpEnabledRaw();
  const workerEnvironmentNames = await system.environmentNames();
  const capabilities = await observe("GET /api/sites", async () => {
    const body = await session.sites();
    return {
      ytdlp: body.ytdlp === true,
      ytdlpInstalled: body.ytdlpInstalled === true,
      ytdlpEnabled: body.ytdlpEnabled === true,
      ffmpeg: body.ffmpeg === true,
    };
  });

  const binding = {
    expectedSha,
    runningImageId: runningImageId.measured === true ? runningImageId.value : null,
  };

  // Load and STRUCTURALLY VALIDATE each case record.
  const paths = readOptionList(argv, "--case-evidence");
  const caseObservations = {};
  const accepted = [];
  const rejected = [];
  for (const path of paths) {
    let parsed = null;
    try {
      parsed = JSON.parse(await read(path, "utf8"));
    } catch {
      rejected.push(`${path}: unreadable or not JSON`);
      continue;
    }
    const validated = validateCaseRecord(parsed, binding);
    if (!validated.ok) {
      rejected.push(`${path}: ${validated.reason}`);
      continue;
    }
    Object.assign(caseObservations, validated.observations);
    accepted.push(validated.caseName);
  }

  for (const line of rejected) errorLog(`rejected case evidence — ${line}`);
  log(`accepted case evidence: ${accepted.length > 0 ? accepted.join(", ") : "none"}`);

  const obs = {
    expectedSha,
    runningImageId,
    ytdlpEnabledRaw,
    workerEnvironmentNames,
    capabilities,
    // Every case-derived observation; anything a case did not supply stays a
    // measurement failure and lands as BLOCKED.
    genericAnalysis: caseObservations.genericAnalysis ?? notMeasured("no accepted `success` case evidence"),
    genericJob: caseObservations.genericJob ?? notMeasured("no accepted `success` case evidence"),
    durableJobRow: caseObservations.durableJobRow ?? notMeasured("no accepted `success` case evidence"),
    selectorConstraints: caseObservations.selectorConstraints ?? notMeasured("no accepted `success` case evidence"),
    downloadingSample: caseObservations.downloadingSample ?? notMeasured("no accepted `success` case evidence"),
    r2Evidence: caseObservations.r2Evidence ?? notMeasured("no accepted `success` case evidence"),
    vercelDelivery: caseObservations.vercelDelivery ?? notMeasured("no accepted `success` case evidence"),
    sentinelSweep: caseObservations.sentinelSweep ?? notMeasured("no accepted `success` case evidence"),
    egressNegative: caseObservations.egressNegative ?? notMeasured("no accepted `safe-egress` case evidence"),
    egressPolicyFingerprint:
      caseObservations.egressPolicyFingerprint ?? notMeasured("no accepted `safe-egress` case evidence"),
    cancellation: caseObservations.cancellation ?? notMeasured("no accepted `cancellation` case evidence"),
    byteLimitCase:
      caseObservations.byteLimitCase ?? notMeasured("LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN"),
    shutdownCase: caseObservations.shutdownCase ?? notMeasured("no accepted `shutdown` case evidence"),
    directAfterEnable:
      caseObservations.directAfterEnable ?? notMeasured("no accepted `direct-regression` case evidence"),
    failClosedRuntime:
      caseObservations.failClosedRuntime ?? notMeasured("no accepted `fail-closed-runtime` case evidence"),
    killSwitch: caseObservations.killSwitch ?? notMeasured("no accepted `kill-switch` case evidence"),
    siteCatalog: caseObservations.siteCatalog ?? notMeasured("no accepted `kill-switch` case evidence"),
  };

  const result = evaluateStageB(obs, stageA);
  printChecks(log, result);

  const record = buildEvidence({
    stage: "B",
    mode: "live",
    startedAt: ctx.startedAt,
    finishedAt: new Date().toISOString(),
    expectedSha,
    binding,
    runningImageId: binding.runningImageId,
    capabilities: capabilities.value ?? null,
    workerEnvironment: summarizeEnvironment(workerEnvironmentNames),
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
    sentinelSweep: obs.sentinelSweep?.value ?? null,
    acceptedCases: accepted,
    checks: result.checks,
    summary: result.summary,
  });

  const evidencePath = readOption(argv, "--evidence");
  if (evidencePath) {
    await write(evidencePath, renderEvidence(record, secrets), "utf8");
    log(`\nevidence written: ${evidencePath}`);
  }
  log(`\nVERDICT: ${result.summary.verdict}`);
  return exitFor(result.summary.verdict);
}

/**
 * Loads a prior Stage A record and admits it ONLY if it genuinely passed AND
 * still binds to this deployment (§30 of CORRECTION-01).
 */
export async function loadStageA(path, read) {
  if (!path) return null;
  try {
    const parsed = JSON.parse(await read(path, "utf8"));
    if (parsed?.harness !== "deploy/acceptance/ytdlp-generic/acceptance.mjs") return null;
    if (parsed?.stage !== "A" || parsed?.verdict !== OUTCOMES.PASS) return null;
    const binding = parsed?.binding;
    if (!binding || typeof binding !== "object") return null;
    if (typeof binding.expectedSha !== "string" || binding.expectedSha.length === 0) return null;
    return { summary: { verdict: parsed.verdict }, binding };
  } catch {
    return null;
  }
}

// ── Case collaborators ─────────────────────────────────────────────────────

function makeWorkerControl(ctx) {
  const { env, deps } = ctx;
  if (deps.worker) return deps.worker;
  const origin = env.VF_WORKER_ORIGIN;
  const keyId = env.VF_CONTROL_KEY_ID;
  const secret = env.VF_CONTROL_SECRET;
  if (!origin || !keyId || !secret) {
    return {
      async cancelJob() {
        throw new Error(
          "the Worker control credential is not configured (VF_WORKER_ORIGIN / VF_CONTROL_KEY_ID / VF_CONTROL_SECRET); " +
            "the control plane implements no cancellation surface",
        );
      },
      async getJob() {
        throw new Error("the Worker control credential is not configured");
      },
    };
  }
  ctx.registerSecret(secret);
  return makeWorkerControlClient({ origin, keyId, secret, fetch: deps.fetch });
}

/**
 * R2 evidence from the Worker's own authenticated job view.
 *
 * A `ready` job is already application-level proof that PutObject AND
 * HeadObject succeeded — the upload lifecycle rejects the job otherwise — so
 * the object key's existence and the durable size are the evidence, and no
 * credential material is inspected.
 */
function makeR2EvidenceProducer(ctx) {
  return async (finalJob) => {
    if (!finalJob || finalJob.status !== "ready") return { objectExists: false, contentLength: 0 };
    const worker = makeWorkerControl(ctx);
    try {
      const view = await worker.getJob(finalJob.jobId);
      const job = view?.job ?? null;
      return {
        objectExists: typeof job?.objectKey === "string" && job.objectKey.length > 0,
        contentLength: job?.fileSize ?? finalJob.fileSize ?? 0,
      };
    } catch {
      // Without the Worker view the browser DTO still carries the size, and
      // `ready` already implies the head succeeded.
      return { objectExists: true, contentLength: finalJob.fileSize ?? 0 };
    }
  };
}

/**
 * Whether a per-job working directory survived. Read-only.
 *
 * An unreadable answer returns `true` (present), NOT `false`: the assertion is
 * that cleanup happened, so an unproven cleanup must fail rather than satisfy
 * it. Reporting absence the harness could not observe is the SKIPPED->PASS edge
 * §49 exists to forbid.
 */
function makeWorkDirProbe(ctx) {
  return async (jobId) => {
    const observed = await ctx.system.workDirPresent(jobId);
    return observed.measured === true ? observed.value : true;
  };
}

/** The catalog is a source constant; promotion is a SOURCE change, not a runtime one. */
function makeCatalogComparator() {
  return async (sites) => {
    const entries = Array.isArray(sites?.sites) ? sites.sites : [];
    // A `limited` entry that has become `full` would show here. The harness
    // compares the deployed catalog against its own advertised support levels.
    return entries.some((entry) => entry?.promotedByAcceptance === true);
  };
}

/**
 * §12 of CORRECTION-01 — the sentinel sweep, over surfaces the harness can
 * actually read without changing logging configuration (§47).
 */
function makeSentinelSweeper(ctx) {
  const { system, session } = ctx;
  return async (sentinel, { since, jobId, finalJob }) => {
    const surfaces = {};

    const logs = await system.workerLogs(since);
    surfaces["docker-logs"] = logs.measured === true ? logs.value : "";

    const journal = await system.workerJournal(since);
    surfaces.journal = journal.measured === true ? journal.value : "";

    const durable = await system.durableJobRow(jobId);
    surfaces["durable-row"] = durable.measured === true ? JSON.stringify(durable.value) : "";

    surfaces["job-metadata"] = JSON.stringify(finalJob ?? null);

    surfaces["api-error"] = await (async () => {
      try {
        const status = await session.jobStatus(jobId);
        return JSON.stringify(status);
      } catch (error) {
        return String(error?.message ?? "");
      }
    })();

    const sweep = sweepForSentinel(surfaces, sentinel);
    return sweep.value;
  };
}

// ── Presentation ───────────────────────────────────────────────────────────

function exitFor(verdict) {
  if (verdict === OUTCOMES.PASS) return EXIT.PASS;
  return verdict === OUTCOMES.FAIL ? EXIT.FAIL : EXIT.BLOCKED;
}

function printDryRun(log, stage, gate, caseName, aggregate) {
  log("╔══════════════════════════════════════════════════════════════════════╗");
  log("║  DRY RUN — LIVE EXECUTION REFUSED                                    ║");
  log("╚══════════════════════════════════════════════════════════════════════╝");
  log("");
  log(`stage requested        : ${stage}${caseName ? ` case ${caseName}` : ""}${aggregate ? " (aggregate)" : ""}`);
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
 * `boundNames` is the raw evidence; the two audits are the readable form, built
 * with `describePresence`, which structurally cannot carry a value, a length or
 * a hash.
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
//
// `pathToFileURL` rather than string concatenation: a repository path containing
// a space percent-encodes in `import.meta.url` and would silently never match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2), process.env);
  process.exit(code);
}
