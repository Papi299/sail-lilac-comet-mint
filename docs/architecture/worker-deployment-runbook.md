# Worker Deployment Runbook (Phase 8B contract)

Provider-neutral deployment contract for the standalone VideoFetch Worker.

This document describes the invariants a Phase-8B deployment **must** satisfy.
It deliberately names **no** hosting provider, region, account id, bucket name,
hostname or credential. The host/provider decision belongs to Phase 8B and is
made by the Product Owner, because it determines persistent-volume semantics,
TLS termination, external egress enforcement, network-namespace ownership and
R2 placement/jurisdiction.

**Status: the Phase-8B final stack is LIVE and Phase 9 acceptance PASSED on
2026-08-30.**

The reconciled deployment artefacts in `deploy/` are installed and running on
the local Lima VM, and the Phase-9 safe-egress acceptance suite was executed
against that exact live topology at `a68243868bafeb88125eccca9344ea6751a76cf5` — in the
normal host-network state and again with the operator's NordVPN client actively
connected. The full record, including what was measured directly and what rests
on operator attestation, is in §11a.

Precisely:

- The **final units — seven of them** — are installed, enabled and active on the
  Lima VM (`videofetch`, Ubuntu 24.04 ARM64 on Apple silicon):
  `videofetch-media-dns`, `videofetch-media-netns`, `videofetch-egress-policy`,
  `videofetch-egress-watchdog`, `videofetch-r2-broker`, `videofetch-worker` and
  `vf-cloudflared`. `videofetch-media-dns` joined them with
  `PRODUCTION-DNS-RESOLVER-001` (§11b); the Phase-9 record in §11a correctly
  describes six, because six was the count during that measurement. The older
  prototype units (`vf-anchor`, `vf-policy`, `vf-worker`, `vf-watchdog`) remain
  present as unit files but are disabled and not running.
- The safe-egress boundary was accepted **in situ**: every forbidden destination
  class was denied, denials were attributed to named nftables rule counters, and
  permitted public traffic succeeded. See §11a.
- Phase 9 acceptance is a **local-deployment** result covering the safe-egress
  boundary. It does not by itself assert anything about the ingress path, Vercel
  environments or DNS operability, which are tracked by their own gates in §11.
- **Production name resolution is deployed and verified.** The Phase-9 DNS cases
  passed against an acceptance-owned resolver that its cleanup removed, leaving
  the configured designated resolver with no listener — a functional readiness
  gap, never a safe-egress bypass. `PRODUCTION-DNS-RESOLVER-001` is now
  **CLOSED**: a durable `systemd-resolved` stub listener and a readiness gate
  were deployed, and hostname resolution was verified in the live Worker after a
  fresh boot. The designated address and the nftables policy are unchanged. See
  §11b.
- **The production direct-media end-to-end path is PROVEN.** On 2026-08-30 a
  real job submitted through authenticated Vercel Production reached the Worker
  over Cloudflare Access and the named Tunnel, executed the `direct` extractor,
  uploaded to R2 through the trusted broker, and was served back by Vercel's
  separate signed-GET identity byte-identically. It was blocked until that day
  by `WORKER-TEMP-TMPFS-OWNERSHIP-001`, a runtime mount-ownership defect that is
  now fixed and deployed. See §11c.
- **Phase 10 has begun in the repository only, and is NOT DEPLOYED.**
  `PHASE-10C1-YTDLP-RUNTIME-FOUNDATION-001` added a pinned yt-dlp runtime to the
  Worker **image definition** and retired the `YTDLP_NETWORK_ISOLATED` contract.
  Nothing was deployed: the live Worker still runs the previously built image,
  and **no user-supplied URL can reach yt-dlp in any build** — there is no
  generic analyze or download path in the Worker at all. See §4.

---

## 1. Topology

| Invariant | Requirement |
| :--- | :--- |
| Replica count | **Exactly 1.** Horizontal autoscaling is not supported. |
| Durable state | One persistent volume mounted at `WORKER_DATA_DIRECTORY`. |
| Volume sharing | The SQLite volume MUST NOT be mounted read/write by a second replica. |
| Ephemeral storage | Writable scratch at `TEMP_DIRECTORY`, discarded freely. |
| Ingress | A TLS endpoint reachable by Vercel. See §1a. |

The single-worker invariant is architectural, not incidental: durable job state
is worker-local SQLite, and the cancellation/idempotency contracts assume one
writer. A second replica sharing the volume corrupts both.

### 1a. Ingress

The provider-neutral requirement is unchanged: **a TLS endpoint reachable by
Vercel, with the Worker never exposed directly to the Internet.** The selected
realization is a Cloudflare Access + Tunnel path onto a dedicated Linux VM:

```
Browser
  → Vercel (private access, WorkerClient, HMAC signing, R2 GET signing)
  → HTTPS
  → Cloudflare Access            (Service Auth policy + service token)
  → named Cloudflare Tunnel
  → cloudflared inside a dedicated Linux VM
  → http://127.0.0.1:<WORKER_PORT>  (VM-local only)
  → Worker container
```

| Invariant | Requirement |
| :--- | :--- |
| Router port forwarding | **None.** `cloudflared` makes only outbound connections. |
| Direct Worker Internet exposure | **None.** The listener is published on VM loopback only. |
| LAN exposure | **None.** No host or LAN interface binding. |
| Hostname | **Stable.** `WORKER_BASE_URL` is a static control-plane value, so an ephemeral `*.trycloudflare.com` quick tunnel is not usable — a named tunnel on a zone the operator controls is required. |
| Inbound to Vercel | **None.** The Worker never initiates a connection to the control plane. |
| Transport | Ordinary HTTPS request/response. No WebSocket is required: job creation is fire-and-forget and progress is polled. |

Any equivalent topology satisfying the invariants above is acceptable. The
provider names describe the selected deployment, not a hard dependency of the
Worker image.

### 1b. Authentication layers

Two independent layers guard the authenticated Worker routes, and **both** must
pass:

| Layer | Owner | Credential | Verified by |
| :--- | :--- | :--- | :--- |
| 1 — transport admission | Access proxy | `CF-Access-Client-Id` / `CF-Access-Client-Secret` | The access layer, before traffic reaches the tunnel |
| 2 — request authenticity | VideoFetch | `WORKER_CONTROL_KEY_ID` / `WORKER_CONTROL_SECRET` HMAC | The Worker itself |

They are deliberately independent:

- The Access service token is **configured and stored on Vercel only**, as
  `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET`. The Worker
  never reads them from its environment, and the Worker application does not
  consume, verify, persist or intentionally log them.

  > **Established and accepted.** Whether Cloudflare Access strips the two
  > request headers before forwarding to the origin was measured externally
  > against the real Service Auth configuration and accepted. See
  > `CLOUDFLARE-ACCESS-ORIGIN-CREDENTIAL-STRIPPING-001` in §11 — **CLOSED**.
  > This remains a statement about the measured ingress path, not a property
  > this repository can re-derive from source.
- The Access credentials are **not part of the HMAC canonical request**. The
  signing input remains exactly `version | key id | method | canonical path |
  timestamp | request id | idempotency key | SHA-256(raw body)`. A logically
  identical request therefore produces a byte-identical signature whether or
  not Access is in the path, and enabling Access requires **no** shared-auth
  protocol version change.
- Configure **both or neither**. Exactly one half makes the control plane fail
  closed with `WORKER_UNAVAILABLE`, without disclosing which half was wrong.
- Rotating the service token rotates independently of the HMAC pair.

**Denial classification.** HTTP 403 cannot originate from the current Worker
protocol — it is absent from `WORKER_ERROR_HTTP_STATUS` and from every Worker
code path — so a 403 on this endpoint is a **non-Worker, upstream refusal**. A
refused Access service token is the expected cause, but other upstream controls
(WAF, rate limiting, a bot rule) could also produce one; the classification
deliberately does not depend on distinguishing them. The control plane maps it
to `WORKER_UNAVAILABLE` *before* Worker response validation, because such a body
is an upstream page rather than a Worker error envelope. An Access login **redirect** is likewise rejected by
`redirect: "error"` and becomes `WORKER_UNAVAILABLE`. Genuine Worker business
responses (404, 409, 410, 413, 422, 429, 500, 502, 504 …) keep their existing
error-envelope mapping and are never collapsed into unavailability.

### Filesystem roles

```
/var/lib/videofetch    persistent volume   SQLite database + WAL/SHM sidecars ONLY
/tmp/videofetch        ephemeral           media working files ONLY
```

These must never be merged. Media is never written to the durable volume, and
durable state is never placed under `/tmp` — a temp-backed database silently
loses every job on restart.

The image is compatible with:

- a **read-only root filesystem**, plus
- a **writable persistent state mount**, plus
- a **writable ephemeral `/tmp`**.

Size the state volume for job metadata only (kilobytes to low megabytes). Size
ephemeral storage for the largest concurrent media artefact, which is bounded by
`MAX_FILE_SIZE`.

---

## 2. Container privileges

| Invariant | Requirement |
| :--- | :--- |
| Runtime user | **Non-root.** The image runs as UID 1000 (`node`). |
| Privileged mode | **Never.** |
| Host network | **Never.** The Worker must have its own network namespace. |
| Capabilities | Drop all. Add none. |
| `CAP_NET_ADMIN` | **Never granted.** |
| `CAP_SYS_ADMIN` | **Never granted.** |
| Docker socket | **Never mounted.** |
| Host filesystem | No writable host bind mounts beyond the state volume. |
| setuid helpers | None. |

The Worker requires no elevated capability of any kind. If a deployment appears
to need one, the deployment is wrong — not the image.

---

## 3. Networking and egress

The safe-egress policy is an **external, host/platform-owned infrastructure
boundary**. It is deliberately *not* implemented inside the container.

| Invariant | Requirement |
| :--- | :--- |
| Deny policy | Host/platform-enforced deny for private, reserved, loopback, link-local and cloud metadata destinations. |
| Enforcement point | Connection time, outside the container's control. |
| Worker capability | The Worker **cannot** read, weaken, mutate or bypass the policy. |
| Firewall tooling in image | None. No `nftables`, `iptables`, `curl`, `wget`, `ssh`, `sudo` or Docker CLI is installed. |
| TLS | Terminated by trusted infrastructure **before** traffic crosses the public internet. The Worker itself speaks plain HTTP. |
| Exposed surface | One port only. No second admin or debug port. |

The container image is intentionally incapable of owning the firewall. That
incapability is the point: an application-level compromise cannot rewrite the
network policy that contains it.

**Phase 9 performs the actual safe-egress acceptance suite from INSIDE the
deployed Worker boundary** — direct-address, redirect, DNS, rebinding,
descendant, firewall-mutation and public-success cases. A deployment is not
accepted until that suite passes in situ. Phase 8A provides no egress evidence
and claims none.

### Prototype status and what it does NOT authorize

A local prototype has demonstrated that this enforcement model is achievable on
a dedicated Linux VM: VM root/systemd installs and verifies an `nftables`
policy inside the media namespace *before* the Worker is allowed to start, the
Worker holds no network-administration capability and cannot alter the policy,
and a missing or mutated policy makes the Worker unavailable rather than
silently unconfined.

That result is **evidence about the enforcement model, not an acceptance**:

- `YTDLP_NETWORK_ISOLATED` was **`false`** throughout Phases 8 and 9, and the
  runtime refused to start if it parsed truthy. That contract has since been
  **retired** by Phase 10C1 — the variable is now refused at *any* value — but
  the property it was standing in for is unchanged: generic yt-dlp execution
  remains impossible. See §4.
- Formal Phase 9 **was re-run against the exact final topology** on 2026-08-30
  and PASSED. See §11a. Its scope was the Worker **safe-egress** boundary; it did
  not remeasure the ingress path (§1a), which was left unchanged throughout.
- Phase 10 remains the only phase authorized to enable yt-dlp, and it has not
  begun.

The residual evidence items carried into Phase 9 are now CLOSED by that run:
`SAFE-EGRESS-NORDVPN-CONNECTED-RETEST-001`,
`SAFE-EGRESS-MULTICAST-ATTRIBUTION-001`,
`SAFE-EGRESS-ROUTE-VERIFIER-HARDENING-001` — see §11.

### 3a. The recovered safe-egress deployment layer

`PHASE-8B-SAFE-EGRESS-PROTOTYPE-RECOVERY-001` moved the prototype's enforcement
model out of a single VM's filesystem and into reviewed source under `deploy/`,
reconciled with the trusted-broker architecture in §5. **Originally recovered as
source only, without deployment.** Those artefacts have since been installed as
the Phase-8B final stack; the prototype units remain present but disabled and
inactive, kept only as rollback assets. Phase 9 accepted the final safe-egress
topology against that live deployment (§11a), and `PRODUCTION-DNS-RESOLVER-001`
later added the resolver-readiness layer to it (§11b).

| Concern | Artefact |
| :--- | :--- |
| Namespace ownership | `deploy/systemd/videofetch-media-netns.service` |
| Namespace holder image | `deploy/media-netns/` (Dockerfile + `holder.c`) |
| Policy source | `deploy/nftables/videofetch-egress.nft.template` |
| Non-secret configuration | `deploy/systemd/media-egress.env.example` |
| Configuration gate | `deploy/bin/vf-egress-config-check` |
| Install | `deploy/bin/vf-egress-policy-install`, `deploy/systemd/videofetch-egress-policy.service` |
| Verify | `deploy/bin/vf-egress-policy-verify` |
| Watch | `deploy/bin/vf-egress-watchdog`, `deploy/systemd/videofetch-egress-watchdog.service` |
| Shared canonicalization | `deploy/bin/vf-egress-lib.sh` |
| Resolver readiness | `deploy/bin/vf-media-dns-check`, `deploy/systemd/videofetch-media-dns.service` |
| Durable resolver listener | `deploy/systemd/resolved.conf.d/10-videofetch-media-dns.conf.example` |
| Phase-9 multicast helper | `deploy/bin/vf-egress-multicast-route-test` |
| Phase-9 probe harness | `deploy/acceptance/safe-egress/` |
| Static + behavioural tests | `src/worker/runtime/safe-egress-deployment-policy.test.ts` |

