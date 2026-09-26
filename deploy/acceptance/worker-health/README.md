# Worker health acceptance — TLS `/v1/healthz`

`WORKER-EXTERNAL-LIVENESS-TLS-HEALTH-IMPLEMENTATION-001`

**Run against Production and accepted on 2026-09-26.**
- **The run.** `WORKER-EXTERNAL-LIVENESS-TLS-HEALTH-LIVE-ACCEPTANCE-001` ran
  this tool once, from `main` `394fe60c…`, through the real external path, and
  it passed: schema `worker-tls-healthz-02`, HTTP `200`.
- **Evidence.** SHA-256
  `5745ece713e824585d9d21c67214b4c140d7a58e91aa4251a4323a4f0ae03f35`, held by
  the operator — accepted operator-measured Production evidence, not CI.
- **What it closed.** That accepted measurement closed the runbook §10 item
  "`GET /v1/healthz` returns 200 through the TLS endpoint" (runbook §8, §10).
  The tool's existence alone never did.
- **Further runs.** Each is its own, separately authorized operator action.

## What it proves, and what it does not

| Measurement | Path | Proves |
| :--- | :--- | :--- |
| **This tool** | real external HTTPS endpoint → Access → tunnel → loopback ingress → Worker | the ingress delivers a healthy answer to the outside world |
| Liveness probe (`deploy/bin/vf-worker-liveness-probe`) | VM loopback → Worker | the application answers on the VM |

The two are not interchangeable. A healthy loopback probe says nothing about the
tunnel or Access, and a healthy TLS result says nothing about whether anything
is watching the Worker between manual checks.

## Contract

The tool makes **exactly one** outbound request and requires all of:

- the origin uses `https:` — `http:` is refused, not downgraded;
- the path is exactly `/v1/healthz`;
- ordinary certificate validation — there is no `--insecure`, and the tool
  refuses to run under `NODE_TLS_REJECT_UNAUTHORIZED=0`;
- the response is **not** a redirect — a 3xx is its own FAIL outcome, never
  followed (`redirect: "manual"`), because following it is how an Access login
  page or a zone redirect becomes a false PASS;
- HTTP `200`;
- a JSON object body whose `status` is exactly `"ok"`, read within **4096
  bytes**.

The body limit is enforced **while the body streams**. Each chunk is checked
before it is kept. The first chunk that would cross the limit is dropped, and
the stream is cancelled so no more bytes are read from the connection. The
result is `body-too-large`. At most 4096 bytes of body are ever held.
`Content-Length` is never trusted. A non-200 body is cancelled unread. The
request's single deadline also covers the body, so a stalled body is a
`transport-failed` result, never a truncated pass.

### The origin normalization contract

| Supplied | Requested |
| :--- | :--- |
| `https://host` | `https://host/v1/healthz` |
| `https://host/` | `https://host/v1/healthz` |
| `https://host/v1/healthz` | `https://host/v1/healthz` |
| anything else | **refused** — other paths, a query, a fragment, embedded credentials, any non-`https` scheme |

## Credentials — two domains, never conflated

| Domain | Headers | Used here? |
| :--- | :--- | :--- |
| Cloudflare Access Service Auth | `CF-Access-Client-Id` / `CF-Access-Client-Secret` | **When supplied.** The ingress may require it to reach the origin at all. |
| VideoFetch Worker HMAC | `x-videofetch-*` | **Never.** `/v1/healthz` is unauthenticated at the Worker application layer. |

The Access pair is read from the **environment**, under the same names the
control plane uses:

```
CLOUDFLARE_ACCESS_CLIENT_ID
CLOUDFLARE_ACCESS_CLIENT_SECRET
```

**Both or neither.** One without the other fails closed *before any request is
dialled*. There is deliberately **no command-line flag** for either value: argv
is world-readable through `/proc`, and the tool refuses
`--access-client-id`/`--access-client-secret` with that explanation rather than
ignoring them.

Never paste either value into a shell history, a file in the repository, an
evidence record, a log, a PR or this document.

## Running it — only when separately authorized

