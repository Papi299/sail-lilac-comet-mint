// Verdict algebra (§49).
//
// The whole point of this module is that there is no `SKIPPED -> PASS` edge.
// A check that could not be measured is BLOCKED, and BLOCKED is terminal for
// the run it appears in. Optional site-specific coverage gets its own outcome
// (`NOT_EXERCISED`) which is honest about having proven nothing and is
// therefore never allowed to satisfy a required check.

/** Every outcome a single check can have. */
export const OUTCOMES = Object.freeze({
  /** Measured, and the property holds. */
  PASS: "PASS",
  /** Measured, and the property does NOT hold. */
  FAIL: "FAIL",
  /** Could not be measured. Security-relevant unmeasurability is this, never PASS. */
  BLOCKED: "BLOCKED",
  /** Genuinely not applicable to the chosen live source, and declared optional. */
  NOT_EXERCISED: "NOT_EXERCISED",
});

/**
 * Run-level verdict precedence, worst first.
 *
 * FAIL outranks BLOCKED because a measured violation is a stronger statement
 * than an unmeasurable one, and the operator should see it first. Both stop the
 * run.
 */
const PRECEDENCE = [OUTCOMES.FAIL, OUTCOMES.BLOCKED, OUTCOMES.NOT_EXERCISED, OUTCOMES.PASS];

/**
 * Builds one check result.
 *
 * `required` defaults TRUE. A check must opt OUT of being required, so a new
 * check added without thinking about it is required by default rather than
 * silently optional.
 */
export function check(id, outcome, detail, opts = {}) {
  if (!Object.values(OUTCOMES).includes(outcome)) {
    throw new Error(`unknown outcome ${String(outcome)} for check ${id}`);
  }
  const required = opts.required !== false;
  if (outcome === OUTCOMES.NOT_EXERCISED && required) {
    // A required check has no "not exercised" state. If a source genuinely
    // cannot exercise it, the check is optional by declaration or the run is
    // BLOCKED — it is never quietly satisfied.
    throw new Error(`check ${id} is required and may not report NOT_EXERCISED`);
  }
  return Object.freeze({
    id,
    outcome,
    required,
    detail: typeof detail === "string" ? detail : "",
    stage: opts.stage ?? null,
  });
}

/** PASS when the predicate holds, FAIL when it does not. Never BLOCKED — see `measured`. */
export function assertCheck(id, ok, detail, opts = {}) {
  return check(id, ok ? OUTCOMES.PASS : OUTCOMES.FAIL, detail, opts);
}

/**
 * The measurement-aware constructor, and the one that encodes §49.
 *
 * `observation.measured === false` means the harness could not look. That is
 * BLOCKED for a required check, whatever the operator would prefer, and it
 * cannot be turned into PASS by supplying a truthy fallback — there is no
 * fallback parameter.
 */
export function measuredCheck(id, observation, predicate, detail, opts = {}) {
  if (!observation || observation.measured !== true) {
    const why = observation?.reason ? `: ${observation.reason}` : "";
    return check(id, OUTCOMES.BLOCKED, `${detail} — NOT MEASURABLE${why}`, opts);
  }
  return assertCheck(id, predicate(observation.value) === true, detail, opts);
}

/** Rolls a check list up into a single run verdict. */
export function summarize(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_EXERCISED: 0 };
  for (const entry of list) counts[entry.outcome] += 1;

  // Only REQUIRED checks can produce a non-PASS verdict. An optional check that
  // reports NOT_EXERCISED is recorded and reported, but does not itself fail the
  // run — while an optional check that actually FAILED still does, because a
  // measured violation is never optional.
  const blocking = list.filter(
    (entry) =>
      entry.outcome === OUTCOMES.FAIL ||
      (entry.outcome === OUTCOMES.BLOCKED && entry.required === true),
  );

  let verdict = OUTCOMES.PASS;
  for (const candidate of PRECEDENCE) {
    if (blocking.some((entry) => entry.outcome === candidate)) {
      verdict = candidate;
      break;
    }
  }
  // An empty check list is not a pass. A run that measured nothing proves
  // nothing, and reporting PASS for it is precisely the failure mode §49 bans.
  if (list.length === 0) verdict = OUTCOMES.BLOCKED;

  return Object.freeze({
    verdict,
    counts: Object.freeze(counts),
    blocking: Object.freeze(blocking.map((entry) => entry.id)),
    notExercised: Object.freeze(
      list.filter((e) => e.outcome === OUTCOMES.NOT_EXERCISED).map((e) => e.id),
    ),
  });
}

/**
 * The Stage A -> Stage B authorization edge (§20).
 *
 * Stage B is permitted ONLY by a Stage A run that itself verdicted PASS. There
 * is no override parameter, no `--force`, and no "warn and continue": those are
 * the three shapes this function exists to make unrepresentable.
 */
export function stageBPermitted(stageASummary) {
  return stageASummary?.verdict === OUTCOMES.PASS;
}
