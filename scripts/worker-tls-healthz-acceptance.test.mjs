// Self-tests for the TLS `/v1/healthz` acceptance tooling.
// (WORKER-EXTERNAL-LIVENESS-TLS-HEALTH-IMPLEMENTATION-001)
//
// These prove the HARNESS, not the Product. NOTHING HERE REACHES THE NETWORK:
// every request goes through an injected fake transport, so no Cloudflare
// hostname, no Worker, no tunnel and no Production system is contacted, and no
// DNS lookup is performed. The real acceptance is a separate, explicitly
// invoked, operator-authorized run of
// `deploy/acceptance/worker-health/tls-healthz-acceptance.mjs`.
//
// Every Access credential value below is OBVIOUSLY FAKE. No real Client Id or
// Client Secret is read, fetched, inspected or stored by this file, and the
// leak tests assert on the FAKE needles — which is what makes them falsifiable
// without ever handling real material.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ACCESS_ID_ENV,
  ACCESS_ID_HEADER,
  ACCESS_SECRET_ENV,
  ACCESS_SECRET_HEADER,
  assertTlsVerificationEnabled,
  buildAccessHeaders,
  evaluateHealthzResponse,
  readBoundedBody,
  resolveHealthzTarget,
  runTlsHealthzAcceptance,
  TLS_HEALTHZ_EXPECTED_STATUS,
  TLS_HEALTHZ_MAX_BODY_BYTES,
  TLS_HEALTHZ_OUTCOMES,
  TLS_HEALTHZ_PATH,
  TLS_HEALTHZ_SCHEMA_VERSION,
} from "../deploy/acceptance/worker-health/lib/tls-healthz.mjs";
import { createEvidenceFile, main, parseArgs } from "../deploy/acceptance/worker-health/tls-healthz-acceptance.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Obviously fake. Long enough to be a realistic needle for the leak sweeps. */
const FAKE_ID = "FAKE-ACCESS-CLIENT-ID-0000000000.access";
const FAKE_SECRET = "FAKE-ACCESS-CLIENT-SECRET-0000000000000000000000";

/** A hostname that exists only in this file. Never resolved: the transport is fake. */
const FAKE_ORIGIN = "https://worker.invalid-test-host.example";

/**
 * Builds a fake transport that records what it was called with.
 *
 * It answers with a REAL platform `Response`, so the acceptance reads the body
 * through the same ReadableStream path it uses against the network — not
 * through a convenience method a fake happens to provide.
 */
function fakeTransport({ status = 200, body = JSON.stringify({ status: "ok" }), throws = null, respond = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw throws;
    if (respond) return respond(url, init);
    return new Response(body, { status });
  };
  impl.calls = calls;
  return impl;
}

/**
 * A streaming body that would yield `totalChunks` × `chunkBytes` if allowed to,
 * and counts exactly how much of it was actually pulled.
 *
 * highWaterMark 0: the stream produces a chunk ONLY when a read is pending, so
 * `pulls` is exactly the number of chunks the consumer asked for — no
 * read-ahead can hide an over-read.
 */
function meteredStream({ totalChunks, chunkBytes, first = null }) {
  const meter = { pulls: 0, bytesProduced: 0, cancelled: false };
  let produced = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        meter.pulls += 1;
        if (produced >= totalChunks) {
          controller.close();
          return;
        }
        const chunk =
          produced === 0 && first !== null ? first : new Uint8Array(chunkBytes).fill(0x20);
        produced += 1;
        meter.bytesProduced += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        meter.cancelled = true;
      },
    },
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
  return { stream, meter };
}

/** A Response whose buffering conveniences THROW, so only the stream is usable. */
function streamOnlyResponse(stream, status = 200) {
  const response = new Response(stream, { status });
  for (const method of ["text", "json", "arrayBuffer", "blob", "formData", "bytes"]) {
    Object.defineProperty(response, method, {
      value: () => {
        throw new Error(`the acceptance must not call response.${method}() — it buffers the whole body`);
      },
    });
  }
  return response;
}

