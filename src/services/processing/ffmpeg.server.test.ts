import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../lib/errors.ts";
import { assertLocalMediaPath } from "./ffmpeg.server.ts";

describe("ffmpeg local-path guard", () => {
  it("rejects remote URLs and protocol-relative inputs", () => {
    for (const value of [
      "https://cdn.example/video.mp4",
      "http://example.com/a.mp4",
      "file:///etc/passwd",
      "//cdn.example/video.mp4",
      "",
    ]) {
      assert.throws(
        () => assertLocalMediaPath(value),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, "PROCESSING_FAILED");
          return true;
        },
      );
    }
  });

  it("allows ordinary local filesystem paths", () => {
    assert.doesNotThrow(() => assertLocalMediaPath("/tmp/videofetch/jobs/abc/source.mp4"));
    assert.doesNotThrow(() => assertLocalMediaPath("source.mp4"));
  });
});
