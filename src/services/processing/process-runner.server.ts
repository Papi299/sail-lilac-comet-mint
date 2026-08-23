import { spawn } from "node:child_process";
import { AppError } from "@/lib/errors";

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

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

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      killed = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) stdout = stdout.slice(-4_000_000);
      onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      onStderr?.(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (timedOut) {
        reject(new AppError("TIMEOUT"));
        return;
      }
      if (signal?.aborted) {
        reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
        return;
      }
      if (killed && code !== 0) {
        reject(new AppError("PROCESSING_FAILED"));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}
