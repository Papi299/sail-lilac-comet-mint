import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENERIC_AUDIO_CONSTRAINTS,
  GENERIC_AUDIO_SOURCE_CONTAINERS,
  GENERIC_FORMAT_SELECTOR_ATOM,
  GENERIC_VIDEO_CONSTRAINTS,
  GENERIC_SOURCE_PROTOCOLS,
  GENERIC_VIDEO_SOURCE_CONTAINERS,
  GenericPresetSourceSchema,
  GenericSourceSelectionSchema,
  GenericSplitSourceSelectionSchema,
  SAFE_FORMAT_ID_PATTERN,
  asSingleSource,
  asSplitPair,
  buildGenericFormatSelector,
  isSafeFormatId,
  splitTargetContainer,
  toGenericSourceContainer,
  type GenericSourceSelection,
} from "./generic-source.ts";
import { buildGenericPresets, selectCandidates } from "../analysis/ytdlp-analysis.server.ts";

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
  audioConstraint: "codec-present",
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
  audioConstraint: "codec-present",
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
        audioConstraint: "codec-present",
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
      { ...MUXED, hasAudio: false, audioConstraint: "absent" as const },
      { ...MUXED, hasAudio: false, audioConstraint: "unknown" as const },
      { ...UNKNOWN_VIDEO, hasAudio: false, audioConstraint: "unknown" as const },
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
    const videoOnly = buildGenericFormatSelector({
      ...MUXED,
      hasAudio: false,
      audioConstraint: "absent",
    });
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
    for (const shape of [
      MUXED,
      UNKNOWN_VIDEO,
      { ...MUXED, hasAudio: false, audioConstraint: "absent" as const },
      { ...UNKNOWN_VIDEO, hasAudio: false, audioConstraint: "unknown" as const },
    ]) {
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
      hasVideo: false, hasAudio: true, videoConstraint: "absent",
      audioConstraint: "codec-present", fileSize: null,
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
      { ...MUXED, hasAudio: false, audioConstraint: "absent" as const },
      { ...MUXED, hasAudio: false, audioConstraint: "unknown" as const },
      { ...UNKNOWN_VIDEO, hasAudio: false, audioConstraint: "unknown" as const },
      {
        formatId: "140", protocol: "https" as const, container: "m4a" as const,
        hasVideo: false, hasAudio: true, videoConstraint: "absent" as const,
        audioConstraint: "codec-present" as const, fileSize: null,
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
    // Each case is internally coherent, so it is refused by THIS rule and not by
    // an agreement check. `hasAudio` means PROVEN audio, so an absent-video
    // shape whose audio is merely unknown proves no stream at all either.
    for (const audioConstraint of ["absent", "unknown"] as const) {
      assert.equal(
        GenericSourceSelectionSchema.safeParse({
          ...MUXED, container: "m4a", hasVideo: false, hasAudio: false,
          videoConstraint: "absent", audioConstraint,
        }).success,
        false,
        audioConstraint,
      );
    }
  });

  it("accepts the three coherent shapes", () => {
    for (const shape of [
      MUXED,
      UNKNOWN_VIDEO,
      {
        formatId: "140", protocol: "https" as const, container: "m4a" as const,
        hasVideo: false, hasAudio: true, videoConstraint: "absent" as const,
        audioConstraint: "codec-present" as const, fileSize: null,
      },
    ]) {
      assert.equal(GenericSourceSelectionSchema.safeParse(shape).success, true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001
//
// Audio used to be reduced to a boolean before it reached this module, so an
// UNKNOWN `acodec` arrived as `hasAudio: false` and the selector rebuilt that as
// `[acodec="none"]` — which the pinned runtime can never match against the
// `acodec: None` format it came from. The private selection now carries the
// three states as they are, and the selector's audio half follows them.
//
// None of this changes what is ADVERTISED: every generic preset still requires
// PROVEN audio. These tests pin the representation; the analysis tests pin the
// advertising policy.
// ─────────────────────────────────────────────────────────────────────────────

/** One coherent private selection per audio state, on the same muxed source. */
const AUDIO_PRESENT: GenericSourceSelection = MUXED;
const AUDIO_ABSENT: GenericSourceSelection = { ...MUXED, hasAudio: false, audioConstraint: "absent" };
const AUDIO_UNKNOWN: GenericSourceSelection = {
  ...MUXED,
  hasAudio: false,
  audioConstraint: "unknown",
};

describe("private audio constraint: the three states", () => {
  it("is exactly the closed tri-state vocabulary", () => {
    assert.deepEqual([...GENERIC_AUDIO_CONSTRAINTS], ["codec-present", "absent", "unknown"]);
  });

  it("accepts codec-present with hasAudio=true", () => {
    assert.equal(AUDIO_PRESENT.hasAudio, true);
    assert.equal(GenericSourceSelectionSchema.safeParse(AUDIO_PRESENT).success, true);
  });

  it("accepts absent with hasAudio=false", () => {
    assert.equal(GenericSourceSelectionSchema.safeParse(AUDIO_ABSENT).success, true);
  });

  it("accepts unknown with hasAudio=false — unknown is not proven audio", () => {
    assert.equal(GenericSourceSelectionSchema.safeParse(AUDIO_UNKNOWN).success, true);
    // The real affected shape: an unknown VIDEO codec (the HTML5 path) whose
    // audio is unknown too, because the page declared no `codecs=` at all.
    assert.equal(
      GenericSourceSelectionSchema.safeParse({
        ...UNKNOWN_VIDEO,
        hasAudio: false,
        audioConstraint: "unknown",
      }).success,
      true,
    );
  });

  const MISMATCHES: Array<[string, boolean]> = [
    ["codec-present", false],
    ["absent", true],
    ["unknown", true],
  ];
  for (const [audioConstraint, hasAudio] of MISMATCHES) {
    it(`rejects audioConstraint=${audioConstraint} with hasAudio=${hasAudio}`, () => {
      assert.equal(
        GenericSourceSelectionSchema.safeParse({ ...MUXED, audioConstraint, hasAudio }).success,
        false,
        "hasAudio is true exactly when audio is PROVEN",
      );
    });
  }

  it("rejects any value outside the closed vocabulary, and a missing one", () => {
    for (const audioConstraint of ["present", "none", "codec_present", "Unknown", "", null, undefined]) {
      assert.equal(
        GenericSourceSelectionSchema.safeParse({ ...MUXED, audioConstraint }).success,
        false,
        String(audioConstraint),
      );
    }
    const withoutConstraint: Record<string, unknown> = { ...MUXED };
    delete withoutConstraint.audioConstraint;
    assert.equal(GenericSourceSelectionSchema.safeParse(withoutConstraint).success, false);
  });
});

describe("private audio constraint: selector construction", () => {
  it("codec-present keeps the strict form", () => {
    assert.equal(
      buildGenericFormatSelector(AUDIO_PRESENT),
      'b*[format_id="22"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!="none"]',
    );
  });

  it("absent binds explicit absence", () => {
    assert.equal(
      buildGenericFormatSelector(AUDIO_ABSENT),
      'b*[format_id="22"][protocol="https"][ext="mp4"][vcodec!="none"][acodec="none"]',
    );
  });

  it("unknown uses the none-inclusive form", () => {
    assert.equal(
      buildGenericFormatSelector(AUDIO_UNKNOWN),
      'b*[format_id="22"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!=?"none"]',
    );
  });

  it("builds the real affected shape: unknown video codec AND unknown audio", () => {
    assert.equal(
      buildGenericFormatSelector({ ...UNKNOWN_VIDEO, hasAudio: false, audioConstraint: "unknown" }),
      'b*[format_id="0"][protocol="https"][ext="mp4"][vcodec!=?"none"][video_ext="mp4"][acodec!=?"none"]',
    );
  });

  it("decides the audio half from audioConstraint, never from hasAudio", () => {
    // absent and unknown share `hasAudio: false`. If the boolean still drove the
    // selector they would collapse onto one filter — which is precisely the
    // unknown->absent reduction this correction removes.
    assert.equal(AUDIO_ABSENT.hasAudio, AUDIO_UNKNOWN.hasAudio);
    assert.notEqual(
      buildGenericFormatSelector(AUDIO_ABSENT),
      buildGenericFormatSelector(AUDIO_UNKNOWN),
    );
  });

  it("binds id, protocol, container, video shape and exactly one audio filter, last", () => {
    for (const shape of [AUDIO_PRESENT, AUDIO_ABSENT, AUDIO_UNKNOWN]) {
      const selector = buildGenericFormatSelector(shape);
      const filters =
        selector.slice(GENERIC_FORMAT_SELECTOR_ATOM.length).match(/\[[^\]]+\]/g) ?? [];
      assert.deepEqual(filters.slice(0, 4), [
        '[format_id="22"]',
        '[protocol="https"]',
        '[ext="mp4"]',
        '[vcodec!="none"]',
      ]);
      assert.equal(filters.filter((f) => f.startsWith("[acodec")).length, 1, "one audio filter");
      assert.match(filters[filters.length - 1]!, /^\[acodec/, "the audio filter stays last");
      assert.doesNotMatch(selector, /\//, "no `/` fallback: one source or none");
      assert.doesNotMatch(selector, /\+/, "no `+` merge: generic v1 never merges streams");
      assert.doesNotMatch(selector, /audio_ext/, "audio_ext is never constrained");
    }
  });
});

describe("private audio constraint against pinned filter semantics", () => {
  /**
   * The same muxed source with its `acodec` in each state the pinned runtime
   * can hand a filter. `missing` is the real HTML5 case: with no `codecs=` on
   * the `<source type>`, `parse_codecs` returns `{}` and the key is never set
   * (see `testdata/pinned-generic-html5-no-audio-codec.json`).
   */
  const base: PinnedFormat = {
    format_id: "22",
    protocol: "https",
    ext: "mp4",
    vcodec: "avc1.640028",
  };
  const ACODEC: Array<[string, string | null | undefined]> = [
    ["missing", undefined],
    ["null", null],
    ["a real codec", "mp4a.40.2"],
    ["the absence marker", "none"],
  ];
  const EXPECTED: Record<string, Record<string, boolean>> = {
    // accepts only PRESENT
    "codec-present": {
      missing: false,
      null: false,
      "a real codec": true,
      "the absence marker": false,
    },
    // accepts only "none"
    absent: { missing: false, null: false, "a real codec": false, "the absence marker": true },
    // accepts UNKNOWN and a later-known codec; rejects PROVEN absence
    unknown: { missing: true, null: true, "a real codec": true, "the absence marker": false },
  };
  const SHAPES: Record<string, GenericSourceSelection> = {
    "codec-present": AUDIO_PRESENT,
    absent: AUDIO_ABSENT,
    unknown: AUDIO_UNKNOWN,
  };

  for (const constraint of GENERIC_AUDIO_CONSTRAINTS) {
    for (const [label, acodec] of ACODEC) {
      const want = EXPECTED[constraint]![label]!;
      it(`${constraint} ${want ? "selects" : "rejects"} acodec ${label}`, () => {
        const format: PinnedFormat = { ...base };
        if (acodec !== undefined) format.acodec = acodec;
        assert.equal(selectsFormat(buildGenericFormatSelector(SHAPES[constraint]!), format), want);
      });
    }
  }

  it("re-selecting an unknown state proves nothing about audio", () => {
    // The none-inclusive form matches an unknown AND a known codec: it states
    // "not proven absent", which is all analysis knew. It is a coherence
    // property of the selector, never a licence to advertise audio.
    const selector = buildGenericFormatSelector(AUDIO_UNKNOWN);
    assert.equal(selectsFormat(selector, { ...base }), true);
    assert.equal(selectsFormat(selector, { ...base, acodec: "mp4a.40.2" }), true);
    assert.equal(AUDIO_UNKNOWN.hasAudio, false, "and the selection still claims no audio");
  });

  it("THE LATENT DEFECT: rebuilding unknown as absent could never re-select it", () => {
    // What the boolean produced before this correction, for the real affected
    // shape. Pinned so the regression cannot come back unnoticed.
    const real: PinnedFormat = {
      format_id: "0",
      protocol: "https",
      ext: "mp4",
      vcodec: null,
      video_ext: "mp4",
      audio_ext: "none",
    };
    const collapsed = buildGenericFormatSelector({
      ...UNKNOWN_VIDEO,
      hasAudio: false,
      audioConstraint: "absent",
    });
    const honest = buildGenericFormatSelector({
      ...UNKNOWN_VIDEO,
      hasAudio: false,
      audioConstraint: "unknown",
    });
    assert.equal(selectsFormat(collapsed, real), false, "unknown->absent selects nothing");
    assert.equal(selectsFormat(honest, real), true, "the honest state re-selects its own source");
  });
});

describe("analysis -> selector round trip", () => {
  const LIMITS = { maxFileSizeBytes: 500 * 1024 * 1024 };

  /** A captured pinned-runtime document's formats, read exactly as analysis tests do. */
  function captured(name: string): Array<Record<string, unknown>> {
    const doc = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "analysis", "testdata", name), "utf8"),
    ) as { formats: Array<Record<string, unknown>> };
    return doc.formats;
  }

  /** Real-shaped raw formats covering every classification analysis makes. */
  const RAW: Array<Record<string, unknown>> = [
    {
      format_id: "22", ext: "mp4", protocol: "https", height: 720,
      vcodec: "avc1.64001F", acodec: "mp4a.40.2", video_ext: "mp4", audio_ext: "none",
    },
    {
      format_id: "43", ext: "webm", protocol: "https", height: 360,
      vcodec: "vp8", acodec: "vorbis", video_ext: "webm", audio_ext: "none",
    },
    {
      format_id: "137", ext: "mp4", protocol: "https", height: 1080,
      vcodec: "avc1.640028", acodec: "none", video_ext: "mp4", audio_ext: "none",
    },
    {
      format_id: "140", ext: "m4a", protocol: "https",
      vcodec: "none", acodec: "mp4a.40.2", video_ext: "none", audio_ext: "m4a",
    },
    {
      format_id: "html5-unknown-audio", ext: "mp4", protocol: "https",
      vcodec: null, video_ext: "mp4", audio_ext: "none",
    },
  ];

  function inputs(): Array<[string, Array<Record<string, unknown>>]> {
    return [
      ["pinned-generic-html5.json", captured("pinned-generic-html5.json")],
      [
        "pinned-generic-html5-no-audio-codec.json",
        captured("pinned-generic-html5-no-audio-codec.json"),
      ],
      ["a real-shaped mixed document", RAW],
      ...RAW.map((f): [string, Array<Record<string, unknown>>] => [`only ${String(f.format_id)}`, [f]]),
    ];
  }

  for (const ffmpegAvailable of [false, true]) {
    it(`every EMITTED selection re-selects its originating format (ffmpeg=${ffmpegAvailable})`, () => {
      let checked = 0;
      for (const [label, formats] of inputs()) {
        const { selections } = buildGenericPresets(selectCandidates(formats, LIMITS), {
          ffmpegAvailable,
        });
        for (const [presetId, presetSource] of Object.entries(selections)) {
          // SPLIT-01: a preset is fulfilled by one source or by a pair, and the
          // property holds for EVERY member either way — each half is acquired
          // by its own independent selector, so each half must re-select the
          // exact format it was approved from.
          const members =
            presetSource.kind === "single"
              ? [["source", presetSource.source] as const]
              : ([
                  ["video", presetSource.pair.video],
                  ["audio", presetSource.pair.audio],
                ] as const);

          for (const [half, selection] of members) {
            const origin = formats.find((f) => f.format_id === selection.formatId);
            assert.ok(
              origin,
              `${label} ${presetId} (${half}): the selection must name a real upstream format`,
            );
            assert.equal(
              selectsFormat(buildGenericFormatSelector(selection), origin as PinnedFormat),
              true,
              `${label} ${presetId} (${half}): analysis approved a format acquisition cannot re-select`,
            );
            checked += 1;
          }
        }
      }
      assert.ok(checked > 0, "the property must actually be exercised");
    });
  }

  it("EVERY candidate — advertised or not — describes a selector that re-selects it", () => {
    // Stronger than the emitted set: this includes the unknown-audio and
    // video-only candidates analysis keeps privately but never advertises,
    // which is exactly where the old boolean built an incoherent selector.
    const states = new Set<string>();
    for (const [label, formats] of inputs()) {
      for (const c of selectCandidates(formats, LIMITS)) {
        const selection = GenericSourceSelectionSchema.parse({
          formatId: c.formatId,
          protocol: c.protocol,
          container: c.container,
          hasVideo: c.hasVideo,
          hasAudio: c.hasAudio,
          videoConstraint: c.videoConstraint,
          audioConstraint: c.audioConstraint,
          fileSize: c.fileSize,
        });
        const origin = formats.find((f) => f.format_id === c.formatId);
        assert.ok(origin);
        assert.equal(
          selectsFormat(buildGenericFormatSelector(selection), origin as PinnedFormat),
          true,
          `${label} ${c.formatId} (${c.audioConstraint})`,
        );
        states.add(c.audioConstraint);
      }
    }
    assert.deepEqual([...states].sort(), ["absent", "codec-present", "unknown"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT-01: the private split video+audio pair
//
// This module is the one place a raw upstream id may exist, and a split pair
// holds TWO of them. These cases pin the invariants that make an INVALID pair
// unrepresentable rather than merely unbuilt — which is the whole reason the
// representation lands before anything can construct one.
// ─────────────────────────────────────────────────────────────────────────────

/** A video-only mp4 half: carries video, PROVEN to carry no audio. */
const SPLIT_VIDEO_MP4: GenericSourceSelection = {
  formatId: "137",
  protocol: "https",
  container: "mp4",
  hasVideo: true,
  hasAudio: false,
  videoConstraint: "codec-present",
  audioConstraint: "absent",
  fileSize: 9_000_000,
};

/** An audio-only m4a half: PROVEN audio, PROVEN to carry no video. */
const SPLIT_AUDIO_M4A: GenericSourceSelection = {
  formatId: "140",
  protocol: "https",
  container: "m4a",
  hasVideo: false,
  hasAudio: true,
  videoConstraint: "absent",
  audioConstraint: "codec-present",
  fileSize: 500_000,
};

const SPLIT_VIDEO_WEBM: GenericSourceSelection = {
  ...SPLIT_VIDEO_MP4,
  formatId: "248",
  container: "webm",
};

const SPLIT_AUDIO_WEBM: GenericSourceSelection = {
  ...SPLIT_AUDIO_M4A,
  formatId: "251",
  container: "webm",
};

describe("split pairs: the closed container table (SPLIT-01)", () => {
  it("maps exactly two combinations and refuses every other one", () => {
    const containers = [
      "mp4",
      "webm",
      "m4a",
      "mp3",
      "ogg",
      "opus",
      "aac",
      "flac",
      "wav",
    ] as const;

    const accepted: string[] = [];
    for (const video of containers) {
      for (const audio of containers) {
        const target = splitTargetContainer(video, audio);
        if (target !== null) accepted.push(`${video}+${audio}=${target}`);
      }
    }

    // Exhaustive over the whole source-container vocabulary: the table is two
    // rows, and widening it must break this test rather than pass silently.
    assert.deepEqual(accepted.sort(), ["mp4+m4a=mp4", "webm+webm=webm"]);
  });

  it("refuses every CROSS-FAMILY combination", () => {
    // These are the combinations that would need codec knowledge to be safe —
    // Opus in mp4 works, Vorbis in mp4 does not, PCM in mp4 barely does. The
    // table excludes them all, which is what lets the merge be a pure stream
    // copy with no codec string consulted anywhere.
    assert.equal(splitTargetContainer("mp4", "webm"), null);
    assert.equal(splitTargetContainer("webm", "m4a"), null);
    assert.equal(splitTargetContainer("mp4", "opus"), null);
    assert.equal(splitTargetContainer("mp4", "wav"), null);
    assert.equal(splitTargetContainer("webm", "mp3"), null);
  });

  it("refuses an AUDIO container as the video half, and vice versa", () => {
    assert.equal(splitTargetContainer("m4a", "m4a"), null);
    assert.equal(splitTargetContainer("mp3", "m4a"), null);
    assert.equal(splitTargetContainer("mp4", "mp4"), null);
  });
});

describe("split pairs: cross-member invariants (SPLIT-01)", () => {
  const pair = (
    video: Partial<GenericSourceSelection> = {},
    audio: Partial<GenericSourceSelection> = {},
  ) => ({
    video: { ...SPLIT_VIDEO_MP4, ...video },
    audio: { ...SPLIT_AUDIO_M4A, ...audio },
  });

  it("accepts the two legal pairs", () => {
    assert.equal(GenericSplitSourceSelectionSchema.safeParse(pair()).success, true);
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse({
        video: SPLIT_VIDEO_WEBM,
        audio: SPLIT_AUDIO_WEBM,
      }).success,
      true,
    );
  });

  it("I1: the video member must actually carry video", () => {
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse({
        video: SPLIT_AUDIO_M4A,
        audio: SPLIT_AUDIO_WEBM,
      }).success,
      false,
    );
  });

  it("I1: the video member may be established by EITHER approved video constraint", () => {
    // `video-ext` is the unknown-codec-but-coherent-shape case, which is the
    // same evidence standard already accepted for muxed video presets.
    for (const videoConstraint of ["codec-present", "video-ext"] as const) {
      assert.equal(
        GenericSplitSourceSelectionSchema.safeParse(pair({ videoConstraint })).success,
        true,
        videoConstraint,
      );
    }
  });

  it("I2: the video member's audio must be PROVEN ABSENT, never unknown and never present", () => {
    // The heart of "UNKNOWN is never silently upgraded". An unknown-audio video
    // half might really be muxed, in which case the job would fetch audio twice
    // and then discard the source's own track via the stream map.
    for (const audioConstraint of ["unknown", "codec-present"] as const) {
      const hasAudio = audioConstraint === "codec-present";
      assert.equal(
        GenericSplitSourceSelectionSchema.safeParse(pair({ audioConstraint, hasAudio })).success,
        false,
        audioConstraint,
      );
    }
  });

  it("I3: the audio member's video must be PROVEN ABSENT, never unknown-shaped", () => {
    for (const videoConstraint of ["codec-present", "video-ext"] as const) {
      assert.equal(
        GenericSplitSourceSelectionSchema.safeParse(
          pair({}, { videoConstraint, hasVideo: true, container: "mp4" }),
        ).success,
        false,
        videoConstraint,
      );
    }
  });

  it("I4: UNKNOWN audio can never masquerade as the PROVEN audio half", () => {
    // An `unknown` audio state is a coherent private description of a source,
    // but it establishes nothing. A pair built on it would merge a track that
    // may not exist.
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse(
        pair({}, { audioConstraint: "unknown", hasAudio: false }),
      ).success,
      false,
    );
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse(
        pair({}, { audioConstraint: "absent", hasAudio: false }),
      ).success,
      false,
    );
  });

  it("I5: the two halves must be two DIFFERENT upstream sources", () => {
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse(pair({}, { formatId: SPLIT_VIDEO_MP4.formatId }))
        .success,
      false,
    );
  });

  it("I6: the container combination must be in the closed table", () => {
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse({
        video: SPLIT_VIDEO_MP4,
        audio: SPLIT_AUDIO_WEBM,
      }).success,
      false,
      "mp4 video + webm audio is not a pair",
    );
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse({
        video: SPLIT_VIDEO_WEBM,
        audio: SPLIT_AUDIO_M4A,
      }).success,
      false,
      "webm video + m4a audio is not a pair",
    );
  });

  it("each member is still validated by the MEMBER schema", () => {
    // An unsafe raw id, an unsafe protocol and a shape/container mismatch must
    // all be caught on either half — the pair schema adds invariants, it does
    // not replace the ones that already exist.
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse(pair({ formatId: "22[ext=mp4]" })).success,
      false,
    );
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse(pair({}, { formatId: "bv+ba" })).success,
      false,
    );
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse(pair({ protocol: "m3u8" as never })).success,
      false,
    );
  });

  it("is strict: a missing half or an extra key is refused", () => {
    assert.equal(GenericSplitSourceSelectionSchema.safeParse({ video: SPLIT_VIDEO_MP4 }).success, false);
    assert.equal(GenericSplitSourceSelectionSchema.safeParse({ audio: SPLIT_AUDIO_M4A }).success, false);
    assert.equal(
      GenericSplitSourceSelectionSchema.safeParse({ ...pair(), targetContainer: "mp4" }).success,
      false,
      "the target is DERIVED from the pair; it may not be asserted alongside it",
    );
  });
});

