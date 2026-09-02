// Stage B case producers and the case-record contract (§9 of CORRECTION-01).
//
// Phase 10D contains transitions that cannot all happen in one process — the
// operator enables generic, cancels a job, stops the Worker mid-acquisition,
// then rolls the switch back. So each case is its own reviewed CLI command that
// emits a sanitized case record, and a final aggregation turns those records
// into the Stage B verdict.
//
// ── Why this is not "trust a JSON file" ────────────────────────────────────
//
// A case record is admitted only if it is one THIS harness emitted and it still
// binds to this deployment:
//
//   1. `harness` and `schemaVersion` must be exactly ours;
//   2. `case` must be a known case name;
//   3. `expectedSha` and `runningImageId` must match the current run;
//   4. the payload must pass that case's STRICT validator — required fields of
//      the right type, and no unknown keys.
//
// So an operator cannot hand the aggregator a hand-written `{"passed":true}`
// and get a PASS: there is no field called `passed`, and every field that does
// exist is re-evaluated by the pure Stage B evaluator rather than believed.

import { mintSentinel, withSentinel } from "./evidence.mjs";
import { classifyTransitionTrace } from "./lifecycle.mjs";
import { createDownloadWindowCollector } from "./download-window.mjs";
import { evaluateTerminationCleanliness } from "./process-tree.mjs";

import { EVIDENCE_SCHEMA_VERSION, HARNESS_ID } from "./provenance.mjs";

/** One schema constant governs both record kinds, so they cannot drift apart. */
export const CASE_SCHEMA_VERSION = EVIDENCE_SCHEMA_VERSION;
export { HARNESS_ID };

/**
 * Every case the Stage B aggregation understands.
 *
 * DERIVED from `CASE_PRODUCERS` at the bottom of this file, which is the single
 * source of truth (§8 of CORRECTION-02). A name can no longer be advertised
 * here while no executable producer exists for it — the previous split between
 * this list and the CLI's dispatch map is exactly how four cases came to be
 * counted as concrete while being unimplemented.
 */
export function caseNames() {
  return Object.keys(CASE_PRODUCERS);
}

const isBool = (v) => typeof v === "boolean";
const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const isArr = (v) => Array.isArray(v);
const isDigest = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/**
 * Strict per-case payload validators.
 *
 * Each entry maps the observation keys the case contributes to a predicate.
 * `unknown keys are rejected` is enforced by `validateCaseRecord` walking the
 * payload's own keys against this map.
 */
