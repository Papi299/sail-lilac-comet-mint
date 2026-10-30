import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadWorkerRuntimeConfig,
  WORKER_DEFAULT_BIND_HOST,
  WORKER_DEFAULT_PORT,
  WORKER_FORBIDDEN_TIME_LIMIT_VARIABLES,
  WORKER_FORBIDDEN_YTDLP_VARIABLES,
  WorkerRuntimeConfigError,
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
const FAKE_BROKER_SOCKET = "/run/videofetch-r2-broker/broker.sock";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    WORKER_DATA_DIRECTORY: "/var/lib/videofetch",
    WORKER_CONTROL_KEY_ID: FAKE_KEY_ID,
    WORKER_CONTROL_SECRET: FAKE_SECRET,
    R2_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    R2_BUCKET: FAKE_BUCKET,
    R2_BROKER_SOCKET_PATH: FAKE_BROKER_SOCKET,
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
    assert.equal(config.r2.brokerSocketPath, FAKE_BROKER_SOCKET);

    // The loaded configuration has no credential surface at all.
    assert.ok(!("accessKeyId" in config.r2));
    assert.ok(!("secretAccessKey" in config.r2));
    assert.ok(!("sessionToken" in config.r2));
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

    describe("ephemeral-storage boundary", () => {
      it("REJECTS the ephemeral root itself", () => {
        expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "/tmp" }), "WORKER_DATA_DIRECTORY");
        expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "/tmp/" }), "WORKER_DATA_DIRECTORY");
        expectInvalid(baseEnv({ WORKER_DATA_DIRECTORY: "/tmp//" }), "WORKER_DATA_DIRECTORY");
      });

      it("REJECTS any descendant of the ephemeral root", () => {
        for (const path of [
          "/tmp/videofetch-state",
          "/tmp/a/b",
          "/tmp/a/b/c/d",
          "/tmp/videofetch",
        ]) {
          expectInvalid(
            baseEnv({ WORKER_DATA_DIRECTORY: path }),
            "WORKER_DATA_DIRECTORY",
          );
        }
      });

      it("does NOT reject by mere string prefix", () => {
        // Component-aware containment: /tmp2 is a different directory entirely.
        for (const path of ["/tmp2/videofetch", "/tmpfs/state", "/tmp2", "/var/tmp/state"]) {
          const config = loadWorkerRuntimeConfig(baseEnv({ WORKER_DATA_DIRECTORY: path }));
          assert.equal(config.dataDirectory, path, `${path} must be accepted`);
        }
      });

      it("still accepts an ordinary persistent path", () => {
        assert.equal(
          loadWorkerRuntimeConfig(baseEnv({ WORKER_DATA_DIRECTORY: "/var/lib/videofetch" }))
            .dataDirectory,
          "/var/lib/videofetch",
        );
      });

      it("permits TEMP_DIRECTORY under the ephemeral root", () => {
        // Media scratch SHOULD be ephemeral; only durable state must not be.
        const config = loadWorkerRuntimeConfig(
          baseEnv({
            WORKER_DATA_DIRECTORY: "/var/lib/videofetch",
            TEMP_DIRECTORY: "/tmp/videofetch",
          }),
        );
        assert.equal(config.media.tempDirectory, "/tmp/videofetch");
      });
    });

    describe("state/media directory overlap", () => {
      it("REJECTS identical directories", () => {
        const env = baseEnv({
          WORKER_DATA_DIRECTORY: "/var/lib/videofetch",
          TEMP_DIRECTORY: "/var/lib/videofetch",
        });
        expectInvalid(env, "WORKER_DATA_DIRECTORY");
        expectInvalid(env, "TEMP_DIRECTORY");
      });

      it("REJECTS a temp directory nested under the state directory", () => {
        expectInvalid(
          baseEnv({
            WORKER_DATA_DIRECTORY: "/var/lib/videofetch",
            TEMP_DIRECTORY: "/var/lib/videofetch/media",
          }),
          "TEMP_DIRECTORY",
        );
      });

      it("REJECTS a state directory nested under the temp directory", () => {
        expectInvalid(
          baseEnv({
            WORKER_DATA_DIRECTORY: "/srv/scratch/state",
            TEMP_DIRECTORY: "/srv/scratch",
          }),
          "WORKER_DATA_DIRECTORY",
        );
      });

      it("ACCEPTS unrelated paths that merely share a string prefix", () => {
        const config = loadWorkerRuntimeConfig(
          baseEnv({
            WORKER_DATA_DIRECTORY: "/var/lib/video",
            TEMP_DIRECTORY: "/var/lib/videofetch2",
          }),
        );
        assert.equal(config.dataDirectory, "/var/lib/video");
        assert.equal(config.media.tempDirectory, "/var/lib/videofetch2");
      });

      it("ACCEPTS sibling directories under a common parent", () => {
        const config = loadWorkerRuntimeConfig(
          baseEnv({
            WORKER_DATA_DIRECTORY: "/srv/videofetch/state",
            TEMP_DIRECTORY: "/srv/videofetch/media",
          }),
        );
        assert.equal(config.dataDirectory, "/srv/videofetch/state");
        assert.equal(config.media.tempDirectory, "/srv/videofetch/media");
      });

      it("ACCEPTS the documented container defaults", () => {
        const config = loadWorkerRuntimeConfig(
          baseEnv({
            WORKER_DATA_DIRECTORY: "/var/lib/videofetch",
            TEMP_DIRECTORY: "/tmp/videofetch",
          }),
        );
        assert.equal(config.dataDirectory, "/var/lib/videofetch");
        assert.equal(config.media.tempDirectory, "/tmp/videofetch");
      });

      it("performs no overlap check when TEMP_DIRECTORY is absent", () => {
        const config = loadWorkerRuntimeConfig(
          baseEnv({ WORKER_DATA_DIRECTORY: "/var/lib/videofetch" }),
        );
        assert.equal(config.media.tempDirectory, null);
      });
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

    it("requires a bounded absolute broker socket path", () => {
      expectInvalid(baseEnv({ R2_BROKER_SOCKET_PATH: undefined }), "R2_BROKER_SOCKET_PATH");
      expectInvalid(baseEnv({ R2_BROKER_SOCKET_PATH: "" }), "R2_BROKER_SOCKET_PATH");
      expectInvalid(baseEnv({ R2_BROKER_SOCKET_PATH: "relative/broker.sock" }), "R2_BROKER_SOCKET_PATH");
      expectInvalid(baseEnv({ R2_BROKER_SOCKET_PATH: "/run/../etc/broker.sock" }), "R2_BROKER_SOCKET_PATH");
      expectInvalid(baseEnv({ R2_BROKER_SOCKET_PATH: "/run/./broker.sock" }), "R2_BROKER_SOCKET_PATH");
      expectInvalid(
        baseEnv({ R2_BROKER_SOCKET_PATH: `/run/${"a".repeat(4097)}.sock` }),
        "R2_BROKER_SOCKET_PATH",
      );
    });

    it("NEVER consumes the Vercel-only signer identity", () => {
      const env = baseEnv({
        R2_SIGNER_ACCESS_KEY_ID: "signer-access-key-must-not-be-used",
        R2_SIGNER_SECRET_ACCESS_KEY: "signer-secret-must-not-be-used",
        R2_SIGNER_SESSION_TOKEN: "signer-token-must-not-be-used",
      });

      const config = loadWorkerRuntimeConfig(env);

      // The Worker reads no object-store credential of any kind, so a signer
      // identity in the environment is simply not consumed.
      assert.equal(config.r2.brokerSocketPath, FAKE_BROKER_SOCKET);

      const serialized = JSON.stringify(config);
      assert.ok(!serialized.includes("signer-access-key-must-not-be-used"));
      assert.ok(!serialized.includes("signer-secret-must-not-be-used"));
      assert.ok(!serialized.includes("signer-token-must-not-be-used"));
    });

    it("still fails closed when only signer credentials are supplied", () => {
      const env = baseEnv({
        R2_BROKER_SOCKET_PATH: undefined,
        R2_SIGNER_ACCESS_KEY_ID: "signer-access",
        R2_SIGNER_SECRET_ACCESS_KEY: "signer-secret",
      });
      expectInvalid(env, "R2_BROKER_SOCKET_PATH");
    });
  });

  describe("media execution limits", () => {
    it("falls back to defaults when unset", () => {
      const media = loadWorkerRuntimeConfig(baseEnv()).media;
      // MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001: exactly 4 GiB, as a literal, so a
      // change to the shared default cannot pass unnoticed.
      assert.equal(media.maxFileSizeBytes, 4_294_967_296);
      assert.equal(media.maxVideoDurationSeconds, 7200);
      assert.equal(media.fileExpirationMinutes, 45);
      assert.equal(media.downloadTimeLimitSeconds, 600);
      assert.equal(media.processingTimeoutSeconds, 600);
      assert.equal(media.uploadTimeoutSeconds, 3600);
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
          DOWNLOAD_TIME_LIMIT: "120",
          PROCESSING_TIMEOUT: "90",
          ANALYSIS_TIMEOUT: "30",
          MAX_REDIRECTS: "0",
          TEMP_DIRECTORY: "/tmp/videofetch",
          FFMPEG_PATH: "/usr/bin/ffmpeg",
        }),
      ).media;

      assert.equal(media.maxFileSizeBytes, 1048576);
      assert.equal(media.maxVideoDurationSeconds, 60);
      assert.equal(media.fileExpirationMinutes, 15);
      assert.equal(media.downloadTimeLimitSeconds, 120);
      assert.equal(media.processingTimeoutSeconds, 90);
      assert.equal(media.analysisTimeoutSeconds, 30);
      assert.equal(media.maxRedirects, 0);
      assert.equal(media.tempDirectory, "/tmp/videofetch");
      assert.equal(media.ffmpegPath, "/usr/bin/ffmpeg");
    });

    it("accepts the exact 4 GiB ceiling and its neighbours, with no 32-bit cap", () => {
      for (const raw of ["4294967295", "4294967296", "4294967297", "9007199254740991"]) {
        assert.equal(
          loadWorkerRuntimeConfig(baseEnv({ MAX_FILE_SIZE: raw })).media.maxFileSizeBytes,
          Number(raw),
          raw,
        );
      }
      // An empty value is "unset", exactly as for every other optional field.
      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ MAX_FILE_SIZE: "" })).media.maxFileSizeBytes,
        4_294_967_296,
      );
    });

    it("keeps the strict decimal grammar at and beyond 4 GiB", () => {
      // One past MAX_SAFE_INTEGER: sixteen digits pass the regex, the
      // safe-integer refinement must still refuse it.
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "9007199254740992" }), "MAX_FILE_SIZE");
      for (const raw of ["4294967296.0", "4GiB", "4 GiB", "0x100000000", "4_294_967_296", "+4294967296", "4.294967296e9"]) {
        expectInvalid(baseEnv({ MAX_FILE_SIZE: raw }), "MAX_FILE_SIZE");
      }
    });

    it("fails closed on malformed or out-of-range values rather than silently defaulting", () => {
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "0" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "-1" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "not-a-number" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "1e9" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_FILE_SIZE: "99999999999999999999" }), "MAX_FILE_SIZE");
      expectInvalid(baseEnv({ MAX_VIDEO_DURATION: "604801" }), "MAX_VIDEO_DURATION");
      expectInvalid(baseEnv({ FILE_EXPIRATION_MINUTES: "1441" }), "FILE_EXPIRATION_MINUTES");
      expectInvalid(baseEnv({ FILE_EXPIRATION_MINUTES: "56" }), "FILE_EXPIRATION_MINUTES");
      expectInvalid(baseEnv({ UPLOAD_TIMEOUT: "0" }), "UPLOAD_TIMEOUT");
      expectInvalid(baseEnv({ DOWNLOAD_TIME_LIMIT: "0" }), "DOWNLOAD_TIME_LIMIT");
      expectInvalid(baseEnv({ PROCESSING_TIMEOUT: "0" }), "PROCESSING_TIMEOUT");
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
/**
 * PHASE-10C1-YTDLP-RUNTIME-FOUNDATION-001 — yt-dlp configuration contract.
 *
 * This block deliberately REPLACES the Phase-8A deployment lock, which asserted
 * that `YTDLP_NETWORK_ISOLATED` could not be truthy. That contract is retired:
 * the variable was an operator assertion, never the safe-egress boundary, and
 * a retired contract that still parses is worse than one that fails closed.
 *
 * The invariants below are strictly stronger than the ones they replace:
 * presence of the retired variable is now fatal at ANY value, and enablement
 * moved to its own explicit, strictly-parsed flag.
 */
