// Stage B — "generic explicitly ENABLED" (§21-§43; Corrections B/C/D).
//
// Pure over an observation bundle, exactly like Stage A. Stage B may only be
// evaluated after a Stage A run verdicted PASS and whose record BINDS to this
// deployment (§29/§30 of CORRECTION-01); `evaluateStageB` refuses to grade
// anything otherwise, so the authorization edge cannot be skipped by invoking
// this module directly.

import { OUTCOMES, assertCheck, check, measuredCheck, summarize } from "./verdict.mjs";
import { classifyTransitionTrace, classifyCancellationTrace } from "./lifecycle.mjs";
import { evaluateGroupTermination } from "./process-tree.mjs";
import {
  aggregateDownloadWindow,
  nodeContained,
  nodeExercised,
  ytdlpIdentified,
} from "./download-window.mjs";

export { REQUIRED_TRANSITIONS } from "./lifecycle.mjs";

/**
 * The application-owned preset vocabulary, mirroring
 * `GENERIC_PRESET_ID_PATTERN` in `src/worker/analysis/ytdlp-analysis.server.ts`.
 *
 * For a generic source the product contract is `id === formatId`, and both are
 * one of these. A raw yt-dlp `format_id` is never one of them.
 */
export const APPLICATION_PRESETS = Object.freeze([
  "preset:best",
  "preset:2160",
  "preset:1440",
  "preset:1080",
  "preset:720",
  "preset:480",
  "preset:360",
  "preset:240",
  "preset:144",
  "preset:audio",
  "preset:mp3",
]);

/** The direct-path format id, for the post-enable direct regression. */
export const DIRECT_FORMAT_ID = "direct-original";

/**
 * Durable fields that must NOT exist on a generic job (§20 of CORRECTION-01).
 *
 * `formatId` / `format_id` are deliberately ABSENT from this list. Phase 10C3
 * persists the application-owned preset in the `format_id` column on purpose;
 * forbidding it was a correctness defect, not a strictness win — it would have
 * rejected every real durable row, in both the snake_case column name and the
 * camelCase projection. What must never become durable is the PRIVATE upstream
 * source selection, which has no column at all and stays memory-only for one
 * execution attempt. Those are the names below.
 */
export const FORBIDDEN_DURABLE_FIELDS = Object.freeze([
  "source_format_id",
  "sourceFormatId",
  "raw_format_id",
  "rawFormatId",
  "upstream_format_id",
  "upstreamFormatId",
  "selector",
  "format_selector",
  "formatSelector",
  "ytdlp_format",
  "ytdlpFormat",
  "source_url",
  "sourceUrl",
]);

/** Values a durable `format_id` may legitimately hold. */
export function isApplicationOwnedFormatId(value) {
  return APPLICATION_PRESETS.includes(value) || value === DIRECT_FORMAT_ID;
}

/**
 * Every advertised option is an application-owned preset.
 *
 * `presets` is an array of `WorkerQualityPreset` OBJECTS, each carrying both
 * `id` and `formatId`; the generic builder sets them equal. BOTH are checked,
 * because `formatId` is the field the browser echoes back on job creation and
 * is therefore the one a raw upstream id would have to travel in.
 */
export function presetsAreApplicationOwned(presets) {
  if (!Array.isArray(presets) || presets.length === 0) return false;
  return presets.every(
    (preset) =>
      preset != null &&
      typeof preset === "object" &&
      APPLICATION_PRESETS.includes(preset.id) &&
      APPLICATION_PRESETS.includes(preset.formatId) &&
      preset.id === preset.formatId,
  );
}

