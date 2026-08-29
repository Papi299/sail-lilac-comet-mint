import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { R2CredentialBroker, type R2BrokerConfig } from "./broker-service.ts";
import { startR2BrokerSocketServer, type R2BrokerSocketServer } from "./socket-server.ts";
import { decodeSessionTokenClaims } from "./temporary-credentials.ts";
import {
  BrokerR2CredentialProvider,
  R2CredentialBrokerError,
} from "../../worker/storage/broker-credential-client.server.ts";
import { R2_BROKER_MINT_PATH } from "../../shared/worker/r2-broker.ts";

/**
 * The real Worker <-> broker boundary, over a real AF_UNIX socket.
 *
 * A real broker process object, a real Unix socket on disk, and the real
 * production client. Fake deterministic credentials only; no Cloudflare
 * endpoint is contacted and no IP socket is opened anywhere in this file.
 */

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "videofetch-objects";
const JOB_ID = "a".repeat(32);
const OBJECT_KEY = `videofetch/jobs/${JOB_ID}/${"b".repeat(32)}`;
const PARENT_SECRET = "fake-parent-secret-access-key-do-not-use";

const CONFIG: R2BrokerConfig = {
  accountId: ACCOUNT_ID,
  bucket: BUCKET,
  jurisdiction: "default",
  parentAccessKeyId: "fake-parent-access-key-id",
  parentSecretAccessKey: PARENT_SECRET,
};

