import { Buffer } from "node:buffer";
import {
  parseWorkerTimestampSeconds,
  sha256WorkerBody,
  type SigningInputParams,
  WorkerKeyIdSchema,
} from "../../shared/worker/auth.ts";
import { WORKER_TIMESTAMP_TOLERANCE_SECONDS } from "../../shared/worker/constants.ts";
import { verifyWorkerSignature } from "../../shared/worker/hmac.server.ts";
import type { WorkerReplayStore } from "./replay-store.ts";

export const WORKER_REPLAY_GRACE_SECONDS = 60;

export class WorkerAuthenticationError extends Error {
  constructor(message: string = "unauthorized") {
    super(message);
    this.name = "WorkerAuthenticationError";
  }
}

export class WorkerReplayStoreUnavailableError extends Error {
  constructor(message: string = "Service Unavailable") {
    super(message);
    this.name = "WorkerReplayStoreUnavailableError";
  }
}

export interface WorkerAuthConfig {
  currentKeyId: string;
  currentSecret: string | Buffer | Uint8Array;
  previousKeyId?: string;
  previousSecret?: string | Buffer | Uint8Array;
  replayStore: WorkerReplayStore;
  clock?: () => number;
}

function assertSecretStrength(secret: string | Buffer | Uint8Array, label: string) {
  const byteLength = typeof secret === "string" ? Buffer.byteLength(secret, "utf8") : secret.length;
  if (byteLength < 32) {
    throw new Error(`${label} must be at least 32 bytes long`);
  }
}

export class WorkerAuthenticator {
  private readonly currentKeyId: string;
  private readonly currentSecret: Buffer;
  private readonly previousKeyId?: string;
  private readonly previousSecret?: Buffer;
  private readonly replayStore: WorkerReplayStore;
  private readonly clock: () => number;

  constructor(config: WorkerAuthConfig) {
    this.currentKeyId = WorkerKeyIdSchema.parse(config.currentKeyId);
    assertSecretStrength(config.currentSecret, "currentSecret");
    this.currentSecret = Buffer.from(config.currentSecret);

    if (config.previousKeyId) {
      if (config.previousKeyId === this.currentKeyId) {
        throw new Error("previousKeyId must be distinct from currentKeyId");
      }
      this.previousKeyId = WorkerKeyIdSchema.parse(config.previousKeyId);
      if (!config.previousSecret) {
        throw new Error("previousSecret is required when previousKeyId is provided");
      }
      assertSecretStrength(config.previousSecret, "previousSecret");
      this.previousSecret = Buffer.from(config.previousSecret);
    } else if (config.previousSecret) {
      throw new Error("previousKeyId is required when previousSecret is provided");
    }

    this.replayStore = config.replayStore;
    this.clock = config.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Validates the timestamp, signature, and attempts to reserve the replay ID.
   * Throws an error on failure.
   */
  async authenticateAndReserve(
    params: {
      keyId: string;
      method: "GET" | "POST";
      canonicalPath: string;
      timestampSeconds: string;
      requestId: string;
      idempotencyKey?: string;
      rawBody: Buffer;
      signatureHex: string;
    }
  ): Promise<void> {
    // 1. Key Selection
    let activeSecret: Buffer;
    if (params.keyId === this.currentKeyId) {
      activeSecret = this.currentSecret;
    } else if (this.previousKeyId && params.keyId === this.previousKeyId) {
      activeSecret = this.previousSecret!;
    } else {
      throw new WorkerAuthenticationError();
    }

    // 2. Timestamp Validation
    let requestTs: number;
    try {
      requestTs = parseWorkerTimestampSeconds(params.timestampSeconds);
    } catch {
      throw new WorkerAuthenticationError();
    }
    const now = this.clock();
    if (Math.abs(requestTs - now) > WORKER_TIMESTAMP_TOLERANCE_SECONDS) {
      throw new WorkerAuthenticationError();
    }

    // 3. HMAC Verification
    const sha256RawBody = sha256WorkerBody(params.rawBody);
    const signingParams: SigningInputParams = {
      keyId: params.keyId,
      method: params.method,
      canonicalPath: params.canonicalPath,
      timestampSeconds: params.timestampSeconds,
      requestId: params.requestId,
      idempotencyKey: params.idempotencyKey,
      sha256RawBody,
    };

    let isValid = false;
    try {
      isValid = verifyWorkerSignature(activeSecret, signingParams, params.signatureHex);
    } catch {
      // e.g. path or other schema validation inside buildWorkerSigningInput failed
      throw new WorkerAuthenticationError();
    }

    if (!isValid) {
      throw new WorkerAuthenticationError();
    }

    // 4. Replay Reservation (ATOMIC)
    // Retention is based on the SIGNED REQUEST TIMESTAMP to ensure requests
    // valid within the tolerance window cannot be replayed before their expiry.
    const expiresAtSeconds =
      requestTs + WORKER_TIMESTAMP_TOLERANCE_SECONDS + WORKER_REPLAY_GRACE_SECONDS;

    // A storage failure will throw and fail closed (service unavailable)
    let reserveResult;
    try {
      reserveResult = await this.replayStore.reserve(params.requestId, expiresAtSeconds);
    } catch (e: any) {
      if (e instanceof WorkerAuthenticationError) {
        throw e;
      }
      throw new WorkerReplayStoreUnavailableError();
    }

    if (reserveResult === "duplicate") {
      throw new WorkerAuthenticationError();
    }

    // Success.
  }
}
