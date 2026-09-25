# HLS-08 — the deterministic clear-HLS full-path acceptance harness

**Test tooling only.** Nothing here runs during Worker startup, no systemd unit
references it, and none of it is on the Worker image's runtime path. HLS-08
adds no Product capability and changes no Product source.

HLS-08 proves, offline and deterministically, that the clear-HLS chain HLS-1…HLS-7
built executes end to end against the exact accepted media runtime:

```
browser-safe analysis -> ordinary HLS-backed public preset
-> fresh execution analysis -> ordinary deriveExecutionPlan() -> clear-hls-remux plan
-> HLS-2 playlist preflight -> HLS-3 sequential fragment acquisition
-> beginProcessing() -> HLS-4 ffprobe + FFmpeg stream-copy remux + validation
-> beginUploading() -> finalizeJobUpload() -> local provider -> ready
```

It is the clear-HLS counterpart of SPLIT-06. It is **not** HLS-9 (release-image
qualification) and **not** HLS-10 (promotion or real-source acceptance).

---

## What one PASS proves

Against deterministic local fixtures and the exact accepted media runtime, the
exact recorded source commit executed the activated clear-HLS chain from real
generic analysis through durable `ready`, using:

| Piece | Real? |
| :--- | :--- |
| `createMediaAnalysisPolicy` — ONE policy for `analyze` and `analyzeForExecution` | real |
| `analyzeGenericMediaInternal` and the pinned yt-dlp 2026.08.19 executable | real |
| the direct-first router, `WorkerAnalyzeRequestSchema`, `looksLikeDirectMedia` | real |
| `deriveExecutionPlan` (the executor default — not injected) | real |
| `JobExecutor`, its fresh execution analysis, its `statfs` workspace preflight | real |
| `SQLiteJobStore` on a real temporary database | real |
| HLS-1 parser, HLS-2 preflight, HLS-3 acquisition, HLS-4 processing | real |
| `safeGet` / `safeHttpRequest`: URL policy, private-address refusal, redirects, headers, abort checks, Node HTTP | real |
| `/usr/bin/ffprobe`, `/usr/bin/ffmpeg` | real |
| `validateLocalOutput`, `beginUploading`, `finalizeJobUpload` | real |
| the submitted-page URL **validator** | **substituted** |
| the safe-HTTP **DNS answer and socket** | **substituted** |
| the object-storage **provider** | **substituted** |

It additionally establishes that the pinned extractor naturally discovers the
fixture as `m3u8_native` / 360p / avc1 + mp4a with a media-playlist location;
that yt-dlp analyzes but never acquires HLS media; that HLS-2/HLS-3 do the
acquisition while the job is `downloading`; that every media-tool process runs
only after `beginProcessing()`; that the executed FFmpeg argv is the reviewed
stream copy; that the uploaded bytes are the produced MP4 and not the MPEG-TS
aggregate; and that no private HLS provenance reaches a public or durable
surface.

## What one PASS does NOT prove

- Production SSRF/address pinning, Production DNS, and Production
  egress/nftables — **not re-proven here**. Phase 9 remains the authority for
  Production egress.
- Production deployment, release-image qualification (HLS-9), promotion
  (HLS-10).
- Cloudflare Tunnel/Access, Vercel, Cloudflare R2, the R2 credential broker.
- The Production media network namespace, watchdog and workspace provisioning.
- Public-site HLS compatibility, real CDN behaviour, real signed-URL lifetimes.

---

## The three substitutions

### 1. The submitted-page validator (`lib/hls-fixture-url.mjs`)

Production's `assertSafeUrl` correctly refuses the fixture, whose name lands on
loopback inside the container. The acceptance validator admits exactly ONE
string — `http://hls-fixture.example.invalid:<port>/hls08/watch.html` — and the
raw input must already be that canonical spelling. Other schemes, hosts, ports,
paths, userinfo, queries and fragments are refused with `INVALID_URL`. The run
records the refusal of every entry in `nearbyPageUrlAlternatives()`.

The direct half of the router still runs the real request schema and the real
`looksLikeDirectMedia`: the page is HTML, so the real predicate declines it and
the ordinary generic fallback proceeds. It is not an "always generic" stub.

### 2. The safe-HTTP transport (`lib/hls-safe-http-transport.mjs`)

HLS-2 and HLS-3 run unchanged and fetch through the real `safeGet`. Only the
two lowest Product test hooks are used:

