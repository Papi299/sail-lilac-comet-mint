import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError, ERROR_MESSAGES, mapExtractorMessage } from "./errors.ts";

describe("extractor error mapping", () => {
  it("maps unsupported urls", () => {
    const err = mapExtractorMessage("ERROR: Unsupported URL: https://example.com");
    assert.equal(err.code, "UNSUPPORTED_SITE");
    assert.equal(err.message, ERROR_MESSAGES.UNSUPPORTED_SITE);
  });

  it("maps bot checks and private videos", () => {
    const err = mapExtractorMessage("Sign in to confirm you’re not a bot");
    assert.equal(err.code, "VIDEO_UNAVAILABLE");
  });

  it("maps timeouts and network errors", () => {
    assert.equal(mapExtractorMessage("socket timed out").code, "TIMEOUT");
    assert.equal(mapExtractorMessage("Temporary failure in name resolution").code, "NETWORK_ERROR");
  });
});

describe("extractor unavailable", () => {
  it("is a 503 distinct from unsupported site", () => {
    const err = new AppError("EXTRACTOR_UNAVAILABLE");
    assert.equal(err.status, 503);
    assert.equal(err.message, ERROR_MESSAGES.EXTRACTOR_UNAVAILABLE);
    assert.notEqual(err.code, "UNSUPPORTED_SITE");
  });
});
