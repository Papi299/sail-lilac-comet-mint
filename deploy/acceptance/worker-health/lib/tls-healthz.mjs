// The TLS `/v1/healthz` acceptance core.
// (WORKER-EXTERNAL-LIVENESS-TLS-HEALTH-IMPLEMENTATION-001)
//
// Proves the SECOND open health item: that `GET /v1/healthz` returns the healthy
// response through the REAL external HTTPS endpoint — the Cloudflare ingress and
// tunnel in front of the Worker — rather than through the VM loopback path the
// liveness probe uses. The two measurements are not interchangeable: loopback
// proves the application answers, and only the TLS path proves the ingress
// delivers that answer to the outside world.
//
// Pure except for the transport, which is injected. Every deterministic test in
// scripts/worker-tls-healthz-acceptance.test.mjs drives this module with a fake
// transport and therefore reaches no network, no Cloudflare hostname and no
// Production system.
//
// TWO CREDENTIAL DOMAINS, NEVER CONFLATED
//
//   Cloudflare Access Service Auth   CF-Access-Client-Id / CF-Access-Client-Secret
//                                    Belongs to the ingress proxy. May be
//                                    REQUIRED to reach the origin at all.
//
//   VideoFetch Worker HMAC           x-videofetch-* headers.
//                                    Belongs to the VideoFetch protocol, and is
//                                    NOT used here: /v1/healthz is
//                                    unauthenticated at the Worker application
//                                    layer, so signing it would both be
//                                    meaningless and put control-plane key
//                                    material into a health check.
//
// This module emits the first pair when supplied, and never the second.

/**
 * The schema version of the evidence record this module produces.
 *
 * `-02` (REVIEW-CORRECTION-001) replaces `-01`, which asserted `httpsUsed: true`
 * and `tlsVerification: "enabled"` on every record — including runs refused
 * before any request, and the run refused BECAUSE verification was disabled.
 * `-01` never produced accepted evidence; it must not be used.
 */
export const TLS_HEALTHZ_SCHEMA_VERSION = "worker-tls-healthz-02";

export const TLS_HEALTHZ_TASK = "WORKER-EXTERNAL-LIVENESS-TLS-HEALTH-IMPLEMENTATION-001";

/**
 * The exact path measured. Kept in step with `WORKER_HEALTH_PATH` in
 * src/shared/worker/constants.ts by the deployment-policy suite.
 */
export const TLS_HEALTHZ_PATH = "/v1/healthz";

/** The healthy state the Worker's health route reports. */
export const TLS_HEALTHZ_EXPECTED_STATUS = "ok";

/** The two Access headers, in their canonical spelling. */
export const ACCESS_ID_HEADER = "CF-Access-Client-Id";
export const ACCESS_SECRET_HEADER = "CF-Access-Client-Secret";

/** The operator-supplied Access credential names. The SAME pair Vercel uses. */
export const ACCESS_ID_ENV = "CLOUDFLARE_ACCESS_CLIENT_ID";
export const ACCESS_SECRET_ENV = "CLOUDFLARE_ACCESS_CLIENT_SECRET";

/** A health body is tiny; anything larger is itself the finding. */
export const TLS_HEALTHZ_MAX_BODY_BYTES = 4096;

/**
 * Validates the operator-supplied origin and returns the exact URL to request.
 *
 * THE NORMALIZATION CONTRACT IS EXACTLY THIS, AND IS TESTED AS SUCH:
 *
 *   https://host                 -> https://host/v1/healthz
 *   https://host/                -> https://host/v1/healthz
 *   https://host/v1/healthz      -> https://host/v1/healthz   (accepted as given)
 *
 * Everything else is REFUSED. In particular a query string, a fragment, embedded
 * credentials, any other path, and any scheme other than `https:`. There is no
 * "close enough" branch: an operator who mistypes the endpoint must get a
 * refusal, not a PASS measured against the wrong URL.
 */
