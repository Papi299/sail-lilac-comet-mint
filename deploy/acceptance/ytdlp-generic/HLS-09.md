# HLS-09 — clear-HLS release-image qualification

**Test tooling only.** Nothing here runs during Worker startup, no systemd unit
references it, and none of it ships in the Worker image. HLS-09 adds no Product
capability, changes no Product source, and deploys nothing.

HLS-09 answers the one question HLS-08 deliberately leaves open:

> Does the image the repository's **real** `Dockerfile.worker` builds from a
> reviewed commit execute the activated clear-HLS chain correctly — with its
> own `/app` source, Node, dependencies, Python, yt-dlp, FFmpeg and ffprobe?

It is not a new framework. It extends the existing SPLIT-07 release-image gate
(`SPLIT-07.md`) with a third child, next to SPLIT-06 mp4 and webm:

```
verified clean release source
  → real Dockerfile.worker build → immutable candidate image id
  → image / config / runtime / hardening qualification, policy verifiers
  → SPLIT-06 mp4 child     (split06-deterministic-full-path-04)
  → SPLIT-06 webm child    (split06-deterministic-full-path-04)
  → HLS-09 clear-HLS child (hls09-release-image-full-path-01)   ← new
  → ONE HLS-aware SPLIT-07 parent PASS (split07-release-image-candidate-03)
```

Every candidate container — the clear-HLS child included — executes the same
immutable `sha256:` image id. The tag is a build and diagnostic label only.

---

## Why HLS-08's `-02` record cannot be reused

`hls08-deterministic-full-path-02` is **overlay** evidence. It asserts that the
accepted historical base source is `593f47df…`, that the accepted historical
base digest is `sha256:5925515f…`, and that the overlay image differs from that
base. Every one of those statements is false for a freshly built release
candidate: there is no historical base and no overlay. Filling them in to reuse
the schema would make the record lie, so HLS-09 has its own schema. HLS-08
`-02` remains accepted historical deterministic source/runtime evidence exactly
as merged, and is neither reinterpreted nor weakened.

## One behavioral run, two explicit modes

The orchestrator `hls-full-path.mjs` is not forked. It takes a required
`--acceptance-mode` (`lib/hls-acceptance-mode.mjs`):

| Mode | Launched by | Identity | Record |
| :--- | :--- | :--- | :--- |
| `overlay` | `run-hls-acceptance.mjs` (HLS-08) | source commit/tree, accepted historical base source and digest, overlay image | `hls08-deterministic-full-path-02`, unchanged |
| `release-image` | `run-release-image-acceptance.mjs` (SPLIT-07) | source commit/tree, the parent's source-context-clean assertion, candidate build label, candidate immutable image id, the run subject Docker executed | `hls09-release-image-full-path-01` |

- The mode is **explicit** and given exactly once. It is never inferred from
  which identity flags happen to be present: release identity flags alone do not
  select release mode.
- **Mixed identity fails closed.** An overlay flag in release mode, or a release
  flag in overlay mode, is a refusal before anything runs.
- Only identity and the record differ. Everything else is **one implementation**
  in both modes: real generic analysis, the real pinned yt-dlp discovery, the
  ordinary HLS-backed presets, the fresh execution analysis, the ordinary
  `deriveExecutionPlan()`, HLS-2, HLS-3, `beginProcessing()`, HLS-4, the upload
  lifecycle, `ready`, and the three bounded negatives.

The HLS-08 overlay invocation now passes `--acceptance-mode overlay`
explicitly, and still emits `-02` with the same meaning and the same mandatory
checks (`HLS08_MANDATORY_CHECKS` is unchanged, in content and order).

## The release child's identity

The child cannot introspect Docker. The SPLIT-07 parent is the authority that
the image was built from the verified source and that Docker executed the
immutable id; it hands the child its **observations**
(`lib/release-container.mjs`, `releaseHlsAcceptanceRunArgs`):

```
--acceptance-mode release-image
--source-commit <release commit>  --source-tree <release tree>  --source-context-clean
--candidate-tag videofetch-worker:split07-<source12>-local-test
--candidate-image-id <sha256:…>   --run-image-id <the same sha256:…>
```

`--run-image-id` is the id the same argv hands Docker as its run subject. The
child records all of it and re-derives six release identity checks, which
replace HLS-08's four overlay identity checks one-for-one in meaning:

| Check | Requires |
| :--- | :--- |
| `release/source-identity-present` | full 40-hex source commit and tree |
| `release/source-context-clean` | the parent asserted the context clean |
| `release/candidate-image-id-valid` | `sha256:<64 lowercase hex>` |
| `release/run-subject-is-candidate-image-id` | run image id is valid and equals the candidate id |
| `release/candidate-label-is-non-production` | the label is exactly `candidateImageTag(<source commit>)` — never `latest`, an RC, or another commit's tag |
| `release/network-namespace-is-loopback-only` | the child **observes** only `lo` — "offline" is measured, not asserted |

