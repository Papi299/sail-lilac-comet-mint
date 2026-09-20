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
// SPLIT-06 adds an OPTIONAL second fixture set, configured independently of
// the Phase-10D one and serving a different acceptance stage — deterministic
// local split-stream media inside a `--network none` container, never a public
// tunnel. When `split` is not configured these routes do not exist at all:
//
//   GET  /split-mp4.mpd            (+HEAD)   pairable ISO-BMFF DASH manifest
//   GET  /split-webm.mpd           (+HEAD)   pairable Matroska DASH manifest
//   GET  /split-incompatible.mpd   (+HEAD)   an mp4+webm pair the table refuses
//   GET  /split-video.mp4          (+HEAD)   the video-only ISO-BMFF half
//   GET  /split-audio.m4a          (+HEAD)   the audio-only ISO-BMFF half
//   GET  /split-video.webm         (+HEAD)   the video-only Matroska half
//   GET  /split-audio.webm         (+HEAD)   the audio-only Matroska half
//
// Every one of them maps to ONE predeclared artifact this process already
// holds in memory. There is no path-to-file mapping here either.
//
// A split set is whole-object only (`Accept-Ranges: none`) unless it is built
// with `ranges: true`. Then, and only then, its four MEDIA routes also answer
// ONE `bytes=START-END` / `bytes=START-` range with 206 (416 past the end). The
// SPLIT-06 orchestrator builds such an instance solely for its chunked
// `--max-filesize` characterization; its full path never does.
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
 * The CURRENT Product limit this fixture is sized against.
 *
 * Mirrors `DEFAULT_MAX_FILE_SIZE_BYTES` in `src/shared/media-limits.ts`, which
 * has been 4 GiB since MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001. It is a
 * REFERENCE, not an authority: the acceptance harness compares against the
 * limit it measures from the DEPLOYED Worker, because a deployment may
 * legitimately override `MAX_FILE_SIZE` in either direction.
 */
export const BYTE_LIMIT_REFERENCE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Bounded observation margin above that reference.
 *
 * The Production byte watcher polls actual bytes every 150 ms, so the transfer
 * does not stop at the exact threshold byte — it stops at the first poll after
 * it. 256 MiB is enough post-threshold room for that poll to land while the
 * fixture is still serving, and small enough that a runaway transfer stays
 * bounded. A far larger margin would only make a runaway more expensive
 * without making the assertion any stronger.
 */
export const BYTE_LIMIT_HEADROOM_BYTES = 256 * 1024 * 1024;

/**
 * How many bytes the unknown-length stream will produce if nobody stops it.
 *
 * 4.25 GiB (4,563,402,752 bytes) — the current 4 GiB reference plus the bounded
 * headroom above. The fixture exists to let the Worker's byte watcher fire, and
 * the normal outcome is that the Worker closes the connection shortly after the
 * threshold, well before this ceiling is reached.
 *
 * HISTORICAL: this was 528 MiB while the deployed default was 500 MiB, and the
 * accepted Phase-10D `byte-limit` record remains valid evidence for THAT
 * deployment. Raising the ceiling does not restate that record against 4 GiB
 * — it only makes a FUTURE run capable of crossing today's limit.
 *
 * This is a CEILING, not an allocation — see `streamUnknownLengthMedia`, which
 * emits it from one reused `BYTE_LIMIT_BLOCK_BYTES` block under backpressure.
 * Nothing here is proportional to the ceiling, and nothing ever allocates it.
 */
export const BYTE_LIMIT_TOTAL_BYTES = BYTE_LIMIT_REFERENCE_MAX_BYTES + BYTE_LIMIT_HEADROOM_BYTES;

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
 * socket buffer, so even the 4.25 GiB default ceiling costs kilobytes of
 * memory. Nothing here is proportional to `totalBytes`.
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

// ── The SPLIT-06 fixture set ───────────────────────────────────────────────

/**
 * The route paths SPLIT-06 declares, as a CLOSED table.
 *
 * The keys are the only split routes that can exist. Each maps to exactly one
 * body supplied at construction time, so — as with every other route here —
 * there is no request input from which a filesystem path could be built, and a
 * traversal attempt has nothing to traverse.
 */
export const SPLIT_MANIFEST_ROUTES = Object.freeze([
  "/split-mp4.mpd",
  "/split-webm.mpd",
  "/split-incompatible.mpd",
]);

