import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../lib/config.ts";
import { AppError } from "../../lib/errors.ts";
import { setProcessRunnerTestHooks, type SpawnImpl } from "./process-runner.server.ts";
import {
  assertLocalMediaPath,
  buildSplitMergeArgs,
  convertMedia,
  mergeSplitMedia,
} from "./ffmpeg.server.ts";
import { resolveFfprobePath } from "./ffprobe.server.ts";

describe("ffmpeg local-path guard", () => {
  it("rejects remote URLs and protocol-relative inputs", () => {
    for (const value of [
      "https://cdn.example/video.mp4",
      "http://example.com/a.mp4",
      "file:///etc/passwd",
      "//cdn.example/video.mp4",
      "",
    ]) {
      assert.throws(
        () => assertLocalMediaPath(value),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, "PROCESSING_FAILED");
          return true;
        },
      );
    }
  });

  it("allows ordinary local filesystem paths", () => {
    assert.doesNotThrow(() => assertLocalMediaPath("/tmp/videofetch/jobs/abc/source.mp4"));
    assert.doesNotThrow(() => assertLocalMediaPath("source.mp4"));
  });
});

describe("m4a audio extraction (worker Phase-6 plan target)", () => {
  afterEach(() => {
    setProcessRunnerTestHooks(null);
  });

  type SpawnCall = { command: string; args: readonly string[]; options: SpawnOptions };

  function createFakeChild(): EventEmitter & {
    pid?: number;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals) => boolean;
    killCalls: NodeJS.Signals[];
  } {
    const child = new EventEmitter() as EventEmitter & {
      pid?: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
      killCalls: NodeJS.Signals[];
    };
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killCalls = [];
    child.kill = (signal?: NodeJS.Signals) => {
      child.killCalls.push(signal ?? ("SIGTERM" as NodeJS.Signals));
      return true;
    };
    return child;
  }

  /** Captures the single spawn runProcess performs; nothing else may spawn. */
  function captureSpawn(onSpawn?: (child: ReturnType<typeof createFakeChild>) => void) {
    const calls: SpawnCall[] = [];
    const spawnImpl: SpawnImpl = (command, args, options) => {
      calls.push({ command, args, options });
      const child = createFakeChild();
      if (onSpawn) {
        onSpawn(child);
      } else {
        queueMicrotask(() => child.emit("close", 0));
      }
      return child as unknown as ChildProcess;
    };
    setProcessRunnerTestHooks({ platform: "linux", spawn: spawnImpl });
    return calls;
  }

  it("extracts AAC audio with -vn into a controlled output path", async () => {
    const calls = captureSpawn();
    const workDir = "/tmp/videofetch/jobs/abc";
    const inputPath = `${workDir}/source.mp4`;

    const outputPath = await convertMedia({
      inputPath,
      workDir,
      target: "m4a",
      timeoutMs: 1_000,
    });

    assert.equal(outputPath, `${workDir}/converted.m4a`);
    assert.equal(calls.length, 1, "exactly one subprocess, through runProcess");

    const args = calls[0]!.args;
    assert.equal(calls[0]!.command, config.ffmpegPath, "only the configured ffmpeg is invoked");
    assert.equal(calls[0]!.options.shell, false, "never through a shell");
    assert.equal(calls[0]!.options.cwd, workDir);

    assert.ok(args.includes("-vn"), "video must be dropped");
    const codecIndex = args.indexOf("-c:a");
    assert.notEqual(codecIndex, -1, "an explicit audio codec is required");
    assert.equal(args[codecIndex + 1], "aac", "m4a extraction uses AAC");

    const inputIndex = args.indexOf("-i");
    assert.notEqual(inputIndex, -1);
    assert.equal(args[inputIndex + 1], inputPath, "the local input path is passed verbatim");
    assert.equal(args[args.length - 1], outputPath, "the output path is the controlled last arg");
    assert.ok(args.includes("-nostdin"));
  });

  it("refuses a remote input before any subprocess is created", async () => {
    const calls = captureSpawn();

    for (const remote of [
      "https://cdn.example.com/video.mp4",
      "http://cdn.example.com/video.mp4",
      "//cdn.example.com/video.mp4",
      "file:///etc/passwd",
    ]) {
      await assert.rejects(
        () =>
          convertMedia({
            inputPath: remote,
            workDir: "/tmp/videofetch/jobs/abc",
            target: "m4a",
            timeoutMs: 1_000,
          }),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, "PROCESSING_FAILED");
          return true;
        },
        remote,
      );
    }

    assert.equal(calls.length, 0, "no remote input may ever reach a subprocess");
  });

  it("propagates the AbortSignal into the m4a conversion subprocess", async () => {
    const controller = new AbortController();
    const killed: NodeJS.Signals[][] = [];

    const calls = captureSpawn((child) => {
      // The process stays alive until the signal aborts it.
      queueMicrotask(() => {
        controller.abort();
        queueMicrotask(() => {
          killed.push(child.killCalls);
          child.emit("close", null);
        });
      });
    });

    await assert.rejects(
      () =>
        convertMedia({
          inputPath: "/tmp/videofetch/jobs/abc/source.mp4",
          workDir: "/tmp/videofetch/jobs/abc",
          target: "m4a",
          timeoutMs: 60_000,
          signal: controller.signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "PROCESSING_FAILED");
        assert.match(err.message, /cancelled/i);
        return true;
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(controller.signal.aborted, true);
  });

  it("rejects immediately when the signal is already aborted, without spawning", async () => {
    const calls = captureSpawn();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        convertMedia({
          inputPath: "/tmp/videofetch/jobs/abc/source.mp4",
          workDir: "/tmp/videofetch/jobs/abc",
          target: "m4a",
          timeoutMs: 1_000,
          signal: controller.signal,
        }),
      (err: unknown) => err instanceof AppError && err.code === "PROCESSING_FAILED",
    );

    assert.equal(calls.length, 0, "an aborted job must not spawn ffmpeg");
  });

  it("a non-zero ffmpeg exit becomes PROCESSING_FAILED with no raw stderr", async () => {
    captureSpawn((child) => {
      queueMicrotask(() => {
        child.stderr.write("FFMPEG_SECRET: /private/path exploded");
        child.emit("close", 1);
      });
    });

    await assert.rejects(
      () =>
        convertMedia({
          inputPath: "/tmp/videofetch/jobs/abc/source.mp4",
          workDir: "/tmp/videofetch/jobs/abc",
          target: "m4a",
          timeoutMs: 1_000,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "PROCESSING_FAILED");
        assert.ok(!err.message.includes("FFMPEG_SECRET"), "raw stderr must not leak");
        return true;
      },
    );
  });

  it("every worker plan target maps to a distinct controlled output name", async () => {
    const workDir = "/tmp/videofetch/jobs/abc";
    const expected: Record<string, string> = {
      mp4: `${workDir}/converted.mp4`,
      webm: `${workDir}/converted.webm`,
      m4a: `${workDir}/converted.m4a`,
      mp3: `${workDir}/converted.mp3`,
    };

    for (const [target, outPath] of Object.entries(expected)) {
      const calls = captureSpawn();
      const result = await convertMedia({
        inputPath: `${workDir}/source.mkv`,
        workDir,
        target: target as "mp4" | "webm" | "m4a" | "mp3",
        timeoutMs: 1_000,
      });
      assert.equal(result, outPath, `${target}: output path`);
      assert.equal(calls[0]!.args[calls[0]!.args.length - 1], outPath, `${target}: last arg`);
      setProcessRunnerTestHooks(null);
    }
  });
});

