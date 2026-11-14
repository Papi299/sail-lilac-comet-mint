import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, ERROR_MESSAGES } from "@/lib/errors";
import { createAcquisitionActivityTracker, type AcquisitionActivityEvent } from "@/services/downloads/acquisition-activity";
import {
  createAcquisitionInactivityWatchdog,
  type InactivityWatchdogTimerHandle,
  type InactivityWatchdogTimers,
} from "@/services/downloads/acquisition-inactivity-watchdog";
import type { RunResult } from "@/services/processing/process-runner.server.ts";
import { DOWNLOAD_TIME_LIMIT_SECONDS, UPLOAD_TIMEOUT_SECONDS } from "../runtime/time-limits.ts";
import { YTDLP_RUNTIME, ytdlpPolicyArgs } from "../runtime/ytdlp-runtime.server.ts";
import { buildGenericFormatSelector, type GenericSourceSelection } from "./generic-source.ts";
import type { GenericSingleSourceExecutionPlan, GenericSplitExecutionPlan } from "./format-plan.ts";
import {
  YTDLP_ACQUISITION_RETRY_POLICIES,
  YTDLP_DOWNLOAD_FFMPEG_LOCATION,
  buildYtdlpDownloadArgv,
  buildYtdlpSplitDownloadArgv,
  classifyDownloadFailure,
  downloadGenericOriginal,
  downloadGenericSplitSources,
  expectedPartPath,
  expectedSourcePath,
  expectedSplitPartPath,
  expectedSplitSourcePath,
  selectYtdlpAcquisitionRetryPolicy,
  ytdlpDownloadPolicyArgs,
  type GenericDownloadDeps,
} from "./ytdlp-download.server.ts";

/**
 * VIDEOFETCH-LD3D-YTDLP-RETRY-SAFEGUARDS-001 — the yt-dlp acquisition retry
 * policy and what its retries may and may not do to the Worker's bounds.
 *
 * yt-dlp retries INSIDE its subprocess. These tests never claim to prove the
 * pinned release's retry implementation (the pinned-runtime contract in
 * `ytdlp-retry-contract.server.test.ts` runs the real artifact); they prove
 * the Worker's side: which policy a call runs under, that the command carries
 * exactly that policy, and that whatever a retrying child does on disk — hold
 * the `.part`, resume it, truncate it and start again, leave fragments behind,
 * exit zero with an incomplete artifact, report its own exhaustion — cannot
 * move the deadline, earn the inactivity window, slip past the byte guard,
 * relabel an established cause, or reach processing.
 *
 * The fake child changes real files in a real job directory and waits until
 * the real monitor has sampled them; decisions are taken by a real tracker or
 * watchdog on a virtual clock, exactly as the LD-3c observation tests do.
 */

const URL_ = "https://media.example.invalid/watch?v=SECRET-RETRY-ID&sig=TOP-SECRET-TOKEN";
const WINDOW = 120_000;
const G = 65_536;
const LIMITS = { maxFileSizeBytes: 1_000_000_000, downloadTimeLimitMs: 600_000 };
const RUNTIME_OK = Object.freeze({ available: true, version: YTDLP_RUNTIME.expectedVersion, reason: "ok" as const });
const EXIT_OK: RunResult = { code: 0, stdout: "", stderr: "" };

/** The approved values, written out: the baseline (main 9390e195) and the long-download design's §4 table. */
const APPROVED = Object.freeze({
  bounded: { socketTimeoutSeconds: 10, retries: 2, fragmentRetries: 1, extractorRetries: 1 },
  watched: { socketTimeoutSeconds: 30, retries: 20, fragmentRetries: 3, extractorRetries: 1 },
});
/** LONG-DOWNLOAD-PROGRESS-AND-INACTIVITY-DESIGN.md §4: the window is 120 s, configurable 60–900 s. */
const DESIGN_WINDOW_MS = 120_000;
const DESIGN_WINDOW_MIN_MS = 60_000;

let workDir = "";
let eventLoopHold: ReturnType<typeof setTimeout> | null = null;
const childAssertions: unknown[] = [];

beforeEach(() => {
  childAssertions.length = 0;
  eventLoopHold = setTimeout(() => {}, 60_000);
  workDir = mkdtempSync(join(tmpdir(), "ld3d-retry-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (eventLoopHold !== null) clearTimeout(eventLoopHold);
  eventLoopHold = null;
});

// ── Helpers (the LD-3c observation tests' shapes) ────────────────────────────

const chunk = (size: number, fill = 0xab) => Buffer.alloc(size, fill);

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 10_000) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

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
  };
}

/**
 * A real watchdog on a virtual clock whose decisions reach the seam through
 * the two stops, as the executor wires them (`newAcquisitionInactivityWatch`).
 */
function watchedWithStops() {
  const vt = virtualTime();
  const decisions: string[] = [];
  const inactivity = new AbortController();
  const observation = new AbortController();
  const watchdog = createAcquisitionInactivityWatchdog({
    policy: { windowMs: WINDOW },
    clock: vt.clock,
    timers: vt.timers,
    onStall: () => {
      decisions.push("inactivity");
      inactivity.abort();
    },
    onObservationLost: () => {
      decisions.push("observation-lost");
      observation.abort();
    },
  });
  return {
    vt,
    watchdog,
    decisions,
    stops: { stopForInactivity: inactivity.signal, stopForObservationLoss: observation.signal },
    sink: (event: AcquisitionActivityEvent) => watchdog.record(event),
  };
}

