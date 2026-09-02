// Stage B — "generic explicitly ENABLED" (§21-§43; Corrections B/C/D).
//
// Pure over an observation bundle, exactly like Stage A. Stage B may only be
// evaluated after a Stage A run verdicted PASS and whose record BINDS to this
// deployment (§29/§30 of CORRECTION-01); `evaluateStageB` refuses to grade
// anything otherwise, so the authorization edge cannot be skipped by invoking
// this module directly.

import { OUTCOMES, assertCheck, check, measuredCheck, summarize } from "./verdict.mjs";
import { classifyTransitionTrace, classifyCancellationTrace } from "./lifecycle.mjs";
import {
  classifyAcquisitionTree,
  evaluateNamespaceIdentity,
  evaluateNodeContainment,
  evaluateTerminationCleanliness,
  evaluateYtdlpIdentity,
  validateSampleShape,
} from "./process-tree.mjs";

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

  // ── §21 the enabled conjunction ────────────────────────────────────────
  add(
    measuredCheck(
      "capability.generic-usable",
      obs.capabilities,
      (value) =>
        value?.ytdlp === true && value?.ytdlpInstalled === true && value?.ytdlpEnabled === true,
      "/api/sites reports ytdlp:true with all three conjuncts true",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "config.ytdlp-enabled",
      obs.ytdlpEnabledRaw,
      (value) => value === "true",
      "YTDLP_ENABLED is exactly 'true' in the deployed configuration",
      { stage },
    ),
  );

  // ── §25 generic HTTP analysis ──────────────────────────────────────────
  add(
    measuredCheck(
      "analysis.routed-to-generic",
      obs.genericAnalysis,
      (value) => value?.extractor === "yt-dlp" && value?.directAttempted === true,
      "direct was attempted first and fell through to generic",
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
  // §28: the raw upstream id is never reported. Structural statement only.
  add(
    measuredCheck(
      "selector.constraints-satisfied",
      obs.selectorConstraints,
      (value) => value?.satisfied === true,
      "safe selector constraints satisfied (structural; no raw upstream id reported)",
      { stage },
    ),
  );

  // ── §29-§32 process evidence ───────────────────────────────────────────
  for (const entry of evaluateProcessEvidence(obs, stage)) add(entry);

  // ── §33/§34 safe-egress negative case ──────────────────────────────────
  add(
    measuredCheck(
      "safe-egress.forbidden-destination-denied",
      obs.egressNegative,
      (value) => value?.denied === true && value?.attributedToBoundary === true,
      "a later forbidden destination was denied by the external boundary",
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
      "delivered bytes agree with durable and provider length, and hash to a recorded digest",
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
    add(
      assertCheck(
        "cancel.processes-gone",
        cancellation?.postSample != null &&
          evaluateTerminationCleanliness(cancellation.postSample, cancellation.workerPid).clean ===
            true,
        "no yt-dlp or Node descendant survives cancellation",
        { stage },
      ),
    );
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

  // ── §38 actual-byte limit ──────────────────────────────────────────────
  add(
    measuredCheck(
      "limit.actual-byte-guard",
      obs.byteLimitCase,
      (value) =>
        value?.declaredLengthUnknown === true &&
        value?.outcome === "TOO_LARGE" &&
        value?.beganProcessing === false &&
        value?.uploaded === false &&
        value?.workDirPresent === false,
      "an over-limit source with an unknown declared length aborted as TOO_LARGE before processing",
      { stage },
    ),
  );

  // ── §40 shutdown during acquisition ────────────────────────────────────
  add(
    measuredCheck(
      "shutdown.group-terminated",
      obs.shutdownCase,
      (value) =>
        value?.descendantsGone === true &&
        typeof value?.recoveredStatus === "string" &&
        value.recoveredStatus.length > 0,
      "a Worker stop during acquisition terminated the owned group and recovered the job",
      { stage },
    ),
  );

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
  add(
    measuredCheck(
      "direct.no-ytdlp-spawned",
      obs.directAfterEnable,
      (value) =>
        Array.isArray(value?.sampledBasenames) &&
        !value.sampledBasenames.some((name) => name.startsWith("python") || name === "yt-dlp"),
      "no yt-dlp process appeared while the direct job ran",
      { stage },
    ),
  );

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
 * The process-tree checks, which share one sample and one shape validation.
 */
function evaluateProcessEvidence(obs, stage) {
  const out = [];
  const observation = obs.downloadingSample;

  if (observation?.measured !== true) {
    // §49: inability to inspect descendants is BLOCKED, never PASS.
    out.push(
      check(
        "process.sample-available",
        OUTCOMES.BLOCKED,
        `the process tree could not be sampled during downloading${
          observation?.reason ? `: ${observation.reason}` : ""
        }`,
        { stage },
      ),
    );
    return out;
  }

  const { sample, workerPid, ytdlpPid, expectedNetns } = observation.value;

  const shape = validateSampleShape(sample);
  out.push(
    assertCheck(
      "process.sample-shape",
      shape.ok,
      shape.ok
        ? "the process sample matches the closed schema (pid, ppid, pgid, comm, netns)"
        : shape.violations.slice(0, 4).join("; "),
      { stage },
    ),
  );
  if (!shape.ok) return out;

  const classified = classifyAcquisitionTree(sample, workerPid);

  // ── §22 of CORRECTION-01: the EXACT owned yt-dlp process ───────────────
  const identity = evaluateYtdlpIdentity(sample, workerPid, ytdlpPid, expectedNetns);
  out.push(
    identity.identified
      ? assertCheck(
          "process.ytdlp-identified",
          true,
          `the owned yt-dlp process (pid ${identity.pid}, ${identity.comm}, own process-group leader) was positively identified`,
          { stage },
        )
      : check("process.ytdlp-identified", OUTCOMES.BLOCKED, identity.reason, { stage }),
  );

  out.push(
    assertCheck(
      "process.no-ffmpeg-during-downloading",
      classified.forbidden.length === 0,
      classified.forbidden.length === 0
        ? "no forbidden executable ran under the Worker during downloading"
        : `forbidden descendants observed: ${classified.forbidden.map((r) => r.comm).join(", ")}`,
      { stage },
    ),
  );
  out.push(
    assertCheck(
      "process.no-unknown-descendants",
      classified.unknown.length === 0,
      classified.unknown.length === 0
        ? "every descendant is on the approved acquisition list"
        : `unclassified descendants observed: ${classified.unknown.map((r) => r.comm).join(", ")}`,
      { stage },
    ),
  );

  // §32 namespace identity.
  const namespaces = evaluateNamespaceIdentity(classified, expectedNetns);
  out.push(
    namespaces.measured
      ? assertCheck(
          "process.namespace-identity",
          namespaces.consistent,
          namespaces.consistent
            ? "every sampled process shares the Worker's media network namespace"
            : `namespace mismatch for pids ${namespaces.offenders.map((o) => o.pid).join(", ")}`,
          { stage },
        )
      : check("process.namespace-identity", OUTCOMES.BLOCKED, namespaces.reason, { stage }),
  );

  // §23/§31 Node/EJS containment, ANCHORED to the verified owned PID.
  const node = evaluateNodeContainment(classified, identity, expectedNetns);
  if (!node.anchored) {
    out.push(check("process.node-ejs-containment", OUTCOMES.BLOCKED, node.reason, { stage }));
  } else if (!node.exercised) {
    out.push(
      check(
        "process.node-ejs-containment",
        OUTCOMES.NOT_EXERCISED,
        "NODE/EJS DESCENDANT NOT EXERCISED BY THIS SOURCE",
        { stage, required: false },
      ),
    );
  } else {
    out.push(
      assertCheck(
        "process.node-ejs-containment",
        node.contained,
        node.contained
          ? "the Node/EJS descendant is inside the owned group and namespace"
          : node.failures.join("; "),
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
