// HLS-12 fixture addressing (HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001):
// one public-looking acceptance hostname, a closed per-case route table behind
// it, and the exact validator for the submitted page URLs.
//
// The reasoning is HLS-11's (`lib/hls11-fixture-url.mjs`), restated for a
// disjoint namespace so the children can never be confused in a ledger. Every
// Product-visible URL names ONE syntactically public hostname under the
// reserved `.invalid` TLD. Inside the `--network none` release container that
// name reaches the loopback fixture two ways only: the pinned yt-dlp through
// `/etc/hosts` (the one `--add-host` mapping below), and the Product's own
// safe-HTTP stack through the acceptance transport, which answers a synthetic
// PUBLIC address so the real private-address policy still runs and then
// re-points only the socket at loopback.
//
// HLS-12 adds one kind of Product request no earlier child admits: the
// separate-audio MASTER proof, which the Product makes itself during analysis.
//
// Plain ESM with NO import at all: the SPLIT-07 host driver reads the mapping
// through `lib/release-container.mjs` on an older Node.

/** The ONE acceptance hostname. Reserved TLD: it cannot resolve publicly. */
export const HLS12_FIXTURE_HOSTNAME = "hls12-fixture.example.invalid";

/** The one scheme. The fixture does not serve TLS. */
export const HLS12_FIXTURE_PROTOCOL = "http:";

/** Where the fixture service listens, inside the container. */
export const HLS12_FIXTURE_LOOPBACK = "127.0.0.1";

/** The `docker run --add-host` value for the pinned yt-dlp subprocess. */
export const HLS12_FIXTURE_HOST_MAPPING = `${HLS12_FIXTURE_HOSTNAME}:${HLS12_FIXTURE_LOOPBACK}`;

/** The synthetic public DNS answer the acceptance transport gives the Product. */
export const HLS12_SYNTHETIC_PUBLIC_ADDRESS = "8.8.8.8";

/**
 * The closed case vocabulary. Each case has its own page, master and media
 * directories, so every request is attributable to exactly one case.
 *
 * Positive (full jobs to `ready`):
 *   pos-audio-late       one packager; the audio starts ~0.48 s after the video
 *   pos-video-late       one packager; the video starts ~0.52 s after the audio
 *   ctl-aligned          two packagers; both halves start at exactly 0 (control)
 *
 * Master-proof negatives (analysis only; no preset may exist):
 *   neg-ambiguous-group  the selected variant's AUDIO group has TWO URI
 *                        renditions (Option A: no preference policy)
 *   neg-no-audio-group   the video-only variant names no AUDIO group
 *   neg-master-redirect  the master answers the PRODUCT with a 302 (yt-dlp
 *                        gets the master); the target must never be requested
 *   neg-master-changed   the master the Product fetches names a re-signed
 *                        video URL (a dynamic master): the selected variant is
 *                        absent from it
 *
 * Execution negatives (full jobs that must fail closed):
 *   neg-audio-ts         the paired audio playlist is MPEG-TS
 *   neg-video-muxed      the "video" playlist serves a muxed rendition
 *   neg-audio-video      the "audio" playlist serves a video-only rendition
 *   neg-budget           the ONE combined byte budget is one byte short
 *   neg-audio-map-404    the audio initialization map answers 404
 *   neg-deadline         (since `-02`) the ONE acquisition deadline: the video
 *                        half uses most of a narrowed budget, the audio map is
 *                        answered only after that deadline (`lib/hls12-deadline.mjs`)
 */
export const HLS12_POSITIVE_CASES = Object.freeze(["pos-audio-late", "pos-video-late", "ctl-aligned"]);
export const HLS12_MASTER_NEGATIVE_CASES = Object.freeze([
  "neg-ambiguous-group",
  "neg-no-audio-group",
  "neg-master-redirect",
  "neg-master-changed",
]);
export const HLS12_EXECUTION_NEGATIVE_CASES = Object.freeze([
  "neg-audio-ts",
  "neg-video-muxed",
  "neg-audio-video",
  "neg-budget",
  "neg-audio-map-404",
  "neg-deadline",
]);
export const HLS12_CASES = Object.freeze([
  ...HLS12_POSITIVE_CASES,
  ...HLS12_MASTER_NEGATIVE_CASES,
  ...HLS12_EXECUTION_NEGATIVE_CASES,
]);

