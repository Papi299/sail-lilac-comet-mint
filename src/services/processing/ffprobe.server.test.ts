import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../../lib/errors.ts";
import { setProcessRunnerTestHooks, type SpawnImpl } from "./process-runner.server.ts";
import {
  assertContainedRegularFile,
  buildProbeArgs,
  hasExactStreamShape,
  normalizeProbeFormatFamily,
  parseProbeDocument,
  probeLocalMedia,
  resolveFfprobePath,
} from "./ffprobe.server.ts";

/** Loads one verbatim ffprobe capture. See `testdata/README.md`. */
function pinned(name: string): Promise<string> {
  return readFile(join(import.meta.dirname, "testdata", `pinned-ffprobe-${name}.json`), "utf8");
}

function assertProcessingFailed(fn: () => unknown | Promise<unknown>): Promise<void> {
  return assert.rejects(
    async () => await fn(),
    (err: unknown) => {
      assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
      assert.equal(err.code, "PROCESSING_FAILED");
      return true;
    },
  );
}

type SpawnCall = { command: string; args: readonly string[]; options: SpawnOptions };

type FakeChild = EventEmitter & {
  pid?: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals) => boolean;
  killCalls: NodeJS.Signals[];
};

function createFakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = (signal?: NodeJS.Signals) => {
    child.killCalls.push(signal ?? ("SIGTERM" as NodeJS.Signals));
    return true;
  };
  return child;
}

/**
 * Installs a spawn that records every call and drives the child through a
 * per-call script. Nothing here ever starts a real process.
 *
 * `processKill` is hooked too, so a termination NEVER signals a real process
 * group on the test host. The hook records the group target the runner chose
 * and then closes the matching fake child, which is what a killed group does.
 */
function captureSpawn(onSpawn: (child: FakeChild, index: number) => void) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const groupKills: number[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    const index = calls.length;
    calls.push({ command, args, options });
    const child = createFakeChild(71_000 + index);
    children.push(child);
    onSpawn(child, index);
    return child as unknown as ChildProcess;
  };
  setProcessRunnerTestHooks({
    spawn: spawnImpl,
    platform: "linux",
    processKill: (pid) => {
      groupKills.push(pid);
      const owner = children.find((child) => child.pid === -pid);
      if (owner) queueMicrotask(() => owner.emit("close", null));
      return true;
    },
  });
  return { calls, children, groupKills };
}

/** Emits `stdout` then closes with `code`, the way a finished ffprobe does. */
function respond(child: FakeChild, stdout: string, code = 0) {
  queueMicrotask(() => {
    child.stdout.write(stdout);
    child.emit("close", code);
  });
}

describe("ffprobe executable resolution", () => {
  it("derives ffprobe as the sibling of the configured absolute FFmpeg", () => {
    // The accepted Worker image's exact layout: FFMPEG_PATH=/usr/bin/ffmpeg,
    // and Debian's ffmpeg package ships /usr/bin/ffprobe beside it.
    assert.equal(resolveFfprobePath("/usr/bin/ffmpeg"), "/usr/bin/ffprobe");
    assert.equal(resolveFfprobePath("/usr/local/bin/ffmpeg"), "/usr/local/bin/ffprobe");
    assert.equal(resolveFfprobePath("/opt/vf/bin/ffmpeg"), "/opt/vf/bin/ffprobe");
  });

  it("never yields a PATH-relative probe: a non-absolute FFmpeg fails closed", () => {
    // The Worker config loader validates FFMPEG_PATH as a string but does not
    // require absoluteness, so this is the layer that refuses to turn a
    // relative FFmpeg into an untrusted-PATH lookup.
    for (const value of ["ffmpeg", "./ffmpeg", "bin/ffmpeg", "", "   "]) {
      assert.throws(
        () => resolveFfprobePath(value),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, "PROCESSING_FAILED");
          return true;
        },
        `expected ${JSON.stringify(value)} to be refused`,
      );
    }
  });

  it("resolves to an absolute path whose basename is exactly ffprobe", () => {
    const resolved = resolveFfprobePath("/usr/bin/ffmpeg");
    assert.ok(resolved.startsWith("/"));
    assert.equal(resolved.split("/").pop(), "ffprobe");
  });
});

