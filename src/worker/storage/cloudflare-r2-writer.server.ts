import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { ObjectStoreWriter, ObjectStorePutInput, ObjectStoreHead } from "./writer.js";
import type { WorkerObjectKey } from "../../shared/worker/contracts.js";
import { Readable } from "node:stream";

export type R2Jurisdiction = "default" | "eu" | "us";

export interface CloudflareR2Config {
  accountId: string;
  bucket: string;
  jurisdiction?: R2Jurisdiction;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export class CloudflareR2Error extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CloudflareR2Error";
  }
}

export class CloudflareR2ObjectStoreWriter implements ObjectStoreWriter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: CloudflareR2Config, overrideClient?: S3Client) {
    if (!config.accountId || !/^[a-f0-9]{32}$/i.test(config.accountId)) {
      throw new CloudflareR2Error("Invalid account ID");
    }
    if (!config.bucket || !/^[a-z0-9.-]{3,63}$/i.test(config.bucket)) {
      throw new CloudflareR2Error("Invalid bucket name");
    }
    if (!config.accessKeyId) {
      throw new CloudflareR2Error("Missing accessKeyId");
    }
    if (!config.secretAccessKey) {
      throw new CloudflareR2Error("Missing secretAccessKey");
    }

    this.bucket = config.bucket;

    const jurisdiction = config.jurisdiction === "eu" ? ".eu" : config.jurisdiction === "us" ? ".us" : "";
    const endpoint = `https://${config.accountId}${jurisdiction}.r2.cloudflarestorage.com`;

    if (overrideClient) {
      this.client = overrideClient;
    } else {
      this.client = new S3Client({
        region: "auto",
        endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          sessionToken: config.sessionToken,
        },
      });
    }
  }

  async put(input: ObjectStorePutInput): Promise<void> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ContentLength: input.contentLength,
        ContentType: input.contentType,
        ContentDisposition: input.contentDisposition,
        Body: Readable.from(input.body),
      });
      await this.client.send(command);
    } catch (error) {
      throw new CloudflareR2Error("Failed to put object", error);
    }
  }

  async head(objectKey: WorkerObjectKey): Promise<ObjectStoreHead | null> {
    let response: any;
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      });
      response = await this.client.send(command);
    } catch (error: any) {
      if (error?.name === "NotFound" || error?.name === "NoSuchKey") {
        return null;
      }
      throw new CloudflareR2Error("Failed to head object", error);
    }

    if (response.ContentLength === undefined) {
      throw new CloudflareR2Error("Missing ContentLength in head response");
    }
    if (!response.ContentType) {
      throw new CloudflareR2Error("Missing ContentType in head response");
    }
    if (!response.ContentDisposition) {
      throw new CloudflareR2Error("Missing ContentDisposition in head response");
    }

    return {
      objectKey,
      contentLength: response.ContentLength,
      contentType: response.ContentType,
      contentDisposition: response.ContentDisposition,
    };
  }

  async delete(objectKey: WorkerObjectKey): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      });
      await this.client.send(command);
    } catch (error) {
      throw new CloudflareR2Error("Failed to delete object", error);
    }
  }
}
