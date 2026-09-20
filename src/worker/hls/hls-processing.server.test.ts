import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { resolveFfprobePath } from "@/services/processing/ffprobe.server.ts";
import {
  setProcessRunnerTestHooks,
  type SpawnImpl,
} from "@/services/processing/process-runner.server.ts";
import { DEFAULT_MAX_FILE_SIZE_BYTES } from "@/shared/media-limits.ts";
import { YTDLP_V1_NATIVE_PROTOCOLS } from "../analysis/ytdlp-analysis.server.ts";
import { GENERIC_SOURCE_PROTOCOLS } from "../execution/generic-source.ts";
import {
  STARTUP_WORKSPACE_FOOTPRINT,
  requiredWorkspaceBytes,
} from "../execution/workspace-capacity.ts";
import { AGGREGATE_FILE_NAME } from "./hls-fragment-acquisition.server.ts";
import {
  HLS_OUTPUT_FILE_NAME,
  HLS_OUTPUT_PARTIAL_FILE_NAME,
  HLS_V1_MP4_STREAM_SHAPE,
  HLS_V1_PROCESSING_WORKSPACE_FOOTPRINT,
  HLS_V1_TS_STREAM_SHAPE,
  buildClearHlsRemuxArgs,
  processClearHlsTsToMp4,
  remainingBudgetMs,
  setClearHlsProcessingBarrierForTests,
  type ClearHlsProcessedMp4,
  type ClearHlsProcessingRequest,
  type ProcessingFinalizationStep,
} from "./hls-processing.server.ts";

/**
 * HLS-4: clear-HLS MPEG-TS → MP4 local processing.
 *
 * Every test runs against a scripted process-runner harness and a throwaway
 * local workDir. No real ffprobe or FFmpeg is ever executed, no real process
 * group is ever signalled, and nothing touches the network — this module has no
 * network surface at all, which is itself one of the properties pinned below.
 *
 * The harness scripts each spawn IN ORDER, because the order is load-bearing:
 *
 *   0  ffprobe  the acquired MPEG-TS source
 *   1  ffmpeg   the stream-copy remux into the partial
 *   2  ffprobe  the produced partial
 *   3  ffprobe  the finalized MP4
 *
 * Every test also asserts its spawn COUNT, so a validation stage that silently
 * stopped running would fail rather than quietly pass.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MODULE_PATH = join(ROOT, "src/worker/hls/hls-processing.server.ts");
const ACQUISITION_PATH = join(ROOT, "src/worker/hls/hls-fragment-acquisition.server.ts");
const HLS_DIR = dirname(MODULE_PATH);
const TESTDATA = join(ROOT, "src/services/processing/testdata");

/** Verbatim ffprobe captures from the pinned runtime. */
function pinned(name: string): Promise<string> {
  return readFile(join(TESTDATA, `pinned-ffprobe-${name}.json`), "utf8");
}

/** A probe document of an arbitrary shape, for the rejection cases. */
function doc(formatName: string, kinds: readonly string[]): string {
  return JSON.stringify({
    programs: [],
    streams: kinds.map((codec_type) => ({ codec_type })),
    format: { format_name: formatName },
  });
}

const MPEGTS = "mpegts";
const ISO = "mov,mp4,m4a,3gp,3g2,mj2";
const WEBM = "matroska,webm";

// ── The throwaway workDir ────────────────────────────────────────────────────

let workDir = "";
let workDirReal = "";
let controller = new AbortController();
const sockets: Server[] = [];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "hls4-"));
  workDirReal = await realpath(workDir);
  controller = new AbortController();
});

afterEach(async () => {
  setProcessRunnerTestHooks(null);
  setClearHlsProcessingBarrierForTests(null);
  for (const server of sockets.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  await rm(workDir, { recursive: true, force: true });
});

function sourcePath(): string {
  return join(workDir, AGGREGATE_FILE_NAME);
}
function partialPath(): string {
  return join(workDirReal, HLS_OUTPUT_PARTIAL_FILE_NAME);
}
function outputPath(): string {
  return join(workDirReal, HLS_OUTPUT_FILE_NAME);
}
function workDirEntries(): string[] {
  return readdirSync(workDirReal).sort();
}

// ── Fixture construction ─────────────────────────────────────────────────────

type Artifact = { readonly filePath: string; readonly segmentType: "mpegts"; readonly fileSize: number };

/**
 * An artifact shaped exactly the way HLS-3 freezes one, with real bytes behind
 * it. Note the path spelling: HLS-3 joins onto `resolve(workDir)` and does NOT
 * realpath, so on macOS (`/var` -> `/private/var`) the artifact really does
 * carry the unresolved spelling, and HLS-4 has to accept it.
 */
async function writeSource(bytes = 4096): Promise<Artifact> {
  const path = sourcePath();
  await writeFile(path, Buffer.alloc(bytes, 0x47));
  return Object.freeze({ filePath: path, segmentType: "mpegts" as const, fileSize: bytes });
}

// ── The scripted subprocess harness ──────────────────────────────────────────

type Step =
  | { kind: "probe"; stdout: string; code?: number; stderr?: string; delayMs?: number }
  | {
      kind: "ffmpeg";
      /** May return an exit code, to emulate FFmpeg deciding from its argv. */
      write?: (outputPath: string, args: readonly string[]) => Promise<void | number>;
      code?: number;
      stdout?: string;
      stderr?: string;
      delayMs?: number;
    }
  | { kind: "hang"; stderr?: string };

type Child = EventEmitter & {
  pid?: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals) => boolean;
  killCalls: NodeJS.Signals[];
};

async function defaultOutput(path: string): Promise<void> {
  await writeFile(path, Buffer.alloc(2048, 0x11));
}

/**
 * Scripts each spawn in order.
 *
 * FFmpeg's step really writes its output file, because the primitive validates
 * the artifact on disk rather than trusting the exit code. `processKill` is
 * ALWAYS hooked: without it the runner's termination path would ask the HOST to
 * SIGKILL a process group belonging to an unrelated process, since a fabricated
 * PID is still a real PID to the kernel.
 */
function harness(steps: readonly Step[], onSpawn?: (index: number) => void) {
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const children: Child[] = [];
  const groupKills: number[] = [];

  const closeLater = (child: Child, code: number | null, delayMs = 0) => {
    if (delayMs > 0) setTimeout(() => child.emit("close", code), delayMs);
    else setImmediate(() => child.emit("close", code));
  };

  const spawnImpl: SpawnImpl = (command, args, options) => {
    const index = calls.length;
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as Child;
    child.pid = 73_000 + index;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killCalls = [];
    child.kill = (signal?: NodeJS.Signals) => {
      child.killCalls.push(signal ?? ("SIGTERM" as NodeJS.Signals));
      return true;
    };
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
        if (step.stderr) child.stderr.write(step.stderr);
        closeLater(child, step.code ?? 0, step.delayMs);
      } else if (step.kind === "ffmpeg") {
        const produced = args[args.length - 1] as string;
        void (async () => {
          const exit = step.write
            ? await step.write(produced, args)
            : await defaultOutput(produced);
          if (step.stdout) child.stdout.write(step.stdout);
          if (step.stderr) child.stderr.write(step.stderr);
          closeLater(child, typeof exit === "number" ? exit : (step.code ?? 0), step.delayMs);
        })();
      } else if (step.stderr) {
        // "hang": emits some output, then never exits on its own.
        child.stderr.write(step.stderr);
      }
    });
    onSpawn?.(index);
    return child as unknown as ChildProcess;
  };

  setProcessRunnerTestHooks({
    platform: "linux",
    spawn: spawnImpl,
    processKill: (pid) => {
      groupKills.push(pid);
      const owner = children.find((child) => child.pid === -pid);
      if (owner) queueMicrotask(() => owner.emit("close", null));
      return true;
    },
  });

  return { calls, children, groupKills };
}

