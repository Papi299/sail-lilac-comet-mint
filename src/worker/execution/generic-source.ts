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

// ── What analysis knew about audio (GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001) ──

/**
 * The closed set of AUDIO states generic analysis can record for a source — and
 * therefore the closed set of acquisition constraints that can re-select it.
 *
 * It mirrors `classifyCodecState(acodec)` one-for-one, because the pinned
 * runtime really does report three different things and a boolean can only
 * hold two of them:
 *
 *   `codec-present`  the extractor named a real audio codec. Audio presence is
 *                    PROVEN, and only this state may be bound with the strict
 *                    `[acodec!="none"]` constraint.
 *
 *   `absent`         the extractor said `acodec == "none"` — audio is proven
 *                    ABSENT, not merely unknown.
 *
 *   `unknown`        `acodec` was null, empty, `"null"` or missing. This is the
 *                    ordinary Generic HTML5 case when the page's
 *                    `<source type>` carries no `codecs=` parameter:
 *                    `parse_codecs` returns `{}` and the key is never set at
 *                    all. It is NOT a statement that audio is missing — and not
 *                    a statement that it is there either.
 *
 * Before this enum existed, unknown was collapsed into `hasAudio: false`, and
 * that boolean then rebuilt the selector as `[acodec="none"]` — a filter the
 * pinned runtime can never match against the `acodec: None` format it came
 * from. The incoherence was unreachable only because no generic preset is
 * built on a source without proven audio; the enum makes it unrepresentable.
 *
 * Unlike `GenericVideoConstraint`, `unknown` IS a member. An unknown audio state
 * can be re-selected honestly (`[acodec!=?"none"]`), so it is a coherent private
 * description of a source. Whether such a source may be ADVERTISED is a
 * separate question, answered by preset construction: it may never back an
 * audio claim, an audio or MP3 preset, or a split half, because nothing proves
 * it carries audio. Since GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001
 * a single progressive source with established video and `unknown` audio may
 * back an ordinary VIDEO preset that claims no audio, as a whole-result fallback
 * used only when no proven video rendition exists.
 */
export const GENERIC_AUDIO_CONSTRAINTS = Object.freeze([
  "codec-present",
  "absent",
  "unknown",
] as const);

