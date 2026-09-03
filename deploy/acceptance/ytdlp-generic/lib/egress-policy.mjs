// Safe-egress deny-counter attribution and policy fingerprinting
// (§11-§16 of CORRECTION-03).
//
// ── Why a counter, and not "the request failed" ────────────────────────────
//
// Phase 9 established the standard, and `deploy/acceptance/safe-egress/counter.py`
// states it exactly:
//
//   "a connection that fails while `deny-v4` increments was denied BY THE
//    FIREWALL, whereas a connection that fails while every counter stays flat
//    was denied by something else — most often a missing route."
//
// The previous implementation attributed a denial to the boundary on the
// strength of a request failure plus `vf-egress-policy-verify == 0`. That pair
// proves the policy is intact; it proves nothing about what stopped this
// particular connection. A missing route, a DNS failure, or the application's
// own SSRF guard would all produce the same evidence.
//
// This module is pure over the nftables JSON that the Phase-9 listing returns.

/**
 * The rule comments the Phase-9 policy attaches to its deny rules.
 *
 * These are the vocabulary `counter.py` already reads. A class named here must
 * exist in the live ruleset; a lookup that finds no such rule is a measurement
 * failure, never a zero.
 */
export const DENY_CLASSES = Object.freeze([
  "deny-v4",
  "deny-v6",
  "deny-v4-mapped",
  "deny-multicast",
  "deny-link-local",
]);

/**
 * Reads one rule's packet counter out of `nft -j list chain` output.
 *
 * Mirrors `counter.py` exactly: find the rule whose `comment` matches, then the
 * first expression carrying a `counter`, and take its `packets`.
 */
export function readDenyCounter(document, ruleComment) {
  const entries = document?.nftables;
  if (!Array.isArray(entries)) {
    return { measured: false, reason: "the chain listing is not nftables JSON" };
  }
  for (const entry of entries) {
    const rule = entry?.rule;
    if (!rule || rule.comment !== ruleComment) continue;
    for (const expression of rule.expr ?? []) {
      if (expression && typeof expression === "object" && "counter" in expression) {
        const packets = expression.counter?.packets;
        if (!Number.isInteger(packets)) {
          return { measured: false, reason: `rule '${ruleComment}' has a non-integer counter` };
        }
        return { measured: true, packets };
      }
    }
  }
  return { measured: false, reason: `no counter found for rule comment '${ruleComment}'` };
}

/**
 * A policy fingerprint that actually describes the RULES (§16).
 *
 * The previous fingerprint combined the policy unit's systemd `InvocationID`
 * and its activation timestamp. Those describe the *unit's lifetime*, not the
 * ruleset: a rule added by hand while the unit kept running would leave both
 * unchanged. Labelling that an nftables policy fingerprint overstated it.
 *
 * Counters are stripped before hashing, because they are *expected* to move —
 * that movement is the evidence — and a fingerprint that changed whenever a
 * packet was denied would be useless for proving the policy held still.
 */
export function fingerprintChain(document) {
  const entries = document?.nftables;
  if (!Array.isArray(entries)) {
    return { measured: false, reason: "the chain listing is not nftables JSON" };
  }
  return { measured: true, normalized: canonicalJson(stripCounters(entries)) };
}

/** Recursively removes `counter` expressions and their volatile values. */
function stripCounters(value) {
  if (Array.isArray(value)) return value.map(stripCounters);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "counter") {
        // Keep the SHAPE — a rule losing its counter entirely is a real change —
        // while dropping the mutable packet/byte totals.
        out.counter = "<counter>";
        continue;
      }
      // `handle` is assigned by the kernel and can shift without the rule
      // changing meaning.
      if (key === "handle") continue;
      out[key] = stripCounters(entry);
    }
    return out;
  }
  return value;
}

/** Deterministic encoding, so key order cannot change the fingerprint. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/**
 * The §12 verdict for one deny class.
 *
 * A flat counter is never a pass. Whether it is FAIL or BLOCKED depends on
 * whether the counter was *measured*: a counter read successfully that did not
 * move is a finding (something other than the firewall stopped the connection);
 * a counter that could not be read at all is an evidence gap.
 */
export function attributeDenial({ before, after, requestDenied }) {
  if (before?.measured !== true || after?.measured !== true) {
    return {
      measured: false,
      reason:
        "the deny counter could not be read before and after, so the denial cannot be " +
        `attributed to the boundary (${before?.reason ?? after?.reason ?? "unknown"})`,
    };
  }
  const delta = after.packets - before.packets;
  return {
    measured: true,
    attributedToBoundary: requestDenied === true && delta > 0,
    denyCounterBefore: before.packets,
    denyCounterAfter: after.packets,
    denyCounterDelta: delta,
    reason:
      delta > 0
        ? "the deny counter moved while the connection failed"
        : "the deny counter did not move; the connection was stopped by something other than the boundary",
  };
}
