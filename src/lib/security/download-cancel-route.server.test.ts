import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.ts";
import { AppError, ERROR_MESSAGES } from "../errors.ts";
import { consumeRateLimit, remainingRateLimit, resetRateLimitForTests } from "./rate-limit.server.ts";
import {
  ACCESS_COOKIE_NAME,
  PRIVATE_ACCESS_PRINCIPAL_ID,
  mintSessionToken,
  setPrivateAccessNowForTests,
  setPrivateAccessTestEnv,
} from "./private-access.server.ts";
import {
  DOWNLOAD_CANCEL_RATE_LIMIT,
  handleDownload,
  handleDownloadCancel,
  handleDownloadCancelMethodNotAllowed,
  resetPrivateAccessApiForTests,
} from "./private-access-api.server.ts";
import { WorkerJobViewSchema, type WorkerJobView, type WorkerObjectKey } from "../../shared/worker/contracts.ts";
import {
  resetWorkerRuntimeForTests,
  setWorkerClientForTests,
  type WorkerControlClient,
} from "../../web/config/worker-runtime.server.ts";
import { WorkerClient } from "../../web/worker/worker-client.server.ts";
import { setSafeHttpTestHooks } from "./safe-http.server.ts";

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001:
 * `POST /api/download/:jobId/cancel`.
 *
 * The route reuses the private-access gate unchanged, adds a rate limit of its
 * own, validates the job id against the closed schema, and asks the Worker's
 * existing HMAC cancel endpoint. It returns the job the Worker committed — the
 * public projection only — and never invents an outcome.
 */

// Distinct from the job id, so the leak checks below can tell them apart.
const SECRET = "fedcba9876543210-access-secret-xyz";
const JOB_ID = "0123456789abcdef0123456789abcdef";
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/aaaabbbbccccddddeeeeffff00001111` as WorkerObjectKey;
const RAW =
  "worker: cancel failed for videofetch/jobs/x at /var/lib/videofetch?X-Amz-Signature=deadbeef key=sk-live-SECRET";

function workerJob(overrides: Partial<WorkerJobView> = {}): WorkerJobView {
  const now = Date.now();
  return WorkerJobViewSchema.parse({
    jobId: JOB_ID,
    status: "cancelled",
    progress: 42,
    stageLabel: "Downloading",
    downloadedBytes: 42_000,
    totalBytes: 100_000,
    speed: null,
    eta: null,
    errorCode: null,
    safeErrorMessage: null,
    filename: null,
    fileSize: null,
    mime: null,
    quality: "1080",
    container: "mp4",
    title: "Clip",
    thumbnail: null,
    source: "cdn.example",
    extractor: "direct",
    createdAt: now - 10_000,
    updatedAt: now - 1_000,
    expiresAt: now + 2_700_000,
    objectKey: null,
    ...overrides,
  });
}

/** Records every call; the cancel answer is scripted per test. */
class FakeWorkerClient implements WorkerControlClient {
  calls: string[] = [];
  cancelAnswer: () => Promise<{ success: true; job: WorkerJobView }> = async () => ({ success: true, job: workerJob() });
  async analyze(): Promise<never> {
    this.calls.push("analyze");
    throw new Error("analyze must not be called");
  }
  async createJob(): Promise<never> {
    this.calls.push("createJob");
    throw new Error("a cancellation must never create a job");
  }
  async getJob(): Promise<never> {
    this.calls.push("getJob");
    throw new Error("getJob must not be called");
  }
  async cancelJob(jobId: string) {
    this.calls.push(`cancelJob:${jobId}`);
    return this.cancelAnswer();
  }
  async diagnostics(): Promise<never> {
    this.calls.push("diagnostics");
    throw new Error("diagnostics must not be called");
  }
}

function install(): FakeWorkerClient {
  const client = new FakeWorkerClient();
  setWorkerClientForTests(client);
  return client;
}

function cancelRequest(
  jobId: string,
  init: { cookie?: string | null; site?: string | null; method?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(init.headers);
  const cookie = init.cookie === undefined ? `${ACCESS_COOKIE_NAME}=${mintSessionToken(SECRET)}` : init.cookie;
  if (cookie) headers.set("cookie", cookie);
  const site = init.site === undefined ? "same-origin" : init.site;
  if (site) headers.set("sec-fetch-site", site);
  return new Request(`https://videofetch.example/api/download/${jobId}/cancel`, {
    method: init.method ?? "POST",
    headers,
  });
}