```
# In a shell whose history is not persisted, with the pair exported from the
# operator's own secret store. Never typed inline.
node deploy/acceptance/worker-health/tls-healthz-acceptance.mjs \
  --origin https://<worker-host> \
  --evidence ./tls-healthz-evidence-<UTC timestamp>.json
```

| Exit | Meaning |
| :--- | :--- |
| `0` | PASS |
| `1` | FAIL — including a refused target, an incomplete credential pair, a redirect, a TLS failure, an oversized body |
| `2` | usage error; the evidence path already exists or cannot be created (**nothing is requested**); or the record could not be written |

The Worker must be **running** for a PASS. The `videofetch` VM is on-demand:
starting it, and the Worker, for this measurement is part of the separately
authorized run, not something this tool does.

## Evidence

Schema **`worker-tls-healthz-02`**. The record is built from an **allowlist**,
so nothing can get in by being copied over from a response, a header bag or an
error object.

`-01` is retired and must not be used. It recorded `httpsUsed: true` and
`tlsVerification: "enabled"` on every run. That included runs refused before
any request, and the run refused precisely *because* verification was
disabled. No accepted evidence was ever produced under `-01`.

**Each fact is recorded only once the run reaches the stage that measures
it.** `null` means *not measured*: the run stopped earlier. It never stands in
for `false`.

| Stage | Fields |
| :--- | :--- |
| Always | `task`, `schemaVersion`, `startedAt`/`finishedAt` (UTC), `tlsOrigin: "<withheld>"`, `healthPath`, `accessCredentialPresence` (`both` / `neither` / `incomplete`: what was supplied), `workerHmacEmitted: false`, `outcome`, `verdict` |
| Target validation | `targetAccepted` (`null` if never evaluated), `suppliedScheme` (`https:`, `http:`, …, or `other`) |
| Request | `requestAttempted`, `httpsUsed` (`null` unless a request was attempted), `tlsVerification`, `accessHeaderNamesSent` (names only, and only once actually sent) |
| Response | `responseReceived`, `httpStatus`, `redirectObserved`, `bodyWithinLimit`, `healthyBodyMatched` |

The `tlsVerification` field takes three values:

| Value | Meaning |
| :--- | :--- |
| `enabled` | A request was attempted with ordinary certificate validation. |
| `disabled-refused` | `NODE_TLS_REJECT_UNAUTHORIZED=0` was present, so the run was refused and nothing was requested. |
| `not-attempted` | The run stopped before any request for another reason. |

| Situation | `requestAttempted` | `httpsUsed` | `tlsVerification` |
| :--- | :--- | :--- | :--- |
| PASS | `true` | `true` | `enabled` |
| transport or certificate failure | `true` | `true` | `enabled` |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | `false` | `null` | `disabled-refused` |
| `http://` target refused | `false` | `null` | `not-attempted` |
| incomplete Access pair | `false` | `null` | `not-attempted` |

**Never recorded:**

- the Worker hostname;
- the Access Client Id or Client Secret;
- any header **value**;
- cookies, signed URLs or response bodies;
- Worker HMAC keys, R2 credentials or Cloudflare identifiers;
- the observed health state when it is wrong;
- transport error messages, which can carry the hostname.

### The evidence file

`--evidence <path>` must name a path that **does not exist yet**:

- The file is created **before the request**, with `O_CREAT | O_EXCL`, then
  `fchmod` to exactly **`0600`** whatever the umask. The path is reserved for
  the whole run, and an unusable path stops the run before anything is dialled.
- An existing path is **refused and left untouched**, and the tool exits `2`
  without requesting anything. This covers a regular file, and a symlink whether
  or not its target exists. A symlink is never followed, so its target can never
  be overwritten.
- The record of a FAIL is written too. The same record is always printed to
  stdout as well.

## Validation

`scripts/worker-tls-healthz-acceptance.test.mjs` exercises every path above
with an injected fake transport. It reaches no network, resolves no hostname and
contacts no Cloudflare endpoint, and every credential in it is obviously fake.
