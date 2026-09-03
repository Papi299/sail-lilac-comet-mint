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
- **Phase 10 has progressed in the repository only, and is NOT DEPLOYED.**
  `PHASE-10C1-YTDLP-RUNTIME-FOUNDATION-001` added a pinned yt-dlp runtime to the
  Worker **image definition** and retired the `YTDLP_NETWORK_ISOLATED` contract.
  `PHASE-10C2-YTDLP-GENERIC-ANALYSIS-FOUNDATION-001` added a bounded generic
  analyzer, unconnected. `PHASE-10C3-YTDLP-GENERIC-EXECUTION-INTEGRATION-001`
  **connected it**: a user-supplied URL can now reach yt-dlp in the source, via
  the direct-first router and durable generic acquisition.

  Nothing was deployed. The live Worker still runs the previously built image,
  and Production `YTDLP_ENABLED` remains **unset**, so generic extraction is not
  reachable in Production. See §4 and §4h.

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
implemented in the source as of Phase 10C3, and is NOT ENABLED in Production.**

Those statements are independent, and the whole design of this section is to
keep them independent:

```
yt-dlp runtime installed
    !=  generic execution implemented
    !=  generic execution enabled
```

*Since `PHASE-10C3-YTDLP-GENERIC-EXECUTION-INTEGRATION-001` a user-supplied URL
CAN reach yt-dlp in the source, through the direct-first router. It cannot in
Production, because `YTDLP_ENABLED` is unset there and the fail-closed default
is disabled. §4h records the connected contract in full; §4a–§4f below describe
the runtime, argument and environment policy, which Phase 10C3 did not change.*

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
| Selection | `--no-playlist`, and `--yes-playlist` is never passed. Playlist behaviour is not configurable and not reachable from request data. **Single media item only** — see §4d |
| Downloader | `--downloader=native`, a fixed application-owned value. No caller or user may choose a downloader, and `--downloader-args`, `--exec` and postprocessor commands are never passed. No third-party downloader (`curl`, `wget`, `aria2c`, `httpie`, `axel`) is installed or configurable. **FFmpeg *is* installed** — it is VideoFetch's own processing tool — and yt-dlp recognises `ffmpeg` as a downloader name, so "no external downloader is installed" would be false. See §4c |

### 4c. What `--downloader=native` does and does not guarantee

`--downloader native` parses to `{default: "native"}` and is applied to every
protocol. Measured against the pinned release's own `_get_suitable_downloader`:

| Protocol | Live | Resolves to |
| :--- | :--- | :--- |
| `https` (progressive) | no | `HttpFD` |
| `m3u8_native` | no | `HlsFD` |
| `http_dash_segments` | yes | `DashSegmentsFD` |
| `m3u8` / `m3u8_native` | **yes** | **`FFmpegFD`** |
| `rtmp_ffmpeg` | — | **`FFmpegFD`** |

**It guarantees** that no third-party downloader is ever invoked
(`get_external_downloader()` is not even reached for the value `native`), that
non-live HLS uses the native `HlsFD`, that live DASH segments stay native, and
that the `to_stdout` FFmpeg-merge branch is skipped.

**It does not guarantee that yt-dlp never invokes FFmpeg.** In this release the
live-HLS test runs *before* the downloader preference is consulted, and
`rtmp_ffmpeg` maps straight to `FFmpegFD`. Any claim that "no external
downloader is configured, therefore FFmpeg cannot run during acquisition" is
false.

This matters because of an accepted Worker invariant:

```
downloading  = network acquisition
processing   = local FFmpeg/remux/transcode/extraction
```

An acquisition that internally shells out to FFmpeg performs local media work
while the durable job still says `downloading`.

**Recorded integration gate.** Phase 10C1 has no user-URL execution path, so
nothing is enforced yet. When generic integration is built, it must reject —
or separately design for — every mode in
`YTDLP_FFMPEG_ACQUISITION_MODES` (`src/worker/runtime/ytdlp-runtime.server.ts`):

- live HLS (`m3u8` / `m3u8_native` with `is_live`);
- `rtmp_ffmpeg`;
- section downloads (`--download-sections`);
- stdout output with a merge-requiring format selection;
- multi-protocol format selections that resolve wholly to `FFmpegFD`.

Protocol selection is deliberately **not** implemented in this phase.

### 4d. Single-item contract

**Phase-10 generic v1 is single media item only.**

```
one submitted generic URL  ->  at most one accepted media item
```

Playlists, channels, feeds and other multi-entry extraction are separate future
product features. They must never arrive implicitly through a yt-dlp default.

`--no-playlist` is in the closed base policy and `--yes-playlist` is never
passed, so playlist behaviour is neither operator-configurable nor reachable
from request data.

**What that control actually does, precisely.** In the pinned release,
`InfoExtractor._yes_playlist(playlist_id, video_id, ...)` opens with:

```python
if not playlist_id or not video_id:
    return not video_id
```

so when a URL carries **both** a playlist id and a video id, `--no-playlist`
makes yt-dlp take just the video. When the URL is playlist-only, that early
return fires and the option is never consulted — and extractors that build a
`playlist_result` directly (channels, feeds, listings) do not call
`_yes_playlist` at all.

**Therefore `--no-playlist` is defence in depth against video-vs-playlist
ambiguity. It is not proof that a playlist or multi-video result cannot be
returned.** Any claim that the flag alone prevents playlist extraction is
false.

**Recorded integration gate.** Phase 10C1 has no generic analysis, so no result
inspection is implemented here. The later generic-analysis layer must
explicitly reject, unless a separate product phase authorizes them:

- playlist URLs;
- channel / feed / listing URLs returning playlist-like data;
- multi-video extractor results;
- any other result that expands one submitted URL into multiple independent
  media entries.

### 4e. Configuration contract

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

### 4f. What Phase 10C1 did NOT authorize *(historical — superseded by §4h)*

> **This subsection describes the state as of Phase 10C1 and is retained as
> history. Its central claim — that no user-URL execution path exists — stopped
> being true in Phase 10C3. See §4h for the current contract.** What remains
> true and current is the last paragraph: `YTDLP_ENABLED` is still absent from
> the image and from the committed systemd unit, and Production is still not
> enabled.

**No user-URL execution path exists.** `WorkerService.analyze()` still resolves
only to the direct-media analyzer, `JobExecutor` still has no generic branch,
and the only yt-dlp subprocess operation in any Production Worker code is a
non-network version probe.

Setting `YTDLP_ENABLED=true` in Phase 10C1 changes **reported configuration
state only** — `features.ytdlpEnabled` in Worker diagnostics and the
informational `ytdlpEnabled` field on `/api/sites`. It does not enable generic
extraction, and it must not make `/api/sites.ytdlp` true: that field additionally
requires a generic execution path to exist in the build, which it does not.

Generic analysis, generic download, format planning and the live acceptance
matrix that must precede enabling any of it are later, separately authorized
phases. **Phase 10C1 has not been deployed**, and `YTDLP_ENABLED` is deliberately
absent from the image and from the committed systemd unit.

---

### 4g. Phase 10C2 — the generic analysis foundation *(historical — connected in §4h)*

> **This subsection describes the state as of Phase 10C2 and is retained as
> history. Its central claim — that the analyzer is unreachable — stopped being
> true in Phase 10C3, which connected it deliberately. So did its statement that
> no upstream `format_id` is parsed at all. See §4h for both corrected
> statements.** The analyzer's own bounds, gates and argument policy, described
> below, are unchanged and remain authoritative.

*This subsection records what `PHASE-10C2-YTDLP-GENERIC-ANALYSIS-FOUNDATION-001`
added, which was **code only**.*

A Worker-owned generic yt-dlp **analyzer** and a direct-first **strategy
router** now exist:

```
src/worker/analysis/ytdlp-analysis.server.ts   generic metadata analyzer
src/worker/analysis/media-analyzer.server.ts   direct-first strategy router
```

**Neither is reachable.** All of the following remain exactly as they were:

| Property | State after Phase 10C2 |
| :--- | :--- |
| `WorkerService.analyze()` | direct-media analyzer only |
| `JobExecutor` | direct-media only, no generic branch |
| Worker runtime composition | injects no generic analyzer |
| Vercel `/api/analyze` | unchanged |
| `/api/sites.ytdlp` | **false** |
| `GENERIC_YTDLP_EXECUTION_IMPLEMENTED` | **false** |
| `YTDLP_ENABLED` in Production | unset (absent means disabled) |
| Deployment | **none — Phase 10C2 has not been deployed** |

The operative distinction from §4 now has a third term:

```
runtime installed  !=  analyzer implemented  !=  generic execution enabled
```

A tested-but-unconnected analyzer is not a capability. `/api/sites` therefore
still reports `ytdlp: false`, and that remains the truthful answer.

`control-plane-boundary.test.ts` asserts the disconnection structurally, by
walking the real module graphs from `WorkerService`, the runtime composition
root, the `JobExecutor` and every Vercel API route.

#### Strategy rule

```
1. try direct
2. direct succeeds                       -> return direct metadata, unmodified
3. direct fails EXTRACTOR_UNAVAILABLE
     + ytdlpEnabled = false              -> EXTRACTOR_UNAVAILABLE (fail closed)
     + ytdlpEnabled = true               -> generic analyzer
4. any other direct failure              -> propagate unchanged, NO fallback
```

`EXTRACTOR_UNAVAILABLE` is the **only** code that permits the generic path. It
is the only outcome meaning "this is not a direct media file, so another
strategy might apply". Every other failure is terminal, and one case is a
security property rather than a preference: an `INVALID_URL` from the Worker's
own SSRF/URL boundary must never be retried through yt-dlp, because that would
take a URL the security boundary just rejected and hand it to a second, far
more capable network client. An unexpected non-`AppError` exception and a
caller cancellation are likewise never fallback triggers.

Direct metadata is returned **byte-for-byte unmodified** when direct succeeds;
its formats, presets and `extractor: "direct"` contract are untouched.

#### Analysis command

The base policy from §4c, plus:

```
--dump-single-json --skip-download --no-progress --no-warnings --no-cache-dir
--socket-timeout=10 --retries=2 --extractor-retries=1
--ffmpeg-location=/nonexistent/videofetch-yt-dlp-analysis-no-ffmpeg
--
<validated-url>
```

run under an analysis-specific environment whose `PATH` is
`/nonexistent/videofetch-yt-dlp-analysis-no-path`.

Every option is verified against yt-dlp 2026.08.19's own `options.py`. The
bounded retry/timeout values replace upstream defaults (`--retries 10`,
`--extractor-retries 3`, no socket timeout) that could consume the whole
analysis budget on one unresponsive host.

