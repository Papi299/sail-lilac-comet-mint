// The loopback Worker health request, for the host-side liveness probe.
// (WORKER-EXTERNAL-LIVENESS-TLS-HEALTH-IMPLEMENTATION-001)
//
// Invoked by deploy/bin/vf-worker-liveness-probe with the pinned host Node the
// deployment already requires (install order step 0 — the R2 broker cannot run
// without it). Using it is what keeps this task from adding ANY host package:
// no curl, no wget, no apt step. The Worker image is forbidden to contain a
// health client, and the host must not grow one either.
//
// WHAT THIS FILE IS ALLOWED TO DO
//
// One bounded HTTP GET to 127.0.0.1 on the configured port, and a strict
// judgement about the response. That is all. It runs in the VM's ordinary host
// namespace, holds no credential, sends no authentication, enters no network
// namespace, invokes no container runtime and mutates nothing.
//
// THE TARGET IS NOT CONFIGURABLE
//
// The host and the path are CONSTANTS here, not arguments. Only the port is
// passed in, because the port is the one value the deployment legitimately owns
// (VIDEOFETCH_WORKER_PORT in /etc/videofetch/media-egress.env, the same
// declaration the namespace holder publishes on loopback). No caller and no
// configuration file can retarget this probe at a LAN address, a public host or
// another endpoint.

import { request } from "node:http";
import { pathToFileURL } from "node:url";

/**
 * The loopback host. A LITERAL ADDRESS, never a name.
 *
 * `localhost` would go through the resolver and can legitimately resolve to
 * `::1`, to both families in an unspecified order, or — on a host with a
 * creative /etc/hosts — somewhere else entirely. The ingress
 * videofetch-media-netns.service publishes is `127.0.0.1:<port>` exactly, so
 * that is what is dialled.
 */
export const LIVENESS_HOST = "127.0.0.1";

/**
 * The Worker's unauthenticated health path.
 *
 * Kept in step with `WORKER_HEALTH_PATH` in src/shared/worker/constants.ts by
 * the deployment-policy suite, which asserts the two agree. It is duplicated
 * rather than imported because this file is executed by the bare host Node,
 * with no TypeScript loader and no alias hooks — the probe must not depend on
 * the application's module graph to find out whether the application is alive.
 */
export const LIVENESS_PATH = "/v1/healthz";

/** The healthy state the Worker's health route reports. */
export const LIVENESS_EXPECTED_STATUS = "ok";

/**
 * A health body is a few bytes. The cap exists so a compromised or confused
 * listener on the port cannot stream indefinitely into a probe that runs on a
 * timer, and it is small enough that exceeding it is itself a finding.
 */
export const LIVENESS_MAX_BODY_BYTES = 4096;

/** Outcomes, so the probe's stdout is greppable and the tests can assert them. */
export const LIVENESS_OUTCOMES = Object.freeze({
  HEALTHY: "healthy",
  CONNECT_FAILED: "connect-failed",
  TIMEOUT: "timeout",
  BAD_STATUS: "bad-status",
  BODY_TOO_LARGE: "body-too-large",
  MALFORMED_BODY: "malformed-body",
  WRONG_STATE: "wrong-state",
});

/**
 * @typedef {object} LivenessResult
 * @property {boolean} ok
 * @property {string} outcome
 * @property {number} [status]
 * @property {string} [detail]
 */

/**
 * @typedef {object} LivenessDetail
 * @property {number} [status]
 * @property {string} [detail]
 */

/**
 * Performs the bounded health request.
 *
 * ONE TOTAL DEADLINE governs the whole exchange — connect, response headers and
 * body — rather than a per-socket inactivity timeout. An inactivity timeout can
 * be held open indefinitely by a peer that dribbles one byte before each
 * expiry, which is precisely the shape of hang a liveness probe must not be
 * susceptible to.
 *
 * Never throws: every failure is returned as a verdict, because a probe that
 * throws is a probe whose timer unit reports a crash instead of a diagnosis.
 */
/**
 * @param {{ port: number, timeoutMs: number, requestImpl?: typeof request }} options
 * @returns {Promise<LivenessResult>}
 */
