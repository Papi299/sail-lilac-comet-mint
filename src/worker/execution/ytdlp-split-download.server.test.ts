import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { readdir as fsReaddir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../lib/errors.ts";
import {
  ProcessOutputLimitError,
  setProcessRunnerTestHooks,
  type RunResult,
} from "../../services/processing/process-runner.server.ts";
import { YTDLP_RUNTIME, type YtdlpRuntimeStatus } from "../runtime/ytdlp-runtime.server.ts";
import { buildGenericFormatSelector } from "./generic-source.ts";
import {
  GenericExecutionPlanSchema,
  type GenericSingleSourceExecutionPlan,
  type GenericSplitExecutionPlan,
} from "./format-plan.ts";
import {
  YTDLP_DOWNLOAD_FFMPEG_LOCATION,
  YTDLP_DOWNLOAD_MAX_STDERR_BYTES,
  YTDLP_DOWNLOAD_MAX_STDOUT_BYTES,
  YTDLP_DOWNLOAD_OUTPUT_BASENAME,
  YTDLP_DOWNLOAD_PATH,
  YTDLP_SPLIT_OUTPUT_BASENAMES,
  buildYtdlpSplitDownloadArgv,
  downloadGenericOriginal,
  downloadGenericSplitSources,
  expectedSplitPartPath,
  expectedSplitSourcePath,
  splitOutputTemplateFor,
  type GenericSplitRole,
} from "./ytdlp-download.server.ts";

/**
 * SPLIT-03: the dual-source acquisition primitive.
 *
 * Every test drives `downloadGenericSplitSources` through FAKE runners (or,
 * for the process-group proofs, the real hardened runner over a fake spawn
 * with a hooked `processKill`), so no network is touched, no real yt-dlp is
 * executed, and no real process group is ever signalled.
 */

const SENTINEL = "SUPER_SECRET_VALUE";
const SECRET_URL = `https://example.invalid/v?token=${SENTINEL}`;
const SAFE_URL = "https://example.invalid/watch/abc";

const MAX = 1000;
const LIMITS = { maxFileSizeBytes: MAX, downloadTimeoutSeconds: 600 };

const OK_RUNTIME: YtdlpRuntimeStatus = Object.freeze({
  available: true,
  version: YTDLP_RUNTIME.expectedVersion,
  reason: "ok" as const,
});

const ok: RunResult = { code: 0, stdout: "", stderr: "" };

type Sizes = { video?: number | null; audio?: number | null };

/** A valid MP4-family pair: mp4 video-only + m4a audio-only -> mp4. */
function mp4Plan(sizes: Sizes = {}): GenericSplitExecutionPlan {
  return {
    strategy: "yt-dlp",
    operation: "merge-split",
    requestedFormatId: "preset:1080",
    pair: {
      video: {
        formatId: "137",
        protocol: "https",
        container: "mp4",
        hasVideo: true,
        hasAudio: false,
        videoConstraint: "codec-present",
        audioConstraint: "absent",
        fileSize: sizes.video ?? null,
      },
      audio: {
        formatId: "140",
        protocol: "https",
        container: "m4a",
        hasVideo: false,
        hasAudio: true,
        videoConstraint: "absent",
        audioConstraint: "codec-present",
        fileSize: sizes.audio ?? null,
      },
    },
    targetContainer: "mp4",
  };
}

/** A valid WebM pair: BOTH members are `.webm`, so only the basename separates them. */
function webmPlan(sizes: Sizes = {}): GenericSplitExecutionPlan {
  return {
    strategy: "yt-dlp",
    operation: "merge-split",
    requestedFormatId: "preset:720",
    pair: {
      video: {
        formatId: "247",
        protocol: "https",
        container: "webm",
        hasVideo: true,
        hasAudio: false,
        videoConstraint: "codec-present",
        audioConstraint: "absent",
        fileSize: sizes.video ?? null,
      },
      audio: {
        formatId: "251",
        protocol: "https",
        container: "webm",
        hasVideo: false,
        hasAudio: true,
        videoConstraint: "absent",
        audioConstraint: "codec-present",
        fileSize: sizes.audio ?? null,
      },
    },
    targetContainer: "webm",
  };
}

type Deps = Parameters<typeof downloadGenericSplitSources>[3];
type RunnerCall = Parameters<NonNullable<Deps["runner"]>>[0];

let workDir = "";
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ytdlp-split-"));
});
afterEach(() => {
  setProcessRunnerTestHooks(null);
  rmSync(workDir, { recursive: true, force: true });
});

const containerOf = (plan: GenericSplitExecutionPlan, role: GenericSplitRole) =>
  plan.pair[role].container;
const finalOf = (plan: GenericSplitExecutionPlan, role: GenericSplitRole) =>
  expectedSplitSourcePath(workDir, role, containerOf(plan, role));
const partOf = (plan: GenericSplitExecutionPlan, role: GenericSplitRole) =>
  expectedSplitPartPath(workDir, role, containerOf(plan, role));

/** Which half a runner call is, read from its fixed output template. */
function roleOf(call: RunnerCall): GenericSplitRole {
  const out = call.args.find((a) => a.startsWith("--output="));
  if (out === `--output=${splitOutputTemplateFor(workDir, "video")}`) return "video";
  if (out === `--output=${splitOutputTemplateFor(workDir, "audio")}`) return "audio";
  throw new Error(`unexpected output template: ${String(out)}`);
}

const formatOf = (call: RunnerCall) => call.args.filter((a) => a.startsWith("--format="));
const argOf = (call: RunnerCall, prefix: string) =>
  call.args.find((a) => a.startsWith(prefix))?.slice(prefix.length);

type Half = (call: RunnerCall) => Promise<RunResult>;

/** A half that writes its real final artifact of `bytes` bytes and exits 0. */
function writes(plan: GenericSplitExecutionPlan, role: GenericSplitRole, bytes: number): Half {
  return async () => {
    writeFileSync(finalOf(plan, role), "x".repeat(bytes));
    return ok;
  };
}

/** A role-aware fake runner. Each call is recorded with its role. */
function splitRunner(plan: GenericSplitExecutionPlan, script: { video?: Half; audio?: Half } = {}) {
  const calls: RunnerCall[] = [];
  const runner = async (call: RunnerCall): Promise<RunResult> => {
    calls.push(call);
    const role = roleOf(call);
    const half = script[role] ?? writes(plan, role, role === "video" ? 7 : 3);
    return half(call);
  };
  return { runner, calls, roles: () => calls.map(roleOf) };
}

function forbiddenRunner() {
  const calls: RunnerCall[] = [];
  const runner = async (call: RunnerCall): Promise<RunResult> => {
    calls.push(call);
    throw new Error("a subprocess was spawned when none was permitted");
  };
  return { runner, calls };
}

function countingProbe(result: YtdlpRuntimeStatus = OK_RUNTIME) {
  const seen: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
  const probeRuntime = async (opts: { signal?: AbortSignal; timeoutMs?: number }) => {
    seen.push(opts);
    return result;
  };
  return { probeRuntime, seen };
}

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    limits: LIMITS,
    probeRuntime: async () => OK_RUNTIME,
    validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
    ...overrides,
  } as Deps;
}

