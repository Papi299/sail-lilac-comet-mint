import test from "node:test";
import assert from "node:assert";
import { WorkerErrorCodeSchema, WorkerErrorResponseSchema } from "./errors.ts";

test("Worker Error Contract", async (t) => {
  await t.test("accepts allowlisted codes", () => {
    assert.doesNotThrow(() => WorkerErrorCodeSchema.parse("INVALID_URL"));
    assert.doesNotThrow(() => WorkerErrorCodeSchema.parse("EXPIRED"));
    assert.doesNotThrow(() => WorkerErrorCodeSchema.parse("PROCESSING_FAILED"));
  });

  await t.test("rejects access errors and unknown codes", () => {
    assert.throws(() => WorkerErrorCodeSchema.parse("ACCESS_REQUIRED"));
    assert.throws(() => WorkerErrorCodeSchema.parse("ACCESS_NOT_CONFIGURED"));
    assert.throws(() => WorkerErrorCodeSchema.parse("FORBIDDEN"));
    assert.throws(() => WorkerErrorCodeSchema.parse("FAKE_CODE"));
  });

  await t.test("envelopes must be strict", () => {
    assert.doesNotThrow(() =>
      WorkerErrorResponseSchema.parse({
        success: false,
        error: { code: "INVALID_URL", message: "Safe message" },
      }),
    );

    assert.throws(() =>
      WorkerErrorResponseSchema.parse({
        success: false,
        error: { code: "INVALID_URL", message: "Safe", stack: "..." },
      }),
    );
  });
});
