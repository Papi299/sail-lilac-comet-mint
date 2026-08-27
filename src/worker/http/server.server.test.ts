import { test } from "node:test";
import assert from "node:assert";
import { createWorkerServer } from "./server.server.ts";
import type { WorkerReplayStore } from "../security/replay-store.ts";
import type { Server } from "node:http";
import { Buffer } from "node:buffer";
import { createWorkerSignatureHex } from "../../shared/worker/hmac.server.ts";
import { createHash } from "node:crypto";
import { request } from "node:http";
import net from "node:net";
import { WORKER_CONTROL_MAX_BODY_BYTES } from "../../shared/worker/constants.ts";

class MockReplayStore implements WorkerReplayStore {
  public reserved = new Set<string>();
  async reserve(requestId: string): Promise<"reserved" | "duplicate"> {
    if (this.reserved.has(requestId)) return "duplicate";
    this.reserved.add(requestId);
    return "reserved";
  }
}

const secret = "0123456789abcdef0123456789abcdef";

function generateAuthHeaders(method: string, path: string, body: Buffer, requestId: string, timestamp: number, idempotencyKey?: string) {
  const sha256RawBody = createHash("sha256").update(body).digest("hex");
  const signature = createWorkerSignatureHex(secret, {
    keyId: "key-1",
    method: method as "GET" | "POST",
    canonicalPath: path,
    timestampSeconds: String(timestamp),
    requestId,
    idempotencyKey,
    sha256RawBody,
  });

  const headers: Record<string, string> = {
    "x-videofetch-key-id": "key-1",
    "x-videofetch-timestamp": String(timestamp),
    "x-videofetch-request-id": requestId,
    "x-videofetch-signature": signature,
  };
  if (idempotencyKey) {
    headers["idempotency-key"] = idempotencyKey;
  }
  return headers;
}

function makeRequest(server: Server, method: string, path: string, headers: Record<string, string | string[]> = {}, body?: Buffer): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as any;
    const req = request(
      {
        method,
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        headers,
      },
      (res) => {
        let resBody = "";
        res.on("data", (chunk) => resBody += chunk);
        res.on("end", () => resolve({ status: res.statusCode || 0, body: resBody }));
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function makeRawRequest(server: Server, requestString: string): Promise<{ status: number, headers: string, body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as any;
    const client = net.createConnection({ port: addr.port }, () => {
      client.write(requestString);
    });
    
    let data = "";
    client.on("data", (chunk) => data += chunk.toString());
    client.on("end", () => {
      const [headerPart, ...bodyParts] = data.split("\r\n\r\n");
      const headersLines = headerPart.split("\r\n");
      const statusLine = headersLines[0];
      const match = statusLine.match(/^HTTP\/1\.\d (\d{3})/);
      const status = match ? parseInt(match[1], 10) : 0;
      resolve({
        status,
        headers: headerPart,
        body: bodyParts.join("\r\n\r\n")
      });
    });
    client.on("error", reject);
  });
}

