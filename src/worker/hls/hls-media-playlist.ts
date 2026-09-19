import { Buffer } from "node:buffer";

/**
 * Worker-owned CLEAR-HLS v1 MEDIA PLAYLIST parser (HLS-1).
 *
 * ─── What this module is ────────────────────────────────────────────────────
 *
 * A pure, fail-closed reader that turns ONE already-fetched media-playlist
 * text document into a small immutable application-owned plan. It performs no
 * I/O of any kind: no network, no DNS, no filesystem, no subprocess, no clock.
 * Give it a string, get a frozen structure or a thrown rejection.
 *
 * ─── What this module is NOT ────────────────────────────────────────────────
 *
 * It is NOT a general HLS implementation, and it is deliberately much stricter
 * than RFC 8216. It is not a master-playlist selector either: yt-dlp remains
 * the website-extraction and rendition-discovery authority, and this parser
 * only ever sees the single media playlist that authority already chose.
 *
 * It does not resolve fragment references to network destinations. A reference
 * is retained as the ORIGINAL TEXT exactly as the playlist wrote it, because
 * HLS-2 must resolve it against the FINAL validated response URL — the URL
 * after redirects — and resolving here against anything else would be wrong.
 *
 * ─── Dormancy ───────────────────────────────────────────────────────────────
 *
 * Nothing in Production calls this module. HLS remains unadvertised and
 * unselectable: the analyzer's protocol policy is unchanged, so `m3u8_native`
 * is still withheld as `unsupported_protocol`. This is foundation only.
 *
 * ─── The governing rule ─────────────────────────────────────────────────────
 *
 * Every construct outside the approved v1 subset FAILS CLOSED. The tag
 * vocabulary is an ALLOWLIST, never a denylist, so a tag nobody considered
 * cannot arrive and be tolerated. Reduced source coverage is the accepted
 * outcome; a silently mis-parsed manifest is not.
 *
 * The approved v1 subset (CLEAR-HLS-ACQUISITION-ARCHITECTURE-001-CORRECTION-002
 * §3, §11, §23): a media playlist, non-live finite VOD, MPEG-TS fragments,
 * unencrypted, no key or session key, no initialization map, no byte ranges, no
 * discontinuities, no fMP4, no audio pairing, no subtitles, no DRM, a bounded
 * finite fragment count, a closed tag vocabulary, and ordinary fragment URI
 * lines only.
 */

// ── Input bounds (§7, §17) ───────────────────────────────────────────────────

/**
 * The largest media-playlist document v1 will parse, in UTF-8 BYTES.
 *
 * Bytes, not `String.length`: a JavaScript string length counts UTF-16 code
 * units, which is not a byte count for anything outside ASCII. The two differ
 * in the permissive direction for non-ASCII input, so measuring code units
 * would let an oversized document through.
 *
 * HLS-2 must enforce the SAME ceiling while receiving the HTTP body, so an
 * oversized response can never be buffered whole before anyone looks at it.
 * The check here is defence in depth, not the primary bound.
 */
export const HLS_V1_MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

/** The largest fragment count v1 will acquire. Sequential transport, one job. */
export const HLS_V1_MAX_FRAGMENTS = 10_000;

/**
 * The longest single fragment reference v1 will carry, in UTF-8 bytes.
 *
 * Chosen deliberately, not inherited. Signed CDN references are legitimately
 * long — expiry, signature and key-id parameters commonly add several hundred
 * bytes — so the bound must sit well clear of them, while still refusing a
 * reference that could only be an attempt to push bulk data through a URI line.
 * 2 KiB is the conventional practical URL ceiling. If a real source is ever
 * withheld by it, that is the fail-closed outcome and a reason to revisit the
 * number with evidence, not to remove the bound.
 */
export const HLS_V1_MAX_FRAGMENT_REFERENCE_BYTES = 2048;

// ── Closed tag vocabulary (§15) ──────────────────────────────────────────────

/**
 * The ONLY tags a v1 clear-VOD media playlist may contain.
 *
 * Every entry is here because the closed transport has a use for it, and each
 * is justified individually below. A tag absent from this list is rejected even
 * if RFC 8216 defines it and even if it looks harmless.
 *
 *   #EXTM3U               the mandatory first line; proves the document is a
 *                         playlist at all
 *   #EXT-X-VERSION        bounded sanity only; the transport never branches on
 *                         the value, because every version-gated feature (byte
 *                         ranges, initialization maps, fMP4) is already refused
 *   #EXT-X-TARGETDURATION RFC-required in a media playlist; its presence is
 *                         part of what distinguishes one from a master playlist
 *   #EXT-X-MEDIA-SEQUENCE structural validation only, and NOT retained: the
 *                         transport iterates the fragment array in order and
 *                         performs no media-sequence arithmetic
 *   #EXT-X-PLAYLIST-TYPE  accepted ONLY as exactly VOD; EVENT is live-shaped
 *   #EXTINF               required before every fragment; it is what makes a
 *                         URI line a declared media fragment rather than a
 *                         loose line of text
 *   #EXT-X-ENDLIST        required; it is the proof that the playlist is finite
 *                         and will not be reloaded
 */