export function probeWorkerHealth({ port, timeoutMs, requestImpl = request }) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {import("node:http").ClientRequest | null} */
    let req = null;

    /**
     * @param {string} outcome
     * @param {LivenessDetail} detail
     */
    const finish = (outcome, detail) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Destroying an already-finished request is harmless, and destroying an
      // in-flight one is what stops a dangling socket from outliving the
      // verdict and keeping the probe process alive past its own deadline.
      try {
        req?.destroy();
      } catch {
        /* the verdict is already decided; teardown cannot change it */
      }
      resolve({
        ok: outcome === LIVENESS_OUTCOMES.HEALTHY,
        outcome,
        ...detail,
      });
    };

    timer = setTimeout(() => {
      finish(LIVENESS_OUTCOMES.TIMEOUT, { detail: `no complete response within ${timeoutMs}ms` });
    }, timeoutMs);
    // The deadline must not, by existing, keep the event loop alive after the
    // request has already settled by another path.
    timer.unref?.();

    try {
      req = requestImpl(
        {
          host: LIVENESS_HOST,
          port,
          path: LIVENESS_PATH,
          method: "GET",
          // No `Host:` override, no credential, no cookie, no VideoFetch HMAC
          // header: /v1/healthz is unauthenticated at the Worker application
          // layer and this probe has nothing to authenticate with.
          headers: { accept: "application/json" },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          /** @type {Buffer[]} */
          const chunks = [];
          let size = 0;

          res.on("data", (/** @type {Buffer} */ chunk) => {
            size += chunk.length;
            if (size > LIVENESS_MAX_BODY_BYTES) {
              finish(LIVENESS_OUTCOMES.BODY_TOO_LARGE, {
                status,
                detail: `response body exceeded ${LIVENESS_MAX_BODY_BYTES} bytes`,
              });
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            if (settled) return;

            // Status first. A 3xx is NOT followed: nothing should be
            // redirecting the loopback ingress, and quietly chasing one would
            // turn "something else is answering this port" into a pass.
            if (status !== 200) {
              finish(LIVENESS_OUTCOMES.BAD_STATUS, {
                status,
                detail: `expected HTTP 200, got ${status}`,
              });
              return;
            }

            const text = Buffer.concat(chunks).toString("utf8");
            /** @type {unknown} */
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              finish(LIVENESS_OUTCOMES.MALFORMED_BODY, {
                status,
                detail: "response body is not valid JSON",
              });
              return;
            }

            // Structural before semantic: an array, a string or null must not
            // reach the `status` comparison and read as "some other state".
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              finish(LIVENESS_OUTCOMES.MALFORMED_BODY, {
                status,
                detail: "response body is not a JSON object",
              });
              return;
            }

            if (/** @type {{ status?: unknown }} */ (parsed).status !== LIVENESS_EXPECTED_STATUS) {
              // The observed state is deliberately NOT echoed: it is attacker-
              // influenceable text from whatever answered the port, and the
              // probe's journal line is not the place to render it.
              finish(LIVENESS_OUTCOMES.WRONG_STATE, {
                status,
                detail: `health state is not "${LIVENESS_EXPECTED_STATUS}"`,
              });
              return;
            }

            finish(LIVENESS_OUTCOMES.HEALTHY, { status, detail: "status ok" });
          });

          res.on("error", () => {
            finish(LIVENESS_OUTCOMES.CONNECT_FAILED, { status, detail: "response stream error" });
          });
        },
      );
    } catch {
      finish(LIVENESS_OUTCOMES.CONNECT_FAILED, { detail: "request could not be created" });
      return;
    }

    // Connection refused, host unreachable, socket reset: all the same class of
    // answer — nothing is serving the ingress the tunnel also uses.
    req.on("error", (/** @type {NodeJS.ErrnoException} */ err) => {
      finish(LIVENESS_OUTCOMES.CONNECT_FAILED, {
        detail: `connection failed (${err?.code ?? "error"})`,
      });
    });

    req.end();
  });
}

/**
 * Parses `--port <n> --timeout-ms <n>`. Strict: an unknown flag is a usage error.
 *
 * @param {string[]} argv
 * @returns {{ error: string } | { error?: undefined, port: number, timeoutMs: number }}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let port;
  /** @type {string | number} */
  let timeoutMs = 3000;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--port") {
      port = value;
      i += 1;
    } else if (flag === "--timeout-ms") {
      timeoutMs = value;
      i += 1;
    } else {
      return { error: `unknown argument '${flag}'` };
    }
  }

  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return { error: `--port '${port ?? ""}' is not a port in 1-65535` };
  }
  const timeoutNumber = Number(timeoutMs);
  if (!Number.isInteger(timeoutNumber) || timeoutNumber < 1 || timeoutNumber > 60_000) {
    return { error: `--timeout-ms '${timeoutMs}' is not an integer in 1-60000` };
  }

  return { port: portNumber, timeoutMs: timeoutNumber };
}

/**
 * The CLI. Exit 0 only when the real health contract is satisfied.
 *
 * @param {string[]} argv
 * @param {{ log?: (line: string) => void, errorLog?: (line: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, { log = console.log, errorLog = console.error } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    errorLog(`vf-worker-health-request: ${parsed.error}`);
    return 2;
  }

  const result = await probeWorkerHealth(parsed);
  const line =
    `vf-worker-health-request: ${result.ok ? "OK" : "FAIL"} outcome=${result.outcome}` +
    ` target=http://${LIVENESS_HOST}:${parsed.port}${LIVENESS_PATH}` +
    (result.status === undefined ? "" : ` http_status=${result.status}`) +
    (result.detail ? ` detail="${result.detail}"` : "");

  if (result.ok) {
    log(line);
    return 0;
  }
  errorLog(line);
  return 1;
}

// Executed directly by the probe; imported without side effects by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
