import { pathToFileURL } from "node:url";
import { R2CredentialBroker } from "./broker-service.ts";
import { loadR2BrokerConfig, R2BrokerConfigError } from "./config.ts";
import { startR2BrokerSocketServer, type R2BrokerSocketServer } from "./socket-server.ts";

/**
 * Trusted R2 credential broker entry point.
 *
 * Runs on the VM HOST, as its own user, in its own systemd unit, OUTSIDE the
 * media network namespace. It must be listening before the Worker container
 * starts — see `deploy/systemd/` for the fail-closed ordering.
 *
 * This is the only layer permitted process-level side effects. Importing the
 * module does nothing.
 */

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Renders a startup failure without disclosing any configuration VALUE.
 *
 * This process reads the persistent R2 parent secret, so the rule is stricter
 * here than anywhere else in the system: never a value, never a Zod message
 * that could embed one, never an exception cause chain.
 */
export function describeBrokerStartupFailure(err: unknown): string {
  if (err instanceof R2BrokerConfigError) {
    return err.variables.length > 0
      ? `startup blocked: invalid configuration for ${err.variables.join(", ")}`
      : "startup blocked: invalid configuration";
  }
  const name =
    err instanceof Error && typeof err.name === "string" && err.name.length > 0
      ? err.name
      : "Error";
  return `startup failed: ${name.slice(0, 64)}`;
}

export type BrokerMainDeps = {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  logError?: (line: string) => void;
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  setExitCode?: (code: number) => void;
};

/**
 * Boots the broker. Returns the live listener, or null when startup failed
 * (in which case the exit status has already been set nonzero and NO socket
 * exists — the Worker's dependency on it then fails closed).
 */
export async function startR2Broker(
  deps: BrokerMainDeps = {},
): Promise<R2BrokerSocketServer | null> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const onSignal =
    deps.onSignal ??
    ((signal: NodeJS.Signals, handler: () => void) => { process.once(signal, handler); });

  try {
    const config = loadR2BrokerConfig(env);

    const broker = new R2CredentialBroker({
      config: config.broker,
      // Category counters only. The observer signature cannot carry an object
      // key, a bucket, a token or a secret, so this call site is incapable of
      // logging credential material.
      observer: (outcome, code) => {
        if (outcome === "refused") log(`[r2-broker] refused ${code}`);
      },
    });

    const listener = await startR2BrokerSocketServer({
      broker,
      socketPath: config.socketPath,
    });

    log(`[r2-broker] listening on ${config.socketPath}`);

    let stopping = false;
    for (const signal of SIGNALS) {
      onSignal(signal, () => {
        if (stopping) return;
        stopping = true;
        log(`[r2-broker] ${signal} received, shutting down`);
        listener
          .close()
          .then(() => log("[r2-broker] shutdown complete"))
          .catch(() => {
            logError("[r2-broker] shutdown failed");
            setExitCode(1);
          });
      });
    }

    return listener;
  } catch (err: unknown) {
    logError(`[r2-broker] ${describeBrokerStartupFailure(err)}`);
    setExitCode(1);
    return null;
  }
}

/**
 * Runs only when this file IS the process entry point, so importing it for
 * tests or tooling can never bind a socket.
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
  await startR2Broker();
}