export const HLS_V1_ALLOWED_TAGS = Object.freeze([
  "#EXTM3U",
  "#EXT-X-VERSION",
  "#EXT-X-TARGETDURATION",
  "#EXT-X-MEDIA-SEQUENCE",
  "#EXT-X-PLAYLIST-TYPE",
  "#EXTINF",
  "#EXT-X-ENDLIST",
] as const);

const ALLOWED_TAGS = new Set<string>(HLS_V1_ALLOWED_TAGS);

/**
 * Tags that get their OWN rejection reason instead of the generic unknown-tag
 * one.
 *
 * Every one of these would be refused by the allowlist regardless. They are
 * named here purely so the refusal is diagnosable and so each prohibition is
 * pinned by a test that cannot pass by accident — if someone were ever to add
 * one of these to the allowlist, its dedicated test would fail loudly rather
 * than the whole thing sliding through a generic "unknown tag" path.
 */
const EXPLICITLY_REFUSED_TAGS = new Map<string, ClearHlsPlaylistRejection>([
  // §11 — encryption is categorically forbidden. The rule is deliberately
  // simpler than yt-dlp's: ANY key line is an unsupported v1 playlist, whatever
  // its METHOD, URI, KEYFORMAT or KEYFORMATVERSIONS says, including METHOD=NONE.
  // No key URI is ever parsed, retained, resolved, fetched or exposed.
  ["#EXT-X-KEY", "encrypted"],
  ["#EXT-X-SESSION-KEY", "encrypted"],
  // §12 — an initialization map means fMP4, not the TS concatenation v1 does.
  ["#EXT-X-MAP", "initialization_map"],
  // §13 — byte ranges would require Range request semantics. The transport is
  // ordinary whole-response streaming only.
  ["#EXT-X-BYTERANGE", "byte_range"],
  // §14 — a discontinuity means more than one concatenation program. v1
  // produces exactly one muxed TS stream.
  ["#EXT-X-DISCONTINUITY", "discontinuity"],
  ["#EXT-X-DISCONTINUITY-SEQUENCE", "discontinuity"],
  // §9 — master/multivariant constructs. This parser is not a rendition
  // selector; yt-dlp already made that choice.
  ["#EXT-X-STREAM-INF", "master_playlist"],
  ["#EXT-X-I-FRAME-STREAM-INF", "master_playlist"],
  ["#EXT-X-MEDIA", "master_playlist"],
  ["#EXT-X-SESSION-DATA", "master_playlist"],
]);

// ── Rejections (§22) ─────────────────────────────────────────────────────────

/**
 * Why a document is not an acceptable v1 clear-VOD media playlist.
 *
 * Worker-private and deliberately NOT a public error code. HLS-6 will map every
 * value here onto the existing `FORMAT_UNAVAILABLE`, which is the honest public
 * statement; the granularity below exists for tests and Worker-side reasoning,
 * and adding a public code in HLS-1 would advertise a capability that does not
 * exist yet.
 */
export type ClearHlsPlaylistRejection =
  | "not_text"
  | "empty"
  | "too_large"
  | "byte_order_mark"
  | "malformed_line_ending"
  | "control_character"
  | "missing_extm3u"
  | "master_playlist"
  | "encrypted"
  | "initialization_map"
  | "byte_range"
  | "discontinuity"
  | "live_or_event"
  | "missing_endlist"
  | "content_after_endlist"
  | "missing_targetduration"
  | "unknown_tag"
  | "duplicate_tag"
  | "malformed_tag_value"
  | "fragment_without_extinf"
  | "extinf_without_fragment"
  | "invalid_fragment_reference"
  | "fragment_reference_too_long"
  | "no_fragments"
  | "too_many_fragments";

/**
 * The message for each rejection — a FIXED literal, looked up by reason.
 *
 * This table is the mechanism that makes the privacy rule structural rather
 * than a matter of remembering. Because a message is only ever read from here,
 * no offending fragment reference, key URI, tag value or playlist line can
 * reach an error string: there is no interpolation site to misuse. Nor does a
 * message name a line number, which would localise the offending text for
 * anyone holding the document.
 */
