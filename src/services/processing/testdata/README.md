# Pinned ffprobe output (SPLIT-02, HLS-4)

These nine documents are **verbatim ffprobe stdout**, not invented fixtures.

The six `iso-bmff-*` and `webm-*` documents were captured for SPLIT-02:

| Provenance | Value |
| --- | --- |
| Image | `videofetch-worker:e4fa646bf7492e16fc8d2733982f708a1e243afb` |
| Image digest | `sha256:c3995e18dd3c51d6ddb186e3a3186360d24a2053439e067b71c7dec029f878fa` |
| ffprobe | `ffprobe version 5.1.9-0+deb12u1` (Debian Bookworm) |
| Capture | `docker run --rm --network none`, synthetic lavfi media only |

The three `mpegts-*` documents were captured for HLS-4:

| Provenance | Value |
| --- | --- |
| Image | `videofetch-worker:phase10c3-local` |
| Image digest | `sha256:3ff9bbdbc3af63c0b04383ada58225a5d3e6f95deed127bdaf06fbeb54239592` |
| ffprobe | `ffprobe version 5.1.9-0+deb12u1` (Debian Bookworm) — the SAME pinned build |
| Capture | `docker run --rm --network none`, synthetic lavfi media only |

That is a DIFFERENT image tag from the SPLIT-02 row, and the difference is
recorded rather than glossed: the accepted Production image was not retained on
the capture host, so a locally retained Worker image carrying the identical
pinned FFmpeg build (`5.1.9-0+deb12u1`, same Debian Bookworm package, same
`ffmpeg -version` string) was used instead. What these documents pin is the
behaviour of that FFmpeg build, which is what the Worker image installs; the
image tag is provenance, not the thing under test. If the Worker's pinned
FFmpeg ever changes, all nine documents must be recaptured together.

The exact command was the one `buildProbeArgs()` produces:

```
/usr/bin/ffprobe -v error -protocol_whitelist file -f <mov|matroska|mpegts> \
  -print_format json -show_entries format=format_name:stream=codec_type -i <file>
```

## Why these are pinned rather than hand-written

`format_name` does **not** report the specific container. It reports the
demuxer's whole alias group, so every ISO-BMFF file — MP4 and M4A alike —
reports `mov,mp4,m4a,3gp,3g2,mj2`, and every Matroska/WebM file reports
`matroska,webm`.

That is why `parseProbeDocument()` normalizes to an application-owned FAMILY
and why a naive `format_name === "mp4"` check would never match anything. These
files are what makes that regression a test failure instead of a surprise in
production.

MPEG-TS is the opposite shape and is pinned for the same reason: its demuxer
registers no aliases, so it reports the single token `mpegts`. The
`mpegts-*` captures also show the one structural difference from the ISO-BMFF
and WebM documents — the `programs` array is NOT empty, and it repeats the
elementary streams nested inside a program entry. `parseProbeDocument()` reads
only the TOP-LEVEL `streams` array, so those nested entries are inert and are
never counted twice; `pinned-ffprobe-mpegts-muxed.json` is what keeps that
true.

It also bounds what the probe can prove: the family and the stream shape, never
the ISO-BMFF subtype. The subtype comes from the SPLIT-01 pair table and the
fixed-path acquisition policy.

## Cross-family refusal (re-verified for HLS-4)

The explicit `-f` demuxer is a security control, and it was re-checked in both
directions against the same pinned build:

| Command | Result |
| --- | --- |
| `-f mov` on a real MPEG-TS file | exit 1, `moov atom not found` |
| `-f mpegts` on a real MP4 file | exit 1, `End of file` |
| `-f mpegts` on 4 KiB of `/dev/urandom` | exit 1, `End of file` |
| `-f mpegts -protocol_whitelist file -i http://…` | exit 1, `Protocol 'http' not on whitelist 'file'!` |

In every refusal ffprobe still prints an empty `{}` document on stdout, which
is why `probeLocalMedia()` gates on the exit code before parsing.

## Sanitization

Nothing was removed. The capture used `-show_entries` limited to
`format=format_name` and `stream=codec_type`, so the documents never contained a
filename, a path, a URL, a tag, a title, a codec name or a duration in the first
place. The synthetic inputs were `testsrc` and `sine` generated inside the
offline container.

## Regenerating

Only when the Worker's pinned FFmpeg changes, and then the change to these files
is the evidence for the review. Re-run the command above inside the new image,
offline, against synthetic media.

The MPEG-TS inputs were generated inside the offline container with:

```
ffmpeg -v error -y -f lavfi -i testsrc=duration=2:size=320x180:rate=15 \
  -f lavfi -i sine=frequency=440:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -f mpegts muxed.ts
```

with the single-stream variants using only the `testsrc` or only the `sine`
input.
