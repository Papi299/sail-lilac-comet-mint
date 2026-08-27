import { createHash } from "node:crypto";
import type { WorkerCreateJobRequest } from "../../shared/worker/contracts.ts";

export const WORKER_IDEMPOTENCY_MIN_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

export function generateIdempotencyFingerprint(request: WorkerCreateJobRequest): string {
  const canonicalBytes = JSON.stringify([
    request.url,
    request.formatId,
    request.principalId
  ]);
  return createHash("sha256").update(canonicalBytes).digest("hex");
}