describe("Phase-10C1 yt-dlp configuration contract", () => {
  describe("retired variables are refused by presence", () => {
    it("names both retired variables", () => {
      assert.deepEqual([...WORKER_FORBIDDEN_YTDLP_VARIABLES], [
        "YTDLP_NETWORK_ISOLATED",
        "YTDLP_PATH",
      ]);
    });

    // The retired lock only rejected TRUTHY values. A stale deployment still
    // shipping `false` looked correct while carrying a dead contract, so the
    // replacement rejects the variable existing at all.
    for (const value of ["true", "false", "1", "0", "yes", "no", "", "   ", "TRUE"]) {
      it(`rejects YTDLP_NETWORK_ISOLATED=${JSON.stringify(value)}`, () => {
        expectInvalid(baseEnv({ YTDLP_NETWORK_ISOLATED: value }), "YTDLP_NETWORK_ISOLATED");
      });
    }

    for (const value of ["/usr/bin/yt-dlp", "python3 -m yt_dlp", ""]) {
      it(`rejects YTDLP_PATH=${JSON.stringify(value)}`, () => {
        expectInvalid(baseEnv({ YTDLP_PATH: value }), "YTDLP_PATH");
      });
    }

    it("accepts startup when neither retired variable is present", () => {
      const config = loadWorkerRuntimeConfig(baseEnv());
      assert.equal(config.dataDirectory, "/var/lib/videofetch");
      assert.equal(config.media.ytdlp.enabled, false);
    });

    it("reports the retired variable even when the rest of the environment is empty", () => {
      // A stale deployment must be told WHICH contract it is still carrying,
      // rather than having it buried under unrelated missing-variable noise.
      assert.throws(
        () => loadWorkerRuntimeConfig({ YTDLP_NETWORK_ISOLATED: "false" }),
        (err: unknown) => {
          assert.ok(err instanceof WorkerRuntimeConfigError);
          assert.ok(err.variables.includes("YTDLP_NETWORK_ISOLATED"));
          return true;
        },
      );
    });

    it("never renders the rejected value", () => {
      assert.throws(
        () => loadWorkerRuntimeConfig(baseEnv({ YTDLP_PATH: "/opt/secret-path/yt-dlp" })),
        (err: unknown) => {
          assert.ok(err instanceof WorkerRuntimeConfigError);
          assert.equal(err.message.includes("secret-path"), false);
          assert.ok(err.message.includes("YTDLP_PATH"));
          return true;
        },
      );
    });
  });

  describe("YTDLP_ENABLED is an explicit, fail-closed feature flag", () => {
    it("defaults to disabled when absent", () => {
      assert.equal(loadWorkerRuntimeConfig(baseEnv()).media.ytdlp.enabled, false);
    });

    it("defaults to disabled when empty", () => {
      const config = loadWorkerRuntimeConfig(baseEnv({ YTDLP_ENABLED: "" }));
      assert.equal(config.media.ytdlp.enabled, false);
    });

    it('accepts exactly "false"', () => {
      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ YTDLP_ENABLED: "false" })).media.ytdlp.enabled,
        false,
      );
    });

    it('accepts exactly "true"', () => {
      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ YTDLP_ENABLED: "true" })).media.ytdlp.enabled,
        true,
      );
    });

    it("tolerates surrounding whitespace, which environment files introduce", () => {
      assert.equal(
        loadWorkerRuntimeConfig(baseEnv({ YTDLP_ENABLED: "  true  " })).media.ytdlp.enabled,
        true,
      );
    });

    // Deliberately NOT the retired 1/true/yes truthiness rule. A flag deciding
    // whether a media extractor may run has exactly two spellings; every other
    // spelling is a guess about the grammar and fails closed at startup rather
    // than resolving to either state.
    for (const value of ["1", "0", "yes", "no", "on", "off", "TRUE", "True", "False", "enabled"]) {
      it(`rejects the non-boolean spelling ${JSON.stringify(value)}`, () => {
        expectInvalid(baseEnv({ YTDLP_ENABLED: value }), "YTDLP_ENABLED");
      });
    }

    it("never renders the rejected value", () => {
      assert.throws(
        () => loadWorkerRuntimeConfig(baseEnv({ YTDLP_ENABLED: "sekrit-typo" })),
        (err: unknown) => {
          assert.ok(err instanceof WorkerRuntimeConfigError);
          assert.equal(err.message.includes("sekrit-typo"), false);
          assert.ok(err.message.includes("YTDLP_ENABLED"));
          return true;
        },
      );
    });

    it("enabling the feature does not require, imply or check a runtime install", () => {
      // The configuration boundary owns INTENT only. Whether the pinned runtime
      // is actually present is probed separately and reported separately, so a
      // parsed `true` is never evidence that anything can execute.
      const config = loadWorkerRuntimeConfig(baseEnv({ YTDLP_ENABLED: "true" }));
      assert.equal(config.media.ytdlp.enabled, true);
    });
  });
});

