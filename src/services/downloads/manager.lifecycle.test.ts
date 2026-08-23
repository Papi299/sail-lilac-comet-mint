import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJob,
  getJob,
  listJobs,
  resetJobsForTests,
  updateJob,
} from "../jobs/store.server.ts";
import { jobsRoot, setTempDirectoryForTests, UnsafePathError } from "../temp/files.server.ts";
import { allocateJob, cleanupExpired } from "./manager.server.ts";

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
      ip: "203.0.113.10",
    });
    assert.notEqual(job.workDir, "/tmp");
    assert.equal(job.workDir, join(jobsRoot(), job.id));
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
          ip: "203.0.113.10",
        }),
      UnsafePathError,
    );
    assert.equal(listJobs().length, 0);
  });

  it("cleanup of a /tmp sentinel refuses deletion and still drops the record", async () => {
    const job = createJob({
      url: "sample://demo",
      formatId: "sample-720",
      ip: "203.0.113.10",
      workDir: "/tmp",
    });
    updateJob(job.id, { expiresAt: Date.now() - 1000 });
    const removed = await cleanupExpired();
    assert.equal(removed, 1);
    assert.equal(getJob(job.id), undefined);
    const tmp = await stat("/tmp");
    assert.equal(tmp.isDirectory(), true);
  });
});
