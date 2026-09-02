import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.ts";
import { ERROR_MESSAGES, AppError } from "../errors.ts";
import { remainingRateLimit, resetRateLimitForTests } from "./rate-limit.server.ts";
import { setSafeHttpTestHooks } from "./safe-http.server.ts";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_LOGIN_RATE_KEY,
  ACCESS_LOGIN_RATE_LIMIT,
  PRIVATE_ACCESS_PRINCIPAL_ID,
  mintSessionToken,
  setPrivateAccessNowForTests,
  setPrivateAccessTestEnv,
} from "./private-access.server.ts";
import {
  handleAccessLogin,
  handleAccessLogout,
  handleAccessSession,
  handleAnalyze,
  handleDiagnostics,
  handleDownload,
  handleDownloadFile,
  handleDownloadStatus,
  handleSites,
  resetPrivateAccessApiForTests,
  setSitesOperationForTests,
} from "./private-access-api.server.ts";
import type {
  WorkerJobStatus,
  WorkerJobView,
  WorkerObjectKey,
} from "../../shared/worker/contracts.ts";
import { WorkerJobViewSchema } from "../../shared/worker/contracts.ts";
import {
  resetWorkerRuntimeForTests,
  setObjectStoreSignerForTests,
  setWorkerClientForTests,
  type WorkerControlClient,
} from "../../web/config/worker-runtime.server.ts";
import type { ObjectStoreSigner } from "../../web/storage/object-store-signer.server.ts";

const SECRET = "0123456789abcdef0123456789abcdef";
const ANALYZE_LIMIT = config.rateLimitPerMinute;
const DOWNLOAD_LIMIT = Math.max(8, Math.floor(config.rateLimitPerMinute / 2));

