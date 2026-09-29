import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir as fsReaddir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AppError, ERROR_MESSAGES } from "../../lib/errors.ts";
import type { RunResult } from "../../services/processing/process-runner.server.ts";
import { YTDLP_RUNTIME, type YtdlpRuntimeStatus } from "../runtime/ytdlp-runtime.server.ts";
import type { GenericSourceSelection } from "./generic-source.ts";
import type {
  GenericSingleSourceExecutionPlan,
  GenericSplitExecutionPlan,
} from "./format-plan.ts";
import {
  YTDLP_DOWNLOAD_FFMPEG_LOCATION,
  buildYtdlpSplitDownloadArgv,
  classifySegmentedAcquisitionEntry,
  downloadGenericOriginal,
  downloadGenericSplitSources,
  expectedSplitSourcePath,
  splitOutputTemplateFor,
  type GenericDownloadProgress,
  type GenericSplitRole,
} from "./ytdlp-download.server.ts";

/**
 * GENERIC-SEGMENTED-DASH-EXECUTION-001 — segmented acquisition.
 *
 * The REAL `downloadGenericSplitSources` runs, with only its yt-dlp child
 * faked. The fake child EMULATES the pinned 2026.08.19 `FragmentFD` on a real
 * job directory, step by step and in the pinned order:
 *
 *   `<final>.ytdl` + an empty `<final>.part`
 *   per fragment N (1-based): `<final>.part-FragN.part` grows, is renamed to
 *   `<final>.part-FragN`, is appended to `<final>.part`, is removed, and the
 *   `.ytdl` records N
 *   then `.ytdl` is removed and `<final>.part` renamed to `<final>`.
 *
 * Each step is held for several poll intervals, so the real monitor samples
 * every intermediate state — including the append window, in which a fragment
 * exists both as a file and inside the aggregate. That the emulation matches
 * the pinned artifact is proven separately, against the artifact itself, by
 * `ytdlp-dash-downloader-contract.server.test.ts`.
 *
 * No network, no yt-dlp, no FFmpeg, no real process group.
 */

const SAFE_URL = "https://example.invalid/watch/dash";
const SENTINEL = "DASH_FRAGMENT_SECRET";

const OK_RUNTIME: YtdlpRuntimeStatus = Object.freeze({
  available: true,
  version: YTDLP_RUNTIME.expectedVersion,
  reason: "ok" as const,
});
const ok: RunResult = { code: 0, stdout: "", stderr: "" };

const POLL_MS = 1;
const TICK_MS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DASH_VIDEO: GenericSourceSelection = {
  formatId: "dash-v1080",
  protocol: "http_dash_segments",
  container: "mp4",
  hasVideo: true,
  hasAudio: false,
  videoConstraint: "codec-present",
  audioConstraint: "absent",
  fileSize: null,
};
const DASH_AUDIO: GenericSourceSelection = {
  formatId: "dash-a128",
  protocol: "http_dash_segments",
  container: "m4a",
  hasVideo: false,
  hasAudio: true,
  videoConstraint: "absent",
  audioConstraint: "codec-present",
  fileSize: null,
};

function plan(
  video: GenericSourceSelection = DASH_VIDEO,
  audio: GenericSourceSelection = DASH_AUDIO,
): GenericSplitExecutionPlan {
  return {
    strategy: "yt-dlp",
    operation: "merge-split",
    requestedFormatId: "preset:1080",
    pair: { video, audio },
    targetContainer: "mp4",
  };
}

type Deps = Parameters<typeof downloadGenericSplitSources>[3];
type RunnerCall = Parameters<NonNullable<Deps["runner"]>>[0];
type Child = (call: RunnerCall) => Promise<RunResult>;

