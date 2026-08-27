import { test } from "node:test";
import assert from "node:assert";
import { Buffer } from "node:buffer";
import { WorkerAuthenticator, WORKER_REPLAY_GRACE_SECONDS, WorkerAuthenticationError, WorkerReplayStoreUnavailableError } from "./authenticate.server.ts";
import { WORKER_TIMESTAMP_TOLERANCE_SECONDS } from "../../shared/worker/constants.ts";
import { createWorkerSignatureHex } from "../../shared/worker/hmac.server.ts";
import type { WorkerReplayStore } from "./replay-store.ts";
import { createHash } from "node:crypto";

class MockReplayStore implements WorkerReplayStore {
  private reserved = new Set<string>();
  public reserveCalls: { requestId: string; expiresAtSeconds: number }[] = [];
  public shouldThrow: boolean | Error = false;

  async reserve(requestId: string, expiresAtSeconds: number): Promise<"reserved" | "duplicate"> {
    if (this.shouldThrow) {
      throw (this.shouldThrow instanceof Error ? this.shouldThrow : new Error("Database unavailable"));
    }
    this.reserveCalls.push({ requestId, expiresAtSeconds });
    if (this.reserved.has(requestId)) return "duplicate";
    this.reserved.add(requestId);
    return "reserved";
  }
}

test("WorkerAuthenticator", async (t) => {
  const currentSecret = "0123456789abcdef0123456789abcdef"; // 32 bytes
  const previousSecret = "fedcba9876543210fedcba9876543210"; // 32 bytes

  const now = 1700000000;
  const mockClock = () => now;
  
  let replayStore: MockReplayStore;
  let authenticator: WorkerAuthenticator;

  t.beforeEach(() => {
    replayStore = new MockReplayStore();
    authenticator = new WorkerAuthenticator({
      currentKeyId: "key-1",
      currentSecret,
      previousKeyId: "key-0",
      previousSecret,
      replayStore,
      clock: mockClock,
    });
  });

  function createParams(override: any = {}, secret = currentSecret) {
    const p = {
      keyId: "key-1",
      method: "POST" as const,
      canonicalPath: "/v1/analyze",
      timestampSeconds: String(now),
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      rawBody: Buffer.from(""),
      ...override,
    };
    
    if (!p.signatureHex) {
      const sha256RawBody = createHash("sha256").update(p.rawBody).digest("hex");
      p.signatureHex = createWorkerSignatureHex(secret, {
        keyId: p.keyId,
        method: p.method,
        canonicalPath: p.canonicalPath,
        timestampSeconds: p.timestampSeconds,
        requestId: p.requestId,
        idempotencyKey: p.idempotencyKey,
        sha256RawBody,
      });
    }
    
    return p;
  }

  await t.test("accepts valid current key signature and reserves ID", async () => {
    const p = createParams();
    await authenticator.authenticateAndReserve(p);
    assert.strictEqual(replayStore.reserveCalls.length, 1);
    
    const expectedExpiry = now + WORKER_TIMESTAMP_TOLERANCE_SECONDS + WORKER_REPLAY_GRACE_SECONDS;
    assert.strictEqual(replayStore.reserveCalls[0].expiresAtSeconds, expectedExpiry);
  });

  await t.test("accepts valid previous key signature", async () => {
    const p = createParams({ keyId: "key-0" }, previousSecret);
    await authenticator.authenticateAndReserve(p);
    assert.strictEqual(replayStore.reserveCalls.length, 1);
  });

  await t.test("rejects unknown key", async () => {
    const p = createParams({ keyId: "key-2" });
    await assert.rejects(authenticator.authenticateAndReserve(p), WorkerAuthenticationError);
    assert.strictEqual(replayStore.reserveCalls.length, 0); // No reserve on bad auth
  });

  await t.test("rejects bad signature", async () => {
    const p = createParams({ signatureHex: "0000000000000000000000000000000000000000000000000000000000000000" });
    await assert.rejects(authenticator.authenticateAndReserve(p), WorkerAuthenticationError);
    assert.strictEqual(replayStore.reserveCalls.length, 0);
  });

  await t.test("accepts -300s timestamp", async () => {
    const p = createParams({ timestampSeconds: String(now - 300) });
    await authenticator.authenticateAndReserve(p);
    assert.strictEqual(replayStore.reserveCalls.length, 1);
  });

  await t.test("accepts +300s timestamp", async () => {
    const p = createParams({ timestampSeconds: String(now + 300) });
    await authenticator.authenticateAndReserve(p);
    assert.strictEqual(replayStore.reserveCalls.length, 1);
  });

  await t.test("rejects -301s timestamp", async () => {
    const p = createParams({ timestampSeconds: String(now - 301) });
    await assert.rejects(authenticator.authenticateAndReserve(p), WorkerAuthenticationError);
    assert.strictEqual(replayStore.reserveCalls.length, 0);
  });

  await t.test("rejects +301s timestamp", async () => {
    const p = createParams({ timestampSeconds: String(now + 301) });
    await assert.rejects(authenticator.authenticateAndReserve(p), WorkerAuthenticationError);
    assert.strictEqual(replayStore.reserveCalls.length, 0);
  });

  await t.test("rejects duplicate request ID (replay)", async () => {
    const p = createParams();
    await authenticator.authenticateAndReserve(p); // First succeeds
    await assert.rejects(authenticator.authenticateAndReserve(p), WorkerAuthenticationError); // Second fails
    assert.strictEqual(replayStore.reserveCalls.length, 2);
  });

  await t.test("fails closed on replay store failure", async () => {
    const p = createParams();
    replayStore.shouldThrow = true;
    await assert.rejects(authenticator.authenticateAndReserve(p), WorkerReplayStoreUnavailableError);
  });

  await t.test("fails closed on replay store failure even if error message is unauthorized", async () => {
    const p = createParams();
    replayStore.shouldThrow = new Error("unauthorized");
    await assert.rejects(authenticator.authenticateAndReserve(p), WorkerReplayStoreUnavailableError);
  });

  await t.test("fails closed on replay store throwing WorkerAuthenticationError", async () => {
    const p = createParams();
    replayStore.shouldThrow = new WorkerAuthenticationError();
    await assert.rejects(authenticator.authenticateAndReserve(p), WorkerReplayStoreUnavailableError);
  });

  await t.test("duplicate replay returns WorkerAuthenticationError", async () => {
    const p = createParams();
    await authenticator.authenticateAndReserve(p); // first: reserved
    await assert.rejects(authenticator.authenticateAndReserve(p), WorkerAuthenticationError);
  });

  await t.test("constructor validates config", () => {
    assert.throws(() => {
      new WorkerAuthenticator({
        currentKeyId: "key-1",
        currentSecret: "short", // < 32 bytes
        replayStore,
      });
    }, /must be at least 32 bytes/);

    assert.throws(() => {
      new WorkerAuthenticator({
        currentKeyId: "key-1",
        currentSecret,
        previousKeyId: "key-1", // same as current
        previousSecret,
        replayStore,
      });
    }, /distinct/);
  });
});
