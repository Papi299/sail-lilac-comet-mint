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

## `pinned-generic-html5-no-audio-codec.json`

Captured for `GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001` by running the pinned
artifact inside the accepted Worker image
(`sha256:c3995e18dd3c51d6ddb186e3a3186360d24a2053439e067b71c7dec029f878fa`), in a
disposable container with `--network none --read-only`. It used the Worker's own
analysis argv and closed environment, taken verbatim from
`buildYtdlpAnalysisArgv` / `buildYtdlpAnalysisEnvironment`; only the
`--js-runtimes` node path was set to the image's own `/usr/local/bin/node`. The
page was deterministic and served over loopback inside the same container:

```html
<video controls><source src="/generic-media.mp4" type="video/mp4"></video>
```

That is the ordinary real-world declaration: a `type` with **no `codecs=`
parameter**. It differs from the `/generic` fixture above in exactly that
respect.

The decisive format fields are preserved **exactly as observed**:

```
format_id  "0"
ext        "mp4"
protocol   "http"
vcodec     null           <- codec identity UNKNOWN, not absent
acodec     (key absent)   <- audio UNKNOWN: parse_codecs("") returns {}, so it is never set
video_ext  "mp4"
audio_ext  "none"         <- a sorting helper, NOT "this format has no audio"
```

`acodec` is not `null` here. The key does not exist in the pinned runtime's
output at all, which is why this file omits it rather than writing `null`. The
raw format also carried no `asr` and no `audio_channels`, and its `abr` and `tbr`
were `null`, so nothing in the document positively establishes an audio stream.
The Worker therefore classifies the format as unknown-codec VIDEO (coherent
`video_ext`) with UNKNOWN audio. It keeps the format as an honest private
candidate and advertises no preset for it.

**Sanitization.** Only the fields the Worker's raw schema reads are kept, using
the same allowlist and order as the capture above. A field the runtime did not
emit is omitted, never filled in; that includes the top-level `duration`,
`is_live` and `live_status`, which this run did not report. `url`,
`http_headers`, `webpage_url`, `original_url`, the loopback host and every other
key are removed. The title is the fixture page's own `<title>`, exactly as the
pinned runtime reported it, including the trailing ` (1)` it appended.
