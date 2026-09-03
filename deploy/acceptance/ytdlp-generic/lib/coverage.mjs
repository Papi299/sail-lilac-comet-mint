// The check -> producer registry (§8 and §36 of CORRECTION-01; §8 of CORRECTION-02).
//
// The standing answer to "who actually goes and looks?", walked by
// `scripts/ytdlp-acceptance.test.mjs` against the live evaluators so a check
// with no concrete producer fails the suite.
//
// ── Why this file no longer holds free-form strings ────────────────────────
//
// It used to. `producer: "cases byte-limit producer (operator fixture)"` counted
// as concrete because it was a non-empty string — while no such producer
// existed. A description is not an implementation, so case-backed checks now
// resolve THROUGH `CASE_PRODUCERS`, and a name with no callable `run` cannot be
// claimed as concrete no matter what is written here.

import { CASE_PRODUCERS, hasExecutableProducer } from "./cases.mjs";

/** Producer kinds. `test-seam` exists ONLY so the test can assert nothing uses it. */
export const PRODUCER_KINDS = Object.freeze(["system", "control-plane", "case", "test-seam"]);

const entry = (kind, producer, command) => Object.freeze({ kind, producer, command });

const SYSTEM = (fn, command = "--stage A") =>
  entry("system", `observers.makeSystemObservers().${fn}`, command);
const CONTROL = (fn, command = "--stage A") =>
  entry("control-plane", `control-plane.makeControlPlaneSession().${fn}`, command);

/**
 * A case-backed check.
 *
 * Resolves through the real registry: the `producer` string is derived from the
 * registry entry, and `executable` reflects whether a callable `run` exists.
 */
function CASE(name, detail) {
  const registered = CASE_PRODUCERS[name];
  return Object.freeze({
    kind: "case",
    case: name,
    producer: registered ? `cases.CASE_PRODUCERS['${name}'].run — ${detail}` : `MISSING PRODUCER: ${name}`,
    command: `--stage B --case ${name}`,
    executable: hasExecutableProducer(name),
    optional: registered?.live === false,
  });
}

