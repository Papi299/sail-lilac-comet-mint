import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../lib/errors.ts";
import type { RunResult } from "../../services/processing/process-runner.server.ts";
import { ProcessOutputLimitError } from "../../services/processing/process-runner.server.ts";
import {
  YTDLP_DOWNLOAD_FFMPEG_LOCATION,
  YTDLP_DOWNLOAD_MAX_STDERR_BYTES,
  YTDLP_DOWNLOAD_MAX_STDOUT_BYTES,
  YTDLP_DOWNLOAD_PATH,
  buildYtdlpDownloadArgv,
  buildYtdlpDownloadEnvironment,
  classifyDownloadFailure,
  downloadGenericOriginal,
  expectedPartPath,
  expectedSourcePath,
  outputTemplateFor,
} from "./ytdlp-download.server.ts";
import { YTDLP_RUNTIME, type YtdlpRuntimeStatus } from "../runtime/ytdlp-runtime.server.ts";
import type { GenericExecutionPlan } from "./format-plan.ts";

/**
 * The secret-bearing URL used throughout. It never reaches a real request:
 * every test feeds it to a FAKE runner, and the assertions are about the
 * sentinel NOT escaping into an error, a return value, a filename or a log.
 */
const SECRET_URL = "https://example.invalid/v?token=SUPER_SECRET_VALUE";
const SENTINEL = "SUPER_SECRET_VALUE";
const SAFE_URL = "https://example.invalid/watch/abc";

const MAX_BYTES = 500 * 1024 * 1024;

const LIMITS = { maxFileSizeBytes: MAX_BYTES, downloadTimeoutSeconds: 600 };

const OK_RUNTIME: YtdlpRuntimeStatus = Object.freeze({
  available: true,
  version: YTDLP_RUNTIME.expectedVersion,
  reason: "ok" as const,
});

function videoPlan(overrides: Partial<GenericExecutionPlan["source"]> = {}): GenericExecutionPlan {
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
      fileSize: null,
      ...overrides,
    },
    targetContainer: "mp4",
  } as GenericExecutionPlan;
}

const ok: RunResult = { code: 0, stdout: "", stderr: "" };

type RunnerCall = Parameters<
  NonNullable<Parameters<typeof downloadGenericOriginal>[3]["runner"]>
>[0];

function fakeRunner(result: RunResult | ((opts: RunnerCall) => Promise<RunResult>)) {
  const calls: RunnerCall[] = [];
  const runner = async (opts: RunnerCall): Promise<RunResult> => {
    calls.push(opts);
    return typeof result === "function" ? result(opts) : result;
  };
  return { runner, calls };
}

function forbiddenRunner() {
  const calls: RunnerCall[] = [];
  const runner = async (opts: RunnerCall): Promise<RunResult> => {
    calls.push(opts);
    throw new Error("a subprocess was spawned when none was permitted");
  };
  return { runner, calls };
}

let workDir = "";
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ytdlp-dl-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Writes the file a successful acquisition would have produced. */
function writeSource(container = "mp4", bytes = "MEDIA-BYTES") {
  writeFileSync(expectedSourcePath(workDir, container), bytes);
}

function baseDeps(overrides: Partial<Parameters<typeof downloadGenericOriginal>[3]> = {}) {
  return {
    limits: LIMITS,
    probeRuntime: async () => OK_RUNTIME,
    validateUrl: async (raw: string) => ({ url: raw, hostname: "example.invalid" }),
    ...overrides,
  } as Parameters<typeof downloadGenericOriginal>[3];
}

// ─────────────────────────────────────────────────────────────────────────────
// §56: the acquisition command
// ─────────────────────────────────────────────────────────────────────────────