export const GenericAudioConstraintSchema = z.enum(GENERIC_AUDIO_CONSTRAINTS);
export type GenericAudioConstraint = z.infer<typeof GenericAudioConstraintSchema>;

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
    /**
     * Audio presence is PROVEN — exactly `audioConstraint === "codec-present"`.
     *
     * Retained for the execution planner, which gates every audio claim and
     * every audio product on proven audio. It does NOT mean "might have audio",
     * and `false` does NOT mean "proven absent": both unknown and absent audio
     * are `false` here, and only `audioConstraint` tells them apart. The
     * selector, and the planner's unknown-vs-absent decisions, read only the
     * latter.
     */
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
    /**
     * WHAT analysis knew about audio, so acquisition can rebuild the exact
     * constraint analysis approved rather than squeezing an unknown state into
     * a boolean (GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001).
     *
     * The SOLE authority for the selector's audio half. Application-owned,
     * closed, and private to exactly the same extent as `videoConstraint`: it
     * never carries, encodes or paraphrases the upstream codec string.
     */
    audioConstraint: GenericAudioConstraintSchema,
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

    // The audio fields are likewise one fact stated twice, but the boolean is
    // deliberately the NARROWER statement: `hasAudio` means audio is PROVEN.
    // An unknown audio state is `hasAudio: false` — never true, because nothing
    // establishes it, and never `absent`, because nothing establishes that
    // either.
    const provesAudio = selection.audioConstraint === "codec-present";
    if (selection.hasAudio !== provesAudio) {
      ctx.addIssue({
        code: "custom",
        path: ["audioConstraint"],
        message: "hasAudio must be true exactly when audioConstraint is codec-present",
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

    // A descriptor PROVING neither stream describes nothing acquirable. Because
    // `hasAudio` means proven audio, this also refuses an audio-only shape
    // whose audio is merely unknown.
    if (!selection.hasVideo && !selection.hasAudio) {
      ctx.addIssue({
        code: "custom",
        path: ["hasAudio"],
        message: "a selection must carry video, audio, or both",
      });
    }
  });

export type GenericSourceSelection = z.infer<typeof GenericSourceSelectionSchema>;

// ── Split video+audio pairs (SPLIT-01 §E) ────────────────────────────────────

/**
 * The CLOSED table of source-container combinations generic v1 may merge, and
 * the target container each one produces.
 *
 * Deliberately two rows, and deliberately SAME-FAMILY only. This table is the
 * premise the merge-safety argument rests on, so it is worth stating the
 * argument here rather than in a review comment:
 *
 *   The merge is a STREAM COPY. A copy is legal exactly when the copied stream
 *   is representable in the target container. Because the target container is
 *   always the same family as the VIDEO source's container, and the AUDIO
 *   source's container is a member of that same family, both streams are
 *   representable BY CONSTRUCTION:
 *
 *     - a video stream that was legally stored in ISO-BMFF (`mp4`) is legally
 *       storable in ISO-BMFF, whatever its codec is — h264, hevc, av1, vp9, or
 *       something this application never named;
 *     - `m4a` IS ISO-BMFF, so its audio stream is likewise representable;
 *     - identically for `webm` + `webm` on the Matroska side.
 *
 * This is why no codec identity is consulted anywhere on the merge path, and
 * why no upstream codec string ever becomes an FFmpeg argument. The property
 * comes from the CLOSED table, not from containers being generally informative.
 *
 * The cross-family combinations are exactly the ones that WOULD need codec
 * knowledge — Opus in mp4 works, Vorbis in mp4 does not, PCM in mp4 is barely
 * supported — so every one of them is absent, and `null` means "not a pair"
 * rather than "guess".
 *
 * Note this is NARROWER than `GENERIC_AUDIO_SOURCE_CONTAINERS`. That list is
 * correct for keeping an audio-only source VERBATIM, which is what it was
 * written for; it is not correct for muxing into mp4 or webm.
 */
export function splitTargetContainer(
  video: GenericSourceContainer,
  audio: GenericSourceContainer,
): GenericSplitTargetContainer | null {
  if (video === "mp4" && audio === "m4a") return "mp4";
  if (video === "webm" && audio === "webm") return "webm";
  return null;
}

/**
 * The only containers a split merge may PRODUCE. A closed union, so the target
 * can become an output extension and a MIME decision without any widening.
 */
export const GenericSplitTargetContainerSchema = z.enum(["mp4", "webm"]);
export type GenericSplitTargetContainer = z.infer<typeof GenericSplitTargetContainerSchema>;

/**
 * One validated, EXECUTABLE video-only + audio-only PAIR.
 *
 * Both members are ordinary `GenericSourceSelection` values — the member schema
 * needed no change, because it already describes a video-only source
 * (`hasVideo: true`, `audioConstraint: "absent"`) and an audio-only source
 * (`videoConstraint: "absent"`, `audioConstraint: "codec-present"`) exactly.
 * What this schema adds is the set of cross-member invariants that make an
 * INVALID pair unrepresentable rather than merely unbuilt.
 *
 * Both raw upstream identifiers are equally private. Nothing here may cross
 * Worker HTTP, enter `WorkerVideoMetadata`, enter SQLite, reach Vercel or the
 * browser, be logged, or appear in an error message. Two ids instead of one
 * changes the count, not the boundary.
 *
 * ─── Why the audio member must be PROVEN video-absent, and the video member
 *     PROVEN audio-absent ──────────────────────────────────────────────────
 *
 * `unknown` is never upgraded to `present`, and never downgraded to `absent`.
 * A pair built on an unknown state would be an implicit claim that the unknown
 * resolved the convenient way. Concretely:
 *
 *   - an unknown-audio VIDEO member might actually be muxed, in which case the
 *     job would acquire audio twice and then silently discard the source's own
 *     track via the stream map — a substitution the user never asked for;
 *   - an unknown-video AUDIO member might actually carry video, so the pair
 *     would not be a split pair at all.
 *
 * Both states are also strictly re-selectable only in their proven form:
 * `[acodec="none"]` and `[vcodec="none"]` match the explicit marker and nothing
 * else, so a source that CHANGED shape between analysis and acquisition fails
 * selection instead of being acquired as different media.
 */
export const GenericSplitSourceSelectionSchema = z
  .object({
    /** The video-only half. Carries video; proven to carry no audio. */
    video: GenericSourceSelectionSchema,
    /** The audio-only half. Carries PROVEN audio; proven to carry no video. */
    audio: GenericSourceSelectionSchema,
  })
  .strict()
  .superRefine((pair, ctx) => {
    const issue = (path: "video" | "audio", message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    // I1: the video member really carries video. Either approved video
    // constraint is accepted — `codec-present` and `video-ext` are the same
    // evidence standard already accepted for muxed video presets, and the
    // source container proves the stream is representable in the target
    // container regardless of codec identity (see `splitTargetContainer`).
    if (!pair.video.hasVideo || pair.video.videoConstraint === "absent") {
      issue("video", "the video member must carry video");
    }

    // I2: the video member's audio is PROVEN ABSENT — never merely unknown.
    if (pair.video.audioConstraint !== "absent") {
      issue("video", "the video member must have proven-absent audio");
    }

    // I3: the audio member's video is PROVEN ABSENT — never merely unknown.
    if (pair.audio.videoConstraint !== "absent" || pair.audio.hasVideo) {
      issue("audio", "the audio member must have proven-absent video");
    }

    // I4: the audio member's audio is PROVEN PRESENT.
    //
    // DEFENCE IN DEPTH, deliberately — not the operative gate, and it is worth
    // being precise about that rather than implying a strength it does not add.
    // I3 forces `videoConstraint: "absent"`, which the member schema ties to
    // `hasVideo: false`; the member schema then requires a selection to carry
    // video, audio or both, and ties `hasAudio === true` to
    // `audioConstraint === "codec-present"`. An audio member with `unknown` or
    // `absent` audio is therefore already unrepresentable one layer down.
    //
    // This restates it at the pair level so the pair stays self-describing and
    // so a future relaxation of the member schema cannot silently make an
    // unknown-audio half acceptable here. `member schema rejects an audio-only
    // descriptor whose audio is not proven` is pinned by its own test.
    if (pair.audio.audioConstraint !== "codec-present" || !pair.audio.hasAudio) {
      issue("audio", "the audio member must have proven audio");
    }

    // I5: two DIFFERENT upstream sources. A pair naming one id twice would
    // acquire the same bytes twice and cannot be a real split rendition.
    if (pair.video.formatId === pair.audio.formatId) {
      issue("audio", "a split pair must name two different upstream sources");
    }

    // I6: the container combination is in the closed table. This is what makes
    // the stream copy provably legal, so it is an invariant of the pair rather
    // than a check performed later by whoever happens to build the command.
    if (splitTargetContainer(pair.video.container, pair.audio.container) === null) {
      issue("video", "the container combination is not a mergeable pair");
    }
  });

export type GenericSplitSourceSelection = z.infer<typeof GenericSplitSourceSelectionSchema>;

/**
 * How ONE advertised preset is fulfilled: by a single approved source, or by an
 * approved video-only + audio-only pair.
 *
 * A discriminated union rather than an optional second source, so "a single
 * source that also has an audio partner" and "a pair with a missing half" are
 * both unrepresentable rather than merely rejected somewhere downstream.
 *
 * The merge TARGET is deliberately NOT a member of this type. It is derived
 * from the pair by `splitTargetContainer()` at plan-derivation time, so there
 * is exactly one authority for it and a drifted pair cannot claim a target the
 * closed table would refuse.
 */
export const GenericPresetSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("single"),
      source: GenericSourceSelectionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("split"),
      pair: GenericSplitSourceSelectionSchema,
    })
    .strict(),
]);

