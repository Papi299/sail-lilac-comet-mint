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
//
// ── PHASE-10D STAGE-B LIFECYCLE OBSERVABILITY REMEDIATION ──────────────────
//
// Live run `132658924d1c7a1b` (fresh Stage A PASS 23/0/0/0, Worker source
// e4fa646b / image sha256:c3995e18…) produced a Stage-B `success` case that
// reached `ready` with every byte, R2 and delivery proof intact, and recorded:
//
//     queued -> analyzing -> downloading -> uploading -> ready
//
// `classifyTransitionTrace` graded that BLOCKED. That grade was correct for what
// it knows and wrong about the Worker. The Worker does NOT skip `processing`:
// `job-executor.server.ts` unconditionally runs
// `download -> beginProcessing() -> executePlan() -> beginUploading()` on every
// strategy. For the `keep-original` plan `executePlan` returns the
// already-acquired path almost immediately, so durable `processing` can live for
// less than one 200 ms acceptance poll. It was durably real; it was not sampled.
//
// Tighter polling cannot fix that — no cadence can guarantee sampling a legal
// near-zero-duration state. What CAN close it is the job store's own refusal
// set: `beginUploading` is `processing -> uploading` and there is no
// `downloading -> uploading` transition, so an OBSERVED `uploading` is causal
// proof that `processing` committed.
//
// `classifySuccessTransitionTrace` below encodes exactly that, for the success
// path only, for `processing` only, and only when the proving `uploading`
// observation is actually present. `classifyTransitionTrace` and
// `classifyCancellationTrace` are unchanged and remain strict. The six-state
// contract itself is unchanged: the property proven is still the complete
// lifecycle, and the raw trace is never rewritten to claim otherwise.

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
 * The single state whose absence from a SUCCESS trace may be closed by proof
 * rather than by observation, and the successor observation that proves it.
 *
 * `SQLiteJobStore.beginUploading` is `processing -> uploading`; there is no
 * `downloading -> uploading` transition anywhere in the Worker's public job-store
 * contract. So a directly observed durable `uploading` is not weak evidence that
 * `processing` "probably" happened — it is causal proof that it DID, because the
 * store would have answered `state_conflict` and left the row alone otherwise.
 */
export const INFERABLE_SUCCESS_STATE = "processing";
export const INFERENCE_WITNESS_STATE = "uploading";

/** Terminal states that a purported success trace must not contain at all. */
const NON_SUCCESS_TERMINALS = Object.freeze(["failed", "cancelled"]);

export const PROCESSING_PROOF_BASIS =
  "SQLiteJobStore.beginUploading enforces `processing -> uploading`, and no " +
  "`downloading -> uploading` transition exists, so an observed durable " +
  "`uploading` proves a durable `processing` committed first";

/**
 * The SUCCESS-path lifecycle contract.
 *
 * This is deliberately NOT a relaxation of `classifyTransitionTrace`, which
 * stays strict for every other caller. It is a narrower classifier that knows
 * one extra thing the generic one does not: which durable transitions the
 * Worker's own job store refuses.
 *
 * The property proven is still the COMPLETE six-state lifecycle. What changes is
 * how ONE of the six may be established:
 *
 *   directly observed   the poller sampled the state itself
 *   causally proven     the poller sampled a state the store can only reach
 *                       from it
 *
 * Why only `processing` qualifies (§7 of the remediation): the Worker commits it
 * unconditionally — `downloadX() -> beginProcessing() -> executePlan() ->
 * beginUploading()` in `job-executor.server.ts` — but for a `keep-original` plan
 * `executePlan` returns the already-acquired path almost immediately, so the
 * durable state's LIFETIME can be shorter than one 200 ms acceptance poll. The
 * state is real and durable; the sampling window simply cannot be guaranteed to
 * land inside it. No other required state has both an unconditional commit and
 * an enforced immediate successor, so no other state is inferable here.
 *
 * The raw trace is never rewritten. `processing` is not spliced into
 * `collapsed`, and it stays in `missing` — the record continues to say exactly
 * what was and was not sampled.
 *
 * @param {unknown} observed the states seen, in capture order.
 * @returns {{outcome: string, trace: object, processing: "observed"|"causally-proven"|"unproven", proof: object|null}}
 */
