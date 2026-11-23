import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClientApiError } from "../client-api.ts";
import { classifyStatusPollFailure } from "../job-status-poller.ts";
import { ACCESS_COOKIE_NAME, mintSessionToken, setPrivateAccessTestEnv } from "./private-access.server.ts";
import { handleDownloadStatus, resetPrivateAccessApiForTests } from "./private-access-api.server.ts";
import { resetRateLimitForTests } from "./rate-limit.server.ts";
import { resetWorkerRuntimeForTests, setWorkerClientForTests } from "../../web/config/worker-runtime.server.ts";
import { PublicJobSchema } from "../../web/jobs/public-job.ts";
import { WorkerClient } from "../../web/worker/worker-client.server.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the browser
 * status route against every shape a Worker can send — the LD-3 Worker's (no
 * field), an LD-4b Worker's (null or an activity), and malformed ones — through
 * the REAL HMAC `WorkerClient` and its strict parse. Only the Worker's HTTP
 * answer is synthetic.
 *
 * Every answer is `no-store`. A malformed activity is refused as a whole and
 * reaches the browser as a 500, which its poller retries: it is never shown as
 * the job's outcome.
 */

const ACCESS_SECRET = "ld4b-status-route-access-secret-0123456";
const JOB_ID = "0123456789abcdef0123456789abcdef";
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/aaaabbbbccccddddeeeeffff00001111`;
const RECEIVING = { state: "receiving", elapsedSeconds: 42, limitSeconds: 600, idleSeconds: 1 };

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: JOB_ID,
    status: "downloading",
    progress: 40,
    stageLabel: "Downloading",
    downloadedBytes: 70_000,
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
    title: "Clip",
    thumbnail: null,
    source: "cdn.example",
    extractor: "direct",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 500,
    expiresAt: Date.now() + 5_000_000,
    objectKey: null,
    ...overrides,
  };
}

let workerAnswer: () => Response = () => new Response(null, { status: 500 });

function answerWith(answer: () => Response) {
  workerAnswer = answer;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  setPrivateAccessTestEnv({ nodeEnv: "production", secret: ACCESS_SECRET });
  setWorkerClientForTests(
    new WorkerClient({
      baseUrl: "https://worker.example.invalid",
      currentKeyId: "worker-control-test",
      currentSecret: "0123456789abcdef0123456789abcdef",
      fetchImplementation: async () => workerAnswer(),
    }),
  );
});

afterEach(() => {
  resetPrivateAccessApiForTests();
  resetWorkerRuntimeForTests();
  setPrivateAccessTestEnv(null);
  resetRateLimitForTests();
});

function request(withAccess = true): Request {
  return new Request(`https://videofetch.example/api/download/${JOB_ID}/status`, {
    headers: {
      ...(withAccess ? { cookie: `${ACCESS_COOKIE_NAME}=${mintSessionToken(ACCESS_SECRET)}` } : {}),
      "sec-fetch-site": "same-origin",
    },
  });
}

async function status(withAccess = true) {
  const res = await handleDownloadStatus(request(withAccess), JOB_ID);
  assert.equal(res.headers.get("cache-control"), "no-store", `status ${res.status} must not be cacheable`);
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as Record<string, unknown> };
}

/** What the browser's poller makes of a failed answer, by structure only. */
function pollerClass(res: Response, body: Record<string, unknown>) {
  const error = body.error as { code?: unknown } | undefined;
  return classifyStatusPollFailure(
    new ClientApiError({
      kind: "response",
      code: (error?.code as never) ?? null,
      status: res.status,
      message: "x",
    }),
  );
}

describe("the status route and the activity field", () => {
  it("an LD-3 Worker's status (no field) is accepted: activity null, everything else as before", async () => {
    answerWith(() => json({ success: true, job: view() }));
    const { res, body } = await status();
    assert.equal(res.status, 200);
    const job = PublicJobSchema.parse(body);
    assert.equal(job.activity, null);
    assert.equal(job.progress, 40);
  });

  it("an LD-4b Worker's activity reaches the browser as published", async () => {
    answerWith(() => json({ success: true, job: view({ activity: RECEIVING }) }));
    const { res, body, text } = await status();
    assert.equal(res.status, 200);
    assert.deepEqual(PublicJobSchema.parse(body).activity, RECEIVING);
    assert.equal(text.includes("objectKey"), false);
  });

  it("an LD-4b Worker's `null` is null", async () => {
    answerWith(() => json({ success: true, job: view({ activity: null }) }));
    assert.equal(PublicJobSchema.parse((await status()).body).activity, null);
  });

  it("a ready job keeps its file route and never leaks its object key, with or without the field", async () => {
    for (const extra of [{}, { activity: null }]) {
      answerWith(() => json({ success: true, job: view({ status: "ready", objectKey: OBJECT_KEY, ...extra }) }));
      const { body, text } = await status();
      const job = PublicJobSchema.parse(body);
      assert.equal(job.downloadUrl, `/api/download/${JOB_ID}/file`);
      assert.equal(job.activity, null);
      assert.equal(text.includes("videofetch/jobs"), false);
    }
  });

  it("a malformed activity is refused whole: a 500 the poller retries, never a job outcome", async () => {
    for (const activity of [
      { ...RECEIVING, state: "stalled" },
      { ...RECEIVING, url: "https://cdn.example/SECRET-PATH/video.mp4" },
      { ...RECEIVING, idleSeconds: -1 },
      { ...RECEIVING, limitSeconds: 10_000_000 },
      { ...RECEIVING, idleSeconds: 30 },
      "receiving",
    ]) {
      answerWith(() => json({ success: true, job: view({ activity }) }));
      const { res, body, text } = await status();
      assert.equal(res.status, 500, JSON.stringify(activity));
      assert.equal((body.error as { code: string }).code, "PROCESSING_FAILED");
      assert.equal(pollerClass(res, body), "transient", "the browser keeps the job and keeps asking");
      assert.equal(text.includes("SECRET-PATH"), false, "nothing of the refused body is echoed");
    }
  });

  it("a live activity on a job that is not downloading is refused the same way", async () => {
    answerWith(() => json({ success: true, job: view({ status: "processing", activity: RECEIVING }) }));
    const { res, body } = await status();
    assert.equal(res.status, 500);
    assert.equal(pollerClass(res, body), "transient");
  });

  it("a Worker outage stays an outage: WORKER_UNAVAILABLE, no-store, retried", async () => {
    answerWith(() => new Response("<html>bad gateway</html>", { status: 503, headers: { "content-type": "text/html" } }));
    const { res, body } = await status();
    assert.equal(res.status, 503);
    assert.equal((body.error as { code: string }).code, "WORKER_UNAVAILABLE");
    assert.equal(pollerClass(res, body), "transient");
  });

  it("without private access nothing reaches the Worker, and the refusal is no-store", async () => {
    let called = 0;
    answerWith(() => {
      called += 1;
      return json({ success: true, job: view({ activity: RECEIVING }) });
    });
    const { res, body } = await status(false);
    assert.equal(res.status, 401);
    assert.equal((body.error as { code: string }).code, "ACCESS_REQUIRED");
    assert.equal(called, 0);
  });
});
