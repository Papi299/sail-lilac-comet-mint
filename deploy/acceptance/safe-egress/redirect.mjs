// Redirect case: a PUBLIC redirector answers 3xx with a Location pointing at a
// forbidden destination, and the client follows it.
//
// Recovered from the prototype's /opt/vf-test/redirect.mjs, which hard-coded
// three real third-party domains. No domain is committed here: the redirector
// is a controlled endpoint the operator supplies, exactly as safe-egress.md
// §Acceptance Tests 2 specifies ("a controlled PUBLIC HTTP endpoint").
//
//   VF_REDIRECT_URLS  comma-separated candidate redirector URLs (required)
//
// Each URL must return a Location header aimed at a forbidden target.
import http from "node:http";
import net from "node:net";

const raw = process.env.VF_REDIRECT_URLS;
if (!raw) {
  console.error("missing VF_REDIRECT_URLS");
  console.error("supply your own controlled redirector; no third-party domain is baked in");
  process.exit(2);
}
const candidates = raw.split(",").map((value) => value.trim()).filter(Boolean);

const probe = (host, port) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(4000);
    const done = (verdict) => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(verdict);
    };
    socket.once("connect", () => done("*** CONNECTED ***"));
    socket.once("timeout", () => done("DENIED(timeout)"));
    socket.once("error", (error) => done(`DENIED(${error.code})`));
    socket.connect({ host, port });
  });

for (const url of candidates) {
  const { host } = new URL(url);
  const result = await new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve({ status: response.statusCode, location: response.headers.location });
    });
    request.setTimeout(8000, () => {
      request.destroy();
      resolve({ status: "timeout" });
    });
    request.on("error", (error) => resolve({ status: `err:${error.code}` }));
  });

  console.log(`redirector ${host} -> status=${result.status} location=${result.location ?? "-"}`);
  if (result.location) {
    const target = new URL(result.location);
    console.log(`  client follows Location -> ${target.host} : ${await probe(target.hostname, Number(target.port || 80))}`);
    process.exit(0);
  }
}

console.log("NO CONTROLLED REDIRECTOR AVAILABLE");
process.exit(1);
