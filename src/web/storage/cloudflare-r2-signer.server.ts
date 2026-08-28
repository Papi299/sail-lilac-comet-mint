import { z } from "zod";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "../../lib/errors.ts";
import { WorkerObjectKeySchema } from "../../shared/worker/contracts.ts";
import type { ObjectStoreSigner } from "./object-store-signer.server.ts";

export const CloudflareR2SignerConfigSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/, "accountId must be 32 hex lowercase chars"),
  bucket: z.string().regex(/^[a-z0-9-]{3,63}$/, "bucket must be 3-63 lowercase alphanumeric or hyphens"),
  jurisdiction: z.enum(["default", "eu", "us"]).default("default"),
  accessKeyId: z.string().min(1).max(128),
  secretAccessKey: z.string().min(1).max(128),
  sessionToken: z.string().min(1).max(2048).optional(),
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

  public async signGet(input: { objectKey: string; expiresAt: number }): Promise<{ url: string; expiresAt: number }> {
    const objectKey = WorkerObjectKeySchema.parse(input.objectKey);
    const nowMs = Date.now();
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
    if (decodeURIComponent(derivedKey) !== objectKey) {
       throw new AppError("PROCESSING_FAILED");
    }

    if (!url.searchParams.has("X-Amz-Signature")) {
      throw new AppError("PROCESSING_FAILED");
    }

    return {
      url: urlStr,
      expiresAt: signedExpiresAtMs,
    };
  }
}
