import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isYtdlpNetworkIsolated } from "../../lib/config.ts";
import {
  assertYtdlpDeploymentLock,
  loadWorkerRuntimeConfig,
  parsesYtdlpIsolationTruthy,
  WORKER_DEFAULT_BIND_HOST,
  WORKER_DEFAULT_PORT,
  WorkerRuntimeConfigError,
  WorkerYtdlpDeploymentLockError,
} from "./config.server.ts";

/**
 * Strict Worker runtime configuration boundary (§6/§7) and the Phase-8A yt-dlp
 * deployment lock (§8).
 *
 * Every value in this file is a syntactically valid FAKE. No real account,
 * bucket, key id or secret appears anywhere.
 */

const FAKE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const FAKE_BUCKET = "videofetch-temp";
const FAKE_KEY_ID = "worker-control-1";
const FAKE_SECRET = "0123456789abcdef0123456789abcdef";
const FAKE_PREVIOUS_KEY_ID = "worker-control-0";
const FAKE_PREVIOUS_SECRET = "fedcba9876543210fedcba9876543210";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    WORKER_DATA_DIRECTORY: "/var/lib/videofetch",
    WORKER_CONTROL_KEY_ID: FAKE_KEY_ID,
    WORKER_CONTROL_SECRET: FAKE_SECRET,
    R2_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    R2_BUCKET: FAKE_BUCKET,
    R2_WRITER_ACCESS_KEY_ID: "fake-writer-access-key-id",
    R2_WRITER_SECRET_ACCESS_KEY: "fake-writer-secret-access-key",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function expectInvalid(env: NodeJS.ProcessEnv, variable: string) {
  assert.throws(
    () => loadWorkerRuntimeConfig(env),
    (err: unknown) => {
      assert.ok(err instanceof WorkerRuntimeConfigError, "must be a config error");
      assert.ok(
        err.variables.includes(variable),
        `expected ${variable} to be reported, got ${err.variables.join(",")}`,
      );
      return true;
    },
  );
}