const CASE_PAYLOAD_VALIDATORS = Object.freeze({
  success: {
    genericAnalysis: (v) =>
      isStr(v?.directControlExtractor) && isArr(v?.formats) && isArr(v?.presets) && "thumbnail" in v,
    genericJob: (v) => isArr(v?.transitions) && isStr(v?.requestedFormatId) && isStr(v?.jobId),
    durableJobRow: (v) => isStr(v?.jobId) && isStr(v?.status) && "formatId" in v && "extractor" in v,
    selectorConstraints: (v) => isBool(v?.containerMatches),
    // The complete downloading window, not one sample (§9-§12 of CORRECTION-02).
    downloadingWindow: (v) => isArr(v?.samples) && isBool(v?.observedDownloading),
    r2Evidence: (v) => isBool(v?.objectExists) && isInt(v?.contentLength),
    vercelDelivery: (v) =>
      isInt(v?.redirectStatus) && isBool(v?.presigned) && isDigest(v?.clientDigest),
    sentinelSweep: (v) => isBool(v?.leaked) && isArr(v?.surfacesChecked),
  },
  cancellation: {
    cancellation: (v) =>
      isArr(v?.transitions) &&
      isBool(v?.lateReady) &&
      isArr(v?.postSample) &&
      // Tri-state measurement flags are REQUIRED fields, so a record cannot
      // omit them and have the evaluator read `undefined !== true` as BLOCKED
      // by accident rather than by construction.
      isBool(v?.postSampleMeasured) &&
      isBool(v?.workDirMeasured) &&
      isInt(v?.workerPid) &&
      isBool(v?.beganProcessing) &&
      isBool(v?.uploaded) &&
      isBool(v?.workDirPresent),
  },
  "byte-limit": {
    byteLimitCase: (v) =>
      isBool(v?.declaredLengthUnknown) &&
      isStr(v?.outcome) &&
      isBool(v?.beganProcessing) &&
      isBool(v?.uploaded) &&
      isBool(v?.workDirPresent),
  },
  shutdown: {
    shutdownCase: (v) => isBool(v?.descendantsGone) && isStr(v?.recoveredStatus),
  },
  "safe-egress": {
    egressNegative: (v) => isBool(v?.denied) && isBool(v?.attributedToBoundary),
    egressPolicyFingerprint: (v) => isBool(v?.beforeMatchesAfter),
  },
  "direct-regression": {
    directAfterEnable: (v) =>
      isStr(v?.status) &&
      isArr(v?.sampledBasenames) &&
      isBool(v?.processSamplingMeasured) &&
      isInt(v?.samplesTaken),
  },
  "kill-switch": {
    killSwitch: (v) => isBool(v?.genericUsableAfterDisable) && isBool(v?.directWorks),
    siteCatalog: (v) => isBool(v?.limitedEntriesPromoted),
  },
  "fail-closed-runtime": {
    failClosedRuntime: (v) =>
      isBool(v?.genericUsable) && isBool(v?.fellBackToPath) && isBool(v?.directStillWorks),
  },
});

/** The observation keys a given case is allowed to contribute. */
export function caseContributions(caseName) {
  return Object.keys(CASE_PAYLOAD_VALIDATORS[caseName] ?? {});
}

/** Wraps a case's produced observations into the on-disk record. */
export function buildCaseRecord({ caseName, binding, payload, runId, startedAt, finishedAt }) {
  return {
    harness: HARNESS_ID,
    schemaVersion: CASE_SCHEMA_VERSION,
    runId: runId ?? null,
    stage: "B",
    case: caseName,
    expectedSha: binding?.expectedSha ?? null,
    runningImageId: binding?.runningImageId ?? null,
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,
    payload,
  };
}

/**
 * Admits a case record, or explains exactly why not.
 *
 * Returns `{ ok, reason, caseName, observations }` where `observations` are
 * already wrapped as `{ measured: true, value }` for the evaluator.
 */
export function validateCaseRecord(record, binding) {
  if (!record || typeof record !== "object") {
    return { ok: false, reason: "case record is not an object" };
  }
  if (record.harness !== HARNESS_ID) {
    return { ok: false, reason: "case record was not produced by this harness" };
  }
  if (record.schemaVersion !== CASE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `case record schema ${record.schemaVersion} is not ${CASE_SCHEMA_VERSION}`,
    };
  }
  if (record.stage !== "B") return { ok: false, reason: "case record is not a Stage B record" };
  if (!Object.prototype.hasOwnProperty.call(CASE_PRODUCERS, record.case)) {
    return { ok: false, reason: `unknown case name ${String(record.case)}` };
  }
  if (!binding || record.expectedSha !== binding.expectedSha) {
    return {
      ok: false,
      reason: `case '${record.case}' binds to source ${record.expectedSha ?? "<none>"}, not to ${binding?.expectedSha ?? "<none>"}`,
    };
  }
  if (binding.runningImageId && record.runningImageId !== binding.runningImageId) {
    return {
      ok: false,
      reason: `case '${record.case}' was produced against a different image object`,
    };
  }

  const validators = CASE_PAYLOAD_VALIDATORS[record.case];
  const payload = record.payload;
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: `case '${record.case}' carries no payload` };
  }

  // Unknown keys are rejected: a record may contribute exactly the observations
  // its case is defined to produce, and nothing else.
  for (const key of Object.keys(payload)) {
    if (!(key in validators)) {
      return { ok: false, reason: `case '${record.case}' carries unexpected observation '${key}'` };
    }
  }
  for (const [key, predicate] of Object.entries(validators)) {
    if (!(key in payload)) {
      return { ok: false, reason: `case '${record.case}' is missing observation '${key}'` };
    }
    if (predicate(payload[key]) !== true) {
      return { ok: false, reason: `case '${record.case}' observation '${key}' is malformed` };
    }
  }

  const observations = {};
  for (const [key, value] of Object.entries(payload)) {
    observations[key] = { measured: true, value };
  }
  return { ok: true, caseName: record.case, observations };
}

