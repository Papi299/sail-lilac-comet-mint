// HLS-08's acceptance DNS/socket transport for the Product's REAL safe-HTTP
// stack.
//
// ── The one problem it solves ──────────────────────────────────────────────
//
// HLS-2 (playlist preflight) and HLS-3 (fragment acquisition) run their REAL
// Product implementations, and both fetch through the real `safeGet()`. That
// function correctly refuses a DNS answer of `127.0.0.1` — which is exactly
// where the fixture lives inside the `--network none` container. Replacing
// `safeGet()`, HLS-2 or HLS-3 would stop the run proving anything about them,
// so this module substitutes the two LOWEST layers the Product already exposes
// as test hooks, and nothing above them:
//
//   setSafeHttpTestHooks({ lookup })        the DNS answer
//   setPinnedRequestFactoryForTests({ http }) the socket
//
// ── What still runs, for real ──────────────────────────────────────────────
//
//   validatePublicHttpUrl      the static URL policy
//   resolveSafeDestination     the lookup call and its error mapping
//   validateResolvedAddresses  the private-address refusal, against an answer
//                              the Product considers PUBLIC
//   the redirect policy, the fixed Product request headers, the abort checks,
//   buildPinnedRequestOptions, nodeRequestOnce, Node's HTTP client and the
//   whole response path
//
// ── What this transport does ───────────────────────────────────────────────
//
// lookup   answers ONLY `hls-fixture.example.invalid`, with ONE synthetic
//          public address. Any other name is refused.
//
// socket   receives the request that already passed the real policy,
//          verifies it names the exact fixture host, port, method, route and
//          Host header and that it was pinned to the synthetic answer, and
//          only then hands Node's real `http.request` the SAME options with
//          one change: the pinned lookup now answers loopback. Method, path,
//          headers, signal and response handling are untouched, and no body
//          is ever synthesized here — every byte comes from the real fixture
//          server through the real Node HTTP stack.
//
// ── What this proves, and what it does NOT ─────────────────────────────────
//
// It proves the HLS code invokes the existing safe-HTTP path and acts
// correctly on its responses. It does NOT re-prove Production SSRF/address
// pinning, Production DNS, or Production egress/nftables. Phase 9 remains the
// accepted authority for Production egress, and nothing recorded through this
// module may be cited for it.
//
// ── Observation ────────────────────────────────────────────────────────────
//
// Every admitted request becomes one ledger entry: its fixture-owned kind and
// ordinal (never its URL), the durable job status at the moment the request
// was built, header NAMES and booleans (never values), and monotonic event
// sequence numbers for open / response end / close, taken from a clock the
// fixture server shares. Non-overlap between fragments is then a comparison of
// those sequence numbers, not an inference from final order.
//
// Pure ESM with no Product import: the setters and Node's request function are
// injected, so the self-tests drive it with fakes as well as with the real
// safe-HTTP module.

import {
  HLS_FIXTURE_HOSTNAME,
  HLS_FIXTURE_LOOPBACK,
  HLS_FIXTURE_PROTOCOL,
  HLS_SYNTHETIC_PUBLIC_ADDRESS,
  classifyHlsFixturePath,
} from "./hls-fixture-url.mjs";

/** The Product's fixed request profile (`safeHttpRequest`), stated as data. */
export const PRODUCT_USER_AGENT = "VideoFetch/1.0";
export const PRODUCT_ACCEPT = "video/*,audio/*,*/*;q=0.8";

/** Exactly the header names a Product HLS request may carry. */
export const EXPECTED_REQUEST_HEADER_NAMES = Object.freeze(["accept", "host", "user-agent"]);

/** Headers whose mere presence would be a Product policy violation. */
export const FORBIDDEN_REQUEST_HEADER_NAMES = Object.freeze([
  "cookie",
  "authorization",
  "referer",
  "proxy-authorization",
]);

/** The only request kinds the Product's HLS code may make through this path. */
const ADMITTED_KINDS = new Set(["media", "fragment"]);

