#!/usr/bin/env python3
"""Controlled DNS resolver for safe-egress acceptance. TEST ONLY.

Recovered from the prototype's /opt/vf-test/vf-testdns.py.

Serves three attack fixtures and forwards everything else upstream, so the
media namespace keeps working name resolution while the acceptance suite
exercises the DNS cases from safe-egress.md:

  <forbidden-v4 name>  -> A <private address>    (private answer)
  <forbidden-lo name>  -> A <loopback address>   (loopback answer)
  <rebind name>        -> A <public> on the FIRST query, A <forbidden>
                          afterwards, TTL 0      (DNS rebinding)

NOTHING IS HARD-CODED. The prototype bound to a fixed bridge address and
forwarded to a fixed public resolver; both were properties of one host at one
moment. Every address and name here is supplied by the operator, so this file
carries no host-specific value and no real domain.

Run on the VM HOST, bound to the address the media namespace has been given as
its designated resolver. It is a test resolver: never point production at it.

Usage:
  testdns.py --bind <address> --upstream <address>
             --forbidden-v4-name <name> --forbidden-v4-answer <address>
             --forbidden-lo-name <name> --forbidden-lo-answer <address>
             --rebind-name <name> --rebind-first <address>
             --rebind-then <address>
"""
import argparse
import socket
import struct
import sys
import threading

LOCK = threading.Lock()
REBIND_SEEN = {"n": 0}


def parse_qname(data: bytes, offset: int):
    parts = []
    while True:
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:  # compression pointer
            offset += 2
            break
        parts.append(data[offset + 1 : offset + 1 + length])
        offset += 1 + length
    return b".".join(parts) + b".", offset


def build_answer(query: bytes, qname_end: int, ip: str, ttl: int = 60) -> bytes:
    transaction_id = query[:2]
    flags = struct.pack("!H", 0x8180)  # response, recursion available
    counts = struct.pack("!HHHH", 1, 1, 0, 0)
    question = query[12 : qname_end + 4]
    record = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, ttl, 4) + socket.inet_aton(ip)
    return transaction_id + flags + counts + question + record


def resolve(data: bytes, cfg) -> bytes | None:
    try:
        qname, offset = parse_qname(data, 12)
        qtype = struct.unpack("!H", data[offset : offset + 2])[0]
    except Exception:
        return None

    name = qname.lower()

    if qtype == 1:  # A
        if name in cfg.static:
            answer = cfg.static[name]
            print(f"[testdns] {name.decode()} -> {answer} (static forbidden)", flush=True)
            return build_answer(data, offset, answer)

        if cfg.rebind_name and name == cfg.rebind_name:
            with LOCK:
                REBIND_SEEN["n"] += 1
                nth = REBIND_SEEN["n"]
            answer = cfg.rebind_first if nth == 1 else cfg.rebind_then
            print(f"[testdns] rebind query #{nth} -> {answer} (ttl 0)", flush=True)
            return build_answer(data, offset, answer, ttl=0)

    try:
        upstream = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        upstream.settimeout(4)
        upstream.sendto(data, (cfg.upstream, 53))
        reply, _ = upstream.recvfrom(4096)
        upstream.close()
        return reply
    except Exception:
        return None


def serve_udp(cfg) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((cfg.bind, 53))
    print(f"[testdns] UDP listening on {cfg.bind}:53", flush=True)
    while True:
        try:
            data, addr = sock.recvfrom(4096)
            reply = resolve(data, cfg)
            if reply:
                sock.sendto(reply, addr)
        except Exception as error:  # keep serving
            print(f"[testdns] udp error: {error}", flush=True)


def serve_tcp(cfg) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((cfg.bind, 53))
    sock.listen(16)
    print(f"[testdns] TCP listening on {cfg.bind}:53", flush=True)
    while True:
        try:
            conn, _ = sock.accept()
            length = struct.unpack("!H", conn.recv(2))[0]
            reply = resolve(conn.recv(length), cfg)
            if reply:
                conn.sendall(struct.pack("!H", len(reply)) + reply)
            conn.close()
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", required=True, help="address to listen on (the designated resolver address)")
    parser.add_argument("--upstream", required=True, help="upstream resolver for everything not faked")
    parser.add_argument("--forbidden-v4-name", required=True)
    parser.add_argument("--forbidden-v4-answer", required=True)
    parser.add_argument("--forbidden-lo-name", required=True)
    parser.add_argument("--forbidden-lo-answer", required=True)
    parser.add_argument("--rebind-name", required=True)
    parser.add_argument("--rebind-first", required=True, help="public answer returned to the FIRST query")
    parser.add_argument("--rebind-then", required=True, help="forbidden answer returned afterwards")
    cfg = parser.parse_args()

    def fqdn(name: str) -> bytes:
        return (name if name.endswith(".") else name + ".").lower().encode()

    cfg.static = {
        fqdn(cfg.forbidden_v4_name): cfg.forbidden_v4_answer,
        fqdn(cfg.forbidden_lo_name): cfg.forbidden_lo_answer,
    }
    cfg.rebind_name = fqdn(cfg.rebind_name)

    print("[testdns] TEST RESOLVER - returns deliberately forbidden answers.", flush=True)
    threading.Thread(target=serve_tcp, args=(cfg,), daemon=True).start()
    serve_udp(cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
