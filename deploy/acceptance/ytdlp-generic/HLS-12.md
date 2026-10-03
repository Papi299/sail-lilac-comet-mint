# HLS-12 — the separate-audio clear-HLS real-media release child

**Test tooling only.** Nothing here runs during Worker startup, and none of it
ships in the Worker image. HLS-12 runs **only** as a child of the SPLIT-07
release-image gate, inside the exact candidate image, offline: its `-01` under
`split07-release-image-candidate-08`, its `-02` under `-09` and later. It never
deploys anything.

HLS-12 answers the question `HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001`
raises:

> Does the exact candidate image prove a video-only fMP4 HLS rendition's ONE
> audio rendition from a Master Playlist it fetches itself, acquire both halves
> through VideoFetch's own safe transport under one byte budget and one
> acquisition deadline, and merge them into an MP4 that keeps their relative
> audio/video timing, strictly after the job has entered `processing` — while
> refusing every pair the master does not prove?

The unit tests of that task pin the master grammar, the pairing proof, the
fetch bounds, the planner partition and the lifecycle ordering, and
`separate-hls-execution-boundary.server.test.ts` runs the production
composition over a scripted network and process runner. None of that is real
media. HLS-12 is the real-media proof.

```
deterministic fixtures (generated in the candidate by its own /usr/bin/ffmpeg)
  → pos-audio-late  video-only fMP4 + audio-only fMP4, ONE packager run, audio input +0.5 s
  → pos-video-late  the same, audio input -0.5 s (the VIDEO is presented later)
  → ctl-aligned     two packager runs, no B-frames: both halves start at exactly 0
  + a hand-authored master per case: one AUDIO group, one URI rendition
harness: each pair's source timing measured by the packet oracle, BEFORE any job
real pinned-yt-dlp analysis (HTML5 <video> → signed master → m3u8_native rows, metadata only)
  → the Product's OWN master proof: one safeGet, maxRedirects 0      → preset:1080
  → fresh execution analysis (the proof again)                       (durable: analyzing)
  → ordinary deriveExecutionPlan() → clear-hls-separate-audio-remux
  → HLS-2 real preflight: video playlist, then audio playlist         (durable: downloading)
  → HLS-3 real acquisition: video half, then audio half, ONE budget  (durable: downloading)
  → beginProcessing()
  → the shared split merge: real ffprobe of each half,
    ONE real FFmpeg stream copy, -isync on the earlier input         (durable: processing)
  → beginUploading() → local object writer → ready
+ four master negatives + six execution negatives (the sixth: the ONE shared deadline)
  → HLS-12 PASS (hls12-release-image-separate-audio-02)
```

Nothing of the Product is replaced. The executor receives exactly one seam, a
transparent recording wrapper around the analysis policy's own
`analyzeForExecution`. Plan derivation, HLS acquisition, the shared merge and
the workspace-capacity reader are the executor's defaults. The substitutions
(`HLS12_SUBSTITUTIONS`) are:

- an exact-page URL validator in place of `assertSafeUrl`;
- safe-HTTP's DNS answer and socket hooks (a synthetic public answer, then the
  socket re-pointed at loopback), as in HLS-08 and HLS-11. The transport
  admits the `master` kind (`HLS_MASTER_PROOF_ADMITTED_KINDS`) and refuses
  anything else, including the redirect negative's target;
- two Product-only answers. In `neg-master-redirect` and `neg-master-changed`,
  the fixture answers the Product's own master request differently from
  yt-dlp's: a redirect, or a re-signed master. It recognises the Product by its
  fixed request profile, which the transport verifies independently;
- a local object writer in place of R2;
- a fresh temporary SQLite job store per job, with a status-audit trigger;
- two per-case controls, each applied to one job and restored after it:
  `neg-budget` narrows the Product's configured byte limit
  (`config.maxFileSize`), and `neg-deadline` narrows its configured download
  budget (`config.downloadTimeoutMs`) and has the fixture hold two routes'
  answers (below). No Product code, clock or timer is replaced.

---

## The fixtures

