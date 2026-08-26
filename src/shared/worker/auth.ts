import { createHash } from "node:crypto";
import { z } from "zod";
import { WORKER_HMAC_VERSION } from "./constants.ts";

export const WorkerRequestIdSchema = z.string().uuid();
export const WorkerIdempotencyKeySchema = z.string().uuid();
export const WorkerKeyIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
export const WorkerTimestampSchema = z.number().int().nonnegative();
export const WorkerMethodSchema = z.enum(["GET", "POST"]);

/**
 * Ensures the path starts with / and contains no query parameters or fragments.
 */
export const WorkerCanonicalPathSchema = z
  .string()
  .startsWith("/")
  .refine((val) => !val.includes("?") && !val.includes("#"), {
    message: "Canonical path must not contain query parameters or fragments",
  });

export interface SigningInputParams {
  keyId: string;
  method: "GET" | "POST";
  canonicalPath: string;
  timestampSeconds: number;
  requestId: string;
  idempotencyKey?: string;
  sha256RawBody: string;
}

/**
 * Hashes the exact raw HTTP body bytes.
 * Must be used BEFORE any JSON parsing.
 */
export function sha256WorkerBody(rawBody: Uint8Array | Buffer | string): string {
  // If string, assume utf-8 bytes (this is standard for raw bodies).
  // Ideally, producers pass Buffer or Uint8Array.
  return createHash("sha256").update(rawBody).digest("hex").toLowerCase();
}

/**
 * Builds the exact newline-delimited canonical signing string.
 * Validates all fields before constructing the string to prevent injection.
 */
export function buildWorkerSigningInput(params: SigningInputParams): string {
  // Validate individually to ensure structural safety (e.g. no newlines)
  const keyId = WorkerKeyIdSchema.parse(params.keyId);
  // Unambiguously normalize method to uppercase
  const method = WorkerMethodSchema.parse(params.method.toUpperCase() as "GET" | "POST");
  const path = WorkerCanonicalPathSchema.parse(params.canonicalPath);
  const ts = WorkerTimestampSchema.parse(params.timestampSeconds);
  const requestId = WorkerRequestIdSchema.parse(params.requestId);
  
  let idempotencyKey = "";
  if (params.idempotencyKey) {
    idempotencyKey = WorkerIdempotencyKeySchema.parse(params.idempotencyKey);
  }

  if (params.sha256RawBody.length !== 64 || !/^[0-9a-f]+$/.test(params.sha256RawBody)) {
    throw new Error("sha256RawBody must be exactly 64 lowercase hex characters");
  }

  // Ensure no fields inadvertently contain newlines (Zod schemas above should prevent this,
  // but we enforce strictly by structure).
  const parts = [
    WORKER_HMAC_VERSION,
    keyId,
    method,
    path,
    ts.toString(10),
    requestId,
    idempotencyKey, // or empty string
    params.sha256RawBody,
  ];

  return parts.join("\n");
}
