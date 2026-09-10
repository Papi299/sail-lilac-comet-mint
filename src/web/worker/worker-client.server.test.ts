
import { describe, it } from "node:test";
import assert from "node:assert";
import { WorkerClient } from "./worker-client.server.ts";
import { ERROR_MESSAGES } from "../../lib/errors.ts";
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

  // ── HTTP 503 disambiguation (Phase 10F) ───────────────────────────────────
  //
  // 503 is the ONE status shared by the Worker protocol and the infrastructure
  // in front of it: the Worker answers 503 for its own EXTRACTOR_UNAVAILABLE
  // business error, while a proxy/tunnel answers 503 for a real outage.
  // Previously every 503 was collapsed into WORKER_UNAVAILABLE before the body
  // could be validated, so a legitimate "generic extraction is unavailable"
  // reached the browser as a worker outage. Only the exact canonical Worker
  // envelope may now survive as EXTRACTOR_UNAVAILABLE; everything else stays
  // WORKER_UNAVAILABLE.
  describe("503 disambiguation", () => {
    const CANONICAL = ERROR_MESSAGES.EXTRACTOR_UNAVAILABLE;
    const envelope = (code: string, message: string) =>
      JSON.stringify({ success: false, error: { code, message } });
    const CANONICAL_ENVELOPE = envelope("EXTRACTOR_UNAVAILABLE", CANONICAL);

    /** Mirrors how the real Worker serializes: JSON + charset + Content-Length. */
    const respondWith = (
      status: number,
      body: string | null,
      contentType: string | null = "application/json; charset=utf-8",
      contentLength?: string,
    ) => {
      const headers: Record<string, string> = {};
      if (contentType !== null) headers["Content-Type"] = contentType;
      if (body !== null) {
        headers["Content-Length"] = contentLength ?? String(Buffer.byteLength(body, "utf8"));
      }
      return new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async () => new Response(body, { status, headers })) as unknown as typeof fetch,
      });
    };

    const streaming = (status: number, start: (c: any) => void, contentLength: string) =>
      new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        fetchImplementation: (async () => new Response(new ReadableStream({ start }), {
          status,
          headers: { "Content-Type": "application/json", "Content-Length": contentLength },
        })) as unknown as typeof fetch,
      });

    const runGetJob = (c: WorkerClient) => c.getJob("00000000000000000000000000000000");
    const isUnavailable = (e: any) => e.code === "WORKER_UNAVAILABLE";

    // A ── the legitimate Worker 503 is preserved.
    it("A: canonical Worker EXTRACTOR_UNAVAILABLE envelope -> EXTRACTOR_UNAVAILABLE", async () => {
      await assert.rejects(
        runGetJob(respondWith(503, CANONICAL_ENVELOPE)),
        (e: any) =>
          e.code === "EXTRACTOR_UNAVAILABLE" &&
          e.message === CANONICAL &&
          e.status === 503,
      );
    });

    it("A: canonical envelope with a bare application/json type -> EXTRACTOR_UNAVAILABLE", async () => {
      await assert.rejects(
        runGetJob(respondWith(503, CANONICAL_ENVELOPE, "application/json")),
        (e: any) => e.code === "EXTRACTOR_UNAVAILABLE",
      );
    });

    it("A: the disambiguation applies to analyze(), the path that surfaces it to users", async () => {
      const client = respondWith(503, CANONICAL_ENVELOPE);
      await assert.rejects(
        client.analyze({ url: "https://example.com/watch" } as any),
        (e: any) => e.code === "EXTRACTOR_UNAVAILABLE",
      );
    });

    // B ── an upstream proxy page is NOT a Worker envelope.
    it("B: HTML proxy body -> WORKER_UNAVAILABLE", async () => {
      await assert.rejects(
        runGetJob(respondWith(503, "<html><body>503 Service Temporarily Unavailable</body></html>", "text/html; charset=utf-8")),
        isUnavailable,
      );
    });

    it("B: no body at all -> WORKER_UNAVAILABLE", async () => {
      await assert.rejects(runGetJob(respondWith(503, null, null)), isUnavailable);
    });

    // C ── content-type is part of the Worker contract.
    it("C: missing Content-Type -> WORKER_UNAVAILABLE", async () => {
      await assert.rejects(runGetJob(respondWith(503, CANONICAL_ENVELOPE, null)), isUnavailable);
    });

    for (const contentType of ["text/plain", "application/jsonp", "text/html", "application/octet-stream"]) {
      it(`C: Content-Type ${contentType} with an otherwise canonical body -> WORKER_UNAVAILABLE`, async () => {
        await assert.rejects(runGetJob(respondWith(503, CANONICAL_ENVELOPE, contentType)), isUnavailable);
      });
    }

    // D ── malformed JSON never reaches the schema.
    it("D: malformed JSON -> WORKER_UNAVAILABLE", async () => {
      await assert.rejects(runGetJob(respondWith(503, '{"success":false,"error":{')), isUnavailable);
    });

    // E ── schema-invalid JSON is refused by the strict envelope schema.
    const schemaInvalid = [
      '{"success":false}',
      '{"success":true,"error":{"code":"EXTRACTOR_UNAVAILABLE","message":"' + CANONICAL + '"}}',
      '{"success":false,"error":{"code":"EXTRACTOR_UNAVAILABLE"}}',
      '{"success":false,"error":{"code":"EXTRACTOR_UNAVAILABLE","message":"' + CANONICAL + '","stack":"boom"}}',
      '{"success":false,"error":{"code":"EXTRACTOR_UNAVAILABLE","message":123}}',
      '"a bare string"',
      "null",
    ];
    for (const [i, body] of schemaInvalid.entries()) {
      it(`E: schema-invalid JSON #${i + 1} -> WORKER_UNAVAILABLE`, async () => {
        await assert.rejects(runGetJob(respondWith(503, body)), isUnavailable);
      });
    }

    // F ── a valid envelope carrying any OTHER code is inconsistent with 503:
    // EXTRACTOR_UNAVAILABLE is the only Worker code mapped to that status.
    for (const code of ["RATE_LIMITED", "PROCESSING_FAILED", "NOT_FOUND", "TIMEOUT", "INVALID_URL"]) {
      it(`F: 503 carrying a valid ${code} envelope -> WORKER_UNAVAILABLE`, async () => {
        await assert.rejects(
          runGetJob(respondWith(503, envelope(code, ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES]))),
          isUnavailable,
        );
      });
    }

    // G ── the Worker always rewrites the message to the canonical one, so a
    // divergent message did not come from the Worker's error path.
    const nonCanonical = [CANONICAL + " ", " " + CANONICAL, CANONICAL.toUpperCase(), "", "Service Unavailable", CANONICAL.slice(0, -1)];
    for (const [i, message] of nonCanonical.entries()) {
      it(`G: EXTRACTOR_UNAVAILABLE with non-canonical message #${i + 1} -> WORKER_UNAVAILABLE`, async () => {
        await assert.rejects(
          runGetJob(respondWith(503, envelope("EXTRACTOR_UNAVAILABLE", message))),
          isUnavailable,
        );
      });
    }

    // H ── a failed read must not be optimistically trusted.
    it("H: a body read that fails mid-stream -> WORKER_UNAVAILABLE", async () => {
      const client = streaming(503, (c) => c.error(new Error("network disconnect")), "100");
      await assert.rejects(runGetJob(client), isUnavailable);
    });

    // C (deadline) ── headers arrive promptly, body never finishes.
    //
    // A byte ceiling cannot bound this shape: the stream stays far below
    // MAX_RESPONSE_BYTES indefinitely, and unlike the overflow and stream-error
    // cases above it never terminates on its own. Only the request deadline
    // ends it. Two variants, because a real Fetch body errors when its signal
    // aborts while a hand-built ReadableStream need not:
    //   1. a stream that IGNORES its abort signal, proving the client bounds
    //      the read itself instead of trusting the stream to cooperate;
    //   2. a stream that ERRORS on abort, modelling real Fetch semantics.
    // The explicit per-test timeout makes a regression fail rather than hang.
    const STALL_SENTINEL = "STALLED_BODY_SENTINEL_LEAK";
    const stalling = (observeAbort: boolean) => new WorkerClient({
      baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
      requestTimeoutMs: 1000, // the minimum the config schema allows
      fetchImplementation: (async (_url: any, opts: any) => new Response(
        new ReadableStream({
          start(controller) {
            // A plausible partial envelope, then silence: never closed.
            controller.enqueue(new TextEncoder().encode(`{"partial":"${STALL_SENTINEL}"`));
            if (observeAbort) {
              opts.signal?.addEventListener("abort", () => {
                try { controller.error(new Error("aborted by signal")); } catch { /* already closed */ }
              }, { once: true });
            }
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } },
      )) as unknown as typeof fetch,
    });

    it("C: a 503 body that never completes is ended by the request deadline -> WORKER_UNAVAILABLE", { timeout: 15000 }, async () => {
      const started = Date.now();
      await assert.rejects(runGetJob(stalling(false)), isUnavailable);
      const elapsed = Date.now() - started;
      // Lower bound: it genuinely waited for the deadline rather than failing
      // fast for an unrelated reason. Upper bound: it did not wait forever.
      assert.ok(elapsed >= 500, `expected the deadline to be awaited, took ${elapsed}ms`);
      assert.ok(elapsed < 10000, `expected a bounded wait, took ${elapsed}ms`);
    });

    it("C: a stalled 503 body that errors on abort (real Fetch semantics) -> WORKER_UNAVAILABLE", { timeout: 15000 }, async () => {
      await assert.rejects(runGetJob(stalling(true)), isUnavailable);
    });

    it("D: a deadline-terminated 503 leaks no body or stream text", { timeout: 15000 }, async () => {
      await assert.rejects(runGetJob(stalling(false)), (e: any) => {
        const rendered = `${String(e)}\n${e.message}\n${e.stack ?? ""}`;
        return e.code === "WORKER_UNAVAILABLE" &&
          e.message === ERROR_MESSAGES.WORKER_UNAVAILABLE &&
          !rendered.includes(STALL_SENTINEL) &&
          !rendered.includes("request deadline exceeded") &&
          !rendered.includes("aborted by signal");
      });
    });

    // C (single budget) ── connect + headers + 503 classification share ONE
    // requestTimeoutMs.
    //
    // This only discriminates if a meaningful share of the budget is spent
    // BEFORE the headers arrive. With instant headers, an implementation that
    // wrongly started a fresh full budget for the body would finish at about
    // the same time as a correct one and the test would prove nothing.
    //
    // So: 2000 ms total budget, headers delayed ~1200 ms, then a stalled body.
    //   correct  -> ~800 ms of the ORIGINAL deadline remains  -> total ~2000 ms
    //   fresh    -> a new ~2000 ms body budget starts         -> total ~3200 ms
    // The body-phase duration is measured directly, so the assertion is about
    // the remaining budget rather than only the wall-clock total.
    const TOTAL_BUDGET_MS = 2000;
    const HEADER_DELAY_MS = 1200;

    it("C: the 503 body gets only the REMAINING request budget, not a fresh one", { timeout: 20000 }, async () => {
      const marks: { headersAt?: number } = {};
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        requestTimeoutMs: TOTAL_BUDGET_MS,
        fetchImplementation: (async () => {
          // Burn a known share of the original budget before headers exist.
          await new Promise((resolve) => setTimeout(resolve, HEADER_DELAY_MS));
          marks.headersAt = Date.now();
          return new Response(
            new ReadableStream({
              start(controller) {
                // Plausible partial envelope, then silence: never closed, and
                // deliberately NOT observing the abort signal, so only the
                // client's own deadline can end this read.
                controller.enqueue(new TextEncoder().encode(`{"partial":"${STALL_SENTINEL}"`));
              },
            }),
            { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } },
          );
        }) as unknown as typeof fetch,
      });

      const started = Date.now();
      await assert.rejects(runGetJob(client), isUnavailable);
      const finished = Date.now();

      assert.ok(marks.headersAt !== undefined, "the 503 headers must have been delivered");
      const headerPhase = marks.headersAt! - started;
      const bodyPhase = finished - marks.headersAt!;
      const total = finished - started;

      // The headers really did arrive inside the original deadline.
      assert.ok(
        headerPhase >= HEADER_DELAY_MS - 200 && headerPhase < TOTAL_BUDGET_MS,
        `headers must arrive before the original deadline, took ${headerPhase}ms`,
      );
      // The body really did stall rather than terminate on its own.
      assert.ok(bodyPhase >= 300, `the body must have stalled, body phase was ${bodyPhase}ms`);
      // The decisive assertion: the body phase used only what was LEFT of the
      // budget (~800ms), not a fresh full one (~2000ms).
      assert.ok(
        bodyPhase <= 1500,
        `the body must get only the remaining budget, body phase was ${bodyPhase}ms`,
      );
      assert.ok(total <= 2700, `one total budget expected, took ${total}ms`);
    });

    // I ── the response bounds still gate the probe.
    it("I: oversized streamed body -> WORKER_UNAVAILABLE", async () => {
      const client = streaming(503, (c) => {
        c.enqueue(new Uint8Array(2 * 1024 * 1024));
        c.enqueue(new Uint8Array(1)); // one byte past the 2 MiB ceiling
        c.close();
      }, "2097152");
      await assert.rejects(runGetJob(client), isUnavailable);
    });

    for (const len of ["-1", "1.5", "1e5", "100a", "9007199254740992", "3000000"]) {
      it(`I: invalid Content-Length ${len} -> WORKER_UNAVAILABLE`, async () => {
        await assert.rejects(
          runGetJob(respondWith(503, CANONICAL_ENVELOPE, "application/json", len)),
          isUnavailable,
        );
      });
    }

    // J ── neither 401 nor 403 becomes a business error, even when dressed as a
    // Worker envelope. A 401 may genuinely be Worker-origin (its HTTP server
    // answers 401 for HMAC/replay rejection), but 401 is not a Worker
    // business-error status, so the path is unavailable either way.
    for (const status of [401, 403]) {
      it(`J: ${status} carrying the canonical Worker envelope -> WORKER_UNAVAILABLE`, async () => {
        await assert.rejects(runGetJob(respondWith(status, CANONICAL_ENVELOPE)), isUnavailable);
      });
    }

    // No untrusted response text may reach the user-facing error.
    it("an untrusted 503 body never leaks into the error message", async () => {
      const SENTINEL = "UPSTREAM_INTERNAL_HOST_LEAK";
      const bodies: Array<[string, string | null]> = [
        [`<html><body>${SENTINEL}</body></html>`, "text/html"],
        [envelope("EXTRACTOR_UNAVAILABLE", SENTINEL), "application/json"],
        [envelope("RATE_LIMITED", SENTINEL), "application/json"],
        [`{"success":false,"${SENTINEL}":true}`, "application/json"],
      ];
      for (const [body, contentType] of bodies) {
        await assert.rejects(runGetJob(respondWith(503, body, contentType)), (e: any) => {
          const rendered = `${String(e)}\n${e.message}\n${e.stack ?? ""}`;
          return e.code === "WORKER_UNAVAILABLE" &&
            e.message === ERROR_MESSAGES.WORKER_UNAVAILABLE &&
            !rendered.includes(SENTINEL);
        });
      }
    });

    it("the preserved EXTRACTOR_UNAVAILABLE carries only the canonical safe message", async () => {
      await assert.rejects(runGetJob(respondWith(503, CANONICAL_ENVELOPE)), (e: any) =>
        e.message === CANONICAL && !e.message.includes("worker"),
      );
    });

    // K/L ── neighbouring behaviour is untouched.
    it("K: a non-503 Worker business envelope still propagates unchanged", async () => {
      await assert.rejects(
        runGetJob(respondWith(429, envelope("RATE_LIMITED", ERROR_MESSAGES.RATE_LIMITED))),
        (e: any) => e.code === "RATE_LIMITED",
      );
    });

    it("L: a 200 response is still validated against the success schema", async () => {
      await assert.rejects(
        runGetJob(respondWith(200, '{"success":true,"job":{"id":"1"}}')),
        (e: any) => e.code === "PROCESSING_FAILED",
      );
    });

    // The health route has no business-error envelope, so 503 stays an outage.
    it("health() keeps 503 as WORKER_UNAVAILABLE even for a canonical envelope", async () => {
      await assert.rejects(respondWith(503, CANONICAL_ENVELOPE).health(), isUnavailable);
    });
  });

  // ── Total response deadline ───────────────────────────────────────────────
  // WORKERCLIENT-TOTAL-RESPONSE-DEADLINE-HARDENING-001
  //
  // `requestTimeoutMs` must bound the COMPLETE response I/O operation —
  // connect, upstream wait, response headers AND response-body read — as ONE
  // total budget, on every path that consumes a body.
  //
  // Phase 10F established that property for the ambiguous 503 classification
  // only. The ordinary success path, the non-503 Worker-error path and the
  // health path each cleared the request timer BEFORE reading their body, so a
  // response that delivered headers and then stalled was awaited forever: the
  // byte ceiling cannot end such a read (it stays far below
  // MAX_RESPONSE_BYTES), and unlike the overflow and stream-error shapes it
  // never terminates on its own.
  //
  // Every stream below is deliberately NEVER closed, so only the client's own
  // deadline can end it, and the explicit per-test `timeout` turns a
  // regression into a failure rather than a hang.
  describe("total response deadline", () => {
    const SENTINEL = "STALLED_ORDINARY_BODY_SENTINEL_LEAK";
    const JOB_ID = "00000000000000000000000000000000";

    /**
     * A response whose headers arrive after `headerDelayMs` and whose body
     * then emits one plausible partial chunk and stalls forever.
     *
     * `observeAbort: false` (the default) models a stream that IGNORES its
     * AbortSignal, proving the client bounds the read itself instead of
     * trusting the stream to cooperate. `true` models real Fetch semantics,
     * where the body errors once the signal aborts.
     */
    const stalling = (opts: {
      status: number;
      requestTimeoutMs: number;
      headerDelayMs?: number;
      observeAbort?: boolean;
      marks?: { headersAt?: number };
    }) => new WorkerClient({
      baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
      requestTimeoutMs: opts.requestTimeoutMs,
      fetchImplementation: (async (_url: any, fetchOpts: any) => {
        if (opts.headerDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, opts.headerDelayMs));
        }
        if (opts.marks) opts.marks.headersAt = Date.now();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`{"partial":"${SENTINEL}"`));
              if (opts.observeAbort) {
                fetchOpts.signal?.addEventListener("abort", () => {
                  try { controller.error(new Error("aborted by signal")); } catch { /* already closed */ }
                }, { once: true });
              }
            },
          }),
          { status: opts.status, headers: { "Content-Type": "application/json; charset=utf-8" } },
        );
      }) as unknown as typeof fetch,
    });

    /**
     * The canonical outcome of a stalled body: the transport error, its exact
     * safe message, and NOTHING of the partial body, the internal deadline
     * marker or the stream's own abort reason anywhere in the rendered error.
     * This carries requirements I and J for every case that uses it.
     */
    const isCleanUnavailable = (e: any) => {
      const rendered = `${String(e)}\n${e.message}\n${e.stack ?? ""}`;
      assert.strictEqual(e.code, "WORKER_UNAVAILABLE");
      assert.strictEqual(e.message, ERROR_MESSAGES.WORKER_UNAVAILABLE);
      assert.ok(!rendered.includes(SENTINEL), "the partial response body must not leak");
      assert.ok(!rendered.includes("request deadline exceeded"), "the deadline marker must not leak");
      assert.ok(!rendered.includes("aborted by signal"), "the raw stream abort reason must not leak");
      return true;
    };

    /** Bounded, and genuinely ended by the deadline rather than failing fast. */
    const assertBoundedByDeadline = async (run: Promise<unknown>, budgetMs: number) => {
      const started = Date.now();
      await assert.rejects(run, isCleanUnavailable);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= budgetMs / 2, `expected the deadline to be awaited, took ${elapsed}ms`);
      assert.ok(elapsed < 10000, `expected a bounded wait, took ${elapsed}ms`);
    };

    // A stalled body behind INSTANT headers cannot tell a correct total budget
    // apart from a fresh per-body one: both finish at about the same moment.
    // The single-budget cases therefore burn a known share of the budget
    // BEFORE the headers exist, and measure the body phase directly:
    //   2000 ms total, ~1200 ms spent before headers
    //     correct -> the body gets only the ~800 ms that REMAIN -> total ~2000 ms
    //     fresh   -> the body starts a new ~2000 ms budget      -> total ~3200 ms
    const TOTAL_BUDGET_MS = 2000;
    const HEADER_DELAY_MS = 1200;

    const assertOneTotalBudget = async (
      status: number,
      run: (c: WorkerClient) => Promise<unknown>,
    ) => {
      const marks: { headersAt?: number } = {};
      const client = stalling({
        status,
        requestTimeoutMs: TOTAL_BUDGET_MS,
        headerDelayMs: HEADER_DELAY_MS,
        marks,
      });

      const started = Date.now();
      await assert.rejects(run(client), isCleanUnavailable);
      const finished = Date.now();

      assert.ok(marks.headersAt !== undefined, "the response headers must have been delivered");
      const headerPhase = marks.headersAt! - started;
      const bodyPhase = finished - marks.headersAt!;
      const total = finished - started;

      // The headers really did arrive inside the original deadline.
      assert.ok(
        headerPhase >= HEADER_DELAY_MS - 200 && headerPhase < TOTAL_BUDGET_MS,
        `headers must arrive before the original deadline, took ${headerPhase}ms`,
      );
      // The body really did stall rather than terminate on its own.
      assert.ok(bodyPhase >= 300, `the body must have stalled, body phase was ${bodyPhase}ms`);
      // The decisive assertion: the body phase used only what was LEFT of the
      // budget (~800 ms), not a fresh full one (~2000 ms).
      assert.ok(
        bodyPhase <= 1500,
        `the body must get only the remaining budget, body phase was ${bodyPhase}ms`,
      );
      assert.ok(total <= 2700, `one total budget expected, took ${total}ms`);
    };

    // A ── ordinary successful responses. Headers arrive, the body stalls.
    // Also carries G (the stream ignores its AbortSignal), I and J.
    it("A: a stalled 200 body is ended by the total request deadline -> WORKER_UNAVAILABLE", { timeout: 20000 }, async () => {
      await assertBoundedByDeadline(
        stalling({ status: 200, requestTimeoutMs: 1000 }).getJob(JOB_ID),
        1000,
      );
    });

    it("A: analyze(), the user-facing path, is bounded identically", { timeout: 20000 }, async () => {
      await assertBoundedByDeadline(
        stalling({ status: 200, requestTimeoutMs: 1000 }).analyze({ url: "https://example.com/watch" } as any),
        1000,
      );
    });

    // B ── the ordinary 200 body gets only the REMAINING budget. This is the
    // case that discriminates a fresh per-body timeout from one total one.
    it("B: a delayed-header 200 gives the body only the remaining budget, not a fresh one", { timeout: 20000 }, async () => {
      await assertOneTotalBudget(200, (c) => c.getJob(JOB_ID));
    });

    // C ── a legitimate non-503 Worker-error status whose envelope never
    // finishes arriving. An error that could not be completely read is a
    // transport failure, not a successfully established business error.
    it("C: a stalled 429 error body -> WORKER_UNAVAILABLE, not a business error", { timeout: 20000 }, async () => {
      await assertBoundedByDeadline(
        stalling({ status: 429, requestTimeoutMs: 1000 }).getJob(JOB_ID),
        1000,
      );
    });

    // D ── and that error path shares the one total budget too.
    it("D: a delayed-header 429 gives its body only the remaining budget", { timeout: 20000 }, async () => {
      await assertOneTotalBudget(429, (c) => c.getJob(JOB_ID));
    });

    // E ── the health probe. A liveness check whose body stalls is an outage.
    it("E: a stalled health 200 body -> WORKER_UNAVAILABLE", { timeout: 20000 }, async () => {
      await assertBoundedByDeadline(
        stalling({ status: 200, requestTimeoutMs: 1000 }).health(),
        1000,
      );
    });

    // F ── health shares the one total budget.
    it("F: a delayed-header health 200 gives its body only the remaining budget", { timeout: 20000 }, async () => {
      await assertOneTotalBudget(200, (c) => c.health());
    });

    // H ── a realistic stream that ERRORS when Fetch aborts is bounded too, so
    // the fix does not depend on which of the two mechanisms fires first.
    it("H: a stalled body that errors on abort (real Fetch semantics) is still bounded", { timeout: 20000 }, async () => {
      await assert.rejects(
        stalling({ status: 200, requestTimeoutMs: 1000, observeAbort: true }).getJob(JOB_ID),
        isCleanUnavailable,
      );
    });

    // ── Non-regression: nothing that COMPLETES inside the deadline changes ──
    //
    // Arming the deadline across the body phase must not reclassify a response
    // that finished in time. These are all fast: the deadline never fires.
    const completing = (status: number, body: string, contentType = "application/json") => new WorkerClient({
      baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
      requestTimeoutMs: 1000,
      fetchImplementation: (async () => new Response(body, {
        status,
        headers: { "Content-Type": contentType, "Content-Length": String(Buffer.byteLength(body, "utf8")) },
      })) as unknown as typeof fetch,
    });

    const VALID_JOB = JSON.stringify({
      success: true,
      job: {
        jobId: JOB_ID, status: "queued", progress: null, stageLabel: null,
        downloadedBytes: null, totalBytes: null, speed: null, eta: null,
        errorCode: null, safeErrorMessage: null, filename: null, fileSize: null,
        mime: null, quality: null, container: null, title: null, thumbnail: null,
        source: null, extractor: null, createdAt: 0, updatedAt: 0, expiresAt: 0,
        objectKey: null,
      },
    });

    // K ── a valid success that completes within the deadline still succeeds.
    it("K: a complete valid 200 within the deadline still resolves", async () => {
      const job = await completing(200, VALID_JOB).getJob(JOB_ID);
      assert.strictEqual(job.job.jobId, JOB_ID);
      assert.strictEqual(job.job.status, "queued");
    });

    // L ── a valid non-503 business envelope still propagates its own code.
    it("L: a complete valid 429 envelope within the deadline still propagates RATE_LIMITED", async () => {
      await assert.rejects(
        completing(429, JSON.stringify({ success: false, error: { code: "RATE_LIMITED", message: "x" } })).getJob(JOB_ID),
        (e: any) => e.code === "RATE_LIMITED" && !e.message.includes("x"),
      );
    });

    // M ── health still succeeds.
    it("M: a complete valid health 200 within the deadline still resolves", async () => {
      assert.deepStrictEqual(await completing(200, '{"status":"ok"}').health(), { status: "ok" });
    });

    // N/O ── the Phase-10F 503 semantics are untouched by this change.
    it("N: the canonical 503 envelope still produces EXTRACTOR_UNAVAILABLE", async () => {
      await assert.rejects(
        completing(503, JSON.stringify({
          success: false,
          error: { code: "EXTRACTOR_UNAVAILABLE", message: ERROR_MESSAGES.EXTRACTOR_UNAVAILABLE },
        })).getJob(JOB_ID),
        (e: any) => e.code === "EXTRACTOR_UNAVAILABLE" && e.message === ERROR_MESSAGES.EXTRACTOR_UNAVAILABLE,
      );
    });

    it("O: a non-canonical 503 still produces WORKER_UNAVAILABLE", async () => {
      await assert.rejects(
        completing(503, "<html><body>503</body></html>", "text/html").getJob(JOB_ID),
        (e: any) => e.code === "WORKER_UNAVAILABLE",
      );
      await assert.rejects(
        completing(503, '{"success":false,"error":{').getJob(JOB_ID),
        (e: any) => e.code === "WORKER_UNAVAILABLE",
      );
    });

    // P ── 401/403 still short-circuit before any body is read.
    it("P: 401 and 403 remain WORKER_UNAVAILABLE and read no body", async () => {
      for (const status of [401, 403]) {
        await assert.rejects(
          completing(status, VALID_JOB).getJob(JOB_ID),
          (e: any) => e.code === "WORKER_UNAVAILABLE",
        );
      }
    });

    // Timer cleanup ── EVERY exit must clear the request timer, including the
    // ones that return early and never read a body. A leaked timer would keep
    // the event loop referenced for the rest of the budget, so a 60 s budget
    // makes one unmistakable.
    //
    // The assertion is a DELTA across the call rather than an absolute count:
    // it is then unaffected by any timer the runner or an unrelated suite
    // happens to hold, and still fails if this request leaves one of its own.
    const activeTimers = () =>
      (process as any).getActiveResourcesInfo().filter((r: string) => r === "Timeout").length;

    const respondingOnce = (status: number, body: string, contentType: string) => new WorkerClient({
      baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
      requestTimeoutMs: 60000,
      fetchImplementation: (async () => new Response(body, {
        status,
        headers: { "Content-Type": contentType, "Content-Length": String(Buffer.byteLength(body, "utf8")) },
      })) as unknown as typeof fetch,
    });

    it("every settled request clears its timer, on every exit path", async () => {
      const exits: Array<[string, () => Promise<unknown>]> = [
        // early, body never read
        ["401", () => respondingOnce(401, '{"error":"unauthorized"}', "application/json").getJob(JOB_ID)],
        ["403", () => respondingOnce(403, "<html>denied</html>", "text/html").getJob(JOB_ID)],
        // 503, both branches of the Phase-10F disambiguation
        ["503 canonical", () => respondingOnce(503, JSON.stringify({
          success: false,
          error: { code: "EXTRACTOR_UNAVAILABLE", message: ERROR_MESSAGES.EXTRACTOR_UNAVAILABLE },
        }), "application/json").getJob(JOB_ID)],
        ["503 ambiguous", () => respondingOnce(503, "<html>503</html>", "text/html").getJob(JOB_ID)],
        // validation failure after the body was read
        ["malformed body", () => respondingOnce(200, "{badjson", "application/json").getJob(JOB_ID)],
        ["bad content-type", () => respondingOnce(200, VALID_JOB, "text/html").getJob(JOB_ID)],
        // a non-503 business error
        ["429 envelope", () => respondingOnce(429, JSON.stringify({
          success: false, error: { code: "RATE_LIMITED", message: "x" },
        }), "application/json").getJob(JOB_ID)],
        // transport failure before any response exists
        ["fetch rejection", () => new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          requestTimeoutMs: 60000,
          fetchImplementation: (async () => { throw new TypeError("unexpected redirect"); }) as unknown as typeof fetch,
        }).getJob(JOB_ID)],
        // health: early exit, and the success path
        ["health 503", () => respondingOnce(503, '{"success":false}', "application/json").health()],
        ["health 200", () => respondingOnce(200, '{"status":"ok"}', "application/json").health()],
      ];

      for (const [name, call] of exits) {
        const before = activeTimers();
        await call().catch(() => {});
        assert.strictEqual(
          activeTimers(),
          before,
          `the ${name} exit must not leave a request timer armed`,
        );
      }
    });

    // Q ── the byte and header bounds still decide their own outcomes; a body
    // that COMPLETES (or overflows) is never reclassified as a timeout just
    // because the deadline is now armed while it is read.
    it("Q: an oversized streamed body under an armed deadline is still PROCESSING_FAILED", async () => {
      const client = new WorkerClient({
        baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
        requestTimeoutMs: 1000,
        fetchImplementation: (async () => new Response(new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(2 * 1024 * 1024));
            c.enqueue(new Uint8Array(1)); // one byte past the 2 MiB ceiling
            c.close();
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch,
      });
      await assert.rejects(client.getJob(JOB_ID), (e: any) => e.code === "PROCESSING_FAILED");
    });

    it("Q: Content-Type and Content-Length rejections are unchanged under an armed deadline", async () => {
      await assert.rejects(
        completing(200, VALID_JOB, "text/html").getJob(JOB_ID),
        (e: any) => e.code === "PROCESSING_FAILED",
      );
      for (const len of ["-1", "1.5", "1e5", "100a", "9007199254740992", "3000000"]) {
        const client = new WorkerClient({
          baseUrl: BASE_URL, currentKeyId: TEST_KEY_ID, currentSecret: TEST_SECRET,
          requestTimeoutMs: 1000,
          fetchImplementation: (async () => new Response(VALID_JOB, {
            status: 200, headers: { "Content-Type": "application/json", "Content-Length": len },
          })) as unknown as typeof fetch,
        });
        await assert.rejects(client.getJob(JOB_ID), (e: any) => e.code === "PROCESSING_FAILED");
      }
    });

    it("Q: malformed complete JSON is still PROCESSING_FAILED, never a timeout", async () => {
      await assert.rejects(
        completing(200, "{badjson").getJob(JOB_ID),
        (e: any) => e.code === "PROCESSING_FAILED",
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
