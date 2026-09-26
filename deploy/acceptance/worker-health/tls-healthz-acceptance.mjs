// TLS `/v1/healthz` acceptance CLI — FOR A LATER OPERATOR-AUTHORIZED LIVE RUN.
// (WORKER-EXTERNAL-LIVENESS-TLS-HEALTH-IMPLEMENTATION-001)
//
// NOTHING RUNS THIS AUTOMATICALLY. It is in no systemd unit, no npm script and
// no test, and it is deliberately not reachable from the Worker's start path. It
// makes exactly one outbound HTTPS request, to an endpoint the operator names on
// the command line, and only when the operator invokes it by hand.
//
// It proves one thing: that `GET /v1/healthz` returns the healthy response
// THROUGH THE REAL EXTERNAL TLS ENDPOINT. That is a different measurement from
// the VM-loopback liveness probe, and neither substitutes for the other.
//
// Usage:
//   CLOUDFLARE_ACCESS_CLIENT_ID=… CLOUDFLARE_ACCESS_CLIENT_SECRET=… \
//     node deploy/acceptance/worker-health/tls-healthz-acceptance.mjs \
//       --origin https://<worker-host> [--evidence <path>] [--timeout-ms 10000]
//
// CREDENTIALS COME FROM THE ENVIRONMENT, NEVER FROM ARGV. argv is world-readable
// through /proc on the VM, so an Access Service Auth secret passed as a flag
// would be readable by every local account for the lifetime of the process.
// There is no flag that accepts either credential value, and adding one would
// be a regression.
//
// There is also no `--insecure`, no `--no-verify` and no certificate override of
// any kind, and the tool refuses to run under NODE_TLS_REJECT_UNAUTHORIZED=0.
//
// `--evidence <path>` must name a path that does NOT exist yet. It is created
// before the request, exclusively and with mode exactly 0600; an existing file
// or symlink is refused and left untouched.

import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  ACCESS_ID_ENV,
  ACCESS_SECRET_ENV,
  runTlsHealthzAcceptance,
  TLS_HEALTHZ_PATH,
} from "./lib/tls-healthz.mjs";

function usage() {
  return [
    "usage: node deploy/acceptance/worker-health/tls-healthz-acceptance.mjs \\",
    "         --origin https://<worker-host> [--evidence <path>] [--timeout-ms <n>]",
    "",
    `Requests exactly ${TLS_HEALTHZ_PATH} over HTTPS and requires 200 with the healthy body.`,
    "",
    "Cloudflare Access Service Auth, when the ingress requires it, is supplied through",
    `the environment as ${ACCESS_ID_ENV} and ${ACCESS_SECRET_ENV} —`,
    "both or neither. Neither value may be passed as an argument.",
  ].join("\n");
}

export function parseArgs(argv) {
  let origin;
  let evidencePath;
  let timeoutMs = 10_000;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--origin":
        origin = value;
        i += 1;
        break;
      case "--evidence":
        evidencePath = value;
        i += 1;
        break;
      case "--timeout-ms":
        timeoutMs = Number(value);
        i += 1;
        break;
      case "--help":
      case "-h":
        return { help: true };
      default:
        // A credential flag must not merely be ignored — an operator who reached
        // for one has to be told the value would have been world-readable.
        if (/^--access-client-(id|secret)$/.test(flag)) {
          return {
            error:
              `${flag} does not exist: an Access credential is never passed on the` +
              ` command line, because argv is world-readable through /proc.` +
              ` Supply ${ACCESS_ID_ENV} and ${ACCESS_SECRET_ENV} in the environment instead.`,
          };
        }
        return { error: `unknown argument '${flag}'` };
    }
  }

  if (!origin) return { error: "--origin is required" };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
    return { error: "--timeout-ms must be an integer in 1000-60000" };
  }

  return { origin, evidencePath, timeoutMs };
}

/**
 * Creates the evidence file as a NEW file with mode exactly 0600.
 *
 * REVIEW-CORRECTION-001. `writeFile(path, …, { mode: 0o600 })` applies the mode
 * only when it CREATES the file: an existing file keeps its old permissions and
 * is silently overwritten, so the documented "0600" was not a guarantee.
 *
 *   `wx`   O_CREAT | O_EXCL. An existing path — regular file, directory, or a
 *          symlink, dangling or not — fails with EEXIST. A symlink is never
 *          followed, so its target can never be clobbered.
 *   chmod  on the open descriptor, so the mode is exactly 0600 whatever the
 *          process umask (a umask only ever REMOVES bits from the create mode).
 *
 * Called BEFORE the request, so an unusable evidence path stops the run before
 * anything is dialled, and the path is reserved for the whole run.
 */
export async function createEvidenceFile(path) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.chmod(0o600);
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
  return handle;
}

export async function main(argv, { env = process.env, log = console.log, errorLog = console.error, fetchImpl = fetch } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log(usage());
    return 0;
  }
  if (args.error) {
    errorLog(`tls-healthz-acceptance: ${args.error}`);
    errorLog(usage());
    return 2;
  }

  let evidenceFile = null;
  if (args.evidencePath) {
    try {
      evidenceFile = await createEvidenceFile(args.evidencePath);
    } catch (err) {
      errorLog(
        err?.code === "EEXIST"
          ? "tls-healthz-acceptance: the evidence path already exists; refusing to overwrite it" +
              " (choose a new path). Nothing was requested."
          : `tls-healthz-acceptance: could not create the evidence file (${err?.code ?? "error"}).` +
              " Nothing was requested.",
      );
      return 2;
    }
  }

  let result;
  try {
    result = await runTlsHealthzAcceptance({
      origin: args.origin,
      accessClientId: env[ACCESS_ID_ENV],
      accessClientSecret: env[ACCESS_SECRET_ENV],
      env,
      fetchImpl,
      timeoutMs: args.timeoutMs,
    });

    // The record is printed as well as written, so a run whose evidence write
    // fails still leaves a reviewable result. It contains no credential, no
    // header value, no body and no hostname.
    log(JSON.stringify(result.evidence, null, 2));

    if (evidenceFile) {
      try {
        await evidenceFile.writeFile(`${JSON.stringify(result.evidence, null, 2)}\n`, "utf8");
        log(`tls-healthz-acceptance: evidence written to ${args.evidencePath} (mode 0600)`);
      } catch (err) {
        errorLog(`tls-healthz-acceptance: could not write evidence (${err?.code ?? "error"})`);
        return 2;
      }
    }
  } finally {
    await evidenceFile?.close().catch(() => {});
  }

  if (result.pass) {
    log(`tls-healthz-acceptance: PASS — ${TLS_HEALTHZ_PATH} returned 200 with the healthy body over HTTPS`);
    return 0;
  }

  errorLog(`tls-healthz-acceptance: FAIL — outcome=${result.outcome} detail="${result.detail}"`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
