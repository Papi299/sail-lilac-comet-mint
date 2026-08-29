import {
  R2_CREDENTIAL_DELETE_TTL_FLOOR_SECONDS,
  R2_CREDENTIAL_TTL_CEILING_SECONDS,
  R2_CREDENTIAL_TTL_MIN_SECONDS,
  clampDeleteCredentialTtlSeconds,
  credentialTtlCeilingSeconds,
  isDeadlineBoundAction,
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
 * The outcome of a TTL derivation.
 *
 * A refusal is a first-class result rather than a clamped number, because the
 * only honest answer for an expired job is "no credential", and a caller must
 * be forced to handle that rather than receive a plausible-looking TTL.
 */
export type CredentialTtlDecision =
  | { readonly ok: true; readonly ttlSeconds: number }
  | { readonly ok: false; readonly reason: "job_expired" };

/**
 * Derives the TTL for one operation.
 *
 * Policy (documented in the deployment runbook §5d):
 *
 * **PutObject / HeadObject — deadline-bound.**
 *   - remaining lifetime known and positive: `min(remaining, ceiling)`. The
 *     credential can never outlive the job it serves, even when the remaining
 *     lifetime is only a few seconds.
 *   - remaining lifetime known and expired: **fail closed.** No credential is
 *     requested at all. Writing or inspecting an object whose authorization has
 *     already lapsed is not something a floor should paper over.
 *   - deadline unknown: the action's conservative ceiling.
 *
 * **DeleteObject — cleanup.**
 *   Always yields a bounded credential, including long after expiry, because
 *   maintenance must be able to delete the object precisely BECAUSE the job
 *   expired. A small floor guarantees the credential is usable; the ceiling
 *   guarantees it stays short. It never carries Put or Head authority.
 *
 * Every successful result is inside `[MIN, ceiling(action)]`, so no derivation
 * — including one from a corrupted deadline — can produce a quasi-persistent
 * credential.
 */
export function deriveCredentialTtlSeconds(input: {
  action: R2DelegatedAction;
  nowMs: number;
  jobDeadlineMs: number | null;
}): CredentialTtlDecision {
  const ceiling = credentialTtlCeilingSeconds(input.action);
  const deadlineKnown =
    input.jobDeadlineMs !== null && Number.isSafeInteger(input.jobDeadlineMs);

  if (!isDeadlineBoundAction(input.action)) {
    // DeleteObject: cleanup survives expiry, bounded either way.
    if (!deadlineKnown) return { ok: true, ttlSeconds: ceiling };
    const remaining = Math.floor((input.jobDeadlineMs! - input.nowMs) / 1000);
    return { ok: true, ttlSeconds: clampDeleteCredentialTtlSeconds(remaining) };
  }

  // PutObject / HeadObject.
  if (!deadlineKnown) return { ok: true, ttlSeconds: ceiling };

  const remaining = Math.floor((input.jobDeadlineMs! - input.nowMs) / 1000);
  if (remaining < R2_CREDENTIAL_TTL_MIN_SECONDS) return { ok: false, reason: "job_expired" };

  return { ok: true, ttlSeconds: Math.min(remaining, ceiling) };
}

export {
  R2_CREDENTIAL_DELETE_TTL_FLOOR_SECONDS,
  R2_CREDENTIAL_TTL_MIN_SECONDS,
  R2_CREDENTIAL_TTL_CEILING_SECONDS,
};
export type { R2DelegatedAction };