describe("split merge argv policy (SPLIT-02)", () => {
  const mp4 = () =>
    buildSplitMergeArgs({
      target: "mp4",
      videoPath: "/w/v.mp4",
      audioPath: "/w/a.m4a",
      outputPath: "/w/merged.mp4",
    });
  const webm = () =>
    buildSplitMergeArgs({
      target: "webm",
      videoPath: "/w/v.webm",
      audioPath: "/w/a.webm",
      outputPath: "/w/merged.webm",
    });

  it("builds the exact MP4 command family", () => {
    assert.deepEqual(mp4(), [
      "-n", "-nostdin", "-v", "error",
      "-protocol_whitelist", "file", "-f", "mov", "-i", "/w/v.mp4",
      "-protocol_whitelist", "file", "-f", "mov", "-i", "/w/a.m4a",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "copy",
      "-map_metadata", "-1", "-map_chapters", "-1",
      "-movflags", "+faststart",
      "-f", "mp4", "/w/merged.mp4",
    ]);
  });

  it("builds the exact WebM command family", () => {
    assert.deepEqual(webm(), [
      "-n", "-nostdin", "-v", "error",
      "-protocol_whitelist", "file", "-f", "matroska", "-i", "/w/v.webm",
      "-protocol_whitelist", "file", "-f", "matroska", "-i", "/w/a.webm",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "copy",
      "-map_metadata", "-1", "-map_chapters", "-1",
      "-f", "webm", "/w/merged.webm",
    ]);
  });

  it("restricts EACH input to local file access with an explicit demuxer", () => {
    // M1 guard. The whitelist is a per-input option, so it must precede both
    // `-i` flags, not just the first.
    for (const [args, demuxer] of [
      [mp4(), "mov"],
      [webm(), "matroska"],
    ] as const) {
      const inputs = args.flatMap((arg, index) => (arg === "-i" ? [index] : []));
      assert.equal(inputs.length, 2, "exactly two inputs");
      for (const at of inputs) {
        assert.deepEqual(args.slice(at - 4, at), ["-protocol_whitelist", "file", "-f", demuxer]);
      }
    }
  });

  it("maps exactly one video stream from input 0 and one audio stream from input 1", () => {
    // M3 guard.
    for (const args of [mp4(), webm()]) {
      const maps = args.flatMap((arg, index) => (arg === "-map" ? [args[index + 1]] : []));
      assert.deepEqual(maps, ["0:v:0", "1:a:0"]);
    }
  });

  it("stream-copies both streams and names no encoder, filter or transcode flag", () => {
    // M4 guard.
    const encoders = [
      "libx264", "libx265", "libvpx", "libvpx-vp9", "libopus", "libvorbis",
      "aac", "libmp3lame", "libaom-av1", "libsvtav1", "h264", "vp9", "opus",
    ];
    const flags = ["-c", "-codec", "-vcodec", "-acodec", "-vf", "-af", "-filter_complex", "-crf", "-b:v", "-b:a"];
    for (const args of [mp4(), webm()]) {
      assert.equal(args[args.indexOf("-c:v") + 1], "copy");
      assert.equal(args[args.indexOf("-c:a") + 1], "copy");
      for (const encoder of encoders) assert.ok(!args.includes(encoder), `no ${encoder}`);
      for (const flag of flags) assert.ok(!args.includes(flag), `no ${flag}`);
    }
  });

  it("never truncates the video with -shortest", () => {
    for (const args of [mp4(), webm()]) assert.ok(!args.includes("-shortest"));
  });

  it("forces the output muxer from the closed target, not the extension", () => {
    assert.deepEqual(mp4().slice(-3), ["-f", "mp4", "/w/merged.mp4"]);
    assert.deepEqual(webm().slice(-3), ["-f", "webm", "/w/merged.webm"]);
  });

  it("drops upstream metadata and chapters", () => {
    for (const args of [mp4(), webm()]) {
      assert.equal(args[args.indexOf("-map_metadata") + 1], "-1");
      assert.equal(args[args.indexOf("-map_chapters") + 1], "-1");
    }
  });

  it("uses +faststart for MP4 only and injects no MP4 option into WebM", () => {
    assert.equal(mp4()[mp4().indexOf("-movflags") + 1], "+faststart");
    assert.ok(!webm().includes("-movflags"));
    assert.ok(!webm().includes("+faststart"));
  });

  it("never overwrites: -n leads BOTH command families and -y appears nowhere (SPLIT-04)", () => {
    // M9 guard. `-y` would let FFmpeg truncate an output entry that appeared
    // after `mergeSplitMedia`'s own existence check.
    for (const args of [mp4(), webm()]) {
      assert.equal(args[0], "-n");
      assert.equal(args.filter((arg) => arg === "-n").length, 1);
      assert.ok(!args.includes("-y"), "no -y anywhere in the split merge");
    }
  });
});