/**
 * VIDEOFETCH-LD1-STAGE-TIME-LIMITS-001 — the stage time limits.
 *
 * `DOWNLOAD_TIME_LIMIT` (60..21600 s, default 600) and `PROCESSING_TIMEOUT`
 * (60..14400 s, default 600) follow the strict loader's existing grammar
 * exactly: unset, empty and whitespace-only mean the default; anything else
 * must be `^[0-9]{1,17}$` within range, or startup fails naming only the
 * variable. The retired `DOWNLOAD_TIMEOUT` is refused by presence.
 */
describe("VIDEOFETCH-LD1 stage time limits", () => {
  const VARIABLES = [
    { name: "DOWNLOAD_TIME_LIMIT", field: "downloadTimeLimitSeconds", min: 60, max: 21_600 },
    { name: "PROCESSING_TIMEOUT", field: "processingTimeoutSeconds", min: 60, max: 14_400 },
  ] as const;

  const read = (env: NodeJS.ProcessEnv, field: (typeof VARIABLES)[number]["field"]) =>
    loadWorkerRuntimeConfig(env).media[field];

  for (const v of VARIABLES) {
    describe(v.name, () => {
      it("defaults to 600 when absent", () => {
        assert.equal(read(baseEnv(), v.field), 600);
      });

      for (const blank of ["", " ", "   ", "\t", " \n ", "\r\n"]) {
        it(`treats ${JSON.stringify(blank)} as unset (the default), never as zero`, () => {
          assert.equal(read(baseEnv({ [v.name]: blank }), v.field), 600);
        });
      }

      it("accepts the range ends and the values just inside them", () => {
        for (const n of [v.min, v.min + 1, 600, v.max - 1, v.max]) {
          assert.equal(read(baseEnv({ [v.name]: String(n) }), v.field), n, String(n));
        }
      });

      it("refuses the values just outside the range, zero and negatives", () => {
        for (const raw of [String(v.min - 1), String(v.max + 1), "0", "1", "-1", "-600"]) {
          expectInvalid(baseEnv({ [v.name]: raw }), v.name);
        }
      });

      it("refuses decimals, exponents, signs, separators, hex and words", () => {
        for (const raw of [
          "600.0",
          "600.5",
          "60.1",
          "6e2",
          "6E2",
          "1e3",
          "+600",
          "600_000",
          "6 00",
          "0x258",
          "600s",
          "10m",
          "ten",
          "Infinity",
          "NaN",
        ]) {
          expectInvalid(baseEnv({ [v.name]: raw }), v.name);
        }
      });

      it("refuses unsafe and oversized integers rather than rounding them", () => {
        for (const raw of ["9007199254740992", "9007199254740993", "99999999999999999", "123456789012345678"]) {
          expectInvalid(baseEnv({ [v.name]: raw }), v.name);
        }
      });

      it("accepts leading zeros within the 17-digit grammar, and trims surrounding whitespace", () => {
        assert.equal(read(baseEnv({ [v.name]: "0600" }), v.field), 600);
        assert.equal(read(baseEnv({ [v.name]: "00000000000000600" }), v.field), 600);
        assert.equal(read(baseEnv({ [v.name]: " 600 " }), v.field), 600);
        // Eighteen digits break the grammar even when the value is in range.
        expectInvalid(baseEnv({ [v.name]: "000000000000000600" }), v.name);
      });

      it("names only the variable, never the rejected value", () => {
        assert.throws(
          () => loadWorkerRuntimeConfig(baseEnv({ [v.name]: "SENTINEL-LIMIT-VALUE" })),
          (err: unknown) => {
            assert.ok(err instanceof WorkerRuntimeConfigError);
            assert.deepEqual([...err.variables], [v.name]);
            assert.equal(err.message.includes("SENTINEL-LIMIT-VALUE"), false);
            return true;
          },
        );
      });
    });
  }

  it("keeps the two limits independent: setting one never moves the other", () => {
    const a = loadWorkerRuntimeConfig(baseEnv({ DOWNLOAD_TIME_LIMIT: "9000" })).media;
    assert.equal(a.downloadTimeLimitSeconds, 9000);
    assert.equal(a.processingTimeoutSeconds, 600);
    const b = loadWorkerRuntimeConfig(baseEnv({ PROCESSING_TIMEOUT: "14400" })).media;
    assert.equal(b.downloadTimeLimitSeconds, 600);
    assert.equal(b.processingTimeoutSeconds, 14400);
  });

  it("keeps the LD-1 acquisition default at 600 s; 9,000 s only by explicit configuration", () => {
    assert.equal(loadWorkerRuntimeConfig(baseEnv()).media.downloadTimeLimitSeconds, 600);
  });

  it("no longer exposes the retired field", () => {
    const media = loadWorkerRuntimeConfig(baseEnv()).media as Record<string, unknown>;
    assert.equal(Object.hasOwn(media, "downloadTimeoutSeconds"), false);
  });

  describe("DOWNLOAD_TIMEOUT is retired and refused by presence", () => {
    it("is the one retired stage-time variable", () => {
      assert.deepEqual([...WORKER_FORBIDDEN_TIME_LIMIT_VARIABLES], ["DOWNLOAD_TIMEOUT"]);
      assert.ok(Object.isFrozen(WORKER_FORBIDDEN_TIME_LIMIT_VARIABLES));
    });

    for (const value of ["600", "120", "9000", "0", "", " ", "   ", "\t", "not-a-number"]) {
      it(`refuses DOWNLOAD_TIMEOUT=${JSON.stringify(value)}`, () => {
        expectInvalid(baseEnv({ DOWNLOAD_TIMEOUT: value }), "DOWNLOAD_TIMEOUT");
      });
    }

    it("is not an alias: even with both new variables set validly, it is refused", () => {
      expectInvalid(
        baseEnv({ DOWNLOAD_TIMEOUT: "600", DOWNLOAD_TIME_LIMIT: "600", PROCESSING_TIMEOUT: "600" }),
        "DOWNLOAD_TIMEOUT",
      );
    });

    it("is reported even when the rest of the environment is empty", () => {
      assert.throws(
        () => loadWorkerRuntimeConfig({ DOWNLOAD_TIMEOUT: "" }),
        (err: unknown) => {
          assert.ok(err instanceof WorkerRuntimeConfigError);
          assert.ok(err.variables.includes("DOWNLOAD_TIMEOUT"));
          return true;
        },
      );
    });

    it("never renders the rejected value", () => {
      assert.throws(
        () => loadWorkerRuntimeConfig(baseEnv({ DOWNLOAD_TIMEOUT: "SENTINEL-RETIRED-VALUE" })),
        (err: unknown) => {
          assert.ok(err instanceof WorkerRuntimeConfigError);
          assert.deepEqual([...err.variables], ["DOWNLOAD_TIMEOUT"]);
          assert.equal(`${err.message}\n${err.stack ?? ""}`.includes("SENTINEL-RETIRED-VALUE"), false);
          return true;
        },
      );
    });

    it("accepts startup when it is absent", () => {
      assert.doesNotThrow(() => loadWorkerRuntimeConfig(baseEnv()));
    });
  });
});

