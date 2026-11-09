import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { setSafeHttpTestHooks } from "@/lib/security/safe-http.server.ts";
import {
  assessAcquisitionActivity,
  createAcquisitionActivityTracker,
  type AcquisitionActivityEvent,
} from "@/services/downloads/acquisition-activity";
import {
  downloadDirectOriginalWorker,
  setDirectDownloadDeadlineTimerForTests,
} from "@/services/extractors/direct.server";
import type { RunResult } from "@/services/processing/process-runner.server.ts";
import { setTempDirectoryForTests } from "@/services/temp/files.server";
import { VideoMetadataSchema } from "@/shared/worker/contracts";
import { acquireSelectedClearHlsMedia } from "../hls/hls-execution.server.ts";
import {
  ClearHlsAcquisitionError,
  acquireClearHlsFmp4,
  acquireClearHlsSeparateAudioFmp4,
  acquireClearHlsSeparateVideoFmp4,
  acquireClearHlsTs,
  type ClearHlsAcquisitionFailure,
} from "../hls/hls-fragment-acquisition.server.ts";
import type {
  ClearHlsFmp4AcquisitionPlan,
  ClearHlsMpegTsAcquisitionPlan,
} from "../hls/hls-preflight.server.ts";
import { acquireSelectedSeparateHlsMedia } from "../hls/hls-separate-audio-execution.server.ts";
import { YTDLP_RUNTIME } from "../runtime/ytdlp-runtime.server.ts";
import { applyMigrations } from "../state/migrations.server.ts";
import { SQLiteJobStore } from "../state/sqlite-job-store.server.ts";
import type { ObjectStoreWriter } from "../storage/writer.ts";
import type { GenericSourceSelection } from "./generic-source.ts";
import type { GenericSingleSourceExecutionPlan, GenericSplitExecutionPlan } from "./format-plan.ts";
import { JobExecutor, type JobExecutorDeps } from "./job-executor.server.ts";
import {
  downloadGenericOriginal,
  downloadGenericSplitSources,
  expectedPartPath,
  expectedSourcePath,
  expectedSplitSourcePath,
} from "./ytdlp-download.server.ts";

/**
 * VIDEOFETCH-LD3A-ACQUISITION-ACTIVITY-FOUNDATION-001 — the emitters, on the
 * REAL acquisition paths.
 *
 * Direct and HLS run through the synthetic safe-HTTP hooks and a throwaway
 * workDir. yt-dlp runs with only its child replaced: the fake child changes
 * real files in a real job directory and waits until the real monitor has
 * sampled each state, so nothing depends on how fast the poll happens to run.
 * The executor runs end to end against a real SQLite store.
 *
 * No real network, DNS, yt-dlp or FFmpeg. These pin WHAT is reported; the pure
 * model's tests pin what the reports mean under the 120-second / 64 KiB target.
 */

const SECRET_URL = "https://cdn.example/SECRET-PATH/video.mp4?sig=TOP-SECRET-TOKEN";
const SECRET_FRAGMENT_1 = "https://cdn.example/SECRET-PATH/seg-1.ts?sig=TOP-SECRET-TOKEN";
const SECRET_FRAGMENT_2 = "https://cdn.example/SECRET-PATH/seg-2.ts?sig=TOP-SECRET-TOKEN";
const INIT_MAP = "https://cdn.example/SECRET-PATH/init.mp4?sig=TOP-SECRET-TOKEN";

let workDir = "";
let eventLoopHold: ReturnType<typeof setTimeout> | null = null;

/**
 * Operations a test holds open. Each is aborted after the test, so a failed
 * assertion can never leave a real deadline timer keeping the process alive.
 */
const liveControllers: AbortController[] = [];
function liveController(): AbortController {
  const controller = new AbortController();
  liveControllers.push(controller);
  return controller;
}
/** A pending operation a test may abandon: its later rejection is expected. */
function abandonable<T>(operation: Promise<T>): Promise<T> {
  operation.catch(() => {});
  return operation;
}

beforeEach(() => {
  // The real monitor's and transport's timers are unref'd; a fake child holds
  // nothing, so the test itself must keep the loop alive (the Node 22 trap).
  eventLoopHold = setTimeout(() => {}, 30_000);
  workDir = mkdtempSync(join(tmpdir(), "ld3a-activity-"));
});

afterEach(() => {
  for (const controller of liveControllers.splice(0)) controller.abort();
  setSafeHttpTestHooks(null);
  setDirectDownloadDeadlineTimerForTests(null);
  rmSync(workDir, { recursive: true, force: true });
  if (eventLoopHold !== null) clearTimeout(eventLoopHold);
  eventLoopHold = null;
});

// ── Recording ────────────────────────────────────────────────────────────────

/** The closed vocabulary: every key and every string value an event may hold. */
const EVENT_KEYS: Record<AcquisitionActivityEvent["kind"], readonly string[]> = {
  "deadline-armed": ["kind", "limitMs"],
  "phase-started": ["kind", "phase"],
  bytes: ["kind", "totalBytes", "evidence"],
  "resource-boundary": ["kind"],
  "sample-gap": ["kind"],
  "phase-ended": ["kind"],
  settled: ["kind", "outcome"],
};
const CLOSED_STRINGS = new Set([
  "deadline-armed",
  "phase-started",
  "bytes",
  "resource-boundary",
  "sample-gap",
  "phase-ended",
  "settled",
  "single",
  "video",
  "audio",
  "transport",
  "filesystem",
  "completed",
  "cancelled",
  "deadline-exceeded",
  "failed",
]);

/**
 * H18: nothing but closed strings and numbers can have been reported, and no
 * URL, host, token, workDir or filename fragment survives in any of it.
 */
function assertClosedAndPrivate(events: readonly AcquisitionActivityEvent[]) {
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [...EVENT_KEYS[event.kind]].sort(), `shape of ${event.kind}`);
    for (const value of Object.values(event)) {
      if (typeof value === "string") assert.ok(CLOSED_STRINGS.has(value), `closed string: ${value}`);
      else assert.equal(typeof value, "number");
    }
  }
  const text = JSON.stringify(events);
  for (const forbidden of ["SECRET-PATH", "TOP-SECRET-TOKEN", "cdn.example", "https:", "/private", "ld3a-activity-", "video.mp4", ".part", tmpdir()]) {
    assert.equal(text.includes(forbidden), false, `must not expose ${forbidden}`);
  }
}

function recorder() {
  const events: AcquisitionActivityEvent[] = [];
  return {
    events,
    sink: (event: AcquisitionActivityEvent) => {
      events.push(event);
    },
    totals: () => events.flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : [])),
    kinds: () => events.map((e) => e.kind),
    settled: () => events.flatMap((e) => (e.kind === "settled" ? [e.outcome] : [])),
  };
}