There is no historical-base or overlay assertion in release mode.

## The release child's record — `hls09-release-image-full-path-01`

`lib/hls-release-evidence.mjs`. An allowlisted release identity followed by
exactly HLS-08's behavioral blocks:

- `schema`, `verdict` (`PASS` requires every check), timestamps;
- `source`: `commit`, `tree`, `contextClean: true`;
- `image`: `candidateTag`, `imageId`, `runSubject`, `builtFromDockerfile`,
  `deployable: false`, and a statement that the parent is the identity
  authority;
- `network`: `mode: "none"`, the observed interface names, the fixture bind and
  port, one acceptance host mapping, zero public hosts contacted;
- the same three `substitutions` as HLS-08, and HLS-09's own `nonClaims`;
- toolchain, invariants, fixture, discovery, public analysis, fresh execution
  analysis, fresh provenance, plan, workspace, HLS-2, HLS-3, aggregate identity,
  lifecycle, media subprocesses, remux, output, upload, ready state, fixture
  requests, privacy, cleanup, negative cases, checks.

**No partial PASS.** A PASS requires every name in `HLS09_MANDATORY_CHECKS` —
the six release identity checks plus **every** behavioral check HLS-08 requires
(`HLS_BEHAVIORAL_MANDATORY_CHECKS`) — recorded exactly once and passing, and
every other recorded check passing too.

**Privacy is exactly as strict as HLS-08 `-02`.** The behavioral privacy checks
are the same field-aware placement checks (`validateStructuredPrivacy`,
`validateDurablePrivacy`, `scanRawPrivacyNeedles`), and the record builder
refuses — PASS or FAIL — the fixture hostname, any URL, any private HLS marker,
the raw upstream HLS id, `sig=`, any `/tmp/` path, any `.m3u8` name and every
forbidden raw-material key. There is no serialized-text hostname heuristic.

## How it runs inside the release candidate

The same container shape as the SPLIT-06 release children, plus the one
acceptance host mapping HLS-08 uses:

```
docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges --read-only
  --add-host hls-fixture.example.invalid:127.0.0.1
  --mount type=bind,source=<media-workspace>,target=/tmp/videofetch
  --tmpfs /acceptance-scratch:rw,noexec,nosuid,nodev,size=512m,uid=1000,gid=1000
  -e TMPDIR=/acceptance-scratch
  -v <harness>/deploy/acceptance/ytdlp-generic:/app/deploy/acceptance/ytdlp-generic:ro
  -v <report>:/report
  -w /app --entrypoint /usr/local/bin/node <sha256:candidate id>
  --import ./scripts/register-ts-aliases.mjs --experimental-strip-types
  deploy/acceptance/ytdlp-generic/hls-full-path.mjs --acceptance-mode release-image …
```

- **Product media** lives on the host-supplied, disk-backed workspace bound at
  `/tmp/videofetch`, exactly as Production binds its workspace. No Product media
  tmpfs, no Production workspace (`/srv/videofetch/…` is refused structurally),
  no fake capacity reader, no lowered `MAX_FILE_SIZE`. Under the default 4 GiB
  limit the HLS job needs `8,589,934,592` bytes, and the Product's own `statfs`
  preflight must admit it. A workspace filesystem without that capacity is
  **BLOCKED**, never faked: the child records verdict `BLOCKED` with the reason,
  and the parent — which only ever records PASS or FAIL — records a FAIL whose
  `hlsAcceptance.child.reason` names the `BLOCKED` verdict. Classify such a run
  as BLOCKED, not as a candidate defect. Check `df -B1` on the workspace first.
- **Harness scratch** — fixture, temporary database, local object sink — lives
  on the separate `/acceptance-scratch` tmpfs via `TMPDIR`. The run's workspace
  diagnostic measures the Product's temp directory (the filesystem the job's
  work directory lives on), never `TMPDIR`.
- **Product imports** resolve to the image's own `/app/src`: the harness is
  mounted read-only at its repository-relative path, and nothing is mounted over
  `/app/src`, `/app/scripts`, `/app/package*.json`, `/app/node_modules`,
  `/usr/local/lib/videofetch`, `/usr/local/bin/node`, `/usr/bin/python3`,
  `/usr/bin/ffmpeg` or `/usr/bin/ffprobe` (the existing forbidden-mount guard).
- `releaseHlsRunPostureViolations` re-derives the posture **structurally** from
  the argv the driver is about to execute and refuses: a network other than
  `none`, a missing, second or retargeted `--add-host`, a missing read-only root,
  capability drop or `no-new-privileges`, anything but exactly one media bind,
  one scratch tmpfs, one environment entry, one read-only harness mount and one
  report mount, a tag as the run subject, a mount over Product source or runtime,
  the Docker or broker socket, `worker.env`, a credential environment,
  `--privileged`, `--user`, and any Production or credential path. The driver
  refuses to launch on any violation.

