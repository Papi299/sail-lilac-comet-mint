import test from "node:test";
import assert from "node:assert/strict";
import { AppError, ERROR_MESSAGES } from "../../lib/errors.ts";
import {
  WORKER_ERROR_CODES,
  WorkerErrorResponseSchema,
} from "../../shared/worker/errors.ts";
import {
  WORKER_ERROR_HTTP_STATUS,
  WorkerBusinessError,
  isWorkerErrorCode,
  toWorkerErrorEnvelope,
} from "./errors.server.ts";

test("every allowlisted worker code has a canonical HTTP status", () => {
  for (const code of WORKER_ERROR_CODES) {
    const status = WORKER_ERROR_HTTP_STATUS[code];
    assert.equal(typeof status, "number", `${code} has no status`);
    assert.ok(status >= 400 && status <= 599, `${code} status ${status} is not an error status`);
  }
  assert.equal(
    Object.keys(WORKER_ERROR_HTTP_STATUS).length,
    WORKER_ERROR_CODES.length,
    "status table must match the allowlist exactly",
  );
});

test("WORKER_UNAVAILABLE is not a worker business code", () => {
  assert.equal(isWorkerErrorCode("WORKER_UNAVAILABLE"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(WORKER_ERROR_HTTP_STATUS, "WORKER_UNAVAILABLE"),
    false,
  );
  // A control-plane-only AppError degrades to PROCESSING_FAILED on the wire.
  const envelope = toWorkerErrorEnvelope(new AppError("WORKER_UNAVAILABLE"));
  assert.equal(envelope.body.error.code, "PROCESSING_FAILED");
  assert.equal(envelope.status, 500);
});

test("every envelope is schema-valid and carries only canonical messages", () => {
  for (const code of WORKER_ERROR_CODES) {
    const envelope = toWorkerErrorEnvelope(new WorkerBusinessError(code));
    assert.doesNotThrow(() => WorkerErrorResponseSchema.parse(envelope.body));
    assert.equal(envelope.body.error.code, code);
    assert.equal(envelope.body.error.message, ERROR_MESSAGES[code]);
    assert.equal(envelope.status, WORKER_ERROR_HTTP_STATUS[code]);
  }
});

test("a custom AppError message is never serialized", () => {
  const secret = "at /srv/worker/tmp/job-abc/secret.mp4 (key=videofetch/jobs/x)";
  const envelope = toWorkerErrorEnvelope(new AppError("ANALYSIS_FAILED", secret));
  assert.equal(envelope.body.error.code, "ANALYSIS_FAILED");
  assert.equal(envelope.body.error.message, ERROR_MESSAGES.ANALYSIS_FAILED);
  assert.equal(JSON.stringify(envelope).includes("secret.mp4"), false);
  assert.equal(JSON.stringify(envelope).includes("videofetch/jobs"), false);
});

test("unknown exceptions become PROCESSING_FAILED", () => {
  for (const thrown of [
    new Error("ECONNREFUSED 10.0.0.4:5432"),
    "a raw string",
    null,
    undefined,
    { code: "NOT_A_CODE" },
    new AppError("ACCESS_REQUIRED"),
  ]) {
    const envelope = toWorkerErrorEnvelope(thrown);
    assert.equal(envelope.body.error.code, "PROCESSING_FAILED");
    assert.equal(envelope.body.error.message, ERROR_MESSAGES.PROCESSING_FAILED);
    assert.equal(envelope.status, 500);
    assert.equal(JSON.stringify(envelope).includes("ECONNREFUSED"), false);
  }
});

test("an explicit HTTP status override keeps the allowlisted code", () => {
  const envelope = toWorkerErrorEnvelope(new WorkerBusinessError("PROCESSING_FAILED", 409));
  assert.equal(envelope.status, 409);
  assert.equal(envelope.body.error.code, "PROCESSING_FAILED");
  assert.doesNotThrow(() => WorkerErrorResponseSchema.parse(envelope.body));
});
