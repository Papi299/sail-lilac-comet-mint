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

  // ── The `processing -> uploading` dependency, pinned executably ────────────
  //
  // The Stage-B acceptance harness treats a directly observed durable
  // `uploading` as CAUSAL PROOF that a durable `processing` committed first
  // (`classifySuccessTransitionTrace` in
  // `deploy/acceptance/ytdlp-generic/lib/lifecycle.mjs`). That inference is only
  // sound while this store refuses `downloading -> uploading`. These two tests
  // are the executable form of that premise: if the store ever gains a direct
  // path from `downloading` to `uploading`, they fail here, at the source of the
  // assumption, rather than silently turning an acceptance PASS into a lie.

  it("beginUploading REFUSES to skip processing: downloading -> uploading is a state_conflict", () => {
    store.createJob({ url: "http://example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" }, "5f0f1d2c-9a44-4c1e-8b77-2a6c1f9e0d31");
    const job = store.claimNextQueuedJob()!;
    store.completeAnalysis(job.jobId, { title: "T", thumbnail: null, source: "example", extractor: "direct" });

    // The job is durably `downloading`, and `processing` has NOT been committed.
    const before = store.getJob(job.jobId)!;
    assert.strictEqual(before.status, "downloading");

    const skipped = store.beginUploading(job.jobId);
    assert.strictEqual(skipped.type, "state_conflict", "downloading -> uploading must be refused");

    // Refused means UNCHANGED, not merely un-acknowledged: the durable row must
    // still read `downloading`. A refusal that still mutated the row would break
    // the inference just as badly as an accepted transition.
    const after = store.getJob(job.jobId)!;
    assert.strictEqual(after.status, "downloading");
  });

  it("uploading is reachable ONLY through processing", () => {
    store.createJob({ url: "http://example.com/a.mp4", formatId: "direct-original", principalId: "private-access-user" }, "c1b8a7e6-3d52-4f09-9a1b-7e4d2c8f6a05");
    const job = store.claimNextQueuedJob()!;
    store.completeAnalysis(job.jobId, { title: "T", thumbnail: null, source: "example", extractor: "direct" });
    assert.strictEqual(store.getJob(job.jobId)!.status, "downloading");

    // The direct hop is refused …
    assert.strictEqual(store.beginUploading(job.jobId).type, "state_conflict");
    assert.strictEqual(store.getJob(job.jobId)!.status, "downloading");

    // … and the ONLY way through is the two-step ladder.
    assert.strictEqual(store.beginProcessing(job.jobId).type, "updated");
    assert.strictEqual(store.getJob(job.jobId)!.status, "processing");

    assert.strictEqual(store.beginUploading(job.jobId).type, "updated");
    assert.strictEqual(store.getJob(job.jobId)!.status, "uploading");
  });
});
