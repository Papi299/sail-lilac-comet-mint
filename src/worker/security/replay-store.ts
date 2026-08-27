/**
 * Replay-store abstraction.
 * Used to atomically reserve request IDs to prevent replay attacks.
 */
export interface WorkerReplayStore {
  /**
   * Atomically reserve the request ID until `expiresAtSeconds`.
   * @param requestId The UUID v4 request ID.
   * @param expiresAtSeconds The epoch seconds when the reservation can be safely removed.
   * @returns "reserved" if successfully reserved, "duplicate" if the request ID was already reserved.
   * @throws Fails closed if the storage is unavailable.
   */
  reserve(
    requestId: string,
    expiresAtSeconds: number
  ): Promise<"reserved" | "duplicate">;
}