**Dependency order (current).** The Worker may run only when the security
boundaries are present **and** the resolver it is configured to use is actually
answering:

```
systemd-resolved.service                 provides the stub listener at the designated address
  └─ videofetch-media-dns.service        FUNCTIONAL readiness: proves the resolver answers
       └─ videofetch-media-netns.service      owns the namespace, publishes 127.0.0.1 only
            └─ videofetch-egress-policy.service     installs + verifies, fingerprints to /run
                 └─ videofetch-egress-watchdog.service  re-verifies continuously
                      └─ videofetch-worker.service
videofetch-r2-broker.service
  └─ videofetch-worker.service
```

**`videofetch-media-dns.service` is functional readiness, not a safe-egress
security boundary.** It proves a resolver is present and speaking DNS at the
designated address; it enforces nothing, and the egress policy is unaffected by
whether it passes. The security boundary remains exactly the namespace, the
policy and the watchdog. The two are kept deliberately separate:
`vf-egress-policy-verify` never consults DNS, and `vf-media-dns-check` never
consults the verifier, so a DNS outage cannot present as a boundary breach and a
breach cannot be masked by DNS being healthy.

The dependency strengths differ, and the difference is the point:

| Unit | On `videofetch-media-dns.service` | Why |
| :--- | :--- | :--- |
| `videofetch-media-netns.service` | `Requires=` + `After=`, **no `BindsTo=`** | A transient DNS fault must not tear down the namespace and force the whole policy to be reinstalled. |
| `videofetch-worker.service` | `Requires=` + `After=` + `BindsTo=` | A resolver that stays gone stops the Worker, rather than leaving it reporting healthy while every lookup fails. |

The Worker's original security dependencies are unchanged: it still declares
`Requires=` + `After=` + `BindsTo=` on `videofetch-media-netns.service`,
`videofetch-egress-policy.service`, `videofetch-egress-watchdog.service` and
`videofetch-r2-broker.service`, so:

| Event | Consequence |
| :--- | :--- |
| Namespace absent | Worker cannot start |
| Policy install or verification fails | Worker cannot start |
| Watchdog unavailable, crashed or hung | Worker stops — it is never left unmonitored |
| Namespace disappears later | Worker stops |
| Broker disappears later | Worker stops |
| Designated resolver stops answering | Worker stops; the namespace, policy and watchdog stay up |
| Boundary invalid after a breach | Worker cannot be restarted; the pre-start verifier is the latch |

**What changed relative to the prototype.**

- **The namespace holder is reproducible.** The prototype ran `alpine:vf`, an
  image that existed on one VM and could not be rebuilt from source. It is
  replaced by a two-stage build whose shipped stage is `FROM scratch` and
  contains one static binary — no shell, no libc, no package manager.
- **The DNS resolver is configuration, not a constant.** The prototype baked
  `172.17.0.1` — one host's Docker bridge address — into its firewall source.
  The resolver is now declared once, in `/etc/videofetch/media-egress.env`, and
  that single declaration feeds both the container runtime's `--dns` and the
  firewall's exception, so the resolver actually queried and the resolver
  admitted cannot drift apart. Each address must be **exact**; a prefix is
  refused, so no broad private-range exception can be introduced as a
  "resolver". Absent or malformed configuration fails closed.
- **The verifier detects added allow rules without a baseline.** It enumerates
  every `accept` verdict in the namespace and requires the set to be exactly
  the intended shape, in addition to the whole-ruleset fingerprint. It also
  asserts exactly one table exists, because a second `nat` table's output hook
  runs at priority `dstnat` — before `filter` — and could DNAT a forbidden
  destination into a permitted one.
- **Routes are verified** (`SAFE-EGRESS-ROUTE-VERIFIER-HARDENING-001`). See §3b.
- **The watchdog's breach path exists.** The prototype invoked
  `vf-policy-breach.target`, which was never defined, so the call silently did
  nothing. No such target is reproduced; the Worker's `BindsTo=` on the
  watchdog unit is the stop path, and it is exercised by tests.
- **The IPv6 deny set is strictly larger.** `::/96` replaces the prototype's
  separate `::/128` and `::1/128`, adding IPv4-**compatible** coverage that
  `safe-egress.md` requires. The three classes cannot be listed separately
  because nftables interval sets reject overlapping elements.
- **The namespace holder builder is pinned immutably** — an exact Alpine patch
  tag *and* the manifest-list digest it resolved to, verified against the
  official registry and confirmed to carry a `linux/arm64` entry. A tag alone,
  even a patch tag, is mutable and cannot support a reproducibility claim.
- **Phase-9 multicast acceptance quiesces the boundary rather than racing it.**
  See §3d.

### 3d. Phase-9 multicast acceptance lifecycle

`deploy/bin/vf-egress-multicast-route-test` must create routes for destinations
the policy denies, so a denial can be attributed to the rule's counter instead
of to a missing route. That means mutating the very route table the watchdog
verifies.

**The production boundary has no acceptance mode.** The verifier and watchdog
contain no allowance, exemption or bypass for "expected" route deltas, and must
not acquire one: such an allowance would be live every second of every day for
the sake of a measurement taken once. The helper instead stops the Worker and
the watchdog for the measurement window, asserts they really stopped, and
restarts them only after the boundary verifies again.

| Phase | Action |
| :--- | :--- |
| Pre-flight | Full verification must already pass; refuse otherwise. |
| Quiesce | Stop the Worker, then the watchdog; **assert** both inactive or abort. |
| Mutate | Record routes, add the minimal test route(s) (`224.0.2.1/32`, `ff0e::1/128`). |
| Bound | Assert the route delta is *exactly* those routes and the nftables fingerprint is unchanged; abort on anything else. |
| Measure | Probe from a disposable, unprivileged container joined to the same namespace; read `deny-v4` / `deny-v6`. |
| Unwind | `EXIT`/signal trap removes the routes, asserts byte-identical restoration, re-verifies the whole boundary. |
| Resume | Start the watchdog, then the Worker — **only** if everything above succeeded. |

No fingerprint is re-baselined at any point: the recorded route baseline keeps
describing the clean namespace throughout, so the closing check is a genuine
comparison against the original state. The installer's `--routes-baseline-only`
mode was removed outright.

Any failure — unexpected route, altered ruleset, failed probe, interrupt —
leaves the Worker and watchdog **stopped**. The failure direction is an outage,
never an unenforced boundary, and the Worker is never running unmonitored
against a knowingly modified route table.

**Executed in Phase 9 on 2026-08-30** against the live VM, in both the normal
host-network state and with NordVPN connected. Both runs quiesced the boundary,
installed exactly the intended narrow routes, restored the route table byte-for-
byte and re-verified the boundary. The helper's own TCP probe reported a flat
counter in every run; §11a records why that is a property of the Linux socket
layer rather than of this boundary, and how the attribution was obtained.

**Not recovered, deliberately.** `cf-api`, `vf-observer.py`, the real
`cloudflared` configuration and credentials, the Lima YAML, macOS launch
wrappers, VM sizing and any VPN tooling are out of scope here and belong to
separate bounded tasks. No macOS LaunchAgent is created and Lima does not start
automatically — see §3c.

### 3b. Route verification (`SAFE-EGRESS-ROUTE-VERIFIER-HARDENING-001`)

The prototype fingerprinted the `nftables` ruleset but not the namespace route
table. That gap is now closed **in source**; it is **not** closed as evidence.

Why it matters even though a route cannot defeat a destination-address deny:
the deny set enumerates address **classes**, not reachability. A new interface
or route appearing inside the media namespace can expose destinations whose
addresses are perfectly public but whose hosts are local — a LAN segment on
public address space, a VPN tunnel, a second bridge. Nothing in the nftables
policy denies those, because by address they are exactly what the Worker is
supposed to reach.

Two independent checks:

1. **A semantic invariant, needing no baseline.** Every policy-routing rule
   must sit at a kernel-default priority and look up a built-in table
   (`local`/`main`/`default`, by name or id). Any injected rule fails,
   whatever it points at. The namespace must also have at least one IPv4
   route — an empty table would make every destination unreachable for reasons
   unrelated to the firewall, which is precisely the ambiguity
   `SAFE-EGRESS-MULTICAST-ATTRIBUTION-001` is about.
2. **A runtime fingerprint**, covering IPv4 routes, IPv6 routes and both rule
   tables, captured after controlled namespace creation and policy install,
   stored under `/run` and regenerated **only** by the trusted install path.

Nothing dynamic is hard-coded: not the Lima-assigned container address, not
Docker's current bridge subnet, not a link-local address, not an interface
name. The baseline is whatever the controlled start path produced, so it
survives an ordinary VM reboot and namespace recreation. Normalization strips
only `expires <n>sec` (a router-advertised lifetime that ticks down every
second), collapses whitespace and sorts; every destination, gateway, device,
metric, scope, table and preference is hashed.

**Status: VERIFIED IN SITU — `SAFE-EGRESS-ROUTE-VERIFIER-HARDENING-001` is
CLOSED.** Source-level tests prove the detection logic against recorded
fixtures; Phase 9 then measured it against the real namespace on the real VM.
The installed verifier hash-matched its `origin/main` blob, passed 50/50
consecutive runs under a connected host VPN with identical fingerprints on every
invocation, and was exercised across the multicast quiesce/mutate/restore
windows. See §11a.

### 3c. Operating model — on demand

The VM is started **manually**, when the application is wanted. There is no
macOS LaunchAgent, Lima does not start at login, and neither the Mac nor the VM
needs to run 24/7.

```
limactl start videofetch
  → guest systemd starts the VideoFetch units
  → safe-egress boundary becomes ready   (namespace, policy, watchdog)
  → broker becomes ready
  → Worker becomes ready
  → cloudflared provides ingress
```

The user-facing start/stop wrapper is deliberately **not** part of this work; it
follows once the deployment artefacts have been reviewed and installed.

---

## 4. yt-dlp

**The Worker image ships a pinned yt-dlp runtime. Generic yt-dlp execution is
not enabled, and no user-supplied URL can reach yt-dlp.**

Those two sentences are independent, and the whole design of this section is to
keep them independent:

```
yt-dlp runtime installed  !=  generic yt-dlp execution enabled
```

*Historical note: throughout Phases 8 and 9 the image contained neither Python
nor yt-dlp, and `YTDLP_NETWORK_ISOLATED=false` was the operative lock. Both
statements were accurate at the time and the Phase-9 and direct-media
acceptance records in §11 are unaffected. What follows describes the contract
as of `PHASE-10C1-YTDLP-RUNTIME-FOUNDATION-001`.*

### 4a. The pinned runtime

| Property | Value |
| :--- | :--- |
| yt-dlp release | `2026.08.19` (exact, immutable release tag) |
| Artifact | The official **platform-independent Unix zipimport executable** — the release's bare `yt-dlp` asset |
| SHA-256 | Pinned in `Dockerfile.worker` via `ADD --checksum` and verified at build time |
| Python | Debian Bookworm system `python3` (3.11). The release requires >= 3.10 |
| Bundled EJS | `yt_dlp_ejs` 0.8.0, shipped **inside** the artifact |
| Install path | `/usr/local/lib/videofetch/yt-dlp`, root-owned, mode `0555`, on the read-only root filesystem |

The PyInstaller builds (`yt-dlp_linux_aarch64` and friends) are deliberately
**not** used: they unpack themselves into a temporary directory on every run,
which this container's read-only root and `noexec` media tmpfs would break.

There is no `pip`, no virtual environment and no package installer anywhere in
the image, so nothing inside it can add, upgrade or replace a Python package.
**yt-dlp cannot update itself**: the artifact is root-owned and read-only, the
Worker runs as `node`, and the argument policy passes `--no-update`. Upgrading
yt-dlp is a reviewed code change to the version and digest — together — followed
by a deployment, never a runtime event.

`src/worker/runtime/ytdlp-runtime.server.ts` holds the same version, digest and
paths, and `container-policy.test.ts` asserts the image and the module agree, so
a bump that touches only one of the two fails the build rather than shipping a
Worker whose probe can never match its image.

### 4b. Execution policy

Every invocation uses one closed, application-owned argument set and one
allowlisted environment built from nothing — `process.env` is never inherited.
The options below were verified against this exact release's own `options.py`
rather than assumed from historical spelling:

| Concern | Mechanism |
| :--- | :--- |
| Configuration discovery | `--ignore-config --no-config-locations` — no system, user, home, XDG or portable config |
| Plugins | `--no-plugin-dirs` (this release has no `--no-plugins`) |
| JavaScript runtime | `--no-js-runtimes` then `--js-runtimes=node:<absolute path>`. The default is otherwise **Deno**, which is not in this image. Order matters: `--js-runtimes` appends |
| Remote components | `--no-remote-components` — EJS is never fetched from npm or GitHub. The requisite package is bundled, so this costs no functionality |
| Self-update | `--no-update`, on a read-only root-owned file |
| Credentials | `--no-cookies --no-cookies-from-browser`; no `--netrc`, username, password, token or authorization header. **Public sources only** |
| External downloaders | None configured. `--downloader`, `--exec` and postprocessor commands are never passed, and no such helper is installed |

### 4c. Configuration contract

