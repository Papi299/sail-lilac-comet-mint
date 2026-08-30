// Single TCP connect probe. Recovered from the prototype's /opt/vf-test/one.mjs.
//
// Run INSIDE the media container. Prints exactly one line so a caller can pair
// it with an nftables counter reading taken from outside the namespace.
//
// Usage:  node probe-one.mjs <host> <port> [timeoutMs]
import net from "node:net";

const host = process.argv[2];
const port = Number(process.argv[3]);
const timeoutMs = Number(process.argv[4] ?? 4000);

if (!host || !Number.isInteger(port)) {
  console.error("usage: node probe-one.mjs <host> <port> [timeoutMs]");
  process.exit(2);
}

const socket = new net.Socket();
socket.setTimeout(timeoutMs);

const done = (verdict) => {
  try {
    socket.destroy();
  } catch {
    /* already gone */
  }
  console.log(verdict);
  process.exit(0);
};

// "CONNECTED" is the only outcome that means the boundary let the packet
// through. Everything else is a denial, and the counter reading says which
// rule produced it.
socket.once("connect", () => done("*** CONNECTED ***"));
socket.once("timeout", () => done("DENIED(timeout)"));
socket.once("error", (error) => done(`DENIED(${error.code ?? error.message})`));
socket.connect({ host, port });
