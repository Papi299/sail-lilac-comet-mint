import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { AppError } from "@/lib/errors";

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const SIGKILL = "SIGKILL" as const;

type TerminationReason = "none" | "timeout" | "abort";

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ProcessKillImpl = (pid: number, signal?: NodeJS.Signals | number) => boolean;

type RunnerTestHooks = {
  spawn?: SpawnImpl;
  processKill?: ProcessKillImpl;
  platform?: NodeJS.Platform;
};

let testHooks: RunnerTestHooks | null = null;

export function setProcessRunnerTestHooks(next: RunnerTestHooks | null): void {
  testHooks = next;
}

function currentPlatform(): NodeJS.Platform {
  return testHooks?.platform ?? process.platform;
}

function currentSpawn(): SpawnImpl {
  return testHooks?.spawn ?? spawn;
}

function currentProcessKill(): ProcessKillImpl {
  return (
    testHooks?.processKill ??
    ((pid, signal) => {
      process.kill(pid, signal);
      return true;
    })
  );
}

export function isValidChildPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

export function posixProcessGroupsEnabled(platform: string): boolean {
  return platform !== "win32";
}

export function buildSpawnOptions(opts: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}): SpawnOptions {
  const platform = opts.platform ?? currentPlatform();
  return {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    detached: posixProcessGroupsEnabled(platform),
  };
}

export type KillableChild = {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
};

export type TerminateTreeResult = {
  usedGroupSignal: boolean;
  usedDirectKill: boolean;
  groupTarget: number | null;
};

function tryDirectKill(child: KillableChild): boolean {
  try {
    child.kill(SIGKILL);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate the runner-owned subprocess tree.
 *
 * POSIX/Linux production: SIGKILL the process group created by detached spawn.
 * Windows development fallback: direct-child SIGKILL only. Negative PIDs are
 * never used. This does not claim full Windows process-tree enforcement.
 */
export function terminateOwnedProcessTree(opts: {
  child: KillableChild;
  createdProcessGroup: boolean;
  platform: string;
  processKill?: ProcessKillImpl;
  selfPid?: number;
}): TerminateTreeResult {
  const processKill = opts.processKill ?? currentProcessKill();
  const selfPid = opts.selfPid ?? process.pid;
  const pid = opts.child.pid;

  const canSignalGroup =
    opts.createdProcessGroup &&
    posixProcessGroupsEnabled(opts.platform) &&
    isValidChildPid(pid) &&
    pid !== selfPid;

  if (!canSignalGroup) {
    return {
      usedGroupSignal: false,
      usedDirectKill: tryDirectKill(opts.child),
      groupTarget: null,
    };
  }

  try {
    processKill(-pid, SIGKILL);
    return { usedGroupSignal: true, usedDirectKill: false, groupTarget: -pid };
  } catch {
    const usedDirectKill = tryDirectKill(opts.child);
    return { usedGroupSignal: true, usedDirectKill, groupTarget: -pid };
  }
}

export function runProcess(opts: {
  command: string;
  args: string[];
  timeoutMs: number;
  cwd?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<RunResult> {
  const { command, args, timeoutMs, cwd, signal, onStdout, onStderr, env } = opts;

  if (signal?.aborted) {
    return Promise.reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
  }

  return new Promise((resolve, reject) => {
    const platform = currentPlatform();
    const spawnOptions = buildSpawnOptions({ cwd, env, platform });
    const createdProcessGroup =
      spawnOptions.detached === true && posixProcessGroupsEnabled(platform);

    const child = currentSpawn()(command, args, spawnOptions);

    let stdout = "";
    let stderr = "";
    let terminationReason: TerminationReason = "none";
    let settled = false;

    const requestTermination = (reason: "timeout" | "abort") => {
      if (terminationReason !== "none") return;
      terminationReason = reason;
      try {
        terminateOwnedProcessTree({
          child,
          createdProcessGroup,
          platform,
        });
      } catch {
        // Timer/abort callbacks must never throw into the event loop.
      }
    };

    const onAbort = () => {
      requestTermination("abort");
    };

    const timer = setTimeout(() => {
      requestTermination("timeout");
    }, timeoutMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) {
      requestTermination("abort");
    }

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      try {
        terminateOwnedProcessTree({ child, createdProcessGroup, platform });
      } catch {
        /* ignore */
      }
      settle(() => reject(new Error("subprocess stdio was not piped")));
      return;
    }

    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");

    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) stdout = stdout.slice(-4_000_000);
      onStdout?.(chunk);
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      onStderr?.(chunk);
    });

    child.on("error", (err) => {
      settle(() => {
        if (terminationReason === "timeout") {
          reject(new AppError("TIMEOUT"));
          return;
        }
        if (terminationReason === "abort") {
          reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
          return;
        }
        reject(err);
      });
    });

    child.on("close", (code) => {
      settle(() => {
        if (terminationReason === "timeout") {
          reject(new AppError("TIMEOUT"));
          return;
        }
        if (terminationReason === "abort") {
          reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
          return;
        }
        resolve({ code, stdout, stderr });
      });
    });
  });
}