const JOB_ID = "0123456789abcdef0123456789abcdef";
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/aaaabbbbccccddddeeeeffff00001111`;
const SIGNED_URL =
  "https://acct.r2.cloudflarestorage.com/bucket/videofetch/jobs/x?X-Amz-Signature=deadbeef";

const VIDEO = {
  title: "Clip",
  thumbnail: null,
  duration: 10,
  source: "cdn.example",
  extractor: "direct",
  webpageUrl: "https://cdn.example/video.mp4",
  formats: [],
  presets: [],
  capabilities: { mp3: false, merge: false },
};

const DIAGNOSTICS = {
  status: "ok" as const,
  queueDepth: 0,
  runningJobs: 0,
  maxConcurrent: 1,
  binaries: { ffmpeg: true, ytdlp: false },
  runtime: { ytdlpVersion: null },
  features: { ytdlpEnabled: false },
  safeEgress: { enforcement: "external" as const, policyVersion: null },
};

function workerJob(overrides: Partial<WorkerJobView> = {}): WorkerJobView {
  return WorkerJobViewSchema.parse({
    jobId: JOB_ID,
    status: "queued",
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
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    objectKey: null,
    ...overrides,
  });
}

function readyJob(overrides: Partial<WorkerJobView> = {}): WorkerJobView {
  return workerJob({
    status: "ready",
    objectKey: OBJECT_KEY as WorkerObjectKey,
    filename: "clip.mp4",
    fileSize: 2048,
    mime: "video/mp4",
    quality: "original",
    container: "mp4",
    title: "Clip",
    ...overrides,
  });
}

/** Records every control-plane call so tests can prove ordering and payloads. */
class FakeWorkerClient implements WorkerControlClient {
  public analyzeCalls: unknown[] = [];
  public createCalls: unknown[] = [];
  public getJobCalls: string[] = [];
  public cancelCalls: string[] = [];
  public diagnosticsCalls = 0;

  public job: WorkerJobView = workerJob();
  public failWith: Error | null = null;

  async analyze(input: unknown) {
    this.analyzeCalls.push(input);
    if (this.failWith) throw this.failWith;
    return { success: true as const, video: VIDEO };
  }
  async createJob(input: unknown) {
    this.createCalls.push(input);
    if (this.failWith) throw this.failWith;
    return { success: true as const, job: this.job };
  }
  async getJob(jobId: string) {
    this.getJobCalls.push(jobId);
    if (this.failWith) throw this.failWith;
    return { success: true as const, job: this.job };
  }
  async cancelJob(jobId: string) {
    this.cancelCalls.push(jobId);
    if (this.failWith) throw this.failWith;
    return { success: true as const, job: this.job };
  }
  async diagnostics() {
    this.diagnosticsCalls += 1;
    if (this.failWith) throw this.failWith;
    return DIAGNOSTICS;
  }
}

class FakeSigner implements ObjectStoreSigner {
  public calls: { objectKey: string; expiresAt: number }[] = [];
  public failWith: Error | null = null;

  async signGet(input: { objectKey: WorkerObjectKey; expiresAt: number }) {
    this.calls.push({ objectKey: input.objectKey, expiresAt: input.expiresAt });
    if (this.failWith) throw this.failWith;
    return { url: SIGNED_URL, expiresAt: input.expiresAt };
  }
}

function installWorker(): { client: FakeWorkerClient; signer: FakeSigner } {
  const client = new FakeWorkerClient();
  const signer = new FakeSigner();
  setWorkerClientForTests(client);
  setObjectStoreSignerForTests(signer);
  return { client, signer };
}

function allowDns() {
  setSafeHttpTestHooks({ lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
}

function apiRequest(
  path: string,
  init?: {
    method?: string;
    body?: unknown;
    cookie?: string;
    site?: string;
    headers?: Record<string, string>;
  },
): Request {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set("cookie", init.cookie);
  if (init?.site) headers.set("sec-fetch-site", init.site);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://videofetch.example${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

function authedCookie(): string {
  return `${ACCESS_COOKIE_NAME}=${mintSessionToken(SECRET)}`;
}

async function readJson(res: Response): Promise<{
  success?: boolean;
  authenticated?: boolean;
  configured?: boolean;
  developmentBypass?: boolean;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}> {
  return (await res.json()) as never;
}

function resetAll() {
  resetPrivateAccessApiForTests();
  resetWorkerRuntimeForTests();
  setPrivateAccessTestEnv(null);
  setPrivateAccessNowForTests(null);
  resetRateLimitForTests();
  setSafeHttpTestHooks(null);
}

const PROXY_HEADERS_A: Record<string, string> = {
  "x-forwarded-for": "1.1.1.1",
  "x-real-ip": "2.2.2.2",
  forwarded: "for=3.3.3.3",
  "x-vercel-forwarded-for": "4.4.4.4",
  "cf-connecting-ip": "5.5.5.5",
  "true-client-ip": "6.6.6.6",
};

const PROXY_HEADERS_B: Record<string, string> = {
  "x-forwarded-for": "8.8.8.8",
  "x-real-ip": "9.9.9.9",
  forwarded: "for=10.10.10.10",
  "x-vercel-forwarded-for": "11.11.11.11",
  "cf-connecting-ip": "12.12.12.12",
  "true-client-ip": "13.13.13.13",
};

// ── Private access session lifecycle (unchanged by Phase 7) ─────────────────

describe("private access API handlers", () => {
  afterEach(resetAll);

  it("logs in with a valid secret, sets a cookie that does not contain the secret, and authenticates", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const res = await handleAccessLogin(
      apiRequest("/api/access/login", { method: "POST", body: { secret: SECRET }, site: "same-origin" }),
    );
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(body.authenticated, true);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${ACCESS_COOKIE_NAME}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.equal(/Domain=/i.test(cookie), false);
    assert.equal(cookie.includes(SECRET), false);
    const token = cookie.split(";")[0]?.split("=")[1] ?? "";
    const session = await handleAccessSession(
      apiRequest("/api/access/session", { cookie: `${ACCESS_COOKIE_NAME}=${token}`, site: "same-origin" }),
    );
    assert.deepEqual(await readJson(session), {
      authenticated: true,
      configured: true,
      developmentBypass: false,
    });
    assert.equal(session.headers.get("cache-control"), "no-store");
  });

  it("rejects an invalid login with 401 and does not set a session cookie", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const res = await handleAccessLogin(
      apiRequest("/api/access/login", { method: "POST", body: { secret: "nope" }, site: "same-origin" }),
    );
    assert.equal(res.status, 401);
    const body = await readJson(res);
    assert.equal(body.error?.code, "ACCESS_REQUIRED");
    assert.equal(body.error?.message?.includes("32"), false);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.equal(cookie.includes(`${ACCESS_COOKIE_NAME}=v1.`), false);
  });

  it("clears the cookie on logout", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const res = await handleAccessLogout(apiRequest("/api/access/logout", { method: "POST", site: "same-origin" }));
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /Max-Age=0/);
    const session = await handleAccessSession(apiRequest("/api/access/session", { site: "same-origin" }));
    assert.equal((await readJson(session)).authenticated, false);
  });

  it("describes unauthenticated, development-bypass, and production-misconfigured sessions", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const unauth = await readJson(await handleAccessSession(apiRequest("/api/access/session")));
    assert.deepEqual(unauth, { authenticated: false, configured: true, developmentBypass: false });

    setPrivateAccessTestEnv({ nodeEnv: "development", secret: undefined });
    const bypass = await readJson(await handleAccessSession(apiRequest("/api/access/session")));
    assert.deepEqual(bypass, { authenticated: false, configured: false, developmentBypass: true });

    setPrivateAccessTestEnv({ nodeEnv: "production", secret: undefined });
    const missing = await readJson(await handleAccessSession(apiRequest("/api/access/session")));
    assert.deepEqual(missing, { authenticated: false, configured: false, developmentBypass: false });
  });
});

// ── Authorization must precede every worker call ────────────────────────────

describe("worker calls require private access first", () => {
  afterEach(resetAll);

  it("does not call the worker for an unauthenticated analyze", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleAnalyze(
      apiRequest("/api/analyze", { method: "POST", body: { url: "https://cdn.example/v.mp4" } }),
    );
    assert.equal(res.status, 401);
    assert.equal((await readJson(res)).error?.code, "ACCESS_REQUIRED");
    assert.equal(client.analyzeCalls.length, 0);
  });

  it("does not call the worker for an unauthenticated download", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: { url: "https://cdn.example/v.mp4", formatId: "direct-original" },
      }),
    );
    assert.equal(res.status, 401);
    assert.equal((await readJson(res)).error?.code, "ACCESS_REQUIRED");
    assert.equal(client.createCalls.length, 0);
  });

  it("does not call the worker for an unauthenticated status request", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    client.job = readyJob();
    const res = await handleDownloadStatus(apiRequest(`/api/download/${JOB_ID}/status`), JOB_ID);
    assert.equal(res.status, 401);
    const body = JSON.stringify(await readJson(res));
    assert.equal(body.includes(OBJECT_KEY), false);
    assert.equal(client.getJobCalls.length, 0);
  });

  it("does not call the worker or the signer for an unauthenticated file request", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client, signer } = installWorker();
    client.job = readyJob();
    const res = await handleDownloadFile(apiRequest(`/api/download/${JOB_ID}/file`), JOB_ID);
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.equal(text.includes(OBJECT_KEY), false);
    assert.equal(text.includes(SIGNED_URL), false);
    assert.equal(JSON.parse(text).error.code, "ACCESS_REQUIRED");
    assert.equal(client.getJobCalls.length, 0);
    assert.equal(signer.calls.length, 0);
  });

  it("does not call the worker for unauthenticated sites or diagnostics", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    let sites = 0;
    setSitesOperationForTests(async () => {
      sites += 1;
      return { leaked: true };
    });
    assert.equal((await handleSites(apiRequest("/api/sites"))).status, 401);
    assert.equal((await handleDiagnostics(apiRequest("/api/diagnostics"))).status, 401);
    assert.equal(sites, 0);
    assert.equal(client.diagnosticsCalls, 0);
  });

  it("rejects a forged cookie before reaching the worker", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleAnalyze(
      apiRequest("/api/analyze", {
        method: "POST",
        body: { url: "https://cdn.example/v.mp4" },
        cookie: `${ACCESS_COOKIE_NAME}=v1.9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        site: "same-origin",
      }),
    );
    assert.equal(res.status, 401);
    assert.equal(client.analyzeCalls.length, 0);
  });

  it("rejects cross-site analyze even with a valid cookie", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleAnalyze(
      apiRequest("/api/analyze", {
        method: "POST",
        body: { url: "https://cdn.example/v.mp4" },
        cookie: authedCookie(),
        site: "cross-site",
      }),
    );
    assert.equal(res.status, 403);
    assert.equal((await readJson(res)).error?.code, "FORBIDDEN");
    assert.equal(client.analyzeCalls.length, 0);
  });

  it("fails closed in production when the access secret is missing", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: undefined });
    const { client } = installWorker();
    const res = await handleAnalyze(
      apiRequest("/api/analyze", { method: "POST", body: { url: "https://cdn.example/v.mp4" } }),
    );
    assert.equal(res.status, 503);
    assert.equal((await readJson(res)).error?.code, "ACCESS_NOT_CONFIGURED");
    assert.equal(client.analyzeCalls.length, 0);
  });
});