export const SPLIT_MEDIA_ROUTES = Object.freeze([
  "/split-video.mp4",
  "/split-audio.m4a",
  "/split-video.webm",
  "/split-audio.webm",
]);

/** The exact `Content-Type` each split route answers with. Fixed in source. */
export const SPLIT_ROUTE_CONTENT_TYPES = Object.freeze({
  "/split-mp4.mpd": "application/dash+xml",
  "/split-webm.mpd": "application/dash+xml",
  "/split-incompatible.mpd": "application/dash+xml",
  "/split-video.mp4": "video/mp4",
  "/split-audio.m4a": "audio/mp4",
  "/split-video.webm": "video/webm",
  "/split-audio.webm": "audio/webm",
});

/** The Phase-10D route set, named positively so it can be gated as a whole. */
export const PHASE_10D_ROUTES = Object.freeze([
  "/direct.mp4",
  "/generic",
  "/generic-media.mp4",
  "/byte-limit",
  "/byte-limit-media.mp4",
  "/byte-evidence",
  "/safe-egress",
]);

/** True when `route` is one of the closed SPLIT-06 routes. */
function isSplitRoute(route) {
  return SPLIT_MANIFEST_ROUTES.includes(route) || SPLIT_MEDIA_ROUTES.includes(route);
}

/**
 * Reads ONE `bytes=START-END` or `bytes=START-` range against `total` bytes.
 *
 * `null` when there is nothing to honour — no header, a suffix or multi-range
 * form, anything malformed, or an end before its start — and the whole object
 * is then served, as RFC 9110 permits for any range a server does not support.
 * `{ satisfiable: false }` when START is at or past the end. Otherwise the
 * inclusive `[start, end]`, END clamped to the last byte. Fifteen digits keep
 * every value a safe integer.
 */
export function readSingleByteRange(header, total) {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(header);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = match[2] === "" ? null : Number(match[2]);
  if (end !== null && end < start) return null;
  if (start >= total) return { satisfiable: false };
  return { satisfiable: true, start, end: Math.min(end ?? total - 1, total - 1) };
}

/**
 * Validates and freezes the caller's split fixture set.
 *
 * Fail-closed and EXACT: every declared route must be present, must be a
 * non-empty Buffer, and no route outside the closed table may be supplied.
 * A partially configured split set would make "which routes exist" depend on
 * what the operator remembered, which is the property the closed table exists
 * to remove.
 */
function buildSplitRouteTable(split) {
  const manifests = split?.manifests;
  const artifacts = split?.artifacts;
  if (!manifests || typeof manifests !== "object") {
    throw new Error("the split fixture set must supply a `manifests` map");
  }
  if (!artifacts || typeof artifacts !== "object") {
    throw new Error("the split fixture set must supply an `artifacts` map");
  }
  // Absent means `false`: the whole-object behaviour every existing caller
  // relies on. Anything but a real boolean is refused rather than coerced.
  if (split.ranges !== undefined && typeof split.ranges !== "boolean") {
    throw new Error("the split fixture set's `ranges` must be a boolean when supplied");
  }

  const bodies = new Map();
  const digests = new Map();
  for (const [routes, supplied, label] of [
    [SPLIT_MANIFEST_ROUTES, manifests, "manifest"],
    [SPLIT_MEDIA_ROUTES, artifacts, "artifact"],
  ]) {
    for (const route of routes) {
      const body = supplied[route];
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw new Error(`the split ${label} for ${route} must be a non-empty Buffer`);
      }
      bodies.set(route, body);
      digests.set(route, createHash("sha256").update(body).digest("hex"));
    }
    for (const route of Object.keys(supplied)) {
      if (!routes.includes(route)) {
        throw new Error(`${route} is not a declared split ${label} route`);
      }
    }
  }

  return {
    bodies,
    digests,
    /**
     * Whether the split MEDIA routes answer a single byte range (206).
     *
     * Off by default, and then every split route is exactly what it always
     * was: `accept-ranges: none`, the whole object whatever the client asks.
     * SPLIT-06 turns it on only for the separate service instance behind its
     * chunked `--max-filesize` characterization, because a source fetched in
     * HTTP chunks is, by definition, a sequence of range requests — and the
     * hosts that set `http_chunk_size` (googlevideo among them) serve them.
     * Manifests never answer ranges.
     */
    ranges: split.ranges === true,
    /**
     * What this service OBSERVED on its split routes.
     *
     * Every field is a measurement this process made on its own request path:
     * the route, the method and the bytes it actually wrote. No URL, no header,
     * no client address, no user agent. A route with no record was never asked
     * for, which is what makes "the audio acquisition read the audio route and
     * nothing else" a positive statement rather than an absence of evidence.
     */
    requests: [],
  };
}

