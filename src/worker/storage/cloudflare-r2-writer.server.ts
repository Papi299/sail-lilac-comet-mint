import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { ObjectStorePutInputSchema, ObjectStoreHeadSchema, type ObjectStoreWriter, type ObjectStorePutInput, type ObjectStoreHead } from "./writer.ts";
import { WorkerObjectKeySchema, type WorkerObjectKey } from "../../shared/worker/contracts.ts";
import { Readable } from "node:stream";
import { z } from "zod";

export const CloudflareR2ConfigSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/, "Account ID must be 32 lowercase hex characters"),
  bucket: z.string().regex(/^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/, "Invalid bucket name"),
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

export interface S3SendClient {
  send(command: any): Promise<any>;
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
      this.client = new S3Client({
        region: "auto",
        endpoint,
        credentials: {
          accessKeyId: validConfig.accessKeyId,
          secretAccessKey: validConfig.secretAccessKey,
          sessionToken: validConfig.sessionToken,
        },
      });
    }
  }

  async put(input: ObjectStorePutInput): Promise<void> {
    let validated: ObjectStorePutInput;
    try {
      validated = ObjectStorePutInputSchema.parse(input);
    } catch (error) {
      throw new CloudflareR2Error("Invalid put input", error);
    }

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: validated.objectKey,
        ContentLength: validated.contentLength,
        ContentType: validated.contentType,
        ContentDisposition: validated.contentDisposition,
        Body: Readable.from(validated.body),
      });
      await this.client.send(command);
    } catch (error) {
      throw new CloudflareR2Error("Failed to put object", error);
    }
  }

  async head(objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    let validatedKey: WorkerObjectKey;
    try {
      validatedKey = WorkerObjectKeySchema.parse(objectKey);
    } catch (error) {
      throw new CloudflareR2Error("Invalid object key", error);
    }

    let response: any;
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: validatedKey,
      });
      response = await this.client.send(command);
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

  async delete(objectKey: WorkerObjectKey): Promise<void> {
    let validatedKey: WorkerObjectKey;
    try {
      validatedKey = WorkerObjectKeySchema.parse(objectKey);
    } catch (error) {
      throw new CloudflareR2Error("Invalid object key", error);
    }

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: validatedKey,
      });
      await this.client.send(command);
    } catch (error) {
      throw new CloudflareR2Error("Failed to delete object", error);
    }
  }
}
