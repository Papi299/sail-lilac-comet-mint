// Tests for the Phase-10D controlled acceptance fixture service.
//
// Everything here runs against a loopback listener this file starts itself.
// NOTHING reaches the public Internet, the Lima VM, Docker, Cloudflare or the
// VideoFetch control plane: the fixture is a self-contained HTTP service over a
// buffer, and that is exactly the property that makes it testable offline.
//
// The assertions are grouped by the promise each one protects:
//
//   exposure      — loopback only, closed route set, closed method set
//   direct        — exact bytes, exact length, exact digest
//   generic       — one relative media reference, exact bytes, real delay
//   byte-limit    — exact correlation grammar, no Content-Length, genuine counts
//   evidence      — this case's facts and nothing else
//   safe-egress   — one fixed private-v4 destination, not operator-controlled
//   contract      — the constants that must agree with the merged harness

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { CASE_ID_PATTERN as HARNESS_CASE_ID_PATTERN } from "../deploy/acceptance/ytdlp-generic/lib/evidence.mjs";
import { EGRESS_FIXTURE_CLASSES } from "../deploy/acceptance/ytdlp-generic/lib/egress-policy.mjs";
import { ffmpegArgs } from "../deploy/acceptance/ytdlp-generic/fixtures/prepare-media.mjs";
import {
  BYTE_LIMIT_TOTAL_BYTES,
  CASE_ID_PATTERN,
  GENERIC_THROTTLE_TARGET_MS,
  LISTEN_ADDRESS,
  SAFE_EGRESS_EXPECTED_DENY_CLASS,
  SAFE_EGRESS_FIXTURE_FAMILY,
  SAFE_EGRESS_MEDIA_URL,
  createFixtureService,
} from "../deploy/acceptance/ytdlp-generic/fixtures/server.mjs";

/**
 * A stand-in for the generated fixture MP4.
 *
 * The tests assert byte identity and digest identity, and both are properties of
 * "whatever buffer the operator supplied" rather than of these particular bytes,
 * so a synthetic buffer exercises them exactly as a real MP4 would — without
 * making the suite depend on Docker or FFmpeg. The real media's shape is pinned
 * separately, by `prepare-media.mjs` and the codec declaration test below.
 */
const MEDIA = Buffer.from("\x00\x00\x00\x18ftypmp42fixture-media-body-0123456789", "binary");
const MEDIA_SHA256 = createHash("sha256").update(MEDIA).digest("hex");

const CASE_A = "0123456789abcdef0123456789abcdef";
const CASE_B = "fedcba9876543210fedcba9876543210";

/** Every started service, torn down after the suite whatever happens. */
const started = [];

/**
 * Starts a fixture on an ephemeral loopback port.
 *
 * `log` is silenced: the fixture's own logging is asserted by inspection of its
 * sanitized event shape, not by scraping stdout during a test run.
 */
async function startFixture(overrides = {}) {
  const service = createFixtureService({
    media: MEDIA,
    mediaPath: "/dev/null/fixture.mp4",
    log: () => {},
    genericThrottleMs: 400,
    genericThrottleTickMs: 100,
    byteLimitTotalBytes: 256 * 1024,
    byteLimitBlockBytes: 16 * 1024,
    ...overrides,
  });
  const address = await service.listen(0);
  started.push(service);
  return {
    service,
    address,
    base: `http://${LISTEN_ADDRESS}:${address.port}`,
  };
}

after(async () => {
  await Promise.all(started.map((service) => service.close()));
});

