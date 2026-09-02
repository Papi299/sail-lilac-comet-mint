# Generic yt-dlp acceptance — offline verifiers + Production harness

**Test tooling only.** Nothing here runs during Worker startup, no systemd unit
references any of it, and none of it is part of the Worker image's runtime path.

> ### Status
>
> ```
> harness exists:            YES
> live generic acceptance:   NO
> Production deployment:     NO
> Production enablement:     NO
> ```
>
> `PHASE-10C4-YTDLP-PRODUCTION-ACCEPTANCE-HARNESS-001` wrote this harness and
> **did not execute it against Production**. It did not start the Lima VM,
> build or install a Worker image, set `YTDLP_ENABLED`, contact a public media
> site, or touch Cloudflare, R2 or Vercel.
>
> The live procedure below is a **specification for the later task**
> `PHASE-10D-YTDLP-PRODUCTION-STAGED-DEPLOYMENT-AND-LIVE-ACCEPTANCE-001`.
> Nothing in this file records a test that has passed.

---

## Two different kinds of evidence

These are not interchangeable, and the harness never labels one as the other.

| | Offline / static | Live Production acceptance |
| :--- | :--- | :--- |
| **Files** | `verify-selector.py`, `verify-download-policy.py` | `acceptance.mjs` + `lib/` |
| **Proves** | pinned-runtime *semantics* | the behaviour of the *deployed system* |
| **Needs** | the image, `--network none` | a real deployment, a real job, real bytes |
| **Run by** | anyone, any time | Phase 10D, under a double opt-in |
| **Status** | executed and green | **NOT EXECUTED** |

A green offline run is **not** Production acceptance. It says the artifact in
the image behaves as reviewed; it says nothing about what a deployed Worker did
with a real URL.

### Offline verifiers

Run inside the hardened Worker image, with no network:

```sh
docker run --rm --network none --read-only --cap-drop=ALL \
  --security-opt no-new-privileges \
  -v "$PWD/deploy/acceptance/ytdlp-generic:/verify:ro" \
  videofetch-worker:<tag> \
  /usr/bin/python3 /verify/verify-selector.py /usr/local/lib/videofetch/yt-dlp

docker run --rm --network none --read-only --cap-drop=ALL \
  --security-opt no-new-privileges \
  -v "$PWD/deploy/acceptance/ytdlp-generic:/verify:ro" \
  videofetch-worker:<tag> \
  /usr/bin/python3 /verify/verify-download-policy.py /usr/local/lib/videofetch/yt-dlp
```

No media URL, no hostname, no socket. Both exit non-zero on any deviation.

---

## Files

| File | Runs on | Purpose |
| :--- | :--- | :--- |
| `verify-selector.py` | inside the image, `--network none` | The format selector picks exactly the approved id and never substitutes. |
| `verify-download-policy.py` | inside the image, `--network none` | Every acquisition option parses as intended; FFmpeg/ffprobe are unavailable. |
| `acceptance.mjs` | the VM host | The live orchestrator. Refuses to run live by default. |
| `lib/gate.mjs` | — | The double opt-in. Pure. |
| `lib/verdict.mjs` | — | `PASS` / `FAIL` / `BLOCKED` / `NOT_EXERCISED`, and the Stage A → Stage B edge. |
| `lib/stage-a.mjs` | — | Every precondition that must hold before enablement is permitted. |
| `lib/stage-b.mjs` | — | The enabled-state acceptance matrix. |
| `lib/process-tree.mjs` | — | Descendant classification, process-group and namespace rules. |
| `lib/redact.mjs` | — | The single redaction implementation. |
| `lib/evidence.mjs` | — | The sanitized machine-readable record, and the sentinel. |
| `lib/observers.mjs` | the VM host | The only impure module. Hard read-only command allowlist. |

Tests: `scripts/ytdlp-acceptance.test.mjs`, run by `npm test`. They drive the
real evaluators with fakes; **no test performs a live run.**

---

## Accidental live execution is impossible by default

```
node deploy/acceptance/ytdlp-generic/acceptance.mjs --stage A
```

prints a refusal and exits `2`:

```
live execution         : REFUSED
Production mutation    : NONE
network media request  : NONE
job created            : NONE
```

A live run needs **both**:

1. the `--live` flag, and
2. `VIDEOFETCH_ACCEPT_LIVE=1` in the environment — matched **exactly**;
   `true`, `yes`, `01` and `1\n` are all refused.

