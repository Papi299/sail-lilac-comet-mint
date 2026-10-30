/* eslint-disable no-control-regex */
import { z } from "zod";
import { WorkerObjectKeySchema, type WorkerObjectKey } from "../../shared/worker/contracts.ts";

export const ObjectStorePutInputSchema = z.object({
  objectKey: WorkerObjectKeySchema,
  body: z.custom<AsyncIterable<Uint8Array>>(
    (val) => val != null && typeof (val as any)[Symbol.asyncIterator] === "function",
    "Must be an AsyncIterable<Uint8Array>"
  ),
  contentLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contentType: z.string().min(1).max(255).regex(/^[^\x00-\x1F\x7F]+$/, "no control characters allowed"),
  contentDisposition: z.string().min(1).max(1024).regex(/^[^\x00-\x1F\x7F]+$/, "no control characters allowed"),
}).strict();

export type ObjectStorePutInput = z.infer<typeof ObjectStorePutInputSchema>;

export const ObjectStoreHeadSchema = z.object({
  objectKey: WorkerObjectKeySchema,
  contentLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contentType: z.string().min(1).max(255).regex(/^[^\x00-\x1F\x7F]+$/, "no control characters allowed"),
  contentDisposition: z.string().min(1).max(1024).regex(/^[^\x00-\x1F\x7F]+$/, "no control characters allowed"),
}).strict();

export type ObjectStoreHead = z.infer<typeof ObjectStoreHeadSchema>;

/**
 * VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001: how the caller can end ONE
 * operation early.
 *
 * Aborting `signal` must end the operation for real: no credential is acquired
 * after it, no request is started after it, and a request already in flight is
 * torn down — its socket destroyed and, for a put, its body no longer read.
 * The operation then rejects. An implementation must never merely stop
 * waiting while the request carries on.
 *
 * Absent, the operation is bounded only by its implementation's own transport
 * limits. The context carries no deadline of its own: a caller with one aborts
 * the signal when it passes.
 */
export type ObjectStoreOperationContext = {
  readonly signal?: AbortSignal;
};

/**
 * Provider-neutral boundary for object storage operations.
 * Must NOT expose presigned URLs, list operations, or wildcard deletes.
 */
export interface ObjectStoreWriter {
  /**
   * Uploads an object. Throws on failure, including when `context.signal`
   * aborts it.
   */
  put(input: ObjectStorePutInput, context?: ObjectStoreOperationContext): Promise<void>;

  /**
   * Retrieves object metadata.
   * Returns null if the object is missing.
   * Throws on operational failure, including when `context.signal` aborts it.
   */
  head(objectKey: WorkerObjectKey, context?: ObjectStoreOperationContext): Promise<ObjectStoreHead | null>;

  /**
   * Deletes exactly one object by key.
   * Succeeds silently if the object is already missing.
   * Throws on operational failure, including when `context.signal` aborts it.
   */
  delete(objectKey: WorkerObjectKey, context?: ObjectStoreOperationContext): Promise<void>;
}