describe("local media path containment", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vf-probe-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("rejects remote, protocol-relative and scheme-bearing inputs", async () => {
    for (const value of [
      "https://cdn.example/video.mp4",
      "http://example.com/a.mp4",
      "file:///etc/passwd",
      "//cdn.example/video.mp4",
      "data:video/mp4;base64,AAAA",
      "ftp://example.com/a.mp4",
      "",
      "   ",
    ]) {
      await assertProcessingFailed(() => assertContainedRegularFile(workDir, value));
    }
  });

  it("rejects a relative path", async () => {
    await assertProcessingFailed(() => assertContainedRegularFile(workDir, "source.mp4"));
  });

  it("rejects a NUL byte in the path", async () => {
    await assertProcessingFailed(() =>
      assertContainedRegularFile(workDir, `${workDir}/a\0.mp4`),
    );
  });

  it("accepts an ordinary regular file inside the work directory", async () => {
    const file = join(workDir, "v.mp4");
    await writeFile(file, "x");
    const resolved = await assertContainedRegularFile(workDir, file);
    assert.ok(resolved.endsWith("/v.mp4"));
  });

  it("accepts a regular file in a nested subdirectory", async () => {
    await mkdir(join(workDir, "nested"));
    const file = join(workDir, "nested", "v.mp4");
    await writeFile(file, "x");
    await assert.doesNotReject(() => assertContainedRegularFile(workDir, file));
  });

  it("rejects a sibling directory that merely shares a string prefix", async () => {
    // The canonical prefix-containment bug: `/tmp/job2/...` must not pass
    // merely because the workDir is `/tmp/job`.
    const base = await mkdtemp(join(tmpdir(), "vf-prefix-"));
    try {
      const job = join(base, "job");
      const job2 = join(base, "job2");
      await mkdir(job);
      await mkdir(job2);
      const outside = join(job2, "v.mp4");
      await writeFile(outside, "x");
      await assertProcessingFailed(() => assertContainedRegularFile(job, outside));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects an absolute path plainly outside the work directory", async () => {
    await assertProcessingFailed(() => assertContainedRegularFile(workDir, "/etc/hosts"));
  });

  it("rejects a traversal that climbs out of the work directory", async () => {
    await assertProcessingFailed(() =>
      assertContainedRegularFile(workDir, join(workDir, "..", "..", "etc", "hosts")),
    );
  });

  it("rejects a symlink inside the work directory that escapes it", async () => {
    // The path TEXT is impeccable; only resolving the link reveals the escape,
    // which is why containment is compared between realpaths.
    const link = join(workDir, "escape.mp4");
    await symlink("/etc/hosts", link);
    await assertProcessingFailed(() => assertContainedRegularFile(workDir, link));
  });

  it("rejects a symlink even when its target is inside the work directory", async () => {
    const real = join(workDir, "real.mp4");
    await writeFile(real, "x");
    const link = join(workDir, "link.mp4");
    await symlink(real, link);
    await assertProcessingFailed(() => assertContainedRegularFile(workDir, link));
  });

  it("rejects the work directory itself and any other directory", async () => {
    await assertProcessingFailed(() => assertContainedRegularFile(workDir, workDir));
    await mkdir(join(workDir, "sub"));
    await assertProcessingFailed(() =>
      assertContainedRegularFile(workDir, join(workDir, "sub")),
    );
  });

  it("rejects a path that does not exist", async () => {
    await assertProcessingFailed(() =>
      assertContainedRegularFile(workDir, join(workDir, "missing.mp4")),
    );
  });
});

