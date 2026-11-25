import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { CloudflareR2Error, CloudflareR2ObjectStoreWriter, buildR2S3ClientConfig } from "./cloudflare-r2-writer.server.ts";
import { startStubS3Server, type StubHeadLifecycle, type StubS3Server } from "./r2-stub-server.fixtures.ts";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";

/**
 * VIDEOFETCH-LD5B-R2-RETENTION-LIFECYCLE-HARDENING-001 — the HEAD's provider
 * timestamp through the REAL AWS SDK, its REAL request handler and its REAL
 * response deserializer, over a REAL loopback socket, configured exactly as
 * Production (`buildR2S3ClientConfig`; only the endpoint is the loopback stub,
 * path-style). The header strings are R2's own shapes; the C1 case replays the
 * exact strings R2 returned in LD-5a.
 *
 * Fake credentials only. Nothing leaves the test process.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "videofetch-objects";
const KEY = `videofetch/jobs/${"a".repeat(32)}/${"d".repeat(32)}` as WorkerObjectKey;

let stub: StubS3Server | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

async function writerWith(headLifecycle?: StubHeadLifecycle): Promise<CloudflareR2ObjectStoreWriter> {
  stub = await startStubS3Server({ bucket: BUCKET, ...(headLifecycle ? { headLifecycle } : {}) });
  const base = buildR2S3ClientConfig({
    endpoint: stub.endpoint,
    credentials: { accessKeyId: "fake-key-id", secretAccessKey: "fake-secret", sessionToken: "fake-session" },
  });
  const client = new S3Client({ ...base, forcePathStyle: true });
  const writer = new CloudflareR2ObjectStoreWriter(
    { accountId: ACCOUNT_ID, bucket: BUCKET, accessKeyId: "fake-key-id", secretAccessKey: "fake-secret", sessionToken: "fake-session" },
    client,
  );
  await writer.put({
    objectKey: KEY,
    body: (async function* () {
      yield new Uint8Array(8);
    })(),
    contentLength: 8,
    contentType: "video/mp4",
    contentDisposition: 'attachment; filename="clip.mp4"',
  });
  return writer;
}

const invalidHead = (err: unknown) => err instanceof CloudflareR2Error && err.message === "Invalid head response";
const failedHead = (err: unknown) => err instanceof CloudflareR2Error && err.message === "Failed to head object";

describe("LD-5b: the HEAD's Last-Modified through the real SDK over a socket", () => {
  it("R2's shape (Last-Modified at completion, x-amz-expiration = Last-Modified + 3,600 s): the completion instant, whole seconds", async () => {
    const writer = await writerWith();
    const head = await writer.head(KEY);
    const stored = stub!.objects.get(KEY)!;
    assert.equal(head?.lastModifiedAtMs, stored.lastModifiedMs);
    assert.equal(stored.lastModifiedMs % 1000, 0);
    assert.equal(stub!.exchanges.filter((e) => e.method === "HEAD").length, 1, "one HEAD, no extra provider request");
  });

  it("LD-5a C1's exact provider headers replayed: Last-Modified 09:38:51 GMT → 1,795,599,531,000 ms", async () => {
    const writer = await writerWith(() => ({
      lastModified: "Wed, 25 Nov 2026 09:38:51 GMT",
      expiration: 'expiry-date="Wed, 25 Nov 2026 10:38:51 GMT", rule-id="videofetch-expired-job-backstop"',
    }));
    assert.equal((await writer.head(KEY))?.lastModifiedAtMs, 1_795_599_531_000);
  });

  it("no x-amz-expiration (no lifecycle rule reported): accepted, the cap from Last-Modified still applies", async () => {
    const writer = await writerWith(() => ({ lastModified: "Wed, 25 Nov 2026 09:38:51 GMT", expiration: null }));
    assert.equal((await writer.head(KEY))?.lastModifiedAtMs, 1_795_599_531_000);
  });

  it("the asctime form HTTP also allows parses to the same whole second", async () => {
    const writer = await writerWith(() => ({ lastModified: "Wed Nov 25 09:38:51 2026", expiration: null }));
    assert.equal((await writer.head(KEY))?.lastModifiedAtMs, 1_795_599_531_000);
  });

  for (const [label, lastModified] of [
    ["missing", null],
    ["fractional seconds (the SDK accepts them; R2 never sends them)", "Wed, 25 Nov 2026 09:38:51.500 GMT"],
    ["before 1970 (the SDK yields −1,000 ms)", "Wed, 31 Dec 1969 23:59:59 GMT"],
  ] as const) {
    it(`a Last-Modified that is ${label}: Invalid head response — no local time substitutes`, async () => {
      const writer = await writerWith(() => ({ lastModified, expiration: null }));
      await assert.rejects(() => writer.head(KEY), invalidHead);
    });
  }

  for (const [label, lastModified] of [
    ["garbage", "not a date"],
    ["RFC 850", "Wednesday, 25-Nov-26 09:38:51 GMT"],
    ["ISO 8601", "2026-11-25T09:38:51Z"],
    ["epoch seconds", "1795599531"],
  ] as const) {
    it(`a Last-Modified in ${label}: the SDK's own deserializer refuses it → Failed to head object`, async () => {
      const writer = await writerWith(() => ({ lastModified, expiration: null }));
      await assert.rejects(() => writer.head(KEY), failedHead);
      const heads = stub!.exchanges.filter((e) => e.method === "HEAD").length;
      assert.equal(heads, 1, "a deserialization failure is not retried: one HEAD exchange");
    });
  }

  it("the provider's x-amz-expiration is not consumed: an earlier, later or malformed report leaves the head unchanged", async () => {
    for (const expiration of [
      'expiry-date="Wed, 25 Nov 2026 10:38:50 GMT", rule-id="videofetch-expired-job-backstop"',
      'expiry-date="Fri, 27 Nov 2026 00:00:00 GMT", rule-id="longer"',
      "garbage",
    ]) {
      const writer = await writerWith(() => ({ lastModified: "Wed, 25 Nov 2026 09:38:51 GMT", expiration }));
      assert.equal((await writer.head(KEY))?.lastModifiedAtMs, 1_795_599_531_000, expiration);
      await stub!.close();
      stub = null;
    }
  });
});
