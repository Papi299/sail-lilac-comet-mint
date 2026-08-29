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

  // ── Cloudflare Access service token (Phase 8B) ────────────────────────────
  //
  // Vercel-only, optional until Access actually fronts the Worker, and
  // both-or-neither. It is part of WORKER_ENV_KEYS so a rotation invalidates
  // the memoized client the same way a rotated HMAC key does.
  describe("Cloudflare Access credentials", () => {
    const ACCESS_ID = "cf-access-client-id.access";
    const ACCESS_SECRET = "cf-access-client-secret-value-0123456789";

    function configureWorker() {
      clearEnv();
      resetWorkerRuntimeForTests();
      process.env.WORKER_BASE_URL = "https://worker.example";
      process.env.WORKER_CONTROL_KEY_ID = "control-key";
      process.env.WORKER_CONTROL_SECRET = "0123456789abcdef0123456789abcdef";
    }

    it("is optional: the client still builds when neither value is set", () => {
      configureWorker();
      const client = getWorkerClient();
      assert.equal(typeof client.analyze, "function");
      assert.equal(typeof client.createJob, "function");
    });

    it("builds a client when both values are set", () => {
      configureWorker();
      process.env.CLOUDFLARE_ACCESS_CLIENT_ID = ACCESS_ID;
      process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET = ACCESS_SECRET;
      const client = getWorkerClient();
      assert.equal(typeof client.diagnostics, "function");
      assert.equal(getWorkerClient(), client, "the client is memoized");
    });

    it("fails closed when only the client id is set", () => {
      configureWorker();
      process.env.CLOUDFLARE_ACCESS_CLIENT_ID = ACCESS_ID;
      assert.throws(
        () => getWorkerClient(),
        (err: unknown) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE",
      );
    });

    it("fails closed when only the client secret is set", () => {
      configureWorker();
      process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET = ACCESS_SECRET;
      assert.throws(
        () => getWorkerClient(),
        (err: unknown) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE",
      );
    });

    it("treats a blank Access value as absent, not as a half-configured pair", () => {
      configureWorker();
      process.env.CLOUDFLARE_ACCESS_CLIENT_ID = "   ";
      process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET = "\t\n ";
      const client = getWorkerClient();
      assert.equal(typeof client.analyze, "function");
    });

    it("a blank id with a real secret is still a half-configured pair", () => {
      configureWorker();
      process.env.CLOUDFLARE_ACCESS_CLIENT_ID = "   ";
      process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET = ACCESS_SECRET;
      assert.throws(
        () => getWorkerClient(),
        (err: unknown) => err instanceof AppError && err.code === "WORKER_UNAVAILABLE",
      );
    });

    it("rotating the Access client id rebuilds the cached client", () => {
      configureWorker();
      process.env.CLOUDFLARE_ACCESS_CLIENT_ID = ACCESS_ID;
      process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET = ACCESS_SECRET;
      const first = getWorkerClient();
      assert.equal(getWorkerClient(), first);

      process.env.CLOUDFLARE_ACCESS_CLIENT_ID = "rotated-access-id";
      assert.notEqual(getWorkerClient(), first, "a rotated Access id must rebuild the client");
    });

    it("rotating the Access client secret rebuilds the cached client", () => {
      configureWorker();
      process.env.CLOUDFLARE_ACCESS_CLIENT_ID = ACCESS_ID;
      process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET = ACCESS_SECRET;
      const first = getWorkerClient();

      process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET = "rotated-access-secret-value";
      assert.notEqual(getWorkerClient(), first, "a rotated Access secret must rebuild the client");
    });

    it("removing the Access pair rebuilds the cached client", () => {
      configureWorker();
      process.env.CLOUDFLARE_ACCESS_CLIENT_ID = ACCESS_ID;
      process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET = ACCESS_SECRET;
      const first = getWorkerClient();

      delete process.env.CLOUDFLARE_ACCESS_CLIENT_ID;
      delete process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET;
      assert.notEqual(getWorkerClient(), first, "removing Access must rebuild the client");
    });

    it("never renders the Access secret or variable name on the failure path", () => {
      const SENTINEL = "SENTINEL_ACCESS_SECRET_MUST_NOT_LEAK";
      configureWorker();
      process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET = SENTINEL;
      try {
        getWorkerClient();
        assert.fail("expected a fail-closed error");
      } catch (err) {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "WORKER_UNAVAILABLE");
        const rendered = `${String(err)}\n${err.message}\n${err.stack ?? ""}`;
        assert.equal(rendered.includes(SENTINEL), false, "the secret must never surface");
        assert.equal(
          rendered.includes("CLOUDFLARE_ACCESS"),
          false,
          "the failing variable must not be named to the caller",
        );
      }
    });

    it("is part of the Vercel worker environment contract", () => {
      assert.ok(
        (WORKER_ENV_KEYS as readonly string[]).includes("CLOUDFLARE_ACCESS_CLIENT_ID"),
      );
      assert.ok(
        (WORKER_ENV_KEYS as readonly string[]).includes("CLOUDFLARE_ACCESS_CLIENT_SECRET"),
      );
      assert.equal(
        (R2_SIGNER_ENV_KEYS as readonly string[]).includes("CLOUDFLARE_ACCESS_CLIENT_ID"),
        false,
        "Access credentials are not part of the object-store signer identity",
      );
    });
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
