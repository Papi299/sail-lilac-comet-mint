import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { AppError } from "@/lib/errors";

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const SIGKILL = "SIGKILL" as const;

/**
 * Default in-memory retention ceilings.
 *
 * These are RETENTION bounds, not process bounds: on overflow the runner keeps
 * only the tail and the child keeps running. Every existing caller relies on
 * that lenient behaviour (FFmpeg, for instance, is expected to be chatty), so
 * the defaults are unchanged.
 */
const DEFAULT_STDOUT_RETENTION_BYTES = 8_000_000;
const DEFAULT_STDOUT_RETAINED_TAIL_BYTES = 4_000_000;
const DEFAULT_STDERR_RETENTION_BYTES = 2_000_000;
const DEFAULT_STDERR_RETAINED_TAIL_BYTES = 1_000_000;

/**
 * Raised when a caller-supplied HARD output ceiling is exceeded.
 *
 * A caller that sets `maxStdoutBytes`/`maxStderrBytes` is stating that output
 * beyond that size is not merely uninteresting but unacceptable — the yt-dlp
 * analysis path needs a complete, parseable JSON document or nothing at all,
 * and silently retaining a tail would hand it a truncated document that looks
 * like malformed extractor output. So the ceiling terminates the owned process
 * group and rejects, and the partial output is never returned to anyone.
 *
 * It is a distinct class rather than a bare `AppError` so a caller can tell an
 * overflow apart from cancellation, which shares `PROCESSING_FAILED`.
 */
export class ProcessOutputLimitError extends AppError {
  readonly stream: "stdout" | "stderr";

  constructor(stream: "stdout" | "stderr") {
    // The message names the STREAM and the fact of the overflow. It never
    // carries any subprocess output, not even a length.
    super("PROCESSING_FAILED", `Subprocess ${stream} exceeded its byte ceiling.`);
    this.name = "ProcessOutputLimitError";
    this.stream = stream;
  }
}

type TerminationReason = "none" | "timeout" | "abort" | "stdout_limit" | "stderr_limit";

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
  /**
   * HARD ceiling on total stdout bytes. When supplied and exceeded, the owned
   * process group is terminated and the promise rejects with
   * `ProcessOutputLimitError`; no partial output is resolved or returned.
   *
   * Omitting it preserves the historical lenient behaviour exactly: retain at
   * most ~8 MB, keeping the last ~4 MB, and let the child run on.
   */
  maxStdoutBytes?: number;
  /** HARD ceiling on total stderr bytes. Same semantics as `maxStdoutBytes`. */
  maxStderrBytes?: number;
}): Promise<RunResult> {
  const {
    command,
    args,
    timeoutMs,
    cwd,
    signal,
    onStdout,
    onStderr,
    env,
    maxStdoutBytes,
    maxStderrBytes,
  } = opts;

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

    const requestTermination = (
      reason: "timeout" | "abort" | "stdout_limit" | "stderr_limit",
    ) => {
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
      if (maxStdoutBytes !== undefined) {
        if (stdout.length > maxStdoutBytes) {
          // Drop what we hold immediately: an over-limit stream is never
          // returned, never parsed and never classified, so retaining it would
          // only keep unwanted bytes alive until the promise settles.
          stdout = "";
          requestTermination("stdout_limit");
          return;
        }
      } else if (stdout.length > DEFAULT_STDOUT_RETENTION_BYTES) {
        stdout = stdout.slice(-DEFAULT_STDOUT_RETAINED_TAIL_BYTES);
      }
      onStdout?.(chunk);
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
      if (maxStderrBytes !== undefined) {
        if (stderr.length > maxStderrBytes) {
          stderr = "";
          requestTermination("stderr_limit");
          return;
        }
      } else if (stderr.length > DEFAULT_STDERR_RETENTION_BYTES) {
        stderr = stderr.slice(-DEFAULT_STDERR_RETAINED_TAIL_BYTES);
      }
      onStderr?.(chunk);
    });

    /**
     * The rejection a termination implies, or null when the run was allowed to
     * finish normally. Shared by the `error` and `close` handlers so a killed
     * process reports identically whichever fires first.
     */
    const terminationRejection = (): Error | null => {
      switch (terminationReason) {
        case "timeout":
          return new AppError("TIMEOUT");
        case "abort":
          return new AppError("PROCESSING_FAILED", "Download was cancelled.");
        case "stdout_limit":
          return new ProcessOutputLimitError("stdout");
        case "stderr_limit":
          return new ProcessOutputLimitError("stderr");
        case "none":
          return null;
      }
    };

    child.on("error", (err) => {
      settle(() => {
        reject(terminationRejection() ?? err);
      });
    });

    child.on("close", (code) => {
      settle(() => {
        const terminated = terminationRejection();
        if (terminated) {
          reject(terminated);
          return;
        }
        resolve({ code, stdout, stderr });
      });
    });
  });
}