// ── event-loop liveness (NODE22-GENERIC-EXECUTION-TEST-LIVENESS-001) ────────
let eventLoopHold: ReturnType<typeof setTimeout> | null = null;
let workDir = "";
beforeEach(() => {
  eventLoopHold = setTimeout(() => {}, 30_000);
  workDir = mkdtempSync(join(tmpdir(), "ytdlp-dash-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (eventLoopHold !== null) clearTimeout(eventLoopHold);
  eventLoopHold = null;
});

function roleOf(call: RunnerCall): GenericSplitRole {
  const out = call.args.find((a) => a.startsWith("--output="));
  if (out === `--output=${splitOutputTemplateFor(workDir, "video")}`) return "video";
  if (out === `--output=${splitOutputTemplateFor(workDir, "audio")}`) return "audio";
  throw new Error(`unexpected output template: ${String(out)}`);
}
const finalOf = (p: GenericSplitExecutionPlan, role: GenericSplitRole) =>
  expectedSplitSourcePath(workDir, role, p.pair[role].container);
const argOf = (call: RunnerCall, prefix: string) =>
  call.args.find((a) => a.startsWith(prefix))?.slice(prefix.length);

/** Deterministic, per-fragment-distinct bytes. */
const fragment = (tag: string, n: number, size: number) => Buffer.alloc(size, `${tag}${n}|`);

type Emulation = {
  readonly fragments: readonly Buffer[];
  /** Bytes of the bookkeeping file the emulator writes (pinned: a few dozen). */
  readonly ytdlBytes?: number;
  /** Extra hold inside each append window, so samples land there. */
  readonly appendHoldMs?: number;
  /** Stop BEFORE the step named; `onHold` runs, then the child waits for abort. */
  readonly holdAt?: { readonly fragment: number; readonly step: "in-flight" | "complete" | "appended" };
  /** Leave this entry behind after an otherwise successful run. */
  readonly leave?: "fragment" | "ytdl" | "part";
  /** Remove the final artifact before exiting 0. */
  readonly dropFinal?: boolean;
  /** This fragment lands COMPLETE between two samples: no in-flight state. */
  readonly skipInFlight?: number;
  /** Called with the step name at every state change. */
  readonly onStep?: (step: string) => void | Promise<void>;
};

class Cancelled extends AppError {
  constructor() {
    super("PROCESSING_FAILED", "Download was cancelled.");
  }
}

/**
 * The fake child: the pinned FragmentFD lifecycle on the REAL job directory.
 * It rejects exactly as the hardened runner does once its signal aborts.
 */
function emulateFragmentFd(final: string, e: Emulation): Child {
  return async (call) => {
    const stopIfAborted = () => {
      if (call.signal?.aborted) throw new Cancelled();
    };
    const tick = async (ms = TICK_MS) => {
      await sleep(ms);
      stopIfAborted();
    };
    const hold = async () => {
      // Parked until the run is aborted (by the guard, the caller or a test).
      for (;;) await tick();
    };
    const part = `${final}.part`;
    const ytdl = `${final}.ytdl`;
    const writeYtdl = (index: number) => {
      const body = JSON.stringify({ downloader: { current_fragment: { index } } });
      writeFileSync(ytdl, e.ytdlBytes === undefined ? body : body.padEnd(e.ytdlBytes, " "));
    };

    writeYtdl(0);
    writeFileSync(part, "");
    await e.onStep?.("prepared");
    await tick();

    for (let i = 0; i < e.fragments.length; i += 1) {
      const n = i + 1;
      const bytes = e.fragments[i]!;
      const fragPart = `${part}-Frag${n}.part`;
      const frag = `${part}-Frag${n}`;

      if (e.skipInFlight === n) {
        // Fetched entirely between two samples: first seen complete.
        writeFileSync(frag, bytes);
      } else {
        // In flight: its own HttpFD `.part`, growing.
        writeFileSync(fragPart, bytes.subarray(0, Math.ceil(bytes.length / 2)));
        await tick();
        writeFileSync(fragPart, bytes);
        await e.onStep?.(`frag${n}:in-flight`);
        if (e.holdAt?.fragment === n && e.holdAt.step === "in-flight") await hold();
        await tick();

        // Complete: renamed, not yet appended.
        renameSync(fragPart, frag);
      }
      await e.onStep?.(`frag${n}:complete`);
      if (e.holdAt?.fragment === n && e.holdAt.step === "complete") await hold();
      await tick();

      // Appended: the aggregate holds it AND the fragment file still exists.
      appendFileSync(part, readFileSync(frag));
      await e.onStep?.(`frag${n}:appended`);
      if (e.holdAt?.fragment === n && e.holdAt.step === "appended") await hold();
      await tick(e.appendHoldMs ?? TICK_MS);

      if (!(e.leave === "fragment" && n === e.fragments.length)) unlinkSync(frag);
      writeYtdl(n);
      await e.onStep?.(`frag${n}:removed`);
      await tick();
    }

    if (e.leave !== "ytdl") unlinkSync(ytdl);
    if (e.leave === "part") {
      writeFileSync(final, readFileSync(part));
    } else {
      renameSync(part, final);
    }
    if (e.dropFinal) unlinkSync(final);
    await e.onStep?.("finished");
    return ok;
  };
}

/** A progressive child for a mixed pair's HTTPS half. */
function progressiveChild(final: string, bytes: Buffer): Child {
  return async () => {
    writeFileSync(`${final}.part`, bytes);
    await sleep(TICK_MS);
    renameSync(`${final}.part`, final);
    return ok;
  };
}

function runner(script: Partial<Record<GenericSplitRole, Child>>) {
  const calls: RunnerCall[] = [];
  const run = async (call: RunnerCall): Promise<RunResult> => {
    calls.push(call);
    const child = script[roleOf(call)];
    if (!child) throw new Error(`no child scripted for ${roleOf(call)}`);
    return child(call);
  };
  return { run, calls };
}

/** Records every listing the REAL monitor and directory proofs made. */
function recordingReadDir() {
  const seen = new Set<string>();
  const readDir = async (p: string) => {
    const names = await fsReaddir(p);
    for (const n of names) seen.add(n);
    return names;
  };
  return { readDir, seen };
}

function download(
  p: GenericSplitExecutionPlan,
  run: Deps["runner"],
  extra: Partial<Deps> & { maxFileSizeBytes?: number } = {},
) {
  const { maxFileSizeBytes, ...rest } = extra;
  return downloadGenericSplitSources(SAFE_URL, workDir, p, {
    limits: { maxFileSizeBytes: maxFileSizeBytes ?? 100_000, downloadTimeoutSeconds: 600 },
    runner: run,
    probeRuntime: async () => OK_RUNTIME,
    validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
    sizePollMs: POLL_MS,
    ...rest,
  } as Deps);
}

async function rejectsWith(code: string, fn: () => Promise<unknown>): Promise<AppError> {
  let caught: unknown = null;
  await assert.rejects(fn, (err: unknown) => {
    caught = err;
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
  return caught as unknown as AppError;
}

function assertNoLeak(err: AppError) {
  for (const needle of [SENTINEL, "Frag", "http_dash_segments", "dash-v1080", "dash-a128", "media.example"]) {
    assert.equal(err.message.includes(needle), false, needle);
  }
  assert.equal(err.message, err.message === ERROR_MESSAGES[err.code] ? ERROR_MESSAGES[err.code] : err.message);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("segmented grammar: classifySegmentedAcquisitionEntry", () => {
  const F = "video-source.mp4";
  it("classifies exactly the pinned FragmentFD names", () => {
    const table: Array<[string, string]> = [
      [F, "aggregate"],
      [`${F}.part`, "aggregate"],
      [`${F}.ytdl`, "bookkeeping"],
      [`${F}.part-Frag1.part`, "fragment-in-flight"],
      [`${F}.part-Frag1`, "fragment-complete"],
      [`${F}.part-Frag42.part`, "fragment-in-flight"],
      [`${F}.part-Frag123456789`, "fragment-complete"],
    ];
    for (const [entry, kind] of table) assert.equal(classifySegmentedAcquisitionEntry(F, entry), kind, entry);
  });

  it("anything else — near misses included — is unexpected", () => {
    for (const entry of [
      `${F}.part-Frag0`,
      `${F}.part-Frag01`,
      `${F}.part-Frag-1`,
      `${F}.part-Frag+1`,
      `${F}.part-Frag`,
      `${F}.part-Frag1.part.part`,
      `${F}.part-Frag1.ytdl`,
      `${F}.part-Frag1234567890`,
      `${F}-Frag1`,
      `${F}.part.part`,
      `${F}.temp`,
      "audio-source.m4a.part-Frag1",
      "video-source.webm.part-Frag1",
      "source.mp4.part-Frag1",
      "tmpabc123.tmp",
      ".cache",
      "",
    ]) {
      assert.equal(classifySegmentedAcquisitionEntry(F, entry), "unexpected", entry);
    }
  });
});

describe("segmented acquisition: the argv of a DASH half", () => {
  for (const role of ["video", "audio"] as const) {
    it(`${role}: one DASH source, native, no FFmpeg, fragments bounded and never skipped`, () => {
      const a = [...buildYtdlpSplitDownloadArgv({ validatedUrl: SAFE_URL, workDir: "/srv/w", plan: plan(), role, maxFileSizeBytes: 1000 })];
      const formats = a.filter((x) => x.startsWith("--format=") || x === "-f");
      assert.equal(formats.length, 1);
      assert.match(formats[0]!, /\[protocol="http_dash_segments"\]/);
      assert.doesNotMatch(formats[0]!, /[/+,]/);
      for (const required of [
        "--downloader=native",
        "--concurrent-fragments=1",
        "--no-keep-fragments",
        "--abort-on-unavailable-fragments",
        "--fixup=never",
        `--ffmpeg-location=${YTDLP_DOWNLOAD_FFMPEG_LOCATION}`,
        "--fragment-retries=1",
        "--max-filesize=1000",
      ]) {
        assert.equal(a.filter((x) => x === required).length, 1, required);
      }
      for (const forbidden of [
        "--skip-unavailable-fragments",
        "--no-abort-on-unavailable-fragments",
        "--keep-fragments",
        "--merge-output-format",
        "--remux-video",
        "--external-downloader",
        "--downloader-args",
        "--live-from-start",
        "--hls-prefer-ffmpeg",
      ]) {
        assert.equal(a.some((x) => x === forbidden || x.startsWith(`${forbidden}=`)), false, forbidden);
      }
      // No `-N`/concurrency other than 1, and the downloader cannot be chosen per protocol.
      assert.equal(a.filter((x) => x.startsWith("--concurrent-fragments")).length, 1);
      assert.equal(a.filter((x) => x.startsWith("--downloader")).length, 1);
    });
  }

  it("the argv differs from a progressive half's ONLY in the selector's protocol", () => {
    const dash = [...buildYtdlpSplitDownloadArgv({ validatedUrl: SAFE_URL, workDir: "/srv/w", plan: plan(), role: "video", maxFileSizeBytes: 1000 })];
    const https = [...buildYtdlpSplitDownloadArgv({
      validatedUrl: SAFE_URL, workDir: "/srv/w",
      plan: plan({ ...DASH_VIDEO, protocol: "https" }), role: "video", maxFileSizeBytes: 1000,
    })];
    const diff = dash.flatMap((x, i) => (x === https[i] ? [] : [[x, https[i]]]));
    assert.equal(dash.length, https.length);
    assert.deepEqual(diff, [[
      '--format=b*[format_id="dash-v1080"][protocol="http_dash_segments"][ext="mp4"][vcodec!="none"][acodec="none"]',
      '--format=b*[format_id="dash-v1080"][protocol="https"][ext="mp4"][vcodec!="none"][acodec="none"]',
    ]]);
  });
});

describe("segmented acquisition: success", () => {
  it("DASH video + DASH audio: two runs, byte-exact aggregates, only the two artifacts left", async () => {
    const p = plan();
    const video = [fragment("V", 1, 100), fragment("V", 2, 150), fragment("V", 3, 120)];
    const audio = [fragment("A", 1, 40), fragment("A", 2, 30)];
    const { run, calls } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), { fragments: video, appendHoldMs: 20 }),
      audio: emulateFragmentFd(finalOf(p, "audio"), { fragments: audio, appendHoldMs: 20 }),
    });
    const { readDir, seen } = recordingReadDir();
    const progress: GenericDownloadProgress[] = [];

    const res = await download(p, run, { readDir, onProgress: (u) => progress.push(u) });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(roleOf), ["video", "audio"]);
    for (const call of calls) {
      assert.equal(call.command, YTDLP_RUNTIME.pythonPath, "no other executable is ever spawned");
      assert.equal(call.args[0], YTDLP_RUNTIME.artifactPath);
    }
    assert.equal(res.video.fileSize, 370);
    assert.equal(res.audio.fileSize, 70);
    assert.equal(res.totalFileSize, 440);
    assert.deepEqual(readFileSync(res.video.filePath), Buffer.concat(video));
    assert.deepEqual(readFileSync(res.audio.filePath), Buffer.concat(audio));
    assert.deepEqual(readdirSync(workDir).sort(), ["audio-source.m4a", "video-source.mp4"]);

    // The monitor really saw the pinned grammar while it ran.
    for (const name of [
      "video-source.mp4.ytdl",
      "video-source.mp4.part",
      "video-source.mp4.part-Frag1.part",
      "video-source.mp4.part-Frag1",
      "video-source.mp4.part-Frag3",
      "audio-source.m4a.part-Frag2.part",
    ]) {
      assert.ok(seen.has(name), `the monitor never observed ${name}`);
    }

    // Progress: actual bytes, monotonic, never a fragment counted twice, no
    // fabricated total or percentage.
    assert.ok(progress.length > 0);
    const bytes = progress.map((u) => u.downloadedBytes ?? -1);
    for (let i = 1; i < bytes.length; i += 1) assert.ok(bytes[i]! >= bytes[i - 1]!, `regressed at ${i}`);
    assert.ok(Math.max(...bytes) <= 440, `double-counted: ${Math.max(...bytes)} > 440 actual bytes`);
    for (const u of progress) {
      assert.equal(u.totalBytes, null);
      assert.equal(u.progress, null);
      assert.equal(u.stage, "Downloading");
    }
  });

  it("while the video half runs, progress never exceeds the video bytes: the append window is counted once", async () => {
    const p = plan();
    const video = [fragment("V", 1, 300), fragment("V", 2, 300)];
    let phase: GenericSplitRole = "video";
    const byPhase: Record<GenericSplitRole, number[]> = { video: [], audio: [] };
    const { run } = runner({
      // A LONG append window: most samples land while the fragment exists both
      // as a file and inside the aggregate.
      video: emulateFragmentFd(finalOf(p, "video"), { fragments: video, appendHoldMs: 60 }),
      audio: async (call) => {
        phase = "audio";
        return emulateFragmentFd(finalOf(p, "audio"), { fragments: [fragment("A", 1, 10)] })(call);
      },
    });
    await download(p, run, { onProgress: (u) => byPhase[phase].push(u.downloadedBytes ?? -1) });
    assert.ok(byPhase.video.length > 5, "the append windows must actually be sampled");
    assert.ok(Math.max(...byPhase.video) <= 600, `double-counted: ${Math.max(...byPhase.video)}`);
  });

  it("DASH video + HTTPS audio: each half monitored by its own grammar", async () => {
    const p = plan(DASH_VIDEO, { ...DASH_AUDIO, protocol: "https" });
    const video = [fragment("V", 1, 64), fragment("V", 2, 64)];
    const { run, calls } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), { fragments: video }),
      audio: progressiveChild(finalOf(p, "audio"), Buffer.alloc(33, "a")),
    });
    const res = await download(p, run);
    assert.match(argOf(calls[0]!, "--format=")!, /protocol="http_dash_segments"/);
    assert.match(argOf(calls[1]!, "--format=")!, /protocol="https"/);
    assert.equal(res.totalFileSize, 128 + 33);
    assert.deepEqual(readdirSync(workDir).sort(), ["audio-source.m4a", "video-source.mp4"]);
  });

  it("the bookkeeping file is JSON state, not media: it is never charged to the byte budget", async () => {
    // A 900-byte aggregate beside a (deliberately inflated) 200-byte .ytdl,
    // under a 1000-byte budget: charging the .ytdl would refuse a valid run.
    const p = plan();
    const { run } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), { fragments: [fragment("V", 1, 900)], ytdlBytes: 200 }),
      audio: emulateFragmentFd(finalOf(p, "audio"), { fragments: [fragment("A", 1, 100)], ytdlBytes: 200 }),
    });
    const res = await download(p, run, { maxFileSizeBytes: 1000 });
    assert.equal(res.totalFileSize, 1000);
  });

  it("a transient unexpected entry mid-run is tolerated, but its bytes still count", async () => {
    // `HOME`/`TMPDIR` point into the job directory, so a runtime temp file can
    // appear and vanish mid-run. It is not a failure — and it is not free.
    const p = plan();
    const { run } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), {
        fragments: [fragment("V", 1, 50), fragment("V", 2, 50)],
        onStep: async (step) => {
          if (step === "frag1:removed") writeFileSync(join(workDir, "tmpk2j3.tmp"), "t");
          if (step === "frag2:removed") unlinkSync(join(workDir, "tmpk2j3.tmp"));
        },
      }),
      audio: emulateFragmentFd(finalOf(p, "audio"), { fragments: [fragment("A", 1, 5)] }),
    });
    const res = await download(p, run);
    assert.equal(res.totalFileSize, 105);
  });
});

