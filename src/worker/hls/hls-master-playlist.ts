import { Buffer } from "node:buffer";

/**
 * Worker-owned CLEAR-HLS MASTER PLAYLIST parser
 * (HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * A pure, fail-closed reader that turns ONE already-fetched Master Playlist
 * text document into a small immutable model of exactly what the separate-audio
 * association proof needs: each variant's URI reference, the index of the
 * AUDIO rendition group it names (if any), and its declared resolution; and,
 * per AUDIO group, each member's URI reference (or `null` for an in-band
 * member). It performs no I/O of any kind: no network, no DNS, no filesystem,
 * no subprocess, no clock and no logging. Give it a string, get a frozen
 * structure or a thrown rejection.
 *
 * ─── Why it exists ──────────────────────────────────────────────────────────
 *
 * The pinned yt-dlp removes its internal audio-group id from every format
 * before `-J` prints, so analysis output cannot say which audio rendition
 * belongs to which video variant. The Master Playlist can: RFC 8216 §4.3.4.2
 * defines the `AUDIO` attribute of `EXT-X-STREAM-INF` as a reference to the
 * `GROUP-ID` of `EXT-X-MEDIA` renditions of `TYPE=AUDIO`. That standards-defined
 * relationship, in a master VideoFetch fetched itself, is the ONLY pairing
 * authority. This module reads it; it does not rank, prefer or guess.
 *
 * ─── What this module is NOT ────────────────────────────────────────────────
 *
 * It is NOT a general HLS master parser and NOT a rendition selector. It is a
 * CLOSED grammar holding only the constructs the association proof needs, and
 * every other construct fails closed. It is not a media-playlist parser either:
 * `hls-media-playlist.ts` stays the only media authority, refuses every master
 * tag, and this module refuses every media-playlist tag — so no document can be
 * accepted as both (`media_playlist`).
 *
 * It does not resolve references to network destinations. A reference is
 * retained as ORIGINAL TEXT; the pairing seam resolves it against the exact
 * master location it requested. What this module guarantees is that every
 * retained reference lies inside the JOIN-STABLE subset (below), where that
 * resolution is identical under the pinned yt-dlp's Python `urljoin` and the
 * Worker's WHATWG `URL`.
 *
 * ─── Privacy ────────────────────────────────────────────────────────────────
 *
 * Nothing descriptive survives. `GROUP-ID`, `NAME`, `LANGUAGE`, `CHANNELS`,
 * `CODECS`, bandwidths and frame rates are validated and dropped: groups are
 * identified by INDEX in the model, never by their upstream name, so no group
 * name, label or language can reach any later stage. Refusal messages come
 * from a fixed table and never interpolate document text.
 */

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * The largest master document this parser will read, in UTF-8 bytes: 256 KiB.
 *
 * Smaller than the 2 MiB media-playlist ceiling, deliberately. A master holds
 * no fragment list: at the admitted maxima below — 64 variants and 32 audio
 * renditions — a real master is a few tens of KiB, so 256 KiB leaves roughly
 * ten-fold headroom while bounding the text an ANALYSIS pass (which a browser
 * can trigger) may buffer per master. The pairing seam enforces the same bound
 * while receiving the body; this check is defence in depth.
 */
export const HLS_MASTER_MAX_PLAYLIST_BYTES = 256 * 1024;

/** The longest single line, in UTF-8 bytes. A tag line is an attribute list. */
export const HLS_MASTER_MAX_LINE_BYTES = 8 * 1024;

/** The most `EXT-X-STREAM-INF` variants one master may declare. */
export const HLS_MASTER_MAX_VARIANTS = 64;

/** The most `EXT-X-MEDIA` renditions one master may declare. */
export const HLS_MASTER_MAX_RENDITIONS = 32;

/** The most attributes one tag may carry. */
export const HLS_MASTER_MAX_ATTRIBUTES = 24;

/** The longest non-URI attribute value, in UTF-8 bytes. */
export const HLS_MASTER_MAX_ATTRIBUTE_VALUE_BYTES = 256;