describe("TLS healthz target contract", () => {
  it("accepts a bare origin and appends the exact health path", () => {
    for (const raw of [FAKE_ORIGIN, `${FAKE_ORIGIN}/`, `  ${FAKE_ORIGIN}  `]) {
      const result = resolveHealthzTarget(raw);
      assert.equal(result.error, undefined, `${raw} should be accepted`);
      assert.equal(result.url, `${FAKE_ORIGIN}${TLS_HEALTHZ_PATH}`);
    }
  });

  it("accepts the full health URL as given", () => {
    const result = resolveHealthzTarget(`${FAKE_ORIGIN}${TLS_HEALTHZ_PATH}`);
    assert.equal(result.error, undefined);
    assert.equal(result.url, `${FAKE_ORIGIN}${TLS_HEALTHZ_PATH}`);
  });

  it("REFUSES a non-HTTPS URL", () => {
    for (const raw of [
      "http://worker.invalid-test-host.example",
      "http://worker.invalid-test-host.example/v1/healthz",
      "ws://worker.invalid-test-host.example",
      "ftp://worker.invalid-test-host.example",
      "file:///etc/passwd",
    ]) {
      const result = resolveHealthzTarget(raw);
      assert.ok(result.error, `${raw} must be refused`);
      assert.equal(result.url, undefined);
    }
  });

  it("REFUSES a query string", () => {
    for (const raw of [
      `${FAKE_ORIGIN}?a=1`,
      `${FAKE_ORIGIN}/?a=1`,
      `${FAKE_ORIGIN}${TLS_HEALTHZ_PATH}?token=abc`,
    ]) {
      const result = resolveHealthzTarget(raw);
      assert.ok(result.error, `${raw} must be refused`);
      assert.match(result.error, /query/);
    }
  });

  it("REFUSES a fragment", () => {
    for (const raw of [`${FAKE_ORIGIN}#frag`, `${FAKE_ORIGIN}${TLS_HEALTHZ_PATH}#frag`]) {
      const result = resolveHealthzTarget(raw);
      assert.ok(result.error, `${raw} must be refused`);
      assert.match(result.error, /fragment/);
    }
  });

  it("REFUSES any other path — there is no close-enough branch", () => {
    for (const raw of [
      `${FAKE_ORIGIN}/healthz`,
      `${FAKE_ORIGIN}/v1/health`,
      `${FAKE_ORIGIN}/v1/healthz/`,
      `${FAKE_ORIGIN}/v1/diagnostics`,
      `${FAKE_ORIGIN}/v1/jobs`,
      `${FAKE_ORIGIN}/V1/HEALTHZ`,
      `${FAKE_ORIGIN}/v1/healthz/../v1/jobs`,
    ]) {
      const result = resolveHealthzTarget(raw);
      assert.ok(result.error, `${raw} must be refused`);
      assert.match(result.error, /path/);
    }
  });

  it("REFUSES embedded credentials rather than silently stripping them", () => {
    const result = resolveHealthzTarget("https://user:pass@worker.invalid-test-host.example");
    assert.ok(result.error);
    assert.match(result.error, /credential/);
  });

  it("REFUSES an empty or unparseable origin", () => {
    for (const raw of ["", "   ", "not a url", "worker.invalid-test-host.example", undefined, null, 42]) {
      const result = resolveHealthzTarget(raw);
      assert.ok(result.error, `${String(raw)} must be refused`);
    }
  });
});

describe("Access Service Auth credential handling", () => {
  it("emits EXACTLY the two Access headers when both are supplied", () => {
    const result = buildAccessHeaders({ clientId: FAKE_ID, clientSecret: FAKE_SECRET });
    assert.equal(result.error, undefined);
    assert.equal(result.supplied, true);
    assert.deepEqual(Object.keys(result.headers).sort(), [ACCESS_ID_HEADER, ACCESS_SECRET_HEADER].sort());
    assert.equal(result.headers[ACCESS_ID_HEADER], FAKE_ID);
    assert.equal(result.headers[ACCESS_SECRET_HEADER], FAKE_SECRET);
  });

  it("emits NEITHER header when neither is supplied", () => {
    for (const input of [{}, { clientId: "", clientSecret: "" }, { clientId: "  ", clientSecret: "\t" }]) {
      const result = buildAccessHeaders(input);
      assert.equal(result.error, undefined);
      assert.equal(result.supplied, false);
      assert.deepEqual(Object.keys(result.headers), []);
    }
  });

  it("FAILS CLOSED when only one of the pair is supplied", () => {
    const idOnly = buildAccessHeaders({ clientId: FAKE_ID });
    assert.ok(idOnly.error);
    assert.match(idOnly.error, new RegExp(ACCESS_SECRET_ENV));
    assert.equal(idOnly.headers, undefined);

    const secretOnly = buildAccessHeaders({ clientSecret: FAKE_SECRET });
    assert.ok(secretOnly.error);
    assert.match(secretOnly.error, new RegExp(ACCESS_ID_ENV));
    assert.equal(secretOnly.headers, undefined);
  });

  it("never echoes a credential VALUE in the incomplete-pair error", () => {
    for (const result of [
      buildAccessHeaders({ clientId: FAKE_ID }),
      buildAccessHeaders({ clientSecret: FAKE_SECRET }),
    ]) {
      assert.ok(!result.error.includes(FAKE_ID), "the error must not carry the id");
      assert.ok(!result.error.includes(FAKE_SECRET), "the error must not carry the secret");
    }
  });

  it("fails closed BEFORE any request is made", async () => {
    const transport = fakeTransport();
    const result = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      accessClientId: FAKE_ID,
      fetchImpl: transport,
    });
    assert.equal(result.pass, false);
    assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.CREDENTIALS_INCOMPLETE);
    assert.equal(transport.calls.length, 0, "no request may be dialled with half a credential");
  });
});

