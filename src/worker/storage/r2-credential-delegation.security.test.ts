import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { R2CredentialBroker, type R2BrokerConfig } from "../../broker/r2/broker-service.ts";
import { startR2BrokerSocketServer } from "../../broker/r2/socket-server.ts";
import { decodeSessionTokenClaims } from "../../broker/r2/temporary-credentials.ts";
import { BrokerR2CredentialProvider } from "./broker-credential-client.server.ts";
import { DelegatedR2ObjectStoreWriter, DelegatedR2Error } from "./delegated-r2-writer.server.ts";
import {
  CloudflareR2ObjectStoreWriter,
  type CloudflareR2Config,
} from "./cloudflare-r2-writer.server.ts";
import type { ObjectStoreWriter } from "./writer.ts";
import type { WorkerObjectKey } from "../../shared/worker/contracts.ts";
import {
  R2_CREDENTIAL_TTL_HARD_CAP_SECONDS,
  R2_FORBIDDEN_ACTIONS,
} from "../../shared/worker/r2-broker.ts";
import {
  WORKER_FORBIDDEN_R2_VARIABLES,
  WorkerRuntimeConfigError,
  loadWorkerRuntimeConfig,
} from "../runtime/config.server.ts";

/**
 * WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001 — consolidated security evidence.
 *
 * Every credential in this file is FAKE and deterministic. No Cloudflare
 * endpoint is contacted, no real R2 bucket or token is referenced, and the only
 * socket opened is a local AF_UNIX socket in a temporary directory.
 *
 * The assertions here are deliberately made against REAL production objects —
 * the real broker, the real Unix-socket transport, the real client, the real
 * delegated writer and the real `CloudflareR2ObjectStoreWriter` — so they
 * describe what the system actually does rather than what a fake was told to
 * report.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "videofetch-objects";
const OTHER_BUCKET = "someone-elses-bucket";
const JOB_ID = "a".repeat(32);
const KEY = `videofetch/jobs/${JOB_ID}/${"b".repeat(32)}` as WorkerObjectKey;
const SIBLING_KEY = `videofetch/jobs/${JOB_ID}/${"c".repeat(32)}` as WorkerObjectKey;

const PARENT_KEY_ID = "fake-parent-access-key-id";
const PARENT_SECRET = "fake-parent-secret-access-key-do-not-use";

const BROKER_CONFIG: R2BrokerConfig = {
  accountId: ACCOUNT_ID,
  bucket: BUCKET,
  jurisdiction: "default",
  parentAccessKeyId: PARENT_KEY_ID,
  parentSecretAccessKey: PARENT_SECRET,
};

/** Mints through the REAL broker (in-process, no socket) for claim inspection. */
function mintThroughBroker(action: string, objectKey: string = KEY, bucket: string = BUCKET) {
  return new R2CredentialBroker({ config: BROKER_CONFIG }).handle({
    bucket,
    objectKey,
    action,
    ttlSeconds: 120,
  });
}

/** Every source file the Worker actually ships, tests excluded. */
function workerProductionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
      if (full.endsWith(".test.ts") || full.endsWith(".test.tsx")) continue;
      out.push(full);
    }
  };
  walk(join(REPO_ROOT, "src", "worker"));
  return out;
}

function baseWorkerEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    WORKER_DATA_DIRECTORY: "/var/lib/videofetch",
    WORKER_CONTROL_KEY_ID: "worker-control-1",
    WORKER_CONTROL_SECRET: "0123456789abcdef0123456789abcdef",
    R2_ACCOUNT_ID: ACCOUNT_ID,
    R2_BUCKET: BUCKET,
    R2_BROKER_SOCKET_PATH: "/run/videofetch-r2-broker/broker.sock",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

// ── Per-operation action scoping ────────────────────────────────────────────