/**
 * The longest URI reference — a variant line or a rendition `URI` — in UTF-8
 * bytes. The same 2 KiB a media-playlist fragment reference may use.
 */
export const HLS_MASTER_MAX_REFERENCE_BYTES = 2048;

// ── Closed tag vocabulary ────────────────────────────────────────────────────

/**
 * The ONLY tags a master may contain.
 *
 *   #EXTM3U                       the mandatory first line
 *   #EXT-X-VERSION                bounded sanity, once; validated and dropped
 *   #EXT-X-INDEPENDENT-SEGMENTS   exact no-value form, once; a statement about
 *                                 how media playlists were encoded that names
 *                                 no resource and no relationship: validated
 *                                 and dropped
 *   #EXT-X-MEDIA                  an alternative rendition; only TYPE=AUDIO is
 *                                 admitted
 *   #EXT-X-STREAM-INF             a variant, immediately followed by its URI line
 *
 * Every other tag is refused — RFC-defined or not.
 */
export const HLS_MASTER_ALLOWED_TAGS = Object.freeze([
  "#EXTM3U",
  "#EXT-X-VERSION",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  "#EXT-X-MEDIA",
  "#EXT-X-STREAM-INF",
] as const);

const ALLOWED_TAGS = new Set<string>(HLS_MASTER_ALLOWED_TAGS);

/**
 * Media-playlist tags. Their presence means the document is (also) a media
 * playlist, and a document is never accepted as both.
 */
const MEDIA_PLAYLIST_TAGS = new Set<string>([
  "#EXT-X-TARGETDURATION",
  "#EXT-X-MEDIA-SEQUENCE",
  "#EXT-X-DISCONTINUITY-SEQUENCE",
  "#EXT-X-ENDLIST",
  "#EXT-X-PLAYLIST-TYPE",
  "#EXT-X-I-FRAMES-ONLY",
  "#EXTINF",
  "#EXT-X-BYTERANGE",
  "#EXT-X-DISCONTINUITY",
  "#EXT-X-KEY",
  "#EXT-X-MAP",
  "#EXT-X-PROGRAM-DATE-TIME",
  "#EXT-X-DATERANGE",
  "#EXT-X-GAP",
  "#EXT-X-BITRATE",
  "#EXT-X-PART",
  "#EXT-X-PART-INF",
  "#EXT-X-SERVER-CONTROL",
  "#EXT-X-PRELOAD-HINT",
  "#EXT-X-RENDITION-REPORT",
  "#EXT-X-SKIP",
]);

/**
 * Master constructs RFC 8216 (and its successors) define that this grammar
 * refuses by name: trick-play variants, session data and keys, content
 * steering, variable definitions and start offsets. Each would either name a
 * further resource or change what a reference means, and the association proof
 * has no use for any of them.
 */
const REFUSED_MASTER_TAGS = new Set<string>([
  "#EXT-X-I-FRAME-STREAM-INF",
  "#EXT-X-SESSION-DATA",
  "#EXT-X-SESSION-KEY",
  "#EXT-X-CONTENT-STEERING",
  "#EXT-X-DEFINE",
  "#EXT-X-START",
]);

/** The only `EXT-X-STREAM-INF` attributes admitted. */
const VARIANT_ATTRIBUTES = new Set<string>([
  "BANDWIDTH",
  "AVERAGE-BANDWIDTH",
  "CODECS",
  "RESOLUTION",
  "FRAME-RATE",
  "AUDIO",
]);

/** The only `EXT-X-MEDIA` attributes admitted. */
const RENDITION_ATTRIBUTES = new Set<string>([
  "TYPE",
  "GROUP-ID",
  "NAME",
  "LANGUAGE",
  "ASSOC-LANGUAGE",
  "DEFAULT",
  "AUTOSELECT",
  "CHANNELS",
  "URI",
]);

/** The attributes whose RFC 8216 value type is quoted-string. */
const QUOTED_ATTRIBUTES = new Set<string>([
  "CODECS",
  "AUDIO",
  "GROUP-ID",
  "NAME",
  "LANGUAGE",
  "ASSOC-LANGUAGE",
  "CHANNELS",
  "URI",
]);