describe("acceptance fixture: exposure surface", () => {
  let fx;
  before(async () => {
    fx = await startFixture();
  });

  it("binds loopback only", () => {
    assert.equal(fx.address.address, LISTEN_ADDRESS);
    assert.equal(LISTEN_ADDRESS, "127.0.0.1");
    assert.notEqual(fx.address.address, "0.0.0.0");
    assert.notEqual(fx.address.address, "::");
  });

  it("answers health without touching fixture state", async () => {
    const res = await fetch(`${fx.base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: "videofetch-acceptance-fixture" });
    assert.equal(fx.service.caseCount(), 0);
  });

  it("404s every route outside the closed set", async () => {
    const unknown = [
      "/",
      "/index.html",
      "/all",
      "/debug",
      "/state",
      "/requests",
      "/favicon.ico",
      "/media",
      "/direct.mp4.bak",
      "/byte-evidence/all",
    ];
    for (const route of unknown) {
      const res = await fetch(`${fx.base}${route}`);
      assert.equal(res.status, 404, `${route} must not be served`);
    }
  });

  it("serves no file the request names — path traversal has nothing to traverse", async () => {
    // Encoded and unencoded, absolute and relative, inside and outside the
    // repository. None of these is a route, and no route maps a request string
    // to a filesystem read, so every one of them is an ordinary 404.
    const traversals = [
      "/../../../../etc/passwd",
      "/..%2f..%2f..%2fetc%2fpasswd",
      "/direct.mp4/../../etc/passwd",
      "/%2e%2e/%2e%2e/etc/shadow",
      "/direct.mp4%00.txt",
      "/deploy/acceptance/ytdlp-generic/acceptance.mjs",
      "/proc/self/environ",
    ];
    for (const route of traversals) {
      const res = await fetch(`${fx.base}${route}`, { redirect: "manual" });
      assert.equal(res.status, 404, `${route} must not resolve to a file`);
      const body = await res.text();
      assert.equal(body.trim(), "not found");
    }
  });

  it("matches the route table on the normalized path, not on a raw string", async () => {
    // `/./direct.mp4` is not a traversal: both the client and the fixture's own
    // `new URL(...)` resolve it to `/direct.mp4`, which IS a route. Recording
    // that here keeps the previous test honest about what it proves — the route
    // table is consulted with a normalized pathname, so a dot segment can only
    // ever reach a route that already exists, never a file outside the table.
    const res = await fetch(`${fx.base}/./direct.mp4`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
  });

  it("405s unsupported methods on every known route", async () => {
    const cases = [
      ["/healthz", "POST"],
      ["/direct.mp4", "POST"],
      ["/direct.mp4", "DELETE"],
      ["/generic", "PUT"],
      ["/generic-media.mp4", "POST"],
      [`/byte-limit?vf_case=${CASE_A}`, "POST"],
      [`/byte-limit-media.mp4?vf_case=${CASE_A}`, "PUT"],
      [`/byte-evidence?vf_case=${CASE_A}`, "POST"],
      // The evidence route is GET-only: even HEAD is refused, so there is one
      // way to ask and one shape of answer.
      [`/byte-evidence?vf_case=${CASE_A}`, "HEAD"],
      ["/safe-egress", "DELETE"],
    ];
    for (const [route, method] of cases) {
      const res = await fetch(`${fx.base}${route}`, { method });
      assert.equal(res.status, 405, `${method} ${route}`);
      assert.match(res.headers.get("allow") ?? "", /GET/);
    }
    assert.equal(fx.service.caseCount(), 0, "a refused method must not create case state");
  });
});

describe("acceptance fixture: direct-media control fixture", () => {
  let fx;
  before(async () => {
    fx = await startFixture();
  });

  it("serves the exact bytes, length, type and digest", async () => {
    const res = await fetch(`${fx.base}/direct.mp4`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-length"), String(MEDIA.byteLength));
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.byteLength, MEDIA.byteLength);
    assert.ok(body.equals(MEDIA), "the served bytes must be the fixture bytes");
    assert.equal(createHash("sha256").update(body).digest("hex"), MEDIA_SHA256);
  });

  it("answers HEAD with the same length and type", async () => {
    // The Worker's direct analyzer reads `Content-Type` and `Content-Length`
    // from a HEAD and never fetches the body during analyze, so HEAD here is a
    // requirement rather than a convenience.
    const res = await fetch(`${fx.base}/direct.mp4`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-length"), String(MEDIA.byteLength));
  });

  it("reports the digest of the media it will actually serve", async () => {
    const manifest = fx.service.manifest();
    assert.equal(manifest.directBytes, MEDIA.byteLength);
    assert.equal(manifest.directSha256, MEDIA_SHA256);

    const served = Buffer.from(await (await fetch(`${fx.base}/direct.mp4`)).arrayBuffer());
    assert.equal(createHash("sha256").update(served).digest("hex"), manifest.directSha256);
  });

  it("declares no range support and ignores a Range request deterministically", async () => {
    // Verified against the pinned yt-dlp 2026.08.19 native downloader, which
    // issued no `Range` on any fixture route (it sends `Accept-Encoding:
    // identity` and a plain GET). Rather than implement an unused partial-content
    // path, the fixture declares `accept-ranges: none` and answers the whole
    // object — one response shape, whatever the client asks for.
    const res = await fetch(`${fx.base}/direct.mp4`, { headers: { range: "bytes=0-9" } });
    assert.equal(res.status, 200, "no 206 path exists");
    assert.equal(res.headers.get("accept-ranges"), "none");
    assert.equal(res.headers.get("content-range"), null);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(MEDIA));
  });
});

