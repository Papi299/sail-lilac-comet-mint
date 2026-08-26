import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { AppError } from "../../lib/errors.ts";
import { setPinnedRequestFactoryForTests, setSafeHttpTestHooks } from "../../lib/security/safe-http.server.ts";
import { directExtractor } from "./direct.server.ts";

describe("direct extractor response disposal", () => {
  afterEach(() => {
    setSafeHttpTestHooks(null);
    setPinnedRequestFactoryForTests(null);
  });

  async function downloadWithStatus(status: number, body: Readable) {
    setSafeHttpTestHooks({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      requestOnce: async () => ({
        status,
        headers: { "content-type": "video/mp4" },
        body,
      }),
    });
    return directExtractor.download(
      "https://cdn.example/video.mp4",
      { formatId: "direct-original" },
      { workDir: "/unused-direct-download-workdir" },
    );
  }

  it("disposes a 404 response body before failing", async () => {
    const body = Readable.from([Buffer.from("missing")]);
    await assert.rejects(
      () => downloadWithStatus(404, body),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "VIDEO_UNAVAILABLE");
        return true;
      },
    );
    assert.equal(body.destroyed, true);
  });

  it("disposes a 500 response body before failing", async () => {
    const body = Readable.from([Buffer.from("error")]);
    await assert.rejects(
      () => downloadWithStatus(500, body),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "NETWORK_ERROR");
        return true;
      },
    );
    assert.equal(body.destroyed, true);
  });
});
