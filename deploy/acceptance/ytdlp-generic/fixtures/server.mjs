#!/usr/bin/env node
//
// The Phase-10D controlled acceptance fixture service.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Phase 10D asserts properties of the Worker — the application byte watcher,
// the cancellation window, the safe-egress boundary, the direct regression —
// and every one of those assertions is only as good as the source it ran
// against. A third-party public video makes the important variables somebody
// else's: its byte count, its `Content-Length` semantics, its transfer timing
// and its secondary media destination can all change between the run that
// passed and the run that is being reviewed.
//
// This service makes those variables OURS while still crossing the real
// public-HTTPS and Worker-egress boundaries: it binds loopback, and the
// operator exposes it through a SEPARATE, temporary Cloudflare Quick Tunnel
// (never the named Production tunnel — see `README.md` in this directory).
//
// ── What it is not ─────────────────────────────────────────────────────────
//
// It is test infrastructure. It must never enter the Production Worker service
// graph, never run persistently, and never hold a credential. There is
// deliberately no static-file server, no redirect endpoint, no URL proxy, no
// shell surface and no environment dump: the route set below is closed, and
// every route serves bytes this process already owns.
//
// ── Route set ──────────────────────────────────────────────────────────────
//
//   GET  /healthz                              liveness, no fixture state
//   GET  /direct.mp4                 (+HEAD)   the direct-media control fixture
//   GET  /generic                              generic progressive page
//   GET  /generic-media.mp4          (+HEAD)   its throttled media
//   GET  /byte-limit                           unknown-length page (vf_case)
//   GET  /byte-limit-media.mp4       (+HEAD)   unknown-length media (vf_case)
//   GET  /byte-evidence                        this case's own observations
//   GET  /safe-egress                          fixed private-v4 destination
//
// Anything else is 404. An unsupported method on a known route is 405.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

// ── Frozen fixture contract ────────────────────────────────────────────────

/**
 * Loopback only.
 *
 * The service is reachable publicly ONLY through the operator's temporary Quick
 * Tunnel, which connects outward from this host. Binding `0.0.0.0` would put a
 * >500 MiB streaming endpoint on every interface the host happens to have,
 * which is exactly the exposure §22 exists to prevent.
 */
export const LISTEN_ADDRESS = "127.0.0.1";

/**
 * The acceptance harness's own 128-bit correlation grammar.
 *
 * Kept byte-identical to `CASE_ID_PATTERN` in `../lib/evidence.mjs`, and
 * asserted equal by the test suite. Matching is EXACT: no trimming, no case
 * folding, no coercion. A `vf_case` that does not satisfy this is not a case
 * this fixture has anything to say about, and normalizing one into another
 * would let two different runs share one evidence record.
 */
export const CASE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The safe-egress fixture's secondary media destination — FIXED IN SOURCE.
 *
 * RFC1918 (10.0.0.0/8), so the deployed Phase-9 policy classifies it through
 * `@forbidden_v4` and the denial increments `deny-v4`. A literal address is
 * used rather than a hostname because a name would make the destination depend
 * on whatever the designated resolver answered at run time, and the whole point
 * of this fixture is that the destination is not negotiable.
 *
 * No route reads it from a query parameter, a header, an environment variable
 * or a CLI flag. An operator who wants a different destination has to change
 * this line and get it reviewed.
 */
export const SAFE_EGRESS_MEDIA_URL = "http://10.255.255.1/videofetch-denied.mp4";

/** The fixture family, per `EGRESS_FIXTURE_CLASSES` in `../lib/egress-policy.mjs`. */
export const SAFE_EGRESS_FIXTURE_FAMILY = "private-v4";

/** The deny rule that family is expected to trip, per the same table. */
export const SAFE_EGRESS_EXPECTED_DENY_CLASS = "deny-v4";

/**
 * How many bytes the unknown-length stream will produce if nobody stops it.
 *
 * 528 MiB, against a deployed `MAX_FILE_SIZE` whose default is 500 MiB. The
 * margin is deliberately small: the fixture exists to let the Worker's byte
 * watcher fire, and the normal outcome is that the Worker closes the connection
 * well before this ceiling is reached. A far larger ceiling would only make a
 * runaway transfer more expensive without making the assertion any stronger.
 *
 * This is a CEILING, not an allocation — see `streamUnknownLengthMedia`.
 */