describe("acceptance fixture: generic progressive fixture", () => {
  let fx;
  before(async () => {
    fx = await startFixture();
  });

  it("references exactly one relative media route and nothing else", async () => {
    const html = await (await fetch(`${fx.base}/generic`)).text();
    const sources = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sources, ["/generic-media.mp4"]);

    // Single item: one media element, one rendition.
    assert.equal((html.match(/<video/g) ?? []).length, 1);
    assert.equal((html.match(/<source/g) ?? []).length, 1);

    // No adaptive-streaming reference of any kind can appear on this page.
    for (const token of ["m3u8", "mpd", "manifest", "dash", "hls"]) {
      assert.ok(!html.toLowerCase().includes(token), `page must not mention ${token}`);
    }
  });

  it("declares the codecs the media generation recipe actually produces", async () => {
    // The declaration is what makes the extracted format describe a muxed mp4
    // rather than one with unknown codecs, so it must stay true. `avc1.42E01E`
    // is H.264 baseline level 3.0 and `mp4a.40.2` is AAC-LC — exactly what
    // `prepare-media.mjs` encodes.
    const html = await (await fetch(`${fx.base}/generic`)).text();
    assert.match(html, /type='video\/mp4; codecs="avc1\.42E01E, mp4a\.40\.2"'/);

    const recipe = ffmpegArgs("/out/x.mp4").join(" ");
    assert.match(recipe, /-c:v libx264/);
    assert.match(recipe, /-profile:v baseline/);
    assert.match(recipe, /-level 3\.0/);
    assert.match(recipe, /-c:a aac/);
  });

  it("never reflects the submitted query into the media destination", async () => {
    // The generic success case submits this page carrying the harness's inert
    // sentinel. A page that echoed the query (or the Host, or any other request
    // header) into an absolute media URL would carry that sentinel onward into
    // a media request — the exact leak the sentinel sweep exists to detect.
    const sentinel = "VF_ACCEPT_SECRET_deadbeefdeadbeefdeadbeefdeadbeef";
    const html = await (
      await fetch(`${fx.base}/generic?vf_accept=${sentinel}&x=1`, {
        headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" },
      })
    ).text();
    assert.ok(!html.includes(sentinel), "the sentinel must not appear in the page");
    assert.ok(!html.includes("attacker.example"), "no request header may reach the page");
    assert.ok(html.includes('src="/generic-media.mp4"'));
  });

  it("serves the media bytes exactly, unchanged by throttling", async () => {
    const res = await fetch(`${fx.base}/generic-media.mp4`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-length"), String(MEDIA.byteLength));
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(MEDIA), "throttling must change timing only, never content");
    assert.equal(createHash("sha256").update(body).digest("hex"), MEDIA_SHA256);
  });

  it("actually delays completion, within a bounded tolerance", async () => {
    // The cancellation and shutdown cases need a real window in which the job
    // is still `downloading`. A fixture that completed instantly would make
    // those cases unobservable, so the delay is asserted, not assumed.
    const slow = await startFixture({ genericThrottleMs: 900, genericThrottleTickMs: 100 });
    const startedAt = Date.now();
    const body = Buffer.from(await (await fetch(`${slow.base}/generic-media.mp4`)).arrayBuffer());
    const elapsed = Date.now() - startedAt;

    assert.ok(body.equals(MEDIA), "a throttled transfer still delivers every byte");
    // 9 ticks of 100 ms with 8 sleeps between them: comfortably over 500 ms and
    // nowhere near a stall. The upper bound keeps a regression that dropped the
    // throttle entirely, and one that made it unboundedly slow, both visible.
    assert.ok(elapsed >= 500, `expected a real delay, got ${elapsed}ms`);
    assert.ok(elapsed < 10_000, `expected a bounded delay, got ${elapsed}ms`);
  });

  it("defaults to a cancellation window on the order of ten seconds", () => {
    assert.ok(GENERIC_THROTTLE_TARGET_MS >= 10_000);
    assert.ok(GENERIC_THROTTLE_TARGET_MS <= 20_000);
  });
});

