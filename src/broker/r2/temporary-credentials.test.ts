import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import {
  R2TemporaryCredentialError,
  buildTemporaryCredentialClaims,
  decodeSessionTokenClaims,
  mintTemporaryCredential,
  signCompactJwtHs256,
  type MintTemporaryCredentialInput,
} from "./temporary-credentials.ts";
import {
  R2_CREDENTIAL_TTL_MIN_SECONDS,
  R2_CREDENTIAL_TTL_HARD_CAP_SECONDS,
  R2_FORBIDDEN_ACTIONS,
} from "../../shared/worker/r2-broker.ts";

/**
 * Local-signing minter (WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001, corrected by
 * R2-TEMP-CREDENTIAL-ACTIONS-ONLY-001).
 *
 * Every credential here is derived from FAKE, deterministic material. Nothing
 * in this file contacts Cloudflare, and no real R2 token is referenced.
 *
 * The claim shape under test is ACTION-ONLY. A live R2 endpoint rejected
 * `scope + actions` tokens with `HTTP 400 InvalidArgument` on
 * `X-Amz-Security-Token` — before authorization — and accepted action-only
 * tokens. So the assertions below do not merely omit `scope`; they fail if
 * `scope`, `permission`, or any other unexpected authority-bearing claim
 * reappears in the signed payload.
 *
 * The two exclusions rest on different evidence, and these tests should not be
 * read as claiming otherwise. `scope` is excluded because the live endpoint
 * rejects it alongside `actions`. `permission` — the Temporary Credentials API
 * spelling of the same coarse preset — is excluded on POLICY: a diagnostic live
 * token carrying `permission` + `actions` passed token parsing, so it was never
 * measured to be rejected and its authority semantics were never characterized.
 * VideoFetch refuses it because the delegated JWT should carry only the minimal
 * vocabulary this design actually understands.
 */

/**
 * Every claim the signed payload is permitted to contain.
 *
 * `bucket` / `actions` / `paths` carry the policy; the rest are the standard
 * identity and time claims. Asserting the key set EXACTLY — rather than
 * asserting the absence of a list of known-bad names — is what makes it hard to
 * add a new authority-bearing claim without a test noticing.
 */
const EXPECTED_CLAIM_KEYS = [
  "bucket",
  "actions",
  "paths",
  "sub",
  "iss",
  "aud",
  "iat",
  "exp",
].sort();

/**
 * Coarse preset claims this design never signs.
 *
 * `scope` is known-invalid alongside `actions` at the live endpoint;
 * `permission` is excluded as an unapproved coarse claim, not as a measured
 * rejection. Either one appearing would breach the exact claim-set invariant.
 */
const FORBIDDEN_COARSE_CLAIMS = ["scope", "permission"] as const;

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
    // What this pins: our node:crypto HS256 path serializes and signs the
    // intended ACTION-ONLY claims exactly as `jose` would, so the broker's
    // dependency-free signer cannot silently drift from the reference.
    //
    // What this does NOT pin: that R2 accepts the claim shape. Provider
    // acceptance is external evidence — `jose` will happily sign a payload the
    // endpoint rejects, which is precisely how the `scope + actions` defect
    // survived this suite. See R2-BROKER-LIVE-MINT-VERIFICATION-001.
    const claims = buildTemporaryCredentialClaims(input());
    const ours = signCompactJwtHs256(claims, PARENT_SECRET);

    const reference = await new SignJWT({
      bucket: claims.bucket,
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
      assert.equal(claims.sub, ACCOUNT_ID);
      assert.equal(claims.aud, ENDPOINT_HOST);
    }
  });

  it("states its authority with `actions` alone — never a coarse preset", () => {
    // REGRESSION GUARD (R2-TEMP-CREDENTIAL-ACTIONS-ONLY-001). Reintroducing
    // `scope` would make R2 refuse the token outright — HTTP 400
    // InvalidArgument while parsing X-Amz-Security-Token, as measured.
    // Reintroducing `permission` was NOT measured to be rejected; it is
    // refused here because it is a coarse claim outside the approved
    // vocabulary, and an unapproved authority claim has no business in a
    // credential whose whole point is stating exactly one operation.
    for (const action of ["PutObject", "HeadObject", "DeleteObject"] as const) {
      const claims = decodeSessionTokenClaims(
        mintTemporaryCredential(input({ action })).sessionToken,
      ) as unknown as Record<string, unknown>;

      for (const coarse of FORBIDDEN_COARSE_CLAIMS) {
        assert.equal(
          Object.hasOwn(claims, coarse),
          false,
          `${action} credential must not carry a \`${coarse}\` claim`,
        );
        assert.equal(claims[coarse], undefined, `\`${coarse}\` must not be present at all`);
      }

      // `actions` is therefore the SOLE operation-authority claim present.
      assert.deepEqual(claims.actions, [action]);
    }
  });

  it("signs exactly the expected claim vocabulary and nothing else", () => {
    // An unexpected claim cannot appear silently: this compares the whole key
    // set, so a new authority-bearing field fails here even if nobody thought
    // to write an assertion naming it.
    for (const action of ["PutObject", "HeadObject", "DeleteObject"] as const) {
      const claims = decodeSessionTokenClaims(
        mintTemporaryCredential(input({ action })).sessionToken,
      );

      assert.deepEqual(
        Object.keys(claims).sort(),
        EXPECTED_CLAIM_KEYS,
        `${action} credential must sign exactly the expected claims`,
      );
      assert.deepEqual(
        Object.keys(claims.paths).sort(),
        ["objectPaths", "prefixPaths"],
        "paths carries exactly the two path lists",
      );
    }
  });

  it("builds the corrected claim shape before anything is signed", () => {
    // The decoded-token assertions above prove what R2 would receive. This
    // proves the same invariants one layer earlier, at the builder, so a
    // regression is caught at its source rather than only at the token.
    for (const action of ["PutObject", "HeadObject", "DeleteObject"] as const) {
      const claims = buildTemporaryCredentialClaims(input({ action }));

      assert.deepEqual(Object.keys(claims).sort(), EXPECTED_CLAIM_KEYS);
      assert.deepEqual(claims.actions, [action]);
      assert.deepEqual(claims.paths.objectPaths, [OBJECT_KEY]);
      assert.deepEqual(claims.paths.prefixPaths, []);

      for (const coarse of FORBIDDEN_COARSE_CLAIMS) {
        assert.equal(
          Object.hasOwn(claims, coarse),
          false,
          `buildTemporaryCredentialClaims must never emit \`${coarse}\``,
        );
      }

      // And the JSON that actually gets signed carries no coarse key either —
      // serialization is the last place one could slip through.
      const serialized = JSON.parse(JSON.stringify(claims)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(serialized).sort(), EXPECTED_CLAIM_KEYS);
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
      () => mintTemporaryCredential(input({ ttlSeconds: R2_CREDENTIAL_TTL_MIN_SECONDS - 1 })),
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
      mintTemporaryCredential(input({ ttlSeconds: R2_CREDENTIAL_TTL_MIN_SECONDS })),
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
