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
    if (len > 2 * 1024 * 1024) {
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
   * Statuses that mean the request never reached the Worker protocol.
   *
   * Neither 401 nor 403 can originate from the current Worker protocol — both
   * are absent from WORKER_ERROR_HTTP_STATUS and from every Worker code path —
   * so either one on this endpoint is a non-Worker, upstream refusal. A refused
   * Access service token is the expected cause, but other upstream controls
   * (WAF, rate limiting, a bot rule) could produce one too; the classification
   * deliberately does not depend on knowing which.
   *
   * It must be decided BEFORE any content-type or JSON validation, because such
   * a response is an upstream page rather than a Worker error envelope. Its body
   * is never read, parsed or surfaced.
   *
   * 503 is deliberately NOT in this set. It used to be, which was wrong: the
   * Worker maps its own EXTRACTOR_UNAVAILABLE business error to 503
   * (WORKER_ERROR_HTTP_STATUS), so a 503 here is ambiguous rather than
   * necessarily upstream. It is resolved by `isCanonicalExtractorUnavailable`.
   */
  private isUpstreamOnlyStatus(status: number): boolean {
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
   * message for it. The message must match because `toWorkerErrorEnvelope`
   * always rewrites a Worker error message to `ERROR_MESSAGES[code]`, so a
   * divergent message did not come from the Worker's error path.
   *
   * Every branch fails closed. Anything short of that exact envelope — an
   * absent or HTML body, a wrong or missing content type, malformed, oversized
   * or unreadable bytes, another Worker code, a doctored message — returns
   * false, and the caller keeps the safer WORKER_UNAVAILABLE classification.
   * The body is consumed here purely to classify it and is never surfaced in
   * the resulting error.
   */
  private async isCanonicalExtractorUnavailable(response: Response): Promise<boolean> {
    try {
      this.validateContentType(response.headers.get("content-type"));
      this.validateContentLength(response.headers.get("content-length"));
      const responseBuffer = await this.readBoundedStream(response, MAX_RESPONSE_BYTES);
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
    } finally {
      clearTimeout(timeoutId);
    }

    // Upstream refusal is classified BEFORE Worker response validation: the
    // body belongs to the proxy, not to the Worker protocol.
    if (this.isUpstreamOnlyStatus(response.status)) {
      throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
    }

    // 503 is ambiguous, so it is resolved here rather than assumed upstream.
    // Only the Worker's exact canonical EXTRACTOR_UNAVAILABLE envelope survives
    // as a business error; every other 503 keeps the safer classification.
    if (response.status === 503) {
      if (await this.isCanonicalExtractorUnavailable(response)) {
        throw new AppError("EXTRACTOR_UNAVAILABLE");
      }
      throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
    }

    this.validateContentType(response.headers.get("content-type"));
    this.validateContentLength(response.headers.get("content-length"));

    const responseBuffer = await this.readBoundedStream(response, MAX_RESPONSE_BYTES);
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
  }

  private async readBoundedStream(response: Response, maxBytes: number): Promise<Buffer> {
    if (!response.body) {
      return Buffer.alloc(0);
    }
    const reader = response.body.getReader();
    let receivedBytes = 0;
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
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
      reader.releaseLock();
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
    } finally {
      clearTimeout(timeoutId);
    }

    // The health route is a liveness probe: it answers 200 {"status":"ok"} and
    // never emits a Worker business-error envelope, so 503 here is always an
    // outage. The makeRequest disambiguation deliberately does not apply.
    if (this.isUpstreamOnlyStatus(response.status) || response.status === 503) {
      throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
    }

    if (response.status !== 200) {
      throw new AppError("PROCESSING_FAILED");
    }

    this.validateContentType(response.headers.get("content-type"));
    this.validateContentLength(response.headers.get("content-length"));

    const responseBuffer = await this.readBoundedStream(response, MAX_RESPONSE_BYTES);
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
  }
}
