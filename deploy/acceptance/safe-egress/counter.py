#!/usr/bin/env python3
"""Read one nftables rule counter by comment.

Recovered verbatim in behaviour from the prototype's /opt/vf-test/ctr.py.

Counter attribution is what makes a denial evidence rather than an anecdote: a
connection that fails while `deny-v4` increments was denied BY THE FIREWALL,
whereas a connection that fails while every counter stays flat was denied by
something else — most often a missing route.

Usage (from OUTSIDE the media namespace, as root):
  nsenter -t <pid> -n nft -j list chain inet videofetch_egress output \\
    | counter.py deny-v4
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: counter.py <rule-comment>", file=sys.stderr)
        return 2

    wanted = sys.argv[1]
    document = json.load(sys.stdin)

    for entry in document.get("nftables", []):
        rule = entry.get("rule")
        if not rule or rule.get("comment") != wanted:
            continue
        for expression in rule.get("expr", []):
            if "counter" in expression:
                print(expression["counter"]["packets"])
                return 0

    print(f"no counter found for rule comment {wanted!r}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