const REJECTION_MESSAGES: Record<ClearHlsPlaylistRejection, string> = {
  not_text: "playlist input is not text",
  empty: "playlist input is empty",
  too_large: "playlist exceeds the supported size",
  byte_order_mark: "playlist begins with a byte order mark",
  malformed_line_ending: "playlist has malformed line endings",
  control_character: "playlist contains a control character",
  missing_extm3u: "playlist does not begin with the required header line",
  master_playlist: "document is a master playlist, not a media playlist",
  encrypted: "playlist declares encryption",
  initialization_map: "playlist declares an initialization map",
  byte_range: "playlist declares a byte range",
  discontinuity: "playlist declares a discontinuity",
  live_or_event: "playlist is not a finite VOD playlist",
  missing_endlist: "playlist is not terminated",
  content_after_endlist: "playlist has content after its terminator",
  missing_targetduration: "playlist declares no target duration",
  unknown_tag: "playlist contains an unsupported tag",
  duplicate_tag: "playlist repeats a single-occurrence tag",
  malformed_tag_value: "playlist contains a malformed tag value",
  fragment_without_extinf: "playlist has a fragment without media metadata",
  extinf_without_fragment: "playlist has media metadata without a fragment",
  invalid_fragment_reference: "playlist has an invalid fragment reference",
  fragment_reference_too_long: "playlist has an overlong fragment reference",
  no_fragments: "playlist declares no fragments",
  too_many_fragments: "playlist declares too many fragments",
};

/**
 * A refusal to accept a document as a v1 clear-VOD media playlist.
 *
 * Private to the Worker's HLS module set. It carries a closed `reason` and a
 * message drawn only from the fixed table above.
 */
export class ClearHlsPlaylistError extends Error {
  readonly reason: ClearHlsPlaylistRejection;

  constructor(reason: ClearHlsPlaylistRejection) {
    super(REJECTION_MESSAGES[reason]);
    this.name = "ClearHlsPlaylistError";
    this.reason = reason;
  }
}

function refuse(reason: ClearHlsPlaylistRejection): never {
  throw new ClearHlsPlaylistError(reason);
}

// ── The parsed model (§6) ────────────────────────────────────────────────────

/**
 * One approved media fragment, as the playlist wrote it.
 *
 * `reference` is ORIGINAL TEXT, never a URL and never resolved. It is a wrapper
 * rather than a bare string so nothing can mistake it for something already
 * validated as a network destination: only HLS-2, resolving against the final
 * validated response URL, may turn this into a destination.
 *
 * Nothing else from the fragment's playlist entry survives — not its duration,
 * not its `#EXTINF` title, not its index.
 */
export type ClearHlsFragmentReference = {
  readonly reference: string;
};

/**
 * The closed v1 acquisition model.
 *
 * Intentionally tiny. No raw manifest text, no tag map, no key material, no
 * arbitrary metadata, no selector strings — nothing that would let a later
 * stage re-interpret the manifest instead of using what was approved here.
 *
 * `segmentType` is a private literal, not an upstream value: v1 accepts exactly
 * one segment type, and writing it down keeps the downstream `-f mpegts` remux
 * honest about what it is being handed.
 */
export type ClearHlsMediaPlaylist = {
  readonly segmentType: "mpegts";
  readonly fragments: readonly ClearHlsFragmentReference[];
  readonly fragmentCount: number;
};

// ── Lexical grammar (§8, §17, §19, §20) ──────────────────────────────────────

/**
 * True when `value` holds any C0 control or DEL other than the line feed that
 * separates lines.
 *
 * A character-code scan rather than a control-character regex, as elsewhere in
 * the repository: a regex spelling these characters is both a lint violation
 * and a place where an invisible raw byte can end up in the source.
 *
 * Tab is refused with the rest: it carries no meaning in the approved subset,
 * and admitting it would mean deciding what a tab means inside a URI line.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0a) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A line that separates content and means nothing: empty, or spaces only. */
const BLANK_LINE_PATTERN = /^ *$/;

/**
 * The characters a fragment reference may contain: exactly the RFC 3986 URI
 * set, minus `#`.
 *
 * Unreserved, gen-delims, sub-delims and the percent sign are all admitted, so
 * ordinary query strings and signed parameters pass untouched — a signed
 * reference must never be rejected merely for carrying a signature, nor
 * rewritten, trimmed or normalised.
 *
 * `#` is excluded because a URI fragment identifier is meaningless to a media
 * fetch and ambiguous next to the comment syntax of the surrounding document.
 * Backslash, quotes, angle brackets, braces, whitespace and every non-ASCII
 * character are excluded because RFC 3986 requires percent-encoding for them,
 * and a reference that skipped that is exactly the kind of thing that resolves
 * differently in two parsers.
 */