export function evaluateStageB(obs, stageAResult) {
  // ── §11/§20/§29 the authorization edge ──────────────────────────────────
  const authorization = stageBAuthorization(obs, stageAResult);
  if (!authorization.permitted) {
    const blocked = [
      check("stage-b.authorized-by-stage-a", OUTCOMES.BLOCKED, authorization.reason, { stage: "B" }),
    ];
    return Object.freeze({ stage: "B", checks: Object.freeze(blocked), summary: summarize(blocked) });
  }

  const checks = [];
  const stage = "B";
  const add = (entry) => checks.push(entry);

  // ── §21 the enabled conjunction, FROM THE ENABLED PHASE ────────────────
  //
  // §3-§6 of CORRECTION-04. These two checks used to read the CURRENT
  // deployment at aggregation time and require it to be enabled — which
  // contradicted the acceptance sequence the harness itself defines. That
  // sequence ends with the operator restoring the disabled state and running
  // the kill-switch case, so by aggregation time generic is expected to be
  // disabled; the aggregate would then have failed a run that had just
  // demonstrated everything it exists to demonstrate. Worse, it could be
  // satisfied the other way: enabling generic immediately before aggregating
  // would have produced a PASS on the strength of a state that had nothing to
  // do with when the evidence was captured.
  //
  // Both now read the state the `success` case SEALED while it ran. An artifact
  // recording the wrong state never reaches here — `validateCaseRecord` refuses
  // it — so an unmeasured enabled phase is BLOCKED rather than substituted for.
  add(
    measuredCheck(
      "capability.generic-usable",
      obs.enabledFeatureState,
      (value) =>
        value?.sites?.ytdlp === true &&
        value?.sites?.ytdlpInstalled === true &&
        value?.sites?.ytdlpEnabled === true,
      "while the enabled-phase cases ran, /api/sites reported ytdlp:true with all three conjuncts true",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "config.ytdlp-enabled",
      obs.enabledFeatureState,
      (value) => value?.state === "enabled" && value?.ytdlpEnabledRaw === "true",
      "while the enabled-phase cases ran, YTDLP_ENABLED was exactly 'true' in the deployed configuration",
      { stage },
    ),
  );
  // The DISABLED half of the same sequence, from the kill-switch case's own
  // sealed record. Together these two assertions are what let the aggregate be
  // state-neutral: each phase is proven by evidence captured while that phase
  // existed, and neither is inferred from the other or from the present.
  add(
    measuredCheck(
      "killswitch.disabled-state-proven",
      obs.disabledFeatureState,
      (value) =>
        value?.state === "disabled" &&
        (value?.ytdlpEnabledRaw === null || value?.ytdlpEnabledRaw === "false") &&
        value?.sites?.ytdlp === false &&
        value?.sites?.ytdlpEnabled === false,
      "while the kill-switch case ran, the deployment reported generic disabled at both the " +
        "configuration and the application boundary",
      { stage },
    ),
  );
  // §7: the final state is RECORDED, and the policy is stated rather than
  // implied. Phase 10D is deployment and acceptance; Phase 10E owns final
  // product enablement, and the runbook already has Production `YTDLP_ENABLED`
  // unset. So `disabled` is the preferred terminal condition — but a valid
  // sequence is proven by its sealed artifacts, not by which state the operator
  // happens to have left behind, and this check deliberately accepts either.
  // What it does NOT accept is a final state nobody could measure, or one
  // outside the deployment's own grammar.
  add(
    measuredCheck(
      "deployment.final-state-recorded",
      obs.finalFeatureState,
      (value) => value?.state === "enabled" || value?.state === "disabled",
      "the deployment state at aggregation time was measured and recorded (either state is a " +
        "valid terminal condition; Phase 10D prefers disabled, and Phase 10E owns enablement)",
      { stage },
    ),
  );

  // ── §25 generic HTTP analysis ──────────────────────────────────────────
  // ── §31 of CORRECTION-02: say only what was observed ────────────────────
  //
  // The internal direct attempt for the generic URL is NOT observable at the
  // application boundary, and adding a surface to observe it would be the debug
  // endpoint this design forbids. Two live facts ARE observable, and combined
  // with the exact-image binding they show the reviewed direct-first router is
  // the code that produced them — but that is a conclusion drawn from a
  // source-reviewed invariant, not a live observation of a fall-through, and
  // the check name no longer claims otherwise.
  add(
    measuredCheck(
      "analysis.generic-selected",
      obs.genericAnalysis,
      (value) => value?.extractor === "yt-dlp",
      "the generic source selected extractor=yt-dlp",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "analysis.direct-still-selected",
      obs.genericAnalysis,
      (value) => value?.directControlExtractor === "direct",
      "a direct control source in the same deployment still selected extractor=direct",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "analysis.no-raw-formats",
      obs.genericAnalysis,
      // v1 exposes `formats: []` for generic sources. A non-empty array would
      // mean a raw upstream format id had reached the browser contract.
      (value) => Array.isArray(value?.formats) && value.formats.length === 0,
      "generic metadata exposes no raw format list",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "analysis.presets-application-owned",
      obs.genericAnalysis,
      (value) => presetsAreApplicationOwned(value?.presets),
      "every advertised option carries id === formatId === an application preset",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "analysis.no-generic-thumbnail",
      obs.genericAnalysis,
      (value) => value?.thumbnail === null || value?.thumbnail === undefined,
      "no generic thumbnail URL is exposed under the v1 contract",
      { stage },
    ),
  );

  // ── §26 durable job lifecycle (CORRECTION-01 §14-§17) ──────────────────
  //
  // All six states, in order. An incomplete trace is an EVIDENCE GAP and lands
  // as BLOCKED; only a genuine ordering violation is FAIL. Missed polling is
  // never reinterpreted as proof.
  if (obs.genericJob?.measured !== true) {
    add(
      check(
        "job.lifecycle-complete",
        OUTCOMES.BLOCKED,
        `the durable lifecycle was not observed${obs.genericJob?.reason ? `: ${obs.genericJob.reason}` : ""}`,
        { stage },
      ),
    );
  } else {
    const classified = classifyTransitionTrace(obs.genericJob.value?.transitions);
    add(
      check("job.lifecycle-complete", classified.outcome, classified.trace.reason, { stage }),
    );
    add(
      assertCheck(
        "job.requested-preset-owned",
        APPLICATION_PRESETS.includes(obs.genericJob.value?.requestedFormatId),
        "the job was created with an application-owned preset",
        { stage },
      ),
    );
  }

  // ── §27 strategy persistence, and the corrected durable-format contract ──
  add(
    measuredCheck(
      "durable.extractor-is-ytdlp",
      obs.durableJobRow,
      (value) => value?.extractor === "yt-dlp",
      "durable evidence records extractor=yt-dlp after analysis",
      { stage },
    ),
  );
  // POSITIVE evidence (CORRECTION-01 §19): the durable format id is the
  // reviewed application preset, and it is the one the job was created with.
  add(
    measuredCheck(
      "durable.application-format-id",
      obs.durableJobRow,
      (value) => {
        if (!isApplicationOwnedFormatId(value?.formatId)) return false;
        const requested = obs.genericJob?.measured === true
          ? obs.genericJob.value?.requestedFormatId
          : undefined;
        // When the requested preset is known, durable must equal it exactly.
        return requested === undefined ? true : value.formatId === requested;
      },
      "the durable format id is the application preset the job was created with",
      { stage },
    ),
  );
  // NEGATIVE evidence: no field that could carry the private source selection.
  add(
    measuredCheck(
      "durable.no-raw-selector-fields",
      obs.durableJobRow,
      (value) =>
        value != null &&
        typeof value === "object" &&
        FORBIDDEN_DURABLE_FIELDS.every((field) => !(field in value)),
      "no raw upstream selector or source id exists in durable job evidence",
      { stage },
    ),
  );
  // ── §32 of CORRECTION-02: the selector's INTERNAL constraints are proven
  // offline, against the pinned parser, by verify-selector.py. Nothing at the
  // application boundary observes them, and exposing the raw upstream id to
  // test them would breach the private boundary this design exists to keep.
  //
  // What IS measurable live is that the artifact delivered matches the
  // application preset that was accepted — renamed so the label describes only
  // that.
  add(
    measuredCheck(
      "delivery.matches-advertised-preset",
      obs.selectorConstraints,
      (value) => value?.containerMatches === true,
      "the delivered container matches the container advertised for the accepted preset",
      { stage },
    ),
  );

  // ── §29-§32 process evidence ───────────────────────────────────────────
  for (const entry of evaluateProcessEvidence(obs, stage)) add(entry);

  // ── §33/§34 safe-egress negative case ──────────────────────────────────
  // §12 of CORRECTION-03: the Phase-9 attribution standard. A flat counter can
  // never pass — a connection that fails while every counter stays flat was
  // stopped by something else, most often a missing route.
  add(
    measuredCheck(
      "safe-egress.generic-path-established",
      obs.egressNegative,
      (value) => value?.genericPathEstablished === true && value?.extractor === "yt-dlp",
      "the forbidden destination was reached through the generic yt-dlp path, not the direct layer",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "safe-egress.forbidden-destination-denied",
      obs.egressNegative,
      (value) =>
        value?.denied === true &&
        value?.attributedToBoundary === true &&
        Number.isInteger(value?.denyCounterDelta) &&
        value.denyCounterDelta > 0 &&
        value?.policyVerifiedBefore === true &&
        value?.policyVerifiedAfter === true,
      "the connection failed AND the nftables deny counter moved, attributing it to the boundary",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "safe-egress.policy-unchanged",
      obs.egressPolicyFingerprint,
      (value) => value?.beforeMatchesAfter === true,
      "the nftables policy fingerprint is unchanged across the acceptance run",
      { stage },
    ),
  );

  // ── §35 R2 delegated write chain ───────────────────────────────────────
  add(
    measuredCheck(
      "r2.delegated-write",
      obs.r2Evidence,
      (value) => value?.objectExists === true && value?.contentLength > 0,
      "the object exists in R2 with a non-zero length, written through the broker",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "r2.worker-holds-no-credential",
      obs.workerEnvironmentNames,
      (names) =>
        Array.isArray(names) &&
        !names.includes("R2_WRITER_ACCESS_KEY_ID") &&
        !names.includes("R2_BROKER_PARENT_ACCESS_KEY_ID") &&
        !names.includes("R2_SIGNER_ACCESS_KEY_ID"),
      "the Worker still holds no persistent R2 credential of any kind",
      { stage },
    ),
  );

  // ── §36/§37 Vercel read chain and byte validation ──────────────────────
  add(
    measuredCheck(
      "vercel.signed-get",
      obs.vercelDelivery,
      (value) => value?.redirectStatus === 303 && value?.presigned === true,
      "the control plane issued a presigned read-only GET",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "vercel.byte-integrity",
      obs.vercelDelivery,
      // HTTP 200 alone is explicitly NOT proof (§37). Three-way length
      // agreement — durable, provider and client — plus a real digest.
      (value) =>
        typeof value?.clientDigest === "string" &&
        /^[0-9a-f]{64}$/.test(value.clientDigest) &&
        value.clientBytes > 0 &&
        value.clientBytes === value.durableFileSize &&
        value.clientBytes === value.r2ContentLength &&
        // An independently known digest is compared when one exists (the direct
        // fixture case); for a public generic source none can exist without
        // re-acquiring the media, which the harness must not do.
        (value.expectedDigest == null || value.expectedDigest === value.clientDigest),
      // §33: state exactly which boundaries were measured. The client digest is
      // a digest of the bytes the client received; it is NOT an independent
      // measurement of the Worker-produced object, because deriving one would
      // mean re-acquiring the media outside the application path. The direct
      // fixture case is where a genuinely independent digest exists, and there
      // `expectedDigest` is populated and compared.
      "delivered byte length agrees with the durable fileSize and the provider contentLength, and the delivered bytes hash to a recorded SHA-256",
      { stage },
    ),
  );

  // ── §46 sentinel leakage ───────────────────────────────────────────────
  add(
    measuredCheck(
      "privacy.sentinel-not-leaked",
      obs.sentinelSweep,
      (value) =>
        value?.leaked === false &&
        Array.isArray(value?.surfacesChecked) &&
        value.surfacesChecked.length >= 5,
      "the ephemeral sentinel appears in none of the swept surfaces",
      { stage },
    ),
  );

  // ── §39 cancellation ───────────────────────────────────────────────────
  if (obs.cancellation?.measured !== true) {
    add(
      check(
        "cancel.durable-cancelled",
        OUTCOMES.BLOCKED,
        `the cancellation case was not performed${obs.cancellation?.reason ? `: ${obs.cancellation.reason}` : ""}`,
        { stage },
      ),
    );
  } else {
    const cancellation = obs.cancellation.value;
    const classified = classifyCancellationTrace(cancellation?.transitions);
    add(check("cancel.durable-cancelled", classified.outcome, classified.trace.reason, { stage }));
    add(
      assertCheck(
        "cancel.no-late-ready",
        cancellation?.lateReady === false,
        "no late `ready` transition followed the cancellation",
        { stage },
      ),
    );
    // §8 of CORRECTION-03: the proof is about the EXACT captured group, at host
    // level. An ancestry check against the current Worker cannot answer it — a
    // leaked acquisition is orphaned and re-parented, so it would look clean.
    add(groupTerminationCheck("cancel.processes-gone", cancellation, stage, "cancellation"));

    // §17 of CORRECTION-02: `workDirPresent` is now a tri-state. A probe that
    // could not read the container is BLOCKED — a measurement failure and a
    // measured cleanup failure are different findings.
    if (cancellation?.workDirMeasured !== true) {
      add(
        check(
          "cancel.no-upload-no-workdir",
          OUTCOMES.BLOCKED,
          "the per-job working directory could not be probed after cancellation",
          { stage },
        ),
      );
    } else {
      add(
        assertCheck(
          "cancel.no-upload-no-workdir",
          cancellation?.beganProcessing === false &&
            cancellation?.uploaded === false &&
            cancellation?.workDirPresent === false,
          "cancellation performed no processing, no upload, and left no working directory",
          { stage },
        ),
      );
    }
  }

  // ── §38 actual-byte limit ──────────────────────────────────────────────
  // §17-§21 of CORRECTION-03. The evidence must describe the ACTUAL media GET,
  // must show that GET carried no usable Content-Length (so `--max-filesize`
  // cannot have been the mechanism), and must show the case ran generic.
  // §14 of CORRECTION-04 adds the two conjuncts that make this an assertion
  // about the APPLICATION THRESHOLD rather than about a job that happened to
  // fail: the transfer must be attributable to this exact case, and the bytes
  // actually served must EXCEED the limit the deployed Worker enforces.
  add(
    measuredCheck(
      "limit.actual-byte-guard",
      obs.byteLimitCase,
      (value) =>
        value?.extractor === "yt-dlp" &&
        // Causally bound to this case's own media request, and exactly one.
        typeof value?.caseId === "string" &&
        value.caseId.length > 0 &&
        value?.mediaRequestCount === 1 &&
        value?.actualMediaRequestObserved === true &&
        value?.contentLengthPresent === false &&
        value?.declaredLengthUnknown === true &&
        // The threshold was genuinely crossed, against the DEPLOYED limit.
        Number.isInteger(value?.bytesServed) &&
        Number.isInteger(value?.effectiveMaxFileSizeBytes) &&
        value.effectiveMaxFileSizeBytes > 0 &&
        value.bytesServed > value.effectiveMaxFileSizeBytes &&
        value?.exceededLimit === true &&
        value?.outcome === "TOO_LARGE" &&
        value?.beganProcessing === false &&
        value?.uploaded === false &&
        value?.workDirPresent === false,
      "this case's own media GET carried no usable declared length, served more bytes than the " +
        "deployed effective maxFileSizeBytes, and was aborted as TOO_LARGE before processing",
      { stage },
    ),
  );

  // ── §40 shutdown during acquisition ────────────────────────────────────
  // §9 of CORRECTION-03. Two independent assertions, because "the new Worker
  // has no descendants" is NOT "the old acquisition group died".
  if (obs.shutdownCase?.measured !== true) {
    add(
      check(
        "shutdown.group-terminated",
        OUTCOMES.BLOCKED,
        `the shutdown case was not performed${obs.shutdownCase?.reason ? `: ${obs.shutdownCase.reason}` : ""}`,
        { stage },
      ),
    );
  } else {
    add(groupTerminationCheck("shutdown.group-terminated", obs.shutdownCase.value, stage, "the Worker restart"));
    add(
      assertCheck(
        "shutdown.job-recovered",
        obs.shutdownCase.value?.restartObserved === true &&
          typeof obs.shutdownCase.value?.recoveredStatus === "string" &&
          obs.shutdownCase.value.recoveredStatus.length > 0,
        "the Worker restart was observed and the job was recovered per the restart policy",
        { stage },
      ),
    );
  }

  // ── §41 direct still works after enablement ────────────────────────────
  add(
    measuredCheck(
      "direct.after-enable",
      obs.directAfterEnable,
      (value) => value?.status === "ready" && value?.extractor === "direct",
      "a direct-media job still succeeds as direct with generic enabled",
      { stage },
    ),
  );
  // §13 of CORRECTION-02: an empty basename list is not evidence of absence.
  // `sampledBasenames: []` from a failed sampler previously PASSED this check —
  // the exact SKIPPED->PASS edge the harness forbids elsewhere. Sampling that
  // never ran is BLOCKED, not a clean result.
  const directSampling = obs.directAfterEnable;
  const samplingRan =
    directSampling?.measured === true &&
    directSampling.value?.processSamplingMeasured === true &&
    directSampling.value?.samplesTaken > 0;

  if (!samplingRan) {
    const why =
      directSampling?.measured !== true
        ? (directSampling?.reason ?? "the direct regression was not performed")
        : (directSampling.value?.samplingFailure ?? "no process sample was taken during the direct job");
    add(check("direct.process-sampling-available", OUTCOMES.BLOCKED, why, { stage }));
    add(
      check(
        "direct.no-ytdlp-spawned",
        OUTCOMES.BLOCKED,
        "no process observation exists, so the absence of yt-dlp is unproven",
        { stage },
      ),
    );
  } else {
    add(
      assertCheck(
        "direct.process-sampling-available",
        true,
        `${directSampling.value.samplesTaken} process sample(s) were taken during the direct job`,
        { stage },
      ),
    );
    add(
      assertCheck(
        "direct.no-ytdlp-spawned",
        Array.isArray(directSampling.value.sampledBasenames) &&
          !directSampling.value.sampledBasenames.some(
            (name) => name.startsWith("python") || name === "yt-dlp",
          ),
        "no yt-dlp process appeared in any sample taken while the direct job ran",
        { stage },
      ),
    );
  }

  // ── §42 fail-closed runtime (optional; must not damage the live image) ──
  add(
    foldOptional(
      "runtime.fail-closed",
      obs.failClosedRuntime,
      (value) =>
        value?.genericUsable === false &&
        value?.fellBackToPath === false &&
        value?.directStillWorks === true,
      "with the exact runtime unavailable, generic is unusable, PATH is not consulted, and direct still works",
      stage,
    ),
  );

  // ── §43 the kill switch ────────────────────────────────────────────────
  add(
    measuredCheck(
      "killswitch.rollback",
      obs.killSwitch,
      (value) => value?.genericUsableAfterDisable === false && value?.directWorks === true,
      "restoring the disabled configuration makes generic unusable while direct keeps working",
      { stage },
    ),
  );

  // ── §22 the catalog was not promoted ───────────────────────────────────
  add(
    measuredCheck(
      "catalog.unchanged",
      obs.siteCatalog,
      (value) => value?.limitedEntriesPromoted === false,
      "no 'limited' catalog entry was promoted on the strength of this run",
      { stage },
    ),
  );

  const summary = summarize(checks);
  return Object.freeze({ stage, checks: Object.freeze(checks), summary });
}