export const BYTE_LIMIT_TOTAL_BYTES = 528 * 1024 * 1024;

/** The single reused block the unknown-length stream is emitted in. */
export const BYTE_LIMIT_BLOCK_BYTES = 64 * 1024;

/**
 * How long `/generic-media.mp4` takes to finish, by design.
 *
 * The cancellation and shutdown cases must observe an owned yt-dlp process
 * while it is still `downloading`, so a fixture that completes in 200 ms leaves
 * them nothing to observe. Throttling changes ONLY transfer timing: every byte
 * of the file is sent, in order, unmodified, and the result is the same valid
 * MP4 with the same digest.
 */
export const GENERIC_THROTTLE_TARGET_MS = 14_000;

/** The throttle's tick period. Total ticks = target / tick. */
export const GENERIC_THROTTLE_TICK_MS = 250;

const MP4_CONTENT_TYPE = "video/mp4";

/**
 * The HTML5 `type` attribute the generic pages declare on their media source.
 *
 * yt-dlp's `_parse_html5_media_entries` runs this through `parse_content_type`,
 * which yields `ext=mp4` plus `vcodec`/`acodec` from the `codecs` parameter —
 * so the extracted format describes a MUXED progressive mp4 rendition rather
 * than one with unknown codecs, and the Worker's `selectCandidates` (which
 * requires a present `vcodec`/`acodec`) can advertise a preset for it.
 *
 * These values are DESCRIPTIVE, not decorative: the generated media really is
 * H.264 baseline video plus AAC-LC audio, so the declaration is accurate. If
 * the media generation recipe ever changes codecs, this must change with it —
 * `prepare-media.mjs` and the test suite both pin the pair together.
 */
const MP4_SOURCE_TYPE = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

// ── Sanitized logging ──────────────────────────────────────────────────────

/**
 * The ONLY facts a fixture log line may carry.
 *
 * Never a full query string, never a header, never a cookie, never an
 * `Authorization` value, never a Cloudflare client-metadata header. `vf_case`
 * is correlation data rather than a credential and is allowed; nothing else
 * from the request line is.
 */
function defaultLog(event) {
  const parts = [`route=${event.route}`, `status=${event.status}`];
  if (event.caseId) parts.push(`case=${event.caseId}`);
  if (Number.isInteger(event.bytes)) parts.push(`bytes=${event.bytes}`);
  if (event.outcome) parts.push(`outcome=${event.outcome}`);
  process.stdout.write(`[fixture] ${parts.join(" ")}\n`);
}

// ── Per-case evidence ──────────────────────────────────────────────────────

/**
 * What the fixture ITSELF observed about one case's media request.
 *
 * Every field is a measurement this process made on its own streaming path.
 * None of it is seeded when the page is fetched, none of it is defaulted, and
 * none of it is derived from what the harness asked for: a record exists only
 * because a media GET for that exact `vf_case` actually arrived.
 */
function createCaseRegistry() {
  /** @type {Map<string, {caseId: string, mediaRequestCount: number, bytesServed: number, contentLengthPresent: boolean, transferMode: string, observedAt: string}>} */
  const cases = new Map();

  return {
    /** Called at the START of an actual media GET, never for HEAD or a page. */
    openMediaRequest(caseId, observedAt) {
      const existing = cases.get(caseId);
      if (existing) {
        // A second GET for the same id is RECORDED, not hidden. The harness
        // requires `mediaRequestCount === 1` and will refuse the evidence —
        // which is the correct outcome, because two transfers cannot be told
        // apart and picking one would be a guess.
        existing.mediaRequestCount += 1;
        return existing;
      }
      const record = {
        caseId,
        mediaRequestCount: 1,
        bytesServed: 0,
        // Stated as a fact about the response this fixture sends: no
        // `Content-Length` header is set on it, and Node therefore frames it
        // with `Transfer-Encoding: chunked`.
        contentLengthPresent: false,
        transferMode: "chunked",
        observedAt,
      };
      cases.set(caseId, record);
      return record;
    },

    /** Bytes the socket actually accepted, accumulated as they flush. */
    recordBytes(record, bytes) {
      record.bytesServed += bytes;
    },

    /** Read-only lookup for the evidence route. `undefined` when unknown. */
    find(caseId) {
      return cases.get(caseId);
    },

    /** Test/operator hook: how many cases are held. Never exposed over HTTP. */
    size() {
      return cases.size;
    },
  };
}

