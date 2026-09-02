import { pathToFileURL } from "node:url";
import { loadWorkerRuntimeConfig, WorkerRuntimeConfigError } from "./config.server.ts";
import { createWorkerRuntime, type WorkerRuntime } from "./runtime.server.ts";

/**
 * Worker process entry point (Phase 8A §15).
 *
 * This file is the ONLY layer permitted to perform process-level side effects:
 * reading the ambient environment, listening, installing signal handlers and
 * setting an exit status. Everything below it is a pure factory.
 *
 * Startup is strictly ordered and fails closed:
 *
 *   load/validate env → create runtime → start maintenance →
 *   listen → wake queue → install signal handlers
 *
 * If any step fails the process NEVER listens, emits exactly one bounded,
 * non-secret line, closes whatever it already opened, and exits nonzero.
 */

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Renders a startup failure without ever disclosing configuration VALUES.
 *
 * `process.env`, R2 credentials, the Worker HMAC secret and full exception
 * cause chains are all deliberately excluded. A configuration failure names the
 * offending variables; anything else is reported by error class alone.
 */
export function describeStartupFailure(err: unknown): string {
  if (err instanceof WorkerRuntimeConfigError) {
    return err.variables.length > 0
      ? `startup blocked: invalid configuration for ${err.variables.join(", ")}`
      : "startup blocked: invalid configuration";
  }
  const name =
    err instanceof Error && typeof err.name === "string" && err.name.length > 0
      ? err.name
      : "Error";
  // The class name is bounded and author-controlled; the message is not, so it
  // never travels.
  return `startup failed: ${name.slice(0, 64)}`;
}

export type MainDeps = {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  logError?: (line: string) => void;
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  setExitCode?: (code: number) => void;
};

/**
 * Boots the Worker. Returns the live runtime on success, or `null` when startup
 * failed (in which case the exit status has already been set nonzero).
 */
export async function startWorker(deps: MainDeps = {}): Promise<WorkerRuntime | null> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const onSignal =
    deps.onSignal ??
    ((signal: NodeJS.Signals, handler: () => void) => {
      process.once(signal, handler);
    });

  let runtime: WorkerRuntime | null = null;
  try {
    const config = loadWorkerRuntimeConfig(env);

    // Construction performs migrations and recovery. It does not listen.
    runtime = await createWorkerRuntime(config);

    runtime.maintenance.start();

    const address = await runtime.listen();
    log(`[worker] listening on ${address.host}:${address.port}`);
    log(`[worker] state directory ${runtime.stateDirectory}`);

    // Durable queued jobs that survived the restart resume from here.
    runtime.wakeQueue();

    installShutdownHandlers(runtime, onSignal, log, logError, setExitCode);

    return runtime;
  } catch (err: unknown) {
    logError(`[worker] ${describeStartupFailure(err)}`);
    setExitCode(1);

    if (runtime) {
      // The listener never bound, but the database and server objects may
      // already exist. Release them rather than leaking a WAL handle.
      try {
        await runtime.shutdown();
      } catch {
        /* the original startup failure is the one that matters */
      }
    }
    return null;
  }
}

function installShutdownHandlers(
  runtime: WorkerRuntime,
  onSignal: (signal: NodeJS.Signals, handler: () => void) => void,
  log: (line: string) => void,
  logError: (line: string) => void,
  setExitCode: (code: number) => void,
): void {
  let shuttingDown = false;

  for (const signal of SIGNALS) {
    onSignal(signal, () => {
      // A second signal during shutdown is ignored; the bounded grace period in
      // the runtime already guarantees termination.
      if (shuttingDown) return;
      shuttingDown = true;

      log(`[worker] ${signal} received, shutting down`);
      runtime
        .shutdown()
        .then(() => {
          log("[worker] shutdown complete");
        })
        .catch(() => {
          // An operator-initiated restart that fails to close cleanly is a real
          // runtime failure, so it is surfaced as a nonzero status. It is never
          // reported with a raw message.
          logError("[worker] shutdown failed");
          setExitCode(1);
        });
    });
  }
}

/**
 * Runs only when this file IS the process entry point, so importing it (for
 * tests or tooling) can never start a server.
 */
function isProcessEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isProcessEntryPoint()) {
  await startWorker();
}