/**
 * §29/§30 of CORRECTION-01 — the Stage A record must BIND to this deployment.
 *
 * A PASS is an authorization artifact for one image, not a permanent licence.
 * Without the SHA and image-object bindings below, a Stage A record from an
 * older deployment would silently authorize Stage B against an image nobody
 * ran Stage A on — which is exactly the confusion the two-stage model exists to
 * prevent.
 */
export function stageBAuthorization(obs, stageAResult) {
  if (stageAResult?.summary?.verdict !== OUTCOMES.PASS) {
    return {
      permitted: false,
      reason: "Stage B assertions require a Stage A run that verdicted PASS; refusing to grade",
    };
  }

  const binding = stageAResult.binding ?? null;
  if (!binding) {
    return {
      permitted: false,
      reason: "the Stage A record carries no deployment binding; refusing to grade Stage B",
    };
  }

  const expectedSha = obs?.expectedSha ?? null;
  if (!expectedSha || binding.expectedSha !== expectedSha) {
    return {
      permitted: false,
      reason: `the Stage A record binds to source ${binding.expectedSha ?? "<none>"}, not to ${expectedSha ?? "<none>"}`,
    };
  }

  // The image object must match too. A restart legitimately recreates the
  // container from the SAME image, so the IMAGE id is compared rather than the
  // container id.
  const running = obs?.runningImageId?.measured === true ? obs.runningImageId.value : null;
  if (!running) {
    return {
      permitted: false,
      reason: "the currently running image could not be identified; refusing to grade Stage B",
    };
  }
  if (binding.runningImageId && binding.runningImageId !== running) {
    return {
      permitted: false,
      reason: "Stage A passed against a different image object than the one now deployed",
    };
  }

  return { permitted: true, reason: "Stage A passed and binds to this deployment" };
}