| Variable | Status |
| :--- | :--- |
| `YTDLP_NETWORK_ISOLATED` | **RETIRED.** Startup-fatal if present at *any* value, `false` included |
| `YTDLP_PATH` | **RETIRED.** Startup-fatal if present |
| `YTDLP_ENABLED` | The application feature state. Absent means disabled. Exactly `true` or `false`; any other spelling is a startup failure |

`YTDLP_NETWORK_ISOLATED` was an operator *assertion* that yt-dlp ran behind an
isolated network. It was never the boundary — the media network namespace and
its externally owned nftables policy are, and this container can neither read
nor alter them. A boolean that merely restates its own configuration while
looking like a security control is worse than no boolean, so it is retired
outright rather than repurposed, and a stale deployment still setting it fails
closed and visibly.

`YTDLP_PATH` chose the executable *and* prepended arbitrary leading arguments to
every invocation, because it was split on spaces. No repository path let user
input reach it, so this was never a user-input vulnerability — it was an
unnecessarily loose operator execution surface, and the Production Worker has no
need of it. The runtime identity is a reviewed constant in the image.

### 4d. What Phase 10C1 does NOT authorize

**No user-URL execution path exists.** `WorkerService.analyze()` still resolves
only to the direct-media analyzer, `JobExecutor` still has no generic branch,
and the only yt-dlp subprocess operation in any Production Worker code is a
non-network version probe. Setting `YTDLP_ENABLED=true` today would change a
diagnostics field and nothing else.

Generic analysis, generic download, format planning and the live acceptance
matrix that must precede enabling any of it are later, separately authorized
phases. **Phase 10C1 has not been deployed**, and `YTDLP_ENABLED` is deliberately
absent from the image and from the committed systemd unit.

---

## 5. Object storage (R2)

Three boundaries operate here and they are documented separately, because
conflating them would overstate the security posture:

- **5a** — what the application code can express (software-enforced).
- **5b** — what the provider credential actually permits.
- **5c** — who holds the persistent credential at all (custody).

`WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001` closed the gap between 5a and 5b for
the Worker, and moved custody out of the media container entirely.

### 5a. Application operation boundary (enforced in software)

This boundary is real, is enforced by the code in this repository, and is
covered by tests.

| Runtime | Operations the production code can perform |
| :--- | :--- |
| Worker (`ObjectStoreWriter`) | `PutObject`, `HeadObject`, `DeleteObject` — nothing else. |
| Vercel (signer) | Signs `GetObject` — nothing else. |

The Worker's `ObjectStoreWriter` interface exposes exactly `put`, `head` and
`delete`. It has no `get`, no `list`, no presign and no bucket-administration
method, so no Worker code path can express those operations. Deletion is always
by exact object key; there is no prefix, wildcard, list or bucket-clear path.

Vercel never receives a Worker credential, and the Worker never receives
`R2_SIGNER_*`.

### 5b. Provider credential boundary

> **This section previously documented a weaker boundary than 5a.** Cloudflare
> R2's **persistent** S3 API token presets are coarse — approximately *Object
> Read & Write* (read + write + list) and *Object Read only* (read + list) —
> with no persistent preset granting exactly `PutObject + HeadObject +
> DeleteObject`. Under the superseded static-credential model the honest
> statement was: *the application only ever invokes its own narrow operation
> set, while the underlying token may permit more.*

**That gap is now closed for the Worker** by
`WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001`. The Worker no longer holds a
persistent credential of any kind. Each operation uses a credential minted just
in time and scoped to a single S3 action:

| Worker operation | S3 action granted | Actions NOT granted |
| :--- | :--- | :--- |
| `put()` | `PutObject` | Get, Head, Delete, List, multipart, admin |
| `head()` | `HeadObject` | Put, Get, Delete, List, multipart, admin |
| `delete()` | `DeleteObject` | Put, Get, Head, List, multipart, admin |

Exact action scoping is reachable only through **R2 temporary-credential local
signing**, not through the Temporary Credentials API — the API accepts the
coarse presets above, whereas local signing accepts an explicit `actions` list.
That is why the broker signs locally rather than calling an API.

**The delegated JWT states its authority with `actions` and nothing else.**
Cloudflare's concept-level contract is that permitted operations are specified
using `scope` (spelled `permission` in the Temporary Credentials API) **or**
`actions`, with at least one required — the two are alternatives, not a preset
that a list then narrows. Each minted credential therefore carries exactly:

- `bucket` — the broker's single configured bucket;
- `actions` — **exactly one** S3 action, and **no** `scope` or `permission`
  claim of any kind;
- `paths.objectPaths` — **exactly one** exact object key;
- `paths.prefixPaths` — **empty**, so no credential can reach a sibling object
  under the same job prefix;
- a bounded `exp`;
- the standard `sub` / `iss` / `aud` / `iat` identity and time claims.

Narrowing is accomplished **entirely** by that explicit one-action list plus the
exact object path. No coarse preset is present to narrow away from.

The scheme is Cloudflare's documented one: sign a JWT (HS256) with the parent
secret, reuse the parent access key id, derive the temporary secret as the
SHA-256 hex digest of the signed JWT, and encode the session token as
`base64("jwt/" + <jwt>)`. `src/broker/r2/temporary-credentials.test.ts` pins the
signing output byte-for-byte against the `jose` reference implementation the
Cloudflare example uses. That pin proves our `node:crypto` signer serializes and
signs the intended claims identically to `jose` — it is **not** evidence that R2
accepts the claim shape, which only the live endpoint can establish.

#### Why `actions` alone — measured, not assumed

The first implementation emitted `scope: "object-read-write"` **alongside**
`actions`, following Cloudflare's runnable local-signing example, which still
builds a required `scope` with an optional `actions`. The **first** live
acceptance attempt (`R2-BROKER-LIVE-MINT-VERIFICATION-001`) reached real R2 and
found that the example does not describe what the endpoint accepts:

| Claim shape | Live R2 result |
| :--- | :--- |
| `scope` only | accepted |
| `scope` + paths | accepted |
| `scope` + `actions` | **rejected** |
| `scope` + `actions` + paths | **rejected** |
| `actions` only | accepted |
| `actions` only + exact paths | accepted |

The merged `scope + actions` credential was rejected with `HTTP 400
InvalidArgument` on `X-Amz-Security-Token` — at token **parsing**, before any
authorization decision. Diagnostic action-only credentials were accepted and
demonstrated the intended enforcement: `PutObject` on the exact key succeeded
while Get/Head/Delete/List and a sibling `PutObject` were denied; `HeadObject`
on the exact key succeeded while cross-action, list and sibling head were
denied. That first attempt measured nothing about expiration.

Nothing here corrected Cloudflare's own material, and none of it should be read
as Cloudflare requiring `scope` in general. Its **concept** documentation
describes `scope` and `actions` as alternatives — at least one required, with
`actions` currently supported through local signing — while it is the
**runnable local-signing example** above that constructs a required `scope`
with an optional `actions`. The live endpoint matched the concept-level
`scope OR actions` contract rather than that example. What changed is our claim
shape, which now matches what the endpoint actually accepts.

`R2-TEMP-CREDENTIAL-ACTIONS-ONLY-001` changed the production claim shape to the
measured-compatible action-only form, and **the corrected production path has
since been exercised live and accepted.** The definitive rerun ran the merged
implementation itself — the merged `mintTemporaryCredential` signer, the merged
`CloudflareR2ObjectStoreWriter` for Put/Head/Delete, repository-generated
`WorkerObjectKey` values, all three temporary-credential fields on every
delegated request, and no parent-credential fallback. A raw AWS SDK client was
used only for `GetObject` and `ListObjectsV2`, which the production writer
deliberately does not implement. No alternate diagnostic claim shape appeared in
the definitive matrix.

Every credential inspected in that rerun carried exactly `bucket`, `actions`,
`paths`, `sub`, `iss`, `aud`, `iat` and `exp` — one action, one `objectPaths`
entry, empty `prefixPaths`, no `scope`, no `permission`, the correct `aud`, a
bounded expiry, and no parent secret in the returned material. The action-only
production correction therefore passed real-provider validation. The full
Put/Head/Delete matrix passed while cross-action, sibling and `ListObjectsV2`
access were denied provider-side, so
`R2-BROKER-LIVE-MINT-VERIFICATION-001` is now **CLOSED — accepted** (§11) and no
longer blocks production R2 traffic.

**Expiration, finally measured.** A production `PutObject` credential was minted
at the merged contract minimum of `TTL = 1s` (§5d) and replayed at `exp + 30s`
against real R2 on real wall-clock time, with no clock manipulation. In this
acceptance R2 surfaced the expired credential provider-side as
`403 SignatureDoesNotMatch` rather than a dedicated expiry code, and the expired
operation did not create its target object. Because that response is not
expiry-specific, the result was isolated by confirming that equivalent 1-second
production credentials were accepted **before** expiry and rejected **after**
it, for both `HeadObject` and `PutObject`. The requirement is accepted on that
before/after evidence and on the response actually observed —
`SignatureDoesNotMatch`, not `ExpiredToken`. That records what this measurement
returned; it is not a general claim about how R2 reports expiry.

**Still true, and still worth stating plainly:** the broker's own *parent* token
is a persistent **bucket-scoped *Object Read & Write*** credential (read + write
+ list on the one bucket, no bucket administration). Its provider permissions
therefore remain broader than `PutObject + HeadObject + DeleteObject`, and
broader than every temporary credential derived from it — removing `scope` from
the delegated JWT changes nothing about the parent, which is not a temporary
credential and carries no claims. The change is one of **custody**, and it is
the change that matters: that token now lives only on the
trusted VM host, outside the media namespace, and nothing the media container
can do reaches it. The Vercel signer identity is likewise unchanged and remains
a separate persistent read-only identity — it is **not** part of this work.

### 5c. Trusted broker architecture

```
media container  (NO R2 credential of any kind)
  │  validated WorkerObjectKey + action + bounded TTL
  │  AF_UNIX socket, bind-mounted read-only. Not the network.
  ▼
trusted broker  (VM host, own user, own systemd unit, own namespace)
  │  sole holder of the persistent R2 parent credential
  ▼
short-lived credential:  1 bucket · 1 exact object key · 1 S3 action
```

| Invariant | Requirement |
| :--- | :--- |
| Parent credential custody | The broker process **only**. Never in the media container, never on Vercel. |
| Parent credential transport | Root-owned `EnvironmentFile`, mode `0400`. **Never** argv — `/proc` makes argv world-readable. |
| Worker credential | Minted per operation. No persistent credential exists to fall back to. |
| Boundary transport | Unix domain socket. Creates **no network egress**, so it neither depends on nor widens the safe-egress policy. |
| Socket permissions | Mode `0660`, broker user and group. The Worker joins the group to `connect(2)`. |
| Socket directory | Bind-mounted **read-only** into the container, so the Worker cannot unlink, replace or shadow the socket with a listener of its own. |
| Broker network | **None.** Local signing makes no API call, so the unit sets `PrivateNetwork=yes` and `RestrictAddressFamilies=AF_UNIX`. Verified active on the VM. |
| Broker Node runtime | **Node `v22.23.2`**, supplied by the deployment. The distro's packaged Node 18 cannot run `--experimental-strip-types`. |
| Broker package manager | **npm `11.19.1`**, pinned by `packageManager` in `package.json` and installed explicitly. The npm bundled with Node v22.23.2 is 10.9.8 and **cannot** install this lockfile. See §5g. |
| Broker install command | `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`. Never `npm install`, never `--legacy-peer-deps`, never `--force`. |
| `MemoryDenyWriteExecute` | **Not set**, by measurement. With the JIT the broker SIGTRAPs; with `--jitless` the type stripper loses the WebAssembly it needs. See §5g. |
| Worker supplementary group | A **numeric GID**, resolved on the host at install time. A `--group-add` NAME would be resolved inside the image, which defines no such group. |
| Broker validation | Re-validates the object key against the authoritative `WorkerObjectKeySchema`, the bucket by equality with its single configured bucket, the action against a closed three-entry set, and the TTL against the policy window. |
| Broker failure mode | Fails closed on any malformed action, key, bucket or TTL. Returns a bare category code, never a value from the request. |
| Broker logging | Never logs a credential, session token, object key or bucket. The observer hook's type cannot carry one. |
| Worker privileges | Unchanged: no `NET_ADMIN`, no `SYS_ADMIN`, no Docker socket, no host networking. |

The Worker validates the object key itself *before* contacting the broker, so
the broker's key check is a second independent gate rather than the only one.

### 5d. Credential TTL policy

Minted just in time. Two DIFFERENT rules apply, because the two kinds of
operation have opposite relationships to job expiry.

| Operation | S3 action | Ceiling | Rule |
| :--- | :--- | :--- | :--- |
| `put()` | `PutObject` | 900s | **Deadline-bound** |
| `head()` | `HeadObject` | 120s | **Deadline-bound** |
| `delete()` | `DeleteObject` | 120s | **Cleanup**, floor 60s |

**Deadline-bound (`PutObject` / `HeadObject`).** The credential must never
outlive the job it serves.

- remaining lifetime known and positive → `min(remaining, ceiling)`. A job with
  30 seconds left yields a 30-second credential, not a floored 60-second one.
- remaining lifetime known and **already expired** → **fail closed.** No
  credential is requested at all, and the broker is never contacted. Writing or
  inspecting an object whose authorization has lapsed is not something a floor
  should be allowed to paper over.
- deadline unknown → the action's conservative ceiling.