const FRAGMENT_REFERENCE_PATTERN = /^[A-Za-z0-9\-._~:/?[\]@!$&'()*+,;=%]+$/;

/** A plain non-negative decimal. Rejects signs, exponents and bare dots. */
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

/** A plain non-negative integer. */
const INTEGER_PATTERN = /^\d+$/;

/**
 * The longest run of digits accepted before a value is parsed.
 *
 * `Number` will happily turn a 40-digit string into a rounded float, so the
 * digit count is bounded BEFORE the conversion rather than checking the result
 * afterwards, and the safe-integer assertion below is then meaningful.
 */
const MAX_INTEGER_DIGITS = 15;

/**
 * `#EXT-X-VERSION` values v1 will tolerate.
 *
 * The transport never branches on the version. The bound exists only so an
 * absurd or non-numeric value fails closed; every feature a high version would
 * signal is already refused on its own terms.
 */
const MIN_PLAYLIST_VERSION = 1;
const MAX_PLAYLIST_VERSION = 10;

/** A target duration, in seconds, beyond which the document is not credible. */
const MAX_TARGET_DURATION_SECONDS = 86_400;

/** A single fragment duration, in seconds, beyond which the same applies. */
const MAX_FRAGMENT_DURATION_SECONDS = 86_400;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Split a tag line into its name and its optional value.
 *
 * Attribute-valued tags split at the FIRST colon, because an attribute list may
 * itself contain colons inside a quoted URI.
 */
function splitTag(line: string): { name: string; value: string | null } {
  const colon = line.indexOf(":");
  if (colon === -1) return { name: line, value: null };
  return { name: line.slice(0, colon), value: line.slice(colon + 1) };
}

function requireBoundedInteger(
  value: string | null,
  min: number,
  max: number,
): number {
  if (value === null) refuse("malformed_tag_value");
  if (!INTEGER_PATTERN.test(value)) refuse("malformed_tag_value");
  if (value.length > MAX_INTEGER_DIGITS) refuse("malformed_tag_value");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) refuse("malformed_tag_value");
  if (parsed < min || parsed > max) refuse("malformed_tag_value");
  return parsed;
}

/**
 * Validate an `#EXTINF` payload: `<duration>` or `<duration>,<title>`.
 *
 * The duration is checked only so a malformed entry cannot masquerade as a
 * valid fragment declaration. It is NOT a security authority — the byte limits
 * in HLS-3 bound acquisition, not any duration claimed here — and it is not
 * retained. The title is discarded without being inspected: it is arbitrary
 * upstream text and has no place in an application-owned model.
 */
function validateExtinf(value: string | null): void {
  if (value === null) refuse("malformed_tag_value");
  const comma = value.indexOf(",");
  const duration = comma === -1 ? value : value.slice(0, comma);
  if (!DECIMAL_PATTERN.test(duration)) refuse("malformed_tag_value");
  if (duration.length > MAX_INTEGER_DIGITS) refuse("malformed_tag_value");
  const parsed = Number(duration);
  if (!Number.isFinite(parsed)) refuse("malformed_tag_value");
  if (parsed < 0 || parsed > MAX_FRAGMENT_DURATION_SECONDS) {
    refuse("malformed_tag_value");
  }
}

function validateFragmentReference(line: string): void {
  if (line.length === 0) refuse("invalid_fragment_reference");
  if (line !== line.trim()) refuse("invalid_fragment_reference");
  if (utf8Bytes(line) > HLS_V1_MAX_FRAGMENT_REFERENCE_BYTES) {
    refuse("fragment_reference_too_long");
  }
  if (!FRAGMENT_REFERENCE_PATTERN.test(line)) refuse("invalid_fragment_reference");
}

// ── The parser (§6) ──────────────────────────────────────────────────────────

/**
 * Read one media-playlist document into the closed v1 model.
 *
 * Pure and synchronous. Throws `ClearHlsPlaylistError` for anything outside the
 * approved subset, and never echoes any part of the input in doing so.
 */
