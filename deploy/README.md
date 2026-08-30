# Deployment artifacts

Host-side units for the VideoFetch VM deployment.

**Nothing in this directory has been installed.** No R2 bucket, token or
account exists; no unit is installed; no secret is present. Every value in
`systemd/r2-broker.env.example` and `systemd/media-egress.env.example` is
intentionally empty.

A local Lima/Ubuntu **prototype** VM does exist and supplied the measured
safe-egress evidence these artefacts were recovered from. It still runs the
**older prototype units**, untouched, so the two remain comparable. Recovering
this source is not deploying it, and deploying it would not be acceptance —
that is Phase 9. See `docs/architecture/worker-deployment-runbook.md` §3a.

The Worker may run **only when both** of two independent boundaries are present:

| Boundary | Governs | Artefacts |
| :--- | :--- | :--- |
| Trusted R2 broker | what the Worker may **write** | `videofetch-r2-broker.service`, `bin/vf-r2-broker-gid-*` |
| Safe egress | where the Worker may **connect** | `videofetch-media-netns.service`, `videofetch-egress-policy.service`, `videofetch-egress-watchdog.service`, `bin/vf-egress-*` |

They are independent: an `AF_UNIX` socket is not the network, so credential
acquisition neither depends on nor widens the egress policy.

---

## The trusted R2 credential broker

`WORKER-R2-TEMP-CREDENTIAL-DELEGATION-001` removes the persistent R2 credential
from the media container. The media Worker holds no parent secret and no
long-lived writer identity; it obtains a fresh credential per operation from a
broker that runs outside its namespace.

```
media container (no R2 credential)
  │
  │  AF_UNIX socket, bind-mounted read-only.
  │  Not the network: no egress is created or required.
  ▼
trusted broker (VM host, own user, own namespace)
  │  holds the ONLY persistent R2 parent credential
  ▼
short-lived credential: 1 bucket · 1 exact object key · 1 S3 action
```

| Component | Unit | Holds the parent credential? |
| :--- | :--- | :--- |
| Broker | `systemd/videofetch-r2-broker.service` | **Yes — exclusively.** |
| Worker | `systemd/videofetch-worker.service` | **No. Never.** |

---

## The safe-egress boundary

`PHASE-8B-SAFE-EGRESS-PROTOTYPE-RECOVERY-001` recovered the proven Lima
prototype's enforcement model into reviewed source.

```
cloudflared (VM)
  │  http://127.0.0.1:<WORKER_PORT>   loopback only, never a LAN interface
  ▼
videofetch-media-netns          owns the network namespace, publishes the port
  │                             holds NO NET_ADMIN and no credential
  │  VM root installs policy INTO the namespace with nsenter
  ▼
inet videofetch_egress          default-drop; public TCP 80/443; DNS to the
                                designated resolver(s) at their EXACT address
  ▲
  │  --network container:videofetch-media-netns
videofetch-worker               cannot read, weaken, mutate or bypass any of it
```

| File | Role |
| :--- | :--- |
| `media-netns/Dockerfile`, `media-netns/holder.c` | The namespace holder image. Two stages; the shipped stage is `FROM scratch` and contains one static binary. |
| `nftables/videofetch-egress.nft.template` | The policy. Deny classes verbatim from `docs/architecture/safe-egress.md`. |
| `systemd/media-egress.env.example` | Non-secret configuration: the loopback port and the designated resolver(s). |
| `bin/vf-egress-lib.sh` | Shared config parsing and canonicalization. |
| `bin/vf-egress-config-check` | Fail-closed configuration gate. |
| `bin/vf-egress-policy-install` | Renders, installs, fingerprints, verifies. |
| `bin/vf-egress-policy-verify` | Read-only verifier. Never repairs. |
| `bin/vf-egress-watchdog` | Continuous re-verification; stops the Worker on breach. |
| `bin/vf-egress-multicast-route-test` | **Phase-9 acceptance only.** Not in any unit. |
| `acceptance/safe-egress/` | **Phase-9 probe harness.** Not in any unit. |

