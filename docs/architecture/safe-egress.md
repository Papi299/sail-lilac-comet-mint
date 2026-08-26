# Safe-Egress Architecture

## Threat Model

The worker executes `yt-dlp` against user-supplied URLs. Attackers may supply URLs designed to cause:
- DNS resolution to internal IP addresses.
- HTTP redirects to internal services.
- Extractor-specific subrequests (e.g., manifest parsing) pointing to private networks.
- DNS rebinding attacks during media fetching.
- FFmpeg child network traffic to internal destinations.

**Conclusion:** Application-level validation (e.g., parsing the initial URL) is insufficient because `yt-dlp` performs its own DNS lookups, follows redirects, and initiates numerous subrequests.

## The Safe-Egress Invariant

> A process running inside the media worker—including `yt-dlp`, `FFmpeg`, and descendants—cannot establish network connections to forbidden local, private, link-local, metadata, loopback, or otherwise non-public destinations even if application-level DNS/redirect validation is bypassed or becomes stale.

## Enforcement Ownership Model

The entity running yt-dlp/FFmpeg MUST NOT be able to alter or remove its own egress policy.

**Required Architecture:** The enforcement controller lives OUTSIDE the media container.
Examples of acceptable realizations:
- Host-level `nftables`/`iptables` applied to the worker's bridge/veth interface.
- Infrastructure/cloud egress firewall/security policy whose control plane is inaccessible to the worker.
In-container application-managed firewall rules are strictly INSUFFICIENT.

**Worker Privilege:**
- Non-root where practical.
- No `CAP_NET_ADMIN` or `CAP_SYS_ADMIN`.
- No host networking (`network_mode: host` forbidden).
- No Docker socket (`/var/run/docker.sock`).
- No privileged mode.

## Denied Destination Classes

The egress firewall MUST block all outbound connections to at least the following explicit ranges. The deployment policy must be at least as conservative as the existing Phase 1 application classification.

**IPv4:**
- `0.0.0.0/8` (Current network)
- `10.0.0.0/8` (RFC1918)
- `100.64.0.0/10` (Carrier-grade NAT)
- `127.0.0.0/8` (Loopback)
- `169.254.0.0/16` (Link-local / Cloud Metadata)
- `172.16.0.0/12` (RFC1918)
- `192.0.0.0/24` (IETF Protocol Assignments)
- `192.0.2.0/24` (TEST-NET-1)
- `192.168.0.0/16` (RFC1918)
- `198.18.0.0/15` (Benchmark testing)
- `198.51.100.0/24` (TEST-NET-2)
- `203.0.113.0/24` (TEST-NET-3)
- `224.0.0.0/4` (Multicast)
- `240.0.0.0/4` (Reserved)
- `255.255.255.255/32` (Broadcast)

**IPv6:**
- `::/128` (Unspecified)
- `::1/128` (Loopback)
- `fc00::/7` (Unique-local / ULA)
- `fe80::/10` (Link-local)
- `ff00::/8` (Multicast)
- IPv4-mapped/compatible addresses.
- `2002::/16` (6to4)
- `2001:0000::/32` (Teredo)
- `64:ff9b::/32` (NAT64 well-known prefix)

## DNS Policy

The firewall must not require broad private-network access for DNS.
**Recommendation:**
Allow outbound UDP/TCP 53 strictly to specifically designated public DNS resolvers.
If an internal resolver must be used, allow DNS traffic ONLY to that exact resolver address. No general private-range route is created.
A private DNS answer must still be useless because the destination firewall blocks the resulting connection.

## Allowed Outbound Protocols/Ports

To support ordinary `yt-dlp` media delivery:
- **TCP 80 (HTTP)** - Allowed to public destinations.
- **TCP 443 (HTTPS)** - Allowed to public destinations.
- **UDP/TCP 53 (DNS)** - Allowed only to designated resolvers.

## Object Storage Reachability

The object-storage endpoint MUST be a public HTTPS endpoint compatible with the TCP 443 public-egress policy. Do NOT create a broad private/VPC exception merely for storage.

## Acceptance Tests

Before `YTDLP_NETWORK_ISOLATED=true` can be enabled, deployment integration tests MUST pass *from inside the exact deployed worker network boundary*. A bare "connection refused" to an address with no listener is NOT strong proof. Use targets known to be listening or verify firewall-policy counters.

1. **Direct-address denial:** Prove loopback IPv4, RFC1918, metadata/link-local IPv4, CGNAT, `::1`, IPv6 ULA, and IPv6 link-local are unreachable.
2. **Redirect test:** Request a controlled PUBLIC HTTP endpoint that responds with a redirect to a controlled forbidden target. Prove the worker cannot establish the forbidden connection.
3. **DNS forbidden-answer test:** Request a controlled hostname where the designated test DNS returns a forbidden destination. Prove the connection fails at the network boundary.
4. **Rebinding test:** Hostname initially validates as public, but later resolves to a forbidden address. Prove the forbidden connection fails.
5. **Descendant test:** Run FFmpeg (or another controlled child process) attempting to reach a forbidden destination. Prove it is blocked.
6. **Firewall-mutation test:** Prove the worker process lacks privileges to alter the firewall/network policy.
7. **Controlled public success:** Prove a controlled public HTTPS endpoint succeeds.

## The Meaning of `YTDLP_NETWORK_ISOLATED`

The environment variable `YTDLP_NETWORK_ISOLATED=true`:
- Is configured **ONLY** in the worker deployment. Vercel does not use this value.
- Remains `false` (fail-closed) by default.
- Serves as the exact enablement gate allowing `yt-dlp` to execute.
- **Becomes `true` ONLY WHEN:**
  - The production worker deployment exists.
  - Externally controlled egress enforcement is active.
  - The worker lacks privileges to modify it.
  - Both IPv4 and IPv6 policies are installed.
  - The DNS policy is installed.
  - The entire acceptance suite (redirect, DNS, rebinding, direct-address, descendant) passes from within that EXACT deployed network boundary.

Docker alone is never sufficient. `assertSafeUrl()` alone is never sufficient.