// ── Rejections ───────────────────────────────────────────────────────────────

/**
 * Why a document is not an acceptable master for the association proof.
 * Worker-private; never a public error code.
 */
export type ClearHlsMasterRejection =
  | "not_text"
  | "empty"
  | "too_large"
  | "byte_order_mark"
  | "malformed_line_ending"
  | "control_character"
  | "line_too_long"
  | "missing_extm3u"
  | "media_playlist"
  | "refused_tag"
  | "unknown_tag"
  | "duplicate_tag"
  | "malformed_tag_value"
  | "malformed_attribute_list"
  | "duplicate_attribute"
  | "too_many_attributes"
  | "unsupported_attribute"
  | "malformed_attribute_value"
  | "missing_attribute"
  | "unsupported_rendition_type"
  | "malformed_rendition_group"
  | "missing_audio_group"
  | "variant_without_codecs"
  | "invalid_uri_reference"
  | "stream_inf_without_uri"
  | "uri_without_stream_inf"
  | "no_variants"
  | "too_many_variants"
  | "too_many_renditions";

/** A FIXED message per rejection; there is no interpolation site. */
const REJECTION_MESSAGES: Record<ClearHlsMasterRejection, string> = {
  not_text: "master input is not text",
  empty: "master input is empty",
  too_large: "master exceeds the supported size",
  byte_order_mark: "master begins with a byte order mark",
  malformed_line_ending: "master has malformed line endings",
  control_character: "master contains a control character",
  line_too_long: "master has an overlong line",
  missing_extm3u: "master does not begin with the required header line",
  media_playlist: "document carries media playlist constructs",
  refused_tag: "master declares an unsupported construct",
  unknown_tag: "master contains an unsupported tag",
  duplicate_tag: "master repeats a single-occurrence tag",
  malformed_tag_value: "master contains a malformed tag value",
  malformed_attribute_list: "master contains a malformed attribute list",
  duplicate_attribute: "master repeats an attribute",
  too_many_attributes: "master tag carries too many attributes",
  unsupported_attribute: "master tag carries an unsupported attribute",
  malformed_attribute_value: "master contains a malformed attribute value",
  missing_attribute: "master tag lacks a required attribute",
  unsupported_rendition_type: "master declares an unsupported rendition type",
  malformed_rendition_group: "master declares an inconsistent rendition group",
  missing_audio_group: "master variant names an undeclared audio group",
  variant_without_codecs: "master variant names an audio group without declaring codecs",
  invalid_uri_reference: "master has an unsupported URI reference",
  stream_inf_without_uri: "master variant has no URI line",
  uri_without_stream_inf: "master has a URI line without a variant",
  no_variants: "master declares no variants",
  too_many_variants: "master declares too many variants",
  too_many_renditions: "master declares too many renditions",
};

export class ClearHlsMasterPlaylistError extends Error {
  readonly reason: ClearHlsMasterRejection;

  constructor(reason: ClearHlsMasterRejection) {
    super(REJECTION_MESSAGES[reason]);
    this.name = "ClearHlsMasterPlaylistError";
    this.reason = reason;
  }
}

function refuse(reason: ClearHlsMasterRejection): never {
  throw new ClearHlsMasterPlaylistError(reason);
}

// ── The parsed model ─────────────────────────────────────────────────────────

/** One variant, as the proof needs it. `reference` is ORIGINAL TEXT. */
export type ClearHlsMasterVariant = {
  readonly reference: string;
  /** Index into `audioGroups`, or `null` when the variant names no AUDIO group. */
  readonly audioGroup: number | null;
  /** The declared `RESOLUTION`, or `null` when none is declared. */
  readonly resolution: { readonly width: number; readonly height: number } | null;
};

/** One AUDIO rendition: its URI reference, or `null` for an in-band member. */
export type ClearHlsMasterAudioRendition = {
  readonly reference: string | null;
};

/**
 * The closed model. Groups are positions, not names: the upstream GROUP-ID is
 * consumed while associating and never stored.
 */
