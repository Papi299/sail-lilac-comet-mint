import { test } from "node:test";
import assert from "node:assert";

import { createWorkerSignatureHex, verifyWorkerSignature } from "./hmac.server.ts";
import type { SigningInputParams } from "./auth.ts";

test("HMAC server primitives", async (t) => {
  const secret = "0123456789abcdef0123456789abcdef"; // 32 bytes
  const params: SigningInputParams = {
    keyId: "key-1",
    method: "POST",
    canonicalPath: "/v1/analyze",
    timestampSeconds: "1700000000",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    sha256RawBody: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // empty body hash
  };

  await t.test("generates and verifies correctly", () => {
    const signature = createWorkerSignatureHex(secret, params);
    assert.strictEqual(signature.length, 64);
    assert.match(signature, /^[0-9a-f]{64}$/);

    assert.ok(verifyWorkerSignature(secret, params, signature));
  });

  await t.test("fails on wrong secret", () => {
    const signature = createWorkerSignatureHex(secret, params);
    assert.strictEqual(verifyWorkerSignature(secret + "a", params, signature), false);
  });

  await t.test("fails on tampered params", () => {
    const signature = createWorkerSignatureHex(secret, params);
    const tamperedParams = { ...params, method: "GET" as "GET" | "POST" };
    assert.strictEqual(verifyWorkerSignature(secret, tamperedParams, signature), false);
  });

  await t.test("fails on malformed signature format", () => {
    assert.strictEqual(verifyWorkerSignature(secret, params, "not-a-hex-string"), false);
    assert.strictEqual(verifyWorkerSignature(secret, params, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85"), false); // 63 chars
  });
});