/** A real tracker on a virtual clock, fed by the seam, with its raw events kept too. */
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
    assess: (windowMs = 120_000) =>
      assessAcquisitionActivity(tracker.snapshot(), { nowMs, windowMs }),
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > 10_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const chunk = (size: number, fill = 0xab) => Buffer.alloc(size, fill);
const concat = (...buffers: Buffer[]) => Buffer.concat(buffers);

/** One chunk per read, so each chunk is a distinct, observable transport event. */
function chunkedBody(chunks: readonly Buffer[]): Readable {
  let next = 0;
  return new Readable({
    read() {
      const piece = chunks[next];
      next += 1;
      this.push(piece === undefined ? null : piece);
    },
  });
}

/** A body the test drives by hand; it never ends until told to. */
function manualBody() {
  const stream = new Readable({
    read() {
      // Chunks arrive only when the test pushes them.
    },
  });
  return { stream, push: (data: Buffer) => stream.push(data), end: () => stream.push(null) };
}

// ── Direct ───────────────────────────────────────────────────────────────────

function serveDirect(body: Readable, headers: Record<string, string> = {}) {
  setSafeHttpTestHooks({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    requestOnce: async () => ({
      status: 200,
      headers: { "content-type": "video/mp4", ...headers },
      body,
    }),
  });
}

type MutableConfig = { maxFileSize: number };

