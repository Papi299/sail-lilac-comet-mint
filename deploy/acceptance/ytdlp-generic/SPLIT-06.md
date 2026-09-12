# SPLIT-06 — the deterministic split-stream full-path acceptance harness

**Test tooling only.** Nothing here runs during Worker startup, no systemd unit
references any of it, and none of it is part of the Worker image's runtime path.

SPLIT-06 adds no product capability. It exists to prove, deterministically and
offline, that the split-stream chain SPLIT-01…SPLIT-05 built actually executes
end to end against the exact accepted media runtime.

```
analysis -> split-backed public preset -> fresh execution analysis
-> merge-split plan -> video acquisition -> audio acquisition
-> beginProcessing() -> ffprobe input validation -> FFmpeg stream-copy merge
-> ffprobe output validation -> beginUploading() -> object upload -> ready
```

---

## What one PASS proves

Against deterministic local fixtures and the exact accepted media runtime, the
**current source** executed the real split application chain from analysis
through durable `ready`, using:

| Piece | Real? |
| :--- | :--- |
| generic candidate selection, SPLIT-05 pairing, preset construction | real |
| private preset selection and `deriveGenericExecutionPlan` | real |
| `JobExecutor`, including its own fresh execution analysis | real |
| `SQLiteJobStore` on a real temporary database, real transitions | real |
| `downloadGenericSplitSources` (SPLIT-03) | real |
| the pinned yt-dlp 2026.08.19 executable | real |
| `probeLocalMedia` and `/usr/bin/ffprobe` | real |
| `mergeSplitMedia` and `/usr/bin/ffmpeg` | real |
| `validateLocalOutput`, `beginUploading`, `finalizeJobUpload` | real |
| the object-storage **provider** | **substituted** |
| the submitted-URL **validator** | **substituted** |

## What one PASS does NOT prove

SPLIT-06 says nothing at all about:

- **Cloudflare** — no tunnel, no DNS, no edge;
- **the R2 broker** — no credential is minted, held or used;
- **Vercel** — the control plane is never contacted;
- **the Production egress namespace** — no nftables policy is exercised;
- **public YouTube compatibility** — no live public source is contacted.

Each of those has its own acceptance stage. A SPLIT-06 PASS is **not**
"Production split downloads work", and must never be reported as such.

---

## How to run it

Both commands run where Docker is — on this project that is inside the Lima VM,
not on the Mac.

```sh
# MP4 (mandatory)
sudo node /repo/deploy/acceptance/ytdlp-generic/run-split-acceptance.mjs \
  --base-image  videofetch-worker:<accepted source sha> \
  --base-digest sha256:<accepted image id> \
  --base-source <accepted image's full 40-hex source commit> \
  --head        <full 40-hex candidate commit> \
  --tree        <full 40-hex candidate tree> \
  --context     /repo \
  --report      /var/tmp/split06 \
  --family      mp4

# WebM (same chain, different closed-table row)
... --family webm
```

The driver first verifies the build context (below), before any Docker command
runs. It then verifies the accepted base image resolves to the exact expected
digest, builds the overlay, re-verifies the context, runs the acceptance
container, and removes the overlay again unless `--keep-image` is passed.

Inside the container the single command is:

```sh
node --import ./scripts/register-ts-aliases.mjs --experimental-strip-types \
  deploy/acceptance/ytdlp-generic/split-full-path.mjs --family mp4 --evidence /report/x.json
```

There is no partial PASS: every stage of the chain, plus byte integrity, stream
shape, packet identity, privacy and cleanup, must succeed in **one** run.

### Source provenance: what the driver checks before it builds

`--head`, `--tree` and `--base-source` are **expectations**, and each must be a
full lowercase 40-hex SHA. Before any Docker command runs,
`lib/split-provenance.mjs` checks them against Git in `--context` and refuses,
fail-closed and with no image inspected, built or run, unless:

