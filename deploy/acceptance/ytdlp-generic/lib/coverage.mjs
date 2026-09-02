// The check -> producer registry (§8 and §36 of CORRECTION-01).
//
// The original harness could prove anything once a test injected a perfect
// observation, but a Phase-10D operator had no committed way to OBTAIN most of
// those observations. This registry is the standing answer to "who actually
// goes and looks?", and `scripts/ytdlp-acceptance.test.mjs` walks it against the
// live evaluators so the same incompleteness cannot come back when a check is
// added: a new check with no entry here fails the suite.
//
// `producer` names the concrete module/function that measures the property.
// `command` names the reviewed CLI invocation an operator actually types.
// Neither may be a test seam — that is the whole point.

/** Producer kinds. `test-seam` exists ONLY so the test can assert nothing uses it. */
export const PRODUCER_KINDS = Object.freeze(["system", "control-plane", "case", "test-seam"]);

const entry = (kind, producer, command) => Object.freeze({ kind, producer, command });

const SYSTEM = (fn, command = "--stage A") => entry("system", `observers.makeSystemObservers().${fn}`, command);
const CONTROL = (fn, command = "--stage A") => entry("control-plane", `control-plane.makeControlPlaneSession().${fn}`, command);
const CASE = (name, producer) => entry("case", producer, `--stage B --case ${name}`);

/**
 * Every check id either evaluator can emit, and how Phase 10D obtains it.
 *
 * Service checks are generated rather than listed, so adding a required unit to
 * `REQUIRED_SERVICES` cannot silently create an uncovered check.
 */
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
    "stage-b.stageBAuthorization over the loaded Stage A record",
    "--stage B --aggregate",
  ),
  "capability.generic-usable": CONTROL("sites", "--stage B --aggregate"),
  "config.ytdlp-enabled": SYSTEM("ytdlpEnabledRaw", "--stage B --aggregate"),

  "analysis.routed-to-generic": CASE("success", "cases.runSuccessCase"),
  "analysis.no-raw-formats": CASE("success", "cases.runSuccessCase"),
  "analysis.presets-application-owned": CASE("success", "cases.runSuccessCase"),
  "analysis.no-generic-thumbnail": CASE("success", "cases.runSuccessCase"),

  "job.lifecycle-complete": CASE("success", "cases.runSuccessCase -> control-plane.pollTrace"),
  "job.requested-preset-owned": CASE("success", "cases.runSuccessCase"),

  "durable.extractor-is-ytdlp": CASE("success", "observers.durableJobRow"),
  "durable.application-format-id": CASE("success", "observers.durableJobRow"),
  "durable.no-raw-selector-fields": CASE("success", "observers.durableJobRow"),
  "selector.constraints-satisfied": CASE("success", "cases.runSuccessCase"),

  "process.sample-available": CASE("success", "process-sampler.makeProcessSampler().sampleWhile"),
  "process.sample-shape": CASE("success", "process-sampler.makeProcessSampler().sampleWhile"),
  "process.ytdlp-identified": CASE("success", "process-sampler.establishYtdlpPid"),
  "process.no-ffmpeg-during-downloading": CASE("success", "process-sampler.makeProcessSampler().sampleWhile"),
  "process.no-unknown-descendants": CASE("success", "process-sampler.makeProcessSampler().sampleWhile"),
  "process.namespace-identity": CASE("success", "process-sampler netnsOf() per pid"),
  "process.node-ejs-containment": CASE("success", "process-sampler.makeProcessSampler().sampleWhile"),

  "safe-egress.forbidden-destination-denied": CASE("safe-egress", "deploy/acceptance/safe-egress composition"),
  "safe-egress.policy-unchanged": CASE("safe-egress", "observers.egressVerifier fingerprint comparison"),

  "r2.delegated-write": CASE("success", "cases.runSuccessCase -> r2Evidence"),
  "r2.worker-holds-no-credential": SYSTEM("environmentNames", "--stage B --aggregate"),

  "vercel.signed-get": CASE("success", "control-plane.signedDownload"),
  "vercel.byte-integrity": CASE("success", "control-plane.fetchDigest"),

  "privacy.sentinel-not-leaked": CASE("success", "evidence.sweepForSentinel over observer log capture"),

  "cancel.durable-cancelled": CASE("cancellation", "cases.runCancellationCase"),
  "cancel.no-late-ready": CASE("cancellation", "cases.runCancellationCase"),
  "cancel.processes-gone": CASE("cancellation", "cases.runCancellationCase -> sampler.sample"),
  "cancel.no-upload-no-workdir": CASE("cancellation", "cases.runCancellationCase"),

  "limit.actual-byte-guard": CASE("byte-limit", "cases byte-limit producer (operator fixture)"),
  "shutdown.group-terminated": CASE("shutdown", "cases shutdown producer (operator transition)"),

  "direct.after-enable": CASE("direct-regression", "cases.runDirectRegressionCase"),
  "direct.no-ytdlp-spawned": CASE("direct-regression", "cases.runDirectRegressionCase"),

  "runtime.fail-closed": CASE("fail-closed-runtime", "disposable-container negative test producer"),
  "killswitch.rollback": CASE("kill-switch", "cases.runKillSwitchCase"),
  "catalog.unchanged": CASE("kill-switch", "cases.runKillSwitchCase"),
});

/** Service checks are derived from the required-service list. */
export function producerFor(checkId) {
  if (checkId.startsWith("service.")) {
    return SYSTEM("serviceState");
  }
  return CHECK_PRODUCERS[checkId] ?? null;
}

/** True when the check has a concrete, non-test producer. */
export function hasConcreteProducer(checkId) {
  const found = producerFor(checkId);
  return found != null && found.kind !== "test-seam";
}