describe("delegated credential action scoping", () => {
  it("accepts the exact valid object key", () => {
    const decision = mintThroughBroker("PutObject", KEY);
    assert.equal(decision.ok, true, "a well-formed key for the configured bucket is accepted");
    if (!decision.ok) return;
    assert.equal(decision.response.objectKey, KEY);
  });

  it("PutObject carries no Get, List or Delete authority", () => {
    const decision = mintThroughBroker("PutObject");
    assert.equal(decision.ok, true);
    if (!decision.ok) return;

    const actions = decodeSessionTokenClaims(decision.response.sessionToken)
      .actions as readonly string[];

    assert.deepEqual(actions, ["PutObject"]);
    for (const denied of ["GetObject", "HeadObject", "DeleteObject", "ListObjectsV2", "ListBucket"]) {
      assert.equal(actions.includes(denied), false, `PutObject must not grant ${denied}`);
    }
  });

  it("HeadObject carries no Put, Get, List or Delete authority", () => {
    const decision = mintThroughBroker("HeadObject");
    assert.equal(decision.ok, true);
    if (!decision.ok) return;

    const actions = decodeSessionTokenClaims(decision.response.sessionToken)
      .actions as readonly string[];

    assert.deepEqual(actions, ["HeadObject"]);
    for (const denied of ["PutObject", "GetObject", "DeleteObject", "ListObjectsV2", "ListBucket"]) {
      assert.equal(actions.includes(denied), false, `HeadObject must not grant ${denied}`);
    }
  });

  it("DeleteObject carries no Put, Get or List authority", () => {
    const decision = mintThroughBroker("DeleteObject");
    assert.equal(decision.ok, true);
    if (!decision.ok) return;

    const actions = decodeSessionTokenClaims(decision.response.sessionToken)
      .actions as readonly string[];

    assert.deepEqual(actions, ["DeleteObject"]);
    for (const denied of ["PutObject", "GetObject", "HeadObject", "ListObjectsV2", "ListBucket"]) {
      assert.equal(actions.includes(denied), false, `DeleteObject must not grant ${denied}`);
    }
  });

  it("grants none of the forbidden actions, for any operation", () => {
    for (const action of ["PutObject", "HeadObject", "DeleteObject"]) {
      const decision = mintThroughBroker(action);
      assert.equal(decision.ok, true);
      if (!decision.ok) continue;
      const actions = decodeSessionTokenClaims(decision.response.sessionToken)
        .actions as readonly string[];
      for (const forbidden of R2_FORBIDDEN_ACTIONS) {
        assert.equal(actions.includes(forbidden), false, `${action} must not grant ${forbidden}`);
      }
    }
  });

  it("binds every credential to one exact object, never a prefix or sibling", () => {
    const decision = mintThroughBroker("DeleteObject", KEY);
    assert.equal(decision.ok, true);
    if (!decision.ok) return;

    const claims = decodeSessionTokenClaims(decision.response.sessionToken);
    assert.deepEqual(claims.paths.objectPaths, [KEY]);
    assert.deepEqual(claims.paths.prefixPaths, [], "no prefix authority is ever granted");
    assert.equal(
      (claims.paths.objectPaths as readonly string[]).includes(SIBLING_KEY),
      false,
      "a credential cannot reach a sibling object under the same job prefix",
    );
  });

  it("cannot be asked for another bucket", () => {
    const decision = mintThroughBroker("PutObject", KEY, OTHER_BUCKET);
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.code, "unauthorized_bucket");
  });

  it("never mints beyond the documented hard cap", () => {
    const decision = mintThroughBroker("PutObject");
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.ok(
      decision.response.expiresAt - Date.now() <= R2_CREDENTIAL_TTL_HARD_CAP_SECONDS * 1000,
      "no credential may become quasi-persistent",
    );
  });
});

// ── The session token actually reaches the S3 client ────────────────────────