### Why the namespace holder is not `sleep infinity` in a borrowed image

The prototype used `alpine:vf` — an image built by an unrecorded command that
existed on exactly one VM. It could not be rebuilt, audited or reproduced.

The replacement compiles `holder.c` into a static binary and ships it `FROM
scratch`. The base image is therefore a **build-time** dependency only: the
running image has no shell, no libc, no package manager and no `/etc`. A
compromised Worker sharing this namespace gains nothing by reaching the holder,
because there is nothing there to execute.

The committed builder default is **immutable on its own** — an exact patch tag
*and* the manifest-list digest it resolved to:

```
alpine:3.22.5@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce
```

The digest is the part that pins the build. A tag is mutable even when it looks
specific: Alpine republishes patch tags when a base package is rebuilt, and
`alpine:3.22` floats across every patch release. Neither can support a claim of
reproducibility, so the default does not rely on the operator remembering to
supply a digest override. Before committing this reference the digest was
resolved against the official `library/alpine` registry, confirmed to be the
SHA-256 of the returned index document, re-fetched *by digest* and compared
byte-for-byte, and confirmed to contain a `linux/arm64` (v8) entry. **It has
never been built or run on the Lima VM**, and no such claim is made.

```
docker build --platform linux/arm64 -t videofetch-media-netns:latest deploy/media-netns
```

`linux/arm64` because the target is a Lima VM on Apple silicon. Nothing in the
build is architecture-specific.

### The designated resolver is configuration, not a constant

The prototype hard-coded `172.17.0.1` into its firewall source — one host's
Docker bridge address at one moment. `VIDEOFETCH_MEDIA_DNS_FLAGS` in
`/etc/videofetch/media-egress.env` replaces it, and is the **single**
declaration feeding two consumers:

- `videofetch-media-netns.service` passes it to `docker run`, which is what
  puts the resolver in the namespace's `resolv.conf`. The Worker inherits that
  file and **cannot** override it — Docker rejects `--dns` alongside
  `--network container:`.
- `vf-egress-policy-install` renders the firewall's DNS exception from the same
  string.

Two separate settings would eventually drift, and the failure would be either a
DNS outage that looks like a network fault or a firewall hole for a resolver
nothing uses.

Every address must be **exact**. `--dns 172.17.0.0/16` is refused: `safe-egress.md`
permits an exception for one resolver address, never for a private network. A
resolver inside a denied class is fine and expected — it is admitted at that
exact address on port 53 only, and the surrounding class stays denied. Absent,
empty or malformed configuration stops the boundary rather than defaulting.

### Fingerprints live in /run, never in Git

`vf-egress-policy-install` records a canonical `nftables` fingerprint and a
canonical route/rule fingerprint under `/run/videofetch-egress/`. They describe
one running namespace, are regenerated by the trusted install path on every
start, and are **never committed** — a fingerprint in Git would be a stale
claim about a machine that no longer exists. `systemd` removes the directory
when `videofetch-egress-policy.service` stops, which is what makes the Worker's
pre-start verifier fail.

### What the verifier catches

Read-only. It inspects and reports; it never installs, reloads or repairs,
because after a repair nobody can say whether the boundary was ever intact.

- The namespace exists, and carries exactly **one** table — a second `nat`
  table's output hook runs before `filter` and could DNAT a forbidden
  destination into a permitted one.
- The output chain is default-drop.
- Every required IPv4 and IPv6 deny class is present, checked against the live
  ruleset without reference to any baseline, so a namespace that was never
  configured correctly fails on its first run.
- The set of `accept` rules is **exactly** the intended shape — this is what
  catches an added or broadened allow without needing the fingerprint.