There is **no auto-detection**. Not "live if a Production host is reachable",
not "live if docker exists", not "live if a URL was supplied". A rich,
Production-looking environment with no flag still produces a dry run.

### What the harness will never do

| | Why |
| :--- | :--- |
| Write `/etc/videofetch/worker.env` | §10 — it must measure the deployment state it is given, not change the condition it is verifying. |
| `systemctl restart videofetch-worker` to enable yt-dlp | Same. Enablement is the Phase-10D operator's own step. |
| Repair a failed service, policy or route | §50 — a failed precondition is `BLOCKED`, and the operator decides whether to repair and re-run from a clean stage. |
| Create or rotate any credential | §51 — a missing credential is a deployment precondition failure. |
| Broaden the nftables policy | §34 — if a site needs a correctly-denied destination, the *source* fails. |
| Print a secret, a query string, a process argv or raw stderr | §16, §24, §45, §47. |

`lib/observers.mjs` enforces the first four **structurally**: `runReadOnly`
accepts only commands matching an allowlist, so `systemctl restart`, `nft`,
`ip route add`, `docker run` and `sh -c` throw before a process is spawned.

---

## The stage model

```
STAGE A — reviewed image deployed, generic DISABLED
   │
   │   every Stage A gate must PASS
   │   (there is no warn-and-continue)
   ▼
   OPERATOR sets YTDLP_ENABLED=true and restarts the Worker
   │
   ▼
STAGE B — generic ENABLED
```

The harness **refuses to grade the wrong stage**. Running `--stage A` against a
deployment whose `YTDLP_ENABLED` is `true` exits `BLOCKED` with `STAGE
MISMATCH`, and vice versa — because a Stage A gate failing on a Stage B
deployment would be read as a deployment defect rather than as the operator
having selected the wrong stage.

Stage B additionally requires `--stage-a <path>` pointing at a Stage A evidence
record whose verdict is literally `PASS`. A missing, unparseable or non-passing
record is `BLOCKED`. There is no override flag.

---

## Fail-closed: `BLOCKED` is not `SKIPPED`

A security-relevant property the harness **could not measure** is `BLOCKED`, and
`BLOCKED` stops the run. It is never converted to `PASS` by a fallback, a
default or an operator assertion.

| Outcome | Meaning |
| :--- | :--- |
| `PASS` | Measured, and the property holds. |
| `FAIL` | Measured, and the property does not hold. |
| `BLOCKED` | **Could not be measured.** Terminal. |
| `NOT_EXERCISED` | Genuinely not applicable to the chosen source, and declared optional. Proves nothing, and can never satisfy a required check. |

Cases that are `BLOCKED`, not skipped:

- cannot identify the running image;
- cannot inspect the process tree;
- cannot verify safe egress;
- cannot determine whether FFmpeg ran;
- cannot obtain the final bytes;
- cannot prove cleanup;
- the actual-byte-limit case has no safe live fixture (§38).

A run whose check list is empty is `BLOCKED`, not `PASS`: a run that measured
nothing proves nothing.

---

## Stage A — the gates before enablement is permitted

`node acceptance.mjs --stage A --live --base-url <control-plane> --evidence stage-a.json`

| # | Gate | Requirement |
| :--- | :--- | :--- |
| 1 | `image.identity` | The running container reports a resolvable image id. |
| 2 | `image.matches-authorized-sha` | The image tagged with the authorized `main` SHA **is** the image running. |
| 3 | `image.latest-alias-is-same-object` | `videofetch-worker:latest` resolves to the **same image object** as the SHA tag. |
| 4 | `service.*` | All seven units active: `videofetch-media-dns`, `-media-netns`, `-egress-policy`, `-egress-watchdog`, `-r2-broker`, `-worker`, `vf-cloudflared`. |
| 5 | `safe-egress.verifier` | The existing read-only `vf-egress-policy-verify` exits 0. |
| 6 | `worker.network-mode` | `container:videofetch-media-netns`, with no fallback network. |
| 7 | `runtime.ytdlp-version` | **Exactly** `2026.08.19`. Not "newer", not date-shaped, not `latest`. |
| 8 | `runtime.python-series` | A `3.11` series interpreter. |
| 9 | `runtime.node-family` | The reviewed `v22` family. |
| 10 | `runtime.bundled-ejs` | **Exactly** `0.8.0`. |
| 11 | `capability.implemented` | `binaries.ytdlp` — the pinned runtime answers its version probe. |
| 12 | `config.ytdlp-disabled` | `YTDLP_ENABLED` absent, or exactly `false`. |
| 13 | `capability.generic-not-usable` | `/api/sites` reports `ytdlp: false`. |
| 14 | `worker-env.forbidden-absent` | None of `YTDLP_NETWORK_ISOLATED`, `YTDLP_PATH`, `R2_WRITER_*`, `R2_BROKER_PARENT_*`, `R2_SIGNER_*` is bound. **Names only.** |
| 15 | `worker-env.required-present` | The Worker's own configuration is present. **Booleans only.** |
| 16 | `direct.regression-ready` | A direct-media job reaches `ready` with `extractor: direct` through the real control plane. |
| 17 | `direct.byte-integrity` | The bytes delivered by the signed GET match the source fixture by **length and SHA-256**. |

