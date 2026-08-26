import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../errors.ts";
import {
  ACCESS_COOKIE_NAME,
  PRIVATE_ACCESS_PRINCIPAL,
  PRIVATE_ACCESS_PRINCIPAL_ID,
  authenticateAccessSecret,
  describeAccessSession,
  getAccessMode,
  mintSessionToken,
  readAccessCookie,
  requireConfiguredPrivateAccess,
  requirePrivateAccess,
  secretsEqual,
  serializeAccessCookie,
  serializeClearedAccessCookie,
  setPrivateAccessNowForTests,
  setPrivateAccessTestEnv,
  verifySessionToken,
} from "./private-access.server.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210";

function requestWith(init?: {
  cookie?: string;
  site?: string;
  method?: string;
  headers?: Record<string, string>;
}): Request {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  if (init?.site) headers.set("sec-fetch-site", init.site);
  return new Request("https://videofetch.example/api/analyze", {
    method: init?.method ?? "POST",
    headers,
  });
}

describe("private access secret handling", () => {
  afterEach(() => {
    setPrivateAccessTestEnv(null);
    setPrivateAccessNowForTests(null);
  });

  it("fails closed when the production secret is missing", () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: undefined });
    assert.equal(getAccessMode().kind, "not-configured");
    assert.throws(
      () => requirePrivateAccess(requestWith()),
      (err: unknown) => err instanceof AppError && err.code === "ACCESS_NOT_CONFIGURED" && err.status === 503,
    );
  });

  it("uses an explicit development bypass when no secret is configured", () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: undefined });
    assert.equal(getAccessMode().kind, "development-bypass");
    const principal = requirePrivateAccess(requestWith());
    assert.equal(principal.id, PRIVATE_ACCESS_PRINCIPAL_ID);
    assert.deepEqual(principal, PRIVATE_ACCESS_PRINCIPAL);
  });

  it("enforces the gate when a valid secret is configured", () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: SECRET });
    assert.equal(getAccessMode().kind, "configured");
    assert.throws(
      () => requirePrivateAccess(requestWith()),
      (err: unknown) => err instanceof AppError && err.code === "ACCESS_REQUIRED" && err.status === 401,
    );
  });

  it("fails closed when a configured secret is below the minimum strength", () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: "too-short" });
    assert.equal(getAccessMode().kind, "not-configured");
    assert.throws(
      () => requirePrivateAccess(requestWith()),
      (err: unknown) => err instanceof AppError && err.code === "ACCESS_NOT_CONFIGURED",
    );
  });

  it("does not treat a short production secret as a public bypass", () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: "short" });
    assert.equal(getAccessMode().kind, "not-configured");
    assert.throws(
      () => requirePrivateAccess(requestWith()),
      (err: unknown) => err instanceof AppError && err.code === "ACCESS_NOT_CONFIGURED",
    );
  });

  it("rejects the wrong secret and accepts the correct secret", () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    assert.throws(
      () => authenticateAccessSecret("wrong-secret"),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "ACCESS_REQUIRED" &&
        err.status === 401 &&
        !err.message.includes("32") &&
        !err.message.includes("length"),
    );
    const token = authenticateAccessSecret(SECRET);
    assert.equal(verifySessionToken(SECRET, token), true);
  });
});