// ── The producers ──────────────────────────────────────────────────────────
//
// Each takes a context of already-constructed collaborators and returns the
// payload for its case record. They contain the acceptance CHOREOGRAPHY; the
// judging stays in `stage-b.mjs`.
//
// Every producer follows one rule (§15/§21 of CORRECTION-02): a measurement
// that could not be taken is reported AS a measurement failure. No `catch`
// invents a favourable value, because "we could not look" and "we looked and it
// was clean" are different findings and only one of them is evidence.

/**
 * Drives a job to a terminal state while sampling the process tree for exactly
 * the durable `downloading` window.
 *
 * The collector opens on the first observed `downloading` and closes on the
 * first state after it, so a `processing` sample — where Worker FFmpeg is
 * legitimate — can never reach the acquisition verdict.
 */
async function driveJobWithWindow(ctx, jobId, initialStatus, opts = {}) {
  const { session, sampler } = ctx;
  const collector = createDownloadWindowCollector({});
  let settled = false;
  let samplerFailure = null;

  const samplingLoop = (async () => {
    const sleep = ctx.sleep;
    while (!settled) {
      // The window state is captured BEFORE the await. `sampler.sample()` takes
      // several ticks, during which the job can legitimately move on to
      // `processing`; judging admission by the state at landing time discarded
      // every sample of a fast job.
      const takenWhileOpen = collector.open;
      if (takenWhileOpen) {
        try {
          collector.addSample(await sampler.sample(), { takenWhileOpen });
        } catch (error) {
          samplerFailure = String(error?.message ?? error);
        }
      }
      await sleep(opts.sampleIntervalMs ?? 200);
    }
  })();

  const polled = await session.pollTrace(jobId, {
    intervalMs: opts.pollIntervalMs ?? 200,
    initialStatus,
    onSample: (job) => {
      collector.noteState(job.status);
      if (["ready", "failed", "cancelled"].includes(job.status)) settled = true;
    },
  });
  settled = true;
  await samplingLoop;

  const window = collector.result();
  return { polled, window: { ...window, samplerFailure } };
}

/**
 * The generic success case (§11, §12 of CORRECTION-01).
 *
 * Mints the sentinel, submits it through the real application surface, drives
 * the durable lifecycle, samples the `downloading` window completely, retrieves
 * the final bytes through the Vercel signed GET, and sweeps for the sentinel.
 */