/** Private-by-contract markers carried as signed `sig` query values. */
export const HLS12_PRIVATE_MARKER_PREFIX = "HLS12_PRIVATE_";

/** The rendition NAME; the pinned extractor builds format ids from it. */
export const HLS12_RAW_NAME_PREFIX = "HLS12_RAW_";

/** The AUDIO group id. */
export const HLS12_GROUP_PREFIX = "HLS12_GROUP_";

/** The rendition LANGUAGE. */
export const HLS12_LANGUAGE_PREFIX = "HLS12LANG-";

/** The route prefix every fixture path lives under. */
export const HLS12_ROUTE_PREFIX = "/hls12/";

/** The closed marker roles. */
export const HLS12_MARKER_ROLES = Object.freeze(["MASTER", "VIDEO", "AUDIO", "ALT", "RESIGNED"]);

const upper = (caseName) => caseName.toUpperCase().replaceAll("-", "_");

/** One case's private marker for one role. */
export function hls12Marker(caseName, role) {
  requireCase(caseName);
  if (!HLS12_MARKER_ROLES.includes(role)) throw new Error(`unknown HLS-12 marker role: ${String(role)}`);
  return `${HLS12_PRIVATE_MARKER_PREFIX}${upper(caseName)}_${role}`;
}

/** The sentinel GROUP-ID, NAME and LANGUAGE of one case. */
export function hls12GroupId(caseName) {
  requireCase(caseName);
  return `${HLS12_GROUP_PREFIX}${upper(caseName)}`;
}
export function hls12RenditionName(caseName) {
  requireCase(caseName);
  return `${HLS12_RAW_NAME_PREFIX}${upper(caseName)}`;
}
export function hls12Language(caseName) {
  requireCase(caseName);
  return `${HLS12_LANGUAGE_PREFIX}${upper(caseName)}`;
}

/** The relative references a master names. */
export function hls12MasterUri(caseName) {
  return `master.m3u8?sig=${hls12Marker(caseName, "MASTER")}`;
}
export function hls12VideoPlaylistUri(caseName, role = "VIDEO") {
  return `video/media.m3u8?sig=${hls12Marker(caseName, role)}`;
}
export function hls12AudioPlaylistUri(caseName) {
  return `audio/media.m3u8?sig=${hls12Marker(caseName, "AUDIO")}`;
}
export function hls12AltAudioPlaylistUri(caseName) {
  return `audio/alt.m3u8?sig=${hls12Marker(caseName, "ALT")}`;
}

/** Where the redirect negative's master points the Product. Never to be requested. */
export function hls12MovedMasterPath(caseName) {
  requireCase(caseName);
  return `${HLS12_ROUTE_PREFIX}${caseName}/moved/master.m3u8`;
}

export function hls12PagePath(caseName) {
  requireCase(caseName);
  return `${HLS12_ROUTE_PREFIX}${caseName}/watch.html`;
}

export function hls12FixtureOrigin(port) {
  requirePort(port);
  return `${HLS12_FIXTURE_PROTOCOL}//${HLS12_FIXTURE_HOSTNAME}:${port}`;
}

export function hls12PageUrl(port, caseName) {
  return `${hls12FixtureOrigin(port)}${hls12PagePath(caseName)}`;
}

const INIT_NAME = /^init(?:_[01])?\.mp4$/;
const FRAGMENT_NAME = /^seg-(\d{1,3})\.(m4s|ts)$/;
const ROLE_DIRECTORIES = new Set(["video", "audio"]);

/**
 * Classifies one request path (pathname plus optional query) against the
 * closed route table. Pure; never throws.
 *
 *   kind     page | master | master-moved | media | init | fragment | unexpected
 *   caseName the case the path belongs to
 *   role     video | audio | audio-alt for media, init and fragments; null otherwise
 *   variant  the case again, and `family` the role again: the two labels the
 *            shared acceptance transport copies into its ledger
 *   ordinal  1-based fragment position (FFmpeg names are 0-based)
 */