describe("segmented acquisition: the fragment-aware byte guard", () => {
  // Every overflow case parks the child in the named state; ONLY the guard can
  // end the run. Without fragment-aware accounting, the park is never broken
  // and the run times out instead (the tests would then fail on the code).
  const parked = (p: GenericSplitExecutionPlan, role: GenericSplitRole, e: Emulation, onAbort: (r: unknown) => void): Child => {
    const inner = emulateFragmentFd(finalOf(p, role), e);
    return async (call) => {
      call.signal?.addEventListener("abort", () => onAbort(call.signal?.reason), { once: true });
      return inner(call);
    };
  };
  const guardDeadline = { downloadTimeoutSeconds: 2 };

  it("an IN-FLIGHT fragment pushing aggregate + fragment past the budget is TOO_LARGE", async () => {
    const p = plan();
    let reason: unknown = null;
    const { run, calls } = runner({
      video: parked(p, "video", {
        fragments: [fragment("V", 1, 300), fragment("V", 2, 800)],
        holdAt: { fragment: 2, step: "in-flight" },
      }, (r) => (reason = r)),
    });
    const err = await rejectsWith("TOO_LARGE", () =>
      download(p, run, { maxFileSizeBytes: 1000, limits: { maxFileSizeBytes: 1000, ...guardDeadline } }),
    );
    // The aggregate alone (300) never crossed the budget: only counting the
    // fragment in flight can have caught this.
    assert.equal(readFileSync(join(workDir, "video-source.mp4.part")).length, 300);
    assert.ok(reason instanceof AppError && reason.code === "TOO_LARGE", "the guard itself aborted the child");
    assert.equal(calls.length, 1, "the audio half never starts");
    assertNoLeak(err);
  });

  it("a COMPLETED fragment not yet appended is still charged — even one never seen in flight", async () => {
    const p = plan();
    let reason: unknown = null;
    const { run } = runner({
      video: parked(p, "video", {
        fragments: [fragment("V", 1, 600), fragment("V", 2, 450)],
        skipInFlight: 2,
        holdAt: { fragment: 2, step: "complete" },
      }, (r) => (reason = r)),
    });
    await rejectsWith("TOO_LARGE", () =>
      download(p, run, { limits: { maxFileSizeBytes: 1000, ...guardDeadline } }),
    );
    assert.ok(reason instanceof AppError && reason.code === "TOO_LARGE");
    assert.ok(existsSync(join(workDir, "video-source.mp4.part-Frag2")), "parked in the complete state");
    assert.equal(readFileSync(join(workDir, "video-source.mp4.part")).length, 600, "the aggregate alone fit");
  });

  it("the APPEND WINDOW is charged once when the fragment was seen in flight: 900 of 1000 succeeds", async () => {
    // For the whole append window the fragment exists both as a file and inside
    // the aggregate. Charging it twice would refuse this legitimate run.
    const p = plan();
    const progress: number[] = [];
    let phase: GenericSplitRole = "video";
    const { run } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), { fragments: [fragment("V", 1, 900)], appendHoldMs: 60 }),
      audio: async (call) => {
        phase = "audio";
        return emulateFragmentFd(finalOf(p, "audio"), { fragments: [fragment("A", 1, 100)], appendHoldMs: 60 })(call);
      },
    });
    const res = await download(p, run, {
      maxFileSizeBytes: 1000,
      onProgress: (u) => {
        if (phase === "video") progress.push(u.downloadedBytes ?? -1);
      },
    });
    assert.equal(res.totalFileSize, 1000);
    assert.ok(progress.length > 5);
    assert.ok(Math.max(...progress) <= 900, `double-counted: ${Math.max(...progress)}`);
  });

  it("CONSERVATIVE fallback: a fragment never seen in flight is charged whole through its append window", async () => {
    // Documented behaviour, pinned so it cannot change silently: without an
    // in-flight observation the monitor cannot know how much of the fragment
    // the aggregate already holds, so the guard charges it whole (600 + 600 >
    // 1000) rather than risk under-counting. Progress never counts it twice.
    const p = plan();
    let reason: unknown = null;
    const { run } = runner({
      video: parked(p, "video", {
        fragments: [fragment("V", 1, 600)],
        skipInFlight: 1,
        holdAt: { fragment: 1, step: "appended" },
      }, (r) => (reason = r)),
    });
    await rejectsWith("TOO_LARGE", () =>
      download(p, run, { limits: { maxFileSizeBytes: 1000, ...guardDeadline } }),
    );
    assert.ok(reason instanceof AppError && reason.code === "TOO_LARGE");
  });

  it("the COMBINED ceiling: validated video + the audio half's fragment in flight", async () => {
    const p = plan();
    let reason: unknown = null;
    const { run, calls } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), { fragments: [fragment("V", 1, 700)] }),
      audio: parked(p, "audio", {
        fragments: [fragment("A", 1, 301)],
        holdAt: { fragment: 1, step: "in-flight" },
      }, (r) => (reason = r)),
    });
    await rejectsWith("TOO_LARGE", () =>
      download(p, run, { limits: { maxFileSizeBytes: 1000, ...guardDeadline } }),
    );
    assert.equal(argOf(calls[1]!, "--max-filesize="), "300", "the audio run gets only the remainder");
    assert.ok(reason instanceof AppError && reason.code === "TOO_LARGE");
    assert.equal(readFileSync(join(workDir, "audio-source.m4a.part")).length, 0, "nothing was appended yet");
  });

  it("an UNEXPECTED entry's bytes are charged too: no name escapes the ceiling", async () => {
    const p = plan();
    let reason: unknown = null;
    const { run } = runner({
      video: parked(p, "video", {
        fragments: [fragment("V", 1, 600)],
        holdAt: { fragment: 1, step: "appended" },
        onStep: (step) => {
          if (step === "frag1:appended") {
            // Simulate the fragment being staged under a name the grammar does not know.
            renameSync(join(workDir, "video-source.mp4.part-Frag1"), join(workDir, "stray.bin"));
          }
        },
      }, (r) => (reason = r)),
    });
    await rejectsWith("TOO_LARGE", () =>
      download(p, run, { limits: { maxFileSizeBytes: 1000, ...guardDeadline } }),
    );
    assert.ok(reason instanceof AppError && reason.code === "TOO_LARGE");
  });

  it("a fragment in flight exactly AT the remaining budget is not an overflow", async () => {
    const p = plan();
    const { run } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), { fragments: [fragment("V", 1, 400), fragment("V", 2, 300)] }),
      audio: emulateFragmentFd(finalOf(p, "audio"), { fragments: [fragment("A", 1, 300)] }),
    });
    const res = await download(p, run, { maxFileSizeBytes: 1000 });
    assert.equal(res.totalFileSize, 1000);
  });
});