export async function runSuccessCase(ctx) {
  const { session, system, genericUrl, directUrl, now = () => new Date() } = ctx;

  const sentinel = mintSentinel();
  ctx.registerSecret?.(sentinel);
  const submittedUrl = withSentinel(genericUrl, sentinel);
  const startedAt = now().toISOString();

  // A direct CONTROL source in the same deployment. This does NOT observe the
  // internal direct attempt for the generic URL — nothing at the application
  // boundary can, and adding a surface that could would be the debug endpoint
  // this design forbids. It is recorded under a name that says what it is.
  const directProbe = await session.analyze(directUrl);

  const video = await session.analyze(submittedUrl);
  const preset = pickPreset(video?.presets);
  if (!preset) throw new Error("the generic source advertised no application preset to accept");

  const created = await session.createJob(submittedUrl, preset.formatId);
  const jobId = created.jobId;

  const { polled, window } = await driveJobWithWindow(ctx, jobId, created.status);
  const finalJob = polled.final;

  const durable = await system.durableJobRow(jobId);
  if (durable.measured !== true) {
    throw new Error(`durable job evidence unavailable: ${durable.reason}`);
  }

  // Delivery: 303 -> presigned -> bytes. The signed URL is used once and never
  // recorded.
  const signed = await session.signedDownload(jobId);
  const delivered = signed.location ? await session.fetchDigest(signed.location) : null;
  if (!delivered) throw new Error("no object bytes were delivered through the signed GET");

  // §16: R2 evidence is a MEASUREMENT. A failure to read the authenticated
  // Worker job view is not "the object exists because the job is ready".
  const r2 = await ctx.r2Evidence(finalJob);

  // §18: an unreadable required surface makes the sweep unmeasured, and the
  // case aborts rather than emitting a record whose privacy check could pass.
  const sweep = await ctx.sweepSurfaces(sentinel, { since: startedAt, jobId, finalJob });
  if (sweep?.measured !== true) {
    throw new Error(`the sentinel sweep is incomplete: ${sweep?.reason ?? "unknown"}`);
  }

  return {
    genericAnalysis: {
      extractor: video?.extractor ?? null,
      directControlExtractor: directProbe?.extractor ?? null,
      formats: video?.formats ?? [],
      presets: video?.presets ?? [],
      thumbnail: video?.thumbnail ?? null,
    },
    genericJob: {
      jobId,
      transitions: polled.trace,
      timeline: polled.timeline,
      requestedFormatId: preset.formatId,
    },
    durableJobRow: durable.value,
    selectorConstraints: {
      // §32 of CORRECTION-02: this is a DELIVERY observation, not a selector
      // observation. The selector's internal constraints are proven offline by
      // verify-selector.py against the pinned parser; exposing the raw upstream
      // id to test them live would breach the private boundary.
      containerMatches:
        finalJob?.status === "ready" &&
        typeof finalJob?.container === "string" &&
        finalJob.container === preset.container,
      advertisedContainer: preset.container ?? null,
      deliveredContainer: finalJob?.container ?? null,
    },
    downloadingWindow: {
      samples: window.samples,
      workerPid: window.workerPid,
      expectedNetns: window.expectedNetns,
      observedDownloading: window.observedDownloading,
      samplerFailure: window.samplerFailure,
    },
    r2Evidence: r2,
    vercelDelivery: {
      redirectStatus: signed.redirectStatus,
      presigned: signed.presigned,
      clientBytes: delivered.bytes,
      clientDigest: delivered.digest,
      durableFileSize: finalJob?.fileSize ?? null,
      r2ContentLength: r2?.contentLength ?? null,
      // No independently known digest exists for a public generic source: the
      // only way to derive one would be to acquire the media a second time
      // outside the application path, which is forbidden. Length agreement
      // across durable, provider and client is the honest assertion here, and
      // the direct fixture case is where a true expected digest exists.
      expectedDigest: null,
    },
    sentinelSweep: sweep.value,
  };
}

/** The highest-fidelity application preset the source advertised. */
export function pickPreset(presets) {
  if (!Array.isArray(presets) || presets.length === 0) return null;
  const order = [
    "preset:720",
    "preset:480",
    "preset:360",
    "preset:240",
    "preset:144",
    "preset:1080",
    "preset:best",
    "preset:audio",
  ];
  for (const id of order) {
    const found = presets.find((p) => p?.id === id);
    if (found) return found;
  }
  return presets[0];
}

/**
 * The cancellation case (§39).
 *
 * Cancels through the Worker's own authenticated route — the control plane
 * implements no cancellation surface — while the job is genuinely in
 * `downloading`, then re-samples to prove the owned group is gone.
 */
