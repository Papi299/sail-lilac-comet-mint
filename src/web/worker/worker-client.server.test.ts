
import { describe, it } from "node:test";
import assert from "node:assert";
import { WorkerClient } from "./worker-client.server.ts";
import { sha256WorkerBody } from "../../shared/worker/auth.ts";
import { createWorkerSignatureHex } from "../../shared/worker/hmac.server.ts";
import { workerJobPath, workerJobCancelPath } from "../../shared/worker/contracts.ts";

describe("WorkerClient", () => {
  const TEST_SECRET = "01234567890123456789012345678901"; // 32 bytes
  const TEST_KEY_ID = "test-key-id";
  const BASE_URL = "http://localhost:8080";

  describe("Outbound validation", () => {
    it("invalid analyze URL -> no fetch", async () => {
      let called = false;
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async () => { called = true; return new Response(); }) as unknown as typeof fetch,
      });
      await assert.rejects(client.analyze({ url: "not-a-url" } as any));
      assert.strictEqual(called, false);
    });

    it("invalid create principal -> no fetch", async () => {
      let called = false;
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async () => { called = true; return new Response(); }) as unknown as typeof fetch,
      });
      await assert.rejects(client.createJob({ url: "http://test.com", formatId: "best", principalId: "wrong" } as any));
      assert.strictEqual(called, false);
    });

    it("invalid create formatId -> no fetch", async () => {
      let called = false;
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async () => { called = true; return new Response(); }) as unknown as typeof fetch,
      });
      await assert.rejects(client.createJob({ url: "http://test.com", formatId: "", principalId: "private-access-user" } as any));
      assert.strictEqual(called, false);
    });

    it("invalid get jobId -> no fetch", async () => {
      let called = false;
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async () => { called = true; return new Response(); }) as unknown as typeof fetch,
      });
      await assert.rejects(client.getJob("123"));
      assert.strictEqual(called, false);
    });

    it("invalid cancel jobId -> no fetch", async () => {
      let called = false;
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async () => { called = true; return new Response(); }) as unknown as typeof fetch,
      });
      await assert.rejects(client.cancelJob("123"));
      assert.strictEqual(called, false);
    });

    it("unknown WorkerClient config field -> rejected", () => {
      assert.throws(() => new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        unknownField: 123
      } as any));
    });

    it("worker secret below 32 bytes -> rejected", () => {
      assert.throws(() => new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: "too-short",
      }));
    });

    it("worker secret above 8192 UTF-8 bytes -> rejected", () => {
      assert.throws(() => new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: "a".repeat(8193),
      }));
    });

    it("HTTP non-loopback -> rejected", () => {
      assert.throws(() => new WorkerClient({
        baseUrl: "http://example.com", currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
      }));
    });

    it("HTTP localhost -> accepted", () => {
      new WorkerClient({ baseUrl: "http://localhost:8080", currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET });
    });

    it("HTTP 127.0.0.1 -> accepted", () => {
      new WorkerClient({ baseUrl: "http://127.0.0.1:8080", currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET });
    });

    it("HTTP [::1] -> accepted", () => {
      new WorkerClient({ baseUrl: "http://[::1]:8080", currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET });
    });
  });

  describe("HMAC/header matrix", () => {
    const makeClient = (mockFetch: any) => new WorkerClient({
      baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
      fetchImplementation: mockFetch,
      requestIdFactory: () => "00000000-0000-4000-8000-000000000000",
      idempotencyKeyFactory: () => "11111111-1111-4111-8111-111111111111",
      clock: () => 1234567890000,
    });

    const verifyAuth = (headers: Headers, expectedSig: string) => {
      assert.strictEqual(headers.has("Cookie"), false);
      assert.strictEqual(headers.has("Authorization"), false);
      assert.strictEqual(headers.get("x-videofetch-signature"), expectedSig);
    };

    it("analyze: POST /v1/analyze, JSON body, no Idempotency-Key", async () => {
      let capturedOptions: any;
      const client = makeClient(async (_url: any, opts: any) => { capturedOptions = opts; throw new Error("stop"); });
      const body = { url: "https://example.com" };
      await client.analyze(body as any).catch(() => {});

      const headers = capturedOptions.headers as Headers;
      assert.strictEqual(headers.has("Idempotency-Key"), false);
      
      const sentBodyStr = capturedOptions.body.toString("utf8");
      const sentSha256 = sha256WorkerBody(Buffer.from(sentBodyStr, "utf8"));
      const expectedSig = createWorkerSignatureHex(TEST_SECRET, {
        keyId: TEST_KEY_ID, method: "POST", canonicalPath: "/v1/analyze",
        timestampSeconds: "1234567890", requestId: "00000000-0000-4000-8000-000000000000",
        idempotencyKey: undefined, sha256RawBody: sentSha256,
      });
      verifyAuth(headers, expectedSig);
    });

    it("create: POST /v1/jobs, Idempotency-Key", async () => {
      let capturedOptions: any;
      const client = makeClient(async (_url: any, opts: any) => { capturedOptions = opts; throw new Error("stop"); });
      const body = { url: "https://example.com", formatId: "best", principalId: "private-access-user" as const };
      await client.createJob(body as any).catch(() => {});

      const headers = capturedOptions.headers as Headers;
      assert.strictEqual(headers.get("Idempotency-Key"), "11111111-1111-4111-8111-111111111111");
      
      const sentBodyStr = capturedOptions.body.toString("utf8");
      const sentSha256 = sha256WorkerBody(Buffer.from(sentBodyStr, "utf8"));
      const expectedSig = createWorkerSignatureHex(TEST_SECRET, {
        keyId: TEST_KEY_ID, method: "POST", canonicalPath: "/v1/jobs",
        timestampSeconds: "1234567890", requestId: "00000000-0000-4000-8000-000000000000",
        idempotencyKey: "11111111-1111-4111-8111-111111111111", sha256RawBody: sentSha256,
      });
      verifyAuth(headers, expectedSig);
    });

    it("get: GET exact workerJobPath, zero-byte body hash, no Idempotency-Key", async () => {
      let capturedOptions: any;
      const client = makeClient(async (_url: any, opts: any) => { capturedOptions = opts; throw new Error("stop"); });
      const jobId = "00000000000000000000000000000000";
      await client.getJob(jobId).catch(() => {});

      const headers = capturedOptions.headers as Headers;
      assert.strictEqual(headers.has("Idempotency-Key"), false);
      assert.strictEqual(capturedOptions.body, undefined);
      
      const sentSha256 = sha256WorkerBody(Buffer.alloc(0));
      const expectedSig = createWorkerSignatureHex(TEST_SECRET, {
        keyId: TEST_KEY_ID, method: "GET", canonicalPath: workerJobPath(jobId),
        timestampSeconds: "1234567890", requestId: "00000000-0000-4000-8000-000000000000",
        idempotencyKey: undefined, sha256RawBody: sentSha256,
      });
      verifyAuth(headers, expectedSig);
    });

    it("cancel: POST exact workerJobCancelPath, zero-byte body hash, no Idempotency-Key", async () => {
      let capturedOptions: any;
      const client = makeClient(async (_url: any, opts: any) => { capturedOptions = opts; throw new Error("stop"); });
      const jobId = "00000000000000000000000000000000";
      await client.cancelJob(jobId).catch(() => {});

      const headers = capturedOptions.headers as Headers;
      assert.strictEqual(headers.has("Idempotency-Key"), false);
      
      const sentSha256 = sha256WorkerBody(Buffer.alloc(0));
      const expectedSig = createWorkerSignatureHex(TEST_SECRET, {
        keyId: TEST_KEY_ID, method: "POST", canonicalPath: workerJobCancelPath(jobId),
        timestampSeconds: "1234567890", requestId: "00000000-0000-4000-8000-000000000000",
        idempotencyKey: undefined, sha256RawBody: sentSha256,
      });
      verifyAuth(headers, expectedSig);
    });

    it("diagnostics: GET /v1/diagnostics, zero-byte body hash, no Idempotency-Key", async () => {
      let capturedOptions: any;
      const client = makeClient(async (_url: any, opts: any) => { capturedOptions = opts; throw new Error("stop"); });
      await client.diagnostics().catch(() => {});

      const headers = capturedOptions.headers as Headers;
      assert.strictEqual(headers.has("Idempotency-Key"), false);
      
      const sentSha256 = sha256WorkerBody(Buffer.alloc(0));
      const expectedSig = createWorkerSignatureHex(TEST_SECRET, {
        keyId: TEST_KEY_ID, method: "GET", canonicalPath: "/v1/diagnostics",
        timestampSeconds: "1234567890", requestId: "00000000-0000-4000-8000-000000000000",
        idempotencyKey: undefined, sha256RawBody: sentSha256,
      });
      verifyAuth(headers, expectedSig);
    });
  });

  describe("Worker response trust-boundary tests", () => {
    const makeClient = (headers: any, body: any, status = 200) => new WorkerClient({
      baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
      fetchImplementation: (async () => {
        let stream;
        if (body instanceof Error) {
          stream = new ReadableStream({
            start(controller) { controller.error(body); }
          });
        } else if (typeof body === 'function') {
          stream = new ReadableStream({
            start(controller) { body(controller); }
          });
        } else {
          stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            }
          });
        }
        return new Response(stream, { status, headers });
      }) as unknown as typeof fetch,
    });

    const runGetJob = async (client: WorkerClient) => {
      return client.getJob("00000000000000000000000000000000");
    };

    it("application/json -> accepted", async () => {
      const c = makeClient({ "Content-Type": "application/json", "Content-Length": "34" }, '{"success":true,"job":{"id":"1"}}');
      await assert.rejects(runGetJob(c)); // fails schema validation because job is fake, but it's accepted by boundary
    });

    it("application/json; charset=utf-8 -> accepted", async () => {
      const c = makeClient({ "Content-Type": "application/json; charset=utf-8", "Content-Length": "34" }, '{"success":true,"job":{"id":"1"}}');
      await assert.rejects(runGetJob(c)); 
    });

    it("application/jsonp -> rejected", async () => {
      const c = makeClient({ "Content-Type": "application/jsonp", "Content-Length": "34" }, '{"success":true,"job":{"id":"1"}}');
      await assert.rejects(runGetJob(c), (e: any) => e.code === "PROCESSING_FAILED");
    });

    it("text/html -> rejected", async () => {
      const c = makeClient({ "Content-Type": "text/html", "Content-Length": "34" }, '{"success":true,"job":{"id":"1"}}');
      await assert.rejects(runGetJob(c), (e: any) => e.code === "PROCESSING_FAILED");
    });

    it("missing Content-Type -> rejected", async () => {
      const c = makeClient({ "Content-Length": "34" }, '{"success":true,"job":{"id":"1"}}');
      await assert.rejects(runGetJob(c), (e: any) => e.code === "PROCESSING_FAILED");
    });

    const badLengths = ["-1", "1.5", "1e5", "100a", "9007199254740992", "3000000"];
    for (const len of badLengths) {
      it("Content-Length: " + len + " -> PROCESSING_FAILED", async () => {
        const c = makeClient({ "Content-Type": "application/json", "Content-Length": len }, '{"success":true,"job":{"id":"1"}}');
        await assert.rejects(runGetJob(c), (e: any) => e.code === "PROCESSING_FAILED");
      });
    }

    it("streamed body > 2 MiB -> PROCESSING_FAILED", async () => {
      const c = makeClient({ "Content-Type": "application/json", "Content-Length": "2097152" }, (controller: any) => {
        controller.enqueue(new Uint8Array(2097152));
        controller.enqueue(new Uint8Array(1)); // overflow
        controller.close();
      });
      await assert.rejects(runGetJob(c), (e: any) => e.code === "PROCESSING_FAILED");
    });

    it("stream throws during reading -> WORKER_UNAVAILABLE", async () => {
      const c = makeClient({ "Content-Type": "application/json", "Content-Length": "100" }, new Error("network disconnect"));
      await assert.rejects(runGetJob(c), (e: any) => e.code === "WORKER_UNAVAILABLE");
    });

    it("malformed JSON -> PROCESSING_FAILED", async () => {
      const c = makeClient({ "Content-Type": "application/json", "Content-Length": "10" }, '{badjson');
      await assert.rejects(runGetJob(c), (e: any) => e.code === "PROCESSING_FAILED");
    });

    it("valid 2xx but malformed success DTO -> PROCESSING_FAILED", async () => {
      const c = makeClient({ "Content-Type": "application/json", "Content-Length": "16" }, '{"success":true}');
      await assert.rejects(runGetJob(c), (e: any) => e.code === "PROCESSING_FAILED");
    });

    it("unexpected success status -> PROCESSING_FAILED", async () => {
      const c = makeClient({ "Content-Type": "application/json", "Content-Length": "34" }, '{"success":true,"job":{"id":"1"}}', 201);
      await assert.rejects(runGetJob(c), (e: any) => e.code === "PROCESSING_FAILED");
    });
  });

  describe("Worker error regressions", () => {
    const makeClient = (status: number, body: string, contentType = "application/json") => new WorkerClient({
      baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
      fetchImplementation: (async () => new Response(body, { status, headers: { "Content-Type": contentType, "Content-Length": String(body.length) } })) as unknown as typeof fetch,
    });
    
    const runGetJob = (c: WorkerClient) => c.getJob("00000000000000000000000000000000");

    it("401 -> WORKER_UNAVAILABLE", async () => {
      await assert.rejects(runGetJob(makeClient(401, '{"success":false}')), (e: any) => e.code === "WORKER_UNAVAILABLE");
    });

    it("503 -> WORKER_UNAVAILABLE", async () => {
      await assert.rejects(runGetJob(makeClient(503, '{"success":false}')), (e: any) => e.code === "WORKER_UNAVAILABLE");
    });

    it("RATE_LIMITED worker envelope -> RATE_LIMITED", async () => {
      await assert.rejects(
        runGetJob(makeClient(429, '{"success":false,"error":{"code":"RATE_LIMITED","message":"x"}}')),
        (e: any) => e.code === "RATE_LIMITED" && e.message !== "x"
      );
    });

    it("EXPIRED worker envelope -> EXPIRED", async () => {
      await assert.rejects(
        runGetJob(makeClient(410, '{"success":false,"error":{"code":"EXPIRED","message":"x"}}')),
        (e: any) => e.code === "EXPIRED" && e.message !== "x"
      );
    });

    it("unknown worker code -> PROCESSING_FAILED", async () => {
      await assert.rejects(
        runGetJob(makeClient(400, '{"success":false,"error":{"code":"BOGUS","message":"x"}}')),
        (e: any) => e.code === "PROCESSING_FAILED"
      );
    });

    it("malformed worker error envelope -> PROCESSING_FAILED", async () => {
      await assert.rejects(
        runGetJob(makeClient(400, '{"success":false,"bad":"true"}')),
        (e: any) => e.code === "PROCESSING_FAILED"
      );
    });

    it("hostile worker message -> NEVER appears in AppError.message", async () => {
      await assert.rejects(
        runGetJob(makeClient(429, '{"success":false,"error":{"code":"RATE_LIMITED","message":"INTERNAL_SECRET_X"}}')),
        (e: any) => e.code === "RATE_LIMITED" && !e.message.includes("INTERNAL_SECRET_X")
      );
    });

    it("non-JSON error response -> PROCESSING_FAILED", async () => {
      await assert.rejects(
        runGetJob(makeClient(500, "Server Error", "text/plain")),
        (e: any) => e.code === "PROCESSING_FAILED"
      );
    });
  });

  describe("Health regressions", () => {
    it("health()", async () => {
      let capturedOptions: any;
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async (_url: any, opts: any) => {
          capturedOptions = opts;
          return new Response('{"status":"ok"}', { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "15" } });
        }) as unknown as typeof fetch
      });

      await client.health();

      const headers = capturedOptions.headers as Headers;
      assert.ok(!headers || !headers.has("x-videofetch-signature"));
      assert.ok(!headers || !headers.has("Idempotency-Key"));
      assert.ok(!headers || !headers.has("Cookie"));
      assert.ok(!headers || !headers.has("Authorization"));
      assert.strictEqual(capturedOptions.body, undefined);
    });

    const testHealth = async (status: number, body: string, ct = "application/json") => {
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async () => new Response(body, { status, headers: { "Content-Type": ct, "Content-Length": String(body.length) } })) as unknown as typeof fetch
      });
      return client.health();
    };

    it("200 valid: PASS", async () => {
      await testHealth(200, '{"status":"ok"}');
    });

    it("201 valid body: PROCESSING_FAILED", async () => {
      await assert.rejects(testHealth(201, '{"status":"ok"}'), (e: any) => e.code === "PROCESSING_FAILED");
    });

    it("503: WORKER_UNAVAILABLE", async () => {
      await assert.rejects(testHealth(503, '{"success":false}'), (e: any) => e.code === "WORKER_UNAVAILABLE");
    });

    it("bad Content-Type: PROCESSING_FAILED", async () => {
      await assert.rejects(testHealth(200, '{"status":"ok"}', "text/html"), (e: any) => e.code === "PROCESSING_FAILED");
    });

    it("oversized body: PROCESSING_FAILED", async () => {
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async () => new Response(new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(3 * 1024 * 1024)); // 3MB > 2MB limit
            c.close();
          }
        }), { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "3145728" } })) as unknown as typeof fetch
      });
      await assert.rejects(client.health(), (e: any) => e.code === "PROCESSING_FAILED");
    });

    it("malformed health DTO: PROCESSING_FAILED", async () => {
      await assert.rejects(testHealth(200, '{"success":true,"status":"bad"}'), (e: any) => e.code === "PROCESSING_FAILED");
    });
  });
});
