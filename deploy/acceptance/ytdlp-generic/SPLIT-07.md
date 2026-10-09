# SPLIT-07 — the release-image candidate acceptance harness

**Test tooling only.** Nothing here runs during Worker startup, no systemd unit
references any of it, and none of it ships in the Worker image. Running it is
**not** a deployment: it builds a temporary, structurally non-deployable image,
characterizes it offline, records the result, and removes the image.

SPLIT-07 answers one question SPLIT-06 cannot:

> Does the image the repository's **real** `Dockerfile.worker` produces, from
> one exact, clean Git commit, contain exactly that commit's application source,
> carry the hardened configuration and pinned media runtime the deployment
> contract relies on, and execute the full split-stream chain — mp4 **and**
> webm — (since `-03`) the activated clear-HLS chain, (since `-05`) real
> fragmented segmented-DASH media through the Worker's own FFmpeg, (since
> `-06`) real clear-HLS v2 fMP4 media, (since `-07`) a split merge that
> preserves the source's relative A/V timing, (since `-08`) a separate-audio
> fMP4 HLS pair proven from a Master Playlist the Product fetches itself, and
> (since `-09`) the ONE acquisition deadline that pair's halves share,
> deterministically?

```
release source   (clean Git worktree, exact commit + tree)
acceptance harness (clean Git worktree, exact commit + tree, verified throughout)
  → actual Dockerfile.worker image (immutable image id = every container's run subject)
  → image identity / configuration / runtime / hardening
  → SPLIT-06 mp4 PASS    (split06-deterministic-full-path-05, validated, hashed)
  → SPLIT-06 webm PASS   (split06-deterministic-full-path-05, validated, hashed)
  → HLS-09 clear-HLS PASS (hls09-release-image-full-path-02, validated, hashed)
  → DASH-01 segmented-DASH PASS (dash01-release-image-full-path-02, validated, hashed)
  → HLS-11 clear-HLS v2 PASS (hls11-release-image-full-path-02, validated, hashed)
  → SYNC-01 split-merge timing PASS (sync01-release-image-merge-timing-01, validated, hashed)
  → HLS-12 separate-audio clear HLS PASS (hls12-release-image-separate-audio-02, validated, hashed)
  → SPLIT-07 PASS        (split07-release-image-candidate-09, created exclusively, read back)
```

The clear-HLS child is HLS-09's; its own contract is in [`HLS-09.md`](HLS-09.md).
The segmented-DASH child is DASH-01's; its own contract is in [`DASH-01.md`](DASH-01.md).
The clear-HLS v2 child is HLS-11's; its own contract is in [`HLS-11.md`](HLS-11.md).
The split-merge timing child is SYNC-01's; its own contract is in [`SYNC-01.md`](SYNC-01.md).
The separate-audio clear-HLS child is HLS-12's; its own contract is in [`HLS-12.md`](HLS-12.md).

---

## Why SPLIT-06's overlay evidence is not release-image evidence

SPLIT-06 deliberately **overlays** the already accepted Worker image with the
candidate's `/app/src` (see `lib/split-container.mjs`). That was the right
design for SPLIT-01…SPLIT-05: they changed application source only, and
rebuilding Bookworm packages to test a source change would have introduced
unrelated runtime drift into the one run meant to isolate the source.

The same design is why a SPLIT-06 PASS says nothing about a release:

| | SPLIT-06 overlay | SPLIT-07 release candidate |
| :--- | :--- | :--- |
| Recipe | a test Dockerfile written by the harness | the repository's real `Dockerfile.worker` |
| Runtime layers | the **old** accepted image's | freshly built from the recipe |
| `/app/src` | `COPY`-ed on top by the test | placed by the recipe itself |
| Acceptance harness | **baked into** the image | **not** in the image; mounted read-only |
| Base/package drift | hidden by design | absorbed or exposed — that is the point |
| Deployable? | never | the SPLIT-07B retained candidate may become so |

A deployment runs the image `Dockerfile.worker` builds. So the release gate must
characterize exactly that image, and must not accept an overlay, an alternate
Dockerfile, or a historical accepted image as a stand-in.

---

## What one PASS proves

For one release source commit, all of the following, measured against the
actual built image rather than asserted from the Dockerfile text:

| Area | Proved |
| :--- | :--- |
| **Source** | The build context was a real Git worktree root at the exact expected commit and tree, with nothing modified, staged, untracked, ignored, or hidden by assume-unchanged/skip-worktree — **before** Docker ran and **again after** the build read it. |
| **Recipe** | The image was built by `Dockerfile.worker` from that context, with no build arg, no secret and no host network. Its committed blob and SHA-256 are recorded. |
| **Harness** | The executable acceptance harness — driver, SPLIT-06, clear-HLS, segmented-DASH, clear-HLS v2, split-merge timing and separate-audio clear-HLS orchestrators, Python verifiers, image probe, evidence evaluators — was a real Git worktree root at the operator's explicit `--harness-source`/`--harness-tree`, clean in the same ways as the release context, **before any Docker command and at every checkpoint through the end of all seven children**; and the executing driver file is that checkout's own. |
| **Run subject** | Every candidate container — four probes, two verifiers, two SPLIT-06 children, the clear-HLS, segmented-DASH, clear-HLS v2, split-merge timing and separate-audio clear-HLS children — executed the image's immutable `sha256:` id, as parsed from the argv Docker received. None executed the mutable tag. |
| **Source → image** | Every regular file the recipe places in `/app` (`package.json`, `package-lock.json`, the alias loader and hooks, all of `src/**`) is present in the image with byte-identical content; no unexplained file is present; `src/broker/**` is absent and its removal is accounted for; the acceptance harness is not baked in. |
| **Configuration** | Linux; architecture recorded and compared with the accepted Worker's; `WorkingDir=/app`; runtime user `node`; `CMD` is exactly the standalone Worker entry point, and `ENTRYPOINT` is at most the base image's inherited `docker-entrypoint.sh` exec shim — observed root-owned, unwritable, at its real path, digest recorded; only `8080/tcp` exposed; no `HEALTHCHECK`; no image-declared volume; the expected non-secret defaults present. |
| **Environment** | No `YTDLP_ENABLED`, no retired `YTDLP_NETWORK_ISOLATED`/`YTDLP_PATH`, and no Worker HMAC, Cloudflare Access, R2 broker-parent, legacy R2 writer or Vercel signer name — checked in the image config **and** inside a running container. |
| **Tooling** | No `docker`, `sudo`, `ssh`, `nft`, `iptables`, `curl` or `wget`, looked up on `PATH` **and** in every standard binary directory. A present tool is a failure that names where it was found; it is never normalized away. |
| **Pinned runtime** | `/usr/local/lib/videofetch/yt-dlp` is version `2026.08.19` with SHA-256 `1fa6733c…d8d4d6`, root-owned, mode `0555`, a regular file at its own real path; `/usr/bin/python3` executes it; an **attempted write** by the runtime user is refused by the kernel. |
| **Media tools** | `ffmpeg` and `ffprobe` are present and executable by the runtime user; Node, Python, ffmpeg and ffprobe versions are recorded exactly. |
| **Offline policy** | `verify-selector.py` and `verify-download-policy.py` (which pins PR #54's `--no-quiet` contract) exit 0 against the image's own artifact. |
| **Full path** | The SPLIT-06 harness PASSes for **mp4 and webm**, executing the candidate image's own `/app/src`, dependency graph, alias loader, Node, Python, yt-dlp, FFmpeg and ffprobe. Since `-07` (`split06-deterministic-full-path-05`) each family runs the full path twice, on the zero-aligned pair and on an offset pair, and the delivered artifact must preserve the relative A/V timing a pre-job oracle measured. |
| **Clear HLS** (since `-03`) | The HLS-08 clear-HLS positive full path and its three bounded negatives PASS in the orchestrator's `release-image` mode (`hls09-release-image-full-path-02` since `-04`; `-01` under `-03`), executed by the same image's own runtime, naming this release source and this immutable id, offline. |
| **Segmented DASH** (since `-05`) | The DASH-01 real-media child PASSes (`dash01-release-image-full-path-02` since `-07`, adding the synchronization oracle and the pre-job merge-policy check; `-01` under `-05`/`-06`): a deterministic 1920×1080 fragmented-MP4 fixture served as an MPD `SegmentList` is acquired by the image's pinned native `DashSegmentsFD` (identity read from the child's own output, every fragment fetched once in order, the artifact byte-identical to init + fragments, no residue), validated by the image's real ffprobe, merged by the real `mergeSplitMedia` FFmpeg stream copy and validated again (one video + one audio stream, 1920×1080), with segmented and with progressive audio; every FFmpeg/ffprobe spawn at `processing` and none at `downloading`; and its three bounded negatives fail closed. Same image, same source, offline. |
| **Clear-HLS v2** (since `-06`) | The HLS-11 real-media child PASSes (`hls11-release-image-full-path-02` since `-08`, whose split-master case also records the Product's own master proof — one unredirected request, no media request, both variants refused; `-01` under `-06`/`-07`): a deterministic 1920×1080 MPEG-TS control and a 1920×1080 fMP4 rendition (init + 4 fragments), from real pinned-yt-dlp analysis through the ordinary planner, the real HLS-2/3/4 chain (the map first for fMP4), the image's real ffprobe (family demuxer) and ONE real FFmpeg stream copy, to `ready`; every playlist, map and fragment request at `downloading` and every ffprobe/FFmpeg at `processing`; the delivered MP4 one H.264 1920×1080 + one AAC stream, faststart, packets preserved; the fMP4 playlist is the pinned packager's own `#EXT-X-VERSION:7` + `#EXT-X-INDEPENDENT-SEGMENTS` output; eight fail-closed negatives (three of them v2 grammar refusals before the map is requested) and the split-master pairing case. Same image, same source, offline. |
| **Split-merge timing** (since `-07`) | The SYNC-01 child PASSes (`sync01-release-image-merge-timing-01`): for each of 19 deterministic cases (progressive and fragmented MP4, WebM with Opus and Vorbis; zero-aligned controls, legitimate offsets, shared non-zero bases, B-frame delay, absolute `tfdt`, edit-list pre-roll, duration discriminators), the candidate's own `mergeSplitMedia` carried exactly the synchronization policy a pre-job oracle derived and preserved the source's relative A/V timing, measured from packet timestamps and from a decoded flash/click event; every zero-aligned control is identical to the historical merge's output; and the oracle detects the historical merge's per-input zeroing. Same image, same source, offline. |
| **Separate-audio clear HLS** (since `-08`) | The HLS-12 real-media child PASSes (`hls12-release-image-separate-audio-02` since `-09`, which adds the shared-deadline negative; `-01` under `-08`): three deterministic video-only + audio-only fMP4 pairs — audio ~0.48 s late, video ~0.52 s late, and a zero-aligned control — each proven by the candidate's own master proof (one Product master request, no redirect, while `analyzing`), planned as the private `clear-hls-separate-audio-remux`, acquired video half then audio half under ONE byte budget while `downloading`, and merged after `beginProcessing()` by ONE real FFmpeg stream copy whose `-isync` reference is the earlier-starting half, to `ready`; each pair's source timing measured before the job and preserved within the time-base tolerance with every packet payload identical, the control byte-identical to the historical merge, and the oracle shown sensitive to per-input zeroing; four master negatives (ambiguous group, no group beside a convenient one, a redirecting master, a re-signed master) advertise nothing, and six execution negatives (MPEG-TS audio, muxed "video", video "audio", the shared budget, a 404 audio map and, since `-09`, the shared deadline: under a narrowed configured budget the video half completes having used most of it and the audio half is stopped, unanswered, at that same deadline — `TIMEOUT`, no media tool, no upload) fail closed. Same image, same source, offline. |
| **No disturbance** | `videofetch-worker:latest`'s image id, and the running Worker container's image id, start time and restart count, are identical before and after the run. |

### The inherited ENTRYPOINT

`node:22-bookworm-slim` declares `ENTRYPOINT ["docker-entrypoint.sh"]` and
`Dockerfile.worker` does not override it, so every image this recipe produces —
the accepted Production image included — starts through that shim. It is
`exec "$@"`, prefixing `node` only when the first argument is a flag or not a
command; with `CMD[0] = "node"` it execs the Worker entry point unchanged.

SPLIT-07 accepts exactly `[]` or `["docker-entrypoint.sh"]` by name, and then
checks the shim by **observation** from inside the image, because whatever runs
before the Worker is part of what the image starts. The first real SPLIT-07A run
required an empty `ENTRYPOINT`, and that check failed against the real image —
another expectation the fake world had encoded wrongly (`Entrypoint: null`) and
the real build corrected. The fake now mirrors the real base.

## What one PASS does NOT prove

- **Production.** Nothing is deployed. No systemd unit, `worker.env`, SQLite
  state, nftables rule, DNS record, tunnel or R2 object is read or changed.
- **The Production egress namespace.** Every candidate container runs with
  `--network none` — see below.
- **Cloudflare, the R2 broker, Vercel, or live YouTube compatibility.** Those
  have their own stages. The SPLIT-06 children substitute a local object writer
  and an exact-fixture URL validator exactly as `SPLIT-06.md` documents.
- **Production safe-egress, DNS or address pinning for HLS, or real public HLS
  sources.** The clear-HLS child keeps HLS-08's substitution — the real Product
  safe-HTTP policy with an acceptance synthetic public DNS answer and a loopback
  socket — and a real release image as the subject does not widen that claim.
- **Reproducibility of the build.** Two builds of one commit may differ in
  Debian package revisions or npm tarball timing. SPLIT-07 characterizes **one
  built image by its immutable id**; it does not claim that any other build of
  the same commit is equivalent. That is why the id, not the tag, is the
  identity recorded, and why SPLIT-07B retains the exact image it accepted.

---

## Source-to-image provenance

"Source provenance" and "image identity" are two different facts, and the
record keeps them apart:

- **Source** is established from Git alone: `lib/release-provenance.mjs` checks
  the context and reads the commit's objects. The CLI's `--source`/`--tree` are
  **expectations**; the record holds only values Git **observed**.
- **Image** is established from Docker alone: the immutable image id from
  `docker image inspect`, never the tag.
- **The link between them** is the manifest comparison. The expected side is
  `git ls-tree -r` at the observed commit, each blob hashed from `git cat-file`,
  so it is a statement about the commit and not about whatever the worktree
  holds. The observed side is the in-image probe hashing `/app` from inside the
  candidate. Both are sorted `path` + SHA-256 lists (`sha256sum`'s own format,
  so a reviewer can reproduce either by hand), compared in both directions, and
  each summarized as one digest.

A symlink or a gitlink under `/app` is refused on the source side and reported
as irregular on the image side, because a link's target is not its bytes and
following one silently would make two different things look identical.

### Harness provenance (since `-02`)

The release context is not the only executable input. The harness checkout
supplies the driver, `split-full-path.mjs`, `hls-full-path.mjs`, both Python
verifiers, the image probe and the evidence evaluators, and it is mounted into
the candidate, so a locally modified harness could change what is measured or
what counts as PASS. Recording its `HEAD` — all `-01` did — is not provenance.

`verifyHarnessProvenance` applies the release context's gate to `--harness`,
against **explicit** `--harness-source`/`--harness-tree` expectations that are
never derived from the checkout being verified. The harness must be a real Git
worktree, and its root; `HEAD` must be exactly the expected commit, and that
commit's tree exactly the expected tree. Nothing may be modified, deleted,
staged, untracked or ignored, and no index entry may be marked
assume-unchanged or skip-worktree. The record names the Git tree object of the
mounted `deploy/acceptance/ytdlp-generic` directory and the driver's blob.

The executing driver is bound to that checkout as well: the driver file actually
running must resolve to `<--harness>/deploy/acceptance/ytdlp-generic/run-release-image-acceptance.mjs`.
Otherwise a clean checkout could be named while different code ran the proof.
Run the driver **from** the harness checkout.

The harness is consumed throughout the run, so it is re-verified at every
checkpoint: `before-docker`, `after-build`, `before-split06-mp4`,
`before-split06-webm`, `before-hls09-clear-hls` (since `-03`),
`before-dash01-segmented-dash` (since `-05`), `before-hls11-clear-hls-v2`
(since `-06`), `before-sync01-merge-timing` (since `-07`),
`before-hls12-clear-hls-separate-audio` (since `-08`) and `after-children`.
The last one comes after **all seven** children have executed and before the parent record is
assembled; the record must list exactly that sequence. A harness that changes at any point makes the run's own
measurements untrustworthy, so the driver **refuses the record outright**. That
means no parent record, PASS or FAIL, and the refusal says which checkpoint
failed.

The topology is recorded as **observed**, not assumed:
- `harness.worktreeIsReleaseContext` says whether the two checkouts are one path.
- `harness.commitIsReleaseSource` says whether they are one commit.

SPLIT-07A uses two checkouts at two commits. SPLIT-07B may use one merged
commit, and even one checkout, for both roles.

### The candidate is its immutable image id (since `-02`)

The temporary tag is a mutable pointer. Between the moment the driver inspects
it and the moment a probe runs, it can be retargeted, and a record could then
claim image A while Docker executed image B. So once the tag has been built and
inspected, the inspected id is validated against the exact grammar
`sha256:<64 lowercase hex>`. From that point every candidate container executes
**that id**. An abbreviated id, a repository reference or `latest` is refused,
even though the daemon itself would run all three.

Configuration and id come from one `docker image inspect`, so they describe one
image. The driver records the run subject of every candidate container from
the very argv it hands Docker, parsed by a closed-grammar `dockerRunSubject`.
It then checks that all thirteen required containers ran the id: the four probes
(manifest, tools, env, runtime), the two verifiers, SPLIT-06 mp4 and webm,
(since `-03`) the clear-HLS child, purpose `hls09:clear-hls`, (since `-05`) the
segmented-DASH child, purpose `dash01:segmented-dash`, (since `-06`) the
clear-HLS v2 child, purpose `hls11:clear-hls-v2`, (since `-07`) the
split-merge timing child, purpose `sync01:merge-timing`, and (since `-08`) the
separate-audio clear-HLS child, purpose `hls12:clear-hls-separate-audio`.

The grammar is closed: it understands exactly the options the container model
emits, now including `--add-host` as a one-value option for the clear-HLS
child, and refuses anything else. An `--option=value` spelling is understood
only for an option the grammar already knows, so `--privileged=true` cannot
pass as "some option with an equals sign".

The tag keeps its other jobs — `docker build -t`, human diagnostics and cleanup —
and keeps every restriction on it. Cleanup removes the tag only while it still
names the tested id: a tag retargeted in the meantime is not this run's to
delete.

## What is mounted, and why that is not a source overlay

The acceptance harness deliberately does **not** ship in a release image, so
the only way to run it against one is to mount it. That is sound because of
what is **never** mounted. `lib/release-container.mjs` refuses — in every argv
it produces, as a property of the module rather than a caller convention — any
mount whose target is, or is under:

```
/app/src   /app/scripts   /app/package.json   /app/package-lock.json
/app/node_modules   /usr/local/lib/videofetch   /usr/local/bin/node
/usr/bin/python3   /usr/bin/ffmpeg   /usr/bin/ffprobe
```

What **is** mounted from the repository and the report directory, all read-only
except the report directory (the Product media workspace and the harness scratch
are the other writable surfaces, below):

| Mount | Target | Why there |
| :--- | :--- | :--- |
| `deploy/acceptance/ytdlp-generic` | `/verify` (ro) | The Python verifiers and the image probe import nothing from `/app`, so they sit outside the application tree entirely. |
| `deploy/acceptance/ytdlp-generic` | `/app/deploy/acceptance/ytdlp-generic` (ro) | The children only. `split-full-path.mjs` and `hls-full-path.mjs` import the product via `../../../src/...`; at their repository-relative position those imports resolve to the **image's** `/app/src`. It is a leaf directory the release image does not contain, so it shadows nothing. |
| the report directory | `/report` (rw) | The children only. Where each child writes its own record. |

The clear-HLS child uses exactly this layout, plus one non-mount addition: the
acceptance-only `--add-host hls-fixture.example.invalid:127.0.0.1` mapping the
pinned yt-dlp subprocess resolves the HLS fixture through, as HLS-08 does. Its
posture is re-derived structurally before launch (`releaseHlsRunPostureViolations`;
see `HLS-09.md`).

The segmented-DASH child (since `-05`) uses exactly this layout with **no**
`--add-host`: its fixture is addressed by loopback IP through an exact-fixture
URL validator, as SPLIT-06's is. Its posture is re-derived structurally before
launch too (`releaseDashRunPostureViolations`), which additionally requires that
the child is told exactly the immutable id it runs as.

The clear-HLS v2 child (since `-06`) uses the clear-HLS child's layout with its
OWN single `--add-host` (`hls11-fixture.example.invalid`, disjoint from
HLS-08's) and, like DASH-01, the identity flags rather than a mode flag
(`releaseHls11RunPostureViolations`).

### The writable surfaces mirror Production

Besides the report directory, the children get two writable surfaces, and
`/tmp` itself stays read-only:

| Target | Mount | Whose |
| :--- | :--- | :--- |
| `/tmp/videofetch` | `--mount type=bind,source=<--media-workspace>,target=/tmp/videofetch` | the **product's** — a caller-supplied, disk-backed host directory. The mount has the same `type=bind` form, the same fields and the same target as the Production unit's `--mount` of its disk workspace; only the source differs. A self-test reads `deploy/systemd/videofetch-worker.service` to enforce that and to confirm the unit declares no `--tmpfs`. |
| `/acceptance-scratch` | `--tmpfs /acceptance-scratch:rw,noexec,nosuid,nodev,size=512m,uid=1000,gid=1000` | the **harness's** — SPLIT-06 keeps fixtures, its temporary database and its object sink under `mkdtemp(tmpdir())`, and `TMPDIR` points here. This is the run's only tmpfs. |

#### The Product media workspace — `--media-workspace`

Since `MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001`, Production binds a bounded,
disk-backed ext4 workspace at `/tmp/videofetch`. A 4 GiB ceiling needs an 8 GiB
successful peak, which the 4 GiB-RAM, swapless VM cannot hold in memory. The
harness therefore never mounts a Product media tmpfs. It binds the host
directory the required `--media-workspace` names, at the same target, in the
same form. The flag has no default.

What the driver enforces (`run-release-image-acceptance.mjs`,
`lib/release-container.mjs`):

- **A clean absolute path.** It is not `/`, has no `.` or `..` segment, and has
  no comma, quote or control character — any of which could smuggle an extra
  mount option.
- **No overlap with the provenance inputs or the evidence.** It must not be, or
  be inside or around, `--context`, `--harness` or `--report`. The comparison is
  component-aware, so `/var/tmp/split07-media` beside `/var/tmp/split07` is
  allowed.
- **Never a Production host path.** It must not be, or be inside or around,
  `/srv/videofetch` (Production's own media workspace), `/var/lib/videofetch` or
  `/etc/videofetch`.
- **An existing, real, empty directory.** A symlink or non-directory is
  refused. Emptiness is checked before any Docker command and again before each
  child — mp4, webm, clear-HLS and segmented DASH.
- **Cleared between children.** After each child the driver removes what it
  left — normally the executor's empty `jobs/` root — and re-proves the
  directory empty. A workspace it cannot clear stops the run instead of letting
  one child's residue stand in for the next.
- **A bind, never a copy of the source or a tmpfs.** It is always bound with
  `--mount`, never `-v`, so a missing source fails instead of being created. The
  finished argv still passes the forbidden-mount guard, so the workspace
  cannot become a source or runtime overlay.

A refusal of any of these exits `2` with no record written.

What the operator must provide, because the driver does not measure it:

- **A directory on disk, not a tmpfs** — the shape Production uses.
- **Writable by the image's uid 1000, and clearable by whoever runs the
  driver.** A bind over `/tmp/videofetch` shadows the node-owned directory the
  image prepares, just as a tmpfs did, so the host directory's ownership is
  load-bearing (`WORKER-TEMP-TMPFS-OWNERSHIP-001`). The driver's own usage note
  suggests `sudo install -d -m 2770 -o 1000 -g 1000 /var/tmp/split07-media` for
  an operator in gid 1000.

A bind carries its host filesystem's mount flags and cannot add `noexec` itself.
Production's workspace is `noexec` on its host mount, and the harness scratch
tmpfs is `noexec`. Nothing in the chain executes a file it wrote, and the pinned
yt-dlp is the zipimport artifact precisely so it never unpacks itself into a
temporary directory.

Keeping `/tmp` read-only matters: a product write to `/tmp` outside
`TEMP_DIRECTORY` fails here exactly as it would in Production. The one ambient
difference from Production is `TMPDIR`, and it is bounded:

- the product never reads it for its own placement (`config.tempDirectory` is
  the image's baked `TEMP_DIRECTORY`);
- yt-dlp receives a sealed environment whose `TMPDIR` is the job's own work
  directory;
- only FFmpeg/ffprobe inherit it — for stream-copy muxing and probing, which
  write to explicit paths.

#### History — the retired tmpfs layout

*Historical. Neither item describes the current harness or the current
Production contract.*

- **The first real SPLIT-07A run used the wrong `/tmp` arrangement.** It put one
  tmpfs on `/tmp`, which hid `/tmp/videofetch` from the product, and **both**
  families failed `PROCESSING_FAILED` before upload. The same image passed with a
  writable root and then with the Production layout of the time. The gate had
  caught a filesystem-layout mistake — not an image defect — which is exactly
  the kind of drift a release gate must not paper over. The harness now refuses a
  `--tmpfs` over any product source or runtime path just as it refuses a bind,
  and a self-test keeps `/tmp` itself unmounted.
- **Until `MAX-FILE-SIZE-4GIB-IMPLEMENTATION-001`, the Product media workspace
  was a 2 GiB tmpfs.** The Production unit mounted
  `/tmp/videofetch:rw,noexec,nosuid,size=2g,uid=1000,gid=1000`, and the harness
  copied that tmpfs byte for byte, enforced by the same kind of unit-reading
  self-test. That layout exposed the ownership issue: a tmpfs over
  `/tmp/videofetch` shadows the node-owned directory the image prepares, so its
  `uid`/`gid` options were load-bearing (`WORKER-TEMP-TMPFS-OWNERSHIP-001`). The
  2 GiB tmpfs is **retired** — in the repository contract, in this harness, and
  (since the 4 GiB rollout, completed 2026-09-17) in Production. Its ownership
  lesson carries over unchanged to the disk bind above.

## How SPLIT-06's flags are satisfied in release mode — without a schema bump

`split-full-path.mjs` refuses to start unless it is told the source commit and
tree, that the context was verified clean, an accepted base source commit, that
the overlay was runtime-compatible, and the base and overlay image identities.
In release mode every one of those is **truthful as stated**:

| SPLIT-06 flag | Release-mode value | Why it is true |
| :--- | :--- | :--- |
| `--source-commit` / `--source-tree` | the observed release commit/tree | observed by the SPLIT-07 driver |
| `--source-context-clean` | set | verified before and after the build |
| `--accepted-base-source` | **the release commit itself** | the image's runtime was built from exactly this commit |
| `--overlay-runtime-compatible` | set | trivially: base source and candidate are one commit, so every runtime-compatibility file is the same object |
| `--base-image` / `--base-digest` | the build **tag** (a human label) / the image id that tag was inspected to name | the image the release build produced |
| `--overlay-image` / `--overlay-image-id` | the immutable **image id** / the same id | what Docker actually executed — no overlay layer, and no tag |

A child cannot introspect Docker; it records what it was told. So the binding
belongs to the parent. `split/children-ran-in-the-candidate-image` requires, for
each child:
- the driver's **own run subject** for that child is the candidate id;
- the child's run image and run id are that id;
- its base label is the build tag whose inspected id it is;
- its source commit is the release commit;
- its network mode is `none`.

Together these positively prove that no overlay, and no retargeted tag, stood in
for the release build.

SPLIT-06's `-04` schema is therefore **not** bumped. Its meaning — the chain, the
fixtures, the checks, what PASS requires — is unchanged; only the caller is new.

## What `--network none` proves, and what it does not

Every candidate container — probes, verifiers, both SPLIT-06 runs, the
clear-HLS run and the segmented-DASH run — gets `--network none`, `--read-only`, `--cap-drop=ALL` and
`--security-opt no-new-privileges`, and never `--privileged`, `--cap-add`, a host
network or the Docker socket.

`--network none` **proves** the run is offline and deterministic: the container
has a loopback interface and nothing else, the SPLIT-06, HLS and DASH fixtures
bind `127.0.0.1` inside that namespace, and no DNS, public address, proxy or host
service is reachable. A PASS therefore cannot depend on anything the machine
happened to be able to reach. The clear-HLS child's one `--add-host` entry only
names the loopback fixture; it adds no route. That child also records the
interfaces it observes and requires loopback only.

It proves **nothing** about the Production egress namespace. That boundary is an
external, host-owned nftables policy the Worker can neither read nor alter, and
a `--network none` container never exercises it. The Phase-9 safe-egress
acceptance owns that claim.

The Docker **build** itself uses ordinary build networking, because the recipe
must fetch its normal pinned inputs (the base image, Debian packages, the npm
graph, and the yt-dlp artifact under `ADD --checksum`). Everything after the
build is offline.

## Why both mp4 and webm must pass

They are the only two container combinations the SPLIT-05 pairing table admits
(`mp4`+`m4a`→`mp4`, `webm`+`webm`→`webm`), and they exercise different demuxers,
muxers and ffprobe stream-shape rules in the rebuilt FFmpeg. A real rebuild can
change a Debian FFmpeg revision, and a change that breaks one family need not
break the other. One family passing is not release-image acceptance: the
record refuses to emit a PASS unless both SPLIT-06 children are present, validated and
passing, and the executed-family list is exactly `mp4` and `webm`.

## Why the clear-HLS child must pass too (since `-03`)

HLS-7 activated clear HLS, so a release image the Worker would run carries a
second media acquisition path that SPLIT-06 never touches: Product-owned
playlist and fragment acquisition (HLS-2/HLS-3) and an MPEG-TS → MP4 stream-copy
remux through the rebuilt FFmpeg and ffprobe (HLS-4). HLS-08 proved that chain
against an overlay of the accepted historical runtime — deliberately not against
a release build. A `-03` PASS therefore also requires the HLS-09 clear-HLS child
(`HLS-09.md`) to PASS on the same immutable image. It is **not** a SPLIT-06
family: it is recorded in its own `hlsAcceptance` block, and `splitAcceptance`
still holds exactly mp4 and webm.

## Why the segmented-DASH child must pass too (since `-05`)

`GENERIC-SEGMENTED-DASH-EXECUTION-001` made `http_dash_segments` executable as a
split half. That artifact is a different SHAPE from anything SPLIT-06 or HLS-09
feed the Worker's FFmpeg: the raw concatenation of a fragmented-MP4 init segment
and its `moof`+`mdat` fragments, written by the pinned native `DashSegmentsFD`
with `--fixup=never`, so no yt-dlp repair has touched it. The unit and
full-path tests fake yt-dlp, FFmpeg and ffprobe; only a real run can show that
this raw artifact is processable by the image's own ffprobe and FFmpeg. A `-05`
PASS therefore also requires the DASH-01 child (`DASH-01.md`) to PASS on the same
immutable image. It has its own `dashAcceptance` block.

## Why the clear-HLS v2 child must pass too (since `-06`)

`HLS-V2-ADAPTIVE-VOD-EXPANSION-001` admits one more clear-HLS shape: a muxed
fMP4 media playlist (one `EXT-X-MAP` initialization map), acquired map-first by
VideoFetch's own HLS-3 into ONE fragmented-MP4 input and stream-copied by HLS-4
through the ISO-BMFF demuxer. HLS-09 covers only the MPEG-TS remux. A `-06`
PASS therefore also requires the HLS-11 child (`HLS-11.md`) to PASS on the same
immutable image: a 1080p MPEG-TS control and a 1080p fMP4 rendition to `ready`
with the durable status measured at every request and process, eight
fail-closed negatives, and the split-master pairing case. It has its own
`hls11Acceptance` block.

## Why the split-merge timing child must pass too (since `-07`)

`SPLIT-MERGE-TIMESTAMP-PRESERVATION-AUDIT-001` confirmed that the split merge
re-based each input to zero on its own, erasing any relative A/V offset the
source carried. The accepted SPLIT-06 and DASH-01 evidence could not see it:
both hashed packet payloads and checked duration to ±0.25 s. The DASH-01
fixture's own 83.3 ms offset was erased in every `-05` and `-06` run.
`SPLIT-MERGE-TIMESTAMP-PRESERVATION-HARDENING-001` replaced the merge's
cross-input timing with a closed policy derived from each half's measured
container start (and, for WebM Opus, its `CodecDelay`). SPLIT-06 `-05` and
DASH-01 `-02` now measure synchronization on their full paths. They cover
three shapes, though. A `-07` PASS therefore also requires the SYNC-01 child
(`SYNC-01.md`) to PASS on the same immutable image: the 19-case timing matrix,
historical identity of every zero-aligned control, and the oracle-sensitivity
control. It has its own `syncAcceptance` block.

## Why the separate-audio clear-HLS child must pass too (since `-08`)

`HLS-SEPARATE-AUDIO-PAIRING-IMPLEMENTATION-001` made one further HLS family
executable: a video-only fMP4 rendition plus the ONE audio-only fMP4 rendition
of the `AUDIO` group its variant names. The pair is proven from a Master
Playlist the Product fetches itself during analysis — the pinned yt-dlp still
exposes no relationship — acquired as two halves under one byte budget, and
merged by the shared split merge with its MP4 synchronization. Its unit and
boundary tests are not real media. A `-08` PASS therefore also requires the
HLS-12 child (`HLS-12.md`) to PASS on the same immutable image, with its own
`hls12Acceptance` block. The HLS-11 child moves to `-02` because the Product
now consults its split master too.

**Since `-09`, the child is HLS-12 `-02`.** The two halves share ONE
acquisition deadline as well as one byte budget, and that invariant is
implemented and unit-tested in source. HLS-12 `-01` never approached a
deadline, so an `-08` PASS — including the first retained `-08` candidate —
does not release-prove it: a candidate that handed the audio half a fresh
budget would have passed `-01`. HLS-12 `-02` adds `neg-deadline`, which fails
that candidate and passes only a shared deadline. Nothing else about the gate
changes: the same seven children, the same thirteen candidate-run purposes, the
same ten harness checkpoints and the same 66 required parent checks. The parent
refuses an HLS-12 `-01` child under `-09` by its required schema, and
`validateHls12ChildRecord` refuses one by its schema and by its eight missing
mandatory checks.

Child order is fixed and tested: characterization → mp4 → clear workspace →
webm → clear workspace → clear-HLS → clear workspace → segmented DASH → clear
workspace → clear-HLS v2 → clear workspace → split-merge timing → clear
workspace → separate-audio clear HLS → clear workspace → final harness
verification → child re-hashing → parent.

## The evidence

**Schema: `split07-release-image-candidate-09`.** SPLIT-07 has its own
identifier, because its record claims something strictly larger and different
in kind than a SPLIT-06 one. Bump it when the record's **meaning** changes;
never rewrite an older record.

| Schema | Status | What a PASS claims |
| :--- | :--- | :--- |
| `-01` | historical | The release source was verified. The image was built by the real recipe and characterized. Both children passed. The harness `HEAD` was **recorded but not verified**. Candidates ran **by tag**. The parent was written after a directory check, not exclusively. It lacks the current harness and immutable-run-subject guarantees. |
| `-02` | valid split-stream release qualification | Everything in `-01`. **Plus:** the executable harness was provenance-bound against explicit expectations and unchanged through the whole run. Every candidate container executed the immutable image id. The record was created exclusively. Requires mp4 + webm; does **not** qualify clear HLS. |
| `-03` | valid HLS-aware release qualification, historical | Everything in `-02`. **Plus:** a validated, byte-hashed HLS-09 clear-HLS child (`hls09-release-image-full-path-01`) PASS, on the same immutable image id, naming the same release source, offline; the harness re-verified before that child and after it; `hls09:clear-hls` in the candidate run ledger; the parent read back after it was written. mp4 + webm + clear-HLS. Valid for exactly the candidates it qualified; never re-read under `-04`. |
| `-04` | historical, never produced | Everything in `-03`, with the clear-HLS child moved to `hls09-release-image-full-path-02`: `GENERIC-SEGMENTED-DASH-EXECUTION-001` restated HLS-7's protocol invariant for the one shared yt-dlp vocabulary, which now carries `http_dash_segments`. It ran no segmented-DASH child, so it proved nothing about real fragmented-DASH media reaching the Worker's FFmpeg. **No `-04` record was ever produced**; the review of PR #102 superseded it with `-05` before any run. |
| `-05` | valid release qualification, historical | Everything in `-04`. **Plus:** a validated, byte-hashed DASH-01 segmented-DASH real-media child (`dash01-release-image-full-path-01`) PASS, on the same immutable image id, naming the same release source, offline; the harness re-verified before that child and after it; `dash01:segmented-dash` in the candidate run ledger. mp4 + webm + clear-HLS + segmented DASH. The pinned DASH downloader contract is still also carried by the two policy verifiers (`verify-download-policy.py` §7, `verify-selector.py` §11). Valid for exactly the candidates it qualified (the image `sha256:db11b5ba…`, Production 2026-09-30 → 2026-10-01, the immediate Worker rollback until 2026-10-02 and now a deeper one); never re-read under `-06`. |
| `-06` | valid release qualification, historical | Everything in `-05`. **Plus:** a validated, byte-hashed HLS-11 clear-HLS v2 real-media child (`hls11-release-image-full-path-01`) PASS, on the same immutable image id, naming the same release source, offline; the harness re-verified before that child and after it; `hls11:clear-hls-v2` in the candidate run ledger. mp4 + webm + clear-HLS + segmented DASH + clear-HLS v2 (fMP4). It qualified `sha256:99ddf3d8…` (retained from merged `main` `88f26318…`; Production 2026-10-01 → 2026-10-02, the immediate Worker rollback until 2026-10-03, and now a deeper one). Its SPLIT-06 (`-04`) and DASH-01 (`-01`) children could not see per-input timestamp zeroing, and that image carries it: valid for exactly what it proved, never re-read under `-07`. |
| `-07` | valid release qualification, historical | Everything in `-06`, with the SPLIT-06 children moved to `split06-deterministic-full-path-05` (control + offset pair, synchronization oracle) and the DASH-01 child to `dash01-release-image-full-path-02` (synchronization oracle, pre-job merge policy). **Plus:** a validated, byte-hashed SYNC-01 split-merge timing child (`sync01-release-image-merge-timing-01`) PASS, on the same immutable image id, naming the same release source, offline; the harness re-verified before that child and after it; `sync01:merge-timing` in the candidate run ledger; 61 required parent checks (`-06`: 56). **First produced 2026-10-02:** it qualified `sha256:2efb85da…`, retained as `videofetch-worker:rc-8ab702002d70-2efb85da9646` from merged `main` `8ab70200…` — parent `e313e03c…`, PASS 62/62 (the 61 required checks plus the conditional accepted-Worker architecture check), with all six children passing on the same immutable id. That image was promoted Worker-only and Production accepted the same day (deployment runbook §4n); it was Production until 2026-10-03 and is now the immediate Worker rollback. Its source has no separate-audio HLS family: valid for exactly what it proved, never re-read under `-08`. |
| `-08` | valid release qualification for what it proved, historical — **not sufficient for promotion** | Everything in `-07`, with the HLS-11 child moved to `hls11-release-image-full-path-02` (its split master now consulted by the Product's own master proof, and refused). **Plus:** a validated, byte-hashed HLS-12 separate-audio clear-HLS real-media child (`hls12-release-image-separate-audio-01`) PASS, on the same immutable image id, naming the same release source, offline; the harness re-verified before that child and after it; `hls12:clear-hls-separate-audio` in the candidate run ledger; 66 required parent checks (`-07`: 61) and seven children. **Produced once:** it qualified `sha256:262f5633…`, retained as `videofetch-worker:rc-b095dfa12f62-262f5633bc38` from merged `main` `b095dfa1…` — parent `3cfe586e…`, PASS 67/67 (the 66 required checks plus the conditional accepted-Worker architecture check), all seven children passing on the same immutable id (deployment runbook §4o). Its HLS-12 `-01` child never approached a deadline, so it does **not** release-prove the separate-audio halves' ONE shared acquisition deadline. That `-08` record is retained as historical evidence and was never the authority for any promotion; never re-read under `-09`. The same bytes were later rebuilt from `34c9567a…` and qualified under `-09` (next row), and that `-09` record, not this one, authorized their promotion. |
| `-09` | current release qualification | Everything in `-08`, with the HLS-12 child moved to `hls12-release-image-separate-audio-02`: its `neg-deadline` case PASSes on the same immutable image (214 mandatory child checks; `-01`: 206). The seven children, the thirteen candidate-run purposes, the ten harness checkpoints and the 66 required parent checks are `-08`'s. **First produced 2026-10-03:** a fresh build from merged `main` `34c9567a…` qualified `sha256:262f5633…`, retained as `videofetch-worker:rc-34c9567abc12-262f5633bc38` — parent `7b0fc743…`, PASS 67/67 (the 66 required checks plus the conditional accepted-Worker architecture check), with all seven children passing on the same immutable id, HLS-12 `-02` 214/214 including all eight `neg-deadline` checks, and all thirteen candidate runs on that id. Because every Worker runtime input was byte-identical to `b095dfa1…`, the build produced the same immutable image as the `-08` candidate: the same runtime bytes under a different qualification generation. This `-09` record was the authority for that image's Worker-only promotion and Production acceptance on 2026-10-03 (deployment runbook §4o). |

`-01` records are **historical**. They are never rewritten, never re-read under
later rules, and never sufficient to authorize SPLIT-07B. They stay useful as
debugging history. `-02` records remain **valid** for exactly what they proved
— split-stream release qualification, mp4 + webm — and are not invalid
globally; they are simply insufficient for clear-HLS release qualification
(HLS-9). A `-02` record is never rewritten as `-03`, and
`validateReleaseParentRecord` names a `-01`..`-08` record as historical rather
than reading it under `-09` rules (an `-08` record as one whose separate-audio
child does not release-prove the shared acquisition deadline). SPLIT-06 children are
`split06-deterministic-full-path-05` since `-07`: a SPLIT-06 PASS now also
means the merge preserved the source's relative A/V timing. `-02`..`-06`
parents' children stay `-04`.

The parent record owns the top level. Each child owns its own record, which
SPLIT-07 never flattens, embeds or rewrites. For each SPLIT-06 child the driver:

1. reads the **exact bytes** from the report directory;
2. requires the exact schema `split06-deterministic-full-path-05`, the exact
   family, verdict `PASS`, a non-empty, all-passing check ledger and (since
   `-07`) every `SPLIT06_MANDATORY_SYNC_CHECKS` entry present exactly once —
   the subprocess exit code alone is never trusted;
3. hashes the bytes (SHA-256);
4. re-reads and re-hashes them immediately before assembling the parent, and
   refuses if they changed;
5. records schema, verdict, digest, byte count, check counts, source identity
   and the image it ran in.

For the clear-HLS child (since `-03`) the driver refuses an evidence path that
already exists before launching it (as it now does for every child: a stale
record is never adopted), and a dedicated validator (`validateHlsChildRecord`)
reads the **exact bytes** and requires: parseable JSON; schema exactly
`hls09-release-image-full-path-02`; verdict `PASS`; every HLS-09 mandatory check
present and every check passing; source commit **and** tree equal to the
release source; candidate image id **and** run image id equal to the parent's
candidate id; the parent's build label; `network.mode` `none`; non-deployable;
and no private HLS material. It hashes those bytes, and re-reads and re-hashes
them immediately before assembling the parent. The parent's `hlsAcceptance`
block records `requiredChildSchema`, `executed`, and the child's schema,
verdict, `ok`, SHA-256, byte and check counts, file name, source commit and
tree, candidate label, candidate and run image ids, network mode and reason —
only grammar-checked values, never the child document.

The segmented-DASH child (since `-05`) is handled identically by
`validateDashChildRecord`: an evidence path refused if it already exists, the
exact bytes read, parsed, hashed and re-hashed before assembly, schema exactly
`dash01-release-image-full-path-02` (since `-07`; `-01` before), verdict `PASS`, every DASH-01 mandatory check
present exactly once and every check passing, the release source commit and
tree, the candidate id as candidate image and run subject, the build label,
`network.mode` `none`, non-deployable, and no private fixture material. The
parent's `dashAcceptance` block records the same grammar-checked fields.

The clear-HLS v2 child (since `-06`) is handled identically by
`validateHls11ChildRecord` against `hls11-release-image-full-path-02` (since
`-08`; `-01` and its 159 checks before) and its 161 mandatory checks; the
parent's `hls11Acceptance` block records the same grammar-checked fields.

The split-merge timing child (since `-07`) is handled identically by
`validateSyncChildRecord` against `sync01-release-image-merge-timing-01` and its
281 mandatory checks; the parent's `syncAcceptance` block records the same
grammar-checked fields.

The separate-audio clear-HLS child (since `-08`) is handled identically by
`validateHls12ChildRecord` against `hls12-release-image-separate-audio-02`
(since `-09`; `-01` and its 206 checks before) and its 214 mandatory checks; the
parent's `hls12Acceptance` block records the same grammar-checked fields.

A PASS parent is refused unless **all** of the following hold:
- every check in `REQUIRED_PASS_CHECKS` is present **and** passing, and no other
  check failed — including `hls/clear-hls-child-executed`,
  `hls/clear-hls-child-passed`, `hls/child-names-the-release-source`,
  `hls/child-ran-in-the-candidate-image`,
  `hls/child-evidence-unchanged-before-assembly` and their five `dash/…`,
  five `hls11/…`, five `sync/…` and five `hls12/…` counterparts;
- both SPLIT-06 children passed as above;
- the clear-HLS child executed and passed as above — missing, failed, of
  another schema, naming another image or another source: **no PASS**;
- the segmented-DASH child executed and passed likewise: **no PASS** otherwise;
- the clear-HLS v2 child executed and passed likewise: **no PASS** otherwise;
- the split-merge timing child executed and passed likewise: **no PASS**
  otherwise;
- the separate-audio clear-HLS child executed and passed likewise: **no PASS**
  otherwise;
- the image id is a full immutable id, and every required candidate container
  — all thirteen — ran it;
- the candidate tag is not deployable.

A FAIL record is still written, so an image failure is always reportable. A
record whose harness was not verified at every checkpoint is not written at
all, PASS or FAIL.

After the exclusive write the driver reads the record **back**: the bytes on
disk must be the bytes written, and the record must validate under the current
schema's rules for this source and image. Otherwise it refuses to claim a
verdict. It prints the parent's SHA-256.

The record is assembled from an allowlist and swept for forbidden keys. It
contains no raw stdout/stderr, no argv, no URL, no upstream format id, no
secret, no credential, no auth header and no query string. Tool versions are the
first banner line only. Environment **names** are recorded; values never are.

Evidence is append-only by path, and the guarantee is **filesystem-level**. The
parent is created with the repository's shared `writeEvidenceExclusive`
(`lib/provenance.mjs`, the Phase-10D writer): `{ encoding: "utf8", flag: "wx" }`,
which either creates the file or fails with `EEXIST`. A path that appears
between any earlier check and the write is therefore **refused, never
truncated**. Losing that race is a refusal, never "adopt the winner": the other
file is not this run's record. The directory pre-flight at the start of the run
remains only as an early, human-friendly diagnostic, so an occupied path fails
before a long run rather than after it. It is not the correctness boundary.

---

## How to run it

Runs where Docker is — on this project, inside the Lima VM, or on an isolated
non-Production Docker host (the PR #102 review qualification ran it on Docker
Desktop on the Mac, never touching the Production VM). The driver is plain
ESM that runs on the guest's Node 18.

```sh
# 1. The RELEASE BUILD CONTEXT: a clean clone fixed to the product commit.
git clone --no-checkout /repo ~/vf-build-<sha12>
git -C ~/vf-build-<sha12> checkout --detach <full release commit>

# 2. The HARNESS: a separate checkout of the branch that carries this file.
git clone --branch <harness branch> /repo ~/vf-split07-harness

# 3. A report directory the container's uid 1000 can write, and the VM user too.
sudo install -d -m 2775 -o 1000 -g 1000 /var/tmp/split07

# 4. The Product media workspace: an EXISTING, EMPTY directory on disk (never a
#    tmpfs), writable by uid 1000 and clearable by the operator, outside the
#    context, the harness and the report directory, and never a Production path.
#    The clear-HLS and segmented-DASH children's Product preflights each need
#    8,589,934,592 bytes available on its filesystem under the default 4 GiB
#    limit; check it first (`df -B1`).
sudo install -d -m 2770 -o 1000 -g 1000 /var/tmp/split07-media

# 5. The run — the driver runs FROM the harness checkout it names.
cd ~/vf-split07-harness
node deploy/acceptance/ytdlp-generic/run-release-image-acceptance.mjs \
  --source          <full 40-hex release commit> \
  --tree            <full 40-hex release tree> \
  --context         ~/vf-build-<sha12> \
  --harness         ~/vf-split07-harness \
  --harness-source  <full 40-hex commit the harness checkout must be at> \
  --harness-tree    <full 40-hex tree of that commit> \
  --report          /var/tmp/split07 \
  --media-workspace /var/tmp/split07-media \
  [--docker <docker command>] [--keep-image]
```

Every flag outside the brackets is required. `--context`, `--harness`,
`--report` and `--media-workspace` must be absolute paths; the shell expands
`~` before the driver sees it.

`--context` and `--harness` are two **provenance roles**, each verified against
its own explicit expectations. The context is what `Dockerfile.worker` builds.
The harness only drives the run and is never part of the image. The record's
`harness` block states, as observations, whether the two roles shared a
checkout or a commit.

Exit status:
- `0` — PASS.
- `1` — a recorded FAIL.
- `2` — a refusal before a verdict could be recorded: a missing or invalid
  argument, release-context or harness provenance, the driver binding, a Product
  media workspace that is missing, not empty or could not be cleared, an invalid
  image id, the build, a harness that changed mid-run, a child evidence path
  that already existed, a clear-HLS, segmented-DASH, clear-HLS v2,
  split-merge timing or separate-audio clear-HLS child argv outside its posture
  model, a
  child record whose bytes changed before assembly, or an occupied, lost or
  unreadable-back evidence path.

## Temporary pre-merge validation vs. the retained candidate

| | SPLIT-07A (pre-merge) | SPLIT-07B (post-merge) |
| :--- | :--- | :--- |
| Release context | the already merged product commit the harness PR is based on | the exact merged `main` that contains this harness |
| Harness | the unmerged SPLIT-07A branch — a **separate** checkout | the same merged commit |
| Purpose | prove the harness against a real build | produce the candidate for staged validation |
| Tag | `videofetch-worker:split07-<sha12>-local-test` | chosen by SPLIT-07B, still never `latest` |
| Image after the run | **removed** | **retained**, by immutable id |
| `image.retainedCandidate` | `false` | — |

SPLIT-07A never produces the deployable candidate. Its image exists only to
prove this harness against the real recipe, and is removed at the end of the
run unless `--keep-image` holds it for diagnosis. Only a `-02` record could
support SPLIT-07B; the earlier `-01` SPLIT-07A PASS records do not.

HLS-9 repeats that split with the `-03` gate — **HLS-9A** proves the HLS-aware
gate from an unmerged harness against a real build of the already merged
`main`, with a temporary, removed candidate; **HLS-9B**, later and separately
authorized, runs the same `-03` gate with merged `main` as both context and
harness and retains the exact accepted immutable candidate. Only a `-03` PASS
can support HLS-9B; a `-02` PASS proves nothing about clear HLS. See
[`HLS-09.md`](HLS-09.md).

## Cleanup expectations

| Artifact | After a run |
| :--- | :--- |
| the candidate image | removed unless `--keep-image` |
| probe, verifier, SPLIT-06, clear-HLS, segmented-DASH, clear-HLS v2, split-merge timing and separate-audio clear-HLS containers | removed (`--rm`) |
| child media in the Product media workspace | removed by the driver after each child, which re-proves the directory empty |
| the `--media-workspace` directory itself | **kept**, empty; the operator removes it |
| child fixtures, temporary databases and object sinks | gone with the containers' harness scratch tmpfs |
| the two SPLIT-06 child records, the clear-HLS, segmented-DASH, clear-HLS v2, split-merge timing and separate-audio clear-HLS child records | **kept**, in the report directory |
| the SPLIT-07 parent record | **kept**, in the report directory |
| `videofetch-worker:latest`, the running Worker | untouched, and measured as such |

---

## Files

| File | Runs on | Purpose |
| :--- | :--- | :--- |
| `run-release-image-acceptance.mjs` | where Docker is | Verifies the release context, builds the real image, characterizes it, runs SPLIT-06 twice, the clear-HLS child once, the segmented-DASH child once, the clear-HLS v2 child once, the split-merge timing child once and the separate-audio clear-HLS child once, writes and reads back the parent record. Admits the required `--media-workspace` empty and clears it after each child. |
| `lib/release-provenance.mjs` | — | The shared clean-worktree gate, applied to the release context and to the harness; the release-input identities; the `/app` source manifest from Git objects. |
| `lib/release-container.mjs` | — | Every `docker` argv. Non-deployable tags for build and cleanup; the immutable-id grammar for every run subject; `dockerRunSubject`'s closed grammar (with `--add-host`); the real Dockerfile; the hardening flags; the Product media workspace `--mount type=bind` (never a Production host path) and the harness scratch tmpfs; the forbidden-mount guard; `releaseHlsAcceptanceRunArgs`, `releaseDashAcceptanceRunArgs`, `releaseHls11AcceptanceRunArgs`, `releaseSyncAcceptanceRunArgs` and `releaseHls12AcceptanceRunArgs` and their structural posture checks. |
| `lib/release-image-probe.mjs` | inside the candidate, at `/verify` | Import-free observer: `/app` manifest, forbidden tools, env names, runtime identity. Observes; never judges. |
| `lib/release-evidence.mjs` | — | The `split07-release-image-candidate-09` record, SPLIT-06, clear-HLS, segmented-DASH, clear-HLS v2, split-merge timing and separate-audio clear-HLS child validation and re-verification, the verified-harness gate, the PASS gate (including the immutable-run-subject ledger), and the read-back validator. |
| `hls-full-path.mjs`, `lib/hls-acceptance-mode.mjs`, `lib/hls-release-evidence.mjs` | inside the candidate / — | The clear-HLS child in `release-image` mode and its `hls09-release-image-full-path-02` record — see `HLS-09.md`. |
| `dash-full-path.mjs`, `lib/dash-argv.mjs`, `lib/dash-evidence.mjs`, `lib/dash-observers.mjs`, `fixtures/dash-media.mjs`, `fixtures/dash-server.mjs` | inside the candidate / — | The segmented-DASH real-media child and its `dash01-release-image-full-path-02` record — see `DASH-01.md`. |
| `hls11-full-path.mjs`, `lib/hls11-evidence.mjs`, `lib/hls11-fixture-url.mjs`, `lib/hls11-observers.mjs`, `fixtures/hls11-media.mjs`, `fixtures/hls11-server.mjs` | inside the candidate / — | The clear-HLS v2 real-media child and its `hls11-release-image-full-path-02` record — see `HLS-11.md`. |
| `sync-matrix.mjs`, `lib/sync-evidence.mjs`, `lib/merge-timing.mjs`, `fixtures/sync-media.mjs` | inside the candidate / — | The split-merge timing child and its `sync01-release-image-merge-timing-01` record — see `SYNC-01.md`. `lib/merge-timing.mjs` is also the SPLIT-06, DASH-01 and HLS-12 oracle. |
| `hls12-full-path.mjs`, `lib/hls12-evidence.mjs`, `lib/hls12-deadline.mjs`, `lib/hls12-fixture-url.mjs`, `lib/hls12-observers.mjs`, `fixtures/hls12-media.mjs`, `fixtures/hls12-server.mjs` | inside the candidate / — | The separate-audio clear-HLS real-media child and its `hls12-release-image-separate-audio-02` record — see `HLS-12.md`. |
| `lib/provenance.mjs` | — | Shared with the Phase-10D harness; SPLIT-07 uses only its `writeEvidenceExclusive`, the `wx` exclusive-create writer. |
| `scripts/ytdlp-release-image-acceptance.test.mjs`, `scripts/ytdlp-dash-acceptance.test.mjs`, `scripts/ytdlp-hls11-acceptance.test.mjs`, `scripts/ytdlp-sync-acceptance.test.mjs`, `scripts/ytdlp-hls12-acceptance.test.mjs` | `npm test` | Harness self-tests against a scripted Git/Docker fake and the DASH-01, HLS-11, SYNC-01 and HLS-12 modules' pure parts. No Docker, no network. |

`container-policy.test.ts` asserts the same image properties against the
Dockerfile **text**; SPLIT-07 asserts them against the **built image**. The two
are complementary: a recipe can say `USER node` and still produce an image
whose config lost it.