- The whole-ruleset fingerprint matches, which additionally catches reordering.
- IPv4 routes, IPv6 routes and both policy-routing rule tables match, by
  semantic invariant and by fingerprint
  (`SAFE-EGRESS-ROUTE-VERIFIER-HARDENING-001`).

### The breach path

The prototype called `vf-policy-breach.target`, which was never defined, so the
call silently did nothing. No such target is reproduced. Instead:

1. the watchdog asks systemd to stop `videofetch-worker.service`, **and**
2. exits nonzero, and the Worker's `BindsTo=` on the watchdog stops it anyway.

(2) is what makes a watchdog **crash** safe — a watchdog that dies for any
reason takes the Worker with it, so the Worker is never left unmonitored. A
**hang** is covered too: the unit is `Type=notify` with `WatchdogSec`, so a main
loop that stops pinging systemd is killed, which lands back on (2). The
watchdog is `Restart=no` on purpose, and the Worker's pre-start verifier is the
latch that stops anyone restarting it into a still-broken boundary.

### The Phase-9 multicast acceptance lifecycle

`vf-egress-multicast-route-test` needs routes to exist for destinations the
policy denies, so the denial can be attributed to the rule's counter rather
than to a missing route. That means mutating the route table the watchdog is
watching.

**It quiesces the boundary; it does not negotiate with it.** There is no
acceptance mode, allowance or exemption anywhere in the verifier or the
watchdog — teaching the production boundary to tolerate an "expected" route
delta would put a bypass in the live path every second of every day for the
sake of a measurement taken once. Instead:

```
verify the boundary                       must already be intact
  ↓
stop videofetch-worker.service            explicitly, first
stop videofetch-egress-watchdog.service   nothing is watching now
  ↓  (assert BOTH are really stopped, or abort)
record the route table
add the minimal test route(s)             224.0.2.1/32 and ff0e::1/128
  ↓
assert the delta is EXACTLY those routes  anything else aborts
assert the nftables fingerprint is unchanged
  ↓
probe from a disposable container joined to the same namespace
read the deny-v4 / deny-v6 counters
  ↓  (EXIT trap from here on, and from well before here)
remove the test routes
assert the route table is byte-identical to before
verify the WHOLE boundary
  ↓  only now
start videofetch-egress-watchdog.service
start videofetch-worker.service
```

Two properties follow, and both matter more than they look:

- **No fingerprint is ever re-baselined.** The recorded route baseline keeps
  describing the *clean* namespace for the whole run, so the final check is a
  real comparison against the original recorded state rather than against
  something the acceptance script wrote moments earlier. The installer's
  narrow `--routes-baseline-only` mode was removed outright.
- **The Worker is not running during the window,** so it cannot be running
  unmonitored. The failure direction is an outage, never an unenforced
  boundary.

If anything goes wrong — an unexpected route, a changed ruleset, a failed
probe, a Ctrl-C — the trap still removes the test routes, but the Worker and
watchdog are **left stopped** and restarting them is a deliberate operator
action. Nothing is restarted into a boundary that did not verify.

The probe container is disposable and joined to the same network namespace with
`--cap-drop=ALL`, `--security-opt no-new-privileges`, `--read-only`, non-root
and no Docker socket, host network or volume. It can emit a packet and nothing
else.

> A denial with a **flat** counter still means "no route", not "policy". This
> tooling produces evidence for Phase 9; running it does not close the gate.

---

## Install order

The order is not a convenience — it is the fail-closed boundary.

