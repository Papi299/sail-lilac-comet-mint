# Worker Deployment Runbook (Phase 8B contract)

Provider-neutral deployment contract for the standalone VideoFetch Worker.

This document describes the invariants a Phase-8B deployment **must** satisfy.
It deliberately names **no** hosting provider, region, account id, bucket name,
hostname or credential. The host/provider decision belongs to Phase 8B and is
made by the Product Owner, because it determines persistent-volume semantics,
TLS termination, external egress enforcement, network-namespace ownership and
R2 placement/jurisdiction.

**Status: no accepted Phase-8B production deployment has been completed.**

An existing local Lima/Ubuntu **prototype** deployment is present and has
supplied measured safe-egress evidence, but it is **not** the reconciled
production deployment and **Phase 9 has not been executed**. The earlier
wording "no host exists" is no longer literally accurate and has been corrected
here: a host exists, it is a prototype, and its existence is not acceptance.

Precisely:

- No **production** bucket, credential, tunnel or DNS record exists.
- A local Lima VM (`videofetch`, Ubuntu 24.04 ARM64 on Apple silicon) runs the
  **older prototype units** — `vf-anchor`, `vf-policy`, `vf-worker`,
  `vf-watchdog` — and is the source of the measured evidence in §3 and §11.
- The reconciled deployment artefacts in `deploy/` have been **recovered into
  source and reviewed, but never installed**. The VM still runs the prototype,
  deliberately, so the two remain comparable.
- Recovering source is not deploying it, and deploying it would not be
  acceptance either. Acceptance is Phase 9, against the exact final topology.

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

- `YTDLP_NETWORK_ISOLATED` remains **`false`**, and the runtime still refuses to
  start if it parses truthy. §4 is unchanged.
- Formal Phase 9 must be **re-run against the exact final topology**, including
  the ingress path in §1a. A prototype passing does not transfer.
- Phase 10 remains the only phase authorized to enable yt-dlp.

Residual evidence items carried into Phase 9, tracked in §11:
`SAFE-EGRESS-NORDVPN-CONNECTED-RETEST-001`,
`SAFE-EGRESS-MULTICAST-ATTRIBUTION-001`,
`SAFE-EGRESS-ROUTE-VERIFIER-HARDENING-001`.

### 3a. The recovered safe-egress deployment layer

`PHASE-8B-SAFE-EGRESS-PROTOTYPE-RECOVERY-001` moved the prototype's enforcement
model out of a single VM's filesystem and into reviewed source under `deploy/`,
reconciled with the trusted-broker architecture in §5. **Source only: nothing
has been installed, and the VM still runs the older prototype units.**

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
| Phase-9 multicast helper | `deploy/bin/vf-egress-multicast-route-test` |
| Phase-9 probe harness | `deploy/acceptance/safe-egress/` |
| Static + behavioural tests | `src/worker/runtime/safe-egress-deployment-policy.test.ts` |

**Dependency order.** The Worker may run **only when both** boundaries are
present:

```
docker.service
  └─ videofetch-media-netns.service      owns the namespace, publishes 127.0.0.1 only
       └─ videofetch-egress-policy.service     installs + verifies, fingerprints to /run
            └─ videofetch-egress-watchdog.service  re-verifies continuously
                 └─ videofetch-worker.service
videofetch-r2-broker.service
  └─ videofetch-worker.service
```

The Worker declares `Requires=` + `After=` + `BindsTo=` on all four, so:

| Event | Consequence |
| :--- | :--- |
| Namespace absent | Worker cannot start |
| Policy install or verification fails | Worker cannot start |
| Watchdog unavailable, crashed or hung | Worker stops — it is never left unmonitored |
| Namespace disappears later | Worker stops |
| Broker disappears later | Worker stops |
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

**Phase 9 is NOT BEGUN and no multicast acceptance has been executed.** This
helper has never been run against the live VM.

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

**Status: IMPLEMENTED, PENDING IN-SITU VERIFICATION.** Source-level tests prove
the detection logic against recorded fixtures. They do not prove behaviour
against a real namespace on the real VM, and the gate stays open until Phase 9
measures it there.

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

