import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetRateLimitForTests } from "./rate-limit.server.ts";
import { setSafeHttpTestHooks } from "./safe-http.server.ts";
import {
  ACCESS_COOKIE_NAME,
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
  setAnalyzeOperationForTests,
  setDiagnosticsOperationForTests,
  setEnqueueOperationForTests,
  setJobOrThrowOperationForTests,
  setPublicJobOperationForTests,
  setSitesOperationForTests,
} from "./private-access-api.server.ts";
import { createJob, resetJobsForTests, updateJob } from "../../services/jobs/store.server.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

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
  return (await res.json()) as {
    success?: boolean;
    authenticated?: boolean;
    configured?: boolean;
    developmentBypass?: boolean;
    error?: { code?: string; message?: string };
  };
}

describe("private access API handlers", () => {
  afterEach(() => {
    resetPrivateAccessApiForTests();
    setPrivateAccessTestEnv(null);
    setPrivateAccessNowForTests(null);
    resetRateLimitForTests();
    resetJobsForTests();
    setSafeHttpTestHooks(null);
  });

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
    const body = await readJson(session);
    assert.equal(body.authenticated, false);
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

  it("does not invoke analyze when unauthorized", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    let invoked = 0;
    setAnalyzeOperationForTests(async () => {
      invoked += 1;
      throw new Error("analyze must not run");
    });
    const res = await handleAnalyze(
      apiRequest("/api/analyze", { method: "POST", body: { url: "https://example.com/v.mp4" } }),
    );
    assert.equal(res.status, 401);
    assert.equal((await readJson(res)).error?.code, "ACCESS_REQUIRED");
    assert.equal(invoked, 0);
  });

  it("does not invoke download enqueue when unauthorized", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    let invoked = 0;
    setEnqueueOperationForTests(async () => {
      invoked += 1;
      throw new Error("enqueue must not run");
    });
    const res = await handleDownload(
      apiRequest("/api/download", {
        method: "POST",
        body: { url: "https://example.com/v.mp4", formatId: "direct-original" },
      }),
    );
    assert.equal(res.status, 401);
    assert.equal((await readJson(res)).error?.code, "ACCESS_REQUIRED");
    assert.equal(invoked, 0);
  });

  it("does not look up job status when unauthorized", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const job = createJob({
      url: "https://example.com/v.mp4",
      formatId: "direct-original",
      ip: "203.0.113.10",
      workDir: "/tmp/videofetch-access-status",
    });
    let invoked = 0;
    setPublicJobOperationForTests((id) => {
      invoked += 1;
      assert.equal(id, job.id);
      return { jobId: job.id, title: "secret-title" } as never;
    });
    const res = await handleDownloadStatus(apiRequest(`/api/download/${job.id}/status`), job.id);
    assert.equal(res.status, 401);
    const body = await readJson(res);
    assert.equal(body.error?.code, "ACCESS_REQUIRED");
    assert.equal(JSON.stringify(body).includes("secret-title"), false);
    assert.equal(JSON.stringify(body).includes(job.id), false);
    assert.equal(invoked, 0);
  });

  it("does not open the output file when unauthorized", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const dir = await mkdtemp(join(tmpdir(), "videofetch-access-file-"));
    const outputPath = join(dir, "clip.mp4");
    await writeFile(outputPath, "SECRET_BYTES");
    const job = createJob({
      url: "https://example.com/v.mp4",
      formatId: "direct-original",
      ip: "203.0.113.10",
      workDir: dir,
    });
    updateJob(job.id, {
      status: "ready",
      outputPath,
      filename: "clip.mp4",
      outputMime: "video/mp4",
    });
    let invoked = 0;
    setJobOrThrowOperationForTests((id) => {
      invoked += 1;
      throw new Error(`file lookup must not run for ${id}`);
    });
    const res = await handleDownloadFile(apiRequest(`/api/download/${job.id}/file`), job.id);
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.equal(text.includes("SECRET_BYTES"), false);
    assert.equal(text.includes("clip.mp4"), false);
    assert.equal(JSON.parse(text).error.code, "ACCESS_REQUIRED");
    assert.equal(invoked, 0);
  });

  it("does not load sites or diagnostics when unauthorized", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    let sites = 0;
    let diagnostics = 0;
    setSitesOperationForTests(async () => {
      sites += 1;
      return { leaked: true };
    });
    setDiagnosticsOperationForTests(async () => {
      diagnostics += 1;
      return { leaked: true } as never;
    });
    const sitesRes = await handleSites(apiRequest("/api/sites"));
    const diagRes = await handleDiagnostics(apiRequest("/api/diagnostics"));
    assert.equal(sitesRes.status, 401);
    assert.equal(diagRes.status, 401);
    assert.equal(sites, 0);
    assert.equal(diagnostics, 0);
  });

  it("allows analyze after a valid session cookie", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    let invoked = 0;
    setAnalyzeOperationForTests(async () => {
      invoked += 1;
      return { title: "ok" } as never;
    });
    const res = await handleAnalyze(
      apiRequest("/api/analyze", {
        method: "POST",
        body: { url: "https://cdn.example/video.mp4" },
        cookie: authedCookie(),
        site: "same-origin",
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(invoked, 1);
  });

  it("rejects a forged cookie", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    let invoked = 0;
    setAnalyzeOperationForTests(async () => {
      invoked += 1;
      return { title: "ok" } as never;
    });
    const res = await handleAnalyze(
      apiRequest("/api/analyze", {
        method: "POST",
        body: { url: "sample://demo" },
        cookie: `${ACCESS_COOKIE_NAME}=v1.9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        site: "same-origin",
      }),
    );
    assert.equal(res.status, 401);
    assert.equal(invoked, 0);
  });

  it("rejects cross-site analyze even with a valid cookie", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    let invoked = 0;
    setAnalyzeOperationForTests(async () => {
      invoked += 1;
      return { title: "ok" } as never;
    });
    const res = await handleAnalyze(
      apiRequest("/api/analyze", {
        method: "POST",
        body: { url: "sample://demo" },
        cookie: authedCookie(),
        site: "cross-site",
      }),
    );
    assert.equal(res.status, 403);
    assert.equal((await readJson(res)).error?.code, "FORBIDDEN");
    assert.equal(invoked, 0);
  });

  it("fails closed in production when the secret is missing rather than becoming public", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: undefined });
    let invoked = 0;
    setAnalyzeOperationForTests(async () => {
      invoked += 1;
      return { title: "ok" } as never;
    });
    const res = await handleAnalyze(
      apiRequest("/api/analyze", { method: "POST", body: { url: "sample://demo" } }),
    );
    assert.equal(res.status, 503);
    assert.equal((await readJson(res)).error?.code, "ACCESS_NOT_CONFIGURED");
    assert.equal(invoked, 0);
  });
});

describe("private access login isolation", () => {
  afterEach(() => {
    resetPrivateAccessApiForTests();
    setPrivateAccessTestEnv(null);
    resetRateLimitForTests();
  });

  it("rejects cross-site login posts", async () => {
    setPrivateAccessTestEnv({ nodeEnv: "production", secret: SECRET });
    const res = await handleAccessLogin(
      apiRequest("/api/access/login", { method: "POST", body: { secret: SECRET }, site: "cross-site" }),
    );
    assert.equal(res.status, 403);
  });
});
