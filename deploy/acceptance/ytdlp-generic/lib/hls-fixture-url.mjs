// HLS-08 fixture addressing: one public-looking acceptance hostname, the
// closed route table behind it, and the exact validator for the ONE submitted
// page URL.
//
// ── Why a public-looking hostname ──────────────────────────────────────────
//
// The clear-HLS Product policy correctly refuses a loopback or private
// playlist location, at analysis (`acceptClearHlsPlaylistUrl`) and again at
// request time (HLS-2/HLS-3's `safeGet`). A fixture that advertised
// `http://127.0.0.1/...` would therefore never be selected, and the run would
// prove nothing. So every Product-visible fixture URL names ONE fixed,
// syntactically public hostname under the reserved `.invalid` TLD, which can
// never resolve on any real network:
//
//   http://hls-fixture.example.invalid:<ephemeral port>/hls08/...
//
// Inside the `--network none` acceptance container that name reaches the
// loopback fixture two ways, and only two:
//
//   - the pinned yt-dlp subprocess resolves it through the container's
//     `/etc/hosts`, which carries exactly one acceptance-only mapping
//     (`--add-host`, pinned in `lib/hls-container.mjs`);
//   - the Product's own safe-HTTP stack resolves it through the acceptance
//     transport (`lib/hls-safe-http-transport.mjs`), which answers with a
//     synthetic PUBLIC address so the real private-address policy still runs,
//     and then re-points only the socket at loopback.
//
// Nothing here is a general allowance: every value is a fixed literal or is
// derived from the running fixture's own ephemeral port.
//
// Plain ESM with NO import at all: the host driver runs on the VM's Node 18,
// which cannot load TypeScript, and it reads the hostname from here through
// `lib/hls-container.mjs`. The page validator therefore receives the Product's
// `AppError` class from its caller instead of importing it.

/** The ONE acceptance hostname. Reserved TLD: it cannot resolve publicly. */
export const HLS_FIXTURE_HOSTNAME = "hls-fixture.example.invalid";

/** The one scheme. The fixture does not serve TLS. */
export const HLS_FIXTURE_PROTOCOL = "http:";

/** Where the fixture service actually listens, inside the container. */
export const HLS_FIXTURE_LOOPBACK = "127.0.0.1";

/**
 * The synthetic public DNS answer the acceptance transport gives the Product.
 *
 * It must be an address the Product's `isPrivateIp` does NOT refuse — that is
 * the point: the real destination policy runs and admits it. It is never
 * contacted: the transport re-points the socket at loopback, and the container
 * has no network to reach it anyway. It is the same public stand-in the HLS-2
 * and HLS-3 unit suites already use.
 */
export const HLS_SYNTHETIC_PUBLIC_ADDRESS = "8.8.8.8";

// ── The closed route table ─────────────────────────────────────────────────

/** The submitted page: HTML, not direct media, so the direct strategy declines. */
export const HLS_PAGE_ROUTE = "/hls08/watch.html";

/** The master playlist the page's `<source>` names. yt-dlp alone reads it. */
export const HLS_MASTER_ROUTE = "/hls08/master.m3u8";

/** Every media playlist lives here, told apart only by its `sig` parameter. */
export const HLS_MEDIA_ROUTE = "/hls08/media.m3u8";

/** The query parameter that carries a private-by-contract marker. */
export const HLS_MEDIA_SIGNATURE_PARAMETER = "sig";

/** A key location the encrypted negative names. It must never be requested. */
export const HLS_KEY_ROUTE = "/hls08/hls08-key.bin";

/**
 * The fragment families. Positive fragments are the FFmpeg-authored names;
 * the fragment-failure negative uses its own names so its requests can never
 * be confused with the positive run's.
 */
export const HLS_FRAGMENT_FAMILIES = Object.freeze({
  positive: "seg-",
  failure: "fail-seg-",
});

const FRAGMENT_ROUTE = /^\/hls08\/(seg-|fail-seg-)(\d{1,3})\.ts$/;

// ── Private-by-contract markers ────────────────────────────────────────────