- `setSafeHttpTestHooks({ lookup })`: `hls-fixture.example.invalid` →
  one synthetic public address (`8.8.8.8`); every other name is refused. The
  real `validateResolvedAddresses` therefore still runs, and a self-test proves
  a private synthetic answer is refused by the Product itself.
- `setPinnedRequestFactoryForTests({ http })`: verifies the request that
  already passed the real policy — exact host, port, `GET`, route, Host header,
  pinned to the synthetic answer — then hands Node's real `http.request` the
  SAME options with one change: the pinned lookup answers `127.0.0.1`. No body
  is ever synthesized.

Both hooks are cleared in a `finally`, and the run observes the restoration.

### 3. The local object writer (`lib/local-object-writer.mjs`)

Reused unchanged from SPLIT-06. Cloudflare R2 is substituted; everything on the
Worker's side stays real, and its HEAD measures the persisted file.

---

## The isolated container (`lib/hls-container.mjs`)

- `FROM` the accepted image; copies exactly SPLIT-06's `OVERLAY_COPIED_PATHS`
  (`src`, `deploy/acceptance/ytdlp-generic`); removes `/app/src/broker`;
  `USER node`.
- Tag `videofetch-worker:hls08-<sha12>-local-test`; deployable spellings are
  refused. Never pushed, never `latest`, never a systemd image, never a
  rollback tag; removed after the run unless `--keep-image`.
- `docker run --rm --pull never --network none
  --add-host hls-fixture.example.invalid:127.0.0.1 -v <report>:/report -w /app`
  by the overlay's **immutable id**. The only bind mount is the report
  directory: no Docker socket, broker socket, `worker.env`, credential,
  Production SQLite or Production workspace. `hlsRunPostureViolations()` parses
  the argv structurally and the driver refuses to run on any violation.

The accepted base is pinned in `HLS08_ACCEPTED_BASE`: source
`593f47dfffe79f166d40af6575c6130668e56af0`, image
`sha256:5925515fb002cd7203228325e1d30fd5987eafde3043ca1663162b9fe04df21e`,
yt-dlp `2026.08.19`. A tag is not evidence: the driver inspects the id, and
after the build proves the overlay's layers begin with the base's layers.

---

## The fixture (`fixtures/hls-media.mjs`, `fixtures/hls-server.mjs`)

Generated at run time by the accepted image's FFmpeg, as harness work (counted
as `fixtureToolUse`, never as Product media work, and generated before the
Product subprocess observer is installed):

- H.264 baseline 3.0, 640×360, 20 fps, AAC-LC mono; 6 s with a forced keyframe
  every 2 s, so FFmpeg's own HLS muxer cuts exactly **3** MPEG-TS segments;
- the FFmpeg-authored VOD playlist, served verbatim, re-checked with the
  Product's HLS-1 parser and tag allowlist;
- an HTML page with `<source src="/hls08/master.m3u8" type="application/x-mpegURL">`;
- a one-variant master (`RESOLUTION=640x360`, `CODECS="avc1.42c01e,mp4a.40.2"`,
  `NAME="HLS08_RAW_FORMAT_ID"`) whose media-playlist URI carries one
  private-by-contract marker in `?sig=`.

No `--load-info-json` and no injected extractor JSON: the pinned extractor
reads the real page and master.

### The fresh-provenance witness

The master first names `HLS08_PRIVATE_BROWSER` for the browser-safe
`policy.analyze`, then is rotated to `HLS08_PRIVATE_EXECUTION` before the job
runs — the submitted page URL never changes. A PASS requires the execution
selection and plan to name the EXECUTION playlist, HLS-2 to request exactly
that one, and the BROWSER playlist never to be requested by anyone.

---

## What is observed, and how

| Observation | Mechanism |
| :--- | :--- |
| durable status transitions | the SPLIT-06 SQLite status-audit trigger |
| every HLS-2/HLS-3 request, its durable status, header names, open/end sequence | the acceptance transport's ledger |
| arrival/finish of every request at the server | the fixture's ledger, sharing the same event clock |
| every Product subprocess, classified, with its durable status | `setProcessRunnerTestHooks({ spawn })`, an observer delegating to the real `spawn` with the exact argv/options |
| the HLS-3 aggregate's bytes | hashed at HLS-4's first media spawn, before that spawn is delegated |
| the remux policy | `evaluateHlsRemuxArgv()` over the argv actually spawned; booleans only |
| the produced MP4 vs the uploaded object | digest of the upload stream's own file at `put` start vs the writer's digest |