export function resolveHealthzTarget(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { error: "no Worker HTTPS origin supplied" };
  }

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "the supplied origin is not a valid URL" };
  }

  // The scheme is recorded as evidence even on refusal — it is the one
  // non-identifying fact that explains why an `http:` target was refused — so
  // it is returned on every path from here on. Only well-known scheme tokens
  // are echoed; anything else is reported as "other" rather than rendered.
  const suppliedScheme = /^(https|http|wss?|ftp|file):$/.test(url.protocol) ? url.protocol : "other";

  // HTTPS ONLY. The whole point of this acceptance is the TLS path, so `http:`
  // is not downgraded-but-accepted; it is refused.
  if (url.protocol !== "https:") {
    return { error: `the origin must use https:, got '${suppliedScheme}'`, suppliedScheme };
  }

  // Embedded credentials would travel in the request AND into any rendering of
  // the URL. Refused outright rather than stripped.
  if (url.username.length > 0 || url.password.length > 0) {
    return { error: "the origin must not embed credentials", suppliedScheme };
  }

  if (url.search.length > 0) {
    return { error: "the origin must not carry a query string", suppliedScheme };
  }
  if (url.hash.length > 0) {
    return { error: "the origin must not carry a fragment", suppliedScheme };
  }

  if (url.pathname !== "/" && url.pathname !== TLS_HEALTHZ_PATH) {
    return {
      error: `the origin path must be empty, '/' or exactly '${TLS_HEALTHZ_PATH}'`,
      suppliedScheme,
    };
  }

  const target = new URL(TLS_HEALTHZ_PATH, `${url.protocol}//${url.host}`);
  return { url: target.toString(), host: url.host, protocol: url.protocol, suppliedScheme };
}

/**
 * Builds the Access headers, both-or-neither, BEFORE any request is made.
 *
 * A half-supplied service token is a fail-closed configuration error, not a
 * request worth attempting: sending one header alone would be rejected by the
 * Access layer and the operator would read the resulting 403 as a Worker fault.
 * The offending VALUE is never echoed — only which name was missing.
 */
export function buildAccessHeaders({ clientId, clientSecret } = {}) {
  const id = typeof clientId === "string" ? clientId.trim() : "";
  const secret = typeof clientSecret === "string" ? clientSecret.trim() : "";
  const hasId = id.length > 0;
  const hasSecret = secret.length > 0;

  if (hasId !== hasSecret) {
    return {
      error:
        `Access Service Auth requires BOTH ${ACCESS_ID_ENV} and ${ACCESS_SECRET_ENV}` +
        ` or neither; ${hasId ? ACCESS_SECRET_ENV : ACCESS_ID_ENV} is missing`,
    };
  }

  if (!hasId) return { headers: {}, supplied: false };

  return {
    headers: { [ACCESS_ID_HEADER]: id, [ACCESS_SECRET_HEADER]: secret },
    supplied: true,
  };
}

/**
 * Describes what the operator SUPPLIED, independently of how far the run got.
 *
 * A static fact of the input, so it is true on every path — unlike "headers
 * sent", which is only true once a request is actually attempted.
 */
export function describeAccessPresence({ clientId, clientSecret } = {}) {
  const hasId = typeof clientId === "string" && clientId.trim().length > 0;
  const hasSecret = typeof clientSecret === "string" && clientSecret.trim().length > 0;
  if (hasId && hasSecret) return "both";
  if (!hasId && !hasSecret) return "neither";
  return "incomplete";
}

/** Outcomes, so the tests and the evidence record agree on one vocabulary. */
export const TLS_HEALTHZ_OUTCOMES = Object.freeze({
  HEALTHY: "healthy",
  TARGET_REFUSED: "target-refused",
  CREDENTIALS_INCOMPLETE: "credentials-incomplete",
  TLS_VERIFICATION_DISABLED: "tls-verification-disabled",
  TRANSPORT_FAILED: "transport-failed",
  REDIRECTED: "redirected",
  BAD_STATUS: "bad-status",
  BODY_TOO_LARGE: "body-too-large",
  MALFORMED_BODY: "malformed-body",
  WRONG_STATE: "wrong-state",
});

/**
 * Judges the status line. Returns `null` only for 200 — the one status whose
 * body is worth reading — and a verdict for everything else.
 *
 * A REDIRECT IS A FAILURE, and is reported as its own outcome rather than folded
 * into "non-200". `redirect: "manual"` means a 3xx arrives here intact, and
 * following it would let an Access login page, a zone-level redirect or a
 * misrouted hostname answer on behalf of the Worker — the single most likely way
 * for this acceptance to produce a false PASS.
 */
export function evaluateHealthzStatus(status) {
  if (typeof status !== "number") {
    return { outcome: TLS_HEALTHZ_OUTCOMES.TRANSPORT_FAILED, detail: "no HTTP status observed" };
  }
  if (status >= 300 && status <= 399) {
    return {
      outcome: TLS_HEALTHZ_OUTCOMES.REDIRECTED,
      detail: `the endpoint answered ${status}; a redirect is never a pass`,
      redirected: true,
    };
  }
  if (status !== 200) {
    return { outcome: TLS_HEALTHZ_OUTCOMES.BAD_STATUS, detail: `expected HTTP 200, got ${status}` };
  }
  return null;
}

