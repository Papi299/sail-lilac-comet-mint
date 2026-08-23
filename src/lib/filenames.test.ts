import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDownloadFilename, sanitizeFilename } from "./filenames.ts";

describe("filename sanitization", () => {
  it("strips path traversal", () => {
    assert.equal(sanitizeFilename("../../etc/passwd"), "etc-passwd");
  });

  it("removes illegal characters", () => {
    const name = sanitizeFilename('My Video:*?"<>| Title');
    assert.match(name, /^[a-zA-Z0-9._-]+$/);
    assert.equal(name.includes("/"), false);
  });

  it("falls back for empty names", () => {
    assert.equal(sanitizeFilename("***"), "video");
  });

  it("builds a user-facing download name", () => {
    assert.equal(
      buildDownloadFilename({ title: "Example Video!", quality: "1080p", container: "mp4" }),
      "Example-Video-1080p.mp4",
    );
  });

  it("limits length", () => {
    const long = "a".repeat(200);
    assert.ok(sanitizeFilename(long).length <= 80);
  });
});
