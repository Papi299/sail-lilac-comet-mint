import { z } from "zod";

/**
 * Worker-owned GENERIC SOURCE SELECTION primitives (Phase 10C3).
 *
 * This module owns the one place in the repository where a raw upstream yt-dlp
 * `format_id` is permitted to exist — and the rules that make that safe.
 *
 * ─── The governing statement ────────────────────────────────────────────────
 *
 * A raw yt-dlp `format_id` may exist only inside a private Worker
 * execution-analysis structure. It is never browser-facing, never durable,
 * never request-controlled, never logged, and never passed to yt-dlp without
 * strict validation and application-owned selector construction.
 *
 * This deliberately REPLACES the stronger Phase-10C2 claim that "no variable
 * ever holds a format_id". That claim was true only because execution did not
 * exist yet. It stops being true here, and pretending otherwise would be worse
 * than stating the real boundary.
 *
 * Nothing in this module performs I/O, spawns a process, or touches the
 * network. It is pure, so the selector grammar can be exhaustively tested.
 */

// ── Safe internal raw format id grammar (§11) ────────────────────────────────

/**
 * The ONLY shape an upstream `format_id` may have to become executable.
 *
 * Strict ASCII, no separators, no quoting characters, no whitespace, no
 * control characters, bounded length. Everything that carries meaning inside
 * yt-dlp's own format-selector grammar is excluded:
 *
 *   `/`  choice/fallback          `+`  merge            `,`  selector list
 *   `[`  `]`  filter delimiters   `(`  `)`  grouping
 *   `"`  `'`  filter value quotes `:`  downloader/protocol prefixes
 *   `\`  filter value escapes     whitespace, controls
 *
 * A candidate whose upstream id does not match is NOT executable and must not
 * produce an advertised generic preset. Reduced site capability is the
 * accepted outcome; a selector-injection surface is not.
 */
export const SAFE_FORMAT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export const SafeFormatIdSchema = z
  .string()
  .regex(SAFE_FORMAT_ID_PATTERN, "unsafe upstream format id");

export type SafeFormatId = z.infer<typeof SafeFormatIdSchema>;

/** True when an upstream id satisfies the approved literal grammar. */
export function isSafeFormatId(value: unknown): value is SafeFormatId {
  return typeof value === "string" && SAFE_FORMAT_ID_PATTERN.test(value);
}

// ── Source protocol policy (§16) ─────────────────────────────────────────────

/**
 * The only source protocols generic v1 may acquire, unchanged from Phase 10C2.
 *
 * Re-exported through this module so the download path and the analysis path
 * cannot drift onto two different lists. Native HLS stays excluded: `HlsFD`
 * decides at DOWNLOAD time, from manifest bytes analysis never fetched, whether
 * to delegate to `FFmpegFD` — which would run local media work while the
 * durable job still says `downloading`.
 */
export const GENERIC_SOURCE_PROTOCOLS = Object.freeze(["http", "https"] as const);

export const GenericSourceProtocolSchema = z.enum(["http", "https"]);
export type GenericSourceProtocol = z.infer<typeof GenericSourceProtocolSchema>;

// ── Source container allowlist (§15) ─────────────────────────────────────────

/**
 * The closed set of SOURCE containers a generic VIDEO candidate may use.
 *
 * Deliberately just two. Phase-10 v1 keeps one muxed source verbatim, so the
 * source container becomes the delivered container, the output extension, and
 * the MIME decision. Exotic video containers buy nothing here and would widen
 * all three at once.
 */
export const GENERIC_VIDEO_SOURCE_CONTAINERS = Object.freeze(["mp4", "webm"] as const);

/**
 * The closed set of SOURCE containers a generic AUDIO-ONLY candidate may use.
 *
 * Wider than video because an audio-only source may be kept verbatim, and
 * these are the containers the product already knows how to name and serve.
 */
export const GENERIC_AUDIO_SOURCE_CONTAINERS = Object.freeze([
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "aac",
  "flac",
  "wav",
  "webm",
] as const);

