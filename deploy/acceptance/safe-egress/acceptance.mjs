// Safe-egress acceptance probe suite. TEST ONLY.
//
// Recovered from the prototype's /opt/vf-test/acceptance.mjs and fully
// parameterized: the original hard-coded one host's Docker bridge address, its
// link-local address, a fixed public resolver and several real third-party
// domains. None of those are properties of this architecture, so none are
// committed here.
//
// Run INSIDE the media container. Every destination comes from the
// environment, so the same file works on any host:
//
//   VF_DESIGNATED_RESOLVER   the resolver the egress policy admits (required)
//   VF_NON_DESIGNATED_RESOLVER a resolver it must NOT admit         (required)
//   VF_WORKER_PORT           the Worker's own port                 (required)
//   VF_PUBLIC_TEST_IP        a reachable public address            (required)
//   VF_FIXTURE_V4            host:port of a LIVE forbidden IPv4 fixture
//   VF_FIXTURE_V6           "[addr]:port" of a LIVE forbidden IPv6 fixture
//   VF_FIXTURE_LINK_LOCAL    optional link-local address, no zone
//   VF_LINK_LOCAL_ZONE       interface for the above (default eth0)
//   VF_DNS_FORBIDDEN_V4_NAME / VF_DNS_FORBIDDEN_LO_NAME / VF_DNS_REBIND_NAME
//                            names served by testdns.py
//   VF_PUBLIC_HTTPS_HOST     a host for the permitted-HTTPS case
//
// This suite REPORTS; it does not assert. Phase 9 acceptance requires reading
// the nftables counters alongside it (see counter.py) — a denial with a flat
// counter means "no route", not "policy", and is not evidence.
import net from "node:net";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required environment variable ${name}`);
    console.error("this suite hard-codes no address, resolver or domain by design");
    process.exit(2);
  }
  return value;
};

const RESOLVER = required("VF_DESIGNATED_RESOLVER");
const NON_DESIGNATED = required("VF_NON_DESIGNATED_RESOLVER");
const WORKER_PORT = Number(required("VF_WORKER_PORT"));
const PUBLIC_IP = required("VF_PUBLIC_TEST_IP");
const PUBLIC_HTTPS_HOST = required("VF_PUBLIC_HTTPS_HOST");

const optional = (name, fallback = null) => process.env[name] ?? fallback;
const LINK_LOCAL = optional("VF_FIXTURE_LINK_LOCAL");
const LINK_LOCAL_ZONE = optional("VF_LINK_LOCAL_ZONE", "eth0");

const splitHostPort = (value, label) => {
  if (!value) return null;
  const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(value);
  if (!match) {
    console.error(`${label} must look like host:port or [v6addr]:port`);
    process.exit(2);
  }
  return { host: match[1], port: Number(match[2]) };
};

const FIXTURE_V4 = splitHostPort(optional("VF_FIXTURE_V4"), "VF_FIXTURE_V4");
const FIXTURE_V6 = splitHostPort(optional("VF_FIXTURE_V6"), "VF_FIXTURE_V6");

const pad = (text) => String(text).padEnd(50);

function probe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (verdict) => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(verdict);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done("*** CONNECTED ***"));
    socket.once("timeout", () => done("DENIED(timeout)"));
    socket.once("error", (error) => done(`DENIED(${error.code ?? error.message})`));
    try {
      socket.connect({ host, port });
    } catch (error) {
      done(`DENIED(${error.code ?? error.message})`);
    }
  });
}

const line = async (label, host, port) => console.log(`${pad(label)} -> ${await probe(host, port)}`);

console.log("### 1-2  LOOPBACK");
await line(`1  IPv4 loopback 127.0.0.1:${WORKER_PORT} [Worker itself, LIVE]`, "127.0.0.1", WORKER_PORT);
if (FIXTURE_V6) await line(`2  IPv6 loopback [::1]:${FIXTURE_V6.port}`, "::1", FIXTURE_V6.port);

console.log("\n### 3-7  PRIVATE / RESERVED");
if (FIXTURE_V4) {
  await line(`3  RFC1918 ${FIXTURE_V4.host}:${FIXTURE_V4.port} [LIVE fixture]`, FIXTURE_V4.host, FIXTURE_V4.port);
  await line(
    `7c IPv4-mapped [::ffff:${FIXTURE_V4.host}]:${FIXTURE_V4.port} [LIVE]`,
    `::ffff:${FIXTURE_V4.host}`,
    FIXTURE_V4.port,
  );
}
// Documentation/reserved ranges only. These are safe to name in source because
// they belong to nobody by definition (RFC 5737 / RFC 3849).
await line("3b RFC1918 10.0.0.1:80", "10.0.0.1", 80);
await line("3c RFC1918 192.168.0.1:80", "192.168.0.1", 80);
await line("4  CGNAT 100.64.0.1:80", "100.64.0.1", 80);
await line("5  metadata/link-local 169.254.169.254:80", "169.254.169.254", 80);
await line("5b TEST-NET-2 198.51.100.1:80", "198.51.100.1", 80);
await line("5c TEST-NET-3 203.0.113.1:80", "203.0.113.1", 80);
await line("5d benchmark 198.18.0.1:80", "198.18.0.1", 80);
await line("5e multicast 224.0.0.1:80", "224.0.0.1", 80);
await line("5f reserved 240.0.0.1:80", "240.0.0.1", 80);
if (FIXTURE_V6) await line(`6  IPv6 ULA [${FIXTURE_V6.host}]:${FIXTURE_V6.port} [LIVE fixture]`, FIXTURE_V6.host, FIXTURE_V6.port);
if (LINK_LOCAL) await line(`7  IPv6 link-local [${LINK_LOCAL}%${LINK_LOCAL_ZONE}]`, `${LINK_LOCAL}%${LINK_LOCAL_ZONE}`, 80);
await line(`7b IPv4-mapped [::ffff:127.0.0.1]:${WORKER_PORT}`, "::ffff:127.0.0.1", WORKER_PORT);
await line("7d 6to4 [2002:101:101::1]:80", "2002:101:101::1", 80);
await line("7e Teredo [2001:0:1::1]:80", "2001:0:1::1", 80);
await line("7f NAT64 [64:ff9b::7f00:1]:80", "64:ff9b::7f00:1", 80);
await line("7g IPv6 multicast [ff02::1]:80", "ff02::1", 80);

console.log("\n### 15-16  DNS POLICY");
const designated = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
designated.setServers([RESOLVER]);
try {
  const [answer] = await designated.resolve4(PUBLIC_HTTPS_HOST);
  console.log(`${pad(`15 designated resolver ${RESOLVER}`)} -> RESOLVED ${answer}`);
} catch (error) {
  console.log(`${pad(`15 designated resolver ${RESOLVER}`)} -> FAILED ${error.code}`);
}
const nonDesignated = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
nonDesignated.setServers([NON_DESIGNATED]);
try {
  const [answer] = await nonDesignated.resolve4(PUBLIC_HTTPS_HOST);
  console.log(`${pad(`16 NON-designated ${NON_DESIGNATED}`)} -> *** RESOLVED ${answer} ***`);
} catch (error) {
  console.log(`${pad(`16 NON-designated ${NON_DESIGNATED}`)} -> DENIED(${error.code})`);
}

console.log("\n### 9  DNS ANSWER -> FORBIDDEN (public name, forbidden answer)");
for (const name of [optional("VF_DNS_FORBIDDEN_V4_NAME"), optional("VF_DNS_FORBIDDEN_LO_NAME")]) {
  if (!name) continue;
  try {
    const [answer] = await designated.resolve4(name);
    const port = answer.startsWith("127.") ? WORKER_PORT : 80;
    console.log(`${pad(`9  ${name} resolves to ${answer}`)} -> connect ${await probe(answer, port)}`);
  } catch (error) {
    console.log(`${pad(name)} -> resolve failed ${error.code}`);
  }
}

console.log("\n### 10  DNS REBINDING (public first answer, forbidden second)");
const rebindName = optional("VF_DNS_REBIND_NAME");
if (rebindName) {
  try {
    const [first] = await designated.resolve4(rebindName);
    console.log(`${pad(`10 ${rebindName} answer #1 = ${first}`)} -> connect ${await probe(first, 443)}`);
    const [second] = await designated.resolve4(rebindName);
    console.log(`${pad(`10 ${rebindName} answer #2 = ${second}`)} -> connect ${await probe(second, WORKER_PORT)}`);
  } catch (error) {
    console.log(`10 rebinding -> resolve failed ${error.code}`);
  }
}

console.log("\n### 13-14  PERMITTED PUBLIC");
await line(`13 public HTTP  ${PUBLIC_IP}:80`, PUBLIC_IP, 80);
await line(`14 public HTTPS ${PUBLIC_IP}:443`, PUBLIC_IP, 443);
await new Promise((resolve) => {
  https
    .get(`https://${PUBLIC_HTTPS_HOST}/`, (response) => {
      console.log(`${pad(`14b real HTTPS GET ${PUBLIC_HTTPS_HOST}`)} -> HTTP ${response.statusCode}`);
      response.resume();
      resolve();
    })
    .on("error", (error) => {
      console.log(`${pad("14b real HTTPS GET")} -> FAILED ${error.code}`);
      resolve();
    });
});

console.log("\n### 8  REDIRECT public -> forbidden");
const redirector = optional("VF_REDIRECT_URL");
if (!redirector) {
  console.log(`${pad("8  redirect case")} -> SKIPPED (set VF_REDIRECT_URL)`);
} else {
  await new Promise((resolve) => {
    http
      .get(redirector, (response) => {
        const location = response.headers.location;
        console.log(`${pad("8  public redirector status")} -> ${response.statusCode} Location=${location ?? "-"}`);
        response.resume();
        if (!location) return resolve();
        const target = new URL(location);
        probe(target.hostname, Number(target.port || 80)).then((verdict) => {
          console.log(`${pad(`8  following redirect to ${target.host}`)} -> ${verdict}`);
          resolve();
        });
      })
      .on("error", (error) => {
        console.log(`${pad("8  public redirector")} -> UNREACHABLE ${error.code}`);
        resolve();
      });
  });
}