0. **Provide the pinned broker toolchain** at
   `/opt/videofetch/node/bin/node`.

   | Component | Pinned value |
   | --------- | ------------ |
   | Node | `v22.23.2` |
   | npm | `11.19.1` (`packageManager` in `package.json`) |
   | Lockfile | committed `package-lock.json`, `lockfileVersion` 3 |
   | Production install | `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` |

   The broker runs TypeScript directly through Node's native type stripping.
   Ubuntu 24.04 packages Node 18, which does **not** support
   `--experimental-strip-types`, so the unit deliberately does not use
   `/usr/bin/node`.

   **npm must be installed explicitly — do not use the bundled npm.** Node
   v22.23.2 bundles npm 10.9.8, and npm 10 cannot install this repository:

   ```
   npm error `npm ci` can only install packages when your package.json and
   npm error package-lock.json are in sync.
   npm error Missing: lru-cache@11.5.2 from lock file
   ```

   `lru-cache@^11` is an **optional peer dependency** of `unstorage`, which is
   reached only through the dev-only `nitro`. npm 10 materialises that optional
   peer anyway and then rejects the committed lockfile for not listing the entry
   it invented; npm >= 11 leaves unrequested optional peers alone and accepts the
   lockfile unmodified. The lockfile is correct — npm 10 is not.

   Install the pinned npm over the bundled one, then verify both:

   ```
   /opt/videofetch/node/bin/npm install -g npm@11.19.1
   /opt/videofetch/node/bin/node -v   # must print v22.23.2
   /opt/videofetch/node/bin/npm -v    # must print 11.19.1
   ```

   Pin the exact patch version. `npm@11`, `npm@^11` and `npm@latest` all
   reintroduce the drift this step exists to remove.

1. **Create the group and user.**

   ```
   groupadd --system videofetch-broker
   useradd --system --no-create-home --shell /usr/sbin/nologin \
           -g videofetch-broker videofetch-broker
   ```

   The Worker container joins the `videofetch-broker` **group** so it may
   `connect(2)` to the socket. It is never added to the broker's user, and
   never gains read access to the broker's environment file.

1b. **Install the GID helpers and resolve the numeric GID.**

   ```
   install -m 0755 deploy/bin/vf-r2-broker-gid-write  /usr/local/sbin/
   install -m 0755 deploy/bin/vf-r2-broker-gid-verify /usr/local/sbin/
   vf-r2-broker-gid-write videofetch-broker /etc/videofetch/broker-gid.env
   ```

   **Why this exists.** `docker run --group-add <name>` resolves the NAME
   *inside the image*, and the Worker image defines no `videofetch-broker`
   group — a named `--group-add` therefore cannot work. The host allocates the
   GID when the group is created, so it must not be hard-coded to a guessed
   value either. It is resolved here and expanded into `ExecStart` by systemd.

   The generated file is world-readable on purpose: a group id is not a secret.
   Neither `/etc/passwd` nor `/etc/group` is mounted into the container.

2. **Install the parent credential — broker host only.**

   ```
   install -o root -g root -m 0400 r2-broker.env /etc/videofetch/r2-broker.env
   ```

   Root-owned, mode `0400`. It is supplied through `EnvironmentFile=`, never on
   a command line: argv is world-readable through `/proc`, so a secret in
   `ExecStart` would be readable by every local account on the VM.

3. **Install the Worker environment.** `/etc/videofetch/worker.env` carries the
   HMAC control pair and the object-store *location* only. It must contain no
   `R2_WRITER_*`, no `R2_BROKER_PARENT_*` and no `R2_SIGNER_*`. The Worker
   runtime refuses to start if any of them is present.

4. **Install the safe-egress layer.**

   ```
   # The namespace holder image, built from committed source.
   docker build --platform linux/arm64 \
     -t videofetch-media-netns:latest deploy/media-netns

   install -m 0755 -d /usr/local/lib/videofetch
   install -m 0644 deploy/bin/vf-egress-lib.sh /usr/local/lib/videofetch/
   install -m 0755 deploy/bin/vf-egress-config-check          /usr/local/sbin/
   install -m 0755 deploy/bin/vf-egress-policy-install         /usr/local/sbin/
   install -m 0755 deploy/bin/vf-egress-policy-verify          /usr/local/sbin/
   install -m 0755 deploy/bin/vf-egress-watchdog               /usr/local/sbin/
   # Phase-9 acceptance only; not required to run the Worker.
   install -m 0755 deploy/bin/vf-egress-multicast-route-test   /usr/local/sbin/

   install -m 0644 deploy/nftables/videofetch-egress.nft.template \
     /etc/videofetch/videofetch-egress.nft.template

   # Non-secret configuration. Both values MUST be filled in; empty is not a
   # default, and vf-egress-config-check refuses to start the boundary without
   # them.
   install -m 0644 deploy/systemd/media-egress.env.example \
     /etc/videofetch/media-egress.env
   ```

   `VIDEOFETCH_WORKER_PORT` must equal `WORKER_PORT` in the Worker's own
   environment file — the holder publishes the port, the Worker binds it, and
   nothing cross-checks the two.

