import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir as fsReaddir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@/lib/errors";
import {
  assessAcquisitionActivity,
  createAcquisitionActivityTracker,
  type AcquisitionActivityEvent,
} from "@/services/downloads/acquisition-activity";
import {
  createAcquisitionInactivityWatchdog,
  type InactivityWatchdogTimerHandle,
  type InactivityWatchdogTimers,
} from "@/services/downloads/acquisition-inactivity-watchdog";
import type { RunResult } from "@/services/processing/process-runner.server.ts";
import { YTDLP_RUNTIME } from "../runtime/ytdlp-runtime.server.ts";
import type { GenericSourceSelection } from "./generic-source.ts";
import type { GenericSingleSourceExecutionPlan, GenericSplitExecutionPlan } from "./format-plan.ts";
import {
  downloadGenericOriginal,
  downloadGenericSplitSources,
  expectedPartPath,
  expectedSourcePath,
  expectedSplitSourcePath,
  observeFilesystemDirectory,
  observeFilesystemFile,
  type FileObservation,
  type GenericDownloadDeps,
} from "./ytdlp-download.server.ts";

/**
 * VIDEOFETCH-LD3C-YTDLP-OBSERVATION-HARDENING-001 — the typed filesystem
 * observation contract, the progressive and segmented samplers built on it,
 * and the generic subprocess seam's own stop causes.
 *
 * The contract runs against the real filesystem where the platform can show
 * the state (a permission refusal needs a non-root user), and against injected
 * filesystem results for everything a real disk cannot be made to do on
 * demand. The samplers run inside the real yt-dlp seam with only its child
 * replaced: the fake child changes the observed state and waits until the real
 * monitor has sampled it, so no assertion depends on how fast the poll runs.
 * Decisions are taken by a real tracker or watchdog on a virtual clock.
 */

const SECRET_URL = "https://cdn.example/SECRET-PATH/video.mp4?sig=TOP-SECRET-TOKEN";
const WINDOW = 120_000;
const G = 65_536;
const LIMITS = { maxFileSizeBytes: 1_000_000_000, downloadTimeLimitMs: 600_000 };
const RUNTIME_OK = Object.freeze({ available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" as const });
const EXIT_OK: RunResult = { code: 0, stdout: "", stderr: "" };
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

let workDir = "";
let eventLoopHold: ReturnType<typeof setTimeout> | null = null;
const restore: Array<() => void> = [];
/**
 * Assertions that failed INSIDE a fake child. The seam (rightly) reports a
 * child that threw as a failed run, so such an assertion would otherwise
 * surface only as an AppError; `dl` / `dlSplit` re-raise it as itself.
 */
const childAssertions: unknown[] = [];

beforeEach(() => {
  childAssertions.length = 0;
  // The real monitor's timer is unref'd and a fake child holds nothing, so the
  // test keeps the loop alive itself (the Node 22 trap).
  eventLoopHold = setTimeout(() => {}, 60_000);
  workDir = mkdtempSync(join(tmpdir(), "ld3c-observe-"));
});

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  rmSync(workDir, { recursive: true, force: true });
  if (eventLoopHold !== null) clearTimeout(eventLoopHold);
  eventLoopHold = null;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** An error carrying a code, a path and a message: only the code may ever be read. */
const coded = (code: string) => Object.assign(new Error(`synthetic ${code} at /private/SECRET-PATH/source.mp4.part`), { code });
const chunk = (size: number, fill = 0xab) => Buffer.alloc(size, fill);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 10_000) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const CLOSED_STRINGS = new Set([
  "deadline-armed", "phase-started", "bytes", "resource-boundary", "sample-gap", "phase-ended", "settled",
  "single", "video", "audio", "transport", "filesystem", "completed", "cancelled", "deadline-exceeded", "failed",
]);
const EVENT_KEYS: Record<AcquisitionActivityEvent["kind"], readonly string[]> = {
  "deadline-armed": ["kind", "limitMs"],
  "phase-started": ["kind", "phase"],
  bytes: ["kind", "totalBytes", "evidence"],
  "resource-boundary": ["kind"],
  "sample-gap": ["kind"],
  "phase-ended": ["kind"],
  settled: ["kind", "outcome"],
};

/** The LD-3a vocabulary is unchanged and closed: no path, message, code or URL in any event. */
function assertClosedAndPrivate(events: readonly AcquisitionActivityEvent[]) {
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [...EVENT_KEYS[event.kind]].sort(), `shape of ${event.kind}`);
    for (const value of Object.values(event)) {
      if (typeof value === "string") assert.ok(CLOSED_STRINGS.has(value), `closed string: ${value}`);
      else assert.equal(typeof value, "number");
    }
  }
  const text = JSON.stringify(events);
  for (const forbidden of ["SECRET", "synthetic", "EACCES", "EIO", "ENOENT", "/private", ".part", "ld3c-observe-", tmpdir()]) {
    assert.equal(text.includes(forbidden), false, `must not expose ${forbidden}`);
  }
}

/** A real tracker on a virtual clock, with the raw events kept. */
function tracked() {
  let nowMs = 0;
  const tracker = createAcquisitionActivityTracker({ clock: () => nowMs });
  const events: AcquisitionActivityEvent[] = [];
  return {
    tracker,
    events,
    sink: (event: AcquisitionActivityEvent) => {
      events.push(event);
      tracker.record(event);
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    status: () => assessAcquisitionActivity(tracker.snapshot(), { nowMs, windowMs: WINDOW }).status,
    count: (kind: AcquisitionActivityEvent["kind"]) => events.filter((e) => e.kind === kind).length,
    totals: () => events.flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : [])),
    settled: () => events.flatMap((e) => (e.kind === "settled" ? [e.outcome] : [])),
  };
}

function virtualTime(startMs = 3_000_000) {
  let now = startMs;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: InactivityWatchdogTimers = {
    setTimeoutFn(fn, ms) {
      seq += 1;
      pending.set(seq, { at: now + ms, fn });
      return { id: seq, unref: () => undefined } as InactivityWatchdogTimerHandle;
    },
    clearTimeoutFn(handle) {
      pending.delete((handle as unknown as { id: number }).id);
    },
  };
  return {
    clock: () => now,
    timers,
    now: () => now,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let nextId = -1;
        let nextAt = Infinity;
        for (const [id, t] of pending) {
          if (t.at <= end && (t.at < nextAt || (t.at === nextAt && id < nextId))) {
            nextId = id;
            nextAt = t.at;
          }
        }
        if (nextId === -1) break;
        const due = pending.get(nextId)!;
        pending.delete(nextId);
        if (due.at > now) now = due.at;
        due.fn();
      }
      if (end > now) now = end;
    },
    pendingCount: () => pending.size,
  };
}

/** A real watchdog on a virtual clock, fed by the real seam. */
function watched(maxUnobservedMs?: number) {
  const vt = virtualTime();
  const decisions: string[] = [];
  const events: AcquisitionActivityEvent[] = [];
  const watchdog = createAcquisitionInactivityWatchdog({
    policy: { windowMs: WINDOW, ...(maxUnobservedMs === undefined ? {} : { maxUnobservedMs }) },
    clock: vt.clock,
    timers: vt.timers,
    onStall: () => decisions.push("inactivity"),
    onObservationLost: () => decisions.push("observation-lost"),
  });
  return {
    vt,
    watchdog,
    decisions,
    events,
    sink: (event: AcquisitionActivityEvent) => {
      events.push(event);
      watchdog.record(event);
    },
    count: (kind: AcquisitionActivityEvent["kind"]) => events.filter((e) => e.kind === kind).length,
  };
}

