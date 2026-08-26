import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PRIVATE_ACCESS_PRINCIPAL_ID } from "../../lib/security/private-access.server.ts";
import {
  countActiveForPrincipal,
  createJob,
  deleteJob,
  expiredJobs,
  getJob,
  resetJobsForTests,
  toPublicJob,
  updateJob,
} from "./store.server.ts";

function sampleJob(principalId: string = PRIVATE_ACCESS_PRINCIPAL_ID, workDir = "/tmp/x") {
  return createJob({
    url: "https://example.com/v",
    formatId: "preset:720",
    principalId,
    workDir,
  });
}

describe("job store", () => {
  beforeEach(() => {
    resetJobsForTests();
  });

  it("creates jobs with unguessable ids and queued status", () => {
    const job = sampleJob();
    assert.equal(job.status, "queued");
    assert.equal(job.id.length, 32);
    assert.equal(job.principalId, PRIVATE_ACCESS_PRINCIPAL_ID);
    assert.equal(getJob(job.id)?.id, job.id);
  });

  it("updates status", () => {
    const job = sampleJob();
    updateJob(job.id, { status: "downloading", progress: 20 });
    assert.equal(getJob(job.id)?.status, "downloading");
    assert.equal(getJob(job.id)?.progress, 20);
  });

  it("hides internal paths and principal identity from public payloads", () => {
    const job = createJob({
      url: "https://example.com/v",
      formatId: "preset:720",
      principalId: PRIVATE_ACCESS_PRINCIPAL_ID,
      workDir: "/tmp/secret-dir",
      title: "clip",
    });
    updateJob(job.id, { status: "ready", outputPath: "/tmp/secret-dir/out.mp4" });
    const pub = toPublicJob(getJob(job.id)!);
    assert.equal("outputPath" in pub, false);
    assert.equal("workDir" in pub, false);
    assert.equal("principalId" in pub, false);
    assert.equal("ip" in pub, false);
    assert.equal(JSON.stringify(pub).includes("secret-dir"), false);
    assert.equal(JSON.stringify(pub).includes(PRIVATE_ACCESS_PRINCIPAL_ID), false);
    assert.equal(pub.downloadUrl, `/api/download/${job.id}/file`);
  });

  it("counts active jobs per principal and ignores completed ones", () => {
    const a1 = sampleJob(PRIVATE_ACCESS_PRINCIPAL_ID, "/tmp/a1");
    const a2 = sampleJob(PRIVATE_ACCESS_PRINCIPAL_ID, "/tmp/a2");
    sampleJob("other-principal", "/tmp/b1");
    assert.equal(countActiveForPrincipal(PRIVATE_ACCESS_PRINCIPAL_ID), 2);
    assert.equal(countActiveForPrincipal("other-principal"), 1);
    updateJob(a1.id, { status: "ready" });
    updateJob(a2.id, { status: "failed" });
    assert.equal(countActiveForPrincipal(PRIVATE_ACCESS_PRINCIPAL_ID), 0);
    assert.equal(countActiveForPrincipal("other-principal"), 1);
  });

  it("treats expired jobs as expired", () => {
    const job = sampleJob();
    updateJob(job.id, { expiresAt: Date.now() - 1000 });
    assert.equal(expiredJobs().some((j) => j.id === job.id), true);
    deleteJob(job.id);
    assert.equal(getJob(job.id), undefined);
  });
});