// ── The service ────────────────────────────────────────────────────────────

/**
 * Builds the fixture service around TWO already-read media buffers.
 *
 * Each body is read ONCE, by the caller, from a path the operator named on the
 * command line. No request can influence which bytes are served: there is no
 * path-to-file mapping anywhere in this module, so path traversal has nothing
 * to traverse and an arbitrary-file read has no reachable call site.
 *
 * `media` and `genericMedia` are SEPARATE and both required
 * (PHASE-10D-STAGE-B-SUCCESS-BLOCKER-REMEDIATION-001). They used to be one
 * buffer, which coupled the direct control fixture's identity — accepted
 * Stage-A evidence, and required to stay bit-identical — to the size the
 * throttled generic route needs in order to be acquirable at all. There is
 * deliberately NO fallback from a missing `genericMedia` to `media`: silently
 * reinstating the coupling is the one failure mode this split exists to
 * prevent, and it would fail live rather than here.
 *
 * @param {object} options
 * @param {Buffer} options.media                    the DIRECT fixture MP4;
 *                                                  also the byte-limit prefix
 * @param {Buffer} options.genericMedia             the GENERIC fixture MP4
 * @param {string} [options.directMediaPath]        where `media` was read from
 * @param {string} [options.genericMediaSourcePath] where `genericMedia` was read from
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
    genericMedia,
    /**
     * SPLIT-06's optional fixture set: `{ manifests, artifacts }`, both maps of
     * route path -> predeclared body. Absent means the split routes do not
     * exist, and the service behaves exactly as it did before SPLIT-06.
     */
    split,
    directMediaPath = null,
    genericMediaSourcePath = null,
    log = defaultLog,
    genericThrottleMs = GENERIC_THROTTLE_TARGET_MS,
    genericThrottleTickMs = GENERIC_THROTTLE_TICK_MS,
    byteLimitTotalBytes = BYTE_LIMIT_TOTAL_BYTES,
    byteLimitBlockBytes = BYTE_LIMIT_BLOCK_BYTES,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => new Date(),
  } = options;

  // ── which fixture families this instance serves ─────────────────────────
  //
  // Stated POSITIVELY, per set, and never by subtraction. The Phase-10D family
  // is requested by naming EITHER media buffer, which is what every existing
  // caller does, so its fail-closed "both buffers or nothing" contract is
  // unchanged: a caller that names one and forgets the other is still refused
  // here rather than during a live case. SPLIT-06 names `split` and neither
  // buffer — it has no use for an 8-16 MiB throttled body, and padding one in
  // to satisfy a requirement it does not need would be exactly the kind of
  // inert fixture state this service avoids.
  //
  // A service configured with neither is refused with the original message: an
  // empty route table is never a usable fixture.
  const wantsPhase10d = media !== undefined || genericMedia !== undefined;
  const wantsSplit = split !== undefined;

  if (wantsPhase10d || !wantsSplit) {
    if (!Buffer.isBuffer(media) || media.byteLength === 0) {
      throw new Error("the direct fixture media must be a non-empty Buffer");
    }
    if (!Buffer.isBuffer(genericMedia) || genericMedia.byteLength === 0) {
      throw new Error("the generic fixture media must be a non-empty Buffer");
    }
  }

  const splitSet = wantsSplit ? buildSplitRouteTable(split) : null;

  const directDigest = wantsPhase10d
    ? createHash("sha256").update(media).digest("hex")
    : null;
  const genericDigest = wantsPhase10d
    ? createHash("sha256").update(genericMedia).digest("hex")
    : null;
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

  /**
   * Answers HEAD for one media route with THAT route's exact length.
   *
   * The body is a parameter rather than a closed-over constant: `/direct.mp4`
   * and `/generic-media.mp4` describe different files now, and a HEAD that
   * reported the other one's length would be a lie the Worker's direct analyzer
   * reads directly.
   */
  function serveMediaHead(res, body, status = 200) {
    res.writeHead(status, {
      "content-type": MP4_CONTENT_TYPE,
      "content-length": String(body.byteLength),
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

    // A route belongs to a fixture SET, and a set that was not configured has
    // no routes. This is what keeps the table closed in both directions: a
    // split-only instance answers 404 for `/direct.mp4` exactly as it does for
    // `/favicon.ico`, rather than reaching a handler with no body to serve.
    if (!wantsPhase10d && PHASE_10D_ROUTES.includes(route)) {
      log({ route: "<unknown>", status: 404 });
      sendText(res, 404, "not found");
      return;
    }
    if (splitSet && isSplitRoute(route)) {
      if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res, route, "GET, HEAD");
      const body = splitSet.bodies.get(route);
      const contentType = SPLIT_ROUTE_CONTENT_TYPES[route];
      // Only a RANGED instance's media routes ever answer a range (see
      // `buildSplitRouteTable`). Everything else is the unchanged
      // whole-object behaviour.
      const rangeable = splitSet.ranges && SPLIT_MEDIA_ROUTES.includes(route);
      const range =
        rangeable && method === "GET" ? readSingleByteRange(req.headers.range, body.byteLength) : null;
      // A ranged instance also records each response's status and the range it
      // served; the default instance's records are exactly what they were.
      const record = (status, bytes, served) =>
        splitSet.requests.push(
          splitSet.ranges
            ? { route, method, status, bytes, range: served, at: now().toISOString() }
            : { route, method, bytes, at: now().toISOString() },
        );

      if (range !== null && !range.satisfiable) {
        res.writeHead(416, {
          "content-range": `bytes */${body.byteLength}`,
          "content-length": "0",
          "cache-control": "no-store",
        });
        res.end();
        record(416, 0, null);
        log({ route, status: 416, outcome: "range-not-satisfiable" });
        return;
      }
      if (range !== null) {
        const slice = body.subarray(range.start, range.end + 1);
        res.writeHead(206, {
          "content-type": contentType,
          "content-length": String(slice.byteLength),
          "content-range": `bytes ${range.start}-${range.end}/${body.byteLength}`,
          "accept-ranges": "bytes",
          "cache-control": "no-store",
        });
        res.end(slice);
        record(206, slice.byteLength, { start: range.start, end: range.end, total: body.byteLength });
        log({ route, status: 206, bytes: slice.byteLength });
        return;
      }

      res.writeHead(200, {
        "content-type": contentType,
        // Deterministic and honest: every split body is fully known before the
        // response begins, so the length is the body's own.
        "content-length": String(body.byteLength),
        // The pinned native downloader does not need ranges for a progressive
        // http source, and the acquired-artifact proof is byte identity of the
        // whole file. Advertising range support would add a transfer mode the
        // evidence does not describe — except on a ranged instance, whose one
        // purpose is to serve the chunks such a source is fetched in.
        "accept-ranges": rangeable ? "bytes" : "none",
        "cache-control": "no-store",
      });
      if (method === "HEAD") {
        record(200, 0, null);
        log({ route, status: 200, outcome: "head" });
        res.end();
        return;
      }
      res.end(body);
      record(200, body.byteLength, null);
      log({ route, status: 200, bytes: body.byteLength });
      return;
    }

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
          serveMediaHead(res, media);
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
      //
      // The GENERIC body, never the direct one. The throttle spreads whatever
      // it is given across `genericThrottleMs`, so the body's SIZE is what
      // decides whether the peer sees one long read or many short ones — which
      // is the whole reason the two fixtures are no longer the same file.
      case "/generic-media.mp4": {
        if (method === "HEAD") {
          log({ route, status: 200, outcome: "head" });
          serveMediaHead(res, genericMedia);
          return;
        }
        if (method !== "GET") return methodNotAllowed(res, route, "GET, HEAD");
        res.writeHead(200, {
          "content-type": MP4_CONTENT_TYPE,
          "content-length": String(genericMedia.byteLength),
          "accept-ranges": "none",
          "cache-control": "no-store",
        });
        const sent = await writeThrottled(createWriter(res), genericMedia, {
          targetMs: genericThrottleMs,
          tickMs: genericThrottleTickMs,
          sleep,
        });
        if (!res.writableEnded) res.end();
        log({
          route,
          status: 200,
          bytes: sent,
          outcome: sent === genericMedia.byteLength ? "complete" : "peer-closed",
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
          // The DIRECT body, deliberately. This prefix only has to be a valid
          // MP4 header the Worker will start acquiring; the case's assertion is
          // about the bytes that follow it, so it must not inherit the generic
          // fixture's size and turn a byte-limit proof into a size accident.
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
     * Route paths, byte counts, BOTH media digests and the frozen egress
     * expectation. No credential, no environment, and no filesystem path other
     * than the two media files the operator explicitly supplied.
     *
     * `*Path` keys ending in a route (`/direct.mp4`, `/generic-media.mp4`) are
     * HTTP paths; `directMediaPath` and `genericMediaSourcePath` are the
     * filesystem files those routes were loaded from. The two bodies are
     * reported separately and are never described by one shared digest — an
     * operator reading this manifest must be able to tell, without inspecting
     * the process, that `/direct.mp4` and `/generic-media.mp4` are different
     * files.
     */
    manifest() {
      const address = server.address();
      const splitManifest = splitSet
        ? {
            splitConfigured: true,
            splitManifestPaths: [...SPLIT_MANIFEST_ROUTES],
            splitMediaPaths: [...SPLIT_MEDIA_ROUTES],
            splitContentTypes: { ...SPLIT_ROUTE_CONTENT_TYPES },
            splitBytes: Object.fromEntries(
              [...splitSet.bodies].map(([route, body]) => [route, body.byteLength]),
            ),
            splitSha256: Object.fromEntries(splitSet.digests),
            splitMediaRanges: splitSet.ranges ? "single byte range" : "none",
          }
        : { splitConfigured: false };

      return {
        ...splitManifest,
        listenAddress: LISTEN_ADDRESS,
        listenPort: address && typeof address === "object" ? address.port : null,
        directPath: "/direct.mp4",
        directBytes: wantsPhase10d ? media.byteLength : null,
        directSha256: directDigest,
        directMediaPath,
        genericPath: "/generic",
        genericMediaPath: "/generic-media.mp4",
        genericMediaBytes: wantsPhase10d ? genericMedia.byteLength : null,
        genericMediaSha256: genericDigest,
        genericMediaSourcePath,
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

    /**
     * The sanitized split-route request log. Never served over HTTP either:
     * the SPLIT-06 orchestrator runs in the same container as this service and
     * reads it in-process, so there is no evidence endpoint to secure.
     */
    splitRequests() {
      return splitSet ? splitSet.requests.map((r) => ({ ...r })) : [];
    },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = {
    media: null,
    genericMedia: null,
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
      case "--generic-media":
        out.genericMedia = next();
        break;
      case "--port":
        out.port = Number.parseInt(next(), 10);
        break;
      case "--generic-throttle-ms":
        out.genericThrottleMs = Number.parseInt(next(), 10);
        break;
      // A BOUNDED override, and never the reviewed default.
      //
      // Its proper uses are the small deterministic ceilings the offline
      // fixture tests start services with, local characterization, and a
      // separately reviewed special acceptance circumstance. It is NOT a way to
      // make the default sufficient — `BYTE_LIMIT_TOTAL_BYTES` already is — and
      // an operator-chosen value does not become trustworthy acceptance
      // evidence by being passed here: the harness binds whatever ceiling the
      // manifest advertises and then proves the bytes ACTUALLY served against
      // the limit it measured from the deployed Worker.
      case "--byte-limit-bytes":
        out.byteLimitTotalBytes = Number.parseInt(next(), 10);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.media) throw new Error("--media <path to the direct fixture mp4> is required");
  // Fail-closed, and NEVER a fallback to `--media`. The one-buffer coupling this
  // flag replaces is what made the throttled generic route unacquirable, so an
  // operator who forgets it must be told here rather than during a live case.
  if (!out.genericMedia) {
    throw new Error("--generic-media <path to the generic fixture mp4> is required");
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
    throw new Error("--port must be 0-65535");
  }
  return out;
}

/** The CLI entry point. Prints the manifest as one JSON line on stdout. */
export async function main(argv) {
  const opts = parseArgv(argv);
  const [media, genericMedia] = await Promise.all([
    readFile(opts.media),
    readFile(opts.genericMedia),
  ]);
  const service = createFixtureService({
    media,
    genericMedia,
    directMediaPath: opts.media,
    genericMediaSourcePath: opts.genericMedia,
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