type SettledState = number | null | { readonly throws: string };
type BoardState = SettledState | { readonly hold: Promise<void>; readonly then: SettledState };

/**
 * An injected `statSize` the test sets path by path: a size, `null` (absent),
 * a coded throw (unreadable), or a held call. Unset paths are absent. Calls are
 * counted per path, so a test can wait for the monitor's next samples.
 */
function board() {
  const states = new Map<string, BoardState>();
  const calls = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    set: (path: string, state: BoardState) => states.set(path, state),
    calls: (path: string) => calls.get(path) ?? 0,
    maxInFlight: () => maxInFlight,
    statSize: async (path: string): Promise<number | null> => {
      calls.set(path, (calls.get(path) ?? 0) + 1);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        let state: BoardState = states.get(path) ?? null;
        if (state !== null && typeof state === "object" && "hold" in state) {
          await state.hold;
          state = state.then;
        }
        if (state === null || typeof state === "number") return state;
        throw coded(state.throws);
      } finally {
        inFlight -= 1;
      }
    },
  };
}

/** Waits until the monitor has STARTED `samples` more observations of `path` (so the earlier ones have finished: samples never overlap). */
function samplesOf(b: ReturnType<typeof board>, path: string, samples = 2) {
  const start = b.calls(path);
  return waitUntil(() => b.calls(path) >= start + samples + 1, `${samples} more samples`);
}

function progressivePlan(): GenericSingleSourceExecutionPlan {
  return {
    strategy: "yt-dlp",
    operation: "keep-original",
    requestedFormatId: "preset:1080",
    source: {
      formatId: "22",
      protocol: "https",
      container: "mp4",
      hasVideo: true,
      hasAudio: true,
      videoConstraint: "codec-present",
      audioConstraint: "codec-present",
      fileSize: null,
    },
    targetContainer: "mp4",
  } as GenericSingleSourceExecutionPlan;
}

const DASH_VIDEO: GenericSourceSelection = {
  formatId: "dash-v",
  protocol: "http_dash_segments",
  container: "mp4",
  hasVideo: true,
  hasAudio: false,
  videoConstraint: "codec-present",
  audioConstraint: "absent",
  fileSize: null,
};
const HTTPS_AUDIO: GenericSourceSelection = {
  formatId: "140",
  protocol: "https",
  container: "m4a",
  hasVideo: false,
  hasAudio: true,
  videoConstraint: "absent",
  audioConstraint: "codec-present",
  fileSize: null,
};
const HTTPS_VIDEO: GenericSourceSelection = { ...DASH_VIDEO, formatId: "137", protocol: "https" };

function splitPlan(video: GenericSourceSelection = DASH_VIDEO, audio: GenericSourceSelection = HTTPS_AUDIO): GenericSplitExecutionPlan {
  return { strategy: "yt-dlp", operation: "merge-split", requestedFormatId: "preset:1080", pair: { video, audio }, targetContainer: "mp4" };
}

function deps(overrides: Partial<GenericDownloadDeps> & { runner: unknown }): GenericDownloadDeps {
  const child = overrides.runner as (call: never) => Promise<RunResult>;
  return {
    limits: LIMITS,
    probeRuntime: async () => RUNTIME_OK,
    validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
    sizePollMs: 1,
    ...overrides,
    runner: async (call: never) => {
      try {
        return await child(call);
      } catch (err: unknown) {
        if (err instanceof assert.AssertionError) childAssertions.push(err);
        throw err;
      }
    },
  } as GenericDownloadDeps;
}

/** An acquisition whose failure is re-raised as the child's own failed assertion, when there was one. */
function surface<T>(operation: Promise<T>): Promise<T> {
  return operation.catch((err: unknown) => {
    throw childAssertions.shift() ?? err;
  });
}
const dl = (...args: Parameters<typeof downloadGenericOriginal>) => surface(downloadGenericOriginal(...args));
const dlSplit = (...args: Parameters<typeof downloadGenericSplitSources>) => surface(downloadGenericSplitSources(...args));

const roleOf = (call: { args: readonly string[] }): "video" | "audio" => (call.args.some((a) => a.includes("audio-source")) ? "audio" : "video");

/**
 * A fake child that holds until the operation's own signal aborts, then rejects
 * as the real runner does. BOUNDED: if no abort arrives within 5 s it exits
 * non-zero instead, so a defect that suppresses an abort fails the test's own
 * assertions about the outcome — never a test-runner timeout.
 */
const untilAborted = (call: { signal?: AbortSignal }, boundMs = 5_000) =>
  new Promise<RunResult>((resolve, reject) => {
    const fail = () => {
      clearTimeout(timer);
      reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
    };
    const timer = setTimeout(() => {
      call.signal?.removeEventListener("abort", fail);
      resolve({ code: 97, stdout: "", stderr: "" });
    }, boundMs);
    if (call.signal?.aborted) fail();
    else call.signal?.addEventListener("abort", fail, { once: true });
  });

// ── F: the typed observation contract ─────────────────────────────────────────

describe("F: the typed file observation, on the real filesystem", () => {
  it("a regular file with zero bytes is `bytes: 0`, never absent", async () => {
    const path = join(workDir, "empty");
    writeFileSync(path, "");
    assert.deepEqual(await observeFilesystemFile(path), { kind: "bytes", bytes: 0 });
  });

  it("a regular file with bytes is its exact size", async () => {
    const path = join(workDir, "media");
    writeFileSync(path, chunk(123_457));
    assert.deepEqual(await observeFilesystemFile(path), { kind: "bytes", bytes: 123_457 });
  });

  it("a file that does not exist is `absent`", async () => {
    assert.deepEqual(await observeFilesystemFile(join(workDir, "never")), { kind: "absent" });
  });

  it("a permission refusal is `unreadable: permission` — never zero bytes, never absent", { skip: IS_ROOT ? "root bypasses permissions" : false }, async () => {
    const locked = join(workDir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "media"), chunk(10));
    chmodSync(locked, 0o000);
    restore.push(() => chmodSync(locked, 0o700));
    assert.deepEqual(await observeFilesystemFile(join(locked, "media")), { kind: "unreadable", failure: "permission" });
    assert.deepEqual(await observeFilesystemFile(join(locked, "never")), { kind: "unreadable", failure: "permission" }, "absence behind a refusal is not proven");
  });

  it("a directory where the file should be is `not-a-regular-file`", async () => {
    const path = join(workDir, "dir");
    mkdirSync(path);
    assert.deepEqual(await observeFilesystemFile(path), { kind: "unreadable", failure: "not-a-regular-file" });
  });

  it("a link to a regular file reads its size, exactly as the byte guard always has (the final proof refuses links)", async () => {
    writeFileSync(join(workDir, "target"), chunk(77));
    symlinkSync(join(workDir, "target"), join(workDir, "link"));
    assert.deepEqual(await observeFilesystemFile(join(workDir, "link")), { kind: "bytes", bytes: 77 });
  });

  it("a dangling link is an unsupported entry, never `absent`", async () => {
    symlinkSync(join(workDir, "nowhere"), join(workDir, "dangling"));
    assert.deepEqual(await observeFilesystemFile(join(workDir, "dangling")), { kind: "unreadable", failure: "unsupported-entry" });
  });

  it("a link loop is `unreadable: path`", async () => {
    symlinkSync(join(workDir, "b"), join(workDir, "a"));
    symlinkSync(join(workDir, "a"), join(workDir, "b"));
    assert.deepEqual(await observeFilesystemFile(join(workDir, "a")), { kind: "unreadable", failure: "path" });
  });

  it("a path through a regular file is `unreadable: path` (ENOTDIR), never absent", async () => {
    writeFileSync(join(workDir, "plain"), "x");
    assert.deepEqual(await observeFilesystemFile(join(workDir, "plain", "media")), { kind: "unreadable", failure: "path" });
  });
});