describe("TLS healthz response judgement", () => {
  it("accepts 200 with the healthy body", () => {
    const verdict = evaluateHealthzResponse({ status: 200, bodyText: '{"status":"ok"}' });
    assert.equal(verdict.outcome, TLS_HEALTHZ_OUTCOMES.HEALTHY);
  });

  it("accepts a healthy body with extra fields, which the contract permits", () => {
    const verdict = evaluateHealthzResponse({
      status: 200,
      bodyText: JSON.stringify({ status: TLS_HEALTHZ_EXPECTED_STATUS, extra: 1 }),
    });
    assert.equal(verdict.outcome, TLS_HEALTHZ_OUTCOMES.HEALTHY);
  });

  it("FAILS a redirect, as its own outcome and never as a pass", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const verdict = evaluateHealthzResponse({ status, bodyText: '{"status":"ok"}' });
      assert.equal(verdict.outcome, TLS_HEALTHZ_OUTCOMES.REDIRECTED, `HTTP ${status}`);
      assert.equal(verdict.redirected, true);
    }
  });

  it("FAILS a non-200 response", () => {
    for (const status of [201, 204, 400, 401, 403, 404, 500, 502, 503]) {
      const verdict = evaluateHealthzResponse({ status, bodyText: '{"status":"ok"}' });
      assert.equal(verdict.outcome, TLS_HEALTHZ_OUTCOMES.BAD_STATUS, `HTTP ${status}`);
    }
  });

  it("FAILS malformed JSON, including an Access login page", () => {
    for (const body of [
      "",
      "not json",
      "<!DOCTYPE html><html><body>Sign in</body></html>",
      "{",
      "[]",
      '"ok"',
      "null",
      "7",
    ]) {
      const verdict = evaluateHealthzResponse({ status: 200, bodyText: body });
      assert.equal(verdict.outcome, TLS_HEALTHZ_OUTCOMES.MALFORMED_BODY, `body: ${body}`);
    }
  });

  it("FAILS a health state that is not ok", () => {
    for (const state of ["degraded", "OK", "Ok", "starting", "", null, 1, true]) {
      const verdict = evaluateHealthzResponse({
        status: 200,
        bodyText: JSON.stringify({ status: state }),
      });
      assert.equal(verdict.outcome, TLS_HEALTHZ_OUTCOMES.WRONG_STATE, `state: ${String(state)}`);
    }
  });

  it("FAILS a body over the cap", () => {
    const verdict = evaluateHealthzResponse({
      status: 200,
      bodyText: `{"status":"ok","pad":"${"x".repeat(9000)}"}`,
    });
    assert.equal(verdict.outcome, TLS_HEALTHZ_OUTCOMES.BODY_TOO_LARGE);
  });

  it("never echoes the observed health state, which is untrusted text", () => {
    const verdict = evaluateHealthzResponse({
      status: 200,
      bodyText: JSON.stringify({ status: "LEAK-ME-abcdef" }),
    });
    assert.ok(!verdict.detail.includes("LEAK-ME-abcdef"));
  });
});

describe("certificate verification cannot be disabled", () => {
  it("has no --insecure or verification-override flag at all", () => {
    for (const file of [
      "deploy/acceptance/worker-health/lib/tls-healthz.mjs",
      "deploy/acceptance/worker-health/tls-healthz-acceptance.mjs",
    ]) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      const executable = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      for (const forbidden of [
        /rejectUnauthorized/,
        /--insecure\b/,
        /--no-verify/,
        /checkServerIdentity/,
        // An ASSIGNMENT that turns verification off. The guard legitimately
        // READS this variable and NAMES it in its refusal message, and neither
        // of those is a setting — so the pattern requires an actual `=` write
        // (not `==`/`===`) through process.env or an env object.
        /(process\.env|\benv)\s*(\.\s*|\[\s*["'])NODE_TLS_REJECT_UNAUTHORIZED["']?\s*\]?\s*=(?!=)/,
        /createSecureContext/,
        /\bca:\s/,
      ]) {
        assert.doesNotMatch(executable, forbidden, `${file} must not reference ${forbidden}`);
      }
    }
  });

  it("REFUSES to run under NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
    const guard = assertTlsVerificationEnabled({ NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assert.ok(guard.error);

    const transport = fakeTransport();
    const result = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      fetchImpl: transport,
    });
    assert.equal(result.pass, false);
    assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.TLS_VERIFICATION_DISABLED);
    assert.equal(transport.calls.length, 0, "nothing is dialled with verification off");
    // REVIEW-CORRECTION-001, finding 2. The first revision asserted "enabled"
    // HERE — evidence contradicting the very outcome it recorded.
    assert.equal(result.evidence.tlsVerification, "disabled-refused");
    assert.notEqual(result.evidence.tlsVerification, "enabled");
    assert.equal(result.evidence.requestAttempted, false);
    assert.equal(result.evidence.httpsUsed, null);
  });

  it("runs normally when verification is untouched or explicitly on", () => {
    for (const env of [{}, { NODE_TLS_REJECT_UNAUTHORIZED: "1" }, { NODE_TLS_REJECT_UNAUTHORIZED: "" }]) {
      assert.equal(assertTlsVerificationEnabled(env).error, undefined);
    }
  });
});