/**
 * Conspicuous, NON-secret markers that stand in for a signed CDN query.
 *
 * Each labels one media-playlist location. They are private BY CONTRACT: the
 * Product must never put a playlist location on any public or durable surface,
 * so none of these may appear in public analysis, SQLite, a job view, an
 * object key, a filename, a trace or the evidence record. The labels (left)
 * are what evidence and ledgers carry instead.
 */
export const HLS08_PRIVATE_MARKERS = Object.freeze({
  browser: "HLS08_PRIVATE_BROWSER",
  execution: "HLS08_PRIVATE_EXECUTION",
  encrypted: "HLS08_PRIVATE_NEG_ENCRYPTED",
  "fragment-failure": "HLS08_PRIVATE_NEG_FRAGMENT",
  "no-ffmpeg": "HLS08_PRIVATE_NEG_NOFFMPEG",
});

/** Every marker shares this prefix, which evidence scans refuse outright. */
export const HLS08_PRIVATE_MARKER_PREFIX = "HLS08_PRIVATE_";

/**
 * The master's `NAME` attribute. The pinned HLS extractor builds the raw
 * upstream format id from it (`hls-` + NAME), which gives the privacy scans a
 * conspicuous needle instead of a bandwidth number that could occur anywhere.
 */
export const HLS08_RAW_FORMAT_NAME = "HLS08_RAW_FORMAT_ID";

/** The raw upstream HLS format id the pinned extractor is expected to emit. */
export const HLS08_RAW_FORMAT_ID = `hls-${HLS08_RAW_FORMAT_NAME}`;

/** The variant labels, in a stable order. */
export const HLS08_VARIANTS = Object.freeze(Object.keys(HLS08_PRIVATE_MARKERS));

/** The relative media-playlist URI a master names for one variant. */
export function mediaPlaylistUri(variant) {
  const marker = HLS08_PRIVATE_MARKERS[variant];
  if (typeof marker !== "string" || !Object.hasOwn(HLS08_PRIVATE_MARKERS, variant)) {
    throw new Error(`unknown HLS-08 media variant: ${variant}`);
  }
  return `${HLS_MEDIA_ROUTE.split("/").pop()}?${HLS_MEDIA_SIGNATURE_PARAMETER}=${marker}`;
}

// ── Request classification (shared by the fixture and the transport) ───────

/**
 * Classifies one request path (pathname plus optional query) against the
 * closed route table. Pure; never throws.
 *
 *   kind     page | master | media | fragment | key | unexpected
 *   variant  the media variant LABEL, for media requests; never the marker
 *   family   positive | failure, for fragments
 *   ordinal  1-based playlist position, for fragments (FFmpeg names are 0-based)
 */
export function classifyHlsFixturePath(pathWithQuery) {
  const none = { kind: "unexpected", variant: null, family: null, ordinal: null };
  if (typeof pathWithQuery !== "string" || !pathWithQuery.startsWith("/")) return none;
  let parsed;
  try {
    parsed = new URL(pathWithQuery, `${HLS_FIXTURE_PROTOCOL}//${HLS_FIXTURE_HOSTNAME}`);
  } catch {
    return none;
  }
  const { pathname, search, hash } = parsed;
  if (hash !== "") return none;

  if (pathname === HLS_PAGE_ROUTE && search === "") return { ...none, kind: "page" };
  if (pathname === HLS_MASTER_ROUTE && search === "") return { ...none, kind: "master" };
  if (pathname === HLS_KEY_ROUTE && search === "") return { ...none, kind: "key" };

  if (pathname === HLS_MEDIA_ROUTE) {
    const params = [...parsed.searchParams.entries()];
    if (params.length !== 1 || params[0][0] !== HLS_MEDIA_SIGNATURE_PARAMETER) return none;
    const variant = HLS08_VARIANTS.find((v) => HLS08_PRIVATE_MARKERS[v] === params[0][1]);
    return variant ? { ...none, kind: "media", variant } : none;
  }

  const fragment = FRAGMENT_ROUTE.exec(pathname);
  if (fragment && search === "") {
    return {
      kind: "fragment",
      variant: null,
      family: fragment[1] === HLS_FRAGMENT_FAMILIES.positive ? "positive" : "failure",
      ordinal: Number(fragment[2]) + 1,
    };
  }
  return none;
}