async function cancel(jobId = JOB_ID, init: Parameters<typeof cancelRequest>[1] = {}) {
  const res = await handleDownloadCancel(cancelRequest(jobId, init), jobId);
  const raw = await res.text();
  return { res, raw, body: raw ? JSON.parse(raw) : null };
}

function production() {
  setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
}

function assertNoLeak(raw: string) {
  for (const fragment of [
    "objectKey",
    "videofetch/jobs",
    "safeErrorMessage",
    "X-Amz-Signature",
    "/var/lib",
    "sk-live",
    "worker: cancel failed",
    SECRET,
  ]) {
    assert.equal(raw.includes(fragment), false, `the browser response leaked ${fragment}`);
  }
}

function resetAll() {
  resetPrivateAccessApiForTests();
  resetWorkerRuntimeForTests();
  setPrivateAccessTestEnv(null);
  setPrivateAccessNowForTests(null);
  resetRateLimitForTests();
  setSafeHttpTestHooks(null);
}

// ── Authentication: the existing private-access session, unchanged ──────────

describe("cancel requires private access before anything else", () => {
  afterEach(resetAll);

  it("refuses a request with no session, without calling the Worker", async () => {
    production();
    const client = install();
    const { res, body, raw } = await cancel(JOB_ID, { cookie: null });
    assert.equal(res.status, 401);
    assert.equal(body.error.code, "ACCESS_REQUIRED");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(client.calls, []);
    assertNoLeak(raw);
  });

  it("refuses a forged, malformed or expired session", async () => {
    production();
    const client = install();
    const expired = mintSessionToken(SECRET, Date.now() - 8 * 24 * 60 * 60 * 1000);
    const otherSecret = mintSessionToken("ffffffffffffffffffffffffffffffff");
    for (const cookie of [
      `${ACCESS_COOKIE_NAME}=v1.9999999999.AAAA`,
      `${ACCESS_COOKIE_NAME}=${otherSecret}`,
      `${ACCESS_COOKIE_NAME}=${expired}`,
      `${ACCESS_COOKIE_NAME}=`,
      `not_the_cookie=${mintSessionToken(SECRET)}`,
    ]) {
      const { res, body } = await cancel(JOB_ID, { cookie });
      assert.equal(res.status, 401, cookie);
      assert.equal(body.error.code, "ACCESS_REQUIRED", cookie);
    }
    assert.deepEqual(client.calls, []);
  });

  it("a session that expires between two requests is refused on the second", async () => {
    production();
    const client = install();
    const token = mintSessionToken(SECRET);
    const ok = await cancel(JOB_ID, { cookie: `${ACCESS_COOKIE_NAME}=${token}` });
    assert.equal(ok.res.status, 200);
    setPrivateAccessNowForTests(() => Date.now() + 8 * 24 * 60 * 60 * 1000);
    const later = await cancel(JOB_ID, { cookie: `${ACCESS_COOKIE_NAME}=${token}` });
    assert.equal(later.res.status, 401);
    assert.equal(client.calls.length, 1, "only the first request reached the Worker");
  });

  it("fails closed when production has no access secret", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: undefined });
    const client = install();
    const { res, body } = await cancel();
    assert.equal(res.status, 503);
    assert.equal(body.error.code, "ACCESS_NOT_CONFIGURED");
    assert.deepEqual(client.calls, []);
  });

  it("keeps the existing development bypass (non-production, no secret) exactly as other job routes do", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: undefined });
    const client = install();
    const { res } = await cancel(JOB_ID, { cookie: null });
    assert.equal(res.status, 200);
    assert.deepEqual(client.calls, [`cancelJob:${JOB_ID}`]);
  });
});

