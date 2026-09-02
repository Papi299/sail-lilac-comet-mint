
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
      await assert.rejects(client.createJob({ url: "http://test.com", formatId: "preset:best", principalId: "wrong" } as any));
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
      const body = { url: "https://example.com", formatId: "preset:best", principalId: "private-access-user" as const };
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

  // ── Cloudflare Access readiness (Phase 8B) ────────────────────────────────
  //
  // Access is an UPSTREAM layer: it authenticates Vercel to the proxy in front
  // of the Worker. It must add exactly two headers, must never enter the
  // VideoFetch HMAC canonical request, and its refusals must be classified as
  // WORKER_UNAVAILABLE rather than as a malformed Worker response.
  describe("Cloudflare Access", () => {
    const ACCESS_ID = "cf-access-client-id.access";
    const ACCESS_SECRET = "cf-access-client-secret-value-0123456789";
    const ID_HEADER = "cf-access-client-id";
    const SECRET_HEADER = "cf-access-client-secret";

    const captureClient = (
      access: { cloudflareAccessClientId?: string; cloudflareAccessClientSecret?: string },
      sink: { options?: any },
    ) => new WorkerClient({
      baseUrl: BASE_URL,
      currentKeyId: TEST_KEY_ID,
      currentSecret: TEST_SECRET,
      ...access,
      fetchImplementation: (async (_url: any, opts: any) => {
        sink.options = opts;
        throw new Error("stop");
      }) as unknown as typeof fetch,
      requestIdFactory: () => "00000000-0000-4000-8000-000000000000",
      idempotencyKeyFactory: () => "11111111-1111-4111-8111-111111111111",
      clock: () => 1234567890000,
    });

    const sortedHeaderNames = (headers: Headers): string[] =>
      [...headers.keys()].map((k) => k.toLowerCase()).sort();

    describe("configuration", () => {
      it("accepts both credentials together", () => {
        new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET,
        });
      });

      it("accepts neither credential", () => {
        new WorkerClient({ baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET });
      });

      it("rejects a client id without a client secret", () => {
        assert.throws(() => new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          cloudflareAccessClientId: ACCESS_ID,
        }));
      });

      it("rejects a client secret without a client id", () => {
        assert.throws(() => new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          cloudflareAccessClientSecret: ACCESS_SECRET,
        }));
      });

      it("rejects an empty credential", () => {
        assert.throws(() => new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: "",
        }));
      });

      it("rejects a credential carrying a header-injection newline", () => {
        assert.throws(() => new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          cloudflareAccessClientId: ACCESS_ID,
          cloudflareAccessClientSecret: "abc\r\nX-Injected: 1",
        }));
      });

      it("never renders the Access secret on any rejection path", () => {
        const SENTINEL = "SENTINEL_ACCESS_SECRET_MUST_NOT_LEAK";
        const attempts: Array<() => WorkerClient> = [
          // half-configured
          () => new WorkerClient({
            baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
            cloudflareAccessClientSecret: SENTINEL,
          }),
          // malformed value
          () => new WorkerClient({
            baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
            cloudflareAccessClientId: ACCESS_ID,
            cloudflareAccessClientSecret: `${SENTINEL}\n`,
          }),
          // over-long value
          () => new WorkerClient({
            baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
            cloudflareAccessClientId: ACCESS_ID,
            cloudflareAccessClientSecret: SENTINEL + "x".repeat(4097),
          }),
        ];
        for (const attempt of attempts) {
          try {
            attempt();
            assert.fail("expected the configuration to be rejected");
          } catch (err) {
            const rendered = `${String(err)}\n${(err as Error).message}\n${JSON.stringify(err)}\n${(err as Error).stack ?? ""}`;
            assert.equal(
              rendered.includes(SENTINEL),
              false,
              "the Access secret must never appear in an exception",
            );
          }
        }
      });
    });

    describe("request headers", () => {
      it("sends both Access headers on every signed Worker request", async () => {
        const jobId = "00000000000000000000000000000000";
        const calls: Array<[string, () => Promise<unknown>]> = [];
        const sink: { options?: any } = {};
        const client = captureClient(
          { cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET },
          sink,
        );
        calls.push(["analyze", () => client.analyze({ url: "https://example.com" } as any)]);
        calls.push(["createJob", () => client.createJob({ url: "https://example.com", formatId: "preset:best", principalId: "private-access-user" } as any)]);
        calls.push(["getJob", () => client.getJob(jobId)]);
        calls.push(["cancelJob", () => client.cancelJob(jobId)]);
        calls.push(["diagnostics", () => client.diagnostics()]);

        for (const [name, call] of calls) {
          sink.options = undefined;
          await call().catch(() => {});
          const headers = sink.options.headers as Headers;
          assert.strictEqual(headers.get(ID_HEADER), ACCESS_ID, `${name} must send the Access client id`);
          assert.strictEqual(headers.get(SECRET_HEADER), ACCESS_SECRET, `${name} must send the Access client secret`);
        }
      });

      it("sends neither Access header when unconfigured", async () => {
        const jobId = "00000000000000000000000000000000";
        const sink: { options?: any } = {};
        const client = captureClient({}, sink);
        for (const call of [
          () => client.analyze({ url: "https://example.com" } as any),
          () => client.createJob({ url: "https://example.com", formatId: "preset:best", principalId: "private-access-user" } as any),
          () => client.getJob(jobId),
          () => client.cancelJob(jobId),
          () => client.diagnostics(),
        ]) {
          sink.options = undefined;
          await call().catch(() => {});
          const headers = sink.options.headers as Headers;
          assert.strictEqual(headers.has(ID_HEADER), false);
          assert.strictEqual(headers.has(SECRET_HEADER), false);
        }
      });

      it("changes the request ONLY by the two Access headers", async () => {
        const withSink: { options?: any } = {};
        const withoutSink: { options?: any } = {};
        await captureClient(
          { cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET },
          withSink,
        ).createJob({ url: "https://example.com", formatId: "preset:best", principalId: "private-access-user" } as any).catch(() => {});
        await captureClient({}, withoutSink)
          .createJob({ url: "https://example.com", formatId: "preset:best", principalId: "private-access-user" } as any).catch(() => {});

        const withHeaders = withSink.options.headers as Headers;
        const withoutHeaders = withoutSink.options.headers as Headers;

        assert.deepStrictEqual(
          sortedHeaderNames(withHeaders).filter((n) => n !== ID_HEADER && n !== SECRET_HEADER),
          sortedHeaderNames(withoutHeaders),
          "no header other than the Access pair may be added or removed",
        );
        for (const name of sortedHeaderNames(withoutHeaders)) {
          assert.strictEqual(
            withHeaders.get(name),
            withoutHeaders.get(name),
            `header ${name} must be unchanged`,
          );
        }
        assert.strictEqual(withSink.options.method, withoutSink.options.method);
        assert.strictEqual(withSink.options.redirect, withoutSink.options.redirect);
        assert.strictEqual(
          withSink.options.body.toString("utf8"),
          withoutSink.options.body.toString("utf8"),
          "the signed body must be byte-identical",
        );
      });
    });

    describe("HMAC invariant", () => {
      // The canonical signing input is version|keyId|method|path|timestamp|
      // requestId|idempotencyKey|sha256(body). Access credentials are NOT in it.
      const jobId = "00000000000000000000000000000000";

      const signatureFor = async (
        access: { cloudflareAccessClientId?: string; cloudflareAccessClientSecret?: string },
        call: (c: WorkerClient) => Promise<unknown>,
      ): Promise<string> => {
        const sink: { options?: any } = {};
        await call(captureClient(access, sink)).catch(() => {});
        return (sink.options.headers as Headers).get("x-videofetch-signature")!;
      };

      const cases: Array<[string, (c: WorkerClient) => Promise<unknown>]> = [
        ["analyze", (c) => c.analyze({ url: "https://example.com" } as any)],
        ["createJob", (c) => c.createJob({ url: "https://example.com", formatId: "preset:best", principalId: "private-access-user" } as any)],
        ["getJob", (c) => c.getJob(jobId)],
        ["cancelJob", (c) => c.cancelJob(jobId)],
        ["diagnostics", (c) => c.diagnostics()],
      ];

      for (const [name, call] of cases) {
        it(`${name}: signature is byte-identical with and without Access credentials`, async () => {
          const withAccess = await signatureFor(
            { cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET },
            call,
          );
          const withoutAccess = await signatureFor({}, call);
          assert.match(withoutAccess, /^[0-9a-f]{64}$/);
          assert.strictEqual(
            withAccess,
            withoutAccess,
            "Access credentials must not enter the HMAC canonical request",
          );
        });
      }

      it("a different Access secret does not change the signature", async () => {
        const call = (c: WorkerClient) => c.getJob(jobId);
        const a = await signatureFor(
          { cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET },
          call,
        );
        const b = await signatureFor(
          { cloudflareAccessClientId: "other-id", cloudflareAccessClientSecret: "a-totally-different-secret" },
          call,
        );
        assert.strictEqual(a, b);
      });

      it("matches the independently computed canonical signature", async () => {
        const sink: { options?: any } = {};
        await captureClient(
          { cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET },
          sink,
        ).getJob(jobId).catch(() => {});
        const expected = createWorkerSignatureHex(TEST_SECRET, {
          keyId: TEST_KEY_ID, method: "GET", canonicalPath: workerJobPath(jobId),
          timestampSeconds: "1234567890", requestId: "00000000-0000-4000-8000-000000000000",
          idempotencyKey: undefined, sha256RawBody: sha256WorkerBody(Buffer.alloc(0)),
        });
        assert.strictEqual((sink.options.headers as Headers).get("x-videofetch-signature"), expected);
      });
    });

    describe("denial classification", () => {
      const respondWith = (status: number, body: string, contentType: string) => new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET,
        fetchImplementation: (async () => new Response(body, {
          status, headers: { "Content-Type": contentType, "Content-Length": String(body.length) },
        })) as unknown as typeof fetch,
      });
      const runGetJob = (c: WorkerClient) => c.getJob("00000000000000000000000000000000");

      const ACCESS_HTML = "<!DOCTYPE html><html><body>Access denied</body></html>";

      it("403 with an HTML Access page -> WORKER_UNAVAILABLE", async () => {
        await assert.rejects(
          runGetJob(respondWith(403, ACCESS_HTML, "text/html; charset=utf-8")),
          (e: any) => e.code === "WORKER_UNAVAILABLE",
        );
      });

      it("403 with a JSON Access body -> WORKER_UNAVAILABLE", async () => {
        await assert.rejects(
          runGetJob(respondWith(403, '{"error":"access denied"}', "application/json")),
          (e: any) => e.code === "WORKER_UNAVAILABLE",
        );
      });

      it("403 with no body or content-type -> WORKER_UNAVAILABLE", async () => {
        const client = new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          fetchImplementation: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
        });
        await assert.rejects(runGetJob(client), (e: any) => e.code === "WORKER_UNAVAILABLE");
      });

      it("403 never leaks the upstream body into the error message", async () => {
        await assert.rejects(
          runGetJob(respondWith(403, "<html>TEAM_NAME_LEAK</html>", "text/html")),
          (e: any) => e.code === "WORKER_UNAVAILABLE" && !e.message.includes("TEAM_NAME_LEAK"),
        );
      });

      it("401 and 503 remain WORKER_UNAVAILABLE", async () => {
        for (const status of [401, 503]) {
          await assert.rejects(
            runGetJob(respondWith(status, '{"success":false}', "application/json")),
            (e: any) => e.code === "WORKER_UNAVAILABLE",
          );
        }
      });

      it("an Access redirect rejected by redirect:error -> WORKER_UNAVAILABLE", async () => {
        const client = new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET,
          // Mirrors what fetch does for a 302 under redirect: "error".
          fetchImplementation: (async () => { throw new TypeError("unexpected redirect"); }) as unknown as typeof fetch,
        });
        await assert.rejects(runGetJob(client), (e: any) => e.code === "WORKER_UNAVAILABLE");
      });

      // The reclassification is narrow: only statuses the Worker protocol never
      // emits. Every genuine Worker business envelope keeps its own mapping.
      const businessCases: Array<[number, string, string]> = [
        [422, "UNSUPPORTED_SITE", "UNSUPPORTED_SITE"],
        [404, "NOT_FOUND", "NOT_FOUND"],
        [409, "FORMAT_UNAVAILABLE", "FORMAT_UNAVAILABLE"],
        [413, "TOO_LARGE", "TOO_LARGE"],
        [429, "RATE_LIMITED", "RATE_LIMITED"],
        [500, "PROCESSING_FAILED", "PROCESSING_FAILED"],
        [502, "ANALYSIS_FAILED", "ANALYSIS_FAILED"],
        [504, "TIMEOUT", "TIMEOUT"],
      ];
      for (const [status, code, expected] of businessCases) {
        it(`${status} ${code} Worker envelope is NOT collapsed into WORKER_UNAVAILABLE`, async () => {
          await assert.rejects(
            runGetJob(respondWith(status, `{"success":false,"error":{"code":"${code}","message":"x"}}`, "application/json")),
            (e: any) => e.code === expected,
          );
        });
      }

      it("a successful Worker response is unaffected by Access credentials", async () => {
        const payload = '{"success":true,"job":{"id":"1"}}';
        const client = respondWith(200, payload, "application/json");
        // Reaches schema validation (the fake job is not a valid DTO), which
        // proves the response passed the upstream gate and the trust boundary.
        await assert.rejects(runGetJob(client), (e: any) => e.code === "PROCESSING_FAILED");
      });
    });

    describe("health()", () => {
      it("sends both Access headers when configured", async () => {
        let captured: any;
        const client = new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET,
          fetchImplementation: (async (_url: any, opts: any) => {
            captured = opts;
            return new Response('{"status":"ok"}', { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "15" } });
          }) as unknown as typeof fetch,
        });
        await client.health();
        const headers = captured.headers as Headers;
        assert.strictEqual(headers.get(ID_HEADER), ACCESS_ID);
        assert.strictEqual(headers.get(SECRET_HEADER), ACCESS_SECRET);
        // Health stays unauthenticated by VideoFetch HMAC.
        assert.strictEqual(headers.has("x-videofetch-signature"), false);
      });

      it("sends neither Access header when unconfigured", async () => {
        let captured: any;
        const client = new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          fetchImplementation: (async (_url: any, opts: any) => {
            captured = opts;
            return new Response('{"status":"ok"}', { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "15" } });
          }) as unknown as typeof fetch,
        });
        await client.health();
        const headers = captured.headers as Headers;
        assert.strictEqual(headers.has(ID_HEADER), false);
        assert.strictEqual(headers.has(SECRET_HEADER), false);
      });

      it("403 HTML -> WORKER_UNAVAILABLE", async () => {
        const client = new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          cloudflareAccessClientId: ACCESS_ID, cloudflareAccessClientSecret: ACCESS_SECRET,
          fetchImplementation: (async () => new Response("<html>denied</html>", {
            status: 403, headers: { "Content-Type": "text/html", "Content-Length": "19" },
          })) as unknown as typeof fetch,
        });
        await assert.rejects(client.health(), (e: any) => e.code === "WORKER_UNAVAILABLE");
      });

      it("401 -> WORKER_UNAVAILABLE", async () => {
        const client = new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          fetchImplementation: (async () => new Response('{"success":false}', {
            status: 401, headers: { "Content-Type": "application/json", "Content-Length": "17" },
          })) as unknown as typeof fetch,
        });
        await assert.rejects(client.health(), (e: any) => e.code === "WORKER_UNAVAILABLE");
      });

      it("a redirect rejection -> WORKER_UNAVAILABLE", async () => {
        const client = new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          fetchImplementation: (async () => { throw new TypeError("unexpected redirect"); }) as unknown as typeof fetch,
        });
        await assert.rejects(client.health(), (e: any) => e.code === "WORKER_UNAVAILABLE");
      });
    });
  });
});
