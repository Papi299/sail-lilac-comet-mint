export interface ObjectStoreSigner {
  signGet(input: {
    objectKey: string; // WorkerObjectKey
    expiresAt: number; // epoch ms
  }): Promise<{
    url: string;
    expiresAt: number;
  }>;
}