describe("segmented acquisition: deadline, retries and cancellation", () => {
  it("fragment retries stay inside the ONE deadline: audio gets exactly what is left", async () => {
    let now = 1_000_000;
    const p = plan();
    const video = emulateFragmentFd(finalOf(p, "video"), {
      fragments: [fragment("V", 1, 50), fragment("V", 2, 50)],
      onStep: (step) => {
        if (step === "frag2:in-flight") {
          // A fragment retry: the in-flight `.part` is truncated and re-fetched,
          // costing time from the same budget.
          truncateSync(join(workDir, "video-source.mp4.part-Frag2.part"), 10);
          now += 12_000;
          writeFileSync(join(workDir, "video-source.mp4.part-Frag2.part"), fragment("V", 2, 50));
        }
      },
    });
    const { run, calls } = runner({
      video: async (call) => {
        const r = await video(call);
        now += 3_000;
        return r;
      },
      audio: emulateFragmentFd(finalOf(p, "audio"), { fragments: [fragment("A", 1, 5)] }),
    });
    await download(p, run, {
      clock: () => now,
      limits: { maxFileSizeBytes: 100_000, downloadTimeoutSeconds: 30 },
    });
    assert.equal(calls[0]!.timeoutMs, 30_000, "video: the whole budget (the probe took no time)");
    assert.equal(calls[1]!.timeoutMs, 15_000, "audio: only what the video's retries left");
  });

  it("a deadline that expires during a fragment is TIMEOUT, and the audio half never starts", async () => {
    const p = plan();
    const { run, calls } = runner({
      video: async () => {
        writeFileSync(join(workDir, "video-source.mp4.part"), fragment("V", 1, 20));
        writeFileSync(join(workDir, "video-source.mp4.part-Frag2.part"), fragment("V", 2, 7));
        await sleep(TICK_MS);
        // Exactly what the hardened runner does when `timeoutMs` elapses.
        throw new AppError("TIMEOUT");
      },
    });
    const err = await rejectsWith("TIMEOUT", () => download(p, run));
    assert.equal(calls.length, 1);
    assertNoLeak(err);
  });

  it("the audio half's run is refused TIMEOUT when the video used the whole deadline", async () => {
    let now = 0;
    const p = plan();
    const { run, calls } = runner({
      video: async (call) => {
        const r = await emulateFragmentFd(finalOf(p, "video"), { fragments: [fragment("V", 1, 5)] })(call);
        now += 30_000;
        return r;
      },
    });
    await rejectsWith("TIMEOUT", () =>
      download(p, run, { clock: () => now, limits: { maxFileSizeBytes: 100_000, downloadTimeoutSeconds: 30 } }),
    );
    assert.equal(calls.length, 1, "no audio run with no time left");
  });

  it("cancellation during a fragment stays a cancellation — never TOO_LARGE, even if bytes overflow after", async () => {
    const p = plan();
    const caller = new AbortController();
    const { run, calls } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), {
        fragments: [fragment("V", 1, 100), fragment("V", 2, 100)],
        holdAt: { fragment: 2, step: "in-flight" },
        onStep: (step) => {
          if (step === "frag2:in-flight") {
            caller.abort(new Error("user cancelled"));
            // Bytes that WOULD overflow land after the cancellation.
            writeFileSync(join(workDir, "video-source.mp4.part-Frag2.part"), fragment("V", 2, 5000));
          }
        },
      }),
    });
    await assert.rejects(
      () => download(p, run, { signal: caller.signal, maxFileSizeBytes: 1000 }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED" && err.message === "Download was cancelled.",
    );
    assert.equal(calls.length, 1);
  });
});

