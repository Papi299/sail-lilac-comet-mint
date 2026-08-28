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
}).strict();

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
