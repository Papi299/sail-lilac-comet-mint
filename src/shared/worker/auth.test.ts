import test from "node:test";
import assert from "node:assert";
import {
  buildWorkerSigningInput,
  sha256WorkerBody,
  WorkerRequestIdSchema,
  WorkerIdempotencyKeySchema,
  WorkerKeyIdSchema,
  WorkerCanonicalPathSchema,
} from "./auth.ts";

test("HMAC Auth Contract - sha256WorkerBody", async (t) => {
  await t.test("hashes exact string properly", () => {
    const hash = sha256WorkerBody("test");
    assert.strictEqual(hash.length, 64);
    assert.strictEqual(hash, "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });

  await t.test("different JSON formatting yields different hashes", () => {
    const h1 = sha256WorkerBody('{"a":1}');
    const h2 = sha256WorkerBody('{ "a": 1 }');
    assert.notStrictEqual(h1, h2);
  });
});

test("HMAC Auth Contract - schema validation", async (t) => {
  await t.test("UUID requires correct format", () => {
    assert.doesNotThrow(() => WorkerRequestIdSchema.parse("123e4567-e89b-12d3-a456-426614174000"));
    assert.doesNotThrow(() => WorkerIdempotencyKeySchema.parse("123e4567-e89b-12d3-a456-426614174000"));
    assert.throws(() => WorkerRequestIdSchema.parse("not-a-uuid"));
    assert.throws(() => WorkerRequestIdSchema.parse("123e4567-e89b-12d3-a456-426614174000\n"));
  });

  await t.test("Key ID enforces ascii bounds and blocks newlines", () => {
    assert.doesNotThrow(() => WorkerKeyIdSchema.parse("key-1.0_A"));
    assert.throws(() => WorkerKeyIdSchema.parse("key\n1"));
    assert.throws(() => WorkerKeyIdSchema.parse(""));
  });

  await t.test("Canonical path rejects query and hash", () => {
    assert.doesNotThrow(() => WorkerCanonicalPathSchema.parse("/v1/jobs"));
    assert.throws(() => WorkerCanonicalPathSchema.parse("/v1/jobs?foo=bar"));
    assert.throws(() => WorkerCanonicalPathSchema.parse("/v1/jobs#hash"));
    assert.throws(() => WorkerCanonicalPathSchema.parse("v1/jobs"));
  });
});

test("HMAC Auth Contract - buildWorkerSigningInput", async (t) => {
  const baseParams = {
    keyId: "test-key-id",
    method: "POST" as const,
    canonicalPath: "/v1/jobs",
    timestampSeconds: 1600000000,
    requestId: "123e4567-e89b-12d3-a456-426614174000",
    idempotencyKey: "888e4567-e89b-12d3-a456-426614174000",
    sha256RawBody: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  };

  await t.test("builds exact canonical signing string", () => {
    const out = buildWorkerSigningInput(baseParams);
    const expected = [
      "v1",
      "test-key-id",
      "POST",
      "/v1/jobs",
      "1600000000",
      "123e4567-e89b-12d3-a456-426614174000",
      "888e4567-e89b-12d3-a456-426614174000",
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    ].join("\n");
    assert.strictEqual(out, expected);
    assert.ok(!out.endsWith("\n"));
  });

  await t.test("normalizes method to uppercase", () => {
    // @ts-expect-error Testing runtime lowercase behavior
    const out = buildWorkerSigningInput({ ...baseParams, method: "post" });
    assert.ok(out.includes("\nPOST\n"));
  });

  await t.test("absent idempotency key produces empty string field", () => {
    const out = buildWorkerSigningInput({ ...baseParams, idempotencyKey: undefined });
    assert.ok(out.includes("\n123e4567-e89b-12d3-a456-426614174000\n\n9f86d0"));
  });

  await t.test("rejects invalid hash length", () => {
    assert.throws(() => buildWorkerSigningInput({ ...baseParams, sha256RawBody: "too-short" }));
  });
});