describe("ffprobe argv policy", () => {
  let workDir: string;
  let file: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vf-argv-"));
    file = join(workDir, "v.mp4");
    await writeFile(file, "x");
  });

  afterEach(async () => {
    setProcessRunnerTestHooks(null);
    await rm(workDir, { recursive: true, force: true });
  });

  it("builds the exact ISO-BMFF probe argv", () => {
    assert.deepEqual(buildProbeArgs({ family: "iso-bmff", inputPath: "/w/v.mp4" }), [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-f",
      "mov",
      "-print_format",
      "json",
      "-show_entries",
      "format=format_name:stream=codec_type",
      "-i",
      "/w/v.mp4",
    ]);
  });

  it("builds the exact WebM probe argv", () => {
    assert.deepEqual(buildProbeArgs({ family: "webm", inputPath: "/w/v.webm" }), [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-f",
      "matroska",
      "-print_format",
      "json",
      "-show_entries",
      "format=format_name:stream=codec_type",
      "-i",
      "/w/v.webm",
    ]);
  });

  it("restricts the probe to local file access only", () => {
    // M1 guard: removing the whitelist must fail here. Verified in the pinned
    // runtime to block `http` before any DNS work.
    for (const family of ["iso-bmff", "webm"] as const) {
      const args = buildProbeArgs({ family, inputPath: "/w/x" });
      const at = args.indexOf("-protocol_whitelist");
      assert.notEqual(at, -1, "the probe must restrict protocols");
      assert.equal(args[at + 1], "file");
      // Exactly the local protocol, nothing appended alongside it.
      for (const forbidden of ["http", "https", "tcp", "udp", "crypto", "concat", "pipe"]) {
        assert.ok(
          !args[at + 1].includes(forbidden),
          `protocol whitelist must not admit ${forbidden}`,
        );
      }
    }
  });

  it("requests only format_name and codec_type", () => {
    const args = buildProbeArgs({ family: "iso-bmff", inputPath: "/w/x" });
    const at = args.indexOf("-show_entries");
    assert.notEqual(at, -1);
    assert.equal(args[at + 1], "format=format_name:stream=codec_type");
    // No tags, titles, comments, codec names, durations or source URLs.
    for (const forbidden of ["tags", "title", "comment", "codec_name", "duration", "filename"]) {
      assert.ok(
        !args[at + 1].includes(forbidden),
        `the probe must not request ${forbidden}`,
      );
    }
  });

  it("names an explicit demuxer and never lets ffprobe auto-detect", () => {
    assert.equal(buildProbeArgs({ family: "iso-bmff", inputPath: "/w/x" })[5], "mov");
    assert.equal(buildProbeArgs({ family: "webm", inputPath: "/w/x" })[5], "matroska");
  });

  it("spawns the absolute controlled ffprobe with shell disabled and bounded output", async () => {
    const { calls } = captureSpawn((child) => {
      respond(child, "{\"streams\":[{\"codec_type\":\"video\"}],\"format\":{\"format_name\":\"mov,mp4,m4a,3gp,3g2,mj2\"}}");
    });

    await probeLocalMedia({
      inputPath: file,
      workDir,
      family: "iso-bmff",
      timeoutMs: 5_000,
    });

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call.command.startsWith("/"), "ffprobe must be an absolute path");
    assert.equal(call.command.split("/").pop(), "ffprobe");
    assert.equal(call.options.shell, false);
    // The hard stdout/stderr ceilings are not visible at the spawn boundary;
    // the overflow tests under "probe subprocess failure handling" prove them.
    assert.ok(call.args.includes("-protocol_whitelist"));
    assert.ok(call.args.includes("json"));
  });

  it("passes the resolved realpath, not the caller's spelling", async () => {
    const { calls } = captureSpawn((child) => {
      respond(child, "{\"streams\":[{\"codec_type\":\"video\"}],\"format\":{\"format_name\":\"mov,mp4,m4a,3gp,3g2,mj2\"}}");
    });
    await probeLocalMedia({
      inputPath: join(workDir, ".", "v.mp4"),
      workDir,
      family: "iso-bmff",
      timeoutMs: 5_000,
    });
    const passed = calls[0].args[calls[0].args.length - 1];
    assert.ok(passed.startsWith("/"));
    assert.ok(!passed.includes("/./"));
  });
});