describe("the request the acceptance actually makes", () => {
  it("requests exactly the health path over HTTPS, with manual redirect handling", async () => {
    const transport = fakeTransport();
    const result = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      accessClientId: FAKE_ID,
      accessClientSecret: FAKE_SECRET,
      fetchImpl: transport,
    });
    assert.equal(result.pass, true);
    assert.equal(transport.calls.length, 1);

    const [{ url, init }] = transport.calls;
    assert.equal(url, `${FAKE_ORIGIN}${TLS_HEALTHZ_PATH}`);
    assert.equal(new URL(url).protocol, "https:");
    assert.equal(init.method, "GET");
    // `manual` is what makes a 3xx arrive to be judged. `follow` would let a
    // login page or a zone redirect answer on the Worker's behalf.
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal, "the request is deadline-bound");
  });

  it("emits exactly the two Access headers and NO Worker HMAC header", async () => {
    const transport = fakeTransport();
    await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      accessClientId: FAKE_ID,
      accessClientSecret: FAKE_SECRET,
      fetchImpl: transport,
    });

    const names = Object.keys(transport.calls[0].init.headers);
    const access = names.filter((n) => /^cf-access-client-/i.test(n));
    assert.deepEqual(access.sort(), [ACCESS_ID_HEADER, ACCESS_SECRET_HEADER].sort());

    // /v1/healthz is unauthenticated at the Worker application layer, so signing
    // it would be meaningless AND would put control-plane key material into a
    // health check.
    for (const name of names) {
      assert.doesNotMatch(name, /^x-videofetch-/i, `${name} is a Worker protocol header`);
      assert.doesNotMatch(name, /^authorization$/i);
      assert.doesNotMatch(name, /^cookie$/i);
      assert.doesNotMatch(name, /^idempotency-key$/i);
    }
  });

  it("emits NEITHER Access header when no credential is supplied", async () => {
    const transport = fakeTransport();
    await runTlsHealthzAcceptance({ origin: FAKE_ORIGIN, fetchImpl: transport });
    const names = Object.keys(transport.calls[0].init.headers);
    assert.deepEqual(names.filter((n) => /^cf-access-client-/i.test(n)), []);
  });

  it("does not dial at all when the target is refused", async () => {
    const transport = fakeTransport();
    const result = await runTlsHealthzAcceptance({
      origin: "http://worker.invalid-test-host.example",
      fetchImpl: transport,
    });
    assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.TARGET_REFUSED);
    assert.equal(transport.calls.length, 0);
  });

  it("FAILS, rather than skips, when the transport itself fails", async () => {
    // A certificate failure lands here. An untrusted endpoint is a FAILED
    // acceptance, never an unmeasured one.
    const transport = fakeTransport({ throws: Object.assign(new Error("self signed certificate"), { name: "TypeError" }) });
    const result = await runTlsHealthzAcceptance({ origin: FAKE_ORIGIN, fetchImpl: transport });
    assert.equal(result.pass, false);
    assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.TRANSPORT_FAILED);
  });

  it("records a redirect as a FAIL with the redirect flag set", async () => {
    const transport = fakeTransport({ status: 302, body: '{"status":"ok"}' });
    const result = await runTlsHealthzAcceptance({ origin: FAKE_ORIGIN, fetchImpl: transport });
    assert.equal(result.pass, false);
    assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.REDIRECTED);
    assert.equal(result.evidence.redirectObserved, true);
    assert.equal(result.evidence.verdict, "FAIL");
  });
});

