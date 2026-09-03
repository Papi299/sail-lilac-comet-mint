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

import { CASE_ID_PATTERN, mintCaseId, mintSentinel, withCaseId, withSentinel } from "./evidence.mjs";
import { classifyTransitionTrace } from "./lifecycle.mjs";
import { createDownloadWindowCollector } from "./download-window.mjs";
import { attributeDenial } from "./egress-policy.mjs";

import { EVIDENCE_SCHEMA_VERSION, HARNESS_ID, IMAGE_ID_PATTERN } from "./provenance.mjs";

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
const isCaseId = (v) => typeof v === "string" && CASE_ID_PATTERN.test(v);

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
      isStr(v?.extractor) &&
      isStr(v?.directControlExtractor) &&
      isArr(v?.formats) &&
      isArr(v?.presets) &&
      "thumbnail" in v,
    genericJob: (v) => isArr(v?.transitions) && isStr(v?.requestedFormatId) && isStr(v?.jobId),
    durableJobRow: (v) => isStr(v?.jobId) && isStr(v?.status) && "formatId" in v && "extractor" in v,
    selectorConstraints: (v) => isBool(v?.containerMatches),
    // The complete downloading window, not one sample (§9-§12 of CORRECTION-02).
    downloadingWindow: (v) =>
      isArr(v?.samples) &&
      isBool(v?.observedDownloading) &&
      isArr(v?.samplerErrors) &&
      isArr(v?.ambiguousSamples),
    r2Evidence: (v) => isBool(v?.objectExists) && isInt(v?.contentLength),
    vercelDelivery: (v) =>
      isInt(v?.redirectStatus) && isBool(v?.presigned) && isDigest(v?.clientDigest),
    sentinelSweep: (v) => isBool(v?.leaked) && isArr(v?.surfacesChecked),
  },
  cancellation: {
    cancellation: (v) =>
      isArr(v?.transitions) &&
      isBool(v?.lateReady) &&
      // The EXACT captured acquisition group, and the host-level survivor set.
      // Tri-state measurement flags are REQUIRED fields, so a record cannot omit
      // them and have the evaluator read `undefined !== true` as BLOCKED by
      // accident rather than by construction.
      isInt(v?.capturedPgid) &&
      isInt(v?.capturedYtdlpPid) &&
      isBool(v?.groupMembersMeasured) &&
      isArr(v?.groupSurvivors) &&
      isBool(v?.workDirMeasured) &&
      isBool(v?.beganProcessing) &&
      isBool(v?.uploaded) &&
      isBool(v?.workDirPresent),
  },
  "byte-limit": {
    byteLimitCase: (v) =>
      isStr(v?.extractor) &&
      isBool(v?.declaredLengthUnknown) &&
      // §10-§12 of CORRECTION-04: the evidence must be CAUSALLY BOUND to this
      // case, and must carry both sides of the comparison it claims.
      isCaseId(v?.caseId) &&
      isInt(v?.mediaRequestCount) &&
      // The transfer semantics of the ACTUAL media GET, not of the submitted URL.
      isBool(v?.actualMediaRequestObserved) &&
      isBool(v?.contentLengthPresent) &&
      isInt(v?.bytesServed) &&
      isInt(v?.effectiveMaxFileSizeBytes) &&
      isStr(v?.limitSource) &&
      isBool(v?.exceededLimit) &&
      isStr(v?.outcome) &&
      isBool(v?.beganProcessing) &&
      isBool(v?.uploaded) &&
      isBool(v?.workDirPresent),
  },
  shutdown: {
    shutdownCase: (v) =>
      isInt(v?.capturedPgid) &&
      isBool(v?.restartObserved) &&
      isBool(v?.groupMembersMeasured) &&
      isArr(v?.groupSurvivors) &&
      // §14 of CORRECTION-05: the deterministic recovery result, in full. All
      // three are REQUIRED fields, so a record cannot omit one and have the
      // evaluator read `undefined !== "failed"` as a coincidental refusal
      // rather than a structural one.
      isStr(v?.recoveredStatus) &&
      "recoveredErrorCode" in v &&
      "recoveredSafeErrorMessage" in v &&
      isBool(v?.lateReady),
  },
  "safe-egress": {
    egressNegative: (v) =>
      isBool(v?.genericPathEstablished) &&
      isStr(v?.extractor) &&
      isBool(v?.denied) &&
      isBool(v?.attributedToBoundary) &&
      isInt(v?.denyCounterBefore) &&
      isInt(v?.denyCounterAfter) &&
      isInt(v?.denyCounterDelta) &&
      isBool(v?.policyVerifiedBefore) &&
      isBool(v?.policyVerifiedAfter),
    egressPolicyFingerprint: (v) => isBool(v?.beforeMatchesAfter),
  },
  "direct-regression": {
    directAfterEnable: (v) =>
      isStr(v?.status) &&
      isArr(v?.sampledBasenames) &&
      isBool(v?.processSamplingMeasured) &&
      isInt(v?.samplesTaken) &&
      // The coverage gaps are REQUIRED fields, so a record cannot omit them and
      // have the evaluator read `undefined` as "no gaps".
      isArr(v?.samplingErrors) &&
      isInt(v?.samplingErrorCount),
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

/**
 * The deployment feature state a case ran under, as the HARNESS measured it at
 * the moment the case ran (§4/§5 of CORRECTION-04).
 *
 * This is the load-bearing artifact of the multi-state acceptance. The
 * enabled-phase and disabled-phase cases run at different times against
 * different deployment configurations, so "generic worked while enabled" and
 * "the kill switch worked while disabled" are claims about MOMENTS — and the
 * aggregate, running later against whichever state happens to exist then,
 * cannot reconstruct either of them.
 *
 * It lives on the RECORD rather than in a case payload, because it applies to
 * every case uniformly and because the record-level seal already authenticates
 * the whole object: an operator cannot edit `state` without invalidating it.
 *
 * `raw` is the deployment's own `YTDLP_ENABLED` spelling; `sites` is the
 * application's own answer at `/api/sites`. Both are MEASURED, never an
 * operator-authored boolean.
 */
export function describeFeatureState({ ytdlpEnabledRaw, sites, observedAt }) {
  const raw = ytdlpEnabledRaw?.measured === true ? (ytdlpEnabledRaw.value ?? null) : undefined;
  if (raw === undefined) {
    return { measured: false, reason: "YTDLP_ENABLED could not be read at case time" };
  }
  const state = raw === "true" ? "enabled" : raw === null || raw === "false" ? "disabled" : null;
  if (state === null) {
    return { measured: false, reason: "YTDLP_ENABLED holds an out-of-grammar value at case time" };
  }
  if (sites?.measured !== true) {
    return {
      measured: false,
      reason: `the application capability report could not be read at case time: ${sites?.reason ?? "unknown"}`,
    };
  }
  return {
    measured: true,
    value: {
      state,
      ytdlpEnabledRaw: raw,
      sites: {
        ytdlp: sites.value?.ytdlp === true,
        ytdlpInstalled: sites.value?.ytdlpInstalled === true,
        ytdlpEnabled: sites.value?.ytdlpEnabled === true,
      },
      observedAt: observedAt ?? null,
    },
  };
}

/** The shape a sealed `featureState` must have to be believed at all. */
export function isWellFormedFeatureState(value) {
  return (
    value != null &&
    typeof value === "object" &&
    (value.state === "enabled" || value.state === "disabled") &&
    (value.ytdlpEnabledRaw === null ||
      value.ytdlpEnabledRaw === "true" ||
      value.ytdlpEnabledRaw === "false") &&
    // Internal consistency: the summarized state must follow from the raw value
    // by the SAME grammar the deployment uses. A record claiming `enabled` next
    // to `ytdlpEnabledRaw: "false"` is self-contradictory and is refused rather
    // than resolved in either direction.
    value.state === (value.ytdlpEnabledRaw === "true" ? "enabled" : "disabled") &&
    value.sites != null &&
    typeof value.sites === "object" &&
    isBool(value.sites.ytdlp) &&
    isBool(value.sites.ytdlpInstalled) &&
    isBool(value.sites.ytdlpEnabled)
  );
}

/**
 * Whether the deployment feature state HELD across the whole case (§12-§14 of
 * CORRECTION-06).
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * A case measured its feature state ONCE, before the producer. `shutdown`
 * exists to span an operator restart, so the concrete attack is:
 *
 *     pre-case          YTDLP_ENABLED=true
 *     acquisition starts, operator restarts the SAME authorized image
 *     the Worker comes back with YTDLP_ENABLED=false
 *     restart recovery succeeds, image continuity holds
 *     -> the record sealed `featureState: enabled`
 *
 * That record combines two deployment states while claiming one. Image
 * continuity cannot catch it: the image genuinely did not change.
 *
 * ── What is required, and what deliberately is not ─────────────────────────
 *
 * Two things are gated:
 *
 *   1. the CONFIGURATION state (`YTDLP_ENABLED`, by the deployment's own
 *      grammar) is the case's required state on BOTH sides; and
 *   2. the application's capability report did not CHANGE across the producer.
 *
 * A particular capability VALUE is deliberately not gated. For `kill-switch`,
 * `/api/sites` still reporting `ytdlp: true` while the configuration is
 * disabled is not a precondition failure — it is the single most important
 * finding that case can produce, and refusing to run would convert "the kill
 * switch does not work" into "we did not look". The evaluator grades the
 * conjunction from this same sealed evidence, which is where a finding belongs.
 */
export function evaluateFeatureContinuity(before, after, requiredState) {
  if (!isWellFormedFeatureState(before) || !isWellFormedFeatureState(after)) {
    return { ok: false, reason: "the feature state was not measured on both sides of the case" };
  }
  if (requiredState !== "enabled" && requiredState !== "disabled") {
    return { ok: false, reason: "the case declares no required deployment state" };
  }
  if (before.state !== requiredState) {
    return {
      ok: false,
      reason: `the case requires generic ${requiredState}, but it began while generic was ${before.state}`,
    };
  }
  if (after.state !== requiredState) {
    return {
      ok: false,
      reason:
        `DEPLOYMENT FEATURE STATE CHANGED DURING THE CASE: it began with generic ${before.state} ` +
        `and ended with generic ${after.state}. The evidence spans two deployment states.`,
    };
  }
  // The capability report is compared, not required to hold a value — see the
  // docblock. A report that MOVED mid-case means the two halves of the evidence
  // describe different deployments even though the configuration matched.
  for (const field of ["ytdlp", "ytdlpInstalled", "ytdlpEnabled"]) {
    if (before.sites[field] !== after.sites[field]) {
      return {
        ok: false,
        reason:
          `DEPLOYMENT CAPABILITY CHANGED DURING THE CASE: /api/sites ${field} moved from ` +
          `${before.sites[field]} to ${after.sites[field]}`,
      };
    }
  }
  return { ok: true, state: requiredState };
}

/**
 * The shape a sealed `featureContinuity` must have to be believed.
 *
 * `sameRequiredState` is recomputed rather than trusted, so a record asserting
 * it beside two disagreeing measurements is refused rather than believed.
 */
export function isWellFormedFeatureContinuity(value, requiredState) {
  if (value == null || typeof value !== "object") return false;
  const evaluated = evaluateFeatureContinuity(value.before, value.after, requiredState);
  return evaluated.ok === true && value.sameRequiredState === true;
}

/**
 * The shape a sealed `imageContinuity` must have to be believed.
 *
 * `same` is not taken on trust — it is recomputed from the two ids, so a record
 * asserting `same: true` beside two different ids is refused rather than
 * believed. All three ids must be the SAME object.
 */
export function isWellFormedImageContinuity(value) {
  if (value == null || typeof value !== "object") return false;
  const { before, after, taggedImageId, same } = value;
  if (![before, after, taggedImageId].every((id) => IMAGE_ID_PATTERN.test(String(id)))) return false;
  if (before !== after || before !== taggedImageId) return false;
  return same === true;
}

/** Wraps a case's produced observations into the on-disk record. */
export function buildCaseRecord({
  caseName,
  binding,
  payload,
  runId,
  startedAt,
  finishedAt,
  featureState,
  featureContinuity,
  imageContinuity,
}) {
  return {
    harness: HARNESS_ID,
    schemaVersion: CASE_SCHEMA_VERSION,
    runId: runId ?? null,
    stage: "B",
    case: caseName,
    expectedSha: binding?.expectedSha ?? null,
    runningImageId: binding?.runningImageId ?? null,
    // The canonical phase state, PROVEN to have held across the whole case by
    // `featureContinuity` below — not a pre-case-only snapshot.
    featureState: featureState ?? null,
    // §12-§14 of CORRECTION-06: the state on BOTH sides of the producer.
    featureContinuity: featureContinuity ?? null,
    // §8-§10 of CORRECTION-05: the image object on BOTH sides of the producer.
    // Image ids are not secrets, and recording both is what lets a reviewer see
    // that a restart-spanning case stayed on one image.
    imageContinuity: imageContinuity ?? null,
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

  // ── §4-§6 of CORRECTION-04: the case must have run in the state it claims ──
  //
  // Each case declares the deployment state it is only meaningful in, and the
  // record carries the state the harness MEASURED when it ran. A `success`
  // record produced while generic was disabled proves nothing about generic
  // acquisition; a `kill-switch` record produced while it was enabled proves
  // nothing about the kill switch. Both are refused HERE, so the aggregate
  // never has to reconstruct a historical state from the current deployment.
  const featureState = record.featureState;
  if (!isWellFormedFeatureState(featureState)) {
    return {
      ok: false,
      reason:
        `case '${record.case}' carries no well-formed measured feature state; the deployment ` +
        "state it ran under cannot be established",
    };
  }
  const requiredState = expectedFeatureStateFor(record.case);
  if (requiredState !== null && featureState.state !== requiredState) {
    return {
      ok: false,
      reason:
        `case '${record.case}' requires generic ${requiredState}, but the sealed evidence records ` +
        `that it ran while generic was ${featureState.state}`,
    };
  }

  // §14 of CORRECTION-06: the state must have held for the WHOLE case, and the
  // aggregate recomputes that rather than trusting the record's own boolean —
  // a claim the aggregator cannot verify itself is a claim it should not make.
  if (requiredState !== null) {
    const continuity = record.featureContinuity;
    if (!isWellFormedFeatureContinuity(continuity, requiredState)) {
      const why = evaluateFeatureContinuity(continuity?.before, continuity?.after, requiredState);
      return {
        ok: false,
        reason:
          `case '${record.case}' carries no valid feature-state continuity: ` +
          `${why.ok ? "its sameRequiredState flag disagrees with its own measurements" : why.reason}`,
      };
    }
    // `featureState` is the canonical phase state, so it must BE the state the
    // continuity proves rather than a separate, potentially divergent claim.
    if (
      featureState.state !== continuity.before.state ||
      featureState.ytdlpEnabledRaw !== continuity.before.ytdlpEnabledRaw ||
      ["ytdlp", "ytdlpInstalled", "ytdlpEnabled"].some(
        (field) => featureState.sites[field] !== continuity.before.sites[field],
      )
    ) {
      return {
        ok: false,
        reason: `case '${record.case}' declares a phase state its own continuity evidence contradicts`,
      };
    }
  }

  // ── §9/§11 of CORRECTION-05: one image object, start to finish ────────────
  //
  // The producing CLI refuses to seal a record whose image changed, so a record
  // that reaches here should always carry a consistent continuity object. It is
  // re-checked anyway, because the aggregate must be able to state that no
  // accepted record combines evidence from two images — and a claim the
  // aggregator cannot verify itself is a claim it should not make.
  const continuity = record.imageContinuity;
  if (!isWellFormedImageContinuity(continuity)) {
    return {
      ok: false,
      reason:
        `case '${record.case}' carries no well-formed image-continuity evidence; the deployment ` +
        "it ran against cannot be confirmed to have stayed the same",
    };
  }
  if (continuity.before !== record.runningImageId) {
    return {
      ok: false,
      reason: `case '${record.case}' records a different image before the case than it binds to`,
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
  return { ok: true, caseName: record.case, observations, featureState };
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
  const collector = createDownloadWindowCollector({ now: ctx.monotonicNow });
  let settled = false;

  const samplingLoop = (async () => {
    const sleep = ctx.sleep;
    const clock = ctx.monotonicNow ?? (() => performance.now());
    while (!settled) {
      if (collector.open) {
        // A snapshot is an INTERVAL, not an instant. Both ends are recorded so
        // the collector can tell whether it sits cleanly inside the window,
        // cleanly outside it, or straddles the close — and refuse to guess in
        // the last case.
        const startedAt = clock();
        try {
          const observed = await sampler.sample();
          collector.addSample(observed, { startedAt, finishedAt: clock() });
        } catch (error) {
          collector.noteSamplerError(String(error?.message ?? error));
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

  return { polled, window: collector.result() };
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
  // §29: an operator-supplied "generic URL" that resolved as direct would
  // exercise the pre-existing direct path and prove nothing about generic
  // acquisition. Assert it, never assume it.
  requireGenericStrategy(video, "success");
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
      // §27/§28: gaps travel WITH the window, so the evaluator can refuse a
      // negative claim that rests on an unobserved interval.
      samplerErrors: window.samplerErrors,
      ambiguousSamples: window.ambiguousSamples,
      workerPid: window.workerPid,
      expectedNetns: window.expectedNetns,
      observedDownloading: window.observedDownloading,
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
 * The cancellation case (§8 of CORRECTION-03).
 *
 * Cancels through the Worker's own authenticated route — the control plane
 * implements no cancellation surface — while the job is genuinely in
 * `downloading`, having FIRST captured the exact owned process group.
 *
 * The termination proof is about that captured group, queried at host level.
 * `descendantsOf(currentWorkerPid)` cannot answer it: a cancelled acquisition
 * that leaked would be orphaned and re-parented away from the Worker, so it
 * would look clean under an ancestry check while still running.
 */
export async function runCancellationCase(ctx) {
  const { session, worker, genericUrl } = ctx;

  const video = await session.analyze(genericUrl);
  requireGenericStrategy(video, "cancellation");
  const preset = pickPreset(video?.presets);
  if (!preset) throw new Error("the cancellation source advertised no application preset");

  const created = await session.createJob(genericUrl, preset.formatId);
  const jobId = created.jobId;

  // 1. Reach durable `downloading` AND capture the exact owned group first.
  const captured = await awaitAcquisitionGroup(ctx, jobId, created.status);
  const transitions = [...captured.transitions];
  let last = transitions[transitions.length - 1] ?? null;

  // 2. Cancel through the real Worker surface.
  await worker.cancelJob(jobId);

  // 3. Settle.
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await session.jobStatus(jobId);
    if (job.status !== last) {
      transitions.push(job.status);
      last = job.status;
    }
    if (["ready", "failed", "cancelled"].includes(job.status)) break;
    await ctx.sleep(150);
  }
  await ctx.sleep(2000);

  // 4. The CAPTURED group must have no surviving members, at host level.
  const survivors = await ctx.processGroupMembers(captured.pgid);
  const workDir = await ctx.workDirPresent(jobId);
  const finalJob = await session.jobStatus(jobId);

  return {
    cancellation: {
      jobId,
      extractor: video.extractor,
      transitions,
      lateReady: finalJob.status === "ready",
      capturedPgid: captured.pgid,
      capturedYtdlpPid: captured.pid,
      capturedComm: captured.comm,
      groupMembersMeasured: survivors.measured === true,
      groupSurvivors: survivors.measured === true ? survivors.value : [],
      groupQueryReason: survivors.measured === true ? null : survivors.reason,
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
  // §16-§17 of CORRECTION-05: EVERY failed attempt is kept.
  //
  // The previous code held a single nullable `samplingFailure`, which a later
  // successful sample then overwrote with nothing — so a run that lost an
  // interval looked identical to one that never did. A failed attempt is an
  // unobserved interval, and this case's whole claim is a negative one across
  // the run, so the gaps travel with the evidence exactly as they do for the
  // generic downloading window.
  const samplingErrors = [];
  let settled = false;

  const samplingLoop = (async () => {
    while (!settled) {
      try {
        const observed = await sampler.sample();
        samplesTaken += 1;
        for (const row of observed.sample) basenames.add(String(row.comm ?? "").toLowerCase());
      } catch (error) {
        samplingErrors.push(String(error?.message ?? error));
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
      samplingErrors,
      samplingErrorCount: samplingErrors.length,
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
 * Asserts that a case genuinely reached the GENERIC path (§19/§29 of
 * CORRECTION-03).
 *
 * A case whose fixture unexpectedly analyzes as `direct` proves nothing about
 * generic acquisition — it exercised the pre-existing direct path, which was
 * already accepted in Phase 9/§11c. Silently passing on that would let the
 * whole generic acceptance be satisfied by the direct implementation.
 */
function requireGenericStrategy(video, caseName) {
  const extractor = video?.extractor ?? null;
  if (extractor !== "yt-dlp") {
    throw new Error(
      `case '${caseName}' requires the generic path, but the fixture analyzed as ` +
        `extractor=${String(extractor)}; it cannot serve as generic acceptance evidence`,
    );
  }
  return extractor;
}

/**
 * The actual-byte-limit case (§17-§21 of CORRECTION-03).
 *
 * Proves the APPLICATION byte watcher, not `--max-filesize`. The pinned
 * `HttpFD.real_download` checks that option only inside `if data_len is not
 * None`, so a source whose length is unknown or misdeclared streams straight
 * past it — which is exactly the fixture this case requires.
 *
 * ── Why the fixture reports its own transfer ───────────────────────────────
 *
 * An earlier draft did `HEAD` on the SUBMITTED URL. That is the wrong request:
 * the submitted URL is a page, and the transfer under test is the *progressive
 * media GET that yt-dlp selected from it*. A page with no `Content-Length` whose
 * media resource declares one would have passed, while being caught by
 * `--max-filesize` — evidence for the wrong gate entirely.
 *
 * The harness cannot see which media URL yt-dlp chose without breaching the
 * private-selector boundary, so the controlled fixture reports the transfer
 * semantics of the media GET it actually served. That keeps the raw selector
 * private while making the claim about the right request.
 */
export async function runByteLimitCase(ctx) {
  const { session, byteLimitUrl } = ctx;

  // 0. Mint the correlation identity and bind the submitted URL to it, so the
  //    fixture's later evidence is about THIS case's transfer and nothing else.
  //    Not a secret: it grants nothing and authenticates nothing.
  const caseId = mintCaseId();
  const submittedUrl = withCaseId(byteLimitUrl, caseId);

  // 1. Establish the fixture is genuinely generic before anything else.
  const video = await session.analyze(submittedUrl);
  requireGenericStrategy(video, "byte-limit");

  const preset = pickPreset(video?.presets);
  if (!preset) throw new Error("the byte-limit fixture advertised no application preset");

  // 2. The EFFECTIVE limit the deployed Worker enforces. Measured BEFORE the
  //    job runs, so a comparison is possible at all — and measured from the
  //    deployment rather than assumed from the repository default, because a
  //    deployment may legitimately override it.
  const limit = await ctx.effectiveMaxFileSize();
  if (limit.measured !== true) {
    throw new Error(
      `the deployed effective maxFileSizeBytes could not be established: ${limit.reason} ` +
        "(LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN)",
    );
  }
  const effectiveMaxFileSizeBytes = limit.value.bytes;

  const created = await session.createJob(submittedUrl, preset.formatId);
  const jobId = created.jobId;

  const { polled } = await driveJobWithWindow(ctx, jobId, created.status);
  const finalJob = polled.final;

  // 3. Ask the fixture what it ACTUALLY served FOR THIS CASE. This is the
  //    request whose semantics the byte watcher had to cope with.
  const transfer = await ctx.mediaTransferEvidence(caseId);
  if (transfer.measured !== true) {
    throw new Error(
      `the actual media transfer semantics could not be established: ${transfer.reason} ` +
        "(LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN)",
    );
  }
  if (transfer.value.actualMediaRequestObserved !== true) {
    throw new Error(
      "the fixture served no media request for this case, so there is no transfer to reason about " +
        "(LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN)",
    );
  }
  if (transfer.value.contentLengthPresent === true) {
    throw new Error(
      "the actual media GET declared a usable Content-Length, so --max-filesize could have " +
        "stopped this job; it cannot serve as evidence for the application byte watcher " +
        "(LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN)",
    );
  }

  // 4. The bytes actually transferred must have CROSSED the deployed limit.
  //
  //    Without this the case proved only that a job failed with TOO_LARGE — it
  //    never established that the application threshold was reached, which is
  //    the entire assertion. A fixture serving less than the limit and a Worker
  //    reporting TOO_LARGE would have been a PASS while describing a bug.
  const bytesServed = transfer.value.bytesServed;
  if (!Number.isInteger(bytesServed)) {
    throw new Error(
      "the fixture did not report how many bytes it served, so the byte threshold cannot be " +
        "shown to have been crossed (LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN)",
    );
  }
  if (bytesServed <= effectiveMaxFileSizeBytes) {
    throw new Error(
      `the fixture served ${bytesServed} bytes against an effective limit of ` +
        `${effectiveMaxFileSizeBytes}; the transfer never crossed the deployed threshold, so this ` +
        "run is invalid fixture evidence rather than acceptance evidence",
    );
  }

  const workDir = await ctx.workDirPresent(jobId);
  if (workDir.measured !== true) {
    throw new Error("the per-job working directory could not be probed after the byte-limit case");
  }

  return {
    byteLimitCase: {
      jobId,
      caseId,
      extractor: video.extractor,
      declaredLengthUnknown: true,
      actualMediaRequestObserved: true,
      mediaRequestCount: transfer.value.mediaRequestCount,
      contentLengthPresent: false,
      transferMode: transfer.value.transferMode ?? null,
      bytesServed,
      effectiveMaxFileSizeBytes,
      limitSource: limit.value.source,
      exceededLimit: bytesServed > effectiveMaxFileSizeBytes,
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
 * The shutdown-during-acquisition case (§9 of CORRECTION-03).
 *
 * The harness must remain non-mutating, so it COORDINATES rather than performs:
 * it starts a job, proves it is genuinely acquiring, CAPTURES THE EXACT OWNED
 * PROCESS GROUP, prints a sanitized prompt, and then waits for the operator's
 * separately authorized Worker stop/restart. `systemctl stop` is not on the
 * read-only allowlist and is never called here.
 *
 * The post-restart proof is about the CAPTURED group, queried at host level.
 * "The new Worker has no descendants" is a different assertion: after a restart
 * a leaked acquisition process is orphaned and re-parented, so it would not be
 * a descendant of the new Worker even while it was still running.
 */
export async function runShutdownCase(ctx) {
  const { session, genericUrl, log } = ctx;

  const video = await session.analyze(genericUrl);
  requireGenericStrategy(video, "shutdown");
  const preset = pickPreset(video?.presets);
  if (!preset) throw new Error("the shutdown source advertised no application preset");

  const created = await session.createJob(genericUrl, preset.formatId);
  const jobId = created.jobId;

  // 1. Reach durable `downloading` AND capture the exact owned group.
  const captured = await awaitAcquisitionGroup(ctx, jobId, created.status);

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

  // 4. The CAPTURED group must be gone, at host level.
  const survivors = await ctx.processGroupMembers(captured.pgid);

  // 5. The AUTHORITATIVE recovery result (§12-§14 of CORRECTION-05).
  const recovery = await awaitRecoveredJob(ctx, jobId);

  return {
    shutdownCase: {
      jobId,
      extractor: video.extractor,
      transitions: captured.transitions,
      capturedPgid: captured.pgid,
      capturedYtdlpPid: captured.pid,
      capturedComm: captured.comm,
      restartObserved: true,
      previousContainerPid: observed.value.previousPid,
      currentContainerPid: observed.value.currentPid,
      groupMembersMeasured: survivors.measured === true,
      groupSurvivors: survivors.measured === true ? survivors.value : [],
      groupQueryReason: survivors.measured === true ? null : survivors.reason,
      recoveredStatus: recovery.status,
      recoveredErrorCode: recovery.errorCode,
      recoveredSafeErrorMessage: recovery.safeErrorMessage,
      recoveryPolls: recovery.polls,
      lateReady: recovery.lateReady,
    },
  };
}

/**
 * Polls, boundedly, for the job the restarted Worker recovered (§13).
 *
 * ── Why this is not a single request ───────────────────────────────────────
 *
 * The restart is detected by the container's main PID changing, which happens
 * the instant the new container starts — well before the Worker has opened its
 * database, run `recover()`, and begun answering HTTP. A single request at that
 * moment would most often fail outright, and an early answer could still show
 * the pre-restart row. So this waits for the Worker to answer at all, and then
 * for the job to reach a terminal state.
 *
 * A window that expires without a terminal answer is a measurement failure and
 * the case aborts — never a favourable default.
 */
async function awaitRecoveredJob(ctx, jobId) {
  const { session } = ctx;
  const timeoutMs = ctx.recoveryWindowMs ?? 2 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let lateReady = false;
  let lastFailure = null;

  while (Date.now() < deadline) {
    polls += 1;
    let job = null;
    try {
      job = await session.jobStatus(jobId);
    } catch (error) {
      // The Worker is not answering yet. That is expected immediately after a
      // restart and is not itself a finding.
      lastFailure = String(error?.message ?? error);
      await ctx.sleep(500);
      continue;
    }

    if (job.status === "ready") lateReady = true;
    if (["ready", "failed", "cancelled"].includes(job.status)) {
      return {
        status: job.status,
        // `error` is the browser projection of the durable `safeErrorMessage`
        // — `src/web/jobs/public-job.ts` surfaces it under that name, and it is
        // the deterministic recovery sentence when the restart path set one.
        errorCode: job.errorCode ?? null,
        safeErrorMessage: typeof job.error === "string" ? job.error : null,
        polls,
        lateReady,
      };
    }
    await ctx.sleep(500);
  }

  throw new Error(
    `the restarted Worker did not report a terminal state for the interrupted job within ` +
      `${Math.round(timeoutMs / 1000)}s${lastFailure ? ` (last error: ${lastFailure})` : ""}; ` +
      "the restart-recovery contract could not be observed",
  );
}

/**
 * Drives a job to durable `downloading` and captures the exact owned yt-dlp
 * process identity (§6 of CORRECTION-03).
 *
 * The PGID is the load-bearing value: `process-runner.server.ts` spawns
 * acquisition detached, so the owned process leads its own group, and every
 * termination proof downstream is expressed in terms of that group. If it
 * cannot be established the case aborts — a termination claim about a group
 * nobody identified is not evidence.
 */
async function awaitAcquisitionGroup(ctx, jobId, initialStatus) {
  const { session, sampler } = ctx;
  const transitions = [];
  let last = null;
  if (typeof initialStatus === "string") {
    transitions.push(initialStatus);
    last = initialStatus;
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await session.jobStatus(jobId);
    if (job.status !== last) {
      transitions.push(job.status);
      last = job.status;
    }
    if (job.status === "downloading") {
      const observed = await sampler.sample().catch(() => null);
      if (observed?.ytdlpPid != null) {
        const row = observed.sample.find((entry) => entry.pid === observed.ytdlpPid);
        if (row) {
          return {
            transitions,
            pid: row.pid,
            pgid: row.pgid,
            comm: row.comm,
            netns: row.netns ?? null,
            nodeMembers: observed.sample
              .filter((entry) => entry.pgid === row.pgid && entry.comm === "node")
              .map((entry) => entry.pid),
          };
        }
      }
    }
    if (["ready", "failed", "cancelled"].includes(job.status)) break;
    await ctx.sleep(150);
  }
  throw new Error(
    "the owned yt-dlp process group could not be established while the job was in `downloading`",
  );
}

/**
 * The safe-egress negative case (§11-§15 of CORRECTION-03).
 *
 * An ADAPTER around the accepted Phase-9 instrument, not a second firewall
 * framework: the deny counters and the chain listing come from the same
 * nftables rule-comment vocabulary `deploy/acceptance/safe-egress/counter.py`
 * already reads.
 *
 * ── The required path ──────────────────────────────────────────────────────
 *
 *   public submitted generic source
 *     -> direct returns EXTRACTOR_UNAVAILABLE
 *     -> yt-dlp generic path
 *     -> yt-dlp later attempts the controlled forbidden destination
 *     -> the external nftables boundary denies it
 *
 * A submitted URL that simply redirects to a private address is NOT this: the
 * control plane's own SSRF guard rejects it long before generic is reached, so
 * the case would "pass" while proving only that the direct layer works.
 */
export async function runSafeEgressCase(ctx) {
  const { session, egressRedirectUrl } = ctx;

  // 1. Policy state BEFORE — verifier verdict plus a real ruleset fingerprint.
  const before = await ctx.egressPolicyState();
  if (before.measured !== true) {
    throw new Error(`the safe-egress policy state could not be captured: ${before.reason}`);
  }
  const beforeCounter = await ctx.denyCounter(before.value.listing);
  if (beforeCounter.measured !== true) {
    throw new Error(`the deny counter could not be read before the attempt: ${beforeCounter.reason}`);
  }

  // 2. Prove the fixture genuinely reaches the GENERIC path. If it analyzes as
  //    direct, or the direct layer rejects it outright, this case cannot be
  //    generic egress evidence.
  const video = await session.analyze(egressRedirectUrl);
  requireGenericStrategy(video, "safe-egress");
  const preset = pickPreset(video?.presets);
  if (!preset) throw new Error("the safe-egress fixture advertised no application preset");

  // 3. Run the acquisition, whose selected media destination is forbidden.
  const created = await session.createJob(egressRedirectUrl, preset.formatId);
  const polled = await session.pollTrace(created.jobId, {
    intervalMs: 200,
    initialStatus: created.status,
  });
  const finalJob = polled.final;
  const requestDenied = finalJob?.status === "failed";

  // 4. Attribute the denial to the boundary via the COUNTER, not the verdict.
  const after = await ctx.egressPolicyState();
  if (after.measured !== true) {
    throw new Error(`the safe-egress policy state could not be re-captured: ${after.reason}`);
  }
  const afterCounter = await ctx.denyCounter(after.value.listing);
  if (afterCounter.measured !== true) {
    throw new Error(`the deny counter could not be read after the attempt: ${afterCounter.reason}`);
  }

  const attribution = attributeDenial({
    before: beforeCounter,
    after: afterCounter,
    requestDenied,
  });
  if (attribution.measured !== true) throw new Error(attribution.reason);

  return {
    egressNegative: {
      jobId: created.jobId,
      genericPathEstablished: true,
      extractor: video.extractor,
      forbiddenClass: ctx.egressDenyClass,
      denied: requestDenied,
      attributedToBoundary: attribution.attributedToBoundary,
      denyCounterBefore: attribution.denyCounterBefore,
      denyCounterAfter: attribution.denyCounterAfter,
      denyCounterDelta: attribution.denyCounterDelta,
      policyVerifiedBefore: before.value.verifierExit === 0,
      policyVerifiedAfter: after.value.verifierExit === 0,
    },
    egressPolicyFingerprint: {
      beforeMatchesAfter: before.value.fingerprint === after.value.fingerprint,
      rulesetFingerprintStable: before.value.fingerprint === after.value.fingerprint,
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
    expectedFeatureState: "enabled",
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
    expectedFeatureState: "enabled",
    needs: ["genericUrl", "workerControl"],
    operatorTransition: false,
    summary: "cancel during downloading; survivors and cleanup",
  }),
  "byte-limit": Object.freeze({
    run: runByteLimitCase,
    live: true,
    expectedFeatureState: "enabled",
    needs: ["byteLimitUrl"],
    operatorTransition: false,
    summary: "unknown-declared-length over-limit source aborts as TOO_LARGE",
  }),
  shutdown: Object.freeze({
    run: runShutdownCase,
    live: true,
    expectedFeatureState: "enabled",
    needs: ["genericUrl"],
    // The harness proves the window and observes the result; the operator
    // performs the stop/restart. `systemctl stop` is not on the allowlist.
    operatorTransition: true,
    summary: "Worker stop during acquisition; owned group terminated and job recovered",
  }),
  "safe-egress": Object.freeze({
    run: runSafeEgressCase,
    live: true,
    expectedFeatureState: "enabled",
    needs: ["egressRedirectUrl"],
    operatorTransition: false,
    summary: "public submission whose later destination is forbidden; denial attributed to the boundary",
  }),
  "direct-regression": Object.freeze({
    run: runDirectRegressionCase,
    live: true,
    expectedFeatureState: "enabled",
    needs: ["directUrl"],
    operatorTransition: false,
    summary: "direct still succeeds as direct, with no yt-dlp process",
  }),
  "kill-switch": Object.freeze({
    run: runKillSwitchCase,
    live: true,
    // The ONLY case that runs with generic DISABLED. The previous global guard
    // required YTDLP_ENABLED=true for every Stage B case, which made this case
    // — whose entire purpose is to prove the kill switch works — impossible to
    // run at all.
    expectedFeatureState: "disabled",
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
    expectedFeatureState: null,
    needs: [],
    operatorTransition: true,
    summary:
      "separately executed optional negative test against a disposable container; not a live case command",
  }),
});


/**
 * The per-case deployment-state gate (§3/§4 of CORRECTION-03).
 *
 * `observed` is the `ytdlpEnabledRaw` observation. Three outcomes, and the
 * unmeasured one is BLOCKED for every case: running a case while the deployment
 * stage itself is unknown produces evidence nobody can interpret.
 */
export function evaluateCaseFeatureState(caseName, observed) {
  const entry = CASE_PRODUCERS[caseName];
  if (!entry) return { ok: false, reason: `unknown case '${caseName}'` };
  const expected = entry.expectedFeatureState;
  if (expected == null) {
    return { ok: false, reason: `case '${caseName}' is not a live case command` };
  }

  if (observed?.measured !== true) {
    return {
      ok: false,
      blocked: true,
      reason:
        "YTDLP_ENABLED could not be measured, so the deployment stage is unknown; " +
        `refusing to run case '${caseName}'`,
    };
  }

  const raw = observed.value;
  // The accepted disabled grammar, unchanged: absent, or exactly "false".
  const isEnabled = raw === "true";
  const isDisabled = raw === null || raw === undefined || raw === "false";
  const actual = isEnabled ? "enabled" : isDisabled ? "disabled" : "malformed";

  if (actual === "malformed") {
    return {
      ok: false,
      blocked: true,
      reason: `YTDLP_ENABLED holds an out-of-grammar value; refusing to run case '${caseName}'`,
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      blocked: true,
      reason:
        `STAGE MISMATCH: case '${caseName}' requires generic ${expected}, ` +
        `but the deployment is ${actual}. Refusing to run it against the wrong state.`,
    };
  }
  return { ok: true, actual };
}

/** The state a case needs, for the README and the aggregation's ordering check. */
export function expectedFeatureStateFor(caseName) {
  return CASE_PRODUCERS[caseName]?.expectedFeatureState ?? null;
}

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