describe("ffprobe format_name normalization (pinned runtime behaviour)", () => {
  it("normalizes the exact ISO-BMFF alias group the pinned runtime emits", () => {
    assert.equal(normalizeProbeFormatFamily("mov,mp4,m4a,3gp,3g2,mj2"), "iso-bmff");
  });

  it("normalizes the exact WebM alias group the pinned runtime emits", () => {
    assert.equal(normalizeProbeFormatFamily("matroska,webm"), "webm");
  });

  it("rejects the naive single-token spellings that never actually occur", () => {
    // M6 guard. `format_name === "mp4"` is not merely fragile, it is never
    // true against this runtime — MP4 files report the whole alias group.
    for (const value of ["mp4", "webm", "mov", "m4a", "matroska"]) {
      assert.equal(normalizeProbeFormatFamily(value), null, `${value} must not normalize`);
    }
  });

  it("rejects an alias group that merely CONTAINS an approved token", () => {
    for (const value of [
      "mov,mp4,m4a,3gp,3g2,mj2,evil",
      "evil,mov,mp4,m4a,3gp,3g2,mj2",
      "matroska,webm,evil",
      "mp4,mov,m4a,3gp,3g2,mj2",
      "matroska",
      "webm,matroska",
    ]) {
      assert.equal(normalizeProbeFormatFamily(value), null, `${value} must not normalize`);
    }
  });

  it("rejects malformed alias lists", () => {
    for (const value of ["", ",", "mov,,mp4", "matroska, webm", "MATROSKA,WEBM", "matroska,web m"]) {
      assert.equal(normalizeProbeFormatFamily(value), null, `${JSON.stringify(value)} must not normalize`);
    }
  });
});

describe("ffprobe document parser", () => {
  it("accepts every pinned capture from the accepted Worker image", async () => {
    const cases: ReadonlyArray<[string, string, readonly string[]]> = [
      ["iso-bmff-video-only", "iso-bmff", ["video"]],
      ["iso-bmff-audio-only", "iso-bmff", ["audio"]],
      ["iso-bmff-merged", "iso-bmff", ["video", "audio"]],
      ["webm-video-only", "webm", ["video"]],
      ["webm-audio-only", "webm", ["audio"]],
      ["webm-merged", "webm", ["video", "audio"]],
    ];
    for (const [name, family, streams] of cases) {
      const probe = parseProbeDocument(await pinned(name));
      assert.equal(probe.family, family, name);
      assert.deepEqual(probe.streams, streams, name);
    }
  });

  it("does not claim to distinguish MP4 from M4A", () => {
    // Both halves of an ISO-BMFF pair report the SAME alias group, so the
    // probe proves the family and the stream shape, never the subtype.
    const video = parseProbeDocument(
      '{"streams":[{"codec_type":"video"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2"}}',
    );
    const audio = parseProbeDocument(
      '{"streams":[{"codec_type":"audio"}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2"}}',
    );
    assert.equal(video.family, audio.family);
    assert.notDeepEqual(video.streams, audio.streams);
  });

  it("rejects malformed JSON", () => {
    for (const value of ["", "not json", "{", '{"format":', "[]", "null", "123"]) {
      assert.throws(
        () => parseProbeDocument(value),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, "PROCESSING_FAILED");
          return true;
        },
        `expected ${JSON.stringify(value)} to be rejected`,
      );
    }
  });

  it("rejects a document with no format block", () => {
    assert.throws(
      () => parseProbeDocument('{"streams":[{"codec_type":"video"}]}'),
      AppError,
    );
  });

  it("rejects an empty or missing format_name", () => {
    assert.throws(
      () => parseProbeDocument('{"streams":[{"codec_type":"video"}],"format":{}}'),
      AppError,
    );
    assert.throws(
      () =>
        parseProbeDocument('{"streams":[{"codec_type":"video"}],"format":{"format_name":""}}'),
      AppError,
    );
  });

  it("rejects an unknown container family", () => {
    assert.throws(
      () =>
        parseProbeDocument(
          '{"streams":[{"codec_type":"video"}],"format":{"format_name":"avi"}}',
        ),
      AppError,
    );
    assert.throws(
      () =>
        parseProbeDocument(
          '{"streams":[{"codec_type":"video"}],"format":{"format_name":"flv"}}',
        ),
      AppError,
    );
  });

  it("rejects an empty stream list", () => {
    assert.throws(
      () => parseProbeDocument('{"streams":[],"format":{"format_name":"matroska,webm"}}'),
      AppError,
    );
  });

  it("rejects an unsupported stream type rather than dropping it", () => {
    // Silently ignoring a subtitle or data stream would let a file claim a
    // shape it does not have.
    for (const kind of ["subtitle", "data", "attachment", "unknown", ""]) {
      assert.throws(
        () =>
          parseProbeDocument(
            `{"streams":[{"codec_type":"video"},{"codec_type":"${kind}"}],"format":{"format_name":"matroska,webm"}}`,
          ),
        AppError,
        `expected codec_type ${JSON.stringify(kind)} to be rejected`,
      );
    }
  });

  it("rejects a pathological stream count", () => {
    const streams = Array.from({ length: 40 }, () => '{"codec_type":"audio"}').join(",");
    assert.throws(
      () =>
        parseProbeDocument(`{"streams":[${streams}],"format":{"format_name":"matroska,webm"}}`),
      AppError,
    );
  });

  it("ignores extra top-level keys the runtime happens to emit", async () => {
    // The pinned runtime also emits `programs`; an FFmpeg point release adding
    // another key must not become a Worker outage.
    const probe = parseProbeDocument(await pinned("webm-merged"));
    assert.equal(probe.family, "webm");
  });
});