// ── Deterministic throttled writing ────────────────────────────────────────

/**
 * Writes a buffer in equal ticks so the transfer takes about `targetMs`.
 *
 * Content is preserved exactly — this is a scheduler, not a transformer. The
 * chunk boundaries are derived from the byte length and the tick period, so two
 * runs of the same fixture produce the same sequence of writes.
 *
 * Resolves with the number of bytes the socket accepted, which is less than the
 * whole file when the peer went away mid-transfer.
 */
async function writeThrottled(writer, body, { targetMs, tickMs, sleep }) {
  const ticks = Math.max(1, Math.ceil(targetMs / tickMs));
  const chunkBytes = Math.max(1, Math.ceil(body.byteLength / ticks));
  let offset = 0;
  let written = 0;

  while (offset < body.byteLength) {
    if (writer.aborted()) break;
    const end = Math.min(offset + chunkBytes, body.byteLength);
    const chunk = body.subarray(offset, end);
    const flushed = await writer.write(chunk);
    if (!flushed) break;
    written += chunk.byteLength;
    offset = end;
    if (offset < body.byteLength) await sleep(tickMs);
  }
  return written;
}

/**
 * A response writer whose every `write` is awaited to its flush callback.
 *
 * The callback fires when the chunk has been handed to the socket, so counting
 * there means `bytesServed` describes bytes this fixture actually served rather
 * than bytes it queued. A peer that goes away mid-stream settles the in-flight
 * write as NOT written, and that chunk is correctly never counted.
 *
 * ── Why the abort listeners live here and not per chunk ────────────────────
 *
 * The unknown-length stream emits thousands of chunks. Attaching a `close` and
 * an `error` listener inside each write registered thousands of listeners on
 * one `ServerResponse` — observed as Node's `MaxListenersExceededWarning`
 * during fixture verification, and an unbounded retainer on a long transfer.
 * Both listeners are registered ONCE per response here, and the in-flight write
 * is settled through the shared `settle` slot.
 */
function createWriter(res) {
  const state = { aborted: false, settle: null };
  const abort = () => {
    state.aborted = true;
    const settle = state.settle;
    state.settle = null;
    if (settle) settle(false);
  };
  res.once("close", abort);
  res.once("error", abort);

  return {
    aborted: () => state.aborted || res.destroyed || res.writableEnded,
    write(chunk) {
      if (state.aborted || res.destroyed || res.writableEnded) return Promise.resolve(false);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          if (state.settle === finish) state.settle = null;
          resolve(ok);
        };
        state.settle = finish;
        try {
          res.write(chunk, (error) => finish(!error));
        } catch {
          finish(false);
        }
      });
    },
  };
}

/**
 * The unknown-length stream, in bounded memory.
 *
 * ── Why no `Content-Length` ────────────────────────────────────────────────
 *
 * The pinned `HttpFD.real_download` consults `--max-filesize` only inside
 * `if data_len is not None`. A declared length would therefore let yt-dlp's own
 * option stop the transfer, and the case would be evidence for the wrong gate.
 * Omitting the header makes Node frame the response `chunked`, the length
 * genuinely unknown to the client, and the APPLICATION byte watcher the only
 * thing that can stop it.
 *
 * ── Why the first bytes are the real MP4 ───────────────────────────────────
 *
 * So the response is a plausible progressive mp4 from its first byte rather
 * than an obvious wall of filler. The remainder is one 64 KiB block written
 * repeatedly: at no point does this hold more than that block plus Node's own
 * socket buffer, so a 528 MiB ceiling costs kilobytes of memory.
 */