// ── Request forgery: the existing Sec-Fetch-Site isolation, unchanged ───────

describe("cancel refuses cross-site requests", () => {
  afterEach(resetAll);

  for (const site of ["cross-site", "same-site", "CROSS-SITE", "bogus"]) {
    it(`refuses Sec-Fetch-Site: ${site} even with a valid session`, async () => {
      production();
      const client = install();
      const { res, body } = await cancel(JOB_ID, { site });
      assert.equal(res.status, 403);
      assert.equal(body.error.code, "FORBIDDEN");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(client.calls, []);
    });
  }

  it("refuses a cross-site request in the development bypass too (no cookie involved)", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: undefined });
    const client = install();
    const { res } = await cancel(JOB_ID, { cookie: null, site: "cross-site" });
    assert.equal(res.status, 403);
    assert.deepEqual(client.calls, []);
  });

  it("accepts same-origin, and the existing policy's 'none' and absent header", async () => {
    production();
    const client = install();
    for (const site of ["same-origin", "none", null]) {
      const { res } = await cancel(JOB_ID, { site });
      assert.equal(res.status, 200, String(site));
    }
    assert.equal(client.calls.length, 3);
  });

  it("the cross-site refusal is checked before the rate limit, so a forged request cannot use up the budget", async () => {
    production();
    install();
    for (let i = 0; i < DOWNLOAD_CANCEL_RATE_LIMIT + 5; i += 1) {
      await cancel(JOB_ID, { site: "cross-site" });
      await cancel(JOB_ID, { cookie: null });
    }
    assert.equal(remainingRateLimit(`cancel:${PRIVATE_ACCESS_PRINCIPAL_ID}`, DOWNLOAD_CANCEL_RATE_LIMIT), DOWNLOAD_CANCEL_RATE_LIMIT);
    const { res } = await cancel();
    assert.equal(res.status, 200, "the person can still cancel");
  });
});

// ── Methods ──────────────────────────────────────────────────────────────────

describe("only POST can cancel", () => {
  afterEach(resetAll);

  it("the route maps POST to the cancel handler and every other method to a 405", async () => {
    const mod = await import("@/routes/api/download.$jobId.cancel");
    const handlers = (mod.Route as unknown as { options: { server: { handlers: Record<string, unknown> } } }).options
      .server.handlers;
    assert.deepEqual(Object.keys(handlers).sort(), ["ANY", "POST"]);
    for (const absent of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      assert.equal(absent in handlers, false, `${absent} must fall to ANY`);
    }
  });

  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    it(`${method} is refused with 405 before any access check, rate limit or Worker call`, async () => {
      production();
      const client = install();
      const mod = await import("@/routes/api/download.$jobId.cancel");
      const handlers = (mod.Route as unknown as {
        options: { server: { handlers: Record<string, (ctx: unknown) => Promise<Response>> } };
      }).options.server.handlers;
      const res = await handlers.ANY({ request: cancelRequest(JOB_ID, { method }), params: { jobId: JOB_ID } });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(await res.text(), "");
      assert.deepEqual(client.calls, []);
      assert.equal(remainingRateLimit(`cancel:${PRIVATE_ACCESS_PRINCIPAL_ID}`, DOWNLOAD_CANCEL_RATE_LIMIT), DOWNLOAD_CANCEL_RATE_LIMIT);
    });
  }

  it("the POST handler delegates to handleDownloadCancel with the path's job id", async () => {
    production();
    const client = install();
    const mod = await import("@/routes/api/download.$jobId.cancel");
    const handlers = (mod.Route as unknown as {
      options: { server: { handlers: Record<string, (ctx: unknown) => Promise<Response>> } };
    }).options.server.handlers;
    const res = await handlers.POST({ request: cancelRequest(JOB_ID), params: { jobId: JOB_ID } });
    assert.equal(res.status, 200);
    assert.deepEqual(client.calls, [`cancelJob:${JOB_ID}`]);
  });

  it("the refusal itself is constant", () => {
    const res = handleDownloadCancelMethodNotAllowed();
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });
});