| Recipe | What it is | Aggregate (review run) |
| :--- | :--- | :--- |
| `pair-audio-late` | ONE packager run, two renditions (`-var_stream_map "v:0,agroup:aud a:0,agroup:aud"`). The audio input carries `-itsoffset 0.5` | video 328,770 B (init 847 B, 4 fragments); audio 34,982 B (init 777 B, 5 fragments) |
| `pair-video-late` | the same, with `-itsoffset -0.5` and 0.5 s more audio | video 328,770 B; audio 39,015 B |
| `aligned-video` | its own packager run: video only, `-bf 0` | 329,844 B (init 833 B) |
| `aligned-audio` | its own packager run: audio only | 34,970 B (init 765 B) |
| `muxed-fmp4` | one rendition carrying video AND audio (negative) | 364,360 B |
| `audio-ts` | an audio-only MPEG-TS rendition (negative) | 38,728 B |

- **Encode.** All media is 1920×1080 `testsrc2` at 25 fps for 4 s, and a
  440 Hz sine at 48 kHz. Video is libx264 `veryfast`, high 4.0, GOP 25, 600k,
  `-threads 1`; audio is AAC-LC 64k mono.
- **Packaging.** FFmpeg's `hls` muxer writes fMP4 with `-hls_flags
  independent_segments`, so every playlist is the pinned packager's own v2
  spelling.
- **Determinism.** `-fflags +bitexact`, per-stream `+bitexact`,
  `-map_metadata -1` and single-threaded x264. The child regenerates
  `pair-audio-late` and requires both halves byte-identical.
- **Source timing.** The harness measures it **before** any job, with the
  shared packet oracle (`lib/merge-timing.mjs`):

  | Pair | Video first presented | Audio first presented | Relative (audio − video) | Reference the merge must use |
  | :--- | ---: | ---: | ---: | :--- |
  | `pos-audio-late` | 80,000 µs | 558,000 µs | **+478,000 µs** | video (`-isync 0`) |
  | `pos-video-late` | 521,016 µs | 0 µs | **−521,016 µs** | audio (`-isync 1`) |
  | `ctl-aligned` | 0 µs | 0 µs | **0 µs** (exact rational) | video (tie) |

  Both offset pairs must be *discriminating*: beyond what rounding alone could
  produce.

  Two pairs need their own recipe. **The control needs two packager runs**,
  because one packager run cannot produce a zero-aligned pair: AAC priming
  leaves its audio about 21 ms early. **The video-late pair needs a negative
  audio offset**, because `-itsoffset` on a lavfi video input does not move the
  packaged video.
- **Masters.** They are hand-authored inside the candidate's closed master
  grammar. Each page names a **signed** master (`master.m3u8?sig=…`). Every
  private slot carries a sentinel:
  - the master, video, audio, alternate and re-signed `sig` values
    (`HLS12_PRIVATE_…`);
  - `GROUP-ID` (`HLS12_GROUP_…`);
  - `NAME` (`HLS12_RAW_…`, from which the pinned extractor builds its audio
    format id);
  - `LANGUAGE` (`HLS12LANG-…`).

  The four shapes are `paired`, `ambiguous` (two URI renditions), `no-audio-group`
  (a variant naming no group, beside an unreferenced one) and `resigned` (the
  same video under a different signature).
- **Addressing.** One reserved hostname, `hls12-fixture.example.invalid`,
  disjoint from HLS-08's and HLS-11's, reachable only through the child's single
  `--add-host`.

## What a PASS proves

**The timing oracle is sensitive.** The historical merge argv (no cross-input
synchronization) re-merges the audio-late halves harness-side: its output comes
out at 0 µs relative, and the oracle reports `relativeTimingPreserved: false`.
That proves a merge which zeroes each input would fail this child.

For **each** of `pos-audio-late`, `pos-video-late` and `ctl-aligned` (39 checks
each):

- **Analysis.** The pinned yt-dlp read only the page and the master. Its `-J`
  shows one video-only row (`acodec: none`), one audio-only row, no muxed row,
  no group or underscore relationship key, and every row naming the submitted
  master. The Product made exactly ONE request of its own: the master, which
  answered 200 and was not redirected. `preset:1080` and `preset:best` carry
  the clear-HLS public facts. `sourceQuality` is 1080 observed and
  deliverable, with nothing withheld. Public metadata carries no private
  material.
- **Plan.** The fresh execution analysis put `preset:1080` in the
  separate-audio map only: no muxed-HLS or progressive owner. Its selection is
  exactly `{audioPlaylistUrl, height, videoPlaylistUrl}`: the master-proven
  pair at height 1080. The ordinary planner produced
  `clear-hls-separate-audio-remux` → `mp4` with the closed key sets.
- **Acquisition.** The job's Product requests were the master (while
  `analyzing`), then the video playlist, the audio playlist, the video map and
  fragments, then the audio map and fragments. Each was requested exactly once,
  one at a time, with the fixed Product request profile and no `Range`. Both
  halves, hashed at the first media tool, are the exact ordered
  concatenations.
- **Processing.** The job ran ffprobe on `hls-video.fmp4`, then on
  `hls-audio.fmp4`, both through `mov`. Then exactly ONE FFmpeg ran: stream
  copy, `-n`, both halves through `mov` into `merged.mp4`. Its argv equals the
  Product's own `buildSplitMergeArgs()` output for the reference the *harness*
  derived from its own measurement. Its synchronization tokens are exactly the
  expected `-isync` on the earlier input, with no forbidden timestamp flag.
  Then the output probe ran.
- **Lifecycle.** The trace was `queued → analyzing → downloading → processing →
  uploading → ready`. The master proof ran while `analyzing`, and every media
  request while `downloading`. No ffprobe or FFmpeg ran while `downloading`;
  all four media tools ran while `processing`. No yt-dlp ran after execution
  analysis, and the upload happened while `uploading`.
- **Workspace.** The acquisition peak is within the two halves, with only half
  files present. The processing peak is within halves + output, which is within
  2 × `maxFileSize`.
- **Output.** A faststart MP4 with exactly one H.264 1920×1080 stream and one
  AAC stream. Its duration is the pair's measured span ±0.25 s, and it is within
  the limit.
- **Timing.** Every packet payload is identical to its half's. Each stream's
  shift is constant, with nothing hidden or un-hidden, no leading gap and spans
  preserved. The relative offset is preserved **within the time-base
  tolerance**:

  | Pair | Source → output | Δ | Tolerance |
  | :--- | :--- | ---: | ---: |
  | `pos-audio-late` | +478,000 µs → +478,000 µs | 0 µs | 1,099 µs |
  | `pos-video-late` | −521,016 µs → −521,016 µs | 0 µs | 1,099 µs |
  | `ctl-aligned` | 0 µs → 0 µs | 0 µs | 1,099 µs |

- **The control** is also byte-identical to the historical merge of the same
  halves: zero-aligned input merges exactly as it always did.
- **Upload and ready.** Exactly one put, of `merged.mp4` and never a half,
  `video/mp4`. The ready view matches it, the workDir is removed, and no
  private material appears in the public metadata, the durable row, the ready
  view or the content disposition.

The **master negatives** run analysis only. For each one, the pinned yt-dlp
still exposes the video-only row (so the master *was* consulted), and the
Product's only request is that master. No HLS video preset is advertised, both
selection maps are empty, `sourceQuality` withholds `unsupported_protocol` at
1080, and the planner refuses `preset:1080`:

| Case | The master the Product fetched | Also proves |
| :--- | :--- | :--- |
| `neg-ambiguous-group` | the variant's group holds TWO URI renditions (a DEFAULT and an alternate) | no preference policy exists: Option A refuses |
| `neg-no-audio-group` | the variant names no group; one audio rendition sits in a group nothing references | the "convenient" audio row is never borrowed |
| `neg-master-redirect` | a 302 to a pairable master (Product only; yt-dlp gets the master) | the redirect is a refusal, and its target is requested by nobody, ever |
| `neg-master-changed` | the same master with the video URL re-signed (Product only) | identity is exact: a path-only comparison would have matched |

The **execution negatives** run full jobs. Each fails closed with no upload and
the workDir removed:

| Case | Expected | Also proves |
| :--- | :--- | :--- |
| `neg-audio-ts` | `FORMAT_UNAVAILABLE` | only the master and the two playlists were requested: the MPEG-TS half is refused before any map or fragment of either half |
| `neg-video-muxed` | `PROCESSING_FAILED` | both halves are acquired, then the real ffprobe of the "video" half refuses its audio stream: no audio probe, no FFmpeg |
| `neg-audio-video` | `PROCESSING_FAILED` | the video half probes clean, and the real ffprobe of the "audio" half refuses it: no FFmpeg |
| `neg-budget` | `TOO_LARGE` | the allowance is the two halves' sum minus one byte, so EACH half alone fits it. The video half is acquired whole, and the audio half is refused at its last fragment: the job fails **only because the halves share one budget**. The limit is restored |
| `neg-audio-map-404` | `NETWORK_ERROR` | the video half is complete, the audio map answers 404, and no audio fragment is ever requested |
| `neg-deadline` (since `-02`) | `TIMEOUT` | the ONE acquisition deadline: the video half completes inside a narrowed budget having used most of it, and the audio half is stopped, unanswered, **at that same deadline** — never given a fresh one. Nothing is probed or merged (next section) |

## The shared deadline (`neg-deadline`, since `-02`)

`acquireSelectedSeparateHlsMedia()` arms ONE acquisition deadline before the
video half and hands the audio half only what is left of it. Every other
HLS-12 case is local and fast, so none of them ever approaches a deadline:
HLS-12 `-01` would have passed a candidate that handed the audio half a fresh
budget. `neg-deadline` is the case that would not.

It runs a full job through the candidate's real executor, HLS-2 preflights and
HLS-3 acquisitions, with exactly two controls (`HLS12_DEADLINE_CONTROL`,
`lib/hls12-deadline.mjs`):

- **The budget.** For this one job, the Product's configured download budget
  `config.downloadTimeoutMs` (the `DOWNLOAD_TIMEOUT` value every acquisition
  already reads) is **10,000 ms**, and it is restored afterwards. The executor
  passes no narrower one, so this is the one shared deadline.
- **Two held answers.** The fixture holds two routes, answering them with
  their own bytes, only later, never differently, and only if the Product is
  still waiting. Each time is measured from the arrival of the video map, the
  first acquisition request: the Product arms its deadline immediately before
  that request.

  | Route | Answer due after | Why |
  | :--- | ---: | :--- |
  | the video half's last fragment | 6,000 ms | the video half completes inside the budget, having used most of it |
  | the audio map | 13,000 ms | after the shared deadline, but before any fresh one would end |

| | One shared deadline (the Product) | A fresh deadline per half |
| :--- | :--- | :--- |
| Audio half's budget | ~4,000 ms: what the video half left | 10,000 ms, again |
| Audio map | abandoned by the Product, unanswered, at ~10,000 ms | still open at 13,000 ms, so it is answered |
| Outcome | `TIMEOUT` in `downloading`: no media tool, no upload | audio fragments, merge, upload, `ready` |

**The margins are seconds.** No outcome depends on host scheduling.
`hls12DeadlineControlProblems()` states them as inequalities, and the case
refuses to run unless all three hold:

- the video half finishes 1,500 ms or more inside the budget, leaving the audio
  half at least 1,500 ms;
- the shared deadline stops the audio map at least 1,500 ms before its late
  answer;
- a fresh deadline, armed even at the earliest admitted video completion,
  would outlive that answer by at least 1,500 ms.

No observed time is held to an exact millisecond: a timer that releases "at
6,000 ms" can fire a fraction of a millisecond early on the monotonic clock.
The video half must complete between 4,500 and 8,500 ms (the hold minus the
slack, and the budget minus the slack). The audio map must be requested after
that completion, which is a causal order rather than a time. It must then be
abandoned within ±1,500 ms of the 10,000 ms deadline.

The fixture ledger records each request's monotonic arrival and finish. For a
held request it also records when it was released or, if the client went away
first, when it was abandoned. `evaluateHls12SharedDeadline()` reduces that to
relative times and two verdicts. The eight checks:

| Check | What it requires |
| :--- | :--- |
| `neg-deadline/timeout` | the job failed `TIMEOUT` |
| `neg-deadline/no-upload-never-ready` | no put; never `uploading` or `ready` |
| `neg-deadline/workdir-removed` | the job's workDir is gone |
| `neg-deadline/video-consumed-the-shared-deadline` | the video map and every fragment answered 200 exactly once; the held last fragment released, never abandoned; the half completed between 4,500 and 8,500 ms |
| `neg-deadline/audio-did-not-receive-a-fresh-deadline` | ONE audio request, its map, made only after the video half completed; never answered; abandoned by the Product within ±1,500 ms of the 10,000 ms deadline, before the 13,000 ms answer |
| `neg-deadline/requests-end-at-the-unanswered-audio-map` | the Product's requests were exactly master, both playlists, the video map and fragments, then the audio map, which received no response; no audio fragment was ever requested |
| `neg-deadline/download-timeout-restored` | `config.downloadTimeoutMs` is back to its value before the case |
| `neg-deadline/never-processing-no-media-tool` | the trace was `queued → analyzing → downloading → failed`, with no ffprobe and no FFmpeg |

On a disposable development image (offline, Docker Desktop), the video half
completed about 6.0 s after the video map arrived, leaving the audio half about
4.0 s. The audio map, requested a few milliseconds later, was abandoned
unanswered about 10.0 s after the video map, inside the ±1.5 s window around
the 10 s deadline. A fresh deadline would have run past 16 s. The record keeps
each run's exact values under `executionNegatives.sharedDeadline.observed`.

**Process output.** A tap on the child's stdout and stderr covers every case,
and proves itself live with one armed line. No sentinel, signed query,
reference spelling or fixture-route material reaches it.

## Identity and evidence

The identity checks are HLS-09's `release/*` six. The parent hands the child
the verified source commit and tree, the non-deployable build label and the
immutable image id as candidate and run subject. The child records them and
the loopback-only interfaces it observes. The record (`lib/hls12-evidence.mjs`)
is built from an allowlist, and states both per-case controls under
`substitutions`. It refuses a PASS that any of the 214 mandatory checks does not
earn. It also refuses to emit any sentinel (`HLS12_PRIVATE_`,
`HLS12_RAW_`, `HLS12_GROUP_`, `HLS12LANG`), the hostname or route, any
master/media/init/fragment spelling, a URL, a loopback address or a Product
temp path. The parent re-reads the exact bytes, validates them
(`validateHls12ChildRecord`) and re-hashes them immediately before assembly.

## What a PASS does not prove

`HLS12_NON_CLAIMS`:

- ONE separate-audio family only;
- no MPEG-TS separate audio, no multi-rendition group (there is no language or
  default preference), no subtitles, I-frame playlists, content steering,
  session keys, encryption or byte-range media;
- no real public HLS source, CDN, signed-URL lifetime or public packager
  compatibility (the masters are hand-authored);
- the shared deadline only at a narrowed 10 s configured budget, with fixture
  answers delayed by whole seconds: not at the Production download budget, and
  not for slow real networks;
- no Production SSRF/DNS/egress re-proof;
- no Cloudflare, Vercel or R2;
- no Production startup, promotion or uptime claim.

## Schema history

| Schema | Status | What it proves |
| :--- | :--- | :--- |
| `hls12-release-image-separate-audio-01` | historical — valid for what it proved | The three pairs, four master negatives and five execution negatives, including the ONE shared byte budget (206 mandatory checks). It never approached a deadline, so it does **not** release-prove that the halves share one acquisition deadline. It is the HLS-12 child of the SPLIT-07 `-08` qualification of `sha256:262f5633…` (source `b095dfa1…`). Never re-read as `-02`, and insufficient for any later release qualification |
| `hls12-release-image-separate-audio-02` | current — required by SPLIT-07 `-09` | Everything in `-01`, plus `neg-deadline`: the release-image proof that both halves share ONE acquisition deadline (214 mandatory checks) |

## Mutation controls (HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001)

Each was applied to a disposable copy of the source and built into its own
throwaway image (removed afterwards), and this child ran against it on Docker
Desktop, offline:

| Mutation | HLS-12 result |
| :--- | :--- |
| MA — Option A dropped: a group's first (DEFAULT) member is taken even when the group holds two renditions | FAIL: exactly the four `neg-ambiguous-group` preset, selection, `sourceQuality` and plan checks |
| MB — a convenient audio row: a variant naming no group borrows the master's first group | FAIL: exactly the four `neg-no-audio-group` checks |
| MC — path-only identity: the variant URL compared without its signed query | FAIL: exactly the four `neg-master-changed` checks |
| MD — the master fetch follows redirects (`maxRedirects: 3`) | FAIL: `neg-master-redirect/product-got-a-redirect-and-followed-nothing` and `transport/no-refused-request`. The follow-up request is refused by the acceptance transport before it reaches the fixture, and the case check counts that attempt |
| ME — the audio half handed the FULL limit, and the seam's own combined-size assertion dropped | **PASS — masked by defense in depth**: the executor's independent combined-size assertion still refuses the pair as `TOO_LARGE` after acquisition, before any media tool runs. The request sequence is unchanged |
| ME2 — ME, plus that executor assertion removed | FAIL: `neg-budget/too-large`, `neg-budget/no-upload-never-ready` and `neg-budget/never-processing-no-media-tool`. The over-budget pair is merged and uploaded |
| MF — the merge's synchronization decision ignores the halves' start times (always the video as reference) | FAIL: `pos-video-late`'s argv, sync-reference, duration and timing checks. The audio-late pair and the control pass, because the video is their correct reference |

No other check failed under any mutation. Those seven ran against `-01`.

`HLS-SEPARATE-AUDIO-HLS12-SHARED-DEADLINE-HARDENING-001` ran `-02` the same
way:

| Mutation | HLS-12 `-02` result |
| :--- | :--- |
| M-DL — the audio half handed a fresh full `config.downloadTimeoutMs` instead of what is left of the shared deadline (`const audioTimeoutMs = config.downloadTimeoutMs;`) | FAIL: exactly `neg-deadline/timeout`, `neg-deadline/no-upload-never-ready`, `neg-deadline/audio-did-not-receive-a-fresh-deadline`, `neg-deadline/requests-end-at-the-unanswered-audio-map` and `neg-deadline/never-processing-no-media-tool`. The audio map was answered about 13 s after the video map arrived, all five audio fragments followed, and the job was merged, uploaded and reached `ready`. `neg-deadline/video-consumed-the-shared-deadline` passed, because the video half is the same either way |

No other check failed.

## Files

| File | Where it runs | What it is |
| :--- | :--- | :--- |
| `hls12-full-path.mjs` | inside the release candidate | The orchestrator; launched by SPLIT-07 with the parent's identity flags. |
| `lib/hls12-evidence.mjs` | — | The `hls12-release-image-separate-audio-02` record, its 214 mandatory checks, PASS and privacy gates, and the parent-side validator. |
| `lib/hls12-deadline.mjs` | — | The `neg-deadline` control, its three margin inequalities and the pure evaluation of the fixture's timed ledger. Import-free. |
| `lib/hls12-fixture-url.mjs` | — | The hostname, `--add-host` mapping, closed per-case routes (the role is the ledger family) and the exact page validator. Import-free. |
| `lib/hls12-observers.mjs` | — | The spawn reducer (each input's product name and demuxer, the output, the merge's sync tokens), the separate-audio workspace grammar and the `-J` reducer. HLS-11's observer and sampler run them. |
| `fixtures/hls12-media.mjs` | — | The bit-exact recipes, the page and the four master shapes. |
| `fixtures/hls12-server.mjs` | inside the release candidate, loopback only | The closed-route fixture service, its sanitized and timed ledger, the Product-only answers and the held (late, never altered) answers. |
| `lib/hls-safe-http-transport.mjs` | — | Shared; HLS-12 passes its own classifier and `HLS_MASTER_PROOF_ADMITTED_KINDS`. |
| `lib/merge-timing.mjs`, `fixtures/sync-media.mjs` | — | Shared with SPLIT-06, DASH-01 and SYNC-01: the packet oracle and the historical merge reference. |
| `scripts/ytdlp-hls12-acceptance.test.mjs` | `npm test` | Self-tests of the pure modules. No Docker, no network. |