async function streamUnknownLengthMedia(writer, { prefix, totalBytes, blockBytes, onBytes }) {
  const block = Buffer.alloc(Math.min(blockBytes, Math.max(1, totalBytes)), 0x00);
  // A repeating, deterministic, non-uniform pattern: still trivially
  // compressible, but not a single constant byte.
  for (let i = 0; i < block.byteLength; i += 1) block[i] = i % 251;

  let remaining = totalBytes;

  if (prefix.byteLength > 0 && remaining > 0) {
    const head = prefix.subarray(0, Math.min(prefix.byteLength, remaining));
    const flushed = await writer.write(head);
    if (!flushed) return;
    onBytes(head.byteLength);
    remaining -= head.byteLength;
  }

  while (remaining > 0) {
    if (writer.aborted()) return;
    const chunk = remaining >= block.byteLength ? block : block.subarray(0, remaining);
    const flushed = await writer.write(chunk);
    if (!flushed) return;
    onBytes(chunk.byteLength);
    remaining -= chunk.byteLength;
  }
}

// ── Pages ──────────────────────────────────────────────────────────────────

/**
 * A single-item HTML5 page the pinned generic extractor resolves to ONE
 * progressive muxed mp4 rendition.
 *
 * The media reference is RELATIVE. That is a privacy property, not a
 * convenience: a page that reflected the request's `Host` (or any other request
 * header, or the submitted query string) into an absolute media URL would make
 * the fixture's media destination a function of untrusted input — and the
 * generic success case submits its page URL carrying the harness's sentinel,
 * which must never travel onward into a media request.
 *
 * Exactly one `<video>` with exactly one `<source>`: no second rendition, no
 * playlist markup, no HLS or DASH manifest reference, nothing that would make
 * the extractor return more than a single item.
 */