test("Worker HTTP Server", async (t) => {
  const replayStore = new MockReplayStore();
  const now = 1700000000;
  const server = createWorkerServer({
    currentKeyId: "key-1",
    currentSecret: secret,
    replayStore,
    clock: () => now,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  await t.test("GET /v1/healthz is unauthenticated and 200", async () => {
    const res = await makeRequest(server, "GET", "/v1/healthz");
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: "ok" });
  });

  await t.test("POST /v1/healthz gives 405", async () => {
    const res = await makeRequest(server, "POST", "/v1/healthz");
    assert.strictEqual(res.status, 405);
  });

  await t.test("GET /v1/analyze gives 405", async () => {
    const res = await makeRequest(server, "GET", "/v1/analyze");
    assert.strictEqual(res.status, 405);
  });

  await t.test("POST /v1/analyze with valid auth gives 501", async () => {
    const body = Buffer.from(JSON.stringify({ url: "https://example.com" }));
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, "11111111-1111-4111-a111-111111111111", now);
    headers["content-type"] = "application/json";
    const res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 501);
  });

  await t.test("POST /v1/jobs with valid auth gives 501", async () => {
    const body = Buffer.from(JSON.stringify({ url: "https://example.com", formatId: "best", principalId: "private-access-user" }));
    const headers = generateAuthHeaders("POST", "/v1/jobs", body, "22222222-2222-4222-a222-222222222222", now, "33333333-3333-4333-a333-333333333333");
    headers["content-type"] = "application/json";
    const res = await makeRequest(server, "POST", "/v1/jobs", headers, body);
    assert.strictEqual(res.status, 501);
  });

  await t.test("GET /v1/jobs/<id> gives 501", async () => {
    const path = "/v1/jobs/0123456789abcdef0123456789abcdef";
    const headers = generateAuthHeaders("GET", path, Buffer.from(""), "44444444-4444-4444-a444-444444444444", now);
    const res = await makeRequest(server, "GET", path, headers);
    assert.strictEqual(res.status, 501);
  });

  await t.test("POST /v1/jobs/<id>/cancel gives 501", async () => {
    const path = "/v1/jobs/0123456789abcdef0123456789abcdef/cancel";
    const headers = generateAuthHeaders("POST", path, Buffer.from(""), "55555555-5555-4555-a555-555555555555", now);
    const res = await makeRequest(server, "POST", path, headers);
    assert.strictEqual(res.status, 501);
  });

  await t.test("Query string is rejected", async () => {
    const res = await makeRawRequest(server, "GET /v1/healthz?foo=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    assert.strictEqual(res.status, 404); // Not Found via strict exact routing
  });

  await t.test("Duplicate headers are rejected", async () => {
    const body = Buffer.from(JSON.stringify({ url: "https://example.com" }));
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, "66666666-6666-4666-a666-666666666666", now);
    headers["content-type"] = "application/json";
    // Duplicate array
    const duplicateHeaders = { ...headers, "x-videofetch-key-id": ["key-1", "key-1"] };
    const res = await makeRequest(server, "POST", "/v1/analyze", duplicateHeaders, body);
    assert.strictEqual(res.status, 401);
  });

  await t.test("Missing Idempotency-Key on jobs create gives 400", async () => {
    const body = Buffer.from(JSON.stringify({ url: "https://example.com", formatId: "best", principalId: "private-access-user" }));
    // Generate auth without idempotency key
    const headers = generateAuthHeaders("POST", "/v1/jobs", body, "77777777-7777-4777-a777-777777777777", now);
    headers["content-type"] = "application/json";
    const res = await makeRequest(server, "POST", "/v1/jobs", headers, body);
    assert.strictEqual(res.status, 400);
  });

  await t.test("Extra Idempotency-Key on analyze gives 400", async () => {
    const body = Buffer.from(JSON.stringify({ url: "https://example.com" }));
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, "88888888-8888-4888-a888-888888888888", now, "99999999-9999-4999-a999-999999999999");
    headers["content-type"] = "application/json";
    const res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 400);
  });

  await t.test("Malformed JSON gives 400", async () => {
    const body = Buffer.from("{ bad json");
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", now);
    headers["content-type"] = "application/json";
    const res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 400);
  });

  await t.test("Body over max bytes gives 413", async () => {
    const body = Buffer.alloc(WORKER_CONTROL_MAX_BODY_BYTES + 1);
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb", now);
    headers["content-type"] = "application/json";
    const res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 413);
  });
  
  await t.test("Raw request-target normalization resistance", async () => {
    const targets = [
      "http://evil.example/v1/healthz",
      "https://evil.example/v1/analyze",
      "//evil.example/v1/healthz",
      "/v1/jobs/../diagnostics",
      "/v1/jobs/%2e%2e/diagnostics",
      "/v1/jobs/.%2e/diagnostics",
      "/v1\\diagnostics",
      "/v1/jobs\\..\\diagnostics",
      "/v1//diagnostics",
      "/v1/%64iagnostics",
      "/v1/jobs/%2Fanything",
    ];
    for (const target of targets) {
      const res = await makeRawRequest(server, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      assert.notStrictEqual(res.status, 200, `Expected failure for ${target}`);
    }
  });

  await t.test("Signed request with mismatched raw target fails", async () => {
    const body = Buffer.from("");
    const headers = generateAuthHeaders("GET", "/v1/diagnostics", body, "cccccccc-cccc-4ccc-accc-cccccccccccc", now);
    
    // Construct raw HTTP request with wrong target but valid signature for the right target
    let rawReq = `GET /v1/jobs/../diagnostics HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      rawReq += `${k}: ${v}\r\n`;
    }
    rawReq += `\r\n`;
    
    const res = await makeRawRequest(server, rawReq);
    assert.notStrictEqual(res.status, 200);
    assert.notStrictEqual(res.status, 501);
  });

  await t.test("Ordering: malformed JSON with valid auth reserves ID then 400", async () => {
    const body = Buffer.from("{ bad json");
    const reqId = "dddddddd-dddd-4ddd-addd-dddddddddddd";
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, reqId, now);
    headers["content-type"] = "application/json";
    
    const res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 400); // Fails parsing
    assert.ok(replayStore.reserved.has(reqId)); // But ID was reserved
  });

  await t.test("Ordering: duplicate replay with malformed JSON gives 401 without parsing", async () => {
    const body = Buffer.from("{ bad json");
    const reqId = "dddddddd-dddd-4ddd-addd-dddddddddddd"; // reused from above
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, reqId, now);
    headers["content-type"] = "application/json";
    
    const res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 401); // 401 Duplicate Replay, not 400 Bad Request
  });
});
