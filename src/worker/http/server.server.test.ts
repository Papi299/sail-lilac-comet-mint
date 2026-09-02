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
import { WorkerAuthenticationError } from "../security/authenticate.server.ts";
import type { WorkerBusinessService } from "./business-service.server.ts";

class MockReplayStore implements WorkerReplayStore {
  public reserved = new Set<string>();
  public shouldThrow: boolean | Error = false;

  async reserve(requestId: string): Promise<"reserved" | "duplicate"> {
    if (this.shouldThrow) {
      throw (this.shouldThrow instanceof Error ? this.shouldThrow : new Error("Database unavailable"));
    }
    if (this.reserved.has(requestId)) return "duplicate";
    this.reserved.add(requestId);
    return "reserved";
  }
}

const secret = "0123456789abcdef0123456789abcdef";

/**
 * Counts business dispatches so the security-ordering tests can prove that an
 * unauthenticated or replayed request never reaches the business boundary.
 */
class SpyBusinessService implements WorkerBusinessService {
  public calls: string[] = [];

  async analyze() {
    this.calls.push("analyze");
    return { success: true as const, video: SAMPLE_VIDEO };
  }
  async createJob() {
    this.calls.push("createJob");
    return { status: 201 as const, body: { success: true as const, job: sampleJob("queued") } };
  }
  async getJob() {
    this.calls.push("getJob");
    return { success: true as const, job: sampleJob("queued") };
  }
  async cancelJob() {
    this.calls.push("cancelJob");
    return { success: true as const, job: sampleJob("cancelled") };
  }
  async diagnostics() {
    this.calls.push("diagnostics");
    return {
      status: "ok" as const,
      queueDepth: 0,
      runningJobs: 0,
      maxConcurrent: 1,
      binaries: { ffmpeg: true, ytdlp: false },
      runtime: { ytdlpVersion: null },
      features: { ytdlpEnabled: false },
      safeEgress: { enforcement: "external" as const, policyVersion: null },
    };
  }
}

const SAMPLE_VIDEO = {
  title: "Clip",
  thumbnail: null,
  duration: null,
  source: "cdn.example",
  extractor: "direct",
  webpageUrl: "https://cdn.example/a.mp4",
  formats: [],
  presets: [],
  capabilities: { mp3: false, merge: false },
};

function sampleJob(status: "queued" | "cancelled") {
  return {
    jobId: "0123456789abcdef0123456789abcdef",
    status,
    progress: null,
    stageLabel: null,
    downloadedBytes: null,
    totalBytes: null,
    speed: null,
    eta: null,
    errorCode: null,
    safeErrorMessage: null,
    filename: null,
    fileSize: null,
    mime: null,
    quality: null,
    container: null,
    title: null,
    thumbnail: null,
    source: null,
    extractor: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    objectKey: null,
  };
}

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