export async function runCancellationCase(ctx) {
  const { session, worker, sampler, genericUrl } = ctx;

  const video = await session.analyze(genericUrl);
  const preset = pickPreset(video?.presets);
  if (!preset) throw new Error("the cancellation source advertised no application preset");

  const created = await session.createJob(genericUrl, preset.formatId);
  const jobId = created.jobId;

  const transitions = [];
  let last = null;
  let cancelled = false;
  if (typeof created.status === "string") {
    transitions.push(created.status);
    last = created.status;
  }
  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    const job = await session.jobStatus(jobId);
    if (job.status !== last) {
      transitions.push(job.status);
      last = job.status;
    }
    if (job.status === "downloading" && !cancelled) {
      await worker.cancelJob(jobId);
      cancelled = true;
    }
    if (["ready", "failed", "cancelled"].includes(job.status)) break;
    await ctx.sleep(150);
  }

  // Settle, then look for survivors and for a late `ready`.
  await ctx.sleep(2000);

  // §14 of CORRECTION-02: a failed post-sample is BLOCKED, never "clean".
  let postSample = [];
  let workerPid = 0;
  let postSampleMeasured = false;
  let postSampleReason = null;
  try {
    const after = await sampler.sample();
    postSample = after.sample;
    workerPid = after.workerPid;
    postSampleMeasured = true;
  } catch (error) {
    postSampleReason = String(error?.message ?? error);
  }

  // §17: tri-state workDir evidence.
  const workDir = await ctx.workDirPresent(jobId);
  const finalJob = await session.jobStatus(jobId);

  return {
    cancellation: {
      jobId,
      transitions,
      lateReady: finalJob.status === "ready",
      postSample,
      postSampleMeasured,
      postSampleReason,
      workerPid,
      beganProcessing: transitions.includes("processing"),
      uploaded: transitions.includes("uploading"),
      workDirMeasured: workDir.measured === true,
      workDirPresent: workDir.measured === true ? workDir.value : true,
    },
  };
}

/**
 * The post-enable direct regression (§41).
 *
 * Proves `YTDLP_ENABLED=true` does not push direct media through yt-dlp: the
 * job must succeed as `direct`, and no yt-dlp process may appear while it runs.
 *
 * Unlike the generic case this samples the WHOLE run rather than only
 * `downloading`, because the claim is that yt-dlp never appears at all — a
 * narrower window would weaken it.
 */
export async function runDirectRegressionCase(ctx) {
  const { session, sampler, directUrl } = ctx;

  const video = await session.analyze(directUrl);
  const created = await session.createJob(directUrl, "direct-original");
  const jobId = created.jobId;

  const basenames = new Set();
  let samplesTaken = 0;
  let samplingFailure = null;
  let settled = false;

  const samplingLoop = (async () => {
    while (!settled) {
      try {
        const observed = await sampler.sample();
        samplesTaken += 1;
        for (const row of observed.sample) basenames.add(String(row.comm ?? "").toLowerCase());
      } catch (error) {
        samplingFailure = String(error?.message ?? error);
      }
      await ctx.sleep(150);
    }
  })();

  const polled = await session.pollTrace(jobId, {
    intervalMs: 150,
    initialStatus: created.status,
    onSample: (job) => {
      if (["ready", "failed", "cancelled"].includes(job.status)) settled = true;
    },
  });
  settled = true;
  await samplingLoop;

  return {
    directAfterEnable: {
      jobId,
      status: polled.final?.status ?? "unknown",
      extractor: polled.final?.extractor ?? video?.extractor ?? null,
      transitions: polled.trace,
      // §13: an empty list from a failed sampler must not read as "no yt-dlp".
      processSamplingMeasured: samplesTaken > 0,
      samplesTaken,
      samplingFailure,
      sampledBasenames: [...basenames].sort(),
    },
  };
}

/**
 * The kill-switch case (§43).
 *
 * The operator has already restored the disabled configuration and restarted
 * the Worker; this measures the result. The harness performs neither step.
 */
