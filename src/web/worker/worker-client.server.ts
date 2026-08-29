import { z } from "zod";
import crypto from "node:crypto";
import { AppError, type ErrorCode } from "../../lib/errors.ts";
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
   * The Worker itself neither receives nor verifies them.
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
   * 401/503 are pre-existing. 403 is added because the authoritative Worker
   * never emits it — it is absent from WORKER_ERROR_HTTP_STATUS and from every
   * Worker code path — so a 403 on this endpoint is always the upstream access
   * layer refusing the service token. It must be classified BEFORE any
   * content-type or JSON validation, because that response is HTML from the
   * proxy rather than a Worker error envelope.
   */
  private isUpstreamUnavailableStatus(status: number): boolean {
    return status === 401 || status === 403 || status === 503;
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
    if (this.isUpstreamUnavailableStatus(response.status)) {
      throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
    }

    this.validateContentType(response.headers.get("content-type"));
    this.validateContentLength(response.headers.get("content-length"));

    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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

    if (this.isUpstreamUnavailableStatus(response.status)) {
      throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
    }

    if (response.status !== 200) {
      throw new AppError("PROCESSING_FAILED");
    }

    this.validateContentType(response.headers.get("content-type"));
    this.validateContentLength(response.headers.get("content-length"));

    const responseBuffer = await this.readBoundedStream(response, 2 * 1024 * 1024);
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
