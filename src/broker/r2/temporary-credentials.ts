import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  R2_CREDENTIAL_TTL_FLOOR_SECONDS,
  R2_CREDENTIAL_TTL_HARD_CAP_SECONDS,
  type R2DelegatedAction,
} from "../../shared/worker/r2-broker.ts";

/**
 * Cloudflare R2 temporary-credential LOCAL SIGNING.
 *
 * R2 offers two ways to obtain a temporary credential. The Temporary
 * Credentials API accepts only coarse permission presets
 * (`object-read-write` / `object-read-only` / `admin-*`), none of which can
 * express "PutObject and nothing else". Local signing accepts an explicit
 * `actions` list, so it is the only mechanism that can realize the action
 * scoping this design requires. That is why this module exists rather than an
 * API client.
 *
 * The scheme (Cloudflare R2 docs, "Temporary credentials" / "Authenticate
 * against R2 with temporary credentials"):
 *
 *   1. build a JWT whose claims carry `bucket`, `scope`, `actions` and `paths`;
 *   2. sign it HS256 with the PARENT secret access key;
 *   3. accessKeyId    = the parent ACCESS KEY ID (an identifier, not a secret);
 *   4. secretAccessKey = SHA-256 hex digest of the signed JWT;
 *   5. sessionToken   = base64("jwt/" + signed JWT).
 *
 * The parent SECRET never leaves this module — it is HMAC key material and is
 * never copied into the returned credential, the JWT claims, an error, or a log
 * line. The derived secret is a digest of a signed token, so possessing it
 * grants exactly the policy inside that token and nothing more.
 *
 * This module performs no I/O and opens no socket. It is pure, which is what
 * makes the scoping assertions in the security suite meaningful.
 */

/**
 * The coarse preset that R2 requires alongside the fine-grained `actions` list.
 *
 * `object-read-write` is the narrowest preset that CONTAINS our three write-side
 * actions; `actions` is what actually narrows the credential from that preset
 * down to a single operation. The preset alone would permit read and list, so
 * `actions` is never omitted by this module — see `assertActionsNarrowed`.
 */
export const R2_TEMPORARY_CREDENTIAL_SCOPE = "object-read-write" as const;

export type R2TemporaryCredential = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** Absolute expiry, epoch milliseconds. */
  readonly expiresAt: number;
};

export type MintTemporaryCredentialInput = {
  /** 32 lowercase hex characters. Becomes the JWT `sub` claim. */
  readonly accountId: string;
  /** Parent access key id. Public identifier, reused as the temporary one. */
  readonly parentAccessKeyId: string;
  /** Parent secret. HMAC key material only — never emitted. */
  readonly parentSecretAccessKey: string;
  /** The single bucket this credential may touch. */
  readonly bucket: string;
  /** The single exact object key this credential may touch. */
  readonly objectKey: string;
  /** The single S3 action this credential authorizes. */
  readonly action: R2DelegatedAction;
  /** S3 endpoint host, becomes the JWT `aud` claim. */
  readonly endpointHost: string;
  readonly ttlSeconds: number;
  /** Epoch milliseconds. Injected so tests are deterministic. */
  readonly nowMs: number;
};

export class R2TemporaryCredentialError extends Error {
  constructor(message: string) {
    // No `cause` chain: a cause could carry key material from a lower layer.
    super(message);
    this.name = "R2TemporaryCredentialError";
  }
}

/** The exact claim set signed into the token. Shaped for assertions. */
export type R2TemporaryCredentialClaims = {
  readonly bucket: string;
  readonly scope: typeof R2_TEMPORARY_CREDENTIAL_SCOPE;
  readonly actions: readonly R2DelegatedAction[];
  readonly paths: {
    readonly prefixPaths: readonly string[];
    readonly objectPaths: readonly string[];
  };
  readonly sub: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
};

function base64Url(input: string | Buffer): string {
  return Buffer.from(input as never).toString("base64url");
}

/**
 * Builds the claim set for exactly one action against exactly one object.
 *
 * Two invariants are structural rather than conventional:
 *  - `actions` has exactly ONE entry, so no credential can carry a second
 *    authority even by accident;
 *  - `prefixPaths` is ALWAYS empty and `objectPaths` holds exactly one exact
 *    key, so no credential can ever address a sibling object under the same
 *    job prefix.
 */
export function buildTemporaryCredentialClaims(
  input: MintTemporaryCredentialInput,
): R2TemporaryCredentialClaims {
  const issuedAtSeconds = Math.floor(input.nowMs / 1000);
  return Object.freeze({
    bucket: input.bucket,
    scope: R2_TEMPORARY_CREDENTIAL_SCOPE,
    actions: Object.freeze([input.action]),
    paths: Object.freeze({
      // An empty prefix list is the point: prefix authority would let one
      // job's credential reach every other object beneath `videofetch/jobs/`.
      prefixPaths: Object.freeze([]),
      objectPaths: Object.freeze([input.objectKey]),
    }),
    sub: input.accountId,
    iss: input.parentAccessKeyId,
    aud: input.endpointHost,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + input.ttlSeconds,
  }) as R2TemporaryCredentialClaims;
}

