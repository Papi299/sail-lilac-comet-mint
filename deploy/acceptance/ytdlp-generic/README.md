# Generic yt-dlp acceptance — offline verifiers + Production harness

**Test tooling only.** Nothing here runs during Worker startup, no systemd unit
references any of it, and none of it is part of the Worker image's runtime path.

> ### Status
>
> ```
> harness exists:            YES
> Stage A (live):            PASSED — run a9ce1c400db8d817
> Stage B:                   NOT STARTED
> Production enablement:     NO — YTDLP_ENABLED remains unset
> ```
>
> **Stage A has passed.** Run `a9ce1c400db8d817`, schema `10d-remediation-02`,
> `live`, bound to the reviewed Worker source
> `4a537e3cb7403801f39a706ce7bed896c0fe11f7`:
>
> ```
> verdict   PASS        PASS 23    FAIL 0    BLOCKED 0    NOT_EXERCISED 0
> ```
>
> It replaces nothing: the earlier `5e6670a858543d93` / `10d-remediation-01`
> run **FAILED** (16 PASS / 1 FAIL / 6 BLOCKED) and its sealed record and run
> key are retained unmodified as historical evidence. Both records stand.
>
> **A Stage A PASS is not enablement authorization.** Generic execution is still
> disabled, no Stage B case has run, and `YTDLP_ENABLED` has not been set.
>
> Immediately after that PASS, `PHASE-10D-ACCEPTANCE-EVIDENCE-IMMUTABILITY-001`
> found that a **dry run** handed `--evidence` wrote a `BLOCKED` stub to that
> path, and that all three live producers sealed their records with an ordinary
> overwriting write. The artifact the whole staged programme depends on was
> therefore silently destroyable. That is corrected **before** Stage B — see
> [Evidence artifacts are append-only by path](#evidence-artifacts-are-append-only-by-path).
> The correction changes durability only; the accepted `10d-remediation-02`
> record remains valid and admissible.

---

## Two different kinds of evidence

These are not interchangeable, and the harness never labels one as the other.

| | Offline / static | Live Production acceptance |
| :--- | :--- | :--- |
| **Files** | `verify-selector.py`, `verify-download-policy.py` | `acceptance.mjs` + `lib/` |
| **Proves** | pinned-runtime *semantics* | the behaviour of the *deployed system* |
| **Needs** | the image, `--network none` | a real deployment, a real job, real bytes |
| **Run by** | anyone, any time | Phase 10D, under a double opt-in |
| **Status** | executed and green | **ATTEMPTED ONCE — FAILED** (see below) |

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
| `lib/lifecycle.mjs` | — | The six-state durable ladder: ordered / complete / missing. |
| `lib/stage-a.mjs` | — | Every precondition that must hold before enablement is permitted. |
| `lib/stage-b.mjs` | — | The enabled-state acceptance matrix. |
| `lib/process-tree.mjs` | — | Closed sample schema, owned-PID identity, containment, namespace rules. |
| `lib/redact.mjs` | — | The single redaction implementation and the console safety boundary. |
| `lib/evidence.mjs` | — | The sanitized machine-readable record, and the sentinel. |
| `lib/download-window.mjs` | — | The durable-`downloading` sampling window and its complete aggregate. |
| `lib/egress-policy.mjs` | — | Phase-9 deny-counter reading and the nftables ruleset fingerprint. |
| `lib/provenance.mjs` | — | Tamper-evident artifacts: run identity, HMAC seal, deployment binding. |
| `lib/coverage.mjs` | — | Which concrete producer obtains each check. Walked by the test suite. |
| `lib/observers.mjs` | the VM host | Read-only system observers. Hard command allowlist. |
| `lib/control-plane.mjs` | the VM host | The authenticated product-surface driver (login, analyze, job, signed GET). |
| `lib/process-sampler.mjs` | the VM host | The real `docker top` sampler; establishes the owned yt-dlp PID. |
| `lib/cases.mjs` | the VM host | Stage B case producers and the case-record contract. |
| `fixtures/server.mjs` | the VM host, loopback only | The controlled acceptance fixture service — all four fixture families. |
| `fixtures/prepare-media.mjs` | the VM host, via `docker run --network none` | Regenerates the bit-exact fixture MP4 and reports its digest. |
| `fixtures/README.md` | — | How to run, expose, verify and tear down the fixtures. |

Tests: `scripts/ytdlp-acceptance.test.mjs` and `scripts/ytdlp-fixture.test.mjs`,
both run by `npm test`. They drive the real evaluators with fakes and the real
fixture over loopback; **no test performs a live run, and none needs the
public Internet.**

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

## The harness is the orchestrator, not a policy model

**Phase 10D does not write a script.** Every required observation has a
committed producer reachable from the CLI, and `scripts/ytdlp-acceptance.test.mjs`
walks `lib/coverage.mjs` against the live evaluators to prove it: a check with no
concrete producer fails the test suite.

```
Production
   │
   ▼  lib/observers.mjs        read-only commands (allowlisted)
   │  lib/control-plane.mjs    authenticated product surface
   │  lib/process-sampler.mjs  docker top -o pid,ppid,pgid,comm
   │  lib/cases.mjs            case choreography
   ▼
reviewed evaluator (stage-a.mjs / stage-b.mjs / lifecycle.mjs / process-tree.mjs)
   │
   ▼
sanitized evidence  →  PASS / FAIL / BLOCKED
```

There is no unreviewed layer between Production and the acceptance logic.

### Commands

| Command | Required generic state | Produces |
| :--- | :--- | :--- |
| `--stage A` | **disabled** | Every Stage A gate, including the direct-media regression. Writes the Stage A record and begins the run. |
| `--stage B --case success` | **enabled** | Generic analysis, job lifecycle, durable evidence, the downloading window, R2, signed GET, sentinel sweep. |
| `--stage B --case cancellation` | **enabled** | Captures the owned PGID, cancels, proves that exact group died. |
| `--stage B --case byte-limit` | **enabled** | This case's own unknown-declared-length **media GET** serves more than the deployed limit and aborts as `TOO_LARGE`. |
| `--stage B --case shutdown` | **enabled** | Captures the owned PGID, the operator restarts, that exact group must be gone. |
| `--stage B --case safe-egress` | **enabled** | Forbidden later destination denied, attributed by the **deny counter** named with `--egress-deny-class` (a closed deny-only enum). |
| `--stage B --case direct-regression` | **enabled** | Post-enable direct job with no yt-dlp process. |
| `--stage B --case kill-switch` | **disabled** | Generic unusable after the operator rolls back; direct still works. |
| `--stage B --aggregate` | either — **genuinely either** | Validates every case record and produces the Stage B verdict, reading each state-dependent claim from the artifact that observed it. |

Each case declares the deployment state it requires. Running one against the
wrong state is `BLOCKED`, and — importantly — so is running **any** case while
`YTDLP_ENABLED` could not be measured: a case graded against an unknown stage
produces evidence nobody can interpret.

Each case also **seals the state it actually ran in** into its own record, which
is what lets the aggregation accept `either` above and mean it — see
[the aggregate judges history](#the-aggregate-judges-history-it-does-not-reconstruct-it).

Each case writes its own record; the aggregation turns records into a verdict.
Multi-run is deliberate: enabling generic, cancelling a job, stopping the Worker
mid-acquisition and rolling the switch back are separate operator transitions
that cannot share one process.

### The ordered acceptance sequence

Generic cannot be simultaneously enabled and disabled, so the cases are ordered
around the two operator transitions:

```
Stage A                     generic DISABLED, must PASS
   │
   ▼  OPERATOR ENABLES GENERIC
   │
enabled-state cases         success · cancellation · byte-limit
                            shutdown · safe-egress · direct-regression
   │
   ▼  OPERATOR DISABLES GENERIC
   │
kill-switch case            proves generic unusable, direct still works
   │
   ▼  OPERATOR RESTORES THE CHOSEN FINAL STATE
   │
--stage B --aggregate       consumes the sealed evidence from BOTH states
```

The harness performs **none** of those transitions. It measures the state it is
given, refuses to run a case against the wrong one, and refuses to run any case
at all when the state is unmeasurable.

#### The aggregate judges history; it does not reconstruct it

Every case record carries a `featureState` the **harness measured while that
case ran** — the deployment's own `YTDLP_ENABLED` spelling and the application's
own `/api/sites` answer — and it is sealed with the record, so it cannot be
edited without invalidating the authenticator.

The aggregation reads the two state-dependent claims from those artifacts:

| Claim | Comes from |
| :--- | :--- |
| `capability.generic-usable` | the `success` record's sealed enabled-state facts |
| `config.ytdlp-enabled` | the `success` record's sealed enabled-state facts |
| `killswitch.disabled-state-proven` | the `kill-switch` record's sealed disabled-state facts |
| `deployment.final-state-recorded` | the deployment at aggregation time — **recorded, not graded** |

A `success` artifact recording the disabled state, or a `kill-switch` artifact
recording the enabled state, is **rejected outright**: the case declares the
state it is only meaningful in, and evidence captured in the other one proves
nothing about the claim it is offered for.

**The final state is deliberately not a gate.** A complete acceptance whose
terminal condition is `disabled` — the preferred Phase-10D outcome, since the
runbook keeps Production `YTDLP_ENABLED` unset and Phase 10E owns final product
enablement — aggregates to `PASS` on the strength of its sealed artifacts. An
aggregate run while generic happens to be enabled does not erase the kill-switch
evidence either. What the check does require is that the final state was
**measured** and is inside the deployment's own grammar; an unmeasurable one is
`BLOCKED`.

This is not a relaxation. The earlier model read the current deployment and
required it to be enabled, which was strictly worse in both directions: it
failed every run that had followed the documented sequence to its end, and it
could be satisfied by enabling generic in the minute before aggregating — a
state with no connection to when the evidence was captured.

### Case records cannot be forged

Every Stage A record and every Stage B case record is **sealed** with an
HMAC-SHA256 over a canonical encoding of the **complete record**, excluding only
the authenticator field itself.

That covers `checks[]`, `runtime`, `services`, `delivery`, `process`, the nested
`binding`, every timestamp, and any field added later — an enumerated subset
would have left a future field silently outside the seal, and an editable
`checks[0].outcome` is exactly what the seal exists to protect. Editing anything
invalidates it, and an unverifiable record is **rejected outright rather than
partially consumed**.

The top-level identity and the nested `binding` must also **agree**; both are
inside the seal, so this catches a record sealed with two internally
inconsistent copies of the same identity. Authenticity is checked *before* any
field is read, because comparing binding fields out of an unverified record
would be trusting the thing under test.

Then, on top of that, the aggregator still requires the case name to be known,
the payload to pass a **strict** validator with no unknown keys, and the pure
evaluator to re-judge every field. A hand-written `{"passed": true}` cannot
produce a PASS at any layer.

#### The acceptance run key

Stage A **begins** a run; Stage B cases and the aggregation **join** it.

- random `runId` + 256-bit key, in `./.vf-acceptance-run.json` (`--run-key` to
  relocate), written `0600`;
- **never** an application credential — not `WORKER_CONTROL_SECRET`, not
  `VIDEOFETCH_ACCESS_SECRET`, not an R2/Cloudflare/Vercel credential. Reusing one
  would give the harness a reason to hold production secrets it does not need,
  and would make a leak of its own state file a production incident;
- never printed, never committed (it is in `.gitignore`), never in any evidence
  record — only the non-secret `runId` travels with the artifacts;
- **refused if it is group- or world-readable, on every path that touches it** —
  Stage A resuming an existing key as much as Stage B loading one. A key any
  local account can read is a key that can re-seal edited artifacts;
- **refused if its permissions cannot be measured at all.** "We could not read
  the mode" is not "the mode is fine";
- **never replaced.** A file that *exists* is never overwritten, whatever is
  wrong with it;
- **deleted by the operator when acceptance is complete.**

##### Evidence artifacts are append-only by path

The run key has been fail-closed since CORRECTION-05. Until CORRECTION-08 the
**evidence records were not**, and the asymmetry was the whole defect: the file
holding a run's only durable result was easier to destroy than the file holding
its key.

**Every LIVE acceptance command requires `--evidence <path>`.** Stage A, every
Stage B case and the aggregation are admitted only after *both* conditions hold:

```
the evidence path is PRESENT      (a live run must name its destination)
the evidence path is UNOCCUPIED   (naming a taken one is refused, not resolved)
```

Both are checked at one admission point — before the private-access login,
before the run key is minted or loaded, and before any observer, product
request, job, cancellation or restart. The path is parsed **once** there and
carried on the context, so the path admitted is provably the path preflighted
and the path exclusively created; no producer re-reads `argv` at seal time.

A missing filename is not a free filename. The Stage B case producer used to
check for `--evidence` *after* it had run — an operator who forgot the flag got
a real generic job, a real cancellation or a real Worker restart, and then a
usage error instead of a record. For a production-changing case, no evidence
destination means no authorization to execute the case at all.

**Dry runs never require and never write evidence.** The mandatory-path rule
begins only after the live gate has positively admitted live execution; without
both opt-ins every subcommand still prints `LIVE EXECUTION REFUSED`, exits 2 and
touches nothing.

- a **dry run writes nothing at all**, even when handed `--evidence`. It used to
  seal a `mode: "dry-run"` stub there — so the one invocation an operator
  reaches for *because* it changes nothing could replace a sealed PASS with a
  record carrying no schema, no `runId` and no checks;
- an existing `--evidence` target is **refused, never replaced** — as a file, a
  directory, or a symlink. The gate uses `lstat`, so a link occupying the path
  is the entry itself rather than a window onto its target;
- the refusal is early: **before** Stage A creates its direct-media job and
  **before** a Stage B case cancels or restarts anything, so an occupied path
  never costs production work whose record cannot be written;
- the final create is exclusive (`flag: "wx"`), so a file appearing inside the
  gate-to-seal window **loses** rather than being truncated. Losing is
  `BLOCKED`: never adopt the winner, never unlink and retry, never archive;
- the harness never deletes, truncates, renames or archives an artifact.
  **Choosing a new path is a deliberate operator action.**

The bounded consequence of losing the race is stated plainly rather than hidden:
the acceptance work may already have executed against Production, but no
evidence claim is made for a run whose record could not be durably written.

**What these two checks do and do not prove.** The early gate proves the target
path was *unoccupied*; the exclusive creation proves it was *still* unoccupied at
the final write. Neither proves the parent directory exists, is writable, or has
safe permissions — an unwritable directory surfaces as a write failure at seal
time, not as an early refusal. Pre-creating and verifying the private evidence
workspace is a separate operator step, and the later Stage-B operational task
does it before generic execution is enabled.

`ENOENT` is the only condition that mints a run:

| Existing file | Outcome |
| :--- | :--- |
| absent (`ENOENT`) | mint a new run |
| private, valid structure | resume |
| group/world-accessible | `BLOCKED` |
| permissions unmeasurable | `BLOCKED` |
| unreadable content | `BLOCKED` |
| malformed JSON | `BLOCKED` |
| no usable `runId` / 256-bit key | `BLOCKED` |

A run identity is admitted only in the **exact grammar the harness itself
produces** — `runId` is 16 lowercase hex characters (`randomBytes(8)`), `key` is
64 (`randomBytes(32)`). The previous test was `typeof runId === "string"`, which
accepted `""`, `"abc"`, uppercase, and anything else a damaged or hand-edited
file happened to carry. That matters beyond tidiness: `runId` is inside the
authenticated material and is compared across artifacts to prove they belong to
one acceptance run, so an identity the harness could never have generated is not
a run identity.

An earlier version fell through to "mint a fresh run" on unreadable or malformed
content — which **overwrote** the file, destroying the only key that could ever
verify the artifacts already sealed under it, and doing so silently at the exact
moment something was already wrong. A damaged acceptance identity is the
operator's to archive or delete deliberately.

Note that a damaged file is an **error**, not a `null`: `null` means "no run has
been started", which would send the operator to re-run Stage A and overwrite the
very file that needed attention.

Stage B refuses to mint a key: doing so would make every prior artifact
unverifiable and would let a re-keyed run re-seal edited records.

It is not a defence against an operator forging their own acceptance — nothing
local can be. It is a defence against an artifact being **edited**, **mixed
between runs**, or **carried over from a different image** without anyone
noticing.

### `schemaVersion` identifies the producer contract

**`schemaVersion` names the acceptance producer contract, not merely the set of
JSON keys.** It is the current value or the artifact is refused.

A valid HMAC proves exactly one thing:

```
this artifact has not changed since somebody holding this run key produced it
```

It says nothing about *which revision of the harness's observation semantics*
produced the contents it authenticates. That is the schema version's job, and it
is the only field that can do it.

**Why that matters most for Stage A.** A Stage B case record is already refused
structurally when a required field is absent, so an older case artifact cannot
pass today's validator. Stage A's record *shape* has not changed since
`10c4-correction-03` — so without a version bump an artifact produced by a much
weaker harness revision could carry the same `runId`, the same key, the same
source SHA, the same image binding and a `PASS` verdict, satisfy `loadStageA()`,
and **authorize current Stage B**. What it actually attested would be far less:

| Since | The same fields came to mean |
| :--- | :--- |
| CORRECTION-04 | effective deployed `MAX_FILE_SIZE`; closed deny-class enum; fail-closed host process parsing; state-neutral aggregation |
| CORRECTION-05 | narrow secret-safe environment probes — the older Stage A retrieved the **complete** environment, values and all; image continuity; deterministic restart recovery |
| CORRECTION-06 | positive findings outranking observation gaps; the exact `docker top` argv boundary; feature-state continuity |
| CORRECTION-07 | raw evidence validated before normalization; successful exit required before stdout is a measurement; container-epoch continuity; type-strict run identity; atomic key creation |
| 10D-REM-01 | the durable observer can address the deployment **at all** — see [Durable state is read inside the Worker](#durable-state-is-read-inside-the-worker). Before it, every `durable.*` check and the sentinel's `durable-row` surface could only ever have been `BLOCKED`, because the producer named a database file, a table and an executable that do not exist |
| CORRECTION-08 | **nothing.** Deliberately *not* a bump: it changes only whether an artifact may be overwritten on disk. Observer semantics, evaluator semantics, record contents and the deployment binding are untouched, so a sealed `10d-remediation-02` `PASS` means exactly what it meant when run `a9ce1c400db8d817` produced one |

**Bump it whenever an observer or evaluator change could make an old artifact
mean something *weaker* under the same shape.** A field added or removed is the
obvious case; a field whose *measurement* became stricter is the case that
matters, because nothing else catches it.

One constant governs Stage A, case records and the aggregate, so they cannot
drift into describing different contracts. No live artifact compatibility is
broken by this: Phase 10D has not run, so no acceptance artifact exists anywhere
that it invalidates.


`--stage B --aggregate` admits a case record only if:

1. `harness` and `schemaVersion` are exactly this harness's;
2. `case` is a known case name;
3. `expectedSha` **and** `runningImageId` match the current run;
4. its sealed `featureState` records the deployment state that case is defined
   to run in;
5. the payload passes that case's **strict** validator — required fields of the
   right type, and **no unknown keys**.

Then the pure evaluator re-judges every field. A hand-written
`{"passed": true}` cannot produce a PASS: there is no field called `passed`, and
nothing in a record is believed — only re-evaluated.

### Authentication

A live run **requires** `VIDEOFETCH_ACCESS_SECRET` and calls the existing
`POST /api/access/login` exactly once, holding the `HttpOnly` cookie in memory.

- A **missing** secret is a **usage failure**, not a capability failure — an
  unauthenticated probe would 401 and be recorded as "the control plane is
  broken", which is a false finding.
- A **failed** login is `BLOCKED`. The harness never continues as an
  unauthenticated observer.
- The secret is registered with the console safety pipeline the moment it is
  read, so it cannot reach output even through an error message.

### Operator-transition cases

`byte-limit`, `shutdown`, `safe-egress` and `fail-closed-runtime` involve a
transition the harness must not perform (stopping the Worker, damaging a
runtime, standing up a forbidden-destination fixture). Running them without a
producer exits `BLOCKED` with the reviewed procedure named — never a pass. The
operator performs the transition, and the case's evidence is produced by the
reviewed path described in the sections below.

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
| Job | `job.lifecycle-complete` | **All six** durable states — `queued → analyzing → downloading → processing → uploading → ready` — observed, in order. See below. |
| | `job.requested-preset-owned` | Created with an application-owned preset. |
| Durable | `durable.extractor-is-ytdlp` | `extractor: yt-dlp` persisted after analysis. |
| | `durable.application-format-id` | The durable `format_id` **is** an application preset, and equals the one the job was created with. Positive evidence. |
| | `durable.no-raw-selector-fields` | No `source_format_id`, `rawFormatId`, `selector`, `sourceUrl` … field exists. |
| | `selector.constraints-satisfied` | Structural only. The raw upstream id is **never** reported or persisted. |
| Process | `process.sample-shape` | The sample matches the **closed** schema: `pid`, `ppid`, `pgid`, `comm`, `netns` and nothing else. |
| | `process.ytdlp-identified` | The **exact** owned yt-dlp PID — descendant of the Worker, approved runtime basename, **its own process-group leader**, in the media namespace. |
| | `process.no-ffmpeg-during-downloading` | No `ffmpeg`, `ffprobe`, `curl`, `wget`, `aria2c`, `axel`, shell … under the Worker while durable state is `downloading`. |
| | `process.no-unknown-descendants` | Anything neither approved nor forbidden fails — unknown is not assumed safe. |
| | `process.namespace-identity` | Worker, yt-dlp and any Node descendant share one media netns inode. |
| | `process.node-ejs-containment` | *Optional.* Anchored to the **verified** owned PID: descendant of it, same process group, same namespace. Unanchored ⇒ `BLOCKED`. Never invoked ⇒ `NODE/EJS DESCENDANT NOT EXERCISED BY THIS SOURCE`. |
| Egress | `safe-egress.forbidden-destination-denied` | A later forbidden destination denied by the **external boundary**, attributed to it. |
| | `safe-egress.policy-unchanged` | The policy fingerprint is identical before and after the run. |
| R2 | `r2.delegated-write` | The object exists with non-zero length, written through the AF_UNIX broker. |
| | `r2.worker-holds-no-credential` | The Worker still holds no persistent R2 credential. |
| Vercel | `vercel.signed-get` | `303` to a presigned read-only GET. The Worker never performs the GET. |
| | `vercel.byte-integrity` | **Three-way** length agreement — durable `fileSize`, R2 `contentLength`, delivered bytes — plus a real SHA-256. `HTTP 200` alone is not proof. |
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

### The durable lifecycle contract

All six states are required evidence for the normal generic success case:

```
queued → analyzing → downloading → processing → uploading → ready
```

Three distinct outcomes, and the distinction is the point:

| Observation | Outcome |
| :--- | :--- |
| Complete and ordered | `PASS` |
| Measured, but moves backwards through the ladder | `FAIL` |
| Measured, but a required state was never seen | **`BLOCKED`** |

A missed poll is an **evidence gap**, never proof. `["ready"]` cannot pass, and
neither can `[queued, analyzing, ready]`. Consecutive duplicates from polling are
collapsed and are fine; a state outside the closed durable vocabulary rejects the
trace outright.

Observation is what was strengthened to meet this, not the evaluator:

- the poller runs at **200 ms**, because the runbook's own direct-media record
  shows a whole job completing in ~1.2 s;
- the trace is **seeded from the `POST /api/download` response**, which is the
  only observation that can witness `queued` for a job that leaves the queue
  before the first poll.

If a complete trace still cannot be obtained, Phase 10D is `BLOCKED`. Do not add
production instrumentation to close the gap.

### The downloading window

`no FFmpeg during downloading` is a **temporal** claim, so the evidence must be
both *scoped to* `downloading` and *complete across* it.

```
before downloading   samples NOT admitted
first downloading    window OPENS
while downloading    sample repeatedly; every sample is retained
first state after    window CLOSES, permanently
processing/uploading samples NOT admitted
```

Worker FFmpeg is **legitimate** during `processing` — `preset:mp3`, and
`preset:audio` from a muxed source, are Worker-side operations performed strictly
after `beginProcessing()` commits. Feeding those samples into an acquisition
check would fail a correct deployment.

**Every sample contributes to the verdict.** A single appearance anywhere in the
window fails, so a transient `ffmpeg` visible in one 250 ms sample and gone by
the next cannot be missed. Likewise a transient unknown executable, a transient
namespace mismatch, and a Node solver that appears in only one sample — which is
**EXERCISED**, and whose containment is judged, rather than being reported as
never having run.

Sampling is asynchronous, so admission depends on when a sample was **taken**,
not when it landed: a capture that begins inside the window and completes after
the job moved on is still evidence about the window.

If no sample was taken while the job was observed in `downloading`:

```
BLOCKED
```

**A sampling attempt that FAILED while the window was open is also `BLOCKED`** —
it leaves a real interval nobody observed, and a negative claim cannot rest on
that.

**A sample that straddles the window close** is discarded and counted, not
credited. Sampling is asynchronous, so the final in-flight snapshot straddles the
close on every healthy run; treating that as a gap would block every run. It can
neither admit a legitimate `processing` FFmpeg nor be counted as acquisition
coverage. The residual limitation is real and is reported rather than hidden: a
descendant appearing *only* during that final unresolvable instant would not be
observed, and `ambiguousSampleCount` in the evidence shows how much of the tail
was unresolvable.

### Proving the exact yt-dlp process

`process.ytdlp-identified` requires a specific PID, not "a Python process
exists". The sampler **establishes** a candidate and the evaluator then
re-verifies every property independently:

1. it is a descendant of the Worker;
2. its basename is an approved runtime shape (`python3`, `python3.11`, `yt-dlp`);
3. **it is its own process-group leader** (`pgid === pid`);
4. it is in the Worker's media network namespace.

Clause 3 is the discriminator. `process-runner.server.ts` spawns acquisition with
`detached: true`, so the owned process necessarily leads its own group, while an
unrelated Python descendant inherits the Worker's. It is also the property every
containment and termination proof depends on, since those are expressed in terms
of that group.

If **zero or several** candidates match, the sampler reports a measurement
failure rather than picking one — guessing which of two Python processes is "the"
acquisition would make every downstream proof meaningless. Node containment is
then anchored to that verified PID; without an anchor it is `BLOCKED`, never
"contained".

### The closed process-sample schema

A row may carry **exactly** `pid`, `ppid`, `pgid`, `comm`, `netns` — an
allowlist, not a blacklist of names someone thought of. `environment`,
`headers`, `query`, `fullCommand`, `cmdline`, `argv` and anything else are
rejected, as are malformed types and a `comm` containing a path separator or
whitespace (which is what a command line would bring).

The sampler uses `docker top <container> -o pid,ppid,pgid,comm` precisely
because it *cannot* return a command line. `ps -ef` and `/proc/<pid>/cmdline`
would each hand back the acquisition argv, whose last element is the submitted
media URL — and, during the sentinel case, the sentinel. Selecting the four safe
columns means the URL is never read, rather than being read and then redacted.

### The durable format contract

The durable `format_id` column legitimately holds the **application-owned**
preset, and the harness now proves that positively:

```
durable.application-format-id   format_id ∈ preset:*  AND  == the requested preset
durable.no-raw-selector-fields  no source_format_id / rawFormatId / selector /
                                format_selector / ytdlpFormat / sourceUrl
```

An earlier draft forbade `formatId` outright, which would have rejected every
real durable row. What must never become durable is the **private upstream
source selection** — which has no column at all and stays memory-only for one
execution attempt.

The durable reader projects **only** `job_id, status, format_id, extractor`. The
`url` column is deliberately never selected: it holds the acceptance URL, and
during the sentinel case the sentinel itself.

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

#### The one admissible process listing

That guarantee is only as strong as the command the allowlist admits. It used to
check `argv[0] === "top"` alone, which left the argv one flag away:

```
docker top <container> -o pid,ppid,pgid,comm      ← the only admissible form
```

| Refused | Why |
| :--- | :--- |
| `docker top <c>` | the default format includes `CMD` |
| `-o args` · `-o pid,args` · `-o command` · `-o cmd` | argv columns |
| `-o pid,ppid,pgid,comm,args` | argv appended to the safe set |
| `aux` · `-ef` · `-eo args` | full-listing forms |
| any extra argument | shape must be exact |
| a container name outside Docker's own grammar | the one dynamic token stays bounded |

Refusal happens **before a process is spawned**, so an argv-bearing listing is
never executed rather than executed and then filtered.

#### An unreadable row cannot be skipped here either

The downloading window's assertions are negative — no FFmpeg during
acquisition, no unknown descendants, no namespace escape — and their evidence is
the *absence* of matching rows. The previous parser did `continue` on a short row
and on a non-numeric id, so one unreadable line left the rest looking clean and
the window `PASSING`. The row most likely to be unusual is exactly the one those
checks exist to catch.

| Line | Outcome |
| :--- | :--- |
| header is `PID PPID PGID COMMAND` | required — see below |
| three numeric ids parse | row kept, whatever follows |
| numeric prefix unreadable | **whole sample unmeasured → sampler error → `BLOCKED`** |
| the **raw** `comm` is a plain basename | lowercased, kept verbatim |
| the **raw** `comm` is anything else | kept, reported as `<unclassified>` |

The raw field is what is judged — see
[Raw evidence is validated before it is normalized](#raw-evidence-is-validated-before-it-is-normalized).
`foo/python3` is not `python3`.

An unclassified descendant inside the Worker container is not an approved
acquisition executable, so it lands in `unknownSeen` and **fails**
`process.no-unknown-descendants` rather than vanishing into a clean result.

**The header is validated, not skipped.** Blindly dropping the first line means
an output whose header is missing or unexpected silently loses its first process
row — and column positions that cannot be confirmed are positions that cannot be
parsed by. The expected header was verified against the pinned image on this
Docker/procps combination:

```
PID                 PPID                PGID                COMMAND
```

procps titles the `comm` column `COMMAND`; that is the column *name*, not the
command line — `-o args` would be needed for argv, and the allowlist forbids it.

This parser is kept separate from the host-level PGID parser. Both are
fail-closed, but they read different commands with different output contracts,
and collapsing them would couple parsers that are only incidentally similar.

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

#### What the fixture must implement

```
VIDEOFETCH_ACCEPT_BYTELIMIT_URL=<https URL of the controlled fixture page>
VIDEOFETCH_ACCEPT_BYTELIMIT_EVIDENCE_URL=<https URL of its evidence endpoint>
```

The harness appends `?vf_case=<128-bit hex>` to the submitted URL. The fixture
must:

1. associate the media request it then serves with that `vf_case` value;
2. serve it with **no usable `Content-Length`** (chunked, or a misdeclared one);
3. serve **more bytes than the deployed `MAX_FILE_SIZE`** — see below;
4. answer `GET <evidence endpoint>?vf_case=<id>` with that case's own facts:

```json
{
  "caseId": "<the same id>",
  "actualMediaRequestObserved": true,
  "mediaRequestCount": 1,
  "contentLengthPresent": false,
  "transferMode": "chunked",
  "bytesServed": 600000000,
  "observedAt": "<iso timestamp>"
}
```

An unknown case must answer `404`, not a default. A response whose `caseId` does
not match, or whose `mediaRequestCount` is not exactly `1`, is `BLOCKED`.

This contract is implemented by `fixtures/server.mjs` — see
[`fixtures/README.md`](fixtures/README.md). Its `/byte-limit-media.mp4` sends no
`Content-Length` (so Node frames it `chunked`), streams up to **528 MiB** from
one reused 64 KiB block under backpressure, and counts `bytesServed` in the
`res.write` flush callback so the number describes bytes handed to the socket
rather than bytes queued. A `HEAD` on that route opens no case and increments
nothing; a second `GET` is reported as `mediaRequestCount: 2` rather than
clamped, so an ambiguous transfer stays `BLOCKED` instead of passing.

### Cancellation and shutdown

Cancellation needs a deterministic window while the job is actively
`downloading`. If the acceptance media completes too quickly, use a
deliberately small-but-slow public source or fixture. **Do not add a sleep to
production code** to create the window.

`fixtures/server.mjs` provides that window: `/generic-media.mp4` is served with
deterministic throttling — a 14 s target in 250 ms ticks — which changes
transfer timing only. Every byte is sent, in order, unmodified, and a completed
transfer hashes to the same digest as the file on disk.

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

The repository fixture for this is `fixtures/server.mjs`'s `/safe-egress`: a
generic single-item page, public HTTPS through a temporary Quick Tunnel, whose
media destination is fixed **in source** at
`http://10.255.255.1/videofetch-denied.mp4`. It is a literal RFC1918 address
rather than a hostname, and no query parameter, header or flag can move it — so
the fixture family is `private-v4` and the run must be invoked with
`--egress-deny-class deny-v4`, chosen before the run rather than from whichever
counter moved.

---

## Proving termination of the exact acquisition group

`process group terminated` is a claim about **one specific group**, so the
harness captures that group before the transition and asks the host about it
afterwards.

```
job reaches durable `downloading`
   │
   ▼  capture pid, PGID, comm, netns of the OWNED yt-dlp process
   │   (established by the detached-spawn invariant: pgid === pid)
   │
   ▼  cancellation, or the operator's Worker restart
   │
   ▼  ps -eo pid=,ppid=,pgid=,comm=  →  survivors of THAT pgid
```

`descendantsOf(currentWorkerPid)` cannot answer this. A cancelled or
restart-orphaned acquisition process is re-parented away from the Worker, so an
ancestry check sees a clean tree while the process is still running — and after
a restart the new Worker never had those descendants in the first place.
"The new Worker is clean" and "the old group died" are different assertions, and
only the second is the one being made.

| Observation | Outcome |
| :--- | :--- |
| No members of the captured PGID survive | `PASS` |
| A plausible acquisition member survives | `FAIL` |
| Host could not be queried, or the PGID was never captured | `BLOCKED` |
| Survivors exist but none could belong to an acquisition group | `BLOCKED` — PID/PGID reuse is not distinguishable from a leak |

The `ps` allowlist admits **one** invocation, `ps -eo pid=,ppid=,pgid=,comm=`.
`ps -ef` and `ps aux` both print the full command line, whose last element on the
acquisition process is the submitted media URL.

### An unreadable row is not a skippable row

This is a **negative** proof, and its evidence is the *absence* of matching
rows. So a line the parser cannot interpret is not noise — it is potentially the
one leaked survivor, and dropping it turns a real leak into `[]` and therefore
into a `PASS`.

The listing answers exactly one question — *does the captured PGID still have
members?* — and the parser is calibrated to that question:

```
<pid> <ppid> <pgid> <the rest of the line is comm>
```

| Line | Outcome |
| :--- | :--- |
| Three numeric ids parse | row kept, whatever follows |
| Numeric prefix unreadable | **whole listing unmeasured → `BLOCKED`** |
| `comm` is a plain basename | kept verbatim |
| `comm` is anything else | kept, reported as `<unclassified>` |

**Why the numeric prefix is the fail-closed part.** A line whose ids cannot be
read might belong to the captured group and cannot be shown not to.

**Why an unusual `comm` is not.** procps permits a `comm` containing spaces — it
comes from the executable name, and an unrelated host process may legitimately
have one. An earlier version split on whitespace and demanded exactly four
tokens, so *one* unrelated process with a spaced name made the entire host
listing unreadable and every termination check `BLOCKED`, for a reason with
nothing to do with the captured group. That is a fail-closed rule misapplied: it
turns an irrelevant oddity into an unanswerable question.

The row is understood structurally either way, so it is never dropped. If an
unclassifiable row **is** in the captured group, `evaluateGroupTermination`
cannot call it a plausible acquisition member and reports the survivor set as
ambiguous — `BLOCKED`, never `[]`.

The trailing text is the `comm` field by the format's own definition: the
allowlisted `ps` selects four columns by name, and there is no `args`, `cmd` or
`command` column. It is still not copied verbatim unless it is a plain basename.

Refusal messages name the line *number* and the defect, never its content — a
line whose ids are unreadable is precisely the case where the rest might not be
a `comm` at all. Blank lines are still skipped: they carry no process and hide
nothing.

## One image, start to finish

A case record binds to an image object, and that object is established on **both
sides** of the producer:

```
resolve videofetch-worker:<authorized sha>
require running image == tagged image      ← the authorized object
   │
   ▼  run the case producer
   │
resolve again; require the SAME object
   │
   ▼  only then seal the record
```

| Outcome | Result |
| :--- | :--- |
| same image before and after | sealed with `imageContinuity` |
| image changed during the case | `BLOCKED — DEPLOYED IMAGE CHANGED DURING CASE`, **no record written** |
| post-case image unmeasurable | `BLOCKED`, no record written |
| running image is not the SHA-tagged object | `BLOCKED`, no record written |

This matters most for `shutdown`, which exists to span an operator restart.
Systemd starts `videofetch-worker:latest`, so a restart is an image-**resolution**
event: the container that comes back could be running a different object than the
one the case began against, and a record sealed against the pre-restart id would
describe only the first half of its own evidence.

**Container identity is not the *image* binding, and does not replace it.** A
restart legitimately recreates the container from the same image — the PID
changes and must be allowed to. The image object is what must not. Which
*running instance* produced the evidence is a separate question, answered
separately: see [One container epoch, start to finish](#one-container-epoch-start-to-finish).

The aggregate re-checks the continuity object rather than trusting it, including
recomputing `same` from the three ids, so it can state on its own authority that
no accepted record combines evidence from two images.

## One deployment state, start to finish

Image continuity is not enough for a case that spans a restart. The **same
authorized image** can come back with a different `YTDLP_ENABLED`:

```
pre-case          YTDLP_ENABLED=true
acquisition starts; operator restarts the SAME image
Worker returns with YTDLP_ENABLED=false
restart recovery succeeds · image continuity holds
   → an earlier version sealed `featureState: enabled`
```

That record combined two deployment states while claiming one, and nothing in
the image binding could catch it.

So every executable Stage B case measures the feature state on **both sides** of
the producer and refuses to seal unless it held:

```
measure pre-case state · validate it is the state this case requires
measure the authorized image
   │
   ▼  run the producer
   │
re-measure the image      → require the same object
re-measure the state      → require the same required state
   │
   ▼  only then seal
```

| Gate | Enabled cases | `kill-switch` |
| :--- | :--- | :--- |
| `YTDLP_ENABLED` semantic state, both sides | `enabled` | `disabled` |
| capability report, both sides | must not change | must not change |

The disabled *spelling* may differ between the two measurements — absent and
`"false"` are both disabled — because the semantic state is what the case
requires.

### What is deliberately **not** gated

A particular capability *value*. For `kill-switch`, `/api/sites` still reporting
`ytdlp: true` while the configuration is disabled is **not** a precondition
failure — it is the single most important finding that case can produce.
Refusing to run would convert *"the kill switch does not work"* into *"we did not
look"*, which is the exact inversion the harness exists to prevent. The
evaluator grades that conjunction from this same sealed evidence, as a `FAIL`.

So the gate asks two questions the case cannot be interpreted without — *was the
configuration the required one?* and *did the deployment move underneath us?* —
and leaves every value judgement to the evaluator.

`featureContinuity { before, after, sameRequiredState }` is sealed with the
record, and `validateCaseRecord` **recomputes** it: `sameRequiredState` is never
believed, and the canonical `featureState` must agree with the continuity it
claims.

## One container epoch, start to finish

Image continuity answers *which reviewed image?* Feature continuity answers
*which deployment configuration?* Neither answers **which running instance
produced this evidence** — and the unit is

```
ExecStartPre=-/usr/bin/docker rm -f videofetch-worker
ExecStart=/usr/bin/docker run --rm --name videofetch-worker … videofetch-worker:latest
```

so a Worker restart is a container **recreation**: a new container object, from
the same image, with the same environment file. Two endpoint measurements that
agree on image *and* feature state are therefore fully consistent with an
unnoticed restart having happened between them.

That is not a hypothetical. A `success` or `cancellation` case whose acquisition
window spanned one is two half-observations of two runtimes, reported as one
observation of one — and every negative claim it makes (no FFmpeg, no unknown
descendants, containment) was measured against a process tree that no longer
exists.

So every case is bound to a **container epoch**, recorded as `containerEpoch` on
the sealed record and recomputed by `validateCaseRecord`.

### Ordinary cases: one instance

```
docker inspect --format {{.Id}} videofetch-worker      ← before
   ▼  run the case producer
docker inspect --format {{.Id}} videofetch-worker      ← after
require before == after
```

| Outcome | Result |
| :--- | :--- |
| same instance before and after | sealed as `mode: "continuous"` |
| a different instance after | `BLOCKED — THE WORKER CONTAINER WAS RECREATED DURING THE CASE`, no record |
| the instance cannot be identified | `BLOCKED`, no record |

### `shutdown`: one pinned observed transition

`shutdown` exists to span an operator stop/restart, so one recreation is
intentional — and it is **pinned end to end** rather than merely permitted:

```
preCase instance      ==  the restart watcher's recorded old instance
restart new instance  !=  restart old instance
postCase instance     ==  the restart's new instance
```

| Outcome | Result |
| :--- | :--- |
| A → B, still B at sealing | sealed as `mode: "one-restart"` |
| A → B, then recreated as C | `BLOCKED — RECREATED AGAIN AFTER THE OBSERVED RESTART` |
| an unobserved recreation before the transition | `BLOCKED` |
| the watcher reports the same instance twice | `BLOCKED` — that is not a restart |
| any ordinary case recording a restart | `BLOCKED` — only `shutdown` may span one |

The transition the epoch pins must be the transition the case's **own** restart
evidence reports; two internally disagreeing copies of one observation are
refused rather than resolved in either direction.

### The restart watcher: the instance is the authority

The watcher polls the **container object id**, not the PID. Polling the PID was
wrong in both directions:

- **False negatives.** PIDs are not unique across container objects. A recreated
  Worker whose main process happens to receive the *same* pid was invisible to a
  PID comparison — the watcher timed out and reported that no restart occurred
  while one plainly had.
- **Incoherent endpoints.** The instance ids were sampled *around* the PID
  change rather than *with* it, so a transition recorded as `A → C` could be
  assembled from an A instance read that preceded a PID from B, and a later PID
  change that preceded a C instance read. None of those three observations was
  of the same runtime.

Each endpoint is therefore a **coherent runtime observation**, bracketed the same
way the deployment snapshot is:

```
containerInstanceId          ← open
containerPid
containerInstanceId          ← close; must equal the open value
```

If the instance moves inside the bracket the observation is **ambiguous** — not
"probably A". It is retried a bounded number of times, and exhaustion is a
measurement failure, never a pairing accepted on the last attempt. The record can
only ever say *container A had PID X* when one observation established both.

The PID stays in the evidence as auxiliary diagnostic data, bound to the instance
it was actually read from. It is never the authority for which transition
occurred.

### An observed epoch is never erased

The poll's own sighting is **evidence**, and the endpoint must be the same
object it saw:

```
poll measures a different instance      →  detectedInstanceId
establish the endpoint coherently       →  after.instanceId
after.instanceId  MUST EQUAL  detectedInstanceId
```

This is the line between two things that look alike and are not:

| What happened between the polls | May the record say `A → C`? |
| :--- | :--- |
| the container was **unavailable** — nothing was measured | **yes**; nothing is being discarded |
| an instance **was successfully measured**, and the endpoint settled elsewhere | **no** — `BLOCKED` |

In the second case the harness did not merely fail to see an intermediate epoch;
it *saw one*. Two distinct post-`A` epochs were positively measured, so no single
transition can be attributed to the restart, and reporting `A → C` would require
un-seeing a measurement that was actually made. A retry of the endpoint bracket
does not change that — a later, cleaner observation never overwrites an earlier
positive one.

The finding is:

```
AN ADDITIONAL WORKER RECREATION WAS OBSERVED WHILE ESTABLISHING THE RESTART
ENDPOINT: two different container epochs were positively measured after the
case began, so no single transition can be attributed to this restart
```

It names neither id — that two epochs were observed is the whole finding, and
printing them adds nothing an operator needs.

This is **not** a stronger claim about polling. The harness still cannot exclude
epochs it never saw, and does not try to. The rule is only:

```
an unobserved interval   →  do not claim what was in it
an observed epoch        →  do not erase it
```

### The deployment snapshot

The image, the feature state and the container instance are read as **one
bracketed snapshot** on each side of the producer:

```
containerInstanceId          ← open
imageShaTag
YTDLP_ENABLED + /api/sites
containerInstanceId          ← close; must equal the open value
```

Reading the three properties at three separate moments could not exclude the
sequence this exists to catch — the watcher observes B, the Worker is later
recreated as C, and the post-state is read from C while the record claims B. If
the bracket does not close on the instance it opened on, the snapshot itself
straddled a recreation and is a measurement failure, not a snapshot with one
stale field in it.

### What this does and does not claim

Endpoint equality is **not** continuous observation of every instant, and the
evidence language says only what is true:

- for an ordinary case — *the same container epoch surrounded the producer, and
  no recreation was observed within it*;
- for `shutdown` — *the watcher observed the deployment transition from the
  recorded old container epoch to the recorded new container epoch, and that
  epoch remained current through final evidence sealing*.

Polling does **not** prove that no transient intermediate container existed
between two polls, and nothing here says it does. An additional recreation that
*is* observed — the endpoint moving again before sealing — is `BLOCKED`. Proving
the stronger *"exactly one restart occurred in all possible instants"* would
require a continuous Docker event observer, which this harness does not have and
does not claim.

The **image** binding remains what ties the evidence to reviewed code. The epoch
only bounds the interval that evidence describes. A container id is non-secret —
a content-addressed object name carrying no environment, no argv and no
configuration — which is why it is safe to record.

## Measured means the command succeeded

A measurement-producing command's stdout is evidence **only if the command
exited zero**. A non-zero exit means the command failed, and a well-formed
buffer beside it was not measured — it is stale, truncated, or from a different
question entirely.

This is load-bearing rather than tidy, because the harness's assertions are
mostly **negative**. A `docker top` that fails while emitting a syntactically
perfect listing looks exactly like a clean one; a `workDir` probe that prints
`False` beside a non-zero exit fabricates the single most favourable answer it
could give; a `docker inspect` that prints a stale PID sends every containment
proof to the wrong process tree.

| Command | Non-zero exit means |
| :--- | :--- |
| `docker top … -o pid,ppid,pgid,comm` | the sample is unmeasured → sampler error → window `BLOCKED` |
| `docker inspect --format {{.State.Pid}}` | the Worker PID is unmeasured |
| `docker inspect --format {{.Id}}` / `{{.Image}}` / `{{.HostConfig.NetworkMode}}` | the scalar is unmeasured |
| `readlink /proc/<pid>/ns/net` | the namespace is `null`, which the evaluator reads as a **mismatch** |
| `python3 --version`, `node --version`, the EJS probe | the version is unmeasured |
| the `workDir` probe | presence is unmeasured — never "absent" |

The durable row is no longer in that table because it is no longer a command —
see [Durable state is read inside the Worker](#durable-state-is-read-inside-the-worker).

### Where a non-zero exit is the finding

Two commands are **status-as-data** and are deliberately unchanged:

- `systemctl is-active <unit>` — it exits non-zero *because* the unit is
  inactive, and inactive is the property under test;
- `/usr/local/sbin/vf-egress-policy-verify` — the exit code **is** the verdict.

Turning either into `BLOCKED` would convert a finding into a refusal, which is
the inversion the harness exists to prevent.

## Raw evidence is validated before it is normalized

A `comm` field is judged **as it arrived**. The check is *"is this already a
plain basename?"*, not *"does it reduce to one?"*

```
raw matches ^[\w.:+-]{1,64}$   →  lowercase it, keep it
otherwise                      →  keep the row, name it <unclassified>
```

Normalizing first was a laundering step. `basenameOf("suspicious/python3")` is
`"python3"`, which is an **approved yt-dlp runtime shape** — so an executable the
harness had never approved acquired the identity of one it had, stopped being an
unknown descendant, and became a candidate to be graded as the owned acquisition
process. The check that exists to catch an out-of-band executable was the check
that gave it cover.

| Raw `comm` | Recorded as | Effect |
| :--- | :--- | :--- |
| `python3`, `node` | verbatim | approved |
| `ffmpeg` | verbatim | **FAIL** `process.no-ffmpeg-during-downloading` |
| `foo/python3` | `<unclassified>` | **FAIL** `process.no-unknown-descendants` — never `python3` |
| `/usr/bin/ffmpeg` | `<unclassified>` | **FAIL** unknown — never `ffmpeg` |
| `foo/node` | `<unclassified>` | **FAIL** unknown — never `node` |
| `python3 --something` | `<unclassified>` | **FAIL** unknown |
| `some odd thing` | `<unclassified>` | **FAIL** unknown |

Paths are not stripped, unusual names are not trimmed into approved ones, and the
row is **never dropped**. The raw text is not copied into evidence either.

## The acceptance run key is created atomically

`stat` → `ENOENT` → `writeFile` is a check followed by an unguarded write, and
everything the harness guarantees about never replacing an existing run key lives
in the gap between the two. Two Stage A invocations started together both see
`ENOENT`, both write, and the second silently destroys the key the first has
already begun sealing artifacts with.

Creation therefore uses `flag: "wx"` — an exclusive create that **fails rather
than truncates**.

| Outcome | Result |
| :--- | :--- |
| the path is free | minted, `0600`, `runId` 16 hex, key 64 hex |
| another process won the race | `BLOCKED`; the winner's file is untouched and un-`chmod`ed |
| any other creation failure | `BLOCKED`, no key handed back |

Losing the race is `BLOCKED`, **not** "load the winner instead": the winner's
`runId` is the identity of a run this invocation did not begin and whose Stage A
binding it has not verified. Adopting it silently would be exactly the resumption
the operator is required to make deliberately. Inspect the existing run identity
and re-run Stage A if it is the one you want.

### The run identity is admitted by type

`runId` must **be a string** of 16 lowercase hex characters, and `key` must **be
a string** of 64. Coercion is never a route in:

```
{ "runId": 1234567890123456, "key": "<64 hex>" }
```

Its string form matches the grammar exactly, so a coercing test admitted it — and
`verifyRecord` then compares a string against a number, making every artifact of
the run unverifiable for a reason nothing reports. The harness mints
`randomBytes(…).toString("hex")`, so requiring the type is requiring what it
actually produces.

## The restart-recovery contract

`shutdown` makes two independent claims, and neither may stand in for the other:

| Claim | Evidence |
| :--- | :--- |
| the old acquisition group died | host survivors of the captured PGID |
| the interrupted job was recovered correctly | the durable row, through the job view |

A dead process group says nothing about the durable row, and a correct durable
row says nothing about whether the process died.

The Worker's restart policy is **deterministic**. `recover()` in
`src/worker/state/sqlite-job-store.server.ts` moves every job left in
`analyzing`, `downloading`, `processing` or `uploading` to exactly:

```
status             = failed
error_code         = PROCESSING_FAILED
safe_error_message = Worker restarted before the job completed.
```

It is not resumed, not `ready`, and not `cancelled`. So acceptance asserts that
result, not a shape. The previous check accepted any non-empty status string —
under which `ready`, `cancelled`, and a job still sitting in `downloading` all
passed a check named `job-recovered`.

**The safe message is asserted, not skipped as brittle.** It is a literal in the
Worker's own SQL, not a formatted or localized string, and it is the only field
that separates *the restart path recovered this job* from *the job failed on its
own and was classified `PROCESSING_FAILED`* — which every internal acquisition
failure is. Without it, a job that failed a moment **before** the restart would
satisfy the check. The harness reads it through the browser projection `error`,
which `src/web/jobs/public-job.ts` documents as where `safeErrorMessage`
surfaces.

Recovery is **polled within a bounded window**, not read once. The restart is
detected the instant the new container's PID appears — well before the Worker has
opened its database, run `recover()`, and begun answering HTTP. A window that
expires without a terminal answer is a measurement failure and the case aborts.

## Attributing an egress denial to the boundary

Phase 9 established the standard, and `counter.py` states it exactly: *a
connection that fails while `deny-v4` increments was denied BY THE FIREWALL,
whereas a connection that fails while every counter stays flat was denied by
something else — most often a missing route.*

So the safe-egress case reads the **actual nftables deny counter** before and
after, through one allowlisted read-only listing:

```
nsenter -t <media-netns pid> -n nft -j list chain inet videofetch_egress output
```

| Observation | Outcome |
| :--- | :--- |
| Request failed **and** the deny counter moved | `PASS` candidate |
| Request failed, counter flat | `FAIL` — something other than the boundary stopped it |
| Counter unreadable | `BLOCKED` |
| Ruleset fingerprint changed across the run | `FAIL` |

The case also proves the forbidden destination was reached through the
**generic** path (`extractor: yt-dlp`). A submitted URL that simply redirects to
a private address is not this test: the control plane's own SSRF guard rejects it
long before generic is reached, so the case would "pass" while proving only that
the direct layer works. The fixture's *secondary media destination* is the
forbidden one.

The policy fingerprint hashes the normalized chain JSON with counters stripped.
An earlier version combined the policy unit's systemd `InvocationID` and
activation timestamp — which describe the *unit's lifetime*, not the rules: a
rule changed by hand while the unit kept running would leave both identical.

### The deny class is a closed enum, not a free-form comment

`--egress-deny-class` is parsed against the deploy-time policy's **actual deny
rules**, at argument-parse time, before anything live happens:

| Accepted | The rule it names |
| :--- | :--- |
| `deny-v4` | `ip daddr @forbidden_v4 counter reject` |
| `deny-v6` | `ip6 daddr @forbidden_v6 counter reject` |
| `deny-v4-broadcast` | `ip daddr 255.255.255.255 counter reject` |

Choose the class the **fixture family** is expected to trip — a private-IPv4
destination trips `deny-v4`, a forbidden IPv6 one `deny-v6`, a broadcast one
`deny-v4-broadcast` — not whichever counter happens to be moving.

Everything else in the chain is refused with a usage error, including every
comment that looks plausible:

| Refused | Why |
| :--- | :--- |
| `public-http` | an ACCEPT rule; its counter moves on every ordinary media fetch |
| `established` | an ACCEPT rule; its counter moves on essentially every response |
| `designated-dns-udp` / `-tcp` | ACCEPT rules for the designated resolver |
| `fallthrough-drop` | the chain's catch-all policy counter — it attributes nothing to a rule |
| anything else | not a rule in the deployed policy at all |

The previous list was free-form, and additionally named three classes
(`deny-v4-mapped`, `deny-multicast`, `deny-link-local`) that do not exist in the
deployed ruleset — those destinations are *elements inside* `@forbidden_v4` and
`@forbidden_v6`, and increment `deny-v4` / `deny-v6`.

## Proving the application byte watcher, not `--max-filesize`

The property is about the **actual progressive media GET** that yt-dlp selected,
not about the page that was submitted.

An earlier version did `HEAD` on the submitted URL. That is the wrong request: a
page with no `Content-Length` whose media resource declared one would have
passed, while being caught by `--max-filesize` — evidence for the wrong gate
entirely.

The harness cannot see which media URL yt-dlp chose without breaching the
private-selector boundary, so the controlled fixture reports the transfer
semantics of the media GET it actually served, via
`VIDEOFETCH_ACCEPT_BYTELIMIT_EVIDENCE_URL`.

### The evidence must belong to this case

Asking a fixture "did you serve a media request?" is not evidence about *this*
transfer. A static endpoint answering `{"actualMediaRequestObserved": true}`
satisfied that question, and so did an answer left over from an earlier run.

So each byte-limit run **mints a 128-bit correlation id**, submits it on the
fixture URL as `vf_case`, and requests the fixture's evidence for exactly that
id. The token is not a credential — it grants nothing and authenticates nothing
— which is why it may appear in the sanitized record.

```
caseId                     == the id this run minted
actualMediaRequestObserved == true
mediaRequestCount          == 1          (zero is not this transfer;
                                          several cannot be told apart)
contentLengthPresent       == false
transferMode               : chunked
bytesServed                : the bytes the fixture actually served
```

### The threshold must actually have been crossed

`TOO_LARGE` alone says a job failed; it does not say the **application byte
threshold** was reached. So the case also measures the limit the *deployed*
Worker enforces, and requires the transfer to exceed it:

```
effectiveMaxFileSizeBytes  : read from the deployment's own MAX_FILE_SIZE
                             (absent -> the Worker's 500 MiB default)
bytesServed > effectiveMaxFileSizeBytes
```

The limit is read from the single non-secret deployment variable via
`docker inspect`, parsed with the runtime's own grammar — no environment file is
opened, and no other value is extracted. Inferring the limit from source would
be wrong whenever a deployment overrides it: a 600 MB transfer proves nothing
against a 1 GiB limit, and proves everything against a 1 MiB one.

The case fails if `contentLengthPresent` is true (then `--max-filesize` could
have been the mechanism), fails if the fixture analyzed as `direct`, fails if
the bytes served did not exceed the deployed limit (invalid fixture, not
acceptance evidence), and is `BLOCKED` — `LIVE UNKNOWN-LENGTH BYTE-GUARD CASE
NOT PROVEN` — if the correlation, the media request, or the effective limit
cannot be established at all.

## The direct regression is a negative claim too

`direct.no-ytdlp-spawned` asserts that **no yt-dlp process appeared** while a
direct job ran with generic enabled. That is a claim across the whole monitored
run, so it obeys the same rule as the generic downloading window:

```
unobserved interval  !=  clean interval
```

Every failed sampling attempt is accumulated in `samplingErrors`, and **one is
enough** to make the coverage claim `BLOCKED` — even with hundreds of clean
samples on either side of it. Clean samples do not describe the gap between
them.

The previous code held a single nullable `samplingFailure` that the next
successful sample overwrote with nothing, so a run that lost an interval looked
identical to one that never did. The successful samples stay in the evidence;
they simply cannot support a continuous absence.

### A gap must not erase a finding

The case makes **two independent claims**, and they are graded separately:

```
A. was the run continuously observable?      -> coverage
B. did any observed sample contain yt-dlp?   -> the finding
```

|  | no gap | gap |
| :--- | :--- | :--- |
| **no yt-dlp seen** | `PASS` + `PASS` | `BLOCKED` + `BLOCKED` |
| **yt-dlp seen** | `PASS` + `FAIL` | `BLOCKED` + **`FAIL`** |

An earlier version routed both through one gate, so a single failed attempt
downgraded a positively observed yt-dlp process to `BLOCKED` — turning the
strongest evidence the case can produce into uncertainty. A process seen in a
successful sample *was seen*, whatever happened in some other interval.

`FAIL` outranks `BLOCKED` in the summary, so the bottom-right cell fails the
run, which is the honest reading: something bad happened **and** we could not
see all of it.

The finding is derived only from **successful samples**. An error message is
never mined for evidence of a process — a failed attempt observed nothing by
definition.

## Generic-specific cases must actually run generic

`success`, `cancellation`, `byte-limit`, `shutdown` and `safe-egress` each assert
`extractor === "yt-dlp"` before producing evidence. An operator-supplied
"generic URL" that resolves as `direct` would exercise the pre-existing direct
path — already accepted in Phase 9 and runbook §11c — and prove nothing about
generic acquisition.

## Measurement failure is not a finding

Every producer distinguishes three states. None of them invents a favourable
value on failure, because "we could not look" and "we looked and it was clean"
are different findings and only one is evidence.

| Surface | Unavailable | Measured negative | Measured positive |
| :--- | :--- | :--- | :--- |
| R2 object evidence (Worker job view) | `BLOCKED` | `FAIL` | `PASS` |
| Per-job workDir probe | `BLOCKED` | `FAIL` (present) | `PASS` (absent) |
| Post-cancellation process sample | `BLOCKED` | `FAIL` (survivors) | `PASS` |
| Direct-regression process sampling | `BLOCKED` | `FAIL` (yt-dlp seen) | `PASS` |
| Downloading window | `BLOCKED` | `FAIL` | `PASS` |
| Any sentinel surface | `BLOCKED` | `FAIL` (leaked) | `PASS` |
| Durable job row | `BLOCKED` | `FAIL` | `PASS` |

An earlier draft returned `objectExists: true` when the Worker job view could not
be read (because the job was `ready`), `sampledBasenames: []` when the sampler
failed, `postSample: []` after a failed post-cancel sample, and `""` for an
unreadable log. Each of those turned an inability to measure into a clean result.

## What the live checks actually claim

The harness states only what it observed, and leaves source-reviewed invariants
where they belong.

| Claim | Where it is proven |
| :--- | :--- |
| The router is direct-first | **Source review** of the canonical router |
| The generic source selected `yt-dlp` | **Live** — `analysis.generic-selected` |
| A direct control source still selected `direct` | **Live** — `analysis.direct-still-selected` |
| Those observations came from the reviewed code | The exact-image binding |
| The selector's internal constraints | **Offline** — `verify-selector.py`, against the pinned parser |
| The delivered artifact matches the accepted preset | **Live** — `delivery.matches-advertised-preset` |
| Delivered length == durable `fileSize` == provider `contentLength` | **Live** — `vercel.byte-integrity` |
| The delivered bytes' SHA-256 | **Live**, recorded |
| An *independent* digest of the Worker-produced object | **Only for the direct fixture**, whose digest the harness derives itself |
| Generic worked **while it was enabled** | **Live**, from the `success` record's sealed feature state |
| The kill switch worked **while it was disabled** | **Live**, from the `kill-switch` record's sealed feature state |
| This exact transfer crossed the byte threshold | **Live** — case-correlated fixture evidence vs. the deployed `MAX_FILE_SIZE` |
| The firewall denied this connection | **Live** — one closed, genuine deny-rule counter moved |
| The old process group has no survivors | **Live** — and only after every host process row was assigned to a group |
| The interrupted job was recovered per the restart policy | **Live** — `failed` / `PROCESSING_FAILED` / the deterministic restart message |
| The case ran against one image, start to finish | **Live** — image resolved before and after the producer |
| The case ran in one deployment state, start to finish | **Live** — feature state measured before and after the producer |
| No yt-dlp appeared during the direct job | **Live** — and only across a run with zero sampling gaps |

The internal direct→generic fall-through for the generic URL is **not**
observable at the application boundary, and adding a surface to observe it would
be the debug endpoint this design forbids. So no check says it was observed.

Likewise, a container comparison is not proof of the private selector, and a
digest of the client's bytes is not an independent measurement at the Worker
boundary. The check names say which is which.

## Durable state is read inside the Worker

The durable observer used to shell out to `sqlite3`. It named three things, and
was wrong about all three:

| | It said | The deployment says |
| :--- | :--- | :--- |
| database | `/var/lib/videofetch/videofetch.db` | `/var/lib/videofetch/worker.sqlite` |
| table | `jobs` | `worker_jobs` |
| access | the `sqlite3` executable | not installed on the VM |

That is worse than a bug in a check, because of what it looks like from the
outside. Every `durable.*` claim and the sentinel's `durable-row` surface would
have reported `BLOCKED` on a perfectly healthy deployment, and the reason would
have described the instrument rather than the system under test — which is the
one confusion the whole fail-closed design exists to prevent. `BLOCKED` is
supposed to mean *we could not measure this deployment*, not *we were never
able to measure any deployment*.

### Why the read does not happen on the host

The first correction read the database from the host with `node:sqlite`. That
removed the `sqlite3` dependency and quietly introduced two worse ones:

```
the Phase-10D Lima host runs Node v18.19.1  ->  no node:sqlite at all
/var/lib/videofetch is 0700, owned by uid 1000  ->  host needs privilege
```

Trading one unmet host prerequisite for another is not remediation. **A tool
that needs the deployment changed before it can measure it has not measured
it.**

The runtime that can already do this ships *with* the deployment:

```
/usr/local/bin/node    in the reviewed Worker image     Node v22.23.2
node:sqlite            present, and needs no flag
/var/lib/videofetch    already mounted, already owned by the Worker's uid
```

So the read happens there, under the Worker's own runtime identity, and the
host is left needing nothing it does not already have: no SQLite, no database
permission, no `sudo`, and no Node newer than the VM's.

### One fixed question, not a shell

```
docker exec videofetch-worker /usr/local/bin/node -e <fixed probe> <32-hex job id>
```

```js
new DatabaseSync("/var/lib/videofetch/worker.sqlite", { readOnly: true })
  .prepare("SELECT job_id, status, format_id, extractor FROM worker_jobs WHERE job_id = ?")
  .get(jobId)
```

The probe source is a **compile-time constant matched whole** by the allowlist —
the same discipline CORRECTION-05 applied to the environment probes. `docker
exec … node -e` is therefore not a general execution capability; it is one
question with one dynamic token.

| Refused | Why |
| :--- | :--- |
| any other `-e` script, including the probe plus one statement | not the constant |
| `--eval` instead of `-e` | shape must be exact |
| `node` instead of `/usr/local/bin/node`, or a traversal path | the interpreter is fixed |
| `/bin/sh`, `/usr/bin/env` | no shell, no indirection |
| a different database, table, or column list | all three are inside the constant |
| `SELECT *` or a projection containing `url` | same |
| a job id that is not 32 lowercase hex | the one dynamic token stays bounded |
| any extra argument | shape must be exact |

Refusal happens before a process is spawned.

- **The filename and table are the deployment's, not the harness's.** They are
  restated here because the harness is standalone `.mjs` on the VM host and
  cannot import the Worker's TypeScript constants — so the test suite
  cross-checks each restatement against the source that defines it
  (`WORKER_DATABASE_FILENAME` in `state-directory.server.ts`, `CREATE TABLE
  worker_jobs` in `migrations.server.ts`). A restated constant with a
  cross-check is a contract; without one it is the defect above.
- **The job id is bound, not interpolated.**
- **`url` is never selected.** That is a projection, not a post-filter: the
  column holds the acceptance URL and, during the sentinel case, the sentinel.
  Fetching the row and deleting the field afterwards is the "fetched, then
  sanitized" pattern CORRECTION-05 removed from the environment probes.
- **`readOnly: true` is explicit.** Not because the probe only runs a `SELECT`,
  but because an open writable handle to the live Production database is a
  capability whether or not it is used — and SQLite *creates* a missing file
  when opened writable, which would fabricate an empty durable database at the
  exact path the acceptance is trying to measure.
- **`sqlite3` is gone from the allowlist**, not merely unused.

### The closed response

The probe answers with one of exactly three shapes, and catches its own
failures so that no raw SQLite message, stack, path, SQL or argv can cross the
`docker exec` boundary at all:

```json
{"kind":"row","jobId":"…","status":"…","formatId":"…","extractor":"…"}
{"kind":"absent","jobId":"…"}
{"kind":"error","code":"database-open-failed|query-failed|probe-runtime-failed"}
```

Stdout is size-bounded, and anything the parser cannot fully account for — an
unknown `kind`, an unexpected key, a mismatched job id, unparseable JSON — is a
measurement failure. Nothing is partially trusted.

The probe exits `0` whenever it produced a closed response, *including* its
error kinds. That keeps CORRECTION-07's rule intact rather than bending it: a
non-zero exit means the probe did not run, and its stdout is not evidence of
anything. The outcome lives in `kind`, inside a response the process
successfully produced.

### An absent row is a measurement

| Observation | Result |
| :--- | :--- |
| the probe ran and the row matched | **measured** — `durable.row-present` `PASS` |
| the probe ran and proved the row absent | **measured** — `durable.row-present` **`FAIL`** |
| the database could not be opened | unmeasured → `BLOCKED` |
| the query failed | unmeasured → `BLOCKED` |
| the response could not be interpreted | unmeasured → `BLOCKED` |

The second row is the one worth stating plainly. A successful query that proves
the expected row is not there **is a measurement**, and the durable ladder is
the Worker's own record of a job the harness watched reach `ready` — so its
absence is a defect in the deployment, not a gap in observation. Reporting it as
`BLOCKED` would say *we could not look* about the one case where we looked and
found something wrong.

Row **presence** is therefore graded on its own, by `durable.row-present`. The
three content checks — `durable.extractor-is-ytdlp`,
`durable.application-format-id`, `durable.no-raw-selector-fields` — are claims
*about a row*, so when the row is provably absent they report that there is
nothing to judge rather than each manufacturing its own version of the same
finding. `FAIL` outranks `BLOCKED`, so the case verdict is `FAIL`, which is the
honest reading: something is wrong, and it is named once.

An unreadable database and an absent row never share a story. The old CLI
parser could not tell them apart at all — empty stdout became "no row", so a
missing table and a missing job looked identical.


## Privacy controls

### Redaction

One implementation, `lib/redact.mjs`. The CLI logs through
`createSafeConsole(...)`, so console output crosses the boundary
**structurally** rather than by every call site remembering to pre-redact — and
the needle list is read at call time, so a secret registered mid-run (the
sentinel, the Worker control secret) protects output that was already wired up.

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

The `success` case — in the real CLI code path, not only in the specification —
mints `VF_ACCEPT_SECRET_<random>` (a random marker, **never a real credential**),
places it in a benign query parameter of the submitted URL, and submits it
through the application surface. It must then appear in **none** of these six
surfaces, each with a real observer:

| Surface | Observer |
| :--- | :--- |
| `worker-journal` | `journalctl -u videofetch-worker` |
| `container-output` | `docker logs videofetch-worker` |
| `cloudflared-journal` | `journalctl -u vf-cloudflared` (`--cloudflared-unit` to rename) |
| `durable-row` | the projected durable job row |
| `job-metadata` | the API's own job document |
| `api-error` | a **genuine 404 error body**, obtained by requesting a job id that cannot exist |
| `object-metadata` | the authenticated Worker job view |

**A surface that cannot be read makes the sweep unmeasured**, which lands
`privacy.sentinel-not-leaked` as `BLOCKED`. An earlier draft substituted `""`
for an unreadable surface, turning "could not read the logs" into "the sentinel
is absent from the logs". `api-error` is also a real error body now, not a
successful status response relabelled as one.

The final record is checked **before** it is written: if the scrubber had to act,
the run is `BLOCKED`. The scrubber is a disclosure backstop, never evidence that
upstream handling was clean.

**The harness never prints the sentinel**, and never writes it to the record —
only the sweep's verdict and the surface names.

### Secrets

The record states whether required configuration **exists**, as a boolean or a
bare variable name. It never contains `WORKER_CONTROL_SECRET`, the R2 parent
secret, temporary R2 credentials, Cloudflare Access or Tunnel credentials,
Vercel signer credentials, session cookies or authorization tokens — and
`/etc/videofetch/worker.env` is never dumped or even read.

#### A secret value is never *retrieved*, not merely never printed

`docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}'` returns the
complete `NAME=value` environment. An earlier version of this harness ran exactly
that and then split the values off in JavaScript — so every Worker secret crossed
into the harness process, lived in a Node string and in a child process's stdout
buffer, and was discarded only afterwards. *Fetched, then sanitized* is not
*never fetched*.

Environment observation is now three fixed, separately allowlisted probes, each
answering one question:

| Observer | Probe | Output contract |
| :--- | :--- | :--- |
| `environmentNames` | `python3 -c '…sorted(os.environ)…'` | one **name** per line. No `=`, no value, no length, no hash |
| `ytdlpEnabledRaw` | `python3 -c '…environ.get("YTDLP_ENABLED")…'` | `<UNSET>` or `SET:<value>` |
| `effectiveMaxFileSize` | `python3 -c '…environ.get("MAX_FILE_SIZE")…'` | `<UNSET>` or `SET:<value>` |

Two structural properties, not two conventions:

- **The variable name is inside the constant.** Each probe's source string is a
  compile-time constant matched *whole* by the `docker exec` allowlist, so no
  argument the caller supplies can redirect the read to a different variable.
  There is no general Python execution capability — only three fixed questions.
- **`docker inspect` is restricted to three named templates** (`{{.Image}}`,
  `{{.HostConfig.NetworkMode}}`, `{{.State.Pid}}`). A bare `docker inspect`, and
  every environment template, is refused. Retrieving the environment that way is
  unrepresentable rather than merely unused.

`MAX_FILE_SIZE` and `YTDLP_ENABLED` are non-secret deployment configuration; the
byte-limit comparison and the feature-state gate are numeric and grammatical
assertions that cannot be made against a name alone.

`SET:` rather than a bare value because a bare sentinel is ambiguous: a variable
literally set to `<UNSET>` would be indistinguishable from an absent one, and for
`YTDLP_ENABLED` that ambiguity resolves silently to "disabled".

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


---

## The first authenticated Stage-A run — FAILED

Run `5e6670a858543d93`, schema `10d-remediation-01`, against the reviewed Worker
image `sha256:b7b7554c…62b5` deployed at
`4a537e3cb7403801f39a706ce7bed896c0fe11f7`.

```
verdict   FAIL
PASS      16
FAIL       1   worker.network-mode
BLOCKED    6   runtime.ytdlp-version, runtime.bundled-ejs,
               capability.implemented, capability.generic-not-usable,
               worker-env.forbidden-absent, worker-env.required-present
```

**Stage A has NOT passed. Generic execution remains disabled. Stage B remains
unauthorized.** The sealed artifact is retained, unmodified, as history.

### What actually worked

The product path did. `direct.regression-ready` and `direct.byte-integrity` both
passed: a real direct-media job reached `ready`, and the bytes delivered through
the signed GET matched the controlled fixture exactly — 48497 bytes,
`44827ff84f50036186a34e7d487ae13afab6934d0b6d17009f5dcf386cd81bdd`. All seven
services, the safe-egress verifier, image identity, the `latest` alias, Python
3.11, Node v22 and `YTDLP_ENABLED` disabled all passed too.

That matters for reading the rest: transport, HMAC, Cloudflare routing and the
Worker's job contracts were all demonstrably healthy.

### Two harness defects — the instrument, not the deployment

**`worker.network-mode` compared against a string Docker never emits.** The
check required `NetworkMode === "container:videofetch-media-netns"`, but
`--network container:<name>` is resolved at creation time and stored as the
target's canonical 64-hex id. A correctly placed Worker therefore failed. It now
proves the property from two independently measured identities that must agree —
the Docker target id versus `videofetch-media-netns`'s own id, and
`readlink /proc/<pid>/ns/net` for both containers — and fails closed on
`bridge`/`host`/`none`, a wrong target, a stopped namespace holder, an
unreadable link, or differing namespaces.

**`runtime.bundled-ejs` asked for an attribute the package does not expose.**
The probe imported `yt_dlp_ejs.__version__`; pinned EJS 0.8.0 exports only
`version` (`__all__ = ["version"]`). The probe's own `ImportError` was reported
as the runtime being unavailable. Measured against the reviewed image,
`__version__` is absent and `version` is `0.8.0`.

**A third defect the run also exposed:** both `worker-env.*` checks ran a probe
whose Python source was a `SyntaxError`. A JavaScript `'\n'` is a real newline,
so the interpreter received a `"` literal split across two physical lines. The
environment names were never read at all. The separator is now escaped so Python
receives its own newline escape.

All three had passed review because the tests mocked them with idealized values.
The regressions now EXECUTE: a real pair of namespace-sharing Docker containers,
a real Python interpreter, and the real reviewed image.

### `/api/diagnostics` and `/api/sites` 500

Five of the six BLOCKED checks trace to those two endpoints failing under an
authenticated session.

> **CONTROL-PLANE SOURCE SKEW — STRONGLY SUPPORTED, DEPLOYED SOURCE IDENTITY
> NOT DIRECTLY ATTESTED.** This is the leading root-cause diagnosis, not an
> attested one. Vercel does not expose a source revision for this CLI-created
> deployment, and no runtime evidence tying the observed 500 to a schema
> rejection was obtained, so the failing bundle has not been shown to contain
> the historical parser.

The hypothesis, and what is actually established:

```
new Worker /v1/diagnostics  →  {binaries, runtime, features,
                                safeEgress{enforcement, policyVersion}}
        ↓
Production-era WorkerClient strict WorkerDiagnosticsSuccessSchema
   (no `runtime`, no `features`, requires `safeEgress.attested`)
        ↓  ZodError
getWorkerClient().diagnostics() rejects
        ↓
/api/diagnostics → safe 500
/api/sites       → loadSites() calls diagnostics() → safe 500
```

**Established.** `src/shared/worker/contracts.test.ts` proves executably that
the two contracts are mutually incompatible: today's Worker response satisfies
today's schema — the Worker parses its own response with that same module before
sending it, so a same-commit control plane *cannot* fail on it — while the
historical schema rejects it on unrecognized keys and a changed `safeEgress`
shape. The direct path passing rules out transport, auth and routing.

**Corroborating.** The deployment was created **2026-08-30 23:10**; the contract
change (`506b1b62`) landed **2026-09-02 12:26**.

**Not established.** Which source revision the failing deployment was actually
built from. `vercel inspect` exposes no Git metadata for it, and the live
rejection itself was not observed. A compatibility proof is not an incident
proof.

Closing that gap needs either sanitized Vercel runtime evidence naming the Zod
rejection, or deployed-bundle metadata identifying the revision — neither of
which is a precondition for the harness corrections in this PR.

**No backward-compatibility parsing was added.** Aligning Vercel Production is a
separate, later, authorized task.

### The schema moved to `10d-remediation-02`

Because `worker.network-mode`, `runtime.bundled-ejs` and both `worker-env.*`
checks now mean something materially stronger. The sealed
`10d-remediation-01` record is refused by `verifyRecord` on the version boundary
alone, independently of its FAIL verdict.

### The corrected retry uses a FRESH acceptance run

Never overwrite run `5e6670a858543d93`. Use new paths, for example:

```
~/vf-phase10d-acceptance/remediation-02/.vf-acceptance-run.json   (0600)
~/vf-phase10d-acceptance/remediation-02/stage-a.json
```

with the containing directory at `0700`.
