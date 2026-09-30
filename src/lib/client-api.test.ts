import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ERROR_MESSAGES } from "./errors.ts";
import {
  ClientApiError,
  GENERIC_API_ERROR_MESSAGE,
  NETWORK_API_ERROR_MESSAGE,
  analyzeVideo,
  getJobStatus,
  loginWithAccessSecret,
  startDownload,
} from "./client-api.ts";

/**
 * BROWSER-JOB-STATUS-POLL-RESILIENCE-001: what a failed control-plane call
 * becomes in the browser. Only structure survives — kind, allowlisted code,
 * HTTP status — plus a message that is safe to show.
 */

const JOB_ID = "0123456789abcdef0123456789abcdef";
const SECRET_TEXT = "token=sk-live-SECRET /var/lib/videofetch X-Amz-Signature=deadbeef";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respondWith(body: BodyInit | null, status: number, contentType = "application/json") {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "Content-Type": contentType } });
  }) as typeof fetch;
  return calls;
}

function envelope(code: unknown, message: unknown = "x"): string {
  return JSON.stringify({ success: false, error: { code, message } });
}

async function statusFailure(): Promise<ClientApiError> {
  try {
    await getJobStatus(JOB_ID);
  } catch (err) {
    assert.ok(err instanceof ClientApiError, "every status failure is a ClientApiError");
    return err;
  }
  assert.fail("getJobStatus should have thrown");
}

function assertNoSecret(err: ClientApiError) {
  const visible = `${err.message} ${JSON.stringify(err)} ${String(err.code)}`;
  for (const fragment of ["sk-live", "/var/lib", "X-Amz-Signature", "SECRET"]) {
    assert.equal(visible.includes(fragment), false, `leaked ${fragment}`);
  }
}

function job(status: string) {
  return {
    jobId: JOB_ID,
    status,
    progress: 40,
    stageLabel: "Downloading",
    downloadedBytes: 1,
    totalBytes: 2,
    speed: null,
    eta: null,
    error: null,
    errorCode: null,
    filename: null,
    fileSize: null,
    quality: "1080",
    container: "mp4",
    title: "Clip",
    thumbnail: null,
    source: "cdn.example",
    extractor: "direct",
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3,
    downloadUrl: null,
  };
}

describe("status polling: canonical error envelopes keep code and status", () => {
  const cases = [
    ["WORKER_UNAVAILABLE", 503],
    ["NOT_FOUND", 404],
    ["EXPIRED", 410],
    ["ACCESS_REQUIRED", 401],
    ["ACCESS_NOT_CONFIGURED", 503],
    ["FORBIDDEN", 403],
    ["PROCESSING_FAILED", 500],
  ] as const;
  for (const [code, status] of cases) {
    it(`${code} → code ${code}, status ${status}, kind response`, async () => {
      respondWith(envelope(code, ERROR_MESSAGES[code]), status);
      const err = await statusFailure();
      assert.equal(err.kind, "response");
      assert.equal(err.code, code);
      assert.equal(err.status, status);
      assert.equal(err.message, ERROR_MESSAGES[code]);
    });
  }

  it("falls back to the canonical message when a recognized envelope has none", async () => {
    respondWith(envelope("EXPIRED", ""), 410);
    const err = await statusFailure();
    assert.equal(err.code, "EXPIRED");
    assert.equal(err.message, ERROR_MESSAGES.EXPIRED);
  });
});

describe("status polling: nothing untrusted becomes a code or a message", () => {
  const untrusted: unknown[] = [
    "INTERNAL_BOOM",
    "not_found",
    "worker_unavailable",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "",
    42,
    null,
    { code: "NOT_FOUND" },
  ];
  for (const code of untrusted) {
    it(`does not trust the code ${JSON.stringify(code)}`, async () => {
      respondWith(envelope(code, SECRET_TEXT), 404);
      const err = await statusFailure();
      assert.equal(err.kind, "response");
      assert.equal(err.code, null);
      assert.equal(err.status, 404, "the HTTP status is still kept");
      assert.equal(err.message, GENERIC_API_ERROR_MESSAGE);
      assertNoSecret(err);
    });
  }

  const malformed: [string, BodyInit | null, string][] = [
    ["an HTML error page", `<html><body>502 Bad Gateway ${SECRET_TEXT}</body></html>`, "text/html"],
    ["truncated JSON", `{"success":false,"error":{"code":"NOT_FOUND","message":"${SECRET_TEXT}"`, "application/json"],
    ["an empty body", null, "application/json"],
    ["a bare string", JSON.stringify(SECRET_TEXT), "application/json"],
    ["success:true", JSON.stringify({ success: true, error: { code: "NOT_FOUND", message: SECRET_TEXT } }), "application/json"],
    ["error as a string", JSON.stringify({ success: false, error: `NOT_FOUND ${SECRET_TEXT}` }), "application/json"],
    ["a top-level code", JSON.stringify({ code: "NOT_FOUND", message: SECRET_TEXT }), "application/json"],
  ];
  for (const [label, body, type] of malformed) {
    it(`keeps only the status for ${label}`, async () => {
      respondWith(body, 502, type);
      const err = await statusFailure();
      assert.equal(err.kind, "response");
      assert.equal(err.code, null);
      assert.equal(err.status, 502);
      assert.equal(err.message, GENERIC_API_ERROR_MESSAGE);
      assertNoSecret(err);
    });
  }

  it("exposes only its name, kind, code and status as its own fields", async () => {
    respondWith(envelope("WORKER_UNAVAILABLE", ERROR_MESSAGES.WORKER_UNAVAILABLE), 503);
    const err = await statusFailure();
    assert.deepEqual(Object.keys(err).sort(), ["code", "kind", "name", "status"]);
    assert.equal(err.name, "ClientApiError");
  });
});