| Gate | Requirement |
| :--- | :--- |
| A | `git rev-parse HEAD` is exactly `--head` |
| B | that commit's tree is exactly `--tree` |
| C | the context is clean: no tracked change and no untracked file anywhere (`git status --porcelain=v1 --untracked-files=all`), no ignored file inside the copied `src/` and `deploy/acceptance/ytdlp-generic/`, and no assume-unchanged or skip-worktree entry there |
| D | `--base-source` exists as a commit (`git cat-file -e <sha>^{commit}`) |
| E | `package.json`, `package-lock.json`, `Dockerfile.worker`, `src/worker/runtime/ytdlp-runtime.server.ts`, `scripts/register-ts-aliases.mjs` and `scripts/ts-alias-hooks.mjs` are the same Git object at `--base-source` and at the candidate |

Gate E is the premise that makes an overlay of the accepted image equivalent to
a build of the candidate. If any of those files differs, the overlay strategy
does not apply and the driver stops; it never falls back to building an image.

The same gates run again after `docker build` has read the context, so a
context that changed underneath the build is refused and its overlay removed.
The values handed to the container, and so recorded in the evidence, are what
Git **observed**, never the command-line text.

---

## The two deliberate substitutions

### 1. The exact-fixture URL validator (`lib/split-fixture-url.mjs`)

Production's `assertSafeUrl` correctly **refuses** loopback and private
destinations, and SPLIT-06 does not weaken it, patch it or route around it in
Production code. The harness injects a replacement into the analysis and
acquisition modules' existing `validateUrl` test seam, because the whole point
of the run is that its media comes from a service inside a `--network none`
container — which means loopback, which is exactly what the production policy
exists to reject.

The replacement is built from the running service's own ephemeral port and
declared route table, so it admits a handful of exact strings that did not exist
before the process started listening:

```
scheme    exactly http:            (no https, no file:, no data:)
hostname  exactly 127.0.0.1        (never localhost, never ::1)
port      exactly the bound port
path      exactly one declared fixture route
          no userinfo, no query, no fragment
```

**SPLIT-06 therefore proves nothing about SSRF policy.** That policy has its own
independent coverage and must never be cited from here.

### 2. The local `ObjectStoreWriter` (`lib/local-object-writer.mjs`)

Cloudflare R2 is replaced by a deterministic local sink. Everything on the
Worker's side of that boundary stays real and is exercised rather than bypassed:
`beginUploading()`, the upload body stream, the content length, the object key,
the MIME, the content disposition, `finalizeJobUpload`'s put → head → compare →
commit sequence, and the `ready` transition. The writer parses
`ObjectStorePutInputSchema` itself, has no list operation, no wildcard delete and
no presigned URL.

Its `head` reports the **persisted object's measured length** — `lstat` of the
stored file at HEAD time — as R2's `HeadObject` reports what R2 stores rather
than echoing the PUT. `declaredLength` and `observedBytes` are recorded apart,
and HEAD never answers with the caller's declaration, so a provider that stored
different bytes is refused by the real `finalizeJobUpload` comparison itself.

**A SPLIT-06 PASS is not R2 acceptance.**

---

## Why `--network none` matters

The acceptance container is started with the network disabled, leaving it a
loopback interface and nothing else. The fixture service binds `127.0.0.1`
inside that namespace. Consequently:

- no DNS lookup is possible, so no name can silently resolve somewhere;
- no public address, proxy or VPN can participate;
- no host service is reachable from inside the run;
- every media byte demonstrably came from a fixture this run generated.

`--network none` is produced by `lib/split-container.mjs` and pinned by its own
test, so a run that lost the flag fails the harness suite rather than quietly
running against whatever the machine can reach.

---

## How the fixture is discovered — and why no adapter was needed

The pinned `_parse_html5_media_entries` cannot express a split pair: it builds
each plain-media format as `{'url': …, 'vcodec': 'none' if media_type ==
'audio' else None}` and then runs `f.update(formats[0])`, which overwrites the
codecs parsed from the `<source type="…; codecs=…">` attribute. Inside a
`<video>` element every format therefore carries `vcodec: null` — never *proven*
video-absent — and a page with both a `<video>` and an `<audio>` element returns
two entries, which the single-item contract refuses.

