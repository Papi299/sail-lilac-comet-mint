import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../lib/errors.ts";
import { PRIVATE_ACCESS_PRINCIPAL_ID } from "../../lib/security/private-access.server.ts";
import {
  createJob,
  getJob,
  listJobs,
  resetJobsForTests,
  updateJob,
} from "../jobs/store.server.ts";
import { jobsRoot, setTempDirectoryForTests, UnsafePathError } from "../temp/files.server.ts";
import { allocateJob, cleanupExpired, diagnosticsSnapshot, enqueueDownload } from "./manager.server.ts";

describe("job lifecycle paths", () => {
  afterEach(() => {
    setTempDirectoryForTests(null);
    resetJobsForTests();
  });

  beforeEach(() => {
    resetJobsForTests();
  });

  it("creates the job directory before inserting the record and never stores /tmp", async () => {
    const root = await mkdtemp(join(tmpdir(), "videofetch-life-"));
    setTempDirectoryForTests(root);
    const job = await allocateJob({
      url: "sample://demo",
      formatId: "sample-720",
      principalId: PRIVATE_ACCESS_PRINCIPAL_ID,
    });
    assert.notEqual(job.workDir, "/tmp");
    assert.equal(job.workDir, join(jobsRoot(), job.id));
    assert.equal(job.principalId, PRIVATE_ACCESS_PRINCIPAL_ID);
    assert.match(job.id, /^[0-9a-f]{32}$/);
    const st = await stat(job.workDir);
    assert.equal(st.isDirectory(), true);
    assert.equal(getJob(job.id)?.workDir, job.workDir);
  });

  it("does not persist a job when directory creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "videofetch-life-"));
    setTempDirectoryForTests(root);
    await assert.rejects(
      () =>
        allocateJob({
          id: "not-a-valid-job-id",
          url: "sample://demo",
          formatId: "sample-720",
          principalId: PRIVATE_ACCESS_PRINCIPAL_ID,
        }),
      UnsafePathError,
    );
    assert.equal(listJobs().length, 0);
  });

  it("cleanup of a /tmp sentinel refuses deletion and still drops the record", async () => {
    const job = createJob({
      url: "sample://demo",
      formatId: "sample-720",
      principalId: PRIVATE_ACCESS_PRINCIPAL_ID,
      workDir: "/tmp",
    });
    updateJob(job.id, { expiresAt: Date.now() - 1000 });
    const removed = await cleanupExpired();
    assert.equal(removed, 1);
    assert.equal(getJob(job.id), undefined);
    const tmp = await stat("/tmp");
    assert.equal(tmp.isDirectory(), true);
  });

  it("rejects another download for the same principal without creating a job", async () => {
    createJob({
      url: "sample://demo",
      formatId: "sample-720",
      principalId: PRIVATE_ACCESS_PRINCIPAL_ID,
      workDir: "/tmp/videofetch-principal-a",
    });
    createJob({
      url: "sample://demo",
      formatId: "sample-720",
      principalId: PRIVATE_ACCESS_PRINCIPAL_ID,
      workDir: "/tmp/videofetch-principal-b",
    });
    await assert.rejects(
      () =>
        enqueueDownload({
          url: "https://example.com/v.mp4",
          formatId: "direct-original",
          principalId: PRIVATE_ACCESS_PRINCIPAL_ID,
        }),
      (err: unknown) => err instanceof AppError && err.code === "SERVER_OVERLOAD",
    );
    assert.equal(listJobs().length, 2);
  });

  it("returns aggregate diagnostics without enumerating jobs", async () => {
    const job = createJob({
      url: "https://cdn.example/leaked.mp4",
      formatId: "sample-720",
      principalId: PRIVATE_ACCESS_PRINCIPAL_ID,
      workDir: "/tmp/videofetch-diag-job",
    });
    updateJob(job.id, {
      status: "failed",
      error: "extractor-secret",
      source: "cdn.example",
      extractor: "direct",
      filename: "leaked.mp4",
    });
    const snap = await diagnosticsSnapshot();
    const encoded = JSON.stringify(snap);
    assert.deepEqual(Object.keys(snap).sort(), [
      "averageProcessingMs",
      "counts",
      "disk",
      "limits",
      "worker",
    ]);
    assert.equal("jobs" in snap, false);
    assert.equal(encoded.includes(job.id), false);
    assert.equal(encoded.includes("extractor-secret"), false);
    assert.equal(encoded.includes("cdn.example"), false);
    assert.equal(encoded.includes("leaked.mp4"), false);
    assert.equal(encoded.includes(PRIVATE_ACCESS_PRINCIPAL_ID), false);
    assert.equal(snap.counts.failed, 1);
  });
});
