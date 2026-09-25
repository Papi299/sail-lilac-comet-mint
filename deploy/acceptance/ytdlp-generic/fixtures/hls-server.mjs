// HLS-08's loopback fixture service.
//
// One small HTTP server bound to 127.0.0.1 inside the `--network none`
// acceptance container, answering the closed route table from
// `lib/hls-fixture-url.mjs` and nothing else:
//
//   page      the HTML page the job submits
//   master    ONE variant, pointing at whichever media playlist the harness
//             has currently selected — the rotation that proves execution
//             reads a FRESH playlist location rather than the browser's
//   media     one media playlist per private-by-contract marker
//   fragment  the FFmpeg-authored MPEG-TS segments (and their failure-family
//             twins, one of which answers non-200)
//
// Every request is recorded in a sanitized ledger — route KIND, variant LABEL,
// fragment ordinal, method, status, header booleans, and sequence numbers from
// the event clock the acceptance transport shares — never a URL, a marker or a
// header value. Arrival and response-finish events make per-fragment
// non-overlap measurable at the server as well as at the client.
//
// Only GET is served. Anything else, and any route outside the table, is
// answered 405/404 and recorded, so "no unexpected route was requested" is a
// ledger fact.

import { createServer } from "node:http";
import {
  HLS_FIXTURE_HOSTNAME,
  HLS_FIXTURE_LOOPBACK,
  classifyHlsFixturePath,
} from "../lib/hls-fixture-url.mjs";
import { PRODUCT_ACCEPT, PRODUCT_USER_AGENT } from "../lib/hls-safe-http-transport.mjs";

const CONTENT_TYPE = Object.freeze({
  page: "text/html; charset=utf-8",
  master: "application/vnd.apple.mpegurl",
  media: "application/vnd.apple.mpegurl",
  fragment: "video/mp2t",
});

/**
 * @param {object} opts
 * @param {Buffer} opts.page
 * @param {(variant: string) => Buffer} opts.masterFor   the master naming one variant
 * @param {Record<string, Buffer>} opts.mediaPlaylists   variant label -> playlist
 * @param {Record<string, Buffer>} opts.fragments        "<family>:<ordinal>" -> bytes
 * @param {Record<string, number>} [opts.failingFragments] "<family>:<ordinal>" -> status
 * @param {{next(): number}} opts.eventClock
 * @param {string} opts.initialMasterVariant
 */
export function createHlsFixtureService({
  page,
  masterFor,
  mediaPlaylists,
  fragments,
  failingFragments = {},
  eventClock,
  initialMasterVariant,
}) {
  if (!Buffer.isBuffer(page)) throw new Error("the fixture page is required");
  if (typeof masterFor !== "function") throw new Error("the master builder is required");
  if (!eventClock || typeof eventClock.next !== "function") throw new Error("the event clock is required");
  if (!Object.hasOwn(mediaPlaylists, initialMasterVariant)) throw new Error("unknown initial master variant");

  const ledger = [];
  let masterVariant = initialMasterVariant;
  let phase = "setup";
  let port = null;

  const server = createServer((req, res) => {
    const route = classifyHlsFixturePath(req.url ?? "");
    const headers = req.headers;
    const ua = headers["user-agent"];
    const entry = {
      arriveSeq: eventClock.next(),
      finishSeq: null,
      closeSeq: null,
      phase,
      method: req.method ?? null,
      kind: route.kind,
      variant: route.variant,
      family: route.family,
      ordinal: route.ordinal,
      masterServedVariant: null,
      status: null,
      bytes: 0,
      hostHeaderIsFixture: headers.host === `${HLS_FIXTURE_HOSTNAME}:${port}`,
      userAgentClass: ua === PRODUCT_USER_AGENT ? "product" : typeof ua === "string" ? "other" : "absent",
      acceptIsProduct: headers.accept === PRODUCT_ACCEPT,
      hasCookie: headers.cookie !== undefined,
      hasAuthorization: headers.authorization !== undefined,
      hasReferer: headers.referer !== undefined,
      hasProxyAuthorization: headers["proxy-authorization"] !== undefined,
    };
    ledger.push(entry);
    res.on("finish", () => {
      if (entry.finishSeq === null) entry.finishSeq = eventClock.next();
    });
    res.on("close", () => {
      if (entry.closeSeq === null) entry.closeSeq = eventClock.next();
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
    switch (route.kind) {
      case "page":
        return send(200, CONTENT_TYPE.page, page);
      case "master":
        entry.masterServedVariant = masterVariant;
        return send(200, CONTENT_TYPE.master, masterFor(masterVariant));
      case "media": {
        const body = mediaPlaylists[route.variant];
        return body ? send(200, CONTENT_TYPE.media, body) : send(404, null, null);
      }
      case "fragment": {
        const key = `${route.family}:${route.ordinal}`;
        if (Object.hasOwn(failingFragments, key)) return send(failingFragments[key], null, null);
        const body = fragments[key];
        return body ? send(200, CONTENT_TYPE.fragment, body) : send(404, null, null);
      }
      default:
        return send(404, null, null);
    }
  });

  return {
    async listen() {
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, HLS_FIXTURE_LOOPBACK, () => {
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
    setMasterVariant(variant) {
      if (!Object.hasOwn(mediaPlaylists, variant)) throw new Error("unknown master variant");
      masterVariant = variant;
    },
    masterVariant() {
      return masterVariant;
    },
    setPhase(next) {
      phase = next;
    },
    requests() {
      return ledger.map((e) => ({ ...e }));
    },
    close() {
      return new Promise((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      });
    },
  };
}
