import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, type S3ClientConfig } from "@aws-sdk/client-s3";
import { ObjectStorePutInputSchema, ObjectStoreHeadSchema, type ObjectStoreWriter, type ObjectStorePutInput, type ObjectStoreHead, type ObjectStoreOperationContext } from "./writer.ts";
import { WorkerObjectKeySchema, type WorkerObjectKey } from "../../shared/worker/contracts.ts";
import { Readable } from "node:stream";
import { z } from "zod";

export const CloudflareR2ConfigSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/, "Account ID must be 32 lowercase hex characters"),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "Invalid bucket name"),
  jurisdiction: z.enum(["default", "eu", "us"]).optional().default("default"),
  accessKeyId: z.string().min(1).max(8192),
  secretAccessKey: z.string().min(1).max(8192),
  sessionToken: z.string().min(1).max(8192).optional(),
}).strict();

export type CloudflareR2Config = z.input<typeof CloudflareR2ConfigSchema>;

export class CloudflareR2Error extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CloudflareR2Error";
  }
}

/**
 * VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001: the transport bounds of every
 * R2 request the Worker makes. Constants, not configuration: no environment
 * variable sets them, and the SDK's own environment-driven defaults
 * (`AWS_MAX_ATTEMPTS`, `AWS_RETRY_MODE`, `AWS_REQUEST_CHECKSUM_CALCULATION`, the
 * shared config file) are overridden explicitly, so the reviewed values are the
 * values that run.
 *
 *  - `connectionTimeoutMs`: from the request's creation until its TCP socket is
 *    connected, the DNS lookup included. A request that cannot connect fails.
 *  - `socketIdleTimeoutMs`: the socket's INACTIVITY bound. No byte read or
 *    written for this long — a stalled TLS handshake, a peer that stopped
 *    reading the body, a response that never starts — destroys the request.
 *    Progress resets it, so it is a stall detector, never a total budget: the
 *    total is the caller's signal (the upload stage's one deadline).
 *  - `maxAttempts`: the SDK's attempts per operation, its default made explicit.
 *    A PutObject is never re-attempted whatever this says, because its body is
 *    a non-replayable stream (the SDK refuses to retry one, pinned by
 *    `r2-transport.server.test.ts`); a HeadObject or DeleteObject may be retried
 *    on a transient error, and every attempt is refused once the operation's
 *    signal has aborted.
 *
 * The 30 s / 120 s values are the reviewed long-download design's (LD-2b row of
 * the implementation roadmap).
 */
export const R2_TRANSPORT_POLICY = Object.freeze({
  connectionTimeoutMs: 30_000,
  socketIdleTimeoutMs: 120_000,
  maxAttempts: 3,
} as const);

/** The two timing bounds a test may narrow (`buildR2S3ClientConfig`). */
export type R2TransportBounds = {
  readonly connectionTimeoutMs: number;
  readonly socketIdleTimeoutMs: number;
};

/**
 * The S3 client configuration for one R2 endpoint and one credential.
 *
 * Production passes no `transport` and gets `R2_TRANSPORT_POLICY` exactly. A
 * test may NARROW either bound to prove its effect in milliseconds; a wider,
 * non-integer or non-positive bound is refused, so no caller can loosen them.
 *
 * Besides the bounds:
 *
 *  - `requestChecksumCalculation: "WHEN_REQUIRED"`. Under the SDK default
 *    (`WHEN_SUPPORTED`) a streaming PutObject body is re-framed by an encoder
 *    that drains its source in flowing mode with no backpressure: against a
 *    peer that has stopped reading, the whole file is pulled into memory, and
 *    it keeps being read after the request is aborted. PutObject requires no
 *    checksum, so with `WHEN_REQUIRED` the body is piped straight into the
 *    request with its declared `Content-Length`, read only as fast as the
 *    socket drains it. TLS protects the bytes in transit, and the upload
 *    lifecycle verifies the stored object's metadata with HeadObject.
 *  - `keepAlive: false`. Every writer serves exactly one operation with one
 *    scoped credential, so a pooled idle socket could never be reused: it
 *    would only outlive the operation. Each request's socket closes when its
 *    exchange ends.
 */
export function buildR2S3ClientConfig(input: {
  endpoint: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  transport?: Partial<R2TransportBounds>;
}): S3ClientConfig {
  const connectionTimeoutMs = narrowedBound(
    input.transport?.connectionTimeoutMs,
    R2_TRANSPORT_POLICY.connectionTimeoutMs,
    "connectionTimeoutMs",
  );
  const socketIdleTimeoutMs = narrowedBound(
    input.transport?.socketIdleTimeoutMs,
    R2_TRANSPORT_POLICY.socketIdleTimeoutMs,
    "socketIdleTimeoutMs",
  );
  return {
    region: "auto",
    endpoint: input.endpoint,
    credentials: input.credentials,
    maxAttempts: R2_TRANSPORT_POLICY.maxAttempts,
    retryMode: "standard",
    requestChecksumCalculation: "WHEN_REQUIRED",
    requestHandler: {
      connectionTimeout: connectionTimeoutMs,
      socketTimeout: socketIdleTimeoutMs,
      httpAgent: { keepAlive: false },
      httpsAgent: { keepAlive: false },
    },
  };
}