describe("the evidence record is deliberately narrow", () => {
  /** Walks every string in the record, at any depth. */
  function allStrings(value, out = []) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
    else if (value && typeof value === "object") for (const v of Object.values(value)) allStrings(v, out);
    return out;
  }

  async function record(extra = {}) {
    const result = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      accessClientId: FAKE_ID,
      accessClientSecret: FAKE_SECRET,
      fetchImpl: fakeTransport(),
      ...extra,
    });
    return result.evidence;
  }

  it("records the non-secret facts the operator needs", async () => {
    const evidence = await record();
    assert.equal(evidence.schemaVersion, TLS_HEALTHZ_SCHEMA_VERSION);
    assert.equal(evidence.schemaVersion, "worker-tls-healthz-02");
    assert.equal(evidence.requestAttempted, true);
    assert.equal(evidence.httpsUsed, true);
    assert.equal(evidence.tlsVerification, "enabled");
    assert.equal(evidence.responseReceived, true);
    assert.equal(evidence.bodyWithinLimit, true);
    assert.equal(evidence.healthPath, TLS_HEALTHZ_PATH);
    assert.equal(evidence.accessCredentialPresence, "both");
    assert.equal(evidence.accessCredentialPairSupplied, true);
    assert.equal(evidence.httpStatus, 200);
    assert.equal(evidence.healthyBodyMatched, true);
    assert.equal(evidence.redirectObserved, false);
    assert.equal(evidence.verdict, "PASS");
    assert.equal(evidence.workerHmacEmitted, false);
    assert.match(evidence.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(evidence.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("withholds the Worker hostname entirely", async () => {
    const evidence = await record();
    assert.equal(evidence.tlsOrigin, "<withheld>");
    const serialized = JSON.stringify(evidence);
    // The repository never commits the Production Worker hostname, so not even
    // the fake one may survive into the record.
    assert.ok(!serialized.includes("worker.invalid-test-host.example"));
    assert.ok(!serialized.includes(FAKE_ORIGIN));
  });

  it("never records a credential VALUE, in a PASS or in a FAIL", async () => {
    const records = [
      await record(),
      await record({ fetchImpl: fakeTransport({ status: 403, body: "denied" }) }),
      await record({ fetchImpl: fakeTransport({ status: 302 }) }),
      await record({ fetchImpl: fakeTransport({ body: "<html>login</html>" }) }),
      await record({ accessClientSecret: undefined }),
      await record({ fetchImpl: fakeTransport({ throws: new Error("boom") }) }),
    ];
    for (const evidence of records) {
      const serialized = JSON.stringify(evidence);
      assert.ok(!serialized.includes(FAKE_ID), "the Access Client Id must never appear");
      assert.ok(!serialized.includes(FAKE_SECRET), "the Access Client Secret must never appear");
      for (const text of allStrings(evidence)) {
        assert.ok(!text.includes(FAKE_ID));
        assert.ok(!text.includes(FAKE_SECRET));
      }
    }
  });

  it("records Access header NAMES only, never values", async () => {
    const evidence = await record();
    assert.deepEqual(evidence.accessHeaderNamesSent.sort(), [ACCESS_ID_HEADER, ACCESS_SECRET_HEADER].sort());
    assert.equal(evidence.unexpectedHeaderCount, 0);
    for (const name of evidence.accessHeaderNamesSent) {
      assert.ok(!name.includes(FAKE_ID));
      assert.ok(!name.includes(FAKE_SECRET));
    }
  });

  it("carries no forbidden field name at any depth", async () => {
    const forbidden = [
      "secret",
      "password",
      "token",
      "credential",
      "credentials",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "cookie",
      "authorization",
      "clientId",
      "clientSecret",
      "hostname",
      "origin",
      "url",
      "headers",
      "body",
      "signedUrl",
    ];
    const evidence = await record();
    const walk = (value, path = "") => {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        assert.ok(
          !forbidden.some((f) => f.toLowerCase() === key.toLowerCase()),
          `evidence must not carry a '${key}' field (at ${path}${key})`,
        );
        walk(entry, `${path}${key}.`);
      }
    };
    walk(evidence);
  });
});

describe("the acceptance CLI", () => {
  function capture() {
    const out = [];
    const err = [];
    return { out, err, log: (m) => out.push(String(m)), errorLog: (m) => err.push(String(m)) };
  }

  it("requires --origin", () => {
    assert.match(parseArgs([]).error, /--origin is required/);
  });

  it("rejects an unknown argument rather than guessing", () => {
    assert.match(parseArgs(["--origin", FAKE_ORIGIN, "--wat"]).error, /unknown argument/);
  });

  it("REFUSES a credential flag, and says why", () => {
    for (const flag of ["--access-client-id", "--access-client-secret"]) {
      const parsed = parseArgs(["--origin", FAKE_ORIGIN, flag, "whatever"]);
      assert.ok(parsed.error, `${flag} must not exist`);
      // argv is world-readable through /proc on the VM.
      assert.match(parsed.error, /world-readable/);
      assert.match(parsed.error, new RegExp(ACCESS_ID_ENV));
    }
  });

  it("bounds --timeout-ms", () => {
    for (const bad of ["0", "999", "60001", "abc", ""]) {
      assert.ok(parseArgs(["--origin", FAKE_ORIGIN, "--timeout-ms", bad]).error, `${bad} must be refused`);
    }
    assert.equal(parseArgs(["--origin", FAKE_ORIGIN, "--timeout-ms", "5000"]).error, undefined);
  });

  it("takes the Access pair from the ENVIRONMENT under the Vercel-side names", async () => {
    const transport = fakeTransport();
    const io = capture();
    const code = await main(["--origin", FAKE_ORIGIN], {
      env: { [ACCESS_ID_ENV]: FAKE_ID, [ACCESS_SECRET_ENV]: FAKE_SECRET },
      fetchImpl: transport,
      ...io,
    });
    assert.equal(code, 0);
    const names = Object.keys(transport.calls[0].init.headers);
    assert.ok(names.some((n) => n.toLowerCase() === ACCESS_ID_HEADER.toLowerCase()));
    assert.ok(names.some((n) => n.toLowerCase() === ACCESS_SECRET_HEADER.toLowerCase()));
  });

  it("exits nonzero on a FAIL and zero only on a PASS", async () => {
    const pass = await main(["--origin", FAKE_ORIGIN], { env: {}, fetchImpl: fakeTransport(), ...capture() });
    assert.equal(pass, 0);

    const fail = await main(["--origin", FAKE_ORIGIN], {
      env: {},
      fetchImpl: fakeTransport({ status: 503, body: "{}" }),
      ...capture(),
    });
    assert.equal(fail, 1);

    const refused = await main(["--origin", "http://worker.invalid-test-host.example"], {
      env: {},
      fetchImpl: fakeTransport(),
      ...capture(),
    });
    assert.equal(refused, 1);
  });

  it("prints no credential and no hostname on any path", async () => {
    for (const transport of [
      fakeTransport(),
      fakeTransport({ status: 403, body: "denied" }),
      fakeTransport({ status: 302 }),
      fakeTransport({ throws: new Error("boom") }),
    ]) {
      const io = capture();
      await main(["--origin", FAKE_ORIGIN], {
        env: { [ACCESS_ID_ENV]: FAKE_ID, [ACCESS_SECRET_ENV]: FAKE_SECRET },
        fetchImpl: transport,
        ...io,
      });
      const printed = [...io.out, ...io.err].join("\n");
      assert.ok(!printed.includes(FAKE_ID), "the Access Client Id must never be printed");
      assert.ok(!printed.includes(FAKE_SECRET), "the Access Client Secret must never be printed");
      assert.ok(!printed.includes("worker.invalid-test-host.example"), "the hostname must not be printed");
    }
  });

  it("is reachable from no unit, npm script or startup path", () => {
    // It makes an outbound request to an operator-named endpoint, so nothing may
    // run it automatically.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    for (const script of Object.values(pkg.scripts ?? {})) {
      assert.doesNotMatch(String(script), /tls-healthz/);
    }
    for (const unit of [
      "deploy/systemd/videofetch-worker.service",
      "deploy/systemd/videofetch-worker-liveness.service",
      "deploy/systemd/videofetch-worker-liveness.timer",
      "deploy/systemd/videofetch-media-netns.service",
    ]) {
      const source = readFileSync(join(REPO_ROOT, unit), "utf8");
      const executable = source
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      assert.doesNotMatch(executable, /tls-healthz/, `${unit} must not invoke the acceptance`);
    }
  });
});