export type ClearHlsMasterPlaylist = {
  readonly variants: readonly ClearHlsMasterVariant[];
  readonly audioGroups: readonly (readonly ClearHlsMasterAudioRendition[])[];
};

// ── The join-stable reference grammar ────────────────────────────────────────

/**
 * The characters a reference may contain: RFC 3986 unreserved, `:` `/` `?`,
 * the sub-delims other than `'` and `;`, and `%` (only as a well-formed escape).
 *
 * Excluded on purpose, each because the two resolvers this proof must agree
 * between treat it differently or because it is outside a plain path/query:
 *   `#`      a fragment, meaningless to a fetch and ambiguous beside comments;
 *   `;`      path parameters: Python's `urljoin` drops an EMPTY `;` parameter
 *            that WHATWG keeps — a measured false cross-match;
 *   `'`      WHATWG percent-encodes it in an http(s) query, Python does not;
 *   `[` `]`  host-literal syntax, invalid in a path;
 *   `@`      userinfo syntax;
 * and every character RFC 3986 requires to be escaped (space, quotes, angle
 * brackets, braces, backslash, non-ASCII).
 */
const REFERENCE_CHARACTERS = /^[A-Za-z0-9\-._~:/?!$&()*+,=%]+$/;

/** A `%` that does not begin a well-formed `%XX` escape. */
const MALFORMED_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

/** An encoded dot, which WHATWG treats as a dot segment and Python does not. */
const ENCODED_DOT = /%2e/i;

/**
 * Is `path` (no query) a join-stable path: no dot segment, no empty segment
 * (so no `//` inside it and no trailing `/`), and no encoded dot?
 */
