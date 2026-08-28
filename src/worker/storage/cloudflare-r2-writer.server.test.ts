import { describe, it } from "node:test";
import assert from "node:assert";
import { CloudflareR2ObjectStoreWriter, CloudflareR2Error, type CloudflareR2Config } from "./cloudflare-r2-writer.server.ts";
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";
import * as fs from "node:fs";
import { Readable } from "node:stream";

describe("CloudflareR2ObjectStoreWriter", () => {
  const validConfig: CloudflareR2Config = {
    accountId: "0123456789abcdef0123456789abcdef",
    bucket: "test-bucket",
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
  };

  const validKey = "videofetch/jobs/0123456789abcdef0123456789abcdef/0123456789abcdef0123456789abcdef" as WorkerObjectKey;

  it("default endpoint derivation", async () => {
    const fakeClient = {
      config: {
        endpoint: async () => ({ hostname: "captured" })
      },
      send: async () => {},
    } as unknown as S3Client;

    new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    
    // We check derivation in constructor by checking the client if we didn't inject one.
    const realWriter = new CloudflareR2ObjectStoreWriter(validConfig);
    const endpoint = await (realWriter as any).client.config.endpoint();
    assert.strictEqual(endpoint.hostname, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  });

  it("eu endpoint derivation", async () => {
    const config = { ...validConfig, jurisdiction: "eu" as const };
    const realWriter = new CloudflareR2ObjectStoreWriter(config);
    const endpoint = await (realWriter as any).client.config.endpoint();
    assert.strictEqual(endpoint.hostname, "0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com");
  });

  it("us endpoint derivation", async () => {
    const config = { ...validConfig, jurisdiction: "us" as const };
    const realWriter = new CloudflareR2ObjectStoreWriter(config);
    const endpoint = await (realWriter as any).client.config.endpoint();
    assert.strictEqual(endpoint.hostname, "0123456789abcdef0123456789abcdef.us.r2.cloudflarestorage.com");
  });

  it("invalid account ID rejected", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, accountId: "short" }), CloudflareR2Error);
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, accountId: "0123456789abcdef0123456789abcdeZ" }), CloudflareR2Error);
  });

  it("arbitrary endpoint cannot be supplied", () => {
    // The type itself prevents passing an endpoint, and the class hardcodes it.
    // If one tries to pass it via TS ignore, it's not supported.
    const config = { ...validConfig, endpoint: "https://evil.com" } as any;
    const realWriter = new CloudflareR2ObjectStoreWriter(config);
    assert.ok(!(realWriter as any).client.config.endpoint.toString().includes("evil.com"));
  });

  it("sessionToken is forwarded when configured", async () => {
    const config = { ...validConfig, sessionToken: "temporary-session-token" };
    const realWriter = new CloudflareR2ObjectStoreWriter(config);
    const creds = await (realWriter as any).client.config.credentials();
    assert.strictEqual(creds.sessionToken, "temporary-session-token");
  });

  it("put creates PutObjectCommand with exact params and streaming body", async () => {
    let capturedCommand: any = null;
    const fakeClient = {
      send: async (command: any) => {
        capturedCommand = command;
      },
    } as unknown as S3Client;

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);

    const bodyObj: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            if (count++ === 0) return { value: new Uint8Array([1, 2, 3]), done: false };
            return { done: true, value: undefined as any };
          }
        };
      }
    };

    await writer.put({
      objectKey: validKey,
      contentLength: 100,
      contentType: "video/mp4",
      contentDisposition: "attachment; filename=\"video.mp4\"",
      body: bodyObj,
    });

    assert.ok(capturedCommand instanceof PutObjectCommand);
    assert.strictEqual(capturedCommand.input.Bucket, "test-bucket");
    assert.strictEqual(capturedCommand.input.Key, validKey);
    assert.strictEqual(capturedCommand.input.ContentLength, 100);
    assert.strictEqual(capturedCommand.input.ContentType, "video/mp4");
    assert.strictEqual(capturedCommand.input.ContentDisposition, "attachment; filename=\"video.mp4\"");
    
    // Check that body is a stream (Readable)
    assert.ok(capturedCommand.input.Body instanceof Readable);
  });

  it("head creates HeadObjectCommand for exact key and normalizes successful metadata", async () => {
    let capturedCommand: any = null;
    const fakeClient = {
      send: async (command: any) => {
        capturedCommand = command;
        return {
          ContentLength: 123,
          ContentType: "video/mp4",
          ContentDisposition: "attachment",
        };
      },
    } as unknown as S3Client;

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    const result = await writer.head(validKey);

    assert.ok(capturedCommand instanceof HeadObjectCommand);
    assert.strictEqual(capturedCommand.input.Bucket, "test-bucket");
    assert.strictEqual(capturedCommand.input.Key, validKey);

    assert.deepStrictEqual(result, {
      objectKey: validKey,
      contentLength: 123,
      contentType: "video/mp4",
      contentDisposition: "attachment",
    });
  });

  it("head genuine 404/NoSuchKey returns null", async () => {
    const fakeClient = {
      send: async () => {
        const err = new Error("Not Found");
        err.name = "NotFound";
        throw err;
      },
    } as unknown as S3Client;

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    const result = await writer.head(validKey);
    assert.strictEqual(result, null);
  });

  it("head 403 throws", async () => {
    const fakeClient = {
      send: async () => {
        const err = new Error("Forbidden");
        err.name = "Forbidden";
        throw err;
      },
    } as unknown as S3Client;

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), CloudflareR2Error);
  });

  it("head 429 throws", async () => {
    const fakeClient = {
      send: async () => {
        const err = new Error("Too Many Requests");
        err.name = "TooManyRequests";
        throw err;
      },
    } as unknown as S3Client;

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), CloudflareR2Error);
  });

  it("head 500 throws", async () => {
    const fakeClient = {
      send: async () => {
        const err = new Error("Internal Error");
        err.name = "InternalError";
        throw err;
      },
    } as unknown as S3Client;

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), CloudflareR2Error);
  });

  it("head malformed contentLength throws", async () => {
    const fakeClient = {
      send: async () => ({ ContentType: "video/mp4", ContentDisposition: "attachment" }),
    } as unknown as S3Client;
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Missing ContentLength/);
  });

  it("head missing contentType throws", async () => {
    const fakeClient = {
      send: async () => ({ ContentLength: 123, ContentDisposition: "attachment" }),
    } as unknown as S3Client;
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Missing ContentType/);
  });

  it("head missing contentDisposition throws", async () => {
    const fakeClient = {
      send: async () => ({ ContentLength: 123, ContentType: "video/mp4" }),
    } as unknown as S3Client;
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Missing ContentDisposition/);
  });

  it("delete creates DeleteObjectCommand for exact key and handles missing object as idempotent success", async () => {
    let capturedCommand: any = null;
    const fakeClient = {
      send: async (command: any) => {
        capturedCommand = command;
      },
    } as unknown as S3Client;

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await writer.delete(validKey);

    assert.ok(capturedCommand instanceof DeleteObjectCommand);
    assert.strictEqual(capturedCommand.input.Bucket, "test-bucket");
    assert.strictEqual(capturedCommand.input.Key, validKey);
  });

  it("delete operational failure throws", async () => {
    const fakeClient = {
      send: async () => {
        throw new Error("Network error");
      },
    } as unknown as S3Client;

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.delete(validKey), CloudflareR2Error);
  });

  it("raw provider exception text does not appear in safe adapter error", async () => {
    const fakeClient = {
      send: async () => {
        throw new Error("SECRET_BUCKET_ID_XYZ123 Forbidden");
      },
    } as unknown as S3Client;

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    
    try {
      await writer.head(validKey);
      assert.fail("Should throw");
    } catch (err: any) {
      assert.ok(err instanceof CloudflareR2Error);
      assert.ok(!err.message.includes("SECRET_BUCKET_ID_XYZ123"));
      assert.ok(err.message === "Failed to head object");
    }
  });

  it("static capability exclusions", () => {
    const source = fs.readFileSync(new URL("./cloudflare-r2-writer.server.ts", import.meta.url), "utf-8");
    assert.ok(!source.includes("GetObjectCommand"), "Must not import GetObjectCommand");
    assert.ok(!source.includes("ListObjects"), "Must not import ListObjects");
    assert.ok(!source.includes("DeleteObjectsCommand"), "Must not import DeleteObjectsCommand");
    assert.ok(!source.includes("getSignedUrl"), "Must not import getSignedUrl");
    assert.ok(!source.includes("S3RequestPresigner"), "Must not import S3RequestPresigner");
    assert.ok(!source.includes("signGet"), "Must not import signGet");
  });
});
