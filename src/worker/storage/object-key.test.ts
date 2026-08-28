import { describe, it } from "node:test";
import * as assert from "node:assert";
import { generateWorkerObjectKey } from "./object-key.ts";

describe("generateWorkerObjectKey", () => {
  const validJobId = "00000000000000000000000000000000";

  it("generates expected exact key given valid ID and deterministic bytes", () => {
    const bytes = new Uint8Array(16);
    bytes.fill(0xAA);
    
    const key = generateWorkerObjectKey(validJobId, () => bytes);
    assert.strictEqual(key, "videofetch/jobs/00000000000000000000000000000000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("rejects invalid job ID", () => {
    assert.throws(() => generateWorkerObjectKey("invalid-job-id"), /hex/i);
  });

  it("rejects random source < 16 bytes", () => {
    assert.throws(() => generateWorkerObjectKey(validJobId, () => new Uint8Array(15)), /exactly 16 bytes/i);
  });

  it("rejects random source > 16 bytes", () => {
    assert.throws(() => generateWorkerObjectKey(validJobId, () => new Uint8Array(17)), /exactly 16 bytes/i);
  });

  it("key contains no title, url, principal, filename", () => {
    const bytes = new Uint8Array(16);
    bytes.fill(0);
    const key = generateWorkerObjectKey(validJobId, () => bytes);
    assert.ok(!key.includes("title"));
    assert.ok(!key.includes("http"));
    assert.ok(!key.includes("principal"));
    assert.ok(!key.includes("file.mp4"));
  });
});
