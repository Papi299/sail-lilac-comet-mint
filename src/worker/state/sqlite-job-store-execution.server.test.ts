import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.server.ts";
import { SQLiteJobStore } from "./sqlite-job-store.server.ts";

describe("SQLiteJobStore Execution Transitions", () => {
  let db: DatabaseSync;
  let store: SQLiteJobStore;
  const now = 1000000;
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-exec-test-"));
    dbPath = path.join(tempDir, "test.sqlite");
    db = new DatabaseSync(dbPath);
    applyMigrations(db);
    store = new SQLiteJobStore({ db, clock: () => now });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("completeAnalysis", () => {
    store.createJob({ url: "http://example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" }, "7e19bc24-682f-4c82-b878-e0a021322d8e");
    const job = store.claimNextQueuedJob()!;
    assert.strictEqual(job.status, "analyzing");

    const res = store.completeAnalysis(job.jobId, { title: "T", thumbnail: null, source: "example", extractor: "direct" });
    assert.strictEqual(res.type, "updated");
    if (res.type === "updated") assert.strictEqual(res.job.status, "downloading");

    // Invalid transition
    const res2 = store.completeAnalysis(job.jobId, { title: "T2", thumbnail: null, source: "example", extractor: "direct" });
    assert.strictEqual(res2.type, "state_conflict");
  });

  it("updateExecutionProgress", () => {
    store.createJob({ url: "http://example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" }, "64d57be4-df9a-4714-8938-7c2ffdd1dfdd");
    const job = store.claimNextQueuedJob()!;
    store.completeAnalysis(job.jobId, { title: "T", thumbnail: null, source: "example", extractor: "direct" });

    const res = store.updateExecutionProgress(job.jobId, "downloading", {
      progress: 50,
      downloadedBytes: 100,
      totalBytes: 200,
      speed: 10,
      eta: 10,
      stageLabel: "dl"
    });
    assert.strictEqual(res.type, "updated");
    if (res.type === "updated") {
      assert.strictEqual(res.job.progress, 50);
      assert.strictEqual(res.job.downloadedBytes, 100);
    }
    
    // wrong expected state
    const res2 = store.updateExecutionProgress(job.jobId, "processing", {
      progress: 60, downloadedBytes: null, totalBytes: null, speed: null, eta: null, stageLabel: "dl"
    });
    assert.strictEqual(res2.type, "state_conflict");
  });

  it("beginProcessing and beginUploading", () => {
    store.createJob({ url: "http://example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" }, "3300628a-5628-4cd8-9f41-8392f264f54d");
    const job = store.claimNextQueuedJob()!;
    store.completeAnalysis(job.jobId, { title: "T", thumbnail: null, source: "example", extractor: "direct" });

    const pRes = store.beginProcessing(job.jobId);
    assert.strictEqual(pRes.type, "updated");
    if (pRes.type === "updated") assert.strictEqual(pRes.job.status, "processing");

    const uRes = store.beginUploading(job.jobId);
    assert.strictEqual(uRes.type, "updated");
    if (uRes.type === "updated") assert.strictEqual(uRes.job.status, "uploading");
  });
});