**If any gate is `FAIL` or `BLOCKED`, Phase 10D STOPS BEFORE GENERIC
ENABLEMENT.** The harness prints:

```
STOP BEFORE GENERIC ENABLEMENT — <verdict>: <failing check ids>
```

and never prints the enablement authorization.

### Image identity — how Phase 10D should build

Build from a **clean checkout at the exact authorized SHA** and tag the result
with that SHA:

```sh
docker build -f Dockerfile.worker -t "videofetch-worker:${SHA}" .
docker tag "videofetch-worker:${SHA}" videofetch-worker:latest
```

The unit still starts `videofetch-worker:latest` (unchanged by Phase 10C4), so
gate 3 exists to prove both tags name **one image object**. Supply the observed
relationship to the harness rather than asserting it — the harness verifies, the
build step knows.

### The direct-media regression, and the authenticated Vercel leg

Reuse the **existing accepted direct-media E2E mechanism** recorded in
`docs/architecture/worker-deployment-runbook.md` §11c. Do not invent a second
direct path.

Authentication reuses the **existing private-access mechanism**: `POST
/api/access/login` with the operator's own secret, holding the returned
`HttpOnly` cookie in memory for the run. `assertPrivateAccessIsolation` admits a
request with no `Sec-Fetch-Site` header, so a CLI session needs **no** change to
the authentication code.

**Forbidden, without exception:** disabling auth, adding an acceptance bypass,
adding a debug endpoint, hardcoding or committing a session cookie, or exposing
an internal Worker route publicly. If a leg cannot be automated safely, it
becomes an **operator-assisted evidence step** whose result is supplied to the
harness — where an unsupplied result is `BLOCKED`, never a pass.

---

## Stage B — the enabled-state matrix

Only after Stage A passed, the operator sets `YTDLP_ENABLED=true` in
`/etc/videofetch/worker.env` and restarts only what is required. **The harness
does not do this.**

`node acceptance.mjs --stage B --live --base-url <cp> --stage-a stage-a.json --evidence stage-b.json`