export const GenericVideoSourceContainerSchema = z.enum(GENERIC_VIDEO_SOURCE_CONTAINERS);
export const GenericAudioSourceContainerSchema = z.enum(GENERIC_AUDIO_SOURCE_CONTAINERS);

/** Every container that may appear as a generic SOURCE, video or audio. */
export const GENERIC_SOURCE_CONTAINERS = Object.freeze([
  ...new Set<string>([
    ...GENERIC_VIDEO_SOURCE_CONTAINERS,
    ...GENERIC_AUDIO_SOURCE_CONTAINERS,
  ]),
] as readonly string[]);

export const GenericSourceContainerSchema = z.enum([
  "mp4",
  "webm",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "aac",
  "flac",
  "wav",
]);
export type GenericSourceContainer = z.infer<typeof GenericSourceContainerSchema>;

/**
 * An upstream extension is never defaulted for generic execution.
 *
 * Phase-10C2 analysis defaults a missing `ext` to `"mp4"` when merely
 * DESCRIBING a format, which is harmless for a preset label. For EXECUTION it
 * is not: the extension becomes the acquired file's real suffix and the
 * `[ext=...]` selector constraint, so an unknown or absent container must make
 * the candidate non-executable rather than silently become mp4 (§15).
 */
export function toGenericSourceContainer(
  ext: string | null | undefined,
  shape: { readonly hasVideo: boolean },
): GenericSourceContainer | null {
  if (typeof ext !== "string" || ext.length === 0) return null;
  const normalized = ext.toLowerCase();
  const allowed = shape.hasVideo
    ? (GENERIC_VIDEO_SOURCE_CONTAINERS as readonly string[])
    : (GENERIC_AUDIO_SOURCE_CONTAINERS as readonly string[]);
  if (!allowed.includes(normalized)) return null;
  const parsed = GenericSourceContainerSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

// ── The private execution source descriptor ──────────────────────────────────

/**
 * One validated, EXECUTABLE generic source.
 *
 * This is the private structure the governing statement refers to. It carries
 * the single raw upstream identifier the Worker is willing to act on, plus the
 * exact properties that approval was based on.
 *
 * It must never cross Worker HTTP, enter `WorkerVideoMetadata`, enter SQLite,
 * reach Vercel, reach browser JSON, be logged, or appear in an error message.
 */
export const GenericSourceSelectionSchema = z
  .object({
    /** The one raw upstream id, already proven to match the safe grammar. */
    formatId: SafeFormatIdSchema,
    protocol: GenericSourceProtocolSchema,
    container: GenericSourceContainerSchema,
    hasVideo: z.boolean(),
    hasAudio: z.boolean(),
    /** Known upstream size, when the extractor reported one. Never trusted alone. */
    fileSize: z.number().int().positive().nullable(),
  })
  .strict();

export type GenericSourceSelection = z.infer<typeof GenericSourceSelectionSchema>;

/**
 * The private per-preset selection map produced by execution analysis.
 *
 * Keyed by the APPLICATION preset id the browser may request. The values are
 * the private descriptors above.
 */
export type GenericSourceSelections = Readonly<Record<string, GenericSourceSelection>>;

// ── Selector construction (§12/§13/§14) ──────────────────────────────────────

/**
 * The base atom every generic selector is built on: `b*`.
 *
 * This is an APPLICATION-OWNED LITERAL, never derived from upstream data.
 * Verified against yt-dlp 2026.08.19's `build_format_selector`:
 *
 *   mobj = re.match(r'(?P<bw>best|worst|b|w)(?P<type>video|audio|v|a)?'
 *                   r'(?P<mod>\*)?(?:\.(?P<n>[1-9]\d*))?$', format_spec)
 *   format_fallback = not format_type and not format_modified   # for b, w
 *   _filter_f = ... else lambda f: True   # b*, w*
 *
 * So `b*`:
 *   - sets `format_modified`, hence `_filter_f` is `lambda f: True` — it
 *     imposes NO stream-shape restriction of its own, leaving every shape
 *     decision to this module's explicit filters;
 *   - sets `format_fallback = False` — it can NEVER fall back to a different
 *     format when the filtered set is empty.
 *
 * Both properties matter. An OMITTED atom is not neutral: `_parse_format_selection`
 * does `if not current_selector: current_selector = FormatSelector(SINGLE, 'best', [])`,
 * and bare `best` both requires a muxed format (so an audio-only source selects
 * NOTHING) and enables `format_fallback`, whose behaviour depends on the
 * extractor-controlled `incomplete_formats` flag. `b*` has neither problem.
 */
export const GENERIC_FORMAT_SELECTOR_ATOM = "b*";

/**
 * Quotes a value for a yt-dlp string filter.
 *
 * The quoting is MANDATORY, not cosmetic. `_build_format_filter` tries a
 * NUMERIC regex first:
 *
 *   (?P<key>[\w.-]+)\s*(?P<op>=|!=|<|<=|>|>=)(...)?\s*
 *   (?P<value>[0-9.]+(?:[kKmMgGtTpPeEzZyY]i?[Bb]?)?)\s*
 *
 * An unquoted purely numeric id — `[format_id=22]`, and numeric ids are
 * extremely common — FULLMATCHES that branch, so yt-dlp does
 * `float("22") -> 22.0` and then compares `operator.eq("22", 22.0)`, which is
 * False in Python. The filter silently matches NOTHING.
 *
 * Quoting defeats the numeric branch (its value group admits no quote
 * character), so parsing falls through to `STR_OPERATORS`, where `=` is
 * `operator.eq` on the STRINGS. That is the exact equality this design needs.
 *
 * The value is safe to wrap because `SAFE_FORMAT_ID_PATTERN` already excludes
 * `"`, `'` and `\`, the only characters that could terminate or escape out of
 * the quoted region. Callers must pass values that satisfy that grammar (or
 * one of the closed literal vocabularies above); this is asserted, not assumed.
 */
function quoteFilterValue(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    // Unreachable through the public API: every caller passes either a
    // grammar-checked id or a member of a closed literal enum. It exists so a
    // future edit cannot introduce an injection by widening a caller.
    throw new Error("refusing to quote a value outside the safe filter grammar");
  }
  return `"${value}"`;
}

