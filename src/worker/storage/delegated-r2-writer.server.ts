import {
  ObjectStoreHeadSchema,
  ObjectStorePutInputSchema,
  type ObjectStoreHead,
  type ObjectStoreOperationContext,
  type ObjectStorePutInput,
  type ObjectStoreWriter,
} from "./writer.ts";
import {
  CloudflareR2ObjectStoreWriter,
  type CloudflareR2Config,
} from "./cloudflare-r2-writer.server.ts";
import {
  deriveCredentialTtlSeconds,
  type JobDeadlineSource,
  type R2CredentialProvider,
  type R2TemporaryCredential,
} from "./credential-provider.ts";
import {
  actionForOperation,
  jobIdFromObjectKey,
  type R2DelegatedAction,
} from "../../shared/worker/r2-broker.ts";
import { WorkerObjectKeySchema, type WorkerObjectKey } from "../../shared/worker/contracts.ts";

/**
 * `ObjectStoreWriter` backed by just-in-time delegated credentials.
 *
 * This is the composition change at the heart of
 * WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001. Previously the Worker built ONE
 * `CloudflareR2ObjectStoreWriter` at startup around a persistent parent
 * credential that then lived for the whole process lifetime. Now each
 * individual operation:
 *
 *   1. validates its own input against the authoritative schemas,
 *   2. derives a TTL from the remaining job lifetime,
 *   3. asks the trusted broker for a credential scoped to exactly this action
 *      and exactly this object key,
 *   4. builds a writer around THAT credential for THAT one call.
 *
 * The `ObjectStoreWriter` contract is unchanged — `put`/`head`/`delete` with
 * the same signatures and the same semantics — so nothing upstream of this
 * class knows or cares that credentials became per-operation.
 *
 * Validation deliberately happens BEFORE the mint. A malformed object key is
 * rejected here and never reaches the broker, so the broker's own key check is
 * a second independent gate rather than the only one.
 *
 * VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001: the operation's signal is
 * honoured at every step. An operation aborted before its mint mints nothing;
 * an abort during the mint ends the broker exchange itself; a credential that
 * arrives after an abort is discarded unused, so no writer is built and no
 * request is started with it; and the signal is handed to the per-operation
 * writer, which tears down an in-flight request. The credential policy is
 * untouched: the same action, the same exact key, the same TTL derivation.
 */

export type DelegatedR2Failure =
  | "invalid_object_key"
  | "invalid_input"
  | "credential_unavailable"
  /**
   * The job's authorization window has already closed, so no PutObject or
   * HeadObject credential may be minted for it. Distinct from
   * `credential_unavailable`: nothing failed, the operation is simply no longer
   * authorized.
   */
  | "job_expired"
  /**
   * LD-2b: the caller's signal ended the operation — before its mint, during
   * it, or while its request was in flight. Nothing was minted after the abort
   * and no request was started after it.
   */
  | "aborted"
  | "operation_failed";

/** Bounded, value-free failure. Mirrors `CloudflareR2Error`'s discipline. */
export class DelegatedR2Error extends Error {
  readonly failure: DelegatedR2Failure;

  constructor(failure: DelegatedR2Failure, cause?: unknown) {
    super(`delegated R2 operation: ${failure}`, cause === undefined ? undefined : { cause });
    this.name = "DelegatedR2Error";
    this.failure = failure;
  }
}

export type DelegatedR2WriterDeps = {
  /** Location only. Contains no credential of any kind. */
  readonly location: {
    readonly accountId: string;
    readonly bucket: string;
    readonly jurisdiction: "default" | "eu" | "us";
  };
  readonly credentials: R2CredentialProvider;
  /**
   * Resolves a job's absolute expiry so the TTL can be shortened to the
   * remaining lifetime. Omitted or null-returning means "unknown", which
   * falls back to the action's conservative ceiling.
   */
  readonly jobDeadlineAt?: JobDeadlineSource;
  readonly clock?: () => number;
  /**
   * Test seam for the per-operation writer factory. Production always builds a
   * real `CloudflareR2ObjectStoreWriter`, which is what actually consumes the
   * session token.
   */
  readonly createWriter?: (config: CloudflareR2Config) => ObjectStoreWriter;
};

export class DelegatedR2ObjectStoreWriter implements ObjectStoreWriter {
  private readonly deps: DelegatedR2WriterDeps;
  private readonly clock: () => number;
  private readonly createWriter: (config: CloudflareR2Config) => ObjectStoreWriter;

  constructor(deps: DelegatedR2WriterDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
    this.createWriter =
      deps.createWriter ?? ((config) => new CloudflareR2ObjectStoreWriter(config));
  }

  public async put(input: ObjectStorePutInput, context: ObjectStoreOperationContext = {}): Promise<void> {
    let validated: ObjectStorePutInput;
    try {
      validated = ObjectStorePutInputSchema.parse(input);
    } catch (error) {
      throw new DelegatedR2Error("invalid_input", error);
    }

    const writer = await this.writerFor("put", validated.objectKey, context.signal);
    try {
      await writer.put(validated, context);
    } catch (error) {
      throw operationFailure(context.signal, error);
    }
  }