/** Judges a body that has ALREADY been read within the byte limit. */
export function evaluateHealthzBody(bodyText) {
  const text = typeof bodyText === "string" ? bodyText : "";

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A well-formed HTML login page is the classic wrong answer here, and it
    // fails at exactly this line.
    return { outcome: TLS_HEALTHZ_OUTCOMES.MALFORMED_BODY, detail: "response body is not valid JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { outcome: TLS_HEALTHZ_OUTCOMES.MALFORMED_BODY, detail: "response body is not a JSON object" };
  }

  if (parsed.status !== TLS_HEALTHZ_EXPECTED_STATUS) {
    // The observed state is not echoed: it is text from whatever answered the
    // hostname, and the evidence record is not the place to render it.
    return {
      outcome: TLS_HEALTHZ_OUTCOMES.WRONG_STATE,
      detail: `health state is not "${TLS_HEALTHZ_EXPECTED_STATUS}"`,
    };
  }

  return { outcome: TLS_HEALTHZ_OUTCOMES.HEALTHY, detail: "status ok" };
}

/**
 * Judges an already-materialized response: status, then size, then body.
 *
 * A PURE convenience for judgement tests. The real acceptance path does NOT
 * use it on a full body — it reads through `readBoundedBody`, which enforces the
 * cap while streaming — so this function's size check is a second gate, never
 * the memory bound.
 */
export function evaluateHealthzResponse({ status, bodyText }) {
  const statusVerdict = evaluateHealthzStatus(status);
  if (statusVerdict) return statusVerdict;
  const text = typeof bodyText === "string" ? bodyText : "";
  if (Buffer.byteLength(text, "utf8") > TLS_HEALTHZ_MAX_BODY_BYTES) {
    return {
      outcome: TLS_HEALTHZ_OUTCOMES.BODY_TOO_LARGE,
      detail: `response body exceeded ${TLS_HEALTHZ_MAX_BODY_BYTES} bytes`,
    };
  }
  return evaluateHealthzBody(text);
}

/** The abort reason, or a TimeoutError-shaped stand-in. */
function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("the request deadline elapsed");
  err.name = "TimeoutError";
  return err;
}

/**
 * Reads a response body INCREMENTALLY, never holding more than `maxBytes`.
 *
 * REVIEW-CORRECTION-001, finding 3. The first revision called
 * `response.text()` and measured the result, which buffers the ENTIRE body
 * before the cap is ever consulted — so a fast or hostile endpoint could consume
 * arbitrary memory while the run was still going to report BODY_TOO_LARGE.
 *
 * Here each chunk is checked BEFORE it is retained. The first chunk that would
 * cross the limit is discarded, the stream is cancelled so the transport stops
 * reading from the socket, and the call returns `{ tooLarge: true }`. At most
 * `maxBytes` of body are ever retained. `Content-Length` is not consulted: it
 * may be absent, and it may lie.
 *
 * The request's own AbortSignal governs the body too. An abort cancels the
 * reader — which unblocks a read that would otherwise wait forever on a
 * stalled peer — and is then raised, so a timed-out body is a transport failure
 * and never a truncated "success".
 */
export async function readBoundedBody(response, maxBytes, signal) {
  const stream = response?.body ?? null;
  if (stream === null) return { text: "", bytesRead: 0 };
  if (typeof stream.getReader !== "function") {
    throw new TypeError("response body is not a readable stream");
  }

  if (signal?.aborted) throw abortError(signal);

  const reader = stream.getReader();
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError(signal);
      if (done) break;

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(0);
      if (total + chunk.byteLength > maxBytes) {
        // Stop reading NOW. The oversized chunk is never retained, and cancel()
        // tells the transport to stop pulling bytes off the connection.
        await reader.cancel().catch(() => {});
        return { tooLarge: true, bytesRead: total + chunk.byteLength };
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released or errored; nothing further is read either way */
    }
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8").decode(joined), bytesRead: total };
}

/** Releases a body that will not be judged, without reading it. */
async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    /* the verdict is already decided by the status line */
  }
}

