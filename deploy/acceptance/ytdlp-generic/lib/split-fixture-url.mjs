// The SPLIT-06 EXACT-FIXTURE URL validator.
//
// ── What this is, and what it emphatically is not ──────────────────────────
//
// Production's `assertSafeUrl` correctly REFUSES loopback and private
// destinations, and SPLIT-06 does not weaken it, patch it, or route around it
// in Production code. This validator is injected into the analysis and
// acquisition modules' existing `validateUrl` test seam, for the acceptance run
// only, because the whole point of the harness is that its media comes from a
// deterministic service inside a `--network none` container — which means
// loopback, which is exactly what the production policy exists to reject.
//
// SPLIT-06 therefore proves NOTHING about SSRF policy. That policy has its own
// independent coverage, and this module must never be cited as evidence for it.
//
// ── Why it is narrower than "allow loopback" ───────────────────────────────
//
// A validator that accepted 127.0.0.0/8, or `localhost`, or any private
// address, would be a general-purpose hole that a future acceptance case could
// lean on by accident. This one is built from the running fixture service's
// OWN address and route table, so the set of URLs it admits is a handful of
// exact strings that did not exist before this process started listening:
//
//   scheme    exactly `http:`                   (no https, no file:, no data:)
//   hostname  exactly `127.0.0.1`               (never `localhost`, never ::1)
//   port      exactly the ephemeral fixture port
//   pathname  exactly one of the declared fixture routes
//   no userinfo, no query, no fragment
//
// Anything else — including a different loopback port, a different private
// address, and the same path on a different host — is refused with the same
// `INVALID_URL` an unsafe URL gets from Production.

import { AppError } from "../../../../src/lib/errors.ts";

/** The one hostname family this validator will ever admit. */
export const FIXTURE_HOSTNAME = "127.0.0.1";

/** The one scheme. `https:` is refused too: the fixture does not serve TLS. */
export const FIXTURE_PROTOCOL = "http:";

/**
 * Builds the validator for ONE running fixture service.
 *
 * @param {object} opts
 * @param {number} opts.port    the ephemeral port the service actually bound
 * @param {readonly string[]} opts.routes the exact pathnames it declares
 */
export function createExactFixtureUrlValidator({ port, routes }) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("the fixture validator needs the exact bound port");
  }
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("the fixture validator needs the exact route set");
  }
  for (const route of routes) {
    if (typeof route !== "string" || !route.startsWith("/") || route.includes("*")) {
      throw new Error(`refusing a fixture route that is not an exact path: ${route}`);
    }
  }
  const allowed = new Set(routes);
  const origin = `${FIXTURE_PROTOCOL}//${FIXTURE_HOSTNAME}:${port}`;

  /**
   * The same contract Production's `assertSafeUrl` has: resolve to the exact
   * URL that may be executed plus the hostname metadata records, or throw.
   */
  const validate = async (raw) => {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new AppError("INVALID_URL");
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError("INVALID_URL");
    }
    if (url.protocol !== FIXTURE_PROTOCOL) throw new AppError("INVALID_URL");
    if (url.hostname !== FIXTURE_HOSTNAME) throw new AppError("INVALID_URL");
    if (url.port !== String(port)) throw new AppError("INVALID_URL");
    // Credentials in a URL are not a fixture address; nor is a query or a
    // fragment, because the exact string admitted here is the exact string
    // handed to yt-dlp.
    if (url.username !== "" || url.password !== "") throw new AppError("INVALID_URL");
    if (url.search !== "" || url.hash !== "") throw new AppError("INVALID_URL");
    if (!allowed.has(url.pathname)) throw new AppError("INVALID_URL");

    // The canonical serialization, so an equivalent-but-differently-spelled
    // input cannot become a different argv string than the one admitted.
    return { url: `${origin}${url.pathname}`, hostname: FIXTURE_HOSTNAME };
  };

  validate.origin = origin;
  validate.routes = Object.freeze([...allowed]);
  /** The exact URL for one declared route. Refuses an undeclared one. */
  validate.urlFor = (route) => {
    if (!allowed.has(route)) throw new Error(`${route} is not a declared fixture route`);
    return `${origin}${route}`;
  };
  return validate;
}
