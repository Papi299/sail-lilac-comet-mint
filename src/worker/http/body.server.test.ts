import { test } from "node:test";
import assert from "node:assert";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readBoundedRawBody, PayloadTooLargeError, UnsupportedMediaTypeError } from "./body.server.ts";
import { WORKER_CONTROL_MAX_BODY_BYTES } from "../../shared/worker/constants.ts";
import type { IncomingMessage } from "node:http";

function createMockReq(headers: Record<string, string>): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  req.headers = headers;
  return req;
}

test("bounded raw body reading", async (t) => {
  await t.test("reads valid body", async () => {
    const req = createMockReq({ "content-length": "11" });
    const p = readBoundedRawBody(req);
    req.emit("data", Buffer.from("hello "));
    req.emit("data", Buffer.from("world"));
    req.emit("end");
    const result = await p;
    assert.strictEqual(result.toString(), "hello world");
  });

  await t.test("rejects over limit content-length", async () => {
    const req = createMockReq({ "content-length": String(WORKER_CONTROL_MAX_BODY_BYTES + 1) });
    await assert.rejects(readBoundedRawBody(req), PayloadTooLargeError);
  });

  await t.test("rejects unsupported content-encoding", async () => {
    const req = createMockReq({ "content-encoding": "gzip" });
    await assert.rejects(readBoundedRawBody(req), UnsupportedMediaTypeError);
  });

  await t.test("rejects streamed body over limit", async () => {
    const req = createMockReq({});
    const p = readBoundedRawBody(req);
    req.emit("data", Buffer.alloc(WORKER_CONTROL_MAX_BODY_BYTES));
    req.emit("data", Buffer.alloc(1));
    await assert.rejects(p, PayloadTooLargeError);
  });

  await t.test("accepts identity encoding", async () => {
    const req = createMockReq({ "content-encoding": "identity" });
    const p = readBoundedRawBody(req);
    req.emit("data", Buffer.from("ok"));
    req.emit("end");
    const result = await p;
    assert.strictEqual(result.toString(), "ok");
  });
});