/**
 * The exact-group termination check, shared by cancellation and shutdown.
 *
 * Three outcomes, kept distinct: the group is gone (PASS), a plausible member
 * survives (FAIL), or the host could not be queried / the survivor set is
 * ambiguous under PID reuse (BLOCKED).
 */
function groupTerminationCheck(id, evidence, stage, what) {
  if (evidence?.groupMembersMeasured !== true) {
    return check(
      id,
      OUTCOMES.BLOCKED,
      `the host could not be queried for survivors of the captured acquisition group${
        evidence?.groupQueryReason ? `: ${evidence.groupQueryReason}` : ""
      }`,
      { stage },
    );
  }
  const termination = evaluateGroupTermination(
    { pgid: evidence.capturedPgid, pid: evidence.capturedYtdlpPid, comm: evidence.capturedComm },
    evidence.groupSurvivors,
  );
  if (termination.measured !== true) {
    return check(id, OUTCOMES.BLOCKED, termination.reason, { stage });
  }
  return assertCheck(
    id,
    termination.terminated === true,
    termination.terminated === true
      ? `the captured acquisition group (pgid ${evidence.capturedPgid}) has no surviving members after ${what}`
      : `group ${evidence.capturedPgid} still has members: ${termination.survivors.map((r) => r.comm).join(", ")}`,
    { stage },
  );
}

