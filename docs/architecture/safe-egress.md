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

This enforcement must be **EXTERNAL** to `yt-dlp` itself. It operates at the network layer.

## Recommended Linux Isolation Model

To guarantee the invariant, the worker must run in an environment with the following properties:
- **Network Namespace:** Dedicated Linux network namespace or container network (e.g., bridge network without route to host).
- **No Host Networking:** `network_mode: host` is strictly forbidden.
- **Worker Privilege:** Runs as a non-root user. The media processes lack `CAP_NET_ADMIN` and cannot alter firewall rules.
- **Docker Socket:** No access to `/var/run/docker.sock`.
- **Enforcement Layer:** Egress firewall (e.g., `nftables`, `iptables`) or cloud-provider network policy applied to the worker's network interface.
- **Dual Stack:** Filtering must cover BOTH IPv4 and IPv6 independently.

## Denied Destination Classes

The egress firewall MUST block all outbound connections to the following:

**IPv4:**
- Loopback (`127.0.0.0/8`)
- RFC1918 Private Space (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
- Link-local (`169.254.0.0/16`) - Crucial for blocking cloud metadata APIs.
- Carrier-grade NAT (`100.64.0.0/10`)
- Unspecified / Reserved multicasts.

**IPv6:**
- Loopback (`::1/128`)
- Unspecified (`::/128`)
- Unique-local (`fc00::/7`)
- Link-local (`fe80::/10`)
- IPv4-mapped/embedded addresses targeting the denied IPv4 ranges.

## DNS Policy

The firewall must not require broad private-network access for DNS.
**Recommendation:** 
Allow outbound UDP/TCP 53 strictly to designated public DNS resolvers (e.g., `1.1.1.1`, `8.8.8.8`).
If an internal VPC resolver must be used, allow port 53 ONLY to that specific internal IP address, while all other ports to that IP (and the rest of the private range) remain blocked.

DNS rebinding attacks are mitigated because even if DNS resolves to `127.0.0.1`, the egress firewall will drop the subsequent TCP connection.

## Allowed Outbound Protocols/Ports

To support ordinary `yt-dlp` media delivery while minimizing risk:
- **TCP 80 (HTTP)** - Allowed to public destinations.
- **TCP 443 (HTTPS)** - Allowed to public destinations.
- **UDP/TCP 53 (DNS)** - Allowed only to designated resolvers.

Arbitrary public TCP ports (e.g., 22, 25, 3306) should be blocked. We do not use a domain allowlist; unknown public websites must remain generically attemptable for the downloader to function.

## Object Storage Reachability

The worker must upload completed media to Object Storage.
- The object-storage endpoint must be a public HTTPS endpoint compatible with the TCP 443 public-egress policy.
- Do NOT broadly permit a private network range to reach a private storage endpoint, as this creates a path for SSRF.
- If a VPC endpoint must be used, document a hyper-narrow IP/port exception in the firewall that strictly matches the storage provider's IPs and nothing else.

## Acceptance Tests

Before `YTDLP_NETWORK_ISOLATED=true` can be enabled in production, the deployment pipeline must run integration tests *from inside* the actual production worker container.

**Must fail to connect (Timeout/Connection Refused):**
- `curl -I http://127.0.0.1`
- `curl -I http://169.254.169.254` (Cloud Metadata)
- `curl -I http://10.0.0.1`
- `curl -I http://[::1]`
- `curl -I http://[fe80::1]`

**Must succeed:**
- `curl -I https://github.com` (or controlled public HTTPS endpoint)

Additionally, it must be verified that a subprocess (like FFmpeg) inherits these identical restrictions, and that the worker user cannot run `iptables -F`.

## The Meaning of `YTDLP_NETWORK_ISOLATED`

The environment variable `YTDLP_NETWORK_ISOLATED=true`:
- Is configured **ONLY** in the worker deployment.
- Vercel does not know about or configure this flag.
- Must **NEVER** be set simply because the worker is in Docker, on another host, or because application-level URL validation is running.
- Is an operator's attestation that the externally enforced egress boundary (firewall) is actively installed and the acceptance tests have passed.
- Serves as the exact enablement gate allowing `yt-dlp` to execute. Without it, the worker fails closed.
