import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GENERIC_AUDIO_SOURCE_CONTAINERS,
  GENERIC_FORMAT_SELECTOR_ATOM,
  GENERIC_VIDEO_CONSTRAINTS,
  GENERIC_SOURCE_PROTOCOLS,
  GENERIC_VIDEO_SOURCE_CONTAINERS,
  GenericSourceSelectionSchema,
  SAFE_FORMAT_ID_PATTERN,
  buildGenericFormatSelector,
  isSafeFormatId,
  toGenericSourceContainer,
  type GenericSourceSelection,
} from "./generic-source.ts";

/**
 * Phase 10C3 §51: the raw upstream `format_id` boundary.
 *
 * These tests exist because this module is the ONE place a raw yt-dlp id is
 * permitted to exist. They pin both halves of what makes that safe: the literal
 * grammar an id must satisfy to become executable at all, and the exact shape
 * of the selector expression built from it.
 */

const MUXED: GenericSourceSelection = {
  formatId: "22",
  protocol: "https",
  container: "mp4",
  hasVideo: true,
  hasAudio: true,
  videoConstraint: "codec-present",
  fileSize: 1024,
};

/**
 * The REAL pinned Generic HTML5 shape: a muxed mp4 whose video codec identity
 * the extractor never reported. See `ytdlp-analysis.server.test.ts` for the
 * captured document this mirrors.
 */
const UNKNOWN_VIDEO: GenericSourceSelection = {
  formatId: "0",
  protocol: "https",
  container: "mp4",
  hasVideo: true,
  hasAudio: true,
  videoConstraint: "video-ext",
  fileSize: null,
};

describe("generic source: safe raw format id grammar (§11)", () => {
  it("accepts the id shapes real extractors actually emit", () => {
    const accepted = [
      "22",
      "137",
      "18",
      "best",
      "hls-6",
      "http-1080p",
      "dash_video_1",
      "audio.medium",
      "vp9-2160p60",
      "A".repeat(128),
      "a",
      "0",
      "-",
      "_",
      ".",
    ];
    for (const id of accepted) {
      assert.equal(isSafeFormatId(id), true, `expected ${JSON.stringify(id)} to be safe`);
    }
  });

  // Each rejected character is one that carries meaning inside yt-dlp's own
  // format-selector grammar, so accepting it would be a selector-injection
  // surface rather than merely an odd identifier.
  const REJECTED: Array<[string, string]> = [
    ["slash", "bv/ba"],
    ["plus", "bv+ba"],
    ["comma", "22,18"],
    ["open bracket", "22[ext=mp4"],
    ["close bracket", "22]"],
    ["open paren", "(22"],
    ["close paren", "22)"],
    ["double quote", 'a"b'],
    ["single quote", "a'b"],
    ["colon", "http:22"],
    ["space", "22 18"],
    ["tab", "22\t18"],
    ["newline", "22\n18"],
    ["carriage return", "22\r18"],
    ["nul", "22\u000018"],
    ["escape", "22\u001b18"],
    ["del", "22\u007f"],
    ["backslash", "a\\b"],
    ["asterisk", "b*"],
    ["equals", "ext=mp4"],
    ["bang", "vcodec!=none"],
    ["non-ascii", "22é"],
    ["empty", ""],
    ["over length", "A".repeat(129)],
  ];

  for (const [label, value] of REJECTED) {
    it(`rejects ${label}`, () => {
      assert.equal(isSafeFormatId(value), false, `expected ${JSON.stringify(value)} rejected`);
      assert.equal(SAFE_FORMAT_ID_PATTERN.test(value), false);
      assert.equal(
        GenericSourceSelectionSchema.safeParse({ ...MUXED, formatId: value }).success,
        false,
        "an unsafe id must not survive selection validation either",
      );
    });
  }

  it("rejects a multi-line id even when the first line alone would be safe", () => {
    // Guards the classic `^...$` regex mistake: without `\n` exclusion, `$`
    // matches before a trailing newline and "22\nmalicious" would pass.
    assert.equal(isSafeFormatId("22\nbv+ba"), false);
    assert.equal(isSafeFormatId("22\n"), false);
  });

  it("is anchored, so a safe substring cannot smuggle an unsafe whole", () => {
    assert.equal(isSafeFormatId("safe[ext=mp4]"), false);
    assert.equal(isSafeFormatId("prefix safe"), false);
  });

  it("rejects non-string input", () => {
    for (const value of [null, undefined, 22, {}, [], true]) {
      assert.equal(isSafeFormatId(value), false);
    }
  });
});