describe("segmented acquisition: exact completion — nothing but the artifact may remain", () => {
  const cases: Array<[string, Emulation]> = [
    ["a residual fragment", { fragments: [fragment("V", 1, 10), fragment("V", 2, 10)], leave: "fragment" }],
    ["a residual .ytdl", { fragments: [fragment("V", 1, 10)], leave: "ytdl" }],
    ["a residual aggregate .part", { fragments: [fragment("V", 1, 10)], leave: "part" }],
    ["a zero exit with NO final artifact", { fragments: [fragment("V", 1, 10)], dropFinal: true }],
  ];
  for (const [label, e] of cases) {
    it(`${label} after exit 0 is PROCESSING_FAILED, and the audio half never starts`, async () => {
      const p = plan();
      const { run, calls } = runner({ video: emulateFragmentFd(finalOf(p, "video"), e) });
      const err = await rejectsWith("PROCESSING_FAILED", () => download(p, run));
      assert.equal(calls.length, 1);
      assertNoLeak(err);
    });
  }

  it("an unexpected file present at completion is PROCESSING_FAILED", async () => {
    const p = plan();
    const { run } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), {
        fragments: [fragment("V", 1, 10)],
        onStep: (step) => {
          if (step === "finished") writeFileSync(join(workDir, "unexpected.json"), "{}");
        },
      }),
    });
    await rejectsWith("PROCESSING_FAILED", () => download(p, run));
  });

  it("a residual fragment of the AUDIO half is refused just the same", async () => {
    const p = plan();
    const { run, calls } = runner({
      video: emulateFragmentFd(finalOf(p, "video"), { fragments: [fragment("V", 1, 10)] }),
      audio: emulateFragmentFd(finalOf(p, "audio"), { fragments: [fragment("A", 1, 10)], leave: "fragment" }),
    });
    await rejectsWith("PROCESSING_FAILED", () => download(p, run));
    assert.equal(calls.length, 2);
  });

  it("a size-refusal witness on stdout is NEVER read for a segmented run", async () => {
    // A progressive run with this stdout and only its own `.part` left would be
    // the pinned refusal's shape B, i.e. TOO_LARGE. A segmented run's fragments
    // cannot print that line, so here it proves nothing and the directory proof
    // refuses the run.
    const p = plan();
    const { run } = runner({
      video: async () => {
        writeFileSync(join(workDir, "video-source.mp4.part"), "x".repeat(10));
        return {
          code: 0,
          stdout: "[download] File is larger than max-filesize (5000 bytes > 1000 bytes). Aborting.\n",
          stderr: "",
        };
      },
    });
    await rejectsWith("PROCESSING_FAILED", () => download(p, run, { maxFileSizeBytes: 1000 }));
  });
});

