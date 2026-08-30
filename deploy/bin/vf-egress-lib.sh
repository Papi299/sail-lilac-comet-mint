# shellcheck shell=bash
# Shared safe-egress deployment helpers.
# (PHASE-8B-SAFE-EGRESS-PROTOTYPE-RECOVERY-001)
#
# Sourced by vf-egress-policy-install, vf-egress-policy-verify,
# vf-egress-watchdog and vf-egress-multicast-route-test. Installed to
# /usr/local/lib/videofetch/vf-egress-lib.sh.
#
# WHY THIS FILE EXISTS
#
# The installer records a fingerprint and the verifier recomputes it. If those
# two ever canonicalize differently — by one stripping a field the other keeps
# — verification fails permanently on a correct system, and the fix an operator
# reaches for is to stop verifying. Both sides therefore call exactly the same
# functions from exactly one file.
#
# This file defines functions only. It performs no action when sourced.

# ── Non-secret deployment configuration ────────────────────────────────────

VF_CONFIG_FILE="${VF_CONFIG_FILE:-/etc/videofetch/media-egress.env}"
VF_RUNDIR="${VF_RUNDIR:-/run/videofetch-egress}"
VF_POLICY_TEMPLATE="${VF_POLICY_TEMPLATE:-/etc/videofetch/videofetch-egress.nft.template}"
VF_POLICY_RENDERED="$VF_RUNDIR/policy.rendered.nft"
VF_POLICY_FINGERPRINT="$VF_RUNDIR/policy.expected.sha256"
VF_ROUTES_FINGERPRINT="$VF_RUNDIR/routes.expected.sha256"

# The namespace holder container. Overridable for testing only; the Worker unit
# hard-codes the same name in `--network container:`.
VF_NETNS_CONTAINER="${VF_NETNS_CONTAINER:-videofetch-media-netns}"

VF_NFT="${VF_NFT:-/usr/sbin/nft}"
VF_IP="${VF_IP:-/usr/sbin/ip}"
VF_DOCKER="${VF_DOCKER:-/usr/bin/docker}"

# The namespace-entry command. Absolute path in production; overridable so the
# deployment test suite can exercise these scripts against recorded fixtures
# without a container runtime, a namespace or root. Overriding it grants no
# authority: everything reachable through it is read-only inspection, and a
# host that cannot enter the namespace fails closed either way.
VF_NSENTER="${VF_NSENTER:-/usr/bin/nsenter}"

vf_die() {
  echo "${VF_PROG:-vf-egress}: FATAL: $*" >&2
  exit 1
}

# ── Configuration ──────────────────────────────────────────────────────────

# Reads ONE key out of the configuration file, with systemd's
# EnvironmentFile= semantics: `KEY=VALUE`, blank and `#`/`;` comment lines
# ignored, one optional layer of surrounding quotes stripped, last assignment
# wins.
#
# PARSED, NEVER SOURCED. `VIDEOFETCH_MEDIA_DNS_FLAGS=--dns 10.0.0.1` is a
# perfectly valid systemd assignment whose value is the whole string, but as
# shell it assigns `--dns` and then EXECUTES `10.0.0.1` as a command. Sourcing
# would therefore both misread the resolver declaration and turn a
# configuration file into an execution surface. The same file is read by
# systemd and by these scripts, so they must agree on what it means.
vf_config_read() {
  local key="$1" line value=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"     # strip leading whitespace
    case "$line" in
      ''|'#'*|';'*) continue ;;
      "$key="*) value="${line#"$key"=}" ;;
      *) continue ;;
    esac
  done < "$VF_CONFIG_FILE"

  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s\n' "$value"
}

# Loads the non-secret deployment configuration. The file contains a listening
# port and a resolver declaration. It holds no credential of any kind and is
# deliberately world-readable.
vf_config_load() {
  [ -r "$VF_CONFIG_FILE" ] || vf_die "configuration $VF_CONFIG_FILE is unreadable"
  VIDEOFETCH_WORKER_PORT="$(vf_config_read VIDEOFETCH_WORKER_PORT)"
  VIDEOFETCH_MEDIA_DNS_FLAGS="$(vf_config_read VIDEOFETCH_MEDIA_DNS_FLAGS)"
}

