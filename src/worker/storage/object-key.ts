import { randomBytes } from "node:crypto";
import { WorkerJobIdSchema, WorkerObjectKeySchema } from "../../shared/worker/contracts.ts";

/**
 * Generates an opaque, cryptographically random object key bound to a given job ID.
 * The token is exactly 16 cryptographically random bytes encoded as lowercase hex (128 bits).
 * 
 * @param jobId The job ID to bind the object key to.
 * @param randomSource Test-only injection point for deterministic randomness.
 * @returns A validated WorkerObjectKey string.
 */
export function generateWorkerObjectKey(
  jobId: string,
  randomSource: () => Uint8Array = () => randomBytes(16)
): string {
  WorkerJobIdSchema.parse(jobId);

  const bytes = randomSource();
  if (bytes.length !== 16) {
    throw new Error("randomSource must generate exactly 16 bytes");
  }

  const hex = Buffer.from(bytes).toString("hex").toLowerCase();
  
  const key = `videofetch/jobs/${jobId}/${hex}`;
  
  return WorkerObjectKeySchema.parse(key);
}