**Cleanup (`DeleteObject`).** Must keep working precisely *because* the job
expired, so it retains a 60-second floor and a 120-second ceiling. Maintenance
therefore mints a **fresh, bounded, delete-only** credential long after expiry
rather than relying on a stale upload credential. Deleting an expired object
grants nothing to anyone, and the credential carries no Put or Head authority.

Global bounds: minimum 1s, absolute hard cap 900s.

#### Where each rule is enforced

The split is deliberate and is not a gap:

| Rule | Enforced by | Why there |
| :--- | :--- | :--- |
| Integer TTL within `[1, ceiling(action)]` | **Broker** | Verifiable without a job store. Refused, never clamped — an out-of-policy ask is a bug or an attack. |
| TTL ≤ remaining job lifetime | **Worker** | Only the Worker knows the job deadline. |
| Expired job → no Put/Head credential | **Worker** | Same reason. |

A compromised Worker therefore cannot negotiate a credential longer than the
per-action ceiling; an honest Worker additionally cannot obtain one that
outlives its job. The broker does not claim to verify deadline-boundness, and
the code does not pretend otherwise.

### 5e. What is still required at provisioning time

| Invariant | Requirement |
| :--- | :--- |
| Bucket | Private, Standard class. Never public-read. |
| Identities | Two **separate** credentials — one parent for the broker, one for Vercel. Never one shared token. |
| Scope | Bucket-specific. Never account-wide. |
| Administration | No bucket administration on either credential. |
| Broker parent token custody | VM host only, `0400`, root-owned. Never supplied to the Worker container or to Vercel. |
| Separation of use | Enforced in software per 5a/5b, and by never cross-supplying the broker parent and `R2_SIGNER_*`. |
| Provider lifecycle | A TTL backstop, configured only during authorized provisioning. |

Set the provider lifecycle retention slightly **longer** than the application
expiration (`FILE_EXPIRATION_MINUTES`) so ordinary Worker cleanup attempts the
exact-key deletion first and the provider TTL only catches what the Worker
missed.

Expiration is enforced by `expiresAt` in durable metadata, independently of
whether cleanup succeeded. A failed object deletion never extends user
authorization.

### 5f. `R2-CREDENTIAL-SCOPE-DECISION-001` — RESOLVED / CLOSED

**Status: CLOSED. The Product Owner selected Option B.**

- ~~Option A — accept bucket-scoped **persistent** R2 credentials whose provider
  permissions are broader than the application operation surface, relying on the
  strict software separation in 5a for v1.~~ **Not selected.**
- **Option B — renewable, action-scoped temporary credentials.** **Selected and
  implemented** by `WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001`.

The renewal complexity Option B was expected to carry is handled by minting
per operation rather than by running a renewal loop: there is no long-lived
credential in the Worker to keep fresh, and therefore no rotation schedule, no
refresh timer and no cached credential to invalidate. Rotating the **parent**
credential is a broker-side restart.

*At the time this decision was closed, no production R2 bucket, token, lifecycle
rule or account change had been made, and it was an unprovisioned design.*
**Production R2 and its credential plane have since been provisioned** — before
Phase 9 — and the provider lifecycle backstop was configured afterwards under
`R2-PROVIDER-LIFECYCLE-BACKSTOP-001` (§5h). None of that changed the decision
itself: Option B, action-scoped temporary credentials minted per operation,
still stands exactly as described above.

Historically, a disposable bucket and parent
token were used for the live acceptance recorded under
`R2-BROKER-LIVE-MINT-VERIFICATION-001` and were **subsequently torn down after
that acceptance passed** — the parent token revoked, the bucket confirmed empty
and then deleted, and the operator's local acceptance credential file
(`~/.config/videofetch/r2-live-acceptance.env`) removed. That teardown is
**operator-attested**; it was not independently re-verified through the
Cloudflare API, and no attempt is made to re-verify it, which would require
recreating the very access that was revoked. The bucket was throwaway
verification material, never production provisioning, and no repository change
depends on it.

### 5g. Measured host constraints

Both items below were found by running the real broker on the target VM
(Ubuntu 24.04.4, Node 22.23.2, aarch64) with fake deterministic credentials and
no R2 endpoint. They are recorded because both would otherwise ship as units
that cannot start.

**1. `MemoryDenyWriteExecute` is unusable while the broker runs TypeScript.**

| Configuration | Result |
| :--- | :--- |
| `MemoryDenyWriteExecute=yes`, JIT enabled | V8 fatal in `OS::SetPermissions` (errno 12); `Result=core-dump`, `status=5/TRAP`. Never starts. |
| `MemoryDenyWriteExecute=yes`, `--jitless` | `ERR_WEBASSEMBLY_NOT_SUPPORTED` at `stripTypeScriptModuleTypes`. Never starts. |
| No `MemoryDenyWriteExecute`, JIT enabled | **Active, listening, stable.** |

V8's tiering compiler needs executable heap pages, which W^X denies. `--jitless`
removes the JIT but also disables WebAssembly — and Node's native type stripper
is a WASM module. The two are jointly unusable here, so the directive is
omitted rather than shipped broken. A unit that cannot start is not a security
control. Every other confinement directive is retained and was verified active
in the same run.

To reinstate W^X the broker would have to stop relying on runtime type
stripping (precompiled JS), at which point `--jitless` becomes viable again.

**3. The npm bundled with Node v22.23.2 cannot install this repository.**

Measured on the target VM with Node `v22.23.2`, whose bundled npm is `10.9.8`:

```
npm ci --omit=dev --ignore-scripts --no-audit --no-fund

npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json are in sync.
npm error Missing: lru-cache@11.5.2 from lock file
```

`lru-cache@^11.2.6` is an **optional peer dependency** of
`unstorage@2.0.0-alpha.7`, which is reached only through the **dev-only**
`nitro` devDependency. Nothing requires it, so it is correctly absent from the
committed lockfile. npm 10 resolves and installs it anyway — writing an entry
explicitly flagged `"dev": true, "optional": true, "peer": true` — and then
fails `npm ci` because the committed lockfile does not contain the entry npm
itself invented.

| npm | clean `npm ci` | prod-only `npm ci` | lockfile mutated |
| :--- | :--- | :--- | :--- |
| 10.9.8 (bundled) | **fails** `EUSAGE` | **fails** `EUSAGE` | — |
| 10.9.9 | **fails** `EUSAGE` | **fails** `EUSAGE` | — |
| **11.19.1 (pinned)** | **passes** | **passes** | **none** |
| 12.0.2 | passes | passes | none |

The committed lockfile is the fixed point of npm >= 11: `npm install` under
npm 11 reproduces it byte-for-byte. Adding the entry npm 10 wants is **not** a
fix — npm 11 deletes it again on the next `npm install`, so the lockfile would
flap with whichever npm last touched it. The repository therefore pins the
package manager instead of editing the lockfile, and `package.json` carries an
exact `"packageManager": "npm@11.19.1"`.

Install it explicitly on the broker host; do not rely on the bundled npm:

```
/opt/videofetch/node/bin/npm install -g npm@11.19.1
/opt/videofetch/node/bin/node -v   # v22.23.2
/opt/videofetch/node/bin/npm -v    # 11.19.1
```

`src/worker/runtime/toolchain-policy.test.ts` fails the build if the pin is
removed, loosened to a range, or drifts from the documented versions.

**2. The Worker's supplementary group must be a numeric GID.**

`docker run --group-add <name>` resolves the NAME inside the container image.
The Worker image defines no `videofetch-broker` group, so a named `--group-add`
cannot work. The host allocates the GID when the group is created, so it must
not be hard-coded either.

`deploy/bin/vf-r2-broker-gid-write` resolves it at install time into
`/etc/videofetch/broker-gid.env` (world-readable; a group id is not a secret),
and `deploy/bin/vf-r2-broker-gid-verify` runs as an `ExecStartPre` gate that
refuses to start the Worker unless the configured GID numerically equals the
group owning the socket and the socket is group-connectable but not
world-accessible. Neither `/etc/passwd` nor `/etc/group` is mounted into the
media container.

### 5h. `R2-PROVIDER-LIFECYCLE-BACKSTOP-001` — CLOSED

**Status: CLOSED.** The provider lifecycle backstop is configured on the
production bucket and verified by API readback.

| | |
| :--- | :--- |
| Rule name | `videofetch-expired-job-backstop` |
| Scope | prefix `videofetch/jobs/` — the exact object-key namespace |
| Action | delete objects after an age of **3600 seconds (60 minutes)** |
| Enabled | yes |
| Storage-class transition | none |

**It is a backstop, not the cleanup path.** Ordinary expiry remains the
application's job: `FILE_EXPIRATION_MINUTES` is **45 minutes** and the Worker
deletes each object by exact key through a delegated `DeleteObject` credential.
The provider rule exists only to collect what that path misses — a Worker killed
mid-job, a delete that failed and was never retried. 60 minutes is deliberately
*longer* than 45 so the application always gets its attempt first, and bounded
enough that an escaped object is measured in minutes rather than days.

Two properties worth stating precisely:

- **Provider deletion is asynchronous.** Cloudflare removes objects on its own
  schedule after the age threshold; the rule guarantees eventual deletion, not
  deletion at a particular instant. Nothing in this system depends on the
  timing — user authorization is governed by `expiresAt` in durable metadata,
  independently of whether any object still exists.
- **The rule does not weaken application cleanup**, and application cleanup is
  not relaxed because the rule exists. Both run.

**Verification.** The rule was written by API and then read back independently —
a dashboard success message is not evidence. The readback confirmed the rule
enabled with the exact prefix, a delete-objects transition at age 3600, no
storage-class transition, and a pre-existing default multipart-abort rule
preserved unchanged alongside it (it was appended to, never replaced).

A single throwaway object was then created under `videofetch/jobs/` through the
real delegated `PutObject` path. The provider returned:

```
x-amz-expiration: expiry-date="…20:40:12 GMT", rule-id="videofetch-expired-job-backstop"
```

naming this rule and an expiry exactly 3600 seconds after the object was
written, on both the `PUT` and a subsequent `HEAD`. The object was then removed
immediately through the normal exact-key delegated `DeleteObject` path,
confirmed absent (HTTP 404), and the bucket confirmed to hold zero objects at
`videofetch/jobs/`, at `videofetch/` and bucket-wide. Nothing was left for the
backstop to collect — the header is evidence that the rule *applies*, not a
measurement of deletion timing.

Authorization for this change was a temporary R2 token scoped to nothing beyond
R2 storage editing, used only for the lifecycle `GET`/`PUT` and readback. Its
local copy was securely deleted immediately afterwards and never appeared in
shell history, and the operator has since **revoked the token** at the provider
— *operator-attested, and not independently re-verified here, because revoking
or inspecting a token requires the token-management permission this work
deliberately did not hold.* The broker's parent credential was never used for
any of it and, as §5b requires, cannot be: it is refused `AccessDenied` on
lifecycle operations. No account identifier, bucket name, token or secret value
is recorded here.

---

## 6. Secrets

| Invariant | Requirement |
| :--- | :--- |
| Baked into image | **Never.** The image contains no secret in any layer, `ENV` or build argument. |
| Supplied via | The platform's runtime secret store / environment injection. |
| Build arguments | Never used for credentials. |
| Logging | Neither runtime logs `process.env`, R2 credentials, session tokens, the HMAC secret, or exception cause chains. A configuration failure names the offending **variable** only, never its value. The broker additionally never logs an object key or bucket — its observer hook's type cannot carry one. |
| Parent credential custody | The trusted broker process **only**. See §5c. |

Required on the **Worker** at runtime:

```
WORKER_DATA_DIRECTORY          absolute, persistent, not under /tmp
WORKER_CONTROL_KEY_ID          shared with Vercel
WORKER_CONTROL_SECRET          shared with Vercel, >= 32 UTF-8 bytes
R2_ACCOUNT_ID
R2_BUCKET
R2_BROKER_SOCKET_PATH          absolute path to the trusted broker's socket
```

Optional on the Worker:

```
WORKER_BIND_HOST               default 0.0.0.0
WORKER_PORT                    default 8080
R2_JURISDICTION                default | eu | us
WORKER_CONTROL_PREVIOUS_KEY_ID \  both or neither; ids must differ
WORKER_CONTROL_PREVIOUS_SECRET /
```

**FORBIDDEN on the Worker.** These are not ignored — their mere presence is a
startup failure, unconditionally and without consulting `NODE_ENV`, because
each one means a long-lived R2 credential is sitting inside the media
container:

```
R2_WRITER_ACCESS_KEY_ID             \
R2_WRITER_SECRET_ACCESS_KEY          |  the superseded persistent contract
R2_WRITER_SESSION_TOKEN             /
R2_BROKER_PARENT_ACCESS_KEY_ID      \  the broker's parent credential
R2_BROKER_PARENT_SECRET_ACCESS_KEY  /
```

Required on the **trusted broker host only** (root-owned `EnvironmentFile`,
mode `0400`, never argv):

```
R2_BROKER_SOCKET_PATH
R2_ACCOUNT_ID
R2_BUCKET
R2_JURISDICTION                optional; default | eu | us
R2_BROKER_PARENT_ACCESS_KEY_ID
R2_BROKER_PARENT_SECRET_ACCESS_KEY
```

Every malformed **required** value fails startup closed, before `listen()`, on
both runtimes. A broker that cannot configure itself does not bind its socket,
which is what makes the Worker's dependency on it fail closed at the systemd
level rather than degrade.

Configured on **Vercel only** (never on the Worker), optional until the access
layer is deployed, and both-or-neither:

```
CLOUDFLARE_ACCESS_CLIENT_ID        \  supply BOTH or NEITHER; exactly one half
CLOUDFLARE_ACCESS_CLIENT_SECRET    /  fails closed as WORKER_UNAVAILABLE
```