/** Every check id either evaluator can emit, and how Phase 10D obtains it. */
export const CHECK_PRODUCERS = Object.freeze({
  // ── Stage A ────────────────────────────────────────────────────────────
  "image.identity": SYSTEM("runningImageId"),
  "image.matches-authorized-sha": SYSTEM("imageShaTag"),
  "image.latest-alias-is-same-object": SYSTEM("imageLatestAlias"),
  "safe-egress.verifier": SYSTEM("egressVerifier"),
  "worker.network-mode": SYSTEM("networkMode"),
  "runtime.ytdlp-version": CONTROL("diagnostics"),
  "runtime.python-series": SYSTEM("pythonVersion"),
  "runtime.node-family": SYSTEM("nodeVersion"),
  "runtime.bundled-ejs": SYSTEM("bundledEjsVersion"),
  "capability.implemented": CONTROL("sites"),
  "capability.generic-not-usable": CONTROL("sites"),
  "config.ytdlp-disabled": SYSTEM("ytdlpEnabledRaw"),
  "worker-env.forbidden-absent": SYSTEM("environmentNames"),
  "worker-env.required-present": SYSTEM("environmentNames"),
  "direct.regression-ready": entry(
    "control-plane",
    "acceptance.runDirectRegression (analyze -> job -> poll -> signed GET -> digest)",
    "--stage A",
  ),
  "direct.byte-integrity": entry(
    "control-plane",
    "acceptance.runDirectRegression (fixture digest vs delivered digest)",
    "--stage A",
  ),
  "stage-a.attempted": SYSTEM("<not-attempted sentinel>"),

  // ── Stage B ────────────────────────────────────────────────────────────
  "stage-b.authorized-by-stage-a": entry(
    "case",
    "acceptance.loadStageA + provenance.verifyRecord + stage-b.stageBAuthorization",
    "--stage B --aggregate",
  ),
  // §3-§6 of CORRECTION-04: the enabled-phase facts come from the `success`
  // case's OWN sealed record, measured while generic was actually enabled —
  // not from the deployment as it stands at aggregation time.
  "capability.generic-usable": CASE("success", "the feature state sealed with the case record"),
  "config.ytdlp-enabled": CASE("success", "the feature state sealed with the case record"),
  "killswitch.disabled-state-proven": CASE(
    "kill-switch",
    "the feature state sealed with the case record",
  ),
  "deployment.final-state-recorded": SYSTEM("ytdlpEnabledRaw", "--stage B --aggregate"),

  "analysis.generic-selected": CASE("success", "the generic source's analysis result"),
  "analysis.direct-still-selected": CASE("success", "a direct control source's analysis result"),
  "analysis.no-raw-formats": CASE("success", "the generic metadata's format list"),
  "analysis.presets-application-owned": CASE("success", "the advertised preset objects"),
  "analysis.no-generic-thumbnail": CASE("success", "the generic metadata's thumbnail field"),

  "job.lifecycle-complete": CASE("success", "control-plane.pollTrace, seeded from the create response"),
  "job.requested-preset-owned": CASE("success", "the preset the job was created with"),

  "durable.extractor-is-ytdlp": CASE("success", "observers.durableJobRow"),
  "durable.application-format-id": CASE("success", "observers.durableJobRow"),
  "durable.no-raw-selector-fields": CASE("success", "observers.durableJobRow"),

  "process.window-observed": CASE("success", "download-window collector, scoped to durable downloading"),
  "delivery.matches-advertised-preset": CASE("success", "the delivered container vs the accepted preset"),
  "process.sample-shape": CASE("success", "process-tree.validateSampleShape over every window sample"),
  "process.ytdlp-identified": CASE("success", "process-sampler.establishYtdlpPid + evaluateYtdlpIdentity"),
  "process.no-ffmpeg-during-downloading": CASE("success", "aggregateDownloadWindow over every window sample"),
  "process.no-unknown-descendants": CASE("success", "aggregateDownloadWindow over every window sample"),
  "process.namespace-identity": CASE("success", "per-PID readlink /proc/<pid>/ns/net"),
  "process.node-ejs-containment": CASE("success", "per-sample containment anchored to the owned PID"),

  "safe-egress.generic-path-established": CASE("safe-egress", "the fixture's own analysis result"),
  "safe-egress.forbidden-destination-denied": CASE("safe-egress", "egress-policy.readDenyCounter before/after (Phase-9 rule comments)"),
  "safe-egress.policy-unchanged": CASE("safe-egress", "egress-policy.fingerprintChain over the nft chain JSON"),

  "r2.delegated-write": CASE("success", "the authenticated Worker job view's objectKey"),
  "r2.worker-holds-no-credential": SYSTEM("environmentNames", "--stage B --aggregate"),

  "vercel.signed-get": CASE("success", "control-plane.signedDownload"),
  "vercel.byte-integrity": CASE("success", "control-plane.fetchDigest + durable/provider lengths"),

  "privacy.sentinel-not-leaked": CASE("success", "evidence.sweepForSentinel over six measured surfaces"),

  "cancel.durable-cancelled": CASE("cancellation", "cases.runCancellationCase"),
  "cancel.no-late-ready": CASE("cancellation", "cases.runCancellationCase"),
  "cancel.processes-gone": CASE("cancellation", "observers.processGroupMembers over the captured pgid"),
  "cancel.no-upload-no-workdir": CASE("cancellation", "observers.workDirPresent"),

  "limit.actual-byte-guard": CASE("byte-limit", "the fixture's own actual-media-GET transfer evidence"),
  "shutdown.group-terminated": CASE("shutdown", "observers.processGroupMembers over the captured pgid"),
  "shutdown.job-recovered": CASE("shutdown", "observers.containerPid + the durable job view"),

  "direct.process-sampling-available": CASE("direct-regression", "cases.runDirectRegressionCase"),
  "direct.after-enable": CASE("direct-regression", "cases.runDirectRegressionCase"),
  "direct.no-ytdlp-spawned": CASE("direct-regression", "cases.runDirectRegressionCase"),

  "runtime.fail-closed": CASE("fail-closed-runtime", "separately executed disposable-container negative test"),
  "killswitch.rollback": CASE("kill-switch", "cases.runKillSwitchCase"),
  "catalog.unchanged": CASE("kill-switch", "cases.runKillSwitchCase"),
});

/** Service checks are derived from the required-service list. */
export function producerFor(checkId) {
  if (checkId.startsWith("service.")) return SYSTEM("serviceState");
  return CHECK_PRODUCERS[checkId] ?? null;
}

/**
 * True when the check has a concrete, executable producer.
 *
 * A case-backed check is concrete only if its case actually resolves to a
 * callable producer — the registry, not the description, decides.
 */
export function hasConcreteProducer(checkId) {
  const found = producerFor(checkId);
  if (found == null || found.kind === "test-seam") return false;
  if (found.kind === "case" && found.case !== undefined) return found.executable === true;
  return true;
}

/** Checks whose producer is declared non-live, and which must therefore be optional. */
export function nonLiveCheckIds() {
  return Object.entries(CHECK_PRODUCERS)
    .filter(([, found]) => found.kind === "case" && found.case !== undefined && found.optional === true)
    .map(([id]) => id);
}