5. **Start the boundary, the broker, then the Worker.** systemd enforces the
   order; starting the Worker pulls the rest in.

   ```
   systemctl enable --now videofetch-media-netns.service
   systemctl enable --now videofetch-egress-policy.service
   systemctl enable --now videofetch-egress-watchdog.service
   systemctl enable --now videofetch-r2-broker.service
   systemctl enable --now videofetch-worker.service
   ```

   The Worker's `ExecStartPre` runs `vf-r2-broker-gid-verify`, which refuses to
   start it unless the configured GID numerically equals the group owning the
   socket and the socket is group-connectable but not world-accessible. A
   drifted GID stops the Worker rather than starting it unable to mint.

---

## Fail-closed dependency

`videofetch-worker.service` declares all three of `Requires=`, `After=` and
`BindsTo=` on **each** of its four preconditions:

```
Requires=videofetch-r2-broker.service
After=videofetch-r2-broker.service
BindsTo=videofetch-r2-broker.service

Requires=videofetch-media-netns.service videofetch-egress-policy.service videofetch-egress-watchdog.service
After=videofetch-media-netns.service videofetch-egress-policy.service videofetch-egress-watchdog.service
BindsTo=videofetch-media-netns.service videofetch-egress-policy.service videofetch-egress-watchdog.service
```

plus two pre-start gates whose failure is fatal — `vf-r2-broker-gid-verify` and
`vf-egress-policy-verify`. Neither is prefixed with `-`, so neither can fail
quietly.

| Event | Consequence |
| :--- | :--- |
| Namespace absent | Worker cannot start |
| Policy install or verification fails | Worker cannot start |
| Watchdog unavailable, crashed or hung | Worker stops — never left unmonitored |
| Namespace disappears later | Worker stops |
| Broker disappears later | Worker stops |
| Boundary invalid after a breach | Worker cannot be restarted |

- `Requires` — the Worker will not start if the broker failed to start.
- `After` — the Worker starts strictly afterwards, so the socket already exists.
- `BindsTo` — if the broker later stops, fails or restarts, the Worker is
  stopped with it rather than continuing without a credential source.

The intended direction of failure is:

```
broker unavailable  ->  Worker R2 operation unavailable
```

and never:

```
broker unavailable  ->  fall back to a persistent Worker R2 credential
```

**There is no fallback to fall back to.** This is enforced in three
independent places, not by unit ordering alone:

1. `WorkerRuntimeConfig` has no credential fields — the type cannot carry one.
2. `loadWorkerRuntimeConfig` treats the presence of any `R2_WRITER_*` or
   `R2_BROKER_PARENT_*` variable as a **startup failure**, unconditionally and
   without consulting `NODE_ENV`.
3. `DelegatedR2ObjectStoreWriter` has no branch that performs an R2 operation
   without a freshly minted credential; a broker refusal propagates as
   `credential_unavailable`.

A recovery procedure that "temporarily re-adds the old secret" therefore fails
closed instead of silently working.

---

## Credential TTL

Two different rules, because Put/Head and Delete relate to job expiry in
opposite ways.