describe("acceptance fixture: byte-limit correlation grammar", () => {
  let fx;
  before(async () => {
    fx = await startFixture();
  });

  it("uses the harness's own 128-bit grammar, exactly", () => {
    assert.equal(CASE_ID_PATTERN.source, HARNESS_CASE_ID_PATTERN.source);
    assert.equal(CASE_ID_PATTERN.flags, HARNESS_CASE_ID_PATTERN.flags);
    assert.equal(CASE_ID_PATTERN.source, "^[0-9a-f]{32}$");
  });

  it("rejects every id that is not exactly 32 lowercase hex characters", async () => {
    const bad = [
      "",
      "0123456789abcdef0123456789abcde", // 31
      "0123456789abcdef0123456789abcdef0", // 33
      "0123456789ABCDEF0123456789ABCDEF", // uppercase is NOT normalized
      "0123456789abcdef0123456789abcdeg", // non-hex
      " 0123456789abcdef0123456789abcdef", // not trimmed
      "0123456789abcdef0123456789abcdef ",
    ];
    for (const value of bad) {
      for (const route of ["/byte-limit", "/byte-limit-media.mp4", "/byte-evidence"]) {
        const res = await fetch(`${fx.base}${route}?vf_case=${encodeURIComponent(value)}`);
        assert.equal(res.status, 400, `${route} must refuse '${value}'`);
      }
    }
    assert.equal(fx.service.caseCount(), 0, "a refused id must not create case state");
  });

  it("refuses a missing, repeated or accompanied vf_case", async () => {
    const ambiguous = [
      "", // absent
      `?vf_case=${CASE_A}&vf_case=${CASE_B}`, // which case is this?
      `?vf_case=${CASE_A}&vf_extra=1`, // §12: no second parameter
      `?vf_accept=x&vf_case=${CASE_A}`,
    ];
    for (const query of ambiguous) {
      const res = await fetch(`${fx.base}/byte-limit${query}`);
      assert.equal(res.status, 400, `byte-limit${query} must be refused`);
    }
    assert.equal(fx.service.caseCount(), 0);
  });

  it("carries the submitted id into the media URL verbatim", async () => {
    const html = await (await fetch(`${fx.base}/byte-limit?vf_case=${CASE_A}`)).text();
    const sources = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sources, [`/byte-limit-media.mp4?vf_case=${CASE_A}`]);
    // Not re-minted, not re-encoded, not folded into another case.
    assert.ok(html.includes(CASE_A));
    assert.ok(!html.includes(CASE_B));
    // Fetching the PAGE is not the transfer under test.
    assert.equal(fx.service.caseCount(), 0);
  });
});

describe("acceptance fixture: byte-limit transfer semantics", () => {
  it("serves the media with no Content-Length, chunked", async () => {
    const fx = await startFixture();
    const res = await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    // The whole point: a declared length would let yt-dlp's own `--max-filesize`
    // stop the transfer, making the case evidence for the wrong gate.
    assert.equal(res.headers.get("content-length"), null);
    assert.equal(res.headers.get("transfer-encoding"), "chunked");
    await res.arrayBuffer();
  });

  it("can exceed the deployed 500 MiB limit by default, without allocating it", () => {
    const fx = createFixtureService({ media: MEDIA, log: () => {} });
    assert.equal(BYTE_LIMIT_TOTAL_BYTES, 528 * 1024 * 1024);
    assert.ok(BYTE_LIMIT_TOTAL_BYTES > 500 * 1024 * 1024, "must be able to cross the deployed limit");
    assert.ok(BYTE_LIMIT_TOTAL_BYTES <= 540 * 1024 * 1024, "no larger than the case needs");
    assert.equal(fx.manifest().byteLimitMaxBytes, BYTE_LIMIT_TOTAL_BYTES);
    // The ceiling is produced incrementally from one small reused block; the
    // service holds the fixture media and nothing proportional to the ceiling.
    assert.ok(process.memoryUsage().heapUsed < BYTE_LIMIT_TOTAL_BYTES);
  });

  it("starts the stream with the real media bytes", async () => {
    const fx = await startFixture({ byteLimitTotalBytes: MEDIA.byteLength + 1024 });
    const body = Buffer.from(
      await (await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`)).arrayBuffer(),
    );
    assert.ok(body.subarray(0, MEDIA.byteLength).equals(MEDIA));
    assert.equal(body.byteLength, MEDIA.byteLength + 1024);
  });

  it("counts exactly one media request per actual GET", async () => {
    const fx = await startFixture();
    await (await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`)).arrayBuffer();

    const evidence = await (await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_A}`)).json();
    assert.equal(evidence.caseId, CASE_A);
    assert.equal(evidence.actualMediaRequestObserved, true);
    assert.equal(evidence.mediaRequestCount, 1);
    assert.equal(evidence.contentLengthPresent, false);
    assert.equal(evidence.transferMode, "chunked");
  });

  it("reports a second GET honestly rather than clamping the count", async () => {
    // The harness refuses evidence whose `mediaRequestCount` is not 1, because
    // two transfers cannot be told apart. Hiding the second request would turn
    // an ambiguous run into a confident PASS.
    const fx = await startFixture();
    const url = `${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`;
    await (await fetch(url)).arrayBuffer();
    await (await fetch(url)).arrayBuffer();

    const evidence = await (await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_A}`)).json();
    assert.equal(evidence.mediaRequestCount, 2);
  });

  it("never counts a HEAD as the media request", async () => {
    const fx = await startFixture();
    const head = await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), null);

    // No case exists yet: a probe is not a transfer.
    assert.equal(fx.service.caseCount(), 0);
    assert.equal((await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_A}`)).status, 404);

    // And after a real GET, the earlier HEAD has added nothing.
    await (await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`)).arrayBuffer();
    const evidence = await (await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_A}`)).json();
    assert.equal(evidence.mediaRequestCount, 1);
  });

  it("does not count a page fetch, a health check or an evidence call", async () => {
    const fx = await startFixture();
    await fetch(`${fx.base}/healthz`);
    await fetch(`${fx.base}/byte-limit?vf_case=${CASE_A}`);
    await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_A}`);
    await fetch(`${fx.base}/favicon.ico`);
    assert.equal(fx.service.caseCount(), 0);

    await (await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`)).arrayBuffer();
    const evidence = await (await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_A}`)).json();
    assert.equal(evidence.mediaRequestCount, 1);
  });
});

