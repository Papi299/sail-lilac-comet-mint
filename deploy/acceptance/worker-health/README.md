# Worker health acceptance — TLS `/v1/healthz`

`WORKER-EXTERNAL-LIVENESS-TLS-HEALTH-IMPLEMENTATION-001`

**Source tooling only. Nothing here has been run against Production.** This
directory holds the tool for a *later, separately authorized* operator run. Its
existence does not close the runbook §10 item "`GET /v1/healthz` returns 200
through the TLS endpoint"; only an accepted live measurement does.

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
- a JSON object body whose `status` is exactly `"ok"`.

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
  --evidence ./tls-healthz-evidence.json
```

| Exit | Meaning |
| :--- | :--- |
| `0` | PASS |
| `1` | FAIL — including a refused target, an incomplete credential pair, a redirect, a TLS failure |
| `2` | usage error, or the evidence file could not be written |

The Worker must be **running** for a PASS. The `videofetch` VM is on-demand:
starting it, and the Worker, for this measurement is part of the separately
authorized run, not something this tool does.

## Evidence

Schema `worker-tls-healthz-01`. Built from an **allowlist**, so nothing can
arrive by being spread in from a response, a header bag or an error object.

| Recorded | Never recorded |
| :--- | :--- |
| task, schema version, UTC start/finish | the Worker hostname — recorded as `"<withheld>"` |
| `httpsUsed`, `tlsVerification` | the Access Client Id or Client Secret |
| `requestedPath` (`/v1/healthz`) | any header **value** |
| `accessCredentialPairSupplied` (yes/no) | cookies, signed URLs, response bodies |
| Access header **names** only | Worker HMAC keys, R2 credentials, Cloudflare identifiers |
| `httpStatus`, `redirectObserved`, `healthyBodyMatched` | the observed health state when it is wrong |
| `workerHmacEmitted: false`, outcome, `PASS`/`FAIL` | transport error messages (they can carry the hostname) |

The evidence file is written mode `0600`.

## Validation

`scripts/worker-tls-healthz-acceptance.test.mjs` exercises every path above
with an injected fake transport. It reaches no network, resolves no hostname and
contacts no Cloudflare endpoint, and every credential in it is obviously fake.