describe("F: the typed file observation, injected results", () => {
  const fs = (stat: () => Promise<unknown>, lstat: () => Promise<unknown> = async () => ({ isSymbolicLink: () => false })) =>
    ({ stat, lstat }) as unknown as Parameters<typeof observeFilesystemFile>[1];
  const file = (size: unknown, isFile = true) => fs(async () => ({ isFile: () => isFile, size }));

  it("every errno maps to its closed category; unknown and code-less errors are `other`", async () => {
    const table: Array<[string, string]> = [
      ["EACCES", "permission"], ["EPERM", "permission"], ["EIO", "io"],
      ["EMFILE", "resource"], ["ENFILE", "resource"], ["ENOMEM", "resource"], ["EAGAIN", "resource"], ["EBUSY", "resource"],
      ["ENOTDIR", "path"], ["ELOOP", "path"], ["ENAMETOOLONG", "path"], ["ESTALE", "other"], ["EWHATEVER", "other"],
    ];
    for (const [code, failure] of table) {
      assert.deepEqual(await observeFilesystemFile("/x", fs(async () => Promise.reject(coded(code)))), { kind: "unreadable", failure }, code);
    }
    assert.deepEqual(await observeFilesystemFile("/x", fs(async () => Promise.reject(new Error("no code")))), { kind: "unreadable", failure: "other" });
    assert.deepEqual(await observeFilesystemFile("/x", fs(async () => Promise.reject("a string"))), { kind: "unreadable", failure: "other" });
    assert.deepEqual(await observeFilesystemFile("/x", fs(async () => Promise.reject(Object.assign(new Error(), { code: 13 })))), { kind: "unreadable", failure: "other" });
  });

  it("an impossible size is `invalid-size`: negative, fractional, unsafe, infinite, NaN or not a number", async () => {
    for (const size of [-1, 1.5, 2 ** 53, Number.POSITIVE_INFINITY, Number.NaN, "12", null]) {
      assert.deepEqual(await observeFilesystemFile("/x", file(size)), { kind: "unreadable", failure: "invalid-size" }, String(size));
    }
    assert.deepEqual(await observeFilesystemFile("/x", file(2 ** 53 - 1)), { kind: "bytes", bytes: 2 ** 53 - 1 });
  });

  it("a FIFO, a socket or a device (anything not a regular file) is `not-a-regular-file`", async () => {
    assert.deepEqual(await observeFilesystemFile("/x", file(0, false)), { kind: "unreadable", failure: "not-a-regular-file" });
  });

  it("absence needs both answers: a stat ENOENT with a failing lstat is that failure, never absent", async () => {
    const enoent = async () => Promise.reject(coded("ENOENT"));
    assert.deepEqual(await observeFilesystemFile("/x", fs(enoent, async () => Promise.reject(coded("EIO")))), { kind: "unreadable", failure: "io" });
    assert.deepEqual(await observeFilesystemFile("/x", fs(enoent, async () => Promise.reject(coded("ENOENT")))), { kind: "absent" });
    assert.deepEqual(await observeFilesystemFile("/x", fs(enoent, async () => ({ isSymbolicLink: () => true }))), { kind: "unreadable", failure: "unsupported-entry" });
  });

  it("a file that appears between the stat and the lstat is absent for this sample (the next one sees it)", async () => {
    const enoent = async () => Promise.reject(coded("ENOENT"));
    assert.deepEqual(await observeFilesystemFile("/x", fs(enoent, async () => ({ isSymbolicLink: () => false }))), { kind: "absent" });
  });

  it("no observation carries a path, a message or an errno: only closed strings and numbers", async () => {
    const results: FileObservation[] = [];
    for (const code of ["EACCES", "EIO", "ENOENT", "ELOOP", "EWHATEVER"]) results.push(await observeFilesystemFile("/private/SECRET-PATH", fs(async () => Promise.reject(coded(code)))));
    const text = JSON.stringify(results);
    for (const forbidden of ["SECRET", "synthetic", "/private", "EACCES", "EIO", "ENOENT", "ELOOP"]) assert.equal(text.includes(forbidden), false, forbidden);
    for (const r of results) assert.ok(Object.isFrozen(r), "observations are frozen values");
  });
});

