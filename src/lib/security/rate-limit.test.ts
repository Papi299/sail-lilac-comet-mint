import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { consumeRateLimit, resetRateLimitForTests } from "./rate-limit.server.ts";

describe("rate limiter", () => {
  beforeEach(() => resetRateLimitForTests());

  it("allows up to the limit then blocks", () => {
    assert.equal(consumeRateLimit("ip:1", 2, 60_000), true);
    assert.equal(consumeRateLimit("ip:1", 2, 60_000), true);
    assert.equal(consumeRateLimit("ip:1", 2, 60_000), false);
  });

  it("isolates keys", () => {
    assert.equal(consumeRateLimit("ip:a", 1, 60_000), true);
    assert.equal(consumeRateLimit("ip:b", 1, 60_000), true);
  });
});