async function rejectsWith(code: string, fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

/** A barrier the test controls explicitly. No sleeps, no timing luck. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains pending continuations a bounded number of event-loop turns. */
async function flush(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * Waits for a CONDITION, not for time. Bounded so a regression fails the test
 * with a message instead of hanging the runner.
 */
async function waitUntil(pred: () => boolean, what: string, timeoutMs = 3_000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A runner half that only ever settles by being aborted, like a killed group. */
function hangsUntilAborted(onAbort?: (reason: unknown) => void): Half {
  return (call) =>
    new Promise((_resolve, reject) => {
      call.signal?.addEventListener("abort", () => {
        onAbort?.(call.signal?.reason);
        reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
      });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 / §47 / §48: the plan boundary — a pair, and nothing else
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: plan boundary (§8/§47/§48)", () => {
  it("positive control: both valid pairs parse, and a valid MP4 pair succeeds", async () => {
    assert.equal(GenericExecutionPlanSchema.safeParse(mp4Plan()).success, true);
    assert.equal(GenericExecutionPlanSchema.safeParse(webmPlan()).success, true);
    const plan = mp4Plan();
    const { runner } = splitRunner(plan);
    const res = await downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner }));
    assert.equal(res.video.container, "mp4");
    assert.equal(res.audio.container, "m4a");
  });

  const single = (operation: "keep-original" | "extract-m4a" | "extract-mp3") => {
    const source = {
      formatId: "22",
      protocol: "https",
      container: "mp4",
      hasVideo: true,
      hasAudio: true,
      videoConstraint: "codec-present",
      audioConstraint: "codec-present",
      fileSize: null,
    } as const;
    const byOp = {
      "keep-original": { requestedFormatId: "preset:1080", targetContainer: "mp4" },
      "extract-m4a": { requestedFormatId: "preset:audio", targetContainer: "m4a" },
      "extract-mp3": { requestedFormatId: "preset:mp3", targetContainer: "mp3" },
    } as const;
    return { strategy: "yt-dlp", operation, source, ...byOp[operation] } as GenericSingleSourceExecutionPlan;
  };

  for (const operation of ["keep-original", "extract-m4a", "extract-mp3"] as const) {
    it(`refuses a single-source ${operation} plan: FORMAT_UNAVAILABLE, nothing runs`, async () => {
      const plan = single(operation);
      // A positive control: the plan is well-formed, so the refusal is the OPERATION's.
      assert.equal(GenericExecutionPlanSchema.safeParse(plan).success, true);
      const { runner, calls } = forbiddenRunner();
      const probe = countingProbe();
      let validated = 0;
      await rejectsWith("FORMAT_UNAVAILABLE", () =>
        downloadGenericSplitSources(
          SAFE_URL,
          workDir,
          plan as unknown as GenericSplitExecutionPlan,
          baseDeps({
            runner,
            probeRuntime: probe.probeRuntime,
            validateUrl: async (raw) => {
              validated += 1;
              return { url: raw, hostname: "example.invalid" };
            },
          }),
        ),
      );
      assert.equal(calls.length, 0);
      assert.equal(probe.seen.length, 0);
      assert.equal(validated, 0, "the plan is refused before the URL is even validated");
    });
  }

  const malformed: Array<[string, () => unknown]> = [
    ["target disagrees with the closed pair table", () => ({ ...mp4Plan(), targetContainer: "webm" })],
    ["preset:audio requested", () => ({ ...mp4Plan(), requestedFormatId: "preset:audio" })],
    ["preset:mp3 requested", () => ({ ...mp4Plan(), requestedFormatId: "preset:mp3" })],
    ["direct-original requested", () => ({ ...mp4Plan(), requestedFormatId: "direct-original" })],
    ["a non-yt-dlp strategy", () => ({ ...mp4Plan(), strategy: "direct" })],
    ["an extra field", () => ({ ...mp4Plan(), selector: "bestvideo+bestaudio" })],
    [
      "the same upstream id twice",
      () => {
        const p = mp4Plan();
        return { ...p, pair: { ...p.pair, audio: { ...p.pair.audio, formatId: "137" } } };
      },
    ],
    [
      "a cross-family pair (mp4 video + webm audio)",
      () => {
        const p = mp4Plan();
        return { ...p, pair: { ...p.pair, audio: { ...p.pair.audio, container: "webm" } } };
      },
    ],
    [
      "a video member whose audio is merely unknown",
      () => {
        const p = mp4Plan();
        return { ...p, pair: { ...p.pair, video: { ...p.pair.video, audioConstraint: "unknown" } } };
      },
    ],
    [
      "an unsafe id carrying yt-dlp merge grammar",
      () => {
        const p = mp4Plan();
        return { ...p, pair: { ...p.pair, video: { ...p.pair.video, formatId: "137+140" } } };
      },
    ],
    [
      "an HLS member",
      () => {
        const p = mp4Plan();
        return { ...p, pair: { ...p.pair, video: { ...p.pair.video, protocol: "m3u8_native" } } };
      },
    ],
  ];

  for (const [label, build] of malformed) {
    it(`refuses a hand-built malformed pair — ${label} — and spawns nothing`, async () => {
      const plan = build();
      assert.equal(GenericExecutionPlanSchema.safeParse(plan).success, false, "fixture must be invalid");
      const { runner, calls } = forbiddenRunner();
      const probe = countingProbe();
      await rejectsWith("FORMAT_UNAVAILABLE", () =>
        downloadGenericSplitSources(
          SAFE_URL,
          workDir,
          plan as GenericSplitExecutionPlan,
          baseDeps({ runner, probeRuntime: probe.probeRuntime }),
        ),
      );
      assert.equal(calls.length, 0);
      assert.equal(probe.seen.length, 0);
      assert.deepEqual(readdirSync(workDir), []);
    });
  }

  it("excludes single-source plans by TYPE (checked by tsc)", () => {
    const typeOnly = () => {
      // @ts-expect-error — a single-source plan is not a GenericSplitExecutionPlan.
      void downloadGenericSplitSources(SAFE_URL, workDir, single("keep-original"), baseDeps());
    };
    void typeOnly;
  });

  it("downloadGenericOriginal still refuses a merge-split plan, MP4 and WebM alike (§47)", async () => {
    for (const plan of [mp4Plan(), webmPlan()]) {
      const { runner, calls } = forbiddenRunner();
      const probe = countingProbe();
      await rejectsWith("FORMAT_UNAVAILABLE", () =>
        downloadGenericOriginal(SAFE_URL, workDir, plan, {
          ...baseDeps({ runner }),
          probeRuntime: probe.probeRuntime,
        }),
      );
      assert.equal(calls.length, 0);
      assert.equal(probe.seen.length, 0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 / §10 / §57: pre-flight ordering, ONE URL, ONE runtime probe
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: pre-flight ordering (§9/§10/§57)", () => {
  it("an unsafe URL spawns NOTHING — not even the version probe", async () => {
    const { runner, calls } = forbiddenRunner();
    const probe = countingProbe();
    await rejectsWith("INVALID_URL", () =>
      downloadGenericSplitSources(
        SAFE_URL,
        workDir,
        mp4Plan(),
        baseDeps({
          runner,
          probeRuntime: probe.probeRuntime,
          validateUrl: async () => {
            throw new AppError("INVALID_URL");
          },
        }),
      ),
    );
    assert.equal(calls.length, 0);
    assert.equal(probe.seen.length, 0);
  });

  it("validates the URL ONCE, and BOTH halves use that same validated URL", async () => {
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan);
    const canonical = "https://example.invalid/watch/abc?canonical=1";
    let validated = 0;
    await downloadGenericSplitSources(
      SAFE_URL,
      workDir,
      plan,
      baseDeps({
        runner,
        validateUrl: async () => {
          validated += 1;
          return { url: canonical, hostname: "example.invalid" };
        },
      }),
    );
    assert.equal(validated, 1);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.args[call.args.length - 1], canonical);
      assert.equal(call.args[call.args.length - 2], "--");
      assert.equal(call.args.includes(SAFE_URL), false, "the unvalidated input never runs");
    }
  });

  it("probes the pinned runtime ONCE for TWO acquisitions: probe -> video -> audio", async () => {
    const plan = mp4Plan();
    const events: string[] = [];
    const { runner, calls, roles } = splitRunner(plan, {
      video: async (call) => {
        events.push("video");
        return writes(plan, "video", 7)(call);
      },
      audio: async (call) => {
        events.push("audio");
        return writes(plan, "audio", 3)(call);
      },
    });
    let probes = 0;
    await downloadGenericSplitSources(
      SAFE_URL,
      workDir,
      plan,
      baseDeps({
        runner,
        probeRuntime: async () => {
          probes += 1;
          events.push("probe");
          return OK_RUNTIME;
        },
      }),
    );
    assert.equal(probes, 1, "exactly one runtime probe");
    assert.equal(calls.length, 2, "exactly two acquisition subprocesses");
    assert.deepEqual(roles(), ["video", "audio"]);
    assert.deepEqual(events, ["probe", "video", "audio"]);
  });

  it("an unavailable runtime acquires nothing: EXTRACTOR_UNAVAILABLE", async () => {
    const { runner, calls } = forbiddenRunner();
    await rejectsWith("EXTRACTOR_UNAVAILABLE", () =>
      downloadGenericSplitSources(
        SAFE_URL,
        workDir,
        mp4Plan(),
        baseDeps({
          runner,
          probeRuntime: async () => ({ available: false, version: null, reason: "version_mismatch" }),
        }),
      ),
    );
    assert.equal(calls.length, 0);
  });

  it("an already-cancelled caller gets no subprocess at all", async () => {
    const caller = new AbortController();
    caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
    const { runner, calls } = forbiddenRunner();
    const probe = countingProbe();
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, mp4Plan(), {
        ...baseDeps({ runner, probeRuntime: probe.probeRuntime }),
        signal: caller.signal,
      }),
    );
    assert.equal(calls.length, 0);
    assert.equal(probe.seen.length, 0);
  });

  it("refuses a relative workDir and a malformed byte limit before anything runs", async () => {
    for (const [dir, limits] of [
      ["relative/work", LIMITS],
      [workDir, { maxFileSizeBytes: 0, downloadTimeoutSeconds: 60 }],
      [workDir, { maxFileSizeBytes: 1.5, downloadTimeoutSeconds: 60 }],
    ] as const) {
      const { runner, calls } = forbiddenRunner();
      const probe = countingProbe();
      await rejectsWith("PROCESSING_FAILED", () =>
        downloadGenericSplitSources(
          SAFE_URL,
          dir,
          mp4Plan(),
          baseDeps({ runner, limits, probeRuntime: probe.probeRuntime }),
        ),
      );
      assert.equal(calls.length, 0);
      assert.equal(probe.seen.length, 0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §20-§23 / §54 / §55: the argv of EACH half
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: argv policy for BOTH halves (§20-§23/§54/§55)", () => {
  async function acquireMp4() {
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: writes(plan, "audio", 300),
    });
    const res = await downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner }));
    assert.equal(calls.length, 2);
    return { plan, calls, res, video: calls[0]!, audio: calls[1]! };
  }

  it("VIDEO: one selector built from pair.video only, fixed video basename, the whole budget", async () => {
    const { plan, video } = await acquireMp4();
    assert.deepEqual(formatOf(video), [`--format=${buildGenericFormatSelector(plan.pair.video)}`]);
    assert.deepEqual(formatOf(video), [
      '--format=b*[format_id="137"][protocol="https"][ext="mp4"][vcodec!="none"][acodec="none"]',
    ]);
    assert.equal(argOf(video, "--output="), join(workDir, "video-source.%(ext)s"));
    assert.equal(argOf(video, "--max-filesize="), "1000");
  });

  it("AUDIO: one selector built from pair.audio only, fixed audio basename, ONLY the remainder", async () => {
    const { plan, audio } = await acquireMp4();
    assert.deepEqual(formatOf(audio), [`--format=${buildGenericFormatSelector(plan.pair.audio)}`]);
    assert.deepEqual(formatOf(audio), [
      '--format=b*[format_id="140"][protocol="https"][ext="m4a"][vcodec="none"][acodec!="none"]',
    ]);
    assert.equal(argOf(audio, "--output="), join(workDir, "audio-source.%(ext)s"));
    // 1000 combined - 700 ACTUAL video bytes.
    assert.equal(argOf(audio, "--max-filesize="), "300");
  });

  it("each spawned argv IS the reviewed builder's output — nothing added by any caller", async () => {
    const { plan, video, audio } = await acquireMp4();
    const expected = (role: GenericSplitRole, maxFileSizeBytes: number) => [
      ...buildYtdlpSplitDownloadArgv({ validatedUrl: SAFE_URL, workDir, plan, role, maxFileSizeBytes }),
    ];
    assert.deepEqual(video.args, expected("video", 1000));
    assert.deepEqual(audio.args, expected("audio", 300));
  });

  it("never uses yt-dlp merge grammar: one --format per run, no '+', no bestvideo/bestaudio (§55)", async () => {
    const { video, audio } = await acquireMp4();
    for (const call of [video, audio]) {
      const formats = formatOf(call);
      assert.equal(formats.length, 1, "exactly one selector per subprocess");
      assert.equal(call.args.includes("-f"), false);
      assert.doesNotMatch(formats[0]!, /\+/, "no merge operator");
      assert.doesNotMatch(formats[0]!, /\//, "no fallback operator");
      assert.doesNotMatch(formats[0]!, /,/, "no selector list");
      assert.doesNotMatch(formats[0]!, /best(video|audio)?|mergeall/, "no yt-dlp choice atom");
      assert.equal(call.args.some((a) => /bestvideo|bestaudio/.test(a)), false);
    }
    // Each run names exactly its own member and never the other's.
    assert.match(formatOf(video)[0]!, /format_id="137"/);
    assert.doesNotMatch(formatOf(video)[0]!, /"140"/);
    assert.match(formatOf(audio)[0]!, /format_id="140"/);
    assert.doesNotMatch(formatOf(audio)[0]!, /"137"/);
  });

  it("keeps the closed acquisition policy intact in BOTH runs (§22)", async () => {
    const { video, audio } = await acquireMp4();
    const forbidden = [
      "-x",
      "--extract-audio",
      "--audio-format",
      "--merge-output-format",
      "--remux-video",
      "--recode-video",
      "--download-sections",
      "--exec",
      "--exec-before-download",
      "--downloader-args",
      "--external-downloader",
      "--external-downloader-args",
      "--postprocessor-args",
      "--write-info-json",
      "--write-thumbnail",
      "--write-subs",
      "--embed-thumbnail",
      "--embed-subs",
      "--cookies",
      "--username",
      "--password",
      "--netrc",
      "--proxy",
      "--load-info-json",
      "--no-part",
    ];
    for (const call of [video, audio]) {
      const a = call.args;
      assert.equal(call.command, YTDLP_RUNTIME.pythonPath);
      assert.equal(a[0], YTDLP_RUNTIME.artifactPath);
      for (const expected of [
        "--ignore-config",
        "--no-config-locations",
        "--no-plugin-dirs",
        "--no-js-runtimes",
        "--no-remote-components",
        "--no-update",
        "--no-cookies",
        "--no-cookies-from-browser",
        "--no-playlist",
        `--ffmpeg-location=${YTDLP_DOWNLOAD_FFMPEG_LOCATION}`,
        "--fixup=never",
        "--no-overwrites",
        "--concurrent-fragments=1",
        "--no-keep-fragments",
      ]) {
        assert.ok(a.includes(expected), `policy lost '${expected}'`);
      }
      assert.match(YTDLP_DOWNLOAD_FFMPEG_LOCATION, /^\/nonexistent\//);
      assert.equal(a.filter((x) => x.startsWith("--downloader")).length, 1);
      assert.ok(a.includes("--downloader=native"));
      for (const bad of forbidden) {
        assert.equal(
          a.some((x) => x === bad || x.startsWith(`${bad}=`)),
          false,
          `forbidden argument '${bad}' is present`,
        );
      }
      assert.equal(a.indexOf("--"), a.length - 2, "one bare -- separator, URL last");
      assert.equal(call.env?.PATH, YTDLP_DOWNLOAD_PATH, "a PATH that resolves nothing");
      assert.equal(call.env?.HOME, workDir);
      assert.equal(call.maxStdoutBytes, YTDLP_DOWNLOAD_MAX_STDOUT_BYTES);
      assert.equal(call.maxStderrBytes, YTDLP_DOWNLOAD_MAX_STDERR_BYTES);
    }
  });

  it("the role binds member AND basename in the builder; there is no other input", () => {
    const plan = mp4Plan();
    const build = (role: GenericSplitRole) =>
      buildYtdlpSplitDownloadArgv({ validatedUrl: SAFE_URL, workDir, plan, role, maxFileSizeBytes: 5 });
    const v = build("video");
    const a = build("audio");
    assert.ok(v.includes(`--format=${buildGenericFormatSelector(plan.pair.video)}`));
    assert.ok(v.includes(`--output=${join(workDir, "video-source.%(ext)s")}`));
    assert.ok(a.includes(`--format=${buildGenericFormatSelector(plan.pair.audio)}`));
    assert.ok(a.includes(`--output=${join(workDir, "audio-source.%(ext)s")}`));
    assert.ok(Object.isFrozen(v) && Object.isFrozen(a));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 / §16-§18 / §62: fixed, distinct, role-derived paths
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: fixed distinct role paths (§16-§18/§62)", () => {
  it("pins the two role basenames, distinct from each other and from `source`", () => {
    assert.deepEqual({ ...YTDLP_SPLIT_OUTPUT_BASENAMES }, {
      video: "video-source",
      audio: "audio-source",
    });
    assert.notEqual(YTDLP_SPLIT_OUTPUT_BASENAMES.video, YTDLP_SPLIT_OUTPUT_BASENAMES.audio);
    assert.notEqual(YTDLP_SPLIT_OUTPUT_BASENAMES.video, YTDLP_DOWNLOAD_OUTPUT_BASENAME);
    assert.notEqual(YTDLP_SPLIT_OUTPUT_BASENAMES.audio, YTDLP_DOWNLOAD_OUTPUT_BASENAME);
    assert.ok(Object.isFrozen(YTDLP_SPLIT_OUTPUT_BASENAMES));
  });

  it("MP4 pair: video-source.mp4 and audio-source.m4a, with distinct .part paths", async () => {
    const plan = mp4Plan();
    assert.equal(finalOf(plan, "video"), join(workDir, "video-source.mp4"));
    assert.equal(partOf(plan, "video"), join(workDir, "video-source.mp4.part"));
    assert.equal(finalOf(plan, "audio"), join(workDir, "audio-source.m4a"));
    assert.equal(partOf(plan, "audio"), join(workDir, "audio-source.m4a.part"));
    const { runner } = splitRunner(plan);
    const res = await downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner }));
    assert.equal(res.video.filePath, join(workDir, "video-source.mp4"));
    assert.equal(res.audio.filePath, join(workDir, "audio-source.m4a"));
  });

  it("WebM pair: TWO .webm sources that still never collide", async () => {
    const plan = webmPlan();
    const paths = [
      finalOf(plan, "video"),
      partOf(plan, "video"),
      finalOf(plan, "audio"),
      partOf(plan, "audio"),
    ];
    assert.deepEqual(paths, [
      join(workDir, "video-source.webm"),
      join(workDir, "video-source.webm.part"),
      join(workDir, "audio-source.webm"),
      join(workDir, "audio-source.webm.part"),
    ]);
    assert.equal(new Set(paths).size, 4);
    const { runner } = splitRunner(plan);
    const res = await downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner }));
    assert.notEqual(res.video.filePath, res.audio.filePath);
    assert.equal(res.video.container, "webm");
    assert.equal(res.audio.container, "webm");
    assert.deepEqual(readdirSync(workDir).sort(), ["audio-source.webm", "video-source.webm"]);
  });

  it("each template interpolates exactly ONE %(ext)s and nothing extractor-controlled", () => {
    for (const role of ["video", "audio"] as const) {
      const template = splitOutputTemplateFor(workDir, role);
      assert.equal(template, join(workDir, `${YTDLP_SPLIT_OUTPUT_BASENAMES[role]}.%(ext)s`));
      assert.equal(template.split("%(").length - 1, 1);
      for (const field of ["%(title)s", "%(id)s", "%(format_id)s", "%(uploader)s"]) {
        assert.equal(template.includes(field), false);
      }
    }
  });

  it("returns ONLY the private artifact shape: no id, selector, argv, URL or codec (§5)", async () => {
    const plan = mp4Plan();
    const { runner } = splitRunner(plan);
    const res = await downloadGenericSplitSources(SECRET_URL, workDir, plan, baseDeps({ runner }));
    assert.deepEqual(Object.keys(res).sort(), ["audio", "totalFileSize", "video"]);
    for (const member of [res.video, res.audio]) {
      assert.deepEqual(Object.keys(member).sort(), ["container", "filePath", "fileSize"]);
      assert.equal(member.filePath.includes(SENTINEL), false);
    }
    assert.match(res.video.filePath, /\/video-source\.mp4$/);
    assert.match(res.audio.filePath, /\/audio-source\.m4a$/);
    assert.equal(res.totalFileSize, res.video.fileSize + res.audio.fileSize);
  });
});

