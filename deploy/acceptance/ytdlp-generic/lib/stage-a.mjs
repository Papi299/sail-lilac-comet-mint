// Stage A — "deployed, generic DISABLED" (§12-§20).
//
// Pure over an OBSERVATION BUNDLE. Every entry in the bundle is either
// `{ measured: true, value }` or `{ measured: false, reason }`, so "the harness
// could not look" is representable and lands as BLOCKED rather than being
// coerced into a boolean somewhere upstream.
//
// Stage A exists to answer one question: is it safe to enable generic
// execution? Every check below is a precondition for that, and there is no
// warn-and-continue path (§20).

import { OUTCOMES, check, measuredCheck, summarize } from "./verdict.mjs";

/** The exact reviewed runtime contract (§13). Exact values, never ranges. */
export const EXPECTED_RUNTIME = Object.freeze({
  ytdlpVersion: "2026.08.19",
  bundledEjsVersion: "0.8.0",
  /** Bookworm's system interpreter. The minor may move within 3.11; the major/minor may not. */
  pythonSeries: "3.11",
  /** The reviewed Node family. The Worker image is node:22-bookworm-slim. */
  nodeMajor: "22",
  nodeExpected: "v22.23.2",
});

/** The security units that must be healthy before the Worker may run (§15). */
export const REQUIRED_SERVICES = Object.freeze([
  "videofetch-media-dns",
  "videofetch-media-netns",
  "videofetch-egress-policy",
  "videofetch-egress-watchdog",
  "videofetch-r2-broker",
  "videofetch-worker",
  "vf-cloudflared",
]);

/**
 * Variables that must NOT be in the Worker's environment (§17).
 *
 * Names only. The audit asks whether the NAME is bound, never what it is bound
 * to, so running it cannot itself become a way to read a credential.
 */
export const FORBIDDEN_WORKER_ENVIRONMENT = Object.freeze([
  "YTDLP_NETWORK_ISOLATED",
  "YTDLP_PATH",
  "R2_WRITER_ACCESS_KEY_ID",
  "R2_WRITER_SECRET_ACCESS_KEY",
  "R2_BROKER_PARENT_ACCESS_KEY_ID",
  "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
  "R2_SIGNER_ACCESS_KEY_ID",
  "R2_SIGNER_SECRET_ACCESS_KEY",
]);

/** Variables that must be PRESENT, reported as booleans only (§16). */
export const REQUIRED_WORKER_ENVIRONMENT = Object.freeze([
  "WORKER_CONTROL_KEY_ID",
  "WORKER_CONTROL_SECRET",
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
]);

/** `YTDLP_ENABLED` values that mean "disabled" in Stage A (§5). */
function isDisabledValue(raw) {
  return raw === undefined || raw === null || raw === "false";
}

/**
 * Evaluates every Stage A gate.
 *
 * @param {object} obs observation bundle; see `observers.mjs` for the producer.
 * @returns {{checks: readonly object[], summary: object}}
 */
