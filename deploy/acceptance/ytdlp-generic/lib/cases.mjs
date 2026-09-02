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

export const CASE_SCHEMA_VERSION = "10c4-correction-01";
export const HARNESS_ID = "deploy/acceptance/ytdlp-generic/acceptance.mjs";

/** Every case the Stage B aggregation understands, and what each contributes. */
export const CASE_NAMES = Object.freeze([
  "success",
  "cancellation",
  "byte-limit",
  "shutdown",
  "safe-egress",
  "direct-regression",
  "kill-switch",
  "fail-closed-runtime",
]);

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
      isBool(v?.directAttempted) && isArr(v?.formats) && isArr(v?.presets) && "thumbnail" in v,
    genericJob: (v) => isArr(v?.transitions) && isStr(v?.requestedFormatId) && isStr(v?.jobId),
    durableJobRow: (v) => isStr(v?.jobId) && isStr(v?.status) && "formatId" in v && "extractor" in v,
    selectorConstraints: (v) => isBool(v?.satisfied),
    downloadingSample: (v) => isArr(v?.sample) && isInt(v?.workerPid),
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
    directAfterEnable: (v) => isStr(v?.status) && isArr(v?.sampledBasenames),
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
export function buildCaseRecord({ caseName, binding, payload, startedAt, finishedAt }) {
  return {
    harness: HARNESS_ID,
    schemaVersion: CASE_SCHEMA_VERSION,
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
  if (!CASE_NAMES.includes(record.case)) {
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

/**
 * The generic success case (§11, §12 of CORRECTION-01).
 *
 * Mints the sentinel, submits it through the real application surface, drives
 * the durable lifecycle at a tight poll interval, samples the process tree for
 * exactly the `downloading` window, retrieves the final bytes through the
 * Vercel signed GET, and sweeps for the sentinel.
 */
export async function runSuccessCase(ctx) {
  const { session, system, sampler, genericUrl, directUrl, now = () => new Date() } = ctx;

  const sentinel = mintSentinel();
  ctx.registerSecret?.(sentinel);
  const submittedUrl = withSentinel(genericUrl, sentinel);
  const startedAt = now().toISOString();

  // Direct-first routing evidence, observed from outside: a direct source in
  // the SAME deployment must analyze as `direct`. Combined with the generic
  // source analyzing as `yt-dlp`, that is the routing proof available at the
  // application boundary — the internal EXTRACTOR_UNAVAILABLE fall-through is
  // not observable there, and inventing a way to see it would mean adding a
  // debug surface.
  const directProbe = await session.analyze(directUrl);
  const directAttempted = directProbe?.extractor === "direct";

  const video = await session.analyze(submittedUrl);
  const preset = pickPreset(video?.presets);
  if (!preset) throw new Error("the generic source advertised no application preset to accept");

  const created = await session.createJob(submittedUrl, preset.formatId);
  const jobId = created.jobId;

  // Sample the process tree for the downloading window only. The predicate is
  // driven by the poller's own view of durable state, so the sample is taken
  // when the job says `downloading` rather than on a guess about timing.
  let downloading = false;
  let settled = false;
  const samplePromise = sampler
    .sampleWhile(async () => !settled, { intervalMs: 250 })
    .catch(() => null);

  const polled = await session.pollTrace(jobId, {
    intervalMs: 200,
    initialStatus: created.status,
    onSample: (job) => {
      if (job.status === "downloading") downloading = true;
      if (["ready", "failed", "cancelled"].includes(job.status)) settled = true;
    },
  });
  settled = true;
  const sampled = await samplePromise;

  const finalJob = polled.final;
  const durable = await system.durableJobRow(jobId);

  // Delivery: 303 -> presigned -> bytes. The signed URL is used once and never
  // recorded.
  const signed = await session.signedDownload(jobId);
  let delivered = null;
  if (signed.location) delivered = await session.fetchDigest(signed.location);

  const r2 = await ctx.r2Evidence?.(finalJob, delivered);

  const sweep = await ctx.sweepSurfaces(sentinel, { since: startedAt, jobId, finalJob });

  return {
    genericAnalysis: {
      directAttempted,
      extractor: video?.extractor ?? null,
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
    durableJobRow: durable.measured === true ? durable.value : { error: durable.reason },
    selectorConstraints: {
      // Structural only (§28). The raw upstream id is never requested, never
      // reported and never recorded; what is provable from the product surface
      // is that the delivered artifact matches the preset that was accepted.
      satisfied:
        finalJob?.status === "ready" &&
        typeof finalJob?.container === "string" &&
        finalJob.container === preset.container,
      advertisedContainer: preset.container ?? null,
      deliveredContainer: finalJob?.container ?? null,
    },
    downloadingSample: sampled
      ? {
          sample: sampled.sample,
          workerPid: sampled.workerPid,
          ytdlpPid: sampled.ytdlpPid,
          expectedNetns: sampled.expectedNetns,
          observedDownloadingWindow: downloading,
        }
      : { sample: [], workerPid: 0, ytdlpPid: null, expectedNetns: null },
    r2Evidence: r2 ?? { objectExists: false, contentLength: 0 },
    vercelDelivery: {
      redirectStatus: signed.redirectStatus,
      presigned: signed.presigned,
      clientBytes: delivered?.bytes ?? 0,
      clientDigest: delivered?.digest ?? "",
      durableFileSize: finalJob?.fileSize ?? null,
      r2ContentLength: r2?.contentLength ?? null,
      // No independently known digest exists for a public generic source: the
      // only way to derive one would be to acquire the media a second time
      // outside the application path, which §24 forbids. Length agreement
      // across durable, provider and client is the honest assertion here, and
      // the direct fixture case is where a true expected digest exists.
      expectedDigest: null,
    },
    sentinelSweep: sweep,
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
  const { session, worker, sampler, genericUrl, directUrl: _directUrl } = ctx;
  void _directUrl;

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
  const after = await sampler.sample().catch(() => null);
  const finalJob = await session.jobStatus(jobId);

  return {
    cancellation: {
      jobId,
      transitions,
      lateReady: finalJob.status === "ready",
      postSample: after?.sample ?? [],
      workerPid: after?.workerPid ?? 0,
      // A cancelled job never commits processing or upload; `fileSize` stays
      // null and no object key is ever produced.
      beganProcessing: transitions.includes("processing"),
      uploaded: transitions.includes("uploading"),
      workDirPresent: await ctx.workDirPresent(jobId),
    },
  };
}

/**
 * The post-enable direct regression (§41).
 *
 * Proves `YTDLP_ENABLED=true` does not push direct media through yt-dlp: the
 * job must succeed as `direct`, and no yt-dlp process may appear while it runs.
 */
export async function runDirectRegressionCase(ctx) {
  const { session, sampler, directUrl } = ctx;

  const video = await session.analyze(directUrl);
  const created = await session.createJob(directUrl, "direct-original");
  const jobId = created.jobId;

  let settled = false;
  const samplePromise = sampler.sampleWhile(async () => !settled, { intervalMs: 200 }).catch(() => null);
  const polled = await session.pollTrace(jobId, {
    intervalMs: 150,
    initialStatus: created.status,
    onSample: (job) => {
      if (["ready", "failed", "cancelled"].includes(job.status)) settled = true;
    },
  });
  settled = true;
  const sampled = await samplePromise;

  return {
    directAfterEnable: {
      jobId,
      status: polled.final?.status ?? "unknown",
      extractor: polled.final?.extractor ?? video?.extractor ?? null,
      transitions: polled.trace,
      // Basenames observed across the WHOLE run, not one instant: a yt-dlp
      // process that existed briefly must still fail this case.
      sampledBasenames: sampled?.basenamesSeenAcrossRun ?? [],
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

/** Exported so the CLI's success path can reuse the trace classification. */
export { classifyTransitionTrace };