describe("split pairs: the per-preset discriminated union (SPLIT-01)", () => {
  it("accepts both fulfilment shapes", () => {
    assert.equal(
      GenericPresetSourceSchema.safeParse({ kind: "single", source: MUXED }).success,
      true,
    );
    assert.equal(
      GenericPresetSourceSchema.safeParse({
        kind: "split",
        pair: { video: SPLIT_VIDEO_MP4, audio: SPLIT_AUDIO_M4A },
      }).success,
      true,
    );
  });

  it("refuses a BARE selection — the shape an older build would have written", () => {
    // The per-preset value used to be a bare `GenericSourceSelection`. A durable
    // or in-flight value in that shape is refused rather than interpreted
    // charitably, so an old producer cannot silently keep working.
    assert.equal(GenericPresetSourceSchema.safeParse(MUXED).success, false);
  });

  it("refuses a mismatched or unknown discriminator", () => {
    assert.equal(
      GenericPresetSourceSchema.safeParse({
        kind: "single",
        pair: { video: SPLIT_VIDEO_MP4, audio: SPLIT_AUDIO_M4A },
      }).success,
      false,
    );
    assert.equal(
      GenericPresetSourceSchema.safeParse({ kind: "split", source: MUXED }).success,
      false,
    );
    assert.equal(GenericPresetSourceSchema.safeParse({ kind: "merge", source: MUXED }).success, false);
    assert.equal(GenericPresetSourceSchema.safeParse({ source: MUXED }).success, false);
  });

  it("is strict on both variants", () => {
    assert.equal(
      GenericPresetSourceSchema.safeParse({ kind: "single", source: MUXED, extra: 1 }).success,
      false,
    );
    assert.equal(
      GenericPresetSourceSchema.safeParse({
        kind: "split",
        pair: { video: SPLIT_VIDEO_MP4, audio: SPLIT_AUDIO_M4A },
        targetContainer: "mp4",
      }).success,
      false,
    );
  });

  it("the narrowing helpers agree with the discriminator", () => {
    const single = GenericPresetSourceSchema.parse({ kind: "single", source: MUXED });
    const split = GenericPresetSourceSchema.parse({
      kind: "split",
      pair: { video: SPLIT_VIDEO_MP4, audio: SPLIT_AUDIO_M4A },
    });
    assert.deepEqual(asSingleSource(single), MUXED);
    assert.equal(asSplitPair(single), null);
    assert.equal(asSingleSource(split), null);
    assert.equal(asSplitPair(split)?.video.formatId, "137");
  });
});

