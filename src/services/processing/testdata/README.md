# Pinned ffprobe output (SPLIT-02)

These six documents are **verbatim ffprobe stdout** captured from the accepted
Worker image, not invented fixtures.

| Provenance | Value |
| --- | --- |
| Image | `videofetch-worker:e4fa646bf7492e16fc8d2733982f708a1e243afb` |
| Image digest | `sha256:c3995e18dd3c51d6ddb186e3a3186360d24a2053439e067b71c7dec029f878fa` |
| ffprobe | `ffprobe version 5.1.9-0+deb12u1` (Debian Bookworm) |
| Capture | `docker run --rm --network none`, synthetic lavfi media only |

The exact command was the one `buildProbeArgs()` produces:

```
/usr/bin/ffprobe -v error -protocol_whitelist file -f <mov|matroska> \
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

It also bounds what the probe can prove: the family and the stream shape, never
the ISO-BMFF subtype. The subtype comes from the SPLIT-01 pair table and the
fixed-path acquisition policy.

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