describe("F: the typed directory observation", () => {
  it("a listing is its names; an absent directory is `absent`", async () => {
    writeFileSync(join(workDir, "a"), "");
    assert.deepEqual(await observeFilesystemDirectory(workDir), { kind: "entries", names: ["a"] });
    assert.deepEqual(await observeFilesystemDirectory(join(workDir, "gone")), { kind: "absent" });
  });

  it("an unreadable directory is `unreadable: permission`", { skip: IS_ROOT ? "root bypasses permissions" : false }, async () => {
    const locked = join(workDir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    restore.push(() => chmodSync(locked, 0o700));
    assert.deepEqual(await observeFilesystemDirectory(locked), { kind: "unreadable", failure: "permission" });
  });

  it("a directory path that is a file is `unreadable: path`; a listing that is not names is `other`", async () => {
    writeFileSync(join(workDir, "plain"), "x");
    assert.deepEqual(await observeFilesystemDirectory(join(workDir, "plain")), { kind: "unreadable", failure: "path" });
    assert.deepEqual(await observeFilesystemDirectory("/x", async () => [1, 2]), { kind: "unreadable", failure: "other" });
    assert.deepEqual(await observeFilesystemDirectory("/x", async () => null), { kind: "unreadable", failure: "other" });
    assert.deepEqual(await observeFilesystemDirectory("/x", async () => Promise.reject(coded("EIO"))), { kind: "unreadable", failure: "io" });
  });
});

// ── H / G: progressive acquisition ───────────────────────────────────────────

describe("H: progressive yt-dlp observation", () => {
  it("H1: neither path exists before the download starts: no gap and no bytes — the phase is awaiting its first byte", async () => {
    const t = tracked();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    let statusBefore = "";
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: t.sink,
      statSize: b.statSize,
      runner: async () => {
        await samplesOf(b, part, 5);
        statusBefore = t.status();
        assert.equal(t.count("sample-gap"), 0, "a file not yet created is not a gap");
        assert.equal(t.count("bytes"), 0);
        writeFileSync(final, chunk(1000));
        b.set(final, 1000);
        await samplesOf(b, part);
        return EXIT_OK;
      },
    }));
    assert.equal(statusBefore, "awaiting-first-byte");
    assert.ok(b.calls(final) > 5, "the final path was observed too, while the .part was absent");
    assertClosedAndPrivate(t.events);
  });

  it("H2/H3: the .part appears and grows: each reading is the real size", async () => {
    const t = tracked();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: t.sink,
      statSize: b.statSize,
      runner: async () => {
        for (const size of [10_000, 80_000, 300_000]) {
          b.set(part, size);
          await samplesOf(b, part);
        }
        b.set(part, null);
        writeFileSync(final, chunk(300_000));
        b.set(final, 300_000);
        await samplesOf(b, part);
        return EXIT_OK;
      },
    }));
    assert.deepEqual([...new Set(t.totals())], [10_000, 80_000, 300_000]);
    assert.equal(t.tracker.snapshot().observedBytes, 300_000);
    assert.equal(t.count("sample-gap"), 0);
  });

  it("H4/H5/H6: the .part disappearing for a while (a non-atomic rename) is a gap, never zero, never a discard — and the final file with the same bytes earns nothing", async () => {
    const w = watched();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: w.sink,
      statSize: b.statSize,
      runner: async () => {
        b.set(part, 5 * G);
        await samplesOf(b, part);
        w.vt.advance(30_000);
        b.set(part, null); // gone, and the final name not there yet
        await waitUntil(() => w.count("sample-gap") >= 3, "the phase to become unobserved");
        w.vt.advance(40_000); // 40 s of blindness, credited to the window
        await samplesOf(b, part);
        writeFileSync(final, chunk(5 * G));
        b.set(final, 5 * G); // the same bytes, under the final name
        await samplesOf(b, part);
        const report = w.watchdog.report();
        assert.equal(report.honouredAnchorAtMs !== null && report.honouredAnchorAtMs < w.vt.now() - 60_000, true, "the window was not restarted by the reappearance");
        assert.equal(report.unobservedCreditMs, 40_000);
        const s = w.watchdog.snapshot();
        assert.equal(s.observedBytes, 5 * G, "never a truncation to zero");
        assert.equal(s.discardedBytes, 0, "a disappearance is never a discard");
        return EXIT_OK;
      },
    }));
    const totals = w.events.flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : []));
    assert.equal(Math.max(...totals), 5 * G, "no byte was counted twice");
    assert.equal(totals.includes(0), false, "an absent file was never read as zero bytes");
    assert.deepEqual(w.decisions, []);
  });

  it("H7: the final file growing after the rename is real growth, read from the final path", async () => {
    const t = tracked();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: t.sink,
      statSize: b.statSize,
      runner: async () => {
        b.set(part, 100_000);
        await samplesOf(b, part);
        b.set(part, null);
        b.set(final, 100_000);
        await samplesOf(b, part);
        b.set(final, 250_000);
        writeFileSync(final, chunk(250_000));
        await samplesOf(b, part);
        return EXIT_OK;
      },
    }));
    assert.equal(t.tracker.snapshot().observedBytes, 250_000);
  });

  it("H8: one transient read failure is one gap and nothing else", async () => {
    const t = tracked();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: t.sink,
      statSize: b.statSize,
      runner: async () => {
        b.set(part, 3 * G);
        await samplesOf(b, part);
        const gapsBefore = t.count("sample-gap");
        b.set(part, { throws: "EIO" });
        b.set(final, null);
        await waitUntil(() => t.count("sample-gap") === gapsBefore + 1, "one gap");
        b.set(part, 3 * G);
        await samplesOf(b, part);
        assert.equal(t.count("sample-gap"), gapsBefore + 1);
        assert.equal(t.status(), "not-advancing", "a single gap is not a blind phase");
        b.set(part, null);
        writeFileSync(final, chunk(3 * G));
        b.set(final, 3 * G);
        await samplesOf(b, part);
        return EXIT_OK;
      },
    }));
    assert.equal(t.tracker.snapshot().discardedBytes, 0);
    assertClosedAndPrivate(t.events);
  });

  it("H9/H10: consecutive failures make the phase unobserved; readable again with the same bytes earns no fresh window", async () => {
    const w = watched();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: w.sink,
      statSize: b.statSize,
      runner: async () => {
        b.set(part, 4 * G);
        await samplesOf(b, part);
        const anchor = w.watchdog.report().honouredAnchorAtMs;
        w.vt.advance(10_000);
        b.set(part, { throws: "EACCES" });
        await waitUntil(() => w.count("sample-gap") >= 4, "several gaps");
        assert.equal(assessAcquisitionActivity(w.watchdog.snapshot(), { nowMs: w.vt.now(), windowMs: WINDOW }).status, "unobserved");
        w.vt.advance(20_000);
        b.set(part, 4 * G); // readable again, nothing new
        await samplesOf(b, part);
        assert.equal(w.watchdog.report().honouredAnchorAtMs, anchor, "recovery alone moves nothing");
        assert.equal(w.watchdog.report().unobservedCreditMs, 20_000);
        b.set(part, null);
        writeFileSync(final, chunk(4 * G));
        b.set(final, 4 * G);
        await samplesOf(b, part);
        return EXIT_OK;
      },
    }));
    assert.deepEqual(w.decisions, []);
  });

  it("H11/H12: a retry that truncates and restarts from zero is a discard after three low readings; only real regrowth earns the window", async () => {
    const w = watched();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: w.sink,
      statSize: b.statSize,
      runner: async () => {
        b.set(part, 2_000_000);
        await samplesOf(b, part);
        const anchor = w.watchdog.report().honouredAnchorAtMs;
        w.vt.advance(30_000);
        b.set(part, 0); // the server ignored Range: the partial is wiped
        await samplesOf(b, part, 4);
        const s = w.watchdog.snapshot();
        assert.equal(s.discardedBytes, 2_000_000);
        assert.equal(w.watchdog.report().honouredAnchorAtMs, anchor, "the discard did not restart the window");
        b.set(part, G - 1); // regrowth below the floor
        await samplesOf(b, part);
        assert.equal(w.watchdog.report().honouredAnchorAtMs, anchor);
        w.vt.advance(10_000);
        b.set(part, G); // the floor over the lowered anchor: real progress
        await samplesOf(b, part);
        assert.equal(w.watchdog.report().honouredAnchorAtMs, w.vt.now());
        b.set(part, null);
        writeFileSync(final, chunk(G));
        b.set(final, G);
        await samplesOf(b, part);
        return EXIT_OK;
      },
    }));
    assert.deepEqual(w.decisions, []);
  });

  it("D4 fix: a file unreadable from the very first sample is blind, not awaiting a byte — gaps from the start", async () => {
    const w = watched();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    b.set(part, { throws: "EACCES" });
    b.set(final, { throws: "EACCES" });
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: w.sink,
      statSize: b.statSize,
      runner: async () => {
        await waitUntil(() => w.count("sample-gap") >= 3, "gaps before any byte");
        assert.equal(w.count("bytes"), 0);
        assert.equal(assessAcquisitionActivity(w.watchdog.snapshot(), { nowMs: w.vt.now(), windowMs: WINDOW }).status, "unobserved");
        w.vt.advance(WINDOW + 1_000); // a full window passes while nothing can be read
        assert.deepEqual(w.decisions, ["observation-lost"], "never a stall: the observer could not see");
        b.set(part, null);
        writeFileSync(final, chunk(10));
        b.set(final, 10);
        return EXIT_OK;
      },
    }));
    assert.equal(w.watchdog.report().stop, null);
  });

  it("an unreadable .part beside a readable final: the guard charges the final, the evidence takes nothing", async () => {
    const t = tracked();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        limits: { maxFileSizeBytes: 1_000, downloadTimeLimitMs: 600_000 },
        activity: t.sink,
        statSize: b.statSize,
        runner: async (call: { signal?: AbortSignal }) => {
          b.set(part, { throws: "EIO" });
          b.set(final, 5_000); // over the limit
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
    assert.equal(t.count("bytes"), 0, "a lower bound is never evidence");
    assert.ok(t.count("sample-gap") >= 1);
  });

  it("H13: the subprocess exits while a stat is pending: the late result reports nothing", async () => {
    const t = tracked();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    const release = deferred();
    let progressCalls = 0;
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: t.sink,
      statSize: b.statSize,
      onProgress: () => {
        progressCalls += 1;
      },
      runner: async () => {
        writeFileSync(final, chunk(500));
        b.set(final, 500);
        await samplesOf(b, part);
        const heldFrom = b.calls(part);
        b.set(part, { hold: release.promise, then: 999_999 });
        await waitUntil(() => b.calls(part) > heldFrom, "the held stat to start");
        return EXIT_OK;
      },
    }));
    const count = t.events.length;
    const progressBefore = progressCalls;
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(t.events.length, count, "the late sample reported nothing");
    // The activity sink is closed at settlement, which would hide a missing gate:
    // the progress stream is not, so it proves the gate itself.
    assert.equal(progressCalls, progressBefore, "the late sample reached neither the guard nor the progress stream");
    assert.equal(t.totals().includes(999_999), false);
    assert.deepEqual(t.settled(), ["completed"]);
  });

  it("H14: the caller cancels while a stat is pending: cancelled, and the late (unreadable) result is inert", async () => {
    const t = tracked();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const controller = new AbortController();
    const release = deferred();
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        activity: t.sink,
        statSize: b.statSize,
        signal: controller.signal,
        runner: async (call: { signal?: AbortSignal }) => {
          b.set(part, 3 * G);
          await samplesOf(b, part);
          const heldFrom = b.calls(part);
          b.set(part, { hold: release.promise, then: { throws: "EIO" } });
          await waitUntil(() => b.calls(part) > heldFrom, "the held stat to start");
          controller.abort(new AppError("PROCESSING_FAILED", "Download was cancelled."));
          return untilAborted(call);
        },
      })),
    );
    const count = t.events.length;
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(t.events.length, count);
    assert.deepEqual(t.settled(), ["cancelled"]);
  });

  it("H15: the absolute deadline expires while a stat is pending: deadline-exceeded, and the late result is inert", async () => {
    const t = tracked();
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const release = deferred();
    let progressCalls = 0;
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        activity: t.sink,
        statSize: b.statSize,
        onProgress: () => {
          progressCalls += 1;
        },
        runner: async () => {
          b.set(part, 3 * G);
          await samplesOf(b, part);
          const heldFrom = b.calls(part);
          b.set(part, { hold: release.promise, then: 9 * G });
          await waitUntil(() => b.calls(part) > heldFrom, "the held stat to start");
          throw new AppError("TIMEOUT"); // the runner's own deadline
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    const count = t.events.length;
    const progressBefore = progressCalls;
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(t.events.length, count);
    assert.equal(progressCalls, progressBefore, "the late sample reached neither the guard nor the progress stream");
    assert.deepEqual(t.settled(), ["deadline-exceeded"]);
  });

  it("G: samples never overlap, and once the run settles no observation is ever made again", async () => {
    const b = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    const release = deferred();
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      statSize: b.statSize,
      runner: async () => {
        b.set(part, { hold: release.promise, then: 10 });
        await waitUntil(() => b.calls(part) >= 1, "a held sample");
        await new Promise((resolve) => setTimeout(resolve, 20)); // ~20 poll intervals pass while it is held
        assert.equal(b.calls(part), 1, "no second sample started while one was pending");
        release.resolve();
        b.set(part, null);
        writeFileSync(final, chunk(10));
        b.set(final, 10);
        await samplesOf(b, part);
        return EXIT_OK;
      },
    }));
    assert.equal(b.maxInFlight(), 1);
    const after = b.calls(part) + b.calls(final);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(b.calls(part) + b.calls(final), after, "a completed monitor never restarts");
  });

  it("the legacy `statSize` seam keeps its meaning: null is absent (silent before the first byte), a coded throw is unreadable (a gap from the start)", async () => {
    const quiet = tracked();
    const b1 = board();
    const part = expectedPartPath(workDir, "mp4");
    const final = expectedSourcePath(workDir, "mp4");
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: quiet.sink,
      statSize: b1.statSize,
      runner: async () => {
        await samplesOf(b1, part, 3);
        writeFileSync(final, chunk(10));
        b1.set(final, 10);
        await samplesOf(b1, part);
        return EXIT_OK;
      },
    }));
    assert.equal(quiet.count("sample-gap"), 0);

    rmSync(final);
    const loud = tracked();
    const b2 = board();
    b2.set(part, { throws: "EIO" });
    b2.set(final, { throws: "EIO" });
    await dl(SECRET_URL, workDir, progressivePlan(), deps({
      activity: loud.sink,
      statSize: b2.statSize,
      runner: async () => {
        await samplesOf(b2, part, 3);
        writeFileSync(final, chunk(10));
        b2.set(final, 10);
        await samplesOf(b2, part);
        return EXIT_OK;
      },
    }));
    assert.ok(loud.count("sample-gap") >= 3);
    assertClosedAndPrivate(loud.events);
  });

  it("the real observer, end to end: a real permission refusal on the job directory's files reports gaps, never bytes", { skip: IS_ROOT ? "root bypasses permissions" : false }, async () => {
    const t = tracked();
    const inner = join(workDir, "inner");
    mkdirSync(inner);
    const part = expectedPartPath(inner, "mp4");
    const final = expectedSourcePath(inner, "mp4");
    await dl(SECRET_URL, inner, progressivePlan(), deps({
      activity: t.sink,
      runner: async () => {
        writeFileSync(part, chunk(3 * G));
        await waitUntil(() => t.count("bytes") >= 2, "real readings");
        chmodSync(inner, 0o000);
        restore.push(() => chmodSync(inner, 0o700));
        const before = t.count("sample-gap");
        await waitUntil(() => t.count("sample-gap") >= before + 3, "real gaps");
        assert.equal(t.status(), "unobserved");
        assert.equal(t.tracker.snapshot().observedBytes, 3 * G, "an unreadable file is never zero bytes");
        chmodSync(inner, 0o700);
        renameSync(part, final);
        await waitUntil(() => t.count("bytes") >= 3, "readable again");
        return EXIT_OK;
      },
    }));
    assert.equal(t.tracker.snapshot().discardedBytes, 0);
    assertClosedAndPrivate(t.events);
  });
});

