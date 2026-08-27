import { test } from "node:test";
import assert from "node:assert";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { readBoundedRawBody, PayloadTooLargeError, UnsupportedMediaTypeError, MalformedContentLengthError } from "./body.server.ts";
import { WORKER_CONTROL_MAX_BODY_BYTES } from "../../shared/worker/constants.ts";
import type { IncomingMessage } from "node:http";

function createMockReq(headers: Record<string, string>): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  req.headers = headers;
  (req as any).resume = () => {};
  return req;
}

function createMockReqWithResumeSpy(headers: Record<string, string>): { req: IncomingMessage & EventEmitter; resumeCalled: () => boolean } {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  req.headers = headers;
  let called = false;
  (req as any).resume = () => { called = true; };
  return { req, resumeCalled: () => called };
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

  await t.test("accepts exactly max bytes", async () => {
    const req = createMockReq({ "content-length": String(WORKER_CONTROL_MAX_BODY_BYTES) });
    const p = readBoundedRawBody(req);
    req.emit("data", Buffer.alloc(WORKER_CONTROL_MAX_BODY_BYTES));
    req.emit("end");
    const result = await p;
    assert.strictEqual(result.length, WORKER_CONTROL_MAX_BODY_BYTES);
  });

  await t.test("rejects over limit content-length and drains", async () => {
    const { req, resumeCalled } = createMockReqWithResumeSpy({ "content-length": String(WORKER_CONTROL_MAX_BODY_BYTES + 1) });
    await assert.rejects(readBoundedRawBody(req), PayloadTooLargeError);
    assert.ok(resumeCalled(), "req.resume() must be called to drain");
  });

  await t.test("rejects malformed content-length", async () => {
    await assert.rejects(readBoundedRawBody(createMockReq({ "content-length": "-1" })), MalformedContentLengthError);
    await assert.rejects(readBoundedRawBody(createMockReq({ "content-length": "+10" })), MalformedContentLengthError);
    await assert.rejects(readBoundedRawBody(createMockReq({ "content-length": "10x" })), MalformedContentLengthError);
    await assert.rejects(readBoundedRawBody(createMockReq({ "content-length": "1.5" })), MalformedContentLengthError);
    await assert.rejects(readBoundedRawBody(createMockReq({ "content-length": " 10" })), MalformedContentLengthError);
    await assert.rejects(readBoundedRawBody(createMockReq({ "content-length": "999999999999999999999999" })), MalformedContentLengthError);
  });

  await t.test("rejects unsupported content-encoding", async () => {
    const req = createMockReq({ "content-encoding": "gzip" });
    await assert.rejects(readBoundedRawBody(req), UnsupportedMediaTypeError);
  });

  await t.test("rejects streamed body over limit and drains", async () => {
    const { req, resumeCalled } = createMockReqWithResumeSpy({});
    const p = readBoundedRawBody(req);
    req.emit("data", Buffer.alloc(WORKER_CONTROL_MAX_BODY_BYTES));
    req.emit("data", Buffer.alloc(1));
    await assert.rejects(p, PayloadTooLargeError);
    assert.ok(resumeCalled(), "req.resume() must be called to drain streaming overflow");
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