`YTDLP_NETWORK_ISOLATED` **must be `false` (or unset) throughout Phases 8 and 9.**

This is enforced in code, not merely by convention: the Worker runtime
**refuses to start** if the variable parses truthy (`1`, `true`, `yes`, in any
case, with surrounding whitespace ignored). The lock exists so an operator typo
or environment drift cannot activate yt-dlp before the Phase-9 acceptance
evidence is approved.

The Worker image does not install yt-dlp or Python at all. Diagnostics reports
`ytdlp: false` honestly.

Phase 10 — and only Phase 10, after approved Phase-9 evidence — may relax this
startup lock and enable the flag.

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

No **production** R2 bucket, token, lifecycle rule or account change has been
made, and this remains an unprovisioned design. A disposable bucket and parent
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
- [ ] External egress deny policy applied and owned outside the container.
      *Source artefacts exist and are tested (§3a); none is installed. The Lima
      VM still runs the older prototype units.*
- [ ] TLS endpoint terminated in front of the Worker and reachable by Vercel.
- [x] **`R2-CREDENTIAL-SCOPE-DECISION-001` closed by the Product Owner —
      Option B (renewable, action-scoped temporary credentials).** See §5f.
      Implemented by `WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001`. No
      **production** credential has been created. A disposable parent
      credential did exist for live acceptance and has since been revoked
      (§5f); that was never production provisioning.
- [x] **`R2-BROKER-LIVE-MINT-VERIFICATION-001` closed — accepted.** The merged
      action-only temporary-credential path passed live-provider acceptance
      against a **disposable** bucket, which was torn down afterwards. See §11.
      **No production R2 resource was created**, so every R2 provisioning item
      below remains unchecked.
- [ ] Private R2 bucket created; lifecycle TTL backstop configured.
- [ ] Broker **parent** credential created — bucket-scoped, no bucket
      administration. Provider permissions are necessarily broader than the
      Put/Head/Delete surface; narrowing happens per operation at mint time via
      local signing. See §5b.
- [ ] Dedicated `videofetch-broker` system user created; parent credential
      installed at `/etc/videofetch/r2-broker.env`, root-owned, mode `0400`,
      **never** on the Worker and **never** in argv.
- [ ] `videofetch-r2-broker.service` installed and started **before** the
      Worker; socket present at `R2_BROKER_SOCKET_PATH`, mode `0660`.
- [ ] Worker unit declares `Requires=` + `After=` + `BindsTo=` on the broker
      unit; broker-stop confirmed to stop the Worker rather than degrade it.
- [ ] Broker socket directory bind-mounted **read-only** into the Worker
      container; Worker container added to the broker group.
- [ ] Confirmed the Worker container environment and argv contain no
      `R2_WRITER_*` and no `R2_BROKER_PARENT_*`. See `deploy/README.md`.
- [ ] Vercel signer credential created **separately** — bucket-scoped, no bucket
      administration. Provider permissions may be broader than signed GET; see §5b.
- [ ] `WORKER_CONTROL_*` generated and configured on both runtimes.
- [ ] `YTDLP_NETWORK_ISOLATED` confirmed false/unset.
- [ ] Termination grace period >= Worker shutdown grace.
- [ ] Named tunnel created against a stable hostname; no router port forwarding;
      Worker not bound to any LAN or public interface.
- [ ] Access application + **Service Auth** policy created; service token issued.
- [ ] `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET` set on
      **Vercel only** — both or neither — and never on the Worker.
- [x] **`CLOUDFLARE-ACCESS-ORIGIN-CREDENTIAL-STRIPPING-001` resolved and
      accepted.** Measured externally against the real Service Auth
      configuration. See §11.
- [ ] External liveness probe wired in the deployment layer, from **outside**
      the restricted media namespace. The image ships no `HEALTHCHECK`.
- [ ] `GET /v1/healthz` returns 200 through the TLS endpoint.
- [ ] Phase-9 safe-egress acceptance suite executed from inside the deployed boundary.

---

## 11. Tracked follow-ups