function narrowedBound(value: number | undefined, policy: number, field: string): number {
  if (value === undefined) return policy;
  if (!Number.isSafeInteger(value) || value <= 0 || value > policy) {
    throw new CloudflareR2Error(`Invalid R2 transport bound: ${field}`);
  }
  return value;
}

export interface S3SendClient {
  send(command: any, options?: { abortSignal?: AbortSignal }): Promise<any>;
}

/**
 * The options handed to the SDK for one operation. With a signal, aborting it
 * makes the SDK's request handler destroy the in-flight request — socket and
 * all — and reject; an attempt that has not started yet is refused outright.
 */
function sendOptions(context: ObjectStoreOperationContext): { abortSignal?: AbortSignal } {
  return context.signal ? { abortSignal: context.signal } : {};
}

export class CloudflareR2ObjectStoreWriter implements ObjectStoreWriter {
  private readonly client: S3SendClient;
  private readonly bucket: string;

  constructor(config: CloudflareR2Config, overrideClient?: S3SendClient) {
    let validConfig;
    try {
      validConfig = CloudflareR2ConfigSchema.parse(config);
    } catch (error) {
      throw new CloudflareR2Error("Invalid Cloudflare R2 configuration", error);
    }

    this.bucket = validConfig.bucket;

    const jurisdictionSuffix = validConfig.jurisdiction === "eu" ? ".eu" : validConfig.jurisdiction === "us" ? ".us" : "";
    const endpoint = `https://${validConfig.accountId}${jurisdictionSuffix}.r2.cloudflarestorage.com`;

    if (overrideClient) {
      this.client = overrideClient;
    } else {
      this.client = new S3Client(
        buildR2S3ClientConfig({
          endpoint,
          credentials: {
            accessKeyId: validConfig.accessKeyId,
            secretAccessKey: validConfig.secretAccessKey,
            sessionToken: validConfig.sessionToken,
          },
        }),
      );
    }
  }

  async put(input: ObjectStorePutInput, context: ObjectStoreOperationContext = {}): Promise<void> {
    let validated: ObjectStorePutInput;
    try {
      validated = ObjectStorePutInputSchema.parse(input);
    } catch (error) {
      throw new CloudflareR2Error("Invalid put input", error);
    }

    // An operation aborted before it starts builds no request and reads nothing.
    if (context.signal?.aborted) throw new CloudflareR2Error("Put aborted");

    // LD-2b: the request body is created here and torn down here. On an abort
    // the SDK destroys the REQUEST but never its body, which would otherwise
    // stay paused mid-file. Destroying it on every outcome stops all further
    // reads at once and returns the source's iterator, which closes a file
    // stream that iteration had started; a body that completed has already
    // ended, so for a success this is a no-op.
    const body = Readable.from(validated.body);
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: validated.objectKey,
        ContentLength: validated.contentLength,
        ContentType: validated.contentType,
        ContentDisposition: validated.contentDisposition,
        Body: body,
      });
      await this.client.send(command, sendOptions(context));
    } catch (error) {
      throw new CloudflareR2Error("Failed to put object", error);
    } finally {
      body.destroy();
    }
  }

  async head(objectKey: WorkerObjectKey, context: ObjectStoreOperationContext = {}): Promise<ObjectStoreHead | null> {
    let validatedKey: WorkerObjectKey;
    try {
      validatedKey = WorkerObjectKeySchema.parse(objectKey);
    } catch (error) {
      throw new CloudflareR2Error("Invalid object key", error);
    }

    if (context.signal?.aborted) throw new CloudflareR2Error("Head aborted");

    let response: any;
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: validatedKey,
      });
      response = await this.client.send(command, sendOptions(context));
    } catch (error: any) {
      const status = error?.$metadata?.httpStatusCode;
      if (
        status === 404 &&
        (error.name === "NotFound" || error.name === "NoSuchKey")
      ) {
        return null;
      }
      throw new CloudflareR2Error("Failed to head object", error);
    }

    try {
      return ObjectStoreHeadSchema.parse({
        objectKey: validatedKey,
        contentLength: response.ContentLength,
        contentType: response.ContentType,
        contentDisposition: response.ContentDisposition,
      });
    } catch (error) {
      throw new CloudflareR2Error("Invalid head response", error);
    }
  }

  async delete(objectKey: WorkerObjectKey, context: ObjectStoreOperationContext = {}): Promise<void> {
    let validatedKey: WorkerObjectKey;
    try {
      validatedKey = WorkerObjectKeySchema.parse(objectKey);
    } catch (error) {
      throw new CloudflareR2Error("Invalid object key", error);
    }

    if (context.signal?.aborted) throw new CloudflareR2Error("Delete aborted");

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: validatedKey,
      });
      await this.client.send(command, sendOptions(context));
    } catch (error) {
      throw new CloudflareR2Error("Failed to delete object", error);
    }
  }
}
