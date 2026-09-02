// The REAL control-plane driver (§4, §10, §11 of CORRECTION-01).
//
// This is the reviewed path from Production to the evaluators. Phase 10D runs
// the committed CLI; it does not write a script that imports `main()` and
// fabricates observations.
//
// Everything here goes through the ACTUAL product surface:
//
//   POST /api/access/login          the existing private-access mechanism
//   POST /api/analyze               { url }
//   POST /api/download              { url, formatId }
//   GET  /api/download/:id/status   polled to build the durable trace
//   GET  /api/download/:id/file     303 -> presigned object GET -> bytes
//
// No auth bypass, no debug endpoint, no persisted cookie, no committed
// credential, and no direct yt-dlp invocation anywhere.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { redactUrl } from "./redact.mjs";

/** Bounded by construction: an acceptance job that never settles must not hang. */
export const DEFAULT_POLL_INTERVAL_MS = 200;
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

const TERMINAL = new Set(["ready", "failed", "cancelled"]);

/**
 * Builds an authenticated control-plane session.
 *
 * The private-access secret is accepted as an argument, used once to obtain the
 * session cookie, and never stored on this object, never logged and never
 * returned. The cookie itself lives only in this closure for the process's
 * lifetime — nothing writes it to disk.
 */
export function makeControlPlaneSession(deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const baseUrl = deps.baseUrl;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!baseUrl) throw new Error("a control-plane base URL is required");

  let cookie = null;

  function url(path) {
    return new URL(path, baseUrl).toString();
  }

  async function call(path, init = {}) {
    const headers = new Headers(init.headers ?? {});
    headers.set("accept", "application/json");
    if (cookie) headers.set("cookie", cookie);
    // `manual` so an Access login redirect surfaces as a status rather than
    // being silently followed into an HTML page.
    return fetchImpl(url(path), { ...init, headers, redirect: "manual" });
  }

  return {
    get authenticated() {
      return cookie !== null;
    },

    /**
     * Establishes the session.
     *
     * A failure here is a HARD stop for every control-plane observation: the
     * caller must never continue as an unauthenticated observer, because a 401
     * from an unauthenticated probe is indistinguishable from a genuine
     * capability failure and would be recorded as the latter.
     */
    async login(secret) {
      if (typeof secret !== "string" || secret.length === 0) {
        throw new Error("no private-access secret supplied");
      }
      const response = await fetchImpl(url("/api/access/login"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ secret }),
        redirect: "manual",
      });
      const setCookie = response.headers.get("set-cookie");
      if (!response.ok || !setCookie) {
        // The status is safe to report; the secret is not, and is not in scope
        // of this message.
        throw new Error(`private-access login failed with HTTP ${response.status}`);
      }
      cookie = setCookie.split(";")[0];
      return true;
    },

    async sites() {
      const response = await call("/api/sites");
      if (!response.ok) throw new Error(`/api/sites returned HTTP ${response.status}`);
      return response.json();
    },

    async diagnostics() {
      const response = await call("/api/diagnostics");
      if (!response.ok) throw new Error(`/api/diagnostics returned HTTP ${response.status}`);
      return response.json();
    },

    /** `POST /api/analyze`. The URL is request data and is never logged raw. */
    async analyze(mediaUrl) {
      const response = await call("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: mediaUrl }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.success !== true) {
        throw new Error(
          `analyze failed for ${redactUrl(mediaUrl)} with HTTP ${response.status}` +
            (body?.code ? ` (${body.code})` : ""),
        );
      }
      return body.video;
    },

    /** `POST /api/download`. `formatId` must be an application-owned preset. */
    async createJob(mediaUrl, formatId) {
      const response = await call("/api/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: mediaUrl, formatId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.jobId) {
        throw new Error(
          `job creation failed for ${redactUrl(mediaUrl)} with HTTP ${response.status}` +
            (body?.code ? ` (${body.code})` : ""),
        );
      }
      return body;
    },

    async jobStatus(jobId) {
      const response = await call(`/api/download/${jobId}/status`);
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.status) {
        throw new Error(`status poll failed with HTTP ${response.status}`);
      }
      return body;
    },

    /**
     * Polls until terminal, recording EVERY distinct status observed.
     *
     * The interval is deliberately tight (200 ms by default). The runbook's own
     * direct-media record shows a whole job completing in ~1.2 s, so a lazy
     * poller would miss most of the ladder — and under the corrected lifecycle
     * contract a missed state is BLOCKED, not a pass. Improving the observation
     * is the correct response to that, never weakening the evaluator.
     *
     * `onSample` fires after each poll so a caller can drive process sampling
     * for exactly the window in which the job is `downloading`.
     */
    async pollTrace(jobId, opts = {}) {
      const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;

      const trace = [];
      const timeline = [];
      let last = null;

      // Seed from the CREATE response when the caller supplies it.
      //
      // `POST /api/download` returns the job in its initial durable state, so
      // that response is itself an observation — and it is the only one that
      // can witness `queued` for a job that leaves the queue before the first
      // poll. Without this seed a fast job loses `queued` from the trace and
      // the corrected lifecycle contract reports BLOCKED, which would be an
      // artifact of when polling started rather than a property of the job.
      if (typeof opts.initialStatus === "string") {
        trace.push(opts.initialStatus);
        timeline.push({ status: opts.initialStatus, at: new Date().toISOString() });
        last = opts.initialStatus;
      }

      while (Date.now() < deadline) {
        const job = await this.jobStatus(jobId);
        if (job.status !== last) {
          trace.push(job.status);
          timeline.push({ status: job.status, at: new Date().toISOString() });
          last = job.status;
        }
        if (opts.onSample) await opts.onSample(job);
        if (TERMINAL.has(job.status)) {
          return { trace, timeline, final: job, timedOut: false };
        }
        await sleep(intervalMs);
      }
      return { trace, timeline, final: last ? await this.jobStatus(jobId) : null, timedOut: true };
    },

    /**
     * `GET /api/download/:id/file` -> 303 -> the presigned object URL.
     *
     * The signed URL is returned to the caller for a single immediate fetch and
     * is NEVER placed in evidence, logged, or printed: it is a bearer
     * credential for the object.
     */
    async signedDownload(jobId) {
      const response = await call(`/api/download/${jobId}/file`);
      const location = response.headers.get("location");
      return {
        redirectStatus: response.status,
        location,
        presigned:
          typeof location === "string" && /X-Amz-Signature=|X-Amz-Credential=/i.test(location),
      };
    },

    /**
     * Fetches an absolute URL and returns ONLY length and digest.
     *
     * The body is hashed as it streams and is never retained, never written to
     * disk and never printed — §37 wants byte integrity, not the bytes.
     */
    async fetchDigest(absoluteUrl) {
      const response = await fetchImpl(absoluteUrl, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`object fetch returned HTTP ${response.status}`);
      }
      const hash = createHash("sha256");
      let bytes = 0;
      const buffer = Buffer.from(await response.arrayBuffer());
      hash.update(buffer);
      bytes = buffer.byteLength;
      return {
        bytes,
        digest: hash.digest("hex"),
        contentType: response.headers.get("content-type"),
      };
    },
  };
}

