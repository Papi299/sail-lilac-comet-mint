import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AppError } from "../../lib/errors.ts";
import {
  R2_SIGNER_ENV_KEYS,
  WORKER_ENV_KEYS,
  getObjectStoreSigner,
  getWorkerClient,
  resetWorkerRuntimeForTests,
} from "./worker-runtime.server.ts";

const ALL_KEYS = [...WORKER_ENV_KEYS, ...R2_SIGNER_ENV_KEYS];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of ALL_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>) {
  for (const key of ALL_KEYS) {
    const value = snap[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearEnv() {
  for (const key of ALL_KEYS) delete process.env[key];
}

describe("worker runtime configuration", () => {
  const original = snapshotEnv();

  afterEach(() => {
    restoreEnv(original);
    resetWorkerRuntimeForTests();
  });

  it("fails closed when worker configuration is missing", () => {
    clearEnv();
    resetWorkerRuntimeForTests();
    assert.throws(
      () => getWorkerClient(),
      (err: unknown) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE",
    );
  });

  it("fails closed without disclosing which field is malformed", () => {
    clearEnv();
    resetWorkerRuntimeForTests();
    process.env.WORKER_BASE_URL = "http://not-loopback.example";
    process.env.WORKER_CONTROL_KEY_ID = "control-key";
    process.env.WORKER_CONTROL_SECRET = "0123456789abcdef0123456789abcdef";

    try {
      getWorkerClient();
      assert.fail("expected a fail-closed error");
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "WORKER_UNAVAILABLE");
      assert.equal(err.message.includes("WORKER_BASE_URL"), false);
      assert.equal(err.message.includes("not-loopback"), false);
      assert.equal(err.message.includes("HTTPS"), false);
    }
  });

  it("builds a client from a complete configuration and caches it", () => {
    clearEnv();
    resetWorkerRuntimeForTests();
    process.env.WORKER_BASE_URL = "https://worker.example";
    process.env.WORKER_CONTROL_KEY_ID = "control-key";
    process.env.WORKER_CONTROL_SECRET = "0123456789abcdef0123456789abcdef";

    const first = getWorkerClient();
    assert.equal(getWorkerClient(), first, "the client is memoized");

    process.env.WORKER_CONTROL_KEY_ID = "rotated-key";
    assert.notEqual(getWorkerClient(), first, "a rotated key rebuilds the client");
  });

  it("treats blank environment values as missing", () => {
    clearEnv();
    resetWorkerRuntimeForTests();
    process.env.WORKER_BASE_URL = "   ";
    process.env.WORKER_CONTROL_KEY_ID = "control-key";
    process.env.WORKER_CONTROL_SECRET = "0123456789abcdef0123456789abcdef";
    assert.throws(
      () => getWorkerClient(),
      (err: unknown) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE",
    );
  });

  it("fails closed when signer configuration is missing", () => {
    clearEnv();
    resetWorkerRuntimeForTests();
    assert.throws(
      () => getObjectStoreSigner(),
      (err: unknown) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE",
    );
  });

  it("builds a signer from a complete configuration", () => {
    clearEnv();
    resetWorkerRuntimeForTests();
    process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    process.env.R2_BUCKET = "videofetch-objects";
    process.env.R2_SIGNER_ACCESS_KEY_ID = "signer-access-key";
    process.env.R2_SIGNER_SECRET_ACCESS_KEY = "signer-secret";

    const signer = getObjectStoreSigner();
    assert.equal(typeof signer.signGet, "function");
    assert.equal(getObjectStoreSigner(), signer, "the signer is memoized");
  });

  it("rejects a malformed account id without leaking it", () => {
    clearEnv();
    resetWorkerRuntimeForTests();
    process.env.R2_ACCOUNT_ID = "NOT-HEX";
    process.env.R2_BUCKET = "videofetch-objects";
    process.env.R2_SIGNER_ACCESS_KEY_ID = "signer-access-key";
    process.env.R2_SIGNER_SECRET_ACCESS_KEY = "signer-secret";

    try {
      getObjectStoreSigner();
      assert.fail("expected a fail-closed error");
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, "WORKER_UNAVAILABLE");
      assert.equal(err.message.includes("NOT-HEX"), false);
      assert.equal(err.message.includes("accountId"), false);
    }
  });

  it("documents every environment name in .env.example with an empty value", () => {
    const envExample = readFileSync("./.env.example", "utf8");
    for (const key of ALL_KEYS) {
      assert.match(
        envExample,
        new RegExp(`^${key}=\\s*$`, "m"),
        `${key} must be documented with no value`,
      );
    }
  });

  it("never exposes a worker or signer secret under a VITE_ prefix", () => {
    const envExample = readFileSync("./.env.example", "utf8");
    assert.equal(/^VITE_/m.test(envExample), false, "no VITE_ prefixed variable may exist");
    for (const key of ALL_KEYS) {
      assert.equal(envExample.includes(`VITE_${key}`), false);
    }
  });
});