export async function runKillSwitchCase(ctx) {
  const { session, directUrl } = ctx;
  const sites = await session.sites();
  const direct = await session.analyze(directUrl);
  const catalogPromoted = await ctx.catalogPromoted(sites);

  return {
    killSwitch: {
      genericUsableAfterDisable: sites?.ytdlp === true,
      directWorks: direct?.extractor === "direct",
    },
    siteCatalog: { limitedEntriesPromoted: catalogPromoted },
  };
}

/**
 * The actual-byte-limit case (§5 of CORRECTION-02).
 *
 * Proves the APPLICATION byte watcher, not `--max-filesize`. The pinned
 * `HttpFD.real_download` checks that option only inside `if data_len is not
 * None`, so a source whose length is unknown or misdeclared streams straight
 * past it — which is exactly the fixture this case requires.
 *
 * The unknown-length property is MEASURED, not asserted by the operator: the
 * harness probes the fixture itself and reads the response headers.
 */
export async function runByteLimitCase(ctx) {
  const { session, byteLimitUrl } = ctx;

  // 1. Measure the fixture's declared length. A fixture that DOES declare a
  //    usable length would be caught by --max-filesize, and a pass from it
  //    would be evidence for the wrong gate.
  const declared = await ctx.probeDeclaredLength(byteLimitUrl);
  if (declared.measured !== true) {
    throw new Error(`the byte-limit fixture's declared length could not be probed: ${declared.reason}`);
  }
  if (declared.value.declaredLengthUnknown !== true) {
    throw new Error(
      "the byte-limit fixture declares a usable Content-Length, so it would be caught by " +
        "--max-filesize and cannot serve as evidence for the application byte watcher " +
        "(LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN)",
    );
  }

  // 2. Submit through the real application path.
  const video = await session.analyze(byteLimitUrl);
  const preset = pickPreset(video?.presets);
  if (!preset) throw new Error("the byte-limit fixture advertised no application preset");

  const created = await session.createJob(byteLimitUrl, preset.formatId);
  const jobId = created.jobId;

  const { polled } = await driveJobWithWindow(ctx, jobId, created.status);
  const finalJob = polled.final;

  const workDir = await ctx.workDirPresent(jobId);
  if (workDir.measured !== true) {
    throw new Error("the per-job working directory could not be probed after the byte-limit case");
  }

  return {
    byteLimitCase: {
      jobId,
      declaredLengthUnknown: true,
      declaredHeaders: declared.value.summary,
      // The durable error code IS the outcome. `TOO_LARGE` is classified by the
      // application byte watcher; a user cancellation is a different code.
      outcome: finalJob?.errorCode ?? finalJob?.status ?? "unknown",
      transitions: polled.trace,
      beganProcessing: polled.trace.includes("processing"),
      uploaded: polled.trace.includes("uploading"),
      workDirPresent: workDir.value,
    },
  };
}

/**
 * The shutdown-during-acquisition case (§6 of CORRECTION-02).
 *
 * The harness must remain non-mutating, so it COORDINATES rather than performs:
 * it starts a job, proves it is genuinely acquiring, prints a sanitized prompt,
 * and then waits for the operator's separately authorized Worker stop/restart.
 * `systemctl stop` is not on the read-only allowlist and is never called here.
 *
 * If the transition never happens inside the bounded window the case throws,
 * which the CLI turns into BLOCKED — never a pass.
 */