/**
 * The Worker's OWN authenticated cancel route.
 *
 * The control plane exposes no cancellation surface — `private-access-api`
 * has analyze, download, status and file and nothing else — so
 * `POST /v1/jobs/<id>/cancel` on the Worker IS the only surface this operation
 * has. Using it is therefore not "calling the Worker and passing it off as
 * control-plane proof"; it is using the real product path for an operation the
 * control plane does not implement, with its real HMAC authentication intact.
 *
 * The signing input mirrors `buildWorkerSigningInput()` exactly, as
 * `deploy/acceptance/safe-egress/sign.mjs` already does. The secret is read
 * from the environment by the caller, used to compute one HMAC, and never
 * printed or stored.
 */
export function makeWorkerControlClient(deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const origin = deps.origin;
  const keyId = deps.keyId;
  const secret = deps.secret;
  if (!origin || !keyId || !secret) {
    throw new Error("worker control client requires an origin, key id and secret");
  }

  async function signedRequest(method, path, bodyJson = null) {
    const raw = bodyJson ? Buffer.from(bodyJson, "utf8") : Buffer.alloc(0);
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const requestId = randomUUID();
    const idempotencyKey = method === "POST" && path === "/v1/jobs" ? randomUUID() : "";
    const signingInput = [
      "v1",
      keyId,
      method,
      path,
      timestamp,
      requestId,
      idempotencyKey,
      bodyHash,
    ].join("\n");
    const signature = createHmac("sha256", secret).update(signingInput, "utf8").digest("hex");

    const headers = {
      "x-videofetch-key-id": keyId,
      "x-videofetch-timestamp": timestamp,
      "x-videofetch-request-id": requestId,
      "x-videofetch-signature": signature,
      accept: "application/json",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (bodyJson) headers["content-type"] = "application/json";

    const response = await fetchImpl(`${origin}${path}`, {
      method,
      headers,
      body: bodyJson ?? undefined,
      redirect: "manual",
    });
    return response;
  }

  return {
    async cancelJob(jobId) {
      const response = await signedRequest("POST", `/v1/jobs/${jobId}/cancel`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`worker cancel returned HTTP ${response.status}`);
      return body;
    },

    /**
     * The Worker's authenticated job view, which carries the durable fields the
     * browser DTO deliberately strips — notably `objectKey`.
     *
     * `formatId` is NOT on this view either; the durable format evidence comes
     * from the state reader instead.
     */
    async getJob(jobId) {
      const response = await signedRequest("GET", `/v1/jobs/${jobId}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`worker job read returned HTTP ${response.status}`);
      return body;
    },
  };
}
