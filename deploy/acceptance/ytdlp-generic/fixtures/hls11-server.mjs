// HLS-11's closed-route loopback fixture service.
//
// Every route it can answer is in one table built by the orchestrator before
// the service starts; any other path is a 404 and is still ledgered. Each
// request is recorded with the case it belongs to, the phase the orchestrator
// declared, its kind, its ordinal, the status and byte count served, and
// whether it carried the Product's fixed request profile — never a URL, a
// query value or a header value.

import { createServer } from "node:http";
import {
  HLS11_FIXTURE_HOSTNAME,
  HLS11_FIXTURE_LOOPBACK,
  classifyHls11FixturePath,
} from "../lib/hls11-fixture-url.mjs";
import { PRODUCT_ACCEPT, PRODUCT_USER_AGENT } from "../lib/hls-safe-http-transport.mjs";

export const HLS11_CONTENT_TYPES = Object.freeze({
  page: "text/html; charset=utf-8",
  master: "application/vnd.apple.mpegurl",
  media: "application/vnd.apple.mpegurl",
  init: "video/mp4",
  fragment: "application/octet-stream",
});

/**
 * @param {object} opts
 * @param {Map<string, {kind: string, body: Buffer}>} opts.routes  exact path (with query) -> body
 * @param {{next(): number}} opts.eventClock  shared with the acceptance transport
 */
export function createHls11FixtureService({ routes, eventClock }) {
  if (!(routes instanceof Map)) throw new Error("the HLS-11 route table is required");
  if (!eventClock || typeof eventClock.next !== "function") throw new Error("the event clock is required");

  const ledger = [];
  const failing = new Map();
  let phase = "setup";
  let port = null;

  const server = createServer((req, res) => {
    const path = req.url ?? "";
    const route = classifyHls11FixturePath(path);
    const headers = req.headers;
    const ua = headers["user-agent"];
    const entry = {
      arriveSeq: eventClock.next(),
      finishSeq: null,
      phase,
      method: req.method ?? null,
      kind: route.kind,
      caseName: route.caseName,
      ordinal: route.ordinal,
      status: null,
      bytes: 0,
      hostHeaderIsFixture: headers.host === `${HLS11_FIXTURE_HOSTNAME}:${port}`,
      userAgentClass: ua === PRODUCT_USER_AGENT ? "product" : typeof ua === "string" ? "other" : "absent",
      acceptIsProduct: headers.accept === PRODUCT_ACCEPT,
      hasCookie: headers.cookie !== undefined,
      hasAuthorization: headers.authorization !== undefined,
      hasReferer: headers.referer !== undefined,
      hasRange: headers.range !== undefined,
    };
    ledger.push(entry);
    res.on("finish", () => {
      if (entry.finishSeq === null) entry.finishSeq = eventClock.next();
    });

    const send = (status, type, body) => {
      entry.status = status;
      entry.bytes = body ? body.byteLength : 0;
      const head = { "cache-control": "no-store", "content-length": String(entry.bytes) };
      if (type) head["content-type"] = type;
      res.writeHead(status, head);
      res.end(body ?? undefined);
    };

    if (req.method !== "GET") return send(405, null, null);
    if (failing.has(path)) return send(failing.get(path), null, null);
    const served = routes.get(path);
    if (served === undefined || served.kind !== route.kind) return send(404, null, null);
    return send(200, HLS11_CONTENT_TYPES[served.kind] ?? null, served.body);
  });

  return {
    async listen() {
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, HLS11_FIXTURE_LOOPBACK, () => {
          server.off("error", reject);
          resolvePromise();
        });
      });
      const address = server.address();
      port = address.port;
      return { address: address.address, port };
    },
    listenAddress() {
      const address = server.address();
      return address && typeof address === "object" ? address.address : null;
    },
    /** Answer `status` for one exact route (a negative case), instead of its body. */
    fail(path, status) {
      failing.set(path, status);
    },
    setPhase(next) {
      phase = String(next);
    },
    requests(filter = null) {
      const all = ledger.map((e) => ({ ...e }));
      return filter === null ? all : all.filter((e) => e.phase === filter);
    },
    close() {
      return new Promise((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      });
    },
  };
}