/** A refusal. It never names a URL, a header value or a marker. */
export class HlsTransportRefusal extends Error {
  constructor(reason) {
    super(`HLS-08 acceptance transport refused a request: ${reason}`);
    this.name = "HlsTransportRefusal";
    this.reason = reason;
  }
}

/** A monotonic event counter shared by the transport and the fixture server. */
export function createEventClock() {
  let value = 0;
  return {
    next() {
      value += 1;
      return value;
    },
    peek() {
      return value;
    },
  };
}

/** A `lookup` in Node's callback shape that always answers `address`. */
function fixedLookup(address) {
  return (_hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb !== "function") return;
    const all = typeof options === "object" && options !== null && options.all === true;
    if (all) cb(null, [{ address, family: 4 }]);
    else cb(null, address, 4);
  };
}

/** What a pinned `lookup` (Node callback shape) answers, read synchronously. */
function pinnedAnswer(lookup, hostname) {
  let answer = null;
  try {
    lookup(hostname, {}, (err, address, family) => {
      if (!err) answer = { address, family };
    });
  } catch {
    return null;
  }
  return answer;
}

function lowerCaseHeaderNames(headers) {
  if (headers === null || typeof headers !== "object") return [];
  return Object.keys(headers).map((k) => k.toLowerCase()).sort();
}