describe("stream-shape matching", () => {
  it("accepts exactly the intended shapes", () => {
    assert.ok(
      hasExactStreamShape({ family: "iso-bmff", streams: ["video"] }, {
        family: "iso-bmff",
        video: 1,
        audio: 0,
      }),
    );
    assert.ok(
      hasExactStreamShape({ family: "webm", streams: ["audio"] }, {
        family: "webm",
        video: 0,
        audio: 1,
      }),
    );
    assert.ok(
      hasExactStreamShape({ family: "webm", streams: ["video", "audio"] }, {
        family: "webm",
        video: 1,
        audio: 1,
      }),
    );
  });

  it("rejects ambiguous and mismatched shapes", () => {
    const expectVideoOnly = { family: "iso-bmff" as const, video: 1, audio: 0 };
    // Muxed media used as the video half.
    assert.ok(
      !hasExactStreamShape({ family: "iso-bmff", streams: ["video", "audio"] }, expectVideoOnly),
    );
    // Two video streams: which one would the map pick?
    assert.ok(
      !hasExactStreamShape({ family: "iso-bmff", streams: ["video", "video"] }, expectVideoOnly),
    );
    // Family mismatch.
    assert.ok(!hasExactStreamShape({ family: "webm", streams: ["video"] }, expectVideoOnly));
    // An audio half that unexpectedly carries video.
    assert.ok(
      !hasExactStreamShape({ family: "webm", streams: ["video", "audio"] }, {
        family: "webm",
        video: 0,
        audio: 1,
      }),
    );
    // Two audio streams in the merged artifact.
    assert.ok(
      !hasExactStreamShape({ family: "webm", streams: ["video", "audio", "audio"] }, {
        family: "webm",
        video: 1,
        audio: 1,
      }),
    );
  });
});

