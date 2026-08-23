import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  deleteJob,
  expiredJobs,
  getJob,
  resetJobsForTests,
  toPublicJob,
  updateJob,
} from "./store.server.ts";

describe("job store", () => {
  beforeEach(() => {
    resetJobsForTests();
  });

  it("creates jobs with unguessable ids and queued status", () => {
    const job = createJob({
      url: "https://example.com/v",
      formatId: "preset:720",
      ip: "1.1.1.1",
      workDir: "/tmp/x",
    });
    assert.equal(job.status, "queued");
    assert.equal(job.id.length, 32);
    assert.equal(getJob(job.id)?.id, job.id);
  });

  it("updates status", () => {
    const job = createJob({
      url: "https://example.com/v",
      formatId: "preset:720",
      ip: "1.1.1.1",
      workDir: "/tmp/x",
    });
    updateJob(job.id, { status: "downloading", progress: 20 });
    assert.equal(getJob(job.id)?.status, "downloading");
    assert.equal(getJob(job.id)?.progress, 20);
  });

  it("hides internal paths from public payloads", () => {
    const job = createJob({
      url: "https://example.com/v",
      formatId: "preset:720",
      ip: "1.1.1.1",
      workDir: "/tmp/secret-dir",
    });
    updateJob(job.id, { status: "ready", outputPath: "/tmp/secret-dir/out.mp4" });
    const pub = toPublicJob(getJob(job.id)!);
    assert.equal("outputPath" in pub, false);
    assert.equal("workDir" in pub, false);
    assert.equal(JSON.stringify(pub).includes("secret-dir"), false);
    assert.equal(pub.downloadUrl, `/api/download/${job.id}/file`);
  });

  it("treats expired jobs as expired", () => {
    const job = createJob({
      url: "https://example.com/v",
      formatId: "preset:720",
      ip: "1.1.1.1",
      workDir: "/tmp/x",
    });
    updateJob(job.id, { expiresAt: Date.now() - 1000 });
    assert.equal(expiredJobs().some((j) => j.id === job.id), true);
    deleteJob(job.id);
    assert.equal(getJob(job.id), undefined);
  });
});