function headerValue(headers, name) {
  if (headers === null || typeof headers !== "object") return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/**
 * One acceptance transport for ONE running fixture.
 *
 * @param {object} opts
 * @param {number} opts.port            the fixture's ephemeral port
 * @param {{next(): number}} opts.eventClock  shared with the fixture server
 * @param {() => string} opts.statusNow the durable job status right now
 * @param {() => string} [opts.caseNow] the acceptance case label right now
 * @param {Function} opts.realRequest   Node's `http.request`
 */
export function createHlsSafeHttpTransport({
  port,
  eventClock,
  statusNow,
  caseNow = () => "unlabelled",
  realRequest,
  hostname = HLS_FIXTURE_HOSTNAME,
  syntheticAddress = HLS_SYNTHETIC_PUBLIC_ADDRESS,
}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("the acceptance transport needs the exact fixture port");
  }
  if (typeof realRequest !== "function") throw new Error("the acceptance transport needs http.request");
  if (typeof statusNow !== "function") throw new Error("the acceptance transport needs a status reader");
  if (!eventClock || typeof eventClock.next !== "function") {
    throw new Error("the acceptance transport needs the shared event clock");
  }

  const entries = [];
  const refusals = [];
  const lookups = { admitted: 0, refused: 0 };
  let armed = true;
  let callsWhileDisarmed = 0;

  const refuse = (reason) => {
    refusals.push({ reason, caseLabel: caseNow() });
    throw new HlsTransportRefusal(reason);
  };

  /** The injected DNS answer: one name, one synthetic public address. */
  const lookup = async (name) => {
    if (!armed) {
      callsWhileDisarmed += 1;
      throw new HlsTransportRefusal("transport disarmed");
    }
    if (name !== hostname) {
      lookups.refused += 1;
      throw new HlsTransportRefusal("lookup of a name other than the fixture hostname");
    }
    lookups.admitted += 1;
    return [{ address: syntheticAddress, family: 4 }];
  };

  /** The injected Node request factory: verify, then connect to loopback. */
  const requestFactory = (options, callback) => {
    if (!armed) {
      callsWhileDisarmed += 1;
      refuse("transport disarmed");
    }
    if (options === null || typeof options !== "object") refuse("no request options");
    if (options.protocol !== HLS_FIXTURE_PROTOCOL) refuse("scheme is not http:");
    if (options.hostname !== hostname) refuse("hostname is not the fixture hostname");
    if (options.port !== port) refuse("port is not the fixture port");
    if (options.method !== "GET") refuse("method is not GET");
    if (options.agent !== false) refuse("request is not a one-shot pinned request");
    if (options.family !== 4) refuse("request is not pinned to IPv4");
    if (typeof options.lookup !== "function") refuse("request carries no pinned lookup");
    const pinned = pinnedAnswer(options.lookup, hostname);
    if (pinned === null || pinned.address !== syntheticAddress) {
      refuse("request was not pinned to the synthetic public answer");
    }
    const hostHeader = headerValue(options.headers, "host");
    if (hostHeader !== `${hostname}:${port}`) refuse("Host header is not the fixture authority");

    const route = classifyHlsFixturePath(options.path);
    if (!ADMITTED_KINDS.has(route.kind)) refuse(`route kind ${route.kind} is not an HLS media request`);

    const names = lowerCaseHeaderNames(options.headers);
    const entry = {
      seq: eventClock.next(),
      caseLabel: caseNow(),
      kind: route.kind,
      variant: route.variant,
      family: route.family,
      ordinal: route.ordinal,
      method: options.method,
      statusAtRequest: statusNow(),
      headerNames: names,
      headerNamesExact:
        names.length === EXPECTED_REQUEST_HEADER_NAMES.length &&
        names.every((n, i) => n === EXPECTED_REQUEST_HEADER_NAMES[i]),
      userAgentIsProduct: headerValue(options.headers, "user-agent") === PRODUCT_USER_AGENT,
      acceptIsProduct: headerValue(options.headers, "accept") === PRODUCT_ACCEPT,
      forbiddenHeadersPresent: FORBIDDEN_REQUEST_HEADER_NAMES.filter((n) => names.includes(n)),
      pinnedToSyntheticPublicAddress: true,
      connectedTo: "loopback",
      responseStatus: null,
      endSeq: null,
      closeSeq: null,
      errored: false,
    };
    entries.push(entry);

    // The ONE change: the same options, whose pinned lookup now answers the
    // fixture's loopback address. Everything else is exactly what the real
    // safe-HTTP policy built.
    const req = realRequest({ ...options, lookup: fixedLookup(HLS_FIXTURE_LOOPBACK) }, callback);
    req.on("response", (res) => {
      entry.responseStatus = res.statusCode ?? null;
      // `end` = every body byte reached the Product's consumer. Neither
      // listener changes the stream's mode.
      res.on("end", () => {
        if (entry.endSeq === null) entry.endSeq = eventClock.next();
      });
      res.on("close", () => {
        if (entry.closeSeq === null) entry.closeSeq = eventClock.next();
      });
    });
    req.on("error", () => {
      entry.errored = true;
    });
    req.on("close", () => {
      if (entry.closeSeq === null) entry.closeSeq = eventClock.next();
    });
    return req;
  };

  return {
    lookup,
    requestFactory,
    /** A deep copy of every admitted request, in order. */
    ledger() {
      return entries.map((e) => ({ ...e, headerNames: [...e.headerNames], forbiddenHeadersPresent: [...e.forbiddenHeadersPresent] }));
    },
    refusals() {
      return refusals.map((r) => ({ ...r }));
    },
    lookupCounts() {
      return { ...lookups };
    },
    get armed() {
      return armed;
    },
    disarm() {
      armed = false;
    },
    callsWhileDisarmed() {
      return callsWhileDisarmed;
    },
  };
}

/**
 * Installs `transport` into the Product's safe-HTTP hooks for exactly the
 * duration of `fn`, and ALWAYS clears both hooks and disarms the transport
 * afterwards — on success, on a thrown error, and on a rejected promise.
 *
 * `setters` is the Product module's own pair, injected so this stays pure.
 */
export async function withHlsSafeHttpTransport(setters, transport, fn) {
  const { setSafeHttpTestHooks, setPinnedRequestFactoryForTests } = setters ?? {};
  if (typeof setSafeHttpTestHooks !== "function" || typeof setPinnedRequestFactoryForTests !== "function") {
    throw new Error("the Product safe-HTTP hook setters are required");
  }
  try {
    setSafeHttpTestHooks({ lookup: transport.lookup });
    setPinnedRequestFactoryForTests({ http: transport.requestFactory });
    return await fn();
  } finally {
    setPinnedRequestFactoryForTests(null);
    setSafeHttpTestHooks(null);
    transport.disarm();
  }
}