describe("split merge execution (SPLIT-02)", () => {
  const ISO = "mov,mp4,m4a,3gp,3g2,mj2";
  const WEBM = "matroska,webm";

  type Step =
    | { kind: "probe"; stdout: string; code?: number }
    | {
        kind: "ffmpeg";
        /** May return an exit code, to emulate FFmpeg deciding from its argv. */
        write?: (outputPath: string, args: readonly string[]) => Promise<void | number>;
        code?: number;
        stdout?: string;
        stderr?: string;
      }
    | { kind: "hang"; stderr?: string };

  type Child = EventEmitter & {
    pid?: number;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals) => boolean;
  };

  type MergeOptions = Parameters<typeof mergeSplitMedia>[0];

  let workDir: string;
  let real: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vf-merge-"));
    real = await realpath(workDir);
  });

  afterEach(async () => {
    setProcessRunnerTestHooks(null);
    await rm(workDir, { recursive: true, force: true });
  });

  /** One verbatim ffprobe capture from the accepted Worker image. */
  function pinned(name: string): Promise<string> {
    return readFile(join(import.meta.dirname, "testdata", `pinned-ffprobe-${name}.json`), "utf8");
  }

  /** A probe document of an arbitrary shape, for the rejection cases. */
  function doc(formatName: string, kinds: readonly string[]): string {
    return JSON.stringify({
      programs: [],
      streams: kinds.map((codec_type) => ({ codec_type })),
      format: { format_name: formatName },
    });
  }

  async function defaultOutput(outputPath: string): Promise<void> {
    await writeFile(outputPath, Buffer.alloc(2048, 7));
  }

  /**
   * Scripts each spawn in order. FFmpeg's step really writes the output file,
   * because the primitive validates the artifact on disk rather than trusting
   * the exit code. `processKill` is hooked so no real process group is ever
   * signalled.
   */
  function harness(steps: readonly Step[], onSpawn?: (index: number) => void) {
    const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
    const children: Child[] = [];
    const groupKills: number[] = [];
    const closeLater = (child: Child, code: number | null) => {
      setImmediate(() => child.emit("close", code));
    };

    setProcessRunnerTestHooks({
      platform: "linux",
      spawn: (command, args, options) => {
        const index = calls.length;
        calls.push({ command, args: [...args], options });
        const child = new EventEmitter() as Child;
        child.pid = 73_000 + index;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        children.push(child);

        const step = steps[index];
        queueMicrotask(() => {
          if (!step) {
            // An unscripted spawn: every test also asserts its spawn count.
            closeLater(child, 97);
            return;
          }
          if (step.kind === "probe") {
            child.stdout.write(step.stdout);
            closeLater(child, step.code ?? 0);
          } else if (step.kind === "ffmpeg") {
            const outputPath = args[args.length - 1];
            void (async () => {
              const exit = step.write
                ? await step.write(outputPath, args)
                : await defaultOutput(outputPath);
              if (step.stdout) child.stdout.write(step.stdout);
              if (step.stderr) child.stderr.write(step.stderr);
              closeLater(child, typeof exit === "number" ? exit : (step.code ?? 0));
            })();
          } else if (step.stderr) {
            // "hang": emits some output, then never exits on its own.
            child.stderr.write(step.stderr);
          }
        });
        onSpawn?.(index);
        return child as unknown as ChildProcess;
      },
      processKill: (pid) => {
        groupKills.push(pid);
        const owner = children.find((child) => child.pid === -pid);
        if (owner) queueMicrotask(() => owner.emit("close", null));
        return true;
      },
    });

    const ffmpegCalls = () => calls.filter((call) => call.command === config.ffmpegPath);
    return { calls, children, groupKills, ffmpegCalls };
  }

  async function inputs(target: string) {
    const videoPath = join(workDir, target === "mp4" ? "v.mp4" : "v.webm");
    const audioPath = join(workDir, target === "mp4" ? "a.m4a" : "a.webm");
    await writeFile(videoPath, "video-bytes");
    await writeFile(audioPath, "audio-bytes");
    return { videoPath, audioPath };
  }

  async function merge(overrides: Partial<MergeOptions> = {}): Promise<string> {
    const target = overrides.target ?? "mp4";
    const paths = await inputs(target);
    return mergeSplitMedia({
      ...paths,
      workDir,
      target,
      timeoutMs: 5_000,
      maxOutputBytes: 1_000_000,
      ...overrides,
    });
  }

  async function rejectsWith(code: string, fn: () => Promise<unknown>): Promise<void> {
    await assert.rejects(fn, (err: unknown) => {
      assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
      assert.equal(err.code, code);
      return true;
    });
  }

  const goodMp4Halves = (): Step[] => [
    { kind: "probe", stdout: doc(ISO, ["video"]) },
    { kind: "probe", stdout: doc(ISO, ["audio"]) },
  ];

  it("merges an ISO-BMFF video-only + audio-only pair into a validated MP4", async () => {
    const { calls, ffmpegCalls } = harness([
      { kind: "probe", stdout: await pinned("iso-bmff-video-only") },
      { kind: "probe", stdout: await pinned("iso-bmff-audio-only") },
      { kind: "ffmpeg" },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
    ]);

    const out = await merge({ target: "mp4" });

    const expectedOut = join(real, "merged.mp4");
    assert.equal(out, expectedOut);
    const ffprobe = resolveFfprobePath();
    assert.deepEqual(
      calls.map((call) => call.command),
      [ffprobe, ffprobe, config.ffmpegPath, ffprobe],
    );
    for (const call of calls) assert.equal(call.options.shell, false);
    // Probes: video half, audio half, then the produced artifact — each by its
    // real path and each through the ISO-BMFF demuxer.
    for (const [index, path] of [
      [0, join(real, "v.mp4")],
      [1, join(real, "a.m4a")],
      [3, expectedOut],
    ] as const) {
      assert.equal(calls[index].args[calls[index].args.length - 1], path);
      assert.equal(calls[index].args[calls[index].args.indexOf("-f") + 1], "mov");
    }
    assert.deepEqual(
      ffmpegCalls()[0].args,
      buildSplitMergeArgs({
        target: "mp4",
        videoPath: join(real, "v.mp4"),
        audioPath: join(real, "a.m4a"),
        outputPath: expectedOut,
      }),
    );
  });

  it("merges a WebM video-only + audio-only pair into a validated WebM", async () => {
    const { calls, ffmpegCalls } = harness([
      { kind: "probe", stdout: await pinned("webm-video-only") },
      { kind: "probe", stdout: await pinned("webm-audio-only") },
      { kind: "ffmpeg" },
      { kind: "probe", stdout: await pinned("webm-merged") },
    ]);

    const out = await merge({ target: "webm" });

    assert.equal(out, join(real, "merged.webm"));
    assert.equal(calls.length, 4);
    for (const index of [0, 1, 3]) {
      assert.equal(calls[index].args[calls[index].args.indexOf("-f") + 1], "matroska");
    }
    assert.deepEqual(
      ffmpegCalls()[0].args,
      buildSplitMergeArgs({
        target: "webm",
        videoPath: join(real, "v.webm"),
        audioPath: join(real, "a.webm"),
        outputPath: join(real, "merged.webm"),
      }),
    );
  });

  it("refuses ambiguous or mismatched INPUT shapes before FFmpeg ever runs", async () => {
    const video = doc(ISO, ["video"]);
    // [label, video-half probe, audio-half probe (null = never reached)]
    const cases: ReadonlyArray<readonly [string, string, string | null]> = [
      ["muxed media as the video half", doc(ISO, ["video", "audio"]), null],
      ["two video streams", doc(ISO, ["video", "video"]), null],
      ["video half in the wrong family", doc(WEBM, ["video"]), null],
      ["video half with zero streams", doc(ISO, []), null],
      ["video half with a subtitle stream", doc(ISO, ["video", "subtitle"]), null],
      ["muxed media as the audio half", video, doc(ISO, ["video", "audio"])],
      ["two audio streams", video, doc(ISO, ["audio", "audio"])],
      ["audio half that carries only video", video, doc(ISO, ["video"])],
      ["audio half in the wrong family", video, doc(WEBM, ["audio"])],
      ["audio half with a data stream", video, doc(ISO, ["audio", "data"])],
    ];
    for (const [label, videoDoc, audioDoc] of cases) {
      const steps: Step[] = [{ kind: "probe", stdout: videoDoc }];
      if (audioDoc !== null) steps.push({ kind: "probe", stdout: audioDoc });
      const { calls, ffmpegCalls } = harness(steps);
      await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
      assert.equal(ffmpegCalls().length, 0, `${label}: FFmpeg must not run`);
      assert.equal(calls.length, steps.length, `${label}: unexpected spawn count`);
    }
  });

  it("refuses ISO-BMFF halves for a WebM target", async () => {
    const { ffmpegCalls } = harness([{ kind: "probe", stdout: doc(ISO, ["video"]) }]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "webm" }));
    assert.equal(ffmpegCalls().length, 0);
  });

  it("fails closed when an input probe exits non-zero", async () => {
    const { ffmpegCalls } = harness([
      { kind: "probe", stdout: doc(ISO, ["video"]) },
      { kind: "probe", stdout: "{\n\n}\n", code: 1 },
    ]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
    assert.equal(ffmpegCalls().length, 0);
  });

  it("refuses a merged artifact without exactly one video and one audio stream", async () => {
    // M5 guard.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["wrong family", doc(WEBM, ["video", "audio"])],
      ["video only", doc(ISO, ["video"])],
      ["audio only", doc(ISO, ["audio"])],
      ["duplicate video", doc(ISO, ["video", "video", "audio"])],
      ["duplicate audio", doc(ISO, ["video", "audio", "audio"])],
      ["unsupported third stream", doc(ISO, ["video", "audio", "subtitle"])],
    ];
    for (const [label, outputDoc] of cases) {
      await rm(join(workDir, "merged.mp4"), { force: true });
      const { calls } = harness([
        ...goodMp4Halves(),
        { kind: "ffmpeg" },
        { kind: "probe", stdout: outputDoc },
      ]);
      await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
      assert.equal(calls.length, 4, `${label}: the artifact must have been probed`);
    }
  });

  it("refuses a zero-byte artifact without probing it", async () => {
    const { calls } = harness([
      ...goodMp4Halves(),
      { kind: "ffmpeg", write: (path) => writeFile(path, "") },
    ]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
    assert.equal(calls.length, 3);
  });

  it("refuses when FFmpeg exits zero but produced nothing", async () => {
    const { calls } = harness([...goodMp4Halves(), { kind: "ffmpeg", write: async () => {} }]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
    assert.equal(calls.length, 3);
  });

  it("refuses an artifact that is a symlink escaping the work directory", async () => {
    const { calls } = harness([
      ...goodMp4Halves(),
      { kind: "ffmpeg", write: (path) => symlink("/etc/hosts", path) },
    ]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
    assert.equal(calls.length, 3);
  });

  it("refuses an artifact that is a symlink even to a file inside the work directory", async () => {
    const { calls } = harness([
      ...goodMp4Halves(),
      {
        kind: "ffmpeg",
        write: async (path) => {
          const other = join(real, "other.bin");
          await writeFile(other, Buffer.alloc(64, 1));
          await symlink(other, path);
        },
      },
    ]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
    assert.equal(calls.length, 3);
  });

  it("refuses an artifact that is a directory", async () => {
    const { calls } = harness([
      ...goodMp4Halves(),
      {
        kind: "ffmpeg",
        write: async (path) => {
          await mkdir(path);
        },
      },
    ]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
    assert.equal(calls.length, 3);
  });

  it("reports an artifact over maxOutputBytes as TOO_LARGE, before probing it", async () => {
    // M7 guard. The final size check is authoritative; no acquisition headroom
    // stands in for it.
    const { calls } = harness([
      ...goodMp4Halves(),
      { kind: "ffmpeg", write: (path) => writeFile(path, Buffer.alloc(1_001, 1)) },
    ]);
    await rejectsWith("TOO_LARGE", () => merge({ target: "mp4", maxOutputBytes: 1_000 }));
    assert.equal(calls.length, 3);
  });

  it("accepts an artifact of exactly maxOutputBytes", async () => {
    const { calls } = harness([
      ...goodMp4Halves(),
      { kind: "ffmpeg", write: (path) => writeFile(path, Buffer.alloc(1_000, 1)) },
      { kind: "probe", stdout: doc(ISO, ["video", "audio"]) },
    ]);
    const out = await merge({ target: "mp4", maxOutputBytes: 1_000 });
    assert.equal(out, join(real, "merged.mp4"));
    assert.equal(calls.length, 4);
  });

  it("refuses to run when anything already exists at the fixed output name", async () => {
    await writeFile(join(workDir, "merged.mp4"), "stale");
    const { calls } = harness([]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
    assert.equal(calls.length, 0);
  });

  it("never writes through a pre-placed output symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "vf-victim-"));
    try {
      const victim = join(outside, "victim.bin");
      await writeFile(victim, "untouched");
      await symlink(victim, join(workDir, "merged.mp4"));
      const { calls } = harness([]);
      await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
      assert.equal(calls.length, 0);
      assert.equal(await readFile(victim, "utf8"), "untouched");

      // A DANGLING symlink is refused too: it is not free space.
      await rm(join(workDir, "merged.mp4"));
      await symlink(join(outside, "absent.bin"), join(workDir, "merged.mp4"));
      const second = harness([]);
      await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
      assert.equal(second.calls.length, 0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses the same file as both halves", async () => {
    const { calls } = harness([]);
    const { videoPath } = await inputs("mp4");
    await rejectsWith("PROCESSING_FAILED", () =>
      merge({ target: "mp4", videoPath, audioPath: videoPath }),
    );
    assert.equal(calls.length, 0);
  });

  it("refuses an input that sits at the fixed output name, and leaves it intact", async () => {
    const clash = join(workDir, "merged.mp4");
    await writeFile(clash, "video-bytes");
    const { calls } = harness([]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4", videoPath: clash }));
    assert.equal(calls.length, 0);
    assert.equal(await readFile(clash, "utf8"), "video-bytes");
  });

  it("never spawns for a remote, relative, escaping, outside or non-regular input", async () => {
    // M2 guard.
    const sibling = await mkdtemp(join(tmpdir(), "vf-sibling-"));
    try {
      const outsideFile = join(sibling, "v.mp4");
      await writeFile(outsideFile, "x");
      const escape = join(workDir, "escape.m4a");
      await symlink("/etc/hosts", escape);
      const directory = join(workDir, "sub");
      await mkdir(directory);
      const bad: ReadonlyArray<Partial<MergeOptions>> = [
        { videoPath: "https://cdn.example/v.mp4" },
        { videoPath: "http://example.com/v.mp4" },
        { audioPath: "file:///etc/passwd" },
        { audioPath: "//cdn.example/a.m4a" },
        { videoPath: "" },
        { videoPath: "v.mp4" },
        { videoPath: outsideFile },
        { audioPath: escape },
        { videoPath: directory },
        { workDir: "https://cdn.example/" },
      ];
      for (const overrides of bad) {
        const { calls } = harness([]);
        await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4", ...overrides }));
        assert.equal(calls.length, 0, `${JSON.stringify(overrides)} reached a subprocess`);
      }
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("reports FFmpeg failure without leaking its stderr", async () => {
    const secret = "FFMPEG-DIAGNOSTIC-SECRET-51c2";
    const { calls } = harness([
      ...goodMp4Halves(),
      { kind: "ffmpeg", write: async () => {}, code: 1, stderr: secret },
    ]);
    await assert.rejects(
      () => merge({ target: "mp4" }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "PROCESSING_FAILED");
        assert.ok(!err.message.includes(secret), "raw FFmpeg stderr must not reach the AppError");
        return true;
      },
    );
    assert.equal(calls.length, 3, "a failed merge is never probed");
  });

  it("fails closed when FFmpeg stderr exceeds its hard ceiling", async () => {
    harness([...goodMp4Halves(), { kind: "ffmpeg", stderr: "e".repeat(400_000) }]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
  });

  it("fails closed when FFmpeg stdout exceeds its hard ceiling", async () => {
    harness([...goodMp4Halves(), { kind: "ffmpeg", stdout: "o".repeat(100_000) }]);
    await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
  });

  it("bounds the merge with the caller's timeout and kills its process group", async () => {
    const { calls, children, groupKills } = harness([...goodMp4Halves(), { kind: "hang" }]);
    await rejectsWith("TIMEOUT", () => merge({ target: "mp4", timeoutMs: 40 }));
    assert.equal(calls.length, 3);
    assert.deepEqual(groupKills, [-(children[2].pid as number)]);
  });

  it("terminates FFmpeg's process group when the caller aborts mid-merge", async () => {
    const controller = new AbortController();
    const secret = "PARTIAL-FFMPEG-OUTPUT-7d10";
    const { calls, children, groupKills } = harness(
      [...goodMp4Halves(), { kind: "hang", stderr: secret }],
      (index) => {
        if (index === 2) setTimeout(() => controller.abort(), 5);
      },
    );
    await assert.rejects(
      () => merge({ target: "mp4", signal: controller.signal }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "PROCESSING_FAILED");
        assert.ok(!err.message.includes(secret), "cancellation must not leak output");
        return true;
      },
    );
    assert.equal(calls.length, 3, "no artifact probe after a cancelled merge");
    assert.deepEqual(groupKills, [-(children[2].pid as number)]);
  });

  it("terminates a probe's process group on abort and never reaches FFmpeg", async () => {
    const controller = new AbortController();
    const { calls, children, groupKills, ffmpegCalls } = harness([{ kind: "hang" }], (index) => {
      if (index === 0) setTimeout(() => controller.abort(), 5);
    });
    await rejectsWith("PROCESSING_FAILED", () =>
      merge({ target: "mp4", signal: controller.signal }),
    );
    assert.equal(calls.length, 1);
    assert.equal(ffmpegCalls().length, 0);
    assert.deepEqual(groupKills, [-(children[0].pid as number)]);
  });

  it("spawns nothing at all for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls } = harness([]);
    await rejectsWith("PROCESSING_FAILED", () =>
      merge({ target: "mp4", signal: controller.signal }),
    );
    assert.equal(calls.length, 0);
  });

  it("refuses invalid bounds and an unknown target before spawning", async () => {
    const bad: ReadonlyArray<Partial<MergeOptions>> = [
      { maxOutputBytes: 0 },
      { maxOutputBytes: -1 },
      { maxOutputBytes: Number.NaN },
      { maxOutputBytes: 1.5 },
      { timeoutMs: 0 },
      { timeoutMs: -5 },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { target: "mkv" as never },
    ];
    for (const overrides of bad) {
      const { calls } = harness([]);
      await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4", ...overrides }));
      assert.equal(calls.length, 0, `${JSON.stringify(overrides)} reached a subprocess`);
    }
  });

  /**
   * SPLIT-04: FFmpeg's overwrite policy, emulated at the spawn boundary from
   * the REAL argv. With `-n`, FFmpeg checks the output with `access(F_OK)` —
   * which follows symlinks, so `realpath` is the faithful stand-in — and exits
   * 1 without opening it if it exists. Otherwise (`-y`) it opens the path for
   * writing, through a symlink if there is one.
   *
   * `raceEntry` runs first: it is another writer creating the output entry
   * AFTER `mergeSplitMedia`'s own pre-check, which has already passed by the
   * time FFmpeg is spawned.
   */
  function ffmpegOverwritePolicy(raceEntry: (outputPath: string) => Promise<void>) {
    return async (outputPath: string, args: readonly string[]): Promise<number> => {
      await raceEntry(outputPath);
      const exists = await realpath(outputPath).then(
        () => true,
        () => false,
      );
      if (args.includes("-n") && exists) return 1;
      await writeFile(outputPath, Buffer.alloc(2048, 7));
      return 0;
    };
  }

  for (const target of ["mp4", "webm"] as const) {
    it(`${target}: an output FILE appearing after the pre-check is refused by FFmpeg, never truncated (SPLIT-04)`, async () => {
      const family = target === "mp4" ? ISO : WEBM;
      const { calls } = harness([
        { kind: "probe", stdout: doc(family, ["video"]) },
        { kind: "probe", stdout: doc(family, ["audio"]) },
        { kind: "ffmpeg", write: ffmpegOverwritePolicy((path) => writeFile(path, "foreign")) },
      ]);
      await rejectsWith("PROCESSING_FAILED", () => merge({ target }));
      assert.equal(calls.length, 3, "a refused merge is never probed as an artifact");
      assert.equal(await readFile(join(workDir, `merged.${target}`), "utf8"), "foreign", "never truncated");
    });
  }

  it("a live output SYMLINK appearing after the pre-check is never written through (SPLIT-04)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "vf-race-victim-"));
    try {
      const victim = join(outside, "victim.bin");
      await writeFile(victim, "untouched");
      const { calls } = harness([
        ...goodMp4Halves(),
        { kind: "ffmpeg", write: ffmpegOverwritePolicy((path) => symlink(victim, path)) },
      ]);
      await rejectsWith("PROCESSING_FAILED", () => merge({ target: "mp4" }));
      assert.equal(calls.length, 3);
      assert.equal(await readFile(victim, "utf8"), "untouched", "the file outside the workDir is intact");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