type BoardState = number | null | { readonly throws: string };

/** An injected `statSize` set path by path (a size, `null` = absent, a coded throw); calls are counted per path. */
function board() {
  const states = new Map<string, BoardState>();
  const calls = new Map<string, number>();
  return {
    set: (path: string, state: BoardState) => states.set(path, state),
    calls: (path: string) => calls.get(path) ?? 0,
    statSize: async (path: string): Promise<number | null> => {
      calls.set(path, (calls.get(path) ?? 0) + 1);
      const state = states.get(path) ?? null;
      if (state === null || typeof state === "number") return state;
      throw Object.assign(new Error(`synthetic ${state.throws} at /private/SECRET-PATH`), { code: state.throws });
    },
  };
}

/** Waits until the monitor has STARTED `samples` more observations of `path` (samples never overlap). */
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

const HTTPS_VIDEO: GenericSourceSelection = {
  formatId: "137",
  protocol: "https",
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
const DASH_VIDEO: GenericSourceSelection = { ...HTTPS_VIDEO, formatId: "dash-v", protocol: "http_dash_segments" };
const DASH_AUDIO: GenericSourceSelection = { ...HTTPS_AUDIO, formatId: "dash-a", protocol: "http_dash_segments" };

function splitPlan(video: GenericSourceSelection = HTTPS_VIDEO, audio: GenericSourceSelection = HTTPS_AUDIO): GenericSplitExecutionPlan {
  return { strategy: "yt-dlp", operation: "merge-split", requestedFormatId: "preset:1080", pair: { video, audio }, targetContainer: "mp4" };
}

type Call = { readonly args: readonly string[]; readonly timeoutMs: number; readonly signal?: AbortSignal };

function deps(overrides: Partial<GenericDownloadDeps> & { runner: unknown }): GenericDownloadDeps {
  const child = overrides.runner as (call: Call) => Promise<RunResult>;
  return {
    limits: LIMITS,
    probeRuntime: async () => RUNTIME_OK,
    validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
    sizePollMs: 1,
    ...overrides,
    runner: async (call: Call) => {
      try {
        return await child(call);
      } catch (err: unknown) {
        if (err instanceof assert.AssertionError) childAssertions.push(err);
        throw err;
      }
    },
  } as GenericDownloadDeps;
}

function surface<T>(operation: Promise<T>): Promise<T> {
  return operation.catch((err: unknown) => {
    throw childAssertions.shift() ?? err;
  });
}
const dl = (...args: Parameters<typeof downloadGenericOriginal>) => surface(downloadGenericOriginal(...args));
const dlSplit = (...args: Parameters<typeof downloadGenericSplitSources>) => surface(downloadGenericSplitSources(...args));

const roleOf = (call: Call): "video" | "audio" => (call.args.some((a) => a.includes("audio-source")) ? "audio" : "video");
const retryArgsOf = (args: readonly string[]) => args.filter((a) => /^--(socket-timeout|retries|fragment-retries|extractor-retries)=/.test(a));
const BOUNDED_ARGS = ["--socket-timeout=10", "--retries=2", "--fragment-retries=1", "--extractor-retries=1"];
const WATCHED_ARGS = ["--socket-timeout=30", "--retries=20", "--fragment-retries=3", "--extractor-retries=1"];

/** A fake child that holds until the operation's own signal aborts, then rejects as the real runner does. Bounded (5 s). */
const untilAborted = (call: Call, boundMs = 5_000) =>
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

/** Never-aborting stops: the shape the executor supplies with an armed watchdog. */
const idleStops = () => ({ stopForInactivity: new AbortController().signal, stopForObservationLoss: new AbortController().signal });

/** A successful single-source child: writes the final artifact and exits 0, recording what it was given. */
function finishingChild(seen: Call[], bytes = 1_000) {
  return async (call: Call) => {
    seen.push(call);
    writeFileSync(expectedSourcePath(workDir, "mp4"), chunk(bytes));
    return EXIT_OK;
  };
}

/** A successful split child: each half writes its own final artifact. */
function finishingSplitChild(seen: Call[]) {
  return async (call: Call) => {
    seen.push(call);
    const role = roleOf(call);
    writeFileSync(expectedSplitSourcePath(workDir, role, role === "video" ? "mp4" : "m4a"), chunk(role === "video" ? 2_000 : 500));
    return EXIT_OK;
  };
}

// ── P: the policy table ──────────────────────────────────────────────────────

describe("P: the closed yt-dlp retry policy table", () => {
  it("P1: exactly two frozen policies: the unchanged baseline and the approved long-download values", () => {
    assert.deepEqual(Object.keys(YTDLP_ACQUISITION_RETRY_POLICIES).sort(), ["bounded", "watched"]);
    assert.deepEqual({ ...YTDLP_ACQUISITION_RETRY_POLICIES.bounded }, APPROVED.bounded);
    assert.deepEqual({ ...YTDLP_ACQUISITION_RETRY_POLICIES.watched }, APPROVED.watched);
    assert.equal(Object.isFrozen(YTDLP_ACQUISITION_RETRY_POLICIES), true);
    assert.equal(Object.isFrozen(YTDLP_ACQUISITION_RETRY_POLICIES.bounded), true);
    assert.equal(Object.isFrozen(YTDLP_ACQUISITION_RETRY_POLICIES.watched), true);
  });

  it("P2: every count is a finite positive safe integer, and none exceeds the approved long-download bound", () => {
    for (const [name, policy] of Object.entries(YTDLP_ACQUISITION_RETRY_POLICIES)) {
      for (const [key, value] of Object.entries(policy)) {
        assert.equal(Number.isSafeInteger(value) && value >= 1, true, `${name}.${key} must be a finite positive integer`);
        assert.equal(value <= APPROVED.watched[key as keyof typeof APPROVED.watched], true, `${name}.${key} exceeds the approved bound`);
      }
    }
  });

  it("P3: why the larger budget needs a watchdog: `bounded` gives up before any allowed window; under `watched` the window decides and the deadline still bounds yt-dlp", () => {
    const silenceMs = (p: { retries: number; socketTimeoutSeconds: number }) => (p.retries + 1) * p.socketTimeoutSeconds * 1_000;
    const { bounded, watched } = YTDLP_ACQUISITION_RETRY_POLICIES;
    assert.equal(silenceMs(bounded) < DESIGN_WINDOW_MIN_MS, true, "bounded: a dead source ends after 3 x 10 s, before the smallest window");
    assert.equal(watched.socketTimeoutSeconds * 1_000 < DESIGN_WINDOW_MIN_MS, true, "watched: one silent attempt never outlasts the smallest window");
    assert.equal(3 * watched.socketTimeoutSeconds * 1_000 < DESIGN_WINDOW_MS, true, "watched: three silent reconnects fit inside the design window");
    assert.equal(silenceMs(watched) >= DOWNLOAD_TIME_LIMIT_SECONDS.default * 1_000, true,
      "watched: yt-dlp's own silence budget (21 x 30 s) never ends a dead source before the 600 s deadline");
  });

  it("P4: the selector: `watched` only with BOTH of a watchdog's stops; anything less is `bounded`", () => {
    const a = new AbortController().signal;
    const b = new AbortController().signal;
    assert.equal(selectYtdlpAcquisitionRetryPolicy({}), "bounded");
    assert.equal(selectYtdlpAcquisitionRetryPolicy({ stopForInactivity: a }), "bounded");
    assert.equal(selectYtdlpAcquisitionRetryPolicy({ stopForObservationLoss: b }), "bounded");
    assert.equal(selectYtdlpAcquisitionRetryPolicy({ stopForInactivity: a, stopForObservationLoss: b }), "watched");
  });
});

// ── A: the command under each policy ─────────────────────────────────────────

describe("A: the acquisition command carries exactly one policy", () => {
  const WORK = "/srv/videofetch/media/workspace/jobs/0123456789abcdef0123456789abcdef";
  const MAX = 524_288_000;
  const build = (retryPolicy?: "bounded" | "watched") =>
    buildYtdlpDownloadArgv({ validatedUrl: URL_, workDir: WORK, plan: progressivePlan(), maxFileSizeBytes: MAX, ...(retryPolicy ? { retryPolicy } : {}) });

  it("A1: with no policy named, the command is byte for byte the one main 9390e195 builds", () => {
    assert.deepEqual([...build()], [
      YTDLP_RUNTIME.artifactPath,
      ...ytdlpPolicyArgs(),
      "--no-cache-dir",
      "--no-quiet",
      "--no-progress",
      "--no-warnings",
      "--socket-timeout=10",
      "--retries=2",
      "--fragment-retries=1",
      "--extractor-retries=1",
      `--ffmpeg-location=${YTDLP_DOWNLOAD_FFMPEG_LOCATION}`,
      "--fixup=never",
      `--max-filesize=${MAX}`,
      "--concurrent-fragments=1",
      "--no-keep-fragments",
      "--abort-on-unavailable-fragments",
      "--no-mtime",
      "--no-overwrites",
      `--format=${buildGenericFormatSelector(progressivePlan().source)}`,
      `--output=${WORK}/source.%(ext)s`,
      "--",
      URL_,
    ]);
    assert.deepEqual(build("bounded"), build());
  });

  it("A2: under `watched` exactly three elements change — the socket timeout, the retries and the fragment retries", () => {
    const bounded = build("bounded");
    const watched = build("watched");
    assert.equal(watched.length, bounded.length);
    const changed = bounded.flatMap((arg, i) => (arg === watched[i] ? [] : [[arg, watched[i]]]));
    assert.deepEqual(changed, [
      ["--socket-timeout=10", "--socket-timeout=30"],
      ["--retries=2", "--retries=20"],
      ["--fragment-retries=1", "--fragment-retries=3"],
    ]);
    assert.deepEqual(retryArgsOf(watched), WATCHED_ARGS);
  });

  it("A3: each retry option appears once, never `infinite`; no other retry, sleep, resume or skip option is ever passed", () => {
    const forbidden = [
      "--retry-sleep", "--file-access-retries", "--http-chunk-size", "--throttled-rate", "--sleep-interval", "--min-sleep-interval",
      "--max-sleep-interval", "--sleep-requests", "--sleep-subtitles", "--no-continue", "--no-part", "--skip-unavailable-fragments",
      "--no-abort-on-unavailable-fragments", "--keep-fragments", "--wait-for-video", "--load-info-json", "--limit-rate", "--rate-limit", "-R", "-r",
    ];
    for (const policy of ["bounded", "watched"] as const) {
      const argv = build(policy);
      for (const flag of ["--socket-timeout", "--retries", "--fragment-retries", "--extractor-retries"]) {
        assert.equal(argv.filter((a) => a === flag || a.startsWith(`${flag}=`)).length, 1, `${policy}: ${flag} once`);
      }
      for (const flag of forbidden) {
        assert.equal(argv.some((a) => a === flag || a.startsWith(`${flag}=`)), false, `${policy}: ${flag} must be absent`);
      }
      assert.equal(argv.some((a) => /=(inf|infinite)$/i.test(a)), false, `${policy}: no unbounded count`);
    }
  });

  it("A4: a policy name outside the closed table is refused before any command exists", () => {
    assert.throws(
      () => ytdlpDownloadPolicyArgs({ formatSelector: "b", outputTemplate: "/x/source.%(ext)s", maxFileSizeBytes: 1, retryPolicy: "aggressive" as never }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );
  });

  it("A5: both halves of a split pair are built under the policy they are given, and only it", () => {
    for (const policy of ["bounded", "watched"] as const) {
      for (const role of ["video", "audio"] as const) {
        const argv = buildYtdlpSplitDownloadArgv({ validatedUrl: URL_, workDir: WORK, plan: splitPlan(), role, maxFileSizeBytes: MAX, retryPolicy: policy });
        assert.deepEqual(retryArgsOf(argv), policy === "watched" ? WATCHED_ARGS : BOUNDED_ARGS, `${policy}/${role}`);
      }
    }
  });

  it("A6: the closed base policy (shared with the runtime probe) carries no retry option at all", () => {
    assert.deepEqual(retryArgsOf(ytdlpPolicyArgs()), []);
  });
});

// ── S: the seam runs each call under its selected policy ─────────────────────

describe("S: the seam chooses the policy from the watchdog's presence, once per call", () => {
  it("S1: no stops — Production's case — spawns the `bounded` command", async () => {
    const seen: Call[] = [];
    await dl(URL_, workDir, progressivePlan(), deps({ runner: finishingChild(seen) }));
    assert.equal(seen.length, 1);
    assert.deepEqual(retryArgsOf(seen[0]!.args), BOUNDED_ARGS);
  });

  it("S2: both stops of an attached watchdog spawn the `watched` command", async () => {
    const seen: Call[] = [];
    await dl(URL_, workDir, progressivePlan(), deps({ runner: finishingChild(seen), ...idleStops() }));
    assert.deepEqual(retryArgsOf(seen[0]!.args), WATCHED_ARGS);
  });

  it("S3: only one stop is not a watchdog: `bounded`, fail-closed", async () => {
    for (const partial of [{ stopForInactivity: new AbortController().signal }, { stopForObservationLoss: new AbortController().signal }]) {
      const seen: Call[] = [];
      rmSync(expectedSourcePath(workDir, "mp4"), { force: true });
      await dl(URL_, workDir, progressivePlan(), deps({ runner: finishingChild(seen), ...partial }));
      assert.deepEqual(retryArgsOf(seen[0]!.args), BOUNDED_ARGS);
    }
  });

  it("S4: a split pair runs BOTH halves under the call's one policy", async () => {
    for (const stops of [{}, idleStops()]) {
      const seen: Call[] = [];
      for (const name of readdirSync(workDir)) rmSync(join(workDir, name), { force: true });
      await dlSplit(URL_, workDir, splitPlan(), deps({ runner: finishingSplitChild(seen), ...stops }));
      assert.deepEqual(seen.map(roleOf), ["video", "audio"]);
      const expected = "stopForInactivity" in stops ? WATCHED_ARGS : BOUNDED_ARGS;
      for (const call of seen) assert.deepEqual(retryArgsOf(call.args), expected, roleOf(call));
    }
  });
});

// ── R: whatever a retrying child does, the Worker's bounds hold ──────────────

describe("R: retries inside the subprocess never reach past the Worker's bounds", () => {
  const part = () => expectedPartPath(workDir, "mp4");
  const final = () => expectedSourcePath(workDir, "mp4");

  it("R1: under `watched`, the WATCHDOG ends a source that stopped growing while yt-dlp reconnects — at the window, long before yt-dlp's own budget", async () => {
    const w = watchedWithStops();
    const b = board();
    let argv: readonly string[] = [];
    let runnerSignal: AbortSignal | undefined;
    await assert.rejects(
      dl(URL_, workDir, progressivePlan(), deps({
        activity: w.sink,
        statSize: b.statSize,
        ...w.stops,
        runner: async (call: Call) => {
          argv = call.args;
          runnerSignal = call.signal;
          b.set(part(), 4 * G); // bytes arrived, then the source fell silent: yt-dlp keeps the .part while it reconnects
          await samplesOf(b, part());
          w.vt.advance(WINDOW - 1_000); // three 30 s reconnects fit in here; the same size every sample
          await samplesOf(b, part());
          assert.deepEqual(w.decisions, [], "still inside the window");
          w.vt.advance(2_000);
          assert.deepEqual(w.decisions, ["inactivity"], "the window passed with no meaningful growth");
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.deepEqual(retryArgsOf(argv), WATCHED_ARGS, "the run was under the larger budget");
    assert.equal(runnerSignal?.aborted, true, "the child's own signal was aborted");
  });

  it("R2: a reconnect that keeps the .part's bytes earns nothing; a resumed transfer earns the window only with 64 KiB of NEW bytes", async () => {
    const w = watchedWithStops();
    const b = board();
    await dl(URL_, workDir, progressivePlan(), deps({
      activity: w.sink,
      statSize: b.statSize,
      ...w.stops,
      runner: async () => {
        b.set(part(), 4 * G);
        await samplesOf(b, part());
        const anchor = w.watchdog.report().honouredAnchorAtMs;
        w.vt.advance(40_000);
        await samplesOf(b, part(), 4); // reconnecting: identical readings
        assert.equal(w.watchdog.report().honouredAnchorAtMs, anchor, "identical readings move nothing");
        b.set(part(), 5 * G - 1); // resumed, one byte short of the floor
        await samplesOf(b, part());
        assert.equal(w.watchdog.report().honouredAnchorAtMs, anchor, "below the floor is not meaningful");
        w.vt.advance(1_000);
        b.set(part(), 5 * G); // the floor reached by new bytes
        await samplesOf(b, part());
        assert.equal(w.watchdog.report().honouredAnchorAtMs, w.vt.now(), "new bytes past the floor are progress");
        b.set(part(), null);
        writeFileSync(final(), chunk(5 * G));
        b.set(final(), 5 * G);
        await samplesOf(b, part());
        return EXIT_OK;
      },
    }));
    assert.deepEqual(w.decisions, []);
  });

  it("R3: a restart from zero (a server ignoring Range) is never counted twice: the guard and progress read the file, so a re-sent file inside the allowance completes", async () => {
    const t = tracked();
    const downloaded: number[] = [];
    const LIMIT = 300_000;
    let runnerSignal: AbortSignal | undefined;
    const res = await dl(URL_, workDir, progressivePlan(), deps({
      limits: { ...LIMITS, maxFileSizeBytes: LIMIT },
      activity: t.sink,
      onProgress: (p) => {
        if (p.downloadedBytes !== null) downloaded.push(p.downloadedBytes);
      },
      runner: async (call: Call) => {
        runnerSignal = call.signal;
        appendFileSync(part(), chunk(200_000));
        await waitUntil(() => t.totals().includes(200_000), "the first attempt's bytes");
        writeFileSync(part(), chunk(50_000, 0xcd)); // yt-dlp reopens the .part with `wb`: truncated, then re-sent
        await waitUntil(() => t.totals().filter((n) => n === 50_000).length >= 3, "three low readings");
        appendFileSync(part(), chunk(200_000, 0xcd));
        await waitUntil(() => t.totals().includes(250_000), "the re-sent file");
        renameSync(part(), final());
        return EXIT_OK;
      },
    }));
    assert.equal(res.fileSize, 250_000, "the artifact is the re-sent file");
    // The truncation may be sampled at 0 or at 50,000 bytes: either way a confirmed discard of the first attempt's bytes.
    const discarded = t.tracker.snapshot().discardedBytes;
    assert.equal(discarded >= 150_000 && discarded <= 200_000, true, `the restart was a confirmed discard (${discarded} B)`);
    assert.equal(Math.max(...downloaded) <= 250_000, true, "progress never counted a byte twice");
    // The guard reads the same file: had it counted the re-sent bytes again (400,000 > 300,000) it would have aborted the child — which a
    // fake child exiting 0 regardless would hide from every assertion above.
    assert.equal(runnerSignal?.aborted, false, "the guard never fired: no byte was counted twice");
  });

  it("R4: yt-dlp's own retry exhaustion is the child's failure — settled `failed`, never `deadline-exceeded`; the runner's deadline is the only `deadline-exceeded`", async () => {
    const exhausted = tracked();
    await assert.rejects(
      dl(URL_, workDir, progressivePlan(), deps({
        activity: exhausted.sink,
        runner: async () => ({ code: 1, stdout: "", stderr: `ERROR: \r[download] Got error: timed out. Giving up after 2 retries\n` }),
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.deepEqual(exhausted.settled(), ["failed"]);

    const deadline = tracked();
    await assert.rejects(
      dl(URL_, workDir, progressivePlan(), deps({ activity: deadline.sink, runner: async () => Promise.reject(new AppError("TIMEOUT")) })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.deepEqual(deadline.settled(), ["deadline-exceeded"]);
  });

  it("R5: a retry's stderr never reaches the error: the message is the canonical one for its code", async () => {
    const stderr = `ERROR: \r[download] Got error: HTTP Error 503: Service Unavailable. Giving up after 2 retries\nhttps://media.example.invalid/SECRET-PATH?sig=TOP-SECRET-TOKEN\n`;
    await assert.rejects(
      dl(URL_, workDir, progressivePlan(), deps({ runner: async () => ({ code: 1, stdout: "", stderr }) })),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.message, ERROR_MESSAGES[err.code]);
        for (const needle of ["SECRET", "Giving up", "503", "media.example"]) assert.equal(err.message.includes(needle), false, needle);
        return true;
      },
    );
  });

  it("R6: split — the audio half runs on what the retrying video half LEFT of the one deadline, never a fresh budget", async () => {
    let now = 1_000_000;
    const budgets: Record<string, number> = {};
    await dlSplit(URL_, workDir, splitPlan(), deps({
      clock: () => now,
      runner: async (call: Call) => {
        const role = roleOf(call);
        budgets[role] = call.timeoutMs;
        if (role === "video") now += 450_000; // the video half spent 450 s in transfers and retries
        writeFileSync(expectedSplitSourcePath(workDir, role, role === "video" ? "mp4" : "m4a"), chunk(100));
        return EXIT_OK;
      },
    }));
    assert.equal(budgets.video, 600_000);
    assert.equal(budgets.audio, 150_000);
  });

  it("R12: the single child's budget is what the probe LEFT of the one deadline — a retrying child never gets a fresh budget", async () => {
    let now = 2_000_000;
    const seen: Call[] = [];
    await dl(URL_, workDir, progressivePlan(), deps({
      clock: () => now,
      probeRuntime: async () => {
        now += 100_000; // the runtime probe spent 100 s of the acquisition's one deadline
        return RUNTIME_OK;
      },
      runner: finishingChild(seen),
    }));
    assert.equal(seen[0]!.timeoutMs, 500_000);
  });

  it("R7: split — when retries spent the whole deadline, no audio attempt starts: TIMEOUT", async () => {
    let now = 1_000_000;
    const roles: string[] = [];
    const t = tracked();
    await assert.rejects(
      dlSplit(URL_, workDir, splitPlan(), deps({
        clock: () => now,
        activity: t.sink,
        runner: async (call: Call) => {
          roles.push(roleOf(call));
          now += 600_000; // the video run ended exactly at the deadline (yt-dlp finished its last retry)
          writeFileSync(expectedSplitSourcePath(workDir, "video", "mp4"), chunk(100));
          return EXIT_OK;
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.deepEqual(roles, ["video"], "no audio child was spawned after the deadline");
  });

  it("R8: split — a cancellation while the video half waits to retry reaches it, and no audio attempt starts after it", async () => {
    const caller = new AbortController();
    const roles: string[] = [];
    await assert.rejects(
      dlSplit(URL_, workDir, splitPlan(), deps({
        signal: caller.signal,
        runner: async (call: Call) => {
          roles.push(roleOf(call));
          caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED" && err.message === "Download was cancelled.",
    );
    assert.deepEqual(roles, ["video"]);
  });

  it("R8b: split — a cancellation landing as the video half completes: no audio attempt starts after it", async () => {
    const caller = new AbortController();
    const roles: string[] = [];
    await assert.rejects(
      dlSplit(URL_, workDir, splitPlan(), deps({
        signal: caller.signal,
        runner: async (call: Call) => {
          const role = roleOf(call);
          roles.push(role);
          writeFileSync(expectedSplitSourcePath(workDir, role, role === "video" ? "mp4" : "m4a"), chunk(100));
          if (role === "video") caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled")); // yt-dlp's last retry just succeeded
          return EXIT_OK;
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED" && err.message === "Download was cancelled.",
    );
    assert.deepEqual(roles, ["video"], "no audio child after the cancellation");
  });

  it("R9: a resumed transfer that grows past the allowance is stopped WHILE it runs: TOO_LARGE, and a later cancellation or stop changes nothing", async () => {
    const t = tracked();
    const caller = new AbortController();
    const stops = { stopForInactivity: new AbortController(), stopForObservationLoss: new AbortController() };
    let runnerSignal: AbortSignal | undefined;
    await assert.rejects(
      dl(URL_, workDir, progressivePlan(), deps({
        limits: { ...LIMITS, maxFileSizeBytes: 100_000 },
        activity: t.sink,
        signal: caller.signal,
        stopForInactivity: stops.stopForInactivity.signal,
        stopForObservationLoss: stops.stopForObservationLoss.signal,
        runner: async (call: Call) => {
          runnerSignal = call.signal;
          appendFileSync(part(), chunk(60_000)); // the first attempt
          await waitUntil(() => t.totals().includes(60_000), "the first attempt's bytes");
          appendFileSync(part(), chunk(60_000)); // resumed with Range: past the allowance
          await waitUntil(() => call.signal?.aborted === true, "the guard's abort");
          caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
          stops.stopForInactivity.abort();
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
    assert.equal(runnerSignal?.aborted, true);
    assert.deepEqual(t.settled(), ["failed"]);
  });

  it("R10: an empty .part (a response's headers, no body) is not progress: the window runs from the phase's start", async () => {
    const w = watchedWithStops();
    const b = board();
    await assert.rejects(
      dl(URL_, workDir, progressivePlan(), deps({
        activity: w.sink,
        statSize: b.statSize,
        ...w.stops,
        runner: async (call: Call) => {
          b.set(part(), 0);
          await samplesOf(b, part(), 3);
          w.vt.advance(WINDOW - 1);
          await samplesOf(b, part());
          assert.deepEqual(w.decisions, [], "one millisecond before the window");
          w.vt.advance(1_001);
          assert.deepEqual(w.decisions, ["inactivity"], "a zero-byte file earned nothing");
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
  });

  it("R11: files unreadable while yt-dlp retries are an observation loss under `watched`: PROCESSING_FAILED, never TIMEOUT", async () => {
    const w = watchedWithStops();
    const b = board();
    await assert.rejects(
      dl(URL_, workDir, progressivePlan(), deps({
        activity: w.sink,
        statSize: b.statSize,
        ...w.stops,
        runner: async (call: Call) => {
          b.set(part(), 4 * G);
          await samplesOf(b, part());
          b.set(part(), { throws: "EIO" });
          b.set(final(), { throws: "EIO" });
          await samplesOf(b, part(), 4);
          w.vt.advance(WINDOW + 2_000);
          await samplesOf(b, part());
          w.vt.advance(2_000);
          assert.deepEqual(w.decisions, ["observation-lost"]);
          return untilAborted(call);
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED" && err.message !== "Download was cancelled.",
    );
  });
});

// ── F: an exhausted or abandoned retry never becomes an artifact ─────────────

describe("F: a retry's leftovers never pass as a download", () => {
  it("F1: a fragment yt-dlp could not fetch ends the run (non-zero exit): failed, nothing returned", async () => {
    const t = tracked();
    await assert.rejects(
      dlSplit(URL_, workDir, splitPlan(DASH_VIDEO), deps({
        activity: t.sink,
        runner: async () => ({ code: 1, stdout: "", stderr: "ERROR: fragment 3 not found, unable to continue\n" }),
      })),
      (err: unknown) => err instanceof AppError && err.code === "EXTRACTION_FAILED",
    );
    assert.deepEqual(t.settled(), ["failed"]);
  });

  it("F2: a zero exit that left a fragment, a fragment .part, the bookkeeping file or a .part beside the artifact is refused: PROCESSING_FAILED", async () => {
    // Left by the LAST child (the audio half), so nothing after it could notice: only that run's own exact-directory proof can.
    const leftovers: Array<[string, () => void]> = [
      ["a completed fragment", () => writeFileSync(join(workDir, "audio-source.m4a.part-Frag3"), chunk(10))],
      ["a fragment in flight", () => writeFileSync(join(workDir, "audio-source.m4a.part-Frag3.part"), chunk(10))],
      ["the bookkeeping file", () => writeFileSync(join(workDir, "audio-source.m4a.ytdl"), "{}")],
      ["the aggregate .part", () => writeFileSync(join(workDir, "audio-source.m4a.part"), chunk(10))],
    ];
    for (const [label, leave] of leftovers) {
      for (const name of readdirSync(workDir)) rmSync(join(workDir, name), { force: true });
      await assert.rejects(
        dlSplit(URL_, workDir, splitPlan(DASH_VIDEO, DASH_AUDIO), deps({
          runner: async (call: Call) => {
            const role = roleOf(call);
            writeFileSync(expectedSplitSourcePath(workDir, role, role === "video" ? "mp4" : "m4a"), chunk(500));
            if (role === "audio") leave();
            return EXIT_OK;
          },
        })),
        (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
        label,
      );
    }
    for (const [label, leave] of [
      ["only the .part (an incomplete transfer reported as a zero exit)", () => writeFileSync(expectedPartPath(workDir, "mp4"), chunk(500))],
      ["the artifact and a stray .part", () => {
        writeFileSync(expectedSourcePath(workDir, "mp4"), chunk(500));
        writeFileSync(expectedPartPath(workDir, "mp4"), chunk(10));
      }],
    ] as Array<[string, () => void]>) {
      for (const name of readdirSync(workDir)) rmSync(join(workDir, name), { force: true });
      await assert.rejects(
        dl(URL_, workDir, progressivePlan(), deps({
          runner: async () => {
            leave();
            return EXIT_OK;
          },
        })),
        (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
        label,
      );
    }
  });

  it("F3: residue where the audio half would resume is refused BEFORE the audio child exists: a retry never splices untrusted bytes", async () => {
    const roles: string[] = [];
    let planted = false;
    await assert.rejects(
      dlSplit(URL_, workDir, splitPlan(), deps({
        // The residue appears only AFTER the video half's own exact-directory
        // proof has passed, so what refuses it is the audio half's check
        // before its child exists — never the video half's.
        readDir: async (path: string) => {
          const names = readdirSync(path);
          if (!planted && names.length === 1 && names[0] === "video-source.mp4") {
            planted = true;
            writeFileSync(expectedSplitPartPath(workDir, "audio", "m4a"), chunk(123, 0x5a));
          }
          return names;
        },
        runner: async (call: Call) => {
          roles.push(roleOf(call));
          writeFileSync(expectedSplitSourcePath(workDir, roleOf(call), roleOf(call) === "video" ? "mp4" : "m4a"), chunk(500));
          return EXIT_OK;
        },
      })),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );
    assert.equal(planted, true, "the residue was planted between the halves");
    assert.deepEqual(roles, ["video"], "no audio child was spawned to resume it");
    assert.equal(existsSync(expectedSplitSourcePath(workDir, "audio", "m4a")), false);
    assert.equal(readFileSync(expectedSplitPartPath(workDir, "audio", "m4a")).length, 123, "nothing was deleted and continued past");
  });

  it("F4: a single source refuses residue before its child exists — a stale .part (which yt-dlp would resume) or a stale final file (which it would call downloaded)", async () => {
    const residues: Array<[string, () => void]> = [
      ["a stale .part", () => writeFileSync(expectedPartPath(workDir, "mp4"), chunk(1_000, 0x5a))],
      ["a stale final file", () => writeFileSync(expectedSourcePath(workDir, "mp4"), chunk(1_000, 0x5a))],
      ["an unexpected file", () => writeFileSync(join(workDir, "other.bin"), chunk(10))],
    ];
    for (const [label, leave] of residues) {
      for (const name of readdirSync(workDir)) rmSync(join(workDir, name), { force: true });
      leave();
      const before = readdirSync(workDir).sort();
      const spawned: Call[] = [];
      await assert.rejects(
        dl(URL_, workDir, progressivePlan(), deps({ runner: finishingChild(spawned) })),
        (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED" && err.message === ERROR_MESSAGES.PROCESSING_FAILED,
        label,
      );
      assert.equal(spawned.length, 0, `${label}: no child was spawned`);
      assert.deepEqual(readdirSync(workDir).sort(), before, `${label}: nothing was deleted and continued past`);
    }
  });
});

// ── C: an exhausted retry is classified by its last error ─────────────────────

describe("C: retry exhaustion keeps the closed codes, classified by the LAST error (pinned stderr lines, real runs)", () => {
  // Each line is the stderr a real run of the pinned 2026.08.19 artifact printed
  // (E-pinned-runtime-audit-1.json), `\r` included as the release writes it.
  const table: Array<[string, string, string]> = [
    ["progressive 503 x3", "ERROR: \r[download] Got error: HTTP Error 503: Service Unavailable. Giving up after 2 retries\n", "NETWORK_ERROR"],
    ["progressive 504 x3 (not TIMEOUT for its reason phrase)", "ERROR: \r[download] Got error: HTTP Error 504: Gateway Timeout. Giving up after 2 retries\n", "NETWORK_ERROR"],
    ["connection cut short x3", "ERROR: \r[download] Got error: Downloaded 12288 bytes, expected 655360 bytes. Giving up after 2 retries\n", "NETWORK_ERROR"],
    ["chunked body cut short x3", "ERROR: \r[download] Got error: 4096 bytes read, 8192 more expected. Giving up after 2 retries\n", "NETWORK_ERROR"],
    ["fragment 503 x3, then aborted", "ERROR: \r[download] Got error: HTTP Error 503: Service Unavailable. Giving up after 2 retries\nERROR: fragment 3 not found, unable to continue\n", "NETWORK_ERROR"],
    ["silence x3: yt-dlp's own budget ran out", "ERROR: \r[download] Got error: timed out. Giving up after 2 retries\n", "TIMEOUT"],
    ["fragment 404 x2, then aborted (unchanged)", "ERROR: \r[download] Got error: HTTP Error 404: Not Found. Giving up after 1 retries\nERROR: fragment 3 not found, unable to continue\n", "EXTRACTION_FAILED"],
    ["progressive 404, never retried (unchanged)", "ERROR: unable to download video data: HTTP Error 404: Not Found\n", "NETWORK_ERROR"],
    ["416 on a resume (unchanged)", "ERROR: unable to download video data: HTTP Error 416: Range Not Satisfiable\n", "NETWORK_ERROR"],
    ["reset x3 (unchanged)", "ERROR: \r[download] Got error: [Errno 54] Connection reset by peer. Giving up after 2 retries\n", "NETWORK_ERROR"],
  ];
  for (const [label, stderr, code] of table) {
    it(`${code}: ${label}`, () => {
      assert.equal(classifyDownloadFailure(stderr), code);
    });
  }

  it("the rule is the exhaustion line's own: the same texts NOT in that line keep their earlier codes", () => {
    // A 5xx or short read reported without the exhaustion line falls through to the existing rules.
    assert.equal(classifyDownloadFailure("ERROR: [download] Got error: HTTP Error 503: Service Unavailable\n"), "EXTRACTION_FAILED");
    assert.equal(classifyDownloadFailure("ERROR: The read operation timed out\n"), "TIMEOUT");
    assert.equal(classifyDownloadFailure("ERROR: something entirely new. Giving up after 2 retries\n"), "EXTRACTION_FAILED");
    // The earlier, more specific rules still win.
    assert.equal(classifyDownloadFailure("ERROR: Private video. Sign in\n[download] Got error: HTTP Error 503: x. Giving up after 2 retries\n"), "VIDEO_UNAVAILABLE");
    assert.equal(classifyDownloadFailure("ERROR: Requested format is not available\n[download] Got error: HTTP Error 503: x. Giving up after 2 retries\n"), "FORMAT_UNAVAILABLE");
  });
});

// ── X: nothing was activated, and nothing public moved ───────────────────────

describe("X: the larger budget stays bound to a watchdog nothing in Production attaches", () => {
  const ROOT = new URL("../../../", import.meta.url);
  const source = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("X1: the composition root supplies no watchdog stop, so every Production acquisition runs `bounded`", () => {
    const runtime = source("src/worker/runtime/runtime.server.ts");
    for (const needle of ["acquisitionInactivity", "watchFilesystemObservedPlans", "stopForInactivity", "stopForObservationLoss", "retryPolicy", "YTDLP_ACQUISITION_RETRY_POLICIES"]) {
      assert.equal(runtime.includes(needle), false, needle);
    }
    // Positive control: the same reader finds the selector where it is defined.
    assert.equal(source("src/worker/execution/ytdlp-download.server.ts").includes("selectYtdlpAcquisitionRetryPolicy"), true);
  });

  it("X2: no configuration names a retry value: the policy is source-owned", () => {
    for (const file of ["src/worker/runtime/config.server.ts", "src/worker/runtime/time-limits.ts", "src/worker/runtime/runtime.server.ts", "src/lib/config.ts"]) {
      const text = code(source(file));
      for (const needle of ["RETRIES", "SOCKET_TIMEOUT", "retryPolicy", "RETRY_POLIC"]) assert.equal(text.includes(needle), false, `${file}: ${needle}`);
    }
    // Positive control: the same reader finds the policy where it is defined.
    assert.equal(code(source("src/worker/execution/ytdlp-download.server.ts")).includes("YTDLP_ACQUISITION_RETRY_POLICIES"), true);
  });

  it("X3: the acquisition default stays 600 s and the upload default 3,600 s", () => {
    assert.equal(DOWNLOAD_TIME_LIMIT_SECONDS.default, 600);
    assert.equal(UPLOAD_TIMEOUT_SECONDS.default, 3_600);
  });
});
