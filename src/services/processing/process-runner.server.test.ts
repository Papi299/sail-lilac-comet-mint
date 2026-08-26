import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { AppError } from "../../lib/errors.ts";
import {
  buildSpawnOptions,
  isValidChildPid,
  posixProcessGroupsEnabled,
  runProcess,
  setProcessRunnerTestHooks,
  terminateOwnedProcessTree,
  type ProcessKillImpl,
  type SpawnImpl,
} from "./process-runner.server.ts";

type FakeChild = EventEmitter & {
  pid?: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: NodeJS.Signals) => boolean;
  unref?: () => void;
  killCalls: NodeJS.Signals[];
  unrefCalls: number;
};

function createFakeChild(pid?: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.unrefCalls = 0;
  child.kill = (signal?: NodeJS.Signals) => {
    child.killCalls.push(signal ?? ("SIGTERM" as NodeJS.Signals));
    return true;
  };
  child.unref = () => {
    child.unrefCalls += 1;
  };
  return child;
}

function closeSoon(child: FakeChild, code: number | null = null): void {
  queueMicrotask(() => child.emit("close", code));
}

function pidIsLive(pid: number): boolean {
  if (existsSync(`/proc/${pid}/stat`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const state = stat.slice(closeParen + 2, closeParen + 3);
      return state !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidIsLive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !pidIsLive(pid);
}

function defensiveKill(pid: number | undefined): void {
  if (!pid || !isValidChildPid(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* Windows or already gone */
  }
}

describe("process runner spawn options", () => {
  afterEach(() => {
    setProcessRunnerTestHooks(null);
  });

  it("builds a POSIX spawn in its own process group with captured stdio and no shell", () => {
    const options = buildSpawnOptions({ platform: "linux", cwd: "/tmp/jobs" });
    assert.equal(options.detached, true);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.cwd, "/tmp/jobs");
  });

  it("does not enable POSIX detached groups on Windows", () => {
    const options = buildSpawnOptions({ platform: "win32" });
    assert.equal(options.detached, false);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(posixProcessGroupsEnabled("win32"), false);
  });

  it("passes POSIX group spawn options through runProcess and does not unref", async () => {
    const spawned: SpawnOptions[] = [];
    const child = createFakeChild(12345);
    const spawnImpl: SpawnImpl = (_command, _args, options) => {
      spawned.push(options);
      closeSoon(child, 0);
      return child as unknown as ChildProcess;
    };
    setProcessRunnerTestHooks({ platform: "linux", spawn: spawnImpl });
    const result = await runProcess({
      command: "/bin/true",
      args: [],
      timeoutMs: 1_000,
    });
    assert.equal(result.code, 0);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]?.detached, true);
    assert.equal(spawned[0]?.shell, false);
    assert.deepEqual(spawned[0]?.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(child.unrefCalls, 0);
  });
});

describe("process runner tree termination helper", () => {
  it("targets the child process group on POSIX, not merely the leader PID", () => {
    const child = createFakeChild(12345);
    const killTargets: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const processKill: ProcessKillImpl = (pid, signal) => {
      killTargets.push({ pid, signal });
      return true;
    };
    const result = terminateOwnedProcessTree({
      child,
      createdProcessGroup: true,
      platform: "linux",
      processKill,
      selfPid: 1,
    });
    assert.deepEqual(killTargets, [{ pid: -12345, signal: "SIGKILL" }]);
    assert.equal(result.usedGroupSignal, true);
    assert.equal(result.usedDirectKill, false);
    assert.equal(result.groupTarget, -12345);
    assert.deepEqual(child.killCalls, []);
  });

  it("never sends a negative PID on Windows and only kills the direct child", () => {
    const child = createFakeChild(12345);
    const killTargets: number[] = [];
    const processKill: ProcessKillImpl = (pid) => {
      killTargets.push(pid);
      return true;
    };
    const result = terminateOwnedProcessTree({
      child,
      createdProcessGroup: true,
      platform: "win32",
      processKill,
      selfPid: 1,
    });
    assert.deepEqual(killTargets, []);
    assert.equal(result.usedGroupSignal, false);
    assert.equal(result.usedDirectKill, true);
    assert.equal(result.groupTarget, null);
    assert.deepEqual(child.killCalls, ["SIGKILL"]);
  });

  it("does not group-signal invalid PIDs, PID 0, or the runner's own PID", () => {
    const processKill: ProcessKillImpl = () => {
      throw new Error("must not group-signal");
    };
    for (const pid of [undefined, 0, -4, 1.5, Number.NaN]) {
      const child = createFakeChild(pid as number | undefined);
      const result = terminateOwnedProcessTree({
        child,
        createdProcessGroup: true,
        platform: "linux",
        processKill,
        selfPid: 99,
      });
      assert.equal(result.usedGroupSignal, false);
      assert.equal(result.groupTarget, null);
    }
    const self = createFakeChild(99);
    const selfResult = terminateOwnedProcessTree({
      child: self,
      createdProcessGroup: true,
      platform: "linux",
      processKill,
      selfPid: 99,
    });
    assert.equal(selfResult.usedGroupSignal, false);
    assert.equal(isValidChildPid(0), false);
    assert.equal(isValidChildPid(-12345), false);
  });
});

describe("process runner timeout and abort", () => {
  afterEach(() => {
    setProcessRunnerTestHooks(null);
  });

  it("timeout on POSIX SIGKILLs the process group and rejects with TIMEOUT", async () => {
    const child = createFakeChild(12345);
    const groupTargets: number[] = [];
    const processKill: ProcessKillImpl = (pid, signal) => {
      groupTargets.push(pid);
      assert.equal(signal, "SIGKILL");
      closeSoon(child, null);
      return true;
    };
    setProcessRunnerTestHooks({
      platform: "linux",
      spawn: () => child as unknown as ChildProcess,
      processKill,
    });
    await assert.rejects(
      () => runProcess({ command: "sleep", args: ["30"], timeoutMs: 20 }),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.deepEqual(groupTargets, [-12345]);
    assert.deepEqual(child.killCalls, []);
  });

  it("abort on POSIX SIGKILLs the process group and rejects with cancellation", async () => {
    const child = createFakeChild(12345);
    const groupTargets: number[] = [];
    const processKill: ProcessKillImpl = (pid) => {
      groupTargets.push(pid);
      closeSoon(child, null);
      return true;
    };
    const controller = new AbortController();
    setProcessRunnerTestHooks({
      platform: "linux",
      spawn: () => child as unknown as ChildProcess,
      processKill,
    });
    const pending = runProcess({
      command: "sleep",
      args: ["30"],
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(
      pending,
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "PROCESSING_FAILED" &&
        err.message === "Download was cancelled.",
    );
    assert.deepEqual(groupTargets, [-12345]);
    assert.deepEqual(child.killCalls, []);
  });

  it("does not spawn when the signal is already aborted", async () => {
    let spawned = 0;
    setProcessRunnerTestHooks({
      platform: "linux",
      spawn: () => {
        spawned += 1;
        throw new Error("must not spawn");
      },
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        runProcess({
          command: "sleep",
          args: ["30"],
          timeoutMs: 1_000,
          signal: controller.signal,
        }),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "PROCESSING_FAILED" &&
        err.message === "Download was cancelled.",
    );
    assert.equal(spawned, 0);
  });

  it("keeps the first termination reason when timeout wins a race with abort", async () => {
    const child = createFakeChild(12345);
    const groupTargets: number[] = [];
    const controller = new AbortController();
    const processKill: ProcessKillImpl = (pid) => {
      groupTargets.push(pid);
      controller.abort();
      closeSoon(child, null);
      return true;
    };
    setProcessRunnerTestHooks({
      platform: "linux",
      spawn: () => child as unknown as ChildProcess,
      processKill,
    });
    await assert.rejects(
      () =>
        runProcess({
          command: "sleep",
          args: ["30"],
          timeoutMs: 20,
          signal: controller.signal,
        }),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.deepEqual(groupTargets, [-12345]);
  });

  it("keeps the first termination reason when abort wins a race with timeout", async () => {
    const child = createFakeChild(12345);
    const groupTargets: number[] = [];
    const controller = new AbortController();
    const processKill: ProcessKillImpl = (pid) => {
      groupTargets.push(pid);
      return true;
    };
    setProcessRunnerTestHooks({
      platform: "linux",
      spawn: () => child as unknown as ChildProcess,
      processKill,
    });
    const pending = runProcess({
      command: "sleep",
      args: ["30"],
      timeoutMs: 40,
      signal: controller.signal,
    });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 60));
    closeSoon(child, null);
    await assert.rejects(
      pending,
      (err: unknown) =>
        err instanceof AppError &&
        err.code === "PROCESSING_FAILED" &&
        err.message === "Download was cancelled.",
    );
    assert.deepEqual(groupTargets, [-12345]);
  });

  it("falls back to the direct child when POSIX group signaling throws and does not crash", async () => {
    const child = createFakeChild(12345);
    const groupTargets: number[] = [];
    const processKill: ProcessKillImpl = (pid) => {
      groupTargets.push(pid);
      const err = new Error("not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    };
    setProcessRunnerTestHooks({
      platform: "linux",
      spawn: () => child as unknown as ChildProcess,
      processKill,
    });
    const pending = runProcess({ command: "sleep", args: ["30"], timeoutMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    closeSoon(child, null);
    await assert.rejects(
      pending,
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.deepEqual(groupTargets, [-12345]);
    assert.deepEqual(child.killCalls, ["SIGKILL"]);
  });

  it("Windows timeout uses direct-child kill and never a negative PID", async () => {
    const child = createFakeChild(12345);
    const groupTargets: number[] = [];
    child.kill = (signal?: NodeJS.Signals) => {
      child.killCalls.push(signal ?? ("SIGTERM" as NodeJS.Signals));
      closeSoon(child, null);
      return true;
    };
    setProcessRunnerTestHooks({
      platform: "win32",
      spawn: (_command, _args, options) => {
        assert.equal(options.detached, false);
        return child as unknown as ChildProcess;
      },
      processKill: (pid) => {
        groupTargets.push(pid);
        return true;
      },
    });
    await assert.rejects(
      () => runProcess({ command: "sleep", args: ["30"], timeoutMs: 20 }),
      (err: unknown) => err instanceof AppError && err.code === "TIMEOUT",
    );
    assert.deepEqual(groupTargets, []);
    assert.deepEqual(child.killCalls, ["SIGKILL"]);
  });
});

describe("process runner result semantics", () => {
  afterEach(() => {
    setProcessRunnerTestHooks(null);
  });

  it("resolves stdout from a successful subprocess", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello-ok')"],
      timeoutMs: 5_000,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "hello-ok");
  });

  it("returns a nonzero exit code without mapping it to timeout or cancellation", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
      timeoutMs: 5_000,
    });
    assert.equal(result.code, 7);
  });

  it("forwards stdout and stderr chunks while they arrive", async () => {
    const child = createFakeChild(9);
    setProcessRunnerTestHooks({
      platform: "linux",
      spawn: () => child as unknown as ChildProcess,
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const pending = runProcess({
      command: "tool",
      args: [],
      timeoutMs: 1_000,
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    child.stdout.write("out-1");
    child.stderr.write("err-1");
    closeSoon(child, 0);
    const result = await pending;
    assert.equal(result.stdout, "out-1");
    assert.equal(result.stderr, "err-1");
    assert.deepEqual(stdoutChunks, ["out-1"]);
    assert.deepEqual(stderrChunks, ["err-1"]);
  });
});

describe("POSIX process-tree integration", () => {
  afterEach(() => {
    setProcessRunnerTestHooks(null);
  });

  it(
    "SIGKILLs a grandchild that inherited the child process group",
    {
      timeout: 10_000,
      skip:
        process.platform === "win32"
          ? "Windows development fallback: direct-child termination only"
          : false,
    },
    async () => {
      const childSource = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  detached: false,
});
if (!grandchild.pid) process.exit(2);
process.stdout.write("child=" + process.pid + "\\n");
process.stdout.write("grandchild=" + grandchild.pid + "\\n");
setInterval(() => {}, 1000);
`;
      const controller = new AbortController();
      let childPid: number | undefined;
      let grandchildPid: number | undefined;
      let seen = "";
      try {
        const pending = runProcess({
          command: process.execPath,
          args: ["-e", childSource],
          timeoutMs: 8_000,
          signal: controller.signal,
          onStdout: (chunk) => {
            seen += chunk;
            const childMatch = /child=(\d+)/.exec(seen);
            const grandchildMatch = /grandchild=(\d+)/.exec(seen);
            if (childMatch) childPid = Number(childMatch[1]);
            if (grandchildMatch) {
              grandchildPid = Number(grandchildMatch[1]);
              if (!controller.signal.aborted) controller.abort();
            }
          },
        });
        await assert.rejects(
          pending,
          (err: unknown) =>
            err instanceof AppError &&
            err.code === "PROCESSING_FAILED" &&
            err.message === "Download was cancelled.",
        );
        assert.ok(grandchildPid, "grandchild pid must be captured");
        assert.ok(childPid, "child pid must be captured");
        const grandchildDead = await waitUntilDead(grandchildPid, 2_000);
        assert.equal(grandchildDead, true, `grandchild ${grandchildPid} remained alive`);
        const childDead = await waitUntilDead(childPid, 2_000);
        assert.equal(childDead, true, `child ${childPid} remained alive`);
      } finally {
        defensiveKill(grandchildPid);
        defensiveKill(childPid);
      }
    },
  );
});