// ── I: segmented DASH and split pairs ────────────────────────────────────────

describe("I: segmented DASH observation (a DASH video half beside an HTTPS audio half)", () => {
  const video = () => expectedSplitSourcePath(workDir, "video", "mp4");
  const audio = () => expectedSplitSourcePath(workDir, "audio", "m4a");

  /** Runs a split pair whose video half is the test's script and whose audio half lands a small real file. */
  async function pair(
    script: (paths: { final: string; part: string }, call: { signal?: AbortSignal }) => Promise<void>,
    extra: Partial<GenericDownloadDeps> = {},
  ) {
    return dlSplit(SECRET_URL, workDir, splitPlan(), deps({
      ...extra,
      runner: async (call: { args: readonly string[]; signal?: AbortSignal }) => {
        if (roleOf(call) === "video") {
          await script({ final: video(), part: `${video()}.part` }, call);
          return EXIT_OK;
        }
        writeFileSync(audio(), chunk(100));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return EXIT_OK;
      },
    }) as Parameters<typeof downloadGenericSplitSources>[3]);
  }

  /** Waits for `n` more completed listings of the job directory (counted by a wrapping readDir). */
  function listings() {
    let count = 0;
    const readDir = async (p: string) => {
      count += 1;
      return fsReaddir(p);
    };
    return { readDir, after: (n = 2) => { const start = count; return waitUntil(() => count >= start + n + 1, `${n} listings`); } };
  }

  it("I: aggregate growth, a fragment growing in flight, its rename, its append and its deletion: every byte once, nothing discarded", async () => {
    const t = tracked();
    const l = listings();
    await pair(async ({ final, part }) => {
      writeFileSync(`${final}.ytdl`, "{}");
      writeFileSync(part, "");
      await l.after();
      for (const [n, size] of [[1, 40_000], [2, 30_000]] as const) {
        const fragPart = `${part}-Frag${n}.part`;
        const frag = `${part}-Frag${n}`;
        writeFileSync(fragPart, chunk(size / 2, n));
        await l.after();
        appendFileSync(fragPart, chunk(size / 2, n));
        await l.after();
        renameSync(fragPart, frag);
        await l.after();
        appendFileSync(part, readFileSync(frag));
        await l.after();
        unlinkSync(frag);
        await l.after();
      }
      unlinkSync(`${final}.ytdl`);
      renameSync(part, final);
      await l.after();
    }, { activity: t.sink, readDir: l.readDir });
    const videoEnd = t.events.findIndex((e) => e.kind === "phase-ended");
    const videoTotals = t.events.slice(0, videoEnd).flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : []));
    assert.equal(Math.max(...videoTotals), 70_000, "every byte counted once");
    assert.equal(t.tracker.snapshot().discardedBytes, 0);
    assertClosedAndPrivate(t.events);
  });

  it("I: zero media files before the first write (only bookkeeping) is absent: silent, not a gap", async () => {
    const t = tracked();
    const l = listings();
    await pair(async ({ final }) => {
      writeFileSync(`${final}.ytdl`, "{}");
      await l.after(4);
      assert.equal(t.count("sample-gap"), 0);
      assert.equal(t.count("bytes"), 0);
      unlinkSync(`${final}.ytdl`);
      writeFileSync(final, chunk(5000));
      await l.after();
    }, { activity: t.sink, readDir: l.readDir });
  });

  it("I: a listing racing with a fragment's deletion (listed, gone at its stat) is incomplete: a gap, never a lower reading", async () => {
    const t = tracked();
    const b = board();
    const l = listings();
    await pair(async ({ final, part }) => {
      writeFileSync(part, chunk(200_000));
      b.set(part, 200_000);
      await l.after();
      writeFileSync(`${part}-Frag7`, chunk(10)); // listed ...
      b.set(`${part}-Frag7`, null); // ... but gone by the time it is stat'ed
      await l.after(); // from here on every listing names it
      const before = t.count("sample-gap");
      b.set(part, 150_000); // and the aggregate reads lower in those same samples
      await l.after(4);
      assert.ok(t.count("sample-gap") >= before + 4, "each incomplete sample is a gap");
      assert.equal(t.totals().includes(150_000), false, "a partial listing never enters the evidence");
      unlinkSync(`${part}-Frag7`);
      b.set(part, 200_000);
      await l.after();
      renameSync(part, final);
      b.set(part, null);
      b.set(final, 200_000);
      await l.after();
    }, { activity: t.sink, readDir: l.readDir, statSize: b.statSize });
    assert.equal(t.tracker.snapshot().discardedBytes, 0, "no false discard from a race");
  });

  it("I: a listing that succeeds while a listed file's stat is refused (permission), and several failures in one cycle: one gap per sample; the guard still charges what it read", async () => {
    const t = tracked();
    const b = board();
    const l = listings();
    await assert.rejects(
      pair(async ({ part }, call) => {
        writeFileSync(part, "");
        b.set(part, 900);
        writeFileSync(`${part}-Frag1.part`, "");
        b.set(`${part}-Frag1.part`, { throws: "EACCES" });
        writeFileSync(join(workDir, "stray"), "");
        b.set(join(workDir, "stray"), { throws: "EIO" });
        await l.after(3);
        assert.equal(t.count("bytes"), 0, "an incomplete listing is never a reading");
        const gaps = t.count("sample-gap");
        assert.ok(gaps >= 3);
        b.set(part, 2_000); // the readable aggregate alone passes the limit
        await untilAborted(call);
      }, { activity: t.sink, readDir: l.readDir, statSize: b.statSize, limits: { maxFileSizeBytes: 1_500, downloadTimeLimitMs: 600_000 } }),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
  });

  it("I: the job directory disappearing is never no-file-yet: gaps from the start, and the run's files are never invented", async () => {
    const t = tracked();
    const gone = coded("ENOENT");
    let fail = false;
    let listed = 0;
    const readDir = async (p: string) => {
      listed += 1;
      if (fail) throw gone;
      return fsReaddir(p);
    };
    await pair(async ({ final }) => {
      fail = true;
      const from = listed;
      await waitUntil(() => listed >= from + 4, "listings of a missing directory");
      assert.ok(t.count("sample-gap") >= 3, "a missing job directory is blindness");
      assert.equal(t.count("bytes"), 0);
      fail = false;
      writeFileSync(final, chunk(300));
      await waitUntil(() => t.count("bytes") >= 1, "a reading");
    }, { activity: t.sink, readDir });
  });

  it("I: an unrecognised entry the run added is charged by the guard: no name escapes the ceiling", async () => {
    const t = tracked();
    const l = listings();
    await assert.rejects(
      pair(async ({ part }, call) => {
        writeFileSync(part, chunk(1_000));
        await l.after();
        writeFileSync(join(workDir, "unrecognised.bin"), chunk(2_000)); // 1,000 + 2,000 > 2,500
        await untilAborted(call);
      }, { activity: t.sink, readDir: l.readDir, limits: { maxFileSizeBytes: 2_500, downloadTimeLimitMs: 600_000 } }),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
    assert.equal(Math.max(...t.totals()), 1_000, "an unrecognised entry is never progress");
  });

  it("I: a fragment never observed in flight is charged whole by the guard and never counted as progress", async () => {
    const t = tracked();
    const l = listings();
    await assert.rejects(
      pair(async ({ part }, call) => {
        writeFileSync(part, chunk(1_000));
        await l.after();
        writeFileSync(`${part}-Frag1`, chunk(1_000)); // complete before any sample saw it in flight
        await untilAborted(call);
      }, { activity: t.sink, readDir: l.readDir, limits: { maxFileSizeBytes: 1_900, downloadTimeLimitMs: 600_000 } }),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
    assert.equal(Math.max(...t.totals()), 1_000, "progress never took the unseen fragment");
  });

  it("D2: an aggregate that cannot be read never becomes the base a fragment in flight will extend: the guard charges that fragment whole", async () => {
    const b = board();
    const l = listings();
    let aborted = false;
    let abortedWhileUnappended: boolean | null = null;
    const outcome = await dlSplit(SECRET_URL, workDir, splitPlan(), deps({
        readDir: l.readDir,
        statSize: b.statSize,
        limits: { maxFileSizeBytes: 150_000, downloadTimeLimitMs: 600_000 },
        runner: async (call: { signal?: AbortSignal }) => {
          call.signal?.addEventListener("abort", () => (aborted = true), { once: true });
          const part = `${video()}.part`;
          writeFileSync(part, "");
          writeFileSync(`${part}-Frag1.part`, "");
          b.set(part, { throws: "EIO" }); // the aggregate cannot be read ...
          b.set(`${part}-Frag1.part`, 60_000); // ... while fragment 1 is in flight
          await l.after(3);
          // Fragment 1 completes; the aggregate is readable again and has not had it appended.
          unlinkSync(`${part}-Frag1.part`);
          writeFileSync(`${part}-Frag1`, "");
          b.set(`${part}-Frag1.part`, null);
          b.set(`${part}-Frag1`, 60_000);
          b.set(part, 100_000);
          await l.after(3);
          // 100,000 + the whole 60,000 > 150,000. A guessed base of 0 would have charged only 60,000 - 100,000 -> 0.
          abortedWhileUnappended = aborted;
          if (aborted) return untilAborted(call);
          return { code: 1, stdout: "", stderr: "" };
        },
      }) as Parameters<typeof downloadGenericSplitSources>[3]).then(
      () => null,
      (err: unknown) => err,
    );
    assert.equal(abortedWhileUnappended, true, "the guard charged the unappended fragment whole");
    assert.ok(outcome instanceof AppError && outcome.code === "TOO_LARGE");
  });

  it("I: a retry that discards a fragment's partial bytes is a discard after three low readings; re-sent bytes are real progress", async () => {
    const t = tracked();
    const b = board();
    const l = listings();
    await pair(async ({ final, part }) => {
      writeFileSync(part, "");
      b.set(part, 100_000);
      b.set(`${part}-Frag3.part`, 50_000);
      writeFileSync(`${part}-Frag3.part`, "");
      await l.after();
      b.set(`${part}-Frag3.part`, 0); // the fragment retry wiped its partial
      await l.after(4);
      assert.equal(t.tracker.snapshot().discardedBytes, 50_000);
      b.set(`${part}-Frag3.part`, 50_000);
      await l.after();
      assert.equal(t.tracker.snapshot().observedBytes, 150_000);
      unlinkSync(`${part}-Frag3.part`);
      b.set(`${part}-Frag3.part`, null);
      b.set(part, 150_000);
      await l.after();
      writeFileSync(final, chunk(150_000));
      unlinkSync(part);
      b.set(part, null);
      b.set(final, 150_000);
      await l.after();
    }, { activity: t.sink, readDir: l.readDir, statSize: b.statSize });
  });

  it("I: multiple consecutive low aggregate readings are a genuine restart: a discard, and the window keeps its time", async () => {
    const w = watched();
    const b = board();
    const l = listings();
    await pair(async ({ final, part }) => {
      writeFileSync(part, "");
      b.set(part, 3_000_000);
      await l.after();
      const anchor = w.watchdog.report().honouredAnchorAtMs;
      w.vt.advance(20_000);
      b.set(part, 1_000);
      await l.after(4);
      assert.equal(w.watchdog.snapshot().discardedBytes, 2_999_000);
      assert.equal(w.watchdog.report().honouredAnchorAtMs, anchor);
      writeFileSync(final, chunk(1_000));
      unlinkSync(part);
      b.set(part, null);
      b.set(final, 1_000);
      await l.after();
    }, { activity: w.sink, readDir: l.readDir, statSize: b.statSize });
  });

  it("I: a late fragment sample after the video half ended reports nothing into the audio half", async () => {
    const t = tracked();
    const b = board();
    const release = deferred();
    const l = listings();
    await dlSplit(SECRET_URL, workDir, splitPlan(), deps({
      activity: t.sink,
      readDir: l.readDir,
      statSize: b.statSize,
      runner: async (call: { args: readonly string[] }) => {
        if (roleOf(call) === "video") {
          writeFileSync(video(), chunk(4_000));
          b.set(video(), 4_000);
          await l.after();
          const heldFrom = b.calls(video());
          b.set(video(), { hold: release.promise, then: 4_000_000 });
          await waitUntil(() => b.calls(video()) > heldFrom, "the held stat to start");
          return EXIT_OK; // the video run ends while its sample is suspended
        }
        writeFileSync(audio(), chunk(300));
        b.set(audio(), 300);
        await waitUntil(() => t.totals().includes(300), "an audio reading");
        release.resolve();
        await new Promise((resolve) => setTimeout(resolve, 10));
        return EXIT_OK;
      },
    }) as Parameters<typeof downloadGenericSplitSources>[3]);
    const audioStart = t.events.findIndex((e) => e.kind === "phase-started" && e.phase === "audio");
    const audioTotals = t.events.slice(audioStart).flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : []));
    assert.equal(audioTotals.includes(4_000_000), false);
    assert.deepEqual([...new Set(audioTotals)], [300]);
    assert.deepEqual(t.settled(), ["completed"]);
  });

  it("I: video to audio: blindness in the video half is not carried into the audio half", async () => {
    const t = tracked();
    const b = board();
    const l = listings();
    await dlSplit(SECRET_URL, workDir, splitPlan(HTTPS_VIDEO, HTTPS_AUDIO), deps({
      activity: t.sink,
      statSize: b.statSize,
      readDir: l.readDir,
      runner: async (call: { args: readonly string[] }) => {
        const role = roleOf(call);
        const final = role === "video" ? video() : audio();
        if (role === "video") {
          b.set(`${final}.part`, { throws: "EIO" });
          b.set(final, { throws: "EIO" });
          await waitUntil(() => t.count("sample-gap") >= 3, "video blindness");
          assert.equal(t.status(), "unobserved");
        }
        writeFileSync(final, chunk(role === "video" ? 2_000 : 300));
        b.set(`${final}.part`, null);
        b.set(final, role === "video" ? 2_000 : 300);
        await waitUntil(() => t.totals().includes(role === "video" ? 2_000 : 300), "a reading");
        if (role === "audio") assert.equal(t.tracker.snapshot().sampleGaps, 0, "the audio half starts with no gaps");
        return EXIT_OK;
      },
    }) as Parameters<typeof downloadGenericSplitSources>[3]);
    assert.deepEqual(t.settled(), ["completed"]);
  });

  it("I: the split pair's combined byte budget is unchanged: the audio half's allowance is what the video half left", async () => {
    const seen: string[] = [];
    await assert.rejects(
      dlSplit(SECRET_URL, workDir, splitPlan(HTTPS_VIDEO, HTTPS_AUDIO), deps({
        limits: { maxFileSizeBytes: 10_000, downloadTimeLimitMs: 600_000 },
        runner: async (call: { args: readonly string[]; signal?: AbortSignal }) => {
          seen.push(call.args.find((a) => a.startsWith("--max-filesize="))!);
          if (roleOf(call) === "video") {
            writeFileSync(video(), chunk(7_000));
            return EXIT_OK;
          }
          writeFileSync(`${audio()}.part`, chunk(3_500)); // 7,000 + 3,500 > 10,000
          return untilAborted(call);
        },
      }) as Parameters<typeof downloadGenericSplitSources>[3]),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
    assert.deepEqual(seen, ["--max-filesize=10000", "--max-filesize=3000"]);
  });
});

