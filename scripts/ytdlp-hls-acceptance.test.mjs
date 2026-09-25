// Self-tests for the HLS-08 deterministic clear-HLS acceptance harness.
//
// These prove the HARNESS, not the product. They spawn no container, no
// FFmpeg, no ffprobe and no yt-dlp, and reach no network: everything here is
// pure argv/document construction, deterministic fakes, or a loopback HTTP
// server driven through the Product's REAL safe-HTTP module and the
// acceptance transport. The full-path acceptance itself is a separate,
// explicitly invoked run — `deploy/acceptance/ytdlp-generic/run-hls-acceptance.mjs`.
//
// Product modules that use the repository's `@/` import alias are loaded with
// dynamic `import()` after the alias hooks are registered, because static
// imports are resolved before any module body runs.

import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppError } from "../src/lib/errors.ts";
import {
  ClearHlsPlaylistError,
  parseClearHlsMediaPlaylist,
} from "../src/worker/hls/hls-media-playlist.ts";
import {
  HLS08_PRIVATE_MARKERS,
  HLS08_PRIVATE_MARKER_PREFIX,
  HLS08_RAW_FORMAT_ID,
  HLS08_RAW_FORMAT_NAME,
  HLS_FIXTURE_HOSTNAME,
  HLS_FIXTURE_LOOPBACK,
  HLS_MASTER_ROUTE,
  HLS_MEDIA_ROUTE,
  HLS_PAGE_ROUTE,
  HLS_SYNTHETIC_PUBLIC_ADDRESS,
  classifyHlsFixturePath,
  createHlsPageUrlValidator,
  hlsPageUrl,
  mediaPlaylistUri,
  nearbyPageUrlAlternatives,
} from "../deploy/acceptance/ytdlp-generic/lib/hls-fixture-url.mjs";
import {
  EXPECTED_REQUEST_HEADER_NAMES,
  HlsTransportRefusal,
  PRODUCT_ACCEPT,
  PRODUCT_USER_AGENT,
  createEventClock,
  createHlsSafeHttpTransport,
  withHlsSafeHttpTransport,
} from "../deploy/acceptance/ytdlp-generic/lib/hls-safe-http-transport.mjs";
import {
  HLS08_ACCEPTED_BASE,
  HLS08_CONTAINER_REPORT_DIR,
  HLS08_FIXTURE_HOST_MAPPING,
  HLS08_OVERLAY_COPIED_PATHS,
  assertNonDeployableTag,
  hlsAcceptanceRunArgs,
  hlsOverlayBuildArgs,
  hlsOverlayDockerfile,
  hlsOverlayImageTag,
  hlsRunPostureViolations,
} from "../deploy/acceptance/ytdlp-generic/lib/hls-container.mjs";
import { OVERLAY_COPIED_PATHS } from "../deploy/acceptance/ytdlp-generic/lib/split-container.mjs";
import {
  OVERLAY_RUNTIME_COMPATIBILITY_FILES,
  ProvenanceError,
} from "../deploy/acceptance/ytdlp-generic/lib/split-provenance.mjs";
import {
  HLS08_EVIDENCE_SCHEMA,
  HLS08_FORBIDDEN_EVIDENCE_SUBSTRINGS,
  HLS08_MANDATORY_CHECKS,
  buildHlsEvidence,
  findForbiddenSubstring,
  renderHlsEvidence,
  unmetPassConditions,
  validateHlsEvidenceRecord,
} from "../deploy/acceptance/ytdlp-generic/lib/hls-evidence.mjs";
import {
  HLS_AGGREGATE_FILE_NAME,
  HLS_OUTPUT_FILE_NAME,
  HLS_OUTPUT_PARTIAL_FILE_NAME,
  classifyProductSpawn,
  createProcessObserver,
  evaluateHlsRemuxArgv,
  inputOperand,
  scanPrivacySurfaces,
  unadmittedHostnameOccurrences,
  withProcessObserver,
} from "../deploy/acceptance/ytdlp-generic/lib/hls-observers.mjs";
import {
  HLS_FAILING_FRAGMENT,
  HLS_FIXTURE_SPEC,
  encryptedMediaPlaylist,
  fragmentFailureMediaPlaylist,
  hlsFixtureFfmpegArgs,
  hlsFixturePage,
  hlsMasterPlaylist,
} from "../deploy/acceptance/ytdlp-generic/fixtures/hls-media.mjs";
import { createHlsFixtureService } from "../deploy/acceptance/ytdlp-generic/fixtures/hls-server.mjs";
import {
  evidenceNameFor,
  parseArgv as parseDriverArgv,
  runHlsAcceptance,
} from "../deploy/acceptance/ytdlp-generic/run-hls-acceptance.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const TREE = "89abcdef0123456789abcdef0123456789abcdef";
const BASE_SOURCE = HLS08_ACCEPTED_BASE.sourceCommit;
const BASE_DIGEST = HLS08_ACCEPTED_BASE.imageDigest;
const BASE_IMAGE = HLS08_ACCEPTED_BASE.retainedTag;
const OVERLAY_ID = `sha256:${"e".repeat(64)}`;
const REPORT = "/var/tmp/hls08";

/** An FFmpeg-shaped VOD playlist, as the pinned muxer writes it. */
const FFMPEG_SHAPED_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PLAYLIST-TYPE:VOD",
  "#EXTINF:2.000000,",
  "seg-0.ts",
  "#EXTINF:2.000000,",
  "seg-1.ts",
  "#EXTINF:2.000000,",
  "seg-2.ts",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

let safeHttp;
let hlsProcessing;
before(async () => {
  await import("./register-ts-aliases.mjs");
  safeHttp = await import("../src/lib/security/safe-http.server.ts");
  hlsProcessing = await import("../src/worker/hls/hls-processing.server.ts");
});

// ── fixture addressing ─────────────────────────────────────────────────────

