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

// ── How video presence was established (§11) ─────────────────────────────────

/**
 * The closed set of ways generic analysis may establish that a source carries
 * video — and therefore the closed set of acquisition constraints that can
 * re-select it.
 *
 * This exists because `hasVideo: true` alone is NOT enough to rebuild the
 * selector. Pinned yt-dlp 2026.08.19 reports two materially different
 * video-bearing shapes, and one strict filter cannot serve both:
 *
 *   `codec-present`  the extractor named a real video codec. The strongest
 *                    evidence there is, and the only one that may be bound
 *                    with the strict `[vcodec!="none"]` constraint.
 *
 *   `video-ext`      the extractor reported NO codec identity (`vcodec: null`)
 *                    but did report a coherent normalized source shape:
 *                    `video_ext` is a real container, equals `ext`, and that
 *                    container is in the generic VIDEO allowlist. This is the
 *                    plain HTML5 `<video><source>` case, where
 *                    `_parse_html5_media_entries` builds the plain-media dict
 *                    with `'vcodec': None` and then `f.update(formats[0])`
 *                    overwrites whatever the `type=` attribute had parsed.
 *
 *   `absent`         the extractor said `vcodec == "none"` — video is proven
 *                    ABSENT, not merely unknown.
 *
 * `unknown` is deliberately NOT a member. A source whose video shape cannot be
 * established as one of the three above is not executable at all: there is no
 * closed selector that could honestly re-select it, so analysis must refuse it
 * rather than advertise a preset acquisition would fail on (§49).
 */
export const GENERIC_VIDEO_CONSTRAINTS = Object.freeze([
  "codec-present",
  "video-ext",
  "absent",
] as const);

export const GenericVideoConstraintSchema = z.enum(GENERIC_VIDEO_CONSTRAINTS);
export type GenericVideoConstraint = z.infer<typeof GenericVideoConstraintSchema>;

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
    /**
     * HOW video presence was established, so acquisition can rebuild the exact
     * constraint analysis approved rather than assuming every video source can
     * be bound with `[vcodec!="none"]` (§11/§16).
     *
     * This is an application-owned closed enum. It never carries, encodes or
     * paraphrases the upstream codec string, and it is private to exactly the
     * same extent the rest of this structure is.
     */
    videoConstraint: GenericVideoConstraintSchema,
    /** Known upstream size, when the extractor reported one. Never trusted alone. */
    fileSize: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((selection, ctx) => {
    // §12: the two video fields are one fact stated twice, so they may never
    // disagree. A runtime check rather than a comment, because a drifting pair
    // is exactly how a selector stops describing the source it approved.
    const claimsVideo = selection.videoConstraint !== "absent";
    if (selection.hasVideo !== claimsVideo) {
      ctx.addIssue({
        code: "custom",
        path: ["videoConstraint"],
        message: "hasVideo must agree with videoConstraint",
      });
    }

    // A video-bearing source's container must be one this product can actually
    // deliver verbatim; an absent-video source's must be an audio container.
    // Both mirror `toGenericSourceContainer`, which is what produced the value.
    const allowed = claimsVideo
      ? (GENERIC_VIDEO_SOURCE_CONTAINERS as readonly string[])
      : (GENERIC_AUDIO_SOURCE_CONTAINERS as readonly string[]);
    if (!allowed.includes(selection.container)) {
      ctx.addIssue({
        code: "custom",
        path: ["container"],
        message: "container is not allowed for this stream shape",
      });
    }

    // A descriptor carrying neither stream describes nothing acquirable.
    if (!selection.hasVideo && !selection.hasAudio) {
      ctx.addIssue({
        code: "custom",
        path: ["hasAudio"],
        message: "a selection must carry video, audio, or both",
      });
    }
  });

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
    ...videoShapeFilters(parsed),
    // Audio shape. `acodec` is the ONLY audio-presence authority here.
    // `audio_ext` is deliberately absent: `_fill_sorting_fields` sets it to
    // "none" on every format whose `vcodec != "none"`, so `[audio_ext!="none"]`
    // would match NOTHING for a real muxed source (§17, §D1).
    parsed.hasAudio ? `[acodec!=${quoteFilterValue("none")}]` : `[acodec=${quoteFilterValue("none")}]`,
  ];

  return `${GENERIC_FORMAT_SELECTOR_ATOM}${filters.join("")}`;
}

/**
 * The video half of the selector, chosen by HOW analysis established video.
 *
 * The distinction is load-bearing against the pinned runtime, because
 * `_build_format_filter`'s inner predicate is:
 *
 *     def _filter(f):
 *         actual_value = f.get(m.group('key'))
 *         if actual_value is None:
 *             return m.group('none_inclusive')
 *         return op(actual_value, comparison_value)
 *
 * A field that is Python `None` — which is exactly what the Generic HTML5 path
 * leaves in `vcodec` — never reaches the operator at all. It matches only when
 * the filter carried the none-inclusive `?`, whose position the string-operator
 * regex fixes as `key` `!`? `op` `?`? `value`; `vcodec?!=` and `vcodec!?=` are
 * both `SyntaxError`. Verified against 2026.08.19:
 *
 *     [vcodec!="none"]   vcodec=None -> NO MATCH   vcodec="avc1" -> match
 *     [vcodec!=?"none"]  vcodec=None -> match      vcodec="avc1" -> match
 *     [vcodec!=?"none"]  vcodec="none" -> NO MATCH
 *
 * So `codec-present` keeps the strict form (§14) — a known video codec is not
 * weakened merely because an unknown-codec state now exists — while `video-ext`
 * uses the none-inclusive form AND additionally binds `video_ext` to the exact
 * approved container, so the shape evidence analysis actually relied on has to
 * still hold at acquisition time (§16).
 */
function videoShapeFilters(parsed: GenericSourceSelection): string[] {
  switch (parsed.videoConstraint) {
    case "codec-present":
      return [`[vcodec!=${quoteFilterValue("none")}]`];
    case "video-ext":
      return [
        // Accepts an absent/unknown codec and a subsequently KNOWN one; rejects
        // an explicit "none". Video may become better described, never absent.
        `[vcodec!=?${quoteFilterValue("none")}]`,
        // The evidence the approval rested on must still hold.
        `[video_ext=${quoteFilterValue(parsed.container)}]`,
      ];
    case "absent":
      return [`[vcodec=${quoteFilterValue("none")}]`];
  }
}
