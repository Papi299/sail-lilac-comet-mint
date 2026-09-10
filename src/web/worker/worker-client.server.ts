import { z } from "zod";
import crypto from "node:crypto";
import { AppError, ERROR_MESSAGES, type ErrorCode } from "../../lib/errors.ts";
import {
  WorkerKeyIdSchema,
  sha256WorkerBody,
  WorkerRequestIdSchema,
  WorkerIdempotencyKeySchema,
} from "../../shared/worker/auth.ts";
import { createWorkerSignatureHex } from "../../shared/worker/hmac.server.ts";
import {
  WorkerAnalyzeSuccessSchema,
  WorkerCreateJobSuccessSchema,
  WorkerJobStatusSuccessSchema,
  WorkerCancelJobSuccessSchema,
  WorkerDiagnosticsSuccessSchema,
  WorkerHealthSuccessSchema,
  WorkerAnalyzeRequestSchema,
  WorkerCreateJobRequestSchema,
  workerJobPath,
  workerJobCancelPath,
  type WorkerDiagnosticsSuccess,
  type WorkerHealthSuccess,
  type WorkerAnalyzeSuccess,
  type WorkerCreateJobSuccess,
  type WorkerJobStatusSuccess,
  type WorkerCancelJobSuccess,
} from "../../shared/worker/contracts.ts";
import { WorkerErrorCodeSchema, WorkerErrorResponseSchema } from "../../shared/worker/errors.ts";
import {
  WORKER_ANALYZE_PATH,
  WORKER_JOBS_PATH,
  WORKER_DIAGNOSTICS_PATH,
  WORKER_HEALTH_PATH,
} from "../../shared/worker/constants.ts";

/**
 * Hard ceiling on any Worker response body this client will read into memory.
 * Single-sourced so every read path — success, error envelope, health probe and
 * the 503 disambiguation probe — is bounded identically.
 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Rejects any byte that cannot legally appear in an HTTP header value, without
 * a control-character regex. A credential carrying CR/LF would otherwise be a
 * header-injection primitive.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * One half of an upstream access-layer service token. Bounded, single-line, and
 * never rendered back out on any error path.
 */
const AccessCredentialSchema = z
  .string()
  .min(1, "must not be empty")
  .max(4096, "must be at most 4096 characters")
  .refine((value) => !hasControlCharacter(value), "must not contain control characters");

export const WorkerClientConfigSchema = z.object({
  baseUrl: z.string().superRefine((val, ctx) => {
    let url: URL;
    try {
      url = new URL(val);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid URL" });
      return;
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Username/password not allowed" });
    }
    if (url.search) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Query string not allowed" });
    }
    if (url.hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Fragment not allowed" });
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pathname must be empty or /" });
    }
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be HTTPS for non-loopback" });
    }
  }),
  currentKeyId: WorkerKeyIdSchema,
  currentSecret: z.string().refine((val) => {
    const len = Buffer.from(val, "utf8").length;
    return len >= 32 && len <= 8192;
  }, {
    message: "Secret must be 32 to 8192 UTF-8 bytes",
  }),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  requestIdFactory: z.custom<() => string>((val) => typeof val === "function").optional(),
  idempotencyKeyFactory: z.custom<() => string>((val) => typeof val === "function").optional(),
  fetchImplementation: z.custom<typeof fetch>((val) => typeof val === "function").optional(),
  clock: z.custom<() => number>((val) => typeof val === "function").optional(),
  /**
   * Optional service-token credentials for the access layer that fronts the
   * Worker endpoint. They authenticate Vercel to that upstream proxy and are
   * NOT part of the VideoFetch protocol: see `applyAccessHeaders`.
   */
  cloudflareAccessClientId: AccessCredentialSchema.optional(),
  cloudflareAccessClientSecret: AccessCredentialSchema.optional(),
}).strict().superRefine((cfg, ctx) => {
  // Both or neither. A half-configured service token would silently produce
  // requests the upstream proxy rejects, which is worse than failing closed at
  // construction time. The offending VALUE is never echoed — only a field name.
  const hasId = cfg.cloudflareAccessClientId !== undefined;
  const hasSecret = cfg.cloudflareAccessClientSecret !== undefined;
  if (hasId !== hasSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Access client id and client secret must be supplied together, or not at all",
      path: [hasId ? "cloudflareAccessClientSecret" : "cloudflareAccessClientId"],
    });
  }
});