Evidence carries sanitized facts only — kinds, labels, ordinals, booleans,
counts, digests — never a URL, a marker, a raw id, argv or a temporary path.

### No-transcode proof

The executed FFmpeg argv carried `-c:v copy -c:a copy` with no encoder or
filter selection, and the output is a valid ISO-BMFF with exactly one H.264 and
one AAC stream of the fixture's duration. Compressed packet identity between
MPEG-TS and MP4 is deliberately **not** claimed: Annex-B → AVCC framing may
change in a container stream copy.

### The hostname privacy rule

The Product legitimately echoes the page the user submitted — `webpageUrl` is
that URL, `source` its hostname, and the durable row keeps both because the job
re-analyzes its own URL. That echo is ordinary Product metadata, not HLS
provenance. Every OTHER host:port/path use of the fixture hostname is a
failure, and every marker, the raw upstream id, `m3u8`, `sig=`, fragment names,
`playlistUrl`, `hlsSelections` and `clear-hls-remux` are refused on the public
and durable surfaces regardless.

---

## The bounded negatives

| Case | Setup | Required |
| :--- | :--- | :--- |
| encrypted playlist | the positive playlist plus ONE `#EXT-X-KEY` line | `FORMAT_UNAVAILABLE`; playlist fetched once; 0 fragment/key requests; 0 media processing; 0 PUT; never `ready` |
| fragment HTTP failure | fragment 2 of 3 answers 503 | `NETWORK_ERROR`; fragments 1 and 2 once each, 3 never; 0 media processing; 0 PUT; never `ready` |
| FFmpeg unavailable at analysis | the policy's FFmpeg resolver answers `false` | no HLS-backed preset; `hlsSelections` empty; the rendition withheld as `unsupported_protocol`; plan `FORMAT_UNAVAILABLE` |

The larger rejection matrix (maps, byte ranges, discontinuities, encodings,
size limits, cancellation and deadline races, filesystem races) remains the
authority of the focused HLS-1…HLS-4 unit suites.

---

## How to run it

Inside the `videofetch` Lima VM, from a clean in-VM clone at the exact
candidate commit (the provenance gate refuses a dirty context):

```sh
H=<full 40-hex candidate commit>; T=<its full tree>
C=/var/tmp/hls08-ctx-${H:0:12}
sudo git clone -q --no-hardlinks /repo "$C"
sudo git -C "$C" checkout -q --detach "$H"
sudo install -d -m 2775 -o 1000 -g 1000 /var/tmp/hls08
sudo node "$C/deploy/acceptance/ytdlp-generic/run-hls-acceptance.mjs" \
  --base-image  videofetch-worker:rc-593f47dfffe7-5925515fb002 \
  --base-digest sha256:5925515fb002cd7203228325e1d30fd5987eafde3043ca1663162b9fe04df21e \
  --base-source 593f47dfffe79f166d40af6575c6130668e56af0 \
  --head "$H" --tree "$T" --context "$C" --report /var/tmp/hls08
```

The report directory must already exist and be writable by the image's `node`
user (uid 1000). The driver names a new `hls08-<UTC stamp>.json`, refuses an
existing one, and the container creates it exclusively. The driver then reads
it back, validates it against the commit, tree, base digest and overlay id it
observed, and prints its SHA-256.

Order, fail-closed: Git provenance (before any Docker command) → base id (before
any build) → overlay build → provenance again → overlay id and layer prefix →
new report target → isolated run → evidence read-back → overlay removal.

**A PASS is valid only for the exact commit and tree it names.** Any source
change afterwards makes it stale; re-run against the new head.

The driver never starts or stops the VM. If the VM was started for the run,
stopping it again afterwards is the operator's step.

## Evidence

Schema `hls08-deterministic-full-path-01` (`lib/hls-evidence.mjs`). There is no
partial PASS: every name in `HLS08_MANDATORY_CHECKS` must be recorded exactly
once and pass, and every other recorded check must pass. The builder is an
allowlist, refuses raw-material keys (`stderr`, `stdout`, `argv`,
`playlistUrl`, `url`, `headers`, `token`, …) and refuses any serialized string
containing a private marker, the raw upstream id, the fixture hostname, a URL,
`sig=`, a `/tmp/` path or a `.m3u8` name. The record names its three
substitutions and its non-claims.

Self-tests: `scripts/ytdlp-hls-acceptance.test.mjs` — no Docker, no network.
