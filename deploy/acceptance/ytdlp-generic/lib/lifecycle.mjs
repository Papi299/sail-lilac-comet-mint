// Durable lifecycle evidence (§14-§17 of CORRECTION-01).
//
// The corrected contract: a normal generic success must show ALL SIX durable
// states, in order. The previous `transitionsAreOrdered` accepted `["ready"]`,
// which made "the poll only ever saw the final state" indistinguishable from
// "the job genuinely passed through the ladder" — and the whole point of this
// evidence is to show the ladder.
//
// Three outcomes, deliberately distinct:
//
//   measured, out of order          -> FAIL     (a real ordering violation)
//   measured, incomplete            -> BLOCKED  (an evidence gap, not proof)
//   measured, complete and ordered  -> PASS
//
// Missed polling is an evidence gap. It is never reinterpreted as proof.

/** The closed durable status vocabulary a successful generic job passes through. */
export const REQUIRED_TRANSITIONS = Object.freeze([
  "queued",
  "analyzing",
  "downloading",
  "processing",
  "uploading",
  "ready",
]);

/**
 * The complete durable status vocabulary, including terminal states a
 * successful trace must NOT contain. A state outside this set is not a missed
 * poll — it is an unknown value, and the trace is rejected.
 */
export const DURABLE_STATUSES = Object.freeze([
  "queued",
  "analyzing",
  "downloading",
  "processing",
  "uploading",
  "ready",
  "failed",
  "cancelled",
]);

/**
 * Evaluates a captured status trace.
 *
 * @param {unknown} observed the states seen, in capture order. Consecutive
 *   duplicates are expected and fine: a poller sampling every 150 ms will see
 *   `downloading` many times. They carry no information and are collapsed.
 * @param {readonly string[]} required the ladder that must be fully present.
 */
export function evaluateTransitionTrace(observed, required = REQUIRED_TRANSITIONS) {
  if (!Array.isArray(observed)) {
    return frozen({
      valid: false,
      ordered: false,
      complete: false,
      missing: [...required],
      unknown: [],
      reason: "the status trace is not an array",
    });
  }

  const unknown = observed.filter((state) => !DURABLE_STATUSES.includes(state));
  if (unknown.length > 0) {
    // A value outside the closed vocabulary is corruption or a contract
    // change, not a lifecycle observation. It never partially counts.
    return frozen({
      valid: false,
      ordered: false,
      complete: false,
      missing: [...required],
      unknown: [...new Set(unknown)],
      reason: `trace contains states outside the durable vocabulary: ${[...new Set(unknown)].join(", ")}`,
    });
  }

  // Collapse consecutive duplicates. Non-consecutive repetition is NOT
  // collapsed, because `downloading -> processing -> downloading` is a genuine
  // ordering violation and must survive to the ordering check below.
  const collapsed = observed.filter((state, index) => index === 0 || state !== observed[index - 1]);

  const ordered = isMonotonic(collapsed, required);
  const seen = new Set(collapsed);
  const missing = required.filter((state) => !seen.has(state));
  const complete = missing.length === 0;

  return frozen({
    valid: true,
    ordered,
    complete,
    missing,
    unknown: [],
    collapsed,
    reason: ordered
      ? complete
        ? "every required transition was observed, in order"
        : `incomplete trace — never observed: ${missing.join(", ")}`
      : "the trace moves backwards through the durable ladder",
  });
}

/** No state may appear at a lower rung than one already passed. */
function isMonotonic(states, required) {
  let cursor = -1;
  for (const state of states) {
    const index = required.indexOf(state);
    // A terminal state outside the success ladder (`failed`, `cancelled`) is
    // not an ordering violation by itself; completeness is what rejects it.
    if (index === -1) continue;
    if (index < cursor) return false;
    cursor = index;
  }
  return true;
}

/**
 * Maps a trace onto the harness's three-way outcome.
 *
 * Returned as a discriminated result rather than a boolean so the Stage B
 * evaluator can raise BLOCKED for an incomplete trace and FAIL for a
 * disordered one — the distinction §15 requires.
 */
export function classifyTransitionTrace(observed, required = REQUIRED_TRANSITIONS) {
  const trace = evaluateTransitionTrace(observed, required);
  if (!trace.valid) return { outcome: "FAIL", trace };
  if (!trace.ordered) return { outcome: "FAIL", trace };
  if (!trace.complete) return { outcome: "BLOCKED", trace };
  return { outcome: "PASS", trace };
}

/**
 * The cancellation trace contract.
 *
 * A cancelled job must have genuinely been acquiring — `downloading` must
 * appear — and must end `cancelled`. A job cancelled while still `queued`
 * proves nothing about terminating an owned process group.
 */
export function classifyCancellationTrace(observed) {
  const trace = evaluateTransitionTrace(observed, ["queued", "analyzing", "downloading"]);
  if (!trace.valid || !trace.ordered) return { outcome: "FAIL", trace };
  const states = Array.isArray(observed) ? observed : [];
  if (!states.includes("downloading")) {
    return {
      outcome: "BLOCKED",
      trace: { ...trace, reason: "the job was never observed in `downloading`; no cancellation window was proven" },
    };
  }
  if (states[states.length - 1] !== "cancelled") {
    return { outcome: "FAIL", trace: { ...trace, reason: "the job did not end in `cancelled`" } };
  }
  return { outcome: "PASS", trace };
}

function frozen(value) {
  return Object.freeze(value);
}
