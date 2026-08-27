import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteWorkerReplayStore } from "./sqlite-replay-store.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { WorkerAuthenticator, WorkerAuthenticationError } from "./authenticate.server.ts";
import { createWorkerSignatureHex } from "../../shared/worker/hmac.server.ts";
import { sha256WorkerBody } from "../../shared/worker/auth.ts";

describe("SQLiteWorkerReplayStore", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videofetch-worker-test-"));
    dbPath = path.join(tempDir, "test.sqlite");
  });

  after(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    db = new DatabaseSync(dbPath);
    applyMigrations(db);
  });

  afterEach(() => {
    try { if (db) db.close(); } catch (e) { void e; }
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
    if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
  });

  it("reserves a new request successfully", async () => {
    const store = new SQLiteWorkerReplayStore(db);
    const result = await store.reserve("123e4567-e89b-42d3-a456-426614174000", Math.floor(Date.now() / 1000) + 60);
    assert.strictEqual(result, "reserved");
  });

  it("returns duplicate for already reserved request", async () => {
    const store = new SQLiteWorkerReplayStore(db);
    const expires = Math.floor(Date.now() / 1000) + 60;
    const res1 = await store.reserve("123e4567-e89b-42d3-a456-426614174001", expires);
    const res2 = await store.reserve("123e4567-e89b-42d3-a456-426614174001", expires);
    assert.strictEqual(res1, "reserved");
    assert.strictEqual(res2, "duplicate");
  });

  it("cleans up expired requests", async () => {
    let mockTime = 1000;
    const store = new SQLiteWorkerReplayStore(db, () => mockTime);
    
    // Reserve expires at 1050
    await store.reserve("123e4567-e89b-42d3-a456-426614174002", 1050);
    assert.strictEqual(await store.reserve("123e4567-e89b-42d3-a456-426614174002", 1050), "duplicate");

    // Advance time past expiration
    mockTime = 1100;
    
    // Cleanup is called inside reserve, or explicitly
    store.cleanup();

    // Now req can be reserved again since it was deleted
    const res = await store.reserve("123e4567-e89b-42d3-a456-426614174002", 1150);
    assert.strictEqual(res, "reserved");
  });

  it("throws on operational failure (table drop)", async () => {
    const store = new SQLiteWorkerReplayStore(db);
    db.exec("DROP TABLE worker_replay_requests");
    await assert.rejects(
      async () => {
        await store.reserve("123e4567-e89b-42d3-a456-426614174003", 99999);
      }
    );
  });

  it("restart-safe replay regression", async () => {
    const store1 = new SQLiteWorkerReplayStore(db, () => 1000);
    const secret = "01234567890123456789012345678901";
    const authenticator1 = new WorkerAuthenticator({
      currentKeyId: "key-1",
      currentSecret: secret,
      clock: () => 1000, // Date.now() representation in ms... wait, clock in seconds according to my changes but it was ms initially? Let's check WorkerAuthenticator
      replayStore: store1,
    });

    const requestId = "c0f81d83-4950-4824-9b21-654db9035be4";
    const timestamp = 1000;
    
    const signature = createWorkerSignatureHex(secret, {
      method: "POST",
      canonicalPath: "/v1/jobs",
      sha256RawBody: sha256WorkerBody(Buffer.from("test")),
      timestampSeconds: timestamp.toString(),
      requestId,
      keyId: "key-1"
    });

    const authParams = {
      keyId: "key-1",
      method: "POST" as const,
      canonicalPath: "/v1/jobs",
      timestampSeconds: timestamp.toString(),
      requestId,
      rawBody: Buffer.from("test"),
      signatureHex: signature
    };

    await authenticator1.authenticateAndReserve(authParams);
    
    db.close();

    // Reopen same database
    const db2 = new DatabaseSync(dbPath);
    const store2 = new SQLiteWorkerReplayStore(db2, () => 1000);
    
    const authenticator2 = new WorkerAuthenticator({
      currentKeyId: "key-1",
      currentSecret: secret,
      clock: () => 1000, // clock in seconds
      replayStore: store2,
    });

    await assert.rejects(
      async () => {
        await authenticator2.authenticateAndReserve(authParams);
      },
      (err: any) => err instanceof WorkerAuthenticationError
    );
    
    db2.close();
  });
});