  public async head(objectKey: WorkerObjectKey, context: ObjectStoreOperationContext = {}): Promise<ObjectStoreHead | null> {
    const key = this.validateKey(objectKey);
    const writer = await this.writerFor("head", key, context.signal);

    let result: ObjectStoreHead | null;
    try {
      result = await writer.head(key, context);
    } catch (error) {
      throw operationFailure(context.signal, error);
    }

    // A missing object stays a missing object, exactly as the contract says.
    if (result === null) return null;

    try {
      return ObjectStoreHeadSchema.parse(result);
    } catch (error) {
      throw new DelegatedR2Error("operation_failed", error);
    }
  }

  public async delete(objectKey: WorkerObjectKey, context: ObjectStoreOperationContext = {}): Promise<void> {
    const key = this.validateKey(objectKey);
    const writer = await this.writerFor("delete", key, context.signal);
    try {
      await writer.delete(key, context);
    } catch (error) {
      throw operationFailure(context.signal, error);
    }
  }

  private validateKey(objectKey: unknown): WorkerObjectKey {
    const parsed = WorkerObjectKeySchema.safeParse(objectKey);
    if (!parsed.success) throw new DelegatedR2Error("invalid_object_key");
    return parsed.data;
  }

  /**
   * Mints a credential for one operation and wraps it in a writer.
   *
   * A broker refusal propagates as `credential_unavailable`, which fails the
   * caller's R2 operation closed. There is deliberately no fallback branch:
   * the Worker has no other credential to fall back TO.
   *
   * LD-2b: an aborted signal is checked before the mint and again after it, so
   * neither a mint nor a writer can follow an abort.
   */
  private async writerFor(
    operation: "put" | "head" | "delete",
    objectKey: WorkerObjectKey,
    signal: AbortSignal | undefined,
  ): Promise<ObjectStoreWriter> {
    const action = actionForOperation(operation);
    if (signal?.aborted) throw new DelegatedR2Error("aborted");
    const credential = await this.mintFor(action, objectKey, signal);
    // A credential that arrived after the abort is dropped here, unused.
    if (signal?.aborted) throw new DelegatedR2Error("aborted");

    return this.createWriter({
      accountId: this.deps.location.accountId,
      bucket: this.deps.location.bucket,
      jurisdiction: this.deps.location.jurisdiction,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      // Always supplied. A delegated credential is only valid together with
      // its session token, which is what carries the scoped policy.
      sessionToken: credential.sessionToken,
    });
  }

  private async mintFor(
    action: R2DelegatedAction,
    objectKey: WorkerObjectKey,
    signal: AbortSignal | undefined,
  ): Promise<R2TemporaryCredential> {
    const nowMs = this.clock();

    // The job binding is structural: the key contains its job id. A key whose
    // job id cannot be recovered is not usable for a scoped mint.
    const jobId = jobIdFromObjectKey(objectKey);
    if (jobId === null) throw new DelegatedR2Error("invalid_object_key");

    let jobDeadlineMs: number | null = null;
    try {
      jobDeadlineMs = this.deps.jobDeadlineAt?.(jobId) ?? null;
    } catch {
      // A deadline lookup failure must not fail the operation — it only costs
      // us the ability to shorten the TTL below the action's ceiling.
      jobDeadlineMs = null;
    }

    const ttl = deriveCredentialTtlSeconds({ action, nowMs, jobDeadlineMs });
    if (!ttl.ok) {
      // A deadline-bound operation on an expired job. The broker is never
      // contacted: there is no TTL that would be both usable and inside the
      // job's authorization window.
      throw new DelegatedR2Error("job_expired");
    }
    const ttlSeconds = ttl.ttlSeconds;

    let credential: R2TemporaryCredential;
    try {
      const request = { action, objectKey, ttlSeconds };
      // The signal travels with the request, so an abort ends the broker
      // exchange instead of waiting out the client's own timeout.
      credential = await (signal
        ? this.deps.credentials.mint(request, { signal })
        : this.deps.credentials.mint(request));
    } catch (error) {
      if (signal?.aborted) throw new DelegatedR2Error("aborted");
      throw new DelegatedR2Error("credential_unavailable", error);
    }

    // Second, independent expiry gate. The client checks this too; doing it
    // again here means no code path can present an expired grant to R2.
    if (
      !Number.isSafeInteger(credential.expiresAt) ||
      credential.expiresAt <= nowMs ||
      credential.sessionToken.length === 0
    ) {
      throw new DelegatedR2Error("credential_unavailable");
    }

    return credential;
  }
}

/** An operation that rejected: `aborted` when the caller's signal ended it. */
function operationFailure(signal: AbortSignal | undefined, error: unknown): DelegatedR2Error {
  return signal?.aborted
    ? new DelegatedR2Error("aborted", error)
    : new DelegatedR2Error("operation_failed", error);
}