| Area | Check | Requirement |
| :--- | :--- | :--- |
| Capability | `capability.generic-usable` | `/api/sites.ytdlp: true`, with all three conjuncts true. |
| | `config.ytdlp-enabled` | `YTDLP_ENABLED` is exactly `true`. |
| Analysis | `analysis.routed-to-generic` | Direct attempted first → `EXTRACTOR_UNAVAILABLE` → generic. `extractor: yt-dlp`. |
| | `analysis.no-raw-formats` | `formats: []`. No raw `format_id` reaches the browser contract. |
| | `analysis.presets-application-owned` | Every advertised option is a `preset:*` rung. |
| | `analysis.no-generic-thumbnail` | No generic thumbnail URL under the v1 contract. |
| Job | `job.transitions-ordered` | `queued → analyzing → downloading → processing → uploading → ready`, in order, reaching `ready`. Never faked. |
| | `job.requested-preset-owned` | Created with an application-owned preset. |
| Durable | `durable.extractor-is-ytdlp` | `extractor: yt-dlp` persisted after analysis. |
| | `durable.no-raw-selector-fields` | No `format_id`, `selector`, `sourceUrl` … field exists in durable evidence. |
| | `selector.constraints-satisfied` | Structural only. The raw upstream id is **never** reported or persisted. |
| Process | `process.no-ffmpeg-during-downloading` | No `ffmpeg`, `ffprobe`, `curl`, `wget`, `aria2c`, `axel`, shell … under the Worker while durable state is `downloading`. |
| | `process.no-unknown-descendants` | Anything neither approved nor forbidden fails — unknown is not assumed safe. |
| | `process.ytdlp-present` | The owned yt-dlp process was actually observed. |
| | `process.namespace-identity` | Worker, yt-dlp and any Node descendant share one media netns inode. |
| | `process.node-ejs-containment` | *Optional.* If Node appears: descendant of the owned yt-dlp process, same process group, same namespace, gone at the end. If it never appears: `NODE/EJS DESCENDANT NOT EXERCISED BY THIS SOURCE`. |
| Egress | `safe-egress.forbidden-destination-denied` | A later forbidden destination denied by the **external boundary**, attributed to it. |
| | `safe-egress.policy-unchanged` | The policy fingerprint is identical before and after the run. |
| R2 | `r2.delegated-write` | The object exists with non-zero length, written through the AF_UNIX broker. |
| | `r2.worker-holds-no-credential` | The Worker still holds no persistent R2 credential. |
| Vercel | `vercel.signed-get` | `303` to a presigned read-only GET. The Worker never performs the GET. |
| | `vercel.byte-digest` | Length **and** SHA-256 match. `HTTP 200` alone is not proof. |
| Privacy | `privacy.sentinel-not-leaked` | The ephemeral sentinel appears in none of the swept surfaces. |
| Cancel | `cancel.durable-cancelled` | Cancel during `downloading` → durable `cancelled`, no late `ready`. |
| | `cancel.processes-gone` | No yt-dlp or Node descendant survives. |
| | `cancel.no-upload-no-workdir` | No `beginProcessing`, no upload, no working directory left. |
| Limit | `limit.actual-byte-guard` | See below. |
| Shutdown | `shutdown.group-terminated` | Worker stop during acquisition terminates the owned group; the job is recovered per the existing restart policy. |
| Direct | `direct.after-enable` | A direct source still succeeds as `direct`. |
| | `direct.no-ytdlp-spawned` | No yt-dlp process appeared while it ran. |
| Runtime | `runtime.fail-closed` | *Optional.* Exact runtime unavailable → generic unusable, **no PATH fallback**, direct still works. |
| Kill switch | `killswitch.rollback` | Restoring the disabled state makes generic unusable while direct keeps working. |
| Catalog | `catalog.unchanged` | No `"limited"` entry was promoted on the strength of this run. |

### The live test URL is an input, never a constant

No third-party video URL is committed. Phase 10D supplies:

```
VIDEOFETCH_ACCEPT_GENERIC_URL=<https URL>
```

It must be: HTTPS, public, unauthenticated, no account cookie, no
private/member-only media, small and short enough for acceptance, legally and
operationally appropriate, and expected to expose at least one Phase-10
v1-compatible **progressive** source.

**The URL is test data, never CLI arguments.** It is submitted through the
existing application request contract and nowhere else. The harness never
assembles a `yt-dlp <url>` command, a format selector or an output template —
running yt-dlp directly and calling that proof would test a different system
than the one being accepted.

Its query string is redacted in every output surface.

### Process observation — what is captured, and what never is

Captured per process: `pid`, `ppid`, `pgid`, executable **basename**, network
namespace inode.

**Never captured: the full command line.** The acquisition argv ends in the
submitted URL, so capturing it would place a third-party URL — and, during the
sentinel case, the sentinel — into evidence that must stay clean.
`validateSampleShape` rejects any sample carrying `cmdline`, `argv`, `exe`,
`command` or `url`, so an observer that grows such a field fails the harness
loudly instead of leaking quietly.

### The actual-byte limit case (§38)

The property to prove:

```
source exceeds the configured maximum WHILE acquisition is active
  → owned process group aborted
  → TOO_LARGE
  → no processing, no upload, workDir cleaned
```

`--max-filesize` **does not prove this.** The pinned `HttpFD.real_download`
checks it only inside `if data_len is not None`, so an unknown or decompressed
`Content-Length` streams past it unchecked. The gate that matters is the
application byte watcher, and the case must therefore use a source whose
declared length is **unknown or misdeclared** — the harness fails a case whose
`declaredLengthUnknown` is false, precisely so a `--max-filesize` catch cannot
be submitted as evidence for the watcher.

If no safe, reproducible live fixture exists at Phase 10D time, the run reports

```
LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN
```

as `BLOCKED` and **the acceptance is incomplete**. Do not substitute a unit
test, and do not fabricate evidence. The gap is made explicit on purpose.

### Cancellation and shutdown

