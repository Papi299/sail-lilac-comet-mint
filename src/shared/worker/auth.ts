import { createHash } from "node:crypto";
import { z } from "zod";
import { WORKER_HMAC_VERSION } from "./constants.ts";

const UuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const WorkerRequestIdSchema = z.string().regex(UuidV4Regex, "Must be a valid UUID v4");
export const WorkerIdempotencyKeySchema = z.string().regex(UuidV4Regex, "Must be a valid UUID v4");
export const WorkerKeyIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);

// Must be exactly the base-10 integer string (e.g. "1700000000")
export const WorkerTimestampSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "Must be canonical base-10 integer string");

export const WorkerMethodSchema = z.enum(["GET", "POST"]);

/**
 * Ensures the path is exactly one of the approved signable routes,
 * rejecting query parameters, fragments, and unauthenticated routes (like /v1/healthz).
 */
export const WorkerCanonicalPathSchema = z
  .string()
  .regex(
    /^\/v1\/(analyze|jobs|diagnostics|jobs\/[0-9a-f]{32}(?:\/cancel)?)$/,
    "Canonical path must be an exact approved route with no query parameters or fragments"
  );

export interface SigningInputParams {
  keyId: string;
  method: "GET" | "POST";
  canonicalPath: string;
  timestampSeconds: string;
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
  
  // Enforce lowercase canonically if it matters, but schema accepts case-insensitive.
  // The architecture requires canonical strings, we'll keep them as supplied if valid.
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
    ts,
    requestId,
    idempotencyKey, // or empty string
    params.sha256RawBody,
  ];

  return parts.join("\n");
}
