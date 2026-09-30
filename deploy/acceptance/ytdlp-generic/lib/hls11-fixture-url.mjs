// HLS-11 fixture addressing: one public-looking acceptance hostname, a closed
// per-case route table behind it, and the exact validator for the submitted
// page URLs.
//
// The reasoning is HLS-08's (`lib/hls-fixture-url.mjs`), restated for a
// disjoint namespace so the two children can never be confused in a ledger:
// the clear-HLS Product policy correctly refuses a loopback playlist location
// at analysis and again at request time, so every Product-visible fixture URL
// names ONE syntactically public hostname under the reserved `.invalid` TLD.
// Inside the `--network none` release container that name reaches the loopback
// fixture two ways only: the pinned yt-dlp through `/etc/hosts` (the one
// `--add-host` mapping below), and the Product's own safe-HTTP stack through
// the acceptance transport (`lib/hls-safe-http-transport.mjs`), which answers a
// synthetic PUBLIC address so the real private-address policy still runs and
// then re-points only the socket at loopback.
//
// Plain ESM with NO import at all: the SPLIT-07 host driver reads the mapping
// through `lib/release-container.mjs` on an older Node.

/** The ONE acceptance hostname. Reserved TLD: it cannot resolve publicly. */
export const HLS11_FIXTURE_HOSTNAME = "hls11-fixture.example.invalid";

/** The one scheme. The fixture does not serve TLS. */
export const HLS11_FIXTURE_PROTOCOL = "http:";

/** Where the fixture service listens, inside the container. */
export const HLS11_FIXTURE_LOOPBACK = "127.0.0.1";

/** The `docker run --add-host` value for the pinned yt-dlp subprocess. */
export const HLS11_FIXTURE_HOST_MAPPING = `${HLS11_FIXTURE_HOSTNAME}:${HLS11_FIXTURE_LOOPBACK}`;

/** The synthetic public DNS answer the acceptance transport gives the Product. */
export const HLS11_SYNTHETIC_PUBLIC_ADDRESS = "8.8.8.8";

/**
 * The closed case vocabulary. Each case has its own page, master and media
 * directory, so a request can always be attributed to exactly one case.
 *
 *   v1-ts           HLS-V1-MUXED-TS control: 1920x1080 MPEG-TS, video + audio
 *   v2-fmp4         HLS-V2-MUXED-FMP4: 1920x1080 init + fMP4 fragments
 *   neg-byterange   an fMP4 playlist whose map carries BYTERANGE (refused)
 *   neg-encrypted   an fMP4 playlist carrying an EXT-X-KEY (refused)
 *   neg-init-404    a valid fMP4 playlist whose map answers 404
 *   neg-budget      a valid fMP4 playlist whose bytes exceed a lowered limit
 *   neg-video-only  a master that CLAIMS audio for a video-only fMP4 rendition
 *   split-master    a video-only rendition + separate HLS audio group, which
 *                   the pinned yt-dlp exposes with no pairing relationship
 */
export const HLS11_CASES = Object.freeze([
  "v1-ts",
  "v2-fmp4",
  "neg-byterange",
  "neg-encrypted",
  "neg-init-404",
  "neg-budget",
  "neg-video-only",
  "split-master",
]);

/** Private-by-contract markers carried as each media playlist's `sig` value. */
export const HLS11_PRIVATE_MARKER_PREFIX = "HLS11_PRIVATE_";

/** The master's NAME attribute; the pinned extractor builds `hls-<NAME>` from it. */
export const HLS11_RAW_FORMAT_NAME_PREFIX = "HLS11_RAW_";

/** The route prefix every fixture path lives under. */
export const HLS11_ROUTE_PREFIX = "/hls11/";

/** The marker for one case's media playlist. */
export function hls11Marker(caseName) {
  requireCase(caseName);
  return `${HLS11_PRIVATE_MARKER_PREFIX}${caseName.toUpperCase().replaceAll("-", "_")}`;
}

/** The raw upstream format id the pinned extractor is expected to emit. */
export function hls11RawFormatId(caseName) {
  requireCase(caseName);
  return `hls-${HLS11_RAW_FORMAT_NAME_PREFIX}${caseName.toUpperCase().replaceAll("-", "_")}`;
}

/** The relative media-playlist URI a master names for one case. */
export function hls11MediaPlaylistUri(caseName) {
  return `media.m3u8?sig=${hls11Marker(caseName)}`;
}

export function hls11PagePath(caseName) {
  requireCase(caseName);
  return `${HLS11_ROUTE_PREFIX}${caseName}/watch.html`;
}

export function hls11FixtureOrigin(port) {
  requirePort(port);
  return `${HLS11_FIXTURE_PROTOCOL}//${HLS11_FIXTURE_HOSTNAME}:${port}`;
}