describe("generic source: container allowlist (§15)", () => {
  it("accepts only mp4/webm for video candidates", () => {
    assert.deepEqual([...GENERIC_VIDEO_SOURCE_CONTAINERS], ["mp4", "webm"]);
    for (const ext of ["mp4", "webm", "MP4", "WebM"]) {
      assert.notEqual(toGenericSourceContainer(ext, { hasVideo: true }), null, ext);
    }
    for (const ext of ["mkv", "mov", "avi", "flv", "m4a", "mp3", "ts", "3gp"]) {
      assert.equal(
        toGenericSourceContainer(ext, { hasVideo: true }),
        null,
        `${ext} must not be an executable generic VIDEO container`,
      );
    }
  });

  it("accepts the audio subset for audio-only candidates", () => {
    for (const ext of GENERIC_AUDIO_SOURCE_CONTAINERS) {
      assert.notEqual(toGenericSourceContainer(ext, { hasVideo: false }), null, ext);
    }
    for (const ext of ["mkv", "mov", "avi", "vtt", "srt", "mhtml", "jpg"]) {
      assert.equal(toGenericSourceContainer(ext, { hasVideo: false }), null, ext);
    }
  });

  it("never defaults an unknown or absent extension to mp4", () => {
    // Phase-10C2 analysis defaults a missing ext to "mp4" for DESCRIPTION.
    // Execution must not: the extension becomes a real file suffix and a
    // selector constraint.
    for (const value of [null, undefined, "", "  ", "wat", "exe", "bin"]) {
      assert.equal(toGenericSourceContainer(value, { hasVideo: true }), null);
      assert.equal(toGenericSourceContainer(value, { hasVideo: false }), null);
    }
  });
});

describe("generic source: protocol policy (§16)", () => {
  it("permits exactly http and https", () => {
    assert.deepEqual([...GENERIC_SOURCE_PROTOCOLS], ["http", "https"]);
  });

  it("refuses every manifest, fragment and streaming protocol", () => {
    for (const protocol of [
      "m3u8",
      "m3u8_native",
      "http_dash_segments",
      "rtmp",
      "rtmp_ffmpeg",
      "ism",
      "mhtml",
      "websocket_frag",
      "niconico_live",
      "ftp",
      "",
    ]) {
      assert.equal(
        GenericSourceSelectionSchema.safeParse({ ...MUXED, protocol }).success,
        false,
        `${protocol} must never be an executable generic protocol`,
      );
    }
  });
});