describe("direct: real transport bytes, each chunk as it arrives", () => {
  it("reports the first byte, then every accepted chunk, with an unknown total", async () => {
    const parts = [chunk(70_000), chunk(30_000), chunk(100_000)];
    serveDirect(chunkedBody(parts)); // no Content-Length at all
    const r = recorder();
    const result = await downloadDirectOriginalWorker(SECRET_URL, {
      workDir,
      downloadTimeLimitMs: 600_000,
      activity: r.sink,
    });
    assert.deepEqual(r.totals(), [70_000, 100_000, 200_000]);
    assert.deepEqual(r.events[0], { kind: "deadline-armed", limitMs: 600_000 });
    assert.deepEqual(r.events[1], { kind: "phase-started", phase: "single" });
    assert.deepEqual(r.kinds().slice(-2), ["phase-ended", "settled"]);
    assert.deepEqual(r.settled(), ["completed"]);
    assert.equal(result.fileSize, 200_000);
    assertClosedAndPrivate(r.events);
  });

  it("a Content-Length that lies changes nothing: only real bytes are reported", async () => {
    serveDirect(chunkedBody([chunk(1000)]), { "content-length": "999999999" });
    const r = recorder();
    await downloadDirectOriginalWorker(SECRET_URL, { workDir, downloadTimeLimitMs: 600_000, activity: r.sink });
    assert.deepEqual(r.totals(), [1000]);
  });

  it("a chunk past the size ceiling is refused and never reported as progress", async () => {
    const mutable = config as MutableConfig;
    const before = mutable.maxFileSize;
    mutable.maxFileSize = 100;
    try {
      serveDirect(chunkedBody([chunk(60), chunk(60)]));
      const r = recorder();
      await assert.rejects(
        downloadDirectOriginalWorker(SECRET_URL, { workDir, downloadTimeLimitMs: 600_000, activity: r.sink }),
        (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
      );
      assert.deepEqual(r.totals(), [60], "the refused 120-byte total was never accepted");
      assert.deepEqual(r.settled(), ["failed"]);
    } finally {
      mutable.maxFileSize = before;
    }
  });

  it("a mid-transfer cancellation settles as cancelled, and nothing is reported after it", async () => {
    const body = manualBody();
    serveDirect(body.stream);
    const r = recorder();
    const controller = liveController();
    const run = abandonable(
      downloadDirectOriginalWorker(SECRET_URL, {
        workDir,
        signal: controller.signal,
        downloadTimeLimitMs: 600_000,
        activity: r.sink,
      }),
    );
    await waitUntil(() => r.kinds().includes("phase-started"), "phase");
    body.push(chunk(70_000));
    await waitUntil(() => r.totals().length === 1, "first chunk");
    controller.abort(new AppError("PROCESSING_FAILED", "Download was cancelled."));
    await assert.rejects(run);
    assert.deepEqual(r.settled(), ["cancelled"]);
    const count = r.events.length;
    body.push(chunk(70_000));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(r.events.length, count, "a late chunk after cancellation is never reported");
    assert.equal(r.kinds().includes("phase-ended"), false);
  });

  it("the absolute deadline settles as deadline-exceeded, and is armed exactly once", async () => {
    const armed: Array<() => void> = [];
    setDirectDownloadDeadlineTimerForTests({
      set: (onDeadline) => {
        armed.push(onDeadline);
        return {};
      },
      clear: () => {},
    });
    const body = manualBody();
    serveDirect(body.stream);
    const r = recorder();
    const run = downloadDirectOriginalWorker(SECRET_URL, { workDir, downloadTimeLimitMs: 123_000, activity: r.sink });
    await waitUntil(() => armed.length === 1, "deadline armed");
    armed[0]!();
    await assert.rejects(run, (err: unknown) => err instanceof AppError && err.code === "TIMEOUT");
    assert.deepEqual(r.settled(), ["deadline-exceeded"]);
    assert.equal(r.events.filter((e) => e.kind === "deadline-armed").length, 1);
    assert.deepEqual(r.events.find((e) => e.kind === "deadline-armed"), { kind: "deadline-armed", limitMs: 123_000 });
  });

  it("a sink that throws cannot corrupt the output or the result", async () => {
    const parts = [chunk(50_000, 0x11), chunk(50_000, 0x22)];
    const reference = sha256(concat(...parts));
    serveDirect(chunkedBody(parts));
    let reports = 0;
    const result = await downloadDirectOriginalWorker(SECRET_URL, {
      workDir,
      signal: liveController().signal,
      downloadTimeLimitMs: 600_000,
      activity: () => {
        reports += 1;
        throw new Error("observer failure");
      },
    });
    assert.ok(reports > 0, "the sink really was called");
    assert.equal(sha256(readFileSync(result.filePath)), reference);
    assert.equal(result.fileSize, 100_000);
  });
});

// ── Clear HLS ────────────────────────────────────────────────────────────────

function hlsTsPlan(urls: readonly string[]): ClearHlsMpegTsAcquisitionPlan {
  return Object.freeze({
    segmentType: "mpegts",
    fragments: Object.freeze(urls.map((url) => Object.freeze({ url }))),
    fragmentCount: urls.length,
  }) as ClearHlsMpegTsAcquisitionPlan;
}

function hlsFmp4Plan(init: string, urls: readonly string[]): ClearHlsFmp4AcquisitionPlan {
  return Object.freeze({
    segmentType: "fmp4",
    initializationMap: Object.freeze({ url: init }),
    fragments: Object.freeze(urls.map((url) => Object.freeze({ url }))),
    fragmentCount: urls.length,
  }) as ClearHlsFmp4AcquisitionPlan;
}

function fakeHlsNetwork(routes: Record<string, () => Readable>) {
  setSafeHttpTestHooks({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    requestOnce: async (args) => {
      const route = routes[args.url.href];
      if (route === undefined) throw new AppError("NETWORK_ERROR");
      return { status: 200, headers: {}, body: route() };
    },
  });
}

describe("clear HLS: chunk progress inside a fragment, and honest boundaries", () => {
  it("reports each chunk as it is written, long before the fragment is complete", async () => {
    const body = manualBody();
    fakeHlsNetwork({ [SECRET_FRAGMENT_1]: () => body.stream });
    const r = recorder();
    const run = abandonable(
      acquireClearHlsTs({
        plan: hlsTsPlan([SECRET_FRAGMENT_1]),
        workDir,
        signal: liveController().signal,
        timeoutMs: 600_000,
        activity: r.sink,
      }),
    );
    await waitUntil(() => r.kinds().includes("phase-started"), "phase");
    body.push(chunk(40_000));
    await waitUntil(() => r.totals().length === 1, "first chunk");
    assert.equal(r.kinds().includes("resource-boundary"), false, "the fragment has not completed");
    body.push(chunk(40_000));
    await waitUntil(() => r.totals().length === 2, "second chunk");
    assert.deepEqual(r.totals(), [40_000, 80_000]);
    body.end();
    await run;
    assert.equal(r.kinds().filter((k) => k === "resource-boundary").length, 1);
    assert.deepEqual(r.kinds().at(-1), "phase-ended");
    assertClosedAndPrivate(r.events);
  });

  it("a fragment boundary continues the same total, and is never itself progress", async () => {
    fakeHlsNetwork({
      [SECRET_FRAGMENT_1]: () => chunkedBody([chunk(10_000)]),
      [SECRET_FRAGMENT_2]: () => chunkedBody([chunk(25_000)]),
    });
    const t = tracked();
    await acquireClearHlsTs({
      plan: hlsTsPlan([SECRET_FRAGMENT_1, SECRET_FRAGMENT_2]),
      workDir,
      signal: new AbortController().signal,
      timeoutMs: 600_000,
      activity: t.sink,
    });
    const kinds = t.events.map((e) => (e.kind === "bytes" ? `bytes:${e.totalBytes}` : e.kind));
    assert.deepEqual(kinds, [
      "deadline-armed",
      "phase-started",
      "bytes:10000",
      "resource-boundary",
      "bytes:35000",
      "resource-boundary",
      "phase-ended",
    ]);
    assert.equal(t.tracker.snapshot().observedBytes, 35_000);
    assert.equal(t.tracker.snapshot().discardedBytes, 0);
  });

  it("the fMP4 initialization map is real bytes, with a boundary after it", async () => {
    fakeHlsNetwork({
      [INIT_MAP]: () => chunkedBody([chunk(100)]),
      [SECRET_FRAGMENT_1]: () => chunkedBody([chunk(1000), chunk(1000)]),
    });
    const r = recorder();
    await acquireClearHlsFmp4({
      plan: hlsFmp4Plan(INIT_MAP, [SECRET_FRAGMENT_1]),
      workDir,
      signal: new AbortController().signal,
      timeoutMs: 600_000,
      activity: r.sink,
    });
    assert.deepEqual(r.totals(), [100, 1100, 2100]);
  });

  it("a stall at a boundary is visible as a boundary, not as progress, until the next byte", async () => {
    const body = manualBody();
    fakeHlsNetwork({
      [SECRET_FRAGMENT_1]: () => chunkedBody([chunk(70_000)]),
      [SECRET_FRAGMENT_2]: () => body.stream,
    });
    const t = tracked();
    const run = abandonable(
      acquireClearHlsTs({
        plan: hlsTsPlan([SECRET_FRAGMENT_1, SECRET_FRAGMENT_2]),
        workDir,
        signal: liveController().signal,
        timeoutMs: 600_000,
        activity: t.sink,
      }),
    );
    await waitUntil(() => t.events.some((e) => e.kind === "resource-boundary"), "boundary");
    const anchor = t.tracker.snapshot().anchorAtMs;
    t.advance(120_000);
    assert.deepEqual(t.assess(), { status: "between-resources", inactivityWindowExhausted: true });
    assert.equal(t.tracker.snapshot().anchorAtMs, anchor);
    body.push(chunk(70_000));
    await waitUntil(() => t.events.filter((e) => e.kind === "bytes").length === 2, "next fragment byte");
    assert.equal(t.assess().inactivityWindowExhausted, false, "real bytes re-anchored the window");
    body.end();
    await run;
  });

  it("a chunk over the aggregate limit is refused, and only admitted bytes are reported", async () => {
    fakeHlsNetwork({ [SECRET_FRAGMENT_1]: () => chunkedBody([chunk(60), chunk(60)]) });
    const r = recorder();
    await assert.rejects(
      acquireClearHlsTs({
        plan: hlsTsPlan([SECRET_FRAGMENT_1]),
        workDir,
        signal: new AbortController().signal,
        timeoutMs: 600_000,
        maxAggregateBytes: 100,
        activity: r.sink,
      }),
      (err: unknown) => err instanceof ClearHlsAcquisitionError,
    );
    assert.deepEqual(r.totals(), [60]);
    assert.deepEqual(r.settled(), ["failed"]);
  });

  it("cancellation mid-fragment settles as cancelled and removes the partial", async () => {
    const body = manualBody();
    fakeHlsNetwork({ [SECRET_FRAGMENT_1]: () => body.stream });
    const r = recorder();
    const controller = liveController();
    const run = abandonable(
      acquireClearHlsTs({
        plan: hlsTsPlan([SECRET_FRAGMENT_1]),
        workDir,
        signal: controller.signal,
        timeoutMs: 600_000,
        activity: r.sink,
      }),
    );
    await waitUntil(() => r.kinds().includes("phase-started"), "phase");
    body.push(chunk(5000));
    await waitUntil(() => r.totals().length === 1, "first chunk");
    controller.abort();
    await assert.rejects(run);
    assert.deepEqual(r.settled(), ["cancelled"]);
    assert.deepEqual(readdirSync(workDir), []);
    const count = r.events.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(r.events.length, count);
  });

  it("the absolute deadline settles as deadline-exceeded, read from the latch", async () => {
    const body = manualBody();
    fakeHlsNetwork({ [SECRET_FRAGMENT_1]: () => body.stream });
    const r = recorder();
    await assert.rejects(
      acquireClearHlsTs({
        plan: hlsTsPlan([SECRET_FRAGMENT_1]),
        workDir,
        signal: new AbortController().signal,
        timeoutMs: 5,
        activity: r.sink,
      }),
      (err: unknown) => err instanceof ClearHlsAcquisitionError && err.reason === ("timeout" as ClearHlsAcquisitionFailure),
    );
    assert.deepEqual(r.settled(), ["deadline-exceeded"]);
  });

  it("a sink that throws cannot corrupt the aggregate", async () => {
    const parts = [chunk(30_000, 0x33), chunk(30_000, 0x44)];
    fakeHlsNetwork({ [SECRET_FRAGMENT_1]: () => chunkedBody(parts) });
    let reports = 0;
    const result = await acquireClearHlsTs({
      plan: hlsTsPlan([SECRET_FRAGMENT_1]),
      workDir,
      signal: liveController().signal,
      timeoutMs: 600_000,
      activity: () => {
        reports += 1;
        throw new Error("observer failure");
      },
    });
    assert.ok(reports > 0);
    assert.equal(sha256(readFileSync(result.filePath)), sha256(concat(...parts)));
    assert.equal(result.fileSize, 60_000);
  });

  it("a truthful-progress percentage repeating across fragments does not change the activity record", async () => {
    const run = async (onProgress?: () => void) => {
      const dir = mkdtempSync(join(tmpdir(), "ld3a-activity-"));
      try {
        fakeHlsNetwork({
          [SECRET_FRAGMENT_1]: () => chunkedBody([chunk(500)]),
          [SECRET_FRAGMENT_2]: () => chunkedBody([chunk(500)]),
        });
        const r = recorder();
        await acquireClearHlsTs({
          plan: hlsTsPlan([SECRET_FRAGMENT_1, SECRET_FRAGMENT_2]),
          workDir: dir,
          signal: new AbortController().signal,
          timeoutMs: 600_000,
          ...(onProgress ? { onProgress } : {}),
          activity: r.sink,
        });
        return r.events;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    assert.deepEqual(await run(), await run(() => {}));
  });
});

describe("clear HLS orchestration: metadata is never transfer", () => {
  it("a playlist request reports nothing; the whole acquisition settles as completed", async () => {
    fakeHlsNetwork({ [SECRET_FRAGMENT_1]: () => chunkedBody([chunk(2000)]) });
    const t = tracked();
    let eventsAtPreflight = -1;
    await acquireSelectedClearHlsMedia(
      {
        plan: { operation: "clear-hls-remux", source: { playlistUrl: "https://cdn.example/SECRET-PATH/media.m3u8" } },
        workDir,
        signal: new AbortController().signal,
        downloadTimeLimitMs: 600_000,
        activity: t.sink,
      },
      {
        preflight: async () => {
          eventsAtPreflight = t.events.length;
          return hlsTsPlan([SECRET_FRAGMENT_1]);
        },
        acquire: acquireClearHlsTs,
        acquireFmp4: acquireClearHlsFmp4,
      },
    );
    assert.equal(eventsAtPreflight, 0, "the playlist fetch is not a transfer and reports nothing");
    assert.ok(t.events.some((e) => e.kind === "phase-started" && e.phase === "single"), "the sink reached the transfer");
    assert.deepEqual(t.events.flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : [])), [2000]);
    assert.equal(t.tracker.snapshot().outcome, "completed");
    assert.deepEqual(t.events.at(-1), { kind: "settled", outcome: "completed" });
    assertClosedAndPrivate(t.events);
  });

  it("a preflight failure settles as failed, with no phase and no byte", async () => {
    const r = recorder();
    await assert.rejects(
      acquireSelectedClearHlsMedia(
        {
          plan: { operation: "clear-hls-remux", source: { playlistUrl: "https://cdn.example/SECRET-PATH/media.m3u8" } },
          workDir,
          signal: new AbortController().signal,
          downloadTimeLimitMs: 600_000,
          activity: r.sink,
        },
        {
          preflight: async () => {
            throw new Error("preflight failure text");
          },
          acquire: acquireClearHlsTs,
          acquireFmp4: acquireClearHlsFmp4,
        },
      ),
    );
    assert.deepEqual(r.events, [{ kind: "settled", outcome: "failed" }]);
  });
});

describe("separate-audio HLS: two halves, one deadline, no reset of the allowance", () => {
  function separatePrimitives(videoPlan: ClearHlsFmp4AcquisitionPlan, audioPlan: ClearHlsFmp4AcquisitionPlan) {
    let calls = 0;
    return {
      preflight: async () => {
        calls += 1;
        return calls === 1 ? videoPlan : audioPlan;
      },
      acquireVideo: acquireClearHlsSeparateVideoFmp4,
      acquireAudio: acquireClearHlsSeparateAudioFmp4,
    };
  }

  const VIDEO_INIT = "https://cdn.example/SECRET-PATH/video-init.mp4";
  const AUDIO_INIT = "https://cdn.example/SECRET-PATH/audio-init.mp4";
  const VIDEO_SEG = "https://cdn.example/SECRET-PATH/video-1.m4s";
  const AUDIO_SEG = "https://cdn.example/SECRET-PATH/audio-1.m4s";

  it("each half counts from zero under one deadline, and the pair settles once", async () => {
    fakeHlsNetwork({
      [VIDEO_INIT]: () => chunkedBody([chunk(100)]),
      [VIDEO_SEG]: () => chunkedBody([chunk(9000), chunk(1000)]),
      [AUDIO_INIT]: () => chunkedBody([chunk(50)]),
      [AUDIO_SEG]: () => chunkedBody([chunk(400)]),
    });
    const t = tracked();
    const result = await acquireSelectedSeparateHlsMedia(
      {
        plan: {
          operation: "clear-hls-separate-audio-remux",
          source: { videoPlaylistUrl: "https://cdn.example/SECRET-PATH/v.m3u8", audioPlaylistUrl: "https://cdn.example/SECRET-PATH/a.m3u8" },
        },
        workDir,
        signal: new AbortController().signal,
        downloadTimeLimitMs: 600_000,
        activity: t.sink,
      },
      separatePrimitives(hlsFmp4Plan(VIDEO_INIT, [VIDEO_SEG]), hlsFmp4Plan(AUDIO_INIT, [AUDIO_SEG])),
    );
    assert.equal(result.video.fileSize, 10_100);
    assert.equal(result.audio.fileSize, 450);

    const phases = t.events.flatMap((e) => (e.kind === "phase-started" ? [e.phase] : []));
    assert.deepEqual(phases, ["video", "audio"]);

    const audioIndex = t.events.findIndex((e) => e.kind === "phase-started" && e.phase === "audio");
    const audioTotals = t.events.slice(audioIndex).flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : []));
    assert.deepEqual(audioTotals, [50, 450], "the audio half counts from zero");

    const snapshot = t.tracker.snapshot();
    assert.equal(snapshot.phase, "audio");
    assert.equal(snapshot.outcome, "completed");
    // The pair's shared deadline is armed from the pair's arm, and the first arm
    // is the only one the record honours — the halves' own timers cannot move it.
    assert.equal(snapshot.deadlineAtMs, 600_000);
    assert.deepEqual(t.events.at(-1), { kind: "settled", outcome: "completed" });
    assert.equal(t.events.filter((e) => e.kind === "settled").length, 1);
    assertClosedAndPrivate(t.events);
  });

  it("the interval between the halves is `between-phases`, under the absolute deadline only", async () => {
    const audioRequested = deferred();
    fakeHlsNetwork({
      [VIDEO_INIT]: () => chunkedBody([chunk(100)]),
      [VIDEO_SEG]: () => chunkedBody([chunk(70_000)]),
      [AUDIO_INIT]: () => {
        audioRequested.resolve();
        return chunkedBody([chunk(10)]);
      },
      [AUDIO_SEG]: () => chunkedBody([chunk(10)]),
    });
    const t = tracked();
    const primitives = separatePrimitives(hlsFmp4Plan(VIDEO_INIT, [VIDEO_SEG]), hlsFmp4Plan(AUDIO_INIT, [AUDIO_SEG]));
    let statusBetween: string | null = null;
    const realAcquireAudio = primitives.acquireAudio;
    primitives.acquireAudio = async (request) => {
      statusBetween = t.assess().status;
      return realAcquireAudio(request);
    };
    await acquireSelectedSeparateHlsMedia(
      {
        plan: {
          operation: "clear-hls-separate-audio-remux",
          source: { videoPlaylistUrl: "https://cdn.example/SECRET-PATH/v.m3u8", audioPlaylistUrl: "https://cdn.example/SECRET-PATH/a.m3u8" },
        },
        workDir,
        signal: new AbortController().signal,
        downloadTimeLimitMs: 600_000,
        activity: t.sink,
      },
      primitives,
    );
    await audioRequested.promise;
    assert.equal(statusBetween, "between-phases", "the first half is done; the second has not begun");
  });
});