describe("segmented acquisition: failed runs keep canonical codes and leak nothing", () => {
  const failing = (stderr: string): Child => async () => {
    writeFileSync(join(workDir, "video-source.mp4.part"), "x");
    return { code: 1, stdout: `[dashsegments] Total fragments: 3\n${SENTINEL}\n`, stderr };
  };
  const table: Array<[string, string]> = [
    // An unavailable fragment ABORTS under `--abort-on-unavailable-fragments`.
    [`ERROR: fragment 2 not found, unable to continue\n`, "EXTRACTION_FAILED"],
    [`ERROR: [download] Got error: HTTP Error 404: Not Found ${SENTINEL}\n`, "EXTRACTION_FAILED"],
    [`ERROR: [download] Got error: The read operation timed out\n`, "TIMEOUT"],
    [`ERROR: [generic] x: Requested format is not available. ${SENTINEL}\n`, "FORMAT_UNAVAILABLE"],
    [`ERROR: unable to download video data: <urlopen error [Errno 111] Connection refused>\n`, "NETWORK_ERROR"],
  ];
  for (const [stderr, code] of table) {
    it(`${code}: ${stderr.trim().slice(0, 48)}`, async () => {
      const p = plan();
      const { run } = runner({ video: failing(stderr) });
      const err = await rejectsWith(code, () => download(p, run));
      assertNoLeak(err);
      assert.equal(err.message.includes("fragment"), false);
    });
  }
});

