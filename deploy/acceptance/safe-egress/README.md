# Safe-egress acceptance harness

Recovered from the Lima prototype's `/opt/vf-test`, reviewed and sanitized.
**Test tooling only.** Nothing here runs during normal Worker startup, and no
systemd unit references any of it.

**Phase 9 has NOT been executed.** These files are the instrument, not the
measurement. Running them is not acceptance; acceptance is a Phase-9 activity
performed against the exact deployed boundary and recorded in
`docs/architecture/worker-deployment-runbook.md` §11.

---

## What was sanitized, and why

The prototype files worked, but they were written against one host at one
moment. Every value below was removed and turned into explicit configuration:

| Removed | Was | Now |
| :--- | :--- | :--- |
| Docker bridge address | `172.17.0.1` hard-coded as the resolver | `VF_DESIGNATED_RESOLVER` |
| Host link-local address | a literal `fe80::…` in a data file | `VF_FIXTURE_LINK_LOCAL` |
| Public resolver | `1.1.1.1` hard-coded upstream | `--upstream` |
| Third-party domains | three real redirector hosts | `VF_REDIRECT_URLS` |
| HMAC key pair | a literal key id and secret in source | `VF_CONTROL_KEY_ID` / `VF_CONTROL_SECRET` |
| Worker port | `8080` hard-coded | `VF_WORKER_PORT` |

No credential, account id, bucket name, hostname or link-local address is
committed. `sign.mjs` reads its credential from the environment and never
prints it — and cannot be given one by editing the file.

Addresses that ARE still written literally are the documentation and reserved
ranges from RFC 5737, RFC 3849 and friends (`192.0.2.0/24`, `198.51.100.0/24`,
`203.0.113.0/24`, `240.0.0.1`, `2001:db8::/32`). Those belong to nobody by
definition, they are the exact classes `safe-egress.md` requires to be denied,
and parameterizing them would only obscure what is being tested.

---

## Prerequisites

Explicit, because a probe that fails for the wrong reason is worse than no
probe:

- **Linux.** `nsenter`, `nft` and network namespaces are Linux-only.
- **Root on the VM host**, to read counters via `nsenter`. The probes
  themselves run unprivileged inside the container.
- **The boundary must verify first.** Run `vf-egress-policy-verify` before
  measuring. Probing a namespace whose policy is already in an unknown state
  produces numbers that mean nothing.
- **Python 3** for `testdns.py` / `fixture.py`, on the host only.

---

## Files

| File | Runs on | Purpose |
| :--- | :--- | :--- |
| `acceptance.mjs` | inside the container | The full probe matrix — direct address, DNS, rebinding, redirect, permitted public. |
| `probe-one.mjs` | inside the container | One connect probe, one line of output, for counter pairing. |
| `redirect.mjs` | inside the container | Public redirector → forbidden `Location`, followed. |
| `sign.mjs` | inside the container | HMAC-signed control-API request. |
| `counter.py` | host, as root | Reads one nftables rule counter by comment. |
| `testdns.py` | host | Controlled resolver returning forbidden answers and a rebinding answer. |
| `fixture.py` | host | A **live** listener at a forbidden address. |

---

## Counter attribution is the point

`safe-egress.md` is explicit that *"a bare 'connection refused' to an address
with no listener is NOT strong proof"*. Two things make a denial evidence:

1. **A live listener** at the forbidden destination (`fixture.py`), so
   "refused" cannot mean "nobody was home"; and
2. **A counter that moved** on the deny rule (`counter.py`), so "refused"
   cannot mean "no route".

```sh
# host, as root
PID=$(docker inspect -f '{{.State.Pid}}' videofetch-media-netns)
before=$(nsenter -t "$PID" -n nft -j list chain inet videofetch_egress output | ./counter.py deny-v4)
docker exec videofetch-worker node /tmp/videofetch/probe-one.mjs 10.0.0.1 80
after=$(nsenter -t "$PID" -n nft -j list chain inet videofetch_egress output | ./counter.py deny-v4)
echo "deny-v4 moved by $((after - before))"
```

A denial with a flat counter is **not** a pass. That is the entire content of
`SAFE-EGRESS-MULTICAST-ATTRIBUTION-001`: in the prototype run, multicast was
denied by the absence of a route rather than by the rule, so its counters never
moved and the result could not be attributed. Use
`deploy/bin/vf-egress-multicast-route-test` to make those destinations reach
the enforcement point.

---

## Getting the probes into the container

The Worker container is `--read-only` with a `noexec` tmpfs at
`/tmp/videofetch`, so a script copied there cannot be executed as a program —
but `node <file>` reads it, which is all these probes need.

```sh
docker cp probe-one.mjs videofetch-worker:/tmp/videofetch/probe-one.mjs
docker exec videofetch-worker node /tmp/videofetch/probe-one.mjs 10.0.0.1 80
```