// ── Job id ───────────────────────────────────────────────────────────────────

describe("cancel validates the job id before the Worker", () => {
  afterEach(resetAll);

  for (const bad of [
    "",
    "123",
    "0123456789ABCDEF0123456789ABCDEF",
    `${JOB_ID}0`,
    "0123456789abcdef0123456789abcdeg",
    "../../v1/diagnostics",
    "0123456789abcdef0123456789abcde%2F",
    `${JOB_ID}/cancel`,
    "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  ]) {
    it(`refuses ${JSON.stringify(bad)} as NOT_FOUND with no Worker call`, async () => {
      production();
      const client = install();
      const res = await handleDownloadCancel(cancelRequest(JOB_ID), bad);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.deepEqual(body, { success: false, error: { code: "NOT_FOUND", message: ERROR_MESSAGES.NOT_FOUND } });
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(client.calls, []);
    });
  }
});

// ── Rate limit ───────────────────────────────────────────────────────────────

describe("cancel is rate limited without a lasting denial", () => {
  afterEach(() => {
    mock.timers.reset();
    resetAll();
  });

  it(`allows ${DOWNLOAD_CANCEL_RATE_LIMIT} per minute, then refuses with 429 before the Worker`, async () => {
    production();
    const client = install();
    for (let i = 0; i < DOWNLOAD_CANCEL_RATE_LIMIT; i += 1) {
      assert.equal((await cancel()).res.status, 200, `request ${i + 1}`);
    }
    const refused = await cancel();
    assert.equal(refused.res.status, 429);
    assert.equal(refused.body.error.code, "RATE_LIMITED");
    assert.equal(refused.res.headers.get("cache-control"), "no-store");
    assert.equal(client.calls.length, DOWNLOAD_CANCEL_RATE_LIMIT, "the refused request never reached the Worker");
  });

  it("the refusal ends when the window slides: no persistent denial", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    production();
    install();
    for (let i = 0; i < DOWNLOAD_CANCEL_RATE_LIMIT; i += 1) await cancel();
    assert.equal((await cancel()).res.status, 429);
    mock.timers.tick(59_999);
    assert.equal((await cancel()).res.status, 429, "still inside the minute");
    mock.timers.tick(2);
    assert.equal((await cancel()).res.status, 200, "allowed again once the window has passed");
  });

  it("uses a bucket of its own: analyze and download traffic cannot use it up, nor it theirs", async () => {
    production();
    install();
    const downloadLimit = Math.max(8, Math.floor(config.rateLimitPerMinute / 2));
    for (let i = 0; i < downloadLimit + 3; i += 1) consumeRateLimit(`download:${PRIVATE_ACCESS_PRINCIPAL_ID}`, downloadLimit);
    for (let i = 0; i < config.rateLimitPerMinute + 3; i += 1) {
      consumeRateLimit(`analyze:${PRIVATE_ACCESS_PRINCIPAL_ID}`, config.rateLimitPerMinute);
    }
    assert.equal((await cancel()).res.status, 200, "a person who used up downloads can still cancel");
    for (let i = 0; i < DOWNLOAD_CANCEL_RATE_LIMIT; i += 1) await cancel();
    assert.equal(remainingRateLimit(`download:${PRIVATE_ACCESS_PRINCIPAL_ID}`, 1_000), 1_000 - downloadLimit);
  });

  it("a malformed id is counted after access (an authenticated person only spends their own budget)", async () => {
    production();
    const client = install();
    const res = await handleDownloadCancel(cancelRequest(JOB_ID), "nope");
    assert.equal(res.status, 404);
    assert.equal(remainingRateLimit(`cancel:${PRIVATE_ACCESS_PRINCIPAL_ID}`, DOWNLOAD_CANCEL_RATE_LIMIT), DOWNLOAD_CANCEL_RATE_LIMIT - 1);
    assert.deepEqual(client.calls, []);
  });
});

