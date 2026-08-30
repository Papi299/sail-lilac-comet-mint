// Minimal HMAC client for the Worker control API, mirroring
// buildWorkerSigningInput() exactly. TEST TOOLING.
//
// Recovered from the prototype's /opt/vf-test/sign.mjs, which embedded a
// hard-coded key pair. The credential is supplied by the environment here.
//
//   VF_CONTROL_KEY_ID    (required)
//   VF_CONTROL_SECRET    (required)
//   VF_WORKER_ORIGIN     host:port of the Worker  (required)
//
// The secret is read from the environment and NEVER printed. Use a
// throwaway acceptance credential; this file must not be handed a production
// WORKER_CONTROL_SECRET, and it is deliberately impossible to configure one
// here by editing the source.
import crypto from "node:crypto";
import http from "node:http";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required environment variable ${name}`);
    process.exit(2);
  }
  return value;
};

const KEY_ID = required("VF_CONTROL_KEY_ID");
const SECRET = required("VF_CONTROL_SECRET");
const ORIGIN = required("VF_WORKER_ORIGIN");

const [, , method, path, bodyJson = null] = process.argv;
if (!method || !path) {
  console.error("usage: node sign.mjs <METHOD> <path> [jsonBody]");
  process.exit(2);
}

const [host, portText] = ORIGIN.split(":");
const port = Number(portText || 80);

const raw = bodyJson ? Buffer.from(bodyJson, "utf8") : Buffer.alloc(0);
const bodyHash = crypto.createHash("sha256").update(raw).digest("hex");
const timestamp = Math.floor(Date.now() / 1000).toString();
const requestId = crypto.randomUUID();
const idempotencyKey = method === "POST" && path === "/v1/jobs" ? crypto.randomUUID() : "";

const signingInput = ["v1", KEY_ID, method, path, timestamp, requestId, idempotencyKey, bodyHash].join("\n");
const signature = crypto.createHmac("sha256", SECRET).update(signingInput, "utf8").digest("hex");

const headers = {
  "x-videofetch-key-id": KEY_ID,
  "x-videofetch-timestamp": timestamp,
  "x-videofetch-request-id": requestId,
  "x-videofetch-signature": signature,
};
if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
if (bodyJson) {
  headers["Content-Type"] = "application/json";
  headers["Content-Length"] = String(raw.length);
}

const request = http.request({ host, port, path, method, headers }, (response) => {
  let body = "";
  response.on("data", (chunk) => (body += chunk));
  response.on("end", () => console.log(`HTTP ${response.statusCode} ${body.slice(0, 400)}`));
});
request.on("error", (error) => console.log("ERR", error.code));
if (bodyJson) request.write(raw);
request.end();