Whitespace-only counts as absent. Neither value is ever logged, echoed in an
error, exposed to the browser, or prefixed with `VITE_`. See §1b.

### HMAC rotation procedure

1. Set `WORKER_CONTROL_PREVIOUS_*` on the Worker to the **current** pair.
2. Set `WORKER_CONTROL_*` on the Worker to the **new** pair. Restart.
   The Worker now accepts both identities.
3. Update Vercel's `WORKER_CONTROL_*` to the new pair.
4. Once no request signs with the old key, clear `WORKER_CONTROL_PREVIOUS_*`
   and restart.

---

## 7. Startup and shutdown behaviour

Startup is strictly ordered and fails closed. The Worker does **not** listen
until all of the following have succeeded:

```
validate configuration
  -> prepare/validate persistent directory
  -> open SQLite
  -> apply migrations
  -> conservative recovery
  -> construct writer/executor/queue/service
  -> listen
  -> wake queue
```

- An unsupported **future** schema version is a startup failure.
- A corrupt or missing expected V1 schema is a startup failure.
- An existing incompatible database is **never** silently recreated or discarded.

Recovery policy on restart (unchanged and authoritative):

| Prior state | After recovery |
| :--- | :--- |
| `queued` | stays `queued`, resumes after the startup queue wake |
| interrupted active | fails deterministically with a worker-restart classification |
| `ready` | unchanged |
| terminal | unchanged |

An operator restart is **never** converted into a user `cancelled` state.

On `SIGTERM`/`SIGINT` the Worker stops accepting new connections, stops the
maintenance timer, stops claiming further queued work, aborts in-flight media
(so no FFmpeg descendant survives the container), and closes SQLite last, all
within a bounded grace period.

Configure the platform's termination grace period to at least the Worker's
shutdown grace so a clean SIGTERM is not truncated by an immediate SIGKILL.

---

## 8. Health and maintenance

| Endpoint | Use |
| :--- | :--- |
| `GET /v1/healthz` | Unauthenticated liveness/readiness. **Unchanged.** |
| `GET /v1/diagnostics` | **Authenticated.** Never use it to gate container health. |

### Liveness ownership — the image ships NO healthcheck

`Dockerfile.worker` deliberately declares **no `HEALTHCHECK`**, and the
container-policy suite fails the build if one is reintroduced.

The reason is architectural, not cosmetic. §3 requires an externally-owned
egress policy that denies loopback, private, link-local and reserved
destinations *from inside the media namespace* — including the Worker's own
listener address. An in-container probe would therefore have to target exactly
what the boundary exists to block. The only ways to make such a probe succeed
are to add an allow exception for `127.0.0.1`/`::1`/the container's own private
address, or to weaken the deny set. **Both are forbidden.** The security
boundary outranks the convenience of a built-in healthcheck.

| Concern | Owner |
| :--- | :--- |
| Health endpoint | The Worker application — `/v1/healthz`, unchanged |
| Health **probe** | The deployment layer / VM supervisor, **from outside the restricted media namespace** |
| Restart-on-unhealthy | The deployment layer |

The probe reaches the Worker the same way the tunnel does — over the published
loopback address on the VM host, outside the media namespace — so it never
traverses the denied path. This is a deployment-layer responsibility and is
deliberately **not** implemented in application code.

Do not "fix" an unhealthy-looking container by punching a hole in the egress
policy. A Worker that cannot be probed from outside its namespace is a
deployment wiring problem, not a policy problem.

Bounded maintenance runs on a modest interval (60s) and never overlaps: expired
replay reservations, expired idempotency records, and exact-key deletion of
expired ready objects followed by conditional removal of exactly that job's
metadata. A failure in one category never stops the others and never terminates
the HTTP runtime.

---

## 9. Rollback and failure model

| Situation | Behaviour |
| :--- | :--- |
| Worker unavailable | Vercel **fails closed** with `WORKER_UNAVAILABLE`. |
| **Broker unavailable** | The Worker's R2 operation **fails closed**. `BindsTo=` stops the Worker with the broker. There is never a fallback to a persistent Worker R2 credential — none exists, and supplying one is a startup failure. |
| Local fallback | **Never.** Production must never fall back to running media processing or yt-dlp inside the Vercel runtime. |
| Worker down at expiry | Vercel still refuses to sign new URLs; the provider TTL eventually removes the object. |
| Rolling back the Worker | Deploy the previous image against the **same** persistent volume. Schema V1 is unchanged, so no data migration is involved. |
| Rolling forward | Never point a new Worker at a volume written by a **newer** schema — startup will refuse, by design. |

Because the replica count is exactly 1, a deployment is a brief interruption,
not a zero-downtime rollout. Queued jobs survive it; interrupted active jobs are
failed deterministically and may be retried by the user.

---

## 10. Phase-8B pre-flight checklist

Except for the explicitly checked decision and acceptance-evidence items below,
none of the production provisioning or deployment actions has been performed.
Each unchecked provisioning/deployment item requires explicit Product Owner
authorization.

- [ ] Host/provider and region selected.
- [ ] Persistent volume provisioned and confirmed writable by UID 1000.
- [ ] Exactly one replica configured; autoscaling disabled.
- [ ] Read-only root filesystem, writable state mount, writable ephemeral `/tmp`.
- [ ] All capabilities dropped; no privileged mode, host network or Docker socket.
- [x] **External egress deny policy applied and owned outside the container.**
      *Installed and accepted.* The source artefacts in §3a are deployed on the
      Lima VM as the Phase-8B final stack, and Phase 9 accepted the boundary in
      situ (§11a). The prototype units remain only as inactive rollback assets.
- [ ] TLS endpoint terminated in front of the Worker and reachable by Vercel.
- [x] **`R2-CREDENTIAL-SCOPE-DECISION-001` closed by the Product Owner —
      Option B (renewable, action-scoped temporary credentials).** See §5f.
      Implemented by `WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001`. The decision
      was **initially accepted using disposable live-provider material** — a
      throwaway parent credential and bucket, revoked and torn down afterwards
      (§5f), which was never production provisioning. **Production R2 and its
      credential plane were subsequently provisioned, before Phase 9.** The
      selected Option-B architecture is unchanged by that provisioning: minting
      is still renewable and action-scoped, and nothing about the credential
      model was revisited. No account identifier, bucket name, token or secret
      value is recorded here.
- [x] **`R2-BROKER-LIVE-MINT-VERIFICATION-001` closed — accepted.** The merged
      action-only temporary-credential path passed live-provider acceptance
      against a **disposable** bucket, which was torn down afterwards. See §11.
      *At the time of that closure no production R2 resource existed, and the
      items below were therefore unchecked.* **That is no longer the current
      state:** production R2 and its parent credential were provisioned before
      Phase 9, and `R2-BROKER-PARENT-TOKEN-ROTATION-001` is CLOSED. What the
      gate itself proved — that the merged mint path is correctly action-scoped
      and expiry-enforced — is unaffected either way.
- [x] **Private R2 bucket created.** Provisioned before Phase 9, private and
      Standard class, in the default jurisdiction. The broker operates against
      it continuously. *No bucket name, account identifier or credential value
      is recorded in this repository.*
- [x] **Provider lifecycle TTL backstop configured**
      (`R2-PROVIDER-LIFECYCLE-BACKSTOP-001`). Rule
      `videofetch-expired-job-backstop`, prefix `videofetch/jobs/`, delete at
      age 3600s, verified by API readback. See §5h.
- [x] **Broker parent credential created — bucket-scoped, no bucket
      administration.** Provider permissions are necessarily broader than the
      Put/Head/Delete surface; narrowing happens per operation at mint time via
      local signing. See §5b. The absence of bucket administration is
      *positively evidenced*: a read-only `GetBucketLifecycleConfiguration`
      issued with this credential is refused `AccessDenied` (HTTP 403), so
      lifecycle management genuinely requires separate authorization.
- [x] **Dedicated `videofetch-broker` system user created; parent credential
      installed at `/etc/videofetch/r2-broker.env`, root-owned, mode `0400`,
      never on the Worker and never in argv.** Verified: the user exists, the
      file is `-r--------` root:root, and the socket is owned
      `videofetch-broker:videofetch-broker` mode `0660`.
- [x] **`videofetch-r2-broker.service` installed and started before the Worker;
      socket present at `R2_BROKER_SOCKET_PATH`, mode `0660`.** Verified across
      a fresh boot: the broker reaches active ahead of the Worker.
- [x] **Worker unit declares `Requires=` + `After=` + `BindsTo=` on the broker
      unit; broker-stop confirmed to stop the Worker rather than degrade it.**
- [x] **Broker socket directory bind-mounted read-only into the Worker
      container; Worker container added to the broker group.** Verified: the
      mount reports `rw=false` and the Worker carries the broker GID.
- [x] **Confirmed the Worker container environment and argv contain no
      `R2_WRITER_*` and no `R2_BROKER_PARENT_*`.** Re-verified against the
      running container. See `deploy/README.md`.
- [x] **Vercel signer credential created separately — bucket-scoped, no bucket
      administration.** Provider permissions may be broader than signed GET; see
      §5b. *Operator-attested: provisioned outside this repository and not
      independently re-verified here, since verifying it would require Vercel
      credentials this task deliberately does not hold.*
- [ ] `WORKER_CONTROL_*` generated and configured on both runtimes.
- [x] **`YTDLP_NETWORK_ISOLATED` confirmed false/unset.** Verified in the
      running Worker container; yt-dlp is absent from the image and the VM.
- [ ] Termination grace period >= Worker shutdown grace.
- [x] **Named tunnel created against a stable hostname; no router port
      forwarding; Worker not bound to any LAN or public interface.** Verified:
      the tunnel's ingress resolves a stable hostname to `http://127.0.0.1:8080`
      and the Worker publishes on VM loopback only.
- [ ] Access application + **Service Auth** policy created; service token issued.
- [ ] `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET` set on
      **Vercel only** — both or neither — and never on the Worker.
- [x] **`CLOUDFLARE-ACCESS-ORIGIN-CREDENTIAL-STRIPPING-001` resolved and
      accepted.** Measured externally against the real Service Auth
      configuration. See §11.
- [ ] External liveness probe wired in the deployment layer, from **outside**
      the restricted media namespace. The image ships no `HEALTHCHECK`.
- [ ] `GET /v1/healthz` returns 200 through the TLS endpoint.
- [x] **Phase-9 safe-egress acceptance suite executed from inside the deployed
      boundary.** Executed 2026-08-30 and ACCEPTED. See §11a.

---

## 11. Tracked follow-ups