describe("Worker runtime configuration", () => {
  it("accepts a complete valid environment and applies bind defaults", () => {
    const config = loadWorkerRuntimeConfig(baseEnv());

    assert.equal(config.bindHost, WORKER_DEFAULT_BIND_HOST);
    assert.equal(config.port, WORKER_DEFAULT_PORT);
    assert.equal(config.dataDirectory, "/var/lib/videofetch");
    assert.equal(config.control.currentKeyId, FAKE_KEY_ID);
    assert.equal(config.control.currentSecret, FAKE_SECRET);
    assert.equal(config.control.previousKeyId, undefined);
    assert.equal(config.r2.accountId, FAKE_ACCOUNT_ID);
    assert.equal(config.r2.bucket, FAKE_BUCKET);
    assert.equal(config.r2.jurisdiction, "default");
    assert.equal(config.r2.accessKeyId, "fake-writer-access-key-id");
  });

  describe("bind host and port", () => {
    it("accepts an explicit bounded host", () => {
      const config = loadWorkerRuntimeConfig(baseEnv({ WORKER_BIND_HOST: "127.0.0.1" }));
      assert.equal(config.bindHost, "127.0.0.1");
    });

    it("rejects hosts containing whitespace or shell metacharacters", () => {
      expectInvalid(baseEnv({ WORKER_BIND_HOST: "127.0.0.1 evil" }), "WORKER_BIND_HOST");
      expectInvalid(baseEnv({ WORKER_BIND_HOST: "host;rm -rf /" }), "WORKER_BIND_HOST");
    });

    it("rejects a host longer than the bound", () => {
      expectInvalid(baseEnv({ WORKER_BIND_HOST: "a".repeat(256) }), "WORKER_BIND_HOST");
    });

    it("accepts the inclusive port bounds", () => {
      assert.equal(loadWorkerRuntimeConfig(baseEnv({ WORKER_PORT: "1" })).port, 1);
      assert.equal(loadWorkerRuntimeConfig(baseEnv({ WORKER_PORT: "65535" })).port, 65535);
      assert.equal(loadWorkerRuntimeConfig(baseEnv({ WORKER_PORT: "8080" })).port, 8080);
    });

    it("rejects ports outside 1..65535 and non-integers", () => {
      for (const port of ["0", "65536", "-1", "8080.5", "abc", "0x1f90", " 8080 x"]) {
        expectInvalid(baseEnv({ WORKER_PORT: port }), "WORKER_PORT");
      }
    });
  });

  describe("persistent data directory", () => {
    it("requires the variable to be present and non-empty", () => {
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: undefined }), "WORKER_DATA_DIRECTORY");
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "" }), "WORKER_DATA_DIRECTORY");
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "   " }), "WORKER_DATA_DIRECTORY");
    });

    it("requires an absolute path", () => {
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "var/lib/videofetch" }), "WORKER_DATA_DIRECTORY");
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "./state" }), "WORKER_DATA_DIRECTORY");
    });

    it("rejects the filesystem root", () => {
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "/" }), "WORKER_DATA_DIRECTORY");
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "//" }), "WORKER_DATA_DIRECTORY");
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "///" }), "WORKER_DATA_DIRECTORY");
    });

    it("rejects relative segments and control characters", () => {
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "/var/lib/../etc" }), "WORKER_DATA_DIRECTORY");
      expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "/var/./lib" }), "WORKER_DATA_DIRECTORY");
      expectInvalid(
        baseEnv({ WORKER_DATA_DIRECTORY: "/var/lib/\u0000videofetch" }),
        "WORKER_DATA_DIRECTORY",
      );
      expectInvalid(
        baseEnv({ WORKER_DATA_DIRECTORY: "/var/lib/video\nfetch" }),
        "WORKER_DATA_DIRECTORY",
      );
    });

    it("rejects a path beyond the length bound", () => {
      expectInvalid(
        baseEnv({ WORKER_DATA_DIRECTORY: `/${"a".repeat(5000)}` }),
        "WORKER_DATA_DIRECTORY",
      );
    });
  });

  describe("Worker control credentials", () => {
    it("uses the authoritative WorkerKeyIdSchema", () => {
      expectInvalid(baseEnv({ WORKER_CONTROL_KEY_ID: undefined }), "WORKER_CONTROL_KEY_ID");
      expectInvalid(baseEnv({ WORKER_CONTROL_KEY_ID: "" }), "WORKER_CONTROL_KEY_ID");
      expectInvalid(baseEnv({ WORKER_CONTROL_KEY_ID: "key id" }), "WORKER_CONTROL_KEY_ID");
      expectInvalid(baseEnv({ WORKER_CONTROL_KEY_ID: "key/id" }), "WORKER_CONTROL_KEY_ID");
      expectInvalid(baseEnv({ WORKER_CONTROL_KEY_ID: "k".repeat(65) }), "WORKER_CONTROL_KEY_ID");

      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ WORKER_CONTROL_KEY_ID: "a.b-c_1" })).control.currentKeyId,
        "a.b-c_1",
      );
    });

    it("requires at least 32 UTF-8 BYTES of secret", () => {
      expectInvalid(baseEnv({ WORKER_CONTROL_SECRET: undefined }), "WORKER_CONTROL_SECRET");
      expectInvalid(baseEnv({ WORKER_CONTROL_SECRET: "a".repeat(31) }), "WORKER_CONTROL_SECRET");

      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ WORKER_CONTROL_SECRET: "a".repeat(32) })).control
          .currentSecret.length,
        32,
      );

      // 16 three-byte characters are 48 UTF-8 bytes but only 16 code units:
      // byte length is what the HMAC boundary actually consumes.
      const multibyte = "中".repeat(16);
      assert.equal(Buffer.byteLength(multibyte, "utf8"), 48);
      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ WORKER_CONTROL_SECRET: multibyte })).control.currentSecret,
        multibyte,
      );

      // 10 three-byte characters are only 30 bytes and must be rejected.
      expectInvalid(
        baseEnv({ WORKER_CONTROL_SECRET: "中".repeat(10) }),
        "WORKER_CONTROL_SECRET",
      );
    });

    it("rejects a secret beyond the upper bound", () => {
      expectInvalid(baseEnv({ WORKER_CONTROL_SECRET: "a".repeat(4097) }), "WORKER_CONTROL_SECRET");
    });

    it("preserves secret bytes verbatim without trimming", () => {
      const padded = `  ${"a".repeat(32)}  `;
      const config = loadWorkerRuntimeConfig(baseEnv({ WORKER_CONTROL_SECRET: padded }));
      assert.equal(config.control.currentSecret, padded);
    });
  });

  describe("HMAC rotation pair", () => {
    it("accepts both previous values together", () => {
      const config = loadWorkerRuntimeConfig(
        baseEnv({
          WORKER_CONTROL_PREVIOUS_KEY_ID: FAKE_PREVIOUS_KEY_ID,
          WORKER_CONTROL_PREVIOUS_SECRET: FAKE_PREVIOUS_SECRET,
        }),
      );
      assert.equal(config.control.previousKeyId, FAKE_PREVIOUS_KEY_ID);
      assert.equal(config.control.previousSecret, FAKE_PREVIOUS_SECRET);
    });

    it("rejects a half-configured rotation", () => {
      expectInvalid(
        baseEnv({ WORKER_CONTROL_PREVIOUS_KEY_ID: FAKE_PREVIOUS_KEY_ID }),
        "WORKER_CONTROL_PREVIOUS_SECRET",
      );
      expectInvalid(
        baseEnv({ WORKER_CONTROL_PREVIOUS_SECRET: FAKE_PREVIOUS_SECRET }),
        "WORKER_CONTROL_PREVIOUS_KEY_ID",
      );
    });

    it("requires the previous key id to differ from the current one", () => {
      expectInvalid(
        baseEnv({
          WORKER_CONTROL_PREVIOUS_KEY_ID: FAKE_KEY_ID,
          WORKER_CONTROL_PREVIOUS_SECRET: FAKE_PREVIOUS_SECRET,
        }),
        "WORKER_CONTROL_PREVIOUS_KEY_ID",
      );
    });

    it("applies the same 32-byte floor to the previous secret", () => {
      expectInvalid(
        baseEnv({
          WORKER_CONTROL_PREVIOUS_KEY_ID: FAKE_PREVIOUS_KEY_ID,
          WORKER_CONTROL_PREVIOUS_SECRET: "short",
        }),
        "WORKER_CONTROL_PREVIOUS_SECRET",
      );
    });

    it("treats an absent rotation as valid", () => {
      const config = loadWorkerRuntimeConfig(baseEnv());
      assert.equal(config.control.previousKeyId, undefined);
      assert.equal(config.control.previousSecret, undefined);
    });
  });

  describe("R2 configuration", () => {
    it("reuses the authoritative account/bucket semantics", () => {
      expectInvalid(baseEnv({ R2_ACCOUNT_ID: undefined }), "R2_ACCOUNT_ID");
      expectInvalid(baseEnv({ R2_ACCOUNT_ID: "NOTHEX" }), "R2_ACCOUNT_ID");
      expectInvalid(baseEnv({ R2_ACCOUNT_ID: FAKE_ACCOUNT_ID.toUpperCase() }), "R2_ACCOUNT_ID");
      expectInvalid(baseEnv({ R2_ACCOUNT_ID: "abc" }), "R2_ACCOUNT_ID");

      expectInvalid(baseEnv({ R2_BUCKET: undefined }), "R2_BUCKET");
      expectInvalid(baseEnv({ R2_BUCKET: "Invalid_Bucket" }), "R2_BUCKET");
      expectInvalid(baseEnv({ R2_BUCKET: "a" }), "R2_BUCKET");
    });

    it("defaults the jurisdiction and accepts the closed set", () => {
      assert.equal(loadWorkerRuntimeConfig(baseEnv()).r2.jurisdiction, "default");
      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ R2_JURISDICTION: "eu" })).r2.jurisdiction,
        "eu",
      );
      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ R2_JURISDICTION: "us" })).r2.jurisdiction,
        "us",
      );
      expectInvalid(baseEnv({ R2_JURISDICTION: "apac" }), "R2_JURISDICTION");
    });

    it("requires non-empty bounded writer credentials", () => {
      expectInvalid(baseEnv({ R2_WRITER_ACCESS_KEY_ID: undefined }), "R2_WRITER_ACCESS_KEY_ID");
      expectInvalid(baseEnv({ R2_WRITER_ACCESS_KEY_ID: "" }), "R2_WRITER_ACCESS_KEY_ID");
      expectInvalid(
        baseEnv({ R2_WRITER_ACCESS_KEY_ID: "a".repeat(8193) }),
        "R2_WRITER_ACCESS_KEY_ID",
      );

      expectInvalid(
        baseEnv({ R2_WRITER_SECRET_ACCESS_KEY: undefined }),
        "R2_WRITER_SECRET_ACCESS_KEY",
      );
      expectInvalid(baseEnv({ R2_WRITER_SECRET_ACCESS_KEY: "" }), "R2_WRITER_SECRET_ACCESS_KEY");
    });

    it("treats the writer session token as optional but bounded", () => {
      assert.equal(loadWorkerRuntimeConfig(baseEnv()).r2.sessionToken, undefined);
      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ R2_WRITER_SESSION_TOKEN: "fake-token" })).r2.sessionToken,
        "fake-token",
      );
      expectInvalid(
        baseEnv({ R2_WRITER_SESSION_TOKEN: "a".repeat(8193) }),
        "R2_WRITER_SESSION_TOKEN",
      );
    });

    it("NEVER consumes the Vercel-only signer identity", () => {
      const env = baseEnv({
        R2_SIGNER_ACCESS_KEY_ID: "signer-access-key-must-not-be-used",
        R2_SIGNER_SECRET_ACCESS_KEY: "signer-secret-must-not-be-used",
        R2_SIGNER_SESSION_TOKEN: "signer-token-must-not-be-used",
      });

      const config = loadWorkerRuntimeConfig(env);

      // The writer identity comes exclusively from R2_WRITER_*.
      assert.equal(config.r2.accessKeyId, "fake-writer-access-key-id");
      assert.equal(config.r2.secretAccessKey, "fake-writer-secret-access-key");
      assert.equal(config.r2.sessionToken, undefined);

      const serialized = JSON.stringify(config);
      assert.ok(!serialized.includes("signer-access-key-must-not-be-used"));
      assert.ok(!serialized.includes("signer-secret-must-not-be-used"));
      assert.ok(!serialized.includes("signer-token-must-not-be-used"));
    });

    it("still fails closed when only signer credentials are supplied", () => {
      const env = baseEnv({
        R2_WRITER_ACCESS_KEY_ID: undefined,
        R2_WRITER_SECRET_ACCESS_KEY: undefined,
        R2_SIGNER_ACCESS_KEY_ID: "signer-access",
        R2_SIGNER_SECRET_ACCESS_KEY: "signer-secret",
      });
      expectInvalid(env, "R2_WRITER_ACCESS_KEY_ID");
      expectInvalid(env, "R2_WRITER_SECRET_ACCESS_KEY");
    });
  });

  describe("media execution limits", () => {
    it("falls back to defaults when unset", () => {
      const media = loadWorkerRuntimeConfig(baseEnv()).media;
      assert.equal(media.maxFileSizeBytes, 500 * 1024 * 1024);
      assert.equal(media.maxVideoDurationSeconds, 7200);
      assert.equal(media.fileExpirationMinutes, 45);
      assert.equal(media.downloadTimeoutSeconds, 600);
      assert.equal(media.analysisTimeoutSeconds, 45);
      assert.equal(media.maxRedirects, 5);
      assert.equal(media.tempDirectory, null);
      assert.equal(media.ffmpegPath, null);
    });

    it("accepts explicit in-range values", () => {
      const media = loadWorkerRuntimeConfig(
        baseEnv({
          MAX_FILE_SIZE: "1048576",
          MAX_VIDEO_DURATION: "60",
          FILE_EXPIRATION_MINUTES: "15",
          DOWNLOAD_TIMEOUT: "120",
          ANALYSIS_TIMEOUT: "30",
          MAX_REDIRECTS: "0",
          TEMP_DIRECTORY: "/tmp/videofetch",
          FFMPEG_PATH: "/usr/bin/ffmpeg",
        }),
      ).media;

      assert.equal(media.maxFileSizeBytes, 1048576);
      assert.equal(media.maxVideoDurationSeconds, 60);
      assert.equal(media.fileExpirationMinutes, 15);
      assert.equal(media.downloadTimeoutSeconds, 120);
      assert.equal(media.analysisTimeoutSeconds, 30);
      assert.equal(media.maxRedirects, 0);
      assert.equal(media.tempDirectory, "/tmp/videofetch");
      assert.equal(media.ffmpegPath, "/usr/bin/ffmpeg");
    });

    it("fails closed on malformed or out-of-range values rather than silently defaulting", () => {
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "0" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "-1" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "not-a-number" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "1e9" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "99999999999999999999" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_VIDEO_DURATION: "604801" }), "MAX_VIDEO_DURATION");
      expectInvalid(baseEnv({ FILE_EXPIRATION_MINUTES: "1441" }), "FILE_EXPIRATION_MINUTES");
      expectInvalid(baseEnv({ DOWNLOAD_TIMEOUT: "0" }), "DOWNLOAD_TIMEOUT");
      expectInvalid(baseEnv({ ANALYSIS_TIMEOUT: "3601" }), "ANALYSIS_TIMEOUT");
      expectInvalid(baseEnv({ MAX_REDIRECTS: "21" }), "MAX_REDIRECTS");
      expectInvalid(baseEnv({ TEMP_DIRECTORY: "relative/tmp" }), "TEMP_DIRECTORY");
      expectInvalid(baseEnv({ TEMP_DIRECTORY: "/" }), "TEMP_DIRECTORY");
    });
  });

  describe("failure disclosure", () => {
    it("names every offending variable at once", () => {
      const env = baseEnv({
        WORKER_PORT: "70000",
        R2_BUCKET: "Invalid_Bucket",
        WORKER_CONTROL_SECRET: "short",
      });
      assert.throws(
        () => loadWorkerRuntimeConfig(env),
        (err: unknown) => {
          assert.ok(err instanceof WorkerRuntimeConfigError);
          assert.deepEqual(
            [...err.variables].sort(),
            ["R2_BUCKET", "WORKER_CONTROL_SECRET", "WORKER_PORT"],
          );
          return true;
        },
      );
    });

    it("never renders the malformed VALUE", () => {
      const sentinelSecret = "SENTINEL-SECRET-VALUE-MUST-NOT-LEAK";
      const sentinelBucket = "SENTINEL_BUCKET_MUST_NOT_LEAK";
      const sentinelKeyId = "SENTINEL KEY ID MUST NOT LEAK";

      assert.throws(
        () =>
          loadWorkerRuntimeConfig(
            baseEnv({
              // Long enough to pass the byte floor but paired with other errors
              // so the whole load fails and the message is rendered.
              WORKER_CONTROL_SECRET: sentinelSecret,
              R2_BUCKET: sentinelBucket,
              WORKER_CONTROL_KEY_ID: sentinelKeyId,
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof WorkerRuntimeConfigError);
          const rendered = `${err.message}\n${err.stack ?? ""}\n${JSON.stringify(err.variables)}`;
          assert.ok(!rendered.includes(sentinelSecret), "secret value must not appear");
          assert.ok(!rendered.includes(sentinelBucket), "bucket value must not appear");
          assert.ok(!rendered.includes(sentinelKeyId), "key id value must not appear");
          // Only NAMES are disclosed.
          assert.ok(err.message.includes("R2_BUCKET"));
          return true;
        },
      );
    });
  });
});