export type WorkerClientConfig = z.input<typeof WorkerClientConfigSchema>;

export class WorkerClient {
  private config: z.output<typeof WorkerClientConfigSchema>;
  private fetchImpl: typeof fetch;

  constructor(config: WorkerClientConfig) {
    this.config = WorkerClientConfigSchema.parse(config);
    this.fetchImpl = this.config.fetchImplementation ?? fetch;
  }

  private get origin(): string {
    const url = new URL(this.config.baseUrl);
    return url.origin;
  }

  private getNowMs(): number {
    const now = this.config.clock ? this.config.clock() : Date.now();
    if (!Number.isFinite(now) || !Number.isSafeInteger(now) || now < 0) {
      throw new Error("Invalid clock value");
    }
    return now;
  }

  private generateRequestId(): string {
    const id = this.config.requestIdFactory ? this.config.requestIdFactory() : crypto.randomUUID();
    return WorkerRequestIdSchema.parse(id);
  }

  private generateIdempotencyKey(): string {
    const key = this.config.idempotencyKeyFactory ? this.config.idempotencyKeyFactory() : crypto.randomUUID();
    return WorkerIdempotencyKeySchema.parse(key);
  }

  private validateContentType(header: string | null): void {
    if (!header) throw new AppError("PROCESSING_FAILED");
    const parts = header.split(";").map(s => s.trim().toLowerCase());
    if (parts[0] !== "application/json") {
      throw new AppError("PROCESSING_FAILED");
    }
  }

  private validateContentLength(header: string | null): void {
    if (!header) return;
    if (!/^(0|[1-9][0-9]*)$/.test(header)) {
      throw new AppError("PROCESSING_FAILED");
    }
    const len = Number(header);
    if (!Number.isSafeInteger(len)) {
      throw new AppError("PROCESSING_FAILED");
    }
    // The same ceiling the streamed read enforces, so a declared length can
    // never be admitted at a size the body reader would later reject.
    if (len > MAX_RESPONSE_BYTES) {
      throw new AppError("PROCESSING_FAILED");
    }
  }

  /**
   * Attaches the upstream access-layer service token, when configured.
   *
   * These headers belong to the proxy in front of the Worker, not to the
   * VideoFetch protocol. They are applied AFTER the signature is computed and
   * are deliberately absent from the HMAC canonical request built by
   * `buildWorkerSigningInput`, so an identical logical request produces a
   * byte-identical signature whether or not the access layer is in the path.
   *
   * What this code establishes: the credentials are configured and stored on
   * the control plane only, and the Worker application never consumes,
   * verifies, persists or intentionally logs them.
   *
   * What it does NOT establish: whether the access layer strips these headers
   * before forwarding to the origin. That is provider/deployment behaviour and
   * must be measured against the real ingress. Tracked as
   * CLOUDFLARE-ACCESS-ORIGIN-CREDENTIAL-STRIPPING-001 (BLOCKING before
   * production Cloudflare ingress acceptance). Until that evidence exists, do
   * not assume the Worker never receives them on the wire.
   */
  private applyAccessHeaders(headers: Headers): void {
    const clientId = this.config.cloudflareAccessClientId;
    const clientSecret = this.config.cloudflareAccessClientSecret;
    // The schema guarantees both-or-neither; this reads both anyway so a future
    // schema regression cannot emit a lone header.
    if (clientId === undefined || clientSecret === undefined) return;
    headers.set("CF-Access-Client-Id", clientId);
    headers.set("CF-Access-Client-Secret", clientSecret);
  }

  /**
   * Statuses that can never carry a Worker business-error envelope, and so
   * always mean the control-plane→Worker path is unavailable to the user.
   *
   * This is deliberately NOT a claim about where the response came from. 401
   * in particular CAN be Worker-origin: the Worker's own HTTP server answers
   * 401 (`sendUnauthorized`) for HMAC, timestamp and replay rejections, and an
   * upstream access layer can answer 401 as well. Either way it is an
   * authentication failure on the path to the Worker rather than a business
   * outcome — the Worker's 401 body is `{"error":"unauthorized"}`, which is not
   * a WorkerErrorResponse envelope — so it stays WORKER_UNAVAILABLE and its
   * body is never trusted or surfaced. Reporting which side rejected the
   * credential would also disclose auth detail to the browser.
   *
   * 403 is not emitted anywhere in the current Worker implementation — it is
   * absent from WORKER_ERROR_HTTP_STATUS and from every Worker code path — so
   * it is an upstream refusal. A refused Access service token is the expected
   * cause, but other upstream controls (WAF, rate limiting, a bot rule) could
   * produce one too; the classification does not depend on knowing which.
   *
   * Both are decided BEFORE any content-type or JSON validation, because
   * neither body is a Worker error envelope.
   *
   * 503 is deliberately NOT in this set, and that is the distinction an earlier
   * revision got wrong: 503 is an INTENTIONAL Worker business-error status
   * (WORKER_ERROR_HTTP_STATUS maps EXTRACTOR_UNAVAILABLE to it), so it is
   * ambiguous rather than necessarily upstream, and is resolved by
   * `isCanonicalExtractorUnavailable`.
   */
  private isUnavailablePathStatus(status: number): boolean {
    return status === 401 || status === 403;
  }