describe("evidence records only what actually happened (REVIEW-CORRECTION-001)", () => {
  const run = (options) =>
    runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      accessClientId: FAKE_ID,
      accessClientSecret: FAKE_SECRET,
      fetchImpl: fakeTransport(),
      ...options,
    });

  it("PASS: request attempted, HTTPS used, verification enabled", async () => {
    const { evidence } = await run();
    assert.equal(evidence.verdict, "PASS");
    assert.equal(evidence.requestAttempted, true);
    assert.equal(evidence.httpsUsed, true);
    assert.equal(evidence.tlsVerification, "enabled");
    assert.equal(evidence.targetAccepted, true);
    assert.equal(evidence.suppliedScheme, "https:");
    assert.equal(evidence.httpStatus, 200);
    assert.equal(evidence.redirectObserved, false);
    assert.equal(evidence.healthyBodyMatched, true);
  });

  it("transport or certificate failure: attempted over verified HTTPS, then FAIL", async () => {
    const certificateError = Object.assign(new Error("unable to verify the first certificate"), { name: "TypeError" });
    const { evidence } = await run({ fetchImpl: fakeTransport({ throws: certificateError }) });
    assert.equal(evidence.verdict, "FAIL");
    assert.equal(evidence.outcome, TLS_HEALTHZ_OUTCOMES.TRANSPORT_FAILED);
    assert.equal(evidence.requestAttempted, true);
    assert.equal(evidence.httpsUsed, true);
    assert.equal(evidence.tlsVerification, "enabled");
    assert.equal(evidence.responseReceived, false);
    assert.equal(evidence.httpStatus, null, "no status was observed");
    assert.equal(evidence.redirectObserved, null, "no response, so no redirect judgement");
    assert.equal(evidence.healthyBodyMatched, null);
  });

  it("NODE_TLS_REJECT_UNAUTHORIZED=0: no request, and verification recorded as disabled", async () => {
    const { evidence } = await run({ env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
    assert.equal(evidence.outcome, TLS_HEALTHZ_OUTCOMES.TLS_VERIFICATION_DISABLED);
    assert.equal(evidence.tlsVerification, "disabled-refused");
    assert.equal(evidence.requestAttempted, false);
    assert.equal(evidence.httpsUsed, null);
    // The run stopped before the target was even evaluated.
    assert.equal(evidence.targetAccepted, null);
    assert.equal(evidence.responseReceived, false);
    // What the operator supplied is still a true fact; nothing was SENT.
    assert.equal(evidence.accessCredentialPresence, "both");
    assert.deepEqual(evidence.accessHeaderNamesSent, []);
  });

  it("http:// target refused: no request, and HTTPS is NOT claimed", async () => {
    const { evidence } = await run({ origin: "http://worker.invalid-test-host.example" });
    assert.equal(evidence.outcome, TLS_HEALTHZ_OUTCOMES.TARGET_REFUSED);
    assert.equal(evidence.requestAttempted, false);
    assert.notEqual(evidence.httpsUsed, true);
    assert.equal(evidence.httpsUsed, null);
    assert.equal(evidence.tlsVerification, "not-attempted");
    assert.equal(evidence.targetAccepted, false);
    assert.equal(evidence.suppliedScheme, "http:", "the reason for refusal is recorded");
  });

  it("an unrecognized scheme is reported as 'other', never rendered", async () => {
    const { evidence } = await run({ origin: "gopher-secret-thing://worker.invalid-test-host.example" });
    assert.equal(evidence.suppliedScheme, "other");
  });

  it("incomplete credentials: no request, presence recorded as incomplete", async () => {
    const { evidence } = await run({ accessClientSecret: undefined });
    assert.equal(evidence.outcome, TLS_HEALTHZ_OUTCOMES.CREDENTIALS_INCOMPLETE);
    assert.equal(evidence.accessCredentialPresence, "incomplete");
    assert.equal(evidence.accessCredentialPairSupplied, false);
    assert.equal(evidence.requestAttempted, false);
    assert.equal(evidence.httpsUsed, null);
    assert.equal(evidence.tlsVerification, "not-attempted");
    assert.equal(evidence.targetAccepted, true, "the target itself was fine");
    assert.deepEqual(evidence.accessHeaderNamesSent, []);
  });

  it("redirect and non-200: status measured, body never judged", async () => {
    for (const [status, outcome, redirected] of [
      [302, TLS_HEALTHZ_OUTCOMES.REDIRECTED, true],
      [503, TLS_HEALTHZ_OUTCOMES.BAD_STATUS, false],
    ]) {
      const { evidence } = await run({ fetchImpl: fakeTransport({ status, body: '{"status":"ok"}' }) });
      assert.equal(evidence.outcome, outcome);
      assert.equal(evidence.responseReceived, true);
      assert.equal(evidence.httpStatus, status);
      assert.equal(evidence.redirectObserved, redirected);
      assert.equal(evidence.bodyWithinLimit, null, "the body was not read");
      assert.equal(evidence.healthyBodyMatched, null, "a healthy-looking body behind a 3xx/5xx is not judged");
    }
  });

  it("NO refusal path ever records HTTPS or enabled verification", async () => {
    const refusals = [
      await run({ env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } }),
      await run({ origin: "http://worker.invalid-test-host.example" }),
      await run({ origin: `${FAKE_ORIGIN}?q=1` }),
      await run({ origin: "not a url" }),
      await run({ accessClientSecret: undefined }),
      await run({ accessClientId: undefined }),
    ];
    for (const { evidence } of refusals) {
      assert.equal(evidence.requestAttempted, false, evidence.outcome);
      assert.notEqual(evidence.httpsUsed, true, `${evidence.outcome} must not claim HTTPS`);
      assert.notEqual(evidence.tlsVerification, "enabled", `${evidence.outcome} must not claim verification`);
      assert.equal(evidence.responseReceived, false);
      assert.equal(evidence.httpStatus, null);
      assert.equal(evidence.verdict, "FAIL");
    }
  });
});