// ── The Worker decides; the route reports it ────────────────────────────────

describe("the Worker's committed job is returned as the public projection", () => {
  afterEach(resetAll);

  it("a job THIS request cancelled", async () => {
    production();
    const client = install();
    client.cancelAnswer = async () => ({ success: true, job: workerJob({ status: "cancelled", stageLabel: "Uploading" }) });
    const { res, body, raw } = await cancel();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(body.jobId, JOB_ID);
    assert.equal(body.status, "cancelled");
    assert.equal(body.error, null);
    assert.equal(body.errorCode, null);
    assert.equal(body.downloadUrl, null);
    assert.deepEqual(client.calls, [`cancelJob:${JOB_ID}`], "exactly one Worker call: no retry, no create, no status read");
    assertNoLeak(raw);
  });

  it("a job that had already reached ready stays ready, with only the local file route", async () => {
    production();
    const client = install();
    client.cancelAnswer = async () => ({
      success: true,
      job: workerJob({
        status: "ready",
        objectKey: OBJECT_KEY,
        filename: "clip.mp4",
        fileSize: 2048,
        mime: "video/mp4",
        stageLabel: "Ready",
        progress: 100,
      }),
    });
    const { res, body, raw } = await cancel();
    assert.equal(res.status, 200);
    assert.equal(body.status, "ready", "never re-labelled as cancelled");
    assert.equal(body.downloadUrl, `/api/download/${JOB_ID}/file`);
    assert.equal("mime" in body, false);
    assertNoLeak(raw);
  });

  it("a job that had already failed keeps its failure, with the control plane's own copy", async () => {
    production();
    const client = install();
    client.cancelAnswer = async () => ({
      success: true,
      job: workerJob({ status: "failed", errorCode: "TIMEOUT", safeErrorMessage: RAW, stageLabel: "Upload failed" }),
    });
    const { body, raw } = await cancel();
    assert.equal(body.status, "failed");
    assert.equal(body.errorCode, "TIMEOUT");
    assert.equal(body.stageLabel, "Upload failed");
    assert.equal(body.error, "Uploading the finished file took too long.");
    assertNoLeak(raw);
  });

  it("an earlier cancellation is answered unchanged (idempotent)", async () => {
    production();
    const client = install();
    const first = await cancel();
    const second = await cancel();
    assert.equal(first.body.status, "cancelled");
    assert.equal(second.body.status, "cancelled");
    assert.equal(client.calls.length, 2, "each request is one Worker call; the Worker answers unchanged");
  });

  it("an unknown job is NOT_FOUND", async () => {
    production();
    const client = install();
    client.cancelAnswer = async () => {
      throw new AppError("NOT_FOUND");
    };
    const { res, body } = await cancel();
    assert.equal(res.status, 404);
    assert.deepEqual(body, { success: false, error: { code: "NOT_FOUND", message: ERROR_MESSAGES.NOT_FOUND } });
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  for (const status of ["ready", "failed", "cancelled"] as const) {
    it(`a ${status} job past its retention answers EXPIRED, never a cancellation`, async () => {
      production();
      const client = install();
      client.cancelAnswer = async () => ({
        success: true,
        job: workerJob({
          status,
          expiresAt: Date.now() - 1,
          ...(status === "ready"
            ? { objectKey: OBJECT_KEY, filename: "clip.mp4", fileSize: 1, mime: "video/mp4" }
            : status === "failed"
              ? { errorCode: "NETWORK_ERROR" as const }
              : {}),
        }),
      });
      const { res, body, raw } = await cancel();
      assert.equal(res.status, 410);
      assert.deepEqual(body, { success: false, error: { code: "EXPIRED", message: ERROR_MESSAGES.EXPIRED } });
      assertNoLeak(raw);
    });
  }
});

describe("Worker failures keep their meaning and never leak", () => {
  afterEach(resetAll);

  it("an unreachable Worker is WORKER_UNAVAILABLE (503), not a job failure", async () => {
    production();
    const client = install();
    client.cancelAnswer = async () => {
      throw new AppError("WORKER_UNAVAILABLE", RAW);
    };
    const { res, body, raw } = await cancel();
    assert.equal(res.status, 503);
    assert.deepEqual(body, {
      success: false,
      error: { code: "WORKER_UNAVAILABLE", message: ERROR_MESSAGES.WORKER_UNAVAILABLE },
    });
    assert.equal("status" in body, false, "no job status is invented");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assertNoLeak(raw);
  });

  for (const [label, thrown] of [
    ["a plain Error", new Error(RAW)],
    ["a TypeError", new TypeError(RAW)],
    ["a thrown string", RAW],
    ["an AppError with a raw message", new AppError("PROCESSING_FAILED", RAW)],
  ] as const) {
    it(`${label} is an unclassified 500 with the canonical message only`, async () => {
      production();
      const client = install();
      client.cancelAnswer = async () => {
        throw thrown;
      };
      const { res, body, raw } = await cancel();
      assert.equal(res.status, 500);
      assert.deepEqual(body, {
        success: false,
        error: { code: "PROCESSING_FAILED", message: ERROR_MESSAGES.PROCESSING_FAILED },
      });
      assertNoLeak(raw);
    });
  }

  it("a Worker view the public DTO refuses is a 500, never a partial job", async () => {
    production();
    const client = install();
    client.cancelAnswer = async () => ({
      success: true,
      job: { ...workerJob(), thumbnail: "not a url" } as unknown as WorkerJobView,
    });
    const { res, body } = await cancel();
    assert.equal(res.status, 500);
    assert.equal(body.error.code, "PROCESSING_FAILED");
  });
});

// ── Through the REAL Worker client: HMAC stays server-side ──────────────────

describe("the cancel request to the Worker through the real client", () => {
  afterEach(resetAll);

  const KEY_ID = "test-key-id";
  const WORKER_SECRET = "01234567890123456789012345678901";
  const ACCESS_ID = "cf-access-client-id-value";
  const ACCESS_SECRET = "cf-access-client-secret-value-0123456789";

  function installReal(answer: (req: { url: string; init: RequestInit }) => Response) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    setWorkerClientForTests(
      new WorkerClient({
        baseUrl: "https://worker.example",
        currentKeyId: KEY_ID,
        currentSecret: WORKER_SECRET,
        cloudflareAccessClientId: ACCESS_ID,
        cloudflareAccessClientSecret: ACCESS_SECRET,
        fetchImplementation: (async (url: string, init: RequestInit) => {
          seen.push({ url, init });
          return answer({ url, init });
        }) as unknown as typeof fetch,
      }),
    );
    return seen;
  }

  function json(body: unknown, status = 200): Response {
    const text = JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) },
    });
  }

  it("signs one POST to the Worker's cancel path, with no body and no Idempotency-Key", async () => {
    production();
    const seen = installReal(() => json({ success: true, job: workerJob({ status: "cancelled" }) }));
    const { res, raw } = await cancel();
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1, "no retry");
    const [{ url, init }] = seen;
    assert.equal(url, `https://worker.example/v1/jobs/${JOB_ID}/cancel`);
    assert.equal(init.method, "POST");
    assert.equal(init.body, undefined);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-videofetch-key-id"), KEY_ID);
    assert.match(headers.get("x-videofetch-signature") ?? "", /^[0-9a-f]{64}$/);
    assert.equal(headers.has("idempotency-key"), false);
    assert.equal(headers.get("cf-access-client-id"), ACCESS_ID);
    // Nothing of the server-to-server authentication reaches the browser.
    for (const secret of [WORKER_SECRET, ACCESS_SECRET, ACCESS_ID, headers.get("x-videofetch-signature")!, KEY_ID]) {
      assert.equal(raw.includes(secret), false, "credential material leaked");
    }
    for (const header of ["x-videofetch-signature", "x-videofetch-key-id", "cf-access-client-secret", "cf-access-client-id"]) {
      assert.equal(res.headers.has(header), false, header);
    }
    assertNoLeak(raw);
  });

  it("a transport failure is WORKER_UNAVAILABLE and carries nothing of the exception", async () => {
    production();
    installReal(() => {
      throw new TypeError(RAW);
    });
    const { res, raw } = await cancel();
    assert.equal(res.status, 503);
    assertNoLeak(raw);
  });

  it("an edge error page in front of the Worker is a 5xx the browser treats as unconfirmed", async () => {
    production();
    installReal(() => new Response(`<html>502 Bad Gateway ${RAW}</html>`, { status: 502, headers: { "Content-Type": "text/html" } }));
    const { res, raw } = await cancel();
    assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
    assertNoLeak(raw);
  });

  it("a Worker 404 envelope is NOT_FOUND; a Worker 401 (HMAC refused) is WORKER_UNAVAILABLE, never echoed", async () => {
    production();
    installReal(() => json({ success: false, error: { code: "NOT_FOUND", message: RAW } }, 404));
    const notFound = await cancel();
    assert.equal(notFound.res.status, 404);
    assert.equal(notFound.body.error.message, ERROR_MESSAGES.NOT_FOUND);
    assertNoLeak(notFound.raw);

    installReal(() => json({ error: "unauthorized" }, 401));
    const refused = await cancel();
    assert.equal(refused.res.status, 503);
    assert.equal(refused.body.error.code, "WORKER_UNAVAILABLE");
  });

  it("a Worker answer carrying the object key is stripped before the browser", async () => {
    production();
    installReal(() =>
      json({
        success: true,
        job: workerJob({ status: "ready", objectKey: OBJECT_KEY, filename: "clip.mp4", fileSize: 1, mime: "video/mp4" }),
      }),
    );
    const { res, raw } = await cancel();
    assert.equal(res.status, 200);
    assertNoLeak(raw);
  });
});

