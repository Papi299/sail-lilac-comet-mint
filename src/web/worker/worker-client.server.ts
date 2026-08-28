import { z } from "zod";
import crypto from "node:crypto";
import { AppError } from "../../lib/errors.ts";
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
  type WorkerDiagnosticsSuccess,
  type WorkerHealthSuccess,
  type WorkerAnalyzeRequest,
  type WorkerCreateJobRequest,
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
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be HTTPS for non-loopback" });
    }
  }),
  currentKeyId: WorkerKeyIdSchema,
  currentSecret: z.string().refine((val) => Buffer.from(val, "utf8").length >= 32, {
    message: "Secret must be at least 32 UTF-8 bytes",
  }),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  requestIdFactory: z.custom<() => string>().optional(),
  idempotencyKeyFactory: z.custom<() => string>().optional(),
  fetchImplementation: z.any().optional(),
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

  private generateRequestId(): string {
    const id = this.config.requestIdFactory ? this.config.requestIdFactory() : crypto.randomUUID();
    return WorkerRequestIdSchema.parse(id);
  }

  private generateIdempotencyKey(): string {
    const key = this.config.idempotencyKeyFactory ? this.config.idempotencyKeyFactory() : crypto.randomUUID();
    return WorkerIdempotencyKeySchema.parse(key);
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
    const timestamp = Math.floor(Date.now() / 1000).toString();
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

    if (response.status === 401 || response.status === 503) {
      throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.toLowerCase().startsWith("application/json")) {
      throw new AppError("PROCESSING_FAILED");
    }

    const contentLength = response.headers.get("content-length");
    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new AppError("PROCESSING_FAILED");
    }

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
        throw new AppError(code as any);
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
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          receivedBytes += value.length;
          if (receivedBytes > maxBytes) {
            throw new Error("Response body exceeds maximum allowed size");
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    
    return Buffer.concat(chunks);
  }

  public async analyze(body: WorkerAnalyzeRequest): Promise<WorkerAnalyzeSuccess> {
    return this.makeRequest("POST", WORKER_ANALYZE_PATH, body, undefined, WorkerAnalyzeSuccessSchema, 200);
  }

  public async createJob(body: WorkerCreateJobRequest): Promise<WorkerCreateJobSuccess> {
    const idempotencyKey = this.generateIdempotencyKey();
    return this.makeRequest("POST", WORKER_JOBS_PATH, body, idempotencyKey, WorkerCreateJobSuccessSchema, [200, 201]);
  }

  public async getJob(jobId: string): Promise<WorkerJobStatusSuccess> {
    return this.makeRequest("GET", `${WORKER_JOBS_PATH}/${jobId}`, null, undefined, WorkerJobStatusSuccessSchema, 200);
  }

  public async cancelJob(jobId: string): Promise<WorkerCancelJobSuccess> {
    return this.makeRequest("POST", `${WORKER_JOBS_PATH}/${jobId}/cancel`, null, undefined, WorkerCancelJobSuccessSchema, 200);
  }

  public async diagnostics(): Promise<WorkerDiagnosticsSuccess> {
    return this.makeRequest("GET", WORKER_DIAGNOSTICS_PATH, null, undefined, WorkerDiagnosticsSuccessSchema, 200);
  }

  public async health(): Promise<WorkerHealthSuccess> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${WORKER_HEALTH_PATH}`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
    } finally {
      clearTimeout(timeoutId);
    }
    
    if (response.status === 401 || response.status === 503) {
      throw new AppError("WORKER_UNAVAILABLE", "The processing worker is temporarily unavailable. Please try again shortly.");
    }
    
    if (!response.ok) {
      throw new AppError("PROCESSING_FAILED");
    }
    
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.toLowerCase().startsWith("application/json")) {
      throw new AppError("PROCESSING_FAILED");
    }
    
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
