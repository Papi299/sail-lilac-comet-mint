type Bucket = { timestamps: number[] };

const windows = new Map<string, Bucket>();

function prune(bucket: Bucket, now: number, windowMs: number) {
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
}

export function consumeRateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const bucket = windows.get(key) ?? { timestamps: [] };
  prune(bucket, now, windowMs);
  if (bucket.timestamps.length >= limit) {
    windows.set(key, bucket);
    return false;
  }
  bucket.timestamps.push(now);
  windows.set(key, bucket);
  return true;
}

export function remainingRateLimit(key: string, limit: number, windowMs = 60_000): number {
  const now = Date.now();
  const bucket = windows.get(key) ?? { timestamps: [] };
  prune(bucket, now, windowMs);
  return Math.max(0, limit - bucket.timestamps.length);
}

export function resetRateLimitForTests() {
  windows.clear();
}