describe("generic source: format selector construction (§12/§13/§14)", () => {
  it("builds the exact expression for a muxed video source", () => {
    assert.equal(
      buildGenericFormatSelector(MUXED),
      'b*[format_id="22"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!="none"]',
    );
  });

  it("builds the exact expression for an audio-only source", () => {
    assert.equal(
      buildGenericFormatSelector({
        formatId: "140",
        protocol: "https",
        container: "m4a",
        hasVideo: false,
        hasAudio: true,
        videoConstraint: "absent",
        fileSize: null,
      }),
      'b*[format_id="140"][protocol="https"][ext="m4a"][vcodec="none"][acodec!="none"]',
    );
  });

  it("QUOTES the format id, which is what makes numeric ids work at all", () => {
    // yt-dlp 2026.08.19 `_build_format_filter` tries a NUMERIC regex first.
    // `[format_id=22]` fullmatches it, becomes float 22.0, and is compared
    // against the STRING "22" — which is never equal, so the filter silently
    // matches nothing. Quoting forces the STR_OPERATORS branch, where `=` is
    // string equality. Numeric ids are extremely common, so this is not an
    // edge case.
    const selector = buildGenericFormatSelector(MUXED);
    assert.match(selector, /\[format_id="22"\]/);
    assert.doesNotMatch(selector, /\[format_id=22\]/);
  });

  it("uses the application-owned b* atom, never a bare raw-id atom (§12)", () => {
    const selector = buildGenericFormatSelector(MUXED);
    assert.equal(GENERIC_FORMAT_SELECTOR_ATOM, "b*");
    assert.ok(selector.startsWith("b*["), "the atom must precede every filter");
    // The raw id appears ONLY inside a quoted format_id filter — never as a
    // standalone selector token, where it could collide with yt-dlp's special
    // vocabulary (best/worst/all/mergeall/extension names).
    assert.equal(selector.split('"22"').length - 1, 1, "the raw id appears exactly once");
    assert.doesNotMatch(selector, /(^|[[\]/+,])22([[\]/+,]|$)/);
  });

  it("never emits a choice, merge or list operator", () => {
    for (const shape of [
      MUXED,
      UNKNOWN_VIDEO,
      { ...MUXED, hasVideo: false, container: "m4a" as const, videoConstraint: "absent" as const },
      { ...MUXED, hasAudio: false },
    ]) {
      const selector = buildGenericFormatSelector(shape);
      assert.doesNotMatch(selector, /\//, "no `/` fallback: one source or none");
      assert.doesNotMatch(selector, /\+/, "no `+` merge: generic v1 never merges streams");
      assert.doesNotMatch(selector, /,/, "no `,` selector list");
      assert.doesNotMatch(selector, /[()]/, "no grouping");
    }
  });

  it("binds protocol, container and stream shape, not just the id (§14)", () => {
    const selector = buildGenericFormatSelector(MUXED);
    assert.match(selector, /\[protocol="https"\]/);
    assert.match(selector, /\[ext="mp4"\]/);
    assert.match(selector, /\[vcodec!="none"\]/);
    assert.match(selector, /\[acodec!="none"\]/);
  });

  it("inverts the stream-shape constraints to match the approved shape", () => {
    const videoOnly = buildGenericFormatSelector({ ...MUXED, hasAudio: false });
    assert.match(videoOnly, /\[vcodec!="none"\]/);
    assert.match(videoOnly, /\[acodec="none"\]/);

    const audioOnly = buildGenericFormatSelector({
      ...MUXED,
      container: "m4a",
      hasVideo: false,
      videoConstraint: "absent",
    });
    assert.match(audioOnly, /\[vcodec="none"\]/);
    assert.match(audioOnly, /\[acodec!="none"\]/);
  });

  it("refuses to build a selector from an unsafe id", () => {
    for (const formatId of ['a"b', "bv+ba", "22/18", "a b", "22]"]) {
      assert.throws(
        () => buildGenericFormatSelector({ ...MUXED, formatId }),
        "an unsafe id must never reach selector construction",
      );
    }
  });

  it("refuses to build a selector from a disallowed protocol or container", () => {
    assert.throws(() =>
      buildGenericFormatSelector({ ...MUXED, protocol: "m3u8_native" as never }),
    );
    assert.throws(() => buildGenericFormatSelector({ ...MUXED, container: "mkv" as never }));
  });

  it("produces a selector containing no character outside the safe filter set", () => {
    // Whole-expression assertion: whatever the inputs, the emitted string is
    // built only from the atom, bracket/quote delimiters, known keys, and
    // grammar-checked values.
    for (const shape of [MUXED, UNKNOWN_VIDEO]) {
      const selector = buildGenericFormatSelector(shape);
      assert.match(selector, /^b\*(\[[a-z_]+(?:!=\?|!=|=)"[A-Za-z0-9._-]{1,128}"\])+$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE-10D-GENERIC-REAL-OUTPUT-COMPATIBILITY-001 — §16/§28
//
// Analysis and acquisition are ONE contract. It is not enough for analysis to
// advertise a preset: the exact format it approved must still be selectable by
// the constrained acquisition subprocess. Before this correction the Generic
// HTML5 format that analysis (now) accepts was REJECTED by the selector, and
// the job would have failed FORMAT_UNAVAILABLE after the user chose a preset.
//
// These tests therefore evaluate the built selector against format documents,
// not against expected strings.
// ─────────────────────────────────────────────────────────────────────────────

/** A yt-dlp format document as the pinned runtime would hand it to a filter. */
type PinnedFormat = Record<string, string | null | undefined>;

/**
 * A faithful model of yt-dlp 2026.08.19's `_build_format_filter` predicate,
 * restricted to the closed grammar this module actually emits.
 *
 * The whole point is the `None` branch. Verbatim from the pinned release:
 *
 *     def _filter(f):
 *         actual_value = f.get(m.group('key'))
 *         if actual_value is None:
 *             return m.group('none_inclusive')
 *         return op(actual_value, comparison_value)
 *
 * A field that is Python `None` — a missing key or an explicit null — never
 * reaches the operator. It matches ONLY when the filter carried the
 * none-inclusive `?`, whose position the string-operator regex fixes as
 * `key` `!`? `op` `?`? `value`.
 *
 * This model was checked against the real pinned artifact: `[vcodec!="none"]`
 * does not select a `vcodec: null` format, `[vcodec!=?"none"]` does, and
 * neither selects a `vcodec: "none"` one. `deploy/acceptance/ytdlp-generic/
 * verify-selector.py` re-proves the same expectations inside the Worker image
 * against the actual binary; this exists so the contract is also covered by the
 * ordinary unit suite, which runs everywhere and on every change.
 */
function selectsFormat(selector: string, format: PinnedFormat): boolean {
  assert.ok(selector.startsWith(GENERIC_FORMAT_SELECTOR_ATOM), "selector must open with the atom");
  const body = selector.slice(GENERIC_FORMAT_SELECTOR_ATOM.length);

  const FILTER = /\[([a-z_]+)(!?)=(\??)"([A-Za-z0-9._-]+)"\]/g;
  const matches = [...body.matchAll(FILTER)];
  // Totality: every character of the emitted expression must be accounted for,
  // so a future selector change cannot slip past this model unnoticed.
  assert.equal(
    matches.map((m) => m[0]).join(""),
    body,
    "the model must parse the whole selector, not part of it",
  );
  assert.ok(matches.length > 0, "a selector with no filters would bind nothing");

  return matches.every(([, key, negation, noneInclusive, value]) => {
    const actual = format[key!];
    if (actual === null || actual === undefined) return noneInclusive === "?";
    return negation === "!" ? actual !== value : actual === value;
  });
}

describe("unknown-codec video selection against pinned filter semantics (§16/§28)", () => {
  const selector = buildGenericFormatSelector(UNKNOWN_VIDEO);

  /** The format the pinned runtime actually produces for the fixture page. */
  const REAL: PinnedFormat = {
    format_id: "0",
    protocol: "https",
    ext: "mp4",
    vcodec: null,
    acodec: "mp4a.40.2",
    video_ext: "mp4",
    audio_ext: "none",
  };

  it("MUST match the exact format analysis approved", () => {
    assert.equal(
      selectsFormat(selector, REAL),
      true,
      "analysis accepting a format acquisition then rejects is still a defect",
    );
  });

  it("MAY match once the codec becomes known, with the same approved shape", () => {
    // Re-extraction giving MORE specific video information is not a change of
    // source shape, so it must not fail the job (§19).
    assert.equal(selectsFormat(selector, { ...REAL, vcodec: "avc1.42E01E" }), true);
  });

  it("MUST reject an explicitly absent video stream", () => {
    assert.equal(
      selectsFormat(selector, { ...REAL, vcodec: "none" }),
      false,
      "a source that became audio-only must never be silently substituted",
    );
  });

  it("MUST reject a video_ext that no longer names the approved container", () => {
    for (const video_ext of ["none", "webm", "m4a"]) {
      assert.equal(selectsFormat(selector, { ...REAL, video_ext }), false, video_ext);
    }
    // An absent video_ext is not the approved evidence either: the filter is
    // the plain `=` form, so a null field matches nothing.
    assert.equal(selectsFormat(selector, { ...REAL, video_ext: null }), false);
  });

  it("MUST reject a changed id, protocol, container or audio shape", () => {
    assert.equal(selectsFormat(selector, { ...REAL, format_id: "1" }), false);
    assert.equal(selectsFormat(selector, { ...REAL, protocol: "http" }), false);
    assert.equal(selectsFormat(selector, { ...REAL, ext: "webm" }), false);
    assert.equal(selectsFormat(selector, { ...REAL, acodec: "none" }), false);
    assert.equal(selectsFormat(selector, { ...REAL, acodec: null }), false);
  });

  it("SELECTOR MUTATION: dropping the none-inclusive marker breaks acquisition", () => {
    // The precise defect this correction exists to close. The strict form is
    // what the merged code emitted for every video source.
    const strict = selector.replace('[vcodec!=?"none"]', '[vcodec!="none"]');
    assert.notEqual(strict, selector, "the selector must actually carry the marker");
    assert.equal(
      selectsFormat(strict, REAL),
      false,
      "the strict form cannot select the real pinned format — that WAS the bug",
    );
  });

  it("SELECTOR MUTATION: weakening it so vcodec='none' matches must fail", () => {
    // If the video constraint were dropped altogether, an audio-only rendition
    // sharing the id would satisfy the rest of the expression.
    const weakened = selector.replace('[vcodec!=?"none"]', "");
    assert.equal(
      selectsFormat(weakened, { ...REAL, vcodec: "none" }),
      true,
      "a weakened selector really does admit the absent-video format",
    );
    assert.equal(
      selectsFormat(selector, { ...REAL, vcodec: "none" }),
      false,
      "the shipped selector must not",
    );
  });
});

describe("known and absent video selection stay strict (§14/§15/§28)", () => {
  it("a KNOWN video codec keeps the strict constraint", () => {
    const selector = buildGenericFormatSelector(MUXED);
    assert.match(selector, /\[vcodec!="none"\]/);
    assert.doesNotMatch(selector, /\[vcodec!=\?"none"\]/, "known video is not weakened");
    assert.doesNotMatch(selector, /video_ext/, "no video_ext binding is added to the known case");

    const base: PinnedFormat = {
      format_id: "22", protocol: "https", ext: "mp4",
      vcodec: "avc1.640028", acodec: "mp4a.40.2",
    };
    assert.equal(selectsFormat(selector, base), true);
    assert.equal(selectsFormat(selector, { ...base, vcodec: "none" }), false);
    // A source that LOST its codec identity is no longer the approved shape.
    assert.equal(selectsFormat(selector, { ...base, vcodec: null }), false);
  });

  it("proven ABSENT video keeps requiring absence", () => {
    const selector = buildGenericFormatSelector({
      formatId: "140", protocol: "https", container: "m4a",
      hasVideo: false, hasAudio: true, videoConstraint: "absent", fileSize: null,
    });
    const base: PinnedFormat = {
      format_id: "140", protocol: "https", ext: "m4a",
      vcodec: "none", acodec: "mp4a.40.2",
    };
    assert.equal(selectsFormat(selector, base), true);
    assert.equal(
      selectsFormat(selector, { ...base, vcodec: "avc1.640028" }),
      false,
      "a format that gained video must not silently match an audio-only approval",
    );
    assert.equal(selectsFormat(selector, { ...base, vcodec: null }), false);
  });
});

describe("audio selection uses acodec, never audio_ext (§17)", () => {
  it("no generic selector ever constrains audio_ext", () => {
    for (const shape of [
      MUXED,
      UNKNOWN_VIDEO,
      { ...MUXED, hasAudio: false },
      {
        formatId: "140", protocol: "https" as const, container: "m4a" as const,
        hasVideo: false, hasAudio: true, videoConstraint: "absent" as const, fileSize: null,
      },
    ]) {
      assert.doesNotMatch(
        buildGenericFormatSelector(shape),
        /audio_ext/,
        "`_fill_sorting_fields` sets audio_ext='none' on every video-bearing " +
          "format, so binding it would match nothing for a real muxed source",
      );
    }
  });

  it("audio_ext='none' on a real muxed format does not prevent selection", () => {
    // The D1 defect, at the acquisition end.
    assert.equal(
      selectsFormat(buildGenericFormatSelector(UNKNOWN_VIDEO), {
        format_id: "0", protocol: "https", ext: "mp4",
        vcodec: null, acodec: "mp4a.40.2", video_ext: "mp4", audio_ext: "none",
      }),
      true,
    );
  });
});

describe("private selection consistency rules (§12)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["hasVideo=false with codec-present", { hasVideo: false, videoConstraint: "codec-present" }],
    ["hasVideo=false with video-ext", { hasVideo: false, videoConstraint: "video-ext" }],
    ["hasVideo=true with absent", { hasVideo: true, videoConstraint: "absent" }],
  ];
  for (const [label, override] of cases) {
    it(`rejects ${label}`, () => {
      assert.equal(GenericSourceSelectionSchema.safeParse({ ...MUXED, ...override }).success, false);
    });
  }

  it("rejects an unknown constraint value, including 'unknown' itself", () => {
    for (const videoConstraint of ["unknown", "codec_present", "videoExt", "", null, undefined]) {
      assert.equal(
        GenericSourceSelectionSchema.safeParse({ ...MUXED, videoConstraint }).success,
        false,
        String(videoConstraint),
      );
    }
    assert.deepEqual([...GENERIC_VIDEO_CONSTRAINTS], ["codec-present", "video-ext", "absent"]);
  });

  it("rejects a video-bearing selection carrying an audio-only container", () => {
    for (const container of ["m4a", "mp3", "ogg", "opus", "aac", "flac", "wav"]) {
      assert.equal(
        GenericSourceSelectionSchema.safeParse({ ...UNKNOWN_VIDEO, container }).success,
        false,
        container,
      );
    }
  });

  it("rejects a selection that carries neither stream", () => {
    assert.equal(
      GenericSourceSelectionSchema.safeParse({
        ...MUXED, container: "m4a", hasVideo: false, hasAudio: false, videoConstraint: "absent",
      }).success,
      false,
    );
  });

  it("accepts the three coherent shapes", () => {
    for (const shape of [
      MUXED,
      UNKNOWN_VIDEO,
      {
        formatId: "140", protocol: "https" as const, container: "m4a" as const,
        hasVideo: false, hasAudio: true, videoConstraint: "absent" as const, fileSize: null,
      },
    ]) {
      assert.equal(GenericSourceSelectionSchema.safeParse(shape).success, true);
    }
  });
});