// ── yt-dlp: the fake child, on a real job directory ──────────────────────────

const RUNTIME_OK = Object.freeze({
  available: true,
  version: YTDLP_RUNTIME.expectedVersion,
  reason: "ok" as const,
});
const EXIT_OK: RunResult = { code: 0, stdout: "", stderr: "" };

const LIMITS = { maxFileSizeBytes: 1_000_000_000, downloadTimeLimitMs: 600_000 };

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

function ytdlpDeps(sink: ((e: AcquisitionActivityEvent) => void) | undefined, runner: unknown, overrides: object = {}) {
  return {
    limits: LIMITS,
    probeRuntime: async () => RUNTIME_OK,
    validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
    sizePollMs: 1,
    runner,
    ...(sink ? { activity: sink } : {}),
    ...overrides,
  } as Parameters<typeof downloadGenericOriginal>[3];
}

/** Waits until the real monitor has taken `samples` more samples after this call. */
function samplesAfter(count: () => number, samples = 2) {
  const start = count();
  return waitUntil(() => count() >= start + samples, "the monitor to sample");
}

describe("yt-dlp progressive: file growth is the evidence", () => {
  it("a `.part` renamed to its final name is the same bytes, not new ones, and the guard saw every sample", async () => {
    const t = tracked();
    const final = expectedSourcePath(workDir, "mp4");
    const part = expectedPartPath(workDir, "mp4");
    const seen: number[] = [];
    let renameAtEvent = -1;
    const samples = () => t.events.filter((e) => e.kind === "bytes").length;
    const result = await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      progressivePlan(),
      ytdlpDeps(t.sink, async () => {
        // The monitor samples an absent file for a while, as during extraction.
        await new Promise((resolve) => setTimeout(resolve, 8));
        writeFileSync(part, chunk(50_000));
        await samplesAfter(samples);
        appendFileSync(part, chunk(70_000)); // a real `.part` only ever grows
        await samplesAfter(samples);
        seen.push(t.tracker.snapshot().observedBytes);
        renameAtEvent = t.events.length;
        renameSync(part, final);
        await samplesAfter(samples);
        return EXIT_OK;
      }),
    );
    assert.equal(t.events.some((e) => e.kind === "sample-gap"), false, "a file not yet created is not a gap");
    assert.equal(result.fileSize, 120_000);
    assert.deepEqual(seen, [120_000]);
    const snapshot = t.tracker.snapshot();
    assert.equal(snapshot.observedBytes, 120_000);
    assert.equal(snapshot.discardedBytes, 0, "a rename is not a discard");
    assert.deepEqual(t.events.at(-1), { kind: "settled", outcome: "completed" });
    assert.ok(t.events.some((e) => e.kind === "phase-ended"));
    // Every sample after the rename read the same size: no new bytes were invented.
    const totals = t.events.flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : []));
    assert.equal(Math.max(...totals), 120_000);
    const afterRename = t.events.slice(renameAtEvent).flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : []));
    assert.ok(afterRename.length > 0, "the monitor sampled the renamed file");
    assert.deepEqual([...new Set(afterRename)], [120_000]);
    assertClosedAndPrivate(t.events);
  });

  it("repeated identical sizes advance nothing and stay visibly unchanged", async () => {
    const t = tracked();
    const final = expectedSourcePath(workDir, "mp4");
    const part = expectedPartPath(workDir, "mp4");
    const samples = () => t.events.filter((e) => e.kind === "bytes").length;
    await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      progressivePlan(),
      ytdlpDeps(t.sink, async () => {
        writeFileSync(part, chunk(80_000));
        await samplesAfter(samples, 6);
        assert.equal(t.assess().status, "not-advancing");
        renameSync(part, final);
        await samplesAfter(samples);
        return EXIT_OK;
      }),
    );
  });

  it("a retry that keeps its partial resumes truthfully: no discard, only real growth", async () => {
    const t = tracked();
    const final = expectedSourcePath(workDir, "mp4");
    const part = expectedPartPath(workDir, "mp4");
    const samples = () => t.events.filter((e) => e.kind === "bytes").length;
    await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      progressivePlan(),
      ytdlpDeps(t.sink, async () => {
        writeFileSync(part, chunk(100_000));
        await samplesAfter(samples);
        // A retried connection resumes with Range and appends to the same `.part`.
        appendFileSync(part, chunk(100_000));
        await samplesAfter(samples);
        renameSync(part, final);
        await samplesAfter(samples);
        return EXIT_OK;
      }),
    );
    assert.equal(t.tracker.snapshot().observedBytes, 200_000);
    assert.equal(t.tracker.snapshot().discardedBytes, 0);
  });

  it("a restart from zero is a discard, and is never itself progress", async () => {
    const t = tracked();
    const final = expectedSourcePath(workDir, "mp4");
    const part = expectedPartPath(workDir, "mp4");
    const samples = () => t.events.filter((e) => e.kind === "bytes").length;
    let discardSeen = false;
    await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      progressivePlan(),
      ytdlpDeps(t.sink, async () => {
        writeFileSync(part, chunk(500_000));
        await samplesAfter(samples);
        // yt-dlp's retry after the source ignored Range: the partial is wiped.
        writeFileSync(part, chunk(10));
        await samplesAfter(samples, 4);
        discardSeen = t.tracker.snapshot().discardedBytes === 500_000 - 10 && t.assess().status === "retry-discarded";
        appendFileSync(part, chunk(199_990));
        await samplesAfter(samples);
        const s = t.tracker.snapshot();
        assert.equal(s.observedBytes, 200_000, "real growth after the restart is real progress");
        assert.equal(s.discardPending, false);
        renameSync(part, final);
        await samplesAfter(samples);
        return EXIT_OK;
      }),
    );
    assert.equal(discardSeen, true);
    assert.equal(t.tracker.snapshot().observedBytes, 200_000);
  });

  it("a file the run already held becoming unreadable is a gap; it is never 0 bytes", async () => {
    const t = tracked();
    const final = expectedSourcePath(workDir, "mp4");
    const part = expectedPartPath(workDir, "mp4");
    const samples = () => t.events.filter((e) => e.kind === "bytes" || e.kind === "sample-gap").length;
    await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      progressivePlan(),
      ytdlpDeps(t.sink, async () => {
        writeFileSync(part, chunk(70_000));
        await samplesAfter(samples);
        unlinkSync(part); // Neither `.part` nor the final name: the sample reads nothing.
        await samplesAfter(samples, 5);
        assert.equal(t.assess().status, "unobserved");
        assert.equal(t.tracker.snapshot().observedBytes, 70_000, "a gap is not a truncation to zero");
        writeFileSync(final, chunk(70_000));
        await samplesAfter(samples);
        return EXIT_OK;
      }),
    );
    assert.ok(t.events.some((e) => e.kind === "sample-gap"));
    assert.equal(t.tracker.snapshot().discardedBytes, 0, "a gap is never a discard");
  });

  it("a plan's declared size is never the evidence", async () => {
    const r = recorder();
    const plan = progressivePlan();
    (plan.source as { fileSize: number | null }).fileSize = 999_999;
    const final = expectedSourcePath(workDir, "mp4");
    await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      plan,
      ytdlpDeps(r.sink, async () => {
        writeFileSync(final, chunk(1000));
        await waitUntil(() => r.totals().length > 0, "a sample");
        return EXIT_OK;
      }),
    );
    assert.equal(r.totals().includes(999_999), false);
    assert.deepEqual([...new Set(r.totals())], [1000]);
  });

  it("cancellation during the run settles as cancelled; a sample resolving afterwards is inert", async () => {
    const r = recorder();
    const controller = new AbortController();
    const part = expectedPartPath(workDir, "mp4");
    const release = deferred();
    let held = false;
    const statSize = async (p: string) => {
      if (held) await release.promise;
      try {
        return statSync(p).size;
      } catch {
        return null;
      }
    };
    await assert.rejects(
      downloadGenericOriginal(
        SECRET_URL,
        workDir,
        progressivePlan(),
        ytdlpDeps(
          r.sink,
          async (call: { signal?: AbortSignal }) => {
            writeFileSync(part, chunk(70_000));
            await waitUntil(() => r.totals().length > 0, "a sample");
            held = true; // the next sample suspends inside its stat
            await new Promise((resolve) => setTimeout(resolve, 3));
            controller.abort(new AppError("PROCESSING_FAILED", "Download was cancelled."));
            await new Promise((resolve, reject) => {
              call.signal?.addEventListener("abort", () => reject(new AppError("PROCESSING_FAILED", "Download was cancelled.")), { once: true });
              if (call.signal?.aborted) reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
              void resolve;
            });
            return EXIT_OK;
          },
          { signal: controller.signal, statSize },
        ),
      ),
    );
    assert.deepEqual(r.settled(), ["cancelled"]);
    const count = r.events.length;
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(r.events.length, count, "the late sample reported nothing");
  });

  it("a late sample after success is inert too", async () => {
    const r = recorder();
    const final = expectedSourcePath(workDir, "mp4");
    const release = deferred();
    let held = false;
    const statSize = async (p: string) => {
      if (held) await release.promise;
      try {
        return statSync(p).size;
      } catch {
        return null;
      }
    };
    await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      progressivePlan(),
      ytdlpDeps(
        r.sink,
        async () => {
          writeFileSync(final, chunk(1000));
          await waitUntil(() => r.totals().length > 0, "a sample");
          held = true;
          await new Promise((resolve) => setTimeout(resolve, 3));
          return EXIT_OK;
        },
        { statSize },
      ),
    );
    assert.deepEqual(r.settled(), ["completed"]);
    const count = r.events.length;
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(r.events.length, count);
  });

  it("the runner's TIMEOUT is the absolute deadline; a stderr that says `timed out` is not", async () => {
    const deadline = recorder();
    await assert.rejects(
      downloadGenericOriginal(
        SECRET_URL,
        workDir,
        progressivePlan(),
        ytdlpDeps(deadline.sink, async () => {
          throw new AppError("TIMEOUT");
        }),
      ),
    );
    assert.deepEqual(deadline.settled(), ["deadline-exceeded"]);

    const stderrSays = recorder();
    await assert.rejects(
      downloadGenericOriginal(
        SECRET_URL,
        workDir,
        progressivePlan(),
        ytdlpDeps(stderrSays.sink, async () => ({ code: 1, stdout: "", stderr: "Read timed out." })),
      ),
    );
    assert.deepEqual(stderrSays.settled(), ["failed"]);
  });

  it("the runtime probe (metadata) reports no bytes and starts no phase", async () => {
    const r = recorder();
    let atProbe: readonly AcquisitionActivityEvent[] = [];
    const final = expectedSourcePath(workDir, "mp4");
    await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      progressivePlan(),
      ytdlpDeps(
        r.sink,
        async () => {
          writeFileSync(final, chunk(1000));
          await waitUntil(() => r.totals().length > 0, "a sample");
          return EXIT_OK;
        },
        {
          probeRuntime: async () => {
            atProbe = [...r.events];
            return RUNTIME_OK;
          },
        },
      ),
    );
    assert.deepEqual(atProbe.map((e) => e.kind), ["deadline-armed"], "the deadline is armed; nothing else");
  });

  it("a sink that throws cannot corrupt the output or the byte guard", async () => {
    const final = expectedSourcePath(workDir, "mp4");
    let reports = 0;
    const result = await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      progressivePlan(),
      ytdlpDeps(
        () => {
          reports += 1;
          throw new Error("observer failure");
        },
        async () => {
          writeFileSync(final, chunk(2000, 0x55));
          await waitUntil(() => reports > 0, "a report");
          return EXIT_OK;
        },
      ),
    );
    assert.equal(sha256(readFileSync(result.filePath)), sha256(chunk(2000, 0x55)));
  });

  it("the byte ceiling still fires from the byte guard, independent of any sink", async () => {
    const part = expectedPartPath(workDir, "mp4");
    const r = recorder();
    await assert.rejects(
      downloadGenericOriginal(
        SECRET_URL,
        workDir,
        progressivePlan(),
        ytdlpDeps(
          r.sink,
          async (call: { signal?: AbortSignal }) => {
            writeFileSync(part, chunk(5000));
            await new Promise<never>((_, reject) => {
              call.signal?.addEventListener("abort", () => reject(new AppError("PROCESSING_FAILED", "cancelled")), { once: true });
            });
            return EXIT_OK;
          },
          { limits: { maxFileSizeBytes: 1000, downloadTimeLimitMs: 600_000 } },
        ),
      ),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
    assert.deepEqual(r.settled(), ["failed"], "an overflow is not a cancellation");
  });
});

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
const DASH_AUDIO: GenericSourceSelection = {
  formatId: "dash-a",
  protocol: "http_dash_segments",
  container: "m4a",
  hasVideo: false,
  hasAudio: true,
  videoConstraint: "absent",
  audioConstraint: "codec-present",
  fileSize: null,
};
const HTTPS_AUDIO: GenericSourceSelection = { ...DASH_AUDIO, formatId: "140", protocol: "https" };