export async function runShutdownCase(ctx) {
  const { session, sampler, genericUrl, log } = ctx;

  const video = await session.analyze(genericUrl);
  const preset = pickPreset(video?.presets);
  if (!preset) throw new Error("the shutdown source advertised no application preset");

  const created = await session.createJob(genericUrl, preset.formatId);
  const jobId = created.jobId;

  // 1. Prove the job is genuinely acquiring before prompting.
  const deadline = Date.now() + 5 * 60 * 1000;
  const transitions = [];
  let last = null;
  let reachedDownloading = false;
  if (typeof created.status === "string") {
    transitions.push(created.status);
    last = created.status;
  }
  while (Date.now() < deadline && !reachedDownloading) {
    const job = await session.jobStatus(jobId);
    if (job.status !== last) {
      transitions.push(job.status);
      last = job.status;
    }
    if (job.status === "downloading") reachedDownloading = true;
    if (["ready", "failed", "cancelled"].includes(job.status)) break;
    await ctx.sleep(150);
  }
  if (!reachedDownloading) {
    throw new Error("the shutdown fixture never reached durable `downloading`; no window to interrupt");
  }

  // 2. Hand the transition to the operator. Nothing here mutates.
  log("");
  log("  ACTION REQUIRED — the harness does not stop the Worker.");
  log(`  Job ${jobId} is now in durable 'downloading'.`);
  log("  Perform the separately authorized Worker stop/restart NOW, then leave it running.");
  log("  This case will observe the result and will BLOCK if nothing happens.");
  log("");

  // 3. Wait for the container to actually go away and come back.
  const observed = await ctx.awaitWorkerRestart({ timeoutMs: ctx.shutdownWindowMs ?? 10 * 60 * 1000 });
  if (observed.measured !== true) {
    throw new Error(`no Worker restart was observed within the window: ${observed.reason}`);
  }

  // 4. Descendants must be gone, and the job must be recovered.
  let descendantsGone = false;
  let postSampleMeasured = false;
  try {
    const after = await sampler.sample();
    postSampleMeasured = true;
    descendantsGone = evaluateTerminationCleanliness(after.sample, after.workerPid).clean === true;
  } catch (error) {
    throw new Error(`the post-restart process tree could not be sampled: ${String(error?.message ?? error)}`);
  }

  const finalJob = await session.jobStatus(jobId);

  return {
    shutdownCase: {
      jobId,
      transitions,
      restartObserved: true,
      previousContainerPid: observed.value.previousPid,
      currentContainerPid: observed.value.currentPid,
      postSampleMeasured,
      descendantsGone,
      recoveredStatus: finalJob?.status ?? "unknown",
    },
  };
}

/**
 * The safe-egress negative case (§7 of CORRECTION-02).
 *
 * An ADAPTER around the accepted Phase-9 machinery, not a second firewall
 * framework. The forbidden-destination fixture, its redirect and the policy
 * fingerprint all come from `deploy/acceptance/safe-egress/` and the existing
 * read-only verifier.
 *
 * The harness never widens the policy, adds a temporary allow, or disables the
 * watchdog — none of those commands are on the read-only allowlist.
 */
export async function runSafeEgressCase(ctx) {
  const { session, egressRedirectUrl } = ctx;

  // 1. Policy state BEFORE. The read-only verifier is the accepted instrument.
  const before = await ctx.egressPolicyState();
  if (before.measured !== true) {
    throw new Error(`the safe-egress policy state could not be captured: ${before.reason}`);
  }

  // 2. A generic request whose LATER destination is forbidden. The submitted
  //    URL is public; the redirect target is the private/reserved address the
  //    Phase-9 fixture serves.
  let denied = false;
  let deniedReason = null;
  try {
    await session.analyze(egressRedirectUrl);
    // Reaching a successful analysis means the forbidden destination was
    // REACHED, which is the failure this case exists to detect.
  } catch (error) {
    denied = true;
    deniedReason = String(error?.message ?? error);
  }

  // 3. Attribute the denial to the external boundary using the existing
  //    counter/verifier tooling rather than inferring it from a timeout.
  const attribution = await ctx.egressDenialAttribution({ since: before.value.capturedAt });
  if (attribution.measured !== true) {
    throw new Error(`the denial could not be attributed to the boundary: ${attribution.reason}`);
  }

  // 4. Policy state AFTER — it must be byte-identical.
  const after = await ctx.egressPolicyState();
  if (after.measured !== true) {
    throw new Error(`the safe-egress policy state could not be re-captured: ${after.reason}`);
  }

  return {
    egressNegative: {
      denied,
      deniedReason,
      attributedToBoundary: attribution.value.attributedToBoundary === true,
      attribution: attribution.value.summary ?? null,
    },
    egressPolicyFingerprint: {
      beforeMatchesAfter: before.value.fingerprint === after.value.fingerprint,
    },
  };
}