describe("session token delivery", () => {
  it("is supplied to the REAL S3 client for every operation", async () => {
    const configs: CloudflareR2Config[] = [];

    const writer = new DelegatedR2ObjectStoreWriter({
      location: { accountId: ACCOUNT_ID, bucket: BUCKET, jurisdiction: "default" },
      credentials: {
        async mint(request) {
          return {
            accessKeyId: "fake-delegated-key-id",
            secretAccessKey: "fake-delegated-secret",
            sessionToken: `fake-session-token-${request.action}`,
            expiresAt: Date.now() + 60_000,
          };
        },
      },
      createWriter: (config): ObjectStoreWriter => {
        configs.push(config);
        // A stub performs the operation, so no request is ever dispatched.
        return {
          async put() {},
          async head() {
            return null;
          },
          async delete() {},
        };
      },
    });

    await writer.put({
      objectKey: KEY,
      body: (async function* () {
        yield new Uint8Array([1]);
      })(),
      contentLength: 1,
      contentType: "video/mp4",
      contentDisposition: 'attachment; filename="v.mp4"',
    });
    await writer.head(KEY);
    await writer.delete(KEY);

    assert.deepEqual(
      configs.map((c) => c.sessionToken),
      [
        "fake-session-token-PutObject",
        "fake-session-token-HeadObject",
        "fake-session-token-DeleteObject",
      ],
      "each operation is configured with its own delegated session token",
    );

    // Now prove the token is not merely carried in the config object but is
    // actually handed to a real AWS S3 client. Constructing the production
    // writer performs NO request — the first call would happen at send() time,
    // which never occurs here.
    for (const config of configs) {
      const real = new CloudflareR2ObjectStoreWriter(config);
      const resolved = await (
        real as unknown as {
          client: { config: { credentials: () => Promise<{ sessionToken?: string; accessKeyId: string; secretAccessKey: string }> } };
        }
      ).client.config.credentials();

      assert.equal(resolved.sessionToken, config.sessionToken, "session token reaches the S3 client");
      assert.ok((resolved.sessionToken ?? "").length > 0, "and it is non-empty");
      assert.equal(resolved.accessKeyId, "fake-delegated-key-id");
      assert.equal(resolved.secretAccessKey, "fake-delegated-secret");
    }
  });

  it("uses a DISTINCT session token per action", async () => {
    const tokens = new Set<string>();
    for (const action of ["PutObject", "HeadObject", "DeleteObject"]) {
      const decision = mintThroughBroker(action);
      assert.equal(decision.ok, true);
      if (decision.ok) tokens.add(decision.response.sessionToken);
    }
    assert.equal(tokens.size, 3, "one credential can never stand in for another action");
  });
});

// ── End-to-end over the real Unix socket ────────────────────────────────────

describe("end-to-end delegation over the real socket boundary", () => {
  it("performs a full scoped operation and fails closed when the broker stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "r2sec-"));
    const socketPath = join(root, "b.sock");
    const listener = await startR2BrokerSocketServer({
      broker: new R2CredentialBroker({ config: BROKER_CONFIG }),
      socketPath,
    });

    const commands: string[] = [];
    const writer = new DelegatedR2ObjectStoreWriter({
      location: { accountId: ACCOUNT_ID, bucket: BUCKET, jurisdiction: "default" },
      credentials: new BrokerR2CredentialProvider({ socketPath, bucket: BUCKET }),
      createWriter: (config) =>
        new CloudflareR2ObjectStoreWriter(config, {
          send: async (command: { constructor: { name: string } }) => {
            commands.push(command.constructor.name);
            return {};
          },
        }),
    });

    try {
      await writer.delete(KEY);
      assert.deepEqual(commands, ["DeleteObjectCommand"], "exactly one exact-key delete");
    } finally {
      await listener.close();
    }

    // Broker gone -> the R2 operation is unavailable. It does NOT fall back to
    // any other credential, because the Worker holds none.
    await assert.rejects(() => writer.delete(KEY), (err: unknown) => {
      assert.ok(err instanceof DelegatedR2Error);
      assert.equal(err.failure, "credential_unavailable");
      return true;
    });
    assert.deepEqual(commands, ["DeleteObjectCommand"], "no second R2 request was attempted");

    await rm(root, { recursive: true, force: true });
  });
});

// ── Parent-secret custody ───────────────────────────────────────────────────