// ── /api/analyze ────────────────────────────────────────────────────────────

describe("analyze is served by the worker", () => {
  afterEach(resetAll);

  it("forwards the validated URL and returns the worker video payload", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    allowDns();
    const { client } = installWorker();
    const res = await handleAnalyze(
      apiRequest("/api/analyze", {
        method: "POST",
        body: { url: "https://cdn.example/video.mp4" },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(body.success, true);
    assert.deepEqual(body.video, VIDEO);
    assert.deepEqual(client.analyzeCalls, [{ url: "https://cdn.example/video.mp4" }]);
  });

  it("performs Vercel-side SSRF validation before calling the worker", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    for (const url of [
      "http://127.0.0.1/video.mp4",
      "http://localhost/video.mp4",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/video.mp4",
      "file:///etc/passwd",
      "",
    ]) {
      const res = await handleAnalyze(
        apiRequest("/api/analyze", {
          method: "POST",
          body: { url },
          cookie: authedCookie(),
          site: "same-origin",
        }),
      );
      assert.equal(res.status >= 400, true, `${url} must be rejected`);
    }
    assert.equal(client.analyzeCalls.length, 0, "no blocked URL may reach the worker");
  });

  it("rejects a non-http scheme the worker contract cannot accept", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleAnalyze(
      apiRequest("/api/analyze", {
        method: "POST",
        body: { url: "sample://demo" },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await readJson(res)).error?.code, "INVALID_URL");
    assert.equal(client.analyzeCalls.length, 0);
  });

  it("rate limits before calling the worker", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    allowDns();
    const { client } = installWorker();
    const cookie = authedCookie();
    for (let i = 0; i < ANALYZE_LIMIT; i += 1) {
      const res = await handleAnalyze(
        apiRequest("/api/analyze", {
          method: "POST",
          body: { url: "https://cdn.example/video.mp4" },
          cookie,
          site: "same-origin",
          headers: { "x-forwarded-for": "1.1.1.1" },
        }),
      );
      assert.equal(res.status, 200);
    }
    const throttled = await handleAnalyze(
      apiRequest("/api/analyze", {
        method: "POST",
        body: { url: "https://cdn.example/video.mp4" },
        cookie,
        site: "same-origin",
        headers: { "x-forwarded-for": "8.8.8.8" },
      }),
    );
    assert.equal(throttled.status, 429);
    assert.equal((await readJson(throttled)).error?.code, "RATE_LIMITED");
    assert.equal(client.analyzeCalls.length, ANALYZE_LIMIT, "the throttled call never hit the worker");
    assert.equal(remainingRateLimit(`analyze:${PRIVATE_ACCESS_PRINCIPAL_ID}`, ANALYZE_LIMIT), 0);
    assert.equal(remainingRateLimit("analyze:1.1.1.1", ANALYZE_LIMIT), ANALYZE_LIMIT);
  });

  it("surfaces WORKER_UNAVAILABLE as a safe 503", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    allowDns();
    const { client } = installWorker();
    client.failWith = new AppError("WORKER_UNAVAILABLE");
    const res = await handleAnalyze(
      apiRequest("/api/analyze", {
        method: "POST",
        body: { url: "https://cdn.example/video.mp4" },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    assert.equal(res.status, 503);
    const body = await readJson(res);
    assert.equal(body.error?.code, "WORKER_UNAVAILABLE");
    assert.equal(body.error?.message, ERROR_MESSAGES.WORKER_UNAVAILABLE);
    const encoded = JSON.stringify(body);
    assert.equal(encoded.includes("WORKER_BASE_URL"), false);
    assert.equal(encoded.includes("hmac"), false);
    assert.equal(encoded.includes("127.0.0.1"), false);
  });
});

// ── /api/download ───────────────────────────────────────────────────────────

describe("download creation is served by the worker", () => {
  afterEach(resetAll);

  it("derives the principal server-side and ignores a browser-supplied one", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    allowDns();
    const { client } = installWorker();
    const res = await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: {
          url: "https://cdn.example/video.mp4",
          formatId: "direct-original",
          principalId: "attacker-principal",
        },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(client.createCalls.length, 1);
    const sent = client.createCalls[0] as Record<string, unknown>;
    assert.equal(sent.principalId, PRIVATE_ACCESS_PRINCIPAL_ID);
    assert.equal(JSON.stringify(sent).includes("attacker-principal"), false);
  });

  it("never forwards browser title, thumbnail or source as worker create metadata", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    allowDns();
    const { client } = installWorker();
    await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: {
          url: "https://cdn.example/video.mp4",
          formatId: "direct-original",
          title: "SPOOFED-TITLE",
          thumbnail: "https://evil.example/t.jpg",
          source: "evil.example",
        },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    const sent = client.createCalls[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent).sort(), ["formatId", "principalId", "url"]);
    const encoded = JSON.stringify(sent);
    assert.equal(encoded.includes("SPOOFED-TITLE"), false);
    assert.equal(encoded.includes("evil.example"), false);
  });

  it("never lets the browser supply an Idempotency-Key", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    allowDns();
    const { client } = installWorker();
    await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: {
          url: "https://cdn.example/video.mp4",
          formatId: "direct-original",
          idempotencyKey: "99999999-9999-4999-a999-999999999999",
        },
        cookie: authedCookie(),
        site: "same-origin",
        headers: { "idempotency-key": "99999999-9999-4999-a999-999999999999" },
      }),
    );
    const sent = JSON.stringify(client.createCalls[0]);
    assert.equal(sent.includes("99999999-9999-4999-a999-999999999999"), false);
    assert.equal(sent.toLowerCase().includes("idempotency"), false);
  });

  it("strips the object key from the create response", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    allowDns();
    const { client } = installWorker();
    client.job = readyJob();
    const res = await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: { url: "https://cdn.example/video.mp4", formatId: "direct-original" },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    const raw = await res.text();
    assert.equal(raw.includes(OBJECT_KEY), false);
    assert.equal(raw.includes("objectKey"), false);
    assert.equal(raw.includes("videofetch/jobs"), false);
  });

  it("requires a format id and validates the URL before calling the worker", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const noFormat = await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: { url: "https://cdn.example/video.mp4" },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    assert.equal(noFormat.status, 409);
    assert.equal((await readJson(noFormat)).error?.code, "FORMAT_UNAVAILABLE");

    const blocked = await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: { url: "http://127.0.0.1/video.mp4", formatId: "direct-original" },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    assert.equal(blocked.status, 400);
    assert.equal(client.createCalls.length, 0);
  });

  it("rate limits downloads per principal before calling the worker", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    allowDns();
    const { client } = installWorker();
    const cookie = authedCookie();
    for (let i = 0; i < DOWNLOAD_LIMIT; i += 1) {
      const res = await handleDownload(
        apiRequest("/api/download", {
          method: "POST",
          body: { url: "https://cdn.example/video.mp4", formatId: "direct-original" },
          cookie,
          site: "same-origin",
          headers: PROXY_HEADERS_A,
        }),
      );
      assert.equal(res.status, 200);
    }
    const throttled = await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: { url: "https://cdn.example/video.mp4", formatId: "direct-original" },
        cookie,
        site: "same-origin",
        headers: PROXY_HEADERS_B,
      }),
    );
    assert.equal(throttled.status, 429);
    assert.equal(client.createCalls.length, DOWNLOAD_LIMIT);
    assert.equal(remainingRateLimit(`download:${PRIVATE_ACCESS_PRINCIPAL_ID}`, DOWNLOAD_LIMIT), 0);
    assert.equal(remainingRateLimit("download:1.1.1.1", DOWNLOAD_LIMIT), DOWNLOAD_LIMIT);
    assert.equal(remainingRateLimit("download:8.8.8.8", DOWNLOAD_LIMIT), DOWNLOAD_LIMIT);
  });

  it("surfaces a worker overload safely", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    allowDns();
    const { client } = installWorker();
    client.failWith = new AppError("SERVER_OVERLOAD");
    const res = await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: { url: "https://cdn.example/video.mp4", formatId: "direct-original" },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    assert.equal(res.status, 429);
    assert.equal((await readJson(res)).error?.code, "SERVER_OVERLOAD");
  });
});