/**
 * A half that settles when the operation's signal aborts it — like a killed
 * process group — or, if nothing ever aborts it, runs `fallback` after `ms`.
 *
 * The fallback keeps a regressed guard from hanging the suite: the test then
 * fails on its assertion about WHO aborted, promptly, instead of timing out.
 */
function settlesOnAbortOr(ms: number, fallback: Half, onAbort?: (reason: unknown) => void): Half {
  return (call) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fallback(call).then(resolve, reject);
      }, ms);
      call.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        onAbort?.(call.signal?.reason);
        reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
      });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 / §56: strictly sequential, video first
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: strictly sequential, video first (§7/§56)", () => {
  it("audio never starts while video is pending, nor before the video artifact validates", async () => {
    const plan = mp4Plan();
    const events: string[] = [];
    const videoStarted = deferred();
    const releaseVideo = deferred();
    const { runner } = splitRunner(plan, {
      video: async () => {
        events.push("start:video");
        videoStarted.resolve();
        await releaseVideo.promise;
        writeFileSync(finalOf(plan, "video"), "VIDEO");
        events.push("end:video");
        return ok;
      },
      audio: async () => {
        events.push("start:audio");
        writeFileSync(finalOf(plan, "audio"), "AUD");
        events.push("end:audio");
        return ok;
      },
    });
    const readDir = async (path: string) => {
      const entries = await fsReaddir(path);
      events.push(`readdir:[${[...entries].sort().join(",")}]`);
      return entries;
    };

    const pending = downloadGenericSplitSources(
      SAFE_URL,
      workDir,
      plan,
      baseDeps({
        runner,
        readDir,
        probeRuntime: async () => {
          events.push("probe");
          return OK_RUNTIME;
        },
      }),
    );

    await videoStarted.promise;
    await flush(8);
    assert.deepEqual(
      events,
      ["probe", "readdir:[]", "start:video"],
      "the audio acquisition must not overlap the pending video acquisition",
    );

    releaseVideo.resolve();
    await pending;
    assert.deepEqual(events, [
      "probe",
      "readdir:[]",
      "start:video",
      "end:video",
      // post-video exact state, then the pre-audio exact state
      "readdir:[video-source.mp4]",
      "readdir:[video-source.mp4]",
      "start:audio",
      "end:audio",
      "readdir:[audio-source.m4a,video-source.mp4]",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §11 / §12 / §58: ONE total deadline
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: ONE shared deadline (§11/§12/§58)", () => {
  function clockedRun(opts: { budgetSeconds: number; probeMs: number; videoMs: number }) {
    let now = 5_000_000;
    const clock = () => now;
    const plan = mp4Plan();
    const probeBudgets: number[] = [];
    const { runner, calls } = splitRunner(plan, {
      video: async (call) => {
        now += opts.videoMs;
        return writes(plan, "video", 7)(call);
      },
    });
    const run = () =>
      downloadGenericSplitSources(
        SAFE_URL,
        workDir,
        plan,
        baseDeps({
          runner,
          clock,
          limits: { maxFileSizeBytes: MAX, downloadTimeoutSeconds: opts.budgetSeconds },
          probeRuntime: async (o) => {
            probeBudgets.push(o.timeoutMs ?? -1);
            now += opts.probeMs;
            return OK_RUNTIME;
          },
        }),
      );
    return { run, calls, probeBudgets };
  }

  it("probe 2s + video 18s of a 30s budget leaves audio EXACTLY 10s — never a fresh 30s", async () => {
    const { run, calls, probeBudgets } = clockedRun({ budgetSeconds: 30, probeMs: 2_000, videoMs: 18_000 });
    await run();
    // The probe never gets more than its own conservative maximum.
    assert.deepEqual(probeBudgets, [15_000]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.timeoutMs, 28_000, "video gets what the probe left");
    assert.equal(calls[1]!.timeoutMs, 10_000, "audio gets ONLY what probe + video left");
  });

  it("probe + video consuming the whole budget is TIMEOUT before audio is spawned", async () => {
    const { run, calls } = clockedRun({ budgetSeconds: 30, probeMs: 2_000, videoMs: 28_000 });
    await rejectsWith("TIMEOUT", run);
    assert.equal(calls.length, 1);
    assert.equal(roleOf(calls[0]!), "video");
  });

  it("a probe consuming the whole budget is TIMEOUT before any acquisition", async () => {
    const { run, calls } = clockedRun({ budgetSeconds: 30, probeMs: 30_000, videoMs: 0 });
    await rejectsWith("TIMEOUT", run);
    assert.equal(calls.length, 0);
  });

  it("is bounded by the SAME configured budget and floor as a single source", async () => {
    // 0.2s floors to the 1s acquisition minimum — for the whole pair, not per half.
    const { run, calls, probeBudgets } = clockedRun({ budgetSeconds: 0.2, probeMs: 0, videoMs: 0 });
    await run();
    assert.deepEqual(probeBudgets, [1_000]);
    assert.equal(calls[0]!.timeoutMs, 1_000);
    assert.equal(calls[1]!.timeoutMs, 1_000);

    const singleDir = mkdtempSync(join(tmpdir(), "ytdlp-single-"));
    try {
      let singleBudget = 0;
      await downloadGenericOriginal(
        SAFE_URL,
        singleDir,
        {
          strategy: "yt-dlp",
          operation: "keep-original",
          requestedFormatId: "preset:1080",
          source: {
            ...mp4Plan().pair.video,
            formatId: "22",
            hasAudio: true,
            audioConstraint: "codec-present",
          },
          targetContainer: "mp4",
        },
        baseDeps({
          clock: () => 7,
          limits: { maxFileSizeBytes: MAX, downloadTimeoutSeconds: 0.2 },
          runner: async (call) => {
            singleBudget = call.timeoutMs;
            writeFileSync(join(singleDir, "source.mp4"), "x");
            return ok;
          },
        }),
      );
      assert.equal(singleBudget, 1_000, "the single-source budget is the same");
    } finally {
      rmSync(singleDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §13-§15 / §24-§27 / §59 / §60: ONE combined byte budget, on ACTUAL bytes
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: ONE combined byte budget (§13-§15/§24-§27/§59/§60)", () => {
  const limits = { maxFileSizeBytes: 1000, downloadTimeoutSeconds: 60 };
  const run = (plan: GenericSplitExecutionPlan, runner: Deps["runner"], extra: Partial<Deps> = {}) =>
    downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner, limits, ...extra }));

  it("video 700 leaves audio an allowance of 300; audio 300 succeeds AT the combined limit", async () => {
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: writes(plan, "audio", 300),
    });
    const res = await run(plan, runner);
    assert.equal(argOf(calls[0]!, "--max-filesize="), "1000");
    assert.equal(argOf(calls[1]!, "--max-filesize="), "300");
    assert.equal(res.video.fileSize, 700);
    assert.equal(res.audio.fileSize, 300);
    assert.equal(res.totalFileSize, 1000);
  });

  it("audio 301 after video 700 is TOO_LARGE — the halves never get independent allowances", async () => {
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: writes(plan, "audio", 301),
    });
    await rejectsWith("TOO_LARGE", () => run(plan, runner));
    assert.equal(argOf(calls[1]!, "--max-filesize="), "300", "never the full 1000 for audio");
  });

  it("the LIVE guard aborts the audio child once video + observed audio exceed the limit", async () => {
    const plan = mp4Plan();
    let reason: unknown = null;
    const { runner } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: async (call) => {
        // 301 observed audio bytes: under the 1000 limit alone, over it combined.
        writeFileSync(partOf(plan, "audio"), "x".repeat(301));
        return settlesOnAbortOr(1_000, writes(plan, "audio", 301), (r) => {
          reason = r;
        })(call);
      },
    });
    await rejectsWith("TOO_LARGE", () => run(plan, runner, { sizePollMs: 1 }));
    assert.ok(
      reason instanceof AppError && reason.code === "TOO_LARGE",
      "the combined byte guard itself must abort the owned process group",
    );
  });

  it("the LIVE guard aborts the video child past the limit, and audio never starts", async () => {
    const plan = mp4Plan();
    let reason: unknown = null;
    const { runner, calls } = splitRunner(plan, {
      video: async (call) => {
        writeFileSync(partOf(plan, "video"), "x".repeat(1001));
        return settlesOnAbortOr(1_000, writes(plan, "video", 1001), (r) => {
          reason = r;
        })(call);
      },
    });
    await rejectsWith("TOO_LARGE", () => run(plan, runner, { sizePollMs: 1 }));
    assert.ok(reason instanceof AppError && reason.code === "TOO_LARGE");
    assert.equal(calls.length, 1, "no audio after a video overflow");
  });

  it("video 1000 of 1000 leaves NO allowance: audio is never started, TOO_LARGE", async () => {
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan, { video: writes(plan, "video", 1000) });
    await rejectsWith("TOO_LARGE", () => run(plan, runner));
    assert.equal(calls.length, 1);
  });

  it("metadata that lies LOW (100 + 100) authorizes nothing: actual bytes decide", async () => {
    const plan = mp4Plan({ video: 100, audio: 100 });
    const { runner } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: writes(plan, "audio", 301),
    });
    await rejectsWith("TOO_LARGE", () => run(plan, runner));
  });

  it("ABSENT metadata (null sizes) with actual bytes within the limit succeeds", async () => {
    const plan = mp4Plan({ video: null, audio: null });
    const { runner } = splitRunner(plan, {
      video: writes(plan, "video", 600),
      audio: writes(plan, "audio", 400),
    });
    const res = await run(plan, runner);
    assert.equal(res.totalFileSize, 1000);
  });

  it("metadata that lies HIGH (900 + 900 > 1000) is not a refusal on its own", async () => {
    // Pinned behaviour: reported sizes are progress hints only, in BOTH
    // directions, so actual bytes within the limit succeed.
    const plan = mp4Plan({ video: 900, audio: 900 });
    const { runner, calls } = splitRunner(plan, {
      video: writes(plan, "video", 600),
      audio: writes(plan, "audio", 300),
    });
    const res = await run(plan, runner);
    assert.equal(res.totalFileSize, 900);
    assert.equal(argOf(calls[1]!, "--max-filesize="), "400", "the allowance follows ACTUAL video bytes");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YTDLP-MAX-FILESIZE-REFUSAL-CLASSIFICATION-001: the pinned --max-filesize
// refusal of EITHER half is TOO_LARGE, bound to that half's own allowance
// ─────────────────────────────────────────────────────────────────────────────

/** The exact line the pinned `HttpFD` prints on a `--max-filesize` refusal. */
const refusalLine = (declared: number, ceiling: number) =>
  `\r[download] File is larger than max-filesize (${declared} bytes > ${ceiling} bytes). Aborting.\n`;

/** A half the pinned runtime refuses: exits 0, writes nothing, ends stdout with the refusal. */
function refusesAt(declared: number, ceiling: number): Half {
  return async () => ({
    code: 0,
    stdout: `[info] abc: Downloading 1 format(s): x\n${refusalLine(declared, ceiling)}`,
    stderr: "",
  });
}

describe("split download: the pinned --max-filesize refusal (YTDLP-MAX-FILESIZE-REFUSAL-CLASSIFICATION-001)", () => {
  const limits = { maxFileSizeBytes: 1000, downloadTimeoutSeconds: 60 };

  it("VIDEO refused: one probe, the video run only, TOO_LARGE, no pair", async () => {
    const plan = mp4Plan();
    const probe = countingProbe();
    const { runner, calls, roles } = splitRunner(plan, { video: refusesAt(4000, 1000) });
    let returned: unknown = "never";
    await rejectsWith("TOO_LARGE", async () => {
      returned = await downloadGenericSplitSources(
        SAFE_URL,
        workDir,
        plan,
        baseDeps({ runner, limits, probeRuntime: probe.probeRuntime }),
      );
    });
    assert.equal(returned, "never", "no pair crosses the boundary");
    assert.equal(probe.seen.length, 1, "exactly one runtime probe");
    assert.deepEqual(roles(), ["video"], "the audio half is never started");
    assert.equal(argOf(calls[0]!, "--max-filesize="), "1000", "the video half carries the whole budget");
    assert.deepEqual(readdirSync(workDir), [], "nothing was acquired");
  });

  it("AUDIO refused after video 700: the audio run carries exactly 300 and is TOO_LARGE", async () => {
    const plan = mp4Plan();
    const probe = countingProbe();
    const { runner, calls, roles } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: refusesAt(450, 300),
    });
    let returned: unknown = "never";
    await rejectsWith("TOO_LARGE", async () => {
      returned = await downloadGenericSplitSources(
        SAFE_URL,
        workDir,
        plan,
        baseDeps({ runner, limits, probeRuntime: probe.probeRuntime }),
      );
    });
    assert.equal(returned, "never", "no pair crosses the boundary");
    assert.equal(probe.seen.length, 1, "ONE probe for the whole operation");
    assert.deepEqual(roles(), ["video", "audio"], "video first, audio second, nothing after");
    assert.equal(argOf(calls[0]!, "--max-filesize="), "1000");
    assert.equal(argOf(calls[1]!, "--max-filesize="), "300", "the audio allowance is the remainder");
    // Acquisition merges nothing and deletes nothing: the validated video half
    // is left for the executor's own cleanup.
    assert.deepEqual(readdirSync(workDir), ["video-source.mp4"]);
  });

  it("an AUDIO refusal naming the WHOLE budget is not this run's refusal: PROCESSING_FAILED", async () => {
    const plan = mp4Plan();
    const { runner } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: refusesAt(4000, 1000),
    });
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner, limits })),
    );
  });

  it("a zero exit that leaves nothing WITHOUT the witness stays PROCESSING_FAILED, either half", async () => {
    for (const role of ["video", "audio"] as const) {
      resetWorkDir();
      const plan = mp4Plan();
      const silent: Half = async () => ({ code: 0, stdout: "[info] abc: Downloading 1 format(s): x\n", stderr: "" });
      const { runner } = splitRunner(
        plan,
        role === "video" ? { video: silent } : { video: writes(plan, "video", 700), audio: silent },
      );
      await rejectsWith("PROCESSING_FAILED", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner, limits })),
      );
    }
  });

  // ── a LATER-chunk refusal: the refused half's own partial `.part` ────────
  //
  // A chunked source (`downloader_options.http_chunk_size`) is fetched as a
  // sequence of responses; the pinned check adds the bytes already held, so a
  // later chunk is refused after the earlier ones filled the half's `.part`.

  /** A half refused on a LATER chunk, with `bytes` already in its own `.part`. */
  const refusesLaterAt =
    (plan: GenericSplitExecutionPlan, role: GenericSplitRole, bytes: number, declared: number, ceiling: number): Half =>
    async (call) => {
      writeFileSync(partOf(plan, role), "x".repeat(bytes));
      return refusesAt(declared, ceiling)(call);
    };

  it("VIDEO refused on a LATER chunk: TOO_LARGE, one probe, no audio run, no pair, its .part left for the executor", async () => {
    const plan = mp4Plan();
    const probe = countingProbe();
    const { runner, calls, roles } = splitRunner(plan, {
      video: refusesLaterAt(plan, "video", 600, 1600, 1000),
    });
    let returned: unknown = "never";
    await rejectsWith("TOO_LARGE", async () => {
      returned = await downloadGenericSplitSources(
        SAFE_URL,
        workDir,
        plan,
        baseDeps({ runner, limits, probeRuntime: probe.probeRuntime }),
      );
    });
    assert.equal(returned, "never", "no pair crosses the boundary");
    assert.equal(probe.seen.length, 1, "exactly one runtime probe");
    assert.deepEqual(roles(), ["video"], "the audio half is never started");
    assert.equal(argOf(calls[0]!, "--max-filesize="), "1000");
    assert.deepEqual(readdirSync(workDir), ["video-source.mp4.part"], "nothing deleted, nothing else");
  });

  it("AUDIO refused on a LATER chunk after video 700: exactly 300, TOO_LARGE, the video and the audio .part left", async () => {
    for (const plan of [mp4Plan(), webmPlan()]) {
      resetWorkDir();
      const probe = countingProbe();
      const { runner, calls, roles } = splitRunner(plan, {
        video: writes(plan, "video", 700),
        audio: refusesLaterAt(plan, "audio", 200, 450, 300),
      });
      let returned: unknown = "never";
      await rejectsWith("TOO_LARGE", async () => {
        returned = await downloadGenericSplitSources(
          SAFE_URL,
          workDir,
          plan,
          baseDeps({ runner, limits, probeRuntime: probe.probeRuntime }),
        );
      });
      const ext = plan.pair.audio.container;
      assert.equal(returned, "never", `${ext}: no pair, so nothing to merge`);
      assert.equal(probe.seen.length, 1);
      assert.deepEqual(roles(), ["video", "audio"]);
      assert.equal(argOf(calls[1]!, "--max-filesize="), "300", `${ext}: the audio allowance is the remainder`);
      assert.deepEqual(
        readdirSync(workDir).sort(),
        [`audio-source.${ext}.part`, `video-source.${plan.pair.video.container}`].sort(),
      );
      assert.equal(readFileSync(finalOf(plan, "video")).byteLength, 700, "the validated video is untouched");
    }
  });

  it("the audio .part is bounded by the REMAINDER, not the combined budget", async () => {
    // With the watcher observing nothing, only the shape proof decides: up to
    // 300 is the genuine shape; 301 or 999 — within the combined 1000, but not
    // within what the video left — is not, and stays PROCESSING_FAILED.
    for (const [bytes, expected] of [
      [300, "TOO_LARGE"],
      [301, "PROCESSING_FAILED"],
      [999, "PROCESSING_FAILED"],
    ] as const) {
      resetWorkDir();
      const plan = mp4Plan();
      const { runner } = splitRunner(plan, {
        video: writes(plan, "video", 700),
        audio: refusesLaterAt(plan, "audio", bytes, 4000, 300),
      });
      await rejectsWith(expected, () =>
        downloadGenericSplitSources(
          SAFE_URL,
          workDir,
          plan,
          baseDeps({ runner, limits, statSize: async () => null }),
        ),
      );
    }
  });

  it("an AUDIO refusal naming the WHOLE budget beside its .part is not this run's refusal: PROCESSING_FAILED", async () => {
    const plan = mp4Plan();
    const { runner } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: refusesLaterAt(plan, "audio", 200, 4000, 1000),
    });
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner, limits })),
    );
  });

  it("only the AUDIO half's own .part qualifies beside the video", async () => {
    const shapes: Array<[string, (plan: GenericSplitExecutionPlan) => void]> = [
      ["the video's .part name", (plan) => writeFileSync(partOf(plan, "video"), "x".repeat(200))],
      [
        "the audio .part beside a final audio artifact",
        (plan) => {
          writeFileSync(partOf(plan, "audio"), "x".repeat(200));
          writeFileSync(finalOf(plan, "audio"), "x".repeat(100));
        },
      ],
      [
        "the audio .part beside a side file",
        (plan) => {
          writeFileSync(partOf(plan, "audio"), "x".repeat(200));
          writeFileSync(join(workDir, "audio-source.info.json"), "{}");
        },
      ],
    ];
    for (const [label, shape] of shapes) {
      resetWorkDir();
      const plan = mp4Plan();
      const { runner } = splitRunner(plan, {
        video: writes(plan, "video", 700),
        audio: async (call) => {
          shape(plan);
          return refusesAt(450, 300)(call);
        },
      });
      await assert.rejects(
        () => downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner, limits })),
        (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
        label,
      );
    }
  });

  it("either refusal shape needs the validated VIDEO intact: truncated, grown, symlinked or removed is PROCESSING_FAILED", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ytdlp-split-outside-"));
    try {
      const sameSize = join(outside, "same-size.bin");
      writeFileSync(sameSize, "x".repeat(700));
      const tamperings: Array<[string, (plan: GenericSplitExecutionPlan) => void]> = [
        ["truncated", (plan) => writeFileSync(finalOf(plan, "video"), "x".repeat(699))],
        ["grown", (plan) => appendFileSync(finalOf(plan, "video"), "y")],
        [
          "replaced by a same-size symlink",
          (plan) => {
            rmSync(finalOf(plan, "video"));
            symlinkSync(sameSize, finalOf(plan, "video"));
          },
        ],
        ["removed", (plan) => rmSync(finalOf(plan, "video"))],
      ];
      for (const [label, tamper] of tamperings) {
        for (const withPart of [false, true]) {
          resetWorkDir();
          const plan = mp4Plan();
          const { runner } = splitRunner(plan, {
            video: writes(plan, "video", 700),
            audio: async (call) => {
              tamper(plan);
              if (withPart) writeFileSync(partOf(plan, "audio"), "x".repeat(200));
              return refusesAt(450, 300)(call);
            },
          });
          await assert.rejects(
            () =>
              downloadGenericSplitSources(
                SAFE_URL,
                workDir,
                plan,
                baseDeps({ runner, limits, statSize: async () => null }),
              ),
            (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
            `${label}, ${withPart ? "with" : "without"} the audio .part`,
          );
        }
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("audio: the caller cancels FIRST beside the audio .part — the cancellation stands", async () => {
    const plan = mp4Plan();
    const caller = new AbortController();
    const { runner } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: async (call) => {
        writeFileSync(partOf(plan, "audio"), "x".repeat(200));
        caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
        return refusesAt(450, 300)(call);
      },
    });
    await assert.rejects(
      () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, {
          ...baseDeps({ runner, limits }),
          signal: caller.signal,
        }),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "PROCESSING_FAILED" &&
        err.message === "Download was cancelled.",
    );
  });

  it("audio: the caller cancels FIRST, then the run exits 0 with the witness — the cancellation stands", async () => {
    const plan = mp4Plan();
    const caller = new AbortController();
    const { runner, roles } = splitRunner(plan, {
      video: writes(plan, "video", 700),
      audio: async (call) => {
        caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
        return refusesAt(450, 300)(call);
      },
    });
    await assert.rejects(
      () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, {
          ...baseDeps({ runner, limits }),
          signal: caller.signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "PROCESSING_FAILED", "never TOO_LARGE");
        assert.equal(err.message, "Download was cancelled.");
        return true;
      },
    );
    assert.deepEqual(roles(), ["video", "audio"]);
  });
});

