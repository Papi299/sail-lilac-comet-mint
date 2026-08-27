import { createHmac, timingSafeEqual } from "node:crypto";
import { buildWorkerSigningInput, type SigningInputParams } from "./auth.ts";

export const WORKER_SIGNATURE_REGEX = /^[0-9a-f]{64}$/;

/**
 * Creates an HMAC-SHA256 signature (64 lowercase hex characters)
 * for the given signing input using the provided secret.
 */
export function createWorkerSignatureHex(
  secret: string | Buffer | Uint8Array,
  params: SigningInputParams
): string {
  const signingInput = buildWorkerSigningInput(params);
  return createHmac("sha256", secret).update(signingInput, "utf8").digest("hex").toLowerCase();
}

/**
 * Constant-time comparison of a provided signature hex string against
 * the expected signature calculated from params and secret.
 */
export function verifyWorkerSignature(
  secret: string | Buffer | Uint8Array,
  params: SigningInputParams,
  providedSignatureHex: string
): boolean {
  if (!WORKER_SIGNATURE_REGEX.test(providedSignatureHex)) {
    return false;
  }

  const expectedHex = createWorkerSignatureHex(secret, params);
  
  const expectedBytes = Buffer.from(expectedHex, "hex");
  const providedBytes = Buffer.from(providedSignatureHex, "hex");

  if (expectedBytes.length !== providedBytes.length) {
    return false;
  }

  return timingSafeEqual(expectedBytes, providedBytes);
}