const FFPROBE = resolveFfprobePath();

/** The happy-path script: source probe, remux, partial probe, final probe. */
async function happyScript(): Promise<Step[]> {
  return [
    { kind: "probe", stdout: await pinned("mpegts-muxed") },
    { kind: "ffmpeg" },
    { kind: "probe", stdout: await pinned("iso-bmff-merged") },
    { kind: "probe", stdout: await pinned("iso-bmff-merged") },
  ];
}

type RunOverrides = Partial<Omit<ClearHlsProcessingRequest, "source">> & { source?: unknown };

async function run(overrides: RunOverrides = {}): Promise<ClearHlsProcessedMp4> {
  const source = "source" in overrides ? overrides.source : await writeSource();
  return processClearHlsTsToMp4({
    source: source as Artifact,
    workDir: overrides.workDir ?? workDir,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    maxOutputBytes: overrides.maxOutputBytes ?? 1_000_000,
    signal: overrides.signal ?? controller.signal,
  });
}

async function rejectsWith(code: string, fn: () => Promise<unknown>, label?: string): Promise<AppError> {
  let captured: AppError | null = null;
  await assert.rejects(
    fn,
    (err: unknown) => {
      assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
      assert.equal(err.code, code, label);
      captured = err;
      return true;
    },
    label,
  );
  return captured as unknown as AppError;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. INPUT AUTHORITY (§8)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-4 input authority: only the HLS-3 artifact, proven before any spawn", () => {
  it("refuses a request whose source is not an HLS-3-shaped artifact", async () => {
    const { calls } = harness(await happyScript());
    const path = sourcePath();
    await writeFile(path, Buffer.alloc(16, 1));

    const rejected: unknown[] = [
      null,
      undefined,
      "hls-source.ts",
      42,
      [],
      // not frozen
      { filePath: path, segmentType: "mpegts", fileSize: 16 },
      // an extra field means it came from somewhere this module has not reasoned about
      Object.freeze({ filePath: path, segmentType: "mpegts", fileSize: 16, extra: 1 }),
      // missing fields
      Object.freeze({ filePath: path, segmentType: "mpegts" }),
      Object.freeze({ filePath: path, fileSize: 16 }),
      // wrong field types
      Object.freeze({ filePath: path, segmentType: "mpegts", fileSize: "16" }),
      Object.freeze({ filePath: 0, segmentType: "mpegts", fileSize: 16 }),
      Object.freeze({ filePath: "", segmentType: "mpegts", fileSize: 16 }),
      Object.freeze({ filePath: path, segmentType: "mpegts", fileSize: 0 }),
      Object.freeze({ filePath: path, segmentType: "mpegts", fileSize: -1 }),
      Object.freeze({ filePath: path, segmentType: "mpegts", fileSize: 1.5 }),
      Object.freeze({ filePath: path, segmentType: "mpegts", fileSize: Number.NaN }),
      Object.freeze({ filePath: path, segmentType: "mpegts", fileSize: Number.MAX_SAFE_INTEGER + 2 }),
    ];

    for (const source of rejected) {
      await rejectsWith("PROCESSING_FAILED", async () => run({ source }), JSON.stringify(source) ?? "undefined");
    }
    assert.equal(calls.length, 0, "no subprocess may run for a malformed artifact");
  });

  it("refuses a segmentType that is not exactly mpegts", async () => {
    const { calls } = harness(await happyScript());
    const path = sourcePath();
    await writeFile(path, Buffer.alloc(16, 1));
    for (const segmentType of ["fmp4", "MPEGTS", "mpegts ", "", null, undefined]) {
      await rejectsWith("PROCESSING_FAILED", () =>
        run({ source: Object.freeze({ filePath: path, segmentType, fileSize: 16 }) }),
      );
    }
    assert.equal(calls.length, 0);
  });

  it("refuses a URL, a protocol-relative reference and a relative path", async () => {
    const { calls } = harness(await happyScript());
    for (const filePath of [
      "https://origin.example/media/hls-source.ts",
      "http://origin.example/hls-source.ts",
      "file:///tmp/hls-source.ts",
      "data:video/mp2t;base64,AAAA",
      "//origin.example/hls-source.ts",
      "hls-source.ts",
      "./hls-source.ts",
      "../hls-source.ts",
    ]) {
      await rejectsWith(
        "PROCESSING_FAILED",
        async () => run({ source: Object.freeze({ filePath, segmentType: "mpegts", fileSize: 16 }) }),
        filePath,
      );
    }
    assert.equal(calls.length, 0, "no remote or relative reference may reach a subprocess");
  });

  it("refuses a path outside the work directory", async () => {
    const { calls } = harness(await happyScript());
    const elsewhere = await mkdtemp(join(tmpdir(), "hls4-out-"));
    try {
      const outside = join(elsewhere, AGGREGATE_FILE_NAME);
      await writeFile(outside, Buffer.alloc(16, 1));
      await rejectsWith("PROCESSING_FAILED", () =>
        run({ source: Object.freeze({ filePath: outside, segmentType: "mpegts", fileSize: 16 }) }),
      );
      // A sibling directory that merely shares a string prefix is outside too.
      const sibling = `${workDir}2`;
      await mkdir(sibling, { recursive: true });
      try {
        const siblingSource = join(sibling, AGGREGATE_FILE_NAME);
        await writeFile(siblingSource, Buffer.alloc(16, 1));
        await rejectsWith("PROCESSING_FAILED", () =>
          run({
            source: Object.freeze({ filePath: siblingSource, segmentType: "mpegts", fileSize: 16 }),
          }),
        );
      } finally {
        await rm(sibling, { recursive: true, force: true });
      }
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
    assert.equal(calls.length, 0);
  });

  it("refuses a symlink at the source name, even one pointing inside the work directory", async () => {
    const { calls } = harness(await happyScript());
    const real = join(workDir, "real-bytes.ts");
    await writeFile(real, Buffer.alloc(16, 1));
    await symlink(real, sourcePath());
    await rejectsWith("PROCESSING_FAILED", () =>
      run({ source: Object.freeze({ filePath: sourcePath(), segmentType: "mpegts", fileSize: 16 }) }),
    );
    assert.equal(calls.length, 0, "a symlinked source must never be probed");
  });

  it("refuses a symlink that escapes the work directory", async () => {
    const { calls } = harness(await happyScript());
    const elsewhere = await mkdtemp(join(tmpdir(), "hls4-esc-"));
    try {
      const outside = join(elsewhere, "secret.ts");
      await writeFile(outside, Buffer.alloc(16, 1));
      await symlink(outside, sourcePath());
      await rejectsWith("PROCESSING_FAILED", () =>
        run({ source: Object.freeze({ filePath: sourcePath(), segmentType: "mpegts", fileSize: 16 }) }),
      );
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
    assert.equal(calls.length, 0);
  });

  it("refuses a directory at the source name", async () => {
    const { calls } = harness(await happyScript());
    await mkdir(sourcePath());
    await rejectsWith("PROCESSING_FAILED", () =>
      run({ source: Object.freeze({ filePath: sourcePath(), segmentType: "mpegts", fileSize: 16 }) }),
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a non-regular entry at the source name", async () => {
    const { calls } = harness(await happyScript());
    const path = sourcePath();
    // A unix socket: a real directory entry that is emphatically not a regular
    // file, and one FFmpeg would happily block on forever.
    await new Promise<void>((done, fail) => {
      const server = createServer();
      sockets.push(server);
      server.once("error", fail);
      server.listen(path, () => done());
    });
    await rejectsWith("PROCESSING_FAILED", () =>
      run({ source: Object.freeze({ filePath: path, segmentType: "mpegts", fileSize: 16 }) }),
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a regular file that is NOT the fixed HLS-3 artifact identity", async () => {
    const { calls } = harness(await happyScript());
    // Contained, regular, non-symlink, correctly sized — and still refused,
    // because containment is not identity. This is the check that stops HLS-4
    // remuxing some other file the job happens to have written.
    for (const name of ["other.ts", "hls-source.ts.part", "nested/hls-source.ts"]) {
      const path = join(workDir, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(16, 1));
      await rejectsWith(
        "PROCESSING_FAILED",
        async () => run({ source: Object.freeze({ filePath: path, segmentType: "mpegts", fileSize: 16 }) }),
        name,
      );
    }
    assert.equal(calls.length, 0, "a foreign in-directory file must never be probed");
  });

  it("accepts the artifact through an unresolved workDir spelling", async () => {
    const { calls } = harness(await happyScript());
    const source = await writeSource(1024);
    // `workDir` here is the mkdtemp spelling, which on macOS resolves through
    // /var -> /private/var. The result is reported at the REAL location.
    const result = await run({ source, workDir });
    assert.equal(result.filePath, outputPath());
    assert.equal(calls.length, 4);
  });

  it("refuses a declared fileSize that disagrees with the bytes on disk", async () => {
    const { calls } = harness(await happyScript());
    await writeFile(sourcePath(), Buffer.alloc(4096, 1));
    for (const fileSize of [4095, 4097, 1]) {
      await rejectsWith(
        "PROCESSING_FAILED",
        () =>
          run({ source: Object.freeze({ filePath: sourcePath(), segmentType: "mpegts", fileSize }) }),
        String(fileSize),
      );
    }
    assert.equal(calls.length, 0, "a size disagreement must be caught before any spawn");
  });

  it("refuses an empty source", async () => {
    const { calls } = harness(await happyScript());
    await writeFile(sourcePath(), Buffer.alloc(0));
    // A zero declared size fails the structural gate; a positive declared size
    // over an empty file fails the on-disk size gate. Both before any spawn.
    await rejectsWith("PROCESSING_FAILED", () =>
      run({ source: Object.freeze({ filePath: sourcePath(), segmentType: "mpegts", fileSize: 0 }) }),
    );
    await rejectsWith("PROCESSING_FAILED", () =>
      run({ source: Object.freeze({ filePath: sourcePath(), segmentType: "mpegts", fileSize: 1 }) }),
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a work directory that is missing, relative, a file or a URL", async () => {
    const { calls } = harness(await happyScript());
    const source = await writeSource();
    const notADir = join(workDir, "not-a-dir");
    await writeFile(notADir, "x");
    for (const dir of [
      join(workDir, "missing"),
      notADir,
      "relative/dir",
      "https://origin.example/jobs/abc",
      "//origin.example/jobs",
      "",
    ]) {
      await rejectsWith("PROCESSING_FAILED", async () => run({ source, workDir: dir }), dir);
    }
    assert.equal(calls.length, 0);
  });

  it("refuses an invalid timeout and an invalid output-size ceiling", async () => {
    const { calls } = harness(await happyScript());
    const source = await writeSource();
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejectsWith("PROCESSING_FAILED", async () => run({ source, timeoutMs }), `timeout ${timeoutMs}`);
    }
    for (const maxOutputBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejectsWith(
        "PROCESSING_FAILED",
        async () => run({ source, maxOutputBytes }),
        `ceiling ${maxOutputBytes}`,
      );
    }
    assert.equal(calls.length, 0, "an invalid bound must be refused before any spawn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. MPEG-TS PROBING (§9, §10, §11)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-4 MPEG-TS probing: explicit demuxer, closed family, exact shape", () => {
  it("probes the source with an explicit MPEG-TS demuxer and a file-only protocol whitelist", async () => {
    const { calls } = harness(await happyScript());
    await run({ source: await writeSource() });

    const probe = calls[0]!;
    assert.equal(probe.command, FFPROBE, "ffprobe is resolved from the configured FFmpeg, not PATH");
    assert.equal(probe.options.shell, false, "never through a shell");
    assert.equal(probe.options.cwd, workDirReal);

    const whitelist = probe.args.indexOf("-protocol_whitelist");
    assert.notEqual(whitelist, -1);
    assert.equal(probe.args[whitelist + 1], "file", "no network-capable protocol may be enabled");

    const format = probe.args.indexOf("-f");
    assert.notEqual(format, -1, "the demuxer is explicit, never auto-detected");
    assert.equal(probe.args[format + 1], "mpegts");

    const input = probe.args.indexOf("-i");
    assert.equal(probe.args[input + 1], join(workDirReal, AGGREGATE_FILE_NAME));
  });

  it("accepts exactly the MPEG-TS family identity the pinned runtime emits", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg" },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
    ]);
    await run({ source: await writeSource() });
    assert.equal(calls.length, 4);
  });

  it("counts only the TOP-LEVEL streams, never the ones nested inside programs", async () => {
    // The pinned MPEG-TS capture repeats both elementary streams inside a
    // `programs` entry. Counting those too would make a perfectly ordinary
    // muxed transport stream look like two video and two audio streams.
    const capture = JSON.parse(await pinned("mpegts-muxed")) as {
      programs: { streams: unknown[] }[];
      streams: unknown[];
    };
    assert.equal(capture.programs.length, 1, "the fixture really does carry a program entry");
    assert.equal(capture.programs[0]!.streams.length, 2);
    assert.equal(capture.streams.length, 2);

    const { calls } = harness(await happyScript());
    await run({ source: await writeSource() });
    assert.equal(calls.length, 4, "the nested program streams did not make the shape ambiguous");
  });

  it("refuses a source that is not MPEG-TS at all", async () => {
    for (const formatName of [ISO, WEBM]) {
      const { calls } = harness([
        { kind: "probe", stdout: doc(formatName, ["video", "audio"]) },
        { kind: "ffmpeg" },
      ]);
      await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }), formatName);
      assert.equal(calls.length, 1, "a cross-family source must never reach FFmpeg");
    }
  });

  it("refuses a malformed or unknown ffprobe family", async () => {
    for (const formatName of ["mpegts,evil", "evil,mpegts", "mpegtsraw", "MPEGTS", "", "mpeg ts", "mpegts,"]) {
      const { calls } = harness([
        { kind: "probe", stdout: doc(formatName, ["video", "audio"]) },
        { kind: "ffmpeg" },
      ]);
      await rejectsWith(
        "PROCESSING_FAILED",
        async () => run({ source: await writeSource() }),
        JSON.stringify(formatName),
      );
      assert.equal(calls.length, 1);
    }
  });

  it("refuses every stream shape except exactly one video and one audio", async () => {
    const refused: readonly (readonly string[])[] = [
      ["video"],
      ["audio"],
      ["video", "video"],
      ["audio", "audio"],
      ["video", "video", "audio"],
      ["video", "audio", "audio"],
      ["video", "audio", "subtitle"],
      ["video", "audio", "data"],
      ["video", "audio", "attachment"],
      ["video", "audio", "unknown"],
      ["subtitle"],
      [],
    ];
    for (const kinds of refused) {
      const { calls } = harness([
        { kind: "probe", stdout: doc(MPEGTS, kinds) },
        { kind: "ffmpeg" },
      ]);
      await rejectsWith(
        "PROCESSING_FAILED",
        async () => run({ source: await writeSource() }),
        kinds.join("+") || "(empty)",
      );
      assert.equal(calls.length, 1, `${kinds.join("+")}: nothing may be remuxed`);
    }
  });

  it("refuses the pinned video-only and audio-only MPEG-TS captures", async () => {
    // The concrete regression this protects: an adaptive video-only rendition
    // must never be delivered as a silent download.
    for (const name of ["mpegts-video-only", "mpegts-audio-only"]) {
      const { calls } = harness([{ kind: "probe", stdout: await pinned(name) }, { kind: "ffmpeg" }]);
      await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }), name);
      assert.equal(calls.length, 1);
    }
  });

  it("pins the approved clear-HLS v1 stream shapes", () => {
    assert.deepEqual({ ...HLS_V1_TS_STREAM_SHAPE }, { family: "mpegts", video: 1, audio: 1 });
    assert.deepEqual({ ...HLS_V1_MP4_STREAM_SHAPE }, { family: "iso-bmff", video: 1, audio: 1 });
    assert.equal(HLS_V1_TS_STREAM_SHAPE.video + HLS_V1_TS_STREAM_SHAPE.audio, 2);
    assert.ok(Object.isFrozen(HLS_V1_TS_STREAM_SHAPE));
    assert.ok(Object.isFrozen(HLS_V1_MP4_STREAM_SHAPE));
  });

  it("treats a non-zero ffprobe exit as a refusal, whatever it printed", async () => {
    const { calls } = harness([
      // The pinned runtime prints an empty `{}` document and exits 1 when the
      // explicit demuxer refuses the file.
      { kind: "probe", stdout: "{\n\n}\n", code: 1 },
      { kind: "ffmpeg" },
    ]);
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. FFMPEG ARGV POLICY (§12)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-4 remux argv: fixed, stream-copy only, no network, no overwrite", () => {
  const SOURCE = "/jobs/abc/hls-source.ts";
  const OUTPUT = "/jobs/abc/hls-output.mp4.part";
  const args = () => buildClearHlsRemuxArgs({ sourcePath: SOURCE, outputPath: OUTPUT });

  it("is byte-for-byte the approved command", () => {
    assert.deepEqual(args(), [
      "-n",
      "-nostdin",
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-f",
      "mpegts",
      "-i",
      SOURCE,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      OUTPUT,
    ]);
  });

  it("never overwrites: -n is present and -y is absent", () => {
    assert.ok(args().includes("-n"));
    assert.equal(args().includes("-y"), false, "-y would truncate an existing artifact");
    assert.equal(args()[0], "-n", "the refusal is stated before anything else");
  });

  it("reads no stdin and bounds its diagnostics", () => {
    assert.ok(args().includes("-nostdin"));
    const verbosity = args().indexOf("-v");
    assert.notEqual(verbosity, -1);
    assert.equal(args()[verbosity + 1], "error");
  });

  it("enables only the file protocol, before the input it applies to", () => {
    const whitelist = args().indexOf("-protocol_whitelist");
    const input = args().indexOf("-i");
    assert.notEqual(whitelist, -1);
    assert.equal(args()[whitelist + 1], "file");
    assert.ok(whitelist < input, "the whitelist is a per-input option and must precede -i");
    for (const protocol of ["http", "https", "tcp", "tls", "rtp", "concat", "crypto", "pipe", "fd", "data", "subfile"]) {
      assert.equal(
        args().some((arg) => arg === protocol || arg.split(",").includes(protocol)),
        false,
        `${protocol} must never be whitelisted`,
      );
    }
  });

  it("selects the MPEG-TS demuxer explicitly for the input", () => {
    const list = args();
    const input = list.indexOf("-i");
    const format = list.lastIndexOf("-f", input);
    assert.notEqual(format, -1);
    assert.equal(list[format + 1], "mpegts");
    assert.equal(list[input + 1], SOURCE);
  });

  it("maps exactly one video and one audio stream, by index", () => {
    const list = args();
    const maps = list.flatMap((arg, index) => (arg === "-map" ? [list[index + 1]] : []));
    assert.deepEqual(maps, ["0:v:0", "0:a:0"]);
  });

  it("copies both streams and names no encoder anywhere", () => {
    const list = args();
    assert.equal(list[list.indexOf("-c:v") + 1], "copy");
    assert.equal(list[list.indexOf("-c:a") + 1], "copy");
    for (const encoder of [
      "libx264",
      "libx265",
      "h264",
      "hevc",
      "aac",
      "libfdk_aac",
      "libmp3lame",
      "libopus",
      "libvpx-vp9",
      "-crf",
      "-b:v",
      "-b:a",
      "-q:a",
      "-preset",
      "-vf",
      "-af",
      "-filter_complex",
      "-bsf:v",
      "-bsf:a",
      "-c",
      "-vcodec",
      "-acodec",
    ]) {
      assert.equal(list.includes(encoder), false, `${encoder} must never appear`);
    }
    assert.equal(list.filter((arg) => arg === "copy").length, 2, "exactly two stream copies");
  });

  it("discards upstream metadata and chapters", () => {
    const list = args();
    assert.equal(list[list.indexOf("-map_metadata") + 1], "-1");
    assert.equal(list[list.indexOf("-map_chapters") + 1], "-1");
  });

  it("names the MP4 muxer explicitly and writes the fixed output last", () => {
    const list = args();
    assert.equal(list[list.length - 3], "-f");
    assert.equal(list[list.length - 2], "mp4");
    assert.equal(list[list.length - 1], OUTPUT);
    // The output muxer is the LAST -f, and it is not inferred from the name —
    // which is exactly why writing to a `.part` filename is safe.
    const outputFormat = list.lastIndexOf("-f");
    assert.equal(list[outputFormat + 1], "mp4");
    assert.ok(list.includes("-movflags"));
    assert.equal(list[list.indexOf("-movflags") + 1], "+faststart");
  });

  it("cannot be injected into: a hostile path stays exactly one argv element", () => {
    const hostile = "/jobs/abc/a b;rm -rf /\n-y\t--x 'q' \"r\" $(id) `id` |&<>";
    const list = buildClearHlsRemuxArgs({ sourcePath: hostile, outputPath: OUTPUT });
    assert.equal(list.filter((arg) => arg === hostile).length, 1);
    assert.equal(list[list.indexOf("-i") + 1], hostile);
    assert.equal(list.length, args().length, "no extra argument appeared");
    assert.equal(list.includes("-y"), false, "an embedded -y is DATA, not a flag");
  });

  it("spawns FFmpeg with the argv, no shell, and the real work directory", async () => {
    const { calls } = harness(await happyScript());
    await run({ source: await writeSource() });

    const remux = calls[1]!;
    assert.equal(remux.command, config.ffmpegPath, "only the configured FFmpeg is invoked");
    assert.equal(remux.options.shell, false);
    assert.equal(remux.options.cwd, workDirReal);
    assert.deepEqual(
      remux.args,
      buildClearHlsRemuxArgs({
        sourcePath: join(workDirReal, AGGREGATE_FILE_NAME),
        outputPath: partialPath(),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. NO-CLOBBER (§13)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-4 output ownership: fixed names, and nothing pre-existing is touched", () => {
  it("uses fixed application-owned names that come from nowhere else", () => {
    assert.equal(HLS_OUTPUT_FILE_NAME, "hls-output.mp4");
    assert.equal(HLS_OUTPUT_PARTIAL_FILE_NAME, "hls-output.mp4.part");
    assert.notEqual(HLS_OUTPUT_FILE_NAME, AGGREGATE_FILE_NAME);
    assert.notEqual(HLS_OUTPUT_PARTIAL_FILE_NAME, AGGREGATE_FILE_NAME);
  });

  it("refuses a pre-existing partial before any spawn, and leaves it exactly as found", async () => {
    const { calls } = harness(await happyScript());
    await writeFile(partialPath(), "pre-existing partial");
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 0);
    assert.equal(await readFile(partialPath(), "utf8"), "pre-existing partial");
  });

  it("refuses a pre-existing final before any spawn, and leaves it exactly as found", async () => {
    const { calls } = harness(await happyScript());
    await writeFile(outputPath(), "pre-existing final");
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 0);
    assert.equal(await readFile(outputPath(), "utf8"), "pre-existing final");
  });

  it("refuses a symlink at either output name, including a dangling one", async () => {
    for (const path of [partialPath(), outputPath()]) {
      const { calls } = harness(await happyScript());
      // Dangling on purpose: `access`/`stat` would report this name as FREE,
      // and FFmpeg's file protocol would then write THROUGH the link.
      await symlink(join(workDirReal, "nowhere-at-all"), path);
      await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }), path);
      assert.equal(calls.length, 0);
      const entry = await stat(path).catch(() => null);
      assert.equal(entry, null, "the dangling link is still dangling, not replaced by a file");
      assert.ok(workDirEntries().includes(basename(path)), "the link itself was left alone");
      await rm(path, { force: true });
    }
  });

  it("refuses a directory sitting at either output name", async () => {
    for (const path of [partialPath(), outputPath()]) {
      const { calls } = harness(await happyScript());
      await mkdir(path);
      await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }), path);
      assert.equal(calls.length, 0);
      assert.ok((await stat(path)).isDirectory(), "the directory is left alone");
      await rm(path, { recursive: true, force: true });
    }
  });

  it("relies on FFmpeg's own -n for the window between the check and the open", async () => {
    // The pre-spawn check and FFmpeg's open are separate moments. `-n` is what
    // makes an entry that appeared in between a refusal rather than a
    // truncation, and the pinned runtime was verified to exit 1 with "File
    // ... already exists. Exiting." and leave the file unchanged.
    const remux = buildClearHlsRemuxArgs({ sourcePath: "/a/hls-source.ts", outputPath: "/a/o.part" });
    assert.ok(remux.includes("-n"));
    assert.equal(remux.includes("-y"), false);

    // And a refusal is reported as a failure that leaves no final artifact.
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg", write: async () => 1 },
    ]);
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 2);
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. PROCESSING FAILURES (§14, §15, §16, §19)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-4 failures: fail closed, clean up, and surface nothing", () => {
  it("a non-zero FFmpeg exit removes the partial this call created", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg", write: async (path) => { await writeFile(path, "half a file"); return 1; } },
    ]);
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 2);
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });

  it("surfaces no FFmpeg stderr, no path and no upstream text", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      {
        kind: "ffmpeg",
        stderr: `FFMPEG_SECRET origin.example ${join(workDirReal, "hls-source.ts")} h264 aac`,
        write: async () => 1,
      },
    ]);
    const err = await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 2);
    for (const secret of ["FFMPEG_SECRET", "origin.example", workDirReal, "h264", "aac", "hls-source"]) {
      assert.equal(String(err.message).includes(secret), false, `${secret} must not leak`);
      assert.equal(JSON.stringify(err).includes(secret), false, `${secret} must not leak`);
    }
  });

  it("refuses when FFmpeg exits zero but produced nothing", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg", write: async () => {} },
    ]);
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 2, "a missing artifact is never probed");
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });

  it("refuses a produced entry that is a symlink out of the work directory", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "hls4-prod-"));
    try {
      const outside = join(elsewhere, "real.mp4");
      await writeFile(outside, Buffer.alloc(512, 3));
      const { calls } = harness([
        { kind: "probe", stdout: await pinned("mpegts-muxed") },
        { kind: "ffmpeg", write: async (path) => { await symlink(outside, path); } },
      ]);
      await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
      assert.equal(calls.length, 2, "an escaping artifact is never probed");
      // The escape target is untouched, and the link this call is responsible
      // for is gone.
      assert.equal((await stat(outside)).size, 512);
      assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a produced entry that is not a regular file", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg", write: async (path) => { await mkdir(path); } },
    ]);
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 2);
  });

  it("refuses a zero-byte artifact", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg", write: async (path) => { await writeFile(path, Buffer.alloc(0)); } },
    ]);
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 2, "an empty artifact is never probed");
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });

  it("an oversized artifact is TOO_LARGE, measured from disk, and is removed", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg", write: async (path) => { await writeFile(path, Buffer.alloc(4_097, 1)); } },
    ]);
    await rejectsWith("TOO_LARGE", async () => run({ source: await writeSource(), maxOutputBytes: 4_096 }));
    assert.equal(calls.length, 2, "an over-ceiling artifact is never probed");
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });

  it("accepts an artifact exactly at the ceiling", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg", write: async (path) => { await writeFile(path, Buffer.alloc(4_096, 1)); } },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
    ]);
    const result = await run({ source: await writeSource(), maxOutputBytes: 4_096 });
    assert.equal(result.fileSize, 4_096);
    assert.equal(calls.length, 4);
  });

  it("refuses a produced artifact whose container is not ISO-BMFF", async () => {
    for (const formatName of [MPEGTS, WEBM, "mp4", "evil"]) {
      const { calls } = harness([
        { kind: "probe", stdout: await pinned("mpegts-muxed") },
        { kind: "ffmpeg" },
        { kind: "probe", stdout: doc(formatName, ["video", "audio"]) },
      ]);
      await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }), formatName);
      assert.equal(calls.length, 3, "a wrong container is never renamed onto the final name");
      assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
    }
  });

  it("refuses a produced artifact whose stream shape is wrong", async () => {
    for (const kinds of [["video"], ["audio"], ["video", "video", "audio"], ["video", "audio", "subtitle"]]) {
      const { calls } = harness([
        { kind: "probe", stdout: await pinned("mpegts-muxed") },
        { kind: "ffmpeg" },
        { kind: "probe", stdout: doc(ISO, kinds) },
      ]);
      await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }), kinds.join("+"));
      assert.equal(calls.length, 3);
      assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
    }
  });

  it("removes the FINALIZED artifact when the post-rename revalidation fails", async () => {
    // The partial probe passes, the rename happens, and the re-probe of the
    // finalized file then refuses. The successful-looking `hls-output.mp4`
    // must not survive that.
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg" },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
      { kind: "probe", stdout: doc(ISO, ["video"]) },
    ]);
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 4, "the finalized artifact really was re-probed");
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });

  it("never returns success on FFmpeg's exit code alone", async () => {
    // FFmpeg exits 0 and writes a plausible file; every downstream validation
    // stage is still what decides, and each one can still refuse.
    const sourceProbe: Step = { kind: "probe", stdout: await pinned("mpegts-muxed") };
    const goodMp4: Step = { kind: "probe", stdout: await pinned("iso-bmff-merged") };
    const wrongMp4: Step = { kind: "probe", stdout: doc(WEBM, ["video", "audio"]) };

    const scripts: readonly [string, Step[], number][] = [
      ["the partial probe refuses", [sourceProbe, { kind: "ffmpeg" }, wrongMp4], 3],
      ["the final probe refuses", [sourceProbe, { kind: "ffmpeg" }, goodMp4, wrongMp4], 4],
    ];
    for (const [label, script, spawns] of scripts) {
      const { calls } = harness(script);
      await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }), label);
      assert.equal(calls.length, spawns, label);
      assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME], label);
    }
  });

  it("leaves the acquired source intact through every failure", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg", write: async () => 1 },
    ]);
    const source = await writeSource(777);
    await rejectsWith("PROCESSING_FAILED", async () => run({ source }));
    assert.equal(calls.length, 2);
    const bytes = await readFile(join(workDirReal, AGGREGATE_FILE_NAME));
    assert.equal(bytes.length, 777);
    assert.ok(bytes.every((byte) => byte === 0x47), "the source bytes are untouched");
  });

  it("uses only existing canonical error codes", async () => {
    const { calls } = harness([{ kind: "probe", stdout: doc(MPEGTS, ["video"]) }]);
    const failure = await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.ok(failure instanceof AppError);
    assert.ok(["PROCESSING_FAILED", "TOO_LARGE", "TIMEOUT"].includes(failure.code));
    assert.equal(calls.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. SUCCESSFUL FINALIZATION (§14, §15)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-4 success: a validated, finalized, frozen MP4", () => {
  it("remuxes an approved MPEG-TS into a validated MP4 at the fixed name", async () => {
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed") },
      { kind: "ffmpeg", write: async (path) => { await writeFile(path, Buffer.alloc(9_001, 5)); } },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
    ]);

    const source = await writeSource(4_096);
    const result = await run({ source });

    assert.deepEqual({ ...result }, {
      filePath: outputPath(),
      container: "mp4",
      fileSize: 9_001,
    });
    assert.ok(Object.isFrozen(result), "the result is immutable, as HLS-3's is");

    // Four subprocesses, in order, each by its real path.
    assert.deepEqual(
      calls.map((call) => call.command),
      [FFPROBE, config.ffmpegPath, FFPROBE, FFPROBE],
    );
    assert.equal(calls[0]!.args[calls[0]!.args.length - 1], join(workDirReal, AGGREGATE_FILE_NAME));
    assert.equal(calls[2]!.args[calls[2]!.args.length - 1], partialPath());
    assert.equal(calls[3]!.args[calls[3]!.args.length - 1], outputPath());
    for (const call of calls) assert.equal(call.options.shell, false);
  });

  it("measures the reported size from disk, never from FFmpeg", async () => {
    for (const size of [1, 2_048, 65_537]) {
      const { calls } = harness([
        { kind: "probe", stdout: await pinned("mpegts-muxed") },
        { kind: "ffmpeg", write: async (path) => { await writeFile(path, Buffer.alloc(size, 6)); } },
        { kind: "probe", stdout: await pinned("iso-bmff-merged") },
        { kind: "probe", stdout: await pinned("iso-bmff-merged") },
      ]);
      const result = await run({ source: await writeSource() });
      assert.equal(result.fileSize, size);
      assert.equal((await stat(result.filePath)).size, size, "the result matches the artifact");
      assert.equal(calls.length, 4);
      await rm(outputPath(), { force: true });
    }
  });

  it("leaves exactly the source and the final MP4 behind — no partial", async () => {
    harness(await happyScript());
    await run({ source: await writeSource() });
    assert.deepEqual(workDirEntries(), [HLS_OUTPUT_FILE_NAME, AGGREGATE_FILE_NAME].sort());
  });

  it("leaves the acquired source byte-for-byte intact", async () => {
    harness(await happyScript());
    const source = await writeSource(1_234);
    await run({ source });
    const bytes = await readFile(join(workDirReal, AGGREGATE_FILE_NAME));
    assert.equal(bytes.length, 1_234);
    assert.ok(bytes.every((byte) => byte === 0x47));
  });

  it("probes the FINAL artifact as ISO-BMFF with one video and one audio stream", async () => {
    const { calls } = harness(await happyScript());
    await run({ source: await writeSource() });
    const final = calls[3]!;
    assert.equal(final.command, FFPROBE);
    const format = final.args.indexOf("-f");
    assert.equal(final.args[format + 1], "mov", "the ISO-BMFF demuxer, explicitly");
    assert.equal(final.args[final.args.indexOf("-protocol_whitelist") + 1], "file");
    assert.equal(final.args[final.args.length - 1], outputPath());
  });

  it("removes its listener from the caller's signal on success", async () => {
    harness(await happyScript());
    const before = getEventListeners(controller.signal, "abort").length;
    await run({ source: await writeSource() });
    assert.equal(getEventListeners(controller.signal, "abort").length, before);
  });

  it("removes its listener from the caller's signal on failure too", async () => {
    harness([{ kind: "probe", stdout: doc(MPEGTS, ["video"]) }]);
    const before = getEventListeners(controller.signal, "abort").length;
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(getEventListeners(controller.signal, "abort").length, before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. DEADLINE AND CANCELLATION (§18)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-4 budget arithmetic", () => {
  it("grants what is left, floored, and refuses a deadline that has passed", () => {
    assert.equal(remainingBudgetMs(1_000, 0), 1_000);
    assert.equal(remainingBudgetMs(1_000, 999.2), null, "a sub-millisecond remainder is nothing");
    assert.equal(remainingBudgetMs(1_000, 400.7), 599);
    assert.equal(remainingBudgetMs(1_000, 1_000), null);
    assert.equal(remainingBudgetMs(1_000, 1_001), null);
    assert.equal(remainingBudgetMs(Number.NaN, 0), null);
    assert.equal(remainingBudgetMs(Number.POSITIVE_INFINITY, 0), null);
    assert.equal(remainingBudgetMs(0, Number.NaN), null);
  });
});

describe("HLS-4 cancellation and the one processing budget", () => {
  it("launches nothing at all for a caller that has already gone", async () => {
    const { calls } = harness(await happyScript());
    const source = await writeSource();
    const aborted = new AbortController();
    aborted.abort();
    const err = await rejectsWith("PROCESSING_FAILED", async () => run({ source, signal: aborted.signal }));
    assert.match(err.message, /cancelled/i);
    assert.equal(calls.length, 0, "an aborted caller gets no ffprobe and no FFmpeg");
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });

  it("stops a cancellation that lands while the source probe is running", async () => {
    const { calls, children, groupKills } = harness([{ kind: "hang" }], (index) => {
      if (index === 0) queueMicrotask(() => controller.abort());
    });
    const err = await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.match(err.message, /cancelled/i);
    assert.equal(calls.length, 1, "FFmpeg never ran");
    // The owned POSIX process group was killed, not just the direct child.
    assert.deepEqual(groupKills, [-(children[0]!.pid as number)]);
    assert.deepEqual(children[0]!.killCalls, [], "no direct-child fallback when the group signal lands");
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });

  it("stops a cancellation that lands while FFmpeg is running, and cleans up", async () => {
    const { calls, children, groupKills } = harness(
      [
        { kind: "probe", stdout: await pinned("mpegts-muxed") },
        { kind: "hang" },
      ],
      (index) => {
        if (index === 1) {
          // FFmpeg has started and has already written part of its output.
          void writeFile(partialPath(), "partially written").then(() => controller.abort());
        }
      },
    );
    const err = await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.match(err.message, /cancelled/i);
    assert.equal(calls.length, 2, "no validation probe ran after the stop");
    assert.deepEqual(groupKills, [-(children[1]!.pid as number)]);
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME], "the partial was removed");
  });

  it("does NOT re-arm the budget for each subprocess stage", async () => {
    // One 400 ms budget covers all four stages. Two stages that each take
    // 250 ms exhaust it during the SECOND one, so the run stops at two spawns.
    // A per-stage budget would hand stage 2 a fresh 400 ms, it would finish in
    // 250 ms, and the run would reach all four spawns and SUCCEED.
    const { calls } = harness([
      { kind: "probe", stdout: await pinned("mpegts-muxed"), delayMs: 250 },
      { kind: "ffmpeg", delayMs: 250 },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
      { kind: "probe", stdout: await pinned("iso-bmff-merged") },
    ]);
    await rejectsWith("TIMEOUT", async () => run({ source: await writeSource(), timeoutMs: 400 }));
    assert.equal(calls.length, 2, "the budget ran out inside stage 2; stages 3 and 4 never started");
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });

  it("times out a stage that never ends, and reports TIMEOUT rather than success", async () => {
    const { calls, children, groupKills } = harness([{ kind: "hang" }]);
    await rejectsWith("TIMEOUT", async () => run({ source: await writeSource(), timeoutMs: 80 }));
    assert.equal(calls.length, 1);
    assert.deepEqual(groupKills, [-(children[0]!.pid as number)]);
  });

  it("keeps the caller as the first cause even when the deadline follows", async () => {
    const { calls } = harness([{ kind: "hang" }], (index) => {
      if (index === 0) queueMicrotask(() => controller.abort());
    });
    const err = await rejectsWith("PROCESSING_FAILED", async () =>
      run({ source: await writeSource(), timeoutMs: 60 }),
    );
    assert.match(err.message, /cancelled/i, "the latched first cause wins");
    assert.equal(calls.length, 1);
  });

  it("stops a cancellation that lands while the rename is in flight", async () => {
    const { calls } = harness(await happyScript());
    setClearHlsProcessingBarrierForTests(async (step) => {
      if (step === "before-rename") controller.abort();
    });
    const err = await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.match(err.message, /cancelled/i);
    assert.equal(calls.length, 3, "the final probe never ran");
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME], "the partial was removed");
  });

  it("removes the FINALIZED artifact for a stop that lands just after the rename", async () => {
    const { calls } = harness(await happyScript());
    setClearHlsProcessingBarrierForTests(async (step) => {
      if (step === "after-rename") controller.abort();
    });
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 3);
    assert.deepEqual(
      workDirEntries(),
      [AGGREGATE_FILE_NAME],
      "a stopped call never leaves a successful-looking hls-output.mp4",
    );
  });

  it("cannot return success once a stop has landed at the very last gate", async () => {
    const { calls } = harness(await happyScript());
    setClearHlsProcessingBarrierForTests(async (step) => {
      if (step === "before-return") controller.abort();
    });
    await rejectsWith("PROCESSING_FAILED", async () => run({ source: await writeSource() }));
    assert.equal(calls.length, 4, "all four stages really did run");
    assert.deepEqual(workDirEntries(), [AGGREGATE_FILE_NAME]);
  });

  it("reaches every finalization step on the success path", async () => {
    const seen: ProcessingFinalizationStep[] = [];
    harness(await happyScript());
    setClearHlsProcessingBarrierForTests(async (step) => {
      seen.push(step);
    });
    await run({ source: await writeSource() });
    assert.deepEqual(seen, ["before-rename", "after-rename", "before-return"]);
  });

  it("clears its deadline timer on success and on failure", async () => {
    const active = () =>
      process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
    harness(await happyScript());
    const before = active();
    await run({ source: await writeSource() });
    assert.ok(active() <= before, "the deadline timer was cleared on success");

    await rm(outputPath(), { force: true });
    harness([{ kind: "probe", stdout: doc(MPEGTS, ["video"]) }]);
    await rejectsWith("PROCESSING_FAILED", () =>
      run({
        source: Object.freeze({
          filePath: sourcePath(),
          segmentType: "mpegts" as const,
          fileSize: 4_096,
        }),
      }),
    );
    assert.ok(active() <= before, "the deadline timer was cleared on failure too");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. WORKSPACE FOOTPRINT (§17)
// ─────────────────────────────────────────────────────────────────────────────

describe("HLS-4 workspace footprint: 2x, stated outside the Product plan policy", () => {
  it("costs two ceilings, because the source and the output coexist", () => {
    assert.equal(HLS_V1_PROCESSING_WORKSPACE_FOOTPRINT, 2);
  });

  it("requires exactly 8 GiB at the 4 GiB Product ceiling", () => {
    assert.equal(DEFAULT_MAX_FILE_SIZE_BYTES, 4_294_967_296);
    assert.equal(
      requiredWorkspaceBytes(DEFAULT_MAX_FILE_SIZE_BYTES, HLS_V1_PROCESSING_WORKSPACE_FOOTPRINT),
      8_589_934_592,
    );
    // The arithmetic is not restated here: it comes from the one shared
    // authority the executor and the startup gate already use.
    assert.equal(
      requiredWorkspaceBytes(DEFAULT_MAX_FILE_SIZE_BYTES, HLS_V1_PROCESSING_WORKSPACE_FOOTPRINT),
      DEFAULT_MAX_FILE_SIZE_BYTES * 2,
    );
  });

  it("is already covered by the startup workspace footprint", () => {
    assert.ok(
      STARTUP_WORKSPACE_FOOTPRINT >= HLS_V1_PROCESSING_WORKSPACE_FOOTPRINT,
      "a freshly started Worker can already hold an HLS v1 processing run",
    );
    const startup = requiredWorkspaceBytes(DEFAULT_MAX_FILE_SIZE_BYTES, STARTUP_WORKSPACE_FOOTPRINT);
    const hls = requiredWorkspaceBytes(
      DEFAULT_MAX_FILE_SIZE_BYTES,
      HLS_V1_PROCESSING_WORKSPACE_FOOTPRINT,
    );
    assert.ok(startup !== null && hls !== null);
    assert.ok(startup >= hls, "no capacity change is required to run HLS v1 processing");
  });

  it("adds no HLS operation to the Product execution-plan vocabulary", () => {
    // The plan-footprint switch is exhaustive over operations a Product plan
    // can actually carry. HLS has none, and inventing one purely so the switch
    // could return 2 would put a non-executable operation into a closed
    // Product vocabulary.
    for (const file of ["src/worker/execution/format-plan.ts", "src/worker/execution/workspace-capacity.ts"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      assert.equal(/\bhls\b/i.test(source), false, `${file} must not gain an HLS operation`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. DORMANCY AND THE MODULE BOUNDARY (§20, §26)
// ─────────────────────────────────────────────────────────────────────────────

/** Every non-test TypeScript file under `src/`. */
function productionSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

/** A module's source with its prose removed, so a mention is not taken for a call. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("HLS-4 processing: dormant, and inside its boundary", () => {
  const code = codeOf(MODULE_PATH);

  it("strips prose without destroying the module under test", () => {
    assert.ok(code.includes("export async function processClearHlsTsToMp4"));
    assert.equal(code.includes("Dormancy"), false, "comments should be gone");
  });

  it("leaves HLS unadvertised: both protocol policies are still exactly http and https", () => {
    assert.deepEqual([...YTDLP_V1_NATIVE_PROTOCOLS], ["http", "https"]);
    assert.deepEqual([...GENERIC_SOURCE_PROTOCOLS], ["http", "https"]);
  });

  it("is reachable from no production module outside the dormant HLS directory", () => {
    for (const file of productionSourceFiles()) {
      if (dirname(file) === HLS_DIR) continue;
      assert.equal(
        readFileSync(file, "utf8").includes("hls-processing"),
        false,
        `${relative(ROOT, file)} must not import the dormant HLS processing primitive`,
      );
    }
  });

  it("imports only config, errors, the local media primitives, Node and HLS-3", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(imports, [
      "node:fs/promises",
      "node:path",
      "@/lib/config",
      "@/lib/errors",
      "@/services/processing/ffprobe.server",
      "@/services/processing/process-runner.server",
      "../execution/workspace-capacity.ts",
      "./hls-fragment-acquisition.server.ts",
    ]);
    // The one `worker/execution` edge is TYPE-ONLY, so the dormant foundation
    // creates no runtime dependency on the Product executor's modules.
    assert.ok(
      /import type \{ WorkspaceFootprint \} from "\.\.\/execution\/workspace-capacity\.ts";/.test(code),
      "the workspace-capacity import must be type-only",
    );
  });

  it("has no network surface of any kind", () => {
    for (const forbidden of [
      "safeGet",
      "safeHead",
      "safeHttpRequest",
      "resolveSafeDestination",
      "disposeHttpBody",
      "fetch(",
      "XMLHttpRequest",
      "node:http",
      "node:https",
      "node:net",
      "node:dns",
      "node:tls",
      "node:dgram",
      "lookupHost",
      "http://",
      "https://",
    ]) {
      assert.equal(code.includes(forbidden), false, `HLS-4 must not reference ${forbidden}`);
    }
  });

  it("invokes no yt-dlp, no uploader and no browser or route contract", () => {
    for (const forbidden of [
      "yt-dlp",
      "ytdlp",
      "yt_dlp",
      "m3u8",
      "m3u8_native",
      "R2",
      "S3Client",
      "PutObject",
      "presign",
      "upload",
      "createRoute",
      "Response",
      "Request(",
      "zod",
      "process.env",
      "console.",
      "require(",
      "import(",
    ]) {
      assert.equal(code.includes(forbidden), false, `HLS-4 must not reference ${forbidden}`);
    }
  });

  it("spawns only through the Worker-owned process runner", () => {
    for (const forbidden of ["node:child_process", "child_process", "spawn(", "execFile", "exec(", "shell"]) {
      assert.equal(code.includes(forbidden), false, `HLS-4 must not reference ${forbidden}`);
    }
    assert.equal(code.split("runProcess(").length - 1, 1, "exactly one direct subprocess call site");
    assert.equal(code.split("probeLocalMedia(").length - 1, 3, "three probe stages, no more");
  });

  it("never overwrites: -y appears nowhere in the module", () => {
    assert.equal(code.includes('"-y"'), false);
    assert.ok(code.includes('"-n"'));
  });

  it("builds every path from the workDir and a module constant, and nothing else", () => {
    assert.ok(code.includes('export const HLS_OUTPUT_FILE_NAME = "hls-output.mp4"'));
    assert.ok(code.includes('export const HLS_OUTPUT_PARTIAL_FILE_NAME = "hls-output.mp4.part"'));
    // Three joins: the expected source identity, the partial and the final.
    assert.equal(code.split("join(").length - 1, 3);
    for (const call of [...code.matchAll(/join\(([^)]*)\)/g)]) {
      assert.ok(call[1]!.startsWith("workDirReal, "), `every join starts at the real workDir: ${call[1]}`);
    }
  });

  it("gates the operation immediately after every finalization await", () => {
    const steps: ProcessingFinalizationStep[] = ["before-rename", "after-rename", "before-return"];
    for (const step of steps) {
      const call = `atFinalizationStep("${step}")`;
      const at = code.indexOf(call);
      assert.ok(at > 0, `${step} must be a real finalization step`);
      const after = code.slice(at + call.length).replace(/\s+/g, " ").trimStart();
      assert.ok(
        after.startsWith("; assertStillRunning();"),
        `${step} must be followed immediately by a stop gate, saw ${after.slice(0, 60)}`,
      );
    }
  });

  it("grants each subprocess stage only the budget that REMAINS", () => {
    // Unobservable at runtime — the single armed deadline stops the operation
    // either way — so it is pinned structurally. This is the defence in depth
    // that keeps four stages from becoming four full processing windows if the
    // one deadline timer were ever removed.
    assert.equal(code.split("stageBudgetMs").length - 1, 6, "one helper, one gate, four stages");
    assert.equal(code.split("timeoutMs: stageBudgetMs()").length - 1, 3, "the three probe stages");
    assert.ok(code.includes("const budget = stageBudgetMs();"), "and the remux stage");
    assert.ok(code.includes("timeoutMs: budget,"));
    // The caller's whole timeout never reaches a subprocess directly.
    assert.equal(code.includes("timeoutMs: timeoutMs"), false);
    assert.equal(code.includes("timeoutMs,\n"), false);
  });

  it("arms exactly one deadline for the whole primitive", () => {
    assert.equal(code.split("setTimeout(").length - 1, 1);
    assert.equal(code.split("clearTimeout(").length - 1, 1);
    assert.equal(code.split("new AbortController(").length - 1, 1);
    assert.equal(code.split("monotonicNowMs() + timeoutMs").length - 1, 1, "one deadline, computed once");
  });

  it("never reads the caller's abort reason", () => {
    assert.equal(code.includes(".reason"), false);
    assert.equal(code.includes("throwIfAborted"), false, "throwIfAborted would surface the reason");
  });

  it("keeps the finalization barrier inert and reachable only from its setter", () => {
    assert.ok(
      code.includes(
        "let finalizationBarrier: ((step: ProcessingFinalizationStep) => Promise<void>) | null = null",
      ),
      "the barrier ships null",
    );
    assert.equal(
      code.split("finalizationBarrier").length - 1,
      4,
      "declared, assigned by the test-only setter, null-checked and called — nothing else",
    );
    assert.equal(
      code.split("setClearHlsProcessingBarrierForTests").length - 1,
      1,
      "the module never installs a barrier on itself",
    );
  });

  it("lives in the Worker-private HLS directory as a server module", () => {
    const rel = relative(ROOT, MODULE_PATH).split("\\").join("/");
    assert.equal(rel, "src/worker/hls/hls-processing.server.ts");
  });
});

describe("HLS-3 remains acquisition-only after HLS-4 landed", () => {
  const code = codeOf(ACQUISITION_PATH);

  it("still performs no local media processing whatsoever", () => {
    for (const forbidden of [
      "node:child_process",
      "child_process",
      "spawn",
      "execFile",
      "exec(",
      "ffmpeg",
      "ffprobe",
      "runProcess",
      "probeLocalMedia",
      "hls-processing",
    ]) {
      assert.equal(code.includes(forbidden), false, `HLS-3 must not reference ${forbidden}`);
    }
  });

  it("still owns the fixed artifact name HLS-4 checks identity against", () => {
    assert.ok(code.includes('const AGGREGATE_FILE_NAME = "hls-source.ts"'));
    assert.equal(AGGREGATE_FILE_NAME, "hls-source.ts");
  });

  it("keeps acquisition and processing in separate modules", () => {
    assert.notEqual(MODULE_PATH, ACQUISITION_PATH);
    assert.equal(
      codeOf(MODULE_PATH).includes("acquireClearHlsTs("),
      false,
      "HLS-4 never performs acquisition",
    );
  });
});
