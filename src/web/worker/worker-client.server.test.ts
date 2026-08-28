import { describe, it } from "node:test";
import assert from "node:assert";
import { WorkerClient } from "./worker-client.server.ts";
import { AppError } from "../../lib/errors.ts";
import { sha256WorkerBody } from "../../shared/worker/auth.ts";
import { createWorkerSignatureHex } from "../../shared/worker/hmac.server.ts";

describe("WorkerClient", () => {
  const TEST_SECRET = "01234567890123456789012345678901"; // 32 bytes
  const TEST_KEY_ID = "test-key-id";
  const BASE_URL = "https://worker.internal";

  it("calculates HMAC correctly for analyze (no idempotency)", async () => {
    let capturedOptions: any;

    const mockFetch = async (_url: string, options: any) => {
      capturedOptions = options;
      return new Response(JSON.stringify({ success: true, video: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = new WorkerClient({
      baseUrl: BASE_URL,
      currentKeyId: TEST_KEY_ID,
      currentSecret: TEST_SECRET,
      fetchImplementation: mockFetch,
      requestIdFactory: () => "00000000-0000-4000-8000-000000000000",
    });

    const body = { url: "https://example.com/video" };
    
    // We mock Date.now to be deterministic for this test by replacing global Date.now
    const originalDateNow = Date.now;
    global.Date.now = () => 1234567890000;
    
    try {
      // Mock success schema parse to bypass strict validation of returned video metadata
      const analyzePromise = client.analyze(body as any);
      // Wait for it to fail validation on return, but fetch will have been called.
      await analyzePromise.catch(() => {});
    } finally {
      global.Date.now = originalDateNow;
    }

    assert.ok(capturedOptions);
    const headers = capturedOptions.headers as Headers;
    assert.strictEqual(headers.get("x-videofetch-key-id"), TEST_KEY_ID);
    assert.strictEqual(headers.get("x-videofetch-timestamp"), "1234567890");
    assert.strictEqual(headers.get("x-videofetch-request-id"), "00000000-0000-4000-8000-000000000000");
    assert.strictEqual(headers.has("Idempotency-Key"), false);

    const sentBodyStr = capturedOptions.body.toString("utf8");
    const rawBodyBuffer = Buffer.from(sentBodyStr, "utf8");
    const sentSha256 = sha256WorkerBody(rawBodyBuffer);
    
    const expectedSig = createWorkerSignatureHex(TEST_SECRET, {
      keyId: TEST_KEY_ID,
      method: "POST",
      canonicalPath: "/v1/analyze",
      timestampSeconds: "1234567890",
      requestId: "00000000-0000-4000-8000-000000000000",
      idempotencyKey: undefined,
      sha256RawBody: sentSha256,
    });

    assert.strictEqual(headers.get("x-videofetch-signature"), expectedSig);
    assert.strictEqual(sentSha256, sha256WorkerBody(Buffer.from(JSON.stringify(body))));
  });

  it("calculates HMAC correctly for createJob (with idempotency)", async () => {
    let capturedOptions: any;

    const mockFetch = async (url: string, options: any) => {
      capturedOptions = options;
      return new Response(JSON.stringify({ success: true, job: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = new WorkerClient({
      baseUrl: BASE_URL,
      currentKeyId: TEST_KEY_ID,
      currentSecret: TEST_SECRET,
      fetchImplementation: mockFetch,
      requestIdFactory: () => "00000000-0000-4000-8000-000000000000",
      idempotencyKeyFactory: () => "11111111-1111-4111-8111-111111111111",
    });

    const body = { url: "https://example.com/video", formatId: "best" };
    
    const originalDateNow = Date.now;
    global.Date.now = () => 1234567890000;
    
    try {
      await client.createJob(body as any).catch(() => {});
    } finally {
      global.Date.now = originalDateNow;
    }

    const headers = capturedOptions.headers as Headers;
    assert.strictEqual(headers.get("Idempotency-Key"), "11111111-1111-4111-8111-111111111111");

    const sentBodyStr = capturedOptions.body.toString("utf8");
    const rawBodyBuffer = Buffer.from(sentBodyStr, "utf8");
    const sentSha256 = sha256WorkerBody(rawBodyBuffer);
    
    const expectedSig = createWorkerSignatureHex(TEST_SECRET, {
      keyId: TEST_KEY_ID,
      method: "POST",
      canonicalPath: "/v1/jobs",
      timestampSeconds: "1234567890",
      requestId: "00000000-0000-4000-8000-000000000000",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      sha256RawBody: sentSha256,
    });

    assert.strictEqual(headers.get("x-videofetch-signature"), expectedSig);
  });

  it("handles network failure by throwing WORKER_UNAVAILABLE", async () => {
    const client = new WorkerClient({
      baseUrl: BASE_URL,
      currentKeyId: TEST_KEY_ID,
      currentSecret: TEST_SECRET,
      fetchImplementation: async () => { throw new Error("fetch failed"); },
    });

    await assert.rejects(
      async () => client.getJob("00000000000000000000000000000000"),
      (err: any) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE"
    );
  });

  it("handles timeout by throwing WORKER_UNAVAILABLE", async () => {
    const client = new WorkerClient({
      baseUrl: BASE_URL,
      currentKeyId: TEST_KEY_ID,
      currentSecret: TEST_SECRET,
      requestTimeoutMs: 1000,
      fetchImplementation: async (url: string, opts: any) => {
        return new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("abort")));
        });
      },
    });

    await assert.rejects(
      async () => client.getJob("00000000000000000000000000000000"),
      (err: any) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE"
    );
  });

  it("maps valid worker error code to AppError", async () => {
    const client = new WorkerClient({
      baseUrl: BASE_URL,
      currentKeyId: TEST_KEY_ID,
      currentSecret: TEST_SECRET,
      fetchImplementation: async () => new Response(JSON.stringify({
        success: false,
        error: { code: "RATE_LIMITED", message: "ignored msg" }
      }), { status: 429, headers: { "Content-Type": "application/json" } }),
    });

    await assert.rejects(
      async () => client.getJob("00000000000000000000000000000000"),
      (err: any) => err instanceof AppError && err.code === "RATE_LIMITED" && err.message !== "ignored msg"
    );
  });
  
  it("maps unknown worker error code to PROCESSING_FAILED", async () => {
    const client = new WorkerClient({
      baseUrl: BASE_URL,
      currentKeyId: TEST_KEY_ID,
      currentSecret: TEST_SECRET,
      fetchImplementation: async () => new Response(JSON.stringify({
        success: false,
        error: { code: "BOGUS_CODE", message: "ignored msg" }
      }), { status: 400, headers: { "Content-Type": "application/json" } }),
    });

    await assert.rejects(
      async () => client.getJob("00000000000000000000000000000000"),
      (err: any) => err instanceof AppError && err.code === "PROCESSING_FAILED"
    );
  });
});