describe("segmented acquisition: the single-source downloader never acquires a DASH source", () => {
  it("a hand-built keep-original DASH plan is refused before any process or network work", async () => {
    const calls: unknown[] = [];
    let validated = 0;
    const forged = {
      strategy: "yt-dlp",
      operation: "keep-original",
      requestedFormatId: "preset:audio",
      source: DASH_AUDIO,
      targetContainer: "m4a",
    } as unknown as GenericSingleSourceExecutionPlan;
    await rejectsWith("FORMAT_UNAVAILABLE", () =>
      downloadGenericOriginal(SAFE_URL, workDir, forged, {
        limits: { maxFileSizeBytes: 1000, downloadTimeoutSeconds: 600 },
        probeRuntime: async () => {
          calls.push("probe");
          return OK_RUNTIME;
        },
        validateUrl: async (raw) => {
          validated += 1;
          return { url: raw, hostname: "example.invalid" };
        },
        runner: async () => {
          calls.push("run");
          return ok;
        },
      }),
    );
    assert.deepEqual(calls, []);
    assert.equal(validated, 0);
    assert.deepEqual(readdirSync(workDir), []);
  });

  it("control: the same plan on an HTTPS source is acquired", async () => {
    const p = {
      strategy: "yt-dlp",
      operation: "keep-original",
      requestedFormatId: "preset:audio",
      source: { ...DASH_AUDIO, protocol: "https" },
      targetContainer: "m4a",
    } as GenericSingleSourceExecutionPlan;
    const res = await downloadGenericOriginal(SAFE_URL, workDir, p, {
      limits: { maxFileSizeBytes: 1000, downloadTimeoutSeconds: 600 },
      probeRuntime: async () => OK_RUNTIME,
      validateUrl: async (raw) => ({ url: raw, hostname: "example.invalid" }),
      runner: async () => {
        writeFileSync(join(workDir, "source.m4a"), "abc");
        return ok;
      },
    });
    assert.equal(basename(res.filePath), "source.m4a");
  });
});
