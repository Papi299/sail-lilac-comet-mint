// Stage B — "generic explicitly ENABLED" (§21-§43).
//
// Pure over an observation bundle, exactly like Stage A. Stage B may only be
// evaluated after a Stage A run verdicted PASS (§20); `evaluateStageB` refuses
// to grade anything otherwise, so the authorization edge cannot be skipped by
// invoking this module directly.

import {
  OUTCOMES,
  assertCheck,
  check,
  measuredCheck,
  stageBPermitted,
  summarize,
} from "./verdict.mjs";
import {
  classifyAcquisitionTree,
  evaluateNamespaceIdentity,
  evaluateNodeContainment,
  evaluateTerminationCleanliness,
  validateSampleShape,
} from "./process-tree.mjs";

/** The durable transitions a successful generic job must pass through (§26). */
export const REQUIRED_TRANSITIONS = Object.freeze([
  "queued",
  "analyzing",
  "downloading",
  "processing",
  "uploading",
  "ready",
]);

/** The application-owned preset vocabulary. A raw yt-dlp format id is never one of these. */
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

/**
 * Durable fields that must NOT exist on a generic job (§27).
 *
 * A raw upstream selector or source id in SQLite would mean the memory-only
 * contract had been broken and a site's own identifier had become trusted
 * durable state.
 */
export const FORBIDDEN_DURABLE_FIELDS = Object.freeze([
  "format_id",
  "formatId",
  "source_format_id",
  "sourceFormatId",
  "selector",
  "format_selector",
  "ytdlp_format",
  "source_url",
  "sourceUrl",
]);

/**
 * The observed transition list contains the required ones, in order.
 *
 * Subsequence, not equality: polling legitimately misses a fast transition, and
 * the direct-media record in the runbook shows a whole job completing in ~1.2s.
 * ORDER is the invariant; observing every intermediate state is not.
 */
export function transitionsAreOrdered(observed, required = REQUIRED_TRANSITIONS) {
  if (!Array.isArray(observed)) return false;
  // Every observed state must be a known one, and the observed sequence must
  // never move backwards through the required ladder.
  let cursor = -1;
  for (const state of observed) {
    const index = required.indexOf(state);
    if (index === -1) return false;
    if (index < cursor) return false;
    cursor = index;
  }
  return observed.includes("ready");
}

