// HLS-12's closed-route loopback fixture service.
//
// Every route it can answer is in one table built by the orchestrator before
// the service starts; any other path is a 404 and is still ledgered. Each
// request is recorded with the case and rendition role it belongs to, the
// phase the orchestrator declared, its kind, its ordinal, the status and byte
// count served, and whether it carried the Product's fixed request profile —
// never a URL, a query value or a header value.
//
// One thing HLS-11's service does not need: a route may answer the PRODUCT
// differently from the pinned yt-dlp. The two master negatives that model a
// dynamic origin use it — one answers the Product's own master proof with a
// redirect, the other with a re-signed master — while yt-dlp keeps receiving
// the ordinary master. The Product is recognised by its fixed request profile
// (`VideoFetch/1.0`), which the transport independently verifies.

import { createServer } from "node:http";
import {
  HLS12_FIXTURE_HOSTNAME,
  HLS12_FIXTURE_LOOPBACK,
  classifyHls12FixturePath,
} from "../lib/hls12-fixture-url.mjs";
import { PRODUCT_ACCEPT, PRODUCT_USER_AGENT } from "../lib/hls-safe-http-transport.mjs";

export const HLS12_CONTENT_TYPES = Object.freeze({
  page: "text/html; charset=utf-8",
  master: "application/vnd.apple.mpegurl",
  "master-moved": "application/vnd.apple.mpegurl",
  media: "application/vnd.apple.mpegurl",
  init: "video/mp4",
  fragment: "application/octet-stream",
});

/**
 * @param {object} opts
 * @param {Map<string, {kind: string, body: Buffer, product?: {status: 200, body: Buffer} | {status: 302, location: string}}>} opts.routes
 *        exact path (with query) -> what it serves
 * @param {{next(): number}} opts.eventClock  shared with the acceptance transport
 */
export function createHls12FixtureService({ routes, eventClock }) {
  if (!(routes instanceof Map)) throw new Error("the HLS-12 route table is required");
  if (!eventClock || typeof eventClock.next !== "function") throw new Error("the event clock is required");
  for (const served of routes.values()) {
    const product = served.product;
    if (product === undefined) continue;
    const valid =
      (product.status === 200 && Buffer.isBuffer(product.body)) ||
      (product.status === 302 && typeof product.location === "string" && product.location.startsWith("/"));
    if (!valid) throw new Error("a Product-only answer must be a 200 body or a root-relative 302");
  }

  const ledger = [];
  const failing = new Map();
  let phase = "setup";
  let port = null;

  const server = createServer((req, res) => {
    const path = req.url ?? "";
    const route = classifyHls12FixturePath(path);
    const headers = req.headers;
    const ua = headers["user-agent"];
    const isProduct = ua === PRODUCT_USER_AGENT;
    const entry = {
      arriveSeq: eventClock.next(),
      finishSeq: null,
      phase,
      method: req.method ?? null,
      kind: route.kind,
      caseName: route.caseName,
      role: route.role,
      ordinal: route.ordinal,
      status: null,
      bytes: 0,
      productAnswer: false,
      hostHeaderIsFixture: headers.host === `${HLS12_FIXTURE_HOSTNAME}:${port}`,
      userAgentClass: isProduct ? "product" : typeof ua === "string" ? "other" : "absent",
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

    const send = (status, type, body, extra = {}) => {
      entry.status = status;
      entry.bytes = body ? body.byteLength : 0;
      const head = { "cache-control": "no-store", "content-length": String(entry.bytes), ...extra };
      if (type) head["content-type"] = type;
      res.writeHead(status, head);
      res.end(body ?? undefined);
    };

    if (req.method !== "GET") return send(405, null, null);
    if (failing.has(path)) return send(failing.get(path), null, null);
    const served = routes.get(path);
    if (served === undefined || served.kind !== route.kind) return send(404, null, null);
    if (isProduct && served.product !== undefined) {
      entry.productAnswer = true;
      if (served.product.status === 302) return send(302, null, null, { location: served.product.location });
      return send(200, HLS12_CONTENT_TYPES[served.kind] ?? null, served.product.body);
    }
    return send(200, HLS12_CONTENT_TYPES[served.kind] ?? null, served.body);
  });

  return {
    async listen() {
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, HLS12_FIXTURE_LOOPBACK, () => {
          server.off("error", reject);
          resolvePromise();
        });
      });
      const address = server.address();
      port = address.port;
      return { address: address.address, port };
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
