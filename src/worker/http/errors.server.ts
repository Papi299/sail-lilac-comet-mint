import { AppError, ERROR_MESSAGES } from "../../lib/errors.ts";
import {
  WORKER_ERROR_CODES,
  WorkerErrorResponseSchema,
  type WorkerErrorCode,
  type WorkerErrorResponse,
} from "../../shared/worker/errors.ts";

/**
 * Canonical HTTP status for every allowlisted Worker business error code.
 *
 * Declared here rather than reused from the control-plane table so the Worker
 * surface cannot silently inherit a control-plane-only code. `WORKER_UNAVAILABLE`
 * is deliberately absent: it is a Vercel/control-plane classification and must
 * never be produced by the Worker.
 */
export const WORKER_ERROR_HTTP_STATUS: Record<WorkerErrorCode, number> = {
  INVALID_URL: 400,
  UNSUPPORTED_SITE: 422,
  VIDEO_UNAVAILABLE: 404,
  ANALYSIS_FAILED: 502,
  FORMAT_UNAVAILABLE: 409,
  SERVER_OVERLOAD: 429,
  PROCESSING_FAILED: 500,
  TIMEOUT: 504,
  NETWORK_ERROR: 502,
  EXTRACTION_FAILED: 502,
  EXTRACTOR_UNAVAILABLE: 503,
  TOO_LARGE: 413,
  TOO_LONG: 413,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  EXPIRED: 410,
};

const WORKER_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(WORKER_ERROR_CODES);

export function isWorkerErrorCode(value: unknown): value is WorkerErrorCode {
  return typeof value === "string" && WORKER_ERROR_CODE_SET.has(value);
}

/**
 * A business failure that has already been classified into the shared
 * allowlist. Carries no message of its own — the wire message is always the
 * canonical `ERROR_MESSAGES[code]`.
 */
export class WorkerBusinessError extends Error {
  readonly code: WorkerErrorCode;
  readonly httpStatus: number;

  constructor(code: WorkerErrorCode, httpStatus?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = "WorkerBusinessError";
    this.code = code;
    this.httpStatus = httpStatus ?? WORKER_ERROR_HTTP_STATUS[code];
  }
}

/**
 * Maps ANY thrown value to a schema-valid Worker error envelope.
 *
 * Raw exception text is never serialized: even an AppError carrying a custom
 * message is rewritten to the canonical safe message for its code. Anything
 * unrecognised becomes PROCESSING_FAILED.
 */
export function toWorkerErrorEnvelope(err: unknown): {
  status: number;
  body: WorkerErrorResponse;
} {
  let code: WorkerErrorCode = "PROCESSING_FAILED";
  let status: number | null = null;

  if (err instanceof WorkerBusinessError) {
    code = err.code;
    status = err.httpStatus;
  } else if (err instanceof AppError && isWorkerErrorCode(err.code)) {
    code = err.code;
  }

  const body = WorkerErrorResponseSchema.parse({
    success: false,
    error: { code, message: ERROR_MESSAGES[code] },
  });

  return { status: status ?? WORKER_ERROR_HTTP_STATUS[code], body };
}