describe("acceptance fixture: per-case evidence", () => {
  it("reports the bytes it actually served, not the ceiling", async () => {
    const ceiling = 256 * 1024;
    const fx = await startFixture({ byteLimitTotalBytes: ceiling });
    await (await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`)).arrayBuffer();

    const evidence = await (await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_A}`)).json();
    assert.equal(evidence.bytesServed, ceiling);
  });

  it("reports fewer bytes when the peer closes the connection early", async () => {
    // This is the shape a real byte-limit case produces: the Worker's byte
    // watcher aborts the transfer, and the fixture must report what it managed
    // to serve rather than what it intended to.
    const ceiling = 64 * 1024 * 1024;
    const fx = await startFixture({ byteLimitTotalBytes: ceiling, byteLimitBlockBytes: 16 * 1024 });
    const controller = new AbortController();
    const res = await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_B}`, {
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const evidence = await (await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_B}`)).json();
    assert.equal(evidence.actualMediaRequestObserved, true);
    assert.equal(evidence.mediaRequestCount, 1);
    assert.ok(evidence.bytesServed > 0, "some bytes were served");
    assert.ok(
      evidence.bytesServed < ceiling,
      `an aborted transfer must report less than the ceiling, got ${evidence.bytesServed}`,
    );
  });

  it("keeps two cases entirely separate", async () => {
    const fx = await startFixture({ byteLimitTotalBytes: 32 * 1024 });
    await (await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`)).arrayBuffer();
    await (await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_B}`)).arrayBuffer();

    const a = await (await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_A}`)).json();
    const b = await (await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_B}`)).json();
    assert.equal(a.caseId, CASE_A);
    assert.equal(b.caseId, CASE_B);
    assert.equal(a.mediaRequestCount, 1);
    assert.equal(b.mediaRequestCount, 1);
    assert.equal(a.bytesServed, 32 * 1024);
    assert.equal(b.bytesServed, 32 * 1024);
  });

  it("404s an unknown case instead of answering with a default", async () => {
    const fx = await startFixture();
    const res = await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_B}`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.actualMediaRequestObserved, false);
    assert.equal(body.caseId, CASE_B);
  });

  it("exposes only the fixture's own measurements", async () => {
    const fx = await startFixture({ byteLimitTotalBytes: 32 * 1024 });
    await fetch(`${fx.base}/byte-limit-media.mp4?vf_case=${CASE_A}`, {
      headers: {
        cookie: "session=super-secret",
        authorization: "Bearer super-secret",
        "user-agent": "acceptance-probe/1.0",
        "cf-connecting-ip": "203.0.113.7",
      },
    }).then((r) => r.arrayBuffer());

    const res = await fetch(`${fx.base}/byte-evidence?vf_case=${CASE_A}`);
    const evidence = await res.json();

    // An exact key set: a future field cannot be added without this failing.
    assert.deepEqual(Object.keys(evidence).sort(), [
      "actualMediaRequestObserved",
      "bytesServed",
      "caseId",
      "contentLengthPresent",
      "mediaRequestCount",
      "observedAt",
      "transferMode",
    ]);

    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      "super-secret",
      "Bearer",
      "acceptance-probe",
      "203.0.113.7",
      "127.0.0.1",
      "http://",
      "https://",
      "byte-limit-media",
      "cookie",
      "authorization",
    ]) {
      assert.ok(!serialized.includes(forbidden), `evidence must not carry '${forbidden}'`);
    }
    assert.match(evidence.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("acceptance fixture: safe-egress fixture", () => {
  let fx;
  before(async () => {
    fx = await startFixture();
  });

  it("points at exactly the fixed private-v4 destination", async () => {
    const html = await (await fetch(`${fx.base}/safe-egress`)).text();
    const sources = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sources, [SAFE_EGRESS_MEDIA_URL]);
    assert.equal(SAFE_EGRESS_MEDIA_URL, "http://10.255.255.1/videofetch-denied.mp4");

    // A literal RFC1918 address, never a name: a hostname would make the
    // destination depend on what the designated resolver answered at run time.
    const host = new URL(SAFE_EGRESS_MEDIA_URL).hostname;
    assert.match(host, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.match(host, /^10\./, "must be inside 10.0.0.0/8");
  });

  it("cannot be redirected by anything the operator or a request supplies", async () => {
    const attempts = [
      "?url=http://192.0.2.9/evil.mp4",
      "?media=http://192.0.2.9/evil.mp4",
      "?vf_case=" + CASE_A,
      "?target=10.0.0.1",
      "?redirect=1",
    ];
    for (const query of attempts) {
      const html = await (
        await fetch(`${fx.base}/safe-egress${query}`, {
          headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" },
        })
      ).text();
      const sources = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(sources, [SAFE_EGRESS_MEDIA_URL], `query ${query} must not move the target`);
      assert.ok(!html.includes("192.0.2.9"));
      assert.ok(!html.includes("attacker.example"));
    }
  });

  it("expects the deny rule its fixture family maps to", () => {
    // Chosen from the fixture family, before any run — never by looking at
    // which counter happened to move.
    assert.equal(SAFE_EGRESS_FIXTURE_FAMILY, "private-v4");
    assert.equal(SAFE_EGRESS_EXPECTED_DENY_CLASS, "deny-v4");
    assert.equal(EGRESS_FIXTURE_CLASSES[SAFE_EGRESS_FIXTURE_FAMILY], SAFE_EGRESS_EXPECTED_DENY_CLASS);
  });

  it("is a generic page, not a direct media URL", async () => {
    // The Worker's direct extractor claims any URL whose path carries a media
    // extension. `/safe-egress` has none, so analysis reaches the generic path —
    // which is what makes this case evidence about generic egress at all.
    const res = await fetch(`${fx.base}/safe-egress`);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    assert.ok(!new URL(`${fx.base}/safe-egress`).pathname.includes("."));
  });
});

describe("acceptance fixture: startup manifest", () => {
  it("states the routes and the frozen expectations, and no secret", async () => {
    const fx = await startFixture();
    const manifest = fx.service.manifest();

    assert.equal(manifest.listenAddress, "127.0.0.1");
    assert.equal(typeof manifest.listenPort, "number");
    assert.equal(manifest.directPath, "/direct.mp4");
    assert.equal(manifest.genericPath, "/generic");
    assert.equal(manifest.byteLimitPath, "/byte-limit");
    assert.equal(manifest.byteEvidencePath, "/byte-evidence");
    assert.equal(manifest.safeEgressPath, "/safe-egress");
    assert.equal(manifest.safeEgressExpectedDenyClass, "deny-v4");
    assert.equal(manifest.directSha256, MEDIA_SHA256);

    const serialized = JSON.stringify(manifest).toLowerCase();
    for (const forbidden of ["secret", "token", "password", "credential", "authorization", "cookie"]) {
      assert.ok(!serialized.includes(forbidden), `manifest must not mention '${forbidden}'`);
    }
    // The only path it may name is the media file the operator supplied.
    assert.equal(manifest.mediaPath, "/dev/null/fixture.mp4");
  });

  it("refuses to start without media", () => {
    assert.throws(() => createFixtureService({ media: Buffer.alloc(0) }), /non-empty Buffer/);
    assert.throws(() => createFixtureService({ media: "not a buffer" }), /non-empty Buffer/);
  });
});
