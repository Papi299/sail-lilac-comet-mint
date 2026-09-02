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
     whereas the implicit `best` atom does.

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


def build_selector(format_id: str, protocol: str, ext: str, has_video: bool, has_audio: bool) -> str:
    parts = [
        f'[format_id="{format_id}"]',
        f'[protocol="{protocol}"]',
        f'[ext="{ext}"]',
        f'[vcodec{"!" if has_video else ""}="none"]',
        f'[acodec{"!" if has_audio else ""}="none"]',
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
        ok = actual == wanted
        print(f"  [{'ok' if ok else 'FAIL'}] {label}: {actual!r}")
        if not ok:
            failures.append(f"{label}: expected {wanted!r}, got {actual!r}")

    print("\n1. the built selector picks exactly the approved format")
    expect("muxed mp4 https 22",
           select(build_selector("22", "https", "mp4", True, True)), ["22"])
    expect("muxed mp4 https 18",
           select(build_selector("18", "https", "mp4", True, True)), ["18"])
    expect("audio-only m4a 140",
           select(build_selector("140", "https", "m4a", False, True)), ["140"])
    expect("audio-only webm 251",
           select(build_selector("251", "https", "webm", False, True)), ["251"])
    expect("muxed webm",
           select(build_selector("muxed-webm", "https", "webm", True, True)), ["muxed-webm"])

    print("\n2. no substitution when the source no longer matches")
    expect("video-only id under a muxed constraint",
           select(build_selector("137", "https", "mp4", True, True)), [])
    expect("manifest protocol under an https constraint",
           select(build_selector("hls-720", "https", "mp4", True, True)), [])
    expect("wrong container",
           select(build_selector("22", "https", "webm", True, True)), [])
    expect("unknown id",
           select(build_selector("does-not-exist", "https", "mp4", True, True)), [])
    expect("audio constraint against a muxed id",
           select(build_selector("22", "https", "mp4", False, True)), [])

    print("\n3. the quoting is load-bearing for numeric ids")
    expect("UNQUOTED numeric filter matches nothing",
           select('b*[format_id=22][protocol="https"][ext="mp4"]'), [])
    expect("quoted numeric filter matches",
           select('b*[format_id="22"][protocol="https"][ext="mp4"]'), ["22"])

    print("\n4. b* never falls back; implicit best does")
    for incomplete in (False, True):
        expect(f"b* audio-only, incomplete_formats={incomplete}",
               select(build_selector("140", "https", "m4a", False, True), incomplete), ["140"])
        expect(f"b* unknown id, incomplete_formats={incomplete}",
               select(build_selector("nope", "https", "mp4", True, True), incomplete), [])
    # The implicit atom is extractor-flag dependent, which is exactly why the
    # application always states `b*` explicitly.
    implicit = '[format_id="140"][protocol="https"][ext="m4a"]'
    expect("implicit best, audio-only, incomplete=False", select(implicit, False), [])
    expect("implicit best, audio-only, incomplete=True", select(implicit, True), ["140"])

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