export function evaluateStageB(obs, stageAResult) {
  // ── §11/§20 the authorization edge ─────────────────────────────────────
  if (!stageBPermitted(stageAResult?.summary)) {
    const blocked = [
      check(
        "stage-b.authorized-by-stage-a",
        OUTCOMES.BLOCKED,
        "Stage B assertions require a Stage A run that verdicted PASS; refusing to grade",
        { stage: "B" },
      ),
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
      // v1 exposes `formats: []` for generic sources. A non-empty array here
      // would mean a raw upstream format id had reached the browser contract.
      (value) => Array.isArray(value?.formats) && value.formats.length === 0,
      "generic metadata exposes no raw format list",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "analysis.presets-application-owned",
      obs.genericAnalysis,
      (value) =>
        Array.isArray(value?.presets) &&
        value.presets.length > 0 &&
        value.presets.every((preset) => APPLICATION_PRESETS.includes(preset)),
      "every advertised option is an application-owned preset",
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

  // ── §26 durable job lifecycle ──────────────────────────────────────────
  add(
    measuredCheck(
      "job.transitions-ordered",
      obs.genericJob,
      (value) => transitionsAreOrdered(value?.transitions),
      `durable states advanced in order and reached ready`,
      { stage },
    ),
  );
  add(
    measuredCheck(
      "job.requested-preset-owned",
      obs.genericJob,
      (value) => APPLICATION_PRESETS.includes(value?.requestedFormatId),
      "the job was created with an application-owned preset",
      { stage },
    ),
  );

  // ── §27 strategy persistence ───────────────────────────────────────────
  add(
    measuredCheck(
      "durable.extractor-is-ytdlp",
      obs.durableJobRow,
      (value) => value?.extractor === "yt-dlp",
      "durable evidence records extractor=yt-dlp after analysis",
      { stage },
    ),
  );
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
  // §28: the raw upstream id is never reported. The harness states only that
  // the constraints held, in sanitized structural form.
  add(
    measuredCheck(
      "selector.constraints-satisfied",
      obs.selectorConstraints,
      (value) => value?.satisfied === true,
      "safe selector constraints satisfied (structural; no raw upstream id reported)",
      { stage },
    ),
  );

  // ── §29/§30 process descendants during downloading ─────────────────────
  const treeChecks = evaluateProcessEvidence(obs, stage);
  for (const entry of treeChecks) add(entry);

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
      "vercel.byte-digest",
      obs.vercelDelivery,
      // HTTP 200 alone is explicitly NOT proof (§37). Length AND digest.
      (value) =>
        typeof value?.workerDigest === "string" &&
        value.workerDigest.length === 64 &&
        value.workerDigest === value.clientDigest &&
        value.workerBytes === value.clientBytes &&
        value.clientBytes > 0,
      "delivered bytes match the Worker-produced object by length and SHA-256",
      { stage },
    ),
  );

  // ── §46 sentinel leakage ───────────────────────────────────────────────
  add(
    measuredCheck(
      "privacy.sentinel-not-leaked",
      obs.sentinelSweep,
      (value) => value?.leaked === false && Array.isArray(value?.surfacesChecked) &&
        value.surfacesChecked.length >= 5,
      "the ephemeral sentinel appears in none of the swept surfaces",
      { stage },
    ),
  );

  // ── §39 cancellation ───────────────────────────────────────────────────
  add(
    measuredCheck(
      "cancel.durable-cancelled",
      obs.cancellation,
      (value) => value?.finalStatus === "cancelled" && value?.lateReady === false,
      "cancelling during downloading yields a durable cancelled job and no late ready",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "cancel.processes-gone",
      obs.cancellation,
      (value) =>
        value?.postSample != null &&
        evaluateTerminationCleanliness(value.postSample, value.workerPid).clean === true,
      "no yt-dlp or Node descendant survives cancellation",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "cancel.no-upload-no-workdir",
      obs.cancellation,
      (value) =>
        value?.beganProcessing === false &&
        value?.uploaded === false &&
        value?.workDirPresent === false,
      "cancellation performed no processing, no upload, and left no working directory",
      { stage },
    ),
  );

  // ── §38 actual-byte limit ──────────────────────────────────────────────
  //
  // Required, and deliberately BLOCKED rather than skipped when no safe live
  // fixture exists at run time. `--max-filesize` is not evidence for this.
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

  // ── §42 fail-closed runtime ────────────────────────────────────────────
  //
  // Optional at the RUN level because it must not be performed by damaging the
  // live image (§42). Executed separately, its result is folded in here.
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
 * The process-tree checks, split out because they share one sample and one
 * shape validation.
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
      "the process sample carries no command line or URL-bearing field",
      { stage },
    ),
  );
  if (!shape.ok) return out;

  const classified = classifyAcquisitionTree(sample, workerPid);

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
  out.push(
    assertCheck(
      "process.ytdlp-present",
      classified.ytdlpProcesses.length > 0,
      "the owned yt-dlp process was observed during downloading",
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

  // §31 Node/EJS containment — measured, and honestly NOT_EXERCISED when the
  // chosen source never invoked the JS runtime.
  const node = evaluateNodeContainment(classified, ytdlpPid, expectedNetns);
  out.push(
    node.exercised
      ? assertCheck(
          "process.node-ejs-containment",
          node.contained,
          node.contained
            ? "the Node/EJS descendant is inside the owned group and namespace"
            : node.failures.join("; "),
          { stage },
        )
      : check(
          "process.node-ejs-containment",
          OUTCOMES.NOT_EXERCISED,
          "NODE/EJS DESCENDANT NOT EXERCISED BY THIS SOURCE",
          { stage, required: false },
        ),
  );

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
