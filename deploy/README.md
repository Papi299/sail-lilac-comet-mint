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

1. **Create the users.**

   ```
   useradd --system --no-create-home --shell /usr/sbin/nologin videofetch-broker
   ```

   The Worker container joins the `videofetch-broker` **group** (via
   `--group-add`) so it may `connect(2)` to the socket. It is never added to
   the broker's user, and never gains read access to the broker's environment
   file.

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

Minted just in time, bounded twice — once by the Worker's derivation and again
by the broker, which does not trust the requested value.

| Operation | S3 action | Ceiling |
| :--- | :--- | :--- |
| `put()` | `PutObject` | 900s |
| `head()` | `HeadObject` | 120s |
| `delete()` | `DeleteObject` | 120s |

Floor 60s; absolute hard cap 900s. Where the remaining job lifetime is known it
shortens the credential further, so a credential never outlives the job it
serves. The floor is what lets maintenance mint a fresh `DeleteObject`-only
credential for an **already expired** job rather than relying on a stale upload
credential.

See `docs/architecture/worker-deployment-runbook.md` §5e for the full policy.

---

## Verifying the boundary after install

```
# The socket exists, is a socket, and is group-only.
stat -c '%F %a %U:%G' /run/videofetch-r2-broker/broker.sock
# expected: socket 660 videofetch-broker:videofetch-broker

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
