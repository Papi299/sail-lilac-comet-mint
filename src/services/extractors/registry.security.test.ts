import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../lib/errors.ts";
import { setSafeHttpTestHooks } from "../../lib/security/safe-http.server.ts";
import { processJob } from "../downloads/processor.server.ts";
import { createJob, getJob, resetJobsForTests } from "../jobs/store.server.ts";
import { analyzeUrl, setExtractorsForTests } from "./registry.server.ts";
import type { MediaExtractor } from "./types.ts";

function fakeExtractor(onInvoke: () => void): MediaExtractor {
  return {
    id: "fake",
    name: "fake",
    canHandle() {
      onInvoke();
      return true;
    },
    async getMetadata() {
      onInvoke();
      throw new Error("fake extractor must not run");
    },
    async getFormats() {
      onInvoke();
      return [];
    },
    async download() {
      onInvoke();
      throw new Error("fake extractor must not run");
    },
  };
}

describe("extractor URL boundary", () => {
  afterEach(() => {
    setExtractorsForTests(null);
    setSafeHttpTestHooks(null);
    resetJobsForTests();
  });

  it("does not invoke extractors when the URL is a private literal", async () => {
    let invoked = 0;
    setExtractorsForTests([fakeExtractor(() => {
      invoked += 1;
    })]);
    await assert.rejects(
      () => analyzeUrl("http://127.0.0.1/video.mp4"),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "INVALID_URL");
        return true;
      },
    );
    assert.equal(invoked, 0);
  });

  it("does not invoke extractors when DNS returns a private address", async () => {
    let invoked = 0;
    let connected = 0;
    setExtractorsForTests([fakeExtractor(() => {
      invoked += 1;
    })]);
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "10.0.0.9", family: 4 }],
      requestOnce: async () => {
        connected += 1;
        throw new Error("should not connect");
      },
    });
    await assert.rejects(
      () => analyzeUrl("https://cdn.example/video.mp4"),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "INVALID_URL");
        return true;
      },
    );
    assert.equal(invoked, 0);
    assert.equal(connected, 0);
  });

  it("does not invoke extractors from processJob when the stored URL is unsafe", async () => {
    let invoked = 0;
    setExtractorsForTests([fakeExtractor(() => {
      invoked += 1;
    })]);
    const job = createJob({
      url: "http://127.0.0.1/secret.mp4",
      formatId: "direct-original",
      principalId: "private-access-user",
      workDir: "/tmp/videofetch-processjob-sentinel",
    });
    await processJob(job.id);
    assert.equal(invoked, 0);
    assert.equal(getJob(job.id)?.status, "failed");
    assert.equal(getJob(job.id)?.errorCode, "INVALID_URL");
  });
});