describe("parent secret custody", () => {
  it("never appears in the Worker runtime configuration", () => {
    const config = loadWorkerRuntimeConfig(baseWorkerEnv());

    assert.ok(!("accessKeyId" in config.r2), "no access key id on the Worker config");
    assert.ok(!("secretAccessKey" in config.r2), "no secret on the Worker config");
    assert.ok(!("sessionToken" in config.r2), "no session token on the Worker config");
    assert.equal(Object.keys(config.r2).sort().join(","), "accountId,brokerSocketPath,bucket,jurisdiction");

    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes(PARENT_SECRET), false);
    assert.equal(serialized.includes(PARENT_KEY_ID), false);
  });

  it("makes the Worker refuse to start when a parent or legacy credential is present", () => {
    for (const name of WORKER_FORBIDDEN_R2_VARIABLES) {
      assert.throws(
        () => loadWorkerRuntimeConfig(baseWorkerEnv({ [name]: "any-non-empty-value" })),
        (err: unknown) => {
          assert.ok(err instanceof WorkerRuntimeConfigError);
          assert.ok(err.variables.includes(name), `${name} must be named as invalid`);
          // The VALUE is never rendered, only the variable name.
          assert.equal(err.message.includes("any-non-empty-value"), false);
          return true;
        },
        `${name} must be fatal in the media container`,
      );
    }
  });

  it("is never read by any Worker production source file", () => {
    const forbiddenNames = ["R2_BROKER_PARENT_ACCESS_KEY_ID", "R2_BROKER_PARENT_SECRET_ACCESS_KEY"];
    for (const file of workerProductionSources()) {
      const source = readFileSync(file, "utf8");
      for (const name of forbiddenNames) {
        // The runtime config module names them only inside the forbidden-list
        // constant, which exists precisely to REJECT them.
        if (file.endsWith(join("runtime", "config.server.ts"))) continue;
        assert.equal(
          source.includes(name),
          false,
          `${relative(REPO_ROOT, file)} must not reference ${name}`,
        );
      }
      assert.equal(
        /process\.env\.R2_/.test(source) && !file.endsWith(join("runtime", "config.server.ts")),
        false,
        `${relative(REPO_ROOT, file)} must not read an R2 variable directly`,
      );
    }
  });

  it("never appears in the Worker container argv", () => {
    const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile.worker"), "utf8");

    // The image's executable instructions must not carry any credential.
    const executable = dockerfile
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    for (const name of [
      ...WORKER_FORBIDDEN_R2_VARIABLES,
      "R2_SIGNER_ACCESS_KEY_ID",
      "R2_SIGNER_SECRET_ACCESS_KEY",
    ]) {
      assert.equal(
        new RegExp(`\\b${name}\\s*=`).test(executable),
        false,
        `${name} must never be assigned in the Worker image`,
      );
    }

    // The CMD is the process argv. It launches the runtime and nothing else.
    const cmd = /^CMD\s+(.+)$/m.exec(executable)?.[1] ?? "";
    assert.ok(cmd.length > 0, "the image declares a CMD");
    assert.match(cmd, /main\.server\.ts/);
    for (const marker of ["R2_", "secret", "SECRET", "accessKey", "ACCESS_KEY"]) {
      assert.equal(cmd.includes(marker), false, `argv must not carry ${marker}`);
    }
  });

  it("never crosses the socket boundary in a broker response", () => {
    for (const action of ["PutObject", "HeadObject", "DeleteObject"]) {
      const decision = mintThroughBroker(action);
      assert.equal(decision.ok, true);
      if (!decision.ok) continue;

      const wire = JSON.stringify(decision.response);
      assert.equal(wire.includes(PARENT_SECRET), false, "the parent secret never crosses the wire");

      // The token body is signed WITH the parent secret but never contains it.
      const decoded = Buffer.from(decision.response.sessionToken, "base64").toString("utf8");
      assert.equal(decoded.includes(PARENT_SECRET), false);
    }
  });
});

// ── Logging discipline ──────────────────────────────────────────────────────