/**
 * VIDEOFETCH-LD2A-JOB-LIFETIME-AND-RETENTION-001 — the job-lifetime inputs.
 *
 * `UPLOAD_TIMEOUT` (300..14400 s, default 3600) is new: parsed and budgeted into
 * the derived job lifetime, NOT enforced before LD-2b. `FILE_EXPIRATION_MINUTES`
 * keeps its default (45) but is capped at 55 (was 1440): it is now the retention
 * after a job ends, and a ready link must end before the R2 lifecycle rule
 * deletes the object. Both follow the strict loader's grammar exactly.
 */
describe("VIDEOFETCH-LD2A job-lifetime inputs", () => {
  const VARIABLES = [
    { name: "UPLOAD_TIMEOUT", field: "uploadTimeoutSeconds", min: 300, max: 14_400, fallback: 3600 },
    { name: "FILE_EXPIRATION_MINUTES", field: "fileExpirationMinutes", min: 1, max: 55, fallback: 45 },
  ] as const;

  const read = (env: NodeJS.ProcessEnv, field: (typeof VARIABLES)[number]["field"]) =>
    loadWorkerRuntimeConfig(env).media[field];

  for (const v of VARIABLES) {
    describe(v.name, () => {
      it(`defaults to ${v.fallback} when absent`, () => {
        assert.equal(read(baseEnv(), v.field), v.fallback);
      });

      for (const blank of ["", " ", "   ", "\t", " \n ", "\r\n"]) {
        it(`treats ${JSON.stringify(blank)} as unset (the default), never as zero`, () => {
          assert.equal(read(baseEnv({ [v.name]: blank }), v.field), v.fallback);
        });
      }

      it("accepts the range ends, the default and the values just inside the ends", () => {
        for (const n of [v.min, v.min + 1, v.fallback, v.max - 1, v.max]) {
          assert.equal(read(baseEnv({ [v.name]: String(n) }), v.field), n, String(n));
        }
      });

      it("refuses the values just outside the range, zero and negatives", () => {
        for (const raw of [String(v.min - 1), String(v.max + 1), "0", "-1", `-${v.fallback}`]) {
          expectInvalid(baseEnv({ [v.name]: raw }), v.name);
        }
      });

      it("refuses decimals, exponents, signs, separators, hex and words", () => {
        for (const raw of [
          `${v.fallback}.0`,
          `${v.fallback}.5`,
          "1e1",
          "3.6e3",
          "1E2",
          `+${v.fallback}`,
          "3_600",
          "3 600",
          "0x10",
          `${v.fallback}s`,
          "45m",
          "forty-five",
          "Infinity",
          "NaN",
        ]) {
          expectInvalid(baseEnv({ [v.name]: raw }), v.name);
        }
      });

      it("refuses unsafe and oversized integers rather than rounding them", () => {
        for (const raw of ["9007199254740992", "9007199254740993", "99999999999999999", "123456789012345678"]) {
          expectInvalid(baseEnv({ [v.name]: raw }), v.name);
        }
      });

      it("accepts leading zeros within the 17-digit grammar, and trims surrounding whitespace", () => {
        assert.equal(read(baseEnv({ [v.name]: `0${v.fallback}` }), v.field), v.fallback);
        assert.equal(read(baseEnv({ [v.name]: ` ${v.fallback} ` }), v.field), v.fallback);
        // Eighteen digits break the grammar even when the value is in range.
        expectInvalid(baseEnv({ [v.name]: String(v.fallback).padStart(18, "0") }), v.name);
      });

      it("names only the variable, never the rejected value", () => {
        assert.throws(
          () => loadWorkerRuntimeConfig(baseEnv({ [v.name]: "SENTINEL-LIFETIME-VALUE" })),
          (err: unknown) => {
            assert.ok(err instanceof WorkerRuntimeConfigError);
            assert.deepEqual([...err.variables], [v.name]);
            assert.equal(`${err.message}\n${err.stack ?? ""}`.includes("SENTINEL-LIFETIME-VALUE"), false);
            return true;
          },
        );
      });
    });
  }

  it("caps FILE_EXPIRATION_MINUTES at 55: 0, 56, 60 and the pre-LD-2a 1440 are refused", () => {
    for (const raw of ["0", "56", "60", "1440", "1441"]) {
      expectInvalid(baseEnv({ FILE_EXPIRATION_MINUTES: raw }), "FILE_EXPIRATION_MINUTES");
    }
    for (const n of [1, 45, 55]) {
      assert.equal(read(baseEnv({ FILE_EXPIRATION_MINUTES: String(n) }), "fileExpirationMinutes"), n);
    }
  });

  it("keeps the inputs independent: setting one never moves another", () => {
    const a = loadWorkerRuntimeConfig(baseEnv({ UPLOAD_TIMEOUT: "14400" })).media;
    assert.equal(a.uploadTimeoutSeconds, 14_400);
    assert.equal(a.fileExpirationMinutes, 45);
    assert.equal(a.downloadTimeLimitSeconds, 600);
    assert.equal(a.processingTimeoutSeconds, 600);
    const b = loadWorkerRuntimeConfig(baseEnv({ FILE_EXPIRATION_MINUTES: "55" })).media;
    assert.equal(b.uploadTimeoutSeconds, 3600);
    assert.equal(b.fileExpirationMinutes, 55);
  });

  it("names every offending variable at once, and still refuses the retired DOWNLOAD_TIMEOUT", () => {
    assert.throws(
      () =>
        loadWorkerRuntimeConfig(
          baseEnv({ UPLOAD_TIMEOUT: "1", FILE_EXPIRATION_MINUTES: "99", DOWNLOAD_TIMEOUT: "600" }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof WorkerRuntimeConfigError);
        assert.deepEqual([...err.variables], ["DOWNLOAD_TIMEOUT", "FILE_EXPIRATION_MINUTES", "UPLOAD_TIMEOUT"]);
        return true;
      },
    );
  });

  it("introduces no lifetime variable: JOB_LIFETIME and EXECUTION_MARGIN are not read", () => {
    const media = loadWorkerRuntimeConfig(baseEnv({ JOB_LIFETIME: "1", EXECUTION_MARGIN: "1" })).media;
    assert.equal(Object.hasOwn(media, "jobLifetimeSeconds"), false);
    assert.equal(Object.hasOwn(media, "executionMarginSeconds"), false);
    assert.equal(media.uploadTimeoutSeconds, 3600);
  });
});
