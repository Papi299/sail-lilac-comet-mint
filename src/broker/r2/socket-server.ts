import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, unlink, stat } from "node:fs/promises";
import {
  R2_BROKER_MAX_REQUEST_BYTES,
  R2_BROKER_MINT_PATH,
  type R2BrokerErrorCode,
} from "../../shared/worker/r2-broker.ts";
import type { R2CredentialBroker } from "./broker-service.ts";

/**
 * The Worker <-> broker boundary: an AF_UNIX socket, deliberately not a port.
 *
 * A Unix domain socket is the transport precisely BECAUSE it is not the
 * network. Credential requests never enter an IP stack, so they cannot leave
 * the host, cannot be reached from the media namespace's egress path, and are
 * unaffected by (and cannot be used to bypass) the externally-owned safe-egress
 * policy. The media container therefore gains a credential source without
 * gaining any new network egress.
 *
 * Access control is filesystem access control:
 *
 *   - the socket is created by the broker's own user, mode 0660;
 *   - the Worker container joins the broker's group, which is what permits
 *     connect(2);
 *   - the socket's DIRECTORY is bind-mounted read-only into the container, so
 *     the Worker cannot unlink, replace or shadow the socket with a listener of
 *     its own — the read-only mount defeats socket hijacking, while the mode
 *     bits permit an ordinary connect.
 *
 * HTTP/1.1 over the socket is used only because Node ships a hardened parser
 * for it. No hostname, TLS or routing is involved.
 */

/** Bounded so a stuck client cannot hold a broker connection open forever. */
export const R2_BROKER_REQUEST_TIMEOUT_MS = 5_000;

export type R2BrokerSocketServer = {
  readonly server: Server;
  readonly socketPath: string;
  close(): Promise<void>;
};

/** Writes a JSON response and never a request value. */
function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function refuse(res: ServerResponse, status: number, code: R2BrokerErrorCode): void {
  respond(res, status, { error: code });
}

/**
 * Reads a bounded request body.
 *
 * The cap is enforced as bytes arrive, not after buffering, so an oversized
 * body is rejected without the broker ever holding it.
 */
async function readBoundedBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > R2_BROKER_MAX_REQUEST_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Creates and binds the broker's Unix-socket listener.
 *
 * A stale socket file from an unclean shutdown is removed first — but only if
 * it is actually a socket, so a misconfigured path can never make the broker
 * delete a regular file.
 */
export async function startR2BrokerSocketServer(deps: {
  broker: R2CredentialBroker;
  socketPath: string;
  /** Socket mode. 0o660 lets the Worker's group connect and no one else. */
  mode?: number;
}): Promise<R2BrokerSocketServer> {
  const { broker, socketPath } = deps;

  await removeStaleSocket(socketPath);

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      // A handler fault must still produce a fail-closed answer, never a
      // hanging request and never a stack trace on the wire.
      if (!res.headersSent) refuse(res, 500, "mint_failed");
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return refuse(res, 405, "malformed_request");

    // Path only — there is exactly one route and no parameterized surface.
    const path = (req.url ?? "").split("?")[0];
    if (path !== R2_BROKER_MINT_PATH) return refuse(res, 404, "malformed_request");

    const body = await readBoundedBody(req);
    if (body === null) {
      // The peer may still be writing. Answer, then tear the connection down
      // explicitly rather than draining an oversized body we already rejected.
      res.setHeader("connection", "close");
      refuse(res, 413, "malformed_request");
      req.destroy();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return refuse(res, 400, "malformed_request");
    }

    const decision = broker.handle(parsed);
    if (!decision.ok) {
      // 403 for an authorization refusal, 400 for a shape refusal. Neither
      // body carries any value from the request.
      const status =
        decision.code === "malformed_request" ||
        decision.code === "invalid_object_key" ||
        decision.code === "invalid_ttl"
          ? 400
          : decision.code === "mint_failed"
            ? 500
            : 403;
      return refuse(res, status, decision.code);
    }

    respond(res, 200, decision.response);
  }

  server.requestTimeout = R2_BROKER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = R2_BROKER_REQUEST_TIMEOUT_MS;
  // The broker holds no long-lived client state; a short keep-alive keeps
  // per-operation minting cheap without pinning connections.
  server.keepAliveTimeout = 1_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  // Tighten the socket immediately after bind. Until this succeeds the broker
  // is not considered started, so a permissive socket is never left exposed.
  await chmod(socketPath, deps.mode ?? 0o660);

  return {
    server,
    socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeStaleSocket(socketPath);
    },
  };
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let info;
  try {
    info = await stat(socketPath);
  } catch {
    return; // nothing there, which is the normal case
  }
  if (!info.isSocket()) {
    throw new Error("broker socket path exists and is not a socket");
  }
  await unlink(socketPath);
}
