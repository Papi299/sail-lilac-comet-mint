import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { config } from "../../lib/config.ts";
import { AppError } from "../../lib/errors.ts";
import { setProcessRunnerTestHooks, type SpawnImpl } from "./process-runner.server.ts";
import { assertLocalMediaPath, convertMedia } from "./ffmpeg.server.ts";

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