function renderMediaPage({ title, mediaUrl }) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    '<video controls preload="none">',
    `<source src="${mediaUrl}" type='${MP4_SOURCE_TYPE}'>`,
    "</video>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// ── Responses ──────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  const payload = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendText(res, status, text) {
  const payload = Buffer.from(`${text}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(payload.byteLength),
    "cache-control": "no-store",
  });
  res.end(payload);
}

// ── The service ────────────────────────────────────────────────────────────

/**
 * Builds the fixture service around one already-read media buffer.
 *
 * The media is read ONCE, by the caller, from a path the operator named on the
 * command line. No request can influence which bytes are served: there is no
 * path-to-file mapping anywhere in this module, so path traversal has nothing
 * to traverse and an arbitrary-file read has no reachable call site.
 *
 * @param {object} options
 * @param {Buffer} options.media           the direct/generic fixture MP4
 * @param {string} options.mediaPath       where it was read from (manifest only)
 * @param {(event: object) => void} [options.log]
 * @param {number} [options.genericThrottleMs]
 * @param {number} [options.genericThrottleTickMs]
 * @param {number} [options.byteLimitTotalBytes]
 * @param {number} [options.byteLimitBlockBytes]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => Date} [options.now]
 */
export function createFixtureService(options) {
  const {
    media,
    mediaPath = null,
    log = defaultLog,
    genericThrottleMs = GENERIC_THROTTLE_TARGET_MS,
    genericThrottleTickMs = GENERIC_THROTTLE_TICK_MS,
    byteLimitTotalBytes = BYTE_LIMIT_TOTAL_BYTES,
    byteLimitBlockBytes = BYTE_LIMIT_BLOCK_BYTES,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => new Date(),
  } = options;

  if (!Buffer.isBuffer(media) || media.byteLength === 0) {
    throw new Error("the fixture media must be a non-empty Buffer");
  }

  const mediaDigest = createHash("sha256").update(media).digest("hex");
  const registry = createCaseRegistry();

  /**
   * The `vf_case` on a request, or `null`.
   *
   * Fail-closed and EXACT: the parameter must be present exactly once and match
   * the harness grammar verbatim. A repeated parameter is ambiguous rather than
   * "the first one", and no other query parameter is permitted on a byte-limit
   * route — §12 forbids a second arbitrary parameter, and accepting one would
   * give an operator a second channel into a route whose whole value is that it
   * has exactly one input.
   */
  function readCaseId(url) {
    const values = url.searchParams.getAll("vf_case");
    if (values.length !== 1) return null;
    const candidate = values[0];
    if (!CASE_ID_PATTERN.test(candidate)) return null;
    for (const key of url.searchParams.keys()) {
      if (key !== "vf_case") return null;
    }
    return candidate;
  }

  /** Serves the fixed media buffer with an exact length. Also answers HEAD. */
  function serveMediaHead(res, status = 200) {
    res.writeHead(status, {
      "content-type": MP4_CONTENT_TYPE,
      "content-length": String(media.byteLength),
      "accept-ranges": "none",
      "cache-control": "no-store",
    });
    res.end();
  }

  const handler = async (req, res) => {
    // `req.url` is a request target, never a filesystem path. It is parsed only
    // to read `pathname` for an EXACT match against the closed table below and
    // to read the one permitted query parameter.
    let url;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      log({ route: "<unparsable>", status: 400 });
      sendText(res, 400, "bad request");
      return;
    }
    const route = url.pathname;
    const method = req.method ?? "GET";

    switch (route) {
      // ── liveness ────────────────────────────────────────────────────────
      case "/healthz": {
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, route, "GET, HEAD");
        log({ route, status: 200 });
        if (method === "HEAD") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end();
          return;
        }
        sendJson(res, 200, { ok: true, service: "videofetch-acceptance-fixture" });
        return;
      }

      // ── the direct-media control fixture ────────────────────────────────
      //
      // The Worker's direct analyzer issues a HEAD and reads `Content-Type` and
      // `Content-Length` from it, so HEAD is genuinely required here — it is
      // not a convenience.
      case "/direct.mp4": {
        if (method === "HEAD") {
          log({ route, status: 200, outcome: "head" });
          serveMediaHead(res);
          return;
        }
        if (method !== "GET") return methodNotAllowed(res, route, "GET, HEAD");
        res.writeHead(200, {
          "content-type": MP4_CONTENT_TYPE,
          "content-length": String(media.byteLength),
          "accept-ranges": "none",
          "cache-control": "no-store",
        });
        res.end(media);
        log({ route, status: 200, bytes: media.byteLength });
        return;
      }

      // ── the generic progressive page ────────────────────────────────────
      //
      // Unknown query parameters are IGNORED rather than refused: the generic
      // success case submits this URL carrying the harness's inert `vf_accept`
      // sentinel, and refusing it would break the case that proves the sentinel
      // never resurfaces. Ignoring is safe precisely because nothing from the
      // query reaches the rendered page.
      case "/generic": {
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, route, "GET, HEAD");
        const html = renderMediaPage({
          title: "VideoFetch acceptance — generic progressive fixture",
          mediaUrl: "/generic-media.mp4",
        });
        log({ route, status: 200 });
        if (method === "HEAD") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(Buffer.byteLength(html, "utf8")),
          });
          res.end();
          return;
        }
        sendHtml(res, 200, html);
        return;
      }

      // ── its throttled media ─────────────────────────────────────────────
      case "/generic-media.mp4": {
        if (method === "HEAD") {
          log({ route, status: 200, outcome: "head" });
          serveMediaHead(res);
          return;
        }
        if (method !== "GET") return methodNotAllowed(res, route, "GET, HEAD");
        res.writeHead(200, {
          "content-type": MP4_CONTENT_TYPE,
          "content-length": String(media.byteLength),
          "accept-ranges": "none",
          "cache-control": "no-store",
        });
        const sent = await writeThrottled(createWriter(res), media, {
          targetMs: genericThrottleMs,
          tickMs: genericThrottleTickMs,
          sleep,
        });
        if (!res.writableEnded) res.end();
        log({
          route,
          status: 200,
          bytes: sent,
          outcome: sent === media.byteLength ? "complete" : "peer-closed",
        });
        return;
      }

      // ── the unknown-length page ─────────────────────────────────────────
      case "/byte-limit": {
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, route, "GET, HEAD");
        const caseId = readCaseId(url);
        if (!caseId) {
          log({ route, status: 400, outcome: "bad-case" });
          sendText(res, 400, "vf_case must be exactly one 32-character lowercase hex id");
          return;
        }
        // The case id is carried through VERBATIM. It is not re-minted, not
        // re-encoded and not normalized: the media URL on this page must name
        // the same id the harness submitted, or the evidence would belong to a
        // case nobody asked about.
        const html = renderMediaPage({
          title: "VideoFetch acceptance — unknown-length byte-limit fixture",
          mediaUrl: `/byte-limit-media.mp4?vf_case=${caseId}`,
        });
        log({ route, status: 200, caseId });
        if (method === "HEAD") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(Buffer.byteLength(html, "utf8")),
          });
          res.end();
          return;
        }
        sendHtml(res, 200, html);
        return;
      }

      // ── the unknown-length media ────────────────────────────────────────
      case "/byte-limit-media.mp4": {
        const caseId = readCaseId(url);
        if (!caseId) {
          log({ route, status: 400, outcome: "bad-case" });
          sendText(res, 400, "vf_case must be exactly one 32-character lowercase hex id");
          return;
        }
        // §19: a HEAD is not the transfer under test. It answers the shape of
        // the response — no `Content-Length` — and touches NO case state: it
        // does not open a case, does not increment `mediaRequestCount` and does
        // not add to `bytesServed`. yt-dlp probing must not be able to consume
        // the one media request the harness will accept.
        if (method === "HEAD") {
          log({ route, status: 200, caseId, outcome: "head" });
          res.writeHead(200, {
            "content-type": MP4_CONTENT_TYPE,
            "accept-ranges": "none",
            "cache-control": "no-store",
          });
          res.end();
          return;
        }
        if (method !== "GET") return methodNotAllowed(res, route, "GET, HEAD");

        const record = registry.openMediaRequest(caseId, now().toISOString());
        // No `content-length`. Node frames an HTTP/1.1 response without one as
        // `Transfer-Encoding: chunked`, which is what `transferMode` reports.
        res.writeHead(200, {
          "content-type": MP4_CONTENT_TYPE,
          "accept-ranges": "none",
          "cache-control": "no-store",
        });
        await streamUnknownLengthMedia(createWriter(res), {
          prefix: media,
          totalBytes: byteLimitTotalBytes,
          blockBytes: byteLimitBlockBytes,
          onBytes: (n) => registry.recordBytes(record, n),
        });
        if (!res.writableEnded) res.end();
        log({
          route,
          status: 200,
          caseId,
          bytes: record.bytesServed,
          outcome: record.bytesServed >= byteLimitTotalBytes ? "ceiling" : "peer-closed",
        });
        return;
      }

      // ── this case's own observations ────────────────────────────────────
      //
      // Read-only, GET-only, one case at a time. There is deliberately no
      // listing, no `/all`, no `/debug` and no `/state`: a caller may ask about
      // one exact id it already knows, and learns nothing else.
      case "/byte-evidence": {
        if (method !== "GET") return methodNotAllowed(res, route, "GET");
        const caseId = readCaseId(url);
        if (!caseId) {
          log({ route, status: 400, outcome: "bad-case" });
          sendText(res, 400, "vf_case must be exactly one 32-character lowercase hex id");
          return;
        }
        const record = registry.find(caseId);
        if (!record) {
          // §15/the harness contract: an unknown case is 404, never a default.
          // A default would let a run that served nothing look like a run that
          // served something.
          log({ route, status: 404, caseId });
          sendJson(res, 404, { caseId, actualMediaRequestObserved: false });
          return;
        }
        log({ route, status: 200, caseId, bytes: record.bytesServed });
        // Only the fixture's own measurements. No URL, no request header, no
        // client address, no user agent, no Cloudflare metadata.
        sendJson(res, 200, {
          caseId: record.caseId,
          actualMediaRequestObserved: true,
          mediaRequestCount: record.mediaRequestCount,
          contentLengthPresent: record.contentLengthPresent,
          transferMode: record.transferMode,
          bytesServed: record.bytesServed,
          observedAt: record.observedAt,
        });
        return;
      }

      // ── the safe-egress page ────────────────────────────────────────────
      //
      // Public HTTPS through the Quick Tunnel, generic-extractor compatible,
      // single item — and its media destination is the module constant. No
      // request input reaches it.
      case "/safe-egress": {
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, route, "GET, HEAD");
        const html = renderMediaPage({
          title: "VideoFetch acceptance — safe-egress fixture",
          mediaUrl: SAFE_EGRESS_MEDIA_URL,
        });
        log({ route, status: 200 });
        if (method === "HEAD") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": String(Buffer.byteLength(html, "utf8")),
          });
          res.end();
          return;
        }
        sendHtml(res, 200, html);
        return;
      }

      default: {
        // The closed table above is the whole service. Anything else — a
        // traversal attempt, a favicon probe, a guessed path — is 404 with no
        // echo of what was asked for.
        log({ route: "<unknown>", status: 404 });
        sendText(res, 404, "not found");
        return;
      }
    }
  };

  function methodNotAllowed(res, route, allow) {
    log({ route, status: 405 });
    const payload = Buffer.from("method not allowed\n", "utf8");
    res.writeHead(405, {
      allow,
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(payload.byteLength),
    });
    res.end(payload);
  }

  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      // A handler fault must not leave a hung socket. Nothing about the fault
      // is echoed to the client or the log beyond the status.
      if (!res.headersSent) {
        try {
          sendText(res, 500, "fixture error");
          return;
        } catch {
          /* fall through to destroy */
        }
      }
      res.destroy();
    });
  });

  return {
    server,

    /** Binds loopback. `port` 0 asks the OS for an ephemeral port. */
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, LISTEN_ADDRESS, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      return server.address();
    },

    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },

    /**
     * The sanitized startup manifest (§23).
     *
     * Route paths, byte counts, the media digest and the frozen egress
     * expectation. No credential, no environment, and no filesystem path other
     * than the media file the operator explicitly supplied.
     */
    manifest() {
      const address = server.address();
      return {
        listenAddress: LISTEN_ADDRESS,
        listenPort: address && typeof address === "object" ? address.port : null,
        directPath: "/direct.mp4",
        directBytes: media.byteLength,
        directSha256: mediaDigest,
        mediaPath,
        genericPath: "/generic",
        genericMediaPath: "/generic-media.mp4",
        genericMediaThrottleMs: genericThrottleMs,
        byteLimitPath: "/byte-limit",
        byteLimitMediaPath: "/byte-limit-media.mp4",
        byteLimitMaxBytes: byteLimitTotalBytes,
        byteEvidencePath: "/byte-evidence",
        safeEgressPath: "/safe-egress",
        safeEgressMediaUrl: SAFE_EGRESS_MEDIA_URL,
        safeEgressFixtureFamily: SAFE_EGRESS_FIXTURE_FAMILY,
        safeEgressExpectedDenyClass: SAFE_EGRESS_EXPECTED_DENY_CLASS,
        healthPath: "/healthz",
      };
    },

    /** Test-only visibility into the case registry. Never served over HTTP. */
    caseCount() {
      return registry.size();
    },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = {
    media: null,
    port: 0,
    genericThrottleMs: GENERIC_THROTTLE_TARGET_MS,
    byteLimitTotalBytes: BYTE_LIMIT_TOTAL_BYTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--media":
        out.media = next();
        break;
      case "--port":
        out.port = Number.parseInt(next(), 10);
        break;
      case "--generic-throttle-ms":
        out.genericThrottleMs = Number.parseInt(next(), 10);
        break;
      case "--byte-limit-bytes":
        out.byteLimitTotalBytes = Number.parseInt(next(), 10);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.media) throw new Error("--media <path to the fixture mp4> is required");
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
    throw new Error("--port must be 0-65535");
  }
  return out;
}

/** The CLI entry point. Prints the manifest as one JSON line on stdout. */
export async function main(argv) {
  const opts = parseArgv(argv);
  const media = await readFile(opts.media);
  const service = createFixtureService({
    media,
    mediaPath: opts.media,
    genericThrottleMs: opts.genericThrottleMs,
    byteLimitTotalBytes: opts.byteLimitTotalBytes,
  });
  await service.listen(opts.port);
  process.stdout.write(`${JSON.stringify(service.manifest())}\n`);

  const stop = () => {
    service.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return service;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[fixture] ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