function splitPlan(
  video: GenericSourceSelection = { ...DASH_VIDEO, formatId: "137", protocol: "https" },
  audio: GenericSourceSelection = HTTPS_AUDIO,
): GenericSplitExecutionPlan {
  return {
    strategy: "yt-dlp",
    operation: "merge-split",
    requestedFormatId: "preset:1080",
    pair: { video, audio },
    targetContainer: "mp4",
  };
}

function roleOf(call: { args: readonly string[] }): "video" | "audio" {
  return call.args.some((a) => a.includes("audio-source")) ? "audio" : "video";
}

describe("yt-dlp split: a transition between halves, with one shared deadline", () => {
  it("each half reports its own bytes from zero, and the deadline is armed once", async () => {
    const t = tracked();
    const samples = () => t.events.filter((e) => e.kind === "bytes").length;
    const statuses: string[] = [];
    await downloadGenericSplitSources(
      SECRET_URL,
      workDir,
      splitPlan(),
      ytdlpDeps(t.sink, async (call: { args: readonly string[] }) => {
        const role = roleOf(call);
        statuses.push(t.assess().status);
        const final = expectedSplitSourcePath(workDir, role, role === "video" ? "mp4" : "m4a");
        const part = `${final}.part`;
        writeFileSync(part, chunk(role === "video" ? 90_000 : 7_000));
        await samplesAfter(samples);
        renameSync(part, final);
        await samplesAfter(samples);
        return EXIT_OK;
      }) as Parameters<typeof downloadGenericSplitSources>[3],
    );

    assert.deepEqual(t.events.flatMap((e) => (e.kind === "phase-started" ? [e.phase] : [])), ["video", "audio"]);
    assert.equal(t.events.filter((e) => e.kind === "deadline-armed").length, 1, "one deadline for both halves");

    const audioStart = t.events.findIndex((e) => e.kind === "phase-started" && e.phase === "audio");
    const audioTotals = t.events.slice(audioStart).flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : []));
    assert.deepEqual([...new Set(audioTotals)], [7_000], "the audio half's own bytes, never the video half's");

    const snapshot = t.tracker.snapshot();
    assert.equal(snapshot.phase, "audio");
    assert.equal(snapshot.observedBytes, 7_000, "the video half's larger total is not a floor for audio");
    assert.equal(snapshot.outcome, "completed");
    assert.deepEqual(statuses[0], "awaiting-first-byte");
    assertClosedAndPrivate(t.events);
  });

  it("a video half's late sample is inert: nothing of it is charged to the audio half", async () => {
    const r = recorder();
    const release = deferred();
    let holdVideoStat = false;
    const statSize = async (p: string) => {
      if (holdVideoStat && p.includes("video-source")) await release.promise;
      try {
        return statSync(p).size;
      } catch {
        return null;
      }
    };
    await downloadGenericSplitSources(
      SECRET_URL,
      workDir,
      splitPlan(),
      ytdlpDeps(
        r.sink,
        async (call: { args: readonly string[] }) => {
          const role = roleOf(call);
          const final = expectedSplitSourcePath(workDir, role, role === "video" ? "mp4" : "m4a");
          if (role === "video") {
            writeFileSync(final, chunk(5000));
            await waitUntil(() => r.totals().length > 0, "a video sample");
            holdVideoStat = true; // the next video sample suspends inside its stat
            await new Promise((resolve) => setTimeout(resolve, 3));
            return EXIT_OK; // the video run ends while that sample is still suspended
          }
          writeFileSync(final, chunk(300));
          await waitUntil(() => r.totals().includes(300), "an audio sample");
          release.resolve(); // the video sample resumes now, inside the audio half
          await new Promise((resolve) => setTimeout(resolve, 3));
          return EXIT_OK;
        },
        { statSize },
      ) as Parameters<typeof downloadGenericSplitSources>[3],
    );
    const audioStart = r.events.findIndex((e) => e.kind === "phase-started" && e.phase === "audio");
    const audioTotals = r.events.slice(audioStart).flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : []));
    assert.equal(audioTotals.includes(5000), false, "the video half's file was not re-reported");
    assert.deepEqual(r.settled(), ["completed"]);
    assert.ok(
      r.kinds().indexOf("phase-ended") < r.events.findIndex((e) => e.kind === "phase-started" && e.phase === "audio"),
      "the video phase ended before the audio phase began",
    );
  });
});

