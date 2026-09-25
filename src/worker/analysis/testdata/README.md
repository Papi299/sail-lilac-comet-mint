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
`video_ext`) with UNKNOWN audio. Under `GENERIC-V1-AUDIO-CONSTRAINT-CORRECTION-001`
it kept the format as an honest private candidate and advertised no preset for
it. Since `GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001` the same
document, having no proven video fulfilment, advertises exactly one ordinary
video preset (`preset:best`, unknown resolution) with `hasAudio: false` and
`audioCodec: null`, and still no audio or MP3 preset; the private selection
stays `audioConstraint: "unknown"`.

**Sanitization.** Only the fields the Worker's raw schema reads are kept, using
the same allowlist and order as the capture above. A field the runtime did not
emit is omitted, never filled in; that includes the top-level `duration`,
`is_live` and `live_status`, which this run did not report. `url`,
`http_headers`, `webpage_url`, `original_url`, the loopback host and every other
key are removed. The title is the fixture page's own `<title>`, exactly as the
pinned runtime reported it, including the trailing ` (1)` it appended.

## `synthetic-x-progressive-unknown-audio.json` — SYNTHETIC

**This file is SYNTHETIC. It is not a capture.** It was written by hand for
`GENERIC-UNKNOWN-AUDIO-VIDEO-PRESET-IMPLEMENTATION-001` to reproduce the OUTPUT
SHAPE that `X-TWITTER-FORMAT-COMPATIBILITY-DIAGNOSTIC-001` found for an X/Twitter
video under the pinned runtime. It describes no real post and contains no data
from one: no submitted URL, status id, username, media/CDN or manifest URL,
query string, token, cookie, real upstream `format_id` or real title. Every
`format_id` is a neutral application-test literal (`synthetic-…`) that satisfies
the safe grammar, heights and sizes are round illustrative values, and the title
says what the file is.

The diagnostic's decisive finding, which the file preserves as a shape:

```
2 × progressive  protocol https, ext mp4, video_ext mp4, NO vcodec key,
                 NO acodec key                       <- video established by shape,
                                                        audio UNKNOWN
2 × HLS video    protocol m3u8_native, ext mp4, real vcodec, acodec "none"
2 × HLS audio    protocol m3u8_native, ext mp4, vcodec "none", video_ext "none",
                 NO acodec key                       <- audio-rendition-like, audio UNKNOWN
```

In the pinned Twitter extractor a progressive variant carries only its URL, id
and bitrate, so `acodec` is never set; the HLS audio renditions get
`vcodec: "none"` but no `acodec` either. `video_ext`/`audio_ext` follow
`_fill_sorting_fields`, exactly as in the captures above.

What the Worker must conclude from it:

- the four HLS formats are ineligible on protocol alone
  (`YTDLP_V1_NATIVE_PROTOCOLS` stays `http`/`https`);
- the two progressive formats are eligible, with `videoConstraint: "video-ext"`
  and `audioConstraint: "unknown"`;
- no PROVEN video fulfilment exists (nothing is muxed with a real `acodec`, and
  unknown audio is neither a split video half nor an audio half), so the
  unknown-audio fallback tier backs ordinary video presets — `hasAudio: false`,
  `audioCodec: null` — and nothing else: no `preset:audio`, no `preset:mp3`.

Being synthetic, it proves nothing about the pinned binary by itself. What the
pinned runtime does with the resulting selector is proven offline by
`deploy/acceptance/ytdlp-generic/verify-selector.py`.

## `source-quality-corpus.json` and `source-quality-preset-identity.golden.json`

Added by `GENERIC-SOURCE-RENDITION-INVENTORY-001` (Phase P1).

**The corpus** is a list of scenarios, each one a synthetic `-J` document (or a
reference to one of the captured fixtures above) plus the two inputs that change
what the analyzer may advertise: `ffmpegAvailable` and `maxFileSizeBytes`. Its
rows are shaped the way the pinned runtime shapes them — notably `video_ext` is
the extension unless `vcodec` is exactly `"none"`, and `audio_ext` is `"none"`
on every video-bearing format (`_fill_sorting_fields`). Unknown codecs appear
both as an explicit `null` and, in `case10b`, as an ABSENT key, because the
pinned Generic-HTML5 path produces the latter.

Being synthetic, the corpus proves what the ANALYZER does with a document, not
what the pinned binary emits for any particular site.

**The golden record** is what the analyzer produced for that corpus BEFORE P1 —
generated by running `main` `d3a967b7ac25c611623b74f396fff85def910d8e` over it.
For each scenario it holds the full public metadata (minus the new
`sourceQuality` field), the private per-preset selections, the execution plan
derived for every advertised preset, and the yt-dlp selector every plan
produces.

It exists so that "P1 changed nothing about what VideoFetch delivers" is a test
rather than a claim: `source-quality.server.test.ts` re-derives all four for
every scenario and compares. **Regenerating it is never part of an inventory
change.** A diff here means presets, selections, plans or selectors moved, which
is a deliberate product change belonging to its own task.

### The HLS-7 carve-out — the golden record is NOT regenerated

`HLS-7-CLEAR-HLS-PRODUCT-ACTIVATION-001` is exactly such a deliberate product
change, and it is confined to ONE scenario:

- `case02-clear-hls-above-progressive` now gives its two clear-HLS video rows a
  synthetic media-playlist `url` (`media.example.invalid`, sentinel
  `CORPUS_PRIVATE_HLS_TOKEN`), and its audio-only HLS row one too. Before that
  the rows had no `url`, so HLS admission could never accept them and the
  scenario could not show activation. Its golden entry is still historically
  true for the amended document: the analyzer that generated it (`d3a967b7`)
  did not parse `url` at all.
- The test lists case02 as HLS-activated and compares only its PROGRESSIVE half
  with the golden record — every preset, selection, plan and selector whose id
  clear HLS does not now own must be byte-identical. The HLS-owned ids
  (`preset:best`, `preset:2160`, `preset:1080`) are asserted separately against
  the HLS-7 contract.
- Every other scenario, including `case03-segmented-dash-above-progressive`
  and the HLS rows in `case18` and the synthetic X case (no `url`, or no proven
  audio), must still match the golden record in full.