`_parse_mpd_periods` has no such clobber. So the fixture serves a tiny **DASH
manifest** whose two Representations carry only a `<BaseURL>`: that takes the
"assuming direct URL to unfragmented media" branch, leaving `protocol` unset,
which `determine_protocol` resolves to the URL's own `http` scheme — an ordinary
progressive source acquired by the native downloader, never
`http_dash_segments`.

Verified against yt-dlp 2026.08.19 in the accepted image, one `GET` of the
manifest yields `_type: "video"`, no `entries`, and exactly two formats:

```
video : ext mp4  protocol http  vcodec avc1.42E01E  acodec "none"
audio : ext m4a  protocol http  vcodec "none"       acodec mp4a.40.2
```

which is precisely the shape SPLIT-05 pairs. **No `--load-info-json` harness
adapter is used, and none exists in this harness.** Nothing about the product
was relaxed to make the fixture work; the fixture conforms to the product.

---

## Evidence

Every run writes one machine-readable record, schema
`split06-deterministic-full-path-02` (`lib/split-evidence.mjs`), to the
`--evidence` path. Following the harness's existing rule, that path must be
**present and unoccupied**: an existing artifact is refused, never replaced.

`-02` changed what `source` means. A `-01` record carried whatever commit and
tree its caller asserted; a `-02` record carries the driver's **verified
observation** — `commit`, `tree`, `contextClean: true`,
`acceptedBaseSourceCommit`, `overlayRuntimeCompatibilityVerified: true` and the
files compared — and the builder refuses to emit one without it. `-01` records
are historical artifacts of the pre-correction harness and are never rewritten.

The record is assembled from an allowlist and refuses to be written if it would
carry a forbidden field (`stderr`, `argv`, anything credential-shaped) or a raw
upstream source identifier — the synthetic ids appear in the analysis selection
and the execution plan and **nowhere else**, which is itself one of the checks.

Runtime evidence is **not committed**. It is written to a task-owned report
directory (`/var/tmp/split06` by convention) and its path and digest are quoted
in the task report. This matches the existing convention: no acceptance record
is tracked in this repository.

---

## Cleanup expectations

| Thing | After a run |
| :--- | :--- |
| the Worker's per-job `workDir` | removed by the executor's own `finally` |
| the temporary SQLite database | removed by the orchestrator |
| the generated fixture halves | removed with the orchestrator's temp root |
| the acceptance container | `--rm`; nothing persists |
| the overlay image | removed unless `--keep-image` |
| the uploaded object copy | **kept**, in the harness sink — it belongs to the sink, not the workDir, which is how "cleanup happened *after* upload" is observable |

Nothing in a run touches a Production container, a systemd unit,
`/etc/videofetch/worker.env`, Production SQLite state, R2, Cloudflare, Vercel,
DNS or nftables, and no Production credential is read.

---

## Files

| File | Runs on | Purpose |
| :--- | :--- | :--- |
| `run-split-acceptance.mjs` | where Docker is | Verifies the build context's provenance and the accepted base, builds the non-deployable overlay, runs the container. |
| `split-full-path.mjs` | inside the acceptance container | The orchestrator. Preflight, fixtures, full path, negatives, characterizations, evidence. |
| `lib/split-container.mjs` | — | The overlay Dockerfile and every `docker` argv. Pure; owns `--network none`. |
| `lib/split-provenance.mjs` | — | The source-provenance gate: exact commit and tree, clean context, overlay runtime compatibility. |
| `lib/split-fixture-url.mjs` | — | The exact-fixture URL validator. Test-only, and narrow by construction. |
| `lib/local-object-writer.mjs` | — | The deterministic local `ObjectStoreWriter`. |
| `lib/split-observers.mjs` | — | Spawn ledger, `/proc` media-tool sampler, SQLite status-audit trigger. |
| `lib/split-evidence.mjs` | — | The `split06-…-02` record, its verified-provenance gate and its privacy refusals. |
| `fixtures/split-media.mjs` | — | The four bit-exact fixture recipes and the DASH manifests. |
| `fixtures/server.mjs` | loopback only | Extended with the optional, closed SPLIT-06 route set. |
| `scripts/ytdlp-split-acceptance.test.mjs` | `npm test` | Harness self-tests. No Docker, no FFmpeg, no network. |