export function classifySuccessTransitionTrace(observed) {
  const trace = evaluateTransitionTrace(observed, REQUIRED_TRANSITIONS);

  // Case E — an unknown status is corruption or a contract change.
  if (!trace.valid) return unproven("FAIL", trace);
  // Case D — a real ordering violation.
  if (!trace.ordered) return unproven("FAIL", trace);

  // Case F — `failed` or `cancelled` inside a purported success trace.
  //
  // These are inside DURABLE_STATUSES, so they are "valid", and they are
  // outside the success ladder, so `isMonotonic` skips them. Neither the
  // validity nor the ordering gate rejects them, and completeness alone would
  // report them as a missing-state BLOCKED. A success lifecycle must not treat
  // a terminal failure or cancellation as harmless noise, so it is caught here
  // and it FAILs.
  const states = trace.collapsed ?? [];
  const intruders = [...new Set(states.filter((state) => NON_SUCCESS_TERMINALS.includes(state)))];
  if (intruders.length > 0) {
    return unproven("FAIL", {
      ...trace,
      reason: `a success trace must not contain a terminal ${intruders.join(" or ")} observation`,
    });
  }

  // Case A — all six directly observed.
  if (trace.complete) {
    return Object.freeze({
      outcome: "PASS",
      trace: frozen({
        ...trace,
        reason: "every required transition was directly observed, in order",
      }),
      processing: "observed",
      proof: null,
    });
  }

  // Case B — ONLY `processing` was not directly sampled, and the observation
  // that proves it is itself present.
  const onlyProcessingMissing =
    trace.missing.length === 1 && trace.missing[0] === INFERABLE_SUCCESS_STATE;
  const downloadingAt = states.indexOf("downloading");
  const uploadingAt = states.indexOf(INFERENCE_WITNESS_STATE);
  const endsReady = states[states.length - 1] === "ready";

  if (
    onlyProcessingMissing &&
    downloadingAt !== -1 &&
    uploadingAt !== -1 &&
    downloadingAt < uploadingAt &&
    endsReady
  ) {
    return Object.freeze({
      outcome: "PASS",
      trace: frozen({
        ...trace,
        reason:
          "`processing` was not directly sampled, but is CAUSALLY PROVEN rather than assumed: " +
          "`uploading` was directly observed, and " +
          PROCESSING_PROOF_BASIS +
          ". Every other required transition was directly observed, in order. " +
          "The recorded trace is unmodified — `processing` remains listed as not sampled.",
      }),
      processing: "causally-proven",
      proof: frozen({
        state: INFERABLE_SUCCESS_STATE,
        establishedBy: "causal-inference",
        observedWitness: INFERENCE_WITNESS_STATE,
        enforcedPredecessorOfWitness: INFERABLE_SUCCESS_STATE,
        basis: PROCESSING_PROOF_BASIS,
        directlyObserved: false,
      }),
    });
  }

  // Case C — anything else missing. No other state may be inferred, and
  // `processing` itself is not inferable without its witness.
  return unproven("BLOCKED", {
    ...trace,
    reason:
      `incomplete trace — never observed: ${trace.missing.join(", ")}. ` +
      (onlyProcessingMissing
        ? "`processing` is inferable ONLY from a directly observed `uploading` that follows a " +
          "directly observed `downloading` in a trace ending `ready`, and that witness is absent."
        : "No state other than `processing` may be inferred; a missed poll is an evidence gap, not proof."),
  });
}

function unproven(outcome, trace) {
  return Object.freeze({ outcome, trace: frozen(trace), processing: "unproven", proof: null });
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