// ── L: the generic subprocess seam's own stop causes ─────────────────────────

describe("L: abort provenance in the generic subprocess seam", () => {
  const final = () => expectedSourcePath(workDir, "mp4");
  const part = () => expectedPartPath(workDir, "mp4");

  it("an inactivity stop is its own cause: TIMEOUT, settled `failed`, never `cancelled`, through the operation's one controller", async () => {
    const t = tracked();
    const stop = new AbortController();
    let runnerSignal: AbortSignal | undefined;
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        activity: t.sink,
        stopForInactivity: stop.signal,
        runner: async (call: { signal?: AbortSignal }) => {
          runnerSignal = call.signal;
          writeFileSync(part(), chunk(70_000));
          await waitUntil(() => t.count("bytes") > 0, "a reading");
          stop.abort();
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.equal(runnerSignal?.aborted, true, "the child's own signal was aborted");
    assert.deepEqual(t.settled(), ["failed"]);
    assertClosedAndPrivate(t.events);
  });

  it("an observation-loss stop is its own cause: PROCESSING_FAILED, settled `failed`, never a TIMEOUT", async () => {
    const t = tracked();
    const stop = new AbortController();
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        activity: t.sink,
        stopForObservationLoss: stop.signal,
        runner: async (call: { signal?: AbortSignal }) => {
          stop.abort();
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED" && err.message !== "Download was cancelled.",
    );
    assert.deepEqual(t.settled(), ["failed"]);
  });

  it("a user cancellation first stays a cancellation: a later stop changes nothing", async () => {
    const t = tracked();
    const caller = new AbortController();
    const stop = new AbortController();
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        activity: t.sink,
        signal: caller.signal,
        stopForInactivity: stop.signal,
        runner: async (call: { signal?: AbortSignal }) => {
          caller.abort(new AppError("PROCESSING_FAILED", "Download was cancelled."));
          stop.abort();
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED" && err.message === "Download was cancelled.",
    );
    assert.deepEqual(t.settled(), ["cancelled"]);
  });

  it("a size overflow first stays TOO_LARGE: a later stop changes nothing", async () => {
    const t = tracked();
    const stop = new AbortController();
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        activity: t.sink,
        limits: { maxFileSizeBytes: 1_000, downloadTimeLimitMs: 600_000 },
        stopForInactivity: stop.signal,
        runner: async (call: { signal?: AbortSignal }) => {
          writeFileSync(part(), chunk(5_000));
          await waitUntil(() => call.signal?.aborted === true, "the guard's abort");
          stop.abort();
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
    assert.deepEqual(t.settled(), ["failed"]);
  });

  it("a stop first stays the outcome: the execution's abort (the caller signal) and an overflow afterwards change nothing", async () => {
    const t = tracked();
    const caller = new AbortController();
    const stop = new AbortController();
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        activity: t.sink,
        signal: caller.signal,
        limits: { maxFileSizeBytes: 1_000, downloadTimeLimitMs: 600_000 },
        stopForInactivity: stop.signal,
        runner: async (call: { signal?: AbortSignal }) => {
          stop.abort();
          caller.abort(new AppError("TIMEOUT"));
          writeFileSync(part(), chunk(5_000));
          await new Promise((resolve) => setTimeout(resolve, 5));
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.deepEqual(t.settled(), ["failed"], "never re-read as the caller's cancellation");
  });

  it("a stop after the absolute deadline has passed is ignored: the runner's TIMEOUT owns the outcome", async () => {
    const t = tracked();
    const stop = new AbortController();
    let now = 1_000_000;
    let runnerSignal: AbortSignal | undefined;
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        activity: t.sink,
        clock: () => now,
        stopForInactivity: stop.signal,
        runner: async (call: { signal?: AbortSignal }) => {
          runnerSignal = call.signal;
          now += LIMITS.downloadTimeLimitMs; // the deadline has passed
          stop.abort();
          assert.equal(call.signal?.aborted, false, "a stop past the deadline aborts nothing");
          throw new AppError("TIMEOUT"); // the runner's own deadline kill
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.equal(runnerSignal?.aborted, false);
    assert.deepEqual(t.settled(), ["deadline-exceeded"]);
  });

  it("a stop already aborted before the child starts: the child is never run alive, and the outcome is the stop", async () => {
    const stop = new AbortController();
    stop.abort();
    let signalAtSpawn: boolean | undefined;
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        stopForInactivity: stop.signal,
        runner: async (call: { signal?: AbortSignal }) => {
          signalAtSpawn = call.signal?.aborted;
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.equal(signalAtSpawn, true, "the hardened runner refuses to spawn under an aborted signal");
  });

  it("split pair: one latch for both halves — a stop between the halves, or during the audio half, is the outcome", async () => {
    const between = new AbortController();
    let audioRan = false;
    await assert.rejects(
      dlSplit(SECRET_URL, workDir, splitPlan(HTTPS_VIDEO, HTTPS_AUDIO), deps({
        stopForInactivity: between.signal,
        runner: async (call: { args: readonly string[] }) => {
          if (roleOf(call) === "audio") audioRan = true;
          writeFileSync(expectedSplitSourcePath(workDir, "video", "mp4"), chunk(100));
          between.abort(); // the video run has exited zero; nothing runs until the audio half
          return EXIT_OK;
        },
      }) as Parameters<typeof downloadGenericSplitSources>[3]),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.equal(audioRan, false, "no audio child after the stop");

    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir);
    const during = new AbortController();
    const t = tracked();
    await assert.rejects(
      dlSplit(SECRET_URL, workDir, splitPlan(HTTPS_VIDEO, HTTPS_AUDIO), deps({
        activity: t.sink,
        stopForObservationLoss: during.signal,
        runner: async (call: { args: readonly string[]; signal?: AbortSignal }) => {
          if (roleOf(call) === "video") {
            writeFileSync(expectedSplitSourcePath(workDir, "video", "mp4"), chunk(100));
            return EXIT_OK;
          }
          during.abort();
          return untilAborted(call);
        },
      }) as Parameters<typeof downloadGenericSplitSources>[3]),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED" && err.message !== "Download was cancelled.",
    );
    assert.deepEqual(t.settled(), ["failed"]);
  });

  it("the zero-exit refusal path honours an earlier stop: never re-read as a size refusal", async () => {
    const stop = new AbortController();
    await assert.rejects(
      dl(SECRET_URL, workDir, progressivePlan(), deps({
        stopForInactivity: stop.signal,
        runner: async () => {
          stop.abort();
          return { code: 0, stdout: `[download] File is larger than max-filesize (2000000000 bytes > ${LIMITS.maxFileSizeBytes} bytes). Aborting.\n`, stderr: "" };
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
  });

  it("a stop arriving after the call settled is inert: no listener survives the call", async () => {
    const stop = new AbortController();
    const result = await dl(SECRET_URL, workDir, progressivePlan(), deps({
      stopForInactivity: stop.signal,
      runner: async () => {
        writeFileSync(final(), chunk(10));
        return EXIT_OK;
      },
    }));
    assert.equal(result.fileSize, 10);
    stop.abort(); // nothing is listening any more: no throw, nothing to abort
    assert.equal(stop.signal.aborted, true);
  });
});