/** Empties the job directory between sub-cases of one test. */
function resetWorkDir() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// §19 / §38-§41 / §45 / §61: exact, role-aware directory states
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: exact directory states (§19/§41/§45/§61)", () => {
  type Setup = (plan: GenericSplitExecutionPlan) => void;

  const atEntry: Array<[string, Setup]> = [
    ["a stale video artifact", (plan) => writeFileSync(finalOf(plan, "video"), "OLD")],
    ["a stale video .part", (plan) => writeFileSync(partOf(plan, "video"), "OLD")],
    ["a pre-existing audio artifact", (plan) => writeFileSync(finalOf(plan, "audio"), "OLD")],
    ["a stale audio .part", (plan) => writeFileSync(partOf(plan, "audio"), "OLD")],
    ["an unrelated side file", () => writeFileSync(join(workDir, "notes.txt"), "x")],
    ["a stray directory", () => mkdirSync(join(workDir, ".cache"))],
  ];
  for (const [label, setup] of atEntry) {
    it(`entry must be EMPTY: refuses ${label}, spawns nothing, deletes nothing`, async () => {
      const plan = mp4Plan();
      setup(plan);
      const before = readdirSync(workDir).sort();
      const { runner, calls } = forbiddenRunner();
      await rejectsWith("PROCESSING_FAILED", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner })),
      );
      assert.equal(calls.length, 0);
      assert.deepEqual(readdirSync(workDir).sort(), before, "nothing is deleted and continued past");
    });
  }

  const afterVideo: Array<[string, Setup]> = [
    [
      "a surviving video .part",
      (plan) => {
        writeFileSync(finalOf(plan, "video"), "V");
        writeFileSync(partOf(plan, "video"), "V");
      },
    ],
    [
      "a retained fragment",
      (plan) => {
        writeFileSync(finalOf(plan, "video"), "V");
        writeFileSync(`${finalOf(plan, "video")}.part-Frag1`, "F");
      },
    ],
    [
      "a second video file",
      (plan) => {
        writeFileSync(finalOf(plan, "video"), "V");
        writeFileSync(join(workDir, "video-source.webm"), "V2");
      },
    ],
    ["the wrong extension", () => writeFileSync(join(workDir, "video-source.webm"), "V")],
    [
      "an early audio entry (§41)",
      (plan) => {
        writeFileSync(finalOf(plan, "video"), "V");
        writeFileSync(partOf(plan, "audio"), "A");
      },
    ],
    ["no artifact at all", () => {}],
  ];
  for (const [label, setup] of afterVideo) {
    it(`after VIDEO: refuses ${label}, and audio is never spawned`, async () => {
      const plan = mp4Plan();
      const { runner, calls } = splitRunner(plan, {
        video: async () => {
          setup(plan);
          return ok;
        },
      });
      await rejectsWith("PROCESSING_FAILED", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner })),
      );
      assert.equal(calls.length, 1);
    });
  }

  const afterAudio: Array<[string, Setup]> = [
    [
      "a thumbnail",
      (plan) => {
        writeFileSync(finalOf(plan, "audio"), "A");
        writeFileSync(join(workDir, "audio-source.jpg"), "J");
      },
    ],
    [
      "a retained fragment",
      (plan) => {
        writeFileSync(finalOf(plan, "audio"), "A");
        writeFileSync(`${finalOf(plan, "audio")}.part-Frag1`, "F");
      },
    ],
    [
      "a metadata JSON",
      (plan) => {
        writeFileSync(finalOf(plan, "audio"), "A");
        writeFileSync(join(workDir, "audio-source.info.json"), "{}");
      },
    ],
    [
      "a third media file",
      (plan) => {
        writeFileSync(finalOf(plan, "audio"), "A");
        writeFileSync(join(workDir, "merged.mp4"), "M");
      },
    ],
    [
      "a surviving audio .part",
      (plan) => {
        writeFileSync(finalOf(plan, "audio"), "A");
        writeFileSync(partOf(plan, "audio"), "A");
      },
    ],
    ["the wrong extension", () => writeFileSync(join(workDir, "audio-source.webm"), "A")],
    ["no artifact at all", () => {}],
  ];
  for (const [label, setup] of afterAudio) {
    it(`after AUDIO: refuses ${label}`, async () => {
      const plan = mp4Plan();
      const { runner, calls } = splitRunner(plan, {
        audio: async () => {
          setup(plan);
          return ok;
        },
      });
      await rejectsWith("PROCESSING_FAILED", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner })),
      );
      assert.equal(calls.length, 2);
    });
  }

  it("directory enumeration ORDER does not matter", async () => {
    for (const order of ["ascending", "descending"] as const) {
      resetWorkDir();
      const plan = mp4Plan();
      const { runner } = splitRunner(plan);
      const readDir = async (p: string) => {
        const sorted = (await fsReaddir(p)).sort();
        return order === "ascending" ? sorted : sorted.reverse();
      };
      const res = await downloadGenericSplitSources(
        SAFE_URL,
        workDir,
        plan,
        baseDeps({ runner, readDir }),
      );
      assert.equal(res.audio.container, "m4a", order);
    }
  });

  it("a duplicated entry is never mistaken for the expected pair", async () => {
    const plan = mp4Plan();
    const { runner } = splitRunner(plan);
    const readDir = async (p: string) => {
      const entries = await fsReaddir(p);
      return entries.length === 2 ? [entries[0]!, entries[0]!] : entries;
    };
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner, readDir })),
    );
  });

  it("an audio artifact that is a SYMLINK is refused, even to a valid file", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ytdlp-split-outside-"));
    try {
      const plan = mp4Plan();
      const { runner } = splitRunner(plan, {
        audio: async () => {
          writeFileSync(join(outside, "payload"), "AUDIO");
          symlinkSync(join(outside, "payload"), finalOf(plan, "audio"));
          return ok;
        },
      });
      await rejectsWith("PROCESSING_FAILED", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner })),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("an audio artifact that is a directory, or empty, is refused", async () => {
    const shapes: Array<[string, Setup]> = [
      ["a directory", (plan) => mkdirSync(finalOf(plan, "audio"))],
      ["an empty file", (plan) => writeFileSync(finalOf(plan, "audio"), "")],
    ];
    for (const [label, setup] of shapes) {
      resetWorkDir();
      const plan = mp4Plan();
      const { runner } = splitRunner(plan, {
        audio: async () => {
          setup(plan);
          return ok;
        },
      });
      await assert.rejects(
        () => downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner })),
        (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
        label,
      );
    }
  });

  it("a video artifact CHANGED during the audio run is refused", async () => {
    const plan = mp4Plan();
    const { runner } = splitRunner(plan, {
      audio: async () => {
        appendFileSync(finalOf(plan, "video"), "MORE");
        writeFileSync(finalOf(plan, "audio"), "AUD");
        return ok;
      },
    });
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner })),
    );
  });

  it("a failure leaves the workDir to its lifecycle owner: nothing is deleted (§43)", async () => {
    const plan = mp4Plan();
    const { runner } = splitRunner(plan, {
      audio: async () => ({ code: 1, stdout: "", stderr: "ERROR: Requested format is not available" }),
    });
    await rejectsWith("FORMAT_UNAVAILABLE", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner })),
    );
    assert.deepEqual(readdirSync(workDir), ["video-source.mp4"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §31-§37 / §63 / §64: ONE monotonic aggregate progress stream
// ─────────────────────────────────────────────────────────────────────────────

type Update = Parameters<NonNullable<Deps["onProgress"]>>[0];

/** Injectable sizes: the MONITOR reads these; final validation reads real files. */
function sizeBoard() {
  const sizes = new Map<string, number>();
  const statSize = async (path: string): Promise<number | null> => sizes.get(path) ?? null;
  return { sizes, statSize };
}

/** Collapses consecutive duplicates, so poll cadence cannot affect an assertion. */
function distinct<T>(xs: readonly T[]): T[] {
  return xs.filter((x, i) => i === 0 || x !== xs[i - 1]);
}

const pct = (u: Update) => (u.progress === null ? null : Math.round(u.progress * 1000) / 1000);

function assertMonotonic(updates: readonly Update[]) {
  for (let i = 1; i < updates.length; i += 1) {
    const prev = updates[i - 1]!;
    const cur = updates[i]!;
    assert.ok(cur.downloadedBytes! >= prev.downloadedBytes!, "downloadedBytes moved backwards");
    if (cur.progress !== null && prev.progress !== null) {
      assert.ok(cur.progress >= prev.progress, "progress moved backwards");
    }
  }
}

/**
 * Halves that step their `.part` through `steps`, advancing only once each
 * AGGREGATE value has actually been reported — a condition, never a sleep.
 */
function steppingRunner(
  plan: GenericSplitExecutionPlan,
  board: ReturnType<typeof sizeBoard>,
  updates: readonly Update[],
  steps: { video: readonly number[]; audio: readonly number[] },
) {
  const reported = (bytes: number) => updates.some((u) => u.downloadedBytes === bytes);
  const videoBytes = steps.video[steps.video.length - 1]!;
  const audioBytes = steps.audio[steps.audio.length - 1]!;
  return splitRunner(plan, {
    video: async () => {
      for (const n of steps.video) {
        board.sizes.set(partOf(plan, "video"), n);
        await waitUntil(() => reported(n), `aggregate ${n}`);
      }
      board.sizes.delete(partOf(plan, "video"));
      writeFileSync(finalOf(plan, "video"), "x".repeat(videoBytes));
      return ok;
    },
    audio: async () => {
      for (const n of steps.audio) {
        board.sizes.set(partOf(plan, "audio"), n);
        await waitUntil(() => reported(videoBytes + n), `aggregate ${videoBytes + n}`);
      }
      board.sizes.delete(partOf(plan, "audio"));
      writeFileSync(finalOf(plan, "audio"), "x".repeat(audioBytes));
      return ok;
    },
  });
}

describe("split download: ONE monotonic aggregate progress stream (§31-§37/§63/§64)", () => {
  async function stepped(plan: GenericSplitExecutionPlan, extra: Partial<Deps> = {}) {
    const board = sizeBoard();
    const updates: Update[] = [];
    const { runner } = steppingRunner(plan, board, updates, { video: [200, 800], audio: [100, 200] });
    const res = await downloadGenericSplitSources(
      SAFE_URL,
      workDir,
      plan,
      baseDeps({
        runner,
        statSize: board.statSize,
        sizePollMs: 1,
        onProgress: (p) => updates.push(p),
        ...extra,
      }),
    );
    return { res, updates };
  }

  it("known totals (800 + 200): ONE cumulative stream 20 -> 80 -> 90 -> 100, never reset", async () => {
    const { updates } = await stepped(mp4Plan({ video: 800, audio: 200 }));
    assert.deepEqual(distinct(updates.map((u) => u.downloadedBytes)), [200, 800, 900, 1000]);
    // Video completion is 80%, NOT 100%: audio still remains.
    assert.deepEqual(distinct(updates.map(pct)), [20, 80, 90, 100]);
    for (const u of updates) {
      assert.equal(u.totalBytes, 1000);
      assert.equal(u.stage, "Downloading");
    }
    assertMonotonic(updates);
  });

  it("an unknown member size: totalBytes AND progress stay null — bytes still accumulate", async () => {
    const { updates } = await stepped(mp4Plan({ video: 800, audio: null }));
    assert.deepEqual(distinct(updates.map((u) => u.downloadedBytes)), [200, 800, 900, 1000]);
    for (const u of updates) {
      assert.equal(u.totalBytes, null);
      assert.equal(u.progress, null, "never a percentage made up from the configured maximum");
      assert.equal(u.eta, null);
      assert.equal(u.stage, "Downloading");
    }
    assertMonotonic(updates);
  });

  it("a reported total above the combined budget is not trusted for progress either", async () => {
    const { updates } = await stepped(mp4Plan({ video: 900, audio: 900 }));
    for (const u of updates) {
      assert.equal(u.totalBytes, null);
      assert.equal(u.progress, null);
    }
  });

  it("a restarted .part never moves the aggregate backwards", async () => {
    const plan = mp4Plan({ video: 800, audio: 200 });
    const board = sizeBoard();
    const updates: Update[] = [];
    let restartStats = 0;
    const statSize = async (path: string) => {
      const value = board.sizes.get(path) ?? null;
      if (value === 100) restartStats += 1;
      return value;
    };
    const { runner } = splitRunner(plan, {
      video: async () => {
        board.sizes.set(partOf(plan, "video"), 500);
        await waitUntil(() => updates.some((u) => u.downloadedBytes === 500), "500");
        // The server ignored the range request and the .part restarted.
        board.sizes.set(partOf(plan, "video"), 100);
        await waitUntil(() => restartStats >= 2, "the restart to be sampled");
        board.sizes.set(partOf(plan, "video"), 800);
        await waitUntil(() => updates.some((u) => u.downloadedBytes === 800), "800");
        board.sizes.delete(partOf(plan, "video"));
        writeFileSync(finalOf(plan, "video"), "x".repeat(800));
        return ok;
      },
      audio: writes(plan, "audio", 200),
    });
    await downloadGenericSplitSources(
      SAFE_URL,
      workDir,
      plan,
      baseDeps({ runner, statSize, sizePollMs: 1, onProgress: (p) => updates.push(p) }),
    );
    assert.equal(updates.some((u) => u.downloadedBytes === 100), false);
    assertMonotonic(updates);
  });

  it("speed is averaged over the WHOLE acquisition, not reset for audio; ETA needs a total", async () => {
    let now = 1_000_000;
    const plan = mp4Plan({ video: 800, audio: 200 });
    const board = sizeBoard();
    const updates: Update[] = [];
    const { runner } = splitRunner(plan, {
      video: async () => {
        now += 2_000;
        board.sizes.set(partOf(plan, "video"), 400);
        await waitUntil(() => updates.some((u) => u.downloadedBytes === 400), "400");
        board.sizes.delete(partOf(plan, "video"));
        writeFileSync(finalOf(plan, "video"), "x".repeat(800));
        return ok;
      },
      audio: async () => {
        now += 2_000;
        board.sizes.set(partOf(plan, "audio"), 100);
        await waitUntil(() => updates.some((u) => u.downloadedBytes === 900), "900");
        board.sizes.delete(partOf(plan, "audio"));
        writeFileSync(finalOf(plan, "audio"), "x".repeat(200));
        return ok;
      },
    });
    await downloadGenericSplitSources(
      SAFE_URL,
      workDir,
      plan,
      baseDeps({
        runner,
        clock: () => now,
        statSize: board.statSize,
        sizePollMs: 1,
        onProgress: (p) => updates.push(p),
      }),
    );
    const at400 = updates.find((u) => u.downloadedBytes === 400)!;
    assert.equal(at400.speed, 200, "400 bytes over 2s");
    assert.equal(at400.eta, 3, "(1000 - 400) / 200");
    const at900 = updates.find((u) => u.downloadedBytes === 900)!;
    assert.equal(at900.speed, 225, "900 bytes over 4s — the audio half did not restart the clock");
    assert.ok(Math.abs(at900.eta! - 100 / 225) < 1e-9);
  });

  it("HARD GATE: no progress after a SUCCESSFUL return, even from a suspended sample (§37)", async () => {
    const plan = mp4Plan({ video: 800, audio: 200 });
    const sampleStarted = deferred();
    const release = deferred();
    let audioStats = 0;
    let progressCalls = 0;
    const statSize = async (path: string): Promise<number | null> => {
      if (path === partOf(plan, "audio")) {
        audioStats += 1;
        if (audioStats === 1) {
          sampleStarted.resolve();
          await release.promise;
          return 150;
        }
      }
      return null;
    };
    const { runner } = splitRunner(plan, {
      video: writes(plan, "video", 800),
      audio: async (call) => {
        await sampleStarted.promise;
        return writes(plan, "audio", 200)(call);
      },
    });
    const res = await downloadGenericSplitSources(
      SAFE_URL,
      workDir,
      plan,
      baseDeps({ runner, statSize, sizePollMs: 1, onProgress: () => (progressCalls += 1) }),
    );
    assert.equal(res.totalFileSize, 1000);
    release.resolve();
    await flush();
    assert.equal(progressCalls, 0, "a post-return sample produced progress");
  });

  it("HARD GATE: no progress and no late error after a THROW, even from a suspended sample", async () => {
    const plan = mp4Plan({ video: 800, audio: 200 });
    const sampleStarted = deferred();
    const release = deferred();
    let audioStats = 0;
    let progressCalls = 0;
    const statSize = async (path: string): Promise<number | null> => {
      if (path === partOf(plan, "audio")) {
        audioStats += 1;
        if (audioStats === 1) {
          sampleStarted.resolve();
          await release.promise;
          return MAX * 10;
        }
      }
      return null;
    };
    const { runner } = splitRunner(plan, {
      video: writes(plan, "video", 800),
      audio: async () => {
        await sampleStarted.promise;
        throw new AppError("TIMEOUT");
      },
    });
    await rejectsWith("TIMEOUT", () =>
      downloadGenericSplitSources(
        SAFE_URL,
        workDir,
        plan,
        baseDeps({ runner, statSize, sizePollMs: 1, onProgress: () => (progressCalls += 1) }),
      ),
    );
    release.resolve();
    await flush();
    assert.equal(progressCalls, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §30 / §65: the video monitor is dead before anything of the audio half exists
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: the video monitor is dead before audio begins (§30/§65)", () => {
  /**
   * Suspends the FIRST video `.part` stat, lets the video run succeed, and
   * releases that stat only once the AUDIO child is running. Every other stat
   * observes nothing, so any progress or abort can only be the stale sample's.
   */
  async function staleVideoSample(staleValue: number) {
    const plan = mp4Plan();
    const sampleStarted = deferred();
    const release = deferred();
    let videoStats = 0;
    let progressCalls = 0;
    let audioSawAbort: boolean | undefined;
    const statSize = async (path: string): Promise<number | null> => {
      if (path === partOf(plan, "video")) {
        videoStats += 1;
        if (videoStats === 1) {
          sampleStarted.resolve();
          await release.promise;
          return staleValue;
        }
      }
      return null;
    };
    const { runner, calls } = splitRunner(plan, {
      video: async (call) => {
        await sampleStarted.promise;
        return writes(plan, "video", 7)(call);
      },
      audio: async (call) => {
        // The suspended VIDEO stat resumes while the AUDIO child runs.
        release.resolve();
        await flush();
        audioSawAbort = call.signal?.aborted;
        return writes(plan, "audio", 3)(call);
      },
    });
    const res = await downloadGenericSplitSources(
      SAFE_URL,
      workDir,
      plan,
      baseDeps({ runner, statSize, sizePollMs: 1, onProgress: () => (progressCalls += 1) }),
    );
    return { res, calls, progressCalls: () => progressCalls, audioSawAbort: () => audioSawAbort };
  }

  it("a late UNDER-limit video sample emits NO progress during audio", async () => {
    const out = await staleVideoSample(512);
    assert.equal(out.progressCalls(), 0);
    assert.equal(out.calls.length, 2);
    assert.equal(out.res.totalFileSize, 10);
  });

  it("a late OVERSIZED video sample can NOT abort the audio child", async () => {
    const out = await staleVideoSample(MAX * 10);
    assert.equal(out.audioSawAbort(), false);
    assert.equal(out.res.audio.fileSize, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §29 / §66: ONE first-cause latch, whichever half is running
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: ONE first-cause latch across BOTH halves (§29/§66)", () => {
  const only = (role: GenericSplitRole, half: Half) =>
    role === "video" ? { video: half } : { audio: half };

  for (const role of ["video", "audio"] as const) {
    it(`${role}: caller cancels FIRST — a later oversized sample does not make it TOO_LARGE`, async () => {
      const plan = mp4Plan();
      const caller = new AbortController();
      const sampleFinished = deferred();
      let oversizedSamples = 0;
      const statSize = async (path: string): Promise<number | null> => {
        if (path !== partOf(plan, role)) return null;
        oversizedSamples += 1;
        if (oversizedSamples === 1) setImmediate(() => sampleFinished.resolve());
        return MAX * 10;
      };
      const { runner, calls } = splitRunner(
        plan,
        only(role, async () => {
          caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
          // Let a full oversized sample run and try to latch an overflow.
          await sampleFinished.promise;
          await flush(2);
          throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
        }),
      );
      await rejectsWith("PROCESSING_FAILED", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, {
          ...baseDeps({ runner, statSize, sizePollMs: 1 }),
          signal: caller.signal,
        }),
      );
      assert.ok(oversizedSamples > 0, "an oversized sample must really have run");
      assert.equal(calls.length, role === "video" ? 1 : 2);
    });

    it(`${role}: overflow FIRST — a later caller abort does not change TOO_LARGE`, async () => {
      const plan = mp4Plan();
      const caller = new AbortController();
      const statSize = async (path: string) => (path === partOf(plan, role) ? MAX * 10 : null);
      const { runner } = splitRunner(
        plan,
        only(
          role,
          settlesOnAbortOr(
            1_000,
            async () => {
              throw new Error("the byte guard never fired");
            },
            // The byte guard aborted first; the caller cancels only afterwards.
            () => caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled")),
          ),
        ),
      );
      await rejectsWith("TOO_LARGE", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, {
          ...baseDeps({ runner, statSize, sizePollMs: 1 }),
          signal: caller.signal,
        }),
      );
      assert.equal(caller.signal.aborted, true, "the caller really did abort afterwards");
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §42-§44 / §67: either half failing fails the whole call — no partial result
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: a failed half fails the whole call (§42-§44/§67)", () => {
  const limits = { maxFileSizeBytes: 1000, downloadTimeoutSeconds: 60 };
  const failures: Array<[string, (plan: GenericSplitExecutionPlan) => Half]> = [
    [
      "FORMAT_UNAVAILABLE",
      () => async () => ({ code: 1, stdout: "", stderr: `ERROR: 140: Requested format is not available ${SENTINEL}` }),
    ],
    [
      "NETWORK_ERROR",
      () => async () => ({ code: 1, stdout: "", stderr: `ERROR: Unable to download: Connection refused ${SENTINEL}` }),
    ],
    [
      "VIDEO_UNAVAILABLE",
      () => async () => ({ code: 1, stdout: "", stderr: `ERROR: Video unavailable ${SENTINEL}` }),
    ],
    [
      "TIMEOUT",
      () => async () => {
        throw new AppError("TIMEOUT");
      },
    ],
    ["TOO_LARGE", (plan) => writes(plan, "audio", 301)],
    [
      "EXTRACTION_FAILED",
      () => async () => ({ code: 1, stdout: `out ${SENTINEL}`, stderr: `ERROR: something entirely new ${SENTINEL}` }),
    ],
  ];

  for (const [code, failure] of failures) {
    it(`video succeeds, audio fails ${code}: the call fails, with no retry and no substitute`, async () => {
      const plan = mp4Plan();
      const { runner, calls } = splitRunner(plan, {
        video: writes(plan, "video", 700),
        audio: failure(plan),
      });
      let returned: unknown = "never";
      await assert.rejects(
        async () => {
          returned = await downloadGenericSplitSources(SECRET_URL, workDir, plan, baseDeps({ runner, limits }));
        },
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, code);
          const serialized = `${err.message} ${JSON.stringify(err)} ${String(err.stack)}`;
          assert.equal(serialized.includes(SENTINEL), false, "no URL or stderr text escapes");
          assert.equal(/format_id|b\*\[/.test(serialized), false, "no selector escapes");
          return true;
        },
      );
      assert.equal(returned, "never", "no partial result crosses the boundary");
      assert.equal(calls.length, 2, "one attempt per half: no retry");
      assert.deepEqual(formatOf(calls[1]!), [`--format=${buildGenericFormatSelector(plan.pair.audio)}`]);
    });
  }

  it("a failed VIDEO half never starts the audio half", async () => {
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan, {
      video: async () => ({ code: 1, stdout: "", stderr: "ERROR: Requested format is not available" }),
    });
    await rejectsWith("FORMAT_UNAVAILABLE", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner })),
    );
    assert.equal(calls.length, 1);
  });

  it("an output overflow in either half surfaces nothing: EXTRACTION_FAILED", async () => {
    for (const role of ["video", "audio"] as const) {
      resetWorkDir();
      const plan = mp4Plan();
      const overflow: Half = async () => {
        throw new ProcessOutputLimitError("stderr");
      };
      const { runner } = splitRunner(plan, role === "video" ? { video: overflow } : { audio: overflow });
      await rejectsWith("EXTRACTION_FAILED", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner })),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §28 / §68: cancellation reaches whichever subprocess currently owns execution
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: cancellation (§28/§68)", () => {
  const cancel = (caller: AbortController) => () =>
    caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));

  it("abort DURING the runtime probe: the probe is stopped, nothing is acquired", async () => {
    const caller = new AbortController();
    let probeSignal: AbortSignal | undefined;
    const { runner, calls } = forbiddenRunner();
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, mp4Plan(), {
        ...baseDeps({
          runner,
          probeRuntime: (opts) =>
            new Promise((_resolve, reject) => {
              probeSignal = opts.signal;
              opts.signal?.addEventListener("abort", () =>
                reject(new AppError("PROCESSING_FAILED", "Download was cancelled.")),
              );
              setImmediate(cancel(caller));
            }),
        }),
        signal: caller.signal,
      }),
    );
    assert.equal(probeSignal?.aborted, true, "the caller's abort must reach the probe");
    assert.notEqual(probeSignal, caller.signal, "the probe runs under the OPERATION's controller");
    assert.equal(calls.length, 0);
  });

  it("abort DURING video: the video child is signalled and audio never starts", async () => {
    const caller = new AbortController();
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan, {
      video: (call) => {
        setImmediate(cancel(caller));
        return hangsUntilAborted()(call);
      },
    });
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, {
        ...baseDeps({ runner, sizePollMs: 1 }),
        signal: caller.signal,
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.signal?.aborted, true);
  });

  it("abort AFTER the video exits 0 but BEFORE audio: audio never starts", async () => {
    const caller = new AbortController();
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan, {
      video: async (call) => {
        const res = await writes(plan, "video", 7)(call);
        cancel(caller)();
        return res;
      },
    });
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, {
        ...baseDeps({ runner }),
        signal: caller.signal,
      }),
    );
    assert.equal(calls.length, 1);
  });

  it("abort DURING the video artifact's validation: audio still never starts", async () => {
    const caller = new AbortController();
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan);
    const readDir = async (path: string) => {
      const entries = await fsReaddir(path);
      if (entries.includes("video-source.mp4") && !caller.signal.aborted) cancel(caller)();
      return entries;
    };
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, {
        ...baseDeps({ runner, readDir }),
        signal: caller.signal,
      }),
    );
    assert.equal(calls.length, 1);
  });

  it("abort DURING audio: the audio child is signalled; nothing starts afterwards", async () => {
    const caller = new AbortController();
    const plan = mp4Plan();
    const { runner, calls } = splitRunner(plan, {
      audio: (call) => {
        setImmediate(cancel(caller));
        return hangsUntilAborted()(call);
      },
    });
    await rejectsWith("PROCESSING_FAILED", () =>
      downloadGenericSplitSources(SAFE_URL, workDir, plan, {
        ...baseDeps({ runner, sizePollMs: 1 }),
        signal: caller.signal,
      }),
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.signal?.aborted, true);
  });

  describe("through the REAL hardened runner (fake spawn, hooked processKill)", () => {
    type Child = EventEmitter & {
      pid?: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
    };

    /**
     * Scripts each spawn by ROLE. `processKill` is ALWAYS hooked, so the real
     * runner's group termination is observed and no real process group is
     * ever signalled.
     */
    function harness(plan: GenericSplitExecutionPlan, behaviour: Record<GenericSplitRole, "exit" | "hang">) {
      const spawns: Array<{ role: GenericSplitRole; command: string; detached: unknown }> = [];
      const children: Child[] = [];
      const groupKills: number[] = [];
      let spawnedCount = 0;
      const onSpawn: Array<(role: GenericSplitRole) => void> = [];

      setProcessRunnerTestHooks({
        platform: "linux",
        spawn: (command, args, options) => {
          const out = args.find((a) => a.startsWith("--output="));
          const role: GenericSplitRole = out?.includes("/video-source.") ? "video" : "audio";
          const child = new EventEmitter() as Child;
          child.pid = 81_000 + spawnedCount;
          spawnedCount += 1;
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => true;
          children.push(child);
          spawns.push({ role, command, detached: options.detached });
          queueMicrotask(() => {
            if (behaviour[role] === "exit") {
              writeFileSync(finalOf(plan, role), role === "video" ? "VIDEO" : "AUD");
              setImmediate(() => child.emit("close", 0));
            }
            for (const fn of onSpawn) fn(role);
          });
          return child as unknown as ChildProcess;
        },
        processKill: (pid) => {
          groupKills.push(pid);
          const owner = children.find((c) => c.pid === -pid);
          if (owner) queueMicrotask(() => owner.emit("close", null));
          return true;
        },
      });
      return { spawns, groupKills, onSpawn };
    }

    it("abort during VIDEO kills exactly the video child's process group; one spawn", async () => {
      const plan = mp4Plan();
      const caller = new AbortController();
      const h = harness(plan, { video: "hang", audio: "exit" });
      h.onSpawn.push((role) => {
        if (role === "video") setImmediate(cancel(caller));
      });
      await rejectsWith("PROCESSING_FAILED", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, {
          ...baseDeps({ sizePollMs: 1 }),
          signal: caller.signal,
        }),
      );
      assert.deepEqual(h.spawns.map((s) => s.role), ["video"]);
      assert.equal(h.spawns[0]!.command, YTDLP_RUNTIME.pythonPath);
      assert.equal(h.spawns[0]!.detached, true, "the child leads its own process group");
      assert.deepEqual(h.groupKills, [-81_000]);
    });

    it("abort during AUDIO kills exactly the audio child's process group; nothing after", async () => {
      const plan = mp4Plan();
      const caller = new AbortController();
      const h = harness(plan, { video: "exit", audio: "hang" });
      h.onSpawn.push((role) => {
        if (role === "audio") setImmediate(cancel(caller));
      });
      await rejectsWith("PROCESSING_FAILED", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, {
          ...baseDeps({ sizePollMs: 1 }),
          signal: caller.signal,
        }),
      );
      assert.deepEqual(h.spawns.map((s) => s.role), ["video", "audio"]);
      assert.deepEqual(h.groupKills, [-81_001], "only the running audio child is killed");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 / §49 / §50 / §69: NO local media processing during acquisition
// ─────────────────────────────────────────────────────────────────────────────

describe("split download: no media processing during acquisition (§3/§49/§50/§69)", () => {
  const source = readFileSync(new URL("./ytdlp-download.server.ts", import.meta.url), "utf8");
  // Prose may NAME the processing boundary; only code is scanned.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("imports exactly the acquisition dependencies — nothing that can process media", () => {
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map(
      (m) => m[1],
    );
    assert.deepEqual(specifiers.sort(), [
      "../../lib/errors.ts",
      "../../lib/security/ssrf.server.ts",
      "../../services/processing/process-runner.server.ts",
      "../runtime/ytdlp-runtime.server.ts",
      "./format-plan.ts",
      "./generic-source.ts",
      "node:fs/promises",
      "node:path",
    ]);
  });

  it("names no media-processing primitive, and never beginProcessing", () => {
    for (const token of [
      "mergeSplitMedia",
      "probeLocalMedia",
      "convertMedia",
      "beginProcessing",
      "ffmpegPath",
      "ffprobePath",
      "ffmpeg.server",
      "ffprobe.server",
    ]) {
      assert.equal(code.includes(token), false, `acquisition code names '${token}'`);
    }
  });

  it("the JobExecutor reaches the split primitive only through its seam, and builds no argv (§50)", () => {
    // SPLIT-04 wires this primitive in as the production default of the
    // executor's `downloadGenericSplit` seam, so the executor now names it — but
    // it still assembles no yt-dlp command of its own. PRODUCT reachability is a
    // separate fact, pinned by format-plan.test.ts ("HARD GATE: analysis builds
    // NO pair"): no real analysis produces a merge-split plan yet.
    const executor = readFileSync(new URL("./job-executor.server.ts", import.meta.url), "utf8");
    assert.equal(executor.includes("downloadGenericSplitSources"), true);
    assert.equal(executor.includes("buildYtdlpSplitDownloadArgv"), false);
  });
});

