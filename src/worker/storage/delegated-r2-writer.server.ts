import {
  ObjectStoreHeadSchema,
  ObjectStorePutInputSchema,
  type ObjectStoreHead,
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
 */

export type DelegatedR2Failure =
  | "invalid_object_key"
  | "invalid_input"
  | "credential_unavailable"
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

  public async put(input: ObjectStorePutInput): Promise<void> {
    let validated: ObjectStorePutInput;
    try {
      validated = ObjectStorePutInputSchema.parse(input);
    } catch (error) {
      throw new DelegatedR2Error("invalid_input", error);
    }

    const writer = await this.writerFor("put", validated.objectKey);
    try {
      await writer.put(validated);
    } catch (error) {
      throw new DelegatedR2Error("operation_failed", error);
    }
  }

  public async head(objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    const key = this.validateKey(objectKey);
    const writer = await this.writerFor("head", key);

    let result: ObjectStoreHead | null;
    try {
      result = await writer.head(key);
    } catch (error) {
      throw new DelegatedR2Error("operation_failed", error);
    }

    // A missing object stays a missing object, exactly as the contract says.
    if (result === null) return null;

    try {
      return ObjectStoreHeadSchema.parse(result);
    } catch (error) {
      throw new DelegatedR2Error("operation_failed", error);
    }
  }

  public async delete(objectKey: WorkerObjectKey): Promise<void> {
    const key = this.validateKey(objectKey);
    const writer = await this.writerFor("delete", key);
    try {
      await writer.delete(key);
    } catch (error) {
      throw new DelegatedR2Error("operation_failed", error);
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
   */
  private async writerFor(
    operation: "put" | "head" | "delete",
    objectKey: WorkerObjectKey,
  ): Promise<ObjectStoreWriter> {
    const action = actionForOperation(operation);
    const credential = await this.mintFor(action, objectKey);

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

    const ttlSeconds = deriveCredentialTtlSeconds({ action, nowMs, jobDeadlineMs });

    let credential: R2TemporaryCredential;
    try {
      credential = await this.deps.credentials.mint({ action, objectKey, ttlSeconds });
    } catch (error) {
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