/**
 * Signs a compact HS256 JWT.
 *
 * Byte-identical to the `jose` reference implementation Cloudflare's own
 * example uses — `temporary-credentials.test.ts` pins that equivalence against
 * the installed `jose` so a divergence in either direction fails the suite.
 * Implemented on `node:crypto` here so the trusted broker's signing path has no
 * dependency beyond the Node runtime itself.
 */
export function signCompactJwtHs256(
  claims: R2TemporaryCredentialClaims,
  parentSecretAccessKey: string,
): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", parentSecretAccessKey)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Mints one short-lived, single-action, single-object R2 credential.
 *
 * Every input is re-checked here even though the broker service validated them
 * already. This function is the last gate before parent key material is used,
 * so it does not trust its caller.
 */
export function mintTemporaryCredential(
  input: MintTemporaryCredentialInput,
): R2TemporaryCredential {
  if (!/^[a-f0-9]{32}$/.test(input.accountId)) {
    throw new R2TemporaryCredentialError("accountId must be 32 lowercase hex characters");
  }
  if (input.parentAccessKeyId.length === 0 || input.parentAccessKeyId.length > 8192) {
    throw new R2TemporaryCredentialError("parentAccessKeyId out of range");
  }
  if (input.parentSecretAccessKey.length === 0 || input.parentSecretAccessKey.length > 8192) {
    throw new R2TemporaryCredentialError("parentSecretAccessKey out of range");
  }
  if (input.bucket.length === 0 || input.objectKey.length === 0) {
    throw new R2TemporaryCredentialError("bucket and objectKey are required");
  }
  if (input.endpointHost.length === 0) {
    throw new R2TemporaryCredentialError("endpointHost is required");
  }
  if (
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds < R2_CREDENTIAL_TTL_FLOOR_SECONDS ||
    input.ttlSeconds > R2_CREDENTIAL_TTL_HARD_CAP_SECONDS
  ) {
    throw new R2TemporaryCredentialError("ttlSeconds outside the permitted window");
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) {
    throw new R2TemporaryCredentialError("nowMs must be a positive safe integer");
  }

  const claims = buildTemporaryCredentialClaims(input);
  assertActionsNarrowed(claims);

  const jwt = signCompactJwtHs256(claims, input.parentSecretAccessKey);

  // The derived secret is the SHA-256 hex digest of the signed token. It is a
  // function of the POLICY, so it cannot outlive or out-scope that policy.
  const secretAccessKey = createHash("sha256").update(jwt, "utf8").digest("hex");

  const credential: R2TemporaryCredential = Object.freeze({
    accessKeyId: input.parentAccessKeyId,
    secretAccessKey,
    sessionToken: Buffer.from(`jwt/${jwt}`, "utf8").toString("base64"),
    expiresAt: claims.exp * 1000,
  });

  assertParentSecretAbsent(credential, input.parentSecretAccessKey);

  return credential;
}

/**
 * Refuses to sign a token whose `actions` list is missing, empty or plural.
 *
 * Without an `actions` list R2 falls back to the coarse `scope` preset, which
 * grants read and list. A silent fallback to a broader credential is exactly
 * the failure this design exists to prevent, so it is a hard error.
 */
function assertActionsNarrowed(claims: R2TemporaryCredentialClaims): void {
  if (!Array.isArray(claims.actions) || claims.actions.length !== 1) {
    throw new R2TemporaryCredentialError(
      "a delegated credential must carry exactly one action",
    );
  }
  if (claims.paths.objectPaths.length !== 1 || claims.paths.prefixPaths.length !== 0) {
    throw new R2TemporaryCredentialError(
      "a delegated credential must carry exactly one object path and no prefix",
    );
  }
}

/**
 * Belt-and-braces: proves the parent secret is not embedded in what we return.
 *
 * The derivation makes this true by construction; asserting it means a future
 * refactor that accidentally passes the parent secret through fails here rather
 * than in production.
 */
function assertParentSecretAbsent(
  credential: R2TemporaryCredential,
  parentSecretAccessKey: string,
): void {
  const parent = Buffer.from(parentSecretAccessKey, "utf8");
  for (const emitted of [
    credential.accessKeyId,
    credential.secretAccessKey,
    credential.sessionToken,
  ]) {
    if (emitted.includes(parentSecretAccessKey)) {
      throw new R2TemporaryCredentialError("parent secret must never be emitted");
    }
    const candidate = Buffer.from(emitted, "utf8");
    if (candidate.length === parent.length && timingSafeEqual(candidate, parent)) {
      throw new R2TemporaryCredentialError("parent secret must never be emitted");
    }
  }
}

/**
 * Decodes a session token back into its claims.
 *
 * TEST AND DIAGNOSTIC USE ONLY — it verifies nothing and trusts nothing. It
 * exists so the security suite can assert what a minted credential actually
 * authorizes instead of asserting that we merely intended to scope it.
 */
export function decodeSessionTokenClaims(sessionToken: string): R2TemporaryCredentialClaims {
  const decoded = Buffer.from(sessionToken, "base64").toString("utf8");
  if (!decoded.startsWith("jwt/")) {
    throw new R2TemporaryCredentialError("session token is not a jwt/ token");
  }
  const compact = decoded.slice("jwt/".length);
  const parts = compact.split(".");
  if (parts.length !== 3) {
    throw new R2TemporaryCredentialError("malformed compact JWT");
  }
  return JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  ) as R2TemporaryCredentialClaims;
}