  /**
   * Decides whether an HTTP 503 is the Worker's own EXTRACTOR_UNAVAILABLE
   * business error rather than an upstream/proxy/tunnel outage.
   *
   * 503 is the single status the Worker protocol shares with the
   * infrastructure in front of it: the Worker answers 503 for
   * EXTRACTOR_UNAVAILABLE, while a proxy, tunnel or load balancer answers 503
   * for a genuine outage. They are told apart by demanding the FULL Worker
   * response contract rather than the status alone — acceptable
   * application/json content type, acceptable Content-Length semantics, a
   * bounded body read, valid JSON, a strict WorkerErrorResponse envelope,
   * exactly the EXTRACTOR_UNAVAILABLE code, and exactly the canonical safe
   * message for it. The message is part of the shape because
   * `toWorkerErrorEnvelope` always rewrites a Worker error message to
   * `ERROR_MESSAGES[code]`, so a divergent message is not the contract the
   * Worker's error path emits.
   *
   * This is a SHAPE test, not authenticated provenance. It establishes that a
   * response is consistent with the Worker's canonical EXTRACTOR_UNAVAILABLE
   * envelope — enough for this classification — and deliberately does not
   * claim to prove Worker origin. Proving origin would require response
   * authentication, which this client does not have and does not add.
   *
   * Every branch fails closed. Anything short of that exact envelope — an
   * absent or HTML body, a wrong or missing content type, malformed, oversized
   * or unreadable bytes, a body that never finishes before the request
   * deadline, another Worker code, a doctored message — returns false, and the
   * caller keeps the safer WORKER_UNAVAILABLE classification. The body is
   * consumed here purely to classify it and is never surfaced in the resulting
   * error.
   *
   * `deadlineSignal` is the in-flight request's own timeout, so reading this
   * body cannot outlive the request budget the caller already started.
   */
  private async isCanonicalExtractorUnavailable(
    response: Response,
    deadlineSignal: AbortSignal,
  ): Promise<boolean> {
    try {
      this.validateContentType(response.headers.get("content-type"));
      this.validateContentLength(response.headers.get("content-length"));
      const responseBuffer = await this.readBoundedStream(response, MAX_RESPONSE_BYTES, deadlineSignal);
      const parsed = WorkerErrorResponseSchema.safeParse(JSON.parse(responseBuffer.toString("utf8")));
      return (
        parsed.success &&
        parsed.data.error.code === "EXTRACTOR_UNAVAILABLE" &&
        parsed.data.error.message === ERROR_MESSAGES.EXTRACTOR_UNAVAILABLE
      );
    } catch {
      return false;
    }
  }

  private async makeRequest<T>(
    method: "GET" | "POST",
    canonicalPath: string,
    body: object | null,
    idempotencyKey: string | undefined,
    successSchema: z.ZodType<T>,
    expectedStatus: number | number[]
  ): Promise<T> {
    const requestId = this.generateRequestId();
    const nowMs = this.getNowMs();
    const timestamp = Math.floor(nowMs / 1000).toString();
    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];

    let rawBodyBytes = Buffer.alloc(0);
    if (body !== null) {
      const jsonStr = JSON.stringify(body);
      rawBodyBytes = Buffer.from(jsonStr, "utf8");
    }

    const sha256 = sha256WorkerBody(rawBodyBytes);
    const signature = createWorkerSignatureHex(this.config.currentSecret, {
      keyId: this.config.currentKeyId,
      method,
      canonicalPath,
      timestampSeconds: timestamp,
      requestId,
      idempotencyKey,
      sha256RawBody: sha256,
    });

