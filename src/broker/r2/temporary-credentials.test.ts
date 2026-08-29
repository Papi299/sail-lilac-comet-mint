import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import {
  R2_TEMPORARY_CREDENTIAL_SCOPE,
  R2TemporaryCredentialError,
  buildTemporaryCredentialClaims,
  decodeSessionTokenClaims,
  mintTemporaryCredential,
  signCompactJwtHs256,
  type MintTemporaryCredentialInput,
} from "./temporary-credentials.ts";
import {
  R2_CREDENTIAL_TTL_FLOOR_SECONDS,
  R2_CREDENTIAL_TTL_HARD_CAP_SECONDS,
  R2_FORBIDDEN_ACTIONS,
} from "../../shared/worker/r2-broker.ts";

/**
 * Local-signing minter (WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001).
 *
 * Every credential here is derived from FAKE, deterministic material. Nothing
 * in this file contacts Cloudflare, and no real R2 token exists.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PARENT_ACCESS_KEY_ID = "fake-parent-access-key-id";
const PARENT_SECRET = "fake-parent-secret-access-key-do-not-use";
const BUCKET = "videofetch-objects";
const OBJECT_KEY = `videofetch/jobs/${"a".repeat(32)}/${"b".repeat(32)}`;
const ENDPOINT_HOST = `${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const NOW_MS = 1_700_000_000_000;

function input(overrides: Partial<MintTemporaryCredentialInput> = {}): MintTemporaryCredentialInput {
  return {
    accountId: ACCOUNT_ID,
    parentAccessKeyId: PARENT_ACCESS_KEY_ID,
    parentSecretAccessKey: PARENT_SECRET,
    bucket: BUCKET,
    objectKey: OBJECT_KEY,
    action: "PutObject",
    endpointHost: ENDPOINT_HOST,
    ttlSeconds: 300,
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe("R2 temporary credential local signing", () => {
  it("derives the credential exactly as Cloudflare's local-signing scheme specifies", () => {
    const credential = mintTemporaryCredential(input());

    // 1. The parent ACCESS KEY ID (an identifier, not a secret) is reused.
    assert.equal(credential.accessKeyId, PARENT_ACCESS_KEY_ID);

    // 2. The derived secret is the SHA-256 hex digest of the signed JWT.
    const decoded = Buffer.from(credential.sessionToken, "base64").toString("utf8");
    assert.ok(decoded.startsWith("jwt/"), "session token is a jwt/ token");
    const jwt = decoded.slice("jwt/".length);
    assert.equal(credential.secretAccessKey, createHash("sha256").update(jwt, "utf8").digest("hex"));
    assert.match(credential.secretAccessKey, /^[0-9a-f]{64}$/);

    // 3. The session token is base64("jwt/" + <signed jwt>).
    assert.equal(credential.sessionToken, Buffer.from(`jwt/${jwt}`, "utf8").toString("base64"));

    // 4. Expiry is issued-at plus the TTL, to the second.
    assert.equal(credential.expiresAt, (Math.floor(NOW_MS / 1000) + 300) * 1000);
  });

  it("signs byte-identically to the reference jose implementation", async () => {
    // Cloudflare's own documented example signs with `jose`. Pinning that
    // equivalence means our node:crypto implementation cannot silently drift
    // from the scheme R2 will actually validate.
    const claims = buildTemporaryCredentialClaims(input());
    const ours = signCompactJwtHs256(claims, PARENT_SECRET);

    const reference = await new SignJWT({
      bucket: claims.bucket,
      scope: claims.scope,
      actions: claims.actions as unknown as string[],
      paths: {
        prefixPaths: claims.paths.prefixPaths as unknown as string[],
        objectPaths: claims.paths.objectPaths as unknown as string[],
      },
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.sub)
      .setIssuer(claims.iss)
      .setAudience(claims.aud)
      .setIssuedAt(claims.iat)
      .setExpirationTime(claims.exp)
      .sign(new TextEncoder().encode(PARENT_SECRET));

    assert.equal(ours, reference, "local signing must match the reference implementation");
  });

  it("binds the credential to exactly one action and exactly one object", () => {
    for (const action of ["PutObject", "HeadObject", "DeleteObject"] as const) {
      const claims = decodeSessionTokenClaims(
        mintTemporaryCredential(input({ action })).sessionToken,
      );

      assert.deepEqual(claims.actions, [action], "exactly one action");
      assert.deepEqual(claims.paths.objectPaths, [OBJECT_KEY], "exactly one exact object");
      assert.deepEqual(claims.paths.prefixPaths, [], "no prefix authority");
      assert.equal(claims.bucket, BUCKET);
      assert.equal(claims.scope, R2_TEMPORARY_CREDENTIAL_SCOPE);
      assert.equal(claims.sub, ACCOUNT_ID);
      assert.equal(claims.aud, ENDPOINT_HOST);
    }
  });

  it("never grants a forbidden action", () => {
    for (const action of ["PutObject", "HeadObject", "DeleteObject"] as const) {
      const credential = mintTemporaryCredential(input({ action }));
      const claims = decodeSessionTokenClaims(credential.sessionToken);

      for (const forbidden of R2_FORBIDDEN_ACTIONS) {
        assert.equal(
          (claims.actions as readonly string[]).includes(forbidden),
          false,
          `${action} credential must not carry ${forbidden}`,
        );
      }
    }
  });

  it("never emits the parent secret in any returned field", () => {
    const credential = mintTemporaryCredential(input());
    for (const field of [
      credential.accessKeyId,
      credential.secretAccessKey,
      credential.sessionToken,
    ]) {
      assert.equal(field.includes(PARENT_SECRET), false, "parent secret must never be emitted");
    }
    // Nor anywhere in the signed token's decoded body.
    const decoded = Buffer.from(credential.sessionToken, "base64").toString("utf8");
    assert.equal(decoded.includes(PARENT_SECRET), false, "parent secret is key material only");
  });

  it("produces a different credential for a different object, action or instant", () => {
    const base = mintTemporaryCredential(input());
    const otherKey = mintTemporaryCredential(
      input({ objectKey: `videofetch/jobs/${"a".repeat(32)}/${"c".repeat(32)}` }),
    );
    const otherAction = mintTemporaryCredential(input({ action: "DeleteObject" }));
    const otherTime = mintTemporaryCredential(input({ nowMs: NOW_MS + 5_000 }));

    const secrets = new Set([
      base.secretAccessKey,
      otherKey.secretAccessKey,
      otherAction.secretAccessKey,
      otherTime.secretAccessKey,
    ]);
    assert.equal(secrets.size, 4, "each scope yields distinct key material");
  });

  it("rejects every malformed input rather than signing something weaker", () => {
    assert.throws(() => mintTemporaryCredential(input({ accountId: "NOTHEX" })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ accountId: ACCOUNT_ID.toUpperCase() })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ parentAccessKeyId: "" })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ parentSecretAccessKey: "" })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ bucket: "" })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ objectKey: "" })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ endpointHost: "" })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ nowMs: 0 })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ nowMs: -1 })), R2TemporaryCredentialError);
  });

  it("refuses a TTL outside the policy window", () => {
    assert.throws(
      () => mintTemporaryCredential(input({ ttlSeconds: R2_CREDENTIAL_TTL_FLOOR_SECONDS - 1 })),
      R2TemporaryCredentialError,
    );
    assert.throws(
      () => mintTemporaryCredential(input({ ttlSeconds: R2_CREDENTIAL_TTL_HARD_CAP_SECONDS + 1 })),
      R2TemporaryCredentialError,
    );
    assert.throws(() => mintTemporaryCredential(input({ ttlSeconds: 0 })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ ttlSeconds: -300 })), R2TemporaryCredentialError);
    assert.throws(() => mintTemporaryCredential(input({ ttlSeconds: 1.5 })), R2TemporaryCredentialError);

    // The boundaries themselves are accepted.
    assert.doesNotThrow(() =>
      mintTemporaryCredential(input({ ttlSeconds: R2_CREDENTIAL_TTL_FLOOR_SECONDS })),
    );
    assert.doesNotThrow(() =>
      mintTemporaryCredential(input({ ttlSeconds: R2_CREDENTIAL_TTL_HARD_CAP_SECONDS })),
    );
  });

  it("can never mint a credential that outlives the hard cap", () => {
    const credential = mintTemporaryCredential(
      input({ ttlSeconds: R2_CREDENTIAL_TTL_HARD_CAP_SECONDS }),
    );
    const lifetimeMs = credential.expiresAt - NOW_MS;
    assert.ok(
      lifetimeMs <= R2_CREDENTIAL_TTL_HARD_CAP_SECONDS * 1000,
      "no credential may exceed the documented hard cap",
    );
  });
});
