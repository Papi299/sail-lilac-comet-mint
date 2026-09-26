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

/** The schema version of the evidence record this module produces. */
export const TLS_HEALTHZ_SCHEMA_VERSION = "worker-tls-healthz-01";

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

  // HTTPS ONLY. The whole point of this acceptance is the TLS path, so `http:`
  // is not downgraded-but-accepted; it is refused.
  if (url.protocol !== "https:") {
    return { error: `the origin must use https:, got '${url.protocol}'` };
  }

  // Embedded credentials would travel in the request AND into any rendering of
  // the URL. Refused outright rather than stripped.
  if (url.username.length > 0 || url.password.length > 0) {
    return { error: "the origin must not embed credentials" };
  }

  if (url.search.length > 0) {
    return { error: "the origin must not carry a query string" };
  }
  if (url.hash.length > 0) {
    return { error: "the origin must not carry a fragment" };
  }

  if (url.pathname !== "/" && url.pathname !== TLS_HEALTHZ_PATH) {
    return {
      error: `the origin path must be empty, '/' or exactly '${TLS_HEALTHZ_PATH}'`,
    };
  }

  const target = new URL(TLS_HEALTHZ_PATH, `${url.protocol}//${url.host}`);
  return { url: target.toString(), host: url.host, protocol: url.protocol };
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
 * Judges the response.
 *
 * A REDIRECT IS A FAILURE, and is reported as its own outcome rather than folded
 * into "non-200". `redirect: "manual"` means a 3xx arrives here intact, and
 * following it would let an Access login page, a zone-level redirect or a
 * misrouted hostname answer on behalf of the Worker — the single most likely way
 * for this acceptance to produce a false PASS.
 */
export function evaluateHealthzResponse({ status, bodyText }) {
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
    return {
      outcome: TLS_HEALTHZ_OUTCOMES.BAD_STATUS,
      detail: `expected HTTP 200, got ${status}`,
    };
  }

  const text = typeof bodyText === "string" ? bodyText : "";
  if (Buffer.byteLength(text, "utf8") > TLS_HEALTHZ_MAX_BODY_BYTES) {
    return {
      outcome: TLS_HEALTHZ_OUTCOMES.BODY_TOO_LARGE,
      detail: `response body exceeded ${TLS_HEALTHZ_MAX_BODY_BYTES} bytes`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A well-formed HTML login page is the classic wrong answer here, and it
    // fails at exactly this line.
    return {
      outcome: TLS_HEALTHZ_OUTCOMES.MALFORMED_BODY,
      detail: "response body is not valid JSON",
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      outcome: TLS_HEALTHZ_OUTCOMES.MALFORMED_BODY,
      detail: "response body is not a JSON object",
    };
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
  const startedAt = now().toISOString();

  const tls = assertTlsVerificationEnabled(env);
  if (tls.error) {
    return finalize({
      outcome: TLS_HEALTHZ_OUTCOMES.TLS_VERIFICATION_DISABLED,
      detail: tls.error,
      startedAt,
      finishedAt: now().toISOString(),
    });
  }

  const target = resolveHealthzTarget(origin);
  if (target.error) {
    return finalize({
      outcome: TLS_HEALTHZ_OUTCOMES.TARGET_REFUSED,
      detail: target.error,
      startedAt,
      finishedAt: now().toISOString(),
    });
  }

  const access = buildAccessHeaders({
    clientId: accessClientId,
    clientSecret: accessClientSecret,
  });
  if (access.error) {
    // FAIL CLOSED BEFORE ANY REQUEST. Nothing is dialled, so an incomplete
    // credential pair cannot be observed by the endpoint at all.
    return finalize({
      outcome: TLS_HEALTHZ_OUTCOMES.CREDENTIALS_INCOMPLETE,
      detail: access.error,
      accessPairSupplied: false,
      startedAt,
      finishedAt: now().toISOString(),
    });
  }

  const headers = { accept: "application/json", ...access.headers };

  let status;
  let bodyText = "";
  try {
    const response = await fetchImpl(target.url, {
      method: "GET",
      headers,
      // A 3xx must ARRIVE here so it can be judged. Following it is how a login
      // page becomes a false PASS.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    bodyText = await response.text();
  } catch (err) {
    // A certificate failure lands here too, which is the intended behaviour: an
    // untrusted endpoint is a FAILED acceptance, never a skipped check. The
    // error's own message is not recorded — it can carry the hostname.
    return finalize({
      outcome: TLS_HEALTHZ_OUTCOMES.TRANSPORT_FAILED,
      detail: `the HTTPS request did not complete (${err?.name ?? "error"})`,
      accessPairSupplied: access.supplied,
      headerNames: Object.keys(access.headers),
      startedAt,
      finishedAt: now().toISOString(),
    });
  }

  const verdict = evaluateHealthzResponse({ status, bodyText });
  return finalize({
    outcome: verdict.outcome,
    detail: verdict.detail,
    status,
    redirected: verdict.redirected === true,
    accessPairSupplied: access.supplied,
    headerNames: Object.keys(access.headers),
    startedAt,
    finishedAt: now().toISOString(),
  });
}

/**
 * Assembles the deliberately narrow evidence record.
 *
 * AN ALLOWLIST, NOT A FILTERED DUMP. Every field is named here, so nothing can
 * arrive by being spread in from a response, a header bag or an error object.
 *
 * Never recorded, by construction rather than by redaction:
 *
 *   * the Worker hostname or origin  — the repository never commits the
 *                                      Production Worker hostname, so the
 *                                      record states only that HTTPS was used
 *   * the Access Client Id           — a credential half
 *   * the Access Client Secret       — a credential half
 *   * any header VALUE               — only header NAMES, and only the Access
 *                                      pair's names
 *   * cookies, signed URLs, HMAC keys, R2 credentials, Cloudflare identifiers
 *   * the response body              — only whether it matched
 */
function finalize(input) {
  const {
    outcome,
    detail,
    status = null,
    redirected = false,
    accessPairSupplied = false,
    headerNames = [],
    startedAt,
    finishedAt,
  } = input;

  const pass = outcome === TLS_HEALTHZ_OUTCOMES.HEALTHY;

  // Header NAMES only, and only ones from the known Access pair. An unexpected
  // name is reported as a count, never as text, so a future edit that attached
  // some other header cannot write it into the record.
  const known = [ACCESS_ID_HEADER, ACCESS_SECRET_HEADER];
  const accessHeaderNames = headerNames.filter((name) =>
    known.some((k) => k.toLowerCase() === name.toLowerCase()),
  );
  const unexpectedHeaderCount = headerNames.length - accessHeaderNames.length;

  const evidence = {
    task: TLS_HEALTHZ_TASK,
    harness: "deploy/acceptance/worker-health/tls-healthz-acceptance.mjs",
    schemaVersion: TLS_HEALTHZ_SCHEMA_VERSION,
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,

    // The endpoint is described, never identified.
    httpsUsed: true,
    tlsVerification: "enabled",
    tlsOrigin: "<withheld>",
    requestedPath: TLS_HEALTHZ_PATH,

    // Presence only, in the style of `describePresence`: no value, no length,
    // no hash.
    accessCredentialPairSupplied: accessPairSupplied,
    accessHeaderNames,
    unexpectedHeaderCount,
    workerHmacEmitted: false,

    httpStatus: status,
    redirectObserved: redirected,
    healthyBodyMatched: pass,

    outcome,
    detail,
    verdict: pass ? "PASS" : "FAIL",
  };

  return { pass, outcome, detail, status, evidence };
}
