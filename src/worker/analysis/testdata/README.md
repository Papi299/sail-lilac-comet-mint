# Captured pinned-runtime analysis documents

Real `yt-dlp 2026.08.19` output, kept so the Worker's generic regressions cannot
drift back onto hand-written documents that quietly describe a world the pinned
runtime never produces.

## `pinned-generic-html5.json`

Captured by running the pinned artifact with the Worker's own analysis policy
argv (`--dump-single-json --skip-download …`) against the merged Phase-10D
`/generic` fixture page from
`deploy/acceptance/ytdlp-generic/fixtures/server.mjs`.

The decisive format fields are preserved **exactly as observed**:

```
format_id  "0"
ext        "mp4"
protocol   "http"
vcodec     null          <- codec identity UNKNOWN, not absent
acodec     "mp4a.40.2"
video_ext  "mp4"
audio_ext  "none"        <- a sorting helper, NOT "this format has no audio"
```

`vcodec` is `null` because `_parse_html5_media_entries` builds the plain-media
dict with `'vcodec': None` and then `f.update(formats[0])` overwrites whatever
the `<source type="…; codecs=…">` attribute had already parsed. `audio_ext` is
`"none"` because `_fill_sorting_fields` sets it that way on **every** format
whose `vcodec != "none"`. Both are properties of the pinned release, not of this
fixture, and they hold for any site — see
`PHASE-10D-GENERIC-REAL-OUTPUT-COMPATIBILITY-001`.

`protocol` is `http` because the capture ran over loopback. A live acceptance
run reaches the same page through an HTTPS Quick Tunnel and reports `https`.
Both are in `YTDLP_V1_NATIVE_PROTOCOLS`, and nothing in the classification under
test depends on which of the two it is.

**Sanitization.** Media URLs, the fixture host, request headers, cookies and the
acceptance sentinel are all removed. The Worker's parsed generic-format schema
deliberately does not read any of them, so none is needed to reproduce the
decision under test.
