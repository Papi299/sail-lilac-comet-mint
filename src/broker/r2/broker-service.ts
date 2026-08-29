import { WorkerObjectKeySchema } from "../../shared/worker/contracts.ts";
import {
  R2CredentialResponseSchema,
  R2CredentialTtlSchema,
  R2DelegatedActionSchema,
  R2_CREDENTIAL_TTL_CEILING_SECONDS,
  type R2BrokerErrorCode,
  type R2CredentialResponse,
  type R2DelegatedAction,
} from "../../shared/worker/r2-broker.ts";
import {
  mintTemporaryCredential,
  type R2TemporaryCredential,
} from "./temporary-credentials.ts";

/**
 * The trusted R2 credential broker's decision layer
 * (WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001).
 *
 * This runs on the VM host, OUTSIDE the media network namespace, as a separate
 * user and a separate systemd unit. It is the only component in the system that
 * holds the persistent R2 parent credential.
 *
 * Its entire job is to refuse. Every request arriving over the Unix socket is
 * treated as hostile input from a potentially compromised media container, so
 * nothing is trusted:
 *
 *  - the object key is re-validated against the AUTHORITATIVE
 *    `WorkerObjectKeySchema`, not a local copy of the pattern;
 *  - the bucket must equal the ONE bucket this broker was configured with —
 *    the request cannot select a bucket, it can only fail to match;
 *  - the action must be one of exactly three, and the minted credential carries
 *    that one action alone;
 *  - the TTL must fall inside the policy window for that action.
 *
 * Any failure returns a bare category code. No value from the request is ever
 * echoed, and no credential value is ever logged, returned in an error, or
 * passed to the observer hook.
 */

export type R2BrokerConfig = {
  readonly accountId: string;
  readonly bucket: string;
  readonly jurisdiction: "default" | "eu" | "us";
  readonly parentAccessKeyId: string;
  readonly parentSecretAccessKey: string;
};

/**
 * Observability hook. Receives a decision CATEGORY and nothing else.
 *
 * There is deliberately no parameter that could carry an object key, a bucket,
 * a token or a secret — the type makes credential logging unexpressible rather
 * than merely discouraged.
 */
export type R2BrokerObserver = (
  outcome: "minted" | "refused",
  code: R2BrokerErrorCode | null,
) => void;

export type R2BrokerDecision =
  | { readonly ok: true; readonly response: R2CredentialResponse }
  | { readonly ok: false; readonly code: R2BrokerErrorCode };

/** Derives the S3 endpoint host for the configured jurisdiction. */
export function r2EndpointHost(accountId: string, jurisdiction: "default" | "eu" | "us"): string {
  const suffix = jurisdiction === "eu" ? ".eu" : jurisdiction === "us" ? ".us" : "";
  return `${accountId}${suffix}.r2.cloudflarestorage.com`;
}

export class R2CredentialBroker {
  private readonly config: R2BrokerConfig;
  private readonly clock: () => number;
  private readonly observe: R2BrokerObserver;
  private readonly mint: (
    input: Parameters<typeof mintTemporaryCredential>[0],
  ) => R2TemporaryCredential;

  constructor(deps: {
    config: R2BrokerConfig;
    clock?: () => number;
    observer?: R2BrokerObserver;
    /** Test seam. Production always uses the real local-signing minter. */
    mintImpl?: (input: Parameters<typeof mintTemporaryCredential>[0]) => R2TemporaryCredential;
  }) {
    this.config = deps.config;
    this.clock = deps.clock ?? (() => Date.now());
    this.observe = deps.observer ?? (() => {});
    this.mint = deps.mintImpl ?? mintTemporaryCredential;
  }

  /**
   * Validates one request and, only if every check passes, mints one
   * credential. Never throws: an unexpected fault becomes `mint_failed` so the
   * caller's R2 operation fails closed rather than proceeding uncredentialed.
   */
  public handle(raw: unknown): R2BrokerDecision {
    const decision = this.decide(raw);
    this.observe(decision.ok ? "minted" : "refused", decision.ok ? null : decision.code);
    return decision;
  }

  private decide(raw: unknown): R2BrokerDecision {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return refuse("malformed_request");
    }

    // An unknown field is a protocol violation. Ignoring it would let a caller
    // smuggle policy material past a schema that merely strips it.
    const permitted = new Set(["bucket", "objectKey", "action", "ttlSeconds"]);
    for (const key of Object.keys(raw)) {
      if (!permitted.has(key)) return refuse("malformed_request");
    }

    const candidate = raw as Record<string, unknown>;

    // 1. Object key — validated against the authoritative contract BEFORE any
    //    parent key material is touched. A malformed key never reaches a mint.
    const objectKey = WorkerObjectKeySchema.safeParse(candidate.objectKey);
    if (!objectKey.success) return refuse("invalid_object_key");

    // 2. Action — the closed three-entry set. Anything else, including a valid
    //    S3 action such as GetObject or ListObjectsV2, is unauthorized.
    const action = R2DelegatedActionSchema.safeParse(candidate.action);
    if (!action.success) return refuse("unauthorized_action");

    // 3. Bucket — equality with the single configured bucket. The request
    //    cannot widen this; a different bucket is simply refused.
    if (typeof candidate.bucket !== "string" || candidate.bucket !== this.config.bucket) {
      return refuse("unauthorized_bucket");
    }

    // 4. TTL — inside the global window AND the per-action ceiling. The broker
    //    does not clamp a too-large ask into range: an out-of-policy request is
    //    a bug or an attack, and either way it fails closed.
    const ttl = R2CredentialTtlSchema.safeParse(candidate.ttlSeconds);
    if (!ttl.success) return refuse("invalid_ttl");
    if (ttl.data > R2_CREDENTIAL_TTL_CEILING_SECONDS[action.data]) {
      return refuse("invalid_ttl");
    }

    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return refuse("mint_failed");

    let credential: R2TemporaryCredential;
    try {
      credential = this.mint({
        accountId: this.config.accountId,
        parentAccessKeyId: this.config.parentAccessKeyId,
        parentSecretAccessKey: this.config.parentSecretAccessKey,
        bucket: this.config.bucket,
        objectKey: objectKey.data,
        action: action.data,
        endpointHost: r2EndpointHost(this.config.accountId, this.config.jurisdiction),
        ttlSeconds: ttl.data,
        nowMs,
      });
    } catch {
      // The raw error is dropped: a signing fault could carry key material in
      // its message or cause chain.
      return refuse("mint_failed");
    }

    const response = R2CredentialResponseSchema.safeParse({
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      sessionToken: credential.sessionToken,
      expiresAt: credential.expiresAt,
      action: action.data,
      bucket: this.config.bucket,
      objectKey: objectKey.data,
    });
    if (!response.success) return refuse("mint_failed");

    return { ok: true, response: response.data };
  }
}

function refuse(code: R2BrokerErrorCode): R2BrokerDecision {
  return { ok: false, code };
}

/** Re-exported for callers that need the action type without the protocol module. */
export type { R2DelegatedAction };