## What the parent does with the child

`run-release-image-acceptance.mjs`, after SPLIT-06 webm:

1. re-verifies the harness (`before-hls09-clear-hls`) and requires the Product
   media workspace to be empty;
2. refuses an evidence path that already exists (never adopt a stale record);
3. builds the argv, re-checks its posture, and runs it by the immutable id,
   recording `hls09:clear-hls` in the candidate run ledger;
4. validates the child from its **exact bytes** (`validateHlsChildRecord`):
   parseable JSON, schema exactly `hls09-release-image-full-path-01`, verdict
   `PASS`, every mandatory check present and every check passing, source commit
   and tree equal to the release source, candidate image id and run image id
   equal to the parent's candidate id, the parent's build label, `network.mode`
   `none`, non-deployable, no private material — and hashes those bytes;
5. clears the Product media workspace and re-proves it empty;
6. after the harness `after-children` verification, re-reads and re-hashes the
   child and refuses the parent if the bytes changed.

Only grammar-checked values from the child are echoed into the parent; the
child document itself is never embedded. See `SPLIT-07.md` for the `-03` parent.

## Safe-HTTP substitution is unchanged

The release child uses the HLS-08 deterministic fixture model exactly. The
accepted substitution is still:

```
real Product safe-HTTP policy + acceptance synthetic public DNS answer + loopback socket transport
```

A real release image as the subject does **not** widen that claim.

## What one PASS does NOT prove

- Production safe-egress / nftables, Production DNS, Production address pinning.
- Real Cloudflare Tunnel/Access, the real R2 broker, Cloudflare R2, Vercel.
- Real public HLS source compatibility, real CDN behaviour, real signed-URL lifetimes.
- Production startup of this candidate, promotion (HLS-10), or long-term uptime.

It proves that the **actual release image** executes the deterministic
clear-HLS chain offline.

## Schema history

| Schema | Status | Meaning |
| :--- | :--- | :--- |
| `hls08-deterministic-full-path-01` | historical, **not accepted** | First HLS-08 record; its hostname placement check was too permissive. |
| `hls08-deterministic-full-path-02` | **accepted** | Overlay / source-runtime deterministic HLS evidence (PR #78 head `6296b0db…`, tree `677c5a24…`, PASS 144/144). Unchanged. |
| `hls09-release-image-full-path-01` | current | The same clear-HLS full path and negatives, executed by a real `Dockerfile.worker` release candidate, with release identity. |

These scopes are not interchangeable: an overlay PASS is not release-image
evidence, and a release child is never read as overlay evidence. HLS-8 remains a
prerequisite; HLS-09 answers the additional release-image question.

## HLS-9A vs HLS-9B

| | HLS-9A (pre-merge) | HLS-9B (post-merge, later) |
| :--- | :--- | :--- |
| Release context | the already merged `main` the harness PR is based on | the exact merged `main` that contains this harness |
| Harness | the unmerged HLS-9 branch, exact head, a separate checkout | the same merged `main` |
| Purpose | prove the HLS-aware release gate against a real image | produce and qualify the candidate that may advance toward HLS-10 |
| Candidate | `videofetch-worker:split07-<source12>-local-test`, **removed** after the run (no `--keep-image`) | retained by immutable id, with an RC identity, only under a separate explicit authorization |
| `latest` | untouched, measured | untouched, measured |

HLS-9A never produces a deployable or retained candidate.

## Files

| File | Purpose |
| :--- | :--- |
| `hls-full-path.mjs` | The one clear-HLS orchestrator, in either mode. |
| `lib/hls-acceptance-mode.mjs` | The explicit mode boundary: argv parsing (mixed identity fails closed), per-mode identity checks, per-mode record. |
| `lib/hls-release-evidence.mjs` | The `hls09-release-image-full-path-01` record, its PASS gate and privacy gates, and the parent-side record validator. |
| `lib/hls-evidence.mjs` | HLS-08's record, unchanged in meaning; exports the shared behavioral check list. |
| `lib/release-container.mjs` | `releaseHlsAcceptanceRunArgs` and `releaseHlsRunPostureViolations`; `--add-host` in the closed run-subject grammar. |
| `lib/release-evidence.mjs` | The `-03` parent: `hlsAcceptance`, `validateHlsChildRecord`, the HLS run purpose, the PASS gate. |
| `run-release-image-acceptance.mjs` | Runs the clear-HLS child third, validates and re-hashes it, writes and reads back the `-03` parent. |

Self-tests (no Docker, no network): `scripts/ytdlp-hls-acceptance.test.mjs`
(modes, identity, release record) and
`scripts/ytdlp-release-image-acceptance.test.mjs` (container model, posture,
child validation, `-03` gates, driver).
