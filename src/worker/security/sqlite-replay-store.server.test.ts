import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteWorkerReplayStore } from "./sqlite-replay-store.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { WorkerAuthenticator } from "./authenticate.server.ts";

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
    const result = await store.reserve("req-1", Math.floor(Date.now() / 1000) + 60);
    assert.strictEqual(result, "reserved");
  });

  it("returns duplicate for already reserved request", async () => {
    const store = new SQLiteWorkerReplayStore(db);
    const expires = Math.floor(Date.now() / 1000) + 60;
    const res1 = await store.reserve("req-2", expires);
    const res2 = await store.reserve("req-2", expires);
    assert.strictEqual(res1, "reserved");
    assert.strictEqual(res2, "duplicate");
  });

  it("cleans up expired requests", async () => {
    let mockTime = 1000;
    const store = new SQLiteWorkerReplayStore(db, () => mockTime);
    
    // Reserve expires at 1050
    await store.reserve("req-3", 1050);
    assert.strictEqual(await store.reserve("req-3", 1050), "duplicate");

    // Advance time past expiration
    mockTime = 1100;
    
    // Cleanup is called inside reserve, or explicitly
    store.cleanup();

    // Now req-3 can be reserved again since it was deleted
    const res = await store.reserve("req-3", 1150);
    assert.strictEqual(res, "reserved");
  });

  it("throws on operational failure (table drop)", async () => {
    const store = new SQLiteWorkerReplayStore(db);
    db.exec("DROP TABLE worker_replay_requests");
    await assert.rejects(
      async () => {
        await store.reserve("req-throw", 99999);
      }
    );
  });

  it("restart-safe replay regression", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    const store1 = new SQLiteWorkerReplayStore(db);
    const authenticator1 = new WorkerAuthenticator({
      currentKeyId: "key-1",
      currentSecret: "01234567890123456789012345678901",
      clock: () => Date.now(),
      replayStore: store1,
    });
    // Just a placeholder to use authenticator1 to avoid unused var lint warning
    assert.ok(authenticator1);
    
    const res1 = await store1.reserve("c0f81d83-4950-4824-9b21-654db9035be4", expiresAt);
    assert.strictEqual(res1, "reserved");
    
    db.close();

    // Reopen same database
    const db2 = new DatabaseSync(dbPath);
    const store2 = new SQLiteWorkerReplayStore(db2);

    const res2 = await store2.reserve("c0f81d83-4950-4824-9b21-654db9035be4", expiresAt);
    assert.strictEqual(res2, "duplicate");
    
    db2.close();
  });
});