| Id | Status | Notes |
| :--- | :--- | :--- |
| `R2-CREDENTIAL-SCOPE-DECISION-001` | **RESOLVED / CLOSED — Option B** | The Product Owner selected Option B: renewable, action-scoped temporary credentials. Implemented by `WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001` — the media Worker holds no persistent R2 credential, a trusted host broker outside the media namespace retains the single-bucket parent writer credential, and each operation receives a credential scoped to one bucket, one exact `WorkerObjectKey` and one S3 action with a bounded TTL, expressed as an action-only JWT claim set (corrected by `R2-TEMP-CREDENTIAL-ACTIONS-ONLY-001`; see §5b). No **production** R2 bucket, token or lifecycle rule has been created — only disposable material for the live acceptance, which was torn down once that acceptance passed (§5f). |
| `R2-BROKER-PARENT-TOKEN-ROTATION-001` | OPEN — non-blocking, provisioning-time | The broker's parent token is still a persistent credential; only its custody changed. Rotating it is a broker-side `EnvironmentFile` update plus a `systemctl restart videofetch-r2-broker`, which `BindsTo=` will propagate as a brief Worker restart. Define the rotation cadence when the token is actually provisioned. No code change is expected. |
| `R2-BROKER-LIVE-MINT-VERIFICATION-001` | **CLOSED — accepted** | **Initial failure → correction → definitive acceptance → teardown.** *First attempt, FAILED:* real R2 was reached and rejected the then-merged `scope + actions` credential at token **parsing** — `HTTP 400 InvalidArgument` on `X-Amz-Security-Token`, before any authorization decision — so the production path failed closed rather than over-granting; diagnostic action-only credentials were accepted and showed the intended enforcement, and expiration went unmeasured. *Correction:* `R2-TEMP-CREDENTIAL-ACTIONS-ONLY-001` (PR #21) changed **production** credentials to action-only claims (see §5b). *Definitive rerun, PASSED:* run against this repository's merged production implementation — the merged `mintTemporaryCredential` signer, the merged `CloudflareR2ObjectStoreWriter` for Put/Head/Delete, repository-generated `WorkerObjectKey` values, all three temporary-credential fields on every delegated request, **no parent-credential fallback** (a raw AWS SDK client was used only for `GetObject`/`ListObjectsV2`, which the production writer deliberately omits). The **full matrix passed**: under its own credential, exact-key `PutObject`, `HeadObject` and `DeleteObject` each **succeeded**, while every **cross-action** attempt, every **sibling-object** attempt and **`ListObjectsV2`** were **denied by R2** — provider-side authorization denials, not local or network failures. Denied sibling writes and deletes left the sibling untouched, the sibling genuinely existed during the head and delete sibling tests (no missing-object ambiguity), the delete negatives ran while the exact object still existed, and no post-delete 404 was used as denial evidence. **Natural expiration was enforced** on real wall-clock time (§5b) — a 1-second production credential replayed at `exp + 30s` was denied and created nothing, the observed expired-credential response in this acceptance being `403 SignatureDoesNotMatch` rather than a dedicated expiry code; because that response is not expiry-specific, the result was isolated by before/after acceptance of equivalent 1-second credentials for both `HeadObject` and `PutObject`. *Cleanup:* all task-owned objects were removed with fresh exact-key `DeleteObject` credentials and a read-only parent check reported 0 objects at the job prefix, 0 at the `videofetch` prefix and 0 bucket-wide. *Teardown (operator-attested, not independently re-verified):* disposable parent token revoked, disposable bucket confirmed empty and deleted, local acceptance credential file removed (§5f). **This gate therefore no longer blocks production R2 traffic.** Closure means only that the merged temporary-credential model passed live-provider acceptance — it does **not** mean production R2 is provisioned (§5e/§10 remain unchecked), that `R2-BROKER-PARENT-TOKEN-ROTATION-001` is resolved, that Phase 9 or Phase 10 progressed, or that yt-dlp may be enabled. |
| `CLOUDFLARE-ACCESS-ORIGIN-CREDENTIAL-STRIPPING-001` | **CLOSED — accepted** | Empirically measured and accepted against the real Cloudflare Access Service Auth configuration; the gate is no longer blocking and is not reopened here. Scope note, unchanged: this is an acceptance of the measured INGRESS path, not a source-level property. This repository proves only that the Access service token is configured on Vercel alone and that the Worker application never consumes, verifies, persists or intentionally logs it — that part is still asserted by the control-plane boundary suite. Any change to the ingress topology invalidates the acceptance and requires a re-measurement. |
| `PHASE-8B-SAFE-EGRESS-PROTOTYPE-RECOVERY-001` | **Source recovery complete; NOT a deployment or an acceptance** | The prototype's enforcement model was recovered from the Lima VM into reviewed source under `deploy/` and reconciled with the trusted-broker architecture (§3a). The live VM was **not modified** — it still runs `vf-anchor`/`vf-policy`/`vf-worker`/`vf-watchdog`, deliberately, so prototype and reconciled source stay comparable. No secret was copied: the only credential-shaped material encountered was clearly-labelled `FAKE_PROTOTYPE_*` placeholders in the stale prototype Worker unit, which is intentionally not recovered. Installing these artefacts is a separate explicit task; acceptance is Phase 9. |
| `SAFE-EGRESS-NORDVPN-CONNECTED-RETEST-001` | OPEN — Phase-9 evidence | The prototype acceptance run was performed with the host VPN client loaded but **not connected**. Repeat the suite with it actively connected (including any DNS-interception or mesh features), since that changes host routing beneath the VM. Requires operator interaction. Not a code blocker. |
| `SAFE-EGRESS-MULTICAST-ATTRIBUTION-001` | **OPEN — Phase-9 evidence. Tooling added; not executed.** | IPv4 `224.0.0.0/4` and IPv6 `ff00::/8` were denied by absence of a route rather than by an exercised rule, so their counters never incremented. Every other range was counter-attributed. `deploy/bin/vf-egress-multicast-route-test` now installs a minimal temporary route so those destinations reach the enforcement point and the denial can be attributed to the rule's own counter. It is acceptance-only: no unit references it, it refuses to run without `--phase9-acceptance` and root, it refuses to run outside a namespace carrying the `inet videofetch_egress` table, and it never touches nftables. **Corrected in Correction 01:** the first implementation mutated routes and only then re-baselined the route fingerprint, while the watchdog was still subscribed to route events — a race whose outcome depended on scheduling. The helper now *quiesces* the boundary instead (stop Worker → stop watchdog → assert both stopped → mutate → measure → unwind → re-verify → restart), re-baselines nothing, and bounds the permitted route delta to exactly the intended multicast destinations. No bypass was added to the verifier or watchdog. See §3d. **The helper has NOT been run against the live VM**, by instruction. The gate closes only when Phase 9 executes it and records moving counters — a denial with a flat counter is still not evidence. |
| `SAFE-EGRESS-ROUTE-VERIFIER-HARDENING-001` | **IMPLEMENTED — PENDING IN-SITU VERIFICATION** (still open) | The prototype verifier fingerprinted the `nftables` ruleset but not the namespace **route table**. Non-blocking, as before: destination denial was proven to survive route injection, and a route cannot defeat a destination-address deny. Source hardening is now merged — see §3b — combining a baseline-free semantic invariant over policy-routing rules with a runtime route/rule fingerprint captured by the trusted install path and stored under `/run`. The watchdog additionally subscribes to route and link netlink events. **This is source-level implementation validated against recorded fixtures only.** It has never run against the real namespace on the real VM, so it is NOT Phase-9 acceptance and the gate is not closed. |
| `NPM-LOCKFILE-RECONCILIATION-001` | OPEN — non-blocking for Phase 8A | `package-lock.json` carries a pre-existing devDependency resolution (`nitro` → `unstorage` requires `lru-cache@^11`, the lock pins `5.1.1`) that npm 10 rejects and npm 11 accepts. The Worker image works around it with an exact-pinned ephemeral npm 11 running `ci`; no `npm install` is used and the lockfile is unmodified. Repository maintenance should reconcile it separately. |
