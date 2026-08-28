import { z } from "zod";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "../../lib/errors.ts";
import { WorkerObjectKeySchema, type WorkerObjectKey } from "../../shared/worker/contracts.ts";
import type { ObjectStoreSigner } from "./object-store-signer.server.ts";

export const CloudflareR2SignerConfigSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/, "accountId must be 32 hex lowercase chars"),
  bucket: z.string().regex(/^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/, "bucket must be 3-63 lowercase alphanumeric or hyphens, no leading/trailing hyphen"),
  jurisdiction: z.enum(["default", "eu", "us"]).default("default"),
  accessKeyId: z.string().min(1).max(8192),
  secretAccessKey: z.string().min(1).max(8192),
  sessionToken: z.string().min(1).max(8192).optional(),
  clock: z.custom<() => number>((val) => typeof val === "function").optional(),
}).strict();

export type CloudflareR2SignerConfig = z.input<typeof CloudflareR2SignerConfigSchema>;

export class CloudflareR2Signer implements ObjectStoreSigner {
  private config: z.output<typeof CloudflareR2SignerConfigSchema>;
  private s3Client: S3Client;
  private endpointHost: string;
  private presignerImpl: typeof getSignedUrl;

  constructor(config: CloudflareR2SignerConfig, presignerImpl?: typeof getSignedUrl) {
    this.config = CloudflareR2SignerConfigSchema.parse(config);
    this.presignerImpl = presignerImpl ?? getSignedUrl;

    let hostPrefix = "";
    if (this.config.jurisdiction === "eu") hostPrefix = "eu.";
    else if (this.config.jurisdiction === "us") hostPrefix = "us.";
    this.endpointHost = `${this.config.accountId}.${hostPrefix}r2.cloudflarestorage.com`;
    const endpoint = `https://${this.endpointHost}`;

    this.s3Client = new S3Client({
      region: "auto",
      endpoint: endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
        sessionToken: this.config.sessionToken,
      },
    });
  }

  private getNowMs(): number {
    const now = this.config.clock ? this.config.clock() : Date.now();
    if (!Number.isFinite(now) || !Number.isSafeInteger(now) || now < 0) {
      throw new Error("Invalid clock value");
    }
    return now;
  }

  public async signGet(input: { objectKey: WorkerObjectKey; expiresAt: number }): Promise<{ url: string; expiresAt: number }> {
    const objectKey = WorkerObjectKeySchema.parse(input.objectKey);

    if (!Number.isFinite(input.expiresAt) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) {
      throw new AppError("PROCESSING_FAILED");
    }

    const nowMs = this.getNowMs();
    const remainingMs = input.expiresAt - nowMs;

    if (remainingMs <= 0) {
      throw new AppError("EXPIRED");
    }

    let ttlSeconds = Math.floor(remainingMs / 1000);
    if (ttlSeconds < 1) {
      throw new AppError("EXPIRED");
    }

    ttlSeconds = Math.min(300, ttlSeconds);
    const signedExpiresAtMs = nowMs + ttlSeconds * 1000;

    if (signedExpiresAtMs > input.expiresAt) {
      throw new AppError("EXPIRED");
    }

    const signingDate = new Date(nowMs);

    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
    });

    let urlStr: string;
    try {
      urlStr = await this.presignerImpl(this.s3Client, command, {
        expiresIn: ttlSeconds,
        signingDate,
      });
    } catch {
      throw new AppError("PROCESSING_FAILED");
    }

    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      throw new AppError("PROCESSING_FAILED");
    }

    if (url.protocol !== "https:") {
      throw new AppError("PROCESSING_FAILED");
    }
    if (url.hostname !== this.endpointHost) {
      throw new AppError("PROCESSING_FAILED");
    }
    if (url.username || url.password) {
      throw new AppError("PROCESSING_FAILED");
    }
    if (url.hash) {
      throw new AppError("PROCESSING_FAILED");
    }

    const pathnameParts = url.pathname.split('/');
    if (pathnameParts.length < 3 || pathnameParts[1] !== this.config.bucket) {
       throw new AppError("PROCESSING_FAILED");
    }

    const derivedKey = url.pathname.substring(this.config.bucket.length + 2); // /bucket/key -> key
    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(derivedKey);
    } catch {
      throw new AppError("PROCESSING_FAILED");
    }
    if (decodedKey !== objectKey) {
       throw new AppError("PROCESSING_FAILED");
    }

    const searchParams = url.searchParams;
    const amzExpires = searchParams.getAll("X-Amz-Expires");
    if (amzExpires.length !== 1) {
      throw new AppError("PROCESSING_FAILED");
    }
    if (!/^(0|[1-9][0-9]*)$/.test(amzExpires[0])) {
      throw new AppError("PROCESSING_FAILED");
    }
    const actualExpires = Number(amzExpires[0]);
    if (actualExpires !== ttlSeconds || actualExpires < 1 || actualExpires > 300) {
      throw new AppError("PROCESSING_FAILED");
    }

    const amzDate = searchParams.getAll("X-Amz-Date");
    if (amzDate.length !== 1) {
      throw new AppError("PROCESSING_FAILED");
    }
    const expectedDate = signingDate.toISOString().replace(/[:-]/g, "").split(".")[0] + "Z";
    if (amzDate[0] !== expectedDate) {
      throw new AppError("PROCESSING_FAILED");
    }

    const amzAlgorithm = searchParams.getAll("X-Amz-Algorithm");
    if (amzAlgorithm.length !== 1 || amzAlgorithm[0] !== "AWS4-HMAC-SHA256") {
      throw new AppError("PROCESSING_FAILED");
    }

    const amzSignature = searchParams.getAll("X-Amz-Signature");
    if (amzSignature.length !== 1 || !/^[0-9a-f]{64}$/i.test(amzSignature[0])) {
      throw new AppError("PROCESSING_FAILED");
    }

    return {
      url: urlStr,
      expiresAt: signedExpiresAtMs,
    };
  }
}