export function hls11PageUrl(port, caseName) {
  return `${hls11FixtureOrigin(port)}${hls11PagePath(caseName)}`;
}

const FRAGMENT_NAME = /^seg-(\d{1,3})\.(ts|m4s)$/;
const SPLIT_PLAYLISTS = new Set(["video-1080.m3u8", "video-720.m3u8", "audio-main.m3u8", "audio-alt.m3u8"]);

/**
 * Classifies one request path (pathname plus optional query) against the
 * closed route table. Pure; never throws.
 *
 *   kind     page | master | media | init | fragment | key | unexpected
 *   caseName the case the path belongs to
 *   ordinal  1-based fragment position (FFmpeg names are 0-based)
 */
export function classifyHls11FixturePath(pathWithQuery) {
  const none = { kind: "unexpected", caseName: null, variant: null, family: null, ordinal: null };
  if (typeof pathWithQuery !== "string" || !pathWithQuery.startsWith(HLS11_ROUTE_PREFIX)) return none;
  let parsed;
  try {
    parsed = new URL(pathWithQuery, `${HLS11_FIXTURE_PROTOCOL}//${HLS11_FIXTURE_HOSTNAME}`);
  } catch {
    return none;
  }
  const { pathname, search, hash } = parsed;
  if (hash !== "") return none;
  const parts = pathname.slice(HLS11_ROUTE_PREFIX.length).split("/");
  if (parts.length !== 2) return none;
  const [caseName, leaf] = parts;
  if (!HLS11_CASES.includes(caseName)) return none;
  const found = (kind, extra = {}) => ({ ...none, kind, caseName, variant: caseName, family: caseName, ...extra });

  if (leaf === "watch.html" && search === "") return found("page");
  if (leaf === "master.m3u8" && search === "") return found("master");
  if (leaf === "key.bin" && search === "") return found("key");
  if (leaf === "init.mp4" && search === "") return found("init");
  if (leaf === "media.m3u8") {
    const params = [...parsed.searchParams.entries()];
    if (params.length !== 1 || params[0][0] !== "sig" || params[0][1] !== hls11Marker(caseName)) return none;
    return found("media");
  }
  if (caseName === "split-master" && SPLIT_PLAYLISTS.has(leaf) && search === "") return found("media");
  const fragment = FRAGMENT_NAME.exec(leaf);
  if (fragment && search === "") return found("fragment", { ordinal: Number(fragment[1]) + 1 });
  return none;
}

/**
 * The acceptance stand-in for Production's `assertSafeUrl`, for the SUBMITTED
 * PAGE URLs only: it admits exactly the runtime-generated page URL of each
 * case, spelled canonically, and nothing near them. It proves NOTHING about
 * SSRF policy and must never be cited for it.
 */
export function createHls11PageUrlValidator({ port, AppError }) {
  requirePort(port);
  if (typeof AppError !== "function") throw new Error("the page validator needs the Product AppError class");
  const admitted = new Set(HLS11_CASES.map((caseName) => hls11PageUrl(port, caseName)));
  const validate = async (raw) => {
    if (typeof raw !== "string" || !admitted.has(raw)) throw new AppError("INVALID_URL");
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError("INVALID_URL");
    }
    if (url.protocol !== HLS11_FIXTURE_PROTOCOL || url.hostname !== HLS11_FIXTURE_HOSTNAME) {
      throw new AppError("INVALID_URL");
    }
    if (url.port !== String(port) || url.username !== "" || url.password !== "") throw new AppError("INVALID_URL");
    if (url.search !== "" || url.hash !== "") throw new AppError("INVALID_URL");
    return { url: raw, hostname: HLS11_FIXTURE_HOSTNAME };
  };
  validate.admitted = [...admitted];
  return validate;
}

/** Nearby alternatives the page validator must refuse, for one port. */
export function hls11NearbyPageUrlAlternatives(port) {
  requirePort(port);
  const host = HLS11_FIXTURE_HOSTNAME;
  const page = hls11PagePath("v2-fmp4");
  return Object.freeze([
    `https://${host}:${port}${page}`,
    `http://${host}:${port + 1}${page}`,
    `http://${HLS11_FIXTURE_LOOPBACK}:${port}${page}`,
    `http://localhost:${port}${page}`,
    `http://HLS11-FIXTURE.example.invalid:${port}${page}`,
    `http://${host}:${port}${HLS11_ROUTE_PREFIX}v2-fmp4/master.m3u8`,
    `http://${host}:${port}${page}?x=1`,
    `http://${host}:${port}${page}#top`,
    `http://user:pw@${host}:${port}${page}`,
    `file://${page}`,
  ]);
}

function requireCase(caseName) {
  if (!HLS11_CASES.includes(caseName)) throw new Error(`unknown HLS-11 case: ${String(caseName)}`);
}

function requirePort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("the HLS-11 fixture needs its exact port");
}
