// The machine-readable, sanitized acceptance record (§44) and the ephemeral
// sentinel (§46).
//
// Pure. The CLI decides where to write the record; this module decides what may
// be in it.

import { randomBytes } from "node:crypto";
import { redactDeep, redactUrl, safeOutput } from "./redact.mjs";

/**
 * Fields that must never appear in the evidence record, at any nesting depth.
 *
 * The record is assembled from an allowlist (`buildEvidence` names every field
 * it emits), so this list is a SECOND gate rather than the mechanism — it
 * catches a future field added to an observation object that gets spread
 * somewhere it should not have been.
 */
export const FORBIDDEN_EVIDENCE_KEYS = Object.freeze([
  "secret",
  "password",
  "token",
  "credential",
  "credentials",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "cookie",
  "authorization",
  "workerControlSecret",
  "sentinel",
  "cmdline",
  "argv",
  "stderr",
  "rawStderr",
]);

/**
 * Mints the per-run sentinel (§46).
 *
 * It is a random marker, NEVER a real credential: the whole point is to place
 * something traceable into a submitted URL and prove it does not resurface. A
 * real secret would make a positive result a disclosure.
 *
 * The value is returned once, to the caller, and the caller must never print
 * it — `assertNoSentinel` below checks surfaces WITHOUT emitting the needle.
 */
export function mintSentinel() {
  return `VF_ACCEPT_SECRET_${randomBytes(16).toString("hex")}`;
}

/**
 * Appends the sentinel to a submitted URL as an inert query parameter.
 *
 * Chosen because a query parameter is the surface that travels furthest through
 * this system — control plane, Worker, durable state, subprocess argv, logs —
 * while being the least likely to alter media selection. It is the caller's
 * responsibility (documented in README) to pick a source where an unknown
 * parameter is ignored.
 */
export function withSentinel(url, sentinel) {
  const parsed = new URL(url);
  parsed.searchParams.set("vf_accept", sentinel);
  return parsed.toString();
}

/**
 * Mints the per-case correlation identity (§10 of CORRECTION-04).
 *
 * 128 bits of randomness, and deliberately NOT a secret: it is test correlation
 * data whose whole purpose is to travel to the controlled fixture and come back
 * in the fixture's evidence, so it may appear in the sanitized acceptance
 * record. It is not a credential, grants nothing, and authenticates nothing —
 * it exists so that "a media request was observed" becomes "THIS case's media
 * request was observed".
 *
 * Distinct from the sentinel, which is the opposite kind of value: the sentinel
 * must never resurface anywhere, and finding it is a failure.
 */
export function mintCaseId() {
  return randomBytes(16).toString("hex");
}

/** A minted case id, for validating what the fixture echoes back. */
export const CASE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Binds a submitted fixture URL to one case run.
 *
 * The fixture associates the media request it serves with this id, and returns
 * evidence only for it — so a static endpoint answering
 * `{"actualMediaRequestObserved": true}`, or a stale answer left over from an
 * earlier case, cannot satisfy the assertion.
 */
export function withCaseId(url, caseId) {
  const parsed = new URL(url);
  parsed.searchParams.set("vf_case", caseId);
  return parsed.toString();
}

/**
 * Sweeps captured surfaces for the sentinel.
 *
 * Returns the VERDICT and the surface names, never the sentinel and never the
 * matching text. A leak is reported as "surface X contained the sentinel",
 * which is enough to act on and discloses nothing further.
 */
export function sweepForSentinel(surfaces, sentinel) {
  const entries = Object.entries(surfaces ?? {});
  const leakedSurfaces = [];
  for (const [name, content] of entries) {
    const text = typeof content === "string" ? content : JSON.stringify(content ?? null);
    if (typeof sentinel === "string" && sentinel.length > 0 && text.includes(sentinel)) {
      leakedSurfaces.push(name);
    }
  }
  return Object.freeze({
    measured: true,
    value: Object.freeze({
      leaked: leakedSurfaces.length > 0,
      leakedSurfaces: Object.freeze(leakedSurfaces),
      surfacesChecked: Object.freeze(entries.map(([name]) => name)),
    }),
  });
}