/**
 * Refuses to run with certificate verification disabled.
 *
 * There is no `--insecure` flag in this tool, and this closes the other route to
 * the same place: `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment would
 * silently turn the whole acceptance into a measurement of an unauthenticated
 * endpoint. An acceptance that can be defeated by an environment variable is not
 * an acceptance.
 */
export function assertTlsVerificationEnabled(env) {
  const raw = env?.NODE_TLS_REJECT_UNAUTHORIZED;
  if (typeof raw === "string" && raw.trim() === "0") {
    return {
      error:
        "NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification;" +
        " this acceptance refuses to run without ordinary TLS validation",
    };
  }
  return { ok: true };
}

/**
 * Runs the acceptance.
 *
 * `fetchImpl` is injected so the deterministic tests drive the whole decision
 * path without a network. The real CLI passes the platform `fetch`, whose
 * certificate validation is on by default and is never overridden here.
 *
 * EVIDENCE RECORDS ONLY WHAT HAPPENED (REVIEW-CORRECTION-001, finding 2). Each
 * fact starts in its "not measured" state and is set only when the run actually
 * reaches the stage that measures it, so a run refused before any request can
 * never claim HTTPS was used or that certificate verification applied.
 */
export async function runTlsHealthzAcceptance({
  origin,
  accessClientId,
  accessClientSecret,
  env = {},
  fetchImpl,
  timeoutMs = 10_000,
  now = () => new Date(),
} = {}) {
  const facts = {
    startedAt: now().toISOString(),
    accessCredentialPresence: describeAccessPresence({
      clientId: accessClientId,
      clientSecret: accessClientSecret,
    }),
    tlsVerification: "not-attempted",
    targetAccepted: null,
    suppliedScheme: null,
    requestAttempted: false,
    httpsUsed: null,
    responseReceived: false,
    httpStatus: null,
    redirectObserved: null,
    bodyWithinLimit: null,
    healthyBodyMatched: null,
    accessHeaderNamesSent: [],
  };
  const done = (outcome, detail) =>
    finalize({ ...facts, outcome, detail, finishedAt: now().toISOString() });

  // ── 1. Verification must be on. Nothing else is evaluated if it is not. ────
  const tls = assertTlsVerificationEnabled(env);
  if (tls.error) {
    facts.tlsVerification = "disabled-refused";
    return done(TLS_HEALTHZ_OUTCOMES.TLS_VERIFICATION_DISABLED, tls.error);
  }

  // ── 2. The target contract. ───────────────────────────────────────────────
  const target = resolveHealthzTarget(origin);
  facts.suppliedScheme = target.suppliedScheme ?? null;
  if (target.error) {
    facts.targetAccepted = false;
    return done(TLS_HEALTHZ_OUTCOMES.TARGET_REFUSED, target.error);
  }
  facts.targetAccepted = true;

  // ── 3. Credentials, both or neither — decided BEFORE any request. ─────────
  const access = buildAccessHeaders({
    clientId: accessClientId,
    clientSecret: accessClientSecret,
  });
  if (access.error) {
    // Nothing is dialled, so an incomplete credential pair cannot be observed
    // by the endpoint at all.
    return done(TLS_HEALTHZ_OUTCOMES.CREDENTIALS_INCOMPLETE, access.error);
  }

  // ── 4. The one request. From here on HTTPS and verification are real. ─────
  const headers = { accept: "application/json", ...access.headers };
  const signal = AbortSignal.timeout(timeoutMs);
  facts.requestAttempted = true;
  facts.httpsUsed = target.protocol === "https:";
  facts.tlsVerification = "enabled";
  facts.accessHeaderNamesSent = Object.keys(access.headers);

  let response;
  try {
    response = await fetchImpl(target.url, {
      method: "GET",
      headers,
      // A 3xx must ARRIVE here so it can be judged. Following it is how a login
      // page becomes a false PASS.
      redirect: "manual",
      signal,
    });
  } catch (err) {
    // A certificate failure lands here too, which is the intended behaviour: an
    // untrusted endpoint is a FAILED acceptance, never a skipped check. The
    // error's own message is not recorded — it can carry the hostname.
    return done(
      TLS_HEALTHZ_OUTCOMES.TRANSPORT_FAILED,
      `the HTTPS request did not complete (${err?.name ?? "error"})`,
    );
  }

  // ── 5. The status line. ──────────────────────────────────────────────────
  facts.responseReceived = true;
  facts.httpStatus = typeof response?.status === "number" ? response.status : null;
  const statusVerdict = evaluateHealthzStatus(facts.httpStatus);
  facts.redirectObserved = statusVerdict?.outcome === TLS_HEALTHZ_OUTCOMES.REDIRECTED;
  if (statusVerdict) {
    await discardBody(response);
    return done(statusVerdict.outcome, statusVerdict.detail);
  }

  // ── 6. The body, bounded WHILE it streams, under the same deadline. ───────
  let body;
  try {
    body = await readBoundedBody(response, TLS_HEALTHZ_MAX_BODY_BYTES, signal);
  } catch (err) {
    return done(
      TLS_HEALTHZ_OUTCOMES.TRANSPORT_FAILED,
      `the response body did not complete (${err?.name ?? "error"})`,
    );
  }
  if (body.tooLarge) {
    facts.bodyWithinLimit = false;
    return done(
      TLS_HEALTHZ_OUTCOMES.BODY_TOO_LARGE,
      `response body exceeded ${TLS_HEALTHZ_MAX_BODY_BYTES} bytes; reading stopped`,
    );
  }
  facts.bodyWithinLimit = true;

  const verdict = evaluateHealthzBody(body.text);
  facts.healthyBodyMatched = verdict.outcome === TLS_HEALTHZ_OUTCOMES.HEALTHY;
  return done(verdict.outcome, verdict.detail);
}