function joinStablePath(path: string, absolute: boolean): boolean {
  if (ENCODED_DOT.test(path)) return false;
  const segments = path.split("/");
  // An absolute path's leading "/" yields one empty first segment, which is
  // its root, not an empty segment.
  const first = absolute ? 1 : 0;
  if (segments.length <= first) return false;
  for (let i = first; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

/** Splits at the first `?` into a path and an optional non-empty query. */
function splitQuery(rest: string): { path: string; query: string | null } | null {
  const at = rest.indexOf("?");
  if (at === -1) return { path: rest, query: null };
  const query = rest.slice(at + 1);
  // An EMPTY query (`v.m3u8?`) is dropped by Python's `urljoin` and kept by
  // WHATWG — a measured false cross-match.
  if (query.length === 0) return null;
  return { path: rest.slice(0, at), query };
}

/**
 * Is `reference` inside the JOIN-STABLE subset: a URI reference whose
 * resolution against a join-stable absolute base is IDENTICAL under the pinned
 * yt-dlp's Python `urljoin` and the WHATWG `URL` parser?
 *
 * HLS-SEPARATE-AUDIO-PAIRING-DESIGN-001 measured the two resolvers against the
 * pinned runtime: unrestricted, they disagree on empty path segments, empty
 * queries and empty `;` parameters, and one of those disagreements produced a
 * FALSE cross-match (two different references resolving to one URL in one
 * resolver only). Under this subset — applied to the master URL as well — a
 * 469-row corpus gave 150/150 identical resolutions and zero false matches.
 *
 * Admitted forms, and nothing else:
 *   - absolute: lowercase `http://` or `https://`, a non-empty authority, then
 *     an absolute path, and the WHOLE reference already in WHATWG canonical
 *     form (so no uppercase host, default port or other spelling the two
 *     resolvers would normalise differently);
 *   - root-relative: `/segment/...`;
 *   - path-relative: `segment/...`, whose first segment has no `:` (so it can
 *     never read as a scheme);
 * each with a path of non-empty, non-dot segments, no encoded dot, and either
 * no query or a non-empty one. Scheme-relative (`//host`), query-only and empty
 * references are refused.
 */
export function isJoinStableReference(reference: string): boolean {
  if (typeof reference !== "string" || reference.length === 0) return false;
  if (!REFERENCE_CHARACTERS.test(reference)) return false;
  if (MALFORMED_ESCAPE.test(reference)) return false;

  const absolute = reference.match(/^(https?):\/\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (absolute !== null) {
    const pathAndQuery = reference.slice(`${absolute[1]}://${absolute[2]}`.length);
    if (pathAndQuery.length === 0 || !pathAndQuery.startsWith("/")) return false;
    const split = splitQuery(pathAndQuery);
    if (split === null || !joinStablePath(split.path, true)) return false;
    let canonical: string;
    try {
      canonical = new URL(reference).href;
    } catch {
      return false;
    }
    return canonical === reference;
  }

  // Any other scheme-shaped prefix, or a scheme-relative reference, is refused.
  if (reference.startsWith("//") || reference.startsWith("?")) return false;
  const split = splitQuery(reference);
  if (split === null || split.path.length === 0) return false;
  if (split.path.startsWith("/")) return joinStablePath(split.path, true);
  const firstSegment = split.path.split("/")[0] ?? "";
  if (firstSegment.includes(":")) return false;
  return joinStablePath(split.path, false);
}

// ── Attribute lists ──────────────────────────────────────────────────────────

/**
 * One RFC 8216 §4.2 attribute: an AttributeName, `=`, and a quoted-string or an
 * unquoted run without whitespace (no RFC 8216 unquoted value type contains
 * any). The unquoted alternative only TOKENISES ordinary values so they can be
 * type-checked by name; it never admits a value its attribute types as quoted.
 */
const ATTRIBUTE_PATTERN = /^([A-Z0-9-]+)=("[^"]*"|[^",\s]*)/;

const DECIMAL_INTEGER = /^\d{1,12}$/;
const DECIMAL_RESOLUTION = /^(\d{1,5})x(\d{1,5})$/;
const DECIMAL_FLOAT = /^\d{1,4}(?:\.\d{1,6})?$/;
const YES_NO = /^(?:YES|NO)$/;
/** A codec list: comma-separated RFC 6381 style tokens. */
const CODECS_VALUE = /^[A-Za-z0-9.+_-]+(?:,[A-Za-z0-9.+_-]+)*$/;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Tokenise and type-check one attribute list. Returns name -> value with the
 * quotes removed. Every refusal is a closed reason; nothing is echoed.
 */
function readAttributes(
  value: string | null,
  allowed: ReadonlySet<string>,
): Map<string, string> {
  if (value === null || value.length === 0) refuse("malformed_attribute_list");
  const raw = new Map<string, string>();
  let rest = value;
  for (;;) {
    const match = rest.match(ATTRIBUTE_PATTERN);
    if (match === null) refuse("malformed_attribute_list");
    const [whole, name, token] = match as unknown as [string, string, string];
    if (raw.has(name)) refuse("duplicate_attribute");
    if (raw.size >= HLS_MASTER_MAX_ATTRIBUTES) refuse("too_many_attributes");
    raw.set(name, token);
    rest = rest.slice(whole.length);
    if (rest.length === 0) break;
    if (!rest.startsWith(",")) refuse("malformed_attribute_list");
    rest = rest.slice(1);
    if (rest.length === 0) refuse("malformed_attribute_list");
  }

  const out = new Map<string, string>();
  for (const [name, token] of raw) {
    if (!allowed.has(name)) refuse("unsupported_attribute");
    const quoted = token.length >= 2 && token.startsWith('"') && token.endsWith('"');
    if (QUOTED_ATTRIBUTES.has(name) !== quoted) refuse("malformed_attribute_value");
    const inner = quoted ? token.slice(1, -1) : token;
    if (inner.length === 0) refuse("malformed_attribute_value");
    // A variable reference is meaningful only beside `EXT-X-DEFINE`, which is
    // refused; an unresolvable one is a parse error under RFC 8216 §4.3.
    if (inner.includes("{$")) refuse("malformed_attribute_value");
    if (name === "URI") {
      if (utf8Bytes(inner) > HLS_MASTER_MAX_REFERENCE_BYTES) refuse("invalid_uri_reference");
      if (!isJoinStableReference(inner)) refuse("invalid_uri_reference");
    } else if (utf8Bytes(inner) > HLS_MASTER_MAX_ATTRIBUTE_VALUE_BYTES) {
      refuse("malformed_attribute_value");
    }
    out.set(name, inner);
  }
  return out;
}

function requireMatch(value: string | undefined, pattern: RegExp): void {
  if (value !== undefined && !pattern.test(value)) refuse("malformed_attribute_value");
}

// ── The parser ───────────────────────────────────────────────────────────────

type PendingVariant = {
  readonly audio: string | null;
  readonly resolution: { readonly width: number; readonly height: number } | null;
};

type ParsedRendition = {
  readonly groupId: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly reference: string | null;
};

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0a) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function readVariant(value: string | null): PendingVariant {
  const attributes = readAttributes(value, VARIANT_ATTRIBUTES);
  const bandwidth = attributes.get("BANDWIDTH");
  if (bandwidth === undefined) refuse("missing_attribute");
  requireMatch(bandwidth, DECIMAL_INTEGER);
  requireMatch(attributes.get("AVERAGE-BANDWIDTH"), DECIMAL_INTEGER);
  requireMatch(attributes.get("FRAME-RATE"), DECIMAL_FLOAT);
  requireMatch(attributes.get("CODECS"), CODECS_VALUE);

  let resolution: PendingVariant["resolution"] = null;
  const declared = attributes.get("RESOLUTION");
  if (declared !== undefined) {
    const match = declared.match(DECIMAL_RESOLUTION);
    if (match === null) refuse("malformed_attribute_value");
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width <= 0 || height <= 0) refuse("malformed_attribute_value");
    resolution = Object.freeze({ width, height });
  }

  const audio = attributes.get("AUDIO") ?? null;
  // RFC 8216 §4.3.4.2: a variant that references a rendition group MUST
  // declare CODECS — and the pinned yt-dlp only marks a grouped video variant
  // audio-less when it does.
  if (audio !== null && !attributes.has("CODECS")) refuse("variant_without_codecs");
  return { audio, resolution };
}