function makeRequest(server: Server, method: string, path: string, headers: Record<string, string | string[]> = {}, body?: Buffer): Promise<{ status: number, body: string, headers: any }> {
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
        res.on("end", () => resolve({ status: res.statusCode || 0, body: resBody, headers: res.headers }));
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
  const businessService = new SpyBusinessService();
  const now = 1700000000;
  const server = createWorkerServer(
    {
      currentKeyId: "key-1",
      currentSecret: secret,
      replayStore,
      clock: () => now,
    },
    businessService,
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  t.beforeEach(() => {
    replayStore.reserved.clear();
    replayStore.shouldThrow = false;
    businessService.calls = [];
  });

  await t.test("GET /v1/healthz is unauthenticated and 200", async () => {
    const res = await makeRequest(server, "GET", "/v1/healthz");
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: "ok" });
    assert.strictEqual(res.headers["cache-control"], "no-store");
  });

  await t.test("Exact method/path regression matrix", async () => {
    // The authenticated business routes are LIVE: they must never answer 501.
    const tests = [
      { method: "POST", path: "/v1/analyze", expected: 200, type: "analyze" },
      { method: "GET", path: "/v1/analyze", expected: 405, type: "analyze" },
      { method: "POST", path: "/v1/jobs", expected: 201, type: "jobs_create" },
      { method: "GET", path: "/v1/jobs", expected: 405, type: "jobs_create" },
      { method: "GET", path: "/v1/jobs/0123456789abcdef0123456789abcdef", expected: 200, type: "jobs_get" },
      { method: "POST", path: "/v1/jobs/0123456789abcdef0123456789abcdef", expected: 405, type: "jobs_get" },
      { method: "POST", path: "/v1/jobs/0123456789abcdef0123456789abcdef/cancel", expected: 200, type: "jobs_cancel" },
      { method: "GET", path: "/v1/jobs/0123456789abcdef0123456789abcdef/cancel", expected: 405, type: "jobs_cancel" },
      { method: "GET", path: "/v1/diagnostics", expected: 200, type: "diagnostics" },
      { method: "POST", path: "/v1/diagnostics", expected: 405, type: "diagnostics" },
      { method: "GET", path: "/v1/healthz", expected: 200, type: "health" },
      { method: "POST", path: "/v1/healthz", expected: 405, type: "health" },
      { method: "GET", path: "/v1/unknown", expected: 404, type: "unknown" },
    ];

    let reqId = 1000;
    for (const { method, path, expected, type } of tests) {
      if (expected === 405 || expected === 404 || type === "health") {
        const res = await makeRequest(server, method, path);
        assert.strictEqual(res.status, expected, `${method} ${path} failed`);
      } else {
        const payload = type === "jobs_create" 
          ? { url: "https://example.com", formatId: "best", principalId: "private-access-user" }
          : (type === "analyze" ? { url: "https://example.com" } : "");
        const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
        const idempotencyKey = type === "jobs_create" ? "11111111-1111-4111-a111-111111111111" : undefined;
        const headers = generateAuthHeaders(method, path, body, `11111111-1111-4111-a111-${String(reqId++).padStart(12, "0")}`, now, idempotencyKey);
        if (type === "analyze" || type === "jobs_create") {
          headers["content-type"] = "application/json";
        }
        const res = await makeRequest(server, method, path, headers, body);
        assert.strictEqual(res.status, expected, `${method} ${path} failed`);
        assert.notStrictEqual(res.status, 501, `${method} ${path} still returns a 501 placeholder`);
      }
    }
  });

  await t.test("Duplicate headers are rejected", async () => {
    const body = Buffer.from(JSON.stringify({ url: "https://example.com" }));
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, "66666666-6666-4666-a666-666666666666", now);
    headers["content-type"] = "application/json";

    const keysToTest = [
      "x-videofetch-key-id",
      "x-videofetch-timestamp",
      "x-videofetch-request-id",
      "x-videofetch-signature",
      "idempotency-key"
    ];

    // Note: Idempotency-Key is not in the base analyze headers, let's test it on jobs
    const jobsHeaders = generateAuthHeaders("POST", "/v1/jobs", body, "77777777-7777-4777-a777-777777777777", now, "88888888-8888-4888-a888-888888888888");
    jobsHeaders["content-type"] = "application/json";

    for (const key of keysToTest) {
      if (key === "idempotency-key") {
        const duplicateHeaders = { ...jobsHeaders, [key]: [jobsHeaders[key], jobsHeaders[key]] };
        const res = await makeRequest(server, "POST", "/v1/jobs", duplicateHeaders, body);
        assert.strictEqual(res.status, 401, `Duplicate ${key} should return 401`);
      } else {
        const duplicateHeaders = { ...headers, [key]: [headers[key], headers[key]] };
        const res = await makeRequest(server, "POST", "/v1/analyze", duplicateHeaders, body);
        assert.strictEqual(res.status, 401, `Duplicate ${key} should return 401`);
      }
    }
  });

  await t.test("HTTP Replay store failure tests", async () => {
    const body = Buffer.from(JSON.stringify({ url: "https://example.com" }));
    const reqId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    
    // Throw standard Error
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, reqId, now);
    headers["content-type"] = "application/json";
    replayStore.shouldThrow = new Error("Database unavailable");
    let res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 503);

    // Throw Error("unauthorized")
    replayStore.shouldThrow = new Error("unauthorized");
    res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 503);

    // Throw WorkerAuthenticationError
    replayStore.shouldThrow = new WorkerAuthenticationError();
    res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 503);
    
    // Cleanup
    replayStore.shouldThrow = false;
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
    const reqId = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, reqId, now);
    headers["content-type"] = "application/json";
    
    // First request
    await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.ok(replayStore.reserved.has(reqId));
    
    // Second request (duplicate)
    const res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 401); // 401 Duplicate Replay, not 400 Bad Request
  });
  
  await t.test("Ordering: store failure with malformed JSON gives 503 without parsing", async () => {
    const body = Buffer.from("{ bad json");
    const reqId = "ffffffff-ffff-4fff-afff-ffffffffffff";
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, reqId, now);
    headers["content-type"] = "application/json";
    
    replayStore.shouldThrow = true;
    const res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 503);
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

  await t.test("Invalid HMAC never reaches the business service", async () => {
    const body = Buffer.from(JSON.stringify({ url: "https://cdn.example/a.mp4" }));
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, "12121212-1212-4121-a121-121212121212", now);
    headers["content-type"] = "application/json";
    headers["x-videofetch-signature"] = "0".repeat(64);

    const res = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(businessService.calls, []);
  });

  await t.test("Replayed request never reaches the business service", async () => {
    const body = Buffer.from(JSON.stringify({ url: "https://cdn.example/a.mp4" }));
    const reqId = "13131313-1313-4131-a131-131313131313";
    const headers = generateAuthHeaders("POST", "/v1/analyze", body, reqId, now);
    headers["content-type"] = "application/json";

    const first = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(businessService.calls, ["analyze"]);

    const replay = await makeRequest(server, "POST", "/v1/analyze", headers, body);
    assert.strictEqual(replay.status, 401);
    // Still exactly one dispatch: the replay was stopped before business logic.
    assert.deepStrictEqual(businessService.calls, ["analyze"]);
  });

  await t.test("Business responses are no-store JSON and never expose 501", async () => {
    const body = Buffer.from("");
    const headers = generateAuthHeaders("GET", "/v1/diagnostics", body, "14141414-1414-4141-a141-141414141414", now);
    const res = await makeRequest(server, "GET", "/v1/diagnostics", headers);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["cache-control"], "no-store");
    assert.match(res.headers["content-type"], /application\/json/);
    assert.strictEqual(JSON.parse(res.body).maxConcurrent, 1);
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
});
