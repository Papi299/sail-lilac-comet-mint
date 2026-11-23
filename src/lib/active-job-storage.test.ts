import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_JOB_STORAGE_KEY,
  clearActiveJob,
  clearActiveJobWithoutAccess,
  isStorableJobId,
  readActiveJob,
  writeActiveJob,
} from "./active-job-storage.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: the one thing
 * a tab remembers about its job — a versioned entry holding only the job id —
 * and every way that entry can be absent, malformed, foreign or unreadable.
 */

const JOB_ID = "0123456789abcdef0123456789abcdef";

/** A Storage double: a Map, optionally throwing like a blocked or full browser store. */
class MemoryStorage implements Storage {
  readonly map = new Map<string, string>();
  private readonly fail: { get?: boolean; set?: boolean; remove?: boolean };
  constructor(fail: { get?: boolean; set?: boolean; remove?: boolean } = {}) {
    this.fail = fail;
  }
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    if (this.fail.get) throw new DOMException("blocked", "SecurityError");
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    if (this.fail.remove) throw new DOMException("blocked", "SecurityError");
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.fail.set) throw new DOMException("full", "QuotaExceededError");
    this.map.set(key, value);
  }
}

describe("the stored entry", () => {
  it("is versioned, and holds exactly the job id — nothing else", () => {
    const storage = new MemoryStorage();
    assert.equal(writeActiveJob(JOB_ID, storage), true);
    assert.deepEqual([...storage.map.keys()], [ACTIVE_JOB_STORAGE_KEY]);
    assert.equal(ACTIVE_JOB_STORAGE_KEY, "videofetch:active-job:v1");
    assert.deepEqual(JSON.parse(storage.map.get(ACTIVE_JOB_STORAGE_KEY)!), { v: 1, jobId: JOB_ID });
    assert.deepEqual(readActiveJob(storage), { kind: "job", jobId: JOB_ID });
  });

  it("a newer job replaces the older one", () => {
    const storage = new MemoryStorage();
    writeActiveJob(JOB_ID, storage);
    writeActiveJob("fedcba9876543210fedcba9876543210", storage);
    assert.deepEqual(readActiveJob(storage), { kind: "job", jobId: "fedcba9876543210fedcba9876543210" });
  });

  it("refuses to store anything that is not a job id", () => {
    const storage = new MemoryStorage();
    for (const bad of [
      "",
      JOB_ID.toUpperCase(),
      JOB_ID.slice(1),
      `${JOB_ID}0`,
      "https://cdn.example/SECRET-PATH/video.mp4",
      "../../etc/passwd",
      "videofetch/jobs/0123456789abcdef0123456789abcdef/aaaa",
    ]) {
      assert.equal(writeActiveJob(bad, storage), false, bad);
      assert.equal(isStorableJobId(bad), false, bad);
    }
    assert.equal(storage.map.size, 0);
  });

  it("clear removes it, and is harmless when nothing is stored", () => {
    const storage = new MemoryStorage();
    clearActiveJob(storage);
    writeActiveJob(JOB_ID, storage);
    clearActiveJob(storage);
    assert.deepEqual(readActiveJob(storage), { kind: "none" });
  });
});

describe("reading: every malformed, foreign or unsupported entry is invalid, never trusted", () => {
  const read = (raw: string) => {
    const storage = new MemoryStorage();
    storage.map.set(ACTIVE_JOB_STORAGE_KEY, raw);
    return readActiveJob(storage);
  };

  it("not JSON", () => {
    for (const raw of ["", "{", "undefined", `{"v":1,"jobId":"${JOB_ID}"`, JOB_ID]) {
      assert.deepEqual(read(raw), { kind: "invalid" }, raw);
    }
  });

  it("the wrong shape", () => {
    for (const raw of ["null", "[]", "42", '"x"', "{}", `[1,"${JOB_ID}"]`]) {
      assert.deepEqual(read(raw), { kind: "invalid" }, raw);
    }
  });

  it("an unsupported version", () => {
    for (const v of [0, 2, "1", null, true]) {
      assert.deepEqual(read(JSON.stringify({ v, jobId: JOB_ID })), { kind: "invalid" }, String(v));
    }
  });

  it("a malformed job id", () => {
    for (const jobId of [JOB_ID.toUpperCase(), JOB_ID.slice(2), 42, null, "../x", "<script>"]) {
      assert.deepEqual(read(JSON.stringify({ v: 1, jobId })), { kind: "invalid" }, String(jobId));
    }
  });

  it("any extra key — a URL, a status, a cancellation — makes it invalid", () => {
    for (const extra of [
      { url: "https://cdn.example/SECRET-PATH/video.mp4" },
      { status: "downloading" },
      { cancel: "requesting" },
      { downloadUrl: "/api/download/x/file" },
    ]) {
      assert.deepEqual(read(JSON.stringify({ v: 1, jobId: JOB_ID, ...extra })), { kind: "invalid" });
    }
  });

  it("an oversized value is invalid without being parsed", () => {
    assert.deepEqual(read(`{"v":1,"jobId":"${JOB_ID}","pad":"${"x".repeat(5_000)}"}`), { kind: "invalid" });
  });
});

describe("storage that cannot be used is never a failure of the page", () => {
  it("no storage at all (server render, or a browser without it)", () => {
    assert.deepEqual(readActiveJob(null), { kind: "unavailable" });
    assert.equal(writeActiveJob(JOB_ID, null), false);
    clearActiveJob(null);
  });

  it("a blocked read is unavailable; a full or blocked write returns false; a blocked removal is ignored", () => {
    assert.deepEqual(readActiveJob(new MemoryStorage({ get: true })), { kind: "unavailable" });
    assert.equal(writeActiveJob(JOB_ID, new MemoryStorage({ set: true })), false);
    clearActiveJob(new MemoryStorage({ remove: true }));
  });

  it("in this runtime (no window), the defaults are simply unavailable", () => {
    assert.deepEqual(readActiveJob(), { kind: "unavailable" });
    assert.equal(writeActiveJob(JOB_ID), false);
  });
});

describe("the access lifecycle", () => {
  it("a tab found without private access forgets its job; with access, or a development bypass, it keeps it", () => {
    const cases = [
      { session: { authenticated: false, developmentBypass: false }, kept: false },
      { session: { authenticated: true, developmentBypass: false }, kept: true },
      { session: { authenticated: false, developmentBypass: true }, kept: true },
    ];
    for (const { session, kept } of cases) {
      const storage = new MemoryStorage();
      writeActiveJob(JOB_ID, storage);
      clearActiveJobWithoutAccess(session, storage);
      assert.equal(readActiveJob(storage).kind === "job", kept, JSON.stringify(session));
    }
  });
});
