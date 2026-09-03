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
import { CASE_ID_PATTERN, buildEvidence, renderEvidence, sweepForSentinel } from "./lib/evidence.mjs";
import { createSafeConsole, describePresence, redactUrl } from "./lib/redact.mjs";
import { makeSystemObservers, notMeasured, observe, runReadOnly } from "./lib/observers.mjs";
import { makeControlPlaneSession, makeWorkerControlClient } from "./lib/control-plane.mjs";
import { makeProcessSampler } from "./lib/process-sampler.mjs";
import { parseDenyClass, readDenyCounter } from "./lib/egress-policy.mjs";
import {
  aggregateDownloadWindow,
  nodeContained,
  nodeExercised,
  ytdlpIdentified,
} from "./lib/download-window.mjs";
import {
  CASE_PRODUCERS,
  buildCaseRecord,
  caseNames,
  describeFeatureState,
  evaluateCaseFeatureState,
  expectedFeatureStateFor,
  hasExecutableProducer,
  liveCaseNames,
  validateCaseRecord,
} from "./lib/cases.mjs";
import {
  EVIDENCE_SCHEMA_VERSION,
  loadOrCreateRun,
  loadRun,
  runFingerprint,
  sealRecord,
  bindingAgreesWithRecord,
  validateDeploymentBinding,
  verifyRecord,
} from "./lib/provenance.mjs";

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
  if (caseName && !caseNames().includes(caseName)) {
    errorLog(`usage error: --case must be one of ${liveCaseNames().join(", ")}`);
    return EXIT.USAGE;
  }
  // §4 of CORRECTION-02: a declared-but-non-live case is refused at PARSE time
  // with what it actually is, rather than being advertised as runnable and then
  // failing at dispatch.
  if (caseName && !hasExecutableProducer(caseName)) {
    errorLog(
      `usage error: '${caseName}' is not a live case command — ${CASE_PRODUCERS[caseName].summary}. ` +
        `Runnable cases: ${liveCaseNames().join(", ")}`,
    );
    return EXIT.USAGE;
  }

  // §17-§19 of CORRECTION-04: the deny class is parsed through the CLOSED enum
  // BEFORE any live operation. An arbitrary nftables comment must never be
  // usable as a denial-attribution counter — `public-http` and `established`
  // are ACCEPT rules whose counters move constantly, and `fallthrough-drop`
  // attributes nothing to a rule. Refusing here means the case cannot run to
  // completion and then report a confident PASS from the wrong counter.
  const denyClass = parseDenyClass(readOption(argv, "--egress-deny-class"));
  if (!denyClass.ok) {
    errorLog(`usage error: ${denyClass.reason}`);
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

  // ── The acceptance run identity (§23-§24) ──────────────────────────────
  //
  // Stage A begins a run; Stage B cases and the aggregation JOIN it. The key is
  // acceptance-only, never an application credential, lives in a 0600 local
  // file, and is never printed or recorded — only the non-secret runId travels
  // with the artifacts.
  const runKeyPath = readOption(argv, "--run-key") ?? "./.vf-acceptance-run.json";
  let acceptanceRun;
  if (stage === "A") {
    acceptanceRun = await loadOrCreateRun(runKeyPath, deps);
    // §26 of CORRECTION-04: Stage A resuming an already-insecure key would
    // re-establish exactly the weakness `loadRun` refuses, from the command
    // expected to touch the file first.
    if (acceptanceRun?.error) {
      errorLog(`BLOCKED: ${acceptanceRun.error}`);
      return EXIT.BLOCKED;
    }
    log(
      `acceptance run ${runFingerprint(acceptanceRun.runId)} ${acceptanceRun.created ? "created" : "resumed"} ` +
        `(key file ${runKeyPath}, mode 0600 — delete it when acceptance is complete)`,
    );
  } else {
    acceptanceRun = await loadRun(runKeyPath, deps);
    if (acceptanceRun?.error) {
      errorLog(`BLOCKED: ${acceptanceRun.error}`);
      return EXIT.BLOCKED;
    }
    if (!acceptanceRun) {
      errorLog(
        `BLOCKED: no acceptance run key at ${runKeyPath}. Stage B artifacts must join the run ` +
          "Stage A began; minting a new key here would make every prior artifact unverifiable.",
      );
      return EXIT.BLOCKED;
    }
    log(`acceptance run ${runFingerprint(acceptanceRun.runId)} joined`);
  }

  // ── Dispatch ───────────────────────────────────────────────────────────
  const ctx = {
    run: acceptanceRun,
    argv,
    env,
    log,
    errorLog,
    write,
    read,
    system,
    session,
    sampler,
    // The read-only command runner. Named distinctly from `run` (the acceptance
    // run identity) — an earlier draft had both under `run`, and the shorthand
    // silently shadowed the run key.
    runReadOnly: run,
    container,
    baseUrl,
    expectedSha,
    egressDenyClass: denyClass.denyClass,
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

  // §27: the Stage A binding must be complete and self-consistent, or the
  // record must not be able to authorize anything. A `runningImageId: null`
  // binding proves nothing about which image was graded.
  const bindingCheck = validateDeploymentBinding(result.binding, ctx.expectedSha);
  if (!bindingCheck.ok) {
    log("");
    log(`NOTE: this Stage A record cannot authorize Stage B — ${bindingCheck.reason}`);
  }

  const record = buildEvidence({
    stage: "A",
    mode: "live",
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: ctx.run.runId,
    runningImageIdBinding: result.binding?.runningImageId ?? null,
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
    const sealed = sealRecord(record, ctx.run.key);
    const rendered = renderEvidence(sealed, secrets);
    if (rendered.includes("<scrubbed>")) {
      errorLog(
        "BLOCKED: secret material reached the pre-scrub Stage A record. The scrubber removed it, " +
          "but that is a disclosure backstop, not evidence that upstream handling was clean.",
      );
      return EXIT.BLOCKED;
    }
    await write(evidencePath, rendered, "utf8");
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
  const { argv, log, errorLog, write, secrets, env, system, expectedSha, run: acceptanceRun } = ctx;

  // §3/§4 of CORRECTION-03: the required deployment state is PER CASE. The
  // previous global guard demanded YTDLP_ENABLED=true for every Stage B case,
  // which made `kill-switch` — whose whole purpose is to run with generic
  // disabled — impossible. An UNMEASURED state blocks every case: running one
  // while the deployment stage is unknown produces uninterpretable evidence.
  const ytdlpEnabledRaw = await system.ytdlpEnabledRaw();
  const stateGate = evaluateCaseFeatureState(caseName, ytdlpEnabledRaw);
  if (!stateGate.ok) {
    errorLog(`BLOCKED: ${stateGate.reason}`);
    return EXIT.BLOCKED;
  }
  log(`deployment state: generic ${stateGate.actual} (case '${caseName}' requires ${expectedFeatureStateFor(caseName)})`);

  // §4/§5 of CORRECTION-04: SEAL the state this case actually ran under.
  //
  // The enabled-phase cases and the kill-switch case run at different times
  // against different configurations, and the aggregation runs later still. So
  // the historical fact is captured HERE, by the harness, while the condition
  // exists — never reconstructed afterwards from whichever state the deployment
  // happens to be in at aggregation time, and never taken from an operator.
  const caseSites = await observe("GET /api/sites", async () => {
    const body = await ctx.session.sites();
    return {
      ytdlp: body.ytdlp === true,
      ytdlpInstalled: body.ytdlpInstalled === true,
      ytdlpEnabled: body.ytdlpEnabled === true,
    };
  });
  const featureState = describeFeatureState({
    ytdlpEnabledRaw,
    sites: caseSites,
    observedAt: new Date().toISOString(),
  });
  if (featureState.measured !== true) {
    errorLog(
      `BLOCKED: the deployment feature state could not be sealed for case '${caseName}': ${featureState.reason}`,
    );
    return EXIT.BLOCKED;
  }

  // ── §8-§10 of CORRECTION-05: image continuity ──────────────────────────
  //
  // A case record used to bind to the image measured BEFORE the producer ran.
  // For a case that spans an operator restart — `shutdown` exists to span one —
  // that is not enough: systemd starts `videofetch-worker:latest`, so a restart
  // is an image-RESOLUTION event, and a record could combine pre-restart and
  // post-restart evidence under one image id that only ever described the
  // first half.
  //
  // So the authorized image is established before, re-established after, and
  // the two must be the same object. The container id is deliberately not the
  // binding: a restart legitimately recreates the container from the same
  // image, and that is the case this must permit.
  const preCase = await system.imageShaTag(expectedSha);
  if (preCase.measured !== true) {
    errorLog(`BLOCKED: the running image could not be identified before the case: ${preCase.reason}`);
    return EXIT.BLOCKED;
  }
  if (preCase.value.runningImageId !== preCase.value.taggedImageId) {
    errorLog(
      "BLOCKED: the running image is not the image tagged with the authorized source SHA; " +
        "a case run against an unauthorized image is not acceptance evidence.",
    );
    return EXIT.BLOCKED;
  }
  const authorizedImageId = preCase.value.taggedImageId;
  const binding = { expectedSha, runningImageId: authorizedImageId };

  const producer = CASE_PRODUCERS[caseName];
  const caseCtx = {
    ...ctx,
    genericUrl: env.VIDEOFETCH_ACCEPT_GENERIC_URL ?? null,
    directUrl: env.VIDEOFETCH_ACCEPT_DIRECT_URL ?? null,
    byteLimitUrl: env.VIDEOFETCH_ACCEPT_BYTELIMIT_URL ?? null,
    egressRedirectUrl: env.VIDEOFETCH_ACCEPT_EGRESS_REDIRECT_URL ?? null,
    cloudflaredUnit: readOption(argv, "--cloudflared-unit") ?? "vf-cloudflared",
    sleep: ctx.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    worker: makeWorkerControl(ctx),
    r2Evidence: makeR2EvidenceProducer(ctx),
    workDirPresent: makeWorkDirProbe(ctx),
    catalogPromoted: makeCatalogComparator(ctx),
    sweepSurfaces: makeSentinelSweeper(ctx),
    awaitWorkerRestart: makeRestartWatcher(ctx),
    egressPolicyState: () => ctx.system.egressPolicyState(),
    // Already validated against the closed deny-only enum at parse time.
    egressDenyClass: ctx.egressDenyClass,
    denyCounter: makeDenyCounterReader(ctx, ctx.egressDenyClass),
    processGroupMembers: (pgid) => ctx.system.processGroupMembers(pgid),
    mediaTransferEvidence: makeMediaTransferProbe(ctx),
    // The EFFECTIVE deployed byte limit (§13), read from the single non-secret
    // deployment variable rather than assumed from the repository default.
    effectiveMaxFileSize: () => ctx.system.effectiveMaxFileSize(),
    // The MONOTONIC clock used to order a snapshot's interval against the
    // window close. Distinct from the wall clock a producer uses for
    // timestamps — `Date.now()` is the wrong instrument for interval
    // comparison, and sharing one name for both confused the two.
    monotonicNow: ctx.deps.monotonicNow,
    // Bounded observation windows. Named on the context rather than baked into
    // the producers so a test can shrink them; the defaults are the operator's
    // real ones.
    shutdownWindowMs: ctx.deps.shutdownWindowMs,
    recoveryWindowMs: ctx.deps.recoveryWindowMs,
  };

  // Every input a case declares is required before anything is submitted.
  const missing = (producer.needs ?? []).filter((need) => {
    if (need === "workerControl") {
      return !env.VF_WORKER_ORIGIN || !env.VF_CONTROL_KEY_ID || !env.VF_CONTROL_SECRET;
    }
    return !caseCtx[need];
  });
  if (missing.length > 0) {
    errorLog(`usage error: case '${caseName}' requires ${missing.join(", ")}; see README.md`);
    return EXIT.USAGE;
  }

  if (producer.operatorTransition) {
    log(`case '${caseName}' involves an operator transition the harness will NOT perform.`);
  }
  log(`running case '${caseName}'…`);

  let payload;
  try {
    payload = await producer.run(caseCtx);
  } catch (error) {
    // Every producer throws rather than emitting a favourable value, so a
    // failure here is BLOCKED and no record is written.
    errorLog(`BLOCKED: case '${caseName}' did not complete: ${String(error?.message ?? error)}`);
    return EXIT.BLOCKED;
  }

  // §9: re-establish the image AFTER the producer, before anything is sealed.
  // An unmeasurable or changed image means no record at all — a record that
  // combined evidence from two images must not exist to be accepted later.
  const postCase = await system.imageShaTag(expectedSha);
  if (postCase.measured !== true) {
    errorLog(
      `BLOCKED: the deployed image could not be re-identified after case '${caseName}': ${postCase.reason}. ` +
        "Refusing to seal evidence whose deployment cannot be confirmed.",
    );
    return EXIT.BLOCKED;
  }
  if (
    postCase.value.runningImageId !== authorizedImageId ||
    postCase.value.taggedImageId !== authorizedImageId
  ) {
    errorLog(
      `BLOCKED — DEPLOYED IMAGE CHANGED DURING CASE '${caseName}'. The evidence spans two ` +
        "different image objects and cannot be attributed to either.",
    );
    return EXIT.BLOCKED;
  }
  const imageContinuity = {
    before: authorizedImageId,
    after: postCase.value.runningImageId,
    taggedImageId: postCase.value.taggedImageId,
    same: true,
  };

  const record = sealRecord(
    buildCaseRecord({
      caseName,
      binding,
      payload,
      runId: acceptanceRun.runId,
      startedAt: ctx.startedAt,
      finishedAt: new Date().toISOString(),
      featureState: featureState.value,
      imageContinuity,
    }),
    acceptanceRun.key,
  );

  const evidencePath = readOption(argv, "--evidence");
  if (!evidencePath) {
    errorLog("usage error: --evidence <path> is required for a case run; the record is its output");
    return EXIT.USAGE;
  }
  const rendered = renderEvidence(record, secrets);
  // §20: the scrubber is a disclosure BACKSTOP, not evidence of clean handling.
  // If it had to act, that is itself a privacy finding and the run stops.
  if (rendered.includes("<scrubbed>")) {
    errorLog(
      "BLOCKED: secret material reached the pre-scrub case record. The scrubber removed it, " +
        "but that is a disclosure backstop, not evidence that upstream handling was clean.",
    );
    return EXIT.BLOCKED;
  }
  await write(evidencePath, rendered, "utf8");
  log(`case evidence written: ${evidencePath}`);
  log("Run `--stage B --aggregate` with every case record to obtain the Stage B verdict.");
  return EXIT.PASS;
}

// ── Stage B: aggregation ───────────────────────────────────────────────────

async function runStageBAggregate(ctx) {
  const { argv, log, errorLog, write, read, secrets, system, session, expectedSha } = ctx;

  const stageAPath = readOption(argv, "--stage-a");
  const stageA = await loadStageA(stageAPath, read, {
    run: ctx.run,
    expectedSha,
  });
  if (!stageA.ok) {
    errorLog(`BLOCKED: the Stage A record is not usable — ${stageA.reason}`);
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
  // §4-§6 of CORRECTION-04: the state each accepted case ran under, taken from
  // its own SEALED record. This is what makes the aggregate state-neutral.
  const caseFeatureStates = {};
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
    // §25: AUTHENTICITY FIRST. Reading binding fields out of an unverified
    // record and comparing them would be trusting the very thing under test.
    const authentic = verifyRecord(parsed, ctx.run.key, {
      runId: ctx.run.runId,
      expectedSha,
      runningImageId: binding.runningImageId,
    });
    if (!authentic.ok) {
      rejected.push(`${path}: ${authentic.reason}`);
      continue;
    }
    const validated = validateCaseRecord(parsed, binding);
    if (!validated.ok) {
      rejected.push(`${path}: ${validated.reason}`);
      continue;
    }
    Object.assign(caseObservations, validated.observations);
    caseFeatureStates[validated.caseName] = validated.featureState;
    accepted.push(validated.caseName);
  }

  for (const line of rejected) errorLog(`rejected case evidence — ${line}`);
  log(`accepted case evidence: ${accepted.length > 0 ? accepted.join(", ") : "none"}`);

  // §6 of CORRECTION-04: the CURRENT deployment state is RECORDED, never used
  // to decide whether an earlier phase passed. A completed acceptance whose
  // final state is `disabled` — the preferred Phase-10D terminal condition,
  // since Phase 10E owns final product enablement — must aggregate to PASS on
  // the strength of its sealed artifacts, and an aggregate run while generic
  // happens to be enabled must not erase the kill-switch evidence either.
  const finalFeatureState = describeFeatureState({
    ytdlpEnabledRaw,
    sites: capabilities,
    observedAt: new Date().toISOString(),
  });

  const obs = {
    expectedSha,
    runningImageId,
    ytdlpEnabledRaw,
    workerEnvironmentNames,
    capabilities,
    // The two historical phases, each from the case that observed it.
    enabledFeatureState: caseFeatureStates.success
      ? { measured: true, value: caseFeatureStates.success }
      : notMeasured(
          "no accepted `success` case evidence, so no artifact proves the enabled phase occurred " +
            "while generic was actually enabled",
        ),
    disabledFeatureState: caseFeatureStates["kill-switch"]
      ? { measured: true, value: caseFeatureStates["kill-switch"] }
      : notMeasured(
          "no accepted `kill-switch` case evidence, so no artifact proves the disabled phase " +
            "occurred while generic was actually disabled",
        ),
    finalFeatureState,
    // Every case-derived observation; anything a case did not supply stays a
    // measurement failure and lands as BLOCKED.
    genericAnalysis: caseObservations.genericAnalysis ?? notMeasured("no accepted `success` case evidence"),
    genericJob: caseObservations.genericJob ?? notMeasured("no accepted `success` case evidence"),
    durableJobRow: caseObservations.durableJobRow ?? notMeasured("no accepted `success` case evidence"),
    selectorConstraints: caseObservations.selectorConstraints ?? notMeasured("no accepted `success` case evidence"),
    downloadingWindow: caseObservations.downloadingWindow ?? notMeasured("no accepted `success` case evidence"),
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
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: ctx.run.runId,
    startedAt: ctx.startedAt,
    finishedAt: new Date().toISOString(),
    expectedSha,
    binding,
    runningImageId: binding.runningImageId,
    capabilities: capabilities.value ?? null,
    // The multi-state sequence, as the sealed artifacts record it.
    stateSequence: {
      enabledPhase: caseFeatureStates.success ?? null,
      disabledPhase: caseFeatureStates["kill-switch"] ?? null,
      byCase: caseFeatureStates,
      finalState: finalFeatureState.measured === true ? finalFeatureState.value : null,
      finalStateReason: finalFeatureState.measured === true ? null : finalFeatureState.reason,
    },
    workerEnvironment: summarizeEnvironment(workerEnvironmentNames),
    job: obs.genericJob?.value ?? null,
    processEvidence: summarizeProcess(obs.downloadingWindow),
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
    const sealed = sealRecord(record, ctx.run.key);
    const rendered = renderEvidence(sealed, secrets);
    if (rendered.includes("<scrubbed>")) {
      errorLog(
        "BLOCKED: secret material reached the pre-scrub Stage B record. The scrubber removed it, " +
          "but that is a disclosure backstop, not evidence that upstream handling was clean.",
      );
      return EXIT.BLOCKED;
    }
    await write(evidencePath, rendered, "utf8");
    log(`\nevidence written: ${evidencePath}`);
  }
  log(`\nVERDICT: ${result.summary.verdict}`);
  return exitFor(result.summary.verdict);
}

/**
 * Loads a prior Stage A record and admits it ONLY if it is AUTHENTIC, genuinely
 * passed, and carries a COMPLETE deployment binding (§25-§28 of CORRECTION-02).
 *
 * Returns a reason on refusal rather than a bare null, because "the Stage A
 * record was rejected" is only actionable if the operator learns which of the
 * five conditions failed.
 */
export async function loadStageA(path, read, { run, expectedSha } = {}) {
  if (!path) return { ok: false, reason: "--stage-a was not supplied" };
  let parsed;
  try {
    parsed = JSON.parse(await read(path, "utf8"));
  } catch {
    return { ok: false, reason: "the file is unreadable or not JSON" };
  }

  // 1. AUTHENTICITY first — before any field is believed.
  const authentic = verifyRecord(parsed, run?.key, {
    runId: run?.runId,
    expectedSha,
    // The Stage A record's own binding is checked below; the record-level
    // `runningImageId` is compared against it there.
    runningImageId: null,
  });
  if (!authentic.ok) return { ok: false, reason: authentic.reason };

  // 2. It must be a Stage A record that actually passed.
  if (parsed.stage !== "A") return { ok: false, reason: "the record is not a Stage A record" };
  if (parsed.verdict !== OUTCOMES.PASS) {
    return { ok: false, reason: `the record's verdict is ${String(parsed.verdict)}, not PASS` };
  }

  // 3. The deployment binding must be complete and self-consistent. A
  //    `runningImageId: null` binding must never authorize Stage B.
  const bindingCheck = validateDeploymentBinding(parsed.binding, expectedSha);
  if (!bindingCheck.ok) return { ok: false, reason: bindingCheck.reason };

  // 4. The top-level identity and the nested binding must AGREE (§23). Both are
  //    inside the seal, so this catches a record sealed with two internally
  //    inconsistent copies of the same identity.
  const agreement = bindingAgreesWithRecord(parsed);
  if (!agreement.ok) return { ok: false, reason: agreement.reason };

  return { ok: true, summary: { verdict: parsed.verdict }, binding: parsed.binding };
}

// ── Case collaborators ─────────────────────────────────────────────────────
//
// Every one of these returns a MEASUREMENT — `{ measured, value }` or a throw —
// and none of them invents a favourable value on failure (§15/§21 of
// CORRECTION-02). "We could not look" and "we looked and it was clean" are
// different findings, and only the second is evidence.

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
 * R2 evidence, MEASURED (§16 of CORRECTION-02).
 *
 * The previous implementation caught a failed Worker job-view read and returned
 * `objectExists: true` on the grounds that the job was `ready`. That is an
 * inference from another check, not a measurement of the object — and it made
 * `r2.delegated-write` unable to fail for the reason it exists to catch.
 *
 * The authenticated Worker job view is the authoritative source: it carries
 * `objectKey`, which the browser DTO strips. A read failure now throws, the
 * case aborts, and the CLI reports BLOCKED. The Worker is never granted
 * GetObject, and no credential material is inspected.
 */
function makeR2EvidenceProducer(ctx) {
  return async (finalJob) => {
    if (!finalJob || finalJob.status !== "ready") {
      throw new Error(`the job did not reach ready (status ${finalJob?.status ?? "unknown"}), so no R2 object exists to evidence`);
    }
    const worker = makeWorkerControl(ctx);
    const view = await worker.getJob(finalJob.jobId);
    const job = view?.job ?? null;
    if (!job) throw new Error("the authenticated Worker job view returned no job");
    const objectKey = typeof job.objectKey === "string" ? job.objectKey : null;
    if (!objectKey) {
      throw new Error("the Worker job view carries no object key, so the delegated write is unproven");
    }
    return {
      // The key SHAPE is evidence; the key itself is server-to-server data and
      // is not recorded.
      objectExists: /^videofetch\/jobs\/[0-9a-f]{32}\/[0-9a-f]{32}$/.test(objectKey),
      contentLength: Number.isInteger(job.fileSize) ? job.fileSize : 0,
    };
  };
}

/**
 * Whether a per-job working directory survived — TRI-STATE (§17 of CORRECTION-02).
 *
 * Returns the observation itself, so the caller can distinguish "measured
 * absent" (a pass candidate), "measured present" (a fail candidate) and "could
 * not measure" (BLOCKED). The previous version collapsed the third into the
 * second to avoid a false pass, which reported a cleanup FAILURE where there was
 * only a measurement failure.
 */
function makeWorkDirProbe(ctx) {
  return async (jobId) => ctx.system.workDirPresent(jobId);
}

/** The catalog is a source constant; promotion is a SOURCE change, not a runtime one. */
function makeCatalogComparator() {
  return async (sites) => {
    const entries = Array.isArray(sites?.sites) ? sites.sites : [];
    return entries.some((entry) => entry?.promotedByAcceptance === true);
  };
}

/**
 * The ACTUAL media transfer semantics, from the controlled fixture, CORRELATED
 * TO THIS CASE (§17-§20 of CORRECTION-03; §10-§12 of CORRECTION-04).
 *
 * The previous implementation did `HEAD` on the SUBMITTED URL. That is the
 * wrong request: the submitted URL is a page, and the transfer under test is the
 * progressive media GET that yt-dlp selected from it. A page with no
 * `Content-Length` whose media resource declared one would have passed — while
 * being caught by `--max-filesize`, which is the gate this case exists to rule
 * out.
 *
 * The harness cannot learn which media URL yt-dlp chose without breaching the
 * private-selector boundary, so the controlled fixture reports what it actually
 * served. `VIDEOFETCH_ACCEPT_BYTELIMIT_EVIDENCE_URL` is the fixture's own
 * read-only evidence endpoint.
 *
 * ── Why a bare endpoint was not enough ─────────────────────────────────────
 *
 * The previous probe asked the fixture "did you serve a media request?" with no
 * way to tell WHICH one. A static endpoint returning
 * `{"actualMediaRequestObserved": true}` satisfied it, and so did evidence left
 * over from a run an hour earlier. The submitted URL now carries a minted
 * `vf_case` correlation id, the fixture associates the media request it serves
 * with that id, and this probe requests and re-checks that exact id — so the
 * evidence is causally bound to this case's transfer or it is BLOCKED.
 */
function makeMediaTransferProbe(ctx) {
  return async (caseId) =>
    observe("actual media transfer semantics", async () => {
      const endpoint = ctx.env.VIDEOFETCH_ACCEPT_BYTELIMIT_EVIDENCE_URL;
      if (!endpoint) {
        throw new Error(
          "no fixture evidence endpoint was supplied (VIDEOFETCH_ACCEPT_BYTELIMIT_EVIDENCE_URL); " +
            "the transfer semantics of the actual media GET cannot be established",
        );
      }
      if (!CASE_ID_PATTERN.test(String(caseId ?? ""))) {
        throw new Error("refusing to request fixture evidence without a minted case correlation id");
      }
      // §11: ask for THIS case. The fixture returns evidence for the media
      // request it associated with this id, or nothing.
      const url = new URL(endpoint);
      url.searchParams.set("vf_case", caseId);

      const fetchImpl = ctx.deps.fetch ?? globalThis.fetch;
      const response = await fetchImpl(url.toString(), { redirect: "follow" });
      if (response.status === 404) {
        throw new Error(
          `the fixture holds no media-request evidence for this case (HTTP 404); the transfer ` +
            "under test cannot be attributed",
        );
      }
      if (!response.ok) throw new Error(`the fixture evidence endpoint returned HTTP ${response.status}`);
      const body = await response.json();

      // §12: the returned evidence must BE this case's.
      if (body?.caseId !== caseId) {
        throw new Error(
          "the fixture returned evidence for a different case than the one this run submitted; " +
            "it cannot be attributed to this transfer",
        );
      }
      if (typeof body?.actualMediaRequestObserved !== "boolean") {
        throw new Error("the fixture evidence is malformed");
      }
      // Exactly one media request may be attributed to this case. Zero is not
      // this case's transfer; several cannot be told apart, and picking one
      // would be a guess about which bytes the byte watcher actually saw.
      const mediaRequestCount = body?.mediaRequestCount;
      if (!Number.isInteger(mediaRequestCount)) {
        throw new Error("the fixture did not report how many media requests it attributed to this case");
      }
      if (body.actualMediaRequestObserved === true && mediaRequestCount !== 1) {
        throw new Error(
          `the fixture attributed ${mediaRequestCount} media requests to this case; a single ` +
            "unambiguous transfer is required to reason about the byte guard",
        );
      }
      // Only sanitized facts are carried forward: no URL, no selector, no
      // headers beyond the transfer-shape booleans the assertion needs.
      return {
        caseId,
        actualMediaRequestObserved: body.actualMediaRequestObserved,
        mediaRequestCount,
        contentLengthPresent: body.contentLengthPresent === true,
        transferMode: typeof body.transferMode === "string" ? body.transferMode : null,
        bytesServed: Number.isInteger(body.bytesServed) ? body.bytesServed : null,
        observedAt: typeof body.observedAt === "string" ? body.observedAt : null,
      };
    });
}

/**
 * Waits for the operator's Worker stop/restart (§9 of CORRECTION-03).
 *
 * The harness observes; it never performs the transition. A restart is detected
 * as the container's main PID changing — `systemctl stop`/`start` are not on the
 * read-only allowlist and are never called from here.
 */
function makeRestartWatcher(ctx) {
  return async ({ timeoutMs }) =>
    observe("operator Worker restart", async () => {
      const before = await ctx.system.containerPid();
      if (before.measured !== true) {
        throw new Error("the container PID could not be read before the transition");
      }
      const previousPid = before.value;

      const deadline = Date.now() + timeoutMs;
      let sawDown = false;
      while (Date.now() < deadline) {
        const now = await ctx.system.containerPid();
        if (now.measured !== true) {
          sawDown = true; // the container is gone — the stop half happened
        } else if (now.value !== previousPid) {
          // A changed PID is a genuine restart whether or not the down window
          // was caught between polls.
          return { previousPid, currentPid: now.value, downObserved: sawDown };
        }
        await (ctx.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(1000);
      }
      throw new Error("no Worker restart was observed before the window expired");
    });
}

/**
 * Reads one Phase-9 deny counter out of a chain listing.
 *
 * The listing itself is captured alongside the policy fingerprint, so before
 * and after share one read and cannot drift between them.
 */
function makeDenyCounterReader(ctx, denyClass) {
  void ctx;
  return async (listing) => readDenyCounter(listing, denyClass);
}

/**
 * The sentinel sweep (§18/§19 of CORRECTION-02).
 *
 * Every REQUIRED surface must be genuinely measured. The previous version
 * substituted `""` for an unreadable surface, which turned "could not read the
 * logs" into "the sentinel is absent from the logs" — an invalid inference, and
 * precisely the SKIPPED->PASS edge the harness forbids elsewhere.
 *
 * A surface that cannot be read makes the sweep unmeasured, which lands
 * `privacy.sentinel-not-leaked` as BLOCKED.
 */
function makeSentinelSweeper(ctx) {
  const { system, session } = ctx;
  return async (sentinel, { since, jobId, finalJob }) => {
    const surfaces = {};
    const unreadable = [];

    const require = (name, observation) => {
      if (observation?.measured !== true) {
        unreadable.push(`${name}: ${observation?.reason ?? "unavailable"}`);
        return;
      }
      surfaces[name] =
        typeof observation.value === "string" ? observation.value : JSON.stringify(observation.value);
    };

    require("worker-journal", await system.workerJournal(since));
    require("container-output", await system.workerLogs(since));
    // §19: the cloudflared-relevant surface needs a real observer, or the sweep
    // is incomplete. The unit name is configurable because the ingress unit is
    // deployment-named.
    require("cloudflared-journal", await system.unitJournal(ctx.cloudflaredUnit, since));
    require("durable-row", await system.durableJobRow(jobId));

    // Job metadata as the API actually returns it.
    surfaces["job-metadata"] = JSON.stringify(finalJob ?? null);

    // §19: a successful status response is NOT an error surface. A real error
    // body is obtained by asking for a job id that cannot exist, which exercises
    // the browser-facing error path without creating anything.
    const errorSurface = await observe("api error body", async () => {
      const response = await session.rawGet(`/api/download/${"0".repeat(32)}/status`);
      return `${response.status} ${await response.text()}`;
    });
    require("api-error", errorSurface);

    // Object metadata, from the authenticated Worker job view. The object key
    // and size are the metadata the application controls.
    const objectMetadata = await observe("object metadata", async () => {
      const worker = makeWorkerControl(ctx);
      const view = await worker.getJob(jobId);
      return JSON.stringify(view?.job ?? null);
    });
    require("object-metadata", objectMetadata);

    if (unreadable.length > 0) {
      return {
        measured: false,
        reason: `required sentinel surfaces could not be read: ${unreadable.join("; ")}`,
      };
    }

    const sweep = sweepForSentinel(surfaces, sentinel);
    return { measured: true, value: sweep.value };
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
/**
 * Final process evidence, from the SAME aggregate the evaluator judged
 * (§26 of CORRECTION-03).
 *
 * The previous serializer read `observation.value.sample` — the obsolete
 * single-sample shape — so against the current multi-sample window it emitted
 * empty basenames and empty namespaces regardless of what was actually
 * observed. Deriving both the verdict and the report from one aggregate is what
 * keeps the record honest: a transient Node solver or a transient forbidden
 * executable appears in the JSON precisely because it appeared in the verdict.
 *
 * Basenames, counts and namespace ids only. No command line, no argv, no URL.
 */
function summarizeProcess(observation) {
  if (observation?.measured !== true) {
    return { measured: false, reason: observation?.reason ?? null };
  }
  const aggregate = aggregateDownloadWindow(observation.value);
  return {
    measured: true,
    usable: aggregate.usable,
    reason: aggregate.reason,
    observedDownloading: observation.value?.observedDownloading === true,
    samplesTaken: aggregate.samplesTaken,
    usableSamples: aggregate.usableSamples,
    samplerErrorCount: aggregate.samplerErrors.length,
    ambiguousSampleCount: aggregate.ambiguousSamples.length,
    shapeViolationCount: aggregate.shapeViolations.length,
    basenamesSeen: aggregate.basenamesSeen,
    ownedYtdlpIdentified: ytdlpIdentified(aggregate),
    ownedYtdlpIdentityCount: aggregate.ytdlpIdentities.length,
    nodeExercised: nodeExercised(aggregate),
    nodeContained: nodeExercised(aggregate) ? nodeContained(aggregate) : null,
    nodeObservationCount: aggregate.nodeObservations.length,
    // Basenames only — enough to act on, and safe to record.
    forbiddenSeen: [...new Set(aggregate.forbiddenSeen.map((r) => r.comm))].sort(),
    forbiddenSeenCount: aggregate.forbiddenSeen.length,
    unknownSeen: [...new Set(aggregate.unknownSeen.map((r) => r.comm))].sort(),
    unknownSeenCount: aggregate.unknownSeen.length,
    namespaceViolationCount: aggregate.namespaceViolations.length,
    expectedNetns: aggregate.expectedNetns,
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