describe("yt-dlp segmented DASH: a fragment rollover is neither a stall nor new bytes", () => {
  async function emulateDash(
    final: string,
    sizes: readonly number[],
    settle: () => Promise<void>,
    landsCompleteBetweenSamples?: number,
  ): Promise<void> {
    const part = `${final}.part`;
    writeFileSync(`${final}.ytdl`, "{}");
    writeFileSync(part, "");
    for (let index = 0; index < sizes.length; index += 1) {
      const n = index + 1;
      const fragPart = `${part}-Frag${n}.part`;
      const frag = `${part}-Frag${n}`;
      const bytes = chunk(sizes[index]!, n);
      if (n === landsCompleteBetweenSamples) {
        // Fetched entirely between two samples: seen only once complete.
        writeFileSync(frag, bytes);
        await settle();
      } else {
        const half = Math.ceil(bytes.length / 2);
        writeFileSync(fragPart, bytes.subarray(0, half));
        await settle();
        appendFileSync(fragPart, bytes.subarray(half));
        await settle();
        renameSync(fragPart, frag);
        await settle();
      }
      appendFileSync(part, readFileSync(frag));
      await settle();
      unlinkSync(frag);
      await settle();
    }
    unlinkSync(`${final}.ytdl`);
    renameSync(part, final);
    await settle();
  }

  it("the high-water mark equals the fragments' real bytes, and nothing is discarded or double-counted", async () => {
    const t = tracked();
    const samples = () => t.events.filter((e) => e.kind === "bytes").length;
    const settle = () => samplesAfter(samples);
    await downloadGenericSplitSources(
      SECRET_URL,
      workDir,
      splitPlan(DASH_VIDEO, HTTPS_AUDIO),
      ytdlpDeps(t.sink, async (call: { args: readonly string[] }) => {
        const role = roleOf(call);
        if (role === "video") {
          await emulateDash(expectedSplitSourcePath(workDir, "video", "mp4"), [40_000, 30_000, 20_000], settle, 3);
        } else {
          const final = expectedSplitSourcePath(workDir, "audio", "m4a");
          writeFileSync(final, chunk(1000));
          await settle();
        }
        return EXIT_OK;
      }) as Parameters<typeof downloadGenericSplitSources>[3],
    );
    const videoEnd = t.events.findIndex((e) => e.kind === "phase-ended");
    const videoTotals = t.events.slice(0, videoEnd).flatMap((e) => (e.kind === "bytes" ? [e.totalBytes] : []));
    assert.equal(Math.max(...videoTotals), 90_000, "every byte counted once, never twice");
    assert.equal(t.tracker.snapshot().outcome, "completed");
    assert.equal(t.tracker.snapshot().discardedBytes, 0, "a rollover is not a discard");
    assertClosedAndPrivate(t.events);
  });
});