describe("probe subprocess failure handling", () => {
  let workDir: string;
  let file: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vf-probefail-"));
    file = join(workDir, "v.mp4");
    await writeFile(file, "x");
  });

  afterEach(async () => {
    setProcessRunnerTestHooks(null);
    await rm(workDir, { recursive: true, force: true });
  });

  const probe = (signal?: AbortSignal, timeoutMs = 5_000) =>
    probeLocalMedia({ inputPath: file, workDir, family: "iso-bmff", timeoutMs, signal });

  it("fails closed on a non-zero ffprobe exit, without parsing the empty document", async () => {
    // The pinned runtime exits 1 for a blocked protocol AND for a file the
    // explicit demuxer refuses, while still printing `{}` on stdout.
    captureSpawn((child) => respond(child, "{\n\n}\n", 1));
    await assertProcessingFailed(() => probe());
  });

  it("fails closed when stdout exceeds the hard ceiling", async () => {
    captureSpawn((child) => {
      queueMicrotask(() => {
        // Far beyond the probe's conservative ceiling; a real probe is ~169 B.
        child.stdout.write("a".repeat(200_000));
        child.emit("close", 0);
      });
    });
    await assertProcessingFailed(() => probe());
  });

  it("fails closed when stderr exceeds the hard ceiling", async () => {
    captureSpawn((child) => {
      queueMicrotask(() => {
        child.stderr.write("e".repeat(200_000));
        child.emit("close", 0);
      });
    });
    await assertProcessingFailed(() => probe());
  });

  it("never parses truncated output", async () => {
    // A document cut off mid-way must not be salvaged into a family.
    captureSpawn((child) =>
      respond(child, '{"streams":[{"codec_type":"video"}],"format":{"format_na'),
    );
    await assertProcessingFailed(() => probe());
  });

  it("reports a timeout as TIMEOUT and kills the owned process group", async () => {
    const { children, groupKills } = captureSpawn(() => {
      /* never closes on its own */
    });
    await assert.rejects(
      () => probe(undefined, 20),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, "TIMEOUT");
        return true;
      },
    );
    assert.equal(children.length, 1);
    // The NEGATIVE pid: the whole detached group, not just the direct child.
    assert.deepEqual(groupKills, [-(children[0].pid as number)]);
  });

  it("spawns nothing at all for an already-aborted signal", async () => {
    const { calls } = captureSpawn(() => {
      /* unreachable */
    });
    const controller = new AbortController();
    controller.abort();
    await assertProcessingFailed(() => probe(controller.signal));
    assert.equal(calls.length, 0, "an aborted caller must get no subprocess");
  });

  it("terminates the probe's process group when the caller aborts mid-run", async () => {
    const { children, groupKills } = captureSpawn(() => {
      /* never closes on its own */
    });
    const controller = new AbortController();
    const pending = assertProcessingFailed(() => probe(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(children.length, 1, "the probe must be running before the abort");
    controller.abort();
    await pending;
    assert.deepEqual(groupKills, [-(children[0].pid as number)]);
  });

  it("leaks no subprocess output into the error text", async () => {
    const secret = "SENSITIVE-STDERR-CONTENT-9f3a";
    captureSpawn((child) => {
      queueMicrotask(() => {
        child.stderr.write(secret);
        child.stdout.write("{}");
        child.emit("close", 1);
      });
    });
    await assert.rejects(
      () => probe(),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.ok(!err.message.includes(secret), "raw stderr must not reach the AppError");
        return true;
      },
    );
  });

  it("rejects a non-positive timeout before spawning", async () => {
    const { calls } = captureSpawn(() => {
      /* unreachable */
    });
    for (const timeoutMs of [0, -1, Number.NaN, 1.5]) {
      await assertProcessingFailed(() => probe(undefined, timeoutMs));
    }
    assert.equal(calls.length, 0);
  });

  it("refuses an unknown family before spawning", async () => {
    const { calls } = captureSpawn(() => {
      /* unreachable */
    });
    await assertProcessingFailed(() =>
      probeLocalMedia({ inputPath: file, workDir, family: "avi" as never, timeoutMs: 5_000 }),
    );
    assert.equal(calls.length, 0);
  });

  it("never spawns for a remote path", async () => {
    const { calls } = captureSpawn(() => {
      /* unreachable */
    });
    for (const inputPath of [
      "https://cdn.example/v.mp4",
      "http://example.com/v.mp4",
      "file:///etc/passwd",
      "//cdn.example/v.mp4",
    ]) {
      await assertProcessingFailed(() =>
        probeLocalMedia({ inputPath, workDir, family: "iso-bmff", timeoutMs: 5_000 }),
      );
    }
    assert.equal(calls.length, 0, "a remote input must never reach a subprocess");
  });
});
