# DASH-01 — the segmented-DASH real-media release child

**Test tooling only.** Nothing here runs during Worker startup, and none of it
ships in the Worker image. DASH-01 runs **only** as a child of the SPLIT-07
release-image gate (`split07-release-image-candidate-05` and later — since `-06`
beside the HLS-11 clear-HLS v2 child), inside the
exact candidate image, offline. It never deploys anything.

DASH-01 answers the question the review of `GENERIC-SEGMENTED-DASH-EXECUTION-001`
(PR #102) left open:

> Is the raw fragmented-DASH artifact that the exact pinned yt-dlp produces
> under the approved acquisition policy actually processable by VideoFetch's
> real ffprobe and FFmpeg — end to end, in the image a deployment would run?

The unit and full-path tests of that PR fake yt-dlp, FFmpeg and ffprobe. They
prove the state machine, the fragment grammar, the byte accounting and the
lifecycle ordering. They cannot prove the media. SPLIT-06's real-FFmpeg evidence
covers progressive split halves, and HLS-09's covers MPEG-TS → MP4 remux. Neither
covers the new artifact shape: the concatenation of a fragmented-MP4 init
segment and its `moof`+`mdat` fragments, written by the pinned native
`DashSegmentsFD` with `--fixup=never`, so no yt-dlp repair has touched it.

```
deterministic fixture (generated in the candidate by its own /usr/bin/ffmpeg)
  → 1920x1080 H.264 fragmented MP4 → init + N media segments → MPD SegmentList
  → AAC fragmented MP4 → init + N media segments   (segmented audio)
  → AAC m4a, served whole                           (progressive audio)
real analysis → preset:1080 → fresh execution analysis → merge-split plan
  → pinned yt-dlp DashSegmentsFD video acquisition   (durable: downloading)
  → segmented or progressive audio acquisition       (durable: downloading)
  → beginProcessing()
  → real ffprobe of both acquired inputs              (durable: processing)
  → real mergeSplitMedia FFmpeg stream copy           (durable: processing)
  → real ffprobe of the merged output                 (durable: processing)
  → beginUploading() → local object writer → ready
+ three bounded negatives
  → DASH-01 PASS (dash01-release-image-full-path-01)
```

No yt-dlp, FFmpeg or ffprobe is faked, stubbed or replaced. The substitutions
are exactly SPLIT-06's (`DASH01_SUBSTITUTIONS`): an exact loopback-fixture URL
validator in place of `assertSafeUrl`, a local object writer in place of R2, a
fresh temporary SQLite job store with a status-audit trigger, and the direct
analyzer's real predicates routing an MPD to the generic strategy.

---

## The fixture

| | Video | Segmented audio | Progressive audio |
| :--- | :--- | :--- | :--- |
| Recipe | `testsrc2` 1920×1080, 24 fps, 2 s, libx264 high, GOP 12, `-threads 1` | 440 Hz sine, AAC-LC 64k mono, 2 s | 660 Hz sine, AAC-LC 64k mono, 2 s |
| Container | fragmented MP4 (`empty_moov`, `default_base_moof`, `frag_keyframe`, `skip_trailer`) | fragmented MP4 (0.5 s fragments) | `ipod` m4a, `faststart` |
| Served as | `ftyp`+`moov` init + 4 `moof`+`mdat` segments | init + 4 segments | one file via `<BaseURL>` |
| yt-dlp protocol | `http_dash_segments` | `http_dash_segments` | `http` |
| Size (review run) | 179,450 B (init 799 + 52,073 / 47,924 / 40,026 / 38,628) | 18,051 B | 17,586 B |

- **Determinism.** `-fflags +bitexact`, per-stream `+bitexact`, `-map_metadata -1`,
  single-threaded x264. The child regenerates the fragmented video and requires
  identical bytes (`fixture/recipes-are-bit-exact`).
- **The split is exact.** `splitFragmentedMp4` refuses anything but
  `ftyp`,`moov`, then pairs of `moof`,`mdat`. That means no `mfra`, `sidx` or stray
  box. It requires `init + segments` to reassemble the file byte for byte.
- **Two manifests, one per pairing.** `dash-dash` has segmented video + segmented
  audio. `dash-progressive` has segmented video + progressive audio. The fixture is
  plain HTTP on loopback inside a `--network none` container, so the progressive
  half is `http`. `https` differs only in transport, because the pinned runtime
  acquires both with the same native `HttpFD`.
- Static, one Period, relative media references, synthetic Representation ids
  (`DASH01_*`). No DRM, no credentials, no signed or external URL.

## What one PASS proves

For each pairing, measured, with every expectation stated before the observation:

| Area | Proved |
| :--- | :--- |
| **Analysis** | `preset:1080` is advertised (video + audio, mp4, `1080p`). `sourceQuality` shows 1080 observed and deliverable, with nothing withheld. The public metadata carries no raw format, id or fragment route. Only the MPD is fetched during analysis. The private selection is a proven split with a segmented video half and the expected audio protocol. |
| **Plan** | `merge-split` → `mp4`, the analyzer's own pair. The fresh execution analysis chose the same pair. |
| **Acquisition** | One runtime probe and two yt-dlp media runs, video first. The pinned policy argv: native downloader, `--fixup=never`, one fragment at a time, no kept fragments, abort on an unavailable fragment, a nonexistent FFmpeg location. No `+` or `/` in any selector. |
| **The downloader actually used** | The video run's own output names the fragment downloader `dashsegments`. Its class is read from the pinned artifact in the same image (`DashSegmentsFD.FD_NAME`). `Total fragments` equals init + segments. Segmented audio uses `DashSegmentsFD`, and progressive audio uses no fragment downloader. No other bracketed banner appears, so no `[ffmpeg]`, `[Merger]`, `Fixup…` or `hlsnative`. |
| **Segmented acquisition happened** | The fixture ledger shows the init and every segment fetched exactly once, in order, each finished. The job directory was observed holding `.part-FragN.part`, `-FragN`, `.ytdl` and the `.part` aggregate during acquisition. |
| **The raw artifact** | The acquired video is byte-for-byte `init + segments`, and the audio is byte-for-byte its fixture. At processing entry the directory holds exactly `audio-source.m4a` and `video-source.mp4`, with no `.part`, `.ytdl`, `-Frag…` or other entry. |
| **Real input validation** | The image's ffprobe reads the acquired video as `mov,mp4,m4a,3gp,3g2,mj2`, one h264 stream at 1920×1080 and no audio. It reads the acquired audio as one aac stream and no video. The product itself probed video, then audio, before the merge. |
| **Real merge** | Exactly one FFmpeg run: stream copy (`-c:v copy -c:a copy`, no encoder), `-n`. `mergeSplitMedia` returned `merged.mp4`. |
| **Real output** | ffprobe of the delivered object: ISO-BMFF, exactly one video and one audio stream, 1920×1080, 2 s ± 0.25 s, size within `MAX_FILE_SIZE`. Compressed-packet identity with the acquired inputs, so it is a copy and not a transcode. The product probed the output after the merge. |
| **Lifecycle** | Durable trace `queued → analyzing → downloading → processing → uploading → ready`. The durable status is read at the instant of **every** Worker subprocess spawn: yt-dlp acquisition and the runtime probe at `downloading`; the 3 ffprobes and 1 FFmpeg at `processing`; no FFmpeg or ffprobe while `downloading`. A `/proc` sampler corroborates. `downloadedBytes` rises monotonically and never past the real artifacts, and progress ends at 100. |
| **Workspace** | Acquisition peak ≤ the allowance and ≤ artifacts + one fragment. Processing peak ≤ inputs + output ≤ 2 × `MAX_FILE_SIZE`. |
| **Upload / ready / privacy / cleanup** | One PUT, taken at `uploading`, and a provider HEAD the real lifecycle accepted. Uploaded bytes are the merged bytes, as `video/mp4`. Ready metadata matches. No synthetic id or fragment route appears on any public surface. The job directory is removed. |

**Bounded negatives** (each through the real executor, failing before any processing):

| Negative | Setup | Must observe |
| :--- | :--- | :--- |
| `fragment-guard` | Allowance = every byte before the last video segment + half of it. The service writes all but the last KiB of that segment, then holds for 8 s. | `TOO_LARGE`. The held response never finished, because the client left during the hold. The audio half never started. |
| `combined-budget` | Allowance = video + audio − 1. | `TOO_LARGE` after both halves ran. |
| `missing-fragment` | Video segment 2 answers 404. | `EXTRACTION_FAILED`. Segment 2 was requested (and retried), and no later segment was ever requested, so the run aborted rather than skipping. |

Each negative also requires: no `processing`/`uploading` in the trace, no product
FFmpeg or ffprobe, no upload, and the job directory removed.

The guard negative only passes if the guard counts the fragment **in flight**. A
guard that counted only the aggregate `.part` would see nothing over the
allowance until the held fragment completed. The guard is reactive, exactly as it
is for progressive sources: it kills the run on the first poll (150 ms) that
observes the violation. In the review run the job directory briefly held
172,566 B against a 160,136 B allowance at the kill. That is one fragment in
flight, bounded as the runbook §4k workspace paragraph states.

## What one PASS does NOT prove (`DASH01_NON_CLAIMS`)

- Real public DASH sources, a real CDN, signed-URL lifetime, or multi-Period
  manifests.
- **YouTube or any other site.** The supplied YouTube regression
  (`https://youtu.be/S_XfAWeXRFQ?si=WAQXxhU-vUaD5PjB`) is NOT exercised or resolved
  here. Its status is `UNRESOLVED — PRODUCTION EXECUTION FAILURE REQUIRES
  DIAGNOSIS` (runbook §4k).
- Production SSRF/DNS/egress policy, Cloudflare, R2, Vercel, Production startup,
  promotion or uptime.

## The evidence

**Schema: `dash01-release-image-full-path-01`** (`lib/dash-evidence.mjs`).

- **Identity** is the release identity the SPLIT-07 parent observed, exactly as
  HLS-09 records it: source commit and tree (clean), candidate build label,
  immutable image id, the run subject Docker executed, and loopback-only
  interfaces.
- **A PASS requires every one of `DASH01_MANDATORY_CHECKS` present exactly once
  and passing**, and no other check failing. The list covers the identity,
  preflight, fixture, all 54 case checks for **both** pairings, and the 13 negative
  checks: 142 in all. Removing an assertion from the orchestrator therefore
  cannot produce a PASS. The builder refuses, and the parent's validator refuses
  independently.
- **Privacy.** The record is an allowlist. No key named `argv`, `stderr` or any
  credential may appear. No string anywhere may contain a synthetic id, a
  fixture route, `.m4s`, `.mpd`, the loopback address, `http://`/`https://`,
  `/tmp/videofetch`, the harness scratch path, or `--format`. A diagnostic check
  detail that would contain any of these is withheld, never allowed to block the
  record.
- The parent re-reads the exact bytes, validates them (`validateDashChildRecord`),
  hashes them, and re-hashes them before assembling its own record.

## Running it

Only through SPLIT-07 (see `SPLIT-07.md`). The driver launches it with
`releaseDashAcceptanceRunArgs`: the SPLIT-06 release posture (`--network none`,
`--read-only`, `--cap-drop=ALL`, `no-new-privileges`, the Product media workspace
bound at `/tmp/videofetch`, the harness scratch tmpfs) with **no** `--add-host`.
It re-derives that posture structurally before launch
(`releaseDashRunPostureViolations`). The child's Product preflight, like every
merge-split job, needs 2 × `MAX_FILE_SIZE` available in the media workspace.

A standalone run (for diagnosis only; it produces no release record) takes the
same identity flags:

```sh
node --import ./scripts/register-ts-aliases.mjs --experimental-strip-types \
  deploy/acceptance/ytdlp-generic/dash-full-path.mjs \
  --evidence /report/<name>.json --source-commit <40-hex> --source-tree <40-hex> \
  --source-context-clean --candidate-tag videofetch-worker:split07-<sha12>-local-test \
  --candidate-image-id sha256:<64-hex> --run-image-id sha256:<64-hex>
```

## Negative controls: the child cannot pass without real media processing

Recorded for the PR #102 review corrections. Each mutation was applied to a
scratch copy, never to this repository, and run standalone in the candidate
image:

| Mutation | Child outcome | Parent (`validateDashChildRecord`) |
| :--- | :--- | :--- |
| **M1** Real DASH acquisition replaced by synthetic output: the byte-identical fixture written into place, no yt-dlp | FAIL, exit 1: `acquisition/one-runtime-probe-two-media-runs-video-first` (0 probes, 0 media runs) | `ok: false` |
| **M2** The product's input ffprobe validation skipped (`mergeSplitMedia` stage 3 removed) | FAIL, exit 1: `input/product-probed-both-inputs-before-the-merge` (only the merge and the output probe ran) | `ok: false` |
| **M3** The real FFmpeg merge skipped: an out-of-band, stream-copied `merged.mp4` handed back instead | FAIL, exit 1: `input/product-probed-both-inputs-before-the-merge` (no product ffprobe or FFmpeg at `processing`) | `ok: false` |
| **M4** The output-resolution assertion removed from the orchestrator | no record, exit 2: the builder refused the PASS, `output/resolution-is-1920x1080: recorded 0 times` | unreadable child, so FAIL |
| **M5** The audio-stream assertion removed from the orchestrator | no record, exit 2: the builder refused the PASS, `output/exactly-one-audio-stream: recorded 0 times` | unreadable child, so FAIL |

The unmutated control, run the same way, PASSed 142 of 142, and the parent
validator accepts it.

## Files

| File | Runs on | Purpose |
| :--- | :--- | :--- |
| `dash-full-path.mjs` | inside the candidate | The orchestrator (release-image mode only). |
| `lib/dash-argv.mjs` | — | Its command line: exactly the parent's identity flags. |
| `lib/dash-evidence.mjs` | — | Schema, mandatory checks, PASS and privacy gates, the parent-side validator. |
| `lib/dash-observers.mjs` | — | Spawn observer, workspace sampler (independent FragmentFD grammar), downloader identity, yt-dlp runner ledger. |
| `fixtures/dash-media.mjs` | — | Recipes, the fragmented-MP4 splitter, the closed route grammar, the MPDs. |
| `fixtures/dash-server.mjs` | inside the candidate, loopback only | The closed-route fixture service, with a sanitized ledger and pace/hold/failing behaviours. |
| `scripts/ytdlp-dash-acceptance.test.mjs` | `npm test` | The pure parts, pinned without Docker, FFmpeg or yt-dlp. |
