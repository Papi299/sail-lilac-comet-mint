# HLS-11 — the clear-HLS v2 real-media release child

**Test tooling only.** Nothing here runs during Worker startup, and none of it
ships in the Worker image. HLS-11 runs **only** as a child of the SPLIT-07
release-image gate (`split07-release-image-candidate-06` and later), inside the
exact candidate image, offline. It never deploys anything.

HLS-11 answers the question `HLS-V2-ADAPTIVE-VOD-EXPANSION-001` raises:

> Does the exact candidate image acquire a clear fMP4 HLS rendition — map
> first, then fragments — through VideoFetch's own safe transport, and turn it
> into a valid MP4 with its real ffprobe and FFmpeg, strictly after the job has
> entered `processing`, without regressing the clear-HLS v1 MPEG-TS path?

The unit tests of that task pin the grammar, the plan, the byte accounting and
the lifecycle ordering, and `hls-v2-execution-boundary.server.test.ts` runs the
production HLS composition over a scripted network and process runner. None of
that is real media. HLS-09 (unchanged) proves the v1 MPEG-TS chain at 360p.
HLS-11 is the real-media proof of the v2 shape, with a 1080p MPEG-TS control run
by the same orchestrator.

```
deterministic fixtures (generated in the candidate by its own /usr/bin/ffmpeg)
  → v1-ts    1920x1080 H.264 + AAC, 4 × 1 s MPEG-TS segments
  → v2-fmp4  1920x1080 H.264 + AAC, init.mp4 + 4 × 1 s fMP4 fragments
real pinned-yt-dlp analysis (HTML5 <video> → master → m3u8_native, 1080p)
  → preset:1080 → fresh execution analysis → ordinary deriveExecutionPlan()
  → clear-hls-remux → HLS-2 real preflight            (durable: downloading)
  → HLS-3 real acquisition, the map first for fMP4    (durable: downloading)
  → beginProcessing()
  → real ffprobe of the aggregate, family demuxer     (durable: processing)
  → ONE real FFmpeg stream copy → real output probes  (durable: processing)
  → beginUploading() → local object writer → ready
+ five fail-closed negatives + the split-master pairing case
  → HLS-11 PASS (hls11-release-image-full-path-01)
```

Nothing of the Product is replaced. The executor receives exactly one seam, a
transparent recording wrapper around the analysis policy's own
`analyzeForExecution`. Plan derivation, HLS acquisition, HLS processing and the
workspace-capacity reader are the executor's defaults. The substitutions
(`HLS11_SUBSTITUTIONS`) are:

- an exact-page URL validator in place of `assertSafeUrl`;
- safe-HTTP's DNS answer and socket hooks (a synthetic public answer, then the
  socket re-pointed at loopback), as in HLS-08;
- a local object writer in place of R2;
- a fresh temporary SQLite job store per job, with a status-audit trigger.

---

## The fixtures

| | v1-ts | v2-fmp4 | fmp4-video (negative) |
| :--- | :--- | :--- | :--- |
| Recipe | `testsrc2` 1920×1080, 25 fps, 4 s + 440 Hz sine | same | video only |
| Encode | libx264 `veryfast`, high 4.0, GOP 25, 600k, `-threads 1`; AAC-LC 64k mono | same | same, `-an` |
| Packaged by | FFmpeg `hls` muxer, `mpegts` | FFmpeg `hls` muxer, `fmp4` | FFmpeg `hls` muxer, `fmp4` |
| Media playlist | v1 subset (7 tags) | v2 grammar: one `#EXT-X-MAP:URI="init.mp4"` | v2 grammar |
| Aggregate (review run) | 383,896 B | 363,302 B (init 1,374 B) | 328,770 B |

- **Determinism.** `-fflags +bitexact`, per-stream `+bitexact`,
  `-map_metadata -1` and single-threaded x264. The child regenerates the fMP4
  rendition and requires identical bytes (`fixture/recipes-are-bit-exact`).
- **Structure.** The init segment is exactly `ftyp moov`; each fragment carries
  `styp`, `sidx`, `moof` and `mdat`, the common CMAF layout.
- **Masters.** Each case has a single-variant master whose `CODECS` names video
  and audio and whose `NAME` gives the pinned extractor a conspicuous raw id
  (`hls-HLS11_RAW_…`) for the privacy scans. The media playlist URL carries a
  private-by-contract `sig` marker (`HLS11_PRIVATE_…`).
- **Addressing.** One reserved hostname, `hls11-fixture.example.invalid`, is
  disjoint from HLS-08's and reachable only through the child's single
  `--add-host`.

## What a PASS proves

For **each** of `v1-ts` and `v2-fmp4` (37 checks each):

- **Analysis.** The pinned yt-dlp read only the page and the master. It
  advertised `preset:1080` and `preset:best` with the clear-HLS public facts,
  and `sourceQuality` is 1080 observed and deliverable, with nothing withheld.
  Public metadata carries no private material.
- **Plan.** The fresh execution analysis gave `preset:1080` to the HLS map, and
  the ordinary planner produced a `clear-hls-remux` → `mp4` plan with the
  closed key set.
- **Acquisition.** The requests were the playlist, then the map (fMP4 only),
  then every fragment in order, each exactly once. There was one request at a
  time, each carried only the fixed product request profile, and no `Range`
  header was sent. The aggregate hashed at the first media tool is
  byte-identical to the ordered concatenation, under the family's own file
  name.
- **Processing.** The source probe used the family's explicit demuxer (`mpegts`
  or `mov`). Exactly one FFmpeg ran: the product's exact argv, stream copy,
  `-n`. Then the partial and final output probes ran.
