#!/usr/bin/env python3
"""Non-network verification of the Phase-10C3 generic ACQUISITION policy.

Runs INSIDE the Worker image against the exact pinned yt-dlp runtime. It parses
the application's argv with yt-dlp's OWN option parser and inspects the
resulting options object; it never constructs a YoutubeDL that touches a
network, and it is designed to be run with `--network none`.

What it proves (§66):

  2. every option the generic download command uses exists in the pinned
     release and parses to the intended value;
  4. the acquisition PATH resolves nothing — not ffmpeg, ffprobe, deno, bun or
     any QuickJS binary;
  5. the approved absolute Node path still executes;
  6. under the fixed nonexistent --ffmpeg-location, the pinned release reports
     FFmpeg and ffprobe as UNAVAILABLE, and FFmpegFD is unavailable with it.

Usage:
    /usr/bin/python3 verify-download-policy.py /usr/local/lib/videofetch/yt-dlp
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

EXPECTED_VERSION = "2026.08.19"

DEAD_PATH = "/nonexistent/videofetch-yt-dlp-no-path"
DEAD_FFMPEG = "/nonexistent/videofetch-yt-dlp-no-ffmpeg"
MAX_BYTES = 524288000
SELECTOR = 'b*[format_id="22"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!="none"]'
WORKDIR = "/tmp/videofetch/job"

failures: list[str] = []


def expect(label: str, actual, wanted) -> None:
    ok = actual == wanted
    print(f"  [{'ok' if ok else 'FAIL'}] {label}: {actual!r}")
    if not ok:
        failures.append(f"{label}: expected {wanted!r}, got {actual!r}")


def expect_true(label: str, value: bool) -> None:
    print(f"  [{'ok' if value else 'FAIL'}] {label}")
    if not value:
        failures.append(label)


def main(artifact: str) -> int:
    sys.path.insert(0, artifact)
    from yt_dlp.options import create_parser
    from yt_dlp.version import __version__

    if __version__ != EXPECTED_VERSION:
        print(f"FAIL: expected yt-dlp {EXPECTED_VERSION}, got {__version__}")
        return 2
    print(f"pinned runtime: yt-dlp {__version__}\n")

    # ── 2. the complete generic download argv, through the pinned parser ─────
    print("2. the generic acquisition option set parses as intended")
    argv = [
        # Phase-10C1 closed base policy
        "--ignore-config",
        "--no-config-locations",
        "--no-plugin-dirs",
        "--no-js-runtimes",
        f"--js-runtimes=node:{sys.argv[2] if len(sys.argv) > 2 else '/usr/local/bin/node'}",
        "--no-remote-components",
        "--no-update",
        "--no-cookies",
        "--no-cookies-from-browser",
        "--no-playlist",
        "--downloader=native",
        # Phase-10C3 acquisition policy
        "--no-cache-dir",
        "--quiet",
        "--no-progress",
        "--no-warnings",
        "--socket-timeout=10",
        "--retries=2",
        "--fragment-retries=1",
        "--extractor-retries=1",
        f"--ffmpeg-location={DEAD_FFMPEG}",
        "--fixup=never",
        f"--max-filesize={MAX_BYTES}",
        "--concurrent-fragments=1",
        "--no-keep-fragments",
        "--no-mtime",
        "--no-overwrites",
        f"--format={SELECTOR}",
        f"--output={WORKDIR}/source.%(ext)s",
        "--",
        "https://example.invalid/watch/abc",
    ]

    try:
        opts, args = create_parser().parse_args(argv)
    except SystemExit:
        print("  [FAIL] the pinned parser REJECTED the acquisition argv")
        return 1

    expect("fixup policy", opts.fixup, "never")
    expect("format selector", opts.format, SELECTOR)
    expect("output template", opts.outtmpl, {"default": f"{WORKDIR}/source.%(ext)s"})
    # The parser stores these as RAW STRINGS; `yt_dlp/__init__.py` converts them
    # with validate_bytes()/parse_retries() before building YoutubeDL. Both the
    # parsed form and the converted value are asserted, so a future release that
    # changed either would be caught.
    expect("max_filesize (raw)", opts.max_filesize, str(MAX_BYTES))
    expect("downloader", opts.external_downloader, {"default": "native"})
    expect("ffmpeg location", opts.ffmpeg_location, DEAD_FFMPEG)
    expect("concurrent fragments", opts.concurrent_fragment_downloads, 1)
    expect("keep fragments", opts.keep_fragments, False)
    expect("overwrites", opts.overwrites, False)
    expect("updatetime (--no-mtime)", opts.updatetime, False)
    expect("retries (raw)", opts.retries, "2")
    expect("fragment retries (raw)", opts.fragment_retries, "1")

    from yt_dlp.utils import parse_bytes
    expect("max_filesize converts to the intended byte count", parse_bytes(opts.max_filesize), MAX_BYTES)
    expect("retries converts to an int", int(opts.retries), 2)
    expect("fragment retries converts to an int", int(opts.fragment_retries), 1)
    expect("socket timeout", opts.socket_timeout, 10.0)
    expect("URL parsed as positional, not as an option", args, ["https://example.invalid/watch/abc"])

    # Forbidden behaviours must be absent/neutral in the parsed options.
    expect("no audio extraction", getattr(opts, "extractaudio", False), False)
    expect("no merge container", getattr(opts, "merge_output_format", None), None)
    expect("no remux", getattr(opts, "remuxvideo", None), None)
    expect("no recode", getattr(opts, "recodevideo", None), None)
    expect("no exec commands", getattr(opts, "exec_cmd", {}) or {}, {})
    expect("no download sections", getattr(opts, "download_ranges", None), None)
    # `writeinfojson` defaults to None ("not requested"); --no-write-info-json
    # would set it to False. Either way it must be FALSY.
    expect_true("no info json written", not getattr(opts, "writeinfojson", None))
    expect("no subtitles written", getattr(opts, "writesubtitles", False), False)
    expect("no thumbnail written", getattr(opts, "writethumbnail", False), False)
    expect("no cookies file", getattr(opts, "cookiefile", None), None)
    expect("no cookies from browser", getattr(opts, "cookiesfrombrowser", None), None)

    # ── 4. the acquisition PATH resolves nothing ────────────────────────────
    print("\n4. the acquisition PATH resolves no media or JS tooling")
    for tool in ("ffmpeg", "ffprobe", "deno", "bun", "qjs", "quickjs", "avconv"):
        found = shutil.which(tool, path=DEAD_PATH)
        expect(f"{tool} unresolvable on the acquisition PATH", found, None)

    # The image DOES ship ffmpeg — that is the point of the dead PATH. Prove
    # the tool exists so the check above is meaningful rather than vacuous.
    real_ffmpeg = shutil.which("ffmpeg", path="/usr/bin:/bin")
    expect_true(
        "ffmpeg genuinely exists in the image (so the dead PATH is doing real work)",
        real_ffmpeg is not None,
    )

    # ── 5. the approved absolute Node still executes ────────────────────────
    print("\n5. the approved absolute Node path still executes")
    node = sys.argv[2] if len(sys.argv) > 2 else "/usr/local/bin/node"
    try:
        out = subprocess.run(
            [node, "-e", "process.stdout.write('node-ok')"],
            capture_output=True,
            text=True,
            timeout=30,
            env={"PATH": DEAD_PATH},
        )
        expect("node executes by absolute path under the dead PATH", out.stdout, "node-ok")
    except Exception as exc:
        expect("node executes by absolute path under the dead PATH", f"{type(exc).__name__}", "node-ok")

    # ── 6. the pinned release sees FFmpeg as unavailable ────────────────────
    print("\n6. the pinned release treats FFmpeg as UNAVAILABLE under the fixed location")
    os.environ["PATH"] = DEAD_PATH
    from yt_dlp import YoutubeDL
    from yt_dlp.postprocessor.ffmpeg import FFmpegPostProcessor
    from yt_dlp.downloader.external import FFmpegFD

    ydl = YoutubeDL({"quiet": True, "simulate": True, "ffmpeg_location": DEAD_FFMPEG})
    pp = FFmpegPostProcessor(ydl)
    expect("FFmpegPostProcessor.available", bool(pp.available), False)
    expect("FFmpegPostProcessor.probe_available", bool(pp.probe_available), False)
    expect("resolved executable map is empty", dict(pp._paths or {}), {})
    expect("FFmpegFD.available()", bool(FFmpegFD.available()), False)

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("ALL DOWNLOAD-POLICY EXPECTATIONS HOLD")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