Cancellation needs a deterministic window while the job is actively
`downloading`. If the acceptance media completes too quickly, use a
deliberately small-but-slow public source or fixture. **Do not add a sleep to
production code** to create the window.

Shutdown is destructive to the acceptance job and is ordered **after** the
normal success case.

### Safe egress — reuse, never rebuild

The generic harness adds the missing **yt-dlp / process-lifecycle** context. It
does not contain a second firewall framework. For forbidden-destination
classification, redirect denial, DNS behaviour, rebinding and route/policy
verification, compose with `deploy/acceptance/safe-egress/` and the Phase-9
machinery recorded in runbook §11a.

Preferred negative case: a controlled public redirect whose destination is a
forbidden private/reserved address, so the submitted URL is genuinely public and
the denial is genuinely the external boundary's.

**Never:** widen the nftables allowlist, add a temporary broad allow, disable
the watchdog, or bind an internal fixture and call it a public-destination test.

---

## Privacy controls

### Redaction

One implementation, `lib/redact.mjs`, used by console output, the JSON record,
errors and command summaries alike.

```
https://host/path?token=secret   →   https://host/path?<redacted>
```

Query strings are removed **wholesale**, not per-parameter: the acceptance URL
is third-party test data whose parameter vocabulary nobody controls, and the
sentinel lives in a query parameter on purpose — a "safe parameter" allowlist
would make the sentinel test unfalsifiable. Fragments are dropped; userinfo is
never re-emitted; a value that does not parse as a URL collapses to
`<unparseable-url>` rather than being passed through. Redaction is idempotent,
because the evidence record is redacted at more than one level.

### The sentinel

Each live run mints `VF_ACCEPT_SECRET_<random>` — a random marker, **never a
real credential** — and places it in a benign query parameter of a submitted
URL where doing so cannot alter media selection. It must then appear in **none**
of:

- the Worker journal;
- cloudflared-relevant application output;
- any durable error;
- job metadata;
- the browser/API error body;
- object metadata;
- the acceptance JSON.

**The harness never prints the sentinel**, and never writes it to the record —
only the sweep's verdict and the surface names.

### Secrets

The record states whether required configuration **exists**, as a boolean or a
bare variable name. It never contains `WORKER_CONTROL_SECRET`, the R2 parent
secret, temporary R2 credentials, Cloudflare Access or Tunnel credentials,
Vercel signer credentials, session cookies or authorization tokens — and
`/etc/videofetch/worker.env` is never dumped or even read: `YTDLP_ENABLED` is
observed from the container's bound environment instead.

### Logs are read, never mutated

The harness may read `journalctl` and `docker logs`. It must not change logging
configuration, raise verbosity to capture raw yt-dlp output, add temporary
production debug logging, or print raw stderr. **If current logging cannot prove
a required invariant, report the evidence gap** — never weaken the privacy
boundary to obtain evidence.

---

## Evidence output

`--evidence <path>` writes a sanitized JSON record containing the expected
source SHA, running image id, stage, runtime versions, service-state booleans,
the safe-egress verifier result, capability booleans, job id, strategy,
transition timestamps, result size and digest, process descendant **basenames**,
namespace ids, negative-case results, and the final `PASS` / `BLOCKED` / `FAIL`.

It is assembled from an **allowlist** — every field is named explicitly, there is
no `...spread` of observer output — then URL-redacted at every depth, then passed
through a forbidden-key strip that withholds anything named like a secret.

**Live evidence is not committed automatically.** Phase 10D decides what to
record in the runbook.

## Cleanup

Three distinct lifecycles, kept distinct:

| Lifecycle | Owner |
| :--- | :--- |
| Application cleanup (workDir, durable expiry) | the Worker |
| Harness local files (evidence, fixtures) | the operator, explicitly |
| Provider object lifecycle | the existing R2 backstop rule |

Capture safe metadata **before** removing anything needed to diagnose a failure.
Delete the **exact object only** — never a bucket-wide or prefix-wide sweep.

---

## Stop conditions

Stop and report rather than improvise if the harness would need to: bypass
authentication; hold a committed credential; capture raw process argv containing
the submitted URL; broaden the firewall policy; add a Worker debug endpoint;
expose raw yt-dlp stderr; or if it cannot distinguish Stage A from Stage B
fail-closed, cannot prevent accidental live execution, or reveals a genuine
Production-code defect. A production-code correction is reported separately —
never folded into acceptance tooling.