describe("split download: no residual timers (§31)", () => {
  it("leaves no timer behind on success, a failed audio half, or an audio overflow", async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const limits = { maxFileSizeBytes: 1000, downloadTimeoutSeconds: 60 };

    resetWorkDir();
    {
      const plan = mp4Plan();
      const { runner } = splitRunner(plan);
      await downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner, sizePollMs: 1 }));
    }
    resetWorkDir();
    {
      const plan = mp4Plan();
      const { runner } = splitRunner(plan, {
        audio: async () => ({ code: 1, stdout: "", stderr: "boom" }),
      });
      await assert.rejects(() =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner, sizePollMs: 1 })),
      );
    }
    resetWorkDir();
    {
      const plan = mp4Plan();
      const { runner } = splitRunner(plan, {
        video: writes(plan, "video", 700),
        audio: async (call) => {
          writeFileSync(partOf(plan, "audio"), "x".repeat(301));
          return settlesOnAbortOr(1_000, writes(plan, "audio", 301))(call);
        },
      });
      await rejectsWith("TOO_LARGE", () =>
        downloadGenericSplitSources(SAFE_URL, workDir, plan, baseDeps({ runner, limits, sizePollMs: 1 })),
      );
    }

    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.ok(after <= before, `timer leak: ${before} -> ${after}`);
  });
});