/**
 * Assembles the deliberately narrow evidence record.
 *
 * AN ALLOWLIST, NOT A FILTERED DUMP. Every field is named here, so nothing can
 * arrive by being spread in from a response, a header bag or an error object.
 *
 * `null` means NOT MEASURED — the run stopped before the stage that would have
 * established the fact. It is never a stand-in for `false`.
 *
 * Never recorded, by construction rather than by redaction:
 *
 *   * the Worker hostname or origin  — the repository never commits the
 *                                      Production Worker hostname
 *   * the Access Client Id / Secret  — credential halves; presence only
 *   * any header VALUE               — only the Access pair's NAMES, and only
 *                                      once they were actually sent
 *   * cookies, signed URLs, HMAC keys, R2 credentials, Cloudflare identifiers
 *   * the response body              — only whether it was within the limit
 *                                      and whether it matched
 */
function finalize(input) {
  const pass = input.outcome === TLS_HEALTHZ_OUTCOMES.HEALTHY;

  // Header NAMES only, and only ones from the known Access pair. An unexpected
  // name is reported as a count, never as text, so a future edit that attached
  // some other header cannot write it into the record.
  const known = [ACCESS_ID_HEADER, ACCESS_SECRET_HEADER];
  const sent = Array.isArray(input.accessHeaderNamesSent) ? input.accessHeaderNamesSent : [];
  const accessHeaderNamesSent = sent.filter((name) =>
    known.some((k) => k.toLowerCase() === name.toLowerCase()),
  );
  const unexpectedHeaderCount = sent.length - accessHeaderNamesSent.length;

  const evidence = {
    task: TLS_HEALTHZ_TASK,
    harness: "deploy/acceptance/worker-health/tls-healthz-acceptance.mjs",
    schemaVersion: TLS_HEALTHZ_SCHEMA_VERSION,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,

    // The endpoint is described, never identified. The health path is the
    // contract's constant; whether it was REQUESTED is `requestAttempted`.
    tlsOrigin: "<withheld>",
    healthPath: TLS_HEALTHZ_PATH,

    // Pre-request validation.
    targetAccepted: input.targetAccepted,
    suppliedScheme: input.suppliedScheme,
    accessCredentialPresence: input.accessCredentialPresence,
    accessCredentialPairSupplied: input.accessCredentialPresence === "both",

    // The request itself. `httpsUsed` and `tlsVerification: "enabled"` are only
    // ever recorded for a request that was actually attempted.
    requestAttempted: input.requestAttempted === true,
    httpsUsed: input.requestAttempted === true ? input.httpsUsed === true : null,
    tlsVerification: input.tlsVerification,
    accessHeaderNamesSent,
    unexpectedHeaderCount,
    workerHmacEmitted: false,

    // The response.
    responseReceived: input.responseReceived === true,
    httpStatus: input.httpStatus,
    redirectObserved: input.redirectObserved,
    bodyWithinLimit: input.bodyWithinLimit,
    healthyBodyMatched: input.healthyBodyMatched,

    outcome: input.outcome,
    detail: input.detail,
    verdict: pass ? "PASS" : "FAIL",
  };

  return {
    pass,
    outcome: input.outcome,
    detail: input.detail,
    status: input.httpStatus,
    evidence,
  };
}
