import { z } from "zod";
import type { ErrorCode } from "../../lib/errors.ts";

export const WORKER_ERROR_CODES = [
  "INVALID_URL",
  "UNSUPPORTED_SITE",
  "VIDEO_UNAVAILABLE",
  "ANALYSIS_FAILED",
  "FORMAT_UNAVAILABLE",
  "SERVER_OVERLOAD",
  "PROCESSING_FAILED",
  "TIMEOUT",
  "NETWORK_ERROR",
  "EXTRACTION_FAILED",
  "EXTRACTOR_UNAVAILABLE",
  "TOO_LARGE",
  "TOO_LONG",
  "RATE_LIMITED",
  "NOT_FOUND",
  "EXPIRED",
] as const satisfies readonly ErrorCode[];

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

export const WorkerErrorCodeSchema = z.enum(WORKER_ERROR_CODES);

export const WorkerErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: WorkerErrorCodeSchema,
    message: z.string(), // Runtime producers must pass only safe, sanitized messages
  }).strict(),
}).strict();

export type WorkerErrorResponse = z.infer<typeof WorkerErrorResponseSchema>;