describe("Phase-8A yt-dlp deployment lock", () => {
  const ORIGINAL = process.env.YTDLP_NETWORK_ISOLATED;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.YTDLP_NETWORK_ISOLATED;
    else process.env.YTDLP_NETWORK_ISOLATED = ORIGINAL;
  });

  const ACCEPTED: Array<[string, string | undefined]> = [
    ["undefined", undefined],
    ["empty string", ""],
    ["false", "false"],
    ["0", "0"],
  ];

  const REJECTED: Array<[string, string]> = [
    ["true", "true"],
    ["1", "1"],
    ["yes", "yes"],
  ];

  for (const [label, value] of ACCEPTED) {
    it(`accepts startup when YTDLP_NETWORK_ISOLATED is ${label}`, () => {
      const env = baseEnv({ YTDLP_NETWORK_ISOLATED: value });
      assert.doesNotThrow(() => assertYtdlpDeploymentLock(env));
      const config = loadWorkerRuntimeConfig(env);
      assert.equal(config.dataDirectory, "/var/lib/videofetch");
    });
  }

  for (const [label, value] of REJECTED) {
    it(`REJECTS startup when YTDLP_NETWORK_ISOLATED is ${label}`, () => {
      const env = baseEnv({ YTDLP_NETWORK_ISOLATED: value });
      assert.throws(
        () => assertYtdlpDeploymentLock(env),
        (err: unknown) => err instanceof WorkerYtdlpDeploymentLockError,
      );
      assert.throws(
        () => loadWorkerRuntimeConfig(env),
        (err: unknown) => err instanceof WorkerYtdlpDeploymentLockError,
      );
    });
  }

  it("rejects case and whitespace variants of the truthy set", () => {
    for (const value of ["TRUE", " true ", "Yes", "YES", " 1"]) {
      assert.throws(
        () => loadWorkerRuntimeConfig(baseEnv({ YTDLP_NETWORK_ISOLATED: value })),
        (err: unknown) => err instanceof WorkerYtdlpDeploymentLockError,
        `${value} must be rejected`,
      );
    }
  });

  it("is evaluated before any other configuration error", () => {
    // A completely empty environment plus the flag still reports the LOCK, so
    // the operator cannot mistake it for an ordinary misconfiguration.
    assert.throws(
      () => loadWorkerRuntimeConfig({ YTDLP_NETWORK_ISOLATED: "true" }),
      (err: unknown) => err instanceof WorkerYtdlpDeploymentLockError,
    );
  });

  it("matches the existing attestation semantics exactly", () => {
    // Proves the lock reuses the SAME truthiness rule as the merged execution
    // guard, without modifying that guard.
    const cases: Array<string | undefined> = [
      undefined, "", "false", "0", "true", "1", "yes", "TRUE", " true ", "no", "2", "on",
    ];

    for (const value of cases) {
      if (value === undefined) delete process.env.YTDLP_NETWORK_ISOLATED;
      else process.env.YTDLP_NETWORK_ISOLATED = value;

      assert.equal(
        parsesYtdlpIsolationTruthy(value),
        isYtdlpNetworkIsolated(),
        `truthiness must agree for ${JSON.stringify(value)}`,
      );
    }
  });
});
