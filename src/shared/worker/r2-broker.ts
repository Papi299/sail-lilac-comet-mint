import { z } from "zod";
import { WorkerObjectKeySchema } from "./contracts.ts";

/**
 * Authoritative protocol contract for the trusted R2 credential broker
 * (WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001).
 *
 * This module is shared by BOTH sides of the delegation boundary and is the
 * single definition of what may cross it:
 *
 *   media Worker  ──(AF_UNIX, no network egress)──>  trusted host broker
 *
 * The Worker holds no persistent R2 parent credential. For every individual
 * object-store operation it asks the broker for a credential scoped to exactly
 * one bucket, exactly one validated `WorkerObjectKey`, exactly one S3 action,
 * and the shortest practical TTL. The broker owns the parent credential and
 * re-validates every field of the request before minting anything.
 *
 * Nothing here is advisory. Both sides parse with these schemas, so a request
 * the contract cannot express is structurally impossible to send AND is
 * independently rejected on arrival.
 */

/**
 * The COMPLETE set of S3 actions the Worker is permitted to request, and the
 * exact mapping from the `ObjectStoreWriter` surface onto them:
 *
 *   put()    -> PutObject
 *   head()   -> HeadObject
 *   delete() -> DeleteObject
 *
 * There is no fourth entry, and no path in this repository adds one at runtime.
 */
export const R2_DELEGATED_ACTIONS = ["PutObject", "HeadObject", "DeleteObject"] as const;

export const R2DelegatedActionSchema = z.enum(R2_DELEGATED_ACTIONS);
export type R2DelegatedAction = z.infer<typeof R2DelegatedActionSchema>;

/**
 * Actions that must NEVER appear in a minted credential's policy.
 *
 * Read access is the control plane's business (Vercel signs `GetObject` with a
 * separate identity), listing would defeat the opacity of the object key space,
 * and bucket administration is granted to no identity in this system at all.
 *
 * Kept as data — not as a comment — so the security suite can assert the
 * absence of every one of them against real minted output.
 */
export const R2_FORBIDDEN_ACTIONS = [
  "GetObject",
  "GetBucketLocation",
  "ListObjectsV1",
  "ListObjectsV2",
  "ListBucket",
  "ListMultipartUploads",
  "ListParts",
  "DeleteObjects",
  "CopyObject",
  "CreateMultipartUpload",
  "UploadPart",
  "UploadPartCopy",
  "AbortMultipartUpload",
  "CompleteMultipartUpload",
  "PutBucketPolicy",
  "DeleteBucket",
] as const;

/**
 * TTL policy (documented in docs/architecture/worker-deployment-runbook.md §5d).
 *
 * A minted credential must live long enough to complete ONE authorized
 * operation and no longer.
 *
 * Two DIFFERENT rules apply, because the two kinds of operation have opposite
 * relationships to job expiry:
 *
 *  - `PutObject` / `HeadObject` are **deadline-bound**. A credential must never
 *    outlive the job it serves, so its TTL is capped by the REMAINING job
 *    lifetime, and an already-expired job yields no credential at all. Writing
 *    or inspecting an object the user is no longer authorized to receive is not
 *    something a shorter floor should be allowed to paper over.
 *
 *  - `DeleteObject` is **cleanup**, and must keep working precisely BECAUSE the
 *    job expired. It therefore keeps a small floor so maintenance can always
 *    mint a fresh, bounded, delete-only credential. Deleting an expired object
 *    grants nothing to anyone.
 *
 * Enforcement is split, and the split is deliberate:
 *
 *  - the WORKER derives the TTL, because only it knows the job deadline;
 *  - the BROKER independently enforces the bounds it CAN verify without a job
 *    store — an integer TTL within `[MIN, ceiling(action)]`. It cannot verify
 *    deadline-boundness and does not pretend to.
 *
 * A compromised Worker therefore cannot negotiate a credential longer than the
 * per-action ceiling, and an honest Worker additionally cannot obtain one that
 * outlives its job.
 */
export const R2_CREDENTIAL_TTL_HARD_CAP_SECONDS = 900;

/** Global minimum. A zero or negative TTL is never a valid credential. */
export const R2_CREDENTIAL_TTL_MIN_SECONDS = 1;

/**
 * DeleteObject-only floor. Applies to cleanup, and to cleanup alone — it is
 * what lets maintenance delete an object whose job expired days ago. It is
 * deliberately NOT applied to PutObject or HeadObject, where raising a
 * nearly-expired TTL up to a floor would mint a credential outliving its job.
 */
export const R2_CREDENTIAL_DELETE_TTL_FLOOR_SECONDS = 60;

/**
 * Per-action ceilings, all at or below the hard cap.
 *
 * An upload is bounded by `MAX_FILE_SIZE` and may legitimately take minutes.
 * A head or a delete is a single fast metadata call, so it gets far less.
 */
export const R2_CREDENTIAL_TTL_CEILING_SECONDS: Readonly<
  Record<R2DelegatedAction, number>
> = Object.freeze({
  PutObject: 900,
  HeadObject: 120,
  DeleteObject: 120,
});

/**
 * The bounds the BROKER can verify on its own. Per-action ceilings are applied
 * on top of this by the broker; deadline-boundness is a Worker-side rule.
 */
export const R2CredentialTtlSchema = z
  .number()
  .int()
  .min(R2_CREDENTIAL_TTL_MIN_SECONDS)
  .max(R2_CREDENTIAL_TTL_HARD_CAP_SECONDS);