export type GenericPresetSource = z.infer<typeof GenericPresetSourceSchema>;

/** Narrows a preset source to its single-source form, or `null`. */
export function asSingleSource(value: GenericPresetSource): GenericSourceSelection | null {
  return value.kind === "single" ? value.source : null;
}

/** Narrows a preset source to its split-pair form, or `null`. */
export function asSplitPair(value: GenericPresetSource): GenericSplitSourceSelection | null {
  return value.kind === "split" ? value.pair : null;
}

/**
 * The private per-preset selection map produced by execution analysis.
 *
 * Keyed by the APPLICATION preset id the browser may request. The values are
 * the private descriptors above.
 */
export type GenericSourceSelections = Readonly<Record<string, GenericPresetSource>>;

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
 *   - no `+` merge.
 *
 * The `+` exclusion survives split-stream support unchanged, and is the reason
 * it can. A split pair is acquired as TWO independent invocations, each with
 * its OWN complete expression built by this function, never as one joined
 * `video+audio` expression. `+` is a yt-dlp selector OPERATOR: admitting it
 * would reopen the grammar surface `SAFE_FORMAT_ID_PATTERN` and
 * `quoteFilterValue` exist to close, and — worse — it would hand yt-dlp the
 * CHOICE of sources plus its own FFmpeg merge, which would run local media work
 * while the durable job still says `downloading`.
 */