describe("private access session token", () => {
  afterEach(() => {
    setPrivateAccessTestEnv(null);
    setPrivateAccessNowForTests(null);
  });

  it("accepts a valid token", () => {
    const token = mintSessionToken(SECRET);
    assert.equal(verifySessionToken(SECRET, token), true);
  });

  it("rejects an expired token", () => {
    const issuedAt = 1_700_000_000_000;
    const token = mintSessionToken(SECRET, issuedAt);
    setPrivateAccessNowForTests(() => issuedAt + 8 * 24 * 60 * 60 * 1000);
    assert.equal(verifySessionToken(SECRET, token, issuedAt + 8 * 24 * 60 * 60 * 1000), false);
  });

  it("rejects a modified expiry", () => {
    const token = mintSessionToken(SECRET);
    const [version, expiry, mac] = token.split(".");
    const tampered = `${version}.${Number(expiry) + 99_999}.${mac}`;
    assert.equal(verifySessionToken(SECRET, tampered), false);
  });

  it("rejects a modified MAC", () => {
    const token = mintSessionToken(SECRET);
    const [version, expiry, mac] = token.split(".");
    const flipped = (mac ?? "").replace(/[A-Za-z]/, (ch) => (ch === "A" ? "B" : "A"));
    assert.equal(verifySessionToken(SECRET, `${version}.${expiry}.${flipped}`), false);
  });

  it("rejects a token after secret rotation", () => {
    const token = mintSessionToken(SECRET);
    assert.equal(verifySessionToken(OTHER_SECRET, token), false);
  });

  it("does not embed the raw configured secret in the token", () => {
    const token = mintSessionToken(SECRET);
    assert.equal(token.includes(SECRET), false);
    assert.match(token, /^v1\.[0-9]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("private access cookie", () => {
  it("serializes HttpOnly Secure SameSite=Strict Path=/ without Domain", () => {
    const token = mintSessionToken(SECRET);
    const header = serializeAccessCookie(token);
    assert.match(header, new RegExp(`^${ACCESS_COOKIE_NAME}=`));
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Path=\//);
    assert.equal(/Domain=/i.test(header), false);
    assert.equal(header.includes(SECRET), false);
    assert.equal(readAccessCookie(requestWith({ cookie: header.split(";")[0] })), token);
  });

  it("clears the cookie without a Domain attribute", () => {
    const header = serializeClearedAccessCookie();
    assert.match(header, new RegExp(`^${ACCESS_COOKIE_NAME}=;`));
    assert.match(header, /Max-Age=0/);
    assert.equal(/Domain=/i.test(header), false);
  });
});

describe("private access request isolation", () => {
  afterEach(() => {
    setPrivateAccessTestEnv(null);
    setPrivateAccessNowForTests(null);
  });

  function authedRequest(site?: string): Request {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const token = mintSessionToken(SECRET);
    return requestWith({
      cookie: `${ACCESS_COOKIE_NAME}=${token}`,
      site,
    });
  }

  it("allows same-origin requests with a valid session", () => {
    const principal = requirePrivateAccess(authedRequest("same-origin"));
    assert.equal(principal.id, PRIVATE_ACCESS_PRINCIPAL_ID);
  });

  it("allows Sec-Fetch-Site none with a valid session", () => {
    assert.doesNotThrow(() => requirePrivateAccess(authedRequest("none")));
  });

  it("allows a missing Sec-Fetch-Site header with a valid session", () => {
    assert.doesNotThrow(() => requirePrivateAccess(authedRequest()));
  });

  it("rejects same-site scripted requests even with a valid cookie", () => {
    assert.throws(
      () => requirePrivateAccess(authedRequest("same-site")),
      (err: unknown) => err instanceof AppError && err.code === "FORBIDDEN" && err.status === 403,
    );
  });

  it("rejects cross-site scripted requests even with a valid cookie", () => {
    assert.throws(
      () => requirePrivateAccess(authedRequest("cross-site")),
      (err: unknown) => err instanceof AppError && err.code === "FORBIDDEN" && err.status === 403,
    );
  });
});

describe("private access session descriptor", () => {
  afterEach(() => {
    setPrivateAccessTestEnv(null);
    setPrivateAccessNowForTests(null);
  });

  it("reports development bypass", () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: undefined });
    assert.deepEqual(describeAccessSession(requestWith()), {
      authenticated: false,
      configured: false,
      developmentBypass: true,
    });
  });

  it("reports production misconfiguration", () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: undefined });
    assert.deepEqual(describeAccessSession(requestWith()), {
      authenticated: false,
      configured: false,
      developmentBypass: false,
    });
  });

  it("reports unauthenticated when configured without a cookie", () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    assert.deepEqual(describeAccessSession(requestWith()), {
      authenticated: false,
      configured: true,
      developmentBypass: false,
    });
  });

  it("reports authenticated when the cookie verifies", () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const token = mintSessionToken(SECRET);
    assert.deepEqual(
      describeAccessSession(requestWith({ cookie: `${ACCESS_COOKIE_NAME}=${token}` })),
      { authenticated: true, configured: true, developmentBypass: false },
    );
  });
});

describe("secret comparison", () => {
  it("accepts equal secrets and rejects unequal secrets", () => {
    assert.equal(secretsEqual(SECRET, SECRET), true);
    assert.equal(secretsEqual("abc", SECRET), false);
  });
});