describe("hls fixture addressing", () => {
  it("names one public-looking .invalid hostname, never loopback or a private literal", () => {
    assert.equal(HLS_FIXTURE_HOSTNAME, "hls-fixture.example.invalid");
    assert.ok(HLS_FIXTURE_HOSTNAME.endsWith(".invalid"));
    for (const bad of ["localhost", ".local", ".internal", "127.", "10.", "192.168."]) {
      assert.ok(!HLS_FIXTURE_HOSTNAME.includes(bad), bad);
    }
    assert.equal(hlsPageUrl(40123), `http://hls-fixture.example.invalid:40123${HLS_PAGE_ROUTE}`);
  });

  it("the page is HTML, so it is not direct media", () => {
    assert.ok(HLS_PAGE_ROUTE.endsWith(".html"));
  });

  it("classifies every declared route and refuses near misses", () => {
    assert.equal(classifyHlsFixturePath(HLS_PAGE_ROUTE).kind, "page");
    assert.equal(classifyHlsFixturePath(HLS_MASTER_ROUTE).kind, "master");
    for (const [variant, marker] of Object.entries(HLS08_PRIVATE_MARKERS)) {
      const c = classifyHlsFixturePath(`${HLS_MEDIA_ROUTE}?sig=${marker}`);
      assert.deepEqual([c.kind, c.variant], ["media", variant]);
    }
    assert.deepEqual(
      (({ kind, family, ordinal }) => ({ kind, family, ordinal }))(classifyHlsFixturePath("/hls08/seg-0.ts")),
      { kind: "fragment", family: "positive", ordinal: 1 },
    );
    assert.equal(classifyHlsFixturePath("/hls08/fail-seg-2.ts").family, "failure");
    assert.equal(classifyHlsFixturePath("/hls08/fail-seg-2.ts").ordinal, 3);
    for (const miss of [
      `${HLS_MEDIA_ROUTE}`,
      `${HLS_MEDIA_ROUTE}?sig=HLS08_PRIVATE_OTHER`,
      `${HLS_MEDIA_ROUTE}?sig=${HLS08_PRIVATE_MARKERS.execution}&x=1`,
      `${HLS_PAGE_ROUTE}?x=1`,
      "/hls08/seg-0.ts?x=1",
      "/hls08/seg-x.ts",
      "/hls08/../hls08/seg-0.mp4",
      "/etc/passwd",
      "relative/path",
      "",
    ]) {
      assert.equal(classifyHlsFixturePath(miss).kind, "unexpected", miss);
    }
  });

  it("the master's media URI carries exactly one marker in the sig parameter", () => {
    assert.equal(mediaPlaylistUri("execution"), `media.m3u8?sig=${HLS08_PRIVATE_MARKERS.execution}`);
    assert.throws(() => mediaPlaylistUri("toString"));
    assert.throws(() => mediaPlaylistUri("nope"));
    for (const marker of Object.values(HLS08_PRIVATE_MARKERS)) assert.ok(marker.startsWith(HLS08_PRIVATE_MARKER_PREFIX));
    assert.equal(HLS08_RAW_FORMAT_ID, `hls-${HLS08_RAW_FORMAT_NAME}`);
  });
});

describe("hls submitted-page validator", () => {
  it("admits exactly the runtime page URL and returns it canonically", async () => {
    const validate = createHlsPageUrlValidator({ port: 40123, AppError });
    assert.deepEqual(await validate(hlsPageUrl(40123)), { url: hlsPageUrl(40123), hostname: HLS_FIXTURE_HOSTNAME });
  });

  it("refuses every nearby alternative with the Production error", async () => {
    const validate = createHlsPageUrlValidator({ port: 40123, AppError });
    const alternatives = nearbyPageUrlAlternatives(40123);
    assert.ok(alternatives.length >= 12);
    for (const candidate of [...alternatives, "", 7, null]) {
      await assert.rejects(validate(candidate), (err) => err instanceof AppError && err.code === "INVALID_URL", String(candidate));
    }
  });

  it("needs the exact port and the Product error class", () => {
    assert.throws(() => createHlsPageUrlValidator({ port: 0, AppError }));
    assert.throws(() => createHlsPageUrlValidator({ port: 40123 }));
  });
});

// ── fixture media recipe ───────────────────────────────────────────────────

describe("hls fixture media recipe", () => {
  it("pins the determinism levers and the FFmpeg HLS muxer", () => {
    const args = hlsFixtureFfmpegArgs("/tmp/x");
    const pair = (a, b) => args.some((v, i) => v === a && args[i + 1] === b);
    assert.ok(pair("-threads", "1"));
    assert.ok(pair("-c:v", "libx264") && pair("-c:a", "aac"));
    assert.ok(pair("-f", "hls") && pair("-hls_playlist_type", "vod") && pair("-hls_segment_type", "mpegts"));
    assert.ok(pair("-hls_time", String(HLS_FIXTURE_SPEC.segmentSeconds)));
    assert.ok(pair("-sc_threshold", "0"));
    assert.ok(!args.includes("-hls_flags"), "no hls_flags: independent_segments would leave the HLS-1 subset");
    assert.ok(!args.some((a) => a.includes("://")), "every input is a lavfi generator");
    assert.equal(args.filter((a) => a === "lavfi").length, 2);
    assert.equal(HLS_FIXTURE_SPEC.durationSeconds / HLS_FIXTURE_SPEC.segmentSeconds, HLS_FIXTURE_SPEC.segmentCount);
    assert.ok(HLS_FIXTURE_SPEC.segmentCount >= 3);
    assert.throws(() => hlsFixtureFfmpegArgs("relative"));
  });

  it("the master is ONE variant with a conspicuous NAME, 640x360 and avc1+mp4a codecs", () => {
    const master = hlsMasterPlaylist({ mediaUri: mediaPlaylistUri("browser") });
    const lines = master.trim().split("\n");
    assert.equal(lines.filter((l) => l.startsWith("#EXT-X-STREAM-INF")).length, 1);
    assert.match(master, new RegExp(`NAME="${HLS08_RAW_FORMAT_NAME}"`));
    assert.match(master, /RESOLUTION=640x360/);
    assert.match(master, /CODECS="avc1\.[0-9a-f]+,mp4a\.40\.2"/);
    assert.equal(lines.at(-1), mediaPlaylistUri("browser"));
    assert.throws(() => hlsMasterPlaylist({ mediaUri: "a\nb" }));
  });

  it("the page names the master through an ordinary HTML5 source", () => {
    assert.match(hlsFixturePage(), new RegExp(`<source src="${HLS_MASTER_ROUTE}" type="application/x-mpegURL">`));
  });

  it("an FFmpeg-shaped VOD playlist is inside the Product's HLS-1 subset", () => {
    const parsed = parseClearHlsMediaPlaylist(FFMPEG_SHAPED_PLAYLIST);
    assert.equal(parsed.fragmentCount, 3);
  });

  it("the encrypted negative differs by exactly one key line and HLS-1 refuses it as encrypted", () => {
    const encrypted = encryptedMediaPlaylist(FFMPEG_SHAPED_PLAYLIST);
    const added = encrypted.split("\n").filter((l) => !FFMPEG_SHAPED_PLAYLIST.split("\n").includes(l));
    assert.deepEqual(added, ['#EXT-X-KEY:METHOD=AES-128,URI="hls08-key.bin"']);
    assert.throws(
      () => parseClearHlsMediaPlaylist(encrypted),
      (err) => err instanceof ClearHlsPlaylistError && err.reason === "encrypted",
    );
  });

  it("the fragment-failure negative only renames segments and stays inside HLS-1", () => {
    const failing = fragmentFailureMediaPlaylist(FFMPEG_SHAPED_PLAYLIST);
    assert.deepEqual(
      failing.split("\n").filter((l) => l.endsWith(".ts")),
      ["fail-seg-0.ts", "fail-seg-1.ts", "fail-seg-2.ts"],
    );
    assert.equal(parseClearHlsMediaPlaylist(failing).fragmentCount, 3);
    assert.deepEqual({ ...HLS_FAILING_FRAGMENT }, { ordinal: 2, status: 503 });
  });
});

// ── fixture server ─────────────────────────────────────────────────────────