// ── /api/download/:jobId/status ─────────────────────────────────────────────

describe("job status is served by the worker", () => {
  afterEach(resetAll);

  it("strips the object key from the status response", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    client.job = readyJob();
    const res = await handleDownloadStatus(
      apiRequest(`/api/download/${JOB_ID}/status`, { cookie: authedCookie(), site: "same-origin" }),
      JOB_ID,
    );
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.equal(raw.includes(OBJECT_KEY), false);
    assert.equal(raw.includes("objectKey"), false);
    assert.equal(raw.includes("videofetch/jobs"), false);
    assert.equal(raw.includes("aaaabbbbccccddddeeeeffff00001111"), false);
    assert.deepEqual(client.getJobCalls, [JOB_ID]);
  });

  it("maps safeErrorMessage onto the browser error field", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    client.job = workerJob({
      status: "failed",
      errorCode: "TIMEOUT",
      safeErrorMessage: ERROR_MESSAGES.TIMEOUT,
    });
    const res = await handleDownloadStatus(
      apiRequest(`/api/download/${JOB_ID}/status`, { cookie: authedCookie(), site: "same-origin" }),
      JOB_ID,
    );
    const body = await readJson(res);
    assert.equal(body.error, ERROR_MESSAGES.TIMEOUT);
    assert.equal(body.errorCode, "TIMEOUT");
    assert.equal("safeErrorMessage" in body, false);
  });

  it("gives a live ready job the local file route only", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    client.job = readyJob();
    const body = await readJson(
      await handleDownloadStatus(
        apiRequest(`/api/download/${JOB_ID}/status`, { cookie: authedCookie(), site: "same-origin" }),
        JOB_ID,
      ),
    );
    assert.equal(body.downloadUrl, `/api/download/${JOB_ID}/file`);
  });

  it("gives non-ready and uploading jobs a null download URL", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const statuses: WorkerJobStatus[] = [
      "queued",
      "analyzing",
      "downloading",
      "processing",
      "uploading",
      "failed",
      "cancelled",
    ];
    for (const status of statuses) {
      client.job = workerJob({ status });
      const body = await readJson(
        await handleDownloadStatus(
          apiRequest(`/api/download/${JOB_ID}/status`, { cookie: authedCookie(), site: "same-origin" }),
          JOB_ID,
        ),
      );
      assert.equal(body.status, status);
      assert.equal(body.downloadUrl, null, `${status} must not get a download URL`);
      assert.equal(typeof body.stageLabel, "string");
    }
  });

  it("reports cancelled as a terminal browser state", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    client.job = workerJob({ status: "cancelled" });
    const body = await readJson(
      await handleDownloadStatus(
        apiRequest(`/api/download/${JOB_ID}/status`, { cookie: authedCookie(), site: "same-origin" }),
        JOB_ID,
      ),
    );
    assert.equal(body.status, "cancelled");
    assert.equal(body.downloadUrl, null);
  });

  it("passes an expired worker response through as EXPIRED", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    client.failWith = new AppError("EXPIRED");
    const res = await handleDownloadStatus(
      apiRequest(`/api/download/${JOB_ID}/status`, { cookie: authedCookie(), site: "same-origin" }),
      JOB_ID,
    );
    assert.equal(res.status, 410);
    assert.equal((await readJson(res)).error?.code, "EXPIRED");
  });

  it("rejects a malformed job id without calling the worker", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleDownloadStatus(
      apiRequest("/api/download/../../etc/status", { cookie: authedCookie(), site: "same-origin" }),
      "../../etc",
    );
    assert.equal(res.status, 404);
    assert.equal(client.getJobCalls.length, 0);
  });
});