describe("private access principal", () => {
  afterEach(() => {
    setPrivateAccessTestEnv(null);
    setPrivateAccessNowForTests(null);
  });

  function authedRequest(headers?: Record<string, string>): Request {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const token = mintSessionToken(SECRET);
    return requestWith({
      cookie: `${ACCESS_COOKIE_NAME}=${token}`,
      site: "same-origin",
      headers,
    });
  }

  it("returns the fixed server principal for a valid configured session", () => {
    const principal = requirePrivateAccess(authedRequest());
    assert.equal(principal.id, "private-access-user");
    assert.deepEqual(principal, PRIVATE_ACCESS_PRINCIPAL);
  });

  it("returns the same principal under development bypass", () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: undefined });
    const principal = requirePrivateAccess(requestWith());
    assert.equal(principal.id, PRIVATE_ACCESS_PRINCIPAL_ID);
    assert.deepEqual(principal, PRIVATE_ACCESS_PRINCIPAL);
  });

  it("does not return a principal for an invalid session", () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    let returned: unknown;
    try {
      returned = requirePrivateAccess(requestWith());
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "ACCESS_REQUIRED");
      returned = "threw";
    }
    assert.equal(returned, "threw");
  });

  it("does not derive the principal from forwarded address headers", () => {
    const first = requirePrivateAccess(
      authedRequest({
        "x-forwarded-for": "1.1.1.1",
        "x-real-ip": "2.2.2.2",
        forwarded: "for=3.3.3.3",
        "x-vercel-forwarded-for": "4.4.4.4",
        "cf-connecting-ip": "5.5.5.5",
        "true-client-ip": "6.6.6.6",
      }),
    );
    const second = requirePrivateAccess(
      authedRequest({
        "x-forwarded-for": "8.8.8.8",
        "x-real-ip": "9.9.9.9",
        forwarded: "for=10.10.10.10",
        "x-vercel-forwarded-for": "11.11.11.11",
        "cf-connecting-ip": "12.12.12.12",
        "true-client-ip": "13.13.13.13",
      }),
    );
    assert.equal(first.id, PRIVATE_ACCESS_PRINCIPAL_ID);
    assert.deepEqual(first, second);
  });
});

describe("configured private access for diagnostics", () => {
  afterEach(() => {
    setPrivateAccessTestEnv(null);
    setPrivateAccessNowForTests(null);
  });

  it("rejects development bypass and requires a configured secret", () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: undefined });
    assert.doesNotThrow(() => requirePrivateAccess(requestWith()));
    assert.throws(
      () => requireConfiguredPrivateAccess(requestWith()),
      (err: unknown) => err instanceof AppError && err.code === "ACCESS_NOT_CONFIGURED" && err.status === 503,
    );
  });

  it("rejects production and test environments without a secret", () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: undefined });
    assert.throws(
      () => requireConfiguredPrivateAccess(requestWith()),
      (err: unknown) => err instanceof AppError && err.code === "ACCESS_NOT_CONFIGURED",
    );
    setPrivateAccessTestEnv({ nodeEnv: "test", secret: undefined });
    assert.throws(
      () => requireConfiguredPrivateAccess(requestWith()),
      (err: unknown) => err instanceof AppError && err.code === "ACCESS_NOT_CONFIGURED",
    );
  });

  it("returns the private principal for a valid configured session", () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: SECRET });
    const token = mintSessionToken(SECRET);
    const principal = requireConfiguredPrivateAccess(
      requestWith({ cookie: `${ACCESS_COOKIE_NAME}=${token}`, site: "same-origin" }),
    );
    assert.deepEqual(principal, PRIVATE_ACCESS_PRINCIPAL);
  });

  it("rejects a missing session even when the secret is configured", () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: SECRET });
    assert.throws(
      () => requireConfiguredPrivateAccess(requestWith({ site: "same-origin" })),
      (err: unknown) => err instanceof AppError && err.code === "ACCESS_REQUIRED" && err.status === 401,
    );
  });

  it("rejects cross-site requests even with a valid cookie", () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const token = mintSessionToken(SECRET);
    assert.throws(
      () =>
        requireConfiguredPrivateAccess(
          requestWith({ cookie: `${ACCESS_COOKIE_NAME}=${token}`, site: "cross-site" }),
        ),
      (err: unknown) => err instanceof AppError && err.code === "FORBIDDEN",
    );
  });
});