describe("split pairs: each half gets its own complete selector (SPLIT-01)", () => {
  it("binds every property the half was approved on, with no merge grammar", () => {
    // Two independent expressions, never one joined `video+audio` expression.
    assert.equal(
      buildGenericFormatSelector(SPLIT_VIDEO_MP4),
      'b*[format_id="137"][protocol="https"][ext="mp4"][vcodec!="none"][acodec="none"]',
    );
    assert.equal(
      buildGenericFormatSelector(SPLIT_AUDIO_M4A),
      'b*[format_id="140"][protocol="https"][ext="m4a"][vcodec="none"][acodec!="none"]',
    );
  });

  it("neither half's selector can carry a merge or a fallback operator", () => {
    for (const half of [SPLIT_VIDEO_MP4, SPLIT_AUDIO_M4A, SPLIT_VIDEO_WEBM, SPLIT_AUDIO_WEBM]) {
      const selector = buildGenericFormatSelector(half);
      assert.equal(selector.includes("+"), false, "no merge operator");
      assert.equal(selector.includes("/"), false, "no fallback operator");
      assert.equal(selector.startsWith(GENERIC_FORMAT_SELECTOR_ATOM), true);
    }
  });

  it("the video half is bound to PROVEN audio absence, strictly", () => {
    // `[acodec="none"]` matches the explicit marker and nothing else, so a
    // source that GAINED an audio codec between analysis and acquisition fails
    // selection instead of being acquired as materially different media.
    assert.equal(buildGenericFormatSelector(SPLIT_VIDEO_MP4).includes('[acodec="none"]'), true);
    assert.equal(buildGenericFormatSelector(SPLIT_AUDIO_M4A).includes('[vcodec="none"]'), true);
  });
});