# Validates the Worker's loopback ingress port. Fail-closed: absent, empty,
# non-numeric or out of range is fatal, never a default.
vf_validate_port() {
  local port="${1-}"
  case "$port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

# Strict exact-address check. A PREFIX IS NOT AN ADDRESS: `10.0.0.0/8` and
# `10.0.0.1/32` are both rejected, because the DNS exception must name one
# host, never a range. Zone ids (`fe80::1%eth0`) are rejected too.
vf_is_exact_ip() {
  local a="${1-}"
  [ -n "$a" ] || return 1
  case "$a" in
    */*|*%*|*' '*) return 1 ;;
  esac

  case "$a" in
    *:*)
      # IPv6. Hex groups and colons only, at most one "::", at most 8 groups.
      case "$a" in
        *[!0-9A-Fa-f:]*) return 1 ;;
        *:::*) return 1 ;;
      esac
      local doubles
      doubles="$(printf '%s\n' "$a" | grep -o '::' | wc -l | tr -d ' ')"
      [ "$doubles" -le 1 ] || return 1
      local groups
      groups="$(printf '%s\n' "$a" | tr ':' '\n' | grep -c '[0-9A-Fa-f]')"
      [ "$groups" -ge 1 ] && [ "$groups" -le 8 ] || return 1
      # A group is at most 4 hex digits.
      printf '%s\n' "$a" | tr ':' '\n' | while IFS= read -r g; do
        [ "${#g}" -le 4 ] || exit 1
      done || return 1
      return 0
      ;;
    *)
      # IPv4: exactly four octets, 0-255, no leading zeros (which some
      # resolvers read as octal).
      local IFS=.
      # shellcheck disable=SC2086
      set -- $a
      [ "$#" -eq 4 ] || return 1
      local o
      for o in "$@"; do
        case "$o" in
          ''|*[!0-9]*) return 1 ;;
          0) ;;
          0*) return 1 ;;
        esac
        [ "$o" -le 255 ] || return 1
      done
      return 0
      ;;
  esac
}

# Extracts the designated resolver addresses from VIDEOFETCH_MEDIA_DNS_FLAGS.
#
# The variable is held in container-runtime flag form — `--dns A --dns B` —
# because it is a SINGLE DECLARATION consumed by two different things: the
# namespace holder's `docker run` (which needs the flags) and this firewall
# policy (which needs the addresses). Keeping one variable makes it impossible
# for the resolver the namespace queries and the resolver the firewall admits
# to disagree, which is the drift that turns a working deployment into either a
# silent DNS outage or an unintended open hole.
#
# Prints one address per line. Fails closed on any malformed token.
vf_dns_resolvers() {
  local flags="${VIDEOFETCH_MEDIA_DNS_FLAGS-}"
  [ -n "$flags" ] || {
    echo "no designated DNS resolver configured (VIDEOFETCH_MEDIA_DNS_FLAGS is empty)" >&2
    return 1
  }

  local expect_addr=0 count=0 token
  # shellcheck disable=SC2086
  for token in $flags; do
    if [ "$expect_addr" -eq 1 ]; then
      vf_is_exact_ip "$token" || {
        echo "designated DNS resolver '$token' is not an exact IP address" >&2
        return 1
      }
      printf '%s\n' "$token"
      count=$((count + 1))
      expect_addr=0
      continue
    fi
    case "$token" in
      --dns) expect_addr=1 ;;
      *)
        echo "unexpected token '$token' in VIDEOFETCH_MEDIA_DNS_FLAGS (expected '--dns <address>' pairs)" >&2
        return 1
        ;;
    esac
  done

  [ "$expect_addr" -eq 0 ] || {
    echo "VIDEOFETCH_MEDIA_DNS_FLAGS ends with '--dns' and no address" >&2
    return 1
  }
  [ "$count" -ge 1 ] || {
    echo "VIDEOFETCH_MEDIA_DNS_FLAGS declares no resolver" >&2
    return 1
  }
  return 0
}

# ── Namespace resolution ───────────────────────────────────────────────────

# Prints the holder container's PID, or fails. An absent namespace is always
# fatal: there is nothing to enforce a policy in, so nothing may run.
vf_netns_pid() {
  local pid
  pid="$("$VF_DOCKER" inspect -f '{{.State.Pid}}' "$VF_NETNS_CONTAINER" 2>/dev/null || true)"
  case "$pid" in
    ''|0|*[!0-9]*)
      echo "media namespace holder '$VF_NETNS_CONTAINER' is not running" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$pid"
}

# Runs a command inside the media NETWORK namespace as VM root. The holder
# itself holds no NET_ADMIN; the capability comes from the host root context
# that nsenter preserves, never from the namespace's occupants.
vf_in_ns() {
  local pid="$1"; shift
  "$VF_NSENTER" -t "$pid" -n "$@"
}

# ── Canonicalization ───────────────────────────────────────────────────────

# Canonical nftables ruleset: the live rules with per-rule packet/byte counters
# removed. Counters change on every packet and carry no policy meaning, so
# leaving them in would make the fingerprint change constantly. NOTHING ELSE is
# stripped — a changed address, port, verdict, comment, chain or set element
# all survive into the hash.
vf_canonical_ruleset() {
  local pid="$1"
  vf_in_ns "$pid" "$VF_NFT" list ruleset 2>/dev/null \
    | sed -E 's/counter packets [0-9]+ bytes [0-9]+/counter/g'
}

# Canonical route/rule state for the media namespace.
#
# Covers IPv4 routes, IPv6 routes and BOTH policy-routing rule tables, each
# under its own label so a route can never be mistaken for a rule.
#
# Normalization is deliberately minimal:
#   * `expires <n>sec` is dropped   — a router-advertised lifetime ticks down
#                                     every second and is not a policy fact.
#   * whitespace runs are collapsed — `ip` pads columns inconsistently.
#   * lines are sorted              — kernel enumeration order is not stable.
# Everything else, including every destination, gateway, device, metric,
# scope, table and preference, is security-relevant and is hashed.
vf_canonical_routes() {
  local pid="$1"
  {
    echo "### ipv4-route"
    vf_in_ns "$pid" "$VF_IP" -4 route show 2>/dev/null | sort
    echo "### ipv6-route"
    vf_in_ns "$pid" "$VF_IP" -6 route show 2>/dev/null | sort
    echo "### ipv4-rule"
    vf_in_ns "$pid" "$VF_IP" -4 rule show 2>/dev/null | sort
    echo "### ipv6-rule"
    vf_in_ns "$pid" "$VF_IP" -6 rule show 2>/dev/null | sort
  } | sed -E 's/ expires [0-9]+sec//g; s/[[:space:]]+/ /g; s/^ //; s/ $//' \
    | grep -v '^$'
}

vf_sha256() {
  sha256sum | awk '{print $1}'
}

# Packet count of the rule carrying an exact comment, e.g. `deny-v4`.
#
# Counter attribution is what separates "the firewall denied this" from "there
# was no route", which is the whole content of
# SAFE-EGRESS-MULTICAST-ATTRIBUTION-001.
#
# The comment is matched WITH its closing quote so `deny-v4` cannot also match
# `deny-v4-broadcast`.
vf_rule_counter() {
  local pid="$1" comment="$2"
  vf_in_ns "$pid" "$VF_NFT" list chain inet videofetch_egress output 2>/dev/null \
    | grep -F "comment \"$comment\"" \
    | sed -nE 's/.*counter packets ([0-9]+).*/\1/p' \
    | head -n 1
}

# `ip route show` prints a host route without its prefix length: a route added
# as `224.0.2.1/32` reads back as `224.0.2.1`. Both spellings name the same
# route, so comparisons must accept either.
vf_strip_host_prefix() {
  case "$1" in
    */32)  printf '%s' "${1%/32}" ;;
    */128) printf '%s' "${1%/128}" ;;
    *)     printf '%s' "$1" ;;
  esac
}

# ── Required deny classes ──────────────────────────────────────────────────
#
# Authoritative source: docs/architecture/safe-egress.md. The verifier asserts
# every one of these is present in the LIVE ruleset, independently of any
# stored fingerprint, so a policy that was never installed correctly is caught
# even on a first run.

VF_REQUIRED_V4="
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.0.0.0/24
192.0.2.0/24
192.168.0.0/16
198.18.0.0/15
198.51.100.0/24
203.0.113.0/24
224.0.0.0/4
240.0.0.0/4
"

# Each entry is "<class label>|<extended regex accepted for it>". A regex
# rather than a literal because nft re-prints addresses in its own canonical
# form, and more than one spelling of the same prefix is correct.
VF_REQUIRED_V6="
unspecified+loopback+ipv4-compatible|::/96
ipv4-mapped|::ffff:(0\.0\.0\.0|0:0)/96
nat64-well-known|64:ff9b::/32
teredo|2001::/32
6to4|2002::/16
unique-local|fc00::/7
link-local|fe80::/10
multicast|ff00::/8
"
