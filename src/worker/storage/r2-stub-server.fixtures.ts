import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

/**
 * VIDEOFETCH-LD2B-BOUNDED-CANCELLABLE-UPLOAD-001 — a synthetic S3-compatible
 * endpoint for transport tests, on the loopback interface only.
 *
 * It speaks the small subset the Worker's R2 writer uses (path-style PutObject,
 * HeadObject and DeleteObject) and, per exchange, misbehaves on request: it can
 * stall before the body, stop reading part-way, read everything and never
 * answer, answer slowly, reset the connection, or answer with an S3 error. It
 * records what it observed on its side of every exchange — body bytes received,
 * whether the client closed first, every socket opened and closed — so a test
 * can prove that a client-side abort really ended the request, rather than
 * merely that a promise rejected.
 *
 * Nothing here contacts anything but the test process itself. It holds no
 * credential: the client signs with fake values and the stub never checks them.
 */

export type StubObject = {
  readonly size: number;
  readonly contentType: string;
  readonly contentDisposition: string;
};

/** One request as the stub saw it. Mutated in place while it is in flight. */
export type StubExchange = {
  readonly ordinal: number;
  readonly method: string;
  /** The object key: the path after `/<bucket>/`, query removed. */
  readonly key: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  bytesReceived: number;
  bodyComplete: boolean;
  /** The status the stub answered with, or null while it has not answered. */
  responded: number | null;
  /** The client went away before the stub had answered. */
  clientClosed: boolean;
  closed: boolean;
};

/** How the stub treats one exchange. `normal` is a faithful happy path. */
export type StubMode =
  | { readonly kind: "normal" }
  /** `Expect: 100-continue` is never answered and nothing is ever read. */
  | { readonly kind: "never-continue" }
  /**
   * Reads this many body bytes, then never reads again and never answers. A
   * socket nobody reads cannot report the client's close either: observe the
   * client's side to prove the request ended.
   */
  | { readonly kind: "stall-body"; readonly afterBytes: number }
  /** Reads like a slow uplink — one chunk, then `tickMs` of pause — and never answers. */
  | { readonly kind: "trickle"; readonly tickMs: number }
  /** Reads the whole body, then never answers. */
  | { readonly kind: "never-respond" }
  /** Answers normally, but only after this delay (the body is read at once). */
  | { readonly kind: "slow-response"; readonly delayMs: number }
  /** Destroys the connection after this many body bytes. */
  | { readonly kind: "reset"; readonly afterBytes: number }
  /** Answers at once with an S3 error document. */
  | { readonly kind: "status"; readonly status: number; readonly code: string };

export type StubS3Server = {
  /** `http://127.0.0.1:<port>`: give it to the client with `forcePathStyle`. */
  readonly endpoint: string;
  readonly exchanges: StubExchange[];
  readonly objects: Map<string, StubObject>;
  readonly sockets: { opened: number; closed: number };
  close(): Promise<void>;
};

export async function startStubS3Server(options: {
  bucket: string;
  mode?: (exchange: StubExchange) => StubMode;
}): Promise<StubS3Server> {
  const exchanges: StubExchange[] = [];
  const objects = new Map<string, StubObject>();
  const sockets = { opened: 0, closed: 0 };
  const prefix = `/${options.bucket}/`;
  const modeFor = options.mode ?? (() => ({ kind: "normal" }) as const);

  const open = (req: IncomingMessage, res: ServerResponse): { exchange: StubExchange; mode: StubMode } => {
    const path = (req.url ?? "/").split("?")[0]!;
    const exchange: StubExchange = {
      ordinal: exchanges.length,
      method: req.method ?? "",
      key: path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : "",
      headers: { ...req.headers },
      bytesReceived: 0,
      bodyComplete: false,
      responded: null,
      clientClosed: false,
      closed: false,
    };
    exchanges.push(exchange);
    res.on("close", () => {
      exchange.closed = true;
      if (exchange.responded === null || !res.writableFinished) exchange.clientClosed = true;
    });
    return { exchange, mode: modeFor(exchange) };
  };

  const answer = (res: ServerResponse, exchange: StubExchange, status: number, headers: Record<string, string> = {}, body = "") => {
    if (res.destroyed || res.headersSent) return;
    exchange.responded = status;
    res.writeHead(status, headers);
    res.end(body);
  };

  const s3Error = (res: ServerResponse, exchange: StubExchange, status: number, code: string) =>
    answer(
      res,
      exchange,
      status,
      { "content-type": "application/xml" },
      exchange.method === "HEAD"
        ? ""
        : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>stub</Message></Error>`,
    );

  const completeNormally = (req: IncomingMessage, res: ServerResponse, exchange: StubExchange) => {
    if (exchange.method === "PUT") {
      objects.set(exchange.key, {
        size: exchange.bytesReceived,
        contentType: String(req.headers["content-type"] ?? ""),
        contentDisposition: String(req.headers["content-disposition"] ?? ""),
      });
      return answer(res, exchange, 200, { etag: '"stub"' });
    }
    if (exchange.method === "HEAD") {
      const object = objects.get(exchange.key);
      if (!object) return s3Error(res, exchange, 404, "NotFound");
      return answer(res, exchange, 200, {
        "content-length": String(object.size),
        "content-type": object.contentType,
        "content-disposition": object.contentDisposition,
        etag: '"stub"',
      });
    }
    if (exchange.method === "DELETE") {
      objects.delete(exchange.key);
      return answer(res, exchange, 204);
    }
    return s3Error(res, exchange, 405, "MethodNotAllowed");
  };

  const handle = (req: IncomingMessage, res: ServerResponse, exchange: StubExchange, mode: StubMode) => {
    if (mode.kind === "status") {
      req.resume();
      return s3Error(res, exchange, mode.status, mode.code);
    }
    if (mode.kind === "never-continue") return;

    let trickleTimer: ReturnType<typeof setTimeout> | undefined;
    res.on("close", () => clearTimeout(trickleTimer));
    req.on("data", (chunk: Buffer) => {
      exchange.bytesReceived += chunk.length;
      if (mode.kind === "stall-body" && exchange.bytesReceived >= mode.afterBytes) req.pause();
      if (mode.kind === "reset" && exchange.bytesReceived >= mode.afterBytes) req.socket.destroy();
      if (mode.kind === "trickle") {
        req.pause();
        trickleTimer = setTimeout(() => req.resume(), mode.tickMs);
      }
    });
    req.on("end", () => {
      exchange.bodyComplete = true;
      if (mode.kind === "never-respond" || mode.kind === "stall-body" || mode.kind === "trickle") return;
      if (mode.kind === "slow-response") {
        const timer = setTimeout(() => completeNormally(req, res, exchange), mode.delayMs);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      completeNormally(req, res, exchange);
    });
  };

  const server = createServer((req, res) => {
    const { exchange, mode } = open(req, res);
    handle(req, res, exchange, mode);
  });
  // With this listener Node no longer answers `Expect: 100-continue` itself, so
  // a mode can decline to.
  server.on("checkContinue", (req, res) => {
    const { exchange, mode } = open(req, res);
    if (mode.kind === "never-continue") return;
    res.writeContinue();
    handle(req, res, exchange, mode);
  });
  server.on("connection", (socket: Socket) => {
    sockets.opened += 1;
    socket.on("close", () => {
      sockets.closed += 1;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    exchanges,
    objects,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