    const headers = new Headers();
    headers.set("x-videofetch-key-id", this.config.currentKeyId);
    headers.set("x-videofetch-timestamp", timestamp);
    headers.set("x-videofetch-request-id", requestId);
    headers.set("x-videofetch-signature", signature);

    if (idempotencyKey) {
      headers.set("Idempotency-Key", idempotencyKey);
    }
    if (body !== null) {
      headers.set("Content-Type", "application/json");
    }
    // Applied last, and never fed back into the signature above.
    this.applyAccessHeaders(headers);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    // `requestTimeoutMs` is ONE total budget for the complete response I/O
    // operation: connect, upstream wait, response headers AND every response
    // body read below. The deadline therefore stays ARMED across the whole
    // block and is cleared exactly once, in the outer `finally`, so no exit —
    // success, business error, validation failure, 401/403, 503 or an expired
    // deadline — can leave a timer alive or hand the body phase a second,
    // fresh budget. A response that delivers headers late leaves the body only
    // what REMAINS of the original budget, never a new one.
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.origin}${canonicalPath}`, {
          method,
          headers,
          body: body !== null ? rawBodyBytes : undefined,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
      }

      // A status that cannot carry a Worker business envelope is classified
      // BEFORE any Worker response validation, and its body is never read.
      if (this.isUnavailablePathStatus(response.status)) {
        throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
      }

      // 503 is ambiguous, so it is resolved here rather than assumed upstream.
      // Only the Worker's exact canonical EXTRACTOR_UNAVAILABLE envelope
      // survives as a business error; every other 503 — including one whose
      // body stalls past the deadline — keeps the safer classification.
      if (response.status === 503) {
        if (await this.isCanonicalExtractorUnavailable(response, controller.signal)) {
          throw new AppError("EXTRACTOR_UNAVAILABLE");
        }
        throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
      }

      this.validateContentType(response.headers.get("content-type"));
      this.validateContentLength(response.headers.get("content-length"));

      // The ordinary body read — successful responses and non-503 Worker error
      // envelopes alike — runs under that SAME deadline. Headers followed by a
      // body that never finishes is a transport failure, not an established
      // success or an established business error, so it resolves to
      // WORKER_UNAVAILABLE instead of being awaited indefinitely, and the
      // partial bytes are discarded rather than surfaced.
      const responseBuffer = await this.readBoundedStream(response, MAX_RESPONSE_BYTES, controller.signal);
      const responseText = responseBuffer.toString("utf8");

      let responseData: unknown;
      try {
        responseData = JSON.parse(responseText);
      } catch {
        throw new AppError("PROCESSING_FAILED");
      }

      if (!response.ok) {
        const parsedError = WorkerErrorResponseSchema.safeParse(responseData);
        if (!parsedError.success) {
          throw new AppError("PROCESSING_FAILED");
        }
        const code = parsedError.data.error.code;
        const isValidCode = WorkerErrorCodeSchema.safeParse(code).success;
        if (isValidCode) {
          throw new AppError(code as ErrorCode);
        }
        throw new AppError("PROCESSING_FAILED");
      }

      if (!statuses.includes(response.status)) {
        throw new AppError("PROCESSING_FAILED");
      }

      const parsedSuccess = successSchema.safeParse(responseData);
      if (!parsedSuccess.success) {
        throw new AppError("PROCESSING_FAILED");
      }

      return parsedSuccess.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Reads a response body under a hard byte ceiling AND under the caller's
   * remaining time budget.
   *
   * A byte ceiling alone does not bound a read: a body that trickles or simply
   * never completes stays under the ceiling forever. `deadlineSignal` is the
   * in-flight request's own timeout, so a stalled stream is abandoned rather
   * than awaited indefinitely and no body read can outlive the budget its
   * caller already started.
   *
   * The signal is REQUIRED, not optional. Every body-consuming path — an
   * ordinary success, a non-503 Worker error envelope, the health probe and
   * the 503 disambiguation probe — passes the same in-flight deadline, so a
   * future caller cannot reintroduce an unbounded read simply by omitting it.
   *
   * The abort reason is a bare marker and is never surfaced; the caller sees
   * only the canonical unavailability error, never partial body bytes.
   */
  private async readBoundedStream(
    response: Response,
    maxBytes: number,
    deadlineSignal: AbortSignal,
  ): Promise<Buffer> {
    if (!response.body) {
      return Buffer.alloc(0);
    }
    const reader = response.body.getReader();
    let receivedBytes = 0;
    const chunks: Uint8Array[] = [];

    // Built once rather than per iteration, so a slow stream cannot accumulate
    // abort listeners. Real fetch also errors the body stream on abort; racing
    // here means the deadline holds even for a stream that ignores its signal.
    const expired = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error("request deadline exceeded"));
      if (deadlineSignal.aborted) fail();
      else deadlineSignal.addEventListener("abort", fail, { once: true });
    });
    // Promise.race handles this while reading; this keeps an abort that
    // arrives after the loop has finished from becoming an unhandled
    // rejection.
    expired.catch(() => {});

    try {
      while (true) {
        let readResult;
        try {
          readResult = await Promise.race([reader.read(), expired]);
        } catch {
          throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
        }
        const { done, value } = readResult;
        if (done) {
          break;
        }
        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > maxBytes) {
            throw new AppError("PROCESSING_FAILED");
          }
          chunks.push(value);
        }
      }
    } finally {
      // On the deadline path a read is still pending, so releasing the lock
      // rejects it. Neither step may throw out of `finally`: that would
      // replace the canonical error with a raw stream exception.
      try {
        reader.releaseLock();
      } catch {
        // Already released, or the reader is unusable — nothing left to free.
      }
      response.body.cancel().catch(() => {});
    }

    return Buffer.concat(chunks);
  }

  public async analyze(input: unknown): Promise<WorkerAnalyzeSuccess> {
    const valid = WorkerAnalyzeRequestSchema.parse(input);
    return this.makeRequest("POST", WORKER_ANALYZE_PATH, valid, undefined, WorkerAnalyzeSuccessSchema, 200);
  }

  public async createJob(input: unknown): Promise<WorkerCreateJobSuccess> {
    const valid = WorkerCreateJobRequestSchema.parse(input);
    const idempotencyKey = this.generateIdempotencyKey();
    return this.makeRequest("POST", WORKER_JOBS_PATH, valid, idempotencyKey, WorkerCreateJobSuccessSchema, [200, 201]);
  }

  public async getJob(jobId: string): Promise<WorkerJobStatusSuccess> {
    const path = workerJobPath(jobId);
    return this.makeRequest("GET", path, null, undefined, WorkerJobStatusSuccessSchema, 200);
  }

  public async cancelJob(jobId: string): Promise<WorkerCancelJobSuccess> {
    const path = workerJobCancelPath(jobId);
    return this.makeRequest("POST", path, null, undefined, WorkerCancelJobSuccessSchema, 200);
  }

  public async diagnostics(): Promise<WorkerDiagnosticsSuccess> {
    return this.makeRequest("GET", WORKER_DIAGNOSTICS_PATH, null, undefined, WorkerDiagnosticsSuccessSchema, 200);
  }

  public async health(): Promise<WorkerHealthSuccess> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    // The Worker's own health route stays unauthenticated by VideoFetch HMAC.
    // Only the upstream access-layer token is attached, so the probe can cross
    // the same proxy as every other request.
    const headers = new Headers();
    this.applyAccessHeaders(headers);

    // Exactly as in `makeRequest`: one armed deadline spans connect, headers
    // and the health body read, cleared once on the way out. A liveness probe
    // whose headers arrive but whose body never finishes is an outage, not a
    // slow-but-live Worker, so it must not be able to outlive the budget.
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.origin}${WORKER_HEALTH_PATH}`, {
          method: "GET",
          headers,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
      }

      // The health route is a liveness probe: it answers 200 {"status":"ok"} and
      // never emits a Worker business-error envelope, so 503 here is always an
      // outage. The makeRequest disambiguation deliberately does not apply.
      if (this.isUnavailablePathStatus(response.status) || response.status === 503) {
        throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
      }

      if (response.status !== 200) {
        throw new AppError("PROCESSING_FAILED");
      }

      this.validateContentType(response.headers.get("content-type"));
      this.validateContentLength(response.headers.get("content-length"));

      const responseBuffer = await this.readBoundedStream(response, MAX_RESPONSE_BYTES, controller.signal);
      const responseText = responseBuffer.toString("utf8");
      let responseData: unknown;
      try {
        responseData = JSON.parse(responseText);
      } catch {
        throw new AppError("PROCESSING_FAILED");
      }

      const parsedSuccess = WorkerHealthSuccessSchema.safeParse(responseData);
      if (!parsedSuccess.success) {
        throw new AppError("PROCESSING_FAILED");
      }

      return parsedSuccess.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