describe("the body limit is enforced WHILE streaming (REVIEW-CORRECTION-001)", () => {
  const CHUNK = 1024;
  const TOTAL = 4096; // 4 MiB available if the reader never stopped

  it("cuts an oversized body off at the limit instead of buffering it", async () => {
    const { stream, meter } = meteredStream({ totalChunks: TOTAL, chunkBytes: CHUNK });
    const result = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      fetchImpl: fakeTransport({ respond: () => streamOnlyResponse(stream) }),
    });

    assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.BODY_TOO_LARGE);
    assert.equal(result.evidence.bodyWithinLimit, false);
    assert.equal(result.evidence.healthyBodyMatched, null);
    assert.equal(meter.cancelled, true, "the stream was cancelled once the cap was crossed");

    // The cap is 4 KiB: exactly the chunks up to and including the one that
    // crossed it were pulled — never the 4 MiB that was on offer.
    const expectedPulls = Math.floor(TLS_HEALTHZ_MAX_BODY_BYTES / CHUNK) + 1;
    assert.equal(meter.pulls, expectedPulls, `pulled ${meter.pulls} chunks`);
    assert.ok(meter.bytesProduced <= TLS_HEALTHZ_MAX_BODY_BYTES + CHUNK);
    assert.ok(meter.bytesProduced < TOTAL * CHUNK / 100, "far less than the full body was produced");
  });

  it("stops on a single chunk that alone exceeds the limit", async () => {
    const huge = new Uint8Array(1024 * 1024).fill(0x20);
    const { stream, meter } = meteredStream({ totalChunks: 50, chunkBytes: CHUNK, first: huge });
    const body = await readBoundedBody(streamOnlyResponse(stream), TLS_HEALTHZ_MAX_BODY_BYTES);
    assert.equal(body.tooLarge, true);
    assert.equal(body.text, undefined, "nothing is returned for an oversized body");
    assert.equal(meter.pulls, 1);
    assert.equal(meter.cancelled, true);
  });

  it("never calls a buffering convenience (text/json/arrayBuffer/blob)", async () => {
    // streamOnlyResponse makes every one of those THROW; a regression back to
    // `await response.text()` fails here as a transport failure, not a pass.
    const encoded = new TextEncoder().encode('{"status":"ok"}');
    const { stream } = meteredStream({ totalChunks: 1, chunkBytes: 0, first: encoded });
    const result = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      fetchImpl: fakeTransport({ respond: () => streamOnlyResponse(stream) }),
    });
    assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.HEALTHY, result.detail);
  });

  it("reassembles a healthy body split across many small chunks", async () => {
    const parts = ['{"sta', 'tus":', '"o', 'k"', "}"].map((t) => new TextEncoder().encode(t));
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < parts.length) controller.enqueue(parts[i++]);
        else controller.close();
      },
    });
    const result = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      fetchImpl: fakeTransport({ respond: () => streamOnlyResponse(stream) }),
    });
    assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.HEALTHY);
  });

  it("accepts a body of exactly the limit and refuses one byte more", async () => {
    const pad = (n) => {
      const base = '{"status":"ok","pad":""}';
      return `{"status":"ok","pad":"${"x".repeat(n - base.length)}"}`;
    };
    const exact = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      fetchImpl: fakeTransport({ body: pad(TLS_HEALTHZ_MAX_BODY_BYTES) }),
    });
    assert.equal(exact.outcome, TLS_HEALTHZ_OUTCOMES.HEALTHY);

    const over = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      fetchImpl: fakeTransport({ body: pad(TLS_HEALTHZ_MAX_BODY_BYTES + 1) }),
    });
    assert.equal(over.outcome, TLS_HEALTHZ_OUTCOMES.BODY_TOO_LARGE);
  });

  it("does not read a non-200 body at all", async () => {
    const { stream, meter } = meteredStream({ totalChunks: TOTAL, chunkBytes: CHUNK });
    const result = await runTlsHealthzAcceptance({
      origin: FAKE_ORIGIN,
      fetchImpl: fakeTransport({ respond: () => streamOnlyResponse(stream, 503) }),
    });
    assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.BAD_STATUS);
    assert.equal(meter.pulls, 0, "no chunk was requested");
    assert.equal(meter.cancelled, true, "the body was released");
  });

  it("applies the request's deadline to a body that stalls", async () => {
    // One byte, then silence forever. Only the shared AbortSignal can end this.
    let sent = false;
    const stalled = new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode("{"));
          return;
        }
        return new Promise(() => {});
      },
    });
    // Raced against a bounded watchdog, so a regression that stops honouring the
    // deadline FAILS this test promptly instead of hanging the whole suite. The
    // watchdog timer also holds the event loop open, which AbortSignal.timeout
    // does not do on its own.
    let watchdog;
    const hung = new Promise((resolve) => {
      watchdog = setTimeout(() => resolve("HUNG"), 3_000);
    });
    try {
      const started = Date.now();
      const result = await Promise.race([
        runTlsHealthzAcceptance({
          origin: FAKE_ORIGIN,
          timeoutMs: 150,
          fetchImpl: fakeTransport({ respond: () => streamOnlyResponse(stalled) }),
        }),
        hung,
      ]);
      assert.notEqual(result, "HUNG", "a stalled body must be ended by the request deadline");
      assert.equal(result.outcome, TLS_HEALTHZ_OUTCOMES.TRANSPORT_FAILED);
      assert.match(result.detail, /TimeoutError|AbortError/);
      assert.equal(result.evidence.responseReceived, true);
      assert.equal(result.evidence.bodyWithinLimit, null, "a timed-out body is not a judged body");
      assert.ok(Date.now() - started < 3_000);
    } finally {
      clearTimeout(watchdog);
    }
  });
});

