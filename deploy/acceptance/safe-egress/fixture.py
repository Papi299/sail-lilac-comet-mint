#!/usr/bin/env python3
"""Known-live HTTP fixture for safe-egress acceptance.

Recovered from the prototype's /opt/vf-test/vf-fixture.py.

WHY A LISTENER MATTERS. safe-egress.md is explicit that "a bare 'connection
refused' to an address with no listener is NOT strong proof". Binding a real
listener at a forbidden address turns "nothing answered" into "something was
listening and the boundary still refused", which is the claim acceptance needs.

Run on the VM HOST (outside the media namespace), never inside the container.

Usage:  fixture.py <bind-address> <port>
"""
import http.server
import socket
import socketserver
import sys

BODY = b"VF-FIXTURE-REACHED\n"


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - name fixed by http.server
        self.send_response(200)
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, *args):
        pass


class ServerV4(socketserver.TCPServer):
    allow_reuse_address = True


class ServerV6(socketserver.TCPServer):
    address_family = socket.AF_INET6
    allow_reuse_address = True


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: fixture.py <bind-address> <port>", file=sys.stderr)
        return 2

    host, port = sys.argv[1], int(sys.argv[2])
    server_class = ServerV6 if ":" in host else ServerV4
    server = server_class((host, port), Handler)
    print(f"fixture listening on {host}:{port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