describe("broker logging discipline", () => {
  it("logs a category for a refusal and nothing at all for a success", () => {
    const lines: string[] = [];
    const broker = new R2CredentialBroker({
      config: BROKER_CONFIG,
      observer: (outcome, code) => {
        if (outcome === "refused") lines.push(`[r2-broker] refused ${code}`);
      },
    });

    const minted = broker.handle({ bucket: BUCKET, objectKey: KEY, action: "PutObject", ttlSeconds: 120 });
    broker.handle({ bucket: OTHER_BUCKET, objectKey: KEY, action: "PutObject", ttlSeconds: 120 });
    broker.handle({ bucket: BUCKET, objectKey: "bad", action: "PutObject", ttlSeconds: 120 });

    assert.deepEqual(lines, [
      "[r2-broker] refused unauthorized_bucket",
      "[r2-broker] refused invalid_object_key",
    ]);

    const all = lines.join("\n");
    assert.equal(all.includes(PARENT_SECRET), false);
    assert.equal(all.includes(PARENT_KEY_ID), false);
    assert.equal(all.includes(KEY), false, "an object key is not a log value");
    assert.equal(all.includes(OTHER_BUCKET), false, "a bucket name is not a log value");
    if (minted.ok) {
      assert.equal(all.includes(minted.response.secretAccessKey), false);
      assert.equal(all.includes(minted.response.sessionToken), false);
    }
  });
});

// ── No static-credential fallback ───────────────────────────────────────────

describe("static-credential fallback", () => {
  it("does not exist in ANY deployment mode, Production included", () => {
    for (const nodeEnv of ["production", "development", "test", undefined]) {
      const config = loadWorkerRuntimeConfig(baseWorkerEnv({ NODE_ENV: nodeEnv }));
      assert.ok(!("secretAccessKey" in config.r2), `no static credential under NODE_ENV=${nodeEnv}`);
      assert.equal(typeof config.r2.brokerSocketPath, "string");
    }
  });

  it("is not reachable in code: the composition root builds only the delegated writer", () => {
    const runtime = readFileSync(join(REPO_ROOT, "src/worker/runtime/runtime.server.ts"), "utf8");

    assert.match(runtime, /new DelegatedR2ObjectStoreWriter\(/, "composition uses delegation");
    assert.equal(
      /new CloudflareR2ObjectStoreWriter\(/.test(runtime),
      false,
      "the composition root must not build a directly-credentialed R2 writer",
    );

    // Exactly one production module may construct the credentialed R2 writer,
    // and it is the delegated one that receives a per-operation credential.
    const constructors = workerProductionSources().filter((file) =>
      /new CloudflareR2ObjectStoreWriter\(/.test(readFileSync(file, "utf8")),
    );
    assert.deepEqual(
      constructors.map((f) => relative(REPO_ROOT, f)),
      ["src/worker/storage/delegated-r2-writer.server.ts"],
    );
  });

  it("regression: the old persistent R2_WRITER_* contract can no longer start the Worker", () => {
    // The exact superseded production contract: account, bucket and a
    // persistent writer identity, with no broker socket. Under the old design
    // this started a Worker holding a long-lived R2 credential.
    const legacyOnly = baseWorkerEnv({
      R2_BROKER_SOCKET_PATH: undefined,
      R2_WRITER_ACCESS_KEY_ID: "legacy-writer-access-key-id",
      R2_WRITER_SECRET_ACCESS_KEY: "legacy-writer-secret-access-key",
    });

    assert.throws(
      () => loadWorkerRuntimeConfig(legacyOnly),
      (err: unknown) => {
        assert.ok(err instanceof WorkerRuntimeConfigError);
        // Both halves of the refusal are reported: the missing broker socket,
        // and the presence of the superseded credential.
        assert.ok(err.variables.includes("R2_BROKER_SOCKET_PATH"));
        assert.ok(err.variables.includes("R2_WRITER_ACCESS_KEY_ID"));
        assert.ok(err.variables.includes("R2_WRITER_SECRET_ACCESS_KEY"));
        assert.equal(err.message.includes("legacy-writer-secret-access-key"), false);
        return true;
      },
    );

    // Even WITH a valid broker socket, the legacy secret alone is still fatal:
    // there is no "broker configured, so the stale secret is harmless" path.
    assert.throws(
      () =>
        loadWorkerRuntimeConfig(
          baseWorkerEnv({ R2_WRITER_SECRET_ACCESS_KEY: "legacy-writer-secret-access-key" }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof WorkerRuntimeConfigError);
        assert.deepEqual(err.variables, ["R2_WRITER_SECRET_ACCESS_KEY"]);
        return true;
      },
    );
  });
});