// ── /api/download/:jobId/file ───────────────────────────────────────────────

describe("file delivery redirects to a signed object URL", () => {
  afterEach(resetAll);

  it("signs the EXACT worker object key and expiry, then 303s", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client, signer } = installWorker();
    const job = readyJob();
    client.job = job;

    const res = await handleDownloadFile(
      apiRequest(`/api/download/${JOB_ID}/file`, { cookie: authedCookie(), site: "same-origin" }),
      JOB_ID,
    );

    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), SIGNED_URL);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(signer.calls, [{ objectKey: OBJECT_KEY, expiresAt: job.expiresAt }]);
  });

  it("never places the signed URL in the response body", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    client.job = readyJob();
    const res = await handleDownloadFile(
      apiRequest(`/api/download/${JOB_ID}/file`, { cookie: authedCookie(), site: "same-origin" }),
      JOB_ID,
    );
    const body = await res.text();
    assert.equal(body, "", "the redirect must carry no body");
    assert.equal(body.includes(SIGNED_URL), false);
    assert.equal(body.includes("X-Amz-Signature"), false);
  });

  it("never logs the signed URL or the object key", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    client.job = readyJob();

    const captured: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => captured.push(args.join(" "));
    console.warn = (...args: unknown[]) => captured.push(args.join(" "));
    console.error = (...args: unknown[]) => captured.push(args.join(" "));
    try {
      await handleDownloadFile(
        apiRequest(`/api/download/${JOB_ID}/file`, { cookie: authedCookie(), site: "same-origin" }),
        JOB_ID,
      );
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }

    const joined = captured.join("\n");
    assert.equal(joined.includes(SIGNED_URL), false);
    assert.equal(joined.includes("X-Amz-Signature"), false);
    assert.equal(joined.includes(OBJECT_KEY), false);
  });

  it("does not sign for a non-ready job", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client, signer } = installWorker();
    for (const status of [
      "queued",
      "analyzing",
      "downloading",
      "processing",
      "uploading",
      "failed",
      "cancelled",
    ] as WorkerJobStatus[]) {
      client.job = workerJob({ status });
      const res = await handleDownloadFile(
        apiRequest(`/api/download/${JOB_ID}/file`, { cookie: authedCookie(), site: "same-origin" }),
        JOB_ID,
      );
      assert.equal(res.status, 404, `${status} must not be downloadable`);
      assert.equal((await readJson(res)).error?.code, "NOT_FOUND");
    }
    assert.equal(signer.calls.length, 0, "the signer must never be reached");
  });

  it("does not sign for an expired ready job", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client, signer } = installWorker();
    client.job = readyJob({ expiresAt: Date.now() - 1 });
    const res = await handleDownloadFile(
      apiRequest(`/api/download/${JOB_ID}/file`, { cookie: authedCookie(), site: "same-origin" }),
      JOB_ID,
    );
    assert.equal(res.status, 410);
    assert.equal((await readJson(res)).error?.code, "EXPIRED");
    assert.equal(signer.calls.length, 0);
  });

  it("does not sign when the worker reports the job expired", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client, signer } = installWorker();
    client.failWith = new AppError("EXPIRED");
    const res = await handleDownloadFile(
      apiRequest(`/api/download/${JOB_ID}/file`, { cookie: authedCookie(), site: "same-origin" }),
      JOB_ID,
    );
    assert.equal(res.status, 410);
    assert.equal(signer.calls.length, 0);
  });

  it("returns a safe AppError when signing fails", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client, signer } = installWorker();
    client.job = readyJob();
    signer.failWith = new AppError("PROCESSING_FAILED", `presign blew up for ${OBJECT_KEY}`);

    const res = await handleDownloadFile(
      apiRequest(`/api/download/${JOB_ID}/file`, { cookie: authedCookie(), site: "same-origin" }),
      JOB_ID,
    );
    assert.equal(res.status, 500);
    const raw = await res.text();
    const parsed = JSON.parse(raw);
    assert.equal(parsed.error.code, "PROCESSING_FAILED");
    // The signer's own message is replaced by the canonical safe message.
    assert.equal(parsed.error.message, ERROR_MESSAGES.PROCESSING_FAILED);
    assert.equal(raw.includes(OBJECT_KEY), false);
    assert.equal(raw.includes("videofetch/jobs"), false);
    assert.equal(raw.includes("presign blew up"), false);
  });

  it("streams no local filesystem bytes", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    client.job = readyJob();
    const res = await handleDownloadFile(
      apiRequest(`/api/download/${JOB_ID}/file`, { cookie: authedCookie(), site: "same-origin" }),
      JOB_ID,
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("content-disposition"), null, "no Vercel-generated disposition");
    assert.equal(res.headers.get("content-length"), null);
    assert.equal(await res.text(), "");
  });
});

