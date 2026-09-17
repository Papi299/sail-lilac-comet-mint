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
> webm — deterministically?

```
release source   (clean Git worktree, exact commit + tree)
acceptance harness (clean Git worktree, exact commit + tree, verified throughout)
  → actual Dockerfile.worker image (immutable image id = every container's run subject)
  → image identity / configuration / runtime / hardening
  → SPLIT-06 mp4 PASS   (split06-deterministic-full-path-04, validated, hashed)
  → SPLIT-06 webm PASS  (split06-deterministic-full-path-04, validated, hashed)
  → SPLIT-07 PASS       (split07-release-image-candidate-02, created exclusively)
```

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
| **Harness** | The executable acceptance harness — driver, SPLIT-06 orchestrator, Python verifiers, image probe, evidence evaluator — was a real Git worktree root at the operator's explicit `--harness-source`/`--harness-tree`, clean in the same ways as the release context, **before any Docker command and at every checkpoint through the end of both children**; and the executing driver file is that checkout's own. |
| **Run subject** | Every candidate container — four probes, two verifiers, two SPLIT-06 children — executed the image's immutable `sha256:` id, as parsed from the argv Docker received. None executed the mutable tag. |
| **Source → image** | Every regular file the recipe places in `/app` (`package.json`, `package-lock.json`, the alias loader and hooks, all of `src/**`) is present in the image with byte-identical content; no unexplained file is present; `src/broker/**` is absent and its removal is accounted for; the acceptance harness is not baked in. |
| **Configuration** | Linux; architecture recorded and compared with the accepted Worker's; `WorkingDir=/app`; runtime user `node`; `CMD` is exactly the standalone Worker entry point, and `ENTRYPOINT` is at most the base image's inherited `docker-entrypoint.sh` exec shim — observed root-owned, unwritable, at its real path, digest recorded; only `8080/tcp` exposed; no `HEALTHCHECK`; no image-declared volume; the expected non-secret defaults present. |
| **Environment** | No `YTDLP_ENABLED`, no retired `YTDLP_NETWORK_ISOLATED`/`YTDLP_PATH`, and no Worker HMAC, Cloudflare Access, R2 broker-parent, legacy R2 writer or Vercel signer name — checked in the image config **and** inside a running container. |
| **Tooling** | No `docker`, `sudo`, `ssh`, `nft`, `iptables`, `curl` or `wget`, looked up on `PATH` **and** in every standard binary directory. A present tool is a failure that names where it was found; it is never normalized away. |
| **Pinned runtime** | `/usr/local/lib/videofetch/yt-dlp` is version `2026.08.19` with SHA-256 `1fa6733c…d8d4d6`, root-owned, mode `0555`, a regular file at its own real path; `/usr/bin/python3` executes it; an **attempted write** by the runtime user is refused by the kernel. |
| **Media tools** | `ffmpeg` and `ffprobe` are present and executable by the runtime user; Node, Python, ffmpeg and ffprobe versions are recorded exactly. |
| **Offline policy** | `verify-selector.py` and `verify-download-policy.py` (which pins PR #54's `--no-quiet` contract) exit 0 against the image's own artifact. |
| **Full path** | The unchanged SPLIT-06 harness PASSes for **mp4 and webm**, executing the candidate image's own `/app/src`, dependency graph, alias loader, Node, Python, yt-dlp, FFmpeg and ffprobe. |
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
supplies the driver, `split-full-path.mjs`, both Python verifiers, the image
probe and the evidence evaluator, and it is mounted into the candidate, so a
locally modified harness could change what is measured or what counts as PASS.
Recording its `HEAD` — all `-01` did — is not provenance.

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
`before-split06-webm` and `after-children`. The last one comes after both
children have executed and before the parent record is assembled. A harness
that changes at any point makes the run's own measurements untrustworthy, so the
driver **refuses the record outright**. That means no parent record, PASS or
FAIL, and the refusal says which checkpoint failed.

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
It then checks that all eight required containers ran the id: the four probes
(manifest, tools, env, runtime), the two verifiers, and SPLIT-06 mp4 and webm.

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
| `deploy/acceptance/ytdlp-generic` | `/app/deploy/acceptance/ytdlp-generic` (ro) | SPLIT-06 only. `split-full-path.mjs` imports the product via `../../../src/...`; at its repository-relative position those imports resolve to the **image's** `/app/src`. It is a leaf directory the release image does not contain, so it shadows nothing. |
| the report directory | `/report` (rw) | SPLIT-06 only. The one writable bind: where the child writes its own record. |

### The writable surfaces mirror Production

Besides the report directory, the SPLIT-06 runs get two writable surfaces, and
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
- **An existing, real, empty directory.** A symlink or non-directory is
  refused. Emptiness is checked before any Docker command and again before each
  family.
- **Cleared between families.** After each family the driver removes what the
  child left — normally the executor's empty `jobs/` root — and re-proves the
  directory empty. A workspace it cannot clear stops the run instead of letting
  one family's residue stand in for the next.
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

Every candidate container — probes, verifiers and both SPLIT-06 runs — gets
`--network none`, `--read-only`, `--cap-drop=ALL` and
`--security-opt no-new-privileges`, and never `--privileged`, `--cap-add`, a host
network or the Docker socket.

`--network none` **proves** the run is offline and deterministic: the container
has a loopback interface and nothing else, the SPLIT-06 fixture binds
`127.0.0.1` inside that namespace, and no DNS, public address, proxy or host
service is reachable. A PASS therefore cannot depend on anything the machine
happened to be able to reach.

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
record refuses to emit a PASS unless both children are present, validated and
passing, and the executed-family list is exactly `mp4` and `webm`.

## The evidence

**Schema: `split07-release-image-candidate-02`.** SPLIT-07 has its own
identifier, because its record claims something strictly larger and different
in kind than a SPLIT-06 one. Bump it when the record's **meaning** changes;
never rewrite an older record.

| Schema | What a PASS claims |
| :--- | :--- |
| `-01` | The release source was verified. The image was built by the real recipe and characterized. Both children passed. The harness `HEAD` was **recorded but not verified**. Candidates ran **by tag**. The parent was written after a directory check, not exclusively. |
| `-02` | Everything in `-01`. **Plus:** the executable harness was provenance-bound against explicit expectations and unchanged through the whole run. Every candidate container executed the immutable image id. The record was created exclusively. |

`-01` records are **historical**. They are never rewritten, never re-read under
`-02` rules, and never sufficient to authorize SPLIT-07B. They stay useful as
debugging history. SPLIT-06 children remain `split06-deterministic-full-path-04`:
nothing about what a SPLIT-06 PASS means changed.

The parent record owns the top level. Each SPLIT-06 child owns its own record,
which SPLIT-07 never flattens or rewrites. For each child the driver:

1. reads the **exact bytes** from the report directory;
2. requires the exact schema `split06-deterministic-full-path-04`, the exact
   family, verdict `PASS`, and a non-empty, all-passing check ledger — the
   subprocess exit code alone is never trusted;
3. hashes the bytes (SHA-256);
4. re-reads and re-hashes them immediately before assembling the parent, and
   refuses if they changed;
5. records schema, verdict, digest, byte count, check counts, source identity
   and the image it ran in.

A PASS parent is refused unless **all** of the following hold:
- every check in `REQUIRED_PASS_CHECKS` is present **and** passing, and no other
  check failed;
- both children passed as above;
- the image id is a full immutable id, and every required candidate container
  ran it;
- the candidate tag is not deployable.

A FAIL record is still written, so an image failure is always reportable. A
record whose harness was not verified before **and** after the run is not
written at all, PASS or FAIL.

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

Runs where Docker is — on this project, inside the Lima VM. The driver is plain
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
#    context, the harness and the report directory.
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
  image id, the build, a harness that changed mid-run, or an occupied or lost
  evidence path.

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
run unless `--keep-image` holds it for diagnosis. Only a `-02` record can
support SPLIT-07B; the earlier `-01` SPLIT-07A PASS records do not.

## Cleanup expectations

| Artifact | After a run |
| :--- | :--- |
| the candidate image | removed unless `--keep-image` |
| probe, verifier and SPLIT-06 containers | removed (`--rm`) |
| SPLIT-06 media in the Product media workspace | removed by the driver after each family, which re-proves the directory empty |
| the `--media-workspace` directory itself | **kept**, empty; the operator removes it |
| SPLIT-06 fixtures, temporary database and object sink | gone with the containers' harness scratch tmpfs |
| the two SPLIT-06 child records | **kept**, in the report directory |
| the SPLIT-07 parent record | **kept**, in the report directory |
| `videofetch-worker:latest`, the running Worker | untouched, and measured as such |

---

## Files

| File | Runs on | Purpose |
| :--- | :--- | :--- |
| `run-release-image-acceptance.mjs` | where Docker is | Verifies the release context, builds the real image, characterizes it, runs SPLIT-06 twice, writes the parent record. Admits the required `--media-workspace` empty and clears it after each family. |
| `lib/release-provenance.mjs` | — | The shared clean-worktree gate, applied to the release context and to the harness; the release-input identities; the `/app` source manifest from Git objects. |
| `lib/release-container.mjs` | — | Every `docker` argv. Non-deployable tags for build and cleanup; the immutable-id grammar for every run subject; `dockerRunSubject`; the real Dockerfile; the hardening flags; the Product media workspace `--mount type=bind` and the harness scratch tmpfs; the forbidden-mount guard. |
| `lib/release-image-probe.mjs` | inside the candidate, at `/verify` | Import-free observer: `/app` manifest, forbidden tools, env names, runtime identity. Observes; never judges. |
| `lib/release-evidence.mjs` | — | The `split07-release-image-candidate-02` record, child validation and re-verification, the verified-harness gate, and the PASS gate (including the immutable-run-subject ledger). |
| `lib/provenance.mjs` | — | Shared with the Phase-10D harness; SPLIT-07 uses only its `writeEvidenceExclusive`, the `wx` exclusive-create writer. |
| `scripts/ytdlp-release-image-acceptance.test.mjs` | `npm test` | Harness self-tests against a scripted Git/Docker fake. No Docker, no network. |

`container-policy.test.ts` asserts the same image properties against the
Dockerfile **text**; SPLIT-07 asserts them against the **built image**. The two
are complementary: a recipe can say `USER node` and still produce an image
whose config lost it.