export function classifyHls12FixturePath(pathWithQuery) {
  const none = { kind: "unexpected", caseName: null, role: null, variant: null, family: null, ordinal: null };
  if (typeof pathWithQuery !== "string" || !pathWithQuery.startsWith(HLS12_ROUTE_PREFIX)) return none;
  let parsed;
  try {
    parsed = new URL(pathWithQuery, `${HLS12_FIXTURE_PROTOCOL}//${HLS12_FIXTURE_HOSTNAME}`);
  } catch {
    return none;
  }
  const { pathname, search, hash } = parsed;
  if (hash !== "") return none;
  const parts = pathname.slice(HLS12_ROUTE_PREFIX.length).split("/");
  const caseName = parts[0];
  if (!HLS12_CASES.includes(caseName)) return none;
  const found = (kind, extra = {}) => ({ ...none, kind, caseName, variant: caseName, family: extra.role ?? null, ...extra });
  const params = [...parsed.searchParams.entries()];
  const signedBy = (role) => params.length === 1 && params[0][0] === "sig" && params[0][1] === hls12Marker(caseName, role);

  if (parts.length === 2) {
    const leaf = parts[1];
    if (leaf === "watch.html" && search === "") return found("page");
    if (leaf === "master.m3u8" && signedBy("MASTER")) return found("master");
    return none;
  }
  if (parts.length !== 3) return none;
  const [, directory, leaf] = parts;
  if (directory === "moved" && leaf === "master.m3u8" && caseName === "neg-master-redirect" && search === "") {
    return found("master-moved");
  }
  if (!ROLE_DIRECTORIES.has(directory)) return none;
  if (leaf === "media.m3u8") {
    if (directory === "video" && (signedBy("VIDEO") || (caseName === "neg-master-changed" && signedBy("RESIGNED")))) {
      return found("media", { role: "video" });
    }
    if (directory === "audio" && signedBy("AUDIO")) return found("media", { role: "audio" });
    return none;
  }
  if (leaf === "alt.m3u8" && directory === "audio" && caseName === "neg-ambiguous-group" && signedBy("ALT")) {
    return found("media", { role: "audio-alt" });
  }
  if (INIT_NAME.test(leaf) && search === "") return found("init", { role: directory });
  const fragment = FRAGMENT_NAME.exec(leaf);
  if (fragment && search === "") return found("fragment", { role: directory, ordinal: Number(fragment[1]) + 1 });
  return none;
}

/**
 * The acceptance stand-in for Production's `assertSafeUrl`, for the SUBMITTED
 * PAGE URLs only: exactly the runtime-generated page URL of each case, spelled
 * canonically, and nothing near them. It proves NOTHING about SSRF policy.
 */
export function createHls12PageUrlValidator({ port, AppError }) {
  requirePort(port);
  if (typeof AppError !== "function") throw new Error("the page validator needs the Product AppError class");
  const admitted = new Set(HLS12_CASES.map((caseName) => hls12PageUrl(port, caseName)));
  const validate = async (raw) => {
    if (typeof raw !== "string" || !admitted.has(raw)) throw new AppError("INVALID_URL");
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new AppError("INVALID_URL");
    }
    if (url.protocol !== HLS12_FIXTURE_PROTOCOL || url.hostname !== HLS12_FIXTURE_HOSTNAME) {
      throw new AppError("INVALID_URL");
    }
    if (url.port !== String(port) || url.username !== "" || url.password !== "") throw new AppError("INVALID_URL");
    if (url.search !== "" || url.hash !== "") throw new AppError("INVALID_URL");
    return { url: raw, hostname: HLS12_FIXTURE_HOSTNAME };
  };
  validate.admitted = [...admitted];
  return validate;
}

/** Nearby alternatives the page validator must refuse, for one port. */
export function hls12NearbyPageUrlAlternatives(port) {
  requirePort(port);
  const host = HLS12_FIXTURE_HOSTNAME;
  const page = hls12PagePath("pos-audio-late");
  return Object.freeze([
    `https://${host}:${port}${page}`,
    `http://${host}:${port + 1}${page}`,
    `http://${HLS12_FIXTURE_LOOPBACK}:${port}${page}`,
    `http://localhost:${port}${page}`,
    `http://HLS12-FIXTURE.example.invalid:${port}${page}`,
    `http://${host}:${port}${HLS12_ROUTE_PREFIX}pos-audio-late/${hls12MasterUri("pos-audio-late")}`,
    `http://${host}:${port}${page}?x=1`,
    `http://${host}:${port}${page}#top`,
    `http://user:pw@${host}:${port}${page}`,
    `file://${page}`,
  ]);
}

function requireCase(caseName) {
  if (!HLS12_CASES.includes(caseName)) throw new Error(`unknown HLS-12 case: ${String(caseName)}`);
}

function requirePort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("the HLS-12 fixture needs its exact port");
}
