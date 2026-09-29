// DASH-01's loopback fixture service.
//
// One small HTTP server bound to 127.0.0.1 inside the `--network none`
// acceptance container, answering exactly the closed route table built by
// `dash-media.mjs` (`dashRouteTable`) and nothing else. There is no path to
// file mapping anywhere: every body was generated before the service started.
//
// Every request is recorded in a sanitized ledger — route KIND (`manifest`,
// `init`, `segment`, `progressive`, `unknown`), rendition ROLE, segment
// ORDINAL, method, status, declared length, bytes actually written, and
// whether the response FINISHED or the client went away first. Never a path,
// a header, a query or a client address.
//
// Three behaviours exist, each set by the orchestrator per phase:
//
//   pace     every media segment is written in two halves with a short pause
//            between them, so the pinned runtime's in-flight fragment file is
//            observable on disk. Timing only: the bytes are unchanged.
//   hold     ONE route writes all but its last `tailBytes`, then waits
//            `holdMs` before finishing. The fragment-aware byte guard must
//            stop the run during that hold; a guard that counted only the
//            aggregate would not see the fragment until it completed.
//   failing  ONE route answers a non-200 status with no body — a fragment the
//            origin cannot serve.
//
// Only GET is served. Anything else, and any route outside the table, is
// answered 405/404 and recorded, so "no unexpected route was requested" is a
// ledger fact.

import { createServer } from "node:http";
import { classifyDashRoute } from "./dash-media.mjs";

export const DASH_FIXTURE_LISTEN_ADDRESS = "127.0.0.1";

/**
 * @param {object} opts
 * @param {Map<string, {body: Buffer, contentType: string}>} opts.table
 * @param {{video: number, audio: number}} opts.segmentCounts
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
export function createDashFixtureService({ table, segmentCounts, sleep = defaultSleep }) {
  if (!(table instanceof Map) || table.size === 0) throw new Error("the DASH route table is required");
  for (const [route, entry] of table) {
    if (!route.startsWith("/") || !Buffer.isBuffer(entry?.body) || entry.body.byteLength === 0) {
      throw new Error("every DASH route needs a non-empty body");
    }
    if (classifyDashRoute(route, { segmentCounts }).kind === "unknown") {
      throw new Error("a DASH route outside the closed grammar was supplied");
    }
  }

  const ledger = [];
  let phase = "setup";
  let behavior = { pace: null, hold: null, failing: null };
  const sockets = new Set();

  const server = createServer(async (req, res) => {
    const path = req.url ?? "";
    const route = classifyDashRoute(path, { segmentCounts });
    const entry = {
      phase,
      method: req.method ?? null,
      kind: route.kind,
      role: route.role,
      ordinal: route.ordinal,
      status: null,
      declaredLength: null,
      bytesWritten: 0,
      finished: false,
      clientClosedEarly: false,
      held: false,
    };
    ledger.push(entry);
    res.on("finish", () => {
      entry.finished = true;
    });
    res.on("close", () => {
      if (!entry.finished) entry.clientClosedEarly = true;
    });

    const served = route.kind === "unknown" ? null : table.get(path);
    if (req.method !== "GET") {
      entry.status = 405;
      res.writeHead(405, { "content-length": "0", connection: "close" });
      res.end();
      return;
    }
    if (served === null || served === undefined) {
      entry.status = 404;
      res.writeHead(404, { "content-length": "0", connection: "close" });
      res.end();
      return;
    }
    if (behavior.failing && behavior.failing.route === path) {
      entry.status = behavior.failing.status;
      res.writeHead(behavior.failing.status, { "content-length": "0", connection: "close" });
      res.end();
      return;
    }

    const body = served.body;
    entry.status = 200;
    entry.declaredLength = body.byteLength;
    res.writeHead(200, {
      "content-type": served.contentType,
      "content-length": String(body.byteLength),
      "accept-ranges": "none",
      "cache-control": "no-store",
      connection: "close",
    });

    const write = (chunk) => {
      if (res.destroyed || res.writableEnded) return false;
      res.write(chunk);
      entry.bytesWritten += chunk.byteLength;
      return true;
    };

    if (behavior.hold && behavior.hold.route === path) {
      entry.held = true;
      const cut = Math.max(0, body.byteLength - behavior.hold.tailBytes);
      write(body.subarray(0, cut));
      await sleep(behavior.hold.holdMs);
      if (!write(body.subarray(cut))) return;
      res.end();
      return;
    }
    if (behavior.pace && route.kind === "segment") {
      const half = Math.floor(body.byteLength / 2);
      write(body.subarray(0, half));
      await sleep(behavior.pace.pauseMs);
      if (!write(body.subarray(half))) return;
      res.end();
      return;
    }
    write(body);
    res.end();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    async listen() {
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, DASH_FIXTURE_LISTEN_ADDRESS, () => resolvePromise());
      });
      const address = server.address();
      return { address: address.address, port: address.port };
    },
    setPhase(next) {
      phase = String(next);
    },
    /** Replaces the whole behaviour; an omitted key is off. */
    setBehavior(next = {}) {
      const pace = next.pace ?? null;
      const hold = next.hold ?? null;
      const failing = next.failing ?? null;
      if (pace !== null && !(Number.isSafeInteger(pace.pauseMs) && pace.pauseMs > 0 && pace.pauseMs <= 1000)) {
        throw new Error("pace.pauseMs must be a small positive integer");
      }
      if (hold !== null) {
        if (!table.has(hold.route)) throw new Error("hold names an unknown route");
        if (!(Number.isSafeInteger(hold.tailBytes) && hold.tailBytes > 0)) throw new Error("hold.tailBytes must be positive");
        if (!(Number.isSafeInteger(hold.holdMs) && hold.holdMs > 0 && hold.holdMs <= 60_000)) {
          throw new Error("hold.holdMs must be a bounded positive integer");
        }
      }
      if (failing !== null) {
        if (!table.has(failing.route)) throw new Error("failing names an unknown route");
        if (!(Number.isSafeInteger(failing.status) && failing.status >= 400 && failing.status <= 599)) {
          throw new Error("failing.status must be an HTTP error status");
        }
      }
      behavior = { pace, hold, failing };
    },
    /** A copy of the ledger, optionally for one phase only. */
    requests(forPhase) {
      return ledger.filter((entry) => forPhase === undefined || entry.phase === forPhase).map((entry) => ({ ...entry }));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

function defaultSleep(ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}