// ── The case registry — the single source of truth ─────────────────────────
//
// `coverage.mjs` derives from this, the CLI dispatches from this, and the test
// suite asserts that every advertised name resolves to a real function. A
// descriptive string can no longer stand in for a producer.

/**
 * `live: false` means the case has no automated producer and CANNOT be run as a
 * live command. It is declared, not hidden — and the Stage B evaluator treats
 * its check as optional, so it can never satisfy a required assertion.
 */
export const CASE_PRODUCERS = Object.freeze({
  success: Object.freeze({
    run: runSuccessCase,
    live: true,
    // The Worker control credential is REQUIRED, not optional: R2 evidence and
    // the object-metadata sentinel surface both come from the authenticated
    // Worker job view, which is the only place `objectKey` exists.
    needs: ["genericUrl", "directUrl", "workerControl"],
    operatorTransition: false,
    summary: "generic analysis, lifecycle, process window, R2, signed GET, sentinel sweep",
  }),
  cancellation: Object.freeze({
    run: runCancellationCase,
    live: true,
    needs: ["genericUrl", "workerControl"],
    operatorTransition: false,
    summary: "cancel during downloading; survivors and cleanup",
  }),
  "byte-limit": Object.freeze({
    run: runByteLimitCase,
    live: true,
    needs: ["byteLimitUrl"],
    operatorTransition: false,
    summary: "unknown-declared-length over-limit source aborts as TOO_LARGE",
  }),
  shutdown: Object.freeze({
    run: runShutdownCase,
    live: true,
    needs: ["genericUrl"],
    // The harness proves the window and observes the result; the operator
    // performs the stop/restart. `systemctl stop` is not on the allowlist.
    operatorTransition: true,
    summary: "Worker stop during acquisition; owned group terminated and job recovered",
  }),
  "safe-egress": Object.freeze({
    run: runSafeEgressCase,
    live: true,
    needs: ["egressRedirectUrl"],
    operatorTransition: false,
    summary: "public submission whose later destination is forbidden; denial attributed to the boundary",
  }),
  "direct-regression": Object.freeze({
    run: runDirectRegressionCase,
    live: true,
    needs: ["directUrl"],
    operatorTransition: false,
    summary: "direct still succeeds as direct, with no yt-dlp process",
  }),
  "kill-switch": Object.freeze({
    run: runKillSwitchCase,
    live: true,
    needs: ["directUrl"],
    operatorTransition: true,
    summary: "generic unusable after the operator restores the disabled state",
  }),
  /**
   * NOT a live command.
   *
   * §42 forbids damaging the live image to run it, and a safe disposable
   * equivalent is a separate exercise against a container that is not the
   * Production Worker. Rather than advertise a command that always refuses, it
   * is declared here as a non-live optional negative test — and `stage-b.mjs`
   * folds `runtime.fail-closed` as OPTIONAL, so its absence reports
   * NOT_EXERCISED and can never satisfy a required check.
   */
  "fail-closed-runtime": Object.freeze({
    run: null,
    live: false,
    needs: [],
    operatorTransition: true,
    summary:
      "separately executed optional negative test against a disposable container; not a live case command",
  }),
});

/** The names that can actually be run as `--stage B --case <name>`. */
export function liveCaseNames() {
  return Object.entries(CASE_PRODUCERS)
    .filter(([, entry]) => entry.live === true && typeof entry.run === "function")
    .map(([name]) => name);
}

/** True when the name resolves to a real, callable producer. */
export function hasExecutableProducer(name) {
  const entry = CASE_PRODUCERS[name];
  return entry != null && entry.live === true && typeof entry.run === "function";
}

/** Exported so the CLI's success path can reuse the trace classification. */
export { classifyTransitionTrace };
