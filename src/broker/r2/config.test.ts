import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadR2BrokerConfig, R2BrokerConfigError } from "./config.ts";

/**
 * The trusted broker's environment boundary.
 *
 * This is the ONE place the persistent R2 parent credential is read, so the
 * "never render a value" rule is enforced here with the same rigour as in the
 * Worker runtime loader. All values are fake.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "videofetch-objects";
const SOCKET = "/run/videofetch-r2-broker/broker.sock";
const PARENT_KEY_ID = "fake-parent-access-key-id";
const PARENT_SECRET = "fake-parent-secret-access-key-do-not-use";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    R2_BROKER_SOCKET_PATH: SOCKET,
    R2_ACCOUNT_ID: ACCOUNT_ID,
    R2_BUCKET: BUCKET,
    R2_BROKER_PARENT_ACCESS_KEY_ID: PARENT_KEY_ID,
    R2_BROKER_PARENT_SECRET_ACCESS_KEY: PARENT_SECRET,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function expectInvalid(env: NodeJS.ProcessEnv, variable: string) {
  assert.throws(
    () => loadR2BrokerConfig(env),
    (err: unknown) => {
      assert.ok(err instanceof R2BrokerConfigError, "must be a broker config error");
      assert.ok(
        err.variables.includes(variable),
        `expected ${variable} among ${err.variables.join(", ")}`,
      );
      return true;
    },
  );
}

describe("R2 broker configuration", () => {
  it("accepts a complete valid environment", () => {
    const config = loadR2BrokerConfig(baseEnv());

    assert.equal(config.socketPath, SOCKET);
    assert.equal(config.broker.accountId, ACCOUNT_ID);
    assert.equal(config.broker.bucket, BUCKET);
    assert.equal(config.broker.jurisdiction, "default");
    assert.equal(config.broker.parentAccessKeyId, PARENT_KEY_ID);
    assert.equal(config.broker.parentSecretAccessKey, PARENT_SECRET);
  });

  it("requires every field and names only the variable on failure", () => {
    expectInvalid(baseEnv({ R2_BROKER_SOCKET_PATH: undefined }), "R2_BROKER_SOCKET_PATH");
    expectInvalid(baseEnv({ R2_BROKER_SOCKET_PATH: "relative.sock" }), "R2_BROKER_SOCKET_PATH");
    expectInvalid(baseEnv({ R2_BROKER_SOCKET_PATH: "/run/../etc/x.sock" }), "R2_BROKER_SOCKET_PATH");

    expectInvalid(baseEnv({ R2_ACCOUNT_ID: undefined }), "R2_ACCOUNT_ID");
    expectInvalid(baseEnv({ R2_ACCOUNT_ID: "NOTHEX" }), "R2_ACCOUNT_ID");

    expectInvalid(baseEnv({ R2_BUCKET: undefined }), "R2_BUCKET");
    expectInvalid(baseEnv({ R2_BUCKET: "Invalid_Bucket" }), "R2_BUCKET");

    expectInvalid(
      baseEnv({ R2_BROKER_PARENT_ACCESS_KEY_ID: undefined }),
      "R2_BROKER_PARENT_ACCESS_KEY_ID",
    );
    expectInvalid(
      baseEnv({ R2_BROKER_PARENT_SECRET_ACCESS_KEY: undefined }),
      "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
    );
    expectInvalid(
      baseEnv({ R2_BROKER_PARENT_SECRET_ACCESS_KEY: "" }),
      "R2_BROKER_PARENT_SECRET_ACCESS_KEY",
    );
  });

  it("NEVER renders a rejected value in the error", () => {
    const poison = "PARENT-SECRET-THAT-MUST-NOT-BE-LOGGED";
    try {
      loadR2BrokerConfig(
        baseEnv({
          // Rejected for length; the point is that the VALUE never travels.
          R2_BROKER_PARENT_SECRET_ACCESS_KEY: poison.repeat(400),
          R2_ACCOUNT_ID: poison,
        }),
      );
      assert.fail("must have thrown");
    } catch (err) {
      assert.ok(err instanceof R2BrokerConfigError);
      assert.equal(err.message.includes(poison), false, "the value must never appear");
      assert.equal(JSON.stringify(err.variables).includes(poison), false);
      assert.deepEqual(
        [...err.variables].sort(),
        ["R2_ACCOUNT_ID", "R2_BROKER_PARENT_SECRET_ACCESS_KEY"],
      );
    }
  });

  it("defaults the jurisdiction and accepts the closed set", () => {
    assert.equal(loadR2BrokerConfig(baseEnv()).broker.jurisdiction, "default");
    assert.equal(loadR2BrokerConfig(baseEnv({ R2_JURISDICTION: "eu" })).broker.jurisdiction, "eu");
    assert.equal(loadR2BrokerConfig(baseEnv({ R2_JURISDICTION: "us" })).broker.jurisdiction, "us");
    expectInvalid(baseEnv({ R2_JURISDICTION: "apac" }), "R2_JURISDICTION");
  });

  it("does NOT consume the superseded Worker writer contract", () => {
    // The broker has its own parent variables. A stray R2_WRITER_* value is
    // simply not read here, and is separately fatal on the Worker side.
    const config = loadR2BrokerConfig(
      baseEnv({
        R2_WRITER_ACCESS_KEY_ID: "stale-writer-key",
        R2_WRITER_SECRET_ACCESS_KEY: "stale-writer-secret",
      }),
    );
    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes("stale-writer-key"), false);
    assert.equal(serialized.includes("stale-writer-secret"), false);
  });
});