The URL is always the **final positional argument after a bare `--`**. Both
`optparse` and yt-dlp's own `parse_known_args` override handle `--` explicitly
and stop option processing there, so no user-supplied string can become an
option, an alias, or an option's value. Verified on the pinned runtime in a
`--network none --read-only --cap-drop=ALL` container: the identical token
`--skip-download` is consumed as an *option* without the barrier ("You must
provide at least one URL") and treated as a *positional URL* with it
("'--skip-download' is not a valid URL").

`--skip-download` is passed even though `-J` already implies simulation
(`dump_single_json` is in `any_getting`, so `simulate` resolves true), so that a
change to either mechanism cannot quietly turn analysis into acquisition. No
`-o`, `-P`, `-f`, `--merge-output-format`, `--remux-video`, `-x`,
`--audio-format`, `--download-sections`, `--wait-for-video`, `--write-*`,
`--download-archive`, credential, header or proxy option appears anywhere on
this path.

#### Analysis descendants cannot reach Worker FFmpeg/ffprobe

The generic analysis child **cannot discover Worker FFmpeg/ffprobe**: its closed
`PATH` excludes their location and yt-dlp is explicitly pointed at a fixed
nonexistent ffmpeg location. Node remains available only through its approved
absolute path.

Two independent mechanisms, so the invariant does not rest on either alone.

**1. A PATH that resolves nothing.** The image intentionally ships
`/usr/bin/ffmpeg` and `/usr/bin/ffprobe`, and the Phase-10C1 base environment
sets `PATH=/usr/bin:/bin`. That base environment is unchanged for its existing
callers (notably the non-network diagnostics probe); analysis alone runs with
`PATH=/nonexistent/videofetch-yt-dlp-analysis-no-path`, a directory that does
not exist. It is deliberately a nonexistent absolute path rather than an empty
string, because an empty `PATH` is read by some resolvers as "use the system
default" (`confstr(_CS_PATH)` → `/bin:/usr/bin`), which would silently restore
exactly what this removes.

**2. An explicit ffmpeg-location denial.** Leaving `--ffmpeg-location` unset is
not neutral. Per `FFmpegPostProcessor._determine_executables` in the pinned
release:

```python
location = self.get_param('ffmpeg_location', ...)
if location is None:
    return {p: p for p in programs}   # bare 'ffmpeg'/'ffprobe' -> PATH lookup
if not os.path.exists(location):
    self.report_warning('... does not exist! Continuing without ffmpeg')
    return {}                          # nothing resolvable at all
```

So unset is an *active grant* of PATH discovery, while a nonexistent location
yields an empty executable map. An empty `_paths` makes `_get_ffmpeg_version`
return `(None, {})` through its `{None: None}` cache seed — without attempting a
subprocess — so `basename` is `None`, `available` and `probe_available` are
false, and `FFmpegFD.available()` (which delegates straight to
`FFmpegPostProcessor().available`) is false too. The location is a compile-time
constant: it is never read from the request, the environment, or configuration.

**Node is unaffected.** `_determine_runtime_path` calls `_find_exe` (PATH
discovery) *only* when no path was supplied, and returns an absolute path
verbatim otherwise, so `--js-runtimes=node:<absolute path>` keeps working with a
dead PATH. Deno, Bun and QuickJS stay disabled by `--no-js-runtimes` and would
additionally be undiscoverable.

*Scope: these are subprocess-boundary guarantees. They deny FFmpeg/ffprobe
discovery; they are not a claim about every future upstream extractor
behaviour. Live acceptance must still inspect real descendants under generic
extraction.*

#### Single-item enforcement

`-J` does **not** enforce the single-item contract: its own help text states
that a playlist URL dumps the whole playlist as one object. The parser enforces
it instead.

The gate is `_type === "video"` **exactly**. This is reliable because
`YoutubeDL.sanitize_info` — the function producing every `-J` document — calls
`info_dict.setdefault('_type', 'video')`, so the key is always present and
explicit. `playlist`, `multi_video`, `url`, `url_transparent` and any
unrecognized value are all refused: an unknown shape is rejected, never guessed
at. A second independent gate rejects any document carrying `entries`.

#### Live sources

Rejected: `is_live: true`, and `live_status` of `is_live`, `is_upcoming` or
`post_live`. `post_live` ("was live, VOD not yet processed") is a wait-for-media
state and is refused with the other two. `was_live`, `not_live` and an unknown
status describe finished, fixed-length media and are accepted. Live sources
surface as `VIDEO_UNAVAILABLE`. `--wait-for-video` is never passed and no live
polling exists.

#### No split-stream video

Video presets are built **only** from source formats that already contain video
*and* audio in one format. A video-only rendition would need yt-dlp to merge it
with a separate audio stream, which Phase-10B rules out of generic v1, so
split-stream renditions produce **no video preset at all** — even when they are
the only high-quality options a site offers. `capabilities.merge` is always
`false`. This is an accepted, recorded reduction in capability, not a defect.

#### Acquisition eligibility: progressive HTTP(S) only

A candidate must carry an explicit `protocol` of `http` or `https`. A format
with **no** protocol field is not eligible either — yt-dlp derives a missing
protocol from the media URL at download time, which analysis cannot do without
trusting an upstream URL.

**Native HLS is excluded**, despite `m3u8_native` selecting `HlsFD` under
`--downloader=native`. `HlsFD.real_download` inspects the media playlist at
*download* time and, when `can_download()` rejects it (DRM markers, AES-128 with
ffmpeg present, other unsupported tags), constructs an `FFmpegFD` and delegates
to it — `yt_dlp/downloader/hls.py`, the `if not can_download:` branch. That
decision depends on manifest bytes analysis never fetches, so HLS **cannot be
proven native at analysis time**, and advertising it would risk local FFmpeg
work running while a future durable job still reports `downloading`. This is the
fail-closed reading of the §4d acquisition boundary and can be widened later by
a phase that proves the manifest is native — with evidence.

#### Application-owned presets only, no raw format IDs

Generic metadata returns `formats: []`. All selectable options are presets whose
ids come from a closed vocabulary:

```
preset:best  preset:2160 … preset:144  preset:audio  preset:mp3
```

Every generic preset satisfies `id === formatId` and must match the
application-owned pattern; the analyzer asserts this on its own output before
returning. This matters because the browser's advanced selector echoes
`formats[].id` back as `formatId` on job creation, which would otherwise turn an
upstream string into a browser-controlled selector expression.

> *Superseded in part by §4h.* Phase 10C2 additionally stated that **no upstream
> `format_id` is parsed at all**, the field being absent from the validation
> schema. That was true while no execution path existed to select a source with.
> Phase 10C3 parses it — into a PRIVATE execution-analysis structure only, under
> a strict ASCII grammar, never browser-facing and never durable. The current
> governing statement is in §4h.

Within one resolution bucket the ranking is container → video codec → audio
codec → larger known size → higher fps → upstream position: total, deterministic
and unit-tested. Resolution is never traded away for a nicer codec, because
ranking only ever runs *inside* a bucket.

Audio may additionally derive from a muxed source, because the Worker can
extract with its **own** FFmpeg after a future durable job enters `processing`.
yt-dlp is never asked to extract audio.

#### Bounds

| Bound | Value | Behaviour on breach |
| :--- | :--- | :--- |
| analysis stdout | 4 MiB (UTF-8 **bytes**) | process group terminated, nothing parsed |
| analysis stderr | 256 KiB (UTF-8 **bytes**) | process group terminated |
| raw formats | 512 | fail closed (never silently truncated) |
| emitted presets | 11 | structural assertion on own output |
| title | 1024 chars | truncated, control characters replaced |
| duration | `maxVideoDurationSeconds` | `TOO_LONG` before metadata is returned |
| known file size | `maxFileSizeBytes` | candidate not advertised |
| wall clock | `analysisTimeoutSeconds` | runner terminates the process group |

The stdout ceiling is the only bound that limits what reaches memory; the
format-count bound can only apply after `JSON.parse`. A truncated document is
**never** parsed — partial JSON must not be interpreted as extractor output.

The ceilings are an opt-in extension of the shared hardened process runner
(`maxStdoutBytes` / `maxStderrBytes`). Omitting them preserves the historical
lenient retain-a-tail behaviour exactly, so every pre-existing caller is
unaffected.

They count **UTF-8 bytes**, via `Buffer.byteLength`, not JavaScript UTF-16 code
units. `"€"` is one code unit but three bytes and `"😀"` is two code units but
four, so a `.length` comparison would under-count real output by up to 4x
against a limit that claims to bound memory. Counting decoded chunks is exact
across chunk boundaries: `setEncoding("utf8")` puts a `StringDecoder` in front
of the stream, which buffers an incomplete multibyte sequence and emits it only
once complete, so a sequence split across raw reads is counted once, in full.
The only divergence is malformed UTF-8, where the decoder's U+FFFD replacement
over-counts — a direction that still fails closed.

Analysis writes no persistent cache and no metadata side files.

#### Raw output is never retained

Raw stdout and stderr exist transiently in memory for classification only. They
are never logged, persisted, placed in durable state, returned in HTTP JSON,
surfaced to the browser, or attached to an exception that crosses a module
boundary. The legacy `stderr.slice(-800)` logging pattern is not reproduced, and
the submitted URL is never logged with its query string.

Error classification is a small Worker-owned function mapping a handful of
stable upstream phrases to canonical codes, collapsing anything unrecognized to
`EXTRACTION_FAILED`. The legacy `mapExtractorMessage()` is deliberately not
reused: it returns errors carrying text derived from its input. Tests inject a
`SUPER_SECRET_VALUE` sentinel into fake stdout and stderr and assert it never
appears in any thrown error, returned value, or console call.

#### Thumbnails

Generic metadata returns `thumbnail: null`. An extractor-supplied thumbnail URL
is a secondary network destination that would be handed straight to the browser,
and no repository mechanism validates or proxies such a URL today. The resulting
missing-thumbnail UX for generic sources is **intentional Phase-10 v1
behaviour**, to be revisited only by a deliberate thumbnail-security policy.

#### Metadata ownership

`extractor` is exactly `"yt-dlp"` — the application-owned execution-strategy
identity, never the upstream `extractor`/`extractor_key`, which is an arbitrary
source-controlled string. `webpageUrl` is the URL the **Worker** validated;
upstream `webpage_url` and `original_url` are not parsed at all, so neither can
override it. `source` is derived from the validated URL's hostname.

#### Ordering is a security property

```
1. validate request shape
2. Worker SSRF / URL validation
3. open ONE subprocess deadline for the whole phase
4. exact pinned-runtime probe   (capped by the smaller of its own
                                 maximum and the remaining budget)
5. only now: a network-capable subprocess, with the REMAINING budget
```

Steps 1–2 complete **before any process is spawned, the version probe
included**, so an unsafe or malformed URL causes zero yt-dlp processes and zero
Node/EJS descendants. Step 4 exists because a user URL must never be executed by
an unverified runtime: a missing, mismatched, malformed or unrunnable yt-dlp
fails closed as `EXTRACTOR_UNAVAILABLE` rather than falling back to whatever is
on disk.

**One budget, not two.** `analysisTimeoutSeconds` is the budget for analyzing a
URL, not a per-subprocess allowance. The probe and the network run share a
single deadline: the probe is capped at `min(YTDLP_PROBE_TIMEOUT_MS, remaining)`
and the network run receives only what is left. If the probe exhausts the
budget, **the network-capable subprocess is never started** and the call fails
`TIMEOUT`. Giving the network run a fresh full budget after the probe had
already spent part of one would let the pair consume up to twice what the
configuration permits.

**Cancellation is real, not advisory.** An already-aborted caller starts nothing
at all — not even the probe. The caller's `AbortSignal` is passed into the probe
as well as the analysis run, so a cancellation mid-probe terminates the probe's
own process group through the hardened runner. A cancelled probe **re-throws**
rather than reporting `available: false`: collapsing it into "unavailable" would
surface a cancellation downstream as `EXTRACTOR_UNAVAILABLE`, sending an
operator to look for a runtime-installation problem that does not exist. The
probe's no-argument form is unchanged, so Phase-10C1 diagnostics behave exactly
as before.

Initial URL validation is **defence in depth and not a claim about yt-dlp's own
networking**. Once running, yt-dlp issues its own secondary requests, follows
its own redirects, and fetches manifests, fragments, extractor APIs and
EJS-related resources that this validation never sees. Those are constrained in
Production by the external media network namespace, its nftables policy and the
watchdog (§3) — an architecture this code deliberately does not restate as an
application boolean.

#### Future integration boundary

*Closed by `PHASE-10C3-YTDLP-GENERIC-EXECUTION-INTEGRATION-001`. See §4h.*

---

### 4h. Phase 10C3 — generic execution, CONNECTED but NOT DEPLOYED

*The §4a–§4f runtime, argument and environment contracts are unchanged and
remain authoritative. This subsection records what
`PHASE-10C3-YTDLP-GENERIC-EXECUTION-INTEGRATION-001` changed, which is **code
only**.*

| Property | State after Phase 10C3 |
| :--- | :--- |
| Generic execution code | **implemented** |
| `WorkerService.analyze()` | the direct-first strategy router |
| `JobExecutor` | re-analyzes each job and branches to generic acquisition |
| Generic HTTP path | gated by `YTDLP_ENABLED` |
| Generic durable jobs | implemented |
| `GENERIC_YTDLP_EXECUTION_IMPLEMENTED` | **true** |
| `/api/sites.ytdlp` | `implemented && runtime installed && YTDLP_ENABLED` |
| `YTDLP_ENABLED` in Production | **unset — unchanged by this phase** |
| Production deployment | **NOT performed** |
| Production enablement | **NOT performed** |

The operative distinction from §4g keeps all three terms, and the third has
simply become true in the source:

```
runtime installed  !=  execution implemented  !=  generic execution enabled
```

Production still runs the previously built image, with `YTDLP_ENABLED` absent.
Generic extraction is therefore **not reachable in Production**, and
`/api/sites` continues to report `ytdlp: false` there. That is the truthful
answer, and it is produced by conjunction rather than by the constant being
pinned false.

#### The browser trust boundary

A download request is still exactly `{ url, formatId, principalId }`. The
browser cannot name a strategy, an extractor, a raw yt-dlp format id, a yt-dlp
argument, a downloader, an output template, a processing operation, or a source
media URL.

`formatId` is now a **closed vocabulary** (`WorkerRequestedFormatIdSchema`):
`direct-original` plus the eleven `preset:*` rungs. It was previously any
non-empty string. Both the control plane and the Worker validate it
independently; anything outside the vocabulary is `FORMAT_UNAVAILABLE`.

The Worker decides the strategy itself, during durable execution, by
re-analyzing the job's own stored URL. The durable `extractor` column is
**evidence of what an execution selected**, never an input: it is a closed
`direct | yt-dlp` union, and a stale value from a previous attempt has no
authority over the next one.

#### Raw upstream format ids — the corrected statement

Phase 10C2 could truthfully say *"`format_id` is not parsed at all"*, because no
execution path existed to select a source with. **That statement is no longer
true and has been removed from the current-state documentation.** The Phase-10C2
text above is retained only as history.

The governing statement is now:

> A raw yt-dlp `format_id` may exist only inside a private Worker
> execution-analysis structure. It is never browser-facing, never durable, never
> request-controlled, never logged, and never passed to yt-dlp without strict
> validation and application-owned selector construction.

Concretely: `analyzeGenericMediaInternal` returns `{ video, selections }`, and
only `selections` carries upstream ids. `analyzeGenericMedia` — the HTTP path —
returns `video` alone, so the private half is unreachable from the authenticated
surface. `WorkerVideoMetadata` still exposes `formats: []` for generic sources.
The selection is not persisted: a restart re-derives it, which is why
interrupted generic work is failed deterministically rather than resumed.

To become executable at all, an upstream id must match a strict ASCII grammar:

```
^[A-Za-z0-9._-]{1,128}$
```

No `/`, `+`, `,`, `[`, `]`, `(`, `)`, `'`, `"`, `:`, backslash, whitespace or
control character — every character that carries meaning inside yt-dlp's own
selector grammar. An id that fails this produces **no advertised preset**.
Reduced site coverage is the accepted outcome; a selector-injection surface is
not.

#### Why the selector is `b*[format_id="..."]` and not `-f <id>`

Two properties of the pinned 2026.08.19 release drive the exact spelling. Both
were verified by reading the source AND behaviourally, against the pinned
artifact, with synthetic format dictionaries and no network
(`deploy/acceptance/ytdlp-generic/verify-selector.py`).

**1. The value must be QUOTED.** `YoutubeDL._build_format_filter` tries a
NUMERIC regex first:

```
(?P<key>[\w.-]+)\s*(?P<op>=|!=|<|<=|>|>=)(...)?\s*
(?P<value>[0-9.]+(?:[kKmMgGtTpPeEzZyY]i?[Bb]?)?)\s*
```

An unquoted numeric id — `[format_id=22]`, and numeric ids are extremely common
— fullmatches that branch, so yt-dlp computes `float("22") -> 22.0` and compares
`operator.eq("22", 22.0)`, which is False in Python. **The filter silently
matches nothing.** Quoting defeats the numeric branch (its value group admits no
quote character), so parsing falls through to `STR_OPERATORS`, where `=` is
`operator.eq` on the strings. The safe-id grammar already excludes `"`, `'` and
`\`, so the quoting cannot be escaped out of.

**2. The atom must be stated as `b*`.** An OMITTED atom is not neutral:
`_parse_format_selection` does
`if not current_selector: current_selector = FormatSelector(SINGLE, 'best', [])`.
Bare `best` requires a muxed format — so an audio-only source selects **nothing**
— and it sets `format_fallback`, whose behaviour depends on the
extractor-controlled `incomplete_formats` flag. `b*` sets `format_modified`, so
`_filter_f` is `lambda f: True` (no shape restriction of its own, leaving every
shape decision to the explicit filters) and `format_fallback` is False (it can
never substitute a different format).

A bare RAW-ID atom (`-f 22`) is forbidden outright: a bare atom is special-cased
for `best`, `worst`, `all`, `mergeall`, extension names and the `/`, `+` and
grouping operators, any of which an upstream id could collide with.

Filters are applied to `ctx['formats']` BEFORE the atom runs, so an exact
`format_id` equality filter leaves at most one candidate and the atom can only
pick that one or nothing.

The complete emitted selector binds every property the source was approved on,
because acquisition re-runs extraction and the site may have changed in between:

```
b*[format_id="<safe-id>"][protocol="https"][ext="mp4"][vcodec!="none"][acodec!="none"]
```

When analysis established video from the normalized source shape rather than
from a reported codec (`videoConstraint: "video-ext"` — the Generic HTML5 case,
where the pinned extractor reports `vcodec: null`), the video half instead reads:

```
[vcodec!=?"none"][video_ext="mp4"]
```

which accepts an unknown or later-known codec, rejects an explicit `"none"`, and
keeps the shape evidence the approval rested on bound. `audio_ext` is never
constrained. See the Phase-10D fixture notes below for why.

If the same id then resolves to a different protocol, container or stream shape,
the selector matches nothing and the job fails `FORMAT_UNAVAILABLE` — never a
silent substitution. There is no `/` fallback and no `+` merge.

#### Generic v1 acquisition scope

Unchanged from §4d/§4e, and now enforced rather than merely recorded:

```
public sources only          progressive HTTP/HTTPS source formats only
single item only             native yt-dlp downloader only
no playlist/channel/feed     no yt-dlp FFmpeg
no live                      no yt-dlp postprocessing
no HLS                       application-owned presets only
no DASH/fragments            no split video+audio merge
```

Source containers are a closed allowlist: **mp4/webm** for video, and
mp4/webm/m4a/mp3/ogg/opus/aac/flac/wav for audio-only. An unknown or absent
upstream extension is a **rejection**, never a silent default to mp4 — for
execution that value becomes a real file suffix, a MIME decision and an
`[ext=...]` constraint at once.

#### The acquisition command

```
/usr/bin/python3 /usr/local/lib/videofetch/yt-dlp
  <Phase-10C1 closed base policy>
  --no-cache-dir --quiet --no-progress --no-warnings
  --socket-timeout=10 --retries=2 --fragment-retries=1 --extractor-retries=1
  --ffmpeg-location=/nonexistent/videofetch-yt-dlp-no-ffmpeg
  --fixup=never
  --max-filesize=<configured maximum bytes>
  --concurrent-fragments=1 --no-keep-fragments
  --no-mtime --no-overwrites
  --format=<application-built exact filter selector>
  --output=<server-owned-workdir>/source.%(ext)s
  -- <validated-url>
```

`PATH` is `/nonexistent/videofetch-yt-dlp-no-path`. `--no-part` is deliberately
NOT passed: keeping yt-dlp's default `.part` behaviour gives the byte guard a
predictable path to watch.

The only interpolation in the output template is `%(ext)s`, and the acquired
extension must then equal the approved container. No title, id, format id or
uploader can influence the path.

#### No FFmpeg during `downloading`

Five independent mechanisms, none trusted alone:

1. `--downloader=native` (inherited from the base policy) → `HttpFD`;
2. a single progressive http/https source, so no fragment or manifest
   downloader is reachable and no merge is possible;
3. a PATH that resolves nothing, so `ffmpeg`/`ffprobe` cannot be found by bare
   name;
4. `--ffmpeg-location` at a fixed nonexistent path, which makes the pinned
   release report FFmpeg and ffprobe as unavailable and `FFmpegFD.available()`
   as False;
5. `--fixup=never`, removing the fixup behaviour rather than relying on its tool
   being absent.

Mechanisms 3, 4 and 5 are verified inside the hardened container by
`deploy/acceptance/ytdlp-generic/verify-download-policy.py`.

#### Size enforcement — three gates

`--max-filesize` is **defence in depth, not sufficient**. The pinned
`HttpFD.real_download` checks it only inside `if data_len is not None`, so an
unknown or decompressed Content-Length streams past it unchecked. The three
gates are:

| Gate | What it catches |
| :--- | :--- |
| Metadata bound at analysis | a KNOWN upstream size already over the limit — the preset is never advertised |
| `--max-filesize` | a server-declared Content-Length over the limit |
| **Application byte watcher** | actual bytes on disk, regardless of what any header claimed |

The watcher polls the known `.part`/final paths every 150 ms, and on overflow
aborts the owned process group and classifies the result as `TOO_LARGE` — not as
a user cancellation. A final `stat` after a clean exit catches a file that grew
between the last poll and process exit.

#### Durable lifecycle

```
analyzing  -> Worker re-analyzes its own stored URL, derives the strategy,
              pins the single source, then completeAnalysis(extractor=strategy)
downloading-> yt-dlp progressive HTTP(S) acquisition ONLY. Zero Worker FFmpeg.
processing -> Worker FFmpeg ONLY if the plan requires it
uploading  -> R2
ready
```

Generic video keeps one muxed source verbatim, so it invokes **zero** FFmpeg
calls. `preset:audio` from an audio-only source is likewise kept. `preset:audio`
from a muxed source, and `preset:mp3` from any source, are Worker-side FFmpeg
operations performed strictly after `beginProcessing()` commits. `-x`,
`--extract-audio` and `--audio-format` appear nowhere on this path.

#### CORRECTION-01 — review findings closed

Three integration defects were identified in review of the Phase-10C3 draft and
corrected on the same branch. They are recorded here rather than folded silently
into the description above, because each one falsified a claim the phase makes.

**1. Generic-only capability probing was not lazy.** The canonical analysis
policy awaited the Worker FFmpeg availability probe while building its options
object — before the router ran — so on a `YTDLP_ENABLED=true` deployment every
request paid for a subprocess probe that only the generic branch reads, and
"direct first" was untrue in the composition root. FFmpeg availability is now a
resolver (`getFfmpegAvailable`) invoked from exactly one place: inside the
already-authorized generic fallback branch, after direct has failed with
`EXTRACTOR_UNAVAILABLE` and after the operator's switch has been checked.

The routing decision was also de-duplicated in the process. `analyzeMedia` and
`analyzeForExecution` now share ONE `routeDirectFirst` implementation and differ
only in the generic continuation they supply.

**2. The byte monitor could act after acquisition settled.** `clearInterval`
does not stop a sample already suspended on a filesystem await. Such a sample
could resume after `beginProcessing()` had committed and emit `downloading`
progress, which the executor's progress reporter would see fail as a state
conflict — halting the reporter and aborting a job that had actually succeeded.
Every side effect is now gated on a liveness flag cleared synchronously by
`stopMonitor()`, which runs before any outcome is interpreted.

The abort cause is now a one-way latch rather than a mutable boolean. Previously
a later overflow sample could overwrite an earlier caller cancellation.
First writer wins: caller-then-overflow stays a cancellation, and
overflow-then-caller stays `TOO_LARGE`.

**3. The durable schemas still accepted arbitrary strings.** Phase 10C3
introduced the closed vocabularies but applied them only at the HTTP boundary,
so a SQLite row could still carry `extractor = "Youtube"` or
`formatId = "bestvideo+bestaudio"` and become trusted execution state.
`DurableWorkerJob.formatId`, `DurableWorkerJob.extractor` and
`CompleteAnalysisInput.extractor` now use the closed schemas.

No SQLite migration was needed or added: the columns remain `TEXT` and the
trusted read/write schemas enforce the vocabulary. A raw upstream source id
still has no column at all — it stays memory-only for one execution attempt.

An out-of-vocabulary durable value is now indistinguishable from row corruption,
and the store's pre-existing corruption policy applies unchanged: the row is
refused loudly and all-or-nothing rather than being written to or executed.

#### Deployment status

```
generic execution code:   implemented
generic HTTP path:        gated by YTDLP_ENABLED
generic durable jobs:     implemented
Production deployment:    NOT performed
Production enablement:    NOT performed
```

Enabling generic extraction in Production remains a later, separately authorized
task. It must include live public-site acceptance, a live safe-egress descendant
proof, and a live R2 generic-media proof — none of which this phase performed.
The site catalog stays conservative: `"limited"` entries were **not** upgraded,
because an existing execution path does not guarantee any given URL satisfies
the public-source, progressive-HTTP(S), muxed-single-stream, safe-format-id and
no-live policies.

### 4i. Phase 10C4 — Production acceptance harness, NOT EXECUTED

*`PHASE-10C4-YTDLP-PRODUCTION-ACCEPTANCE-HARNESS-001` added acceptance tooling
and reconciled stale deployment prose. It changed no Worker execution code, no
safe-egress policy and no functional systemd behaviour, and it touched nothing
in Production.*

```
harness exists:            YES
live generic acceptance:   NO
Production deployment:     NO
Production enablement:     NO
```

| Property | State after Phase 10C4 |
| :--- | :--- |
| Generic execution code | unchanged since §4h |
| `GENERIC_YTDLP_EXECUTION_IMPLEMENTED` | `true`, unchanged |
| `YTDLP_ENABLED` in Production | **unset — unchanged by this phase** |
| Production deployment | **NOT performed** |
| Production enablement | **NOT performed** |
| Live generic media request | **NONE** |
| Provider mutation (Cloudflare / R2 / Vercel) | **NONE** |
| Lima VM | **not started for this phase** |

#### Why the phase exists

Phase 10C3 connected generic execution in source. Enabling it in Production is a
different act, and the failure mode this phase exists to prevent is designing
the test inside Production — improvising `docker`, `systemctl` and `curl`
commands at the moment of enablement, then reporting whatever they happened to
show. That produces evidence nobody reviewed the shape of beforehand.

The ordering is therefore:

```
reviewed generic implementation  (10C3, merged)
        +
reviewed acceptance harness      (10C4, this phase)
        |
        v
staged live deployment           (10D, not yet authorized)
```

#### What was added

`deploy/acceptance/ytdlp-generic/` gains a live-acceptance layer beside the two
existing offline verifiers, which are retained unchanged:

| File | Kind |
| :--- | :--- |
| `verify-selector.py` | offline / static — **retained** |
| `verify-download-policy.py` | offline / static — **retained** |
| `README.md` | the Phase-10D specification |
| `acceptance.mjs` | the live orchestrator |
| `lib/{gate,verdict,stage-a,stage-b,process-tree,redact,evidence,observers}.mjs` | small single-purpose modules |
| `scripts/ytdlp-acceptance.test.mjs` | 84 tests, run by `npm test` |

The two kinds of evidence are kept explicitly separate. The offline verifiers
prove pinned-runtime **semantics** without a network; the orchestrator proves
the behaviour of a **deployed system**. Offline evidence is never labelled
Production acceptance.

#### Accidental live execution

The default invocation is a dry run that exits `BLOCKED`:

```
live execution         : REFUSED
Production mutation    : NONE
network media request  : NONE
job created            : NONE
```

A live run requires **both** `--live` and an exact `VIDEOFETCH_ACCEPT_LIVE=1`.
Neither is inferred from anything: there is no "live if a Production host is
reachable" heuristic, and a Production-shaped environment with no flag still
produces a dry run.

#### The harness does not change what it measures

It never writes `/etc/videofetch/worker.env`, never restarts the Worker to
enable generic execution, never repairs a failed service or policy, and never
creates or rotates a credential. `lib/observers.mjs` enforces this
structurally: a hard read-only command allowlist means `systemctl restart`,
`nft`, `ip route add`, `docker run` and `sh -c` throw before a process is
spawned, rather than being merely discouraged.

Enablement, repair and rollback are Phase-10D operator steps.

#### The two-stage procedure Phase 10D must follow

```
STAGE A — reviewed image deployed, generic DISABLED
   │   17 gates: exact image identity, seven active services, the read-only
   │   vf-egress-policy-verify, media-namespace placement, exact runtime
   │   identity, truthful generic-disabled diagnostics, a forbidden-variable
   │   audit by NAME, and a full direct-media regression proven to the byte.
   │
   │   ALL must PASS. There is no warn-and-continue.
   ▼
   OPERATOR sets YTDLP_ENABLED=true, restarts only what is required
   ▼
STAGE B — generic ENABLED
       capability truthfulness, generic analysis, a real durable job through
       queued→ready, process-descendant sampling, the no-FFmpeg rule, Node/EJS
       containment, namespace identity, a safe-egress negative case, delegated
       R2 write, a Vercel signed GET validated by digest, cancellation,
       shutdown, the actual-byte guard, post-enable direct regression and the
       kill switch.
```

The harness **refuses to grade the wrong stage**: Stage A assertions against an
enabled deployment, or Stage B against a disabled one, exit `BLOCKED` with
`STAGE MISMATCH`. Stage B additionally requires a Stage A evidence record whose
verdict is literally `PASS`; there is no override flag.

#### Stop gates

Stage B is unreachable if any of these is not proven in Stage A:

```
exact image identity      required service chain     safe-egress verifier
exact runtime identity    generic-disabled truth     direct regression
R2 path                   Vercel delivery
```

A security-relevant property that **could not be measured** is `BLOCKED`, not
skipped, and `BLOCKED` stops the run exactly as `FAIL` does. Optional
site-specific coverage reports `NOT_EXERCISED`, which proves nothing and can
never satisfy a required check — so a source that never invokes the Node/EJS
runtime records that fact rather than claiming the containment case passed.

#### Known evidence gap, recorded in advance

The actual-byte-limit case (unknown or misdeclared `Content-Length`) requires a
safe, reproducible live fixture. `--max-filesize` does **not** prove it: the
pinned `HttpFD.real_download` checks that option only inside
`if data_len is not None`. If no such fixture exists at Phase 10D time, the run
must report

```
LIVE UNKNOWN-LENGTH BYTE-GUARD CASE NOT PROVEN
```

and the acceptance is **incomplete**. Substituting a unit test for it is
explicitly forbidden, and the harness fails a case whose declared length was
known — so a `--max-filesize` catch cannot be submitted as evidence for the
application byte watcher.

#### Deployment prose reconciled

Three comments asserted a Phase-10C1 fact that Phase 10C3 falsified — that no
user-URL yt-dlp execution path exists:

- `deploy/systemd/videofetch-worker.service`
- `src/shared/worker/contracts.ts` (the `features.ytdlpEnabled` contract)
- `src/worker/runtime/config.server.ts` (the `ytdlp.enabled` config field)

All three are **comment-only** changes; no functional systemd directive, schema
or code path was altered. The unit's `YTDLP_ENABLED` block now states the
three-value grammar (absent / `"false"` / `"true"`), records that the image may
contain the reviewed execution path while enabling it remains a separate
deployment decision, and reiterates that safe egress is the external
systemd/netns/nftables boundary rather than anything this variable controls.

The unit still sets **no** `Environment=YTDLP_ENABLED`. The deployed value comes
only from `/etc/videofetch/worker.env`, so the operator disables generic
execution by removing the variable there — or setting the approved disabled
value — with no edit to the committed unit.

`src/worker/runtime/worker-unit-ytdlp-policy.test.ts` asserts both halves: that
the retired claim is absent from the unit's comments in any wording, and that
the accepted functional controls are unchanged — the safe-egress and broker
`Requires`/`After`/`BindsTo` edges, both fatal `ExecStartPre` gates, the media
namespace with no fallback, `--cap-drop=ALL`, `no-new-privileges`, the read-only
root, the 2 GiB `noexec,nosuid` tmpfs, the read-only broker socket directory,
the numeric `--group-add`, and the absence of any Docker socket mount.

#### Privacy contract of the harness

One redaction implementation covers console output, the JSON record, errors and
command summaries. Query strings are removed wholesale rather than
per-parameter, because the acceptance URL is third-party test data and the
per-run sentinel deliberately lives in a query parameter — a "safe parameter"
allowlist would make the sentinel test unfalsifiable.

Process sampling collects `pid`, `ppid`, `pgid`, executable **basename** and
network-namespace inode. It never collects command lines: the acquisition argv
ends in the submitted URL. A sample carrying `cmdline`, `argv`, `exe`, `command`
or `url` is rejected outright rather than redacted.

The evidence record is assembled from an allowlist, redacted at every depth,
then stripped of forbidden keys. `/etc/videofetch/worker.env` is never dumped or
read — `YTDLP_ENABLED` is observed from the container's bound environment, and
every other variable is reported as a bare name or a boolean.

#### CORRECTION-01 — review findings closed

Four findings were raised in review of the Phase-10C4 draft and corrected on the
same branch. Each falsified something the phase claimed, so they are recorded
rather than folded silently into the description above.

**1. The live CLI depended on test-only observation injection.** The evaluators
were sound, but most observations reached them through `deps.<name>` seams that
only a test populated. A Phase-10D operator would have had to write a script
importing `main()` and fabricating those objects — recreating precisely the
improvised live layer this phase exists to eliminate.

The harness now owns the acquisition path end to end:

| Added | Obtains |
| :--- | :--- |
| `lib/control-plane.mjs` | authenticated login, analyze, job creation, status polling, the 303 signed GET, and byte digests |
| `lib/process-sampler.mjs` | `docker top -o pid,ppid,pgid,comm`, per-PID namespace identity, and the owned yt-dlp PID |
| `lib/cases.mjs` | Stage B case choreography and the case-record contract |
| `lib/coverage.mjs` | the check → producer registry the test suite walks |
| concrete observers | image-SHA and `latest` tag identity, the bundled-EJS version, durable job rows, workDir presence, log capture |

`VIDEOFETCH_ACCESS_SECRET` is now genuinely used: a live run calls the existing
`POST /api/access/login` exactly once and holds the cookie in memory. A missing
secret is a **usage failure** (an unauthenticated probe would 401 and be recorded
as a capability failure — a false finding); a failed login is `BLOCKED`, never a
silent fall-through to unauthenticated observation. `--expected-sha` became
mandatory for the same reason: a live run that cannot say which image it is
grading should not start.

Stage B became multi-run, because enabling generic, cancelling a job, stopping
the Worker mid-acquisition and rolling the switch back are separate operator
transitions. Each case is its own reviewed command emitting a sanitized record;
`--stage B --aggregate` produces the verdict. A record is admitted only if its
harness id, schema version, case name, expected SHA and image object all match
and its payload passes a **strict** validator with no unknown keys — then every
field is re-judged by the pure evaluator. A hand-written `{"passed": true}`
cannot produce a PASS.

A structural test walks `lib/coverage.mjs` against both evaluators and fails if
any emitted check lacks a concrete, non-test producer, so the same incompleteness
cannot return when a check is added.

**2. `["ready"]` satisfied the lifecycle contract.** The old ordering predicate
accepted any ordered subsequence, which made "the poller only ever saw the final
state" indistinguishable from "the job passed through the ladder" — the very
thing the evidence exists to show.

All six states are now required, and the outcome is three-way: complete and
ordered is `PASS`, a backwards trace is `FAIL`, and an **incomplete** trace is
`BLOCKED` — an evidence gap, never proof. Observation was strengthened to meet
the contract rather than the contract weakened to fit observation: the poller
runs at 200 ms, and the trace is seeded from the `POST /api/download` response,
which is the only observation that can witness `queued` for a job that leaves the
queue before the first poll.

**3. The legitimate durable `formatId` was mistaken for a raw selector.** Phase
10C3 persists the application-owned preset in the `format_id` column on purpose;
forbidding it would have rejected every real durable row, under both the
snake_case column name and the camelCase projection.

`formatId` / `format_id` were removed from the forbidden list and replaced with
positive evidence: `durable.application-format-id` proves the durable value is a
`preset:*` rung **and** equals the preset the job was created with. The forbidden
list now names only fields that could carry the private upstream selection —
`source_format_id`, `rawFormatId`, `selector`, `format_selector`, `ytdlpFormat`,
`sourceUrl` and their variants — which have no column at all. The durable reader
projects only `job_id, status, format_id, extractor`; the `url` column is never
selected, because it holds the acceptance URL and, during the sentinel case, the
sentinel.

**4. Process proof accepted any Python process, and the sample schema was a
blacklist.** `process.ytdlp-present` merely looked for a Python descendant, and
`validateSampleShape` rejected a list of known-bad field names — which only
catches the leaks somebody already thought of.

`process.ytdlp-identified` now proves a specific PID: a descendant of the Worker,
with an approved runtime basename, **its own process-group leader**, in the media
namespace. Group leadership is the discriminator — `process-runner.server.ts`
spawns acquisition with `detached: true`, so the owned process necessarily leads
its group while an unrelated Python descendant inherits the Worker's — and it is
the property every containment and termination proof is expressed in terms of.
Zero or several candidates is a measurement failure, not a guess. Node
containment is anchored to that verified PID, and is `BLOCKED` without an anchor
rather than reported as contained.

The sample schema became a true allowlist — exactly `pid`, `ppid`, `pgid`,
`comm`, `netns`, with type validation and a `comm` that must be a bare basename.
`docker top -o pid,ppid,pgid,comm` is used precisely because it cannot return a
command line: `ps -ef` and `/proc/<pid>/cmdline` would each hand back the
acquisition argv, whose last element is the submitted media URL.

Also corrected while closing these: the sentinel is now minted and swept by the
real CLI code path rather than only specified, and console output crosses the
central redaction/scrub boundary structurally instead of relying on each call
site.

#### CORRECTION-02 — five acceptance-integrity gaps closed

**1. Four advertised Stage-B cases had no producer.** `byte-limit`, `shutdown`,
`safe-egress` and `fail-closed-runtime` were listed as case names and counted as
concrete producers, while the CLI dispatch implemented only four of the eight. A
description string is not an implementation.

`byte-limit`, `shutdown` and `safe-egress` are now real producers.
`fail-closed-runtime` is declared **non-live** — it cannot be run as a case
command, is refused at parse time with what it actually is, and its check is
optional in the evaluator so it can never satisfy a required assertion. One
registry (`CASE_PRODUCERS`) is now the single source of truth for the CLI, the
coverage map and the tests, so a name cannot be advertised without a callable
`run`.

The `byte-limit` producer **measures** the unknown-declared-length property
itself rather than accepting an operator boolean: a fixture that declares a
usable `Content-Length` would be caught by `--max-filesize`, and a pass from it
would be evidence for the wrong gate. The `shutdown` producer proves the job is
genuinely acquiring, prints a sanitized prompt, and waits for the operator's
separately authorized stop/restart — `systemctl stop` is not on the read-only
allowlist and is never called. The `safe-egress` producer is an adapter over the
accepted Phase-9 instrument, not a second firewall framework.

**2. Process evidence was not scoped to `downloading`, and lost observations.**
Sampling ran from job creation until the job settled, so `processing` samples fed
a check named "no FFmpeg during downloading" — and Worker FFmpeg is *legitimate*
during `processing` (`preset:mp3`, and `preset:audio` from a muxed source). A
correct deployment would have failed it. The sampler also kept one "best" sample
and discarded the rest, so a transient `ffmpeg` visible in one 250 ms sample was
simply not in the retained evidence.

The window now opens on the first observed `downloading` and closes permanently
on the first state after it, and **every** sample in it contributes: one
appearance of a forbidden or unknown executable, or one namespace mismatch,
fails; a Node solver appearing in one sample is EXERCISED and judged rather than
reported as never having run. Admission depends on when a sample was *taken*, not
when it landed — sampling is asynchronous, and judging by landing time discarded
every sample of a fast job.

**3. Unavailable measurements were converted into clean-looking values.** The R2
producer returned `objectExists: true` when the authenticated Worker job view
could not be read, on the grounds that the job was `ready`. The workDir probe
collapsed "could not measure" into "present". The post-cancellation sampler
returned `postSample: []`, and the direct-regression sampler
`sampledBasenames: []` — both of which *passed* their checks. The sentinel sweep
substituted `""` for an unreadable surface, turning "could not read the logs"
into "the sentinel is absent from the logs".

Each is now a measurement with three distinct outcomes: unavailable is BLOCKED,
measured-negative is FAIL, measured-positive is PASS. The sweep additionally
covers six surfaces each with a real observer — including a cloudflared journal
reader and a **genuine 404 error body** rather than a successful status response
relabelled as an error surface — and the final record is checked before writing:
if the scrubber had to act, the run is BLOCKED, because the scrubber is a
disclosure backstop and not evidence of clean handling.

**4. Local evidence artifacts were not tamper-evident, and the Stage-A image
binding could be null.** Strict schema validation is not provenance: a
hand-written record with the right field names was accepted, which violated the
rule that no arbitrary operator JSON assertion may create a PASS.

Every Stage A and case record is now sealed with an HMAC-SHA256 over a canonical
encoding of harness, schema version, run id, stage, case, expected SHA, image
ids, verdict and payload. Authenticity is verified **before** any field is read.
The key is a per-run, acceptance-only random value in a `0600` local file,
gitignored, never printed and never recorded — deliberately **not** any
application credential, so a leak of the harness's own state is not a production
incident. Stage A begins a run; Stage B joins it and refuses to mint one.
`loadStageA` now requires a complete, self-consistent binding: valid
`expectedSha`, `runningImageId` and `taggedImageId` matching each other and the
current deployment. A `runningImageId: null` record can no longer authorize
anything.

**5. Two live checks overstated what they observed.**
`analysis.routed-to-generic` claimed direct was observed falling through for the
generic URL. It was not — nothing at the application boundary can observe that,
and adding a surface that could would be the debug endpoint this design forbids.
It is now two honest checks: `analysis.generic-selected` and
`analysis.direct-still-selected`, with the direct-first router remaining a
**source-reviewed invariant** tied to the observations by the exact-image
binding.

`selector.constraints-satisfied` presented a container comparison as proof of the
private selector's internal constraints. Those are proven **offline** by
`verify-selector.py` against the pinned parser; the live check is renamed
`delivery.matches-advertised-preset` and claims only that. `vercel.byte-digest`
became `vercel.byte-integrity` and now states exactly which boundaries it
measured — durable `fileSize`, provider `contentLength`, delivered bytes and
their SHA-256 — without implying an independent digest of the Worker-produced
object, which only the direct fixture case genuinely has.

#### CORRECTION-03 — six acceptance-integrity defects closed

**1. The kill-switch case was impossible, and the state gate was not
fail-closed.** Every Stage B case was guarded by a single global requirement
that `YTDLP_ENABLED=true`, so `kill-switch` — whose entire purpose is to prove
generic becomes unusable when the operator turns it off — could never run. The
guard was also silent when the state could not be measured at all.

The required deployment state is now declared PER CASE: `enabled` for `success`,
`cancellation`, `byte-limit`, `shutdown`, `safe-egress` and `direct-regression`;
`disabled` for `kill-switch`, using the accepted grammar (absent or exactly
`"false"`). An UNMEASURED state blocks every case, because a case graded against
an unknown stage produces evidence nobody can interpret. The ordered sequence —
Stage A disabled, operator enables, enabled-state cases, operator disables,
kill-switch, operator restores the chosen final state, aggregate — is documented
rather than left implicit.

**2. Termination proved the wrong thing.** Cancellation and shutdown checked the
CURRENT Worker's descendant tree. A cancelled or restart-orphaned acquisition
process is re-parented away from the Worker, so an ancestry check sees a clean
tree while the process is still running — and after a restart the new Worker
never had those descendants at all. "The new Worker is clean" and "the old
acquisition group died" are different assertions.

Both cases now capture the exact owned yt-dlp PID/PGID while the job is in
durable `downloading` — established by the detached-spawn invariant, `pgid ===
pid` — and afterwards ask the HOST whether that group has any surviving members,
through one allowlisted `ps -eo pid=,ppid=,pgid=,comm=`. (`ps -ef` and `ps aux`
print the full command line, whose last element is the submitted media URL, so
the allowlist was tightened to that single invocation.) Survivors that could not
belong to an acquisition group are treated as PID/PGID reuse and reported
BLOCKED rather than guessed either way.

**3. Safe-egress attribution did not use the Phase-9 standard.** A request
failure plus `vf-egress-policy-verify == 0` proves the policy is intact; it
proves nothing about what stopped that particular connection. Phase 9 already
settled this: a connection that fails while the deny counter increments was
denied by the firewall, while one that fails with every counter flat was denied
by something else — most often a missing route.

The case now reads the actual nftables deny counter before and after, through
one read-only listing (`nsenter -t <netns pid> -n nft -j list chain inet
videofetch_egress output`), using the same rule-comment vocabulary
`deploy/acceptance/safe-egress/counter.py` already consumes. A flat counter can
never pass; an unreadable counter is BLOCKED. The case also proves the forbidden
destination was reached through the GENERIC path, because a submitted URL that
merely redirects to a private address is rejected by the control plane's own
SSRF guard long before generic is reached — such a case would "pass" while
proving only that the direct layer works.

The policy fingerprint is now a hash of the normalized chain JSON with counters
stripped. The previous fingerprint combined the policy unit's systemd
`InvocationID` and activation timestamp, which describe the unit's lifetime
rather than the rules: a rule changed by hand while the unit kept running would
have left both identical.

**4. The byte-limit case measured the wrong request.** It did `HEAD` on the
SUBMITTED URL. The property under test is the transfer semantics of the
progressive media GET yt-dlp selected from that page — so a page with no
`Content-Length` whose media resource declared one would have passed while being
caught by `--max-filesize`, which is precisely the gate this case exists to rule
out.

The harness cannot learn which media URL yt-dlp chose without breaching the
private-selector boundary, so the controlled fixture reports what it actually
served. The case fails if the actual media GET declared a usable length, fails if
the fixture analyzed as `direct`, and remains BLOCKED — `LIVE UNKNOWN-LENGTH
BYTE-GUARD CASE NOT PROVEN` — when the transfer semantics cannot be established.
Every generic-specific case (`success`, `cancellation`, `byte-limit`,
`shutdown`, `safe-egress`) now asserts `extractor === "yt-dlp"` rather than
assuming an operator-supplied "generic URL" caused generic execution.

**5. Only part of the evidence was authenticated.** The HMAC covered a named
subset, leaving `checks[]`, `runtime`, `services`, `delivery`, `process`, the
nested `binding` and every timestamp outside the seal — an editable
`checks[0].outcome` being the clearest example of what that misses. Enumerating
was also the wrong shape, since a field added later would silently fall outside.

The seal now covers the complete record minus only the authenticator itself, so
future fields are authenticated by default. The top-level identity and the
nested binding must additionally agree, and an existing run-key file is refused
on load if it is group- or world-readable.

**6. Final process evidence used the obsolete single-sample shape.** The
serializer still read `observation.value.sample`, which the multi-sample window
does not have, so the record emitted empty basenames and empty namespaces
regardless of what was observed. It now derives from the same aggregate the
evaluator judges, reporting sample counts, basenames seen, owned-PID
identification, Node exercise/containment and violation counts.

Relatedly, a sampling attempt that FAILED while the downloading window was open
now blocks the negative claim — it leaves a real unobserved interval. A sample
that straddles the window close is discarded and counted rather than blocking:
sampling is asynchronous, so the final in-flight snapshot straddles the close on
every healthy run, and treating that as a gap would block every run. The residual
limitation is reported in the evidence as `ambiguousSampleCount` rather than
hidden.

**Also reconciled, comment-only:** `src/worker/http/business-service.server.ts`
still asserted that runtime availability plus operator enablement does not mean a
user URL can reach yt-dlp "because no such path exists". That ceased to be true
in Phase 10C3. The comment now states that runtime availability and operator
enablement are distinct and both necessary, while reachability is supplied by the
reviewed application router and execution path. No diagnostics behaviour changed.

#### CORRECTION-04 — four remaining acceptance-integrity gaps closed

**1. Final aggregation still graded the CURRENT deployment as if generic had to
be enabled.** CORRECTION-03 documented the multi-state sequence but left the
aggregate reading `capability.generic-usable` and `config.ytdlp-enabled` from
the deployment as it stood at aggregation time. That contradicted the sequence
in both directions: the sequence *ends* with the operator restoring the disabled
state and running `kill-switch`, so a correctly executed acceptance would have
failed at the last step — and the same check could be satisfied by enabling
generic in the minute before aggregating, a state with no connection to when any
evidence was captured.

Every case record now carries a `featureState` the harness MEASURED while that
case ran — the deployment's own `YTDLP_ENABLED` spelling and the application's
own `/api/sites` answer — sealed with the record and therefore uneditable. A
`success` artifact recording the disabled state, or a `kill-switch` artifact
recording the enabled state, is rejected outright. The aggregate reads each
state-dependent claim from the artifact that observed it, adds
`killswitch.disabled-state-proven` for the disabled half, and RECORDS the state
at aggregation time under `deployment.final-state-recorded` without grading it.

The terminal-state policy is explicit rather than implied: **either** state
aggregates successfully, `disabled` is the preferred Phase-10D outcome (this
runbook keeps Production `YTDLP_ENABLED` unset, and Phase 10E owns final product
enablement), and an unmeasurable final state is BLOCKED.

**2. Byte-limit fixture evidence was not bound to the case, and never showed the
threshold was crossed.** The probe asked the fixture "did you serve a media
request?" with no way to tell which one — a static endpoint answering
`{"actualMediaRequestObserved": true}` satisfied it, and so did evidence left
over from an earlier run. Separately, `TOO_LARGE` alone says a job failed; it
does not say the application byte threshold was reached, so a fixture serving
less than the limit would have produced a PASS while describing a bug.

Each run now mints a 128-bit correlation id (test data, not a credential),
submits it as `vf_case` on the fixture URL, and requests the fixture's evidence
for exactly that id; a foreign id, a missing association, or a media-request
count other than one is BLOCKED. The case also measures the EFFECTIVE deployed
limit — the single non-secret `MAX_FILE_SIZE` variable read through
`docker inspect` and parsed with the runtime's own grammar, defaulting to 500
MiB — and requires `bytesServed > effectiveMaxFileSizeBytes`. Inferring the
limit from source would be wrong wherever a deployment overrides it.

**3. Any nftables comment could be named as the deny counter.**
`--egress-deny-class` took a free-form string, so `public-http` (an ACCEPT rule
whose counter moves on every ordinary media fetch) or `established` (which moves
on essentially every response) would have attributed a denial to a counter that
had nothing to do with one. The list also named three classes that do not exist
in the deployed ruleset — `deny-v4-mapped`, `deny-multicast`,
`deny-link-local` — whose destinations are elements inside `@forbidden_v4` and
`@forbidden_v6` and increment `deny-v4`/`deny-v6`.

The enum is now exactly the deployed policy's deny rules — `deny-v4`, `deny-v6`,
`deny-v4-broadcast` — parsed at argument-parse time, before any live operation.
Every accept rule, the catch-all `fallthrough-drop` counter, and any unknown
value are usage errors. The fixture family determines which class is expected;
counter-delta, request-failure, verifier and fingerprint requirements are
unchanged.

**4. Malformed host process rows disappeared from termination evidence.** The
parser skipped any non-empty line it could not interpret. The termination proof
is a NEGATIVE one whose evidence is the ABSENCE of matching rows, so a single
unreadable line — precisely where a leaked process's unexpected name would
appear — turned one real survivor into `[]` and therefore into a PASS.

Any non-empty line that is not exactly four fields, three numeric ids and a
plain executable basename now makes the WHOLE listing unmeasured, and the
termination check lands BLOCKED. The refusal names the line number and the
defect, never its content — a malformed line is exactly the case where the
content might not be a `comm`. Blank lines are still skipped.

**Also hardened (two smaller consistency fixes):** the run-key permission check
now applies on EVERY path that touches the file, so Stage A can no longer
silently resume an already group- or world-readable key; and a permission
measurement that fails for any reason other than the file being absent fails
closed, because "we could not read the mode" is not "the mode is fine". The
stale comment in `download-window.mjs` claiming a straddling sample makes the
window unusable was reworded to match the implemented discard-and-count policy.
The accepted CORRECTION-03 ambiguity policy and monotonic clock are unchanged.

#### CORRECTION-05 — six acceptance-integrity gaps closed

**1. The observer retrieved every Worker environment VALUE before discarding the
unwanted ones.** `environmentNames`, `ytdlpEnabledRaw` and `effectiveMaxFileSize`
all rendered `{{range .Config.Env}}{{println .}}{{end}}`, which emits the
complete `NAME=value` environment — `WORKER_CONTROL_SECRET` included — and then
split the values off in JavaScript. For a harness whose subject holds secrets
that is the wrong order of operations: the value crossed into the harness
process, lived in a Node string and in a child process's stdout buffer, and was
discarded only afterwards. Fetched-then-sanitized is not never-fetched.

Environment observation is now three fixed probes, each answering one question:
names only (no `=`, no value, no length, no hash), `YTDLP_ENABLED` alone, and
`MAX_FILE_SIZE` alone — the two non-secret deployment variables the numeric and
grammatical assertions genuinely need. Each probe's source is a compile-time
constant matched whole by the `docker exec` allowlist, so the caller cannot
redirect a read to a different variable, and no general Python execution
capability exists. `docker inspect` is additionally restricted to three named
templates (`{{.Image}}`, `{{.HostConfig.NetworkMode}}`, `{{.State.Pid}}`), which
makes retrieving the environment that way unrepresentable rather than unused.

**2. A case could be sealed against the pre-restart image.** The record bound to
the image measured BEFORE the producer ran. `shutdown` exists to span an operator
restart, and systemd starts `videofetch-worker:latest` — so a restart is an
image-resolution event, and a record could combine pre-restart and post-restart
evidence under an id that only ever described the first half.

Every Stage B case now resolves the authorized SHA-tagged image before the
producer, requires the running image to BE that object, resolves it again after,
and requires exact equality before anything is sealed. An image that changed, or
that could not be re-measured, is BLOCKED with no record written. Container
identity is deliberately not the binding: a restart legitimately recreates the
container from the same image, and the PID is expected to change.

**3. Shutdown accepted any non-empty recovered status.** The predicate was
`typeof recoveredStatus === "string" && length > 0`, under which `ready`,
`cancelled`, and a job still sitting in `downloading` all passed a check named
`job-recovered`. The Worker's policy is deterministic: `recover()` in
`src/worker/state/sqlite-job-store.server.ts` moves every job left in
`analyzing`, `downloading`, `processing` or `uploading` to exactly `failed` /
`PROCESSING_FAILED` / `Worker restarted before the job completed.`

Acceptance now asserts that result. The safe message is asserted rather than
skipped as brittle, because it is a literal in the Worker's own SQL and is the
only field separating "the restart path recovered this job" from "the job failed
on its own and was classified PROCESSING_FAILED" — which every internal
acquisition failure is. It is read through the browser projection `error`, which
`src/web/jobs/public-job.ts` documents as where `safeErrorMessage` surfaces.
Recovery is polled within a bounded window rather than read once, because the
restart is detected the instant the new container's PID appears — before the
Worker has opened its database, run `recover()`, or begun answering HTTP. The
PGID-termination proof remains an independent requirement; neither substitutes
for the other.

**4. Direct-regression sampling errors could be erased by a later success.** The
producer held a single nullable `samplingFailure` that the next successful sample
overwrote with nothing, so a run that lost an observation interval looked
identical to one that never did — while the check it fed claims that no yt-dlp
process appeared across the whole run. Failed attempts are now accumulated, and
one is enough to BLOCK both direct sampling checks regardless of how many clean
samples surround it. This is the rule the generic downloading window already
applied. A yt-dlp process actually observed remains a FAIL, not a BLOCKED.

**5. The host `comm` parser was stricter than procps.** It split on whitespace
and demanded exactly four tokens, but procps permits a `comm` containing spaces
— it derives from the executable name. One unrelated host process with such a
name made the entire listing unmeasurable and every termination check BLOCKED,
for a reason with nothing to do with the captured group: a fail-closed rule
misapplied, turning an irrelevant oddity into an unanswerable question.

The three numeric ids are now parsed structurally and the remainder taken as the
single `comm` field it is by the format's own definition. The fail-closed part is
the numeric prefix — a line whose ids cannot be read might belong to the captured
group — while an unusual `comm` keeps its row under the fixed token
`<unclassified>` rather than being dropped or copied verbatim. An unclassifiable
survivor inside the captured group is reported as ambiguous and BLOCKS; it can
never become an empty survivor set. The `ps` invocation, and its absence of any
argv column, is unchanged.

**6. A present-but-malformed run-key file was silently overwritten.**
`loadOrCreateRun` fell through to "mint a fresh run" on unreadable content or
malformed JSON, which replaced the file — destroying the only key that could
verify the artifacts already sealed under it, and doing so silently at the exact
moment something was already wrong. `ENOENT` is now the only condition that mints
a run; a file that exists is never replaced, and unreadable content, malformed
JSON or an invalid structure each BLOCK. A damaged file is an error rather than a
`null`, because `null` means "no run has been started" and would send the
operator to re-run Stage A over the very file that needed attention.

#### CORRECTION-06 — four residual acceptance-integrity gaps closed

**1. An observation gap could erase a positive finding.** The direct regression
routed two independent questions — *was the run continuously observable?* and
*did any observed sample contain yt-dlp?* — through a single gate, so one failed
sampling attempt downgraded a positively observed yt-dlp process from FAIL to
BLOCKED. That is the strongest evidence the case can produce, turned into
uncertainty because some other interval was uncertain.

The two are now graded separately. Coverage is BLOCKED whenever a sampling
attempt failed; the finding is FAIL whenever an approved yt-dlp runtime basename
appears in a SUCCESSFUL sample, gap or no gap. FAIL already outranks BLOCKED in
the summary, so a finding alongside a gap fails the run — the honest reading:
something bad happened and we could not see all of it. A finding is never
inferred from an error message, because a failed attempt observed nothing.

**2. `docker top` was neither structurally bounded nor fail-closed.** The
allowlist checked `argv[0] === "top"` alone, so `docker top <c> -o args`,
`-o pid,args`, `-o command` and a bare `docker top <c>` (whose default format
includes CMD) all passed the boundary the architecture claims makes command
lines structurally unavailable. The allowlist now admits exactly
`docker top <container> -o pid,ppid,pgid,comm`, with the container name checked
against Docker's own name grammar; every argv-bearing form is refused before a
process is spawned.

The parser also did `continue` on a short row and on a non-numeric id. The
downloading window's assertions are NEGATIVE and their evidence is the absence
of matching rows, so one unreadable line left the remaining rows looking clean
and the window PASSING — and the row most likely to be unusual is exactly the
one those checks exist to catch. An unreadable numeric prefix now makes the whole
SAMPLE unmeasured, which the collector records as a sampler error and the window
gap rule turns into BLOCKED. A valid row with an unusual `comm` keeps its row
under the fixed token `<unclassified>`, which is not an approved acquisition
executable and therefore FAILS `process.no-unknown-descendants` rather than
vanishing. The header is validated rather than skipped, because blindly dropping
the first line loses a real process row when the header is absent; the expected
`PID PPID PGID COMMAND` was verified against the pinned image on this
Docker/procps combination. The host-level PGID parser stays a separate
implementation: both are fail-closed, but they read different commands with
different output contracts.

**3. Cases proved image continuity but not feature-state continuity.** The
deployment state was measured once, before the producer. `shutdown` exists to
span an operator restart, so the same authorized image could come back with
`YTDLP_ENABLED=false` — restart recovery succeeding, image continuity holding —
and the record would still seal `featureState: enabled`, combining two
deployment states while claiming one.

Every executable Stage B case now measures the feature state on both sides of
the producer and refuses to seal unless the case's required configuration state
held and the capability report did not move. `featureContinuity` is sealed with
the record, and `validateCaseRecord` recomputes it rather than trusting its own
boolean; the canonical `featureState` must agree with the continuity it claims.

A particular capability VALUE is deliberately not gated. For `kill-switch`,
`/api/sites` still reporting `ytdlp: true` while the configuration is disabled is
not a precondition failure — it is the most important finding that case can
produce, and refusing to run would convert "the kill switch does not work" into
"we did not look". The evaluator grades that conjunction from the same sealed
evidence, as a FAIL.

**4. A malformed `runId` was still accepted.** The run-key admission test was
`typeof runId === "string"`, so a file carrying `""`, `"abc"`, or uppercase hex
passed with an otherwise valid key. `runId` is inside the authenticated material
and is compared across artifacts to prove they belong to one acceptance run, so
an identity the harness could never have generated is not a run identity. Both
fields are now matched against the exact grammar `loadOrCreateRun` produces —
16 and 64 lowercase hex characters. Every invalid shape BLOCKS on both entry
points and leaves the existing file untouched; ENOENT remains the only condition
that mints a run.

#### CORRECTION-07 — five residual evidence-boundary gaps closed

The governing rule for all five: **never transform raw evidence into a more
favourable identity before deciding whether that raw evidence was valid.**

**1. Run identity was admitted by coercion.** Admission tested
`RUN_ID_PATTERN.test(String(parsed.runId))`, so the value was transformed into a
more admissible shape and the transformed shape was then judged. A JSON NUMBER
escapes that test — `String(1234567890123456)` matches `/^[0-9a-f]{16}$/`
exactly — and it would have been admitted, carried into `verifyRecord`, and
compared against a string, making every artifact of the run unverifiable for a
reason nothing reports. Both fields now require `typeof === "string"` before the
grammar is applied. `loadOrCreateRun` mints `randomBytes(…).toString("hex")`, so
requiring the type is requiring what the harness actually produces. Every invalid
shape BLOCKS on both entry points and leaves the existing file untouched.

**2. `comm` was normalized before it was validated.** The `docker top` parser
computed `basenameOf(raw)` and validated THAT, so `suspicious/python3` became
`python3` — an APPROVED yt-dlp runtime shape. An executable the harness had never
approved acquired the identity of one it had: it stopped being an unknown
descendant, became a candidate for `establishYtdlpPid`, and could be graded as
the owned acquisition process. The check that exists to catch an out-of-band
executable was the check that gave it cover.

The RAW field now decides. A raw `comm` that is already a plain basename is
lowercased and kept; anything else keeps its row and loses its name to
`<unclassified>`, which is not on the approved list and therefore FAILS
`process.no-unknown-descendants`. Paths are not stripped, unusual names are not
trimmed into approved ones, and no row is ever dropped. The host-level PGID
parser already validated its raw field and is unchanged.

**3. Favourable stdout could come from a failed command.** Several observers
consumed a command's buffer without checking its exit status, so a well-formed
value beside a non-zero exit became a measurement. That matters because the
harness's assertions are mostly NEGATIVE: a `docker top` that fails while
emitting a syntactically perfect listing looks exactly like a clean one, a
`workDir` probe printing `False` beside a failure fabricates the most favourable
answer it could give, and a stale `docker inspect` PID sends every containment
proof to the wrong process tree.

Successful completion is now required before stdout may support a measurement
claim, across `docker top`, the four container `docker inspect` templates,
`readlink /proc/<pid>/ns/net`, the Python/Node/EJS version probes, the `workDir`
probe and the media-namespace holder PID. Two commands are STATUS-AS-DATA and
are deliberately unchanged: `systemctl is-active` exits non-zero BECAUSE the unit
is inactive, and `vf-egress-policy-verify`'s exit code IS the verdict. Turning
either into BLOCKED would convert a finding into a refusal.

**4. Evidence was not bound to a container epoch.** Image identity answers which
reviewed image; feature state answers which configuration. Neither answers which
RUNNING INSTANCE produced the evidence — and the unit is `docker run --rm` behind
an `ExecStartPre=-docker rm -f`, so a restart is a container RECREATION from the
same image with the same environment file. Two endpoint measurements agreeing on
image and feature state are fully consistent with an unnoticed restart between
them, and a case whose acquisition window spanned one is two half-observations of
two runtimes reported as one.

`docker inspect --format {{.Id}}` is added to the allowlist — a non-secret
content-addressed object name — and every case now seals a `containerEpoch`.
Ordinary cases require one instance start to finish. `shutdown` pins its one
intentional transition end to end: the instance the case began on must be the
one the restart watcher saw go away, the new instance must genuinely differ, and
the instance current at sealing must be that same new one, so a SECOND
recreation cannot pass as the first. The image, feature state and instance are
read as one BRACKETED snapshot on each side — instance first and last, and they
must match — so the post-case properties cannot describe a container the watcher
never saw. `validateCaseRecord` recomputes the epoch and requires it to agree
with the case's own restart evidence.

The image binding is NOT replaced: it remains what ties evidence to reviewed
code. The epoch only bounds the interval that evidence describes, and the
documented claim says exactly that rather than asserting continuous observation
of every instant.

**5. The run key was created non-atomically.** `stat` → ENOENT → `writeFile` is a
check followed by an unguarded write, and everything CORRECTION-05 established
about never replacing an existing run key lived in the gap between them: two
Stage A invocations both see ENOENT, both write, and the second destroys the key
the first has already begun sealing artifacts with. Creation now uses
`flag: "wx"`. Losing the race is BLOCKED — not "load the winner instead", since
the winner's `runId` identifies a run this invocation did not begin and whose
Stage A binding it has not verified — and the winner's file is neither
overwritten nor `chmod`ed.

Separately, the unused `sampleWhile` helper was REMOVED. It swallowed individual
sampling failures and returned the richest successful sample whenever any had
succeeded — the exact gap policy removed everywhere else. No live path called it;
leaving it exported would only have let a future caller reintroduce the defect by
reaching for the obvious name.

CORRECTION-06's positive-finding precedence, exact `docker top` argv boundary,
header validation, fail-closed row handling, feature continuity and the
kill-switch value-not-gate rule are unchanged.

#### CORRECTION-08 — two final artifact-integrity defects closed

**1. The evidence schema identifier was stale.** It still read
`10c4-correction-03`, which was no longer truthful: the acceptance contract has
changed materially since, even where a record's JSON shape has not.

A valid HMAC proves only that an artifact has not changed since somebody holding
the run key produced it. It says nothing about WHICH revision of the harness's
observation semantics produced the contents it authenticates, and only the
schema version can.

That gap mattered specifically for Stage A. Stage B case records are already
refused structurally when a required field is absent, so an older case artifact
cannot pass today's validator. Stage A's record shape has not changed since
CORRECTION-03, so an artifact produced by a much weaker harness revision could
carry the same runId, the same key, the same source SHA, the same image binding
and a PASS verdict — and therefore satisfy `loadStageA()` and AUTHORIZE CURRENT
STAGE B. What it actually attested was far less: narrow secret-safe environment
observation, non-zero exits no longer accepted as measurements, fail-closed
process parsing, state/feature/image/container-epoch continuity, strict run
identity and atomic key creation all postdate it.

The schema is now `10c4-correction-08`, one constant governing Stage A, case
records and the aggregate so they cannot drift into describing different
contracts. `schemaVersion` identifies the acceptance PRODUCER CONTRACT, not
merely the set of JSON keys, and must be bumped whenever an observer or
evaluator change could make an old artifact mean something WEAKER under the same
shape. No live artifact compatibility is broken: Phase 10D has not run.

**2. Restart endpoints were assembled rather than observed.** The watcher read
the container instance and the PID separately and polled the PID for the
transition. Both halves were wrong.

Polling the PID produced FALSE NEGATIVES: PIDs are not unique across container
objects, so a recreated Worker whose main process received the same pid was
invisible — the watcher timed out and reported that no restart occurred while
one plainly had. That matters because the unit is `docker run --rm` behind an
`ExecStartPre=-docker rm -f`, so the container object is what a restart actually
changes.

Reading the instance around the PID rather than with it produced INCOHERENT
ENDPOINTS: a transition recorded as A -> C could be assembled from an A instance
read that preceded a PID from B and a later PID change that preceded a C
instance read. None of those three observations was of the same runtime, and the
record would claim "container A had PID X" for a pairing that never existed.

The container instance is now the polling authority, and each endpoint is a
coherent bracketed observation — instance, PID, instance again, all agreeing on
the instance. An instance that moves inside the bracket makes the observation
AMBIGUOUS, retried a bounded number of times, with exhaustion a measurement
failure rather than a pairing accepted on the last attempt. The PID remains in
evidence as auxiliary diagnostic data bound to the instance it was read from.

The claim language is bounded accordingly: the watcher observed the transition
from the recorded old container epoch to the recorded new one, and the case's
outer bracketed snapshots add that the new epoch remained current through
sealing. Polling is not claimed to prove that no transient intermediate
container existed between two polls; an additional recreation that IS observed
still BLOCKS.

The CORRECTION-07 epoch architecture is unchanged: `containerEpoch`,
`continuous` mode for ordinary cases, `one-restart` for `shutdown`, the pre/post
bracketed deployment snapshots, image identity as code provenance, feature
continuity, and container identity as runtime-epoch evidence only.

#### CORRECTION-09 — a positively observed restart epoch is no longer erased

CORRECTION-08 made the container instance the restart authority and required
each endpoint to be a coherent observation. One case remained wrong.

When the polling loop SUCCESSFULLY MEASURED a different instance and the
coherent endpoint then settled on a THIRD instance, the watcher recorded the
transition as old -> endpoint and discarded the instance it had just measured.
That is not a gap in observation; it is the deletion of one. The harness did not
merely fail to see an intermediate epoch — it saw one, and then reported a
transition that skipped it.

The two situations look alike and are not:

  AN UNOBSERVED INTERVAL — the container was unavailable, nothing was measured
  during the gap, and one coherent endpoint followed. Recording that transition
  discards no observation, so it remains usable, with the same bounded claim
  CORRECTION-08 established: polling cannot exclude epochs it never saw.

  A POSITIVELY OBSERVED INTERMEDIATE — a probe successfully measured one
  instance and the endpoint settled on another. Two distinct post-transition
  epochs were measured, so no single transition can be attributed to the
  restart.

The poll's sighting is now retained as `detectedInstanceId`, and the coherent
endpoint must equal it. If it does not, the case BLOCKS with "AN ADDITIONAL
WORKER RECREATION WAS OBSERVED WHILE ESTABLISHING THE RESTART ENDPOINT" and no
record is written. An endpoint-bracket retry does not change that: a later,
cleaner observation never overwrites an earlier positive one. The finding names
neither container id, because that two epochs were observed is the whole finding.

One probe establishes that a different container object exists but cannot bind a
PID to it, so the coherent bracket still runs — the accepted endpoint is the
instance the poll saw, carrying the PID that observation established. A PID from
one instance is never attached to another.

This introduces no stronger claim about polling. It only preserves what polling
actually observed. The schema identifier stays `10c4-correction-08`: the change
makes the watcher STRICTER, so no artifact becomes acceptable more weakly, and
the record semantics are unchanged.

Everything CORRECTION-08 established is preserved: the producer-contract schema
and its rejection of stale Stage-A and case artifacts, the container instance as
restart authority, the PID as auxiliary evidence, the instance -> PID -> instance
endpoint bracket with bounded retries, PID reuse being unable to hide a
recreation, the outer bracketed deployment snapshots, and the absence of any
continuous-observation claim.

#### PHASE-10D-BLOCKER-REMEDIATION-01 — the durable-state observer could not address Production

Phase 10D's live preflight found that the acceptance harness's durable observer
named three things and was wrong about all three:

```
database   videofetch.db   ->  worker.sqlite   (WORKER_DATABASE_FILENAME,
                                                 state-directory.server.ts)
table      jobs            ->  worker_jobs     (CREATE TABLE worker_jobs,
                                                 migrations.server.ts)
access     `sqlite3` CLI   ->  node:sqlite     (not installed on the Lima VM)
```

Nothing about this was subtle in effect: `durable.extractor-is-ytdlp`,
`durable.application-format-id`, `durable.no-raw-selector-fields` and the
sentinel sweep's `durable-row` surface could only ever have reported `BLOCKED`,
against any deployment, for a reason describing the instrument rather than the
system under test. That inverts what `BLOCKED` is supposed to mean — *we could
not measure this deployment*, not *this tool has never been able to measure
one* — and it is the precise failure mode the harness's own fail-closed design
exists to make visible rather than silent.

The correction is to the OBSERVER, not to Production. The Worker's contract is
authoritative; a measuring instrument that disagrees with it is the thing that
is wrong.

- the reader uses `node:sqlite` — the Worker's own driver — opened explicitly
  with `readOnly: true`, so no external executable is required and a missing
  database cannot be created by the act of looking for it;
- the projection is unchanged (`job_id, status, format_id, extractor`), and
  `url` is still never selected — a projection, not a post-filter, because the
  column carries the acceptance URL and, during the sentinel case, the sentinel;
- the job id is now a BOUND parameter rather than interpolated into SQL;
- `sqlite3` is REMOVED from the read-only allowlist rather than left dormant;
- the `node:sqlite` import is dynamic, so an older Node runtime costs one
  unmeasured observation instead of making the whole harness unloadable;
- the filename and table are restated in the acceptance layer (it is standalone
  `.mjs` on the VM host and cannot import the Worker's TypeScript constants) and
  cross-checked by the test suite against the sources that define them.

**Evidence schema bumped to `10d-remediation-01`.** The producer contract
changed materially: "durable state was measured" now comes from a producer that
can address the deployment at all. No live artifact is invalidated — Phase 10D
has still not produced one.

**CORRECTION-01 — the read moved INSIDE the Worker container.** The first draft
of this remediation read the database from the host with `node:sqlite`. That
removed the `sqlite3` dependency and introduced two worse ones: the Lima host
runs Node v18.19.1, which has no `node:sqlite` at all, and `/var/lib/videofetch`
is `0700` owned by uid 1000, so the host would also have needed filesystem
privilege. Trading one unmet host prerequisite for another is not remediation —
a tool that needs the deployment changed before it can measure it has not
measured it.

The runtime that can already do this ships with the deployment: the reviewed
Worker image carries `/usr/local/bin/node` v22.23.2, whose `node:sqlite` needs
no flag, and the container already has the durable volume mounted under the
Worker's own uid. The observer therefore spawns exactly one allowlisted probe:

```
docker exec videofetch-worker /usr/local/bin/node -e <fixed probe> <32-hex job id>
```

The probe source is a compile-time constant matched WHOLE by the allowlist, so
`docker exec ... node -e` is one fixed question rather than a general execution
capability. A different script, interpreter, database, table, column list or
argument count is refused before a process is spawned. The probe catches its own
failures and answers with a closed, size-bounded JSON response — `row`, `absent`
or one of three named error classes — so no raw SQLite text, stack, path, SQL or
argv crosses the boundary.

**The Phase-10D host now needs nothing new**: no `node:sqlite`, no `sqlite3`, no
database permission, no `sudo`, and no Node newer than the VM's v18.19.1. The
harness still loads and still refuses a live run there, verified on the VM.

**An absent durable row is a FAIL, not a BLOCKED.** A query that ran and proved
the row is not there is a MEASUREMENT, and the durable ladder is the Worker's
own record of a job the harness watched reach `ready`. Row presence is graded on
its own by the new `durable.row-present` check; the three content checks are
claims about a row, so when the row is provably absent they report that there is
nothing to judge rather than each restating the same finding. `FAIL` outranks
`BLOCKED`, so the case verdict is `FAIL`.

**Still recorded, still not fixed here.** `/var/lib/videofetch` remains `0700`
and is deliberately unchanged; the acceptance operator no longer needs to
traverse it.

**No Production mutation.** No deployment, image retag, `worker.env` edit,
systemd, network-policy, DNS, Cloudflare, R2 or Vercel change was made, and
`YTDLP_ENABLED` remains absent.

#### What Phase 10D is authorized to do

Nothing yet. Only after this harness has been **independently reviewed and
merged** may Phase 10D be authorized to touch the Lima VM, build and deploy the
exact reviewed image, or set `YTDLP_ENABLED=true`.

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

---

## 11d. Phase-10D controlled acceptance fixtures

**Source only. `PHASE-10D-ACCEPTANCE-FIXTURE-SUITE-001` implements and verifies
the fixtures; it deploys nothing.** No Worker image was retagged or built, no
`worker.env` was touched, `YTDLP_NETWORK_ISOLATED` was not removed,
`YTDLP_ENABLED` was not set, no Worker job was created, and neither Stage A nor
Stage B was run against Production.

### Why the fixtures exist

Phase 10D asserts properties of the Worker — the application byte watcher, the
cancellation window, the safe-egress boundary, the direct regression — and each
assertion is only as strong as the source it ran against. A third-party public
video makes the decisive variables somebody else's: byte count,
`Content-Length` semantics, transfer timing, secondary media destination and
expected digest can all change between the run that passed and the review that
reads it.

`deploy/acceptance/ytdlp-generic/fixtures/` makes those variables ours while
still crossing the real public-HTTPS and Worker-egress boundaries during the
live run. Its own `README.md` is the operator reference; this section is the
record.

```
fixture server                    temporary Quick Tunnel
binds 127.0.0.1 only  ─────────►  random *.trycloudflare.com HTTPS origin
```

### The four families

| Family | Route | The property it makes ours |
| :--- | :--- | :--- |
| direct control | `/direct.mp4` | exact bytes, exact length, exact digest, known before the run |
| generic progressive | `/generic` | one single-item muxed mp4 rendition, deterministically throttled |
| unknown-length byte limit | `/byte-limit` | no `Content-Length`, >500 MiB potential, per-case evidence |
| safe egress | `/safe-egress` | a media destination fixed in source at a private IPv4 address |

The route table is closed: anything else is `404`, an unsupported method is
`405`. There is no static-file server, no redirect endpoint, no URL proxy, no
shell surface and no environment dump, and no request input reaches any media
destination.

### The media

A 3-second 320x240 H.264 baseline (`avc1.42E01E`) plus mono AAC-LC
(`mp4a.40.2`) MP4, **48 497 bytes**, SHA-256

```
b1b9007bf9d28c334891bcbbc7dbc2d30261e708e5f044a080b74e031f75b5f4
```

generated by `fixtures/prepare-media.mjs` through the **Worker image's own**
`/usr/bin/ffmpeg` in a container with `--network none`, from synthetic `lavfi`
sources. The recipe is bit-exact, and regenerating it reproduced the same digest
exactly — so the expected digest is checkable by a reviewer rather than merely
asserted. It is never derived from anything that came back through VideoFetch.

### Observed pinned-yt-dlp behaviour

Measured against `/usr/bin/python3 /usr/local/lib/videofetch/yt-dlp`
(**2026.08.19**) from the retained `videofetch-worker:phase10c3-local` image, in
a disposable container with `--network none` running both the fixture and yt-dlp
over loopback.

All three pages extract as a **single non-live item** (`_type: "video"`, no
`entries`) with exactly one progressive `http`/`https` mp4 rendition and no HLS,
DASH or fragment reference. Their selected media destinations were
`…/generic-media.mp4`, `…/byte-limit-media.mp4?vf_case=<the same id>` and
`http://10.255.255.1/videofetch-denied.mp4` respectively. yt-dlp's own extractor
key is `HTML5MediaEmbed`; the Worker's `extractor` field is application-owned
(`"yt-dlp"`) and is not read from upstream, so `requireGenericStrategy` is
satisfied.

**No `Range` header was issued on any route**, in analysis or download; every
request was a plain `GET` with `Accept-Encoding: identity`, and yt-dlp sent no
`HEAD` at all. The fixture therefore declares `Accept-Ranges: none` and answers
the whole object, rather than carrying an unused partial-content path.

Submitting the **page** produced exactly one media `GET` (analysis fetches only
the page; the download run fetches the page again, then the media once).
Submitting a media URL directly produces two, because the Generic extractor
fetches the URL itself to decide whether it is HTML — acceptance submits pages,
so this does not arise, and the fixture would report `2` rather than hide it.

A full download through the page URL wrote a file whose SHA-256 equals the
generated fixture's exactly, confirming the throttle is a scheduler and not a
transformer. A download of the byte-limit media with `--max-filesize` set far
below the transfer **did not stop it**, confirming against the pinned binary
that the fixture genuinely defeats `--max-filesize` and leaves the application
byte watcher as the only gate.

### Contract mismatch found during fixture provisioning — CORRECTED IN SOURCE

Running the pinned extractor against the fixtures surfaced a real defect in
`src/worker/analysis/ytdlp-analysis.server.ts`. It was **not** a fixture problem,
and it could not be fixed in the fixture or the harness without fabricating codec
metadata or weakening acceptance, so it was left to its own task and review.

> **Status.** Corrected in source by
> `PHASE-10D-GENERIC-REAL-OUTPUT-COMPATIBILITY-001`, which reconciles generic
> analysis AND acquisition with the pinned runtime's real output. The defect is
> recorded here as it was found, because it is the reason the fixture suite
> merged before the live phase could run — not rewritten as though it had never
> existed. **Live Phase 10D has still not been executed:** Stage A, enabling
> generic, and Stage B all remain outstanding, and nothing below is a claim
> about Production.

**D1 — `hasAudio` is unreachable for any video-bearing format.**
`selectCandidates` requires `audio_ext !== "none"`, but yt-dlp 2026.08.19's
`_fill_sorting_fields` sets `audio_ext` to `"none"` on **every** format whose
`vcodec !== "none"`. `audio_ext` is a *sorting* field, not a statement that a
format carries no audio. `buildGenericPresets` requires `hasVideo && hasAudio`
for every video preset, so that condition is structurally impossible for real
output — for any source, not only this fixture. The repository's unit tests pass
only because their format fixture omits `audio_ext` entirely.

**D2 — the HTML5 path never reports a `vcodec`.**
`_parse_html5_media_entries` parses the `<source type="…; codecs=…">`
declaration into `vcodec`/`acodec` and then overwrites it with
`f.update(formats[0])`, where `formats[0]` carries `'vcodec': None`. So `vcodec`
comes back `null` and `hasVideo` is false as well; `acodec` survives.

Reproduced **as the defect stood** by calling the Worker's own
`selectCandidates` and `buildGenericPresets` on the captured documents:

| format shape | candidates | presets |
| :--- | :--- | :--- |
| repository test fixture (no `*_ext` keys) | `hasVideo`, `hasAudio` | `preset:best`, `preset:1080`, … |
| real muxed video (`vcodec` + `acodec` + `audio_ext: "none"`) | `hasVideo` only | **none** |
| real HTML5 (`vcodec: null`) | **none** | **none** |
| real audio-only (`vcodec: "none"`) | `hasAudio` only | `preset:audio`, `preset:mp3` |

**This blocked the live `success`, `byte-limit`, `cancellation`, `shutdown` and
`safe-egress` cases**, all of which call `pickPreset` and fail without one. The
direct regression and the kill-switch case were unaffected.

#### The corrected semantics

The fix is a three-state codec model — the governing rule being that **unknown
is not absent**. `vcodec = null` says the codec identity was not reported;
`vcodec = "none"` says there is no video stream. Only the second proves absence.

| field | `"none"` | a real codec string | `null` / absent / `"null"` |
| :--- | :--- | :--- | :--- |
| `acodec` | audio ABSENT | audio PRESENT | audio UNKNOWN |
| `vcodec` | video ABSENT | video PRESENT | video UNKNOWN |

- **Audio presence is decided by `acodec` alone.** `audio_ext` is retained in
  the raw schema for regression coverage but has no presence authority in either
  direction, because the pinned runtime sets it to `"none"` on every
  video-bearing format.
- **An UNKNOWN `vcodec` may establish video only from coherent source-shape
  evidence**: `video_ext` must be a real container, must equal `ext`, and that
  container must be in the generic VIDEO allowlist. No codec is ever invented —
  `WorkerQualityPreset.videoCodec` stays `null`.
- **Contradictions fail closed.** `vcodec = "none"` with a real `video_ext`, or
  a present `vcodec` with `video_ext = "none"`, make the format non-executable
  rather than being resolved in whichever direction would make it usable.
- **Unknown audio never becomes a muxed claim**, so split streams still produce
  no video preset and generic v1 still never merges.

Analysis and acquisition were corrected **together**, because a preset analysis
advertises must remain selectable by the constrained acquisition subprocess. The
private `GenericSourceSelection` gained an application-owned `videoConstraint`
enum (`codec-present` | `video-ext` | `absent`) recording HOW video presence was
established, and the selector's video half follows it:

```
codec-present   [vcodec!="none"]                          (unchanged, strict)
video-ext       [vcodec!=?"none"][video_ext="<container>"]
absent          [vcodec="none"]                           (unchanged, strict)
```

The `?` is load-bearing. `_build_format_filter`'s predicate returns the
`none_inclusive` group without ever consulting the operator when the field is
Python `None`, so the strict form silently matches **nothing** for an ordinary
muxed mp4 whose codec was not reported. The none-inclusive form accepts an
unknown codec and a later-known one, and still rejects an explicit `"none"`.
`verify-selector.py` proves all of this against the actual pinned binary inside
the image, and `audio_ext` is never constrained by any generic selector.

The enum is Worker-private: it never reaches the browser, Vercel, SQLite, an
HTTP response, a log or an error, and it carries no upstream codec string.

### Temporary Quick-Tunnel verification

Run from the Lima VM, which was **Stopped** before and after. The fixture bound
`127.0.0.1:18099` only (`ss` confirmed `127.0.0.1:18099`, never `0.0.0.0`), and
one separate `cloudflared` process exposed it:

```
/usr/local/bin/cloudflared --config /dev/null --no-autoupdate \
  --url http://127.0.0.1:18099
```

| Check | Result |
| :--- | :--- |
| public origin | HTTPS, HTTP/2, `*.trycloudflare.com` |
| `/healthz` | 200 |
| `/direct.mp4` HEAD | 200, `video/mp4`, `content-length: 48497`, `accept-ranges: none` |
| `/direct.mp4` GET | 200, 48 497 bytes, **hash equals the startup manifest digest** |
| `/generic` | one relative `<source src="/generic-media.mp4">` |
| `/generic-media.mp4` | 200, bytes exact, **14.22 s** — inside the 10–20 s window |
| `/byte-limit?vf_case=…` | media URL carries the same id verbatim |
| `/byte-limit-media.mp4` | 200, **no `content-length`**; `HTTP/1.1 Transfer-Encoding: chunked` on the fixture→cloudflared leg |
| `/byte-evidence?vf_case=…` | this case only: `mediaRequestCount: 1`, `contentLengthPresent: false`, `transferMode: "chunked"`, `bytesServed: 25 148 785` |
| `/byte-evidence` for another id | `404`, not a default |
| `/safe-egress` | one `<source src="http://10.255.255.1/videofetch-denied.mp4">` |

The byte-limit smoke GET was **deliberately aborted at ~24 MiB**. It provisions
the correlation plumbing and proves the absent `Content-Length`; it is **not**
evidence that the >500 MiB guard fires. That claim belongs to the live case.

### Production isolation, measured

Byte-identical before and after — same digest, size, mtime and mode:

```
/etc/cloudflared/config.yml              68d054f233df80c4755ad0d5d5548d6a033052978ec2c69d1b8224f29c26d8df
/etc/cloudflared/videofetch-worker.json  64ad132b8f428ab5a31cfedac86336f191da12199e28d4e7b932881fdb73554e
```

`vf-cloudflared` kept `MainPID=705`, `NRestarts=0` and the same
`ExecMainStartTimestamp` throughout — it was never restarted, and the named
tunnel ran untouched alongside the temporary one. All seven units held their
original states. No DNS record, Access policy, nftables rule or Vercel setting
was read-modified or written.

### Cleanup

The temporary tunnel and the fixture server were terminated, the disposable
workspace was removed, and the smoke case state went with the process. No
listener remains on 18099, the only `cloudflared` process is the original
production one (PID 705), and the temporary hostname returns **530**. The VM was
returned to **Stopped**, its initial power state.
