import {
  R2_CREDENTIAL_TTL_CEILING_SECONDS,
  R2_CREDENTIAL_TTL_FLOOR_SECONDS,
  clampCredentialTtlSeconds,
  type R2DelegatedAction,
} from "../../shared/worker/r2-broker.ts";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";

/**
 * The Worker's view of credential acquisition.
 *
 * The media Worker holds NO persistent R2 credential. Everything it can ever do
 * against object storage arrives through this interface, one operation at a
 * time, from the trusted host broker.
 *
 * The interface is deliberately narrow in a specific way: the caller names an
 * ACTION and an OBJECT KEY, and cannot name a bucket, a policy, a permission
 * preset or a duration ceiling. Those belong to the broker.
 */

export type R2TemporaryCredential = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Always present for a delegated credential. Its absence would mean a parent
   * credential had been handed to the Worker, which this design forbids.
   */
  readonly sessionToken: string;
  /** Absolute expiry, epoch milliseconds. */
  readonly expiresAt: number;
};

export type R2CredentialRequestInput = {
  readonly action: R2DelegatedAction;
  readonly objectKey: WorkerObjectKey;
  readonly ttlSeconds: number;
};

export interface R2CredentialProvider {
  /**
   * Obtains a credential scoped to exactly one action against exactly one
   * object. Throws on any refusal — callers must fail the R2 operation closed
   * rather than proceeding without a credential.
   */
  mint(request: R2CredentialRequestInput): Promise<R2TemporaryCredential>;
}

/**
 * Resolves the absolute expiry of the job an object belongs to.
 *
 * Returns null when the job's durable row is gone — which is normal for
 * maintenance cleanup running after metadata removal, and is why a null
 * deadline must still yield a usable (short) credential rather than a refusal.
 */
export type JobDeadlineSource = (jobId: string) => number | null;

/**
 * Derives the TTL for one operation.
 *
 * Policy (documented in the deployment runbook §5e):
 *
 *  - the per-action CEILING is the conservative hard upper bound, and is the
 *    value used when the remaining job lifetime is unknown;
 *  - when the remaining lifetime IS known, it shortens the credential further,
 *    so a credential never outlives the job it serves;
 *  - the FLOOR keeps an already-expired job cleanable. Maintenance deletion
 *    after expiry therefore mints a fresh, short DeleteObject-only credential
 *    instead of reaching for a stale upload credential.
 *
 * The result is always inside `[floor, ceiling]`, so no derivation — including
 * one from a corrupted deadline — can produce a quasi-persistent credential.
 */
export function deriveCredentialTtlSeconds(input: {
  action: R2DelegatedAction;
  nowMs: number;
  jobDeadlineMs: number | null;
}): number {
  const ceiling = R2_CREDENTIAL_TTL_CEILING_SECONDS[input.action];

  if (input.jobDeadlineMs === null || !Number.isSafeInteger(input.jobDeadlineMs)) {
    return clampCredentialTtlSeconds(ceiling, input.action);
  }

  const remainingMs = input.jobDeadlineMs - input.nowMs;
  const remainingSeconds = Math.floor(remainingMs / 1000);
  return clampCredentialTtlSeconds(remainingSeconds, input.action);
}

export { R2_CREDENTIAL_TTL_FLOOR_SECONDS, R2_CREDENTIAL_TTL_CEILING_SECONDS };
export type { R2DelegatedAction };
