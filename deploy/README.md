# Deployment artifacts

Host-side units for the VideoFetch VM deployment.

**Nothing in this directory has been provisioned or deployed.** No R2 bucket,
token or account exists; no unit is installed; no secret is present. Every
value in `systemd/r2-broker.env.example` is intentionally empty.

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

## Install order

The order is not a convenience — it is the fail-closed boundary.

0. **Provide a Node >= 22.6 runtime for the broker** at
   `/opt/videofetch/node/bin/node`.

   The broker runs TypeScript directly through Node's native type stripping.
   Ubuntu 24.04 packages Node 18, which does **not** support
   `--experimental-strip-types`, so the unit deliberately does not use
   `/usr/bin/node`.

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

4. **Start the broker, then the Worker.** systemd enforces this:

   ```
   systemctl enable --now videofetch-r2-broker.service
   systemctl enable --now videofetch-worker.service
   ```

   The Worker's `ExecStartPre` runs `vf-r2-broker-gid-verify`, which refuses to
   start it unless the configured GID numerically equals the group owning the
   socket and the socket is group-connectable but not world-accessible. A
   drifted GID stops the Worker rather than starting it unable to mint.

---

## Fail-closed dependency

`videofetch-worker.service` declares all three of:

```
Requires=videofetch-r2-broker.service
After=videofetch-r2-broker.service
BindsTo=videofetch-r2-broker.service
```

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