/** Recursively strips forbidden keys. The second gate described above. */
export function stripForbiddenKeys(value, depth = 0) {
  if (depth > 8) return "<max-depth>";
  if (Array.isArray(value)) return value.map((entry) => stripForbiddenKeys(entry, depth + 1));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_EVIDENCE_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) {
        out[key] = "<withheld>";
        continue;
      }
      out[key] = stripForbiddenKeys(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Assembles the record.
 *
 * Every field is named explicitly. There is no `...obs` anywhere in this
 * function, which is what makes the record an allowlist rather than a filtered
 * dump of whatever the observers happened to collect.
 */
export function buildEvidence(input) {
  const {
    task,
    stage,
    mode,
    schemaVersion,
    runId,
    startedAt,
    finishedAt,
    expectedSha,
    binding,
    acceptedCases,
    runningImageId,
    imageTags,
    runtime,
    services,
    egressVerifier,
    capabilities,
    stateSequence,
    workerEnvironment,
    job,
    processEvidence,
    negativeCases,
    delivery,
    checks,
    summary,
    acceptanceUrl,
    sentinelSweep,
  } = input;

  const record = {
    task: task ?? "PHASE-10D-YTDLP-PRODUCTION-STAGED-DEPLOYMENT-AND-LIVE-ACCEPTANCE-001",
    harness: "deploy/acceptance/ytdlp-generic/acceptance.mjs",
    schemaVersion: schemaVersion ?? null,
    // The non-secret run identifier. The run KEY never appears here.
    runId: runId ?? null,
    // Hoisted alongside `source` because the authenticator covers them at the
    // top level; `binding` keeps the human-readable grouping.
    expectedSha: expectedSha ?? null,
    runningImageId: binding?.runningImageId ?? runningImageId ?? null,
    taggedImageId: binding?.taggedImageId ?? null,
    stage: stage ?? null,
    mode: mode ?? "dry-run",
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,

    source: {
      expectedSha: expectedSha ?? null,
      runningImageId: runningImageId ?? null,
      imageTags: imageTags ?? null,
    },

    // The DEPLOYMENT BINDING (§29/§30 of CORRECTION-01). A Stage A PASS
    // authorizes Stage B only for the source SHA and image object it actually
    // passed against, so the identity travels inside the record itself.
    binding: binding ?? null,

    /** Which Stage B case records the aggregation accepted. */
    acceptedCases: acceptedCases ?? null,

    runtime: runtime ?? null,

    // Booleans only. A service state is not a secret, but the shape is kept
    // narrow so a future observer cannot smuggle unit contents in here.
    services: services ?? null,
    safeEgressVerifier: egressVerifier ?? null,

    capabilities: capabilities ?? null,

    // The multi-state acceptance sequence (§3-§7 of CORRECTION-04).
    //
    // `enabledPhase` and `disabledPhase` are the feature states the harness
    // MEASURED when those cases ran, carried out of their own sealed records.
    // `finalState` is the deployment state at aggregation time, RECORDED for
    // the reviewer and deliberately not used to grade either phase.
    stateSequence: stateSequence ?? null,

    // §16/§17: names and booleans. No values, no lengths, no hashes.
    workerEnvironment: workerEnvironment ?? null,

    job: job ?? null,
    process: processEvidence ?? null,
    negativeCases: negativeCases ?? null,
    delivery: delivery ?? null,

    // §23/§45: the acceptance URL is recorded with its query removed.
    acceptanceUrl: acceptanceUrl ? redactUrl(acceptanceUrl) : null,
    // Named `sentinelSweep`, NOT `sentinel`: `sentinel` is on the forbidden-key
    // list, so calling this field that would withhold the sweep RESULT — the
    // one thing §46 requires the record to state — while the value it protects
    // against was never in here anyway.
    sentinelSweep: {
      // The sentinel VALUE is never recorded; only whether the sweep found it.
      used: sentinelSweep != null,
      leaked: sentinelSweep?.leaked ?? null,
      leakedSurfaces: sentinelSweep?.leakedSurfaces ?? null,
      surfacesChecked: sentinelSweep?.surfacesChecked ?? null,
    },

    checks: (checks ?? []).map((entry) => ({
      id: entry.id,
      outcome: entry.outcome,
      required: entry.required,
      detail: entry.detail,
    })),

    verdict: summary?.verdict ?? "BLOCKED",
    counts: summary?.counts ?? null,
    blocking: summary?.blocking ?? [],
    notExercised: summary?.notExercised ?? [],
  };

  // Redact URLs everywhere, then strip forbidden keys. Both run over the whole
  // record, so a nested observer value cannot bypass either.
  return stripForbiddenKeys(redactDeep(record));
}

/**
 * Renders the record for writing, with the sentinel scrubbed as a backstop.
 *
 * `needles` should include the run's sentinel. If it ever matches, the file is
 * still clean — and the caller learns from `sweepForSentinel` that a leak
 * happened, which is the finding.
 */
export function renderEvidence(record, needles) {
  return safeOutput(`${JSON.stringify(record, null, 2)}\n`, needles);
}
