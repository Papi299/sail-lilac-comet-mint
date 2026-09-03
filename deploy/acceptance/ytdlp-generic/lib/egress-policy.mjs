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
 * The EXACT deny-rule comments the deployed Phase-9 policy carries (§17-§19 of
 * CORRECTION-04).
 *
 * Reconciled against `deploy/nftables/videofetch-egress.nft.template`, which is
 * the source the installer renders. The complete rule-comment vocabulary the
 * live chain actually contains is:
 *
 *   established          accept  — replies to inbound connections
 *   designated-dns-udp   accept  — the one designated resolver, port 53
 *   designated-dns-tcp   accept  — likewise
 *   deny-v4-broadcast    reject  — 255.255.255.255/32
 *   deny-v4              reject  — @forbidden_v4
 *   deny-v6              reject  — @forbidden_v6
 *   public-http          accept  — tcp dport { 80, 443 }
 *   fallthrough-drop     drop    — the chain policy counter
 *
 * Only the three `deny-*` rules can attribute a denial to the boundary, and
 * this list is now exactly those three.
 *
 * ── Why the previous list was a defect, not merely untidy ──────────────────
 *
 * It named `deny-v4-mapped`, `deny-multicast` and `deny-link-local`, none of
 * which exist in the deployed ruleset — those classes are elements INSIDE
 * `@forbidden_v4`/`@forbidden_v6` and increment `deny-v4`/`deny-v6`. Worse, the
 * value was a free-form string, so `--egress-deny-class public-http` would have
 * attributed a denial to an ACCEPT rule whose counter moves on every ordinary
 * media fetch, and `--egress-deny-class established` to a counter that moves on
 * essentially every response the Worker sends. Either would have produced a
 * confident PASS from a counter that had nothing to do with a denial.
 */
export const DENY_CLASSES = Object.freeze(["deny-v4", "deny-v6", "deny-v4-broadcast"]);

/**
 * Every rule comment in the deployed chain that is NOT a denial.
 *
 * Kept explicitly so the refusal message can say *why* a plausible-looking
 * value is refused, rather than only that it is not on a list.
 */
export const NON_DENY_RULE_COMMENTS = Object.freeze({
  established: "an ACCEPT rule for replies to inbound connections",
  "designated-dns-udp": "an ACCEPT rule for the designated resolver",
  "designated-dns-tcp": "an ACCEPT rule for the designated resolver",
  "public-http": "an ACCEPT rule for ordinary public media egress",
  "fallthrough-drop": "the chain's catch-all policy counter, which attributes nothing to a rule",
});

/**
 * The deny class each controlled fixture family is expected to trip (§19).
 *
 * The FIXTURE determines the counter, so an operator cannot point the case at
 * an unrelated counter that happens to be moving for its own reasons.
 */
export const EGRESS_FIXTURE_CLASSES = Object.freeze({
  "private-v4": "deny-v4",
  "forbidden-v6": "deny-v6",
  broadcast: "deny-v4-broadcast",
});

/**
 * Parses an operator-supplied deny class through the closed enum.
 *
 * Called at ARGUMENT-PARSE time, before any live operation, so an unknown or
 * non-deny value is a usage error rather than a case that runs to completion
 * and then reports an unreadable counter.
 */
export function parseDenyClass(value) {
  if (value === undefined || value === null) {
    return { ok: true, denyClass: DENY_CLASSES[0] };
  }
  const candidate = String(value);
  if (DENY_CLASSES.includes(candidate)) return { ok: true, denyClass: candidate };

  const nonDeny = NON_DENY_RULE_COMMENTS[candidate];
  return {
    ok: false,
    reason: nonDeny
      ? `--egress-deny-class '${candidate}' is ${nonDeny}; a denial can only be attributed to a ` +
        `deny rule. Choose one of: ${DENY_CLASSES.join(", ")}`
      : `--egress-deny-class '${candidate}' is not a deny rule in the deployed policy. ` +
        `Choose one of: ${DENY_CLASSES.join(", ")}`,
  };
}

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