/**
 * Actions whose credential must never outlive the job it serves.
 *
 * Kept as data so both the derivation and its tests read the same list.
 */
export const R2_DEADLINE_BOUND_ACTIONS = ["PutObject", "HeadObject"] as const;

export function isDeadlineBoundAction(action: R2DelegatedAction): boolean {
  return (R2_DEADLINE_BOUND_ACTIONS as readonly string[]).includes(action);
}

/**
 * Bucket names are re-validated on the broker side against its OWN single
 * configured bucket. This schema only rejects structurally impossible names;
 * equality with the configured bucket is the security check.
 */
export const R2BucketNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "must be a valid bucket name");

/**
 * A credential request. `.strict()` matters: an unknown field is a protocol
 * violation, not something to ignore, so a request smuggling extra policy
 * material fails closed instead of being silently truncated.
 */
export const R2CredentialRequestSchema = z
  .object({
    bucket: R2BucketNameSchema,
    objectKey: WorkerObjectKeySchema,
    action: R2DelegatedActionSchema,
    ttlSeconds: R2CredentialTtlSchema,
  })
  .strict();

export type R2CredentialRequest = z.infer<typeof R2CredentialRequestSchema>;

/**
 * Bounded credential material. The lengths are sanity limits, not secrets
 * policy — the values themselves are never logged by either side.
 */
const CredentialMaterialSchema = z.string().min(1).max(8192);

export const R2CredentialResponseSchema = z
  .object({
    accessKeyId: CredentialMaterialSchema,
    secretAccessKey: CredentialMaterialSchema,
    /**
     * Always present. A delegated credential without a session token would be
     * a parent credential, which is exactly what this design forbids.
     */
    sessionToken: CredentialMaterialSchema,
    /** Absolute expiry, epoch milliseconds. */
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /** Echoed back so the caller can verify it got what it asked for. */
    action: R2DelegatedActionSchema,
    bucket: R2BucketNameSchema,
    objectKey: WorkerObjectKeySchema,
  })
  .strict();

export type R2CredentialResponse = z.infer<typeof R2CredentialResponseSchema>;

/**
 * Broker refusal codes.
 *
 * Deliberately coarse and value-free: a refusal names a CATEGORY, never the
 * offending value, so a malformed key or an unauthorized bucket cannot be
 * echoed back through the boundary and into a Worker log line.
 */
export const R2_BROKER_ERROR_CODES = [
  "malformed_request",
  "unauthorized_bucket",
  "unauthorized_action",
  "invalid_object_key",
  "invalid_ttl",
  "mint_failed",
] as const;

export const R2BrokerErrorCodeSchema = z.enum(R2_BROKER_ERROR_CODES);
export type R2BrokerErrorCode = z.infer<typeof R2BrokerErrorCodeSchema>;

export const R2BrokerErrorSchema = z
  .object({ error: R2BrokerErrorCodeSchema })
  .strict();

/** The single request path the broker serves. Nothing else is routed. */
export const R2_BROKER_MINT_PATH = "/v1/r2/credentials";

/** Bounded request body. A credential request is a few hundred bytes. */
export const R2_BROKER_MAX_REQUEST_BYTES = 4096;

/**
 * Derives the S3 action for an `ObjectStoreWriter` operation.
 *
 * A function rather than an inline literal so the mapping has exactly one
 * definition that tests can pin.
 */
export function actionForOperation(operation: "put" | "head" | "delete"): R2DelegatedAction {
  switch (operation) {
    case "put":
      return "PutObject";
    case "head":
      return "HeadObject";
    case "delete":
      return "DeleteObject";
  }
}

/** The effective upper bound for one action, never above the hard cap. */
export function credentialTtlCeilingSeconds(action: R2DelegatedAction): number {
  return Math.min(
    R2_CREDENTIAL_TTL_CEILING_SECONDS[action],
    R2_CREDENTIAL_TTL_HARD_CAP_SECONDS,
  );
}

/**
 * Clamps a DeleteObject TTL into `[delete floor, delete ceiling]`.
 *
 * DELETE ONLY. A negative or zero remaining lifetime is raised to the floor,
 * which is exactly the post-expiry cleanup case. Applying this to PutObject or
 * HeadObject would defeat their deadline-bound rule, so it does not accept
 * them — see `deriveCredentialTtlSeconds`.
 */
export function clampDeleteCredentialTtlSeconds(desiredSeconds: number): number {
  const ceiling = credentialTtlCeilingSeconds("DeleteObject");
  if (!Number.isFinite(desiredSeconds)) return R2_CREDENTIAL_DELETE_TTL_FLOOR_SECONDS;
  const floored = Math.floor(desiredSeconds);
  if (floored < R2_CREDENTIAL_DELETE_TTL_FLOOR_SECONDS) {
    return R2_CREDENTIAL_DELETE_TTL_FLOOR_SECONDS;
  }
  if (floored > ceiling) return ceiling;
  return floored;
}

/**
 * Extracts the job id embedded in an object key.
 *
 * The key contract is `videofetch/jobs/<jobId>/<token>`, so the binding between
 * an object and its job is structural. Returns null for anything the
 * authoritative schema does not accept — callers must fail closed on null
 * rather than guessing a job.
 */
export function jobIdFromObjectKey(objectKey: string): string | null {
  const parsed = WorkerObjectKeySchema.safeParse(objectKey);
  if (!parsed.success) return null;
  const segments = parsed.data.split("/");
  return segments[2] ?? null;
}