export function parseClearHlsMediaPlaylist(input: string): ClearHlsMediaPlaylist {
  // A runtime guard even though the parameter is typed: HLS-2 will hand this an
  // HTTP response body, and the type system does not reach across that.
  if (typeof input !== "string") refuse("not_text");
  if (input.length === 0) refuse("empty");

  // RFC 8216 §4 forbids a byte order mark outright, so refusing one is both
  // spec-exact and fail-closed. Stripping it would mean repairing a document
  // that already told us it was not written to the rules we are relying on.
  if (input.charCodeAt(0) === 0xfeff) refuse("byte_order_mark");

  if (utf8Bytes(input) > HLS_V1_MAX_PLAYLIST_BYTES) refuse("too_large");

  // CRLF is normalised; a bare CR is malformed and is NOT silently repaired.
  const normalized = input.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) refuse("malformed_line_ending");
  if (hasControlCharacter(normalized)) refuse("control_character");

  const lines = normalized.split("\n");

  // The header must be the literal FIRST line, which is stricter than "the
  // first line that means anything": RFC 8216 §4.3.1.1 requires exactly that,
  // and anything ahead of it is a document we do not recognise.
  if (lines[0] !== "#EXTM3U") refuse("missing_extm3u");

  const fragments: ClearHlsFragmentReference[] = [];
  const seenTags = new Set<string>(["#EXTM3U"]);

  let sawTargetDuration = false;
  let sawEndList = false;
  let pendingExtinf = false;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (BLANK_LINE_PATTERN.test(line)) continue;

    if (line.startsWith("#")) {
      // An ordinary comment is ignorable ONLY because it cannot influence
      // acquisition. Anything that even looks like a tag must not slip through
      // this door, so a line whose prefix matches `#EXT` in any case is held to
      // the allowlist rather than treated as prose.
      if (!/^#ext/i.test(line)) continue;

      const { name, value } = splitTag(line);

      const refusal = EXPLICITLY_REFUSED_TAGS.get(name);
      if (refusal !== undefined) refuse(refusal);

      if (!ALLOWED_TAGS.has(name)) refuse("unknown_tag");

      // Nothing may follow the terminator. A fragment after it would mean the
      // document disagrees with itself about being finite.
      if (sawEndList) refuse("content_after_endlist");

      // §21 — every allowed tag except `#EXTINF` occurs at most once, and a
      // repeat is refused whether or not it contradicts the first. Choosing
      // first-wins or last-wins would be inventing a rule the transport does
      // not need and cannot verify.
      if (name !== "#EXTINF") {
        if (seenTags.has(name)) refuse("duplicate_tag");
        seenTags.add(name);
      }

      // `#EXTM3U` needs no case below: line 0 seeded `seenTags`, so a repeat is
      // already refused by the duplicate guard above.
      switch (name) {
        case "#EXT-X-VERSION":
          requireBoundedInteger(value, MIN_PLAYLIST_VERSION, MAX_PLAYLIST_VERSION);
          break;
        case "#EXT-X-TARGETDURATION":
          requireBoundedInteger(value, 1, MAX_TARGET_DURATION_SECONDS);
          sawTargetDuration = true;
          break;
        case "#EXT-X-MEDIA-SEQUENCE":
          // Validated, then discarded: the transport iterates the fragment
          // array in order and performs no media-sequence arithmetic.
          requireBoundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
          break;
        case "#EXT-X-PLAYLIST-TYPE":
          // EVENT means segments may still be appended — live-shaped, and
          // outside the finite-VOD subset whatever else the document says.
          if (value !== "VOD") refuse("live_or_event");
          break;
        case "#EXTINF":
          if (pendingExtinf) refuse("extinf_without_fragment");
          validateExtinf(value);
          pendingExtinf = true;
          break;
        case "#EXT-X-ENDLIST":
          if (value !== null) refuse("malformed_tag_value");
          if (pendingExtinf) refuse("extinf_without_fragment");
          sawEndList = true;
          break;
        default:
          refuse("unknown_tag");
      }
      continue;
    }

    // Anything else is a media fragment reference.
    if (sawEndList) refuse("content_after_endlist");
    if (!pendingExtinf) refuse("fragment_without_extinf");
    validateFragmentReference(line);
    if (fragments.length >= HLS_V1_MAX_FRAGMENTS) refuse("too_many_fragments");
    fragments.push(Object.freeze({ reference: line }));
    pendingExtinf = false;
  }

  if (pendingExtinf) refuse("extinf_without_fragment");
  if (!sawTargetDuration) refuse("missing_targetduration");
  if (!sawEndList) refuse("missing_endlist");
  if (fragments.length === 0) refuse("no_fragments");

  // §23 — the plan, its fragment collection and every entry are frozen, so a
  // later stage cannot edit the approved set between approval and acquisition.
  return Object.freeze({
    segmentType: "mpegts",
    fragments: Object.freeze(fragments),
    fragmentCount: fragments.length,
  });
}