| Id | Status | Notes |
| :--- | :--- | :--- |
| `R2-CREDENTIAL-SCOPE-DECISION-001` | **RESOLVED / CLOSED — Option B** | The Product Owner selected Option B: renewable, action-scoped temporary credentials. Implemented by `WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001` — the media Worker holds no persistent R2 credential, a trusted host broker outside the media namespace retains the single-bucket parent writer credential, and each operation receives a credential scoped to one bucket, one exact `WorkerObjectKey` and one S3 action with a bounded TTL, expressed as an action-only JWT claim set (corrected by `R2-TEMP-CREDENTIAL-ACTIONS-ONLY-001`; see §5b). The decision was **initially accepted using disposable live-provider material** — a throwaway bucket and parent token, torn down once that acceptance passed (§5f). **Production R2 and its credential plane were provisioned later, before Phase 9**, and the provider lifecycle backstop was added afterwards (§5h). The selected Option-B architecture is unchanged by either: minting stays renewable, action-scoped and per-operation. No account identifier, bucket name, token or secret value is recorded here. |
| `R2-BROKER-PARENT-TOKEN-ROTATION-001` | **CLOSED** | Production R2 and its credential plane were provisioned **before** Phase 9, and the parent token was provisioned and verified with them. Custody is unchanged: the token remains a persistent broker-side credential held in the broker's `EnvironmentFile`, and rotation remains an `EnvironmentFile` update plus `systemctl restart videofetch-r2-broker`, which `BindsTo=` propagates as a brief Worker restart. No code change was required. Phase 9 did not exercise or modify R2 in any way; the broker ran untouched throughout with `NRestarts=0`. No account identifier, bucket name, token or secret value is recorded here. |
| `R2-BROKER-LIVE-MINT-VERIFICATION-001` | **CLOSED — accepted** | **Initial failure → correction → definitive acceptance → teardown.** *First attempt, FAILED:* real R2 was reached and rejected the then-merged `scope + actions` credential at token **parsing** — `HTTP 400 InvalidArgument` on `X-Amz-Security-Token`, before any authorization decision — so the production path failed closed rather than over-granting; diagnostic action-only credentials were accepted and showed the intended enforcement, and expiration went unmeasured. *Correction:* `R2-TEMP-CREDENTIAL-ACTIONS-ONLY-001` (PR #21) changed **production** credentials to action-only claims (see §5b). *Definitive rerun, PASSED:* run against this repository's merged production implementation — the merged `mintTemporaryCredential` signer, the merged `CloudflareR2ObjectStoreWriter` for Put/Head/Delete, repository-generated `WorkerObjectKey` values, all three temporary-credential fields on every delegated request, **no parent-credential fallback** (a raw AWS SDK client was used only for `GetObject`/`ListObjectsV2`, which the production writer deliberately omits). The **full matrix passed**: under its own credential, exact-key `PutObject`, `HeadObject` and `DeleteObject` each **succeeded**, while every **cross-action** attempt, every **sibling-object** attempt and **`ListObjectsV2`** were **denied by R2** — provider-side authorization denials, not local or network failures. Denied sibling writes and deletes left the sibling untouched, the sibling genuinely existed during the head and delete sibling tests (no missing-object ambiguity), the delete negatives ran while the exact object still existed, and no post-delete 404 was used as denial evidence. **Natural expiration was enforced** on real wall-clock time (§5b) — a 1-second production credential replayed at `exp + 30s` was denied and created nothing, the observed expired-credential response in this acceptance being `403 SignatureDoesNotMatch` rather than a dedicated expiry code; because that response is not expiry-specific, the result was isolated by before/after acceptance of equivalent 1-second credentials for both `HeadObject` and `PutObject`. *Cleanup:* all task-owned objects were removed with fresh exact-key `DeleteObject` credentials and a read-only parent check reported 0 objects at the job prefix, 0 at the `videofetch` prefix and 0 bucket-wide. *Teardown (operator-attested, not independently re-verified):* disposable parent token revoked, disposable bucket confirmed empty and deleted, local acceptance credential file removed (§5f). **This gate therefore no longer blocks production R2 traffic.** Closure means only that the merged temporary-credential model passed live-provider acceptance — *at the time of closure* it did not mean production R2 was provisioned, that `R2-BROKER-PARENT-TOKEN-ROTATION-001` was resolved, or that Phase 9 or Phase 10 had progressed. **Those particular caveats have since been overtaken:** production R2 and its parent credential were provisioned before Phase 9, `R2-BROKER-PARENT-TOKEN-ROTATION-001` is CLOSED, and Phase 9 is COMPLETE / ACCEPTED. What this gate itself proved — that the merged mint path is action-scoped, exact-key and expiry-enforced against the live provider — is unaffected by any of that. It still does not mean Phase 10 progressed or that yt-dlp may be enabled; both remain closed off. |
| `CLOUDFLARE-ACCESS-ORIGIN-CREDENTIAL-STRIPPING-001` | **CLOSED — accepted** | Empirically measured and accepted against the real Cloudflare Access Service Auth configuration; the gate is no longer blocking and is not reopened here. Scope note, unchanged: this is an acceptance of the measured INGRESS path, not a source-level property. This repository proves only that the Access service token is configured on Vercel alone and that the Worker application never consumes, verifies, persists or intentionally logs it — that part is still asserted by the control-plane boundary suite. Any change to the ingress topology invalidates the acceptance and requires a re-measurement. |
| `PHASE-8B-SAFE-EGRESS-PROTOTYPE-RECOVERY-001` | **Source recovery complete; NOT a deployment or an acceptance** | The prototype's enforcement model was recovered from the Lima VM into reviewed source under `deploy/` and reconciled with the trusted-broker architecture (§3a). At the time of recovery the live VM was **not modified**, so prototype and reconciled source stayed comparable. No secret was copied: the only credential-shaped material encountered was clearly-labelled `FAKE_PROTOTYPE_*` placeholders in the stale prototype Worker unit, which is intentionally not recovered. **Superseded by deployment:** the reconciled artefacts have since been installed as the Phase-8B final stack, the prototype units are present but disabled and inactive, and Phase 9 acceptance PASSED against that live topology on 2026-08-30 — see §11a. |
| `SAFE-EGRESS-NORDVPN-CONNECTED-RETEST-001` | **CLOSED — accepted 2026-08-30** | The COMPLETE acceptance suite was re-run against the live final topology with the operator's NordVPN client **actively connected** using their normal configuration (features left exactly as configured; none were enabled or disabled for the test). Connection was confirmed independently: the macOS default route moved to the NordLynx `utun` interface and the primary resolver changed with it. The VM's own routing was unaffected — Lima's `vz` NAT insulates the guest, so the media namespace's route fingerprint was byte-identical throughout and the watchdog recorded no breach. Under VPN the verifier passed **50/50** consecutive runs, and the whole matrix reproduced the disconnected-state result: every forbidden destination denied, counters attributed, designated DNS working, non-designated DNS dropped, rebinding and the controlled redirect contained, public HTTP/HTTPS succeeding, descendants confined, mutation refused, and the multicast measurement repeated. The operator's original (disconnected) state was restored and re-verified afterwards. See §11a. |
| `SAFE-EGRESS-MULTICAST-ATTRIBUTION-001` | **CLOSED — accepted 2026-08-30** | IPv4 `224.0.0.0/4` and IPv6 `ff00::/8` were denied by absence of a route rather than by an exercised rule, so their counters never incremented. Every other range was counter-attributed. `deploy/bin/vf-egress-multicast-route-test` now installs a minimal temporary route so those destinations reach the enforcement point and the denial can be attributed to the rule's own counter. It is acceptance-only: no unit references it, it refuses to run without `--phase9-acceptance` and root, it refuses to run outside a namespace carrying the `inet videofetch_egress` table, and it never touches nftables. **Corrected in Correction 01:** the first implementation mutated routes and only then re-baselined the route fingerprint, while the watchdog was still subscribed to route events — a race whose outcome depended on scheduling. The helper now *quiesces* the boundary instead (stop Worker → stop watchdog → assert both stopped → mutate → measure → unwind → re-verify → restart), re-baselines nothing, and bounds the permitted route delta to exactly the intended multicast destinations. No bypass was added to the verifier or watchdog. See §3d. **Executed against the live VM in Phase 9**, disconnected and again under NordVPN. The helper behaved exactly as designed — quiesce, install only the intended narrow routes, probe, unwind, restore byte-for-byte, re-verify — but its TCP probe left `deny-v4`/`deny-v6` flat in every run, and it correctly refused to call that attribution. The cause was isolated with a control experiment in a throwaway namespace carrying a valid route to the same destinations and **no firewall whatsoever**: TCP `connect()` to a multicast address still returned `ENETUNREACH` there, so the Linux socket layer rejects multicast TCP before netfilter's output hook is consulted, and no TCP probe can ever attribute it. UDP to the same destinations does emit a packet. Repeating the helper's exact discipline with a UDP probe moved **`deny-v4` +1 and `deny-v6` +1**, with the route delta bounded to the intended destinations, the policy fingerprint unchanged during the window, the route table restored exactly and the boundary re-verified. Multicast is therefore denied **by the rule**, and the flat TCP counter is a kernel property rather than a gap in this boundary. No bypass was added to the verifier or the watchdog. |
| `SAFE-EGRESS-ROUTE-VERIFIER-HARDENING-001` | **CLOSED — accepted 2026-08-30** | The prototype verifier fingerprinted the `nftables` ruleset but not the namespace **route table**. Non-blocking, as before: destination denial was proven to survive route injection, and a route cannot defeat a destination-address deny. Source hardening is now merged — see §3b — combining a baseline-free semantic invariant over policy-routing rules with a runtime route/rule fingerprint captured by the trusted install path and stored under `/run`. The watchdog additionally subscribes to route and link netlink events. **Verified in situ during Phase 9 on 2026-08-30.** The installed verifier hash-matches the `origin/main` blob exactly, and it ran against the real namespace on the real VM throughout acceptance — including 50 consecutive executions under NordVPN, all passing, and repeated runs across the multicast quiesce/mutate/restore windows. It reported identical policy and route fingerprints on every invocation, correctly refused nothing that was intact, and the deliberate route mutations it is meant to catch were caught by the helper's own comparison before the verifier was consulted. The gate is closed. |
| `PRODUCTION-DNS-RESOLVER-001` | **CLOSED — deployed and fresh-boot verified** | The media namespace was configured to use the designated resolver `172.17.0.1:53` — holder `--dns` flag, namespace `resolv.conf` and the rendered policy's exact UDP/TCP 53 exception all agreeing — while **nothing listened there**. The resolver that satisfied the Phase-9 DNS cases belonged to the acceptance and was removed by its cleanup, so ordinary hostname resolution failed (`EAI_AGAIN`) while direct connections to public IP addresses kept working. Confirmed on a fresh boot with every unit active, the Worker reporting healthy and the verifier passing — which was the defect itself. **Closed by PR #28, merge commit `4d4f90c60dd9feba8c423022aa34f467fd093691`.** `systemd-resolved` now carries an extra stub listener at the designated address (`DNSStubListenerExtra`), chosen over a new daemon because resolved is already the VM's resolver and already follows its upstream configuration. `vf-media-dns-check` probes that address — read from `media-egress.env`, never from the drop-in — on both transports, and `videofetch-media-dns.service` runs it as a `Type=notify` readiness gate ordered in front of the namespace holder. The Worker declares `Requires=`/`After=`/`BindsTo=` on it; the holder deliberately takes only the first two, so a DNS fault stops the Worker without tearing down the boundary. **The designated address was not changed and the nftables policy was not touched**: the policy and route fingerprints are byte-identical to the Phase-9 baseline, so this is a functional addition, not a boundary change. Verified post-deployment and again after a controlled reboot: exact UDP and TCP listeners with no wildcard or LAN exposure, readiness probe passing on both transports, Worker hostname resolution and HTTPS-by-hostname succeeding, non-designated resolvers still denied, and `172.17.0.1` still reachable on port 53 alone. Phase 9 was neither rerun nor reopened. |
| `R2-PROVIDER-LIFECYCLE-BACKSTOP-001` | **CLOSED** | The production bucket had no object-expiration rule: its only lifecycle entry was a default multipart-abort rule, which deletes nothing by age. A backstop named `videofetch-expired-job-backstop` was added — enabled, scoped to the `videofetch/jobs/` prefix, deleting objects at an age of **3600 seconds**, with no storage-class transition — and the pre-existing multipart rule was preserved by appending rather than replacing the configuration. 3600s is deliberately longer than the application's 45-minute `FILE_EXPIRATION_MINUTES` so ordinary exact-key cleanup always attempts deletion first; the provider rule only collects what that path misses. Verified by independent API readback, not by a dashboard message, and further evidenced by a throwaway object whose `x-amz-expiration` header named this rule with an expiry exactly 3600s after write; that object was then deleted through the normal delegated exact-key path and the bucket confirmed empty. Provider deletion is asynchronous, so this guarantees eventual collection rather than deletion at a specific instant. Authorization was a temporary narrowly scoped R2 token: its local copy was securely deleted immediately after use and the operator has since revoked the token at the provider (operator-attested). The broker parent credential is refused lifecycle access by design. See §5h. |
| `WORKER-TEMP-TMPFS-OWNERSHIP-001` | **CLOSED — merged, deployed and proven by a real job** | The Worker unit mounted its media temp filesystem as `--tmpfs /tmp/videofetch:rw,noexec,nosuid,size=2g`, with no ownership options. A tmpfs is a fresh filesystem mounted **over** the mountpoint, so it shadowed the directory `Dockerfile.worker` creates and `chown`s to `node:node`, and the kernel gave the new mount `root:root 0755` while the Worker runs as uid/gid **1000**. The first production direct-media job therefore failed `PROCESSING_FAILED` about 13 ms in, on `mkdir /tmp/videofetch/jobs` → `EACCES`, with `object_key = null` and nothing written to R2. Image-layer ownership cannot satisfy a path a tmpfs is mounted over; only the mount can. Fixed by appending `uid=1000,gid=1000` — **PR #29, merge commit `a5eba777d7b169f83836f045fcf43bab8578c6f6`**. `rw`, `noexec`, `nosuid`, `size=2g`, `--read-only`, `--cap-drop=ALL` and `no-new-privileges` are all retained, the Worker still runs non-root, the mount is not world-writable and is still a tmpfs rather than a host bind, and no application code changed. The suite's previous single order-sensitive regex had actively certified the broken declaration; it is replaced by an option-set parser plus guards against relaxing `noexec`/`nosuid` or substituting a bind mount. Verified live and then proven by a real production job. See §11c. |
| `VERCEL-DIRECT-MEDIA-E2E-001` | **CLOSED — complete production chain accepted 2026-08-30** | The full path — private-access authentication on Vercel Production, Vercel → Cloudflare Access → named Tunnel → Worker HMAC, `direct` extraction of a controlled public MP4, real job execution on the Worker, `PutObject` + `HeadObject` through the trusted broker, `ready` commit with a durable `object_key`, and a byte-identical download through Vercel's **separate** R2 signer — was executed end to end and passed. yt-dlp was neither present nor invoked. See §11c. |
| `NPM-LOCKFILE-RECONCILIATION-001` | **CLOSED** | `package-lock.json` carries a pre-existing devDependency resolution (`nitro` → `unstorage` requires `lru-cache@^11`, the lock pins `5.1.1`) that npm 10 rejects and npm 11 accepts. The Worker image works around it with an exact-pinned ephemeral npm 11 running `ci`; no `npm install` is used and the lockfile is unmodified. **Resolved and merged** in PR #24 (merge commit `7009550d5573dc5b7d3b7eda7efaf20120a1c22f`), with npm `11.19.1` pinned and the lockfile intentionally unchanged. |

---

## 11a. Phase-9 safe-egress acceptance record

**`PHASE-9-SAFE-EGRESS-ACCEPTANCE-001` — PASSED, 2026-08-30.**

| | |
| :--- | :--- |
| Deployed `main` | `a68243868bafeb88125eccca9344ea6751a76cf5` |
| Tree | `735d79feb29c2a3ef228d70e24347633c0e50c1b` |
| Topology accepted | Phase-8B final stack on the `videofetch` Lima VM |
| Acceptance date | 2026-08-30 |
| Policy fingerprint | `7cb95aaee72c91c2…` — identical before, during and after |
| Route fingerprint | `97960e25cd6925e2…` — identical outside the controlled multicast windows |
| yt-dlp | absent; `YTDLP_NETWORK_ISOLATED=false` throughout |
| Phase 10 | NOT BEGUN |

All six final units then deployed (`videofetch-media-netns`,
`videofetch-egress-policy`, `videofetch-egress-watchdog`,
`videofetch-r2-broker`, `videofetch-worker`, `vf-cloudflared`) were active and
enabled with `NRestarts=0` before, during and after. *Six is the count that was
correct during this measurement;* `videofetch-media-dns.service` was added
afterwards by `PRODUCTION-DNS-RESOLVER-001`, so the current topology has seven
— see §11b. Worker health returned HTTP 200 at every checkpoint. Every installed
`deploy/bin` tool hash-matched its `origin/main` blob exactly, as did every
acceptance probe staged into the Worker's `noexec` tmpfs.

### What was measured

The committed suite in `deploy/acceptance/safe-egress/` was run unmodified from
inside the Worker container as its unprivileged runtime user, against
environment values **derived from the live topology** rather than reused from
the prototype. The designated resolver `172.17.0.1` was confirmed from four
agreeing sources (`media-egress.env`, the holder's `--dns` flag, the namespace
`resolv.conf`, and the rendered nftables rule). The public test address was
proved to fall outside every element of the live `forbidden_v4` set and outside
every named private, loopback, link-local, CGNAT, documentation, reserved and
multicast class before use.

Forbidden destinations were made **genuinely live** so that a refusal could not
mean "nobody was home": `fixture.py` listened on the docker0 bridge address
(`172.17.0.1`, forbidden via `172.16.0.0/12`) and on its ULA address
(`fd00:cafe::1`, forbidden via `fc00::/7`) — both of which are the namespace's
own default gateways, so they are reachable at the routing layer. Both returned
their known body when fetched from the VM host, and both were refused from
inside the namespace.

**No forbidden destination connected, in either network state.** Loopback (the
Worker's own live port), RFC1918, CGNAT, metadata/link-local, TEST-NET-2/3,
benchmark, reserved, IPv4-mapped, IPv6 ULA, IPv6 link-local, 6to4, Teredo,
NAT64 and multicast were all denied. Permitted public TCP 80 and 443 connected
and a real HTTPS GET returned 200.

### Counter attribution

Each family was measured as counter-before → one probe → counter-after against
the rule comments in the **live rendered** policy:

| Rule | Exercised by | Result |
| :--- | :--- | :--- |
| `deny-v4` | live RFC1918 fixture, loopback, CGNAT, metadata | +1 per probe |
| `deny-v6` | live ULA fixture, link-local, NAT64 | increments per probe |
| `fallthrough-drop` | non-designated resolver (UDP and TCP), arbitrary port | increments per probe |
| `public-http` | permitted public 80 and 443 | +1 per probe |
| `designated-dns-udp` / `designated-dns-tcp` | designated resolver | +1 each |

The IPv6 link-local case reports `DENIED(timeout)` rather than a refusal, which
on its own would be ambiguous; `deny-v6` moved for it, so the denial is
attributed to the rule. A negative control was also recorded: during the
non-designated DNS probe `deny-v4` stayed **flat** while `fallthrough-drop`
moved, confirming the counters discriminate between rules rather than simply
tracking activity.

DNS **policy** behaved as specified. The designated resolver resolved; a real,
working public resolver (`9.9.9.9`, verified functional from the VM host) was
denied from inside the namespace. A public name answered with a private address
resolved but could not be connected to; the same held for a loopback answer. In
the rebinding case the first answer was public and behaved as public, and the
subsequent forbidden answer was denied — at TTL 0, so no cache masked the
change.

**What the designated-DNS result does and does not say.** Those cases passed
against a resolver the acceptance itself supplied at `172.17.0.1:53`, which was
**intentionally removed during cleanup**. They demonstrate that the *policy*
admits exactly that address on port 53 and denies every other resolver — which
is what Phase 9 set out to prove.

They do **not** demonstrate durable production name resolution, and Phase 9 never
claimed to. Immediately after this cleanup there was no listener at the
designated address at all, so ordinary Worker hostname resolution was absent —
a functional readiness gap, never a boundary weakness. That gap was closed
later, outside Phase 9, by `PRODUCTION-DNS-RESOLVER-001`: PR #28 deployed a
durable resolver and a readiness dependency, and hostname resolution was
verified in the live Worker across a fresh boot. See §11b. The distinction
matters — the acceptance evidence above is about the *policy*, and the readiness
work is a separate, later change that did not touch it.

### Multicast

Recorded in full in the `SAFE-EGRESS-MULTICAST-ATTRIBUTION-001` row above. In
short: the committed helper's lifecycle works correctly, but its TCP probe can
never attribute multicast, because the Linux socket layer rejects TCP
`connect()` to a multicast address before netfilter is consulted — demonstrated
by a control experiment in a namespace with a valid route and **no firewall at
all**, where the same `ENETUNREACH` appeared.

To be precise about provenance: **the committed helper did not produce the
successful measurement.** In every run of the shipped helper the counters stayed
flat and it correctly declined to call that attribution. The accepted evidence
came from a separate UDP probe run under the helper's identical
quiesce/mutate/restore discipline, which moved `deny-v4` and `deny-v6` and
established that multicast is denied by the rule.

**The helper was corrected afterwards.** PR #28 replaced its TCP probe with a
bounded UDP datagram per family, and the deployed helper then reproduced the
measurement itself — `deny-v4` +1 and `deny-v6` +1, routes restored exactly,
boundary re-verified. That was **tooling reconciliation, not another Phase-9
run**: the gate was already closed on the evidence above, and re-running the
corrected helper neither reopened nor re-established it. What changed is only
that the measurement is now reproducible from committed repository tooling
instead of a one-off probe.

### Containment and mutation incapability

A genuine child process spawned with `child_process.spawn()` was denied at the
live forbidden fixture (`deny-v4` +1) and permitted to the public endpoint
(`public-http` +1), so the boundary applies to descendants and not merely to a
top-level probe.

The Worker container reports `Privileged=false`, empty `CapAdd`,
`CapDrop=[ALL]`, `no-new-privileges`, a read-only rootfs and no Docker socket;
its process capability sets — including the **bounding** set — are all zero, so
no capability can be regained. A disposable helper container joined to the same
namespace with `--cap-drop=ALL`, `no-new-privileges` and `--read-only` (never
privileged, never `NET_ADMIN`/`SYS_ADMIN`, never host network, never the Docker
socket) attempted to create an nftables table, add a rule to the production
chain, flush the ruleset, add and delete routes, take the interface down and add
an address. **All attempts failed with `EPERM`**, no test table appeared, and
both fingerprints were unchanged immediately afterwards with the verifier
passing.

### Redirect

The public→forbidden redirect case used an **operator-controlled** endpoint, not
a third-party redirect service: a local redirector returning
`302 Location: http://172.17.0.1:18080/` exposed through a temporary Cloudflare
Quick Tunnel on a random ephemeral hostname. The tunnel ran as a separate
process against an isolated empty config; `/etc/cloudflared/config.yml` and the
named-tunnel credential were **byte-identical** before and after, `vf-cloudflared`
was never restarted and kept `NRestarts=0`, and no DNS record or Access policy
was touched. The redirector returned the expected 302 over plain HTTP, the
Worker received the `Location`, and following it to the forbidden target was
denied.

### Evidence attribution

Directly measured in this task: all service, container, capability, fingerprint,
counter, route and verifier evidence above; both suite runs; the multicast runs
and the control experiment; the cleanup verification. The macOS VPN state was
verified **read-only** from host routing, interface and resolver state, which
independently corroborated the operator's report of Connected and Disconnected.

Resting on operator action, not on independent verification: that NordVPN was
connected using the operator's normal configuration with no feature changed for
the test.

**Ingress was not remeasured.** Phase 9 ran against the final Worker
**safe-egress** topology. The existing named Tunnel and its configuration were
unchanged throughout — `vf-cloudflared` kept `NRestarts=0`, was never restarted,
and both files under `/etc/cloudflared` were byte-identical before and after. The
previously accepted `CLOUDFLARE-ACCESS-ORIGIN-CREDENTIAL-STRIPPING-001` evidence
**remains valid and was not remeasured**; Phase 9 neither re-accepted it nor
depended on re-accepting it.

Out of scope and untouched here: R2 (provisioned before Phase 9 — the broker ran
untouched with `NRestarts=0` and no R2 request was made by this acceptance),
Vercel environments, Cloudflare Access and DNS records. Their gates are unchanged
by this run.

### Cleanup

Every acceptance-owned artefact was removed: both fixtures, the controlled
resolver, the redirector, the Quick Tunnel, the disposable helper image and
container, the staged probe files in the Worker tmpfs, and the root-owned
scratch directory. No temporary route, host alias or test nftables table
remains, the Worker tmpfs is empty, and the only `cloudflared` process is the
original production one. The boundary verified and health returned 200 after
cleanup.

---

## 11b. Production name resolution — deployed and verified

**`PRODUCTION-DNS-RESOLVER-001` — CLOSED.** Closed by PR #28, merge commit
`4d4f90c60dd9feba8c423022aa34f467fd093691`.

### The defect

Phase 9 proved a property of the **policy**: the boundary admits exactly
`172.17.0.1` on UDP and TCP port 53 and denies every other resolver, including a
real working public one. It proved that using a resolver the acceptance itself
started at that address, and that resolver was intentionally removed during
cleanup along with every other acceptance-owned artefact.

Nothing else ever listened there. The configuration was internally consistent
and agreed across all four sources — `media-egress.env`, the holder's
`HostConfig.Dns`, the namespace `resolv.conf`, and the rendered
`designated-dns-udp`/`designated-dns-tcp` rules — but the VM's
`systemd-resolved` bound only `127.0.0.53` and `127.0.0.54`, so the designated
address had no listener. Ordinary hostname resolution failed with `EAI_AGAIN`
while connections to public IP addresses still succeeded, and a fresh boot came
up with every unit active, the Worker healthy and the verifier passing. **The
stack reported fully operational while its configured resolver was absent.**

That was a functional readiness defect, never a safe-egress bypass: the boundary
was intact throughout and no rule was broadened by it.

### The fix, as deployed

**A durable listener.** `systemd-resolved` carries an extra stub listener at the
designated address. It was chosen over a dedicated daemon because resolved is
already the VM's resolver and already follows its upstream configuration, so the
namespace inherits what the VM legitimately uses rather than a public resolver
fixed in source. The committed drop-in ships unfilled; the deployment renders it
with the address parsed from `media-egress.env`.

Ordering looks like it should defeat this and does not, which was **verified
rather than assumed**: `systemd-resolved` starts several seconds before
`docker.service`, so `docker0` and its address do not yet exist when the stub
binds. It binds anyway, because systemd sets `IP_FREEBIND` on stub listener
sockets. The listener was observed to survive a `systemd-resolved` restart, a
`docker` restart that destroys and recreates `docker0`, `docker0` taken
administratively down and back up, and two full VM reboots.

**A readiness gate.** `vf-media-dns-check` probes the address taken from
`media-egress.env` — never from the drop-in, so a disagreement between the two
files fails the unit instead of passing quietly — on **both** transports. It
deliberately does not test whether the Internet resolves: any rcode counts,
because `NXDOMAIN`, `SERVFAIL` and `REFUSED` all prove a resolver is listening
and speaking DNS, and the query is for a `.invalid` name that needs no upstream
traffic at all. Functional readiness is kept strictly apart from the security
verification in `vf-egress-policy-verify`; neither script calls the other.

**A lifecycle.** The final topology now orders resolver readiness in front of
the boundary:

```
videofetch-media-dns.service        resolver answering on UDP+TCP 53
        ↓
videofetch-media-netns.service      namespace created with --dns <that address>
        ↓
videofetch-egress-policy.service
        ↓
videofetch-egress-watchdog.service
        ↓
videofetch-worker.service           (also BindsTo videofetch-r2-broker.service)
```

The holder takes `After=` and `Requires=` but deliberately **not** `BindsTo=`,
so a transient DNS fault cannot tear down the namespace and force the policy to
be reinstalled. The Worker takes all three. This was exercised rather than
asserted: killing the readiness process so systemd saw an unexpected failure
stopped the Worker through `BindsTo=`, while the namespace holder, its container
identity and the `inet videofetch_egress` table all survived untouched, and both
recovered on restart.

### Post-deployment verification

Verified after deployment and again after a controlled reboot:

| | |
| :--- | :--- |
| Designated address | `172.17.0.1` — **unchanged**, parsed from config and agreeing across all four sources |
| Listener | exact UDP and TCP 53 on that address only |
| Wildcard / LAN exposure | none — no `0.0.0.0:53`, no `[::]:53`, no LAN-address listener |
| Readiness probe | PASS on both transports |
| Worker hostname lookup | resolves |
| HTTPS GET by hostname | HTTP 200 |
| Direct public-IP egress | HTTP 200 |
| Non-designated resolver | still denied |
| `172.17.0.1` on other ports | `:8080` and `:443` denied, `deny-v4` +1 each |
| Private / loopback | still denied |
| Policy fingerprint | `7cb95aaee72c91c2…` — unchanged from the Phase-9 baseline |
| Route fingerprint | `97960e25cd6925e2…` — unchanged from the Phase-9 baseline |

**No safe-egress rule changed.** The nftables policy was never touched, the
designated address was never changed, and the exception remains one exact host
on port 53 alone. Phase 9 was neither rerun nor reopened by this work.

### The final topology is now SEVEN services

`videofetch-media-dns`, `videofetch-media-netns`, `videofetch-egress-policy`,
`videofetch-egress-watchdog`, `videofetch-r2-broker`, `videofetch-worker` and
`vf-cloudflared` — all active and enabled after a fresh boot with `NRestarts=0`.
Descriptions of the Phase-9 measurement itself correctly say six, because six
was the count at that time.

### Multicast tooling reconciliation

Separate from the DNS work, and worth keeping distinct from the acceptance
record:

- **Phase-9 acceptance used a supplementary UDP measurement.** The committed
  helper's TCP probe reported flat counters and correctly declined to call that
  attribution; the accepted evidence came from a UDP probe run under the same
  quiesce/mutate/restore discipline.
- **PR #28 corrected the committed helper to UDP**, so the measurement is
  reproducible from repository tooling rather than a one-off probe.
- **The deployed helper then reproduced it**: `deny-v4` +1 and `deny-v6` +1,
  route table restored exactly, boundary re-verified, watchdog and Worker
  restarted cleanly, `OK - nothing left behind`.

This was **tooling reconciliation, not a second Phase-9 acceptance.** The
multicast gate was already closed on the Phase-9 evidence and is unchanged by it.


---

## 11c. Production direct-media end-to-end record

**`WORKER-TEMP-TMPFS-OWNERSHIP-001` — CLOSED.
`VERCEL-DIRECT-MEDIA-E2E-001` — CLOSED. Both on 2026-08-30.**

This section records the first successful production media job, and the
deployment defect that had to be fixed to obtain it. Evidence is attributed
throughout: **GitHub-verifiable**, **Lima runtime measurement**, **Vercel
measurement**, **provider evidence**, or **operator-attested**.

### The tmpfs ownership defect

The first production direct-media attempt proved the whole upstream chain and
then failed at execution. Job `ab7ee139…` went `queued → failed` with
`PROCESSING_FAILED` roughly 13 ms after start, `object_key = null`, nothing in
R2, and yt-dlp never invoked. The failing syscall was:

```
mkdir /tmp/videofetch/jobs  ->  EACCES
```

The cause was **runtime mount semantics, not application code.**
`Dockerfile.worker` does prepare the directory correctly:

```dockerfile
RUN mkdir -p /var/lib/videofetch /tmp/videofetch \
  && chown -R node:node /var/lib/videofetch /tmp/videofetch
USER node
```

but the unit then mounted a tmpfs **over** that path. A tmpfs is a fresh, empty
filesystem placed on the mountpoint; it does not inherit the ownership of the
directory beneath, which is merely covered. With no `uid=`/`gid=` options the
kernel created the mount root as `root:root 0755`, while the Worker runs as the
image's non-root `node` user, uid/gid **1000**. The `chown` in the image was
real but unreachable.

`createJobDir()` needs `/tmp/videofetch/jobs` and then
`/tmp/videofetch/jobs/<32hex>`. Its `ensureJobsRoot()` wraps the `mkdir` failure
as `UnsafePathError`, which the executor surfaces as `PROCESSING_FAILED` — which
is exactly the observed symptom.

**Measured on the live VM before the fix** (Lima runtime measurement):

```
runtime uid/gid : 1000 / 1000
/tmp/videofetch : owner=0:0 mode=755
mount           : tmpfs rw,nosuid,nodev,noexec,relatime,size=2097152k,mode=755,inode64
contents        : empty — no jobs/ directory had ever been created
```

### The mount correction, as deployed

One line of `deploy/systemd/videofetch-worker.service`:

```diff
-  --tmpfs /tmp/videofetch:rw,noexec,nosuid,size=2g \
+  --tmpfs /tmp/videofetch:rw,noexec,nosuid,size=2g,uid=1000,gid=1000 \
```

`1000:1000` is the `node` user of the `node:22-bookworm-slim` base — the image's
established runtime identity, measured rather than assumed. It is written
numerically for the same reason `--group-add` is: a kernel mount option takes
ids, not names, and the container's `/etc/passwd` is not consulted.

**Nothing was traded away for it.** `rw`, `noexec`, `nosuid` and `size=2g` are
retained; `--read-only`, `--cap-drop=ALL` and `--security-opt no-new-privileges`
are retained; the Worker still runs non-root; the mount is **not**
world-writable — the grant is exactly the Worker's own uid/gid and nothing
wider; and it remains a tmpfs rather than becoming a host bind mount, which
would have put media working files on the VM disk and outside the size bound.
No application-runtime source changed.

**GitHub-verifiable.** PR #29, one commit `38dfc4da25066b8bdcdd2b46160642e5d0e27fa1`,
+110/−2 across exactly two files — the unit and
`src/worker/runtime/safe-egress-deployment-policy.test.ts`. Merged as a regular
merge commit `a5eba777d7b169f83836f045fcf43bab8578c6f6`, whose parents are
`2dc235145fc91ce20d12790495373de52befc695` and the approved head, and whose tree
`efd6e0cf1947cf9812e4f7591d0c3b5b2a6d5a32` equals the approved head tree exactly.
This repository has no CI: there were no workflow runs, statuses or check runs on
that head, and none is claimed.

### Why the regression test had to change too

The suite previously asserted one exact option string:

```ts
assert.match(exec, /--tmpfs\s+\/tmp\/videofetch:rw,noexec,nosuid,size=2g\b/);
```

That assertion **actively certified the broken declaration** — it described as
correct a mount the Worker could not write. It is replaced by a small semantic
parser that extracts the option list and asserts over the **set**: the required
options must all be present, `exec`/`suid`/`ro` must not appear, any `mode=`
must not be world-writable, and `/tmp/videofetch` may not be served by a
`--volume` or `--mount` bind. Re-ordering the options is therefore free, while
dropping one fails. Against the pre-fix unit the corrected suite fails with
`the /tmp/videofetch tmpfs must be mounted uid=1000`.

### Deployment

The merged tracked source was reconciled into `/opt/videofetch` — all 405
tracked files hash-matched merged main afterwards, with `node/` and
`node_modules/` untouched — and the unit was installed atomically to
`/etc/systemd/system/videofetch-worker.service`, hash-matching the merged blob
(`35d99f03…`). `systemd-analyze verify` passed over the complete seven-unit set,
followed by `daemon-reload`.

**Only the Worker was restarted.** The other six services were not touched: all
kept `NRestarts=0` and their original start timestamps, the namespace holder
container kept the same id `d7aec670…`, and `vf-cloudflared` kept PID 703 and an
unchanged config hash. Both fail-closed `ExecStartPre` gates passed on the new
start — the broker GID verifier and the safe-egress policy verifier — and the
policy and route fingerprints were byte-identical before and after:

```
policy: 7cb95aaee72c91c27a16293c014edfbd7f5b843f21384982714eb33c2a26b21e
routes: 97960e25cd6925e2d00cdf2e65012e233398ab9a60257f34ea45a35789aa27b2
```

No safe-egress reacceptance was required or performed: the network topology and
policy did not change. **Phase 9 was neither rerun nor reopened.**

### The live mount, after the fix

**Lima runtime measurement**, inside the new production Worker container:

```
runtime uid/gid : 1000 / 1000
/tmp/videofetch : owner=1000:1000 mode=755 (tmpfs)
mount           : rw,nosuid,nodev,noexec,relatime,size=2097152k,mode=755,uid=1000,gid=1000,inode64
size            : 524288 x 4096 = 2 GiB exactly
```

`nodev` and `inode64` are added by the container runtime and are recorded here
as **measured**, not claimed from the unit — the unit specifies neither. A
minimal acceptance-only write as uid 1000 (create, write, read back, delete)
succeeded and left the filesystem empty. `jobs/` was deliberately **not**
created by hand; the real job was left to prove it.

### The end-to-end run

Executed against Vercel Production **without redeploying it**. PR #29 changed
only a Lima systemd artefact and a test file — zero files under any Vercel
runtime path — so deployment `dpl_3C5V47oLmBSGsDdUxxUqEF8G5pbc`
(`https://videofetcher.vercel.app`) remained authoritative and application-
equivalent. The Worker's deployment source advanced; Vercel's did not need to.

**The fixture.** A 3-second H.264 + AAC MP4, 83089 bytes, SHA-256
`c6f57ea73acfe17b7bd3759334ba2c180a0ddeefe47b80a4c1e47994d42c7f1c`, generated in
a disposable container and served by a temporary local server exposed through a
**separate temporary Cloudflare Quick Tunnel**. The named production Tunnel,
`/etc/cloudflared/config.yml`, Cloudflare Access and DNS were **not** touched.
Verified externally before use: `HEAD` 200, `GET` 200, `video/mp4`,
`Content-Length: 83089`, hash exact.

**The chain** (Vercel measurement unless noted):

| Step | Result |
| :--- | :--- |
| Private-access login on the production alias | authenticated |
| `/api/sites` → Worker diagnostics over Access + Tunnel + HMAC | `ffmpeg: true`, **`ytdlp: false`** |
| `POST /api/analyze` | `extractor: "direct"`, `fileSize: 83089` — exactly the fixture — and a `direct-original` format |
| `POST /api/download` (`formatId: direct-original`) | job `fb63f3170c2342717c7dd8af11d09418`, `queued` |
| Status polling | reached **`ready`** in ~1.2 s (`started` → `finished` = 1170 ms), so the transient states were legitimately missed by polling rather than skipped |
| Final job document | `status: ready`, `extractor: direct`, `fileSize: 83089`, `container: mp4`, `quality: original` |

**The defect is closed by the job itself** (Lima runtime measurement). After the
run, `/tmp/videofetch/jobs` **existed**, owned `1000:1000` — created by the
runtime through the exact code path that previously returned `EACCES` — and
contained **zero** job directories, the per-job working directory having been
removed by normal cleanup.

### Real application `PutObject` + `HeadObject`

The merged upload lifecycle is strictly ordered: `writer.put(...)` →
`writer.head(objectKey)` → reject if `null` → schema-validate the head →
compare `objectKey`, `contentLength`, `contentType` and `contentDisposition` →
**only then** `commitReadyFromUploading`. A `ready` job is therefore itself
application-level proof that both operations succeeded and that the stored
metadata matched.

Durable Worker state for the job (Lima runtime measurement, read from a copy of
the SQLite state):

```
status      ready
object_key  videofetch/jobs/fb63f3170c2342717c7dd8af11d09418/50c0808b4c18d763e758a046c598a9b2
file_size   83089
mime        video/mp4
filename    videofetch-e2e-fixture-original.mp4
extractor   direct
```

The key matches the required `videofetch/jobs/<32hex>/<32hex>` shape exactly.

The broker does **not** log per-mint action/key metadata to journald, so no
corroborating broker record exists. Broker logging was deliberately **not**
changed for acceptance, and no synthetic broker `Head` was performed and passed
off as application evidence: the `ready` transition already requires the
application's own `Head`.

### The separate Vercel signed GET

`GET /api/download/<jobId>/file` returned **303** with `Cache-Control: no-store`
to a presigned R2 URL — `AWS4-HMAC-SHA256`, `X-Amz-Expires=300` — whose path is
the exact object key above. Following it (provider evidence):

```
HTTP 200
Content-Type        : video/mp4
Content-Length      : 83089
Content-Disposition : attachment; filename="videofetch-e2e-fixture-original.mp4"
x-amz-expiration    : expiry-date="Sun, 30 Aug 2026 21:59:18 GMT",
                      rule-id="videofetch-expired-job-backstop"
```

**SHA-256 of the downloaded object equals the source fixture byte for byte**,
which `direct-original` makes meaningful: no FFmpeg transformation was involved,
so byte identity is the correct assertion. `ffprobe` on the downloaded artefact
confirms H.264 320x240 plus AAC mono, duration 3.000000 s, and a full decode
pass reports no errors.

The `x-amz-expiration` header is independent confirmation that
`R2-PROVIDER-LIFECYCLE-BACKSTOP-001` is live and applies to this object, with an
expiry exactly 3600 s after write. The lifecycle rule was not modified.

### Credential separation, re-proven

Names only; no value was printed, pulled or compared.

- **Worker** carries `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_JURISDICTION`,
  `R2_BROKER_SOCKET_PATH` and the `WORKER_CONTROL_*` HMAC pair. It has **no**
  `R2_SIGNER_*`, **no** `R2_WRITER_*` and **no** `R2_BROKER_PARENT_*`.
- **Vercel Production** holds `R2_SIGNER_ACCESS_KEY_ID` and
  `R2_SIGNER_SECRET_ACCESS_KEY` — the sole persistent GET signer — and **no**
  `R2_WRITER_*` or `R2_BROKER_PARENT_*`.
- **The broker** remains the sole holder of
  `R2_BROKER_PARENT_ACCESS_KEY_ID` / `R2_BROKER_PARENT_SECRET_ACCESS_KEY`.

So the write path and the read path used genuinely different identities: the
Worker never held a signer key, and Vercel never held a writer or parent key.

### yt-dlp remains disabled

`YTDLP_NETWORK_ISOLATED=false` in the live container, no `yt-dlp`, `youtube-dl`
or `python3` binary present in the image, Worker diagnostics reporting
`ytdlp: false` through the real Vercel path, and the successful job using
`extractor: direct`. **Phase 10 is NOT BEGUN.**

### Cleanup and residual state

The fixture server and the temporary Quick Tunnel were terminated — the Quick
Tunnel hostname now returns `530` — and the fixture, cookie jar and scratch
artefacts were deleted. The named Tunnel kept running throughout (PID 703,
unchanged config hash).

Two jobs remain in durable Worker state, both left to the application's normal
expiry model rather than deleted by hand:

- `ab7ee139…` — the original **failed** attempt, `object_key = null`, no object;
- `fb63f317…` — this **successful** job, whose object is covered both by the
  45-minute application retention and by the 3600-second provider backstop.

No object was manually deleted, so no durable `ready` row points at a missing
object.

### Operator-attested

The private-access secret used to authenticate the session is held in the
operator's local environment file. Its custody, and the fact that it was neither
rotated nor re-staged for this run, rest on operator attestation; this record
contains no secret value.
