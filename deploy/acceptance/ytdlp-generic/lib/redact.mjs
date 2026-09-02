// The ONE redaction implementation for the generic acceptance harness (§45).
//
// Every console line, every evidence field, every error message and every
// command summary this harness emits passes through here. There is deliberately
// no second spelling: a redaction helper that exists in two places is a
// redaction helper that will disagree with itself.
//
// Pure. No I/O, no process, no network — so the tests can assert the exact
// output shape without a Production system anywhere near them.

/**
 * Query strings are removed WHOLESALE rather than per-parameter.
 *
 * An allowlist of "safe" parameter names is the wrong shape for this problem:
 * the operator-supplied acceptance URL (§23) is third-party test data whose
 * parameter vocabulary nobody controls, media hosts routinely carry signed
 * tokens in ordinary-looking parameters, and the ephemeral sentinel (§46) is
 * placed in a query parameter ON PURPOSE. Keeping any query value at all would
 * make the sentinel test unfalsifiable.
 */
const REDACTED_QUERY = "<redacted>";

/** Fragments are dropped entirely: they carry no evidence value and can carry tokens. */
function redactUrlObject(url) {
  const query = url.search.length > 0 ? `?${REDACTED_QUERY}` : "";
  // `url.username`/`url.password` are stripped by never being re-emitted.
  return `${url.protocol}//${url.host}${url.pathname}${query}`;
}

/**
 * Renders a URL safe for output.
 *
 * A value that does not parse as a URL is NOT passed through — an unparseable
 * string is exactly where a malformed-but-secret-bearing value would hide — so
 * it collapses to a fixed marker instead.
 */
export function redactUrl(value) {
  if (typeof value !== "string" || value.length === 0) return "<no-url>";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "<unparseable-url>";
  }
  return redactUrlObject(url);
}

/**
 * Redacts every URL-shaped substring inside arbitrary text.
 *
 * Used for anything that originated outside this harness — an error message, a
 * captured log line, a status body. The pattern stops at whitespace, quotes and
 * angle brackets, which is where a URL ends in every log format this harness
 * reads.
 */
// The optional trailing `<redacted>` makes redaction IDEMPOTENT. Without it,
// a second pass over an already-redacted URL matches only up to the `?`,
// leaves `<redacted>` dangling outside the match, and re-renders the URL as
// `https://host/path<redacted>` — a value that no longer parses and no longer
// shows that a query was removed. The evidence record is redacted at more than
// one level, so this case is reached in normal operation, not in theory.
const URL_IN_TEXT = /\b(?:https?|ftp|ws|wss):\/\/[^\s"'<>`\\]+(?:<redacted>)?/gi;

export function redactText(value) {
  if (typeof value !== "string") return "";
  return value.replace(URL_IN_TEXT, (match) => redactUrl(match));
}

/**
 * Redacts a value of unknown shape for the evidence record.
 *
 * Strings are text-redacted; arrays and plain objects are walked; everything
 * else is returned as-is. Depth is bounded so a cyclic or pathological
 * structure cannot hang the harness.
 */
export function redactDeep(value, depth = 0) {
  if (depth > 8) return "<max-depth>";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, depth + 1));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactDeep(entry, depth + 1);
    return out;
  }
  return value;
}

/**
 * Reports a secret-bearing environment variable as presence only (§16, §17).
 *
 * The value is never returned, never hashed by default and never length-
 * reported: a length is a real constraint on a short secret. `present` is the
 * entire answer.
 */
export function describePresence(name, rawValue) {
  return Object.freeze({ name, present: typeof rawValue === "string" && rawValue.length > 0 });
}

/**
 * The scrubber of last resort.
 *
 * Given the ephemeral sentinel (§46) and any operator-supplied secret material
 * the harness happens to hold, this replaces every occurrence in a rendered
 * string. It is a BACKSTOP, not the mechanism — the mechanism is that the
 * harness never puts those values into output in the first place — but it means
 * a single missed call site cannot leak.
 *
 * `needles` are matched literally, longest first, so a needle that is a
 * substring of another still cannot survive.
 */
export function scrubSecrets(text, needles) {
  if (typeof text !== "string" || text.length === 0) return text ?? "";
  const list = (needles ?? [])
    .filter((n) => typeof n === "string" && n.length >= 8)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of list) out = out.split(needle).join("<scrubbed>");
  return out;
}

/**
 * The full output pipeline: redact URLs, then scrub known secret material.
 *
 * Order matters. Redaction runs first so that a sentinel sitting in a query
 * string is removed as a QUERY rather than reported as a scrub hit — a scrub
 * hit would prove the URL survived redaction, which is itself the defect.
 */
export function safeOutput(value, needles) {
  return scrubSecrets(redactText(value), needles);
}

/**
 * The central console safety boundary (§13 of CORRECTION-01).
 *
 * The harness previously CLAIMED one redaction implementation covered console
 * output, but relied on every call site remembering to pre-redact its own
 * string. This makes it structural: the CLI logs through this, so any dynamic
 * value — an error message carrying a media URL, a status body, a command
 * summary — is redacted and scrubbed on the way out.
 *
 * `needles` is passed BY REFERENCE and read at call time, so a secret
 * registered later in the run (the per-run sentinel, the Worker control secret)
 * protects output that was already wired up.
 */
export function createSafeConsole({ log, errorLog, needles }) {
  const emit = (sink) => (value) => sink(safeOutput(String(value ?? ""), needles ?? []));
  return {
    log: emit(log ?? console.log),
    error: emit(errorLog ?? console.error),
  };
}