| Operation | S3 action | Ceiling | Rule |
| :--- | :--- | :--- | :--- |
| `put()` | `PutObject` | 900s | **Deadline-bound** |
| `head()` | `HeadObject` | 120s | **Deadline-bound** |
| `delete()` | `DeleteObject` | 120s | **Cleanup**, floor 60s |

**Deadline-bound**: TTL is `min(remaining lifetime, ceiling)`, so a credential
never outlives its job — a job with 30 seconds left yields a 30-second
credential. An **already expired** job yields no Put/Head credential at all; the
operation fails closed and the broker is never contacted.

**Cleanup**: `DeleteObject` keeps a 60-second floor so maintenance can still
delete an object whose job expired days ago, with delete authority only.

Enforcement is split: the **broker** independently enforces
`1 <= ttl <= ceiling(action)` (refused, never clamped); the **Worker** enforces
deadline-boundness, because only it knows the job deadline.

See `docs/architecture/worker-deployment-runbook.md` §5d for the full policy.

---

## Verifying the boundary after install

```
# The socket exists, is a socket, and is group-only.
stat -c '%F %a %U:%G' /run/videofetch-r2-broker/broker.sock
# expected: socket 660 videofetch-broker:videofetch-broker

# The Worker's supplementary GID numerically matches the socket's group.
stat -c %g /run/videofetch-r2-broker/broker.sock
docker exec videofetch-worker id                # 'groups=' must include that GID

# The Worker container cannot read the parent credential.
docker exec videofetch-worker env | grep -c R2_BROKER_PARENT   # expected: 0
docker exec videofetch-worker env | grep -c R2_WRITER          # expected: 0

# The Worker's argv carries no credential.
docker exec videofetch-worker cat /proc/1/cmdline | tr '\0' ' '

# Stopping the broker stops the Worker, rather than degrading it.
systemctl stop videofetch-r2-broker.service
systemctl is-active videofetch-worker.service                  # expected: inactive
```

Do **not** "fix" a Worker that cannot reach the broker by reintroducing a
persistent R2 credential. That is the failure mode this design exists to
remove.

### Safe egress

```
# The boundary verifies, right now, in the live namespace.
vf-egress-policy-verify

# The Worker's ingress is on VM loopback and nowhere else.
ss -ltnp | grep ":$VIDEOFETCH_WORKER_PORT"      # expect 127.0.0.1, never 0.0.0.0

# The namespace holder is unprivileged and owns no credential.
docker inspect videofetch-media-netns --format '{{.HostConfig.Privileged}}'   # false
docker inspect videofetch-media-netns --format '{{.Config.Env}}'
docker inspect videofetch-media-netns --format '{{.HostConfig.CapAdd}}'       # []

# The Worker cannot alter the policy that contains it.
docker exec videofetch-worker sh -c 'command -v nft iptables; echo rc=$?'     # not found

# Stopping the boundary stops the Worker, rather than degrading it.
systemctl stop videofetch-egress-watchdog.service
systemctl is-active videofetch-worker.service                                 # expect inactive
```

Do **not** "fix" a Worker that will not start by disabling the verifier,
loosening a deny class or adding a private-range DNS exception. A Worker that
cannot start is the boundary working.

---

## Deliberately NOT recovered

These exist on the prototype VM and are **out of scope** for the safe-egress
boundary. Each belongs to its own bounded task:

`cf-api` · `vf-observer.py` · the real `cloudflared` configuration and tunnel
credentials · a `cloudflared` service migration · the Lima YAML · macOS launch
or start wrappers · VM resource sizing · VPN tooling.

The prototype's `vf-worker.service` is **intentionally obsolete** and is not
recovered: it predates credential delegation, mounts
`/var/lib/videofetch-proto`, and passes `R2_WRITER_*` placeholders and
`R2_BUCKET=videofetch-proto-fake` directly to the container. The current
`videofetch-worker.service` — broker-mediated, holding no R2 credential — is
authoritative, and the safe-egress dependency was added *to it*.
