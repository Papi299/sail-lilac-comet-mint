#!/usr/bin/env python3
"""Non-network behavioural verification of the Phase-10C3 generic format selector.

Runs INSIDE the Worker image, against the exact pinned yt-dlp runtime, using
only synthetic format dictionaries. It contacts no media website, resolves no
hostname and opens no socket: `build_format_selector` is a pure function over
the format list it is handed.

What it proves (§52):

  1. the selector this application builds selects EXACTLY the intended
     format_id, and nothing else;
  2. it does not fall through to another format of the same extension, to
     `best`, to a different protocol, to a video-only rendition where a muxed
     one was approved, or to a different container;
  3. an UNQUOTED numeric `format_id` filter silently matches nothing — the
     precise trap the application-owned quoting exists to avoid;
  4. the `b*` atom performs no fallback even when `incomplete_formats` is set,
     whereas the implicit `best` atom does;
  5. the audio half follows the private tri-state audio constraint
     (GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001): a PRESENT constraint matches
     a present codec only, an ABSENT one matches `"none"` only, and an UNKNOWN
     one matches an unknown or later-known codec but never `"none"`.

Exit status is 0 only when every expectation holds.

Usage:
    /usr/bin/python3 verify-selector.py /usr/local/lib/videofetch/yt-dlp
"""

from __future__ import annotations

import sys

EXPECTED_VERSION = "2026.08.19"

# The application-owned selector, mirrored from
# src/worker/execution/generic-source.ts `buildGenericFormatSelector`.
ATOM = "b*"


def build_selector(
    format_id: str,
    protocol: str,
    ext: str,
    audio_constraint: str,
    video_constraint: str,
) -> str:
    """Mirrors `buildGenericFormatSelector`, including both shape branches.

    `video_constraint` is the application-owned enum from
    src/worker/execution/generic-source.ts:

        codec-present  analysis saw a real video codec        -> strict
        video-ext      analysis saw vcodec=None but a coherent
                       normalized shape (the Generic HTML5 case) -> none-inclusive
        absent         analysis saw vcodec="none"             -> strict absence

    `audio_constraint` is the application-owned audio enum from the same module,
    mirroring `classifyCodecState(acodec)` one-for-one:

        codec-present  analysis saw a real audio codec        -> strict
        absent         analysis saw acodec="none"             -> strict absence
        unknown        acodec was None, empty or missing      -> none-inclusive
    """
    if video_constraint == "codec-present":
        video = [f'[vcodec!="none"]']
    elif video_constraint == "video-ext":
        video = [f'[vcodec!=?"none"]', f'[video_ext="{ext}"]']
    elif video_constraint == "absent":
        video = [f'[vcodec="none"]']
    else:
        raise AssertionError(f"unknown video constraint {video_constraint!r}")

    if audio_constraint == "codec-present":
        audio = '[acodec!="none"]'
    elif audio_constraint == "absent":
        audio = '[acodec="none"]'
    elif audio_constraint == "unknown":
        audio = '[acodec!=?"none"]'
    else:
        raise AssertionError(f"unknown audio constraint {audio_constraint!r}")

    parts = [
        f'[format_id="{format_id}"]',
        f'[protocol="{protocol}"]',
        f'[ext="{ext}"]',
        *video,
        # `acodec` is the only audio authority, and the private audio
        # constraint decides its form. `audio_ext` is deliberately never
        # constrained: `_fill_sorting_fields` sets it to "none" on every format
        # whose vcodec != "none", so binding it would match nothing.
        audio,
    ]
    return ATOM + "".join(parts)