/**
 * The process checks, over the COMPLETE measured `downloading` window.
 *
 * `obs.downloadingWindow` carries every sample taken while durable state was
 * observed to be `downloading` — and only those. Samples from `processing` are
 * excluded by the collector, because Worker FFmpeg is legitimate there and
 * feeding them here would fail a correct deployment.
 */
function evaluateProcessEvidence(obs, stage) {
  const out = [];
  const observation = obs.downloadingWindow;

  if (observation?.measured !== true) {
    out.push(
      check(
        "process.window-observed",
        OUTCOMES.BLOCKED,
        `no process evidence was captured for the downloading window${
          observation?.reason ? `: ${observation.reason}` : ""
        }`,
        { stage },
      ),
    );
    return out;
  }

  const window = observation.value;
  if (window?.observedDownloading !== true) {
    // The job never reached an observed `downloading`, so there is no window to
    // make a statement about. That is an evidence gap, not a clean result.
    out.push(
      check(
        "process.window-observed",
        OUTCOMES.BLOCKED,
        "the job was never observed in durable `downloading`; no acquisition window exists",
        { stage },
      ),
    );
    return out;
  }

  const aggregate = aggregateDownloadWindow(window);

  // A schema violation is a DEFINITE finding — a sampler emitted a field the
  // evidence contract forbids — so it fails rather than reporting an inability
  // to look, and it is reported even when no sample survived.
  out.push(
    assertCheck(
      "process.sample-shape",
      aggregate.shapeViolations.length === 0,
      aggregate.shapeViolations.length === 0
        ? "every sample matches the closed schema (pid, ppid, pgid, comm, netns)"
        : aggregate.shapeViolations.slice(0, 3).join("; "),
      { stage },
    ),
  );

  if (!aggregate.usable) {
    out.push(check("process.window-observed", OUTCOMES.BLOCKED, aggregate.reason, { stage }));
    return out;
  }

  out.push(
    assertCheck(
      "process.window-observed",
      true,
      `${aggregate.usableSamples} process sample(s) captured across the observed downloading window`,
      { stage },
    ),
  );

  // The owned yt-dlp process must have been positively identified in at least
  // one sample. It legitimately exits before the window closes, so "once" is
  // the right threshold — but a window that never identified it cannot support
  // any statement about "the owned process".
  out.push(
    ytdlpIdentified(aggregate)
      ? assertCheck(
          "process.ytdlp-identified",
          true,
          `the owned yt-dlp process was positively identified in ${aggregate.ytdlpIdentities.length} sample(s)`,
          { stage },
        )
      : check(
          "process.ytdlp-identified",
          OUTCOMES.BLOCKED,
          "no sample in the downloading window positively identified the owned yt-dlp process",
          { stage },
        ),
  );

  // A SINGLE appearance anywhere in the window fails. This is the transient
  // case the previous "keep the largest sample" approach could miss entirely.
  out.push(
    assertCheck(
      "process.no-ffmpeg-during-downloading",
      aggregate.forbiddenSeen.length === 0,
      aggregate.forbiddenSeen.length === 0
        ? `no forbidden executable appeared in any of ${aggregate.usableSamples} downloading sample(s)`
        : `forbidden executables observed: ${[...new Set(aggregate.forbiddenSeen.map((r) => r.comm))].join(", ")}`,
      { stage },
    ),
  );
  out.push(
    assertCheck(
      "process.no-unknown-descendants",
      aggregate.unknownSeen.length === 0,
      aggregate.unknownSeen.length === 0
        ? "every descendant observed was on the approved acquisition list"
        : `unclassified executables observed: ${[...new Set(aggregate.unknownSeen.map((r) => r.comm))].join(", ")}`,
      { stage },
    ),
  );
  out.push(
    assertCheck(
      "process.namespace-identity",
      aggregate.namespaceViolations.length === 0,
      aggregate.namespaceViolations.length === 0
        ? "every sampled process shared the Worker's media network namespace"
        : `namespace mismatch for pids ${aggregate.namespaceViolations.map((o) => o.pid).join(", ")}`,
      { stage },
    ),
  );

  // Node appearing in ANY sample makes the case exercised — the previous
  // single-sample approach could report NOT_EXERCISED for a solver that ran.
  if (!nodeExercised(aggregate)) {
    out.push(
      check(
        "process.node-ejs-containment",
        OUTCOMES.NOT_EXERCISED,
        "NODE/EJS DESCENDANT NOT EXERCISED BY THIS SOURCE",
        { stage, required: false },
      ),
    );
  } else {
    const failures = aggregate.nodeObservations
      .filter((entry) => !(entry.anchored && entry.contained))
      .flatMap((entry) => entry.failures);
    out.push(
      assertCheck(
        "process.node-ejs-containment",
        nodeContained(aggregate),
        nodeContained(aggregate)
          ? `every Node/EJS observation (${aggregate.nodeObservations.length}) was inside the owned group and namespace`
          : failures.slice(0, 3).join("; "),
        { stage },
      ),
    );
  }

  return out;
}

/**
 * An optional check whose absence is recorded as NOT_EXERCISED rather than
 * inflated into a pass — but whose measured FAILURE still fails the run.
 */
function foldOptional(id, observation, predicate, detail, stage) {
  if (observation?.measured !== true) {
    return check(id, OUTCOMES.NOT_EXERCISED, `${detail} — not exercised in this run`, {
      stage,
      required: false,
    });
  }
  return assertCheck(id, predicate(observation.value) === true, detail, { stage, required: false });
}