export function buildGenericFormatSelector(selection: GenericSourceSelection): string {
  const parsed = GenericSourceSelectionSchema.parse(selection);

  const filters = [
    `[format_id=${quoteFilterValue(parsed.formatId)}]`,
    `[protocol=${quoteFilterValue(parsed.protocol)}]`,
    `[ext=${quoteFilterValue(parsed.container)}]`,
    ...videoShapeFilters(parsed),
    // Audio shape. `acodec` is the ONLY audio-presence authority here, and the
    // private `audioConstraint` — never the boolean `hasAudio` — decides which
    // form it takes. `audio_ext` is deliberately absent: `_fill_sorting_fields`
    // sets it to "none" on every format whose `vcodec != "none"`, so
    // `[audio_ext!="none"]` would match NOTHING for a real muxed source (§17, §D1).
    audioShapeFilter(parsed),
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

/**
 * The audio half of the selector, chosen by WHAT analysis knew about audio
 * (GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001).
 *
 * The same `_build_format_filter` predicate governs it (see
 * `videoShapeFilters`): a Python `None` field never reaches the operator and
 * matches only a none-inclusive filter. Verified against 2026.08.19 inside the
 * accepted image, for a real HTML5 format whose `acodec` key is absent:
 *
 *     [acodec="none"]    missing -> NO MATCH   "mp4a.40.2" -> NO MATCH   "none" -> match
 *     [acodec!="none"]   missing -> NO MATCH   "mp4a.40.2" -> match      "none" -> NO MATCH
 *     [acodec!=?"none"]  missing -> match      "mp4a.40.2" -> match      "none" -> NO MATCH
 *
 * So each state gets the one form that re-selects exactly what it approved:
 *
 *   `codec-present`  strict. A proven codec is not weakened because an unknown
 *                    state now exists, and a source that LOST its codec
 *                    identity is no longer the approved shape.
 *   `absent`         strict equality. Only the explicit marker was approved.
 *   `unknown`        none-inclusive. The codec may become better described,
 *                    but a transition to PROVEN absence must fail selection —
 *                    the same rule the `video-ext` constraint follows.
 *
 * Re-selecting an unknown state proves nothing about the file. It is a property
 * of selector coherence, and it never licenses advertising a source as carrying
 * audio.
 */
function audioShapeFilter(parsed: GenericSourceSelection): string {
  switch (parsed.audioConstraint) {
    case "codec-present":
      return `[acodec!=${quoteFilterValue("none")}]`;
    case "absent":
      return `[acodec=${quoteFilterValue("none")}]`;
    case "unknown":
      return `[acodec!=?${quoteFilterValue("none")}]`;
  }
}