# Synthetic formats only. Every URL is a reserved-for-documentation name that
# is never contacted: the selector never dereferences it.
FORMATS = [
    {"format_id": "22", "ext": "mp4", "protocol": "https",
     "vcodec": "avc1.64001F", "acodec": "mp4a.40.2", "height": 720, "url": "https://example.invalid/1"},
    {"format_id": "18", "ext": "mp4", "protocol": "https",
     "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "height": 360, "url": "https://example.invalid/2"},
    # Same container, HIGHER quality, but video-only: must never be substituted
    # for an approved muxed selection.
    {"format_id": "137", "ext": "mp4", "protocol": "https",
     "vcodec": "avc1.640028", "acodec": "none", "height": 1080, "url": "https://example.invalid/3"},
    {"format_id": "140", "ext": "m4a", "protocol": "https",
     "vcodec": "none", "acodec": "mp4a.40.2", "height": None, "url": "https://example.invalid/4"},
    {"format_id": "251", "ext": "webm", "protocol": "https",
     "vcodec": "none", "acodec": "opus", "height": None, "url": "https://example.invalid/5"},
    {"format_id": "248", "ext": "webm", "protocol": "https",
     "vcodec": "vp9", "acodec": "none", "height": 1080, "url": "https://example.invalid/6"},
    # Same id shape but a manifest protocol: the protocol constraint must bind.
    {"format_id": "hls-720", "ext": "mp4", "protocol": "m3u8_native",
     "vcodec": "avc1", "acodec": "mp4a", "height": 720, "url": "https://example.invalid/7"},
    {"format_id": "muxed-webm", "ext": "webm", "protocol": "https",
     "vcodec": "vp9", "acodec": "opus", "height": 720, "url": "https://example.invalid/8"},
    # ── The REAL pinned Generic HTML5 shape ─────────────────────────────────
    # `_parse_html5_media_entries` builds the plain-media dict with
    # `'vcodec': None` and then `f.update(formats[0])` overwrites the codec that
    # the `<source type="…; codecs=…">` attribute had already parsed, so the
    # video codec identity is genuinely UNKNOWN. `_fill_sorting_fields` then
    # sets `video_ext = ext` and `audio_ext = 'none'` because `vcodec != 'none'`
    # (None is not the string "none"). This is what every generic HTML5 page
    # produces, and it is the shape the merged Phase-10D fixtures exposed.
    {"format_id": "html5", "ext": "mp4", "protocol": "https",
     "vcodec": None, "acodec": "mp4a.40.2", "video_ext": "mp4", "audio_ext": "none",
     "height": None, "url": "https://example.invalid/9"},
    # Same shape, but the extractor DID name the codec on a later extraction.
    {"format_id": "html5-known", "ext": "mp4", "protocol": "https",
     "vcodec": "avc1.42E01E", "acodec": "mp4a.40.2", "video_ext": "mp4", "audio_ext": "none",
     "height": None, "url": "https://example.invalid/10"},
    # Same id shape, but video is now explicitly ABSENT.
    {"format_id": "html5-audio", "ext": "mp4", "protocol": "https",
     "vcodec": "none", "acodec": "mp4a.40.2", "video_ext": "none", "audio_ext": "mp4",
     "height": None, "url": "https://example.invalid/11"},
    # ── The same HTML5 shape with NO declared audio codec ──────────────────
    # When the page's `<source type>` carries no `codecs=` parameter,
    # `parse_codecs` returns `{}` and `acodec` is never set: the key is simply
    # ABSENT from the format, not None. Captured from the pinned runtime in
    # src/worker/analysis/testdata/pinned-generic-html5-no-audio-codec.json.
    {"format_id": "html5-noacodec", "ext": "mp4", "protocol": "https",
     "vcodec": None, "video_ext": "mp4", "audio_ext": "none",
     "height": None, "url": "https://example.invalid/12"},
    # The same, with the key present but explicitly None.
    {"format_id": "html5-acodec-null", "ext": "mp4", "protocol": "https",
     "vcodec": None, "acodec": None, "video_ext": "mp4", "audio_ext": "none",
     "height": None, "url": "https://example.invalid/13"},
    # The same shape with audio proven ABSENT (a `codecs=` naming video only
    # makes `parse_codecs` fill in `acodec or 'none'`).
    {"format_id": "html5-noaudio", "ext": "mp4", "protocol": "https",
     "vcodec": None, "acodec": "none", "video_ext": "mp4", "audio_ext": "none",
     "height": None, "url": "https://example.invalid/14"},
]


def main(artifact: str) -> int:
    sys.path.insert(0, artifact)
    try:
        from yt_dlp import YoutubeDL
        from yt_dlp.version import __version__
    except Exception as exc:  # pragma: no cover - import failure is a hard stop
        print(f"FAIL: cannot import pinned yt_dlp from {artifact}: {type(exc).__name__}")
        return 2

    if __version__ != EXPECTED_VERSION:
        print(f"FAIL: expected yt-dlp {EXPECTED_VERSION}, got {__version__}")
        return 2
    print(f"pinned runtime: yt-dlp {__version__}")

    def select(spec: str, incomplete: bool = False) -> list[str] | str:
        ydl = YoutubeDL({"quiet": True, "simulate": True})
        try:
            fn = ydl.build_format_selector(spec)
        except Exception as exc:
            return f"PARSE_ERROR:{type(exc).__name__}"
        try:
            ctx = {"formats": list(FORMATS), "incomplete_formats": incomplete}
            return [f.get("format_id") for f in fn(ctx)]
        except Exception as exc:
            return f"EVAL_ERROR:{type(exc).__name__}"

    failures: list[str] = []

    def expect(label: str, actual, wanted) -> None:
        # A parse-failure expectation only pins the ERROR KIND, because the
        # message text is not a contract; everything else is exact.
        if isinstance(wanted, str) and wanted.startswith("PARSE_ERROR"):
            ok = isinstance(actual, str) and actual.startswith(wanted)
        else:
            ok = actual == wanted
        print(f"  [{'ok' if ok else 'FAIL'}] {label}: {actual!r}")
        if not ok:
            failures.append(f"{label}: expected {wanted!r}, got {actual!r}")

    print("\n1. the built selector picks exactly the approved format")
    expect("muxed mp4 https 22",
           select(build_selector("22", "https", "mp4", "codec-present", "codec-present")), ["22"])
    expect("muxed mp4 https 18",
           select(build_selector("18", "https", "mp4", "codec-present", "codec-present")), ["18"])
    expect("audio-only m4a 140",
           select(build_selector("140", "https", "m4a", "codec-present", "absent")), ["140"])
    expect("audio-only webm 251",
           select(build_selector("251", "https", "webm", "codec-present", "absent")), ["251"])
    expect("muxed webm",
           select(build_selector("muxed-webm", "https", "webm", "codec-present", "codec-present")), ["muxed-webm"])

    print("\n2. no substitution when the source no longer matches")
    expect("video-only id under a muxed constraint",
           select(build_selector("137", "https", "mp4", "codec-present", "codec-present")), [])
    expect("manifest protocol under an https constraint",
           select(build_selector("hls-720", "https", "mp4", "codec-present", "codec-present")), [])
    expect("wrong container",
           select(build_selector("22", "https", "webm", "codec-present", "codec-present")), [])
    expect("unknown id",
           select(build_selector("does-not-exist", "https", "mp4", "codec-present", "codec-present")), [])
    expect("audio constraint against a muxed id",
           select(build_selector("22", "https", "mp4", "codec-present", "absent")), [])

    print("\n3. the quoting is load-bearing for numeric ids")
    expect("UNQUOTED numeric filter matches nothing",
           select('b*[format_id=22][protocol="https"][ext="mp4"]'), [])
    expect("quoted numeric filter matches",
           select('b*[format_id="22"][protocol="https"][ext="mp4"]'), ["22"])

    print("\n4. b* never falls back; implicit best does")
    for incomplete in (False, True):
        expect(f"b* audio-only, incomplete_formats={incomplete}",
               select(build_selector("140", "https", "m4a", "codec-present", "absent"), incomplete), ["140"])
        expect(f"b* unknown id, incomplete_formats={incomplete}",
               select(build_selector("nope", "https", "mp4", "codec-present", "codec-present"), incomplete), [])
    # The implicit atom is extractor-flag dependent, which is exactly why the
    # application always states `b*` explicitly.
    implicit = '[format_id="140"][protocol="https"][ext="m4a"]'
    expect("implicit best, audio-only, incomplete=False", select(implicit, False), [])
    expect("implicit best, audio-only, incomplete=True", select(implicit, True), ["140"])

    print("\n5. the REAL pinned Generic HTML5 shape (vcodec is None)")
    # The pinned runtime's `_build_format_filter` never passes a `None` field to
    # the operator at all:
    #
    #     def _filter(f):
    #         actual_value = f.get(m.group('key'))
    #         if actual_value is None:
    #             return m.group('none_inclusive')
    #         return op(actual_value, comparison_value)
    #
    # so the strict form silently matches NOTHING for a perfectly ordinary muxed
    # mp4, and the none-inclusive form is required. This is the acquisition half
    # of PHASE-10D-GENERIC-REAL-OUTPUT-COMPATIBILITY-001: analysis approving a
    # format that acquisition then rejects is still a defect.
    unknown = build_selector("html5", "https", "mp4", "codec-present", "video-ext")
    expect("approved unknown-codec source is re-selected", select(unknown), ["html5"])
    expect("THE DEFECT: the strict form selects nothing",
           select('b*[format_id="html5"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!="none"]'),
           [])
    expect("audio_ext must never be constrained: it is 'none' here",
           select('b*[format_id="html5"][audio_ext!="none"]'), [])
    expect("acodec IS the audio authority",
           select('b*[format_id="html5"][acodec!="none"]'), ["html5"])

    print("\n6. the unknown-video constraint stays closed")
    expect("a later KNOWN codec with the same shape still matches",
           select(build_selector("html5-known", "https", "mp4", "codec-present", "video-ext")), ["html5-known"])
    expect("an explicitly ABSENT video stream is rejected",
           select(build_selector("html5-audio", "https", "mp4", "codec-present", "video-ext")), [])
    expect("video_ext must still name the approved container",
           select('b*[format_id="html5"][protocol="https"][ext="mp4"][vcodec!=?"none"][video_ext="webm"][acodec!="none"]'),
           [])
    expect("WEAKENING it to admit vcodec='none' would select the wrong format",
           select('b*[format_id="html5-audio"][protocol="https"][ext="mp4"][acodec!="none"]'),
           ["html5-audio"])
    expect("known video is NOT weakened by the new state",
           select(build_selector("22", "https", "mp4", "codec-present", "codec-present")), ["22"])
    expect("a KNOWN-video approval no longer matches once the codec is gone",
           select(build_selector("html5", "https", "mp4", "codec-present", "codec-present")), [])

    print("\n7. the none-inclusive marker's position is the only valid one")
    for spec in ('b*[vcodec?!="none"]', 'b*[vcodec!?="none"]',
                 'b*[acodec?!="none"]', 'b*[acodec!?="none"]'):
        expect(f"{spec} is a syntax error", select(spec), 'PARSE_ERROR:SyntaxError')

    print("\n8. the audio half follows the private audio constraint")
    # GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001. The same `None` branch governs
    # `acodec`: a missing or None field matches only a none-inclusive filter.
    #
    #   codec-present  strict       matches PRESENT only
    #   absent         equality     matches "none" only
    #   unknown        none-incl.   matches UNKNOWN and PRESENT, never "none"
    def html5(fid: str, audio_constraint: str) -> list[str] | str:
        return select(build_selector(fid, "https", "mp4", audio_constraint, "video-ext"))

    expect("PRESENT re-selects a present codec",
           html5("html5", "codec-present"), ["html5"])
    expect("PRESENT rejects a MISSING acodec",
           html5("html5-noacodec", "codec-present"), [])
    expect("PRESENT rejects acodec=None",
           html5("html5-acodec-null", "codec-present"), [])
    expect("PRESENT rejects acodec='none'",
           html5("html5-noaudio", "codec-present"), [])

    expect("ABSENT re-selects acodec='none'",
           html5("html5-noaudio", "absent"), ["html5-noaudio"])
    expect("ABSENT rejects a present codec",
           html5("html5", "absent"), [])
    expect("ABSENT rejects a MISSING acodec",
           html5("html5-noacodec", "absent"), [])
    expect("ABSENT rejects acodec=None",
           html5("html5-acodec-null", "absent"), [])

    expect("UNKNOWN re-selects a MISSING acodec",
           html5("html5-noacodec", "unknown"), ["html5-noacodec"])
    expect("UNKNOWN re-selects acodec=None",
           html5("html5-acodec-null", "unknown"), ["html5-acodec-null"])
    expect("UNKNOWN still matches a later-known codec",
           html5("html5", "unknown"), ["html5"])
    expect("UNKNOWN rejects PROVEN absence",
           html5("html5-noaudio", "unknown"), [])

    # The same three forms on a KNOWN-video source.
    expect("ABSENT re-selects a proven video-only rendition",
           select(build_selector("137", "https", "mp4", "absent", "codec-present")), ["137"])
    expect("UNKNOWN on a known-video muxed source matches its known codec",
           select(build_selector("22", "https", "mp4", "unknown", "codec-present")), ["22"])
    expect("UNKNOWN never admits a video-only rendition",
           select(build_selector("137", "https", "mp4", "unknown", "codec-present")), [])

    print("\n9. the boolean it replaced could not describe unknown audio")
    # Before the correction unknown audio was `has_audio=False`, rebuilt as
    # `[acodec="none"]`. Flipping it to True would not have helped either.
    expect("THE LATENT DEFECT: unknown collapsed to absent selects nothing",
           select('b*[format_id="html5-noacodec"][protocol="https"][ext="mp4"]'
                  '[vcodec!=?"none"][video_ext="mp4"][acodec="none"]'), [])
    expect("...and unknown promoted to present selects nothing either",
           select('b*[format_id="html5-noacodec"][protocol="https"][ext="mp4"]'
                  '[vcodec!=?"none"][video_ext="mp4"][acodec!="none"]'), [])

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("ALL SELECTOR EXPECTATIONS HOLD")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