describe("generic download: argv policy (§23/§24/§56)", () => {
  const argv = () => [
    ...buildYtdlpDownloadArgv({
      validatedUrl: SAFE_URL,
      workDir: "/srv/work",
      plan: videoPlan(),
      maxFileSizeBytes: MAX_BYTES,
    }),
  ];

  it("preserves the closed Phase-10C1 base policy verbatim", () => {
    const a = argv();
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
      "--downloader=native",
    ]) {
      assert.ok(a.includes(expected), `base policy lost '${expected}'`);
    }
  });

  it("selects the native downloader exactly once", () => {
    assert.equal(argv().filter((x) => x === "--downloader=native").length, 1);
    assert.equal(argv().filter((x) => x.startsWith("--downloader")).length, 1);
  });

  it("enables exactly one JS runtime: the approved absolute Node path", () => {
    const a = argv();
    const runtimes = a.filter((x) => x.startsWith("--js-runtimes="));
    assert.equal(runtimes.length, 1);
    assert.match(runtimes[0]!, /^--js-runtimes=node:\//);
    // The clear MUST precede the enable: the pinned release appends.
    assert.ok(a.indexOf("--no-js-runtimes") < a.indexOf(runtimes[0]!));
    for (const forbidden of ["deno", "bun", "quickjs"]) {
      assert.equal(
        a.some((x) => x.toLowerCase().includes(forbidden)),
        false,
        `${forbidden} must remain disabled and unlocatable`,
      );
    }
  });

  it("bounds retries and the socket timeout", () => {
    const a = argv();
    assert.ok(a.includes("--socket-timeout=10"));
    assert.ok(a.includes("--retries=2"));
    assert.ok(a.includes("--fragment-retries=1"));
    assert.ok(a.includes("--extractor-retries=1"));
  });

  it("points ffmpeg at a fixed nonexistent location and disables fixups", () => {
    const a = argv();
    assert.ok(a.includes(`--ffmpeg-location=${YTDLP_DOWNLOAD_FFMPEG_LOCATION}`));
    assert.match(YTDLP_DOWNLOAD_FFMPEG_LOCATION, /^\/nonexistent\//);
    assert.ok(a.includes("--fixup=never"));
  });

  it("passes the configured maximum as --max-filesize", () => {
    assert.ok(argv().includes(`--max-filesize=${MAX_BYTES}`));
  });

  it("keeps fragment concurrency at one and retains no fragments", () => {
    const a = argv();
    assert.ok(a.includes("--concurrent-fragments=1"));
    assert.ok(a.includes("--no-keep-fragments"));
  });

  it("carries exactly ONE format selector, an exact format_id equality filter", () => {
    const a = argv();
    const formats = a.filter((x) => x.startsWith("--format=") || x === "-f");
    assert.equal(formats.length, 1);
    assert.equal(
      formats[0],
      '--format=b*[format_id="22"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!="none"]',
    );
    // §12: never a bare raw-id atom.
    assert.equal(a.includes("--format=22"), false);
    assert.equal(a.includes("-f"), false);
    // §14: no fallback, no merge.
    assert.doesNotMatch(formats[0]!, /\//);
    assert.doesNotMatch(formats[0]!, /\+/);
  });

  it("uses the fixed server-owned output template and no other interpolation", () => {
    const a = argv();
    const outputs = a.filter((x) => x.startsWith("--output=") || x === "-o");
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0], "--output=/srv/work/source.%(ext)s");
    // §28: nothing extractor-controlled may enter the path.
    for (const field of ["%(title)s", "%(id)s", "%(format_id)s", "%(uploader)s", "%(ext)s.%("]) {
      if (field === "%(ext)s.%(") continue;
      assert.equal(outputs[0]!.includes(field), false, `template interpolates ${field}`);
    }
    assert.equal(outputs[0]!.split("%(").length - 1, 1, "exactly one interpolation");
  });

  it("places the URL last, after a bare --", () => {
    const a = argv();
    assert.equal(a[a.length - 1], SAFE_URL);
    assert.equal(a[a.length - 2], "--");
    assert.equal(a.indexOf("--"), a.length - 2, "only one bare -- separator");
  });

  it("starts with the pinned artifact, executed by the pinned interpreter", () => {
    assert.equal(argv()[0], YTDLP_RUNTIME.artifactPath);
    assert.match(YTDLP_RUNTIME.pythonPath, /^\/usr\/bin\/python3$/);
  });

  it("contains NO forbidden argument (§24)", () => {
    const a = argv();
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
      "--write-info-json",
      "--write-thumbnail",
      "--write-description",
      "--write-comments",
      "--write-subs",
      "--write-auto-subs",
      "--load-info-json",
      "--wait-for-video",
      "--postprocessor-args",
      "--embed-thumbnail",
      "--embed-subs",
      "--cookies",
      "--username",
      "--password",
      "--netrc",
      "--proxy",
    ];
    for (const bad of forbidden) {
      assert.equal(
        a.some((x) => x === bad || x.startsWith(`${bad}=`)),
        false,
        `forbidden argument '${bad}' is present`,
      );
    }
    // No output to stdout, in either spelling.
    assert.equal(a.includes("-"), false);
    assert.equal(a.some((x) => x === "--output=-" || x === "-o-"), false);
  });

  it("never lets the audio plan become a yt-dlp extraction", () => {
    // preset:audio from a MUXED source is a Worker-side FFmpeg job. The
    // acquisition command must still just download the muxed original.
    const a = [
      ...buildYtdlpDownloadArgv({
        validatedUrl: SAFE_URL,
        workDir: "/srv/work",
        plan: {
          strategy: "yt-dlp",
          operation: "extract-m4a",
          requestedFormatId: "preset:audio",
          source: {
            formatId: "22",
            protocol: "https",
            container: "mp4",
            hasVideo: true,
            hasAudio: true,
            videoConstraint: "codec-present",
            fileSize: null,
          },
          targetContainer: "m4a",
        },
        maxFileSizeBytes: MAX_BYTES,
      }),
    ];
    assert.equal(a.includes("-x"), false);
    assert.equal(a.some((x) => x.startsWith("--audio-format")), false);
    // The selector still names the MUXED source, not an imagined audio one.
    assert.ok(
      a.includes(
        '--format=b*[format_id="22"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!="none"]',
      ),
    );
    assert.ok(a.includes("--output=/srv/work/source.%(ext)s"));
  });
});