describe("the evidence file is created new, exactly 0600, and never overwritten (REVIEW-CORRECTION-001)", () => {
  async function sandbox() {
    return mkdtemp(join(tmpdir(), "vf-tls-evidence-"));
  }
  const quiet = () => ({ log: () => {}, errorLog: () => {} });

  it("creates a NEW file with mode exactly 0600 containing the record", async () => {
    const dir = await sandbox();
    try {
      const path = join(dir, "evidence.json");
      const code = await main(["--origin", FAKE_ORIGIN, "--evidence", path], {
        env: {},
        fetchImpl: fakeTransport(),
        ...quiet(),
      });
      assert.equal(code, 0);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const record = JSON.parse(await readFile(path, "utf8"));
      assert.equal(record.verdict, "PASS");
      assert.equal(record.schemaVersion, "worker-tls-healthz-02");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is exactly 0600 even under a umask that would strip the owner's write bit", async () => {
    const dir = await sandbox();
    const previous = process.umask(0o277);
    try {
      const path = join(dir, "evidence.json");
      const handle = await createEvidenceFile(path);
      await handle.close();
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally {
      process.umask(previous);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("REFUSES an existing file, leaves it untouched, and requests nothing", async () => {
    const dir = await sandbox();
    try {
      const path = join(dir, "evidence.json");
      const original = "PRE-EXISTING EVIDENCE — must survive\n";
      await writeFile(path, original, { mode: 0o644 });
      const transport = fakeTransport();
      const errors = [];
      const code = await main(["--origin", FAKE_ORIGIN, "--evidence", path], {
        env: {},
        fetchImpl: transport,
        log: () => {},
        errorLog: (m) => errors.push(String(m)),
      });
      assert.equal(code, 2);
      assert.equal(await readFile(path, "utf8"), original, "the existing file is unchanged");
      assert.equal((await stat(path)).mode & 0o777, 0o644, "and so are its permissions");
      assert.equal(transport.calls.length, 0, "nothing was requested");
      assert.match(errors.join("\n"), /already exists; refusing to overwrite/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("REFUSES a symlink and never writes through it to the target", async () => {
    const dir = await sandbox();
    try {
      const target = join(dir, "victim.txt");
      const link = join(dir, "evidence.json");
      await writeFile(target, "VICTIM CONTENT\n");
      await symlink(target, link);
      const transport = fakeTransport();
      const code = await main(["--origin", FAKE_ORIGIN, "--evidence", link], {
        env: {},
        fetchImpl: transport,
        ...quiet(),
      });
      assert.equal(code, 2);
      assert.equal(await readFile(target, "utf8"), "VICTIM CONTENT\n");
      assert.ok((await lstat(link)).isSymbolicLink(), "the link itself is untouched");
      assert.equal(await readlink(link), target);
      assert.equal(transport.calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("REFUSES a dangling symlink rather than creating its target", async () => {
    const dir = await sandbox();
    try {
      const target = join(dir, "would-be-created.txt");
      const link = join(dir, "evidence.json");
      await symlink(target, link);
      const code = await main(["--origin", FAKE_ORIGIN, "--evidence", link], {
        env: {},
        fetchImpl: fakeTransport(),
        ...quiet(),
      });
      assert.equal(code, 2);
      await assert.rejects(stat(target), { code: "ENOENT" }, "the symlink target was not created");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the evidence of a FAILED run too", async () => {
    const dir = await sandbox();
    try {
      const path = join(dir, "evidence.json");
      const code = await main(["--origin", "http://worker.invalid-test-host.example", "--evidence", path], {
        env: {},
        fetchImpl: fakeTransport(),
        ...quiet(),
      });
      assert.equal(code, 1);
      const record = JSON.parse(await readFile(path, "utf8"));
      assert.equal(record.verdict, "FAIL");
      assert.equal(record.requestAttempted, false);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