- **Lifecycle.** The trace was `queued → analyzing → downloading → processing →
  uploading → ready`. Every HLS request happened while `downloading`, no
  ffprobe/FFmpeg of any role ran while `downloading`, every media tool ran
  while `processing`, no yt-dlp ran after execution analysis, and the upload
  happened while `uploading`.
- **Workspace.** The acquisition peak is the aggregate alone. The processing
  peak is within aggregate + output, which is within 2 × `maxFileSize`.
- **Output.** A faststart ISO-BMFF MP4 (`ftyp`, `moov` before `mdat`, no
  `moof`): exactly one H.264 1920×1080 video and one AAC audio stream, the
  fixture's duration ±0.25 s, and within the limit. For fMP4, every video and
  audio packet payload is byte-identical to the input's. For the MPEG-TS
  control, packet counts are preserved; Annex-B → AVCC and ADTS → raw framing
  legitimately changes the payloads.
- **Upload and ready.** Exactly one put, of the produced MP4 and never the
  aggregate, `video/mp4`. The ready view matches it, the workDir is removed,
  and no private material appears on any public surface.

The **negatives** each fail closed, with no upload and the workDir removed:

| Case | Expected | Also proves |
| :--- | :--- | :--- |
| `neg-byterange` | `FORMAT_UNAVAILABLE` | only the playlist was requested — the map was never fetched |
| `neg-encrypted` | `FORMAT_UNAVAILABLE` | no key, map or fragment request |
| `neg-init-404` | `NETWORK_ERROR` | the map 404 stopped acquisition before any fragment |
| `neg-budget` | `TOO_LARGE` | the allowance is the aggregate minus one byte — the fragments alone fit, so the job fails **only because the map counts** |
| `neg-video-only` | `PROCESSING_FAILED` | a master that claims audio for a video-only fMP4 rendition is acquired, then refused by the REAL ffprobe stream-shape check, with no FFmpeg run |

The **split master** carries a 1080p video-only variant that references an
audio group (a DEFAULT and an alternate rendition) and a 720p control variant
that references none. Against the candidate's own pinned yt-dlp, the child
proves:

- the two audio renditions are exposed with no audio codec;
- no format carries a group or underscore relationship key, and the grouped
  and ungrouped video variants have one identical key set;
- no HLS video preset is advertised, the HLS selections are empty, and
  `sourceQuality` withholds `unsupported_protocol` at 1080;
- the planner refuses `preset:1080`, and no product media request was made.

This is the release-image form of the HLS v2 finding **HLS AUDIO PAIRING
PROVENANCE INSUFFICIENT**.

## Identity and evidence

The identity checks are HLS-09's `release/*` six. The parent hands the child
the verified source commit and tree, the non-deployable build label and the
immutable image id as candidate and run subject. The child records them and
the loopback-only interfaces it observes. The record
(`lib/hls11-evidence.mjs`) is built from an allowlist. It refuses a PASS that
any of the 137 mandatory checks does not earn, and it refuses to emit any
fixture marker, raw id, hostname, route, URL, loopback address or Product
temp path. The parent re-reads the exact bytes, validates them
(`validateHls11ChildRecord`) and re-hashes them immediately before assembly.

## What a PASS does not prove

`HLS11_NON_CLAIMS`: no separate HLS audio (not implemented), no real public
HLS source or CDN, no Production SSRF/DNS/egress re-proof, no Cloudflare,
Vercel or R2, and no Production startup, promotion or uptime claim.

## Mutation controls (HLS-V2-ADAPTIVE-VOD-EXPANSION-001)

Each was applied to a copy of the source, built into its own candidate image,
and run through this child:

| Mutation | HLS-11 result |
| :--- | :--- |
| M1 — map parsed but never fetched | FAIL: v2-fmp4 order, exact-once, aggregate identity, and the real ffprobe refuses the map-less input (no output) |
| M2a — an audio-less HLS rendition admitted (the analog of an unproven pairing) | FAIL: every split-master Product check |
| M3 — FFmpeg run before `beginProcessing()` | FAIL: `no-media-tool-while-downloading`, `media-tools-only-while-processing`, trace, output |
| M4a — the map excluded from the byte budget | FAIL: `neg-budget` reaches `ready` instead of `TOO_LARGE` |
| M5 — output audio validation removed and audio dropped | FAIL: `exactly-one-aac-audio`, `exactly-two-streams`, packets 189 → 0 on both families |

## Files

| File | Where it runs | What it is |
| :--- | :--- | :--- |
| `hls11-full-path.mjs` | inside the release candidate | The orchestrator; launched by SPLIT-07 with the parent's identity flags. |
| `lib/hls11-evidence.mjs` | — | The `hls11-release-image-full-path-01` record, its 137 mandatory checks, PASS and privacy gates, and the parent-side validator. |
| `lib/hls11-fixture-url.mjs` | — | The hostname, `--add-host` mapping, closed per-case routes and the exact page validator. Import-free. |
| `lib/hls11-observers.mjs` | — | The spawn observer (durable status, input, demuxer), the HLS workspace sampler and the `-J` pairing-fact reducer. |
| `fixtures/hls11-media.mjs` | — | The bit-exact recipes, masters (including the split master) and negative playlists. |
| `fixtures/hls11-server.mjs` | inside the release candidate, loopback only | The closed-route fixture service and its sanitized ledger. |
| `lib/hls-safe-http-transport.mjs` | — | Shared with HLS-08; HLS-11 passes its own classifier and `HLS_V2_ADMITTED_KINDS` (map included). HLS-08's defaults are unchanged. |
| `scripts/ytdlp-hls11-acceptance.test.mjs` | `npm test` | Self-tests of the pure modules. No Docker, no network. |