// ── The exact submitted-page validator ─────────────────────────────────────

/** The exact origin for one running fixture. */
export function hlsFixtureOrigin(port) {
  requirePort(port);
  return `${HLS_FIXTURE_PROTOCOL}//${HLS_FIXTURE_HOSTNAME}:${port}`;
}

/** The ONE submitted page URL for one running fixture. */
export function hlsPageUrl(port) {
  return `${hlsFixtureOrigin(port)}${HLS_PAGE_ROUTE}`;
}

/**
 * The acceptance stand-in for Production's `assertSafeUrl`, for the SUBMITTED
 * PAGE URL only.
 *
 * Production's validator correctly refuses this fixture, because the name
 * ultimately lands on loopback inside the container. This one admits exactly
 * one string — the runtime-generated page URL — and nothing near it:
 *
 *   scheme    exactly http:
 *   hostname  exactly hls-fixture.example.invalid
 *   port      exactly the ephemeral fixture port
 *   path      exactly the page route
 *   no userinfo, no query, no fragment
 *
 * and, beyond the parsed checks, the RAW input must already be that canonical
 * string, so a differently spelled equivalent (case, default port, a bare `?`
 * or `#`) is refused rather than normalized into admission.
 *
 * It proves NOTHING about SSRF policy and must never be cited for it.
 */
export function createHlsPageUrlValidator({ port, AppError }) {
  requirePort(port);
  if (typeof AppError !== "function") {
    throw new Error("the page validator needs the Product AppError class, to refuse as Production does");
  }
  const admitted = hlsPageUrl(port);

  const validate = async (raw) => {
    if (typeof raw !== "string" || raw.length === 0) throw new AppError("INVALID_URL");
    if (raw !== admitted) throw new AppError("INVALID_URL");
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError("INVALID_URL");
    }
    if (url.protocol !== HLS_FIXTURE_PROTOCOL) throw new AppError("INVALID_URL");
    if (url.hostname !== HLS_FIXTURE_HOSTNAME) throw new AppError("INVALID_URL");
    if (url.port !== String(port)) throw new AppError("INVALID_URL");
    if (url.username !== "" || url.password !== "") throw new AppError("INVALID_URL");
    if (url.search !== "" || url.hash !== "") throw new AppError("INVALID_URL");
    if (url.pathname !== HLS_PAGE_ROUTE) throw new AppError("INVALID_URL");
    return { url: admitted, hostname: HLS_FIXTURE_HOSTNAME };
  };
  validate.admitted = admitted;
  return validate;
}

/**
 * Nearby alternatives the page validator must refuse, for one port. The
 * orchestrator records each refusal as a check, so "narrow" is measured.
 */
export function nearbyPageUrlAlternatives(port) {
  requirePort(port);
  const host = HLS_FIXTURE_HOSTNAME;
  return Object.freeze([
    `https://${host}:${port}${HLS_PAGE_ROUTE}`,
    `http://${host}:${port + 1}${HLS_PAGE_ROUTE}`,
    `http://${host}${HLS_PAGE_ROUTE}`,
    `http://${HLS_FIXTURE_LOOPBACK}:${port}${HLS_PAGE_ROUTE}`,
    `http://localhost:${port}${HLS_PAGE_ROUTE}`,
    `http://other.example.invalid:${port}${HLS_PAGE_ROUTE}`,
    `http://${host}.:${port}${HLS_PAGE_ROUTE}`,
    `http://HLS-FIXTURE.example.invalid:${port}${HLS_PAGE_ROUTE}`,
    `http://${host}:${port}${HLS_MASTER_ROUTE}`,
    `http://${host}:${port}${HLS_PAGE_ROUTE}?x=1`,
    `http://${host}:${port}${HLS_PAGE_ROUTE}?`,
    `http://${host}:${port}${HLS_PAGE_ROUTE}#top`,
    `http://user:pw@${host}:${port}${HLS_PAGE_ROUTE}`,
    `file://${HLS_PAGE_ROUTE}`,
    `sample:${HLS_PAGE_ROUTE}`,
  ]);
}

function requirePort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("the HLS-08 fixture needs its exact bound port");
  }
}