/**
 * Builds the COMPLETE `--format` expression for one approved generic source.
 *
 * The expression binds every property the source was approved on, not just its
 * id, because acquisition re-runs extraction and the site may have changed in
 * between. If the same id then resolves to a different protocol, container or
 * stream shape, the selector matches nothing and the job fails
 * `FORMAT_UNAVAILABLE` — rather than silently acquiring materially different
 * media (§14/§27).
 *
 * Structurally guaranteed absent, and asserted by tests:
 *   - no bare raw-id atom (`-f <id>`), whose special-cased vocabulary
 *     (`best`, `worst`, `all`, `mergeall`, extension names) an upstream id
 *     could collide with (§12);
 *   - no `/` fallback — one source or none;
 *   - no `+` merge — generic v1 never merges split streams.
 */
export function buildGenericFormatSelector(selection: GenericSourceSelection): string {
  const parsed = GenericSourceSelectionSchema.parse(selection);

  const filters = [
    `[format_id=${quoteFilterValue(parsed.formatId)}]`,
    `[protocol=${quoteFilterValue(parsed.protocol)}]`,
    `[ext=${quoteFilterValue(parsed.container)}]`,
    // Stream shape. `vcodec`/`acodec` are compared against the literal string
    // "none", which is exactly how yt-dlp itself marks an absent stream.
    parsed.hasVideo ? `[vcodec!=${quoteFilterValue("none")}]` : `[vcodec=${quoteFilterValue("none")}]`,
    parsed.hasAudio ? `[acodec!=${quoteFilterValue("none")}]` : `[acodec=${quoteFilterValue("none")}]`,
  ];

  return `${GENERIC_FORMAT_SELECTOR_ATOM}${filters.join("")}`;
}
