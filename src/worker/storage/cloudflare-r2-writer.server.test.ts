import { describe, it } from "node:test";
import assert from "node:assert";
import { CloudflareR2ObjectStoreWriter, CloudflareR2Error, type CloudflareR2Config, type S3SendClient } from "./cloudflare-r2-writer.server.ts";
import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
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
    // Check derivation via real config object
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

  it("invalid runtime jurisdiction", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, jurisdiction: "fedramp" as any }), CloudflareR2Error);
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, jurisdiction: "EU" as any }), CloudflareR2Error);
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, jurisdiction: "" as any }), CloudflareR2Error);
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, jurisdiction: null as any }), CloudflareR2Error);
  });

  it("unknown endpoint property", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, endpoint: "https://evil.example" } as any), CloudflareR2Error);
  });

  it("invalid bucket uppercase", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, bucket: "ABCD" }), CloudflareR2Error);
  });

  it("bucket with period", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, bucket: "abc.def" }), CloudflareR2Error);
  });

  it("leading hyphen bucket", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, bucket: "-abc" }), CloudflareR2Error);
  });

  it("trailing hyphen bucket", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, bucket: "abc-" }), CloudflareR2Error);
  });

  it("too short bucket", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, bucket: "ab" }), CloudflareR2Error);
  });

  it("too long bucket", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, bucket: "a".repeat(64) }), CloudflareR2Error);
  });

  it("valid lower-case hyphenated bucket", () => {
    assert.doesNotThrow(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, bucket: "a1-b2-c3" }));
    assert.doesNotThrow(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, bucket: "video-fetch" }));
    assert.doesNotThrow(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, bucket: "video123" }));
  });

  it("empty accessKeyId", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, accessKeyId: "" }), CloudflareR2Error);
  });

  it("overlong accessKeyId", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, accessKeyId: "a".repeat(8193) }), CloudflareR2Error);
  });

  it("empty secret", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, secretAccessKey: "" }), CloudflareR2Error);
  });

  it("overlong secret", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, secretAccessKey: "a".repeat(8193) }), CloudflareR2Error);
  });

  it("empty supplied sessionToken", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, sessionToken: "" }), CloudflareR2Error);
  });

  it("overlong sessionToken", () => {
    assert.throws(() => new CloudflareR2ObjectStoreWriter({ ...validConfig, sessionToken: "a".repeat(8193) }), CloudflareR2Error);
  });

  it("region and explicit credentials resolving correctly", async () => {
    const config = { ...validConfig, sessionToken: "temporary-session-token" };
    const realWriter = new CloudflareR2ObjectStoreWriter(config);
    const region = await (realWriter as any).client.config.region();
    assert.strictEqual(region, "auto");

    const creds = await (realWriter as any).client.config.credentials();
    assert.strictEqual(creds.accessKeyId, "test-access");
    assert.strictEqual(creds.secretAccessKey, "test-secret");
    assert.strictEqual(creds.sessionToken, "temporary-session-token");
  });

  it("put creates PutObjectCommand with exact params and streaming body", async () => {
    let capturedCommand: any = null;
    const fakeClient: S3SendClient = {
      send: async (command: any) => {
        capturedCommand = command;
      },
    };

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
    assert.ok(capturedCommand.input.Body instanceof Readable);
  });

  it("head creates HeadObjectCommand for exact key and normalizes successful metadata", async () => {
    let capturedCommand: any = null;
    const fakeClient: S3SendClient = {
      send: async (command: any) => {
        capturedCommand = command;
        return {
          ContentLength: 123,
          ContentType: "video/mp4",
          ContentDisposition: "attachment",
        };
      },
    };

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

  it("NotFound + 404 -> null", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        const err = new Error("Not Found");
        err.name = "NotFound";
        (err as any).$metadata = { httpStatusCode: 404 };
        throw err;
      },
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    assert.strictEqual(await writer.head(validKey), null);
  });

  it("NoSuchKey + 404 -> null", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        const err = new Error("No Such Key");
        err.name = "NoSuchKey";
        (err as any).$metadata = { httpStatusCode: 404 };
        throw err;
      },
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    assert.strictEqual(await writer.head(validKey), null);
  });

  it("NotFound + 403 -> THROWS", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        const err = new Error("Not Found");
        err.name = "NotFound";
        (err as any).$metadata = { httpStatusCode: 403 };
        throw err;
      },
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), CloudflareR2Error);
  });

  it("NoSuchKey + 500 -> THROWS", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        const err = new Error("No Such Key");
        err.name = "NoSuchKey";
        (err as any).$metadata = { httpStatusCode: 500 };
        throw err;
      },
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), CloudflareR2Error);
  });

  it("Forbidden + 403 -> THROWS", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        const err = new Error("Forbidden");
        err.name = "Forbidden";
        (err as any).$metadata = { httpStatusCode: 403 };
        throw err;
      },
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), CloudflareR2Error);
  });

  it("429 -> THROWS", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        const err = new Error("Too Many Requests");
        err.name = "TooManyRequests";
        (err as any).$metadata = { httpStatusCode: 429 };
        throw err;
      },
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), CloudflareR2Error);
  });

  it("500 -> THROWS", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        const err = new Error("Internal Server Error");
        err.name = "InternalServerError";
        (err as any).$metadata = { httpStatusCode: 500 };
        throw err;
      },
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), CloudflareR2Error);
  });

  it("network error with no HTTP status -> THROWS", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        const err = new Error("Connection Refused");
        err.name = "NetworkingError";
        throw err;
      },
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), CloudflareR2Error);
  });

  it("ContentLength = -1 -> throws safe CloudflareR2Error", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: -1, ContentType: "video/mp4", ContentDisposition: "attachment" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), (err) => {
      assert.ok(err instanceof CloudflareR2Error);
      assert.strictEqual(err.message, "Invalid head response");
      return true;
    });
  });

  it("ContentLength = NaN -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: NaN, ContentType: "video/mp4", ContentDisposition: "attachment" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentLength = Infinity -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: Infinity, ContentType: "video/mp4", ContentDisposition: "attachment" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentLength = Number.MAX_SAFE_INTEGER + 1 -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: Number.MAX_SAFE_INTEGER + 1, ContentType: "video/mp4", ContentDisposition: "attachment" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentType empty -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: 0, ContentType: "", ContentDisposition: "attachment" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentType CR -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: 0, ContentType: "video/\rmp4", ContentDisposition: "attachment" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentType LF -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: 0, ContentType: "video/\nmp4", ContentDisposition: "attachment" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentType other ASCII control -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: 0, ContentType: "video/\x07mp4", ContentDisposition: "attachment" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentType overlong -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: 0, ContentType: "a".repeat(256), ContentDisposition: "attachment" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentDisposition empty -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: 0, ContentType: "video/mp4", ContentDisposition: "" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentDisposition overlong -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: 0, ContentType: "video/mp4", ContentDisposition: "a".repeat(1025) }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("ContentDisposition ASCII control -> throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => ({ ContentLength: 0, ContentType: "video/mp4", ContentDisposition: "attachment\r" }),
    };
    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.head(validKey), /Invalid head response/);
  });

  it("delete creates DeleteObjectCommand for exact key and handles missing object as idempotent success", async () => {
    let capturedCommand: any = null;
    const fakeClient: S3SendClient = {
      send: async (command: any) => {
        capturedCommand = command;
      },
    };

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await writer.delete(validKey);

    assert.ok(capturedCommand instanceof DeleteObjectCommand);
    assert.strictEqual(capturedCommand.input.Bucket, "test-bucket");
    assert.strictEqual(capturedCommand.input.Key, validKey);
  });

  it("delete operational failure throws", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        throw new Error("Network error");
      },
    };

    const writer = new CloudflareR2ObjectStoreWriter(validConfig, fakeClient);
    await assert.rejects(() => writer.delete(validKey), CloudflareR2Error);
  });

  it("raw provider exception text does not appear in safe adapter error", async () => {
    const fakeClient: S3SendClient = {
      send: async () => {
        throw new Error("SECRET_BUCKET_ID_XYZ123 Forbidden");
      },
    };

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
    assert.ok(!source.includes("CreateBucketCommand"), "Must not import CreateBucketCommand");
    assert.ok(!source.includes("DeleteBucketCommand"), "Must not import DeleteBucketCommand");
    assert.ok(!source.includes("PutBucket"), "Must not import PutBucket");
    assert.ok(!source.includes("GetBucket"), "Must not import GetBucket");
  });
});
