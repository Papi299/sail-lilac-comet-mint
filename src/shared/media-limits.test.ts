import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "./media-limits.ts";
import { config } from "../lib/config.ts";
import { loadWorkerRuntimeConfig } from "../worker/runtime/config.server.ts";

// MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001: the two live readers of MAX_FILE_SIZE
// must resolve an unset value to the SAME exact 4 GiB. Each reader is pinned to
// the literal, so changing only one side — or silently changing the shared
// constant — fails here.

const FOUR_GIB = 4_294_967_296;

/** Syntactically valid FAKE Worker environment; no real value anywhere. */
const FAKE_WORKER_ENV: NodeJS.ProcessEnv = {
  WORKER_DATA_DIRECTORY: "/var/lib/videofetch",
  WORKER_CONTROL_KEY_ID: "worker-control-1",
  WORKER_CONTROL_SECRET: "0123456789abcdef0123456789abcdef",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET: "videofetch-temp",
  R2_BROKER_SOCKET_PATH: "/run/videofetch-r2-broker/broker.sock",
};

describe("MAX-FILE-SIZE-4GIB: one authoritative 4 GiB default", () => {
  it("the shared constant is exactly 4 GiB, and its workspace double is a safe integer", () => {
    assert.equal(DEFAULT_MAX_FILE_SIZE_BYTES, FOUR_GIB);
    assert.ok(Number.isSafeInteger(2 * DEFAULT_MAX_FILE_SIZE_BYTES));
  });

  it("the strict Worker runtime loader resolves an unset MAX_FILE_SIZE to exactly 4 GiB", () => {
    assert.equal(loadWorkerRuntimeConfig(FAKE_WORKER_ENV).media.maxFileSizeBytes, FOUR_GIB);
  });

  it("src/lib/config.ts resolves an unset MAX_FILE_SIZE to exactly 4 GiB", () => {
    assert.equal(process.env.MAX_FILE_SIZE, undefined, "run the suite without MAX_FILE_SIZE set");
    assert.equal(config.maxFileSize, FOUR_GIB);
  });

  it("both readers agree with each other", () => {
    assert.equal(config.maxFileSize, loadWorkerRuntimeConfig(FAKE_WORKER_ENV).media.maxFileSizeBytes);
  });
});
