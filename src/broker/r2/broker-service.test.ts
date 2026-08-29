import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { R2CredentialBroker, r2EndpointHost, type R2BrokerConfig } from "./broker-service.ts";
import { decodeSessionTokenClaims } from "./temporary-credentials.ts";
import {
  R2_CREDENTIAL_TTL_CEILING_SECONDS,
  R2_CREDENTIAL_TTL_MIN_SECONDS,
  R2_CREDENTIAL_TTL_HARD_CAP_SECONDS,
  R2_FORBIDDEN_ACTIONS,
} from "../../shared/worker/r2-broker.ts";

/**
 * The broker's refusal surface.
 *
 * The broker is the trusted side of the boundary, so every test here treats the
 * incoming request as hostile input from a potentially compromised media
 * container. All credentials are fake and deterministic.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "videofetch-objects";
const OTHER_BUCKET = "videofetch-other";
const JOB_ID = "a".repeat(32);
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/${"b".repeat(32)}`;
const NOW_MS = 1_700_000_000_000;

const CONFIG: R2BrokerConfig = {
  accountId: ACCOUNT_ID,
  bucket: BUCKET,
  jurisdiction: "default",
  parentAccessKeyId: "fake-parent-access-key-id",
  parentSecretAccessKey: "fake-parent-secret-access-key-do-not-use",
};

function makeBroker(overrides: Partial<ConstructorParameters<typeof R2CredentialBroker>[0]> = {}) {
  return new R2CredentialBroker({ config: CONFIG, clock: () => NOW_MS, ...overrides });
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return { bucket: BUCKET, objectKey: OBJECT_KEY, action: "PutObject", ttlSeconds: 300, ...overrides };
}

describe("R2 credential broker", () => {
  it("accepts an exact valid object key and mints a scoped credential", () => {
    const decision = makeBroker().handle(validRequest());

    assert.equal(decision.ok, true);
    if (!decision.ok) return;

    assert.equal(decision.response.action, "PutObject");
    assert.equal(decision.response.bucket, BUCKET);
    assert.equal(decision.response.objectKey, OBJECT_KEY);
    assert.equal(decision.response.expiresAt, (Math.floor(NOW_MS / 1000) + 300) * 1000);
    assert.ok(decision.response.sessionToken.length > 0, "a session token is always issued");

    const claims = decodeSessionTokenClaims(decision.response.sessionToken);
    assert.deepEqual(claims.actions, ["PutObject"]);
    assert.deepEqual(claims.paths.objectPaths, [OBJECT_KEY]);
    assert.deepEqual(claims.paths.prefixPaths, []);
  });

  describe("rejects before any parent key material is touched", () => {
    /** Fails the test if the mint path is reached at all. */
    function neverMint() {
      return makeBroker({
        mintImpl: () => {
          assert.fail("the broker must refuse before minting");
        },
      });
    }

    it("a malformed object key", () => {
      const malformed = [
        "",
        "videofetch/jobs/short/abc",
        `videofetch/jobs/${JOB_ID}`,
        `videofetch/jobs/${JOB_ID}/${"b".repeat(31)}`,
        `videofetch/jobs/${JOB_ID}/${"B".repeat(32)}`,
        `videofetch/jobs/${JOB_ID}/${"b".repeat(32)}/extra`,
        `../videofetch/jobs/${JOB_ID}/${"b".repeat(32)}`,
        `videofetch/jobs/${JOB_ID}/${"b".repeat(32)}\n`,
        "other-prefix/jobs/" + JOB_ID + "/" + "b".repeat(32),
        null,
        42,
        {},
        [],
      ];
      for (const objectKey of malformed) {
        const decision = neverMint().handle(validRequest({ objectKey }));
        assert.equal(decision.ok, false, `must refuse key ${JSON.stringify(objectKey)}`);
        if (!decision.ok) assert.equal(decision.code, "invalid_object_key");
      }
    });

    it("a different bucket", () => {
      for (const bucket of [OTHER_BUCKET, "", "videofetch-objects-2", null, 7]) {
        const decision = neverMint().handle(validRequest({ bucket }));
        assert.equal(decision.ok, false, `must refuse bucket ${JSON.stringify(bucket)}`);
        if (!decision.ok) assert.equal(decision.code, "unauthorized_bucket");
      }
    });

    it("any action outside the three delegated operations", () => {
      for (const action of [...R2_FORBIDDEN_ACTIONS, "putobject", "PUTOBJECT", "", null, 1]) {
        const decision = neverMint().handle(validRequest({ action }));
        assert.equal(decision.ok, false, `must refuse action ${JSON.stringify(action)}`);
        if (!decision.ok) assert.equal(decision.code, "unauthorized_action");
      }
    });

    it("a TTL outside the global window", () => {
      for (const ttlSeconds of [
        0,
        -1,
        1.5,
        R2_CREDENTIAL_TTL_MIN_SECONDS - 1,
        R2_CREDENTIAL_TTL_HARD_CAP_SECONDS + 1,
        Number.MAX_SAFE_INTEGER,
        "300",
        null,
      ]) {
        const decision = neverMint().handle(validRequest({ ttlSeconds }));
        assert.equal(decision.ok, false, `must refuse ttl ${JSON.stringify(ttlSeconds)}`);
        if (!decision.ok) assert.equal(decision.code, "invalid_ttl");
      }
    });

    it("a TTL above the ceiling for the requested action", () => {
      // A head or delete may not borrow the upload window.
      for (const action of ["HeadObject", "DeleteObject"] as const) {
        const decision = neverMint().handle(
          validRequest({ action, ttlSeconds: R2_CREDENTIAL_TTL_CEILING_SECONDS[action] + 1 }),
        );
        assert.equal(decision.ok, false);
        if (!decision.ok) assert.equal(decision.code, "invalid_ttl");
      }
    });

    it("an unknown field, rather than silently ignoring it", () => {
      for (const extra of [
        { scope: "admin-read-write" },
        { actions: ["GetObject"] },
        { prefixPaths: ["videofetch/"] },
        { permission: "object-read-write" },
      ]) {
        const decision = neverMint().handle(validRequest(extra));
        assert.equal(decision.ok, false, `must refuse extra field ${JSON.stringify(extra)}`);
        if (!decision.ok) assert.equal(decision.code, "malformed_request");
      }
    });

    it("a non-object request", () => {
      for (const raw of [null, undefined, "", "PutObject", 42, [], [validRequest()]]) {
        const decision = neverMint().handle(raw);
        assert.equal(decision.ok, false);
        if (!decision.ok) assert.equal(decision.code, "malformed_request");
      }
    });
  });

  it("independently enforces the per-action TTL contract at its exact boundaries", () => {
    // The broker cannot verify deadline-boundness — it has no job store — but
    // it CAN verify the bounds, and it does so without trusting the request.
    for (const action of ["PutObject", "HeadObject", "DeleteObject"] as const) {
      const ceiling = R2_CREDENTIAL_TTL_CEILING_SECONDS[action];

      // The exact boundaries are accepted.
      for (const ttlSeconds of [R2_CREDENTIAL_TTL_MIN_SECONDS, ceiling]) {
        const decision = makeBroker().handle(validRequest({ action, ttlSeconds }));
        assert.equal(decision.ok, true, `${action} must accept ttl ${ttlSeconds}`);
      }

      // One second past either boundary is refused, never clamped into range.
      for (const ttlSeconds of [R2_CREDENTIAL_TTL_MIN_SECONDS - 1, ceiling + 1]) {
        const decision = makeBroker({
          mintImpl: () => assert.fail("an out-of-contract TTL must never be minted"),
        }).handle(validRequest({ action, ttlSeconds }));
        assert.equal(decision.ok, false, `${action} must refuse ttl ${ttlSeconds}`);
        if (!decision.ok) assert.equal(decision.code, "invalid_ttl");
      }
    }

    // A Head or Delete may not borrow the larger PutObject window.
    for (const action of ["HeadObject", "DeleteObject"] as const) {
      const decision = makeBroker().handle(
        validRequest({ action, ttlSeconds: R2_CREDENTIAL_TTL_CEILING_SECONDS.PutObject }),
      );
      assert.equal(decision.ok, false, `${action} must not reach the Put ceiling`);
      if (!decision.ok) assert.equal(decision.code, "invalid_ttl");
    }
  });

  it("fails closed when the minter itself throws", () => {
    const decision = makeBroker({
      mintImpl: () => {
        throw new Error("signing subsystem exploded with secret-bearing detail");
      },
    }).handle(validRequest());

    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, "mint_failed");
    // The raw error never travels: the decision carries a bare category.
    assert.equal(JSON.stringify(decision).includes("secret-bearing"), false);
  });

  it("reports only a category to the observer, never a value", () => {
    const seen: Array<[string, string | null]> = [];
    const broker = makeBroker({ observer: (outcome, code) => seen.push([outcome, code]) });

    broker.handle(validRequest());
    broker.handle(validRequest({ bucket: OTHER_BUCKET }));
    broker.handle(validRequest({ objectKey: "not-a-key" }));

    assert.deepEqual(seen, [
      ["minted", null],
      ["refused", "unauthorized_bucket"],
      ["refused", "invalid_object_key"],
    ]);

    // Nothing the observer received can identify an object, bucket or secret.
    const flattened = JSON.stringify(seen);
    assert.equal(flattened.includes(OBJECT_KEY), false);
    assert.equal(flattened.includes(OTHER_BUCKET), false);
    assert.equal(flattened.includes(CONFIG.parentSecretAccessKey), false);
  });

  it("derives the endpoint host per jurisdiction", () => {
    assert.equal(r2EndpointHost(ACCOUNT_ID, "default"), `${ACCOUNT_ID}.r2.cloudflarestorage.com`);
    assert.equal(r2EndpointHost(ACCOUNT_ID, "eu"), `${ACCOUNT_ID}.eu.r2.cloudflarestorage.com`);
    assert.equal(r2EndpointHost(ACCOUNT_ID, "us"), `${ACCOUNT_ID}.us.r2.cloudflarestorage.com`);
  });

  it("binds the minted credential to the broker's own bucket, not the request's", () => {
    // Even a request that matches is not the source of truth: the claims are
    // built from the broker's configuration.
    const decision = makeBroker().handle(validRequest());
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decodeSessionTokenClaims(decision.response.sessionToken).bucket, BUCKET);
  });
});
