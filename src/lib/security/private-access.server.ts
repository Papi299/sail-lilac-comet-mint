import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";

export const ACCESS_COOKIE_NAME = "__Host-videofetch_access";
export const MIN_ACCESS_SECRET_BYTES = 32;
export const ACCESS_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCESS_LOGIN_RATE_KEY = "private-access-login";
export const ACCESS_LOGIN_RATE_LIMIT = 10;

const TOKEN_VERSION = "v1";
const MAC_PURPOSE = "videofetch-private-access";

export type AccessMode =
  | { kind: "configured"; secret: string }
  | { kind: "development-bypass" }
  | { kind: "not-configured" };

export type AccessSessionInfo = {
  authenticated: boolean;
  configured: boolean;
  developmentBypass: boolean;
};

type AccessTestEnv = {
  nodeEnv?: string;
  secret?: string | undefined;
};

let testEnv: AccessTestEnv | null = null;
let nowImpl: () => number = () => Date.now();

export function setPrivateAccessTestEnv(next: AccessTestEnv | null): void {
  testEnv = next;
}

export function setPrivateAccessNowForTests(now: (() => number) | null): void {
  nowImpl = now ?? (() => Date.now());
}

function currentTimeMs(): number {
  return nowImpl();
}

function readNodeEnv(): string {
  if (testEnv && testEnv.nodeEnv !== undefined) return testEnv.nodeEnv;
  return process.env.NODE_ENV || "development";
}

function readConfiguredSecret(): string | undefined {
  if (testEnv && Object.prototype.hasOwnProperty.call(testEnv, "secret")) {
    return testEnv.secret;
  }
  return process.env.VIDEOFETCH_ACCESS_SECRET;
}

export function isProductionEnv(): boolean {
  return readNodeEnv() === "production";
}

export function getAccessMode(): AccessMode {
  const raw = readConfiguredSecret();
  const production = isProductionEnv();
  if (raw == null || raw.length === 0) {
    return production ? { kind: "not-configured" } : { kind: "development-bypass" };
  }
  if (Buffer.byteLength(raw, "utf8") < MIN_ACCESS_SECRET_BYTES) {
    return { kind: "not-configured" };
  }
  return { kind: "configured", secret: raw };
}

function sha256Bytes(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function secretsEqual(provided: string, configured: string): boolean {
  const left = sha256Bytes(provided);
  const right = sha256Bytes(configured);
  return timingSafeEqual(left, right);
}

function macForExpiry(secret: string, expiryUnix: number): Buffer {
  return createHmac("sha256", secret)
    .update(`${MAC_PURPOSE}:${TOKEN_VERSION}:${expiryUnix}`)
    .digest();
}

function encodeMac(mac: Buffer): string {
  return mac.toString("base64url");
}

function decodeMac(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export function mintSessionToken(secret: string, nowMs = currentTimeMs()): string {
  const expiryUnix = Math.floor((nowMs + ACCESS_SESSION_TTL_MS) / 1000);
  const mac = encodeMac(macForExpiry(secret, expiryUnix));
  return `${TOKEN_VERSION}.${expiryUnix}.${mac}`;
}

export function verifySessionToken(
  secret: string,
  token: string,
  nowMs = currentTimeMs(),
): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, expiryRaw, macRaw] = parts;
  if (version !== TOKEN_VERSION) return false;
  if (!expiryRaw || !/^[0-9]+$/.test(expiryRaw)) return false;
  const expiryUnix = Number(expiryRaw);
  if (!Number.isSafeInteger(expiryUnix) || expiryUnix <= 0) return false;

  const expected = macForExpiry(secret, expiryUnix);
  const provided = decodeMac(macRaw ?? "") ?? Buffer.alloc(32);
  if (!timingSafeEqual(provided, expected)) return false;
  if (!decodeMac(macRaw ?? "")) return false;
  return expiryUnix * 1000 > nowMs;
}

export function serializeAccessCookie(token: string, maxAgeSeconds?: number): string {
  const maxAge =
    maxAgeSeconds ?? Math.floor(ACCESS_SESSION_TTL_MS / 1000);
  return `${ACCESS_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function serializeClearedAccessCookie(): string {
  return `${ACCESS_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readAccessCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== ACCESS_COOKIE_NAME) continue;
    return part.slice(idx + 1).trim();
  }
  return null;
}

export function assertPrivateAccessIsolation(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (!site || site === "same-origin" || site === "none") return;
  throw new AppError("FORBIDDEN", "This request is not allowed.");
}

export function requirePrivateAccess(request: Request): void {
  assertPrivateAccessIsolation(request);
  const mode = getAccessMode();
  if (mode.kind === "development-bypass") return;
  if (mode.kind === "not-configured") {
    throw new AppError("ACCESS_NOT_CONFIGURED");
  }
  const token = readAccessCookie(request);
  if (!token || !verifySessionToken(mode.secret, token)) {
    throw new AppError("ACCESS_REQUIRED");
  }
}

export function describeAccessSession(request: Request): AccessSessionInfo {
  assertPrivateAccessIsolation(request);
  const mode = getAccessMode();
  if (mode.kind === "development-bypass") {
    return { authenticated: false, configured: false, developmentBypass: true };
  }
  if (mode.kind === "not-configured") {
    return { authenticated: false, configured: false, developmentBypass: false };
  }
  const token = readAccessCookie(request);
  const authenticated = Boolean(token && verifySessionToken(mode.secret, token));
  return { authenticated, configured: true, developmentBypass: false };
}

export function authenticateAccessSecret(secret: string): string {
  const mode = getAccessMode();
  if (mode.kind !== "configured") {
    throw new AppError("ACCESS_NOT_CONFIGURED");
  }
  if (!secretsEqual(secret, mode.secret)) {
    throw new AppError("ACCESS_REQUIRED", "Invalid access secret.");
  }
  return mintSessionToken(mode.secret);
}

export function noStoreHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "Cache-Control": "no-store", ...extra };
}