describe("status polling: no response at all is a network failure", () => {
  for (const [label, thrown] of [
    ["Chrome", new TypeError("Failed to fetch")],
    ["Safari", new TypeError("Load failed")],
    ["Firefox", new TypeError("NetworkError when attempting to fetch resource.")],
    ["an abort", new DOMException("The operation was aborted.", "AbortError")],
  ] as const) {
    it(`classifies a rejected fetch (${label}) without its text`, async () => {
      globalThis.fetch = (async () => {
        throw thrown;
      }) as typeof fetch;
      const err = await statusFailure();
      assert.equal(err.kind, "network");
      assert.equal(err.code, null);
      assert.equal(err.status, null);
      assert.equal(err.message, NETWORK_API_ERROR_MESSAGE);
      assert.equal(err.message.includes(thrown.message), false);
    });
  }

  it("classifies a body that breaks off mid-read as a network failure", async () => {
    globalThis.fetch = (async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jobId":'));
          controller.error(new TypeError("network error"));
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const err = await statusFailure();
    assert.equal(err.kind, "network");
    assert.equal(err.status, null);
  });

  it("passes the abort signal to fetch", async () => {
    const calls = respondWith(JSON.stringify(job("downloading")), 200);
    const controller = new AbortController();
    await getJobStatus(JOB_ID, { signal: controller.signal });
    assert.equal(calls[0].url, `/api/download/${JOB_ID}/status`);
    assert.equal(calls[0].init?.signal, controller.signal);
  });
});

describe("status polling: a 2xx must be a job status", () => {
  it("returns a well-formed status", async () => {
    respondWith(JSON.stringify(job("processing")), 200);
    const result = await getJobStatus(JOB_ID);
    assert.equal(result.jobId, JOB_ID);
    assert.equal(result.status, "processing");
  });

  for (const [label, body] of [
    ["an interstitial page", `<html>Sign in to Wi-Fi ${SECRET_TEXT}</html>`],
    ["JSON without a status", JSON.stringify({ jobId: JOB_ID })],
    ["JSON without a job id", JSON.stringify({ status: "ready" })],
    ["another job's status", JSON.stringify({ ...job("ready"), jobId: "fedcba9876543210fedcba9876543210" })],
    ["JSON null", "null"],
  ]) {
    it(`rejects ${label} as a response failure carrying the 2xx status`, async () => {
      respondWith(body, 200, "text/html");
      const err = await statusFailure();
      assert.equal(err.kind, "response");
      assert.equal(err.code, null);
      assert.equal(err.status, 200);
      assert.equal(err.message, GENERIC_API_ERROR_MESSAGE);
      assertNoSecret(err);
    });
  }
});

describe("other callers keep working through .message", () => {
  it("analyze keeps the canonical envelope message", async () => {
    respondWith(envelope("INVALID_URL", ERROR_MESSAGES.INVALID_URL), 400);
    await assert.rejects(analyzeVideo("nope"), (err: unknown) => {
      assert.ok(err instanceof ClientApiError);
      assert.equal(err.message, ERROR_MESSAGES.INVALID_URL);
      assert.equal(err.code, "INVALID_URL");
      return true;
    });
  });

  it("login keeps the server's own message for a recognized code", async () => {
    respondWith(envelope("ACCESS_REQUIRED", "Invalid access secret."), 401);
    await assert.rejects(loginWithAccessSecret("wrong"), { message: "Invalid access secret." });
  });

  it("download creation reports a lost connection in application copy", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await assert.rejects(startDownload({ url: "https://cdn.example/v.mp4", formatId: "direct-original" }), {
      message: NETWORK_API_ERROR_MESSAGE,
    });
  });
});