// ── /api/sites and /api/diagnostics ─────────────────────────────────────────

describe("sites and diagnostics are served from worker capability data", () => {
  afterEach(resetAll);

  it("builds the sites payload from worker diagnostics plus the static catalog", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleSites(apiRequest("/api/sites", { cookie: authedCookie(), site: "same-origin" }));
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(client.diagnosticsCalls, 1);
    assert.equal(body.ffmpeg, true);
    assert.equal(body.ytdlp, false);
    assert.ok(Array.isArray(body.sites));
    assert.equal("extractors" in body, false, "no local extractor registry may be exposed");
  });

  it("proxies authenticated worker diagnostics", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleDiagnostics(
      apiRequest("/api/diagnostics", { cookie: authedCookie(), site: "same-origin" }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(client.diagnosticsCalls, 1);
    const body = await readJson(res);
    assert.deepEqual(body, DIAGNOSTICS);
    assert.equal("jobs" in body, false);
    assert.equal("disk" in body, false, "no fabricated local disk usage");
    assert.equal("averageProcessingMs" in body, false, "no fabricated local timing");
  });

  it("fails closed in development when the access secret is missing", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "development", secret: undefined });
    const { client } = installWorker();
    const res = await handleDiagnostics(apiRequest("/api/diagnostics"));
    assert.equal(res.status, 503);
    assert.equal((await readJson(res)).error?.code, "ACCESS_NOT_CONFIGURED");
    assert.equal(client.diagnosticsCalls, 0);
  });

  it("rejects cross-site diagnostics even with a valid cookie", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleDiagnostics(
      apiRequest("/api/diagnostics", { cookie: authedCookie(), site: "cross-site" }),
    );
    assert.equal(res.status, 403);
    assert.equal(client.diagnosticsCalls, 0);
  });

  it("does not invoke diagnostics for a forged cookie", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const { client } = installWorker();
    const res = await handleDiagnostics(
      apiRequest("/api/diagnostics", {
        cookie: `${ACCESS_COOKIE_NAME}=v1.9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        site: "same-origin",
      }),
    );
    assert.equal(res.status, 401);
    assert.equal(client.diagnosticsCalls, 0);
  });
});

// ── Login isolation (unchanged by Phase 7) ──────────────────────────────────

describe("private access login isolation", () => {
  afterEach(resetAll);

  it("rejects cross-site login posts", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const res = await handleAccessLogin(
      apiRequest("/api/access/login", { method: "POST", body: { secret: SECRET }, site: "cross-site" }),
    );
    assert.equal(res.status, 403);
  });

  it("throttles login with a process-local key independent of forwarded IP headers", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    for (let i = 0; i < ACCESS_LOGIN_RATE_LIMIT; i += 1) {
      const res = await handleAccessLogin(
        apiRequest("/api/access/login", {
          method: "POST",
          body: { secret: "wrong" },
          site: "same-origin",
          headers: PROXY_HEADERS_A,
        }),
      );
      assert.equal(res.status, 401);
    }
    const spoofed = await handleAccessLogin(
      apiRequest("/api/access/login", {
        method: "POST",
        body: { secret: SECRET },
        site: "same-origin",
        headers: PROXY_HEADERS_B,
      }),
    );
    assert.equal(spoofed.status, 429);
    assert.equal((await readJson(spoofed)).error?.code, "RATE_LIMITED");
    assert.equal(remainingRateLimit(ACCESS_LOGIN_RATE_KEY, ACCESS_LOGIN_RATE_LIMIT), 0);
    assert.equal(remainingRateLimit("1.1.1.1", ACCESS_LOGIN_RATE_LIMIT), ACCESS_LOGIN_RATE_LIMIT);
    assert.equal(remainingRateLimit("8.8.8.8", ACCESS_LOGIN_RATE_LIMIT), ACCESS_LOGIN_RATE_LIMIT);
  });
});