export function evaluateStageA(obs) {
  const checks = [];
  const stage = "A";
  const add = (entry) => checks.push(entry);

  // ── §14 exact image / source identity ──────────────────────────────────
  //
  // "Which image is running" is the question every other Stage A answer is
  // conditional on: a runtime fact measured against the wrong image proves
  // nothing about the image under review.
  add(
    measuredCheck(
      "image.identity",
      obs.runningImageId,
      (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value),
      "the running container reports a resolvable image id",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "image.matches-authorized-sha",
      obs.imageShaTag,
      (value) =>
        typeof value?.expectedSha === "string" &&
        typeof value?.taggedImageId === "string" &&
        typeof value?.runningImageId === "string" &&
        value.taggedImageId === value.runningImageId,
      "the image tagged with the authorized main SHA is the image actually running",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "image.latest-alias-is-same-object",
      obs.imageLatestAlias,
      // The unit still consumes `videofetch-worker:latest` (§14), so `latest`
      // and the SHA tag must resolve to ONE image object. Two ids here means
      // the unit would start an image nobody reviewed.
      (value) => value?.latestImageId != null && value.latestImageId === value.taggedImageId,
      "videofetch-worker:latest resolves to the same image object as the SHA tag",
      { stage },
    ),
  );

  // ── §15 security-service preconditions ─────────────────────────────────
  for (const service of REQUIRED_SERVICES) {
    add(
      measuredCheck(
        `service.${service}`,
        obs.services?.[service],
        (value) => value?.activeState === "active",
        `${service} is active`,
        { stage },
      ),
    );
  }
  add(
    measuredCheck(
      "safe-egress.verifier",
      obs.egressVerifier,
      // The read-only verifier's own exit status. The harness NEVER repairs on
      // failure (§50) — it reports and stops.
      (value) => value?.exitCode === 0,
      "vf-egress-policy-verify reports the live boundary intact",
      { stage },
    ),
  );

  // ── §32 network placement ──────────────────────────────────────────────
  add(
    measuredCheck(
      "worker.network-mode",
      obs.workerNetworkMode,
      (value) => value === "container:videofetch-media-netns",
      "the Worker container runs in the media network namespace",
      { stage },
    ),
  );

  // ── §13 exact runtime identity ─────────────────────────────────────────
  add(
    measuredCheck(
      "runtime.ytdlp-version",
      obs.ytdlpVersion,
      // Exact string equality. A date-shaped "looks newer" value is a
      // DIFFERENT reviewed artifact and fails here on purpose.
      (value) => value === EXPECTED_RUNTIME.ytdlpVersion,
      `yt-dlp is exactly ${EXPECTED_RUNTIME.ytdlpVersion}`,
      { stage },
    ),
  );
  add(
    measuredCheck(
      "runtime.python-series",
      obs.pythonVersion,
      (value) => typeof value === "string" && value.startsWith(EXPECTED_RUNTIME.pythonSeries),
      `the interpreter is a ${EXPECTED_RUNTIME.pythonSeries} series build`,
      { stage },
    ),
  );
  add(
    measuredCheck(
      "runtime.node-family",
      obs.nodeVersion,
      (value) => typeof value === "string" && value.startsWith(`v${EXPECTED_RUNTIME.nodeMajor}.`),
      `Node is the reviewed v${EXPECTED_RUNTIME.nodeMajor} family`,
      { stage },
    ),
  );
  add(
    measuredCheck(
      "runtime.bundled-ejs",
      obs.bundledEjsVersion,
      (value) => value === EXPECTED_RUNTIME.bundledEjsVersion,
      `the bundled EJS artifact is exactly ${EXPECTED_RUNTIME.bundledEjsVersion}`,
      { stage },
    ),
  );

  // ── §12 generic DISABLED, and truthfully reported ──────────────────────
  //
  // Read from the structured diagnostics contract, never by grepping a
  // human-facing page: the API representation exists and is the reviewed one.
  add(
    measuredCheck(
      "capability.implemented",
      obs.capabilities,
      (value) => value?.ytdlpInstalled === true,
      "the pinned runtime answers its version probe (binaries.ytdlp)",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "config.ytdlp-disabled",
      obs.ytdlpEnabledRaw,
      (value) => isDisabledValue(value),
      "YTDLP_ENABLED is absent or exactly 'false' in the deployed configuration",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "capability.generic-not-usable",
      obs.capabilities,
      (value) => value?.ytdlp === false && value?.ytdlpEnabled === false,
      "/api/sites reports ytdlp:false while generic execution is disabled",
      { stage },
    ),
  );

  // ── §17 forbidden environment audit (names only) ───────────────────────
  add(
    measuredCheck(
      "worker-env.forbidden-absent",
      obs.workerEnvironmentNames,
      (names) =>
        Array.isArray(names) &&
        FORBIDDEN_WORKER_ENVIRONMENT.every((name) => !names.includes(name)),
      "no retired or persistent-credential variable is bound in the Worker",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "worker-env.required-present",
      obs.workerEnvironmentNames,
      (names) =>
        Array.isArray(names) && REQUIRED_WORKER_ENVIRONMENT.every((name) => names.includes(name)),
      "the Worker's own required configuration is present (names only)",
      { stage },
    ),
  );

  // ── §18 direct-media regression ────────────────────────────────────────
  //
  // The last gate before enablement is permitted, and the one that proves the
  // deployment did not break what already worked.
  add(
    measuredCheck(
      "direct.regression-ready",
      obs.directRegression,
      (value) => value?.status === "ready" && value?.extractor === "direct",
      "a direct-media job reached ready through the real control plane",
      { stage },
    ),
  );
  add(
    measuredCheck(
      "direct.byte-integrity",
      obs.directRegression,
      (value) =>
        typeof value?.expectedDigest === "string" &&
        value.expectedDigest.length === 64 &&
        value.expectedDigest === value.deliveredDigest &&
        value.expectedBytes === value.deliveredBytes,
      "the bytes delivered through the signed GET match the source fixture exactly",
      { stage },
    ),
  );

  const summary = summarize(checks);
  return Object.freeze({ stage, checks: Object.freeze(checks), summary });
}

/**
 * §20 — the enablement authorization.
 *
 * Separate from the summary on purpose: the operator asks this question
 * explicitly, and the answer carries the reason it is negative.
 */
export function enablementAuthorized(stageAResult) {
  const ok = stageAResult?.summary?.verdict === OUTCOMES.PASS;
  return Object.freeze({
    authorized: ok,
    reason: ok
      ? "every Stage A precondition passed"
      : `STOP BEFORE GENERIC ENABLEMENT — ${stageAResult?.summary?.verdict ?? "NO RESULT"}: ${(
          stageAResult?.summary?.blocking ?? []
        ).join(", ")}`,
  });
}

/** Convenience for the CLI: a Stage A run that never got to measure anything. */
export function stageANotAttempted(reason) {
  const checks = [check("stage-a.attempted", OUTCOMES.BLOCKED, reason, { stage: "A" })];
  return Object.freeze({ stage: "A", checks: Object.freeze(checks), summary: summarize(checks) });
}

/** Exported for the CLI's stage-confusion guard (§11). */
export function rejectsStageBConfiguration(obs) {
  // Running Stage A assertions against an ENABLED deployment is a category
  // error: `config.ytdlp-disabled` would fail and be read as a deployment
  // defect rather than as the operator having selected the wrong stage.
  const raw = obs?.ytdlpEnabledRaw;
  if (raw?.measured !== true) return false;
  return raw.value === "true";
}
