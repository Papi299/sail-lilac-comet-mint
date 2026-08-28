import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";

export interface ObjectStoreSigner {
  signGet(input: {
    objectKey: WorkerObjectKey;
    expiresAt: number;
  }): Promise<{
    url: string;
    expiresAt: number;
  }>;
}