/** Raw request helper, for cases the typed client refuses to express. */
function rawPost(
  socketPath: string,
  path: string,
  body: string,
  method = "POST",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath, path, method, headers: { "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Like `rawPost`, but for a body the server rejects mid-write.
 *
 * The broker answers 413 and closes the connection without draining, so the
 * client's remaining write may fail with EPIPE. Both outcomes are correct; this
 * helper resolves only once the socket is fully closed, so no asynchronous
 * activity outlives the test.
 */
function rawPostOversized(
  socketPath: string,
  path: string,
  body: string,
): Promise<{ status: number | null }> {
  return new Promise((resolve) => {
    let status: number | null = null;
    const req = httpRequest(
      { socketPath, path, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        status = res.statusCode ?? null;
        res.resume();
      },
    );
    req.on("error", () => {});
    req.on("close", () => resolve({ status }));
    req.end(body);
  });
}

describe("R2 broker Unix-socket boundary", () => {
  let root: string;
  let socketPath: string;
  let listener: R2BrokerSocketServer;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "r2b-"));
    socketPath = join(root, "b.sock");
    listener = await startR2BrokerSocketServer({
      broker: new R2CredentialBroker({ config: CONFIG }),
      socketPath,
    });
  });

  after(async () => {
    await listener.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it("binds a real Unix socket with group-only permissions", async () => {
    const info = await stat(socketPath);
    assert.ok(info.isSocket(), "the boundary is an AF_UNIX socket, not a port");
    // 0o660: the broker's user and group only. World access would let any
    // local account mint credentials.
    assert.equal(info.mode & 0o777, 0o660);
  });

  it("mints a scoped credential for the real production client", async () => {
    const provider = new BrokerR2CredentialProvider({ socketPath, bucket: BUCKET });

    const credential = await provider.mint({
      action: "PutObject",
      objectKey: OBJECT_KEY,
      ttlSeconds: 300,
    });

    assert.ok(credential.sessionToken.length > 0, "session token is always present");
    assert.ok(credential.expiresAt > Date.now(), "credential is live");

    const claims = decodeSessionTokenClaims(credential.sessionToken);
    assert.deepEqual(claims.actions, ["PutObject"]);
    assert.deepEqual(claims.paths.objectPaths, [OBJECT_KEY]);
    assert.deepEqual(claims.paths.prefixPaths, []);
    assert.equal(claims.bucket, BUCKET);
  });

  it("never returns the parent secret over the boundary", async () => {
    const provider = new BrokerR2CredentialProvider({ socketPath, bucket: BUCKET });
    const raw = await rawPost(
      socketPath,
      R2_BROKER_MINT_PATH,
      JSON.stringify({ bucket: BUCKET, objectKey: OBJECT_KEY, action: "PutObject", ttlSeconds: 300 }),
    );

    assert.equal(raw.status, 200);
    assert.equal(
      raw.body.includes(PARENT_SECRET),
      false,
      "the parent secret must never cross the socket",
    );

    const credential = await provider.mint({
      action: "HeadObject",
      objectKey: OBJECT_KEY,
      ttlSeconds: 120,
    });
    assert.equal(JSON.stringify(credential).includes(PARENT_SECRET), false);
  });

  it("refuses a wrong bucket over the wire", async () => {
    const res = await rawPost(
      socketPath,
      R2_BROKER_MINT_PATH,
      JSON.stringify({
        bucket: "someone-elses-bucket",
        objectKey: OBJECT_KEY,
        action: "PutObject",
        ttlSeconds: 300,
      }),
    );
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.body), { error: "unauthorized_bucket" });
  });

  it("refuses a forbidden action over the wire", async () => {
    for (const action of ["GetObject", "ListObjectsV2", "DeleteObjects"]) {
      const res = await rawPost(
        socketPath,
        R2_BROKER_MINT_PATH,
        JSON.stringify({ bucket: BUCKET, objectKey: OBJECT_KEY, action, ttlSeconds: 300 }),
      );
      assert.equal(res.status, 403, `${action} must be refused`);
      assert.deepEqual(JSON.parse(res.body), { error: "unauthorized_action" });
    }
  });

  it("refuses a malformed key, an unparseable body and an oversized body", async () => {
    const badKey = await rawPost(
      socketPath,
      R2_BROKER_MINT_PATH,
      JSON.stringify({ bucket: BUCKET, objectKey: "../etc/passwd", action: "PutObject", ttlSeconds: 300 }),
    );
    assert.equal(badKey.status, 400);
    assert.deepEqual(JSON.parse(badKey.body), { error: "invalid_object_key" });

    const unparseable = await rawPost(socketPath, R2_BROKER_MINT_PATH, "{not json");
    assert.equal(unparseable.status, 400);
    assert.deepEqual(JSON.parse(unparseable.body), { error: "malformed_request" });

    const oversized = await rawPostOversized(
      socketPath,
      R2_BROKER_MINT_PATH,
      "x".repeat(64 * 1024),
    );
    // Either the 413 arrived, or the connection was torn down before the
    // client finished writing. Never a mint.
    assert.ok(
      oversized.status === 413 || oversized.status === null,
      `oversized body must never be accepted, got ${oversized.status}`,
    );
  });

  it("serves exactly one route and one method", async () => {
    const wrongPath = await rawPost(socketPath, "/v1/r2/admin", "{}");
    assert.equal(wrongPath.status, 404);

    const wrongMethod = await rawPost(socketPath, R2_BROKER_MINT_PATH, "", "GET");
    assert.equal(wrongMethod.status, 405);
  });

  it("fails the client closed when the broker is not running", async () => {
    const provider = new BrokerR2CredentialProvider({
      socketPath: join(root, "absent.sock"),
      bucket: BUCKET,
      timeoutMs: 1_000,
    });

    await assert.rejects(
      () => provider.mint({ action: "PutObject", objectKey: OBJECT_KEY, ttlSeconds: 300 }),
      (err: unknown) => {
        assert.ok(err instanceof R2CredentialBrokerError);
        assert.equal(err.failure, "broker_unavailable");
        return true;
      },
    );
  });

  it("fails the client closed when the broker refuses", async () => {
    const provider = new BrokerR2CredentialProvider({ socketPath, bucket: "wrong-bucket" });

    await assert.rejects(
      () => provider.mint({ action: "PutObject", objectKey: OBJECT_KEY, ttlSeconds: 300 }),
      (err: unknown) => {
        assert.ok(err instanceof R2CredentialBrokerError);
        assert.equal(err.failure, "broker_refused");
        return true;
      },
    );
  });

  it("refuses to bind over a path that is not a socket", async () => {
    const regular = join(root, "not-a-socket");
    await writeFile(regular, "important data");

    await assert.rejects(() =>
      startR2BrokerSocketServer({
        broker: new R2CredentialBroker({ config: CONFIG }),
        socketPath: regular,
      }),
    );

    // The pre-existing file is untouched, never silently unlinked.
    const info = await stat(regular);
    assert.ok(info.isFile());
  });
});
