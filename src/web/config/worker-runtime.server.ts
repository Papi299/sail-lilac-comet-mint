import { AppError } from "../../lib/errors.ts";
import type {
  WorkerAnalyzeSuccess,
  WorkerCancelJobSuccess,
  WorkerCreateJobSuccess,
  WorkerDiagnosticsSuccess,
  WorkerJobStatusSuccess,
} from "../../shared/worker/contracts.ts";
import { CloudflareR2Signer } from "../storage/cloudflare-r2-signer.server.ts";
import type { ObjectStoreSigner } from "../storage/object-store-signer.server.ts";
import { WorkerClient } from "../worker/worker-client.server.ts";

/**
 * The exact control-plane surface the Vercel handlers are allowed to use.
 * WorkerClient satisfies it structurally; tests substitute a stub so no
 * handler test ever opens a socket.
 */
export interface WorkerControlClient {
  analyze(input: unknown): Promise<WorkerAnalyzeSuccess>;
  createJob(input: unknown): Promise<WorkerCreateJobSuccess>;
  getJob(jobId: string): Promise<WorkerJobStatusSuccess>;
  cancelJob(jobId: string): Promise<WorkerCancelJobSuccess>;
  diagnostics(): Promise<WorkerDiagnosticsSuccess>;
}

/**
 * Server-only, lazy composition for the Vercel control plane.
 *
 * Nothing here runs at module import: no client is constructed, no secret is
 * read, and no validation happens until a request actually needs the worker or
 * the object-store signer. Missing or malformed configuration fails closed at
 * request time as WORKER_UNAVAILABLE, which carries no configuration detail.
 *
 * These are an environment CONTRACT only — the names are documented in
 * .env.example with empty values. No secret may ever use a VITE_ prefix,
 * because that would publish it to the browser bundle.
 */
export const WORKER_ENV_KEYS = [
  "WORKER_BASE_URL",
  "WORKER_CONTROL_KEY_ID",
  "WORKER_CONTROL_SECRET",
] as const;

export const R2_SIGNER_ENV_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
  "R2_JURISDICTION",
  "R2_SIGNER_ACCESS_KEY_ID",
  "R2_SIGNER_SECRET_ACCESS_KEY",
  "R2_SIGNER_SESSION_TOKEN",
] as const;

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fingerprint(names: readonly string[]): string {
  return JSON.stringify(names.map((name) => readEnv(name) ?? null));
}

let workerClientOverride: WorkerControlClient | null = null;
let signerOverride: ObjectStoreSigner | null = null;

let cachedWorkerClient: WorkerControlClient | null = null;
let cachedWorkerFingerprint: string | null = null;
let cachedSigner: ObjectStoreSigner | null = null;
let cachedSignerFingerprint: string | null = null;

/**
 * Returns the configured Worker HTTP client.
 *
 * Reuses the strict WorkerClient constructor verbatim — its own schema is the
 * single source of truth for base-URL, key-id and secret validation, so none of
 * it is duplicated here.
 */
export function getWorkerClient(): WorkerControlClient {
  if (workerClientOverride) return workerClientOverride;

  const current = fingerprint(WORKER_ENV_KEYS);
  if (cachedWorkerClient && cachedWorkerFingerprint === current) {
    return cachedWorkerClient;
  }

  const baseUrl = readEnv("WORKER_BASE_URL");
  const currentKeyId = readEnv("WORKER_CONTROL_KEY_ID");
  const currentSecret = readEnv("WORKER_CONTROL_SECRET");

  if (!baseUrl || !currentKeyId || !currentSecret) {
    throw new AppError("WORKER_UNAVAILABLE");
  }

  let client: WorkerControlClient;
  try {
    client = new WorkerClient({ baseUrl, currentKeyId, currentSecret });
  } catch {
    // Never surface which field was malformed.
    throw new AppError("WORKER_UNAVAILABLE");
  }

  cachedWorkerClient = client;
  cachedWorkerFingerprint = current;
  return client;
}

/**
 * Returns the GetObject-only object-store signer.
 *
 * Reuses the strict CloudflareR2Signer constructor verbatim. These credentials
 * are the read-side signer identity and are never the Worker's writer
 * credentials.
 */
export function getObjectStoreSigner(): ObjectStoreSigner {
  if (signerOverride) return signerOverride;

  const current = fingerprint(R2_SIGNER_ENV_KEYS);
  if (cachedSigner && cachedSignerFingerprint === current) {
    return cachedSigner;
  }

  const accountId = readEnv("R2_ACCOUNT_ID");
  const bucket = readEnv("R2_BUCKET");
  const accessKeyId = readEnv("R2_SIGNER_ACCESS_KEY_ID");
  const secretAccessKey = readEnv("R2_SIGNER_SECRET_ACCESS_KEY");
  const sessionToken = readEnv("R2_SIGNER_SESSION_TOKEN");
  const jurisdiction = readEnv("R2_JURISDICTION") ?? "default";

  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new AppError("WORKER_UNAVAILABLE");
  }

  let signer: ObjectStoreSigner;
  try {
    signer = new CloudflareR2Signer({
      accountId,
      bucket,
      jurisdiction: jurisdiction as "default" | "eu" | "us",
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    });
  } catch {
    throw new AppError("WORKER_UNAVAILABLE");
  }

  cachedSigner = signer;
  cachedSignerFingerprint = current;
  return signer;
}

export function setWorkerClientForTests(client: WorkerControlClient | null): void {
  workerClientOverride = client;
}

export function setObjectStoreSignerForTests(signer: ObjectStoreSigner | null): void {
  signerOverride = signer;
}

export function resetWorkerRuntimeForTests(): void {
  workerClientOverride = null;
  signerOverride = null;
  cachedWorkerClient = null;
  cachedWorkerFingerprint = null;
  cachedSigner = null;
  cachedSignerFingerprint = null;
}
