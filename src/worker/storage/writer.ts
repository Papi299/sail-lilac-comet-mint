import { z } from "zod";
import { WorkerObjectKeySchema } from "../../shared/worker/contracts.ts";

export const ObjectStorePutInputSchema = z.object({
  objectKey: WorkerObjectKeySchema,
  body: z.custom<AsyncIterable<Uint8Array>>(
    (val) => val != null && typeof (val as any)[Symbol.asyncIterator] === "function",
    "Must be an AsyncIterable<Uint8Array>"
  ),
  contentLength: z.number().int().nonnegative(),
  contentType: z.string().min(1).regex(/^[^\r\n]+$/, "no control characters allowed"),
  contentDisposition: z.string().min(1).regex(/^[^\r\n]+$/, "no control characters allowed"),
}).strict();

export type ObjectStorePutInput = z.infer<typeof ObjectStorePutInputSchema>;

export const ObjectStoreHeadSchema = z.object({
  objectKey: WorkerObjectKeySchema,
  contentLength: z.number().int().nonnegative(),
  contentType: z.string().min(1).regex(/^[^\r\n]+$/, "no control characters allowed"),
  contentDisposition: z.string().min(1).regex(/^[^\r\n]+$/, "no control characters allowed"),
}).strict();

export type ObjectStoreHead = z.infer<typeof ObjectStoreHeadSchema>;

/**
 * Provider-neutral boundary for object storage operations.
 * Must NOT expose presigned URLs, list operations, or wildcard deletes.
 */
export interface ObjectStoreWriter {
  /**
   * Uploads an object. Throws on failure.
   */
  put(input: ObjectStorePutInput): Promise<void>;

  /**
   * Retrieves object metadata.
   * Returns null if the object is missing.
   * Throws on operational failure.
   */
  head(objectKey: string): Promise<ObjectStoreHead | null>;

  /**
   * Deletes exactly one object by key.
   * Succeeds silently if the object is already missing.
   * Throws on operational failure.
   */
  delete(objectKey: string): Promise<void>;
}