function readRendition(value: string | null): ParsedRendition {
  const attributes = readAttributes(value, RENDITION_ATTRIBUTES);
  const type = attributes.get("TYPE");
  if (type === undefined) refuse("missing_attribute");
  if (type !== "AUDIO") refuse("unsupported_rendition_type");
  const groupId = attributes.get("GROUP-ID");
  const name = attributes.get("NAME");
  if (groupId === undefined || name === undefined) refuse("missing_attribute");
  requireMatch(attributes.get("DEFAULT"), YES_NO);
  requireMatch(attributes.get("AUTOSELECT"), YES_NO);
  const isDefault = attributes.get("DEFAULT") === "YES";
  // RFC 8216 §4.3.4.1: AUTOSELECT, when present, MUST be YES if DEFAULT is YES.
  if (isDefault && attributes.get("AUTOSELECT") === "NO") refuse("malformed_rendition_group");
  return { groupId, name, isDefault, reference: attributes.get("URI") ?? null };
}

/**
 * Read one master document into the closed model. Pure and synchronous; throws
 * `ClearHlsMasterPlaylistError` for anything outside the grammar and never
 * echoes any part of the input.
 */
export function parseClearHlsMasterPlaylist(input: string): ClearHlsMasterPlaylist {
  if (typeof input !== "string") refuse("not_text");
  if (input.length === 0) refuse("empty");
  if (input.charCodeAt(0) === 0xfeff) refuse("byte_order_mark");
  if (utf8Bytes(input) > HLS_MASTER_MAX_PLAYLIST_BYTES) refuse("too_large");

  const normalized = input.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) refuse("malformed_line_ending");
  if (hasControlCharacter(normalized)) refuse("control_character");

  const lines = normalized.split("\n");
  if (lines[0] !== "#EXTM3U") refuse("missing_extm3u");

  const seenOnce = new Set<string>();
  const variants: { reference: string; pending: PendingVariant }[] = [];
  const renditions: ParsedRendition[] = [];
  let pending: PendingVariant | null = null;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (utf8Bytes(line) > HLS_MASTER_MAX_LINE_BYTES) refuse("line_too_long");
    if (/^ *$/.test(line)) continue;

    if (line.startsWith("#")) {
      // A variant's URI line must FOLLOW its tag: nothing but blank lines may
      // separate them, not even a comment.
      if (pending !== null) refuse("stream_inf_without_uri");
      // Anything tag-shaped is held to the vocabulary; only prose is a comment.
      if (!/^#ext/i.test(line)) continue;

      const colon = line.indexOf(":");
      const name = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? null : line.slice(colon + 1);

      if (MEDIA_PLAYLIST_TAGS.has(name)) refuse("media_playlist");
      if (REFUSED_MASTER_TAGS.has(name)) refuse("refused_tag");
      if (!ALLOWED_TAGS.has(name)) refuse("unknown_tag");

      switch (name) {
        case "#EXTM3U":
          refuse("duplicate_tag");
          break;
        case "#EXT-X-VERSION":
          if (seenOnce.has(name)) refuse("duplicate_tag");
          seenOnce.add(name);
          if (value === null || !/^\d{1,2}$/.test(value)) refuse("malformed_tag_value");
          if (Number(value) < 1 || Number(value) > 10) refuse("malformed_tag_value");
          break;
        case "#EXT-X-INDEPENDENT-SEGMENTS":
          if (seenOnce.has(name)) refuse("duplicate_tag");
          seenOnce.add(name);
          if (value !== null) refuse("malformed_tag_value");
          break;
        case "#EXT-X-MEDIA":
          if (renditions.length >= HLS_MASTER_MAX_RENDITIONS) refuse("too_many_renditions");
          renditions.push(readRendition(value));
          break;
        case "#EXT-X-STREAM-INF":
          if (variants.length >= HLS_MASTER_MAX_VARIANTS) refuse("too_many_variants");
          pending = readVariant(value);
          break;
        default:
          refuse("unknown_tag");
      }
      continue;
    }

    // Anything else is a URI line, and it must belong to a variant.
    if (pending === null) refuse("uri_without_stream_inf");
    if (utf8Bytes(line) > HLS_MASTER_MAX_REFERENCE_BYTES) refuse("invalid_uri_reference");
    if (!isJoinStableReference(line)) refuse("invalid_uri_reference");
    variants.push({ reference: line, pending });
    pending = null;
  }
  if (pending !== null) refuse("stream_inf_without_uri");
  if (variants.length === 0) refuse("no_variants");

  // AUDIO groups, by first appearance. RFC 8216 §4.3.4.1.1: members of a group
  // have distinct NAMEs and at most one is DEFAULT.
  const groupIndex = new Map<string, number>();
  const groups: { name: string; isDefault: boolean; reference: string | null }[][] = [];
  for (const rendition of renditions) {
    let at = groupIndex.get(rendition.groupId);
    if (at === undefined) {
      at = groups.length;
      groupIndex.set(rendition.groupId, at);
      groups.push([]);
    }
    const members = groups[at]!;
    if (members.some((member) => member.name === rendition.name)) refuse("malformed_rendition_group");
    if (rendition.isDefault && members.some((member) => member.isDefault)) {
      refuse("malformed_rendition_group");
    }
    members.push({ name: rendition.name, isDefault: rendition.isDefault, reference: rendition.reference });
  }

  const model: ClearHlsMasterVariant[] = variants.map(({ reference, pending: variant }) => {
    let audioGroup: number | null = null;
    if (variant.audio !== null) {
      const at = groupIndex.get(variant.audio);
      if (at === undefined) refuse("missing_audio_group");
      audioGroup = at;
    }
    return Object.freeze({ reference, audioGroup, resolution: variant.resolution });
  });

  // Names and DEFAULT flags were consistency evidence only: only the URI
  // reference of each member survives.
  const audioGroups = groups.map((members) =>
    Object.freeze(members.map((member) => Object.freeze({ reference: member.reference }))),
  );

  return Object.freeze({
    variants: Object.freeze(model),
    audioGroups: Object.freeze(audioGroups),
  });
}