describe("generic download: environment (§21)", () => {
  it("uses a PATH that resolves nothing", () => {
    const env = buildYtdlpDownloadEnvironment({ workDir: "/srv/work" });
    assert.equal(env.PATH, YTDLP_DOWNLOAD_PATH);
    assert.match(YTDLP_DOWNLOAD_PATH, /^\/nonexistent\//);
    // Deliberately NOT empty: an empty PATH is read by some resolvers as
    // "use the system default" (/bin:/usr/bin), restoring what this removes.
    assert.notEqual(env.PATH, "");
    assert.equal(env.PATH!.includes("/usr/bin"), false);
    assert.equal(env.PATH!.includes("/bin"), false);
  });

  it("is an allowlist built from nothing: no ambient variable survives", () => {
    const marker = "VIDEOFETCH_TEST_AMBIENT_SENTINEL";
    process.env[marker] = SENTINEL;
    try {
      const env = buildYtdlpDownloadEnvironment({ workDir: "/srv/work" });
      assert.equal(marker in env, false);
      assert.equal(JSON.stringify(env).includes(SENTINEL), false);
      for (const forbidden of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
      ]) {
        assert.equal(forbidden in env, false, `${forbidden} leaked into the child`);
      }
    } finally {
      delete process.env[marker];
    }
  });

  it("roots HOME, TMPDIR and the XDG paths inside the job's own workDir", () => {
    const env = buildYtdlpDownloadEnvironment({ workDir: "/srv/work" });
    assert.equal(env.HOME, "/srv/work");
    assert.equal(env.TMPDIR, "/srv/work");
    assert.equal(env.XDG_CONFIG_HOME, "/srv/work/.config");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §25/§26: nothing spawns before validation and the runtime gate
// ─────────────────────────────────────────────────────────────────────────────

describe("generic download: pre-flight ordering (§25/§26)", () => {
  it("re-validates the URL and spawns NOTHING when it is unsafe", async () => {
    const { runner, calls } = forbiddenRunner();
    let probed = 0;
    await assert.rejects(
      () =>
        downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), {
          ...baseDeps({ runner }),
          probeRuntime: async () => {
            probed += 1;
            return OK_RUNTIME;
          },
          validateUrl: async () => {
            throw new AppError("INVALID_URL");
          },
        }),
      (err: unknown) => err instanceof AppError && err.code === "INVALID_URL",
    );
    assert.equal(calls.length, 0, "no acquisition subprocess");
    assert.equal(probed, 0, "not even the version probe may run");
  });

  it("re-checks the URL even though analysis already did", async () => {
    // analysis-time DNS state is not download-time DNS state.
    let validated = 0;
    const { runner } = fakeRunner(async () => {
      writeSource();
      return ok;
    });
    await downloadGenericOriginal(
      SAFE_URL,
      workDir,
      videoPlan(),
      baseDeps({
        runner,
        validateUrl: async (raw: string) => {
          validated += 1;
          return { url: raw, hostname: "example.invalid" };
        },
      }),
    );
    assert.equal(validated, 1);
  });

  it("fails closed when the exact pinned runtime is unavailable", async () => {
    const { runner, calls } = forbiddenRunner();
    await assert.rejects(
      () =>
        downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), {
          ...baseDeps({ runner }),
          probeRuntime: async () => ({
            available: false,
            version: null,
            reason: "version_mismatch",
          }),
        }),
      (err: unknown) => err instanceof AppError && err.code === "EXTRACTOR_UNAVAILABLE",
    );
    assert.equal(calls.length, 0, "an unverified runtime must acquire nothing");
  });

  it("shares ONE deadline between the probe and the acquisition", async () => {
    let now = 1_000_000;
    const clock = () => now;
    let probeBudget = 0;
    let runBudget = 0;
    const { runner } = fakeRunner(async (opts) => {
      runBudget = opts.timeoutMs;
      writeSource();
      return ok;
    });

    await downloadGenericOriginal(
      SAFE_URL,
      workDir,
      videoPlan(),
      baseDeps({
        runner,
        clock,
        limits: { maxFileSizeBytes: MAX_BYTES, downloadTimeoutSeconds: 60 },
        probeRuntime: async (o) => {
          probeBudget = o.timeoutMs ?? 0;
          now += 4_000; // the probe consumes 4s of the 60s budget
          return OK_RUNTIME;
        },
      }),
    );

    // The probe never gets more than its own conservative maximum.
    assert.ok(probeBudget <= 15_000, `probe budget ${probeBudget}`);
    // The acquisition gets only what the probe left behind, not a fresh 60s.
    assert.equal(runBudget, 56_000);
  });

  it("starts no subprocess when the caller is already cancelled", async () => {
    const { runner, calls } = forbiddenRunner();
    const controller = new AbortController();
    controller.abort();
    let probed = 0;
    await assert.rejects(() =>
      downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), {
        ...baseDeps({ runner }),
        signal: controller.signal,
        probeRuntime: async () => {
          probed += 1;
          return OK_RUNTIME;
        },
      }),
    );
    assert.equal(calls.length, 0);
    assert.equal(probed, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §29/§57: local artifact validation
// ─────────────────────────────────────────────────────────────────────────────

describe("generic download: acquired artifact validation (§29/§57)", () => {
  async function run(deps: Partial<Parameters<typeof downloadGenericOriginal>[3]> = {}) {
    return downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), baseDeps(deps));
  }

  it("accepts exactly the expected file", async () => {
    const { runner } = fakeRunner(async () => {
      writeSource("mp4", "0123456789");
      return ok;
    });
    const res = await run({ runner });
    assert.equal(res.filePath, expectedSourcePath(workDir, "mp4"));
    assert.equal(res.container, "mp4");
    assert.equal(res.fileSize, 10);
  });

  it("rejects a symlink even when it points at a valid file", async () => {
    const { runner } = fakeRunner(async () => {
      const real = join(workDir, "real-payload");
      writeFileSync(real, "MEDIA");
      symlinkSync(real, expectedSourcePath(workDir, "mp4"));
      return ok;
    });
    await assert.rejects(() => run({ runner }), (err: unknown) => err instanceof AppError);
  });

  it("rejects a wrong extension: the acquired container must equal the approved one", async () => {
    const { runner } = fakeRunner(async () => {
      writeSource("webm");
      return ok;
    });
    await assert.rejects(
      () => run({ runner }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );
  });

  it("rejects a non-regular file", async () => {
    const { runner } = fakeRunner(async () => {
      mkdirSync(expectedSourcePath(workDir, "mp4"));
      return ok;
    });
    await assert.rejects(() => run({ runner }), (err: unknown) => err instanceof AppError);
  });

  it("rejects an empty artifact", async () => {
    const { runner } = fakeRunner(async () => {
      writeSource("mp4", "");
      return ok;
    });
    await assert.rejects(
      () => run({ runner }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );
  });

  it("rejects a successful run that left a .part behind", async () => {
    const { runner } = fakeRunner(async () => {
      writeSource();
      writeFileSync(expectedPartPath(workDir, "mp4"), "leftover");
      return ok;
    });
    await assert.rejects(
      () => run({ runner }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );
  });

  it("rejects retained fragment files", async () => {
    const { runner } = fakeRunner(async () => {
      writeSource();
      writeFileSync(`${expectedSourcePath(workDir, "mp4")}.part-Frag1`, "frag");
      return ok;
    });
    await assert.rejects(
      () => run({ runner }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );
  });

  it("rejects an unexpected SECOND media file rather than guessing", async () => {
    const { runner } = fakeRunner(async () => {
      writeSource();
      writeFileSync(join(workDir, "source.webm"), "OTHER");
      return ok;
    });
    await assert.rejects(
      () => run({ runner }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );
  });

  it("rejects a side file yt-dlp should never have written", async () => {
    const { runner } = fakeRunner(async () => {
      writeSource();
      writeFileSync(join(workDir, "source.info.json"), "{}");
      return ok;
    });
    await assert.rejects(() => run({ runner }), (err: unknown) => err instanceof AppError);
  });

  it("rejects a missing artifact after a zero exit", async () => {
    const { runner } = fakeRunner(ok);
    await assert.rejects(
      () => run({ runner }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §30/§58: the actual-byte guard
// ─────────────────────────────────────────────────────────────────────────────

describe("generic download: actual-byte enforcement (§30/§58)", () => {
  it("accepts a file exactly AT the maximum", async () => {
    const limit = 32;
    const { runner } = fakeRunner(async () => {
      writeSource("mp4", "x".repeat(limit));
      return ok;
    });
    const res = await downloadGenericOriginal(
      SAFE_URL,
      workDir,
      videoPlan(),
      baseDeps({ runner, limits: { maxFileSizeBytes: limit, downloadTimeoutSeconds: 60 } }),
    );
    assert.equal(res.fileSize, limit);
  });

  it("TOO_LARGE when the final artifact exceeds the maximum despite a clean exit", async () => {
    const limit = 16;
    const { runner } = fakeRunner(async () => {
      // The watcher never sampled this: the file appeared only at exit.
      writeSource("mp4", "x".repeat(limit + 1));
      return ok;
    });
    await assert.rejects(
      () =>
        downloadGenericOriginal(
          SAFE_URL,
          workDir,
          videoPlan(),
          baseDeps({ runner, limits: { maxFileSizeBytes: limit, downloadTimeoutSeconds: 60 } }),
        ),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
  });

  it("aborts the process group mid-flight when the .part grows past the limit", async () => {
    const limit = 64;
    let aborted = false;
    let abortReason: unknown = null;

    // A runner that grows the .part file and only settles when aborted, which
    // is exactly how the real runner behaves when its process group is killed.
    const runner = async (opts: RunnerCall): Promise<RunResult> => {
      writeFileSync(expectedPartPath(workDir, "mp4"), "x".repeat(limit * 4));
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          aborted = true;
          abortReason = opts.signal?.reason;
          reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
        });
      });
    };

    await assert.rejects(
      () =>
        downloadGenericOriginal(
          SAFE_URL,
          workDir,
          videoPlan(),
          baseDeps({
            runner,
            sizePollMs: 5,
            limits: { maxFileSizeBytes: limit, downloadTimeoutSeconds: 60 },
          }),
        ),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );

    assert.equal(aborted, true, "the owned process group must be signalled");
    assert.ok(
      abortReason instanceof AppError && abortReason.code === "TOO_LARGE",
      "the internal abort must be classified as TOO_LARGE, not a user cancellation",
    );
  });

  it("does not rely on metadata size: an unknown filesize still gets enforced", async () => {
    const limit = 32;
    const plan = videoPlan({ fileSize: null });
    const runner = async (opts: RunnerCall): Promise<RunResult> => {
      writeFileSync(expectedPartPath(workDir, "mp4"), "x".repeat(limit * 3));
      return new Promise((_r, reject) => {
        opts.signal?.addEventListener("abort", () =>
          reject(new AppError("PROCESSING_FAILED", "cancelled")),
        );
      });
    };
    await assert.rejects(
      () =>
        downloadGenericOriginal(
          SAFE_URL,
          workDir,
          plan,
          baseDeps({
            runner,
            sizePollMs: 5,
            limits: { maxFileSizeBytes: limit, downloadTimeoutSeconds: 60 },
          }),
        ),
      (err: unknown) => err instanceof AppError && err.code === "TOO_LARGE",
    );
  });

  it("leaves no timer behind on success, failure or overflow (§31)", async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    // success
    {
      const { runner } = fakeRunner(async () => {
        writeSource();
        return ok;
      });
      await downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), baseDeps({ runner, sizePollMs: 5 }));
      rmSync(expectedSourcePath(workDir, "mp4"), { force: true });
    }
    // failure
    {
      const { runner } = fakeRunner({ code: 1, stdout: "", stderr: "boom" });
      await assert.rejects(() =>
        downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), baseDeps({ runner, sizePollMs: 5 })),
      );
    }
    // overflow
    {
      const runner = async (opts: RunnerCall): Promise<RunResult> => {
        writeFileSync(expectedPartPath(workDir, "mp4"), "x".repeat(100));
        return new Promise((_r, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new AppError("PROCESSING_FAILED")));
        });
      };
      await assert.rejects(() =>
        downloadGenericOriginal(
          SAFE_URL,
          workDir,
          videoPlan(),
          baseDeps({ runner, sizePollMs: 5, limits: { maxFileSizeBytes: 8, downloadTimeoutSeconds: 60 } }),
        ),
      );
      rmSync(expectedPartPath(workDir, "mp4"), { force: true });
    }

    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.ok(after <= before, `timer leak: ${before} -> ${after}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §32: progress
// ─────────────────────────────────────────────────────────────────────────────

describe("generic download: progress (§32)", () => {
  it("derives progress from observed local bytes, not from yt-dlp text", async () => {
    const updates: Array<{ downloadedBytes: number | null; totalBytes: number | null; stage: string }> = [];
    const runner = async (): Promise<RunResult> => {
      writeFileSync(expectedPartPath(workDir, "mp4"), "x".repeat(50));
      // Give the poller a chance to observe the partial file.
      await new Promise((r) => setTimeout(r, 40));
      rmSync(expectedPartPath(workDir, "mp4"), { force: true });
      writeSource("mp4", "x".repeat(100));
      return ok;
    };

    await downloadGenericOriginal(
      SAFE_URL,
      workDir,
      videoPlan({ fileSize: 100 }),
      baseDeps({
        runner,
        sizePollMs: 5,
        onProgress: (p) => updates.push(p),
      }),
    );

    assert.ok(updates.length > 0, "progress must be reported");
    for (const u of updates) {
      assert.equal(u.stage, "Downloading");
      assert.equal(u.totalBytes, 100);
      assert.ok(u.downloadedBytes !== null && u.downloadedBytes > 0);
    }
  });

  it("reports a null total when the upstream size is unknown", async () => {
    const updates: Array<{ progress: number | null; totalBytes: number | null }> = [];
    const runner = async (): Promise<RunResult> => {
      writeFileSync(expectedPartPath(workDir, "mp4"), "x".repeat(10));
      await new Promise((r) => setTimeout(r, 30));
      rmSync(expectedPartPath(workDir, "mp4"), { force: true });
      writeSource();
      return ok;
    };
    await downloadGenericOriginal(
      SAFE_URL,
      workDir,
      videoPlan({ fileSize: null }),
      baseDeps({ runner, sizePollMs: 5, onProgress: (p) => updates.push(p) }),
    );
    for (const u of updates) {
      assert.equal(u.totalBytes, null);
      assert.equal(u.progress, null, "progress must not be fabricated without a total");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §33/§34/§60: bounded output, classification, privacy
// ─────────────────────────────────────────────────────────────────────────────

describe("generic download: bounded output and classification (§33/§34)", () => {
  it("applies hard, small stdout/stderr ceilings", async () => {
    const { runner, calls } = fakeRunner(async () => {
      writeSource();
      return ok;
    });
    await downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), baseDeps({ runner }));
    assert.equal(calls[0]!.maxStdoutBytes, YTDLP_DOWNLOAD_MAX_STDOUT_BYTES);
    assert.equal(calls[0]!.maxStderrBytes, YTDLP_DOWNLOAD_MAX_STDERR_BYTES);
    // A quiet, document-free command needs far less headroom than analysis.
    assert.ok(YTDLP_DOWNLOAD_MAX_STDOUT_BYTES <= 64 * 1024);
    assert.ok(YTDLP_DOWNLOAD_MAX_STDERR_BYTES <= 256 * 1024);
  });

  it("surfaces nothing when output overflows its ceiling", async () => {
    const runner = async (): Promise<RunResult> => {
      throw new ProcessOutputLimitError("stderr");
    };
    await assert.rejects(
      () => downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), baseDeps({ runner })),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "EXTRACTION_FAILED" &&
        !err.message.includes("stderr exceeded"),
    );
  });

  it("classifies the failures it can distinguish safely", () => {
    assert.equal(
      classifyDownloadFailure("ERROR: File is larger than max-filesize (900 bytes > 100 bytes)"),
      "TOO_LARGE",
    );
    assert.equal(classifyDownloadFailure("ERROR: Requested format is not available"), "FORMAT_UNAVAILABLE");
    assert.equal(classifyDownloadFailure("ERROR: Private video. Sign in"), "VIDEO_UNAVAILABLE");
    assert.equal(classifyDownloadFailure("ERROR: The read operation timed out"), "TIMEOUT");
    assert.equal(classifyDownloadFailure("ERROR: Connection refused"), "NETWORK_ERROR");
    // Anything unrecognized collapses safely rather than being described.
    assert.equal(classifyDownloadFailure("ERROR: something entirely new"), "EXTRACTION_FAILED");
    assert.equal(classifyDownloadFailure(""), "EXTRACTION_FAILED");
  });

  it("size refusal outranks the generic phrases that accompany it", () => {
    assert.equal(
      classifyDownloadFailure("Unable to download. File is larger than max-filesize"),
      "TOO_LARGE",
    );
  });
});

describe("generic download: privacy (§60)", () => {
  it("never leaks a stderr sentinel into the thrown error", async () => {
    const { runner } = fakeRunner({
      code: 1,
      stdout: `stdout ${SENTINEL}`,
      stderr: `ERROR: something failed ${SENTINEL}`,
    });
    await assert.rejects(
      () => downloadGenericOriginal(SECRET_URL, workDir, videoPlan(), baseDeps({ runner })),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        const serialized = `${err.message} ${JSON.stringify(err)} ${String(err.stack)}`;
        assert.equal(serialized.includes(SENTINEL), false, "sentinel escaped into the error");
        return true;
      },
    );
  });

  it("never lets the URL query become part of the acquired filename", async () => {
    const { runner } = fakeRunner(async () => {
      writeSource();
      return ok;
    });
    const res = await downloadGenericOriginal(
      SECRET_URL,
      workDir,
      videoPlan(),
      baseDeps({ runner }),
    );
    assert.equal(res.filePath.includes(SENTINEL), false);
    assert.match(res.filePath, /\/source\.mp4$/);
  });

  it("keeps the sentinel out of the output template, which is fully fixed", () => {
    const template = outputTemplateFor(workDir);
    assert.equal(template.includes(SENTINEL), false);
    assert.match(template, /\/source\.%\(ext\)s$/);
  });

  it("writes nothing to the console", () => {
    const source = readFileSync(
      new URL("./ytdlp-download.server.ts", import.meta.url),
      "utf8",
    );
    for (const token of [
      "console.log",
      "console.error",
      "console.warn",
      "console.info",
      "process.stdout.write",
    ]) {
      assert.equal(source.includes(token), false, `the downloader must not call ${token}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §40: cancellation
// ─────────────────────────────────────────────────────────────────────────────

describe("generic download: cancellation (§40)", () => {
  it("relays the caller's abort to the owned process group", async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const runner = async (opts: RunnerCall): Promise<RunResult> => {
      return new Promise((_r, reject) => {
        opts.signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
        });
        setTimeout(() => controller.abort(new AppError("PROCESSING_FAILED", "Job cancelled")), 5);
      });
    };

    await assert.rejects(() =>
      downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), {
        ...baseDeps({ runner, sizePollMs: 5 }),
        signal: controller.signal,
      }),
    );
    assert.equal(sawAbort, true, "cancellation must reach the subprocess");
  });

  it("keeps a real cancellation distinct from a size overflow", async () => {
    const controller = new AbortController();
    const runner = async (opts: RunnerCall): Promise<RunResult> =>
      new Promise((_r, reject) => {
        opts.signal?.addEventListener("abort", () =>
          reject(new AppError("PROCESSING_FAILED", "Download was cancelled.")),
        );
        setTimeout(() => controller.abort(), 5);
      });

    await assert.rejects(
      () =>
        downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), {
          ...baseDeps({ runner, sizePollMs: 5 }),
          signal: controller.signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        // A cancellation must never be reported as a size refusal: the two are
        // distinguished by the internal overflow flag, not by which fired first.
        assert.notEqual(err.code, "TOO_LARGE");
        assert.equal(err.code, "PROCESSING_FAILED");
        return true;
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION-01 §7-§14: monitor lifecycle and first-cause abort semantics
// ─────────────────────────────────────────────────────────────────────────────

/** A barrier the test controls explicitly. No sleeps, no timing luck. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Drains the microtask queue a bounded number of times.
 *
 * Everything a suspended `sample()` still has to do after its stat resolves is
 * pure microtask work, so draining is deterministic — it is not a sleep and does
 * not depend on how long anything takes.
 */
async function flush(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("generic download: the monitor cannot act after settlement (§7/§8/§9)", () => {
  it("emits NO progress from a sample whose stat resolves after the downloader returned", async () => {
    const trace: string[] = [];
    const sampleStarted = deferred();
    const releaseStat = deferred();
    let statCalls = 0;
    let progressCalls = 0;

    // The first stat suspends until the test releases it, then reports a normal
    // UNDER-limit size. Under-limit is deliberate: an oversized value would take
    // the early-return overflow branch and never reach `onProgress`, so it could
    // not distinguish a gated monitor from an ungated one.
    const statSize = async (): Promise<number | null> => {
      statCalls += 1;
      if (statCalls === 1) {
        trace.push("sample-start");
        sampleStarted.resolve();
        await releaseStat.promise;
        trace.push("sample-release");
        return 512;
      }
      return null;
    };

    const runner = async (): Promise<RunResult> => {
      // Only settle once a sample is genuinely suspended mid-stat.
      await sampleStarted.promise;
      trace.push("runner-resolve");
      writeSource("mp4", "OK");
      return ok;
    };

    const res = await downloadGenericOriginal(
      SAFE_URL,
      workDir,
      videoPlan(),
      baseDeps({
        runner,
        statSize,
        sizePollMs: 1,
        onProgress: () => {
          progressCalls += 1;
          trace.push("progress");
        },
      }),
    );
    trace.push("download-return");

    // The acquisition succeeded and is now, from the executor's point of view,
    // finished — `beginProcessing()` would be the very next thing to commit.
    assert.equal(res.fileSize, 2);
    assert.equal(progressCalls, 0, "no progress may have been emitted yet");

    // NOW let the suspended sample finish.
    releaseStat.resolve();
    await flush();

    assert.equal(progressCalls, 0, "a post-settlement sample must emit no progress");
    assert.deepEqual(trace, [
      "sample-start",
      "runner-resolve",
      "download-return",
      "sample-release",
    ]);
  });

  it("does NOT convert a settled success into TOO_LARGE from a late oversized sample", async () => {
    // Same shape as above, asserted as an outcome rather than a trace: the
    // returned result must stand, unaffected by what the stale sample saw.
    const sampleStarted = deferred();
    const releaseStat = deferred();
    let statCalls = 0;

    const statSize = async (): Promise<number | null> => {
      statCalls += 1;
      if (statCalls === 1) {
        sampleStarted.resolve();
        await releaseStat.promise;
        return MAX_BYTES * 10;
      }
      return null;
    };

    const runner = async (): Promise<RunResult> => {
      await sampleStarted.promise;
      writeSource("mp4", "PAYLOAD");
      return ok;
    };

    const res = await downloadGenericOriginal(
      SAFE_URL,
      workDir,
      videoPlan(),
      baseDeps({ runner, statSize, sizePollMs: 1 }),
    );

    releaseStat.resolve();
    await flush();

    assert.equal(res.container, "mp4");
    assert.equal(res.fileSize, 7);
  });

  it("a stale sample cannot turn a TIMEOUT into a TOO_LARGE (§13)", async () => {
    const sampleStarted = deferred();
    const releaseStat = deferred();
    let statCalls = 0;
    let progressCalls = 0;

    const statSize = async (): Promise<number | null> => {
      statCalls += 1;
      if (statCalls === 1) {
        sampleStarted.resolve();
        await releaseStat.promise;
        // Under-limit, so the sample would reach `onProgress` if it were still
        // live — the observable effect that crosses the module boundary.
        return 512;
      }
      return null;
    };

    const runner = async (): Promise<RunResult> => {
      await sampleStarted.promise;
      // The runner's own deadline expired: the outcome is already determined.
      throw new AppError("TIMEOUT");
    };

    let code = "";
    await downloadGenericOriginal(
      SAFE_URL,
      workDir,
      videoPlan(),
      baseDeps({ runner, statSize, sizePollMs: 1, onProgress: () => { progressCalls += 1; } }),
    ).catch((err: unknown) => {
      code = err instanceof AppError ? err.code : "other";
    });

    releaseStat.resolve();
    await flush();

    assert.equal(code, "TIMEOUT", "the already-determined outcome must stand");
    assert.equal(progressCalls, 0);
  });

  it("a stale sample cannot turn an output-overflow failure into TOO_LARGE", async () => {
    const sampleStarted = deferred();
    const releaseStat = deferred();
    let statCalls = 0;

    const statSize = async (): Promise<number | null> => {
      statCalls += 1;
      if (statCalls === 1) {
        sampleStarted.resolve();
        await releaseStat.promise;
        return MAX_BYTES * 10;
      }
      return null;
    };

    const runner = async (): Promise<RunResult> => {
      await sampleStarted.promise;
      throw new ProcessOutputLimitError("stderr");
    };

    let code = "";
    await downloadGenericOriginal(
      SAFE_URL,
      workDir,
      videoPlan(),
      baseDeps({ runner, statSize, sizePollMs: 1 }),
    ).catch((err: unknown) => {
      code = err instanceof AppError ? err.code : "other";
    });

    releaseStat.resolve();
    await flush();

    assert.equal(code, "EXTRACTION_FAILED");
  });
});

describe("generic download: first-cause abort latch (§11/§12)", () => {
  it("caller cancels FIRST: a later oversized sample does not make it TOO_LARGE", async () => {
    const caller = new AbortController();
    const sampleFinished = deferred();
    let statCalls = 0;

    // Every stat reports an oversized file, so the byte guard WOULD abort — but
    // the caller has already cancelled by the time any sample completes.
    const statSize = async (): Promise<number | null> => {
      statCalls += 1;
      if (statCalls === 1) {
        // Resolve on the next turn so the sample's own continuation — including
        // its overflow attempt — has definitely run first.
        setImmediate(() => sampleFinished.resolve());
      }
      return MAX_BYTES * 10;
    };

    const runner = async (opts: RunnerCall): Promise<RunResult> => {
      // Cancel while the acquisition is genuinely in flight.
      caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
      // Let at least one full sample observe the oversized file and attempt to
      // latch an overflow cause.
      await sampleFinished.promise;
      await flush(2);
      void opts;
      throw new AppError("PROCESSING_FAILED", "Download was cancelled.");
    };

    let code = "";
    await downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), {
      ...baseDeps({ runner, statSize, sizePollMs: 1 }),
      signal: caller.signal,
    }).catch((err: unknown) => {
      code = err instanceof AppError ? err.code : "other";
    });

    assert.ok(statCalls > 0, "at least one oversized sample must have run");
    assert.notEqual(code, "TOO_LARGE", "the first cause was the caller, and it must stand");
    assert.equal(code, "PROCESSING_FAILED");
  });

  it("overflow happens FIRST: a later caller abort does not change TOO_LARGE", async () => {
    const caller = new AbortController();
    const overflowAborted = deferred();

    const statSize = async (): Promise<number | null> => MAX_BYTES * 10;

    const runner = async (opts: RunnerCall): Promise<RunResult> =>
      new Promise((_resolve, reject) => {
        // The byte guard fires first, through the OWNED controller.
        opts.signal?.addEventListener("abort", () => {
          overflowAborted.resolve();
          // The caller then cancels too, after the cause is already latched.
          caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));
          reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
        });
      });

    let code = "";
    await downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), {
      ...baseDeps({
        runner,
        statSize,
        sizePollMs: 1,
        limits: { maxFileSizeBytes: 16, downloadTimeoutSeconds: 60 },
      }),
      signal: caller.signal,
    }).catch((err: unknown) => {
      code = err instanceof AppError ? err.code : "other";
    });

    await overflowAborted.promise;
    assert.equal(code, "TOO_LARGE", "the first cause was the overflow, and it must stand");
  });

  it("an already-aborted caller is the first cause, before any sampling", async () => {
    const caller = new AbortController();
    caller.abort(new AppError("PROCESSING_FAILED", "Job cancelled"));

    let code = "";
    await downloadGenericOriginal(SAFE_URL, workDir, videoPlan(), {
      ...baseDeps({
        runner: forbiddenRunner().runner,
        statSize: async () => MAX_BYTES * 10,
        sizePollMs: 1,
      }),
      signal: caller.signal,
    }).catch((err: unknown) => {
      code = err instanceof AppError ? err.code : "other";
    });

    assert.equal(code, "PROCESSING_FAILED");
    assert.notEqual(code, "TOO_LARGE");
  });
});

describe("generic download: no residual monitor work after settlement (§14)", () => {
  it("leaves neither a timer nor a live sample on every settlement path", async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    let lateEffects = 0;

    // Each case suspends a sample mid-stat, settles the download, then releases
    // the stat and asserts the sample produced NOTHING.
    const paths: Array<{ label: string; run: () => Promise<RunResult> }> = [
      { label: "success", run: async () => { writeSource(); return ok; } },
      { label: "yt-dlp failure", run: async () => ({ code: 1, stdout: "", stderr: "boom" }) },
      { label: "timeout", run: async () => { throw new AppError("TIMEOUT"); } },
      { label: "output overflow", run: async () => { throw new ProcessOutputLimitError("stdout"); } },
    ];

    for (const { label, run } of paths) {
      const sampleStarted = deferred();
      const releaseStat = deferred();
      let statCalls = 0;

      const statSize = async (): Promise<number | null> => {
        statCalls += 1;
        if (statCalls === 1) {
          sampleStarted.resolve();
          await releaseStat.promise;
          // Under-limit: this is the value that would reach `onProgress`, which
          // is the side effect that actually crosses into the executor.
          return 512;
        }
        return null;
      };

      await downloadGenericOriginal(
        SAFE_URL,
        workDir,
        videoPlan(),
        baseDeps({
          runner: async () => {
            await sampleStarted.promise;
            return run();
          },
          statSize,
          sizePollMs: 1,
          onProgress: () => {
            lateEffects += 1;
          },
        }),
      ).catch(() => {});

      releaseStat.resolve();
      await flush();
      assert.equal(lateEffects, 0, `${label}: a released sample produced a side effect`);
      rmSync(expectedSourcePath(workDir, "mp4"), { force: true });
    }

    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.ok(after <= before, `timer leak: ${before} -> ${after}`);
  });
});