describe("hls fixture server", () => {
  let service;
  let port;
  const clock = createEventClock();
  before(async () => {
    const playlist = Buffer.from(FFMPEG_SHAPED_PLAYLIST);
    service = createHlsFixtureService({
      page: Buffer.from(hlsFixturePage()),
      masterFor: (variant) => Buffer.from(hlsMasterPlaylist({ mediaUri: mediaPlaylistUri(variant) })),
      mediaPlaylists: { browser: playlist, execution: playlist },
      fragments: { "positive:1": Buffer.from("one"), "failure:1": Buffer.from("one") },
      failingFragments: { "failure:2": 503 },
      eventClock: clock,
      initialMasterVariant: "browser",
    });
    ({ port } = await service.listen());
  });
  after(async () => {
    await service.close();
  });

  const get = (path, method = "GET", headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: HLS_FIXTURE_LOOPBACK, port, path, method, headers: { host: `${HLS_FIXTURE_HOSTNAME}:${port}`, ...headers } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end();
    });

  it("binds loopback only", () => {
    assert.equal(service.listenAddress(), HLS_FIXTURE_LOOPBACK);
  });

  it("rotates the master between variants without changing the page", async () => {
    service.setPhase("rotation");
    const a = await get(HLS_MASTER_ROUTE);
    service.setMasterVariant("execution");
    const b = await get(HLS_MASTER_ROUTE);
    assert.match(a.body, new RegExp(HLS08_PRIVATE_MARKERS.browser));
    assert.match(b.body, new RegExp(HLS08_PRIVATE_MARKERS.execution));
    const served = service.requests().filter((r) => r.phase === "rotation").map((r) => r.masterServedVariant);
    assert.deepEqual(served, ["browser", "execution"]);
    assert.throws(() => service.setMasterVariant("encrypted"), /unknown/);
  });

  it("refuses HEAD, unknown routes and an unknown marker, and records them", async () => {
    service.setPhase("refusals");
    assert.equal((await get(HLS_PAGE_ROUTE, "HEAD")).status, 405);
    assert.equal((await get("/etc/passwd")).status, 404);
    assert.equal((await get(`${HLS_MEDIA_ROUTE}?sig=HLS08_PRIVATE_UNKNOWN`)).status, 404);
    assert.equal((await get("/hls08/fail-seg-1.ts")).status, 503);
    const kinds = service.requests().filter((r) => r.phase === "refusals").map((r) => `${r.method}:${r.kind}:${r.status}`);
    assert.deepEqual(kinds, ["HEAD:page:405", "GET:unexpected:404", "GET:unexpected:404", "GET:fragment:503"]);
  });

  it("records header booleans and sequence numbers, never URLs or values", async () => {
    service.setPhase("headers");
    await get("/hls08/seg-0.ts", "GET", { "user-agent": PRODUCT_USER_AGENT, accept: PRODUCT_ACCEPT, cookie: "a=b" });
    const [entry] = service.requests().filter((r) => r.phase === "headers");
    assert.equal(entry.userAgentClass, "product");
    assert.equal(entry.acceptIsProduct, true);
    assert.equal(entry.hasCookie, true);
    assert.equal(entry.hostHeaderIsFixture, true);
    assert.ok(entry.finishSeq > entry.arriveSeq);
    assert.ok(!JSON.stringify(entry).includes("a=b"));
    assert.ok(!JSON.stringify(service.requests()).includes(HLS08_PRIVATE_MARKER_PREFIX));
  });
});

// ── the safe-HTTP acceptance transport ─────────────────────────────────────