describe("cancellation never creates a job", () => {
  afterEach(resetAll);

  it("handleDownloadCancel calls only cancelJob, for every Worker answer", async () => {
    production();
    const client = install();
    for (const answer of [
      async () => ({ success: true as const, job: workerJob({ status: "cancelled" }) }),
      async () => {
        throw new AppError("WORKER_UNAVAILABLE");
      },
      async () => {
        throw new AppError("NOT_FOUND");
      },
    ]) {
      client.cancelAnswer = answer;
      await cancel();
    }
    assert.deepEqual(client.calls, [`cancelJob:${JOB_ID}`, `cancelJob:${JOB_ID}`, `cancelJob:${JOB_ID}`]);
  });

  it("a cancel request with a JSON body naming a URL or format is ignored, not forwarded", async () => {
    production();
    allowDns();
    const client = install();
    const req = new Request(`https://videofetch.example/api/download/${JOB_ID}/cancel`, {
      method: "POST",
      headers: {
        cookie: `${ACCESS_COOKIE_NAME}=${mintSessionToken(SECRET)}`,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://cdn.example/x.mp4", formatId: "preset:best", principalId: "x" }),
    });
    const res = await handleDownloadCancel(req, JOB_ID);
    assert.equal(res.status, 200);
    assert.deepEqual(client.calls, [`cancelJob:${JOB_ID}`]);
    // And the download route is a different operation with its own rate limit.
    assert.equal(typeof handleDownload, "function");
  });
});

function allowDns() {
  setSafeHttpTestHooks({ lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
}