// ── The executor: per-acquisition scope, and absent by default ───────────────

describe("the executor's activity plumbing", () => {
  function harnessExecutor() {
    const dir = mkdtempSync(join(tmpdir(), "ld3a-executor-"));
    setTempDirectoryForTests(dir);
    const db = new DatabaseSync(join(dir, "test.sqlite"));
    applyMigrations(db);
    const store = new SQLiteJobStore({ db });
    const puts: Array<{ objectKey: string; contentLength: number; contentType: string; contentDisposition: string }> = [];
    const writer: ObjectStoreWriter = {
      async put(input) {
        puts.push({
          objectKey: input.objectKey,
          contentLength: input.contentLength,
          contentType: input.contentType,
          contentDisposition: input.contentDisposition,
        });
        for await (const piece of input.body) void piece;
      },
      async head(key) {
        return puts.find((p) => p.objectKey === key) ?? null;
      },
      async delete() {},
    };
    return {
      store,
      writer,
      claim(formatId: "direct-original" = "direct-original") {
        store.createJob(
          { url: "https://cdn.example.com/clip.mp4", formatId, principalId: "private-access-user" },
          randomUUID(),
        );
        const job = store.claimNextQueuedJob();
        assert.ok(job);
        return job;
      },
      cleanup() {
        db.close();
        setTempDirectoryForTests(null);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  function directDeps(overrides: Partial<JobExecutorDeps> = {}): JobExecutorDeps {
    return {
      analyze: async () =>
        VideoMetadataSchema.parse({
          title: "clip",
          thumbnail: null,
          duration: null,
          source: "cdn.example.com",
          extractor: "direct",
          webpageUrl: "https://cdn.example.com/clip",
          formats: [
            {
              id: "direct-original",
              resolution: "unknown",
              width: null,
              height: null,
              fps: null,
              container: "mp4",
              videoCodec: "unknown",
              audioCodec: "unknown",
              bitrate: null,
              fileSize: 8,
              hasVideo: true,
              hasAudio: true,
              formatNote: null,
            },
          ],
          presets: [],
          capabilities: { mp3: true, merge: true },
        }),
      downloadOriginal: async (_url, ctx) => {
        const filePath = join(ctx.workDir, "source.mp4");
        writeFileSync(filePath, "mockdata");
        return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
      },
      ...overrides,
    };
  }

  it("Production composition supplies no sink: no acquisition seam gets an activity key", async () => {
    const h = harnessExecutor();
    try {
      let keys: string[] = [];
      const job = h.claim();
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), directDeps({
        downloadOriginal: async (_url, ctx) => {
          keys = Object.keys(ctx).sort();
          const filePath = join(ctx.workDir, "source.mp4");
          writeFileSync(filePath, "mockdata");
          return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
        },
      }));
      await executor.execute(job);
      assert.deepEqual(keys, ["downloadTimeLimitMs", "onProgress", "signal", "workDir"]);
    } finally {
      h.cleanup();
    }
  });

  it("the composition root names no activity sink", () => {
    const runtime = readFileSync(new URL("../runtime/runtime.server.ts", import.meta.url), "utf8");
    assert.equal(runtime.includes("createAcquisitionActivitySink"), false);
    assert.equal(runtime.includes("acquisition-activity"), false);
  });

  it("every default acquisition seam forwards the sink it is given", () => {
    // The yt-dlp and HLS seams' default compositions need a real child or
    // network, so their one forwarding line each is pinned here. The direct
    // default hands the whole context over; the test below covers injection.
    const executor = readFileSync(new URL("./job-executor.server.ts", import.meta.url), "utf8");
    assert.equal(executor.split("...(ctx.activity ? { activity: ctx.activity } : {}),").length - 1, 4);
  });

  it("a fresh sink per acquisition, handed to the seam", async () => {
    const h = harnessExecutor();
    try {
      let handed: unknown = null;
      let created = 0;
      const sink = () => {};
      const job = h.claim();
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), directDeps({
        createAcquisitionActivitySink: () => {
          created += 1;
          return sink;
        },
        downloadOriginal: async (_url, ctx) => {
          handed = ctx.activity;
          const filePath = join(ctx.workDir, "source.mp4");
          writeFileSync(filePath, "mockdata");
          return { filePath, container: "mp4", mime: "video/mp4", fileSize: 8 };
        },
      }));
      await executor.execute(job);
      assert.equal(created, 1);
      assert.equal(handed, sink);
    } finally {
      h.cleanup();
    }
  });

  it("a sink factory that fails is an observer failing: the job still reaches the same end", async () => {
    const h = harnessExecutor();
    try {
      const job = h.claim();
      const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), directDeps({
        createAcquisitionActivitySink: () => {
          throw new Error("factory failure");
        },
      }));
      await executor.execute(job);
      assert.equal(h.store.getJob(job.jobId)!.status, "ready");
    } finally {
      h.cleanup();
    }
  });

  it("attaching a sink changes no outcome: the durable result matches the sink-free run", async () => {
    const run = async (attach: boolean) => {
      const h = harnessExecutor();
      try {
        const job = h.claim();
        const executor = new JobExecutor(h.store, h.writer, () => Date.now(), new Map(), directDeps(
          attach
            ? {
                createAcquisitionActivitySink: () => () => {
                  throw new Error("a sink that always fails");
                },
              }
            : {},
        ));
        await executor.execute(job);
        const view = h.store.getJob(job.jobId)!;
        return { status: view.status, container: view.container, fileSize: view.fileSize };
      } finally {
        h.cleanup();
      }
    };
    assert.deepEqual(await run(true), await run(false));
  });
});