describe("hls safe-http acceptance transport (real Product safe-HTTP)", () => {
  let server;
  let port;
  const served = [];
  before(async () => {
    server = createServer((req, res) => {
      served.push({ url: req.url, method: req.method, host: req.headers.host, headers: { ...req.headers } });
      const body = Buffer.from(req.url.includes("seg-") ? "fragment-bytes" : FFMPEG_SHAPED_PLAYLIST);
      res.writeHead(200, { "content-length": String(body.byteLength) });
      res.end(body);
    });
    await new Promise((r) => server.listen(0, HLS_FIXTURE_LOOPBACK, r));
    port = server.address().port;
  });
  after(async () => {
    safeHttp.setPinnedRequestFactoryForTests(null);
    safeHttp.setSafeHttpTestHooks(null);
    await new Promise((r) => server.close(r));
  });
  afterEach(() => {
    served.length = 0;
  });

  const setters = () => ({
    setSafeHttpTestHooks: safeHttp.setSafeHttpTestHooks,
    setPinnedRequestFactoryForTests: safeHttp.setPinnedRequestFactoryForTests,
  });
  const makeTransport = (overrides = {}) =>
    createHlsSafeHttpTransport({
      port,
      eventClock: createEventClock(),
      statusNow: () => "downloading",
      caseNow: () => "unit",
      realRequest: http.request.bind(http),
      ...overrides,
    });
  const readAll = async (body) => {
    const chunks = [];
    for await (const c of body) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  };
  const origin = () => `http://${HLS_FIXTURE_HOSTNAME}:${port}`;

  it("carries a real safeGet of the exact media route to the loopback server, unchanged", async () => {
    const transport = makeTransport();
    const text = await withHlsSafeHttpTransport(setters(), transport, async () => {
      const res = await safeHttp.safeGet(`${origin()}${HLS_MEDIA_ROUTE}?sig=${HLS08_PRIVATE_MARKERS.execution}`);
      assert.equal(res.status, 200);
      return readAll(res.body);
    });
    assert.equal(text, FFMPEG_SHAPED_PLAYLIST);
    assert.equal(served.length, 1);
    assert.equal(served[0].url, `${HLS_MEDIA_ROUTE}?sig=${HLS08_PRIVATE_MARKERS.execution}`);
    assert.equal(served[0].host, `${HLS_FIXTURE_HOSTNAME}:${port}`);
    assert.equal(served[0].headers["user-agent"], PRODUCT_USER_AGENT);
    const [entry] = transport.ledger();
    assert.equal(entry.kind, "media");
    assert.equal(entry.variant, "execution");
    assert.equal(entry.statusAtRequest, "downloading");
    assert.equal(entry.responseStatus, 200);
    assert.equal(entry.headerNamesExact, true);
    assert.deepEqual(entry.headerNames, [...EXPECTED_REQUEST_HEADER_NAMES]);
    assert.equal(entry.userAgentIsProduct && entry.acceptIsProduct, true);
    assert.deepEqual(entry.forbiddenHeadersPresent, []);
    assert.ok(entry.endSeq > entry.seq);
    assert.ok(!JSON.stringify(transport.ledger()).includes(HLS08_PRIVATE_MARKER_PREFIX));
    assert.equal(transport.lookupCounts().admitted, 1);
  });

  it("orders two sequential fragment GETs by open/end sequence", async () => {
    const transport = makeTransport();
    await withHlsSafeHttpTransport(setters(), transport, async () => {
      for (const n of [0, 1]) await readAll((await safeHttp.safeGet(`${origin()}/hls08/seg-${n}.ts`)).body);
    });
    const [a, b] = transport.ledger();
    assert.deepEqual([a.ordinal, b.ordinal], [1, 2]);
    assert.ok(b.seq > a.endSeq);
  });

  it("refuses another hostname at the DNS layer", async () => {
    const transport = makeTransport();
    await withHlsSafeHttpTransport(setters(), transport, async () => {
      await assert.rejects(safeHttp.safeGet(`http://other.example.invalid:${port}${HLS_MEDIA_ROUTE}`));
    });
    assert.equal(transport.lookupCounts().refused, 1);
    assert.equal(served.length, 0);
  });

  it("refuses another port, the page, the master, an unknown route and HEAD at the socket", async () => {
    const transport = makeTransport();
    await withHlsSafeHttpTransport(setters(), transport, async () => {
      for (const url of [
        `http://${HLS_FIXTURE_HOSTNAME}:${port + 1}${HLS_MEDIA_ROUTE}?sig=${HLS08_PRIVATE_MARKERS.execution}`,
        `${origin()}${HLS_PAGE_ROUTE}`,
        `${origin()}${HLS_MASTER_ROUTE}`,
        `${origin()}/hls08/hls08-key.bin`,
        `${origin()}/etc/passwd`,
      ]) {
        await assert.rejects(safeHttp.safeGet(url));
      }
      await assert.rejects(safeHttp.safeHead(`${origin()}/hls08/seg-0.ts`));
    });
    assert.equal(served.length, 0);
    assert.equal(transport.ledger().length, 0);
    assert.equal(transport.refusals().length, 6);
  });

  it("leaves the real private-address policy in force: a private answer is refused by the Product", async () => {
    const transport = makeTransport({ syntheticAddress: "10.0.0.1" });
    await withHlsSafeHttpTransport(setters(), transport, async () => {
      await assert.rejects(
        safeHttp.safeGet(`${origin()}${HLS_MEDIA_ROUTE}?sig=${HLS08_PRIVATE_MARKERS.execution}`),
        (err) => err?.code === "INVALID_URL",
      );
    });
    assert.equal(served.length, 0);
  });

  it("the synthetic answer is one the Product treats as public", () => {
    assert.equal(HLS_SYNTHETIC_PUBLIC_ADDRESS, "8.8.8.8");
  });

  it("always restores both Product hooks and disarms, even when the body throws", async () => {
    const transport = makeTransport();
    await assert.rejects(
      withHlsSafeHttpTransport(setters(), transport, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(transport.armed, false);
    // Restored: the real lookup is back, so the fixture name is no longer
    // answered with the synthetic address (it is .invalid: real DNS refuses it).
    const answer = await safeHttp.lookupHost(HLS_FIXTURE_HOSTNAME).catch(() => null);
    assert.ok(answer === null || answer.every((a) => a.address !== HLS_SYNTHETIC_PUBLIC_ADDRESS));
    assert.equal(transport.callsWhileDisarmed(), 0);
    await assert.rejects(transport.lookup(HLS_FIXTURE_HOSTNAME), HlsTransportRefusal);
    assert.equal(transport.callsWhileDisarmed(), 1);
  });

  it("clears the hooks in the fixed order with fake setters", async () => {
    const calls = [];
    const fake = {
      setSafeHttpTestHooks: (v) => calls.push(["lookup", v === null ? null : "set"]),
      setPinnedRequestFactoryForTests: (v) => calls.push(["factory", v === null ? null : "set"]),
    };
    const transport = makeTransport();
    await withHlsSafeHttpTransport(fake, transport, async () => {});
    assert.deepEqual(calls, [["lookup", "set"], ["factory", "set"], ["factory", null], ["lookup", null]]);
    await assert.rejects(withHlsSafeHttpTransport({}, transport, async () => {}));
  });
});

// ── process observation ────────────────────────────────────────────────────

describe("hls process observer and remux policy", () => {
  const tools = {
    ytdlpPython: "/usr/bin/python3",
    ytdlpArtifact: "/opt/yt-dlp/yt-dlp",
    ffmpegPath: "/usr/bin/ffmpeg",
    ffprobePath: "/usr/bin/ffprobe",
  };
  const work = "/tmp/videofetch/jobs/0123456789abcdef0123456789abcdef";
  const remuxArgs = () =>
    hlsProcessing.buildClearHlsRemuxArgs({
      sourcePath: `${work}/${HLS_AGGREGATE_FILE_NAME}`,
      outputPath: `${work}/${HLS_OUTPUT_PARTIAL_FILE_NAME}`,
    });

  it("the harness file names equal the Product's own constants", () => {
    assert.equal(HLS_OUTPUT_FILE_NAME, hlsProcessing.HLS_OUTPUT_FILE_NAME);
    assert.equal(HLS_OUTPUT_PARTIAL_FILE_NAME, hlsProcessing.HLS_OUTPUT_PARTIAL_FILE_NAME);
  });

  it("classifies every Product spawn kind", () => {
    const c = (command, args) => classifyProductSpawn({ command, args }, tools);
    assert.equal(c("/usr/bin/python3", ["/opt/yt-dlp/yt-dlp", "--ignore-config", "--version"]), "ytdlp-runtime-probe");
    assert.equal(c("/usr/bin/python3", ["/opt/yt-dlp/yt-dlp", "--dump-single-json", "--skip-download", "--", "u"]), "ytdlp-analysis");
    assert.equal(c("/usr/bin/python3", ["/opt/yt-dlp/yt-dlp", "--format=x", "--", "u"]), "ytdlp-other");
    assert.equal(c("/usr/bin/ffmpeg", ["-version"]), "ffmpeg-capability-probe");
    assert.equal(c("/usr/bin/ffmpeg", remuxArgs()), "hls-ffmpeg-remux");
    assert.equal(c("/usr/bin/ffmpeg", ["-i", "x", "-c:v", "libx264", "out.mp4"]), "ffmpeg-other");
    assert.equal(c("/usr/bin/ffprobe", ["-i", "x"]), "ffprobe-media-probe");
    assert.equal(c("/bin/sh", ["-c", "true"]), "other");
    assert.equal(inputOperand(remuxArgs()), `${work}/${HLS_AGGREGATE_FILE_NAME}`);
  });

  it("the Product's own remux builder satisfies every rule of the reviewed policy", () => {
    const { ok, facts } = evaluateHlsRemuxArgv(remuxArgs());
    assert.equal(ok, true, JSON.stringify(facts));
    assert.ok(Object.values(facts).every((v) => v === true));
    assert.ok(!JSON.stringify(facts).includes("/tmp/"));
  });

  it("any drift from a pure stream copy is caught", () => {
    const base = remuxArgs();
    const swap = (a, b) => base.map((x) => (x === a ? b : x));
    const mutations = {
      reencode: (() => {
        const m = [...base];
        m[m.indexOf("-c:v") + 1] = "libx264";
        return m;
      })(),
      overwrite: swap("-n", "-y"),
      noWhitelist: base.filter((x, i) => x !== "-protocol_whitelist" && base[i - 1] !== "-protocol_whitelist"),
      urlInput: base.map((x) => (x.endsWith(HLS_AGGREGATE_FILE_NAME) ? "http://example.invalid/a.ts" : x)),
      extraMap: [...base.slice(0, -1), "-map", "0:s:0", base.at(-1)],
      bsf: [...base.slice(0, -1), "-bsf:v", "h264_mp4toannexb", base.at(-1)],
      finalName: base.map((x) => (x.endsWith(HLS_OUTPUT_PARTIAL_FILE_NAME) ? `${work}/${HLS_OUTPUT_FILE_NAME}` : x)),
      noFaststart: base.filter((x, i) => x !== "-movflags" && base[i - 1] !== "-movflags"),
    };
    for (const [name, argv] of Object.entries(mutations)) {
      assert.equal(evaluateHlsRemuxArgv(argv).ok, false, name);
    }
  });

  it("the observer delegates the exact command, argv and options and records status", async () => {
    const delegated = [];
    const realSpawn = (command, args, options) => {
      delegated.push({ command, args, options });
      return { fake: true };
    };
    let status = "processing";
    const seen = [];
    const observer = createProcessObserver({
      realSpawn,
      classify: (command, args) => classifyProductSpawn({ command, args }, tools),
      statusNow: () => status,
      caseNow: () => "positive",
      eventClock: createEventClock(),
      beforeDelegate: (entry) => seen.push(entry.kind),
    });
    const args = remuxArgs();
    const options = { cwd: work, detached: true };
    const child = observer.spawn("/usr/bin/ffmpeg", args, options);
    assert.deepEqual(child, { fake: true });
    assert.equal(delegated[0].args, args, "the SAME argv array, not a copy");
    assert.equal(delegated[0].options, options);
    status = "downloading";
    observer.spawn("/usr/bin/ffprobe", ["-i", "x"], {});
    assert.deepEqual(observer.entries().map((e) => [e.kind, e.statusAtSpawn]), [
      ["hls-ffmpeg-remux", "processing"],
      ["ffprobe-media-probe", "downloading"],
    ]);
    assert.deepEqual(seen, ["hls-ffmpeg-remux", "ffprobe-media-probe"]);
    assert.ok(!JSON.stringify(observer.entries()).includes(work));
  });

  it("the process-runner hook is always cleared, even when the body throws", async () => {
    const calls = [];
    const observer = createProcessObserver({
      realSpawn: () => ({}),
      classify: () => "other",
      statusNow: () => "x",
      eventClock: createEventClock(),
    });
    await assert.rejects(
      withProcessObserver((v) => calls.push(v === null ? null : "set"), observer, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(calls, ["set", null]);
    observer.spawn("/bin/true", [], {});
    assert.equal(observer.spawnsWhileDisarmed(), 1);
  });
});

// ── privacy scanning ───────────────────────────────────────────────────────

describe("hls privacy scanning", () => {
  const opts = { hostname: HLS_FIXTURE_HOSTNAME, port: 40123, pageRoute: HLS_PAGE_ROUTE };
  const page = hlsPageUrl(40123);

  it("admits the Product's echo of the submitted page, and nothing else on the host", () => {
    assert.equal(unadmittedHostnameOccurrences(JSON.stringify({ webpageUrl: page, source: HLS_FIXTURE_HOSTNAME }), opts), 0);
    // raw SQLite stores column values back to back
    assert.equal(unadmittedHostnameOccurrences(`${page}preset:best${HLS_FIXTURE_HOSTNAME}yt-dlp`, opts), 0);
    assert.equal(unadmittedHostnameOccurrences(`http://${HLS_FIXTURE_HOSTNAME}:40123${HLS_MEDIA_ROUTE}?sig=x`, opts), 1);
    assert.equal(unadmittedHostnameOccurrences(`http://${HLS_FIXTURE_HOSTNAME}:40124${HLS_PAGE_ROUTE}`, opts), 1);
    assert.equal(unadmittedHostnameOccurrences(`http://${HLS_FIXTURE_HOSTNAME}/hls08/seg-0.ts`, opts), 1);
  });

  it("reports surface names and needle labels, never the needle", () => {
    const findings = scanPrivacySurfaces(
      { clean: JSON.stringify({ webpageUrl: page }), dirty: `x ${HLS08_PRIVATE_MARKERS.execution} y` },
      { ...opts, needles: { "execution-marker": HLS08_PRIVATE_MARKERS.execution } },
    );
    assert.deepEqual(findings, [{ surface: "dirty", needle: "execution-marker" }]);
  });
});

// ── container model ────────────────────────────────────────────────────────

describe("hls container model", () => {
  const provenance = {
    commit: HEAD,
    tree: TREE,
    acceptedBaseSourceCommit: BASE_SOURCE,
    contextClean: true,
    overlayRuntimeCompatibilityVerified: true,
    baseImage: BASE_IMAGE,
    baseDigest: BASE_DIGEST,
  };
  const image = hlsOverlayImageTag(HEAD);
  const args = () => hlsAcceptanceRunArgs({ imageId: OVERLAY_ID, image, reportDir: REPORT, evidenceName: "hls08-x.json", provenance });

  it("pins the recorded accepted runtime", () => {
    assert.deepEqual({ ...HLS08_ACCEPTED_BASE }, {
      sourceCommit: "593f47dfffe79f166d40af6575c6130668e56af0",
      imageDigest: "sha256:5925515fb002cd7203228325e1d30fd5987eafde3043ca1663162b9fe04df21e",
      retainedTag: "videofetch-worker:rc-593f47dfffe7-5925515fb002",
      ytdlpVersion: "2026.08.19",
    });
  });

  it("names a non-deployable local-test overlay tag from the full head", () => {
    assert.equal(image, "videofetch-worker:hls08-0123456789ab-local-test");
    assert.throws(() => hlsOverlayImageTag("0123456789ab"));
    assert.throws(() => hlsOverlayImageTag(HEAD.toUpperCase()));
  });

  it("refuses every deployable tag spelling", () => {
    for (const ref of [
      "videofetch-worker:latest", "videofetch-worker:stable", "videofetch-worker:production",
      "videofetch-worker:current", "videofetch-worker:LATEST", "videofetch-worker",
      "videofetch-worker:rc-593f47dfffe7-5925515fb002", "other:hls08-0123456789ab-local-test",
    ]) {
      assert.throws(() => assertNonDeployableTag(ref), ref);
    }
    assert.throws(() => hlsOverlayBuildArgs({ image: "videofetch-worker:latest", dockerfile: "/d", context: "/c" }));
  });

  it("copies exactly SPLIT-06's authorized paths and removes the broker", () => {
    assert.equal(HLS08_OVERLAY_COPIED_PATHS, OVERLAY_COPIED_PATHS);
    const lines = hlsOverlayDockerfile(BASE_IMAGE).split("\n");
    assert.deepEqual(lines.filter((l) => l.startsWith("FROM ")), [`FROM ${BASE_IMAGE}`]);
    assert.deepEqual(
      lines.filter((l) => l.startsWith("COPY ")),
      OVERLAY_COPIED_PATHS.map((p) => `COPY --chown=node:node ${p} /app/${p}`),
    );
    const rmAt = lines.indexOf("RUN rm -rf /app/src/broker");
    assert.ok(rmAt > lines.findLastIndex((l) => l.startsWith("COPY ")));
    assert.equal(lines.filter((l) => l.trim()).at(-1), "USER node");
    assert.deepEqual(hlsOverlayBuildArgs({ image, dockerfile: "/d/Dockerfile.hls08", context: "/ctx" }), [
      "build", "-f", "/d/Dockerfile.hls08", "-t", image, "/ctx",
    ]);
  });

  it("the run is --rm, --network none, one exact --add-host, one report mount, by immutable id", () => {
    const a = args();
    assert.deepEqual(hlsRunPostureViolations(a, { reportDir: REPORT }), []);
    const at = (flag) => a.indexOf(flag);
    assert.equal(a[at("--network") + 1], "none");
    assert.equal(a[at("--add-host") + 1], "hls-fixture.example.invalid:127.0.0.1");
    assert.equal(HLS08_FIXTURE_HOST_MAPPING, "hls-fixture.example.invalid:127.0.0.1");
    assert.equal(a[at("-v") + 1], `${REPORT}:${HLS08_CONTAINER_REPORT_DIR}`);
    assert.equal(a[at("--pull") + 1], "never");
    assert.ok(a.includes(OVERLAY_ID));
    assert.ok(!a.includes("--user") && !a.includes("-u"), "the image's node user is inherited");
    assert.equal(a[at("-w") + 1], "/app");
    for (const value of [HEAD, TREE, BASE_SOURCE, BASE_DIGEST, OVERLAY_ID]) assert.ok(a.includes(value));
    assert.ok(a.includes("--source-context-clean") && a.includes("--overlay-runtime-compatible"));
  });

  it("the posture check catches each removal and each dangerous addition", () => {
    const without = (flag, withValue = true) => {
      const a = args();
      const i = a.indexOf(flag);
      a.splice(i, withValue ? 2 : 1);
      return a;
    };
    const imageAt = (a) => a.indexOf(OVERLAY_ID);
    const inject = (...extra) => {
      const a = args();
      a.splice(imageAt(a), 0, ...extra);
      return a;
    };
    const cases = {
      "no --network none": without("--network"),
      "no --add-host": without("--add-host"),
      "no --rm": without("--rm", false),
      "network host": inject("--network", "host"),
      "docker socket": inject("-v", "/var/run/docker.sock:/var/run/docker.sock"),
      "broker socket": inject("-v", "/run/videofetch-r2-broker:/run/b"),
      "worker env": inject("--env-file", "/etc/videofetch/worker.env"),
      "second host": inject("--add-host", "example.com:127.0.0.1"),
      "production workspace": inject("--mount", "type=bind,src=/var/lib/videofetch,dst=/w"),
      privileged: inject("--privileged"),
      "credential env": inject("-e", "R2_BROKER_PARENT_SECRET_ACCESS_KEY=x"),
      "user override": inject("--user", "0"),
    };
    for (const [name, argv] of Object.entries(cases)) {
      assert.ok(hlsRunPostureViolations(argv, { reportDir: REPORT }).length > 0, name);
    }
    const byTag = args().map((x) => (x === OVERLAY_ID ? image : x));
    assert.ok(hlsRunPostureViolations(byTag, { reportDir: REPORT }).length > 0, "by tag");
  });

  it("refuses unverified provenance, a tag instead of an id, and a relative report dir", () => {
    assert.throws(() => hlsAcceptanceRunArgs({ imageId: image, image, reportDir: REPORT, evidenceName: "e.json", provenance }));
    assert.throws(() => hlsAcceptanceRunArgs({ imageId: OVERLAY_ID, image, reportDir: "rel", evidenceName: "e.json", provenance }));
    assert.throws(() => hlsAcceptanceRunArgs({ imageId: OVERLAY_ID, image, reportDir: REPORT, evidenceName: "../e.json", provenance }));
    assert.throws(() =>
      hlsAcceptanceRunArgs({ imageId: OVERLAY_ID, image, reportDir: REPORT, evidenceName: "e.json", provenance: { ...provenance, contextClean: false } }),
    );
    assert.throws(() =>
      hlsAcceptanceRunArgs({ imageId: OVERLAY_ID, image, reportDir: REPORT, evidenceName: "e.json", provenance: { ...provenance, commit: "abc" } }),
    );
  });
});

// ── evidence ───────────────────────────────────────────────────────────────

function passingChecks() {
  return HLS08_MANDATORY_CHECKS.map((name) => ({ name, ok: true, detail: null }));
}

function evidenceInput(overrides = {}) {
  return {
    verdict: "PASS",
    startedAt: "2026-09-25T00:00:00.000Z",
    finishedAt: "2026-09-25T00:01:00.000Z",
    source: {
      commit: HEAD, tree: TREE, contextClean: true, acceptedBaseSourceCommit: BASE_SOURCE,
      overlayRuntimeCompatibilityVerified: true,
    },
    image: {
      acceptedBaseImage: BASE_IMAGE, acceptedBaseDigest: BASE_DIGEST,
      overlayImage: hlsOverlayImageTag(HEAD), overlayImageId: OVERLAY_ID,
    },
    network: { fixtureBind: HLS_FIXTURE_LOOPBACK, fixturePort: 40123 },
    toolchain: { node: "v22.x" },
    invariants: {}, fixture: {}, fixtureToolUse: {}, discovery: { protocol: "m3u8_native" },
    publicAnalysis: {}, executionAnalysis: {}, freshProvenance: {},
    plan: { operation: "clear-hls-remux" }, workspace: {}, hls2: {}, hls3: {}, aggregate: {}, lifecycle: {},
    productMediaToolUse: {}, remux: {}, output: {}, upload: { objectKey: "videofetch/jobs/x/y.mp4" }, ready: {},
    fixtureRequests: {}, privacy: {}, cleanup: {}, negativeCases: {}, openNotes: {},
    checks: passingChecks(),
    ...overrides,
  };
}

describe("hls evidence record", () => {
  it("a PASS carrying every mandatory check builds, with the fixed schema, substitutions and non-claims", () => {
    const record = buildHlsEvidence(evidenceInput());
    assert.equal(record.schema, HLS08_EVIDENCE_SCHEMA);
    assert.equal(record.schema, "hls08-deterministic-full-path-01");
    assert.equal(record.image.deployable, false);
    assert.equal(record.network.mode, "none");
    assert.match(record.substitutions.submittedUrlValidator, /NOT Production SSRF/);
    assert.match(record.substitutions.safeHttpTransport, /NOT Production DNS, address-pinning or egress/);
    assert.match(record.substitutions.objectStoreProvider, /NOT Cloudflare R2/);
    assert.ok(record.nonClaims.some((c) => /Production SSRF\/address-pinning is NOT re-proven/.test(c)));
    assert.ok(record.nonClaims.some((c) => /Production DNS is NOT re-proven/.test(c)));
    assert.ok(record.nonClaims.some((c) => /egress\/nftables is NOT re-proven/.test(c)));
    assert.deepEqual(record.source.runtimeCompatibilityFiles, [...OVERLAY_RUNTIME_COMPATIBILITY_FILES]);
    assert.ok(renderHlsEvidence(record).endsWith("\n"));
  });

  it("the mandatory ledger covers every required category", () => {
    for (const prefix of [
      "provenance/", "image/", "preflight/", "invariants/", "fixture/", "validator/", "discovery/", "public/",
      "privacy/", "execution/", "executor/", "provenance-witness/", "plan/", "workspace/", "hls2/", "hls3/",
      "aggregate/", "lifecycle/", "processing/", "remux/", "output/", "upload/", "ready/", "cleanup/", "hooks/",
      "negative-encrypted/", "negative-fragment/", "negative-no-ffmpeg/", "transport/",
    ]) {
      assert.ok(HLS08_MANDATORY_CHECKS.some((n) => n.startsWith(prefix)), prefix);
    }
    assert.equal(new Set(HLS08_MANDATORY_CHECKS).size, HLS08_MANDATORY_CHECKS.length);
  });

  it("no partial PASS: a missing, failed, duplicated or extra-failed check refuses", () => {
    const drop = passingChecks().slice(1);
    const failed = passingChecks().map((c, i) => (i === 5 ? { ...c, ok: false } : c));
    const dup = [...passingChecks(), passingChecks()[0]];
    const extra = [...passingChecks(), { name: "extra/x", ok: false, detail: null }];
    for (const checks of [drop, failed, dup, extra, []]) {
      assert.ok(unmetPassConditions(checks).length > 0);
      assert.throws(() => buildHlsEvidence(evidenceInput({ checks })), /refusing to emit a PASS/);
    }
    // A FAIL record with failures is fine to emit.
    assert.equal(buildHlsEvidence(evidenceInput({ verdict: "FAIL", checks: failed })).verdict, "FAIL");
    assert.throws(() => buildHlsEvidence(evidenceInput({ verdict: "MAYBE" })));
  });

  it("refuses unverified source provenance", () => {
    assert.throws(() => buildHlsEvidence(evidenceInput({ source: { commit: HEAD } })), /driver-verified/);
  });

  it("refuses private markers, the raw HLS id, the hostname, URLs, temp paths and playlist names", () => {
    const leaks = [
      HLS08_PRIVATE_MARKERS.execution,
      HLS08_PRIVATE_MARKERS.browser,
      HLS08_RAW_FORMAT_ID,
      HLS_FIXTURE_HOSTNAME,
      "http://anything.example/x",
      "sig=abc",
      "/tmp/videofetch/jobs/x/hls-source.ts",
      "media.m3u8",
    ];
    for (const leak of leaks) {
      assert.throws(() => buildHlsEvidence(evidenceInput({ hls2: { note: leak } })), /private HLS material/, leak);
      assert.throws(() => buildHlsEvidence(evidenceInput({ fixture: { deep: [{ x: leak }] } })), /private HLS material/, leak);
    }
    assert.ok(HLS08_FORBIDDEN_EVIDENCE_SUBSTRINGS.includes(HLS08_PRIVATE_MARKER_PREFIX));
    assert.equal(findForbiddenSubstring({ fine: "m3u8_native", op: "clear-hls-remux" }), null);
  });

  it("refuses raw-material keys", () => {
    for (const key of ["stderr", "stdout", "argv", "playlistUrl", "fragmentUrl", "cookie", "authorization", "secret", "credential", "token", "url", "headers"]) {
      assert.throws(() => buildHlsEvidence(evidenceInput({ hls3: { [key]: 1 } })), /containing a/, key);
    }
  });

  it("the driver's read-back validation binds the record to the observed source and images", () => {
    const record = JSON.parse(renderHlsEvidence(buildHlsEvidence(evidenceInput())));
    const expected = { commit: HEAD, tree: TREE, baseDigest: BASE_DIGEST, overlayImage: hlsOverlayImageTag(HEAD), overlayImageId: OVERLAY_ID };
    assert.deepEqual(validateHlsEvidenceRecord(record, expected), []);
    assert.ok(validateHlsEvidenceRecord(record, { ...expected, commit: TREE }).length > 0);
    assert.ok(validateHlsEvidenceRecord(record, { ...expected, overlayImageId: `sha256:${"f".repeat(64)}` }).length > 0);
    assert.ok(validateHlsEvidenceRecord({ ...record, verdict: "FAIL" }, expected).length > 0);
    assert.ok(validateHlsEvidenceRecord({ ...record, extra: HLS08_PRIVATE_MARKERS.execution }, expected).length > 0);
    assert.ok(validateHlsEvidenceRecord(null, expected).length > 0);
  });
});

// ── the host driver ────────────────────────────────────────────────────────

describe("hls host driver", () => {
  const CONTEXT = "/var/tmp/hls08-context";
  const BASE_LAYERS = ["sha256:l1", "sha256:l2"];
  const OVERLAY_LAYERS = [...BASE_LAYERS, "sha256:l3", "sha256:l4"];

  it("parses full SHAs and the pinned accepted runtime only", () => {
    const good = [
      "--base-image", BASE_IMAGE, "--base-digest", BASE_DIGEST, "--base-source", BASE_SOURCE,
      "--head", HEAD, "--tree", TREE, "--context", CONTEXT, "--report", REPORT,
    ];
    assert.equal(parseDriverArgv(good).head, HEAD);
    const swap = (flag, value) => good.map((x, i) => (good[i - 1] === flag ? value : x));
    assert.throws(() => parseDriverArgv(swap("--head", HEAD.slice(0, 12))), /full lowercase/);
    assert.throws(() => parseDriverArgv(swap("--tree", TREE.toUpperCase())), /full lowercase/);
    assert.throws(() => parseDriverArgv(swap("--base-digest", `sha256:${"a".repeat(64)}`)), /accepted runtime/);
    assert.throws(() => parseDriverArgv(swap("--base-source", TREE)), /accepted runtime/);
    assert.throws(() => parseDriverArgv(swap("--report", "relative")), /absolute/);
    assert.throws(() => parseDriverArgv(good.slice(2)), /--base-image is required/);
    assert.throws(() => parseDriverArgv([...good, "--family", "mp4"]), /unknown argument/);
  });

  it("names evidence as a new UTC-stamped plain basename", () => {
    assert.equal(evidenceNameFor(() => Date.UTC(2026, 8, 25, 15, 1, 2, 345)), "hls08-20260925T150102Z.json");
  });

  function repoState(overrides = {}) {
    const blobs = Object.fromEntries(OVERLAY_RUNTIME_COMPATIBILITY_FILES.map((f, i) => [f, `${String(i).repeat(40)}`.slice(0, 40)]));
    return { head: HEAD, tree: TREE, status: "", untracked: "", lsFiles: "", baseSourcePresent: true, blobsAtBase: blobs, blobsAtHead: { ...blobs }, afterBuild: null, ...overrides };
  }

  function fakeWorld(repo, { baseId = BASE_DIGEST, overlayLayers = OVERLAY_LAYERS, evidenceText = null, evidenceExistsBeforeRun = false } = {}) {
    const calls = [];
    let ran = false;
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const git = (args) => {
      assert.deepEqual(args.slice(0, 3), ["--no-optional-locks", "-C", CONTEXT]);
      const [verb, ...rest] = args.slice(3);
      if (verb === "rev-parse") {
        const rev = rest.at(-1);
        if (rev === "HEAD") return ok(`${repo.head}\n`);
        if (rev === `${repo.head}^{tree}`) return ok(`${repo.tree}\n`);
        const at = rev.indexOf(":");
        const commit = rev.slice(0, at);
        const table = commit === BASE_SOURCE ? repo.blobsAtBase : commit === repo.head ? repo.blobsAtHead : {};
        const blob = table[rev.slice(at + 1)];
        return blob ? ok(`${blob}\n`) : { code: 1, stdout: "", stderr: "" };
      }
      if (verb === "status") return ok(rest.includes("--ignored=matching") ? repo.untracked : repo.status);
      if (verb === "ls-files") return ok(repo.lsFiles);
      if (verb === "cat-file") return repo.baseSourcePresent ? ok() : { code: 128, stdout: "", stderr: "" };
      throw new Error(`unexpected git ${verb}`);
    };
    const docker = (args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        const ref = args[2];
        const format = args[4];
        const isOverlay = ref === OVERLAY_ID || ref.includes(":hls08-");
        if (format === "{{.Id}}") return ok(`${isOverlay ? OVERLAY_ID : baseId}\n`);
        return ok(JSON.stringify(isOverlay ? overlayLayers : BASE_LAYERS));
      }
      if (args[0] === "build") {
        if (repo.afterBuild) repo.afterBuild(repo);
        return ok();
      }
      if (args[0] === "run") {
        ran = true;
        return ok();
      }
      if (args[0] === "image" && args[1] === "rm") return ok();
      throw new Error(`unexpected docker ${args.join(" ")}`);
    };
    return {
      calls,
      docker: () => calls.filter((c) => c.command === "docker").map((c) => c.args),
      deps: {
        run: async (command, args) => {
          calls.push({ command, args });
          if (command === "git") return git(args);
          if (command === "docker") return docker(args);
          throw new Error(`unexpected command ${command}`);
        },
        log: () => {},
        now: () => Date.UTC(2026, 8, 25, 15, 1, 2),
        exists: () => (ran ? evidenceText !== null : evidenceExistsBeforeRun),
        readText: async () => evidenceText,
        statDir: async () => ({ isDirectory: () => true }),
      },
    };
  }

  let scratch;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "hls08-driver-"));
  });
  after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const opts = () => ({
    baseImage: BASE_IMAGE, baseDigest: BASE_DIGEST, baseSource: BASE_SOURCE, head: HEAD, tree: TREE,
    context: CONTEXT, report: REPORT, keepImage: false, docker: "docker",
  });
  const passText = () => {
    const input = evidenceInput();
    return renderHlsEvidence(buildHlsEvidence(input));
  };

  it("happy path: provenance, base, build, re-verify, layers, run by id, read back, remove", async () => {
    const world = fakeWorld(repoState(), { evidenceText: passText() });
    const result = await runHlsAcceptance(opts(), { ...world.deps, scratchRoot: scratch });
    assert.equal(result.code, 0, JSON.stringify(result.problems));
    assert.equal(result.overlayId, OVERLAY_ID);
    assert.match(result.evidencePath, /^\/var\/tmp\/hls08\/hls08-\d{8}T\d{6}Z\.json$/);
    assert.match(result.evidenceSha256, /^[0-9a-f]{64}$/);
    const verbs = world.docker().map((a) => (a[0] === "image" ? `${a[0]} ${a[1]}` : a[0]));
    assert.deepEqual(verbs, ["image inspect", "image inspect", "build", "image inspect", "image inspect", "run", "image rm"]);
    const runArgs = world.docker().find((a) => a[0] === "run");
    assert.ok(runArgs.includes(OVERLAY_ID));
    assert.deepEqual(hlsRunPostureViolations(runArgs, { reportDir: REPORT }), []);
    // git ran before the first docker command, and again between build and run
    const firstDocker = world.calls.findIndex((c) => c.command === "docker");
    assert.ok(world.calls.slice(0, firstDocker).some((c) => c.command === "git" && c.args[3] === "status"));
    const buildAt = world.calls.findIndex((c) => c.command === "docker" && c.args[0] === "build");
    const runAt = world.calls.findIndex((c) => c.command === "docker" && c.args[0] === "run");
    assert.ok(world.calls.slice(buildAt, runAt).some((c) => c.command === "git" && c.args[3] === "status"));
  });

  it("a Git provenance refusal runs NO docker command", async () => {
    for (const repo of [
      repoState({ head: TREE }),
      repoState({ status: " M src/x.ts\n" }),
      repoState({ baseSourcePresent: false }),
      repoState({ blobsAtHead: { ...repoState().blobsAtBase, "package-lock.json": "f".repeat(40) } }),
    ]) {
      const world = fakeWorld(repo, { evidenceText: passText() });
      await assert.rejects(runHlsAcceptance(opts(), { ...world.deps, scratchRoot: scratch }), ProvenanceError);
      assert.equal(world.docker().length, 0);
    }
  });

  it("an unavailable or mismatched accepted base refuses before any build", async () => {
    const world = fakeWorld(repoState(), { baseId: `sha256:${"b".repeat(64)}`, evidenceText: passText() });
    await assert.rejects(runHlsAcceptance(opts(), { ...world.deps, scratchRoot: scratch }), /ACCEPTED RUNTIME IMAGE UNAVAILABLE/);
    assert.ok(!world.docker().some((a) => a[0] === "build" || a[0] === "run"));
  });

  it("a context that changed during the build is refused and the overlay removed", async () => {
    const world = fakeWorld(repoState({ afterBuild: (r) => (r.status = "?? injected\n") }), { evidenceText: passText() });
    await assert.rejects(runHlsAcceptance(opts(), { ...world.deps, scratchRoot: scratch }), /changed while the overlay/);
    assert.ok(!world.docker().some((a) => a[0] === "run"));
    assert.deepEqual(world.docker().at(-1).slice(0, 2), ["image", "rm"]);
  });

  it("an overlay not built on the accepted base layers is refused and removed", async () => {
    const world = fakeWorld(repoState(), { overlayLayers: ["sha256:other", "sha256:l3"], evidenceText: passText() });
    await assert.rejects(runHlsAcceptance(opts(), { ...world.deps, scratchRoot: scratch }), /accepted base image's layers/);
    assert.ok(!world.docker().some((a) => a[0] === "run"));
    assert.deepEqual(world.docker().at(-1).slice(0, 2), ["image", "rm"]);
  });

  it("an existing evidence target is refused before the container runs", async () => {
    const world = fakeWorld(repoState(), { evidenceText: passText(), evidenceExistsBeforeRun: true });
    await assert.rejects(runHlsAcceptance(opts(), { ...world.deps, scratchRoot: scratch }), /refusing to replace/);
    assert.ok(!world.docker().some((a) => a[0] === "run"));
  });

  it("evidence naming another source fails the run", async () => {
    const other = renderHlsEvidence(
      buildHlsEvidence(evidenceInput({ source: { ...evidenceInput().source, commit: "f".repeat(40) } })),
    );
    const world = fakeWorld(repoState(), { evidenceText: other });
    const result = await runHlsAcceptance(opts(), { ...world.deps, scratchRoot: scratch });
    assert.equal(result.code, 1);
    assert.ok(result.problems.includes("source commit mismatch"));
  });

  it("--keep-image retains the overlay", async () => {
    const world = fakeWorld(repoState(), { evidenceText: passText() });
    await runHlsAcceptance({ ...opts(), keepImage: true }, { ...world.deps, scratchRoot: scratch });
    assert.ok(!world.docker().some((a) => a[0] === "image" && a[1] === "rm"));
  });
});
